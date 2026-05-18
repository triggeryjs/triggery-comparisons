// Performance bench for floating-workspace.
//
//   - Drag throughput: open a panel, startDrag, fire N pointerMove calls in
//     a tight loop. Each engine's throttle decides how many snapshots
//     materialise (we count actual snapshot fires). Reports "events/sec"
//     and "snapshots delivered" (the latter shows the throttle in action).
//
//   - Open/close throughput: cycle openPanel + close N times.
//
//   - Lifecycle latency: single setBody → snapshot round-trip p50/p95/p99.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { Engine, EngineFactory } from '../src/engine';
import { ENGINE_LIST } from '../src/registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reportsDir = resolve(__dirname, 'reports');
mkdirSync(reportsDir, { recursive: true });

const DRAG_N = 1000;
const LIFECYCLE_N = 200;
const TRIALS = 5;

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

async function benchDrag(factory: EngineFactory): Promise<{ eventsPerSec: number; snapshots: number }> {
  const engine = factory.create();
  const id = engine.openPanel('note', { mode: 'floating' });
  if (!id) throw new Error('openPanel failed');
  let snapshots = 0;
  engine.subscribe(() => { snapshots += 1; });
  engine.startFloatingDrag(id, 100, 100);
  const start = performance.now();
  for (let i = 0; i < DRAG_N; i++) {
    engine.pointerMove(100 + (i % 200), 100 + (i % 200));
  }
  engine.pointerUp();
  await flush();
  const elapsed = performance.now() - start;
  engine.dispose();
  return { eventsPerSec: (DRAG_N / elapsed) * 1000, snapshots };
}

async function benchLifecycle(factory: EngineFactory): Promise<number[]> {
  const engine = factory.create();
  const id = engine.openPanel('note');
  if (!id) throw new Error('openPanel failed');
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
  for (let i = 0; i < LIFECYCLE_N; i++) {
    pending = true;
    pendingStart = performance.now();
    const fired = new Promise<void>((r) => (resolveNext = r));
    engine.setBody(id, `body ${i}`);
    await fired;
  }
  engine.dispose();
  return latencies;
}

async function main() {
  console.log(`Drag: ${DRAG_N} pointerMove × ${TRIALS} trials; lifecycle: ${LIFECYCLE_N} setBody × ${TRIALS} trials\n`);

  type Row = {
    label: string;
    dragEventsPerSec: number;
    dragSnapshots: number;
    p50_us: number;
    p95_us: number;
    p99_us: number;
  };
  const rows: Row[] = [];

  for (const factory of ENGINE_LIST) {
    const drags: number[] = [];
    let snapshots = 0;
    for (let t = 0; t < TRIALS; t++) {
      const { eventsPerSec, snapshots: s } = await benchDrag(factory);
      drags.push(eventsPerSec);
      snapshots = s;
    }
    const allLat: number[][] = [];
    for (let t = 0; t < TRIALS; t++) allLat.push(await benchLifecycle(factory));
    const merged = allLat.flat().sort((a, b) => a - b);
    rows.push({
      label: factory.meta.label,
      dragEventsPerSec: median(drags),
      dragSnapshots: snapshots,
      p50_us: percentile(merged, 50) * 1000,
      p95_us: percentile(merged, 95) * 1000,
      p99_us: percentile(merged, 99) * 1000,
    });
  }
  rows.sort((a, b) => b.dragEventsPerSec - a.dragEventsPerSec);

  const fmtK = (n: number) => `${(n / 1000).toFixed(0)}k`;
  const fmtUs = (n: number) =>
    n < 1 ? n.toFixed(2) : n < 10 ? n.toFixed(1) : Math.round(n).toString();
  const pad = (s: string | number, w: number) => String(s).padStart(w);
  const padL = (s: string, w: number) => s.padEnd(w);
  const W = Math.max(...rows.map((r) => r.label.length), 'engine'.length);

  const lines = [
    `| ${padL('engine', W)} | drag events/sec | snapshots/${DRAG_N} | setBody p50 | p95 | p99 |`,
    `|${'-'.repeat(W + 2)}|---:|---:|---:|---:|---:|`,
    ...rows.map(
      (r) =>
        `| ${padL(r.label, W)} | ${pad(`${fmtK(r.dragEventsPerSec)} ev/sec`, 14)} | ${pad(r.dragSnapshots, 7)} | ${pad(`${fmtUs(r.p50_us)} µs`, 8)} | ${pad(`${fmtUs(r.p95_us)} µs`, 8)} | ${pad(`${fmtUs(r.p99_us)} µs`, 8)} |`,
    ),
  ];
  const md = lines.join('\n');

  writeFileSync(
    join(reportsDir, 'perf.json'),
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        dragEvents_N: DRAG_N,
        lifecycle_N: LIFECYCLE_N,
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
