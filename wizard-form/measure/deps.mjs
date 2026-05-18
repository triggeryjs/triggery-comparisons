// Dependency footprint: for each engine, esbuild bundles it with the same
// settings as bundle.mjs, then we walk the metafile's `inputs` and count
// unique top-level npm packages that ended up in the bundle.
//
// This is the honest "Dependency footprint" measurement — what each engine
// actually drags in transitively at build time, not the package.json count.
// `react` / `react-dom` are externalised (not part of the engine's footprint).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const enginesDir = resolve(__dirname, '../src/engines');
const reportsDir = resolve(__dirname, 'reports');
mkdirSync(reportsDir, { recursive: true });

const engines = [
  'triggery', 'xstate', 'effector', 'rxjs', 'reatom', 'rtk-listener',
  'redux-thunk', 'redux-saga', 'naked',
];

/** Extract the top-level package name from a node_modules path. Handles
 *  pnpm's `.pnpm/<pkg>@<ver>/node_modules/<pkg>/...` layout as well as the
 *  flat `node_modules/<pkg>/...` layout. */
function packageFromPath(p) {
  // pnpm: .../node_modules/.pnpm/<scope+pkg>@<ver>/node_modules/<pkg>/...
  const pnpm = p.match(/node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (pnpm) return pnpm[1];
  // flat: .../node_modules/<pkg>/...
  const flat = p.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (flat) return flat[1];
  return null;
}

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
    metafile: true,
    treeShaking: true,
    legalComments: 'none',
    external: ['react', 'react-dom'],
    conditions: ['production', 'module', 'import', 'browser', 'default'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });

  const pkgs = new Set();
  for (const path of Object.keys(result.metafile.inputs)) {
    if (!path.includes('node_modules/')) continue;
    const pkg = packageFromPath(path);
    if (pkg) pkgs.add(pkg);
  }
  return { engine, packages: [...pkgs].sort(), count: pkgs.size };
}

const rows = [];
for (const e of engines) {
  try {
    rows.push(await measure(e));
  } catch (err) {
    console.warn(`failed to measure ${e}: ${err.message}`);
  }
}
rows.sort((a, b) => a.count - b.count);

const json = { measuredAt: new Date().toISOString(), rows };
writeFileSync(join(reportsDir, 'deps.json'), JSON.stringify(json, null, 2));

const widthEng = Math.max(...rows.map((r) => r.engine.length), 'engine'.length);
const padR = (s, w) => String(s).padStart(w);
const padL = (s, w) => String(s).padEnd(w);

const md = [
  '| engine | packages | list |',
  '|---|---:|---|',
  ...rows.map(
    (r) =>
      `| ${padL(r.engine, widthEng)} | ${padR(r.count, 4)} | ${r.packages.join(', ') || '_(none — pure JS)_'} |`,
  ),
].join('\n');

writeFileSync(join(reportsDir, 'deps.md'), `${md}\n`);
console.log(md);
console.log(`\nWrote ${join(reportsDir, 'deps.json')} and deps.md`);
