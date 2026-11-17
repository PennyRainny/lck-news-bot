// LCK News Bot — watches LCK team / news accounts on X + Instagram, posts new ones to Discord.
//   node src/bot.mjs setup               local setup page (Discord token, invite, logins -> GitHub)
//   node src/bot.mjs login [x|instagram] open a Chrome window to log in, ship session to GitHub
//   node src/bot.mjs check               scrape every source, print a table, change nothing
//   node src/bot.mjs once                one full cycle on this PC (posts new items)
//   node src/bot.mjs preview <handle>    post that source's newest item (format check)
//   node src/bot.mjs test                send a test message to the channel
//   node src/bot.mjs cloud               one cycle inside GitHub Actions (the schedule calls this)
//   node src/bot.mjs run                 run forever on this PC instead of the cloud
import { PLATFORMS, PLATFORM_NAME, jitter, loadEnv, loadSources, loadState, log, saveState, sleep } from './util.mjs';
import { pruneSeen, queueNew as queueNewShared } from './shared.mjs';
import { CLOUD, openBrowser, secretHash } from './browser.mjs';
import { fetchX, fetchXFx } from './x.mjs';
import { fetchInstagram } from './instagram.mjs';
import { identifyOnce, sendPost, sendText } from './discord.mjs';

loadEnv();

// X: login-free FxTwitter first, the X session only as backup. Instagram: session only.
async function fetchSource(src, getPage, { allowSession = true } = {}) {
  if (src.platform === 'instagram') return { ...(await fetchInstagram(await getPage(), src)), via: 'session' };
  try {
    return { ...(await fetchXFx(src)), via: 'fx' };
  } catch (fxErr) {
    if (!allowSession) throw fxErr;
    log(`[x] @${src.handle}: ${fxErr.message} — trying the X session`);
    return { ...(await fetchX(await getPage(), src)), via: 'session' };
  }
}

// The headless browser only starts if a source actually needs a session.
function lazyBrowser() {
  let ctx = null;
  let page = null;
  return {
    async getPage() {
      if (!page) {
        ctx = await launch();
        page = ctx.pages()[0] || (await ctx.newPage());
      }
      return page;
    },
    async close() {
      if (ctx) await ctx.close().catch(() => {});
    },
  };
}

const HUMAN_TIMEOUT_MIN = 15;
const HUMAN_RETRY_MIN = 60; // local: re-open the login window after this
const DEAD_RETRY_H = 6; // cloud: retry a dead session (same secret) after this
const KEEPALIVE_DAYS = 7; // cloud: touch state so GitHub never disables the schedule (60-day rule)
const XDOWN_ALERT_H = 3; // cloud: alert when no X account was readable for this long

async function launch() {
  try {
    return await openBrowser({ headless: true });
  } catch (e) {
    if (/ProcessSingleton|existing browser session|user data directory is already in use/i.test(e.message))
      throw new Error('The bot browser profile is in use — is another copy of the bot (or its login window) running?');
    throw e;
  }
}

// Cloud: a session that failed and whose secret has not changed since.
const sessionDead = (p, state, now) => {
  const dead = state.dead[p];
  return CLOUD && !!dead && dead.hash === secretHash(p) && now - dead.at < DEAD_RETRY_H * 3600e3;
};

function isDue(p, cfg, state, now) {
  if (CLOUD) {
    if (p !== 'x' && sessionDead(p, state, now)) return false; // X still has the login-free route
    const every = cfg.intervalsMinutes[p];
    const tick = cfg.cronMinutes; // the workflow fires about every `cronMinutes`
    if (every <= tick) return true;
    // GitHub starts scheduled runs late and sometimes drops them, so go by the last check, not the clock
    return now - (state.lastRun[p] || 0) >= (every - tick / 2) * 60e3;
  }
  return (state.humanWaitUntil[p] || 0) <= now && now - (state.lastRun[p] || 0) >= cfg.intervalsMinutes[p] * 60e3 - 5000;
}

function queueNew(state, cfg, src, res, outbox) {
  if (queueNewShared(state, cfg, src, res, outbox)) {
    log(`[${src.platform}] first look at @${src.handle}: ${res.posts.length} existing posts marked seen (not posted)`);
  }
}

