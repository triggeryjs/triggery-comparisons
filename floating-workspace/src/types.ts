// Domain types shared by every engine. UI talks only to these — each engine
// implements the orchestration that drives them.

export type PanelKind = 'note' | 'inspector';

/** Where a panel is docked. `null` = floating. */
export type DockAnchor = 'left' | 'right' | 'bottom';

export interface FloatingPanel {
  id: string;
  kind: PanelKind;
  title: string;
  /** When `dock === null`, x/y are coords in the main area; w/h are size.
   *  When docked, x/y are ignored, and only `w` matters for left/right
   *  docks (their width) while `h` matters for bottom dock (its height).
   *  The other dimension is `auto` (full main area). */
  dock: DockAnchor | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Free-form panel data — `string` (note body) for notes,
   *  JSON-shaped data for inspectors. */
  body: string;
}

export type ModalSpec =
  | { kind: 'alert'; id: string; title: string; body: string }
  | { kind: 'confirm'; id: string; title: string; body: string }
  | {
      kind: 'command-palette';
      id: string;
      query: string;
      // Mutable type (no `readonly`) so RTK/immer can hold this in slice state
      // without complaining. The contract is still "treat as read-only at use".
      commands: { id: string; label: string; hint?: string }[];
    };

export type ModalResult =
  | { kind: 'alert'; result: void }
  | { kind: 'confirm'; result: boolean }
  | { kind: 'command-palette'; result: string | null };

/** Pointer interaction in flight: `null` when idle. */
export type Interaction =
  | null
  | {
      kind: 'drag';
      id: string;
      /** Offset from the panel's top-left to where the pointer grabbed it. */
      offset: { x: number; y: number };
    }
  | {
      kind: 'resize';
      id: string;
      /** Size at the moment resize started. */
      startSize: { w: number; h: number };
      /** Pointer coords at the moment resize started. */
      startPointer: { x: number; y: number };
    }
  | {
      kind: 'dock-resize';
      anchor: DockAnchor;
      /** Dock dimension (width for left/right, height for bottom) at start. */
      startSize: number;
      /** Pointer coord at start (x for left/right, y for bottom). */
      startPointer: number;
    };

/** Public snapshot the UI subscribes to. */
export interface WorkspaceSnapshot {
  /** All open panels (both floating and docked), keyed by id. The `dock`
   *  field on each `FloatingPanel` distinguishes — `null` = floating,
   *  otherwise the anchor side. */
  panels: Record<string, FloatingPanel>;
  /** *Floating* panel ids in bottom-to-top z-order. Docked panels are
   *  never in zOrder (they have their own slot). The last one is on top. */
  zOrder: readonly string[];
  /** Modal stack — last element is the active modal. Modals always render
   *  above everything. */
  modals: readonly ModalSpec[];
  /** Currently focused panel id (floating or docked). Drives ⌘W + ESC fallback. */
  focused: string | null;
  /** In-flight pointer interaction (drag / resize / dock-resize). */
  interaction: Interaction;
  /** Current dock-slot sizes — width for left/right, height for bottom.
   *  Only meaningful when the corresponding dock has a panel in it. */
  dockSizes: { left: number; right: number; bottom: number };
}

export type Unsubscribe = () => void;
