// Shared Redux Toolkit slice for the three redux engines (thunk / listener /
// saga). The slice is identical — the engines only differ in how they wire
// side-effects (pointer-move throttle, persist debounce, splitTile on
// pointer-up).

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  appendToTreeRight, buildColumn, buildMosaic, buildRow, cascadeFloating,
  clampPanelToViewport, clampResize, defaultBody, defaultFloatingGeometry,
  defaultTitle, emptySnapshot, equalizeTree, findContainer, findLeaf,
  flattenPanelIds, genId, getViewport, removeFromTree, resizeContainerDivider,
  setContainerSizes, snapFloating, splitAt,
} from '../scenario';
import type {
  InspectorMode, ModalSpec, Panel, PanelKind, WorkspaceSnapshot,
} from '../types';

export type WS = WorkspaceSnapshot;

export type OpenPanelPayload = {
  kind: PanelKind;
  opts?: { title?: string; body?: string; mode?: 'tiled' | 'floating' };
  reqId: number;
};

// Resolvers live outside the store (Maps with side effects don't belong in
// serialisable state). The slice merely emits panel ids via an out-of-band
// `openPanelResults` field that the engine wrapper drains.
export const slice = createSlice({
  name: 'ws',
  initialState: emptySnapshot() as WS,
  reducers: {
    openPanel(s, a: PayloadAction<OpenPanelPayload & { id: string | null }>) {
      if (!a.payload.id) return;
      const id = a.payload.id;
      const mode = a.payload.opts?.mode ?? 'tiled';
      const geo = defaultFloatingGeometry(a.payload.kind);
      const panel: Panel = {
        id, kind: a.payload.kind,
        title: a.payload.opts?.title ?? defaultTitle(a.payload.kind),
        body: a.payload.opts?.body ?? defaultBody(a.payload.kind),
        mode,
        x: geo.x, y: geo.y, w: geo.w, h: geo.h,
        ...(a.payload.kind === 'inspector' ? { inspectorMode: 'static' as InspectorMode } : {}),
      };
      s.panels[id] = panel;
      if (mode === 'tiled') {
        s.tree = appendToTreeRight(s.tree, id);
      } else {
        s.floatingZOrder.push(id);
      }
      s.focused = id;
    },
    openModal(s, a: PayloadAction<ModalSpec>) { s.modals.push(a.payload); },
    closeWindow(s, a: PayloadAction<string>) {
      const id = a.payload;
      if (s.modals.some((m) => m.id === id)) {
        s.modals = s.modals.filter((m) => m.id !== id);
        return;
      }
      if (!s.panels[id]) return;
      delete s.panels[id];
      s.tree = removeFromTree(s.tree, id);
      s.floatingZOrder = s.floatingZOrder.filter((x) => x !== id);
      if (s.focused === id) s.focused = s.floatingZOrder[s.floatingZOrder.length - 1] ?? null;
    },
    focusPanel(s, a: PayloadAction<string>) {
      const panel = s.panels[a.payload]; if (!panel) return;
      if (panel.mode === 'floating') {
        s.floatingZOrder = [...s.floatingZOrder.filter((x) => x !== a.payload), a.payload];
      }
      s.focused = a.payload;
    },
    setQuery(s, a: PayloadAction<string>) {
      const top = s.modals[s.modals.length - 1];
      if (top?.kind === 'command-palette') top.query = a.payload;
    },
    setBody(s, a: PayloadAction<{ id: string; body: string }>) {
      const p = s.panels[a.payload.id]; if (!p) return;
      p.body = a.payload.body;
    },
    setInspectorMode(s, a: PayloadAction<{ id: string; mode: InspectorMode }>) {
      const p = s.panels[a.payload.id]; if (!p || p.kind !== 'inspector') return;
      p.inspectorMode = a.payload.mode;
    },
    setPanelMode(s, a: PayloadAction<{ id: string; mode: 'tiled' | 'floating' }>) {
      const p = s.panels[a.payload.id]; if (!p || p.mode === a.payload.mode) return;
      if (a.payload.mode === 'floating') {
        p.mode = 'floating';
        p.x = p.x || 120; p.y = p.y || 120; p.w = p.w || 360; p.h = p.h || 240;
        s.tree = removeFromTree(s.tree, a.payload.id);
        s.floatingZOrder.push(a.payload.id);
      } else {
        p.mode = 'tiled';
        s.tree = appendToTreeRight(s.tree, a.payload.id);
        s.floatingZOrder = s.floatingZOrder.filter((x) => x !== a.payload.id);
      }
      s.focused = a.payload.id;
    },
    splitTile(s, a: PayloadAction<{ srcId: string; targetId: string; edge: 'top' | 'right' | 'bottom' | 'left' }>) {
      const src = s.panels[a.payload.srcId]; if (!src) return;
      if (!findLeaf(s.tree, a.payload.targetId) || a.payload.srcId === a.payload.targetId) return;
      let tree = src.mode === 'tiled' ? removeFromTree(s.tree, a.payload.srcId) : s.tree;
      if (src.mode === 'floating') {
        s.floatingZOrder = s.floatingZOrder.filter((x) => x !== a.payload.srcId);
      }
      if (!tree) tree = removeFromTree(s.tree, a.payload.srcId);
      tree = splitAt(tree!, a.payload.targetId, a.payload.edge, a.payload.srcId);
      s.tree = tree;
      src.mode = 'tiled';
      s.focused = a.payload.srcId;
      s.interaction = null;
    },
    arrangeCascadeFloating(s) {
      const fpanels = s.floatingZOrder
        .map((id) => s.panels[id])
        .filter((p): p is Panel => !!p);
      if (fpanels.length === 0) return;
      const next = cascadeFloating(fpanels, getViewport());
      for (const p of next) s.panels[p.id] = p;
    },
    arrangeMosaicTiled(s) { s.tree = buildMosaic(flattenPanelIds(s.tree)); },
    arrangeRows(s) { s.tree = buildRow(flattenPanelIds(s.tree)); },
    arrangeColumns(s) { s.tree = buildColumn(flattenPanelIds(s.tree)); },
    arrangeEqualizeTiles(s) { s.tree = equalizeTree(s.tree); },
    setAllPanelsMode(s, a: PayloadAction<'tiled' | 'floating'>) {
      const allIds = Object.keys(s.panels);
      for (const id of allIds) s.panels[id]!.mode = a.payload;
      if (a.payload === 'floating') {
        s.tree = null;
        s.floatingZOrder = allIds;
      } else {
        s.tree = buildMosaic(allIds);
        s.floatingZOrder = [];
      }
    },
    startFloatingDrag(s, a: PayloadAction<{ id: string; px: number; py: number }>) {
      const p = s.panels[a.payload.id]; if (!p || p.mode !== 'floating') return;
      s.floatingZOrder = [...s.floatingZOrder.filter((x) => x !== a.payload.id), a.payload.id];
      s.focused = a.payload.id;
      s.interaction = { kind: 'drag-floating', id: a.payload.id, offset: { x: a.payload.px - p.x, y: a.payload.py - p.y } };
    },
    startTileDrag(s, a: PayloadAction<string>) {
      const p = s.panels[a.payload]; if (!p || p.mode !== 'tiled') return;
      s.interaction = { kind: 'drag-tiled', id: a.payload, targetLeafId: null, targetZone: null };
    },
    startFloatingResize(s, a: PayloadAction<{ id: string; px: number; py: number }>) {
      const p = s.panels[a.payload.id]; if (!p || p.mode !== 'floating') return;
      s.floatingZOrder = [...s.floatingZOrder.filter((x) => x !== a.payload.id), a.payload.id];
      s.focused = a.payload.id;
      s.interaction = { kind: 'resize-floating', id: a.payload.id, startSize: { w: p.w, h: p.h }, startPointer: { x: a.payload.px, y: a.payload.py } };
    },
    startDividerResize(s, a: PayloadAction<{ containerId: string; dividerIdx: number; px: number; py: number; containerLengthPx: number }>) {
      const c = findContainer(s.tree, a.payload.containerId); if (!c) return;
      s.interaction = {
        kind: 'divider-resize', containerId: a.payload.containerId, dividerIdx: a.payload.dividerIdx,
        startSizes: [...c.sizes], startPointer: c.dir === 'row' ? a.payload.px : a.payload.py,
        containerLength: a.payload.containerLengthPx,
      };
    },
    applyMove(s, a: PayloadAction<{ px: number; py: number }>) {
      const inter = s.interaction; if (!inter) return;
      const viewport = getViewport();
      if (inter.kind === 'drag-floating') {
        const p = s.panels[inter.id]; if (!p) return;
        const moved = { ...p, x: a.payload.px - inter.offset.x, y: a.payload.py - inter.offset.y };
        const clamped = clampPanelToViewport(moved, viewport);
        const others = Object.values(s.panels).filter((x) => x.id !== inter.id && x.mode === 'floating');
        const snapped = snapFloating(clamped, viewport, others);
        s.panels[inter.id] = snapped;
        return;
      }
      if (inter.kind === 'resize-floating') {
        const p = s.panels[inter.id]; if (!p) return;
        const dx = a.payload.px - inter.startPointer.x;
        const dy = a.payload.py - inter.startPointer.y;
        const sized = clampResize(inter.startSize.w + dx, inter.startSize.h + dy, { x: p.x, y: p.y }, viewport);
        Object.assign(p, sized);
        return;
      }
      if (inter.kind === 'divider-resize') {
        const c = findContainer(s.tree, inter.containerId); if (!c) return;
        const delta = (c.dir === 'row' ? a.payload.px : a.payload.py) - inter.startPointer;
        const next = resizeContainerDivider(inter.startSizes, inter.dividerIdx, delta, inter.containerLength);
        s.tree = setContainerSizes(s.tree!, inter.containerId, next);
      }
    },
    setTileDropTarget(s, a: PayloadAction<{ leafId: string | null; zone: 'top' | 'right' | 'bottom' | 'left' | 'center' | null }>) {
      const inter = s.interaction;
      if (inter?.kind !== 'drag-tiled') return;
      if (inter.targetLeafId === a.payload.leafId && inter.targetZone === a.payload.zone) return;
      s.interaction = { ...inter, targetLeafId: a.payload.leafId, targetZone: a.payload.zone };
    },
    pointerUp(s) { s.interaction = null; },
    setCursor(s, a: PayloadAction<{ x: number; y: number; overPanelId: string | null }>) {
      if (s.cursor.x === a.payload.x && s.cursor.y === a.payload.y && s.cursor.overPanelId === a.payload.overPanelId) return;
      s.cursor = a.payload;
    },
    reset() { return emptySnapshot(); },
    hydrate(_s, a: PayloadAction<WS>) { return a.payload; },
  },
});

export const wsActions = slice.actions;

// Helper to allocate a new panel id outside the reducer (since reducer must
// be pure; the engine wrapper generates the id and passes it in).
export function nextPanelId(state: WS): string | null {
  if (Object.keys(state.panels).length >= /* MAX_PANELS */ 8) return null;
  return genId('panel');
}

export function findByNode(t: WS['tree'], nid: string): string | null {
  if (!t) return null;
  if (t.kind === 'leaf') return t.id === nid ? t.panelId : null;
  for (const c of t.children) { const r = findByNode(c, nid); if (r) return r; }
  return null;
}
