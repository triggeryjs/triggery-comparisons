// Engine contract for floating-workspace v4 (tree-based tiling).
// The UI subscribes to `subscribe(cb)` and receives a fresh `WorkspaceSnapshot`
// on every change. All input goes through method calls.

import type {
  InspectorMode,
  ModalSpec,
  PanelKind,
  Unsubscribe,
  WorkspaceSnapshot,
} from './types';

export interface Engine {
  snapshot(): WorkspaceSnapshot;
  subscribe(cb: (s: WorkspaceSnapshot) => void): Unsubscribe;

  // ─── lifecycle ─────────────────────────────────────────────────────
  /** Open a new panel. Returns its id, or `null` if MAX_PANELS reached. */
  openPanel(
    kind: PanelKind,
    opts?: { title?: string; body?: string; mode?: 'tiled' | 'floating' },
  ): string | null;
  alert(title: string, body: string): Promise<void>;
  confirm(title: string, body: string): Promise<boolean>;
  openCommandPalette(
    commands: { id: string; label: string; hint?: string }[],
  ): Promise<string | null>;
  /** Close any window — floating, tiled or modal. */
  close(id: string, result?: unknown): void;
  /** Bring a floating panel to the top of z-order; for tiled panels just sets focus. */
  focus(id: string): void;
  /** Update a panel's body (for note editing). */
  setBody(id: string, body: string): void;
  /** Set the inspector mode for a given inspector panel. */
  setInspectorMode(id: string, mode: InspectorMode): void;
  /** Set query text on the open command palette (no-op if none open). */
  setQuery(q: string): void;

  // ─── tiling / mode ─────────────────────────────────────────────────
  /** Move a panel from floating → tiled (appended to right of tree)
   *  or tiled → floating (removed from tree, dropped at a sensible position). */
  setPanelMode(id: string, mode: 'tiled' | 'floating'): void;
  /** Split: insert `srcId` into the tree adjacent to `targetId` at `edge`.
   *  If `srcId` was floating, it becomes tiled. If `srcId` was already in the
   *  tree, it's moved (atomic remove + insert). */
  splitTile(srcId: string, targetId: string, edge: 'top' | 'right' | 'bottom' | 'left'): void;

  // ─── arrange (palette commands) ────────────────────────────────────
  arrangeCascadeFloating(): void;
  arrangeMosaicTiled(): void;
  arrangeRows(): void;
  arrangeColumns(): void;
  arrangeEqualizeTiles(): void;
  /** Convert all panels to one mode. */
  setAllPanelsMode(mode: 'tiled' | 'floating'): void;

  // ─── pointer / keyboard ────────────────────────────────────────────
  /** Begin a drag for a floating panel. */
  startFloatingDrag(id: string, px: number, py: number): void;
  /** Begin a drag-to-split interaction for a tiled panel. */
  startTileDrag(id: string, px: number, py: number): void;
  /** Begin a resize for a floating panel (bottom-right handle). */
  startFloatingResize(id: string, px: number, py: number): void;
  /** Begin a divider resize inside a container at the given divider index. */
  startDividerResize(
    containerId: string,
    dividerIdx: number,
    px: number,
    py: number,
    containerLengthPx: number,
  ): void;
  /** Pointer moved (global). During tile-drag, UI must additionally call
   *  `setTileDropTarget` when the pointer enters/leaves a target leaf. */
  pointerMove(px: number, py: number): void;
  /** UI hover hint for tile-drag — informs the engine of the current target
   *  leaf and zone. Called from UI's per-leaf pointer handler. */
  setTileDropTarget(leafId: string | null, zone: 'top' | 'right' | 'bottom' | 'left' | 'center' | null): void;
  /** Pointer released — engine finalises interaction (e.g. commits a split). */
  pointerUp(): void;
  /** Global cursor tracking — UI calls this on every pointermove, regardless of interaction.
   *  Stored in `snap.cursor` for live inspectors. */
  setCursor(x: number, y: number, overPanelId: string | null): void;
  /** Keyboard event. Returns `true` if the engine handled it. */
  onKey(e: { key: string; meta: boolean; ctrl: boolean }): boolean;

  // ─── persistence / teardown ────────────────────────────────────────
  loadLayout(): void;
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
