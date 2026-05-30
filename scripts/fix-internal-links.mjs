/**
 * Fix Internal Links — cleanup script for existing WordPress posts.
 *
 * Scans every published post on a site, finds:
 *   1. Anchors with href="?p=ID" → resolves canonical permalink, replaces
 *   2. Plain-text URLs (https://siteHost/...) NOT inside an <a> tag → wraps as <a>
 *
 * Both fixes are user-visibility fixes:
 *   - ?p=ID anchors "work" via WP redirect but some clients/browsers don't
 *     follow cleanly. Replacing with canonical is cleaner + SEO-friendlier.
 *   - Plain-text URLs aren't clickable. Users see "https://..." but can't tap.
 *
 * Idempotent: re-running over a clean post is a no-op.
 *
 * Usage:
 *   node scripts/fix-internal-links.mjs leagueofcooking           # DRY RUN
 *   node scripts/fix-internal-links.mjs leagueofcooking --commit  # write
 *
 * Defaults to dry-run for safety. Writes are made via WP REST PUT.
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const SITE_ID = args.find(a => !a.startsWith('--')) || 'leagueofcooking';
const COMMIT = args.includes('--commit');
const LIMIT = Number(args.find(a => a.startsWith('--limit='))?.slice(8) || 0);  // 0 = all

const ok   = m => console.log(`\x1b[32m[OK]\x1b[0m   ${m}`);
const info = m => console.log(`\x1b[34m[INFO]\x1b[0m ${m}`);
const warn = m => console.log(`\x1b[33m[WARN]\x1b[0m ${m}`);
const err  = m => console.log(`\x1b[31m[ERR]\x1b[0m  ${m}`);
const dry  = m => console.log(`\x1b[36m[DRY]\x1b[0m  ${m}`);

async function loadSettings(siteId) {
  const p = join(PROJECT_ROOT, 'data', 'sites', siteId, 'settings.json');
  return JSON.parse(await readFile(p, 'utf8'));
}

function authHeader(settings) {
  const { wpUsername, wpAppPassword } = settings;
  return 'Basic ' + Buffer.from(`${wpUsername}:${wpAppPassword}`).toString('base64');
}

async function listAllPosts(settings) {
  const out = [];
  let page = 1;
  while (true) {
    const url = `${settings.wpUrl}/wp-json/wp/v2/posts?per_page=100&page=${page}&status=publish&_fields=id,link,title,content,modified&orderby=date&order=desc`;
    const res = await fetch(url, { headers: { Authorization: authHeader(settings) } });
    if (!res.ok) {
      // page=N beyond last returns 400 — stop
      if (res.status === 400 && page > 1) break;
      throw new Error(`WP REST ${res.status} for page ${page}`);
    }
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const p of arr) {
      out.push({
        id: p.id,
        link: p.link,
        title: p.title?.rendered || '',
        content: p.content?.rendered || '',
        modified: p.modified,
      });
      if (LIMIT > 0 && out.length >= LIMIT) return out;
    }
    if (arr.length < 100) break;
    page++;
  }
  return out;
}

// Cache resolved permalinks
const _canonicalCache = new Map();
async function resolveCanonical(rawUrl, settings) {
  if (!rawUrl) return rawUrl;
  let origin, postId;
  try {
    const u = new URL(rawUrl);
    origin = u.origin;
    postId = u.searchParams.get('p');
  } catch { return rawUrl; }
  if (!postId || !/^\d+$/.test(postId)) return rawUrl;
  const key = `${origin}|${postId}`;
  if (_canonicalCache.has(key)) return _canonicalCache.get(key);
  try {
    const url = `${origin}/wp-json/wp/v2/posts/${postId}?_fields=link`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j = await res.json();
      if (j?.link) {
        _canonicalCache.set(key, j.link);
        return j.link;
      }
    }
  } catch {}
  _canonicalCache.set(key, rawUrl);
  return rawUrl;
}

/**
 * Returns { newContent, changes: { canonicalized, wrapped } } or null if no changes.
 */
