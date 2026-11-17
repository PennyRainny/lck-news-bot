// Browser layer.
//  - local: one dedicated Chrome profile (.browser-profile) holds the X + Instagram logins;
//           a visible window opens only when a human must log in / verify.
//  - cloud (GitHub Actions): a throw-away profile, sessions come from the X_COOKIES /
//           IG_COOKIES secrets (exported by the local login), always headless.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { PATHS, log, sleep } from './util.mjs';

export const CLOUD = process.env.GITHUB_ACTIONS === 'true' || process.env.BOT_CLOUD === '1';

const BASE = {
  channel: process.env.CHROME_CHANNEL || 'chrome', // installed Google Chrome, no browser download
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  viewport: { width: 1280, height: 900 },
  locale: 'en-US',
};

export const LOGIN = {
  x: {
    origin: 'https://x.com',
    cookie: 'auth_token',
    secret: 'X_COOKIES',
    loginUrl: 'https://x.com/i/flow/login',
    blocked: /^\/(i\/flow\/|login|account\/access)/,
  },
  instagram: {
    origin: 'https://www.instagram.com',
    cookie: 'sessionid',
    secret: 'IG_COOKIES',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    blocked: /^\/(accounts\/login|challenge|checkpoint|auth_platform)/,
  },
};

// Cookies handed to the cloud run. Every value is masked in the Actions log.
function secretCookies(platform) {
  const raw = process.env[LOGIN[platform].secret];
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (process.env.GITHUB_ACTIONS === 'true') for (const c of arr) if (String(c.value).length >= 6) console.log(`::add-mask::${c.value}`);
    return arr;
  } catch {
    log(`${LOGIN[platform].secret} secret is not valid JSON — log in again`);
    return [];
  }
}

// Short fingerprint of the session secret, so the cloud knows when a fresh login arrived.
export function secretHash(platform) {
  const raw = process.env[LOGIN[platform].secret] || '';
  return raw ? createHash('sha256').update(raw).digest('hex').slice(0, 12) : '';
}

let headlessUA = null;

// Headless Chrome advertises "HeadlessChrome" in its UA; swap it for the normal one.
async function probeUA(dir) {
  const ctx = await chromium.launchPersistentContext(dir, { ...BASE, headless: true });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    return (await page.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
  } finally {
    await ctx.close();
  }
}

export async function openBrowser({ headless = true } = {}) {
  const dir = CLOUD ? mkdtempSync(join(tmpdir(), 'lckbot-')) : PATHS.profile;
  if (CLOUD) headless = true;
  if (headless && !headlessUA) headlessUA = await probeUA(dir);
  const ctx = await chromium.launchPersistentContext(dir, {
    ...BASE,
    headless,
    ...(headless ? { userAgent: headlessUA } : { viewport: null }),
  });
  if (CLOUD) {
    const cookies = [...secretCookies('x'), ...secretCookies('instagram')];
    if (cookies.length) await ctx.addCookies(cookies);
  }
  return ctx;
}

export async function hasSession(ctx, platform) {
  const cookies = await ctx.cookies(LOGIN[platform].origin);
  return cookies.some((c) => c.name === LOGIN[platform].cookie && c.value);
}

// Opens a visible Chrome window on the login (or checkpoint) page and waits for the
// human. On success returns the platform's cookies (to ship to the cloud), else null.
export async function interactiveLogin(platform, { url, timeoutMin = 15 } = {}) {
  if (CLOUD) return null;
  const cfg = LOGIN[platform];
  const ctx = await openBrowser({ headless: false });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(url || cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    log(`[${platform}] login window open — waiting up to ${timeoutMin} min for a human`);
    const host = new URL(cfg.origin).hostname.replace(/^www\./, ''); // x.com | instagram.com
    const deadline = Date.now() + timeoutMin * 60e3;
    let okSince = 0;
    while (Date.now() < deadline) {
      if (page.isClosed()) return null;
      let onSite = false;
      let path = '';
      try {
        const u = new URL(page.url());
        onSite = u.hostname === host || u.hostname.endsWith('.' + host);
        path = u.pathname;
      } catch {}
      const ok = onSite && !cfg.blocked.test(path) && (await hasSession(ctx, platform));
      if (ok) {
        // stay "ok" for a few seconds so post-login redirects/cookies settle
        okSince ||= Date.now();
        if (Date.now() - okSince > 5000) return await ctx.cookies(cfg.origin);
      } else okSince = 0;
      await sleep(1500);
    }
    return null;
  } finally {
    await ctx.close().catch(() => {});
  }
}