async function cycle({ force = false, dry = false } = {}) {
  const cfg = loadSources();
  const state = loadState();
  const now = Date.now();
  const out = { rows: [], needHuman: {}, posted: 0 };
  // BOT_PLATFORMS=instagram on GitHub: X is checked every minute by the Cloudflare Worker (worker/)
  const only = (process.env.BOT_PLATFORMS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const due = PLATFORMS.filter(
    (p) => (!only.length || only.includes(p)) && cfg.sources.some((s) => s.platform === p) && (force || isDue(p, cfg, state, now)),
  );
  if (!due.length) return out;

  const outbox = [];
  const restored = [];
  const browser = lazyBrowser();
  try {
    for (const platform of due) {
      let allowSession = !sessionDead(platform, state, now);
      let usedSession = false;
      for (const src of cfg.sources.filter((s) => s.platform === platform)) {
        const row = { src, status: 'ok', posts: [] };
        out.rows.push(row);
        try {
          Object.assign(row, await fetchSource(src, browser.getPage, { allowSession }));
          if (row.via === 'session') usedSession = true;
          if (!dry) queueNew(state, cfg, src, row, outbox);
        } catch (e) {
          row.status = e.code || 'ERROR';
          row.error = e.message;
          if (e.code === 'LOGIN' || e.code === 'CHECKPOINT') {
            out.needHuman[platform] = { reason: e.code.toLowerCase(), url: e.url };
            if (platform !== 'x') break;
            allowSession = false; // X: keep going on the login-free route for the rest
            continue;
          }
          log(`[${platform}] @${src.handle}: ${e.message}`);
          if (e.code === 'RATE') allowSession = false;
          if (e.code === 'RATE' && platform !== 'x') break;
        }
        await (row.via === 'fx' ? jitter(300, 900) : jitter(1500, 4000));
      }
      const human = out.needHuman[platform];
      if (human || usedSession) {
        const next = human ? { ok: false, reason: human.reason } : { ok: true };
        const prev = state.login[platform];
        if (!prev || prev.ok !== next.ok || prev.reason !== next.reason) state.login[platform] = { ...next, at: Date.now() };
      }
      // cloud: only slower-than-the-cron platforms need it (keeps state.json from changing every run)
      if (!human && !dry && (!CLOUD || cfg.intervalsMinutes[platform] > cfg.cronMinutes)) state.lastRun[platform] = Date.now();
      if (!human && usedSession && state.dead[platform]) {
        delete state.dead[platform];
        restored.push(platform);
      }
    }
  } finally {
    await browser.close();
  }

  if (dry) {
    const fresh = loadState();
    fresh.login = { ...fresh.login, ...state.login };
    saveState(fresh);
    return out;
  }

  outbox.sort((a, b) => a.item.createdAt - b.item.createdAt);
  for (const { item, src, profile } of outbox) {
    try {
      await sendPost(item, src, profile);
      state.seen[item.key] = Date.now();
      out.posted++;
      log(`posted ${src.label}: ${item.url}`);
      saveState(state);
      await sleep(1200);
    } catch (e) {
      log(`post failed ${item.url}: ${e.message}`);
      if (e.status === 400) state.seen[item.key] = Date.now(); // payload Discord won't ever accept
      if ([0, 401, 403, 404].includes(e.status)) break; // token/channel problem: keep items for later
    }
  }
  for (const p of restored) {
    delete state.alerts[p];
    await sendText(`✅ ${PLATFORM_NAME[p]} session works again — posts resume.`).catch(() => {});
  }
  pruneSeen(state, now);
  saveState(state);
  return out;
}

// Cloud: nobody can log in on a GitHub runner, so alert Discord once per dead session.
async function cloudAlert(platform, info) {
  const name = PLATFORM_NAME[platform];
  const state = loadState();
  const hash = secretHash(platform);
  const known = state.dead[platform]?.hash === hash;
  state.dead[platform] = { hash, reason: info.reason, at: Date.now() };
  if (!known) {
    const extra =
      platform === 'instagram' && info.reason === 'checkpoint' ? ' If the Instagram app asks "Was this you?", tap **This was me** first.' : '';
    const impact =
      platform === 'x'
        ? 'X posts still arrive through the login-free route; only accounts that route fails on are paused.'
        : `${name} posts are paused.`;
    await sendText(
      `⚠️ **LCK News Bot** — the ${name} session ${hash ? 'stopped working' : 'is not set up yet'}. ${impact}${extra}\n` +
        'Fix: on the bot PC, open `.SELFWORK\\LCK_News_Bot` and run `npm run login` — a Chrome window opens, log in, and the cloud picks it up by itself.',
    ).catch((e) => log('alert failed:', e.message));
    state.alerts[platform] = Date.now();
  }
  saveState(state);
}

// Local: alert Discord once, open a visible login window, wait for the human.
async function askHuman(platform, info) {
  const name = PLATFORM_NAME[platform];
  let state = loadState();
  if (!state.alerts[platform]) {
    const why = info.reason === 'checkpoint' ? 'a verification' : 'a login';
    await sendText(`⚠️ **LCK News Bot** — ${name} needs ${why}. A Chrome window opened on the bot PC; ${name} posts are paused until then.`).catch((e) =>
      log('alert failed:', e.message),
    );
    state.alerts[platform] = Date.now();
    saveState(state);
  }
  const { loginAndShip } = await import('./session.mjs');
  const { ok } = await loginAndShip(platform, { url: info.url, timeoutMin: HUMAN_TIMEOUT_MIN, kick: false });
  if (ok) {
    log(`[${platform}] login OK — resuming`);
    await sendText(`✅ ${name} login restored — posts resume.`).catch(() => {});
  } else {
    state = loadState();
    state.humanWaitUntil[platform] = Date.now() + HUMAN_RETRY_MIN * 60e3;
    saveState(state);
    log(`[${platform}] nobody logged in within ${HUMAN_TIMEOUT_MIN} min — asking again in ${HUMAN_RETRY_MIN} min`);
  }
  return ok;
}

function printRows(rows) {
  const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
  console.log('\n' + pad('platform', 10) + pad('handle', 16) + pad('status', 13) + pad('name', 26) + pad('followers', 11) + pad('posts', 6) + 'newest');
  for (const r of rows) {
    const newest = r.posts.at(-1);
    console.log(
      pad(r.src.platform, 10) +
        pad(r.src.handle, 16) +
        pad(r.status === 'ok' ? `ok (${r.via})` : r.status, 13) +
        pad(r.profile?.name || r.error || '', 26) +
        pad(r.profile?.followers?.toLocaleString?.('en-US') ?? '', 11) +
        pad(r.posts.length, 6) +
        (newest ? new Date(newest.createdAt).toISOString().slice(0, 16).replace('T', ' ') : ''),
    );
  }
  console.log();
}

async function loginCmd(which) {
  const { loginAndShip } = await import('./session.mjs');
  const cfg = loadSources();
  const list = which ? [which === 'ig' ? 'instagram' : which] : PLATFORMS.filter((p) => cfg.sources.some((s) => s.platform === p));
  for (const p of list) {
    if (!PLATFORMS.includes(p)) throw new Error(`unknown platform ${p}`);
    console.log(`Opening ${PLATFORM_NAME[p]} login window — log in there; it closes by itself when done.`);
    const r = await loginAndShip(p, { timeoutMin: HUMAN_TIMEOUT_MIN, kick: p === list.at(-1) });
    console.log(`${PLATFORM_NAME[p]}: ${r.ok ? 'logged in' : 'NOT logged in (timed out / window closed)'}${r.ok ? (r.shipped ? ', sent to GitHub' : `, NOT sent to GitHub (${r.shipError})`) : ''}`);
  }
}

async function previewCmd(handle) {
  const cfg = loadSources();
  const src = cfg.sources.find((s) => s.handle.toLowerCase() === String(handle).toLowerCase());
  if (!src) throw new Error(`no source with handle ${handle} in sources.json`);
  const browser = lazyBrowser();
  let res;
  try {
    res = await fetchSource(src, browser.getPage);
  } finally {
    await browser.close();
  }
  const item = res.posts.filter((p) => p.kind !== 'repost').at(-1);
  if (!item) throw new Error(`@${handle}: no posts found`);
  await sendPost(item, src, res.profile);
  console.log(`posted preview: ${item.url}`);
}

async function runLoop() {
  log('LCK News Bot running on this PC (Ctrl+C to stop) — do not also run the cloud schedule');
  try {
    log(`Discord gateway OK as ${(await identifyOnce()).username}`);
  } catch (e) {
    log(`Discord gateway: ${e.message}`);
  }
  for (;;) {
    try {
      const r = await cycle();
      if (r.rows.length) log(`cycle: ${r.rows.filter((x) => x.status === 'ok').length}/${r.rows.length} sources ok, ${r.posted} posted`);
      for (const [p, info] of Object.entries(r.needHuman)) await askHuman(p, info);
    } catch (e) {
      log('cycle error:', e.stack || e.message);
    }
    await sleep(60e3);
  }
}

const [cmd = 'run', arg] = process.argv.slice(2);
const commands = {
  setup: async () => (await import('./setup.mjs')).runSetup(),
  login: () => loginCmd(arg),
  check: async () => {
    const r = await cycle({ force: true, dry: true });
    printRows(r.rows);
    for (const p of Object.keys(r.needHuman)) console.log(`${PLATFORM_NAME[p]} needs a login: npm run login -- ${p}`);
  },
  once: async () => {
    const r = await cycle({ force: true });
    printRows(r.rows);
    console.log(`posted ${r.posted} new item(s)`);
    for (const [p, info] of Object.entries(r.needHuman)) await askHuman(p, info);
  },
  cloud: async () => {
    if (!CLOUD) throw new Error('"cloud" is for GitHub Actions; on this PC use once / run');
    const r = await cycle({ force: process.env.BOT_FORCE === '1' }); // manual runs check everything
    if (!r.rows.length) console.log('nothing due this tick');
    else printRows(r.rows);
    console.log(`posted ${r.posted} new item(s)`);
    for (const [p, info] of Object.entries(r.needHuman)) await cloudAlert(p, info);
    const s = loadState();
    // Whole-X outage watch (e.g. FxTwitter gone): one alert after XDOWN_ALERT_H, one on recovery.
    const xRows = r.rows.filter((row) => row.src.platform === 'x');
    if (xRows.length) {
      const now = Date.now();
      if (!xRows.some((row) => row.status === 'ok')) {
        s.xDownSince ??= now;
        if (!s.xDownAlerted && now - s.xDownSince > XDOWN_ALERT_H * 3600e3) {
          await sendText(
            `⚠️ **LCK News Bot** — no X account could be read for ${XDOWN_ALERT_H} h (login-free route down, cloud backup blocked). ` +
              'Run `npm run once` on the bot PC to catch up, or `npm start` to run from the PC until it recovers.',
          ).catch((e) => log('alert failed:', e.message));
          s.xDownAlerted = now;
        }
      } else if (s.xDownSince) {
        if (s.xDownAlerted) await sendText('✅ X posts are coming through again.').catch(() => {});
        delete s.xDownSince;
        delete s.xDownAlerted;
      }
    }
    if (Date.now() - (s.keepalive || 0) > KEEPALIVE_DAYS * 864e5) s.keepalive = Date.now();
    saveState(s);
  },
  preview: () => previewCmd(arg),
  test: async () => {
    const u = await identifyOnce();
    await sendText(`✅ **LCK News Bot** (${u.username}) is connected and can post here.`);
    console.log('test message sent');
  },
  run: runLoop,
};

if (!commands[cmd]) {
  console.error(`unknown command "${cmd}". Use: ${Object.keys(commands).join(' | ')}`);
  process.exit(1);
}
commands[cmd]().then(
  () => cmd !== 'run' && cmd !== 'setup' && process.exit(0),
  (e) => {
    console.error(e.message || e);
    process.exit(1);
  },
);
