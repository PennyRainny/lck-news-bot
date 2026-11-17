// Shared helpers: paths, logging, .env, state, sources.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS = {
  env: join(ROOT, '.env'),
  state: join(ROOT, 'state.json'),
  sources: join(ROOT, 'sources.json'),
  profile: join(ROOT, '.browser-profile'),
  logs: join(ROOT, 'logs'),
};

export const PLATFORMS = ['x', 'instagram'];
export const PLATFORM_NAME = { x: 'X', instagram: 'Instagram' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min, max) => sleep(min + Math.random() * (max - min));

export function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    mkdirSync(PATHS.logs, { recursive: true });
    appendFileSync(join(PATHS.logs, 'bot.log'), line + '\n');
  } catch {}
}

// Error with a machine-readable code: LOGIN | CHECKPOINT | RATE | NOTFOUND
export class SourceError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export function loadEnv() {
  if (existsSync(PATHS.env)) process.loadEnvFile(PATHS.env);
}

// Replace/add keys in .env without touching other lines. Values never get logged.
export function writeEnv(updates) {
  const lines = existsSync(PATHS.env) ? readFileSync(PATHS.env, 'utf8').split(/\r?\n/) : [];
  const left = { ...updates };
  const out = lines.map((l) => {
    const k = l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1];
    if (k && k in left) {
      const v = left[k];
      delete left[k];
      return `${k}=${v}`;
    }
    return l;
  });
  for (const [k, v] of Object.entries(left)) out.push(`${k}=${v}`);
  writeFileSync(PATHS.env, out.join('\n').replace(/\n*$/, '\n'));
  Object.assign(process.env, updates);
}

export function loadState() {
  let s = {};
  try {
    s = JSON.parse(readFileSync(PATHS.state, 'utf8'));
  } catch {}
  for (const k of ['seen', 'seeded', 'lastRun', 'login', 'alerts', 'humanWaitUntil', 'dead']) s[k] ??= {};
  return s;
}

export function saveState(s) {
  writeFileSync(PATHS.state + '.tmp', JSON.stringify(s, null, 1));
  renameSync(PATHS.state + '.tmp', PATHS.state);
}

export function loadSources() {
  const cfg = JSON.parse(readFileSync(PATHS.sources, 'utf8'));
  cfg.intervalsMinutes = { x: 10, instagram: 30, ...cfg.intervalsMinutes };
  cfg.cronMinutes ??= 10;
  cfg.maxAgeHours ??= 48;
  cfg.includeRetweets ??= false;
  for (const s of cfg.sources) {
    if (!PLATFORMS.includes(s.platform)) throw new Error(`sources.json: unknown platform "${s.platform}"`);
    s.label ??= s.handle;
  }
  return cfg;
}

export const srcKey = (src) => `${src.platform}:${src.handle.toLowerCase()}`;

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