async function fixPostContent(content, settings) {
  if (!content) return null;
  let result = content;
  let canonicalized = 0;
  let wrapped = 0;
  const host = settings.wpUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

  // ── Pass 1: replace ?p=ID anchor hrefs with canonical ─────────
  const anchorRegex = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>/gi;
  const matches = [...result.matchAll(anchorRegex)];
  for (const m of matches) {
    const fullMatch = m[0];
    const href = m[2];
    if (!href.match(/[?&]p=\d+/)) continue;
    const canonical = await resolveCanonical(href, settings);
    if (canonical && canonical !== href) {
      const newAnchor = `<a${m[1]}href="${canonical}"${m[3]}>`;
      result = result.split(fullMatch).join(newAnchor);
      canonicalized++;
    }
  }

  // ── Pass 2: wrap standalone plain-text URLs as <a> ────────────
  const hostEscaped = host.replace(/\./g, '\\.');
  const urlRegex = new RegExp(`(?<!["'=>])\\b(https?://${hostEscaped}/[^\\s<>"']+)`, 'g');
  const isAsset = u => /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|zip|mp4|webm)$/i.test(u);
  const parts = result.split(/(<code[\s\S]*?<\/code>|<pre[\s\S]*?<\/pre>)/gi);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue;
    parts[i] = parts[i].replace(urlRegex, (m, url) => {
      if (isAsset(url)) return url;
      wrapped++;
      return `<a href="${url}">${url}</a>`;
    });
  }
  result = parts.join('');

  if (canonicalized === 0 && wrapped === 0) return null;
  return { newContent: result, changes: { canonicalized, wrapped } };
}

async function updatePost(settings, postId, newContent) {
  const url = `${settings.wpUrl}/wp-json/wp/v2/posts/${postId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(settings),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: newContent }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WP PUT ${postId} → ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function main() {
  console.log('━'.repeat(60));
  console.log(` Internal Link Cleanup — site: ${SITE_ID}`);
  console.log('━'.repeat(60));
  if (!COMMIT) info('DRY RUN — no writes. Pass --commit to actually update posts.');
  else warn('COMMIT MODE — posts WILL be updated on WordPress.');

  const settings = await loadSettings(SITE_ID);
  info(`Target: ${settings.wpUrl} (user: ${settings.wpUsername})`);

  info('Fetching all published posts...');
  const posts = await listAllPosts(settings);
  info(`Found ${posts.length} published post(s).`);
  if (LIMIT > 0) info(`(--limit=${LIMIT} applied)`);

  let scanned = 0;
  let modified = 0;
  let totalCanonicalized = 0;
  let totalWrapped = 0;
  const errors = [];

  for (const post of posts) {
    scanned++;
    const fix = await fixPostContent(post.content, settings);
    if (!fix) continue;
    modified++;
    totalCanonicalized += fix.changes.canonicalized;
    totalWrapped += fix.changes.wrapped;
    const summary = `#${post.id} "${post.title.slice(0, 60)}" — ${fix.changes.canonicalized} ?p=ID resolved · ${fix.changes.wrapped} URLs wrapped`;
    if (COMMIT) {
      try {
        await updatePost(settings, post.id, fix.newContent);
        ok(summary);
      } catch (e) {
        err(`#${post.id} update failed: ${e.message}`);
        errors.push({ id: post.id, error: e.message });
      }
    } else {
      dry(summary);
    }
  }

  console.log();
  console.log('━'.repeat(60));
  info(`Scanned: ${scanned} · Modified: ${modified}`);
  info(`Total ?p=ID anchors resolved: ${totalCanonicalized}`);
  info(`Total plain-text URLs wrapped: ${totalWrapped}`);
  if (errors.length) {
    err(`${errors.length} error(s) during write:`);
    errors.forEach(e => err(`  #${e.id}: ${e.error}`));
  }
  if (!COMMIT && modified > 0) {
    console.log();
    info('Re-run with --commit to apply these changes.');
  }
  console.log('━'.repeat(60));
}

main().catch(e => {
  console.error('\n❌ Failed:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
