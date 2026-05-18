# Wizard form

A multi-step onboarding wizard: account → profile → (preferences | team-size, branching on role) → review → submit. Email is async-validated. Drafts are persisted. Submit is a network call with success/failure. Same UI, **nine implementations**, one frozen spec.

## Headline numbers

For the 8-rule scenario in this folder (see [acceptance spec](#acceptance-behaviour-the-spec--frozen) below). "naked" is excluded from the leader column — it's a no-library baseline, not a competitor. xstate is *included* this time because state machines are exactly what wizards are.

|                                | best library             | worst library              | triggery |
|---|---|---|---|
| **LOC**                        | **triggery — 163**         | xstate — 283               | **1st** |
| **API surface**                | **triggery — 1 import / 2 symbols** | rxjs — 2 imports / 18 symbols | **1st** |
| **Bundle (gzipped)**           | reatom — 4.03 KB           | redux-saga — 15.69 KB      | 2nd (5.58 KB) |
| **Throughput (setField/sec)**  | rxjs — 305k op/sec         | rtk — 20k op/sec           | 3rd (205k) |
| **Latency p50**                | rxjs / reatom — 2.0 µs     | rtk — 9.5 µs               | 3rd (2.6 µs) |
| **Cyclomatic complexity**      | rtk / saga — 17            | **triggery — 29**          | **last** |

Triggery wins on LOC + API surface; rxjs wins both perf axes (sync Subject + `scan` reducer is unbeatable for "apply N field updates"); reatom keeps its smallest-bundle crown; **xstate is the verbose one** (283 LOC, 14.57 KB gz, 71k op/sec) but its cyclomatic complexity is the 3rd-lowest in the matrix (20) — *the statechart shifts complexity out of `if`-chains into declarative transitions, which the cyclomatic counter rewards*. That trade-off is the whole point.

- [`triggery`](./src/engines/triggery.ts) — one trigger, switch-on-event handler, `actions.debounce()` for email + draft
- [`xstate`](./src/engines/xstate.ts) — statechart: states + transitions + guards; debounce via `raise({ delay, id })` + `cancel(id)`
- [`effector`](./src/engines/effector.ts) — events + stores + samples + effects
- [`rxjs`](./src/engines/rxjs.ts) — `Subject<Action>` + `scan` reducer + operators
- [`reatom`](./src/engines/reatom.ts) — atoms + actions, ctx-scoped state, hand-rolled timers
- [`rtk-listener`](./src/engines/rtk-listener.ts) — slice + listenerMiddleware
- [`redux-thunk`](./src/engines/redux-thunk.ts) — slice + thunks + hand-rolled timers
- [`redux-saga`](./src/engines/redux-saga.ts) — slice + saga (`debounce` / `takeEvery` / `call`)
- [`naked`](./src/engines/naked.ts) — no library, mutable state, plain `setTimeout`

## Acceptance behaviour (the spec — frozen)

### Steps + branching

1. **`account`** — email, password, password-confirm.
2. **`profile`** — name, role (`developer` | `designer` | `manager`).
3. **`preferences`** — notification frequency + marketing opt-in (only when `role !== 'manager'`).
3'. **`team-size`** — pick a team size (only when `role === 'manager'`).
4. **`review`** — read-only summary.
5. submit → success / failure.

### Rules

- **R1.** Forward navigation only fires when sync validation passes (`validateStep` returns no errors).
- **R2.** Back navigation works at any time, doesn't clear data.
- **R3.** Conditional branching on `role`:
  - `profile` → `team-size` if `role === 'manager'`, else `profile` → `preferences`.
  - back from review goes to whichever branch was taken.
- **R4.** Email field — **debounced 500 ms** — hits `checkEmailAvailable(email)` (~250 ms mocked); supersedes in-flight checks on new keystrokes; if response is for an outdated input, drop it.
- **R5.** Any field change schedules a **debounced 1000 ms** localStorage write. On forward navigation, flush the pending draft immediately (no debounce wait).
- **R6.** Submit (from `review`) flips state to `submitting` (disables inputs), then resolves to `success { userId }` or `error { message }` (~700 ms, 1-in-5 fails).
- **R7.** Reset clears all state + draft, returns to step 1.
- **R8.** Display `step X of N` — derived; total is 4 (`account / profile / [prefs|team-size] / review`).

The mocked `checkEmailAvailable` says `admin@example.com` and `taken@example.com` are taken; everything else passes.

## How to play with it

```bash
pnpm install
pnpm --filter triggery-comparison-wizard-form dev
# → http://localhost:5181/?engine=triggery
```

Switch engines with the pill buttons at the top, or in the URL:
`?engine=triggery | xstate | effector | rxjs | reatom | rtk | redux-thunk | redux-saga | naked`.

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
| naked        |  139 |  4903 |
| **triggery** | **163** | **6590** |
| reatom       |  169 |  5708 |
| redux-thunk  |  189 |  6543 |
| redux-saga   |  193 |  6848 |
| rtk-listener |  195 |  6734 |
| rxjs         |  205 |  7545 |
| effector     |  210 |  8467 |
| xstate       |  283 | 10045 |

Bundle size — engine + transitive deps, esbuild ES2022 ESM, React externalised, `production` export condition enabled:

| engine | minified | gzipped |
|---|---:|---:|
| naked        |   3.29 KB |   1.49 KB |
| reatom       |   9.15 KB |   4.03 KB |
| **triggery** |  **15.49 KB** |   **5.58 KB** |
| rxjs         |  29.95 KB |   9.52 KB |
| redux-thunk  |  25.42 KB |   9.84 KB |
| effector     |  22.71 KB |  10.01 KB |
| rtk-listener |  29.39 KB |  11.28 KB |
| xstate       |  43.96 KB |  14.57 KB |
| redux-saga   |  41.49 KB |  15.69 KB |

### Performance

Two shapes per engine: **throughput** (1000 sequential `setField` calls, microtasks flushed once at the end — models typing into a form) and **per-update latency** (one `setField`, await snapshot subscription fire, measure round-trip). Median of 5 trials, M1 Pro / Node 20.

| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|---|---:|---:|---:|---:|
| Naked baseline         |  997k ops/sec |  0.38 µs |  0.46 µs |   1.2 µs |
| RxJS                   |  305k ops/sec |   2.0 µs |   2.1 µs |   2.7 µs |
| Reatom                 |  214k ops/sec |   2.0 µs |    16 µs |    53 µs |
| **Triggery**           |  **205k ops/sec** |   **2.6 µs** |   **3.6 µs** |   **25 µs** |
| Redux + thunk          |  100k ops/sec |   7.8 µs |   8.6 µs |    19 µs |
| Redux + saga           |   80k ops/sec |   7.7 µs |   8.5 µs |    12 µs |
| XState                 |   71k ops/sec |   4.3 µs |   6.0 µs |    15 µs |
| Effector               |   61k ops/sec |   6.2 µs |   8.0 µs |    22 µs |
| RTK listenerMiddleware |   20k ops/sec |   9.5 µs |    12 µs |    37 µs |

> Numbers vary ±10–15% between runs. Treat as an honest snapshot.

RxJS wins this scenario's perf — a `Subject<Action>` + `scan` reducer is essentially the same as the naked baseline with a thin operator wrapper, no observers, no graph propagation. Triggery's sync-handler path lands 3rd; reatom is the surprise on p99 latency (53 µs — atom recomputation on every field write costs).

### API surface — concepts you have to learn

| engine | unique imports | symbols | primitive constructors |
|---|---:|---:|---|
| naked        | 0 | 0 | (pure JS) |
| **triggery** | **1** | **2** | **`createTrigger`×1, `createRuntime`×1** |
| reatom       | 1 | 3 | `atom`×6, `action`×6, `createCtx`×1 |
| effector     | 1 | 5 | `createEvent`×11, `createStore`×5, `createEffect`×2, `sample`×6, `combine`×1 |
| rtk-listener | 1 | 5 | `createAction`×1, `createSlice`×1, `createListenerMiddleware`×1, `startListening`×4 |
| redux-thunk  | 1 | 5 | `createSlice`×1 + 4 thunk creators |
| xstate       | 1 | 7 | `setup`, `createMachine`, `createActor`, `assign`, `fromPromise`, `raise`, `cancel` |
| redux-saga   | 3 | 11 | `createSlice` + 6 effects (`all`, `call`, `debounce`, `put`, `select`, `takeEvery`) + saga middleware |
| rxjs         | 2 | 18 | `Subject`, `BehaviorSubject` + 13 operators (`scan`, `debounceTime`, `switchMap`, `withLatestFrom`, `filter`, `map`, `tap`, `merge`, `distinctUntilChanged`, `startWith`, `combineLatest`, `defer`, `from`) |

### Complexity & type safety

| engine | cyclomatic | max nesting | `as` casts | `!` non-null |
|---|---:|---:|---:|---:|
| rtk-listener |    17 |       6 | 11 |  0 |
| redux-saga   |    17 |       6 |  7 |  0 |
| **xstate**   |    **20** |       **8** |  **4** |  **0** |
| naked        |    22 |       7 |  1 |  0 |
| reatom       |    22 |       6 |  1 |  0 |
| redux-thunk  |    24 |       6 |  4 |  0 |
| effector     |    25 |       6 | 11 |  0 |
| rxjs         |    26 |       7 |  3 |  0 |
| **triggery** |    **29** |       **9** |  **3** |  **0** |

The cyclomatic flip is the headline of this scenario. **Triggery has the highest cyclomatic** because its handler is one big switch over event names — every transition is an `if` / `case` / sequential check. **xstate is 3rd-lowest** because its transitions are declarative: `target: 'profile', guard: 'accountValid'` reads as a tuple, not as a branch the cyclomatic counter sees. The `as` casts on rtk-listener / effector are mostly state-typing boilerplate (`getState() as State`).

<!-- END: measurements -->

## How to read these numbers

Wizard-form is the **opposite scenario** to notifications-pipeline: there, gating + throttle + debounce + fan-out across many events; here, multi-step navigation with branching + async validation + draft persistence. The shape of the problem reshuffles the leaderboard.

- **XState is the readability winner, even though it's the verbose loser.** 283 LOC, 14.57 KB gz, 71k op/sec — easily the worst on size and perf. But the file reads as a **statechart**: `account → profile → (team-size | preferences) → review → submitting → success` is right there, transitions, guards, invoked actors. The 3rd-lowest cyclomatic complexity is real: state-machine modelling hides branching in `target` + `guard` tuples that the counter doesn't count as conditionals. If your wizard has 10 states and 30 transitions, this is the engine where adding the 31st is the easiest to reason about.
- **Triggery wins LOC + API surface but pays in cyclomatic.** One switch-on-event handler is the most compact translation of the spec, but it concentrates every `if` / `case` in one place. Splitting the switch into one trigger-per-event would lower cyclomatic and raise LOC — same trade-off seen everywhere, just made explicit here.
- **RxJS is the perf winner** (305k op/sec, 2.0 µs latency). A `Subject<Action>` + `scan` reducer is basically the naked baseline plus an operator wrapper — minimal extra cost per dispatch.
- **Reatom keeps its bundle crown.** 4.03 KB gz, narrowly above naked. Atom-as-direct-call is the tightest packaging in the matrix.
- **Effector is graph-heavy in this shape.** 11 `createEvent`s, 5 stores, 6 samples to wire a 5-state machine — every transition adds a sample, every condition needs `filter` + `fn`. 210 LOC, 61k op/sec. If your domain is dataflow (streams in, streams out), effector pays back; for FSM-shaped problems it's the most-typed-out.
- **RTK listener-middleware lands last on every perf axis** (20k op/sec, 9.5 µs p50). The async listeners + `cancelActiveListeners()` + `delay()` machinery has the heaviest per-dispatch cost. Familiar, expensive.
- **Redux-thunk is the perf-leader of the Redux family** (100k op/sec) — same pattern that won notifications-pipeline. Thin dispatch path > heavy listener / saga scaffolding.

**Where Triggery makes sense over the alternatives for wizard-form:**

1. You want the smallest code (LOC) + smallest concept budget (2 symbols), and the cyclomatic of a single switch handler is fine to live with.
2. You want triggery anyway for other scenarios and don't want to add a second library just for the wizard.
3. The wizard is small enough that statechart-overhead would dominate.

**Where Triggery isn't the right tool for wizard-form:**

- If your wizard is **complex enough that a visualisable statechart pays back** (10+ states, error/retry sub-machines, hierarchical states, parallel regions) — that's xstate's home turf, and the LOC/bundle cost is worth it.
- If you're already deep in Redux — pick the variant your team speaks (thunk for compactness, saga for effect-as-data, listenerMiddleware for "the official RTK way").

## Per-engine notes

### `triggery`

One trigger, sync schedule, switch-on-event handler. State lives in a closure — triggery's `conditions` map isn't used (a form is a form, not a graph). Triggery's value here is **`actions.debounce(500).checkEmail()` and `actions.debounce(1000).saveDraft()`** — declarative debounce primitives that other handler-shaped engines (naked / thunk / reatom) have to hand-roll. Async work (`checkEmailAvailable`, `submitWizard`) lives in action subscribers, results feed back via dedicated events (`email-check-done`, `submit-done`). The big switch keeps the LOC count tight but pushes the cyclomatic count up.

### `xstate`

The shape this library was built for. `setup({ guards, actions, actors })` declares the vocabulary; `.createMachine({ states: {...} })` declares the wiring. Conditional branching (R3) is two transitions on the same event with different `guard`s. Debounce (R4 + R5) uses `raise({ delay, id })` + `cancel(id)` — XState's first-class scheduled action; no timer handles. Async submit is an invoked `fromPromise(...)` actor. All this costs **283 LOC** (the most) and **14.57 KB gz** (2nd most) — XState is not free — but the **statechart you'd draw on a whiteboard is literally the code**.

### `effector`

11 events, 5 stores, 6 `sample`s, 1 `combine` for the snapshot. Every state-change rule is "event → filter → store mutation"; every async is an effect. The graph is small enough to fit in the file but each piece is wired explicitly. Effector pays for its dataflow purity in LOC (210, second-most) and per-event latency (6.2 µs).

### `rxjs`

`Subject<Action>` upstream, `scan(reduce, initialSnapshot)` for the reducer, separate streams for the async side-effects (`switchMap` for email check, `debounceTime` + `withLatestFrom` for draft save). The reducer-shape gives RxJS the best perf in this matrix because there's no graph propagation — just synchronous Subject + scan + observers. 18 imported symbols is the steepest API surface; if you already think in marbles, the operator pipeline is concise.

### `reatom`

6 atoms + 6 actions; `snapshotAtom` is a computed atom that spies the others. Async (email, submit) inside an `action(async (c) => ...)`. Timers hand-rolled (reatom v3 has no built-in debounce). Smallest bundle in the matrix.

### `rtk-listener`

One slice + a couple of input actions + 4 listeners. Email + draft debounce use `cancelActiveListeners()` + `delay()` — idiomatic RTK. Async submit is a listener that awaits `submitWizard`. The official RTK way; loses on perf because every cancel + delay round-trip is expensive.

### `redux-thunk`

One slice + 4 thunks. Each thunk is a function that reads `getState()`, decides, dispatches. Email + draft debounce are hand-rolled `setTimeout` handles in a closure (vanilla thunk has no scheduling). Async submit is `async (dispatch, getState) => { ... await ... ; dispatch(setSubmit(...)); }`. The Redux family's perf leader.

### `redux-saga`

`debounce(500, setField, emailCheckSaga)` for email — saga's built-in debounce effect cancels prior in-flight calls automatically (no manual `cancelActiveListeners`). Same trick for draft save. `takeEvery` for `nextClicked` / `backClicked` / `submitClicked`. The cleanest one-liner debounce in the matrix.

### `naked`

Mutable `state` object, a Set of subscribers, two `setTimeout` handles for email + draft debounce, one counter for the email-race guard. The honesty of the comparison: 139 LOC and 1.49 KB gz baseline; you'd be perfectly fine writing this for one wizard, **until** the second one lands.
