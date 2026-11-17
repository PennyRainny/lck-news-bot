// X (Twitter), two routes, no X API key either way:
//  1. fetchXFx  — FxTwitter's public API (api.fxtwitter.com): no login, no browser. Primary.
//  2. fetchX    — the logged-in headless browser reads the UserTweets GraphQL response the
//                 profile page requests. Backup when FxTwitter fails / returns nothing.
import { SourceError, decodeEntities, sleep } from './util.mjs';
import { hasSession, LOGIN } from './browser.mjs';

const FX = 'https://api.fxtwitter.com/2/profile/';

export async function fetchXFx(src) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(FX + encodeURIComponent(src.handle) + '/statuses', {
        headers: { 'User-Agent': 'lck-news-bot/1.0' },
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.code === 200 && j.results?.length) return parseFx(j, src.handle);
      last = new Error(`FxTwitter HTTP ${r.status}${j?.message ? ' ' + j.message : ''}${j?.results ? ' (no posts)' : ''}`);
    } catch (e) {
      last = new Error(`FxTwitter ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
    }
    if (attempt === 0) await sleep(2000);
  }
  throw last;
}

export function parseFx(j, handle) {
  const me = handle.toLowerCase();
  let profile = null;
  const posts = [];
  const seen = new Set();
  for (const s of j.results || []) {
    if (s.type && s.type !== 'status') continue;
    const author = s.author?.screen_name || '';
    const mine = author.toLowerCase() === me;
    if (!profile && (mine || s.reposted_by)) {
      const u = mine ? s.author : s.reposted_by;
      profile = { name: u.name, avatar: u.avatar_url || null, followers: u.followers ?? null };
    }
    const repost = !!s.reposted_by;
    if (!repost && !mine) continue;
    const replyTo = typeof s.replying_to === 'string' ? s.replying_to : s.replying_to?.screen_name;
    if (!repost && replyTo && replyTo.toLowerCase() !== me) continue; // replies to other people
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const m = s.media?.all?.[0];
    const q = s.quote;
    posts.push({
      key: `x:${s.id}`,
      platform: 'x',
      id: s.id,
      url: `https://x.com/${author}/status/${s.id}`,
      kind: repost ? 'repost' : q ? 'quote' : 'post',
      repostOf: repost ? '@' + author : null,
      text: String(s.text || '').trim(),
      image: m ? (m.type === 'photo' ? m.url : m.thumbnail_url || null) : null,
      isVideo: !!m && m.type !== 'photo',
      quote: q ? { author: '@' + (q.author?.screen_name || '?'), text: String(q.text || '').trim() } : null,
      createdAt: (s.created_timestamp || 0) * 1000 || Date.parse(s.created_at) || Date.now(),
    });
  }
  posts.sort((a, b) => a.createdAt - b.createdAt);
  return { profile, posts };
}

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

    return { profile: profileOf(userJson), posts: parseTimeline(await resp.json(), src.handle) };
  } finally {
    page.off('response', onResponse);
  }
}

export function parseTimeline(json, handle) {
  const raws = [];
  collect(json?.data, raws);
  const seen = new Set();
  const posts = [];
  for (const r of raws) {
    const p = normalize(r, handle);
    if (p && !seen.has(p.key)) {
      seen.add(p.key);
      posts.push(p);
    }
  }
  return posts.sort((a, b) => a.createdAt - b.createdAt);
}
