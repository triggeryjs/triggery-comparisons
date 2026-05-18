// Code-shape metrics per engine file:
//
//   - API surface:    count of unique third-party symbols imported,
//                     count of import sources
//   - Atoms:          count of "primitive constructors" (createTrigger,
//                     createEvent, atom, etc.) — what the file declares
//   - Complexity:     cyclomatic-ish (if/&&/||/ternary/case/catch/while),
//                     max nesting depth
//   - Type safety:    count of `as ` casts, `!` non-null assertions
//
// All by regex over the source text (no AST parser). Approximate but
// reproducible and side-by-side fair: the same regex runs against every
// file.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const enginesDir = resolve(__dirname, '../src/engines');
const reportsDir = resolve(__dirname, 'reports');
mkdirSync(reportsDir, { recursive: true });

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

function parseImports(src) {
  // Matches: import { a, b as x } from 'lib'; import lib from 'lib';
  const re = /import\s+(?:type\s+)?(?:(\w+)|(\{[^}]+\})|\*\s+as\s+\w+)?\s*(?:,\s*\{([^}]+)\})?\s*from\s+['"]([^'"]+)['"]/g;
  const result = [];
  let m;
  while ((m = re.exec(src))) {
    const [, def, named, alsoNamed, source] = m;
    const symbols = [];
    if (def) symbols.push(def);
    const collect = (block) => {
      if (!block) return;
      const inner = block.replace(/[{}]/g, '');
      for (const raw of inner.split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (name) symbols.push(name);
      }
    };
    collect(named);
    collect(alsoNamed);
    result.push({ source, symbols });
  }
  return result;
}

function countMatches(src, re) {
  return (src.match(re) || []).length;
}

function maxNestingDepth(src) {
  let depth = 0;
  let max = 0;
  for (const ch of src) {
    if (ch === '{') {
      depth++;
      if (depth > max) max = depth;
    } else if (ch === '}') {
      depth--;
    }
  }
  return max;
}

const PRIMITIVES = {
  // triggery
  createTrigger: /createTrigger\s*</g,
  createRuntime: /createRuntime\s*\(/g,
  // effector
  createEvent: /createEvent\s*[<(]/g,
  createStore: /createStore\s*</g,
  createEffect: /createEffect\s*\(/g,
  sample: /\bsample\s*\(/g,
  combine: /\bcombine\s*\(/g,
  // rxjs
  Subject: /new\s+Subject\s*</g,
  BehaviorSubject: /new\s+BehaviorSubject\s*</g,
  '.pipe(': /\.pipe\s*\(/g,
  // reatom
  atom: /\batom\s*</g,
  action: /\baction\s*\(/g,
  createCtx: /createCtx\s*\(/g,
  // rtk
  createAction: /createAction\s*</g,
  createSlice: /createSlice\s*\(/g,
  createListenerMiddleware: /createListenerMiddleware\s*\(/g,
  startListening: /\.startListening\s*\(/g,
  // naked
  emitter: /\bemitter\s*</g,
};

const rows = [];
for (const file of readdirSync(enginesDir).sort()) {
  if (!file.endsWith('.ts')) continue;
  const engine = file.replace(/\.ts$/, '');
  const raw = readFileSync(join(enginesDir, file), 'utf8');
  const src = stripComments(raw);

  // imports — only third-party (skip relative ../, ./)
  const imports = parseImports(raw).filter((i) => !i.source.startsWith('.'));
  const uniqueSources = new Set(imports.map((i) => i.source)).size;
  const totalSymbols = new Set(imports.flatMap((i) => i.symbols)).size;

  // primitives
  const primitives = {};
  let primitivesTotal = 0;
  for (const [name, re] of Object.entries(PRIMITIVES)) {
    const c = (src.match(re) || []).length;
    if (c > 0) {
      primitives[name] = c;
      primitivesTotal += c;
    }
  }

  // complexity
  const cyclo =
    countMatches(src, /\bif\s*\(/g) +
    countMatches(src, /\bfor\s*\(/g) +
    countMatches(src, /\bwhile\s*\(/g) +
    countMatches(src, /\bcase\s+/g) +
    countMatches(src, /\bcatch\s*\(/g) +
    countMatches(src, /\?\s*[^:]+\s*:/g) + // ternaries
    countMatches(src, /&&|\|\|/g) +
    1;

  const nesting = maxNestingDepth(src);

  // type safety
  const asCasts = countMatches(src, /\bas\s+(?!const\b)[A-Z]/g);
  const nonNull = countMatches(src, /!(?=\.|\s*[,);])/g);

  rows.push({
    engine,
    importedSources: uniqueSources,
    importedSymbols: totalSymbols,
    primitives,
    primitivesTotal,
    cyclo,
    nesting,
    asCasts,
    nonNull,
  });
}

// ─── output ──────────────────────────────────────────────────────────

const padL = (s, w) => String(s).padEnd(w);
const padR = (s, w) => String(s).padStart(w);
const W = Math.max(...rows.map((r) => r.engine.length), 'engine'.length);

const apiTable = [
  `| ${padL('engine', W)} | imports | symbols | primitives | concepts list |`,
  `|${'-'.repeat(W + 2)}|---:|---:|---:|---|`,
  ...rows
    .sort((a, b) => a.importedSymbols - b.importedSymbols)
    .map(
      (r) =>
        `| ${padL(r.engine, W)} | ${padR(r.importedSources, 7)} | ${padR(r.importedSymbols, 7)} | ${padR(r.primitivesTotal, 10)} | ${Object.entries(r.primitives)
          .map(([k, v]) => `${k}×${v}`)
          .join(', ')} |`,
    ),
].join('\n');

const complexityTable = [
  `| ${padL('engine', W)} | cyclo | nesting | as | ! |`,
  `|${'-'.repeat(W + 2)}|---:|---:|---:|---:|`,
  ...[...rows]
    .sort((a, b) => a.cyclo - b.cyclo)
    .map(
      (r) =>
        `| ${padL(r.engine, W)} | ${padR(r.cyclo, 5)} | ${padR(r.nesting, 7)} | ${padR(r.asCasts, 2)} | ${padR(r.nonNull, 2)} |`,
    ),
].join('\n');

const json = { measuredAt: new Date().toISOString(), rows };
writeFileSync(join(reportsDir, 'code.json'), JSON.stringify(json, null, 2));
writeFileSync(
  join(reportsDir, 'api.md'),
  `## API surface — what each engine imports from its library\n\n${apiTable}\n`,
);
writeFileSync(
  join(reportsDir, 'complexity.md'),
  `## Complexity & type safety\n\n${complexityTable}\n\n- **cyclo**: rough cyclomatic count (if/for/while/case/catch/&&/||/?: + 1).\n- **nesting**: deepest brace nesting in the file.\n- **as**: \\\`as TypeName\\\` casts (excluding \\\`as const\\\`).\n- **!**: non-null assertions \\\`x!\\\`.\n`,
);

console.log('--- API surface ---\n' + apiTable);
console.log('\n--- Complexity ---\n' + complexityTable);
console.log(`\nWrote ${join(reportsDir, 'code.json')}, api.md, complexity.md`);
