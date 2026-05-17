// Framework-agnostic engine contract. Every implementation (triggery, effector,
// rxjs, reatom, rtk-listener) exposes this exact shape so the React shell can
// swap engines via ?engine=… without knowing how the orchestration is done
// inside.
//
// The contract is intentionally narrow: events in, conditions in, actions out
// (via subscribe). No reactive store, no React-specific surface — that's
// exactly the scenario we want to compare.

import type { Message, Settings, Sound, ToastPayload } from './types';

export type Unsubscribe = () => void;

export interface Engine {
  // Events
  fireMessage(msg: Message): void;

  // Conditions (writes — the "world snapshot" each engine gates actions on)
  setSettings(s: Settings): void;
  setActiveChannel(id: string | null): void;
  setCurrentUser(id: string): void;

  // Actions (reads — fan-out subscriptions)
  onShowToast(cb: (p: ToastPayload) => void): Unsubscribe;
  onPlaySound(cb: (s: Sound) => void): Unsubscribe;
  onIncrementBadge(cb: (channelId: string) => void): Unsubscribe;

  // Lifecycle
  dispose(): void;
}

export type EngineId = 'triggery' | 'effector' | 'rxjs' | 'reatom' | 'rtk' | 'naked';

export interface EngineMeta {
  id: EngineId;
  label: string;
  description: string;
  /** Path to the LOC-measured file (relative to repo root) for the score table. */
  sourcePath: string;
}

export interface EngineFactory {
  meta: EngineMeta;
  create(): Engine;
}
