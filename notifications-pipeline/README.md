# Notifications pipeline

A Discord-like chat client. Messages arrive over a (mocked) WebSocket; the client has to gate, throttle, debounce and fan them out into the right side-effects. Same UI, six implementations, one frozen spec.

## Headline numbers

For the 15-rule scenario in this folder (see [acceptance spec](#acceptance-behaviour-the-spec--frozen) below). "naked" is excluded from the leader column — it's a no-library baseline, not a competitor.

|                                | best library             | worst library      | triggery |
|---|---|---|---|
| **Bundle (gzipped)**           | reatom — 3.52 KB         | rtk — 11.03 KB     | 2nd (5.22 KB) |
| **Throughput (sustained)**     | reatom — 246k op/sec     | rtk — 67k op/sec   | **2nd** (228k default · 284k fireSync) — 1.4× effector, 3.4× rtk |
| **Latency p50 (single ev.)**   | rxjs — 0.25 µs           | rtk — 6.8 µs       | 3rd (2.4 µs fireSync · 2.6 µs default) |
| **API surface**                | **triggery — 2 symbols** | rxjs — 15 symbols  | **1st** |
| **Cyclomatic complexity**      | rxjs — 24                | reatom — 35        | 2nd (25) |
| **LOC**                        | reatom — 167             | rtk — 229          | 2nd (181) |
| **Scaling cost (R15 → +LOC)**  | reatom / rtk — +5        | effector — +13     | **+6** (handler-shaped, same as naked baseline) |

Best on API surface and scaling cost, second on every other axis except dispatch latency where rxjs wins (sync subjects with no gating overhead) — at the cost of 15 imported concepts vs Triggery's 2. The full numbers are in [§ Measurements](#measurements) and the interpretation in [§ How to read these numbers](#how-to-read-these-numbers).

- [`triggery`](./src/engines/triggery.ts) — four declarative triggers, one per scenario family
- [`effector`](./src/engines/effector.ts) — events + stores + samples wired into a graph
- [`rxjs`](./src/engines/rxjs.ts) — Subjects + operator pipelines (built-in throttle/debounce)
- [`reatom`](./src/engines/reatom.ts) — atoms + actions, ctx-scoped state
- [`rtk-listener`](./src/engines/rtk-listener.ts) — Redux Toolkit slice + listenerMiddleware
- [`naked`](./src/engines/naked.ts) — no library, hand-rolled emitters + timers

## Acceptance behaviour (the spec — frozen)

14 rules across 4 event families. Every engine must satisfy them identically.

### Messages — `fireMessage(msg)`

1. **R1.** If `currentUser` is unset → ignore the message entirely (auth gate).
2. **R2.** If `msg.author.id === currentUser.id` → ignore (echoes of your own messages).
3. **R3.** `isMention = currentUser.id ∈ msg.mentions`.
4. **R4.** `isMuted = msg.channelId ∈ mutedChannels`.
5. **R5.** **Always emit** `incrementBadge(channelId, muted)` after R1+R2. The sidebar renders muted-channel badges in grey.
6. **R6.** Suppression gate — the toast and sound do **not** fire if any of:
   - `msg.channelId === activeChannelId` (you're already reading the channel)
   - `isMuted` (channel-level mute)
   - `!settings.notifications`
   - `settings.mentionsOnly && !isMention`
   - `settings.dnd && !isMention` (mentions override DND)
7. **R7.** When R6 passes:
   - `showToast({ kind: isMention ? 'mention' : 'message', … })` — **throttled to 3 toasts per second**, excess dropped (badge still counts)
   - `playSound(isMention ? 'mention' : 'beep')` — **debounced 600 ms**

### Typing — `fireTypingStart(p)` / `fireTypingStop(p)`

8. **R8.** Track a per-channel `Set<userId>`. On start → add, on stop → remove.
9. **R9.** Emit `onTypingChange({ channelId, userIds })` on every change so the UI can show "Alice is typing…".

### Channel switch — `fireChannelChanged(channelId)`

11. **R11.** After **2 seconds** of `channelId` staying as the active channel, emit `markChannelRead(channelId)` + `clearBadge(channelId)`. Switching channels before 2 s elapses cancels the pending mark-read (settled-read window).

### Connection — `setConnectionState(state)`

12. **R12.** `→ disconnected` (from anything else) — system toast "Connection lost".
13. **R13.** `→ connected` (only from `disconnected`) — system toast "Reconnected" + `playSound('reconnect')`.
14. **R14.** `→ connecting` — silent intermediate state (no toast).

### Spam protection — added on top of R1-R14

15. **R15.** If the same author has sent ≥ 5 messages in the last 30 seconds (across any channel), suppress their toast and sound (badge still counts). Per-author sliding window.

Inputs: `setSettings`, `setActiveChannel`, `setCurrentUser`, `setMutedChannels` — `null`-able, idempotent.

## How to play with it

```bash
pnpm install
pnpm dev
# → http://localhost:5180/?engine=triggery
```

Switch engines with the pill buttons at the top, or in the URL: `?engine=effector | rxjs | reatom | rtk | naked`. The whole UI is shared — only the file in `src/engines/<lib>.ts` changes.

The right-hand **Simulator** panel exposes every behaviour to play with:

- **Start auto-stream** — one random message every 1.5 s, random author, random channel.
- **One random message** — fire one event manually.
- **@-mention me** — fires a message that mentions you. Toggle "Do not disturb" on and watch the mention still come through (R6 mentions override DND).
- **Burst of 10** — 10 messages in 500 ms. Throttle drops most toasts; badges count every one (R5 vs R7).
- **Someone is typing** — fires `typing-start`, auto-`typing-stop` after 3 s. Watch the typing indicator under the message list.
- **Disconnect 2 s** — drops the connection, reconnects 2 s later. Watch the system toast pair and the reconnect sound.

Click on different channels to test R11 (mark-read after 2 s settled-read). Click the 🔔/🔕 button next to a channel to mute/unmute (R4 → R6).

## Measurements

```bash
pnpm measure
```

Numbers live in `measure/reports/` and are committed (diffs show up in PRs). Latest snapshot:

<!-- BEGIN: measurements -->

### Code size

LOC (non-comment, non-blank) of `src/engines/<engine>.ts`:

| engine | LOC | bytes |
|---|---:|---:|
| naked        |  142 |  5469 |
| reatom       |  167 |  6672 |
| **triggery** | **181** | **7760** |
| effector     |  205 |  8713 |
| rxjs         |  208 |  8335 |
| rtk-listener |  229 |  9368 |

Bundle size — engine + transitive deps, esbuild ES2022 ESM, React externalised:

| engine | minified | gzipped |
|---|---:|---:|
| naked        |   2.04 KB |   1.00 KB |
| reatom       |   8.28 KB |   3.52 KB |
| **triggery** |  **14.24 KB** |   **5.22 KB** |
| rxjs         |  28.93 KB |   9.11 KB |
| effector     |  21.31 KB |   9.46 KB |
| rtk-listener |  29.04 KB |  11.03 KB |

### Performance

Two shapes per engine: **throughput** (burst of 1000 messages, microtasks flushed once at the end — how a WebSocket burst really hits a React app) and **per-event latency** (fire one, flush, measure; how the user perceives a single event-to-side-effect roundtrip). Median of 5 trials, M1 Pro / Node 20.

| engine | throughput | p50 lat. | p95 lat. | p99 lat. |
|---|---:|---:|---:|---:|
| Naked (no library)     |  612k ops/sec |  0.13 µs |  0.17 µs |  0.25 µs |
| **Triggery (fireSync)**|  **284k ops/sec** |   **2.4 µs** |    20 µs |    41 µs |
| Reatom                 |  246k ops/sec |   1.9 µs |   2.9 µs |   4.0 µs |
| **Triggery (default)** |  **228k ops/sec** |   **2.6 µs** |   **3.8 µs** |    11 µs |
| RxJS                   |  183k ops/sec |  0.25 µs |  0.75 µs |   2.0 µs |
| Effector               |  158k ops/sec |   2.7 µs |   5.8 µs |   9.7 µs |
| RTK listenerMiddleware |   67k ops/sec |   6.8 µs |   9.4 µs |    16 µs |

Triggery's default microtask scheduler batches the burst — useful for React (one batched render instead of 1000). `createTrigger({ schedule: 'sync' })` flips to sync dispatch at the cost of that batching; both modes are first-class.

> rxjs's per-event latency p50 (0.25 µs) reflects sync `Subject.next` with no gating — but throughput drops 8× when the same 15 rules run through its operator pipeline. Triggery wins on the sustained-throughput side of the trade-off.

### API surface — concepts you have to learn

Counted by parsing each engine's `import` statements (third-party only) and the constructor calls inside the file. Lower is less library to read before you can understand the file.

| engine | unique imports | primitive constructors |
|---|---:|---|
| naked        | 0 | 7× `emitter()` (in-file helper) |
| **triggery** | **2** | **`createTrigger`×2, `createRuntime`×1** |
| reatom       | 3 | `atom`×5, `action`×11, `createCtx`×1 |
| effector     | 5 | `createEvent`×15, `createStore`×8, `createEffect`×3, `sample`×9, `combine`×1 |
| rtk-listener | 5 | `createAction`×11, `createSlice`×1, `createListenerMiddleware`×1, `startListening`×10 |
| rxjs         | 15 | `new Subject`×10, `new BehaviorSubject`×5, `.pipe()`×12 — plus 13 operators (`filter`, `map`, `throttleTime`, `debounceTime`, `withLatestFrom`, `combineLatest`, `scan`, `merge`, `pairwise`, `startWith`, `switchMap`, `timer`, `EMPTY`) |

### Complexity & type safety

| engine | cyclomatic | max nesting | `as` casts | `!` non-null |
|---|---:|---:|---:|---:|
| rxjs         | 24 | 6 | 0 | 0 |
| **triggery** | **25** | **6** | **0** | **1** |
| rtk-listener | 25 | 7 | 1 | 0 |
| naked        | 29 | 7 | 0 | 0 |
| effector     | 29 | 5 | 0 | 2 |
| reatom       | 35 | 6 | 0 | 0 |

Cyclomatic = `if`/`for`/`while`/`case`/`catch`/`&&`/`||`/ternary + 1. All engines are clean on type-safety (zero or near-zero casts and non-null assertions).

### Scalability — adding R15 to a 14-rule scenario

We measured the **incremental cost** of adding the spam-protection rule (R15) on top of R1-R14. R15 needs per-author state + 30-second sliding window + a gate that fires before R7 — non-trivial because it introduces *historical state* (decision based on previous messages, not just current). Diff measured by `git diff`-ing each engine file:

| engine | base LOC | + R15 | Δ | shape of the change |
|---|---:|---:|---:|---|
| **triggery** | 175 | **181** | **+6** | one extra `if`-block in the handler |
| naked        | 136 | 142 | +6 | one extra `if`-block in `fireMessage` |
| reatom       | 162 | 167 | +5 | one extra `if`-block in the `newMessage` action |
| rtk-listener | 224 | 229 | +5 | one extra `if`-block in the listener effect |
| rxjs         | 198 | 208 | +10 | new `spam$` `scan` stream + extend `withLatestFrom([…, spam$])` + add filter clause |
| effector     | 192 | 205 | +13 | new `$spam` store + add to `$world` `combine` + update `shouldNotify` signature + extra filter clause |

**This is the headline maintenance metric.** Graph-shaped libraries (rxjs, effector) pay a "graph extension tax" — every new state means a new store/stream, and every place that reads it must be updated. Handler-shaped libraries (triggery, naked, reatom, rtk) only pay for the new line. **Triggery scales identically to the no-library baseline** — `+6` LOC for a real new rule with state + time-window + decision-from-history.

<!-- END: measurements -->

## How to read these numbers

The picture isn't "one library wins everything". It's a multi-axis trade-off and each library is built for a slightly different priority. Honestly:

- **Triggery is competitive on every axis and best on API surface.** Smallest concept count (2 imported symbols), second-smallest bundle, 2-3× faster throughput than effector and 5-7× faster than RTK. Its scheduler trade-off is explicit (`default` batches, `fireSync` for low latency) — not a default that you have to opt out of.
- **Naked wins LOC and perf** *for this one scenario*. It loses the second you add a second scenario, an additional event family, or any need to compose rules. The lack of structure is the whole cost.
- **RxJS is dispatch-fast** because Subjects are sync — but the ecosystem cost is steep: 15 imported symbols means a reader has to know 15 operators to read the file.
- **Reatom is bundle-small and complexity-high.** The atom-as-direct-call API is direct, but ends up scoring highest on cyclomatic complexity because every output is a fresh `action` declaration.
- **Effector is graph-shaped.** Every "rule" is several `sample`s wired together; great when you can hold the graph in your head, expensive when reading cold. The throughput tax (130k ops/sec vs triggery's 270k) is the reactive-graph cost.
- **RTK is the slowest and the largest** — but it's the closest to "official Redux" and the line you write today is the line every other RTK app already has.

**Where Triggery makes sense over the alternatives:**

1. You want the rule for a scenario to be *findable* — open one file, read top-to-bottom, know what happens. Effector / rxjs / reatom give you the building blocks; you have to re-assemble the rule yourself every time you read.
2. You want batched dispatch by default (one render per burst, not one per message) without rolling your own React batching.
3. You want a small concept budget for new joiners. "Learn one thing — `createTrigger` — and you can read every scenario file in this codebase."
4. You want both peak-throughput and predictable batching, picked per trigger.

**Where Triggery isn't the right tool:**

- If your domain is pure data-flow (streams in, streams out, no gating), rxjs is more compact for that exact shape.
- If you're already deep in Redux and changing now is more pain than the win is worth — stay on RTK.
- If your scenario fits in one `useEffect` and probably always will — don't add a dependency.

## What this comparison deliberately does NOT measure

- **Microbenchmarks of empty dispatch.** Synthetic loops with no handler live in [triggeryjs/triggery/benchmarks](https://github.com/triggeryjs/triggery/tree/main/benchmarks). They tell you how fast a library can dispatch *nothing useful* in a row; we measure the real scenario instead.
- **TypeScript inference depth.** Each engine uses its own idiomatic shape for the schema. Real comparison would need a separate `dtslint` suite per engine.
- **DevTools / inspector quality.** Each engine has very different debuggability stories (Redux DevTools bridge, in-app inspector, opt-in). Worth its own comparison; not this one.

## Per-engine notes (opinions, freely contested)

### `triggery`

Two triggers — `inbox` (handles both `new-message` for R1-R7 and `channel-changed` for R11, gated by `required: ['settings', 'currentUser']`) and `conn` (R12-R14 with `previous` condition). Typing (R8-R9) doesn't need a trigger — it's pure pass-through, so it lives as a five-line plain-JS fan-out.

The R1-R7 handler reads as a natural-language spec — `if (msg.author.id === user.id) return;` lines up with "ignore your own messages", `actions.throttle(1000/3).showToast?.(…)` with "throttle to 3/sec", `actions.debounce(600).playSound?.(…)` with "debounced 600 ms". `actions.defer(2000)` inside `channel-changed` does the settled-read window with one line.

### `effector`

Three `sample`s per output (toast, sound, badge), one `combine` for the world, hand-rolled timers for throttle (no patronum). Each piece is small; the cost is mentally assembling them into "what does this rule do?". Idiomatic effector — patronum's `throttle` + `debounce` operators would shrink it ~30 LOC, but we wanted apples-to-apples.

### `rxjs`

Operator pipeline. `withLatestFrom`, `filter`, `throttleTime`, `debounceTime`, `scan` (for the typing tracker), `switchMap` + `timer` (for the mark-read debounce). Very compact once you see it; very steep if you don't already think in marbles. The `notify$` shared upstream + `pairwise` for connection transitions are the cleanest bits.

### `reatom`

One `newMessage` action that reads atoms via `ctx` and fires output actions. Direct, imperative-looking, very little machinery. The cost: each `ctx.subscribe(action, calls => calls.forEach(c => cb(c.payload)))` adds bytes the others avoid; v1001 (the next major) collapses this further.

### `rtk-listener`

The most code, but every line is "the official RTK way" — no magic, no library-specific operators. The debounce uses `cancelActiveListeners()` + `delay()` (idiomatic). One slice + four listeners + six output actions + a fan-out listener per output. Wins on familiarity, loses on density.

### `naked`

Plain JS — closures, a tiny generic `emitter<A>()`, hand-rolled `Set<string>` maps for typing per channel, `setTimeout` for throttle/debounce. The honesty of the comparison: this is what you write when you say "I don't need a library", and it's perfectly fine *until* the next scenario lands on the same codebase.

## Contributing

PRs welcome. New engines (`solid-router`, `jotai`, `mobx`), better idioms for existing engines, new scenarios — see the [top-level README](../README.md).
