// Find image URL paths inside body-016 (the StreamGenerate response for image gen)
import { readFileSync } from 'fs';

const body = readFileSync(process.argv[2] || 'data/tmp/gemini-net-image/body-016.txt', 'utf-8');
const ANTI = ")]}'";
let s = body.startsWith(ANTI) ? body.slice(ANTI.length) : body;
s = s.trimStart();
const chunks = [];
let pos = 0;
while (pos < s.length) {
  const nl = s.indexOf('\n', pos);
  if (nl === -1) break;
  if (!/^\d+$/.test(s.slice(pos, nl).trim())) break;
  const start = nl + 1;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end === -1) break;
  try { chunks.push(JSON.parse(s.slice(start, end))); } catch {}
  pos = end;
  while (pos < s.length && (s[pos] === '\n' || s[pos] === '\r' || s[pos] === ' ')) pos++;
}
console.log('chunks parsed:', chunks.length);

// Find image URLs in each chunk's payload + their paths
const seen = new Set();
for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i];
  if (!Array.isArray(c)) continue;
  for (const e of c) {
    if (!Array.isArray(e) || e[0] !== 'wrb.fr') continue;
    const stringified = e[2];
    if (typeof stringified !== 'string') continue;
    let payload;
    try { payload = JSON.parse(stringified); } catch { continue; }
    walk(payload, '', 0, i);
  }
}

function walk(node, path, depth, ci) {
  if (depth > 22) return;
  if (typeof node === 'string') {
    if (node.length > 30 && (
        node.includes('googleusercontent') ||
        node.includes('lh3.google') ||
        /\/=s\d+/.test(node) ||
        /=s\d+-rj/.test(node) ||
        node.startsWith('//') ||
        node.startsWith('https://')
      ) && !seen.has(node)) {
      seen.add(node);
      console.log('  chunk', ci, 'path', path);
      console.log('    →', node.substring(0, 220));
    }
    return;
  }
  if (Array.isArray(node)) for (let i = 0; i < node.length; i++) walk(node[i], path + '[' + i + ']', depth + 1, ci);
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const k of Object.keys(node)) walk(node[k], path + '.' + k, depth + 1, ci);
  }
}
