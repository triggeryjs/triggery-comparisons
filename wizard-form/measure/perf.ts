// Performance bench for wizard-form. Two measurements per engine:
//
//   1. Field-update throughput: fire N `setField` calls in a tight loop,
//      flush microtasks once, count ops/sec. Models typing-into-form burst.
//
//   2. Snapshot-to-screen latency: setField → wait for snapshot subscriber
//      to fire → measure round-trip. p50/p95/p99 over many trials.
//
// We deliberately skip transition perf (`next`/`back`) because those happen
// at most a few times per wizard; the dominant cost is per-keystroke.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { Engine, EngineFactory } from '../src/engine';
import { ENGINE_LIST } from '../src/registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reportsDir = resolve(__dirname, 'reports');
mkdirSync(reportsDir, { recursive: true });

const THROUGHPUT_N = 1000;
const LATENCY_N = 200;
const TRIALS = 5;

function setupEngine(factory: EngineFactory): Engine {
  const engine = factory.create();
  return engine;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(() => setImmediate(r)));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function benchThroughput(factory: EngineFactory): Promise<number> {
  const engine = setupEngine(factory);
  let updates = 0;
  engine.subscribe(() => {
    updates++;
  });
  const start = performance.now();
  for (let i = 0; i < THROUGHPUT_N; i++) engine.setField('name', `n${i}`);
  await flush();
  const elapsed = performance.now() - start;
  engine.dispose();
  if (updates < 1) throw new Error(`[${factory.meta.label}] no snapshot updates fired`);
  return (THROUGHPUT_N / elapsed) * 1000;
}

async function benchLatency(factory: EngineFactory): Promise<number[]> {
  const engine = setupEngine(factory);
  const latencies: number[] = [];
  let pendingStart = 0;
  let pending = false;
  let resolveNext: (() => void) | null = null;
  engine.subscribe(() => {
    if (!pending) return;
    latencies.push(performance.now() - pendingStart);
    pending = false;
    resolveNext?.();
  });
  for (let i = 0; i < LATENCY_N; i++) {
    pending = true;
    pendingStart = performance.now();
    const fired = new Promise<void>((r) => (resolveNext = r));
    engine.setField('name', `n${i}`);
    await fired;
  }
  engine.dispose();
  return latencies;
}

async function main() {
  console.log(
    `Throughput: ${THROUGHPUT_N} setField × ${TRIALS} trials; latency: ${LATENCY_N} single updates × ${TRIALS} trials\n`,
  );

  type Row = {
    label: string;
    throughput_ops_per_sec: number;
    p50_us: number;
    p95_us: number;
    p99_us: number;
  };
  const rows: Row[] = [];

  for (const factory of ENGINE_LIST) {
    const throughputs: number[] = [];
    for (let t = 0; t < TRIALS; t++) throughputs.push(await benchThroughput(factory));
    const allLat: number[][] = [];
    for (let t = 0; t < TRIALS; t++) allLat.push(await benchLatency(factory));
    const merged = allLat.flat().sort((a, b) => a - b);
    rows.push({
      label: factory.meta.label,
      throughput_ops_per_sec: median(throughputs),
      p50_us: percentile(merged, 50) * 1000,
      p95_us: percentile(merged, 95) * 1000,
      p99_us: percentile(merged, 99) * 1000,
    });
  }
  rows.sort((a, b) => b.throughput_ops_per_sec - a.throughput_ops_per_sec);

  const fmtK = (n: number) => `${(n / 1000).toFixed(0)}k`;
  const fmtUs = (n: number) =>
    n < 1 ? n.toFixed(2) : n < 10 ? n.toFixed(1) : Math.round(n).toString();
  const pad = (s: string | number, w: number) => String(s).padStart(w);
  const padL = (s: string, w: number) => s.padEnd(w);
  const W = Math.max(...rows.map((r) => r.label.length), 'engine'.length);

  const lines = [
    `| ${padL('engine', W)} | throughput | p50 lat. | p95 lat. | p99 lat. |`,
    `|${'-'.repeat(W + 2)}|---:|---:|---:|---:|`,
    ...rows.map(
      (r) =>
        `| ${padL(r.label, W)} | ${pad(`${fmtK(r.throughput_ops_per_sec)} ops/sec`, 13)} | ${pad(`${fmtUs(r.p50_us)} µs`, 8)} | ${pad(`${fmtUs(r.p95_us)} µs`, 8)} | ${pad(`${fmtUs(r.p99_us)} µs`, 8)} |`,
    ),
  ];
  const md = lines.join('\n');

  writeFileSync(
    join(reportsDir, 'perf.json'),
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        throughput_N: THROUGHPUT_N,
        latency_N: LATENCY_N,
        trials: TRIALS,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        rows,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(reportsDir, 'perf.md'), `${md}\n`);
  console.log(md);
  console.log(`\nWrote ${join(reportsDir, 'perf.json')} and perf.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
