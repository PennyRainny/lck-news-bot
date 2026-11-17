// One X check: every X account in sources.json through FxTwitter (login-free), new posts -> Discord.
// Called every minute by the Cloudflare Worker's Durable Object (index.mjs). No Worker-only
// imports, so Node can run it too (dry test).
import { parseFx, pruneSeen, queueNew, toEmbed } from '../src/shared.mjs';

const FX = 'https://api.fxtwitter.com/2/profile/';
const DISCORD = 'https://discord.com/api/v10';
// first run only: start from what the GitHub bot already saw, so nothing is posted twice
const GH_STATE = 'https://api.github.com/repos/PennyRainny/lck-news-bot/contents/state.json?ref=state';
const UA = 'lck-news-bot/1.0';
const MAX_POSTS_PER_TICK = 8; // Workers allow 50 sub-requests per call (24 FxTwitter worst case); the rest go next minute
const XDOWN_ALERT_H = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function xConfig(raw) {
  return {
    maxAgeHours: raw.maxAgeHours ?? 48,
    includeRetweets: raw.includeRetweets ?? false,
    sources: raw.sources.filter((s) => s.platform === 'x').map((s) => ({ ...s, label: s.label ?? s.handle })),
  };
}

async function fetchFxOnce(src, fetchFn) {
  try {
    const r = await fetchFn(FX + encodeURIComponent(src.handle) + '/statuses', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j?.code === 200 && j.results?.length) return { ok: true, res: parseFx(j, src.handle) };
    return { ok: false, error: `HTTP ${r.status}${j?.results ? ' (no posts)' : ''}` };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : String(e.message || e) };
  }
}

// FxTwitter randomly answers 404 "no posts" for an account; one retry a moment later usually works.
async function fetchFx(src, fetchFn) {
  const first = await fetchFxOnce(src, fetchFn);
  if (first.ok) return first;
  await sleep(1500 + Math.random() * 1500);
  return fetchFxOnce(src, fetchFn);
}

// 3 at a time instead of all 12 at once — gentler on FxTwitter
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function importState(fetchFn, log) {
  const state = { seen: {}, seeded: {} };
  try {
    const r = await fetchFn(GH_STATE, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github.raw+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const gh = await r.json();
    for (const [k, t] of Object.entries(gh.seen || {})) if (k.startsWith('x:')) state.seen[k] = t;
    for (const [k, t] of Object.entries(gh.seeded || {})) if (k.startsWith('x:')) state.seeded[k] = t;
    log(`imported ${Object.keys(state.seen).length} seen X posts / ${Object.keys(state.seeded).length} accounts from the GitHub state`);
  } catch (e) {
    log(`GitHub state not read (${e.message}) — the first look at each account only marks its posts seen`);
  }
  return state;
}

async function discord(env, fetchFn, path, body) {
  const token = String(env.DISCORD_TOKEN || '').trim().replace(/^Bot\s+/i, '');
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetchFn(DISCORD + path, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (https://discord.com/developers/docs, 1.0)',
      },
      body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }), // never ping @everyone / roles
    });
    const text = await r.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {}
    if (r.status === 429) {
      await sleep(((j?.retry_after ?? 1) + 0.25) * 1000);
      continue;
    }
    if (!r.ok) throw Object.assign(new Error(`Discord ${r.status} ${j?.message || text.slice(0, 120)}`), { status: r.status });
    return j;
  }
  throw Object.assign(new Error('Discord rate limit'), { status: 429 });
}

