# LCK News Bot

Posts new posts from LCK team and LCK news accounts (X + Instagram) into a Discord channel.
Free to run, no X/Instagram API keys:

- **X — every minute**, on a **Cloudflare Worker** (`worker/`, cron `* * * * *`). It reads
  FxTwitter's public API (`api.fxtwitter.com`): no login, no browser. An account FxTwitter
  misses one minute is picked up the next.
- **Instagram — about every 30 min**, on **GitHub Actions**: a headless Chrome with your
  Instagram session opens the profile and reads the posts from the page's own GraphQL response
  (`PolarisProfilePostsQuery`). Checking more often gets the account locked.

## How it works

```
Cloudflare Worker (cron every minute)          GitHub Actions (cron every 10 min)
  12 X accounts -> api.fxtwitter.com              restore state.json <- branch `state`
  new posts -> Discord embeds (REST)              IG due? (30 min since the last check)
  seen posts -> one Durable Object                  headless Chrome + IG session -> GraphQL
                (strongly consistent:               new posts -> Discord embeds (REST)
                 a post never goes out twice)     save state.json -> branch `state`

this PC (only when a human is needed)
  npm run setup  -> local page: Discord token, invite, test message, Instagram login
  npm run login -- instagram  -> re-login when Discord says the session stopped working
```

The GitHub run sets `BOT_PLATFORMS=instagram`, so X is never checked twice. A logged-in X
session is still supported as a backup for `npm run once` on this PC (from GitHub, X's
Cloudflare check blocks it).

- First look at each account only memorises its existing posts (nothing is spammed).
- Only posts younger than `maxAgeHours` (48 h) are ever sent. Reposts are skipped
  (`includeRetweets`), replies to other people are skipped, quote posts are shown with the quote.
- Same post seen through two accounts is sent once.
- X is checked every minute (Worker), Instagram every 30 min (`sources.json` → `intervalsMinutes`).
- If the Instagram session dies, the bot posts **one** alert in the channel and pauses Instagram
  until a new login arrives (it retries the old one every 6 h).
- If no X account can be read for 3 h (FxTwitter down), one alert; one more when it recovers.

## Secrets (never in the repo)

| GitHub secret        | What                                         | Written by          |
|----------------------|----------------------------------------------|---------------------|
| `DISCORD_TOKEN`      | bot token                                    | setup page          |
| `DISCORD_CHANNEL_ID` | target channel                               | setup page          |
| `X_COOKIES`          | X session cookies (JSON)                     | `npm run login`     |
| `IG_COOKIES`         | Instagram session cookies (JSON)             | `npm run login`     |

The Worker has its own copies of `DISCORD_TOKEN` / `DISCORD_CHANNEL_ID` as Cloudflare secrets
(`npm run deploy:worker` copies them from `.env` over stdin).
Locally the token also sits in `.env` and the logins in `.browser-profile/` — both gitignored.
Cookie values are masked in the Actions log.

## Commands (on this PC)

```
npm install
npm run setup              # setup page: token, invite, test, logins, start cloud
npm run login              # re-login X + Instagram (or: npm run login -- x)
npm run check              # scrape every source, print a table, change nothing
node src/bot.mjs preview T1LoL   # post that account's newest post (format check)
npm run once / npm start   # run on this PC instead of the cloud (don't run both)
npm run deploy:worker      # deploy the every-minute X Worker (after editing sources.json too)
npm run logs:worker        # live log of the Worker's checks
```

After editing `sources.json`, push (GitHub picks it up) **and** run `npm run deploy:worker`
(the Worker has its own copy).

## Sources

Edit `sources.json` (`platform`: `x` | `instagram`, `handle`, `label`, `color`) and push.
`npm run check` shows whether every handle resolves.

## Notes

- Use a spare X / Instagram account: automated reading can get an account limited.
- Instagram is strict about logins from cloud IPs; if it keeps asking for verification,
  approve "This was me" in the app and run `npm run login -- instagram` again.
- GitHub starts scheduled runs late under load (5–20 min is normal) — that is why X moved to the
  Worker, whose cron fires on the minute. Free-plan use: ~1,440 Worker runs a day (limit 100,000).
