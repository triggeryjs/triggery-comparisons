# Notifications pipeline

A Discord-like chat client. Messages arrive over a (mocked) WebSocket; the client has to gate, throttle, debounce and fan them out into the right side-effects. Same UI, six implementations, one frozen spec.

## Headline numbers

For the 15-rule scenario in this folder (see [acceptance spec](#acceptance-behaviour-the-spec--frozen) below). "naked" is excluded from the leader column — it's a no-library baseline, not a competitor.

|                                | best library             | worst library              | triggery |
|---|---|---|---|
| **LOC**                        | **triggery — 162**         | redux-saga — 264           | **1st** |
| **API surface**                | **triggery — 1 import, 2 symbols** | redux-saga — 3 imports, 17 symbols | **1st** |
| **Bundle (gzipped)**           | reatom — 3.52 KB           | redux-saga — 15.67 KB      | 2nd (**5.17 KB**) |
| **Throughput (sustained)**     | **triggery (fireSync) — 275k op/sec** | redux-saga — 57k op/sec | **1st** (sync) · 4th-among-libs-default 164k (microtask-batched for React) — 1.21× redux-thunk, 1.96× effector, 4.2× rtk |
| **Latency p50 (single ev.)**   | rxjs — 0.25 µs             | rtk — 7.0 µs               | 3rd (1.5 µs fireSync · 2.8 µs default) |
| **Cyclomatic complexity**      | rxjs — 24                  | reatom — 35                | 3rd (26) |
| **Scaling cost (R15 → +LOC)**  | reatom / rtk — +5          | effector — +13             | **+6** (handler-shaped, same as naked baseline) |

Best on LOC, API surface, sustained throughput (fireSync) and scaling cost; second on bundle; beaten on per-event latency by rxjs's sync `Subject.next` and redux-thunk's bare-middleware path. Default `microtask` mode trades raw throughput for one React render per burst (one batched commit instead of 1000) — an explicit, per-trigger choice rather than a forced default. The full numbers are in [§ Measurements](#measurements) and the interpretation in [§ How to read these numbers](#how-to-read-these-numbers).

- [`triggery`](./src/engines/triggery.ts) — two declarative triggers + a plain-JS typing tracker
- [`effector`](./src/engines/effector.ts) — events + stores + samples wired into a graph
- [`rxjs`](./src/engines/rxjs.ts) — Subjects + operator pipelines (built-in throttle/debounce)
- [`reatom`](./src/engines/reatom.ts) — atoms + actions, ctx-scoped state
- [`rtk-listener`](./src/engines/rtk-listener.ts) — Redux Toolkit slice + listenerMiddleware
- [`redux-thunk`](./src/engines/redux-thunk.ts) — Redux + thunks + tiny output-router middleware
- [`redux-saga`](./src/engines/redux-saga.ts) — Redux + sagas (generators) + built-in throttle/debounce effects
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

Switch engines with the pill buttons at the top, or in the URL: `?engine=effector | rxjs | reatom | rtk | redux-thunk | redux-saga | naked`. The whole UI is shared — only the file in `src/engines/<lib>.ts` changes.

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
| **triggery** | **162** | **7190** |
| reatom       |  167 |  6672 |
| effector     |  205 |  8713 |
| rxjs         |  208 |  8335 |
| redux-thunk  |  215 |  9056 |
| rtk-listener |  229 |  9368 |
| redux-saga   |  264 | 11081 |

Bundle size — engine + transitive deps, esbuild ES2022 ESM, React externalised:

| engine | minified | gzipped |
|---|---:|---:|
| naked        |   2.04 KB |   1.00 KB |
| reatom       |   8.28 KB |   3.52 KB |
| **triggery** |  **14.35 KB** |   **5.17 KB** |
| effector     |  21.31 KB |   9.46 KB |
| redux-thunk  |  24.82 KB |   9.56 KB |
| rxjs         |  28.93 KB |   9.11 KB |
| rtk-listener |  29.04 KB |  11.03 KB |
| redux-saga   |  42.30 KB |  15.67 KB |

Builds use the `production` export condition (mirrors Vite/Webpack prod mode) — Triggery serves its prod-stripped variant from `@triggery/core` (no dev-warns, no DOM instrumentation). The engine in this scenario also bypasses the `@triggery/core/builder` subpath (config-form `createTrigger({ … })`) and subscribes to actions through the lean main-bundle path (`runtime.subscribeAction`), so neither the builder machinery nor per-action channel cache lands in the bundle.

### Performance

Two shapes per engine: **throughput** (burst of 1000 messages, microtasks flushed once at the end — how a WebSocket burst really hits a React app) and **per-event latency** (fire one, flush, measure; how the user perceives a single event-to-side-effect roundtrip). Median of 5 trials, M1 Pro / Node 20.

| engine | throughput | p50 lat. | p95 lat. | p99 lat. |
|---|---:|---:|---:|---:|
| Naked (no library)     |  603k ops/sec |  0.13 µs |  0.17 µs |  0.21 µs |
| **Triggery (fireSync)**|  **275k ops/sec** |   **1.5 µs** |   **1.7 µs** |   **3.7 µs** |
| Redux + thunk          |  227k ops/sec |   1.3 µs |   1.8 µs |   7.8 µs |
| RxJS                   |  216k ops/sec |  0.25 µs |  0.33 µs |  0.92 µs |
| Reatom                 |  214k ops/sec |   1.9 µs |   2.8 µs |   3.8 µs |
| **Triggery (default)** |  **164k ops/sec** |   **2.8 µs** |   **10 µs** |   **51 µs** |
| Effector               |  140k ops/sec |   2.7 µs |   6.2 µs |    12 µs |
| RTK listenerMiddleware |   65k ops/sec |   7.0 µs |   8.9 µs |    19 µs |
| Redux + saga           |   57k ops/sec |   6.5 µs |   9.7 µs |    41 µs |

> Numbers vary ±10–15% between runs (perf bench is sensitive to system load). The values above come from a single canonical run on M1 Pro / Node 20; across 5 consecutive runs Triggery (fireSync) measured 271–286k op/sec (median 277), Triggery (default) 151–205k (median 187), and the rest stayed within similar ranges. Treat the table as "an honest snapshot," not a leaderboard tied to the last digit.

Triggery's default microtask scheduler batches the burst — useful for React (one batched render instead of 1000). `createTrigger({ schedule: 'sync' })` flips to sync dispatch and **leads sustained throughput** in this matrix at 275k ops/sec — 1.21× redux-thunk, 1.27× rxjs, 1.28× reatom, 1.96× effector, 4.2× rtk, 4.8× saga. Both modes are first-class.

> rxjs's per-event latency p50 (0.25 µs) reflects sync `Subject.next` with no gating — but its sustained throughput (216k) is below Triggery's fireSync (275k) once the 15 gating/throttle/debounce rules run through the operator pipeline. Triggery wins on the burst side; rxjs wins on the single-event-latency side. **Redux-thunk is the surprise of the Redux family:** plain dispatch with a tiny router middleware leaves more room than rtk-listener or saga's heavier scaffolding (227k op/sec — best of the Redux family), but still trails Triggery sync by ~17%.

### API surface — concepts you have to learn

Counted by parsing each engine's `import` statements (third-party only) and the constructor calls inside the file. Lower is less library to read before you can understand the file.

| engine | unique imports | primitive constructors |
|---|---:|---|
| naked        | 0 | 7× `emitter()` (in-file helper) |
| **triggery** | **2** | **`createTrigger`×2, `createRuntime`×1** |
| reatom       | 3 | `atom`×5, `action`×11, `createCtx`×1 |
| effector     | 5 | `createEvent`×15, `createStore`×8, `createEffect`×3, `sample`×9, `combine`×1 |
| rtk-listener | 5 | `createAction`×11, `createSlice`×1, `createListenerMiddleware`×1, `startListening`×10 |
| redux-thunk  | 7 | `createAction`×6, `createSlice`×1, 4× thunk creators (`messageThunk`, `typingThunk`, `channelChangedThunk`, `connectionThunk`) + tiny router middleware |
| redux-saga   | 17 | `createAction`×11, `createSlice`×1, `createSagaMiddleware`×1, effects: `takeEvery`/`throttle`/`debounce`/`take`/`fork`/`cancel`/`delay`/`put`/`select`/`all`/`call` |
| rxjs         | 15 | `new Subject`×10, `new BehaviorSubject`×5, `.pipe()`×12 — plus 13 operators (`filter`, `map`, `throttleTime`, `debounceTime`, `withLatestFrom`, `combineLatest`, `scan`, `merge`, `pairwise`, `startWith`, `switchMap`, `timer`, `EMPTY`) |

### Complexity & type safety

| engine | cyclomatic | max nesting | `as` casts | `!` non-null |
|---|---:|---:|---:|---:|
| rxjs         | 24 | 6 | 0 | 0 |
| rtk-listener | 25 | 7 | 1 | 0 |
| **triggery** | **26** | **6** | **0** | **0** |
| naked        | 29 | 7 | 0 | 0 |
| effector     | 29 | 5 | 0 | 2 |
| redux-saga   | 30 | 6 | 7 | 0 |
| redux-thunk  | 33 | 6 | 2 | 0 |
| reatom       | 35 | 6 | 0 | 0 |

Cyclomatic = `if`/`for`/`while`/`case`/`catch`/`&&`/`||`/ternary + 1. All engines are clean on type-safety (zero or near-zero casts and non-null assertions).

### Scalability — adding R15 to a 14-rule scenario

We measured the **incremental cost** of adding the spam-protection rule (R15) on top of R1-R14. R15 needs per-author state + 30-second sliding window + a gate that fires before R7 — non-trivial because it introduces *historical state* (decision based on previous messages, not just current). Diff measured by `git diff`-ing each engine file:

| engine | base LOC | + R15 | Δ | shape of the change |
|---|---:|---:|---:|---|
| **triggery** | 156 | **162** | **+6** | one extra `if`-block in the handler |
| naked        | 136 | 142 | +6 | one extra `if`-block in `fireMessage` |
| reatom       | 162 | 167 | +5 | one extra `if`-block in the `newMessage` action |
| rtk-listener | 224 | 229 | +5 | one extra `if`-block in the listener effect |
| redux-thunk  | 209 | 215 | +6 | one extra `if`-block in `messageThunk` |
| redux-saga   | 257 | 264 | +7 | spam-window update in `handleBadge` + check in `handleToast` + same in `handleSound` |
| rxjs         | 198 | 208 | +10 | new `spam$` `scan` stream + extend `withLatestFrom([…, spam$])` + add filter clause |
| effector     | 192 | 205 | +13 | new `$spam` store + add to `$world` `combine` + update `shouldNotify` signature + extra filter clause |

**This is the headline maintenance metric.** Graph-shaped libraries (rxjs, effector) pay a "graph extension tax" — every new state means a new store/stream, and every place that reads it must be updated. Handler-shaped libraries (triggery, naked, reatom, rtk) only pay for the new line. **Triggery scales identically to the no-library baseline** — `+6` LOC for a real new rule with state + time-window + decision-from-history.

### Dependency footprint

Unique npm packages each engine actually pulls into a production bundle (esbuild metafile, walked transitively, `react`/`react-dom` externalised). This is the honest "what does adding this library cost my node_modules" answer.

| engine | packages | list |
|---|---:|---|
| naked        | 0 | _(none — pure JS)_ |
| **triggery** | **1** | `@triggery/core` |
| effector     | 1 | `effector` |
| reatom       | 1 | `@reatom/core` |
| rxjs         | 2 | `rxjs`, `tslib` |
| rtk-listener | 5 | `@reduxjs/toolkit`, `immer`, `redux`, `redux-thunk`, `reselect` |
| redux-thunk  | 5 | `@reduxjs/toolkit`, `immer`, `redux`, `redux-thunk`, `reselect` |
| redux-saga   | 12 | `@babel/runtime`, `@redux-saga/{core,deferred,delay-p,is,symbols}`, `@reduxjs/toolkit`, `immer`, `redux`, `redux-saga`, `redux-thunk`, `reselect` |

`@triggery/core` ties effector and reatom for the smallest "1 package" footprint. The full Redux family ships at least 5 — `@reduxjs/toolkit` brings `immer` + `redux` + `redux-thunk` + `reselect` along whether you use them or not. Saga is dramatically heavier — 12 packages — because the saga runtime is split across half-a-dozen `@redux-saga/*` subpackages plus `@babel/runtime` for generator helpers.

### Mental load — subjective notes

Four axes per engine. The first column ("concepts") is the same number as in the API-surface table above, mapped to a colour band; the other three are honest opinion grounded in this scenario's per-engine notes (see below). 🟢 light · 🟡 medium · 🔴 heavy.

| engine | concepts | spec ↔ code | debug tooling | onboarding | summary |
|---|---|---|---|---|---|
| naked | 🟢 0 | 🟡 closures + `setTimeout` | 🟡 just `console.log` | 🟢 instant | 🟢 light |
| **triggery** | 🟢 2 | 🟢 handler reads as the R1-R15 spec | 🟡 `@triggery/core/inspect` exists, basic | 🟢 hours | 🟢 light |
| reatom | 🟢 3 | 🟡 logic scattered across atoms / actions | 🟡 reatom-devtools (basic) | 🟢 days | 🟢 light |
| effector | 🟡 5 | 🟡 graph requires assembly | 🟢 effector-inspector + Redux DevTools bridge | 🟡 days | 🟡 medium |
| rtk-listener | 🟡 5 | 🟢 reads as a listener registry | 🟢 Redux DevTools + time travel | 🟢 hours (if RTK-familiar) | 🟡 medium |
| redux-thunk | 🟡 7 | 🟡 imperative branches in thunks | 🟢 Redux DevTools | 🟢 hours | 🟡 medium |
| redux-saga | 🔴 17 | 🟡 generator effects | 🟢 Redux DevTools + saga-monitor | 🟡 days (generators) | 🔴 heavy |
| rxjs | 🔴 15 | 🟡 marble diagrams (if you know them) | 🔴 deep operator stacks, no first-class inspector | 🔴 weeks (marble model) | 🔴 heavy |

Honest caveats — what the table doesn't capture:

- **Triggery's debuggability is a real weak point**, not just a quibble. `@triggery/core/inspect` exists as a subpath but it's basic — no time-travel, no graph visualizer, no Redux-DevTools-class polish yet. This is a roadmap item.
- **rxjs's debug 🔴** — operator-pipeline stack traces are deep and require `tap(console.log)` to introspect intermediate values. There's no inspector that shows "the current value flowing through Subject X", short of writing one yourself.
- **redux-saga's `Generator` ergonomics** are easier than they look once you stop fighting them — `yield call(api)` reads almost exactly like `await api()`. The 🔴 summary is more about the 17-symbol vocabulary than the generators themselves.

<!-- END: measurements -->

## How to read these numbers

The picture isn't "one library wins everything". It's a multi-axis trade-off and each library is built for a slightly different priority. Honestly:

- **Triggery is competitive on every axis and best on LOC + API surface + sustained throughput.** Smallest concept count (2 imported symbols), second-smallest bundle (5.17 KB gz, half the size of effector/rxjs/redux-thunk), and — in `fireSync` mode — **fastest sustained throughput in the matrix at 275k op/sec** (1.21× redux-thunk, 1.96× effector, 4.2× rtk, 4.8× saga). The scheduler trade-off is explicit per trigger (`default` batches for React, `fireSync` for low latency) — not a default that you have to opt out of.
- **Naked wins LOC and perf** *for this one scenario*. It loses the second you add a second scenario, an additional event family, or any need to compose rules. The lack of structure is the whole cost.
- **RxJS is dispatch-fast** because Subjects are sync — but the ecosystem cost is steep: 15 imported symbols means a reader has to know 15 operators to read the file.
- **Reatom is bundle-small and complexity-high.** The atom-as-direct-call API is direct, but ends up scoring highest on cyclomatic complexity because every output is a fresh `action` declaration.
- **Effector is graph-shaped.** Every "rule" is several `sample`s wired together; great when you can hold the graph in your head, expensive when reading cold. The throughput tax (140k ops/sec vs triggery's 275k fireSync) is the reactive-graph cost.
- **Redux-thunk is the perf surprise** — minimal middleware + thunk-as-function gives the leanest dispatch path of the Redux family, ties Triggery (sync) for fastest sustained throughput. The cost lands in the code shape: imperative `if`-chains in thunks, hand-rolled timers, no effect vocabulary.
- **RTK listenerMiddleware is the heavy-but-official RTK way.** Worst throughput, most code in the RTK family, but identical to every other "official RTK" listener you've read. Predictable. Familiar.
- **Redux-saga is the most code and one of the two slowest** (57k op/sec, 264 LOC) — but it's the only engine where throttle, debounce, cancel and delay are part of a uniform vocabulary instead of hand-rolled. If your team already thinks in effects, saga reads like a spec; if not, the generator scheduler is real overhead.

**Where Triggery makes sense over the alternatives:**

1. You want the rule for a scenario to be *findable* — open one file, read top-to-bottom, know what happens. Effector / rxjs / reatom give you the building blocks; you have to re-assemble the rule yourself every time you read.
2. You want batched dispatch by default (one render per burst, not one per message) without rolling your own React batching.
3. You want a small concept budget for new joiners. "Learn one thing — `createTrigger` — and you can read every scenario file in this codebase."
4. You want both peak-throughput and predictable batching, picked per trigger.

**Where Triggery isn't the right tool:**

- If your domain is pure data-flow (streams in, streams out, no gating), rxjs is more compact for that exact shape.
- If you're already deep in Redux and changing now is more pain than the win is worth — stay on RTK / thunk / saga (pick whichever your team already speaks).
- If your team already thinks in effect-as-data — `takeEvery`, `throttle`, `debounce`, `delay` — redux-saga gives you that vocabulary out of the box.
- If your scenario fits in one `useEffect` and probably always will — don't add a dependency.

## What this comparison deliberately does NOT measure

- **Microbenchmarks of empty dispatch.** Synthetic loops with no handler live in [triggeryjs/triggery/benchmarks](https://github.com/triggeryjs/triggery/tree/main/benchmarks). They tell you how fast a library can dispatch *nothing useful* in a row; we measure the real scenario instead.
- **TypeScript inference depth.** Each engine uses its own idiomatic shape for the schema. Real comparison would need a separate `dtslint` suite per engine.
- **DevTools / inspector quality.** Each engine has very different debuggability stories (Redux DevTools bridge, in-app inspector, opt-in). Worth its own comparison; not this one.

## Per-engine notes (opinions, freely contested)

### `triggery`

Two triggers — `inbox` (handles both `new-message` for R1-R7 and `channel-changed` for R11, gated by `required: ['settings', 'currentUser']`) and `conn` (R12-R14 with `previous` condition). Typing (R8-R9) doesn't need a trigger — it's pure pass-through, so it lives as a five-line plain-JS fan-out.

The R1-R7 handler reads as a natural-language spec — `if (msg.author.id === user.id) return;` lines up with "ignore your own messages", `actions.throttle(1000/3).showToast?.(…)` with "throttle to 3/sec", `actions.debounce(600).playSound?.(…)` with "debounced 600 ms". `actions.defer(2000)` inside `channel-changed` does the settled-read window with one line.

Trigger definitions use the config-form `createTrigger({ … }, runtime)` from `@triggery/core` (not the chainable builder from `@triggery/core/builder` — that subpath isn't pulled in). Outputs subscribe through `runtime.subscribeAction(triggerId, name, cb)` — the lean main-bundle path, no per-action channel cache. Net cost: **5.17 KB gz**, half the size of effector / rxjs / redux-thunk and a third of rtk-listener.

### `effector`

Three `sample`s per output (toast, sound, badge), one `combine` for the world, hand-rolled timers for throttle (no patronum). Each piece is small; the cost is mentally assembling them into "what does this rule do?". Idiomatic effector — patronum's `throttle` + `debounce` operators would shrink it ~30 LOC, but we wanted apples-to-apples.

### `rxjs`

Operator pipeline. `withLatestFrom`, `filter`, `throttleTime`, `debounceTime`, `scan` (for the typing tracker), `switchMap` + `timer` (for the mark-read debounce). Very compact once you see it; very steep if you don't already think in marbles. The `notify$` shared upstream + `pairwise` for connection transitions are the cleanest bits.

### `reatom`

One `newMessage` action that reads atoms via `ctx` and fires output actions. Direct, imperative-looking, very little machinery. The cost: each `ctx.subscribe(action, calls => calls.forEach(c => cb(c.payload)))` adds bytes the others avoid; v1001 (the next major) collapses this further.

### `rtk-listener`

The most-code of the RTK family, but every line is "the official RTK way" — no magic, no library-specific operators. The debounce uses `cancelActiveListeners()` + `delay()` (idiomatic). One slice + four listeners + six output actions + a fan-out listener per output. Wins on familiarity, loses on density.

### `redux-thunk`

Plain redux-thunk: one slice + six output actions + four thunk creators + a 6-line `router` middleware that fans output actions to React subscribers. Inside each thunk: `getState()`, decide, `dispatch(out())`. Throttle and debounce are hand-rolled with a timestamp window + `setTimeout` — vanilla redux-thunk has no scheduling primitives. The thin dispatch path leaves more headroom than rtk-listener's heavier scaffolding or saga's generator scheduler (227k op/sec — best of the Redux family), but still trails Triggery sync at 275k by ~17%. The cost is in code shape: imperative branches inside thunks instead of effects/listeners.

### `redux-saga`

Generators + effect-as-data. Each rule is its own saga: `takeEvery(newMessage, handleBadge)` for R5, `throttle(333, newMessage, handleToast)` for R7 toast, `debounce(600, newMessage, handleSound)` for R7 sound, `fork`/`cancel`/`delay` for R11 settled-read window, `takeEvery(connectionChanged, handleConnection)` for R12-R14. `select`/`put` read and write the store. The throttle and debounce effects come built-in — no hand-rolled timers, no `cancelActiveListeners()` dance.

Saga is the most-code engine in the matrix (264 LOC) and one of the two slowest (57k op/sec — neck-and-neck with rtk-listener) — the price of the generator scheduler. What you buy in return is a uniform vocabulary: every rule is a saga, every side-effect is yielded, every `cancel`/`debounce`/`throttle` is named, not implemented. If your team already thinks in effects, saga reads like a spec; if not, the surface area is real.

### `naked`

Plain JS — closures, a tiny generic `emitter<A>()`, hand-rolled `Set<string>` maps for typing per channel, `setTimeout` for throttle/debounce. The honesty of the comparison: this is what you write when you say "I don't need a library", and it's perfectly fine *until* the next scenario lands on the same codebase.

## Contributing

PRs welcome. New engines (`solid-router`, `jotai`, `mobx`), better idioms for existing engines, new scenarios — see the [top-level README](../README.md).
