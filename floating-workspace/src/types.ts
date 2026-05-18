// Domain types shared by every engine. UI talks only to these — each engine
// implements the orchestration that drives them.

export type PanelKind = 'note' | 'inspector';

/** Whether a panel lives inside the tile tree or as a free-form floating window. */
export type PanelMode = 'tiled' | 'floating';

/** Inspector view mode — what its body shows. UI reads live `snap.*` to render. */
export type InspectorMode = 'static' | 'state' | 'cursor' | 'tree';

export interface Panel {
  id: string;
  kind: PanelKind;
  title: string;
  /** Plain text for notes; JSON-mock for `inspectorMode === 'static'`; ignored
   *  for other inspector modes (UI computes content from live snap). */
  body: string;
  mode: PanelMode;
  /** Floating geometry — meaningful only when `mode === 'floating'`. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Inspector-only — UI's content renderer mode. Defaults to 'static'. */
  inspectorMode?: InspectorMode;
}

/** Tree-based tiling: every internal node is a row/col split with N children;
 *  every leaf is one panel id. The tree's geometry fills the main area. */
export type TileNode = TileContainer | TileLeaf;
export interface TileContainer {
  kind: 'container';
  id: string;
  /** `row` = horizontal split (children side-by-side, left → right).
   *  `col` = vertical split (children top → bottom). */
  dir: 'row' | 'col';
  /** Tree children. */
  children: TileNode[];
  /** Flex weights — percentage of parent dimension. `sizes.length === children.length`,
   *  sum should be ≈ 100. */
  sizes: number[];
}
export interface TileLeaf {
  kind: 'leaf';
  id: string;
  panelId: string;
}

export type ModalSpec =
  | { kind: 'alert'; id: string; title: string; body: string }
  | { kind: 'confirm'; id: string; title: string; body: string }
  | {
      kind: 'command-palette';
      id: string;
      query: string;
      commands: { id: string; label: string; hint?: string }[];
    };

/** Pointer interaction in flight: `null` when idle. */
export type Interaction =
  | null
  | {
      kind: 'drag-floating';
      id: string;
      offset: { x: number; y: number };
    }
  | {
      kind: 'resize-floating';
      id: string;
      startSize: { w: number; h: number };
      startPointer: { x: number; y: number };
    }
  | {
      kind: 'drag-tiled';
      /** Panel being dragged out of its tile (preview for drag-to-split). */
      id: string;
      /** Target leaf id under pointer, if any (UI shows 5-zone overlay there). */
      targetLeafId: string | null;
      /** Which zone of the target leaf the pointer is in. */
      targetZone: 'top' | 'right' | 'bottom' | 'left' | 'center' | null;
    }
  | {
      kind: 'divider-resize';
      /** Container id whose divider is being dragged. */
      containerId: string;
      /** Index in `sizes` of the LEFT/TOP-side child of this divider. */
      dividerIdx: number;
      /** Starting sizes before drag. */
      startSizes: number[];
      /** Pointer coord at start (x for row dir, y for col dir). */
      startPointer: number;
      /** Container's total length along the split axis (in px), captured at drag start. */
      containerLength: number;
    };

/** Public snapshot the UI subscribes to. */
export interface WorkspaceSnapshot {
  /** All open panels (both tiled and floating), keyed by id. Mode field discriminates. */
  panels: Record<string, Panel>;
  /** Tile tree — null when no tiled panels exist. */
  tree: TileNode | null;
  /** Floating panel ids in bottom-to-top z-order. */
  floatingZOrder: readonly string[];
  /** Modal stack — last is the active modal, always rendered above everything. */
  modals: readonly ModalSpec[];
  /** Currently focused panel id (tiled or floating). */
  focused: string | null;
  /** In-flight pointer interaction. */
  interaction: Interaction;
  /** Live cursor tracking — used by inspector's 'cursor' mode. */
  cursor: { x: number; y: number; overPanelId: string | null };
}

export type Unsubscribe = () => void;
