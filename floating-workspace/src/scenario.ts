// Shared scenario fixtures + helpers used by every engine. Tree manipulation,
// arrange algorithms, validators, persistence — anything that doesn't belong
// in the engine orchestration sits here.

import type {
  InspectorMode,
  Panel,
  PanelKind,
  TileContainer,
  TileLeaf,
  TileNode,
  WorkspaceSnapshot,
} from './types';

export const STORAGE_KEY = 'triggery-comparison.floating-workspace.v4';

/** Pointer-move updates are throttled to ~60 fps. */
export const POINTER_THROTTLE_MS = 16;
/** Layout persistence — debounced after any change. */
export const PERSIST_DEBOUNCE_MS = 1000;
/** Max panels (tiled + floating combined). */
export const MAX_PANELS = 8;
/** Snap distance during floating-panel drag. */
export const SNAP_PX = 12;
/** Floating-panel size constraints. */
export const MIN_PANEL = { w: 200, h: 120 };
/** Tile-split drop-zone thresholds (fraction of leaf size). */
export const DROP_EDGE_FRACTION = 0.25;
/** Minimum size of any tile (px). Divider clamps each side to this. */
export const MIN_TILE_PX = 120;

// ─── ID generation ─────────────────────────────────────────────────────

let idCounter = 0;
export function genId(prefix: 'panel' | 'modal' | 'node'): string {
  idCounter += 1;
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${r}${idCounter.toString(36)}`;
}

let openCounter = 0;
function bumpOpenCounter(): number {
  openCounter += 1;
  return openCounter;
}

/** Default inspector mode rotates cursor → tree → state → static, then repeats.
 *  This way the first 4 inspectors a user opens showcase all 4 live modes
 *  without having to click any pills. */
const INSPECTOR_MODE_ROTATION: InspectorMode[] = ['cursor', 'tree', 'state', 'static'];
let inspectorCounter = 0;
export function defaultInspectorMode(): InspectorMode {
  const m = INSPECTOR_MODE_ROTATION[inspectorCounter % INSPECTOR_MODE_ROTATION.length]!;
  inspectorCounter += 1;
  return m;
}

export function defaultTitle(kind: PanelKind): string {
  const n = openCounter; // already bumped by defaultPanelLayout caller
  return kind === 'note' ? `Note ${n}` : `Inspector ${n}`;
}

export function defaultBody(kind: PanelKind): string {
  if (kind === 'note') {
    return 'Click to edit. Drag the title bar to move (in float mode) or split tiles (in tile mode).';
  }
  const id = openCounter.toString(36).toUpperCase();
  return JSON.stringify(
    {
      Type: 'Selection',
      Id: `obj_${id}`,
      Name: `Element ${openCounter}`,
      Position: { x: 24, y: 56 },
      Size: { w: 320, h: 240 },
      Visible: true,
      Tags: ['draft', 'shared'],
      Modified: new Date().toISOString().slice(0, 16).replace('T', ' '),
    },
    null,
    2,
  );
}

/** Floating geometry seed — staggered positions so cascading-open looks nice. */
export function defaultFloatingGeometry(kind: PanelKind): Pick<Panel, 'x' | 'y' | 'w' | 'h'> {
  bumpOpenCounter();
  const dx = (openCounter % 6) * 28;
  const dy = (openCounter % 6) * 28;
  return kind === 'note'
    ? { x: 96 + dx, y: 96 + dy, w: 320, h: 220 }
    : { x: 540 + dx, y: 96 + dy, w: 280, h: 280 };
}

/** Make a leaf node referencing the given panel. */
export function makeLeaf(panelId: string): TileLeaf {
  return { kind: 'leaf', id: genId('node'), panelId };
}

// ─── Tree manipulation ─────────────────────────────────────────────────

/** Recursive find — returns the leaf node referencing this panel id. */
export function findLeaf(tree: TileNode | null, panelId: string): TileLeaf | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') return tree.panelId === panelId ? tree : null;
  for (const c of tree.children) {
    const r = findLeaf(c, panelId);
    if (r) return r;
  }
  return null;
}

/** Find the container that directly contains a leaf with the given panel id. */
export function findParentOf(tree: TileNode | null, panelId: string): TileContainer | null {
  if (!tree || tree.kind === 'leaf') return null;
  for (const c of tree.children) {
    if (c.kind === 'leaf' && c.panelId === panelId) return tree;
    const r = findParentOf(c, panelId);
    if (r) return r;
  }
  return null;
}

/** Find any leaf by its node id (not panel id). */
export function findLeafByNodeId(tree: TileNode | null, nodeId: string): TileLeaf | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') return tree.id === nodeId ? tree : null;
  for (const c of tree.children) {
    const r = findLeafByNodeId(c, nodeId);
    if (r) return r;
  }
  return null;
}

/** Flatten the tree into a list of panel ids (depth-first, in render order). */
export function flattenPanelIds(tree: TileNode | null): string[] {
  if (!tree) return [];
  if (tree.kind === 'leaf') return [tree.panelId];
  const out: string[] = [];
  for (const c of tree.children) out.push(...flattenPanelIds(c));
  return out;
}

/** Insert a new leaf next to `target` at the indicated edge. Returns the
 *  rewritten tree. */
export function splitAt(
  tree: TileNode,
  targetPanelId: string,
  edge: 'top' | 'right' | 'bottom' | 'left',
  newPanelId: string,
): TileNode {
  const replace = (node: TileNode): TileNode => {
    if (node.kind === 'leaf') {
      if (node.panelId !== targetPanelId) return node;
      // Build a new container of two leaves.
      const dir: 'row' | 'col' = edge === 'left' || edge === 'right' ? 'row' : 'col';
      const newLeaf = makeLeaf(newPanelId);
      const children =
        edge === 'top' || edge === 'left' ? [newLeaf, node] : [node, newLeaf];
      const container: TileContainer = {
        kind: 'container',
        id: genId('node'),
        dir,
        children,
        sizes: [50, 50],
      };
      return container;
    }
    return {
      ...node,
      children: node.children.map(replace),
    };
  };
  return replace(tree);
}

/** Remove the leaf for `panelId`. If parent has 1 child left, collapse parent
 *  into that child. If tree becomes single-leaf at root, return that. If tree
 *  becomes empty, return null. */
export function removeFromTree(tree: TileNode | null, panelId: string): TileNode | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') return tree.panelId === panelId ? null : tree;
  const newChildren: TileNode[] = [];
  const newSizes: number[] = [];
  let removed = false;
  for (let i = 0; i < tree.children.length; i++) {
    const c = tree.children[i]!;
    const reduced = removeFromTree(c, panelId);
    if (reduced === null) {
      removed = true;
      continue;
    }
    newChildren.push(reduced);
    newSizes.push(tree.sizes[i]!);
  }
  if (!removed) return tree;
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0]!;
  // Re-normalize sizes to sum 100.
  const sum = newSizes.reduce((a, b) => a + b, 0);
  const normalized = newSizes.map((s) => (s / sum) * 100);
  return { ...tree, children: newChildren, sizes: normalized };
}

/** Find container by its id. */
export function findContainer(tree: TileNode | null, containerId: string): TileContainer | null {
  if (!tree || tree.kind === 'leaf') return null;
  if (tree.id === containerId) return tree;
  for (const c of tree.children) {
    const r = findContainer(c, containerId);
    if (r) return r;
  }
  return null;
}

/** Rebuild the tree with a container's sizes replaced. */
export function setContainerSizes(
  tree: TileNode,
  containerId: string,
  sizes: number[],
): TileNode {
  const walk = (n: TileNode): TileNode => {
    if (n.kind === 'leaf') return n;
    if (n.id === containerId) return { ...n, sizes: [...sizes] };
    return { ...n, children: n.children.map(walk) };
  };
  return walk(tree);
}

/** Insert a new leaf at the right of the existing tree (used when tiling a
 *  floating panel back into the tree). */
export function appendToTreeRight(tree: TileNode | null, panelId: string): TileNode {
  const leaf = makeLeaf(panelId);
  if (!tree) return leaf;
  // Wrap in a row container with the existing tree on the left.
  return {
    kind: 'container',
    id: genId('node'),
    dir: 'row',
    children: [tree, leaf],
    sizes: [70, 30],
  };
}

/** Resolve which zone of a leaf the pointer is in. `leafRect` is the leaf's
 *  bounding box in client coords. */
export function classifyDropZone(
  px: number,
  py: number,
  leafRect: { left: number; top: number; width: number; height: number },
): 'top' | 'right' | 'bottom' | 'left' | 'center' | null {
  const x = px - leafRect.left;
  const y = py - leafRect.top;
  if (x < 0 || y < 0 || x > leafRect.width || y > leafRect.height) return null;
  const fx = x / leafRect.width;
  const fy = y / leafRect.height;
  if (fx < DROP_EDGE_FRACTION && fx < fy && fx < 1 - fy) return 'left';
  if (fx > 1 - DROP_EDGE_FRACTION && 1 - fx < fy && 1 - fx < 1 - fy) return 'right';
  if (fy < DROP_EDGE_FRACTION) return 'top';
  if (fy > 1 - DROP_EDGE_FRACTION) return 'bottom';
  return 'center';
}

/** Clamp a floating panel to viewport. */
export function clampPanelToViewport(
  panel: Panel,
  viewport: { w: number; h: number },
): Panel {
  const w = Math.min(panel.w, viewport.w);
  const h = Math.min(panel.h, viewport.h);
  return {
    ...panel,
    w, h,
    x: Math.max(0, Math.min(panel.x, viewport.w - w)),
    y: Math.max(0, Math.min(panel.y, viewport.h - h)),
  };
}

/** Snap a floating panel to viewport edges AND to other floating panels.
 *  The latter is the panel-to-panel snap the previous prototype lacked. */
export function snapFloating(
  panel: Panel,
  viewport: { w: number; h: number },
  others: readonly Panel[],
): Panel {
  let { x, y } = panel;
  // Viewport edges
  if (x < SNAP_PX) x = 0;
  if (y < SNAP_PX) y = 0;
  if (x + panel.w > viewport.w - SNAP_PX) x = viewport.w - panel.w;
  if (y + panel.h > viewport.h - SNAP_PX) y = viewport.h - panel.h;
  // Other-panel edges — check 8 candidate alignments per neighbour
  for (const o of others) {
    if (o.id === panel.id || o.mode !== 'floating') continue;
    // Vertical alignments (left/right of `panel` to left/right of `o`)
    const candidatesX = [
      o.x,                   // panel.left aligns to other.left
      o.x + o.w - panel.w,   // panel.right aligns to other.right
      o.x - panel.w,         // panel.right aligns to other.left (panel to left of other)
      o.x + o.w,             // panel.left aligns to other.right (panel to right of other)
    ];
    for (const cx of candidatesX) {
      if (Math.abs(x - cx) < SNAP_PX) { x = cx; break; }
    }
    // Horizontal alignments
    const candidatesY = [
      o.y,
      o.y + o.h - panel.h,
      o.y - panel.h,
      o.y + o.h,
    ];
    for (const cy of candidatesY) {
      if (Math.abs(y - cy) < SNAP_PX) { y = cy; break; }
    }
  }
  return { ...panel, x, y };
}

export function clampResize(
  w: number, h: number,
  origin: { x: number; y: number },
  viewport: { w: number; h: number },
): { w: number; h: number } {
  return {
    w: Math.max(MIN_PANEL.w, Math.min(w, viewport.w - origin.x)),
    h: Math.max(MIN_PANEL.h, Math.min(h, viewport.h - origin.y)),
  };
}

/** Adjust container sizes from a divider drag. `delta` is px along the split
 *  axis. */
export function resizeContainerDivider(
  startSizes: number[],
  dividerIdx: number,
  deltaPx: number,
  containerLengthPx: number,
): number[] {
  if (containerLengthPx <= 0) return startSizes;
  const deltaPct = (deltaPx / containerLengthPx) * 100;
  const next = [...startSizes];
  const a = startSizes[dividerIdx]! + deltaPct;
  const b = startSizes[dividerIdx + 1]! - deltaPct;
  const minPct = (MIN_TILE_PX / containerLengthPx) * 100;
  if (a < minPct || b < minPct) {
    // Clamp without changing
    if (a < minPct) {
      next[dividerIdx] = minPct;
      next[dividerIdx + 1] = startSizes[dividerIdx]! + startSizes[dividerIdx + 1]! - minPct;
    } else {
      next[dividerIdx + 1] = minPct;
      next[dividerIdx] = startSizes[dividerIdx]! + startSizes[dividerIdx + 1]! - minPct;
    }
    return next;
  }
  next[dividerIdx] = a;
  next[dividerIdx + 1] = b;
  return next;
}

// ─── Arrange algorithms ─────────────────────────────────────────────────

/** Rebuild the tree as a roughly-square grid of `panelIds`. */
export function buildMosaic(panelIds: string[]): TileNode | null {
  if (panelIds.length === 0) return null;
  if (panelIds.length === 1) return makeLeaf(panelIds[0]!);
  const cols = Math.ceil(Math.sqrt(panelIds.length));
  const rows: TileNode[] = [];
  for (let i = 0; i < panelIds.length; i += cols) {
    const rowPanels = panelIds.slice(i, i + cols);
    const rowChildren = rowPanels.map((id) => makeLeaf(id));
    if (rowChildren.length === 1) {
      rows.push(rowChildren[0]!);
    } else {
      rows.push({
        kind: 'container',
        id: genId('node'),
        dir: 'row',
        children: rowChildren,
        sizes: rowChildren.map(() => 100 / rowChildren.length),
      });
    }
  }
  if (rows.length === 1) return rows[0]!;
  return {
    kind: 'container',
    id: genId('node'),
    dir: 'col',
    children: rows,
    sizes: rows.map(() => 100 / rows.length),
  };
}

/** Single-row tile. */
export function buildRow(panelIds: string[]): TileNode | null {
  if (panelIds.length === 0) return null;
  if (panelIds.length === 1) return makeLeaf(panelIds[0]!);
  const children = panelIds.map((id) => makeLeaf(id));
  return {
    kind: 'container',
    id: genId('node'),
    dir: 'row',
    children,
    sizes: children.map(() => 100 / children.length),
  };
}

/** Single-column tile. */
export function buildColumn(panelIds: string[]): TileNode | null {
  if (panelIds.length === 0) return null;
  if (panelIds.length === 1) return makeLeaf(panelIds[0]!);
  const children = panelIds.map((id) => makeLeaf(id));
  return {
    kind: 'container',
    id: genId('node'),
    dir: 'col',
    children,
    sizes: children.map(() => 100 / children.length),
  };
}

/** Walk the tree and reset every container's sizes to be equal. */
export function equalizeTree(tree: TileNode | null): TileNode | null {
  if (!tree) return null;
  if (tree.kind === 'leaf') return tree;
  return {
    ...tree,
    children: tree.children.map(equalizeTree).filter((n): n is TileNode => n !== null),
    sizes: tree.children.map(() => 100 / tree.children.length),
  };
}

/** Cascade-stagger an array of floating panels (returns new geometry). */
export function cascadeFloating(
  panels: Panel[],
  viewport: { w: number; h: number },
): Panel[] {
  return panels.map((p, i) => ({
    ...p,
    x: Math.min(80 + i * 32, viewport.w - 320),
    y: Math.min(80 + i * 32, viewport.h - 220),
    w: 360,
    h: 240,
  }));
}

export const COMMAND_PALETTE_COMMANDS = [
  { id: 'open:note', label: 'Open new note', hint: '' },
  { id: 'open:inspector', label: 'Open inspector', hint: '' },
  { id: 'mode:float-focused', label: 'Float focused panel', hint: '↗' },
  { id: 'mode:tile-focused', label: 'Tile focused panel', hint: '⇲' },
  { id: 'mode:float-all', label: 'Float all panels', hint: '' },
  { id: 'mode:tile-all', label: 'Tile all panels', hint: '' },
  { id: 'arrange:cascade-floating', label: 'Arrange: cascade floating', hint: '' },
  { id: 'arrange:mosaic-tiled', label: 'Arrange: mosaic tiled', hint: '' },
  { id: 'arrange:rows', label: 'Arrange: tile as rows', hint: '' },
  { id: 'arrange:cols', label: 'Arrange: tile as columns', hint: '' },
  { id: 'arrange:equalize', label: 'Arrange: equalize tile sizes', hint: '' },
  { id: 'inspector:cursor', label: 'Inspector mode: cursor', hint: 'focused inspector only' },
  { id: 'inspector:state', label: 'Inspector mode: workspace state', hint: '' },
  { id: 'inspector:tree', label: 'Inspector mode: tile tree', hint: '' },
  { id: 'inspector:static', label: 'Inspector mode: static JSON', hint: '' },
  { id: 'close:focused', label: 'Close focused window', hint: '⌘W' },
  { id: 'workspace:reset', label: 'Reset workspace', hint: 'destructive' },
];

// ─── Snapshot lifecycle ─────────────────────────────────────────────────

export function emptySnapshot(): WorkspaceSnapshot {
  return {
    panels: {},
    tree: null,
    floatingZOrder: [],
    modals: [],
    focused: null,
    interaction: null,
    cursor: { x: 0, y: 0, overPanelId: null },
  };
}

// ─── Persistence ────────────────────────────────────────────────────────

export type PersistedLayout = {
  panels: Record<string, Panel>;
  tree: TileNode | null;
  floatingZOrder: string[];
  focused: string | null;
};

export function persistLayout(s: WorkspaceSnapshot): void {
  try {
    const layout: PersistedLayout = {
      panels: s.panels,
      tree: s.tree,
      floatingZOrder: [...s.floatingZOrder],
      focused: s.focused,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // ignore
  }
}

export function readPersistedLayout(): PersistedLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedLayout) : null;
  } catch {
    return null;
  }
}

export function clearPersistedLayout(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getViewport(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 1280, h: 800 };
  return { w: window.innerWidth, h: window.innerHeight - 56 };
}

/** Filter command list against a substring query. */
export function filterCommands<T extends { label: string }>(
  commands: readonly T[],
  query: string,
): readonly T[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.label.toLowerCase().includes(q));
}

export const INSPECTOR_MODE_LABELS: Record<InspectorMode, string> = {
  static: 'Static',
  state: 'State',
  cursor: 'Cursor',
  tree: 'Tree',
};
