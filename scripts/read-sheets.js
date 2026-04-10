// Read both sheet tabs and display rows
const SHEET_ID = '1ZWZGfKV3dqkwJZ7Hhw-tLo6t8LwZVeBPZ4zEfjm0l0Y';

async function readTab(tab) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url);
  const text = await res.text();
  const match = text.match(/setResponse\(({.*})\)/s);
  if (!match) { console.log(`${tab}: No data`); return; }
  const data = JSON.parse(match[1]);
  console.log(`\n=== ${tab} ===`);
  data.table.rows.forEach((r, i) => {
    const cells = r.c.map(c => c && c.v ? String(c.v).substring(0, 80) : '');
    console.log(`  Row ${i + 2}: ${cells.join(' | ')}`);
  });
}

await readTab('single post');
await readTab('Scraping');
