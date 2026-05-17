# Notifications pipeline

A Discord-like chat client. Messages arrive over a (mocked) WebSocket; the client has to gate, throttle, debounce and fan them out into the right side-effects. Same UI, six implementations, one frozen spec.

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

**LOC** (non-comment, non-blank) — `src/engines/<engine>.ts`:

| engine | LOC | bytes |
|---|---:|---:|
| naked        |  136 |  5102 |
| reatom       |  162 |  6347 |
| effector     |  192 |  8168 |
| rxjs         |  198 |  7806 |
| **triggery** | **215** | **8618** |
| rtk-listener |  224 |  9033 |

**Bundle size** — engine + transitive deps, esbuild ES2022 ESM, React externalised:

| engine | minified | gzipped |
|---|---:|---:|
| naked        |   1.92 KB |   0.94 KB |
| reatom       |   8.18 KB |   3.47 KB |
| **triggery** |  **14.60 KB** |   **5.19 KB** |
| rxjs         |  28.74 KB |   9.03 KB |
| effector     |  21.13 KB |   9.39 KB |
| rtk-listener |  28.94 KB |  10.97 KB |

<!-- END: measurements -->

## How to read these numbers

**Bundle size is the cleaner signal.** What you ship to your users is unchanged by stylistic choices — it's the cost of the library, full stop. Triggery is 2nd-smallest after reatom and **roughly half of effector / rxjs / rtk**.

**LOC requires more interpretation:**

- **Triggery's 215 LOC carries ~25 lines of manual fan-out boilerplate** (a `subs` Set + a `fan()` helper for each of the six output actions) that effector / rxjs / reatom / rtk get for free from their framework (`event.watch`, `subject.subscribe`, `ctx.subscribe`, `listener.startListening`). The triggery v1 API only allows a single `registerAction` handler per action; we manually multiplex. With a small core-level addition this is one of the [top-priority gaps in the audit](https://github.com/triggeryjs/triggery/issues) — and would shave triggery from 215 → ~190.
- **The "spec-shaped" handler of triggery reads top-to-bottom**, matching the natural-language spec almost line for line. Effector's same logic is split across three `sample`s with cross-referenced filters. RxJS uses one shared `notify$` source piped twice. Both work; both require holding more of the data flow in your head.
- **Naked is small only because the scenario fit a tiny emitter.** Add a second scenario and the lack of structure starts to bite — variables proliferate, debounce/throttle get duplicated, the `if`-chain in `fireMessage` becomes unmaintainable.

## What this comparison deliberately does NOT measure

- **Microbenchmarks of dispatch throughput.** Synthetic loops live in [triggeryjs/triggery/benchmarks](https://github.com/triggeryjs/triggery/tree/main/benchmarks). They tell you how fast a library can dispatch nothing useful in a row.
- **TypeScript inference depth.** Each engine uses its own idiomatic shape for the schema.
- **DevTools / inspector quality.** Each engine has very different debuggability stories (Redux DevTools bridge, in-app inspector, opt-in). Worth its own comparison; not this one.

## Per-engine notes (opinions, freely contested)

### `triggery`

Four triggers, one per event family (`message-received`, `channel-changed`, `typing`, `connection`). Each handler reads top-to-bottom like a natural-language spec — the R1-R7 chain in `messageTrigger` is literally a translation of "ignore your own messages, then increment badge, then gate, then throttle, then debounce". `actions.throttle(1000/3)` and `actions.debounce(600)` are first-class.

Lines lost: the fan-out boilerplate (see above) and the 4× `registerCondition` + `registerAction` calls that effector handles inline.

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
