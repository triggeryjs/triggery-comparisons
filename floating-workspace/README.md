# Floating workspace

A real-prototype-grade window manager — drag panels, resize from the corner, ESC/⌘W/⌘K keyboard, modal stack with `alert` / `confirm` / command-palette returning typed promises, snap-to-edge, z-order, persisted layout. Same UI, **nine implementations**, one frozen 20-rule spec.

This is the deliberately-hardest scenario in the repo. Pointer-move events at 60 fps are a stream; window state is a record; keyboard routing is event dispatch; promise-returning modals are async glue. Each library is good at one or two of those four and pays for the others. The leaderboard reshuffles accordingly — read on for an honest spread.

## Headline numbers

|                                  | best                              | worst                            | triggery |
|---|---|---|---|
| **LOC**                          | redux-thunk — 206                 | xstate — 352                     | 8th (332) |
| **Bundle (gzipped)**             | reatom — 4.61 KB                  | redux-saga — 16.46 KB            | **2nd** (6.41 KB) |
| **API surface (imports)**        | **triggery — 1 / 2 symbols**      | rxjs — 2 / 18 symbols            | **1st** |
| **Dependency footprint**         | **triggery — 1 package** *(tied)* | redux-saga — 12 packages         | **tied 1st** |
| **Drag throughput (events/sec)** | redux-thunk — 7.6M / RxJS — 1.65M *(throttle-honoring)* | RTK — 71k                       | 7th (339k) |
| **setBody latency p50**          | RxJS — 1.0 µs                     | RTK — 6.5 µs                     | 4th (2.5 µs) |
| **Cyclomatic complexity**        | rtk / saga — 37                   | xstate — 52                      | 7th (48) |

Three things to read off this honest table:

1. **Triggery doesn't win LOC here.** A simple slice + reducer (RTK-style) is the shortest way to express "20 rules over a record state" — `redux-thunk` ships at 206 LOC and `reatom` at 211. Triggery's 4-trigger split (lifecycle / pointer / keyboard / persist) is more code on this scenario than reactive engines need. It's the right shape for the **vocabulary** (`actions.throttle(16)` is a one-liner), but the 4 trigger setups eat the savings on this 20-rule app.
2. **Bundle, API surface, and dependency footprint are still Triggery's home turf.** 6.41 KB gz (half of effector/rxjs/redux-thunk, a third of saga), one import / two symbols, one npm package. The Redux family ships 5 packages just to start; saga ships 12.
3. **Throughput numbers tell two stories at once.** The naïve `events/sec` column makes Redux + thunk look fastest (7.6M ev/sec) — but that engine is *not* applying every event: its hand-rolled `lastMoveTime` throttle drops 997 of 1000 incoming `pointerMove`s and only fires 3 snapshot updates. RxJS does the same with `throttleTime(16)`. Triggery and naked also throttle to 3 snapshots out of 1000 events. **XState is the outlier — it produces 1002 snapshots from 1000 events** because its idiomatic `cancel + raise + delay` pattern is *debounce-shaped, not throttle-shaped*. We call that out honestly below.

## The 9 engines

- [`triggery`](./src/engines/triggery.ts) — four triggers (lifecycle / pointer / keyboard / persist), `actions.throttle(16)` + `actions.debounce(1000)` declarative
- [`xstate`](./src/engines/xstate.ts) — `idle`/`dragging`/`resizing` as top-level states; `raise+cancel` for throttle (see honest caveat below)
- [`effector`](./src/engines/effector.ts) — events + one `$workspace` store + hand-rolled timers
- [`rxjs`](./src/engines/rxjs.ts) — `Subject<Action>` + `scan` reducer + `throttleTime` + `debounceTime`
- [`reatom`](./src/engines/reatom.ts) — atoms + actions, mutator-action, hand-rolled timers
- [`rtk-listener`](./src/engines/rtk-listener.ts) — slice + listeners with `cancelActiveListeners()` + `delay()`
- [`redux-thunk`](./src/engines/redux-thunk.ts) — slice + thunks + hand-rolled timers
- [`redux-saga`](./src/engines/redux-saga.ts) — slice + sagas (`throttle` / `debounce` effects)
- [`naked`](./src/engines/naked.ts) — no library, mutable state, hand-rolled timers

