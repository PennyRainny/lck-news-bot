// Cloudflare Worker: checks the X accounts every minute (cron "* * * * *") and posts new posts
// to Discord. Seen-post state lives in ONE Durable Object: strongly consistent, and a check that
// is still running blocks the next one, so a post can never go out twice.
import { DurableObject } from 'cloudflare:workers';
import sources from '../sources.json';
import { tick } from './tick.mjs';

export class Ticker extends DurableObject {
  busy = false;

  async tick() {
    if (this.busy) return 'previous check still running';
    this.busy = true;
    try {
      const r = await tick({ env: this.env, storage: this.ctx.storage, sources });
      return r.skipped ? 'skipped' : `${r.rows.filter((x) => x.ok).length}/${r.rows.length} ok, ${r.posted} posted`;
    } finally {
      this.busy = false;
    }
  }
}

export default {
  async scheduled(_controller, env) {
    await env.TICKER.get(env.TICKER.idFromName('x')).tick();
  },
};
