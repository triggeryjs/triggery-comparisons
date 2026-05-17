# Notifications pipeline

A chat message arrives. **Three** side-effects should fire — a toast, a sound and a badge increment — gated by user settings and by whether the user is currently in the channel that received the message.

Six implementations of the exact same scenario, sharing one UI:

- [`triggery`](./src/engines/triggery.ts) — declarative trigger file
- [`effector`](./src/engines/effector.ts) — events + stores + samples
- [`rxjs`](./src/engines/rxjs.ts) — Subjects + operator pipeline
- [`reatom`](./src/engines/reatom.ts) — atoms + actions
- [`rtk-listener`](./src/engines/rtk-listener.ts) — Redux Toolkit + listenerMiddleware
- [`naked`](./src/engines/naked.ts) — no library, just a tiny emitter

## Acceptance behaviour (the spec)

This is the rule each implementation must satisfy. **Frozen** — implementations vary, the rule doesn't.

> On every incoming chat message:
>
> 1. **Drop** if the message's `channelId` equals the currently-active channel.
> 2. **Drop** if the message's `authorId` equals the current user (echoes of your own messages).
> 3. If both drops fail, run three independent actions:
>    - **`showToast({ title: author, body: text })`** — only when `settings.notifications === true`
>    - **`playSound('beep')`** — only when `settings.sound === true` AND `settings.dnd === false`, **debounced by 800 ms** (rapid messages produce one beep, not many)
>    - **`incrementBadge(channelId)`** — always (no extra gating)
>
> Until `settings` and `currentUserId` are set, ignore all messages.

## How to compare

```bash
pnpm install
pnpm dev
```

Open <http://localhost:5180/> and switch engines via the URL:

- `?engine=triggery` (default)
- `?engine=effector`
- `?engine=rxjs`
- `?engine=reatom`
- `?engine=rtk`
- `?engine=naked`

Or use the buttons in the header to jump between them. Try the three "Fire" buttons under each engine — same buttons, same gates, same outputs.

## Measurements

```bash
pnpm measure
```

Generates fresh numbers in `measure/reports/`:

- `loc.md` — non-comment LOC per engine file
- `bundle.md` — minified + gzipped size per engine (esbuild bundle, React excluded)

The latest snapshot lives below. Re-run `pnpm measure` to refresh.

<!-- BEGIN: measurements -->

**LOC** (non-comment, non-blank) — `src/engines/<engine>.ts`:

| engine | LOC | bytes |
|---|---:|---:|
| naked        |   52 |  2224 |
| reatom       |   58 |  2946 |
| **triggery** | **71** | **3193** |
| effector     |   75 |  3667 |
| rxjs         |   89 |  3456 |
| rtk-listener |   97 |  3994 |

**Bundle size** — engine + transitive deps, esbuild ES2022 ESM, React externalised:

| engine | minified | gzipped |
|---|---:|---:|
| naked        |   0.76 KB |   0.48 KB |
| reatom       |   6.62 KB |   2.93 KB |
| **triggery** |  **12.44 KB** |   **4.52 KB** |
| rxjs         |  24.28 KB |   7.55 KB |
| effector     |  19.35 KB |   8.80 KB |
| rtk-listener |  26.64 KB |  10.26 KB |

Numbers come from `pnpm measure` on a clean install; regenerate any time. Both files (`loc.md`, `bundle.md`) live in `measure/reports/`.

<!-- END: measurements -->

## What we deliberately do NOT measure

- **Microbenchmarks of dispatch throughput.** Synthetic loops live in [triggeryjs/triggery/benchmarks](https://github.com/triggeryjs/triggery/tree/main/benchmarks). They tell you how fast a library can dispatch nothing useful in a row — not interesting at the scenario level.
- **TypeScript inference depth.** Each engine has its own way of expressing the schema; we use whichever shape the library wants natively. Don't read the LOC numbers as "this library is X% better" — read them as "this scenario is X lines when written in this library's idiom."

## Reading the comparison fairly

For each engine, the file under `src/engines/` is the **entire** orchestration cost. Everything else — the UI, the settings panel, the toast list, the badge map — is shared and identical. So:

- Lines added by an engine = lines you actually write per scenario.
- Bytes added by an engine = what your users download to ship this scenario.
- "Mental load" is yours to judge by reading the file. We have opinions but they're at the bottom of this README.

## Notes per engine (opinions, freely contested)

### `triggery`

The rule is one `handler` function. Conditions are pushed in, actions fan out. Reads top-to-bottom like a spec.

### `effector`

The rule is a *graph*: three `sample`s, two stores, two events. Each piece is small; the cost is mentally assembling them into the rule. Idiomatic effector — patronum would shrink the debounce + a few samples.

### `rxjs`

The rule is an *operator pipeline*. `combineLatest`, `withLatestFrom`, `filter`, `debounceTime`. Very compact once you see it; very steep if you don't think in marbles.

### `reatom`

The rule is an *action* that reads atoms via `ctx`. Very direct. The fan-out subscription needs an extra `for` loop over `calls`, which adds bytes the other engines don't pay.

### `rtk-listener`

The most code in this comparison, by a wide margin. Slice + action creators + listener + per-output listeners. But every line is "the official RTK way" — no magic, no library-specific operators. The debounce uses `cancelActiveListeners()` + `delay()` (idiomatic).

### `naked`

The "what if I just don't?" baseline. Surprisingly small — but only because the requirements happened to fit a tiny emitter. The minute you add a second scenario, the lack of structure starts to bite.

## Contributing

PRs welcome. New engines, better idioms for existing engines, new scenarios — see the [top-level README](../README.md).
