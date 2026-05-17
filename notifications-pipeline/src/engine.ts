// Framework-agnostic engine contract. Every implementation (triggery, effector,
// rxjs, reatom, rtk-listener, naked) exposes this exact shape so the React
// shell can swap engines via ?engine=… without knowing how the orchestration
// is done inside.
//
// The contract is intentionally narrow: events in (fire*), conditions in
// (set*), actions out (on*). No reactive store, no React-specific surface —
// that is exactly the scenario we want to compare.

import type {
  ConnectionState,
  Message,
  Settings,
  Sound,
  ToastPayload,
  TypingUpdate,
  User,
} from './types';

export type Unsubscribe = () => void;

export interface Engine {
  // ─── inputs / events ───────────────────────────────────────────────
  fireMessage(msg: Message): void;
  fireTypingStart(p: { userId: string; channelId: string }): void;
  fireTypingStop(p: { userId: string; channelId: string }): void;
  /** UI shell calls this when the active channel changes. The engine
   *  uses it to schedule a debounced `markChannelRead`. */
  fireChannelChanged(channelId: string | null): void;
  setConnectionState(state: ConnectionState): void;

  // ─── inputs / conditions ───────────────────────────────────────────
  setSettings(s: Settings): void;
  setActiveChannel(id: string | null): void;
  setCurrentUser(user: User | null): void;
  setMutedChannels(ids: ReadonlySet<string>): void;

  // ─── outputs / subscriptions ───────────────────────────────────────
  onShowToast(cb: (t: ToastPayload) => void): Unsubscribe;
  onPlaySound(cb: (s: Sound) => void): Unsubscribe;
  onIncrementBadge(cb: (channelId: string, muted: boolean) => void): Unsubscribe;
  onClearBadge(cb: (channelId: string) => void): Unsubscribe;
  onTypingChange(cb: (u: TypingUpdate) => void): Unsubscribe;
  onMarkChannelRead(cb: (channelId: string) => void): Unsubscribe;

  // ─── lifecycle ─────────────────────────────────────────────────────
  dispose(): void;
}

export type EngineId = 'triggery' | 'effector' | 'rxjs' | 'reatom' | 'rtk' | 'naked';

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
