// Engine contract — same shape for every implementation. The UI subscribes
// to `subscribe(cb)` to get a fresh `WizardSnapshot` whenever anything
// changes; it pushes input via `setField`, `next`, `back`, `submit`, `reset`.
//
// The contract is deliberately push-based (subscribe + snapshot) so naked /
// observable / reactive / xstate-actor engines all map to it cleanly.

import type { FieldName, WizardData, WizardSnapshot } from './types';

export type Unsubscribe = () => void;

export interface Engine {
  /** Current snapshot — used for synchronous reads (e.g. initial render). */
  snapshot(): WizardSnapshot;
  /** Push a new field value. Triggers validation; email field triggers
   *  debounced async availability check. */
  setField<K extends FieldName>(name: K, value: WizardData[K]): void;
  /** Try to advance one step forward. No-op if the current step is invalid
   *  (sync validation runs first). Picks `preferences` vs `team-size`
   *  branch based on `role`. */
  next(): void;
  /** Step backwards. No-op at the first step. Data is preserved. */
  back(): void;
  /** Submit from the `review` step. Transitions to `submitting`, then to
   *  `success` or `error` (mocked async). No-op outside `review`. */
  submit(): void;
  /** Restart from step 1 and clear all data. Wipes the localStorage draft. */
  reset(): void;
  /** Try to restore data + step from the persisted draft. No-op if none. */
  loadDraft(): void;
  /** Subscribe to snapshot changes. Returns an unsubscribe function. */
  subscribe(cb: (snap: WizardSnapshot) => void): Unsubscribe;
  /** Tear down the engine — flush timers, drop subscriptions, etc. */
  dispose(): void;
}

export type EngineId =
  | 'triggery'
  | 'xstate'
  | 'effector'
  | 'rxjs'
  | 'reatom'
  | 'rtk'
  | 'redux-thunk'
  | 'redux-saga'
  | 'naked';

export interface EngineMeta {
  id: EngineId;
  label: string;
  description: string;
  /** Path (relative to repo root) for the LOC-measured engine file. */
  sourcePath: string;
}

export interface EngineFactory {
  meta: EngineMeta;
  create(): Engine;
}
