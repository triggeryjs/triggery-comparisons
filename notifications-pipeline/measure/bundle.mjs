// Bundle-size measurer. esbuild bundles each engine + its transitive deps
// into a single ESM blob and reports min/gzip sizes. The blob includes only
// what the engine imports — not React, not the UI shell.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const enginesDir = resolve(__dirname, '../src/engines');
const reportsDir = resolve(__dirname, 'reports');
mkdirSync(reportsDir, { recursive: true });

const engines = ['triggery', 'effector', 'rxjs', 'reatom', 'rtk-listener', 'naked'];

async function measure(engine) {
  const entry = join(enginesDir, `${engine}.ts`);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    treeShaking: true,
    legalComments: 'none',
    external: ['react', 'react-dom'],
    logLevel: 'silent',
  });
  const blob = result.outputFiles[0].contents;
  return { engine, minBytes: blob.byteLength, gzipBytes: gzipSync(blob).byteLength };
}

const rows = [];
for (const e of engines) {
  try {
    rows.push(await measure(e));
  } catch (err) {
    console.warn(`failed to measure ${e}: ${err.message}`);
  }
}
rows.sort((a, b) => a.minBytes - b.minBytes);

const json = { measuredAt: new Date().toISOString(), rows };
writeFileSync(join(reportsDir, 'bundle.json'), JSON.stringify(json, null, 2));

const widthEng = Math.max(...rows.map((r) => r.engine.length), 'engine'.length);
const fmt = (n) => `${(n / 1024).toFixed(2)} KB`;
const padR = (s, w) => String(s).padStart(w);
const padL = (s, w) => String(s).padEnd(w);

const md = [
  '| engine | minified | gzipped |',
  '|---|---:|---:|',
  ...rows.map(
    (r) => `| ${padL(r.engine, widthEng)} | ${padR(fmt(r.minBytes), 9)} | ${padR(fmt(r.gzipBytes), 9)} |`,
  ),
].join('\n');

writeFileSync(join(reportsDir, 'bundle.md'), `${md}\n`);
console.log(md);
console.log(`\nWrote ${join(reportsDir, 'bundle.json')} and bundle.md`);
