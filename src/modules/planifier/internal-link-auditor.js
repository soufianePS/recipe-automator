import { randomUUID } from 'crypto';
import { StateManager } from '../../shared/utils/state-manager.js';
import { Logger } from '../../shared/utils/logger.js';

const jobs = new Map();
const TARGET_STATUSES = new Set(['publish', 'draft', 'future', 'private', 'pending']);

function createJob(site, mode = 'scan') {
  const job = {
    id: randomUUID(),
    site,
    mode,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: { scanned: 0, total: 0, current: '' },
    summary: {
      postsScanned: 0,
      postsWithIssues: 0,
      issuesFound: 0,
      fixable: 0,
      corrected: 0,
      skipped: 0,
      errors: 0,
      byAction: {},
    },
    findings: [],
    results: [],
    log: [],
    error: '',
  };
  jobs.set(job.id, job);
  return job;
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

function addLog(job, msg) {
  job.log.push({ at: new Date().toISOString(), msg });
  if (job.log.length > 100) job.log = job.log.slice(-100);
  touch(job);
}

function normalizeWpUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function basicAuth(settings) {
  if (!settings?.wpUsername || !settings?.wpAppPassword) return {};
  return {
    Authorization: 'Basic ' + Buffer.from(`${settings.wpUsername}:${settings.wpAppPassword}`).toString('base64'),
  };
}

async function wpFetch(settings, path, options = {}) {
  const base = normalizeWpUrl(settings.wpUrl);
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...basicAuth(settings),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs || 20000),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(json?.message || json?.error || `WordPress HTTP ${res.status}`);
  }
  return json;
}