// Start the GitHub Actions run that checks Instagram (GitHub's own cron is unreliable).
// GH_DISPATCH_TOKEN: fine-grained token for this one repo, Actions: read & write.
const GH_DISPATCH = 'https://api.github.com/repos/PennyRainny/lck-news-bot/actions/workflows/lck-news.yml/dispatches';
export async function kickInstagram(env, fetchFn = fetch, log = console.log) {
  try {
    const r = await fetchFn(GH_DISPATCH, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(env.GH_DISPATCH_TOKEN).trim()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': UA,
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    log(r.status === 204 ? 'started the Instagram check on GitHub' : `GitHub dispatch failed: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  } catch (e) {
    log(`GitHub dispatch failed: ${e.message}`);
  }
}

export async function tick({ env, storage, sources, fetchFn = fetch, log = console.log, dry = false }) {
  const cfg = xConfig(sources);
  const channel = String(env.DISCORD_CHANNEL_ID || '').trim();
  if (!dry && (!env.DISCORD_TOKEN || !channel)) {
    log('DISCORD_TOKEN / DISCORD_CHANNEL_ID secret not set — nothing done');
    return { skipped: true, rows: [], posted: 0 };
  }
  const now = Date.now();
  const stored = await storage.get('state');
  const state = stored || (await importState(fetchFn, log));
  let savedJson = stored ? JSON.stringify(stored) : null;
  const save = async () => {
    const json = JSON.stringify(state);
    if (json !== savedJson && !dry) await storage.put('state', state);
    savedJson = json;
  };

  const results = await mapLimit(cfg.sources, 3, (src) => fetchFx(src, fetchFn));
  const outbox = [];
  const rows = results.map((r, i) => {
    const src = cfg.sources[i];
    if (r.ok && queueNew(state, cfg, src, r.res, outbox, now))
      log(`first look at @${src.handle}: ${r.res.posts.length} posts marked seen (not posted)`);
    return { handle: src.handle, ok: r.ok, error: r.error, newest: r.res?.posts.at(-1)?.createdAt };
  });
  outbox.sort((a, b) => a.item.createdAt - b.item.createdAt);
  if (dry) return { rows, outbox: outbox.map((o) => o.item.url), state, posted: 0 };

  const send = (content) => discord(env, fetchFn, `/channels/${channel}/messages`, { content });
  let posted = 0;
  for (const { item, src, profile } of outbox.slice(0, MAX_POSTS_PER_TICK)) {
    try {
      await discord(env, fetchFn, `/channels/${channel}/messages`, { embeds: [toEmbed(item, src, profile)] });
      state.seen[item.key] = Date.now();
      posted++;
      log(`posted ${src.label}: ${item.url}`);
      await save();
      await sleep(1200);
    } catch (e) {
      log(`post failed ${item.url}: ${e.message}`);
      if (e.status === 400) state.seen[item.key] = Date.now(); // a payload Discord will never accept
      if ([401, 403, 404, 429].includes(e.status)) break; // token / channel / rate problem: retry next minute
    }
  }

  // Whole-X outage watch (FxTwitter down): one alert after XDOWN_ALERT_H, one on recovery.
  const okCount = rows.filter((r) => r.ok).length;
  if (!okCount) {
    state.xDownSince ??= now;
    if (!state.xDownAlerted && now - state.xDownSince > XDOWN_ALERT_H * 3600e3) {
      await send(
        `⚠️ **LCK News Bot** — no X account could be read for ${XDOWN_ALERT_H} h (FxTwitter, the login-free route, looks down). ` +
          'X posts resume by themselves when it is back.',
      ).catch((e) => log('alert failed:', e.message));
      state.xDownAlerted = now;
    }
  } else if (state.xDownSince) {
    if (state.xDownAlerted) await send('✅ X posts are coming through again.').catch(() => {});
    delete state.xDownSince;
    delete state.xDownAlerted;
  }

  pruneSeen(state, now);
  await save();
  const failed = rows.filter((r) => !r.ok).map((r) => `@${r.handle} ${r.error}`);
  const waiting = outbox.length - posted;
  log(`${okCount}/${rows.length} X accounts ok, ${posted} posted${waiting > 0 ? `, ${waiting} waiting` : ''}${failed.length ? ' | ' + failed.join(', ') : ''}`);
  return { rows, posted };
}
