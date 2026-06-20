/**
 * Fix Internal Links — cleanup script for EXISTING published WordPress posts.
 *
 * For every published post, find anchors whose href is a "?p=ID" form and:
 *   - target PUBLISHED  → rewrite href to the canonical permalink
 *   - target DRAFT/gone → unwrap the anchor (keep the text, drop the dead link
 *                          so visitors don't hit a 404)
 *
 * Uses AUTHENTICATED REST so it can see draft/private targets (the public API
 * returns 401/404 for them, which is why ?p=ID drafts slipped through before).
 * Also wraps standalone plain-text site URLs as clickable <a> (skips ?p= ones).
 *
 * DRY-RUN by default. Pass --commit to actually update posts.
 * Usage:
 *   node scripts/fix-internal-links.mjs leagueofcooking            # dry run
 *   node scripts/fix-internal-links.mjs leagueofcooking --commit   # write
 *   node scripts/fix-internal-links.mjs leagueofcooking --limit=5  # first 5 posts
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const SITE_ID = args.find(a => !a.startsWith('--')) || 'leagueofcooking';
const COMMIT = args.includes('--commit');
const LIMIT = Number(args.find(a => a.startsWith('--limit='))?.slice(8) || 0);

const ok = m => console.log(`[OK]  ${m}`);
const info = m => console.log(`[INFO] ${m}`);
const dry = m => console.log(`[DRY] ${m}`);
const err = m => console.log(`[ERR] ${m}`);

async function loadSettings(siteId) {
  return JSON.parse(await readFile(join(PROJECT_ROOT, 'data', 'sites', siteId, 'settings.json'), 'utf8'));
}
function authHeader(s) {
  return 'Basic ' + Buffer.from(`${s.wpUsername}:${s.wpAppPassword}`).toString('base64');
}

async function listAllPosts(settings) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const url = `${settings.wpUrl}/wp-json/wp/v2/posts?per_page=50&page=${page}&status=publish&context=edit&_fields=id,link,title,content&orderby=date&order=desc`;
    const res = await fetch(url, { headers: { Authorization: authHeader(settings) } });
    if (!res.ok) { if (res.status === 400 && page > 1) break; throw new Error(`WP REST ${res.status} page ${page}`); }
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const p of arr) {
      out.push({ id: p.id, link: p.link, title: (p.title?.raw || p.title?.rendered || ''), content: (p.content?.raw ?? p.content?.rendered ?? '') });
      if (LIMIT > 0 && out.length >= LIMIT) return out;
    }
    if (arr.length < 50) break;
  }
  return out;
}

// AUTHENTICATED target resolution → { status, link }
const _targetCache = new Map();
async function resolveTarget(postId, settings) {
  if (_targetCache.has(postId)) return _targetCache.get(postId);
  let out = { status: 'missing', link: '' };
  try {
    const url = `${settings.wpUrl}/wp-json/wp/v2/posts/${postId}?context=edit&_fields=status,link`;
    const res = await fetch(url, { headers: { Authorization: authHeader(settings) }, signal: AbortSignal.timeout(8000) });
    if (res.ok) { const j = await res.json(); out = { status: j.status || 'unknown', link: j.link || '' }; }
  } catch {}
  _targetCache.set(postId, out);
  return out;
}

async function fixPostContent(content, settings) {
  if (!content) return null;
  let result = content;
  let fixed = 0, unlinked = 0, wrapped = 0;
  const host = settings.wpUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

  // Pass 1: ?p=ID anchors → permalink (published) or unlink (draft/missing)
  const fullAnchorRe = /<a\b([^>]*?)href=["']([^"']*[?&]p=(\d+)[^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of [...result.matchAll(fullAnchorRe)]) {
    const [full, pre, href, id, post2, inner] = m;
    if (!href.includes(host)) continue;
    const t = await resolveTarget(id, settings);
    if (t.status === 'publish' && t.link && !/[?&]p=\d/.test(t.link)) {
      result = result.split(full).join(`<a${pre}href="${t.link}"${post2}>${inner}</a>`);
      fixed++;
    } else {
      result = result.split(full).join(inner); // dead draft/missing link → keep text only
      unlinked++;
    }
  }

  // Pass 2: wrap standalone plain-text site URLs (skip assets + ?p= forms)
  const hostEscaped = host.replace(/\./g, '\\.');
  const urlRegex = new RegExp(`(?<!["'=>])\\b(https?://${hostEscaped}/[^\\s<>"']+)`, 'g');
  const isAsset = u => /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|zip|mp4|webm)$/i.test(u);
  const parts = result.split(/(<code[\s\S]*?<\/code>|<pre[\s\S]*?<\/pre>)/gi);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue;
    parts[i] = parts[i].replace(urlRegex, (mm, url) => {
      if (isAsset(url) || /[?&]p=\d/.test(url)) return url; // don't wrap ?p= into a new broken link
      wrapped++;
      return `<a href="${url}">${url}</a>`;
    });
  }
  result = parts.join('');

  if (fixed === 0 && unlinked === 0 && wrapped === 0) return null;
  return { newContent: result, fixed, unlinked, wrapped };
}

async function updatePost(settings, postId, newContent) {
  const res = await fetch(`${settings.wpUrl}/wp-json/wp/v2/posts/${postId}`, {
    method: 'POST',
    headers: { Authorization: authHeader(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: newContent }),
  });
  if (!res.ok) throw new Error(`update ${postId} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

async function main() {
  console.log('='.repeat(60));
  console.log(` Internal Link Cleanup — site: ${SITE_ID} — ${COMMIT ? 'COMMIT (writing!)' : 'DRY-RUN'}`);
  console.log('='.repeat(60));
  const settings = await loadSettings(SITE_ID);
  info(`Target: ${settings.wpUrl} (user: ${settings.wpUsername})`);
  info('Fetching published posts...');
  const posts = await listAllPosts(settings);
  info(`Found ${posts.length} published post(s).`);

  let modified = 0, tFixed = 0, tUnlinked = 0, tWrapped = 0;
  const errors = [];
  for (const post of posts) {
    const fix = await fixPostContent(post.content, settings);
    if (!fix) continue;
    modified++; tFixed += fix.fixed; tUnlinked += fix.unlinked; tWrapped += fix.wrapped;
    const summary = `#${post.id} "${post.title.replace(/<[^>]+>/g, '').slice(0, 50)}" — ${fix.fixed} fixed→permalink · ${fix.unlinked} dead unlinked · ${fix.wrapped} wrapped`;
    if (COMMIT) {
      try { await updatePost(settings, post.id, fix.newContent); ok(summary); }
      catch (e) { err(`#${post.id}: ${e.message}`); errors.push(post.id); }
    } else dry(summary);
  }

  console.log('='.repeat(60));
  info(`Posts changed: ${modified} | links→permalink: ${tFixed} | dead unlinked: ${tUnlinked} | wrapped: ${tWrapped}`);
  if (errors.length) err(`${errors.length} write error(s): ${errors.join(', ')}`);
  if (!COMMIT && modified > 0) info('Re-run with --commit to apply.');
  console.log('='.repeat(60));
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
