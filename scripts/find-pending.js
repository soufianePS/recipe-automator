// Find pending rows in both tabs
const SHEET_ID = '1ZWZGfKV3dqkwJZ7Hhw-tLo6t8LwZVeBPZ4zEfjm0l0Y';

async function readTab(tab) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url);
  const text = await res.text();
  const match = text.match(/setResponse\(({.*})\)/s);
  if (!match) return [];
  const data = JSON.parse(match[1]);
  return data.table.rows.map((r, i) => ({
    row: i + 2,
    cells: r.c.map(c => c && c.v ? String(c.v) : '')
  }));
}

console.log('=== Generator (single post) — Pending ===');
const gen = await readTab('single post');
gen.forEach(r => {
  const topic = r.cells[0]?.trim();
  const status = r.cells[1]?.trim()?.toLowerCase();
  if (topic && (!status || status === 'pending')) {
    console.log(`  Row ${r.row}: "${topic.substring(0, 60)}"`);
  }
});

console.log('\n=== Scraper (Scraping) — Pending ===');
const scr = await readTab('Scraping');
scr.forEach(r => {
  const url = r.cells[0]?.trim();
  const status = r.cells[1]?.trim()?.toLowerCase();
  if (url && (!status || status === 'pending')) {
    console.log(`  Row ${r.row}: "${url.substring(0, 80)}"`);
  }
});
