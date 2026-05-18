// Quick inspection: search the Dolphin OpenAPI spec for any plan
// restriction beyond "Free plan blocks automation".
import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('C:/Users/xassi/Downloads/dolphinanty-public-api.json', 'utf8'));
const json = JSON.stringify(data, null, 2);
const lines = json.split('\n');

const patterns = [
  /free.?plan/i,
  /paid.?plan/i,
  /starter/i,
  /base.?plan/i,
  /automation.*forbidden/i,
  /FREE_PLAN/,
  /AUTOMATION/,
  /HTTP\s*402/i,
  /402.*Payment/i,
];

const hits = new Set();
lines.forEach((line, i) => {
  for (const p of patterns) {
    if (p.test(line)) {
      hits.add(i);
      break;
    }
  }
});

console.log(`Found ${hits.size} relevant lines:`);
const sorted = [...hits].sort((a, b) => a - b);
for (const i of sorted) {
  console.log(`Line ${i}: ${lines[i].trim().slice(0, 240)}`);
}
