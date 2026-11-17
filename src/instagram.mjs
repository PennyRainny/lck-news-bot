// Instagram: call the same web_profile_info endpoint instagram.com uses, from inside
// the logged-in page so the session cookie rides along. Never scrapes logged out.
import { SourceError, decodeEntities } from './util.mjs';
import { hasSession, LOGIN } from './browser.mjs';

const IG_APP_ID = '936619743392459'; // public id of the instagram.com web app

async function igGet(page, path) {
  return page.evaluate(
    async ({ path, appId }) => {
      const r = await fetch(path, { headers: { 'x-ig-app-id': appId, 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' });
      return { status: r.status, url: r.url, text: await r.text() };
    },
    { path, appId: IG_APP_ID },
  );
}

function judge(res, handle) {
  let j = null;
  try {
    j = JSON.parse(res.text);
  } catch {}
  const msg = `${j?.message || ''} ${res.text.slice(0, 200)}`;
  if (res.status === 200 && j) return j;
  if (j?.checkpoint_url || /checkpoint_required|challenge_required/.test(msg))
    throw new SourceError('CHECKPOINT', 'Instagram wants a verification', { url: j?.checkpoint_url ? new URL(j.checkpoint_url, 'https://www.instagram.com').href : undefined });
  if (res.status === 429 || /wait a few minutes/i.test(msg)) throw new SourceError('RATE', `Instagram rate limit (${res.status})`);
  if (/login_required/.test(msg) || /\/accounts\/login/.test(res.url)) throw new SourceError('LOGIN', 'Instagram session expired');
  if (res.status === 404) throw new SourceError('NOTFOUND', `@${handle} not found`);
  throw new Error(`Instagram HTTP ${res.status}: ${(j?.message || res.text).slice(0, 120)}`);
}

const firstImage = (it) =>
  it?.image_versions2?.candidates?.[0]?.url || it?.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url || null;

export async function fetchInstagram(page, src) {
  if (!(await hasSession(page.context(), 'instagram'))) throw new SourceError('LOGIN', 'Instagram session missing');
  if (!page.url().startsWith(LOGIN.instagram.origin)) {
    await page.goto(LOGIN.instagram.origin + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (LOGIN.instagram.blocked.test(new URL(page.url()).pathname)) {
      const path = new URL(page.url()).pathname;
      if (/challenge|checkpoint/.test(path)) throw new SourceError('CHECKPOINT', 'Instagram wants a verification', { url: page.url() });
      throw new SourceError('LOGIN', 'Instagram redirected to login');
    }
  }

  const info = judge(await igGet(page, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(src.handle)}`), src.handle);
  const user = info?.data?.user;
  if (!user) throw new SourceError('NOTFOUND', `@${src.handle} not found`);
  const profile = { name: user.full_name || src.handle, avatar: user.profile_pic_url_hd || user.profile_pic_url || null, followers: user.edge_followed_by?.count ?? null };

  let posts = (user.edge_owner_to_timeline_media?.edges || []).map(({ node: n }) => ({
    key: `ig:${n.shortcode}`,
    platform: 'instagram',
    id: n.shortcode,
    url: `https://www.instagram.com/p/${n.shortcode}/`,
    kind: 'post',
    text: decodeEntities(n.edge_media_to_caption?.edges?.[0]?.node?.text || '').trim(),
    image: n.display_url || n.thumbnail_src || null,
    isVideo: !!n.is_video,
    createdAt: (n.taken_at_timestamp || 0) * 1000,
  }));

  // Some responses ship the profile without posts; the feed endpoint has them.
  if (!posts.length && user.id && (user.edge_owner_to_timeline_media?.count ?? 1) > 0) {
    const feed = judge(await igGet(page, `/api/v1/feed/user/${user.id}/?count=12`), src.handle);
    posts = (feed.items || []).map((it) => ({
      key: `ig:${it.code}`,
      platform: 'instagram',
      id: it.code,
      url: `https://www.instagram.com/p/${it.code}/`,
      kind: 'post',
      text: (it.caption?.text || '').trim(),
      image: firstImage(it),
      isVideo: it.media_type === 2,
      createdAt: (it.taken_at || 0) * 1000,
    }));
  }

  posts.sort((a, b) => a.createdAt - b.createdAt);
  return { profile, posts };
}
