// Instagram: open the profile page in the logged-in headless browser and read the posts
// from the GraphQL responses the page itself requests (PolarisProfilePostsQuery ->
// xdt_api__v1__feed__user_timeline_graphql_connection). The old web_profile_info endpoint
// returns 404 since late 2026. Never scrapes logged out.
import { SourceError, decodeEntities } from './util.mjs';
import { hasSession, LOGIN } from './browser.mjs';

const GQL_RE = /instagram\.com\/(api\/graphql|graphql\/query)/;
const friendlyName = (req) =>
  req.headers()['x-fb-friendly-name'] || (req.postData() || '').match(/fb_api_req_friendly_name=([^&]+)/)?.[1] || '';

// Responses can carry a `for (;;);` guard or several JSON documents, one per line.
function parseMany(text) {
  const t = String(text || '').replace(/^for \(;;\);/, '');
  try {
    return [JSON.parse(t)];
  } catch {}
  return t
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  visit(node);
  for (const k in node) walk(node[k], visit);
}

const bestImage = (m) =>
  m.image_versions2?.candidates?.[0]?.url || m.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url || m.display_uri || null;

export async function fetchInstagram(page, src) {
  if (!(await hasSession(page.context(), 'instagram'))) throw new SourceError('LOGIN', 'Instagram session missing');
  const me = src.handle.toLowerCase();
  const bodies = [];
  const onResponse = (r) => {
    if (GQL_RE.test(r.url())) bodies.push(r.text().catch(() => ''));
  };
  page.on('response', onResponse);
  try {
    const postsLoaded = page
      .waitForResponse((r) => GQL_RE.test(r.url()) && friendlyName(r.request()) === 'PolarisProfilePostsQuery', { timeout: 30000 })
      .catch(() => null);
    const nav = await page.goto(`https://www.instagram.com/${encodeURIComponent(src.handle)}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const path = new URL(page.url()).pathname;
    if (/^\/(challenge|checkpoint|auth_platform)/.test(path)) throw new SourceError('CHECKPOINT', 'Instagram wants a verification', { url: page.url() });
    if (LOGIN.instagram.blocked.test(path)) throw new SourceError('LOGIN', 'Instagram redirected to login');
    if (nav?.status() === 404) throw new SourceError('NOTFOUND', `@${src.handle} not found`);
    if (nav?.status() === 429) throw new SourceError('RATE', 'Instagram rate limit (429)');
    await postsLoaded;
    await page.waitForTimeout(1500); // let the profile-header query land too

    const docs = (await Promise.all(bodies)).flatMap(parseMany);
    const posts = [];
    const seen = new Set();
    let profile = null;
    walk(docs, (n) => {
      if (typeof n.code === 'string' && n.taken_at && (n.image_versions2 || n.carousel_media) && n.user?.username?.toLowerCase() === me) {
        if (seen.has(n.code)) return;
        seen.add(n.code);
        posts.push({
          key: `ig:${n.code}`,
          platform: 'instagram',
          id: n.code,
          url: `https://www.instagram.com/p/${n.code}/`,
          kind: 'post',
          text: decodeEntities(n.caption?.text || '').trim(),
          image: bestImage(n),
          isVideo: n.media_type === 2 || !!n.video_versions?.length,
          createdAt: n.taken_at * 1000,
        });
      } else if (!profile && n.username?.toLowerCase() === me && 'full_name' in n && n.profile_pic_url) {
        profile = { name: n.full_name || src.handle, avatar: n.hd_profile_pic_url_info?.url || n.profile_pic_url, followers: n.follower_count ?? null };
      }
    });
    if (!posts.length) {
      if (/not found|isn.t available/i.test(await page.title().catch(() => ''))) throw new SourceError('NOTFOUND', `@${src.handle} not found`);
      throw new Error('Instagram posts did not load');
    }
    posts.sort((a, b) => a.createdAt - b.createdAt);
    return { profile, posts };
  } finally {
    page.off('response', onResponse);
  }
}
