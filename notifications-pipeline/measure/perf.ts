// Performance bench — two measurements per engine:
//
//   1. Throughput: fire N messages in a tight loop, flush microtasks once at
//      the end, count ops/sec. Models a WebSocket burst the way it really
//      hits a React app (events batched, framework flushes once).
//
//   2. Single-event latency: fire ONE message, flush, measure. Repeat N
//      times. Models the cost the user perceives between an event and the
//      first visible side effect.
//
// Triggery's microtask scheduler gives it dramatically different shapes on
// the two: great throughput (batched), looser latency than fireSync — the
// trade-off worth being honest about.

import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { triggerySyncFactory } from '../src/engines/triggery';
import { ENGINE_LIST } from '../src/registry';
import { CHANNELS, USERS } from '../src/scenario';
import type { Engine, EngineFactory } from '../src/engine';
import type { Message } from '../src/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reportsDir = resolve(__dirname, 'reports');
mkdirSync(reportsDir, { recursive: true });

const ME = USERS[0]!;
const SETTINGS = { notifications: true, sound: true, dnd: false, mentionsOnly: false };
const MUTED = new Set<string>(['announcements']);
const THROUGHPUT_N = 1000;
const LATENCY_N = 200;
const TRIALS = 5;

function makeBenchMessage(i: number): Message {
  const channel = CHANNELS[i % CHANNELS.length]!;
  const author = USERS[1 + (i % (USERS.length - 1))]!;
  return {
    id: `b-${i}`,
    author,
    channelId: channel.id,
    text: `payload ${i}`,
    mentions: [],
    emittedAt: 0,
  };
}

function setupEngine(factory: EngineFactory): Engine {
  const engine = factory.create();
  engine.setCurrentUser(ME);
  engine.setSettings(SETTINGS);
  engine.setActiveChannel(null);
  engine.setMutedChannels(MUTED);
  engine.setConnectionState('connected');
  engine.onShowToast(() => {});
  engine.onPlaySound(() => {});
  engine.onClearBadge(() => {});
  engine.onTypingChange(() => {});
  engine.onMarkChannelRead(() => {});
  return engine;
}

const flush = (): Promise<void> =>
  new Promise((r) => setImmediate(() => setImmediate(r)));

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
  let badges = 0;
  engine.onIncrementBadge(() => {
    badges++;
  });
  const start = performance.now();
  for (let i = 0; i < THROUGHPUT_N; i++) engine.fireMessage(makeBenchMessage(i));
  await flush();
  const elapsed = performance.now() - start;
  engine.dispose();
  if (badges !== THROUGHPUT_N) {
    throw new Error(
      `[${factory.meta.label}] expected ${THROUGHPUT_N} badges, got ${badges}`,
    );
  }
  return (THROUGHPUT_N / elapsed) * 1000;
}

async function benchLatency(factory: EngineFactory): Promise<number[]> {
  const engine = setupEngine(factory);
  const latencies: number[] = [];
  let pendingStart = 0;
  let pending = false;
  let resolveNext: (() => void) | null = null;
  engine.onIncrementBadge(() => {
    if (!pending) return;
    latencies.push(performance.now() - pendingStart);
    pending = false;
    resolveNext?.();
  });
  for (let i = 0; i < LATENCY_N; i++) {
    pending = true;
    pendingStart = performance.now();
    const fired = new Promise<void>((r) => (resolveNext = r));
    engine.fireMessage(makeBenchMessage(i));
    await fired;
  }
  engine.dispose();
  return latencies;
}

async function main() {
  const allFactories: EngineFactory[] = [...ENGINE_LIST, triggerySyncFactory];
  console.log(`Throughput: ${THROUGHPUT_N} msg × ${TRIALS} trials; latency: ${LATENCY_N} single events × ${TRIALS} trials\n`);

  const rows: Array<{
    label: string;
    throughput_ops_per_sec: number;
    p50_us: number;
    p95_us: number;
    p99_us: number;
  }> = [];

  for (const factory of allFactories) {
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
  const fmtUs = (n: number) => (n < 1 ? n.toFixed(2) : n < 10 ? n.toFixed(1) : Math.round(n).toString());
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