## Acceptance behaviour (the spec — frozen)

20 rules over 6 concerns. Every engine satisfies them identically.

### Lifecycle

- **R1.** `openPanel(kind)` adds a floating window with a unique id and seeded position.
- **R2.** `close(id)` removes any window. For modal openers (alert/confirm/palette) the awaiting promise resolves with the result.
- **R3.** Max **5 floating panels** (modals don't count). Subsequent `openPanel` returns `null`.
- **R4.** Modals stack — a second `open` adds to the top; ESC closes the top one.

### Drag (floating panels only)

- **R5.** Pointerdown on title bar → start drag; capture offset from panel's top-left.
- **R6.** Pointermove → update position, **throttled to ~60 fps** (16 ms window).
- **R7.** Pointerup → end drag, flush persist.
- **R8.** Clamp to viewport: the window cannot be dragged off-screen.
- **R9.** Snap to edge when within 12 px (top/left/right/bottom).

### Resize (floating panels)

- **R10.** Pointerdown on the bottom-right handle → start resize.
- **R11.** Pointermove → update size, throttled like drag.
- **R12.** Min 200×120; max = viewport.

### Focus / z-order

- **R13.** Pointerdown anywhere on a floating panel → bring to top + focus.
- **R14.** Modals always above all floating panels.

### Keyboard

- **R15.** **ESC** → close top modal; otherwise close focused floating panel.
- **R16.** **⌘K / Ctrl+K** → open command palette.
- **R17.** **⌘W / Ctrl+W** → close focused floating panel (only when no modal is open).

### Persistence

- **R18.** Any floating-layout change schedules a **debounced 1000 ms** localStorage write.
- **R19.** On mount → restore the saved layout.
- **R20.** `reset()` clears state + localStorage.

## How to play with it

```bash
pnpm install
pnpm --filter triggery-comparison-floating-workspace dev
# → http://localhost:5182/?engine=triggery
```

Switch engines: `?engine=triggery | xstate | effector | rxjs | reatom | rtk | redux-thunk | redux-saga | naked`. Try:

- **+ Note** / **+ Inspector** — open panels.
- **Drag the title bar** — move; release near an edge to snap.
- **Drag the bottom-right corner** — resize.
- **⌘K** — open command palette; type to filter; Enter or click to run.
- **⌘W** — close focused.
- **Esc** — close top modal or focused panel.

## Measurements

```bash
pnpm measure
```

Numbers live in `measure/reports/` and are committed.

<!-- BEGIN: measurements -->

### Code size

LOC (non-comment, non-blank) of `src/engines/<engine>.ts`:

| engine | LOC | bytes |
|---|---:|---:|
| redux-thunk  |  206 |  9308 |
| reatom       |  211 |  8903 |
| rtk-listener |  212 |  9486 |
| effector     |  217 |  9773 |
| redux-saga   |  217 |  9674 |
| rxjs         |  257 | 11341 |
| naked        |  271 |  9238 |
| **triggery** | **332** | **13227** |
| xstate       |  352 | 15215 |

Bundle size — engine + transitive deps, esbuild ES2022 ESM, React externalised, `production` export condition:

| engine | minified | gzipped |
|---|---:|---:|
| naked        |   4.86 KB |   2.13 KB |
| reatom       |  10.95 KB |   4.61 KB |
| **triggery** |  **17.85 KB** |   **6.41 KB** |
| effector     |  18.24 KB |   8.17 KB |
| redux-thunk  |  27.25 KB |  10.43 KB |
| rtk-listener |  31.13 KB |  11.87 KB |
| rxjs         |  32.08 KB |  10.32 KB |
| redux-saga   |  44.04 KB |  16.46 KB |
| xstate       |  45.65 KB |  15.20 KB |

### Performance

Two shapes per engine, single canonical run on M1 Pro / Node 20:

- **Drag throughput** — fire 1000 `pointerMove` events in a tight loop while a drag is active. `events/sec` shows the dispatch path's cost; `snapshots / 1000` shows how many actually materialised after each engine's throttle. The intended answer is **≈ 3 snapshots** (1000 events ÷ 16 ms ≈ 3 fires in the loop window).
- **`setBody` latency** — single setBody → next snapshot fire, p50 / p95 / p99.

| engine                 | drag events/sec | snapshots/1000 | setBody p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|
| Naked baseline         |  11407k ev/sec |       3 |  0.63 µs |  0.71 µs |   2.3 µs |
| Redux + thunk          |   7621k ev/sec |       3 |   4.2 µs |    13 µs |    33 µs |
| Effector               |   6861k ev/sec |       3 |   3.1 µs |   6.2 µs |    18 µs |
| Reatom                 |   4854k ev/sec |       3 |   2.4 µs |   3.5 µs |   9.8 µs |
| RxJS                   |   1651k ev/sec |       3 |   1.0 µs |   1.4 µs |   5.7 µs |
| Redux + saga           |    722k ev/sec |       3 |   3.4 µs |    12 µs |    31 µs |
| **Triggery**           |    **339k ev/sec** |    **3** |   **2.5 µs** |   **3.5 µs** |   **9.3 µs** |
| **XState**             |   **100k ev/sec** | **1002** |   **4.4 µs** |   **6.9 µs** |    **21 µs** |
| RTK listenerMiddleware |     71k ev/sec |       2 |   6.5 µs |    11 µs |    23 µs |

**Read with care.** The naïve `events/sec` ranking is misleading because most engines drop almost every event (that's the whole point of throttling). What you actually want to know:

- All engines except XState honour the throttle (3 snapshots from 1000 events).
- **XState fires 1002 snapshots from 1000 events** because the `cancel('id') + raise(EV, { delay, id })` pattern is debounce-shaped: each pointer-move replaces the scheduled raise but the *cancel + raise* sequence itself emits state-transition events the subscriber sees. To get real throttle-shaped semantics in XState you need an explicit `cooling-down` sub-state with an `after` transition — that adds significant LOC and would push xstate even higher on the size axis.
- Triggery's `actions.throttle(16)` honors the throttle (3 snapshots) and clocks 339k events/sec — slower per-event than thunk because the action goes through a runtime dispatch path, but fast enough that 60 fps is never the bottleneck.

### API surface — concepts you have to learn

| engine | unique imports | symbols | primitive constructors |
|---|---:|---:|---|
| naked        | 0 | 0 | (pure JS) |
| **triggery** | **1** | **2** | **`createTrigger`×4, `createRuntime`×1** |
| reatom       | 1 | 3 | `atom`×1, `action`×1, `createCtx`×1 |
| effector     | 1 | 2 | `createEvent`×11, `createStore`×1 |
| redux-thunk  | 1 | 3 | `createSlice`×1 |
| rtk-listener | 1 | 5 | `createAction`×2, `createSlice`×1, `createListenerMiddleware`×1, `startListening`×2 |
| xstate       | 1 | 6 | `setup`, `createMachine`, `createActor`, `assign`, `cancel`, `raise` |
| redux-saga   | 3 | 9 | `createAction`×3, `createSlice`×1 + saga effects (`all`, `call`, `debounce`, `put`, `select`, `takeEvery`, `throttle`) |
| rxjs         | 2 | 9 | `Subject`, `BehaviorSubject` + 7 operators (`scan`, `throttleTime`, `debounceTime`, `filter`, `merge`, `tap`, `share`, …) |

### Complexity & type safety

| engine | cyclomatic | max nesting | `as` casts | `!` non-null |
|---|---:|---:|---:|---:|
| rtk-listener |    37 |       6 |  4 |  0 |
| redux-saga   |    37 |       6 |  5 |  0 |
| effector     |    42 |       7 |  1 |  0 |
| redux-thunk  |    42 |       6 |  3 |  0 |
| reatom       |    43 |       8 |  1 |  0 |
| naked        |    44 |       7 |  1 |  0 |
| **triggery** |    **48** |       **7** |  **3** |  **0** |
| rxjs         |    51 |       7 |  1 |  0 |
| xstate       |    52 |       8 |  4 |  0 |

Triggery 48 (7th of 9). The 4-trigger split + 4 dispatch tables + 4 inline handlers concentrate branching across triggers. RTK / saga are lowest because their reducers compose by name (no `if (event.name === …)` chain). The cyclomatic counter favours "many small functions referenced from a slice" over "few large dispatch tables".

### Dependency footprint

Unique npm packages each engine drags into a production bundle (esbuild metafile, walked transitively, `react`/`react-dom` externalised).

| engine | packages | list |
|---|---:|---|
| naked        | 0 | _(none — pure JS)_ |
| **triggery** | **1** | `@triggery/core` |
| xstate       | 1 | `xstate` |
| effector     | 1 | `effector` |
| reatom       | 1 | `@reatom/core` |
| rxjs         | 2 | `rxjs`, `tslib` |
| rtk-listener | 5 | `@reduxjs/toolkit`, `immer`, `redux`, `redux-thunk`, `reselect` |
| redux-thunk  | 5 | `@reduxjs/toolkit`, `immer`, `redux`, `redux-thunk`, `reselect` |
| redux-saga   | 12 | `@babel/runtime`, `@redux-saga/{core,deferred,delay-p,is,symbols}`, `@reduxjs/toolkit`, `immer`, `redux`, `redux-saga`, `redux-thunk`, `reselect` |

### Mental load — subjective notes

Four axes per engine. 🟢 light · 🟡 medium · 🔴 heavy.

| engine | concepts | spec ↔ code | debug tooling | onboarding | summary |
|---|---|---|---|---|---|
| naked | 🟢 0 | 🟡 closures + `setTimeout`; one growing file | 🟡 just `console.log` | 🟢 instant | 🟢 light |
| **triggery** | 🟢 2 | 🟡 4 triggers + dispatch tables — readable but spread | 🟡 `@triggery/core/inspect` (basic) | 🟢 hours | 🟡 medium |
| reatom | 🟢 3 | 🟡 single mutator action, ctx-bound | 🟡 reatom-devtools (basic) | 🟢 days | 🟢 light |
| effector | 🟡 5 | 🟡 events + store-on chain | 🟢 effector-inspector + Redux DevTools bridge | 🟡 days | 🟡 medium |
| rtk-listener | 🟡 5 | 🟢 slice + listeners reads as a registry | 🟢 Redux DevTools + time travel | 🟢 hours | 🟡 medium |
| redux-thunk | 🟡 5 | 🟢 slice + thunks reads as procedure | 🟢 Redux DevTools | 🟢 hours | 🟡 medium |
| **xstate** | 🟡 6 | 🟢 statechart for drag/resize ↔ ideal | 🟢 Stately inspector + visualizer | 🔴 weeks | 🔴 heavy |
| redux-saga | 🟡 9 | 🟡 generators + effect vocabulary | 🟢 Redux DevTools + saga-monitor | 🟡 days | 🔴 heavy |
| rxjs | 🔴 9 | 🟢 drag-as-stream is canonical | 🔴 deep operator stacks, no first-class inspector | 🔴 weeks | 🔴 heavy |

Honest caveats — what the table doesn't capture:

- **XState's `throttle` is actually debounce here.** The idiomatic `cancel + raise + delay` pattern fires after silence, not during. For drag-during-pointer-stream you want leading-edge throttle. To do real throttle in XState you'd add a `cooldown` sub-state with an `after` transition — ≈ 15-25 more LOC and an extra state node per throttled stream. We left the simpler version in to show the cost honestly.
- **RxJS's spec↔code is 🟢 here, unlike wizard-form** — the drag-as-stream (`pointerDown$ → switchMap(_ => pointerMove$.pipe(throttleTime, takeUntil(pointerUp$)))`) is the textbook pattern. We don't use the literal switchMap form (we reduce through a `Subject<Action>` instead for composition with non-drag actions), but the family is right.
- **Triggery's 4-trigger split is structural overhead** in this scenario. It pays off for the *vocabulary* — `actions.throttle(16)` is a single declarative line, no timer handles, no race-ids — but the 4 setups push absolute LOC into the high range. In a scenario with **more orthogonal event sources** (say, 8 trigger concerns, not 4), the structural cost amortises better.
- **Redux family's "spec ↔ code 🟢"** is honest for this scenario specifically — the slice's reducer cases line up 1:1 with R1-R14 mutations. The "imperative branches in thunks" critique from wizard-form is less applicable here because the workspace state is dominated by record-mutations, not transitions.

<!-- END: measurements -->

## How to read these numbers

Floating-workspace is the **stress test of the scenario set** — pointer streams + record state + keyboard routing + promise-returning modals all at once. Read the leaderboard like a balance sheet:

- **Redux-thunk wins LOC.** When the scenario reduces to "a slice + a couple of thunks", thunk is hard to beat. 206 LOC, predictable Redux DevTools. The cost shows up only in bundle (10.43 KB gz, 1.6× triggery) and the slowest perceived-latency p99 (33 µs).
- **Reatom wins bundle.** 4.61 KB gz, 1 npm package, 3 concepts. It's the only library that comfortably matches naked baseline on weight while still giving you structure.
- **RxJS wins drag-shape ergonomics + setBody latency.** The Subject + scan + throttleTime form is canonical and short (257 LOC). The 18-symbol API is the price.
- **XState wins the drag-state-machine readability**, but loses on every quantifiable axis (longest LOC, second-largest bundle, slowest sustained drag throughput, highest cyclomatic). The trade-off honesty: if your team thinks in statecharts, the rest is bearable; if they don't, this scenario is the most expensive in the matrix.
- **Triggery wins API surface (2 symbols), dependency footprint (1 package), and second-bundle (6.41 KB gz).** It loses LOC and cyclomatic to the slice-based engines because its 4-trigger split is structural overhead that this 20-rule app doesn't amortise. Its `actions.throttle(16).x?.(...)` and `actions.debounce(1000).x?.(...)` lines are individually the shortest in the matrix for "throttled action emit" and "debounced persist".

**Where Triggery makes sense over the alternatives for this kind of scenario:**

1. You already use Triggery in the codebase and want one library for "events + side-effects" everywhere.
2. You need the smallest npm-package count and smallest concept budget (2 symbols).
3. Your scenario has more orthogonal event-source concerns (10+ buttons / shortcuts / streams) where the per-trigger split pays back in readability.

**Where Triggery isn't the right tool here:**

- If your team already thinks in slices + middleware — `redux-thunk` is shorter for this exact shape (record state + side-effects on dispatch).
- If your scenario is dominated by *one* canonical pointer-stream (drag, scroll, paint) and nothing else — rxjs's `pointerDown$ → switchMap → throttleTime → takeUntil` form is the shortest, most direct expression.
- If your app is a fully-fledged state-machine product (multi-stage video player, complex onboarding chain) — xstate's statechart-as-spec wins despite the LOC cost.

## Per-engine notes

### `triggery`

Four triggers, schedule `'sync'`:
- `lifecycle` — open / close / focus / set-query / set-body / reset / load-layout
- `pointer` — start-drag / start-resize / pointer-move / pointer-up (with `actions.throttle(16)` on the move emit)
- `keyboard` — single `key` event routed through a closure flag back to the engine façade
- `persist` — `changed` event from any of the above schedules `actions.debounce(1000).write(state)`; `flush` fires it immediately on pointer-up

Dispatch tables (built once per engine instance, not per event) replace per-event if/else chains. State lives in a closure; the four triggers all mutate it and emit a `snapshot` action that subscribers fan-out from. Modal openers (`alert` / `confirm` / `openCommandPalette`) return promises whose resolvers live in a factory-closure `Map<id, fn>`; `close(id, result)` looks them up.

### `xstate`

`idle`/`dragging`/`resizing` as top-level states; transitions enforce "you can't `START_RESIZE` while dragging". The `cancel('move-throttle') + raise({ type: 'APPLY_MOVE' }, { delay: 16, id })` pattern *looks* like throttle but is debounce-shaped (see honest caveat above). The actor's `submitActor` from wizard-form is replaced here with a closure-held `Map` for modal resolvers because xstate's setup-time actor schema can't see per-instance state — that's where `.provide({ actions })` comes in.

### `effector`

11 `createEvent`s + 1 `$workspace` store with 11 `.on()` handlers. Pointer-move throttle is hand-rolled in a closure (`lastMoveTime`). Persist debounce is `$workspace.updates.watch(scheduleSetTimeout)`. The framework's strength (effect graph) doesn't pay off here because there's no graph — it's a single store with 11 reducers.

### `rxjs`

`Subject<Action>` upstream, `scan` reducer downstream, pointer-moves go through a parallel `throttleTime(16, { leading: true, trailing: true })` branch and merge back in. Persist is a `snapshot$.pipe(debounceTime(1000), tap(persistLayout))` side-effect stream. Cleanly composes — every concern is a stream that merges into the same shape.

### `reatom`

A single `workspaceAtom` plus one `mutate(ctx, fn)` action that takes a function `(s) => s'`. Throttle + debounce are hand-rolled in closure (`lastMoveTime` + `setTimeout`). The framework's structure (atom = unit of memoised computation) doesn't actively help here — you end up using it as a single Container Atom + a mutator function. That's fine, just minimal use of what reatom offers.

### `rtk-listener`

One slice with 12 reducer cases + 2 listeners (`pointerMoveAction` → cancel + delay + applyMove; `persistTrigger` → cancel + delay + persistLayout). The `cancelActiveListeners() + delay(16)` pattern is debounce-shaped like xstate's, but a single dispatch reaches `applyMove` before the next cancel — so the snapshot count is still 2 (out of 1000) in our bench. Loses on perf (71k ev/sec) because every event goes through the listener middleware stack.

### `redux-thunk`

Same slice + 2 thunks (`schedulePersist`, `flushPersistNow`). Pointer-move throttle is `lastMoveTime` check before dispatching `applyMove`. **Best LOC in the matrix at 206**, mostly because the slice carries the bulk of the logic and there's no listener / saga / actor machinery on top.

### `redux-saga`

`throttle(16, pointerMoveAction.type, moveSaga)` + `debounce(1000, mutationOccurred.type, persistSaga)` + `takeEvery(pointerUpAction.type, pointerUpSaga)`. The cleanest one-line throttle/debounce in the matrix at the language level — but 16.46 KB gz, 12 npm packages, and 722k ev/sec drag throughput is the bottom of the non-RTK-listener stack.

### `naked`

Plain JS — mutable `state` object, Set of subscribers, `lastMoveTime` + `setTimeout` for throttle/debounce. 271 LOC and the **fastest** dispatch path of any engine (11.4M ev/sec for the inner loop) because there's literally no library between `setBody(id, body)` and `state.panels[id].body = body`. The dispatch path doesn't help the *perceived* feel of the UI — drag is throttled to 60 fps anyway.
