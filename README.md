# LCK News Bot

Posts new posts from LCK team and LCK news accounts on **X** into a Discord channel,
checked **every minute**. Free, no X API key, no X login.

## How it works

```
Cloudflare Worker `lck-news-x` (cron * * * * *, free plan)
  12 X accounts -> api.fxtwitter.com/2/profile/<handle>/statuses   (login-free)
  new posts     -> Discord embeds (REST, bot token)
  seen posts    -> one Durable Object (strongly consistent: a post never goes out twice,
                   a check still running blocks the next one)
```

- First look at each account only memorises its existing posts (nothing is spammed).
- Only posts younger than `maxAgeHours` (48 h) are ever sent. Reposts are skipped
  (`includeRetweets`), replies to other people are skipped, quote posts are shown with the quote.
- Same post seen through two accounts is sent once.
- FxTwitter randomly answers "no posts" for some accounts on some minutes (each gets one retry);
  a missed account is read the next minute, so a new post usually lands within 1–2 minutes.
- If no X account can be read for 3 h (FxTwitter down), one alert in the channel; one more when
  it recovers.

## Secrets (never in the repo)

| Cloudflare Worker secret | What            | Set by                                   |
|--------------------------|-----------------|------------------------------------------|
| `DISCORD_TOKEN`          | bot token       | `npm run deploy:worker` (from `.env`)    |
| `DISCORD_CHANNEL_ID`     | target channel  | `npm run deploy:worker` (from `.env`)    |

`.env` (gitignored) holds the same two values; `npm run setup` writes it. The deploy script pipes
them to Cloudflare over stdin — they are never printed.

## Commands (on this PC)

```
npm install
npm run setup              # local page: Discord token, invite the bot, test message
npm run deploy:worker      # deploy the Worker (after any code or sources.json change)
npm run logs:worker        # live log: one line per minute, "N/12 X accounts ok, M posted"
npm run check              # read every source from this PC, print a table, change nothing
node src/bot.mjs preview T1LoL   # post that account's newest post (format check)
```

First deploy on a Cloudflare account needs `npx wrangler login` (browser) and the account's
workers.dev subdomain (open dash.cloudflare.com → Workers & Pages once).

## Sources

Edit `sources.json` (`handle`, `label`, `color`), push, and run `npm run deploy:worker`
(the Worker bundles its own copy). `npm run check` shows whether every handle resolves.

KT Rolster has no usable X account (`@KTRolster_tw` is protected), so KT is not covered.

## Notes

- Free-plan use: ~1,440 Worker runs a day (limit 100,000); Durable Object storage is written
  only when something changes.
- The `src/` Node code still supports Instagram and a logged-in X session for runs on this PC
  (`npm run once`), but nothing in the cloud uses them. Don't run `npm run once` / `npm start`
  while the Worker is live — they keep separate state and would post the same news twice.
- GitHub Actions is no longer used (its schedule never fired for this repo); the old workflow is
  disabled and removed.
