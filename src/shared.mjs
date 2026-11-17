// Pure helpers shared by the Node bot (GitHub Actions / this PC) and the Cloudflare Worker.
// No Node or Worker imports here — both runtimes load this file.

export const PLATFORM_NAME = { x: 'X', instagram: 'Instagram' };
export const SEEN_TTL = 7 * 24 * 3600e3; // > maxAgeHours, so an old post can never come back

export const srcKey = (src) => `${src.platform}:${src.handle.toLowerCase()}`;

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// FxTwitter /2/profile/<handle>/statuses -> { profile, posts } (oldest first).
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

// Decide which fetched posts are new. The first look at an account only marks its posts seen.
// Reposts are skipped (unless enabled) WITHOUT being marked seen, so the original author's own
// source can still post them. Returns true when this call seeded the account.
export function queueNew(state, cfg, src, res, outbox, now = Date.now()) {
  const k = srcKey(src);
  const seeding = !state.seeded[k];
  const oldest = now - cfg.maxAgeHours * 3600e3;
  for (const item of res.posts) {
    if (item.kind === 'repost' && !cfg.includeRetweets) continue;
    if (state.seen[item.key]) continue;
    if (seeding || item.createdAt < oldest) {
      state.seen[item.key] = now;
      continue;
    }
    if (!outbox.some((o) => o.item.key === item.key)) outbox.push({ item, src, profile: res.profile });
  }
  if (seeding) state.seeded[k] = now;
  return seeding;
}

export function pruneSeen(state, now = Date.now()) {
  for (const [k, t] of Object.entries(state.seen)) if (now - t > SEEN_TTL) delete state.seen[k];
}

export function toEmbed(item, src, profile) {
  const plat = PLATFORM_NAME[item.platform];
  const profileUrl = item.platform === 'x' ? `https://x.com/${src.handle}` : `https://www.instagram.com/${src.handle}/`;
  let title = item.kind === 'repost' ? `${src.label} reposted ${item.repostOf}` : `${src.label} · new ${plat} post`;
  if (item.isVideo) title += ' ▶️';
  let desc = item.text || '';
  if (item.quote) desc += `\n\n> **${item.quote.author}**: ${truncate(item.quote.text, 400).replace(/\n/g, '\n> ')}`;
  const color = parseInt(String(src.color || '#888888').replace('#', ''), 16);
  const avatar = profile?.avatar && /^https?:\/\//.test(profile.avatar) ? profile.avatar : undefined;
  return {
    title: truncate(title, 256),
    url: item.url,
    description: truncate(desc, item.platform === 'instagram' ? 1500 : 3900) || undefined,
    color: Number.isFinite(color) ? color : 0x888888,
    author: { name: truncate(`${profile?.name || src.label} (@${src.handle})`, 256), url: profileUrl, icon_url: avatar },
    image: item.image ? { url: item.image } : undefined,
    footer: { text: item.isVideo ? `${plat} · video — open the post to watch` : plat },
    timestamp: new Date(item.createdAt).toISOString(),
  };
}
