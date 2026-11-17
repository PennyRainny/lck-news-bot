// X (Twitter): open the profile in the logged-in headless browser and read the
// UserTweets GraphQL response the page itself requests. No X API key needed.
import { SourceError, decodeEntities } from './util.mjs';
import { hasSession, LOGIN } from './browser.mjs';

const TIMELINE_RE = /\/i\/api\/graphql\/[^/]+\/UserTweets(\?|$)/;
const USER_RE = /\/i\/api\/graphql\/[^/]+\/UserByScreenName(\?|$)/;

const unwrap = (r) => (r?.__typename === 'TweetWithVisibilityResults' ? r.tweet : r);
const userOf = (r) => r?.core?.user_results?.result;
const screenName = (u) => u?.core?.screen_name || u?.legacy?.screen_name;

// Every timeline entry holds its tweet under `tweet_results`; quoted tweets and
// retweets live deeper (quoted_status_result / retweeted_status_result), so we stop
// descending once we hit one. Promoted entries carry promotedMetadata.
function collect(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  if (node.tweet_results?.result) {
    if (!node.promotedMetadata) out.push(node.tweet_results.result);
    return;
  }
  for (const k in node) collect(node[k], out);
}

function cleanText(t) {
  const L = t.legacy;
  const note = t.note_tweet?.note_tweet_results?.result;
  let text = note?.text || L.full_text || '';
  const urls = [...(L.entities?.urls || []), ...(note?.entity_set?.urls || [])];
  for (const u of urls) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  for (const m of L.entities?.media || []) if (m.url) text = text.split(m.url).join('');
  return decodeEntities(text).trim();
}

function normalize(raw, handle) {
  const t = unwrap(raw);
  if (!t?.legacy) return null;
  const author = screenName(userOf(t));
  if (!author || author.toLowerCase() !== handle.toLowerCase()) return null;
  const L = t.legacy;
  // replies to other people are noise; self-threads are kept
  if (L.in_reply_to_screen_name && L.in_reply_to_screen_name.toLowerCase() !== handle.toLowerCase()) return null;

  const rt = unwrap(L.retweeted_status_result?.result);
  const main = rt?.legacy ? rt : t; // what the post actually shows
  const ML = main.legacy;
  const mainAuthor = screenName(userOf(main)) || author;
  const id = ML.id_str || main.rest_id;
  const media = (ML.extended_entities?.media || ML.entities?.media || [])[0];

  const q = unwrap(main.quoted_status_result?.result);
  const quote = q?.legacy ? { author: '@' + (screenName(userOf(q)) || '?'), text: cleanText(q) } : null;

  return {
    key: `x:${id}`, // canonical id, so the same retweet from two teams posts once
    platform: 'x',
    id,
    url: `https://x.com/${mainAuthor}/status/${id}`,
    kind: rt?.legacy ? 'repost' : quote ? 'quote' : 'post',
    repostOf: rt?.legacy ? '@' + mainAuthor : null,
    text: cleanText(main),
    image: media?.media_url_https || null,
    isVideo: media ? media.type !== 'photo' : false,
    quote,
    createdAt: Date.parse(rt?.legacy ? L.created_at : ML.created_at) || Date.now(),
  };
}

function profileOf(userJson) {
  const u = userJson?.data?.user?.result;
  if (!u) return null;
  if (u.__typename && u.__typename !== 'User') return { unavailable: u.__typename };
  return {
    name: u.core?.name || u.legacy?.name,
    avatar: (u.avatar?.image_url || u.legacy?.profile_image_url_https || '').replace('_normal.', '_200x200.') || null,
    followers: u.legacy?.followers_count ?? null,
    protected: !!(u.privacy?.protected ?? u.legacy?.protected),
  };
}

export async function fetchX(page, src) {
  let userJson;
  const onResponse = async (r) => {
    if (USER_RE.test(r.url())) userJson = await r.json().catch(() => undefined);
  };
  page.on('response', onResponse);
  try {
    const timeline = page.waitForResponse((r) => TIMELINE_RE.test(r.url()), { timeout: 25000 }).catch(() => null);
    await page.goto(`https://x.com/${encodeURIComponent(src.handle)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const resp = await timeline;
    const path = new URL(page.url()).pathname;

    if (LOGIN.x.blocked.test(path)) {
      if (path.startsWith('/account/access')) throw new SourceError('CHECKPOINT', 'X wants a verification', { url: page.url() });
      throw new SourceError('LOGIN', 'X redirected to login');
    }
    if (!resp) {
      if (!(await hasSession(page.context(), 'x'))) throw new SourceError('LOGIN', 'X session missing');
      const prof = profileOf(userJson);
      if (userJson && !prof) throw new SourceError('NOTFOUND', `@${src.handle} does not exist`);
      if (prof?.unavailable) throw new SourceError('NOTFOUND', `@${src.handle} unavailable (${prof.unavailable})`);
      if (prof?.protected) throw new SourceError('NOTFOUND', `@${src.handle} is protected`);
      throw new Error('timeline did not load (rate limit or slow page)');
    }
    if (resp.status() === 429) throw new SourceError('RATE', 'X rate limit (429)');
    if (!resp.ok()) throw new Error(`timeline HTTP ${resp.status()}`);

    const json = await resp.json();
    const raws = [];
    collect(json?.data, raws);
    const seen = new Set();
    const posts = [];
    for (const r of raws) {
      const p = normalize(r, src.handle);
      if (p && !seen.has(p.key)) {
        seen.add(p.key);
        posts.push(p);
      }
    }
    posts.sort((a, b) => a.createdAt - b.createdAt);
    return { profile: profileOf(userJson), posts };
  } finally {
    page.off('response', onResponse);
  }
}