function sameHost(url, settings) {
  try {
    const u = new URL(url);
    const site = new URL(settings.wpUrl);
    return u.hostname.replace(/^www\./, '') === site.hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
}

function extractPostId(rawUrl) {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    const id = u.searchParams.get('p') || u.searchParams.get('post');
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    const m = String(rawUrl).match(/[?&](?:p|post)=(\d+)/);
    return m ? m[1] : null;
  }
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function inc(summary, key) {
  summary.byAction[key] = (summary.byAction[key] || 0) + 1;
}

function isAssetUrl(url) {
  return /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|zip|mp4|webm)([?#].*)?$/i.test(url);
}

async function resolveTarget(settings, cache, rawUrl) {
  const postId = extractPostId(rawUrl);
  if (!postId) return { postId: null, status: null, link: rawUrl, public: true };
  if (cache.has(postId)) return cache.get(postId);

  try {
    const json = await wpFetch(settings, `/wp-json/wp/v2/posts/${postId}?context=edit&_fields=id,link,status,title`);
    const out = {
      postId,
      status: json.status || null,
      title: stripHtml(json.title?.rendered || ''),
      link: json.link || rawUrl,
      public: json.status === 'publish' && !!json.link && !/[?&]p=\d+/.test(json.link),
    };
    cache.set(postId, out);
    return out;
  } catch (e) {
    const out = { postId, status: 'missing', title: '', link: rawUrl, public: false, error: e.message };
    cache.set(postId, out);
    return out;
  }
}

function replaceAllLiteral(input, from, to) {
  return String(input).split(from).join(to);
}

async function analyzeAndFixContent({ content, post, settings, targetCache }) {
  let fixed = String(content || '');
  const issues = [];
  const addIssue = (issue) => {
    issues.push({
      postId: post.id,
      postTitle: stripHtml(post.title?.rendered || post.title?.raw || ''),
      postStatus: post.status,
      postLink: post.link,
      ...issue,
    });
  };

  // Convert plain markdown internal links before anchor correction.
  const markdownRegex = /\[([^\]<]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const markdownMatches = [...fixed.matchAll(markdownRegex)];
  for (const match of markdownMatches) {
    const [full, text, url] = match;
    if (!sameHost(url, settings) || isAssetUrl(url)) continue;
    let href = url;
    let action = 'markdown_to_anchor';
    const target = await resolveTarget(settings, targetCache, url);
    if (target.postId && target.public) {
      href = target.link;
      action = 'markdown_to_canonical_anchor';
    } else if (target.postId && !target.public) {
      fixed = replaceAllLiteral(fixed, full, text);
      addIssue({ kind: 'markdown', action: 'unlink_unpublished', from: full, to: text, target });
      continue;
    }
    const replacement = `<a href="${href}">${text}</a>`;
    fixed = replaceAllLiteral(fixed, full, replacement);
    addIssue({ kind: 'markdown', action, from: full, to: replacement, target });
  }

  // Fix anchors pointing to internal ?p=ID/admin edit links.
  const anchorRegex = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  const anchorMatches = [...fixed.matchAll(anchorRegex)];
  for (const match of anchorMatches) {
    const [full, prefix, href, suffix, inner] = match;
    if (!sameHost(href, settings)) continue;
    const postId = extractPostId(href);
    if (!postId && !href.includes('/wp-admin/post.php')) continue;

    const target = await resolveTarget(settings, targetCache, href);
    if (target.public && target.link && target.link !== href) {
      const replacement = `<a${prefix || ''}href="${target.link}"${suffix || ''}>${inner || ''}</a>`;
      fixed = replaceAllLiteral(fixed, full, replacement);
      addIssue({ kind: 'anchor', action: 'canonicalize', from: href, to: target.link, anchorText: stripHtml(inner), target });
    } else if (!target.public) {
      const replacement = inner || stripHtml(full);
      fixed = replaceAllLiteral(fixed, full, replacement);
      addIssue({ kind: 'anchor', action: 'unlink_unpublished', from: href, to: stripHtml(replacement), anchorText: stripHtml(inner), target });
    }
  }

  // Wrap or resolve plain internal URLs outside anchors/code blocks.
  const protectedSplit = /(<a\b[\s\S]*?<\/a>|<code[\s\S]*?<\/code>|<pre[\s\S]*?<\/pre>)/gi;
  const parts = fixed.split(protectedSplit);
  const host = new URL(settings.wpUrl).hostname.replace(/\./g, '\\.');
  const plainRegex = new RegExp(`\\b(https?:\\/\\/(?:www\\.)?${host}\\/[^\\s<>"']+)`, 'g');
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue;
    const urls = [...new Set([...parts[i].matchAll(plainRegex)].map(m => m[1]))];
    for (const raw of urls) {
      const trailing = raw.match(/[),.;:!?]+$/)?.[0] || '';
      const url = trailing ? raw.slice(0, -trailing.length) : raw;
      if (!url || isAssetUrl(url)) continue;
      let href = url;
      let replacementText = `<a href="${href}">${href}</a>${trailing}`;
      let action = 'wrap_plain_url';
      const target = await resolveTarget(settings, targetCache, url);
      if (target.postId && target.public) {
        href = target.link;
        replacementText = `<a href="${href}">${href}</a>${trailing}`;
        action = 'plain_to_canonical_anchor';
      } else if (target.postId && !target.public) {
        replacementText = '';
        action = 'remove_plain_unpublished';
      }
      parts[i] = replaceAllLiteral(parts[i], raw, replacementText);
      addIssue({ kind: 'plain_url', action, from: raw, to: replacementText, target });
    }
  }
  fixed = parts.join('');

  return { fixed, issues };
}

async function listPosts(settings, statuses, maxPosts, job) {
  const posts = [];
  for (const status of statuses) {
    let page = 1;
    while (posts.length < maxPosts) {
      const remaining = maxPosts - posts.length;
      const perPage = Math.max(1, Math.min(100, remaining));
      let batch;
      try {
        batch = await wpFetch(
          settings,
          `/wp-json/wp/v2/posts?status=${encodeURIComponent(status)}&per_page=${perPage}&page=${page}&orderby=date&order=desc&context=edit&_fields=id,link,status,title,content`
        );
      } catch (e) {
        if (/invalid page|page number|not found/i.test(e.message || '')) break;
        throw e;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      posts.push(...batch);
      job.progress.total = posts.length;
      touch(job);
      if (batch.length < perPage) break;
      page++;
    }
  }
  return posts;
}

function summarizeFindings(job, findings) {
  job.summary.postsScanned = job.progress.scanned;
  job.summary.postsWithIssues = new Set(findings.map(f => f.postId)).size;
  job.summary.issuesFound = findings.length;
  job.summary.fixable = findings.length;
  job.summary.byAction = {};
  for (const f of findings) inc(job.summary, f.action);
}

export function getInternalLinkJob(jobId) {
  return jobs.get(jobId) || null;
}

export async function startInternalLinkScan({ site, statuses = ['publish'], maxPosts = 100 }) {
  if (!site) throw new Error('site is required');
  const cleanStatuses = statuses.filter(s => TARGET_STATUSES.has(s));
  if (cleanStatuses.length === 0) throw new Error('At least one valid status is required');

  const job = createJob(site, 'scan');
  setTimeout(() => runScan(job, cleanStatuses, Math.max(1, Math.min(500, Number(maxPosts) || 100))).catch(e => {
    job.status = 'failed';
    job.error = e.message;
    job.summary.errors++;
    addLog(job, `Failed: ${e.message}`);
    Logger.error(`[InternalLinks] scan failed for ${site}: ${e.message}`);
  }), 0);
  return job;
}

async function runScan(job, statuses, maxPosts) {
  job.status = 'in_progress';
  addLog(job, `Loading settings for ${job.site}`);
  const settings = await StateManager.getSettingsForSite(job.site);
  if (!settings.wpUrl || !settings.wpUsername || !settings.wpAppPassword) {
    throw new Error(`Missing WordPress settings for site "${job.site}"`);
  }

  addLog(job, `Fetching ${statuses.join(', ')} posts`);
  const posts = await listPosts(settings, statuses, maxPosts, job);
  job.progress.total = posts.length;
  const targetCache = new Map();
  const allFindings = [];

  for (const post of posts) {
    job.progress.scanned++;
    job.progress.current = stripHtml(post.title?.rendered || `Post ${post.id}`);
    const content = post.content?.raw || post.content?.rendered || '';
    try {
      const { fixed, issues } = await analyzeAndFixContent({ content, post, settings, targetCache });
      if (issues.length > 0) {
        allFindings.push(...issues.map(i => ({ ...i, willChange: fixed !== content })));
      }
    } catch (e) {
      job.summary.errors++;
      addLog(job, `Post ${post.id} scan error: ${e.message}`);
    }
    summarizeFindings(job, allFindings);
    touch(job);
  }

  job.findings = allFindings.slice(0, 1000);
  summarizeFindings(job, allFindings);
  job.status = 'done';
  job.progress.current = '';
  addLog(job, `Scan done: ${job.summary.issuesFound} issue(s), ${job.summary.postsWithIssues} post(s) affected`);
}

export async function startInternalLinkApply({ jobId }) {
  const job = jobs.get(jobId);
  if (!job) throw new Error('job not found');
  if (job.status !== 'done') throw new Error('scan job must be done before apply');
  if (!job.findings?.length) throw new Error('no findings to apply');

  job.mode = 'apply';
  job.status = 'applying';
  job.progress = { scanned: 0, total: new Set(job.findings.map(f => f.postId)).size, current: '' };
  job.results = [];
  job.summary.corrected = 0;
  job.summary.skipped = 0;
  job.summary.errors = 0;
  addLog(job, 'Applying corrections');

  setTimeout(() => runApply(job).catch(e => {
    job.status = 'failed';
    job.error = e.message;
    job.summary.errors++;
    addLog(job, `Apply failed: ${e.message}`);
    Logger.error(`[InternalLinks] apply failed for ${job.site}: ${e.message}`);
  }), 0);
  return job;
}

async function runApply(job) {
  const settings = await StateManager.getSettingsForSite(job.site);
  const targetCache = new Map();
  const postIds = [...new Set(job.findings.map(f => f.postId))];

  for (const postId of postIds) {
    job.progress.scanned++;
    try {
      const post = await wpFetch(settings, `/wp-json/wp/v2/posts/${postId}?context=edit&_fields=id,link,status,title,content`);
      job.progress.current = stripHtml(post.title?.rendered || `Post ${postId}`);
      const content = post.content?.raw || post.content?.rendered || '';
      const { fixed, issues } = await analyzeAndFixContent({ content, post, settings, targetCache });
      if (fixed !== content && issues.length > 0) {
        await wpFetch(settings, `/wp-json/wp/v2/posts/${postId}`, {
          method: 'POST',
          body: JSON.stringify({ content: fixed }),
          timeoutMs: 30000,
        });
        job.summary.corrected += issues.length;
        job.results.push({ postId, title: stripHtml(post.title?.rendered || ''), corrected: issues.length, link: post.link });
        addLog(job, `Corrected ${issues.length} link(s): ${stripHtml(post.title?.rendered || postId)}`);
      } else {
        job.summary.skipped++;
        job.results.push({ postId, title: stripHtml(post.title?.rendered || ''), corrected: 0, skipped: true, link: post.link });
      }
    } catch (e) {
      job.summary.errors++;
      job.results.push({ postId, corrected: 0, error: e.message });
      addLog(job, `Post ${postId} apply error: ${e.message}`);
    }
    touch(job);
  }

  job.status = 'applied';
  job.progress.current = '';
  addLog(job, `Apply done: ${job.summary.corrected} link(s) corrected`);
}
