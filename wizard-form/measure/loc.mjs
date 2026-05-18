// LOC counter for engine files. Strips comments and blank lines, counts the
// rest. Outputs a markdown table + JSON for the README.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const enginesDir = resolve(__dirname, '../src/engines');
const reportsDir = resolve(__dirname, 'reports');
mkdirSync(reportsDir, { recursive: true });

function effectiveLines(source) {
  // Strip /* … */ block comments (cheap-and-cheerful; no string-aware parsing,
  // but our engine files don't include `/*` in strings).
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = noBlock.split('\n');
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('//')) continue;
    count++;
  }
  return count;
}

const rows = [];
for (const file of readdirSync(enginesDir).sort()) {
  if (!file.endsWith('.ts')) continue;
  const path = join(enginesDir, file);
  const src = readFileSync(path, 'utf8');
  const loc = effectiveLines(src);
  const bytes = Buffer.byteLength(src, 'utf8');
  rows.push({ engine: file.replace(/\.ts$/, ''), loc, bytes });
}

rows.sort((a, b) => a.loc - b.loc);

const json = { measuredAt: new Date().toISOString(), rows };
writeFileSync(join(reportsDir, 'loc.json'), JSON.stringify(json, null, 2));

const widthEng = Math.max(...rows.map((r) => r.engine.length), 'engine'.length);
const padR = (s, w) => String(s).padStart(w);
const padL = (s, w) => String(s).padEnd(w);

const md = [
  '| engine | LOC | bytes |',
  '|---|---:|---:|',
  ...rows.map((r) => `| ${padL(r.engine, widthEng)} | ${padR(r.loc, 4)} | ${padR(r.bytes, 5)} |`),
].join('\n');

writeFileSync(join(reportsDir, 'loc.md'), `${md}\n`);
console.log(md);
console.log(`\nWrote ${join(reportsDir, 'loc.json')} and loc.md`);
