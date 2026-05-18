// Engine contract for floating-workspace. UI subscribes to `subscribe(cb)`
// to receive `WorkspaceSnapshot`s. All input (open, close, focus, pointer,
// keyboard, command-palette query) goes through method calls; the engine
// owns the state machine and pushes a fresh snapshot whenever anything
// changes.
//
// Modal openers return typed promises so callers can `await` them.

import type {
  DockAnchor,
  ModalSpec,
  PanelKind,
  Unsubscribe,
  WorkspaceSnapshot,
} from './types';

export interface Engine {
  snapshot(): WorkspaceSnapshot;
  subscribe(cb: (s: WorkspaceSnapshot) => void): Unsubscribe;

  // ─── lifecycle ─────────────────────────────────────────────────────
  /** Open a floating panel; rejected (returns null) when max-5 hit. */
  openPanel(kind: PanelKind, opts?: { title?: string; body?: string }): string | null;
  alert(title: string, body: string): Promise<void>;
  confirm(title: string, body: string): Promise<boolean>;
  openCommandPalette(
    commands: { id: string; label: string; hint?: string }[],
  ): Promise<string | null>;
  /** Close any window by id; for modals, `result` is forwarded to the awaiting promise. */
  close(id: string, result?: unknown): void;
  /** Bring a floating panel to the top of z-order + mark focused. */
  focus(id: string): void;
  /** Set query text on the open command palette (no-op if none open). */
  setQuery(q: string): void;
  /** Update a floating panel's body (for note editing). */
  setBody(id: string, body: string): void;

  // ─── dock / undock ─────────────────────────────────────────────────
  /** Move a panel into a dock slot. If the slot is occupied, the previous
   *  occupant goes back to floating with a sensible centered position. */
  dock(id: string, anchor: DockAnchor): void;
  /** Move a docked panel back into floating area. */
  undock(id: string): void;

  // ─── pointer / keyboard ────────────────────────────────────────────
  /** Begin a drag interaction. UI calls on pointerdown on title bar. */
  startDrag(id: string, pointerX: number, pointerY: number): void;
  /** Begin a resize interaction. UI calls on pointerdown on resize handle. */
  startResize(id: string, pointerX: number, pointerY: number): void;
  /** Begin a dock-divider resize. UI calls on pointerdown on the divider
   *  between a docked panel and the main area. */
  startDockResize(anchor: DockAnchor, pointerX: number, pointerY: number): void;
  /** Pointer moved (global) — engine applies throttled drag/resize updates. */
  pointerMove(pointerX: number, pointerY: number): void;
  /** Pointer released anywhere — engine ends drag/resize. */
  pointerUp(): void;
  /** Keyboard event. `meta`/`ctrl` distinguishes ⌘ vs Ctrl.
   *  Returns `true` if the engine handled it (UI should `preventDefault`). */
  onKey(e: { key: string; meta: boolean; ctrl: boolean }): boolean;

  // ─── persistence / teardown ────────────────────────────────────────
  /** Read the saved layout from localStorage (if any) and apply it. */
  loadLayout(): void;
  /** Clear all windows + localStorage. */
  reset(): void;
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
  sourcePath: string;
}

export interface EngineFactory {
  meta: EngineMeta;
  create(): Engine;
}

export type { ModalSpec, WorkspaceSnapshot };
