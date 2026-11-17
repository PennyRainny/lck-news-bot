// Discord via plain REST (no discord.js). The token is read from process.env only.
import { sleep, truncate } from './util.mjs';
import { toEmbed } from './shared.mjs';

const API = 'https://discord.com/api/v10';
export const PERMISSIONS = 1024 + 2048 + 16384; // View Channel + Send Messages + Embed Links

const token = () => (process.env.DISCORD_TOKEN || '').trim().replace(/^Bot\s+/i, '');
export const channelId = () => (process.env.DISCORD_CHANNEL_ID || '').trim();

export async function api(method, path, body) {
  if (!token()) throw Object.assign(new Error('DISCORD_TOKEN is not set (run: npm run setup)'), { status: 0 });
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${token()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (https://discord.com/developers/docs, 1.0)',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
    if (!r.ok) {
      throw Object.assign(new Error(`Discord ${method} ${path} -> ${r.status} ${j?.message || text.slice(0, 120)}`), { status: r.status, code: j?.code });
    }
    return j;
  }
  throw Object.assign(new Error('Discord rate limit retries exhausted'), { status: 429 });
}

// Discord only lets a bot send messages after it has identified on the Gateway once.
// We connect, identify, wait for READY and disconnect.
export function identifyOnce({ timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    const done = (fn, v) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new Error('gateway timeout')), timeoutMs);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.op === 10)
        ws.send(JSON.stringify({ op: 2, d: { token: token(), intents: 0, properties: { os: 'windows', browser: 'lck-news-bot', device: 'lck-news-bot' } } }));
      else if (m.op === 0 && m.t === 'READY') done(resolve, m.d.user);
      else if (m.op === 9) done(reject, new Error('gateway rejected the session'));
    };
    ws.onclose = (ev) => {
      if (ev.code === 4004) done(reject, new Error('gateway: token rejected (4004)'));
    };
    ws.onerror = () => done(reject, new Error('gateway connection error'));
  });
}

export async function botInfo() {
  const [me, app] = await Promise.all([api('GET', '/users/@me'), api('GET', '/oauth2/applications/@me')]);
  return {
    id: me.id,
    username: me.username,
    appId: app.id,
    inviteUrl: `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot&permissions=${PERMISSIONS}`,
  };
}

// Is the configured channel reachable? If the id is actually a server id, list its text channels.
export async function channelInfo(id = channelId()) {
  try {
    const ch = await api('GET', `/channels/${id}`);
    const guild = ch.guild_id ? await api('GET', `/guilds/${ch.guild_id}`).catch(() => null) : null;
    return { ok: true, id, name: ch.name, guild: guild?.name || null };
  } catch (e) {
    const guild = await api('GET', `/guilds/${id}`).catch(() => null);
    if (guild) {
      const chans = await api('GET', `/guilds/${id}/channels`).catch(() => []);
      return {
        ok: false,
        error: `${id} is the server "${guild.name}", not a channel — pick a channel`,
        channels: chans.filter((c) => c.type === 0 || c.type === 5).map((c) => ({ id: c.id, name: c.name })),
      };
    }
    const hint = e.status === 403 || e.status === 404 ? ' — is the bot invited to that server, and can it see the channel?' : '';
    return { ok: false, error: e.message + hint };
  }
}

const NO_PINGS = { parse: [] }; // never let post text ping @everyone / roles

export async function sendText(content) {
  return api('POST', `/channels/${channelId()}/messages`, { content: truncate(content, 2000), allowed_mentions: NO_PINGS });
}

export { toEmbed }; // lives in shared.mjs (the Cloudflare Worker uses it too)

export async function sendPost(item, src, profile) {
  return api('POST', `/channels/${channelId()}/messages`, { embeds: [toEmbed(item, src, profile)], allowed_mentions: NO_PINGS });
}
