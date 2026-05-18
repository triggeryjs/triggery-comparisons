// Domain types shared by every engine. UI talks only to these — each engine
// implements the orchestration that drives them.

export type PanelKind = 'note' | 'inspector';

export interface FloatingPanel {
  id: string;
  kind: PanelKind;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Free-form panel data — `string` (note body) for notes,
   *  `{ readonly: boolean; lines: string[] }` for inspectors. */
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
    };

/** Public snapshot the UI subscribes to. */
export interface WorkspaceSnapshot {
  /** All open floating panels, keyed by id. */
  panels: Record<string, FloatingPanel>;
  /** Panel ids in bottom-to-top z-order. The last one is "on top". */
  zOrder: readonly string[];
  /** Modal stack — last element is the active modal. Modals always render
   *  above all floating panels. */
  modals: readonly ModalSpec[];
  /** Currently focused floating-panel id (drives ⌘W + ESC fallback). */
  focused: string | null;
  /** In-flight pointer interaction (drag/resize). UI uses this to hide
   *  text selection + force `cursor: grabbing`. */
  interaction: Interaction;
}

export type Unsubscribe = () => void;
