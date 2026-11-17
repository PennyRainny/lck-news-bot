// npm run deploy:worker — deploy the X Worker to Cloudflare, then copy DISCORD_TOKEN and
// DISCORD_CHANNEL_ID from .env into its secrets (piped on stdin, never printed).
// First time: `npx wrangler login` opens a browser to log in to Cloudflare.
import { spawnSync } from 'node:child_process';
import { ROOT, loadEnv } from '../src/util.mjs';

loadEnv();
const wrangler = (args, input) => {
  const r = spawnSync('npx', ['-y', 'wrangler@4', ...args, '-c', 'worker/wrangler.toml'], {
    cwd: ROOT,
    shell: process.platform === 'win32',
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`wrangler ${args[0]} failed (exit ${r.status})`);
};

const secrets = ['DISCORD_TOKEN', 'DISCORD_CHANNEL_ID'];
for (const name of secrets) if (!process.env[name]?.trim()) throw new Error(`${name} is missing in .env (run: npm run setup)`);

wrangler(['deploy']);
for (const name of secrets) wrangler(['secret', 'put', name], process.env[name].trim());
console.log(`Worker deployed; it checks the X accounts every minute. Secrets set: ${secrets.join(', ')}`);
