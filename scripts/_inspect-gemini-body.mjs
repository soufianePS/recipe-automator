// Find ALL string-paths in the payload that contain real recipe content
import { readFileSync } from 'fs';

const body = readFileSync(process.argv[2] || 'data/tmp/gemini-net/body-0073.txt');
const ANTI = ")]}'";
let s = body.toString('utf8');
if (s.startsWith(ANTI)) s = s.slice(ANTI.length);
s = s.trimStart();

const chunks = [];
let pos = 0;
while (pos < s.length) {
  const nlIdx = s.indexOf('\n', pos);
  if (nlIdx === -1) break;
  const lenStr = s.slice(pos, nlIdx).trim();
  if (!/^\d+$/.test(lenStr)) break;
  const jsonStart = nlIdx + 1;
  let depth = 0, inStr = false, esc = false, jsonEnd = -1;
  for (let j = jsonStart; j < s.length; j++) {
    const c = s[j];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { jsonEnd = j + 1; break; } }
  }
  if (jsonEnd === -1) break;
  try { chunks.push(JSON.parse(s.slice(jsonStart, jsonEnd))); } catch {}
  pos = jsonEnd;
  while (pos < s.length && (s[pos] === '\n' || s[pos] === '\r' || s[pos] === ' ')) pos++;
}
console.log('chunks parsed:', chunks.length);

// Look at the LAST big chunk's full payload to see all paths with content
const lastDataChunk = chunks.findLast(c => Array.isArray(c) && c.some(e => Array.isArray(e) && e[0] === 'wrb.fr' && typeof e[2] === 'string' && e[2].length > 1000));
if (!lastDataChunk) { console.log('no large data chunk'); process.exit(); }
const wrb = lastDataChunk.find(e => Array.isArray(e) && e[0] === 'wrb.fr');
const payload = JSON.parse(wrb[2]);

// List ALL string leaf paths longer than 100 chars
const found = [];
walk(payload, '', 0);
found.sort((a,b) => b.len - a.len);
console.log('\nTop 15 long string leaves in last data chunk payload:');
found.slice(0, 15).forEach(f => {
  console.log(`  len=${String(f.len).padStart(6)}  path=${f.path}`);
  console.log(`    preview: ${f.preview}`);
});

function walk(node, path, depth) {
  if (depth > 16) return;
  if (typeof node === 'string') {
    if (node.length > 100) {
      found.push({ path, len: node.length, preview: node.substring(0, 120).replace(/\n/g, '\\n') });
    }
    return;
  }
  if (Array.isArray(node)) for (let i = 0; i < node.length; i++) walk(node[i], path + '[' + i + ']', depth + 1);
  if (node && typeof node === 'object' && !Array.isArray(node)) for (const k of Object.keys(node)) walk(node[k], path + '.' + k, depth + 1);
}
