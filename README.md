# LCK News Bot

Posts new posts from LCK team and LCK news accounts (X + Instagram) into a Discord channel.
Runs free on **GitHub Actions** every ~10 minutes. No X/Instagram API keys.

- **X**: read through FxTwitter's public API (`api.fxtwitter.com`) — no login, no browser.
  An account FxTwitter misses on one run is picked up on the next. A logged-in X session is
  only a backup (it works from this PC; from GitHub, X's Cloudflare check blocks it).
- **Instagram**: a headless Chrome with your Instagram session opens the profile and reads the
  posts from the page's own GraphQL response (`PolarisProfilePostsQuery`).

## How it works

```
GitHub Actions (cron */10)                     this PC (only when a human is needed)
  restore state.json  <- branch `state`          npm run setup  -> local page:
  headless Chrome + session cookies                 Discord token, invite, test message
    X: profile page -> UserTweets JSON              Log in to X / Instagram (Chrome window)
    IG: web_profile_info JSON                         -> session sent to GitHub Secrets
  new posts -> Discord embeds (REST)             npm run login  -> re-login when Discord says
  save state.json     -> branch `state`                           a session stopped working
```

- First look at each account only memorises its existing posts (nothing is spammed).
- Only posts younger than `maxAgeHours` (48 h) are ever sent. Reposts are skipped
  (`includeRetweets`), replies to other people are skipped, quote posts are shown with the quote.
- Same post seen through two accounts is sent once.
- Instagram is checked every 30 min, X every 10 min (`sources.json`).
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
```

## Sources

Edit `sources.json` (`platform`: `x` | `instagram`, `handle`, `label`, `color`) and push.
`npm run check` shows whether every handle resolves.

## Notes

- Use a spare X / Instagram account: automated reading can get an account limited.
- Instagram is strict about logins from cloud IPs; if it keeps asking for verification,
  approve "This was me" in the app and run `npm run login -- instagram` again.
- GitHub starts scheduled runs late under load (5–20 min is normal).
