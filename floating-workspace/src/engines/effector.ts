// Effector — events + a single `$workspace` store. The store `.on()`s every
// event; one reducer-on-event per concern. Pointer-move throttle and persist
// debounce are hand-rolled (patronum intentionally excluded for apples-to-
// apples comparison).

import { createEvent, createStore } from 'effector';
import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS, MAX_PANELS, PERSIST_DEBOUNCE_MS, POINTER_THROTTLE_MS,
  appendToTreeRight, buildColumn, buildMosaic, buildRow, cascadeFloating,
  clampPanelToViewport, clampResize, clearPersistedLayout, defaultBody,
  defaultFloatingGeometry, defaultInspectorMode, defaultTitle, emptySnapshot, equalizeTree, findContainer,
  findLeaf, flattenPanelIds, genId, getViewport, persistLayout, readPersistedLayout,
  removeFromTree, resizeContainerDivider, setContainerSizes, snapFloating, splitAt,
} from '../scenario';
import type {
  InspectorMode, ModalSpec, Panel, PanelKind, Unsubscribe, WorkspaceSnapshot,
} from '../types';

type WS = WorkspaceSnapshot;

export const effectorFactory: EngineFactory = {
  meta: {
    id: 'effector',
    label: 'Effector',
    description: 'Events + one $workspace store; hand-rolled throttle + debounce.',
    sourcePath: 'floating-workspace/src/engines/effector.ts',
  },
  create(): Engine {
    const pendingResolvers = new Map<string, (r: unknown) => void>();
    const openResolvers = new Map<number, (id: string | null) => void>();
    let openReqIdCounter = 0;
    let lastMoveTime = 0;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    // ─── events ──────────────────────────────────────────────────────
    const openPanelEv = createEvent<{ kind: PanelKind; opts?: { title?: string; body?: string; mode?: 'tiled' | 'floating' }; reqId: number }>();
    const openModalEv = createEvent<{ spec: ModalSpec }>();
    const closeEv = createEvent<{ id: string; result?: unknown }>();
    const focusEv = createEvent<{ id: string }>();
    const setQueryEv = createEvent<{ q: string }>();
    const setBodyEv = createEvent<{ id: string; body: string }>();
    const setInspectorModeEv = createEvent<{ id: string; mode: InspectorMode }>();
    const setPanelModeEv = createEvent<{ id: string; mode: 'tiled' | 'floating' }>();
    const splitTileEv = createEvent<{ srcId: string; targetId: string; edge: 'top' | 'right' | 'bottom' | 'left' }>();
    const arrangeCascadeFloatingEv = createEvent();
    const arrangeMosaicTiledEv = createEvent();
    const arrangeRowsEv = createEvent();
    const arrangeColumnsEv = createEvent();
    const arrangeEqualizeTilesEv = createEvent();
    const setAllPanelsModeEv = createEvent<{ mode: 'tiled' | 'floating' }>();
    const startFloatingDragEv = createEvent<{ id: string; px: number; py: number }>();
    const startTileDragEv = createEvent<{ id: string }>();
    const startFloatingResizeEv = createEvent<{ id: string; px: number; py: number }>();
    const startDividerResizeEv = createEvent<{ containerId: string; dividerIdx: number; px: number; py: number; containerLengthPx: number }>();
    const applyMoveEv = createEvent<{ px: number; py: number }>();
    const setTileDropTargetEv = createEvent<{ leafId: string | null; zone: 'top' | 'right' | 'bottom' | 'left' | 'center' | null }>();
    const pointerUpEv = createEvent();
    const setCursorEv = createEvent<{ x: number; y: number; overPanelId: string | null }>();
    const resetEv = createEvent();
    const loadLayoutEv = createEvent();

    const moveFloatingTop = (s: WS, id: string): WS => ({
      ...s,
      floatingZOrder: [...s.floatingZOrder.filter((x) => x !== id), id],
      focused: id,
    });

    // ─── store ───────────────────────────────────────────────────────
    const $workspace = createStore<WS>(emptySnapshot())
      .on(openPanelEv, (s, p) => {
        const resolver = openResolvers.get(p.reqId);
        openResolvers.delete(p.reqId);
        if (Object.keys(s.panels).length >= MAX_PANELS) { resolver?.(null); return s; }
        const id = genId('panel');
        const mode = p.opts?.mode ?? 'tiled';
        const panel: Panel = {
          id, kind: p.kind,
          title: p.opts?.title ?? defaultTitle(p.kind),
          body: p.opts?.body ?? defaultBody(p.kind),
          mode,
          ...defaultFloatingGeometry(p.kind),
          ...(p.kind === 'inspector' ? { inspectorMode: defaultInspectorMode() } : {}),
        };
        resolver?.(id);
        const panels = { ...s.panels, [id]: panel };
        if (mode === 'tiled') return { ...s, panels, tree: appendToTreeRight(s.tree, id), focused: id };
        return { ...s, panels, floatingZOrder: [...s.floatingZOrder, id], focused: id };
      })
      .on(openModalEv, (s, p) => ({ ...s, modals: [...s.modals, p.spec] }))
      .on(closeEv, (s, p) => {
        if (s.modals.some((m) => m.id === p.id)) {
          const r = pendingResolvers.get(p.id); pendingResolvers.delete(p.id);
          const next = { ...s, modals: s.modals.filter((m) => m.id !== p.id) };
          r?.(p.result);
          return next;
        }
        if (!s.panels[p.id]) return s;
        const { [p.id]: _drop, ...rest } = s.panels; void _drop;
        const tree = removeFromTree(s.tree, p.id);
        const floatingZOrder = s.floatingZOrder.filter((x) => x !== p.id);
        const focused = s.focused === p.id ? (floatingZOrder[floatingZOrder.length - 1] ?? null) : s.focused;
        return { ...s, panels: rest, tree, floatingZOrder, focused };
      })
      .on(focusEv, (s, p) => {
        const panel = s.panels[p.id]; if (!panel) return s;
        return panel.mode === 'floating' ? moveFloatingTop(s, p.id) : { ...s, focused: p.id };
      })
      .on(setQueryEv, (s, p) => {
        const top = s.modals[s.modals.length - 1];
        if (top?.kind !== 'command-palette') return s;
        return { ...s, modals: [...s.modals.slice(0, -1), { ...top, query: p.q }] };
      })
      .on(setBodyEv, (s, p) => {
        const panel = s.panels[p.id]; if (!panel) return s;
        return { ...s, panels: { ...s.panels, [p.id]: { ...panel, body: p.body } } };
      })
      .on(setInspectorModeEv, (s, p) => {
        const panel = s.panels[p.id]; if (!panel || panel.kind !== 'inspector') return s;
        return { ...s, panels: { ...s.panels, [p.id]: { ...panel, inspectorMode: p.mode } } };
      })
      .on(setPanelModeEv, (s, p) => {
        const panel = s.panels[p.id]; if (!panel || panel.mode === p.mode) return s;
        if (p.mode === 'floating') {
          const updated: Panel = { ...panel, mode: 'floating', x: panel.x || 120, y: panel.y || 120, w: panel.w || 360, h: panel.h || 240 };
          return {
            ...s,
            panels: { ...s.panels, [p.id]: updated },
            tree: removeFromTree(s.tree, p.id),
            floatingZOrder: [...s.floatingZOrder, p.id],
            focused: p.id,
          };
        }
        return {
          ...s,
          panels: { ...s.panels, [p.id]: { ...panel, mode: 'tiled' } },
          tree: appendToTreeRight(s.tree, p.id),
          floatingZOrder: s.floatingZOrder.filter((x) => x !== p.id),
          focused: p.id,
        };
      })
      .on(splitTileEv, (s, p) => {
        const src = s.panels[p.srcId]; if (!src) return s;
        if (!findLeaf(s.tree, p.targetId) || p.srcId === p.targetId) return s;
        let tree = src.mode === 'tiled' ? removeFromTree(s.tree, p.srcId) : s.tree;
        let floatingZOrder = s.floatingZOrder;
        if (src.mode === 'floating') floatingZOrder = floatingZOrder.filter((x) => x !== p.srcId);
        if (!tree) tree = removeFromTree(s.tree, p.srcId);
        tree = splitAt(tree!, p.targetId, p.edge, p.srcId);
        return {
          ...s,
          panels: { ...s.panels, [p.srcId]: { ...src, mode: 'tiled' } },
          tree, floatingZOrder, focused: p.srcId, interaction: null,
        };
      })
      .on(arrangeCascadeFloatingEv, (s) => {
        const fpanels = s.floatingZOrder.map((id) => s.panels[id]).filter((x): x is Panel => !!x);
        if (fpanels.length === 0) return s;
        const next = cascadeFloating(fpanels, getViewport());
        const panels = { ...s.panels };
        for (const p of next) panels[p.id] = p;
        return { ...s, panels };
      })
      .on(arrangeMosaicTiledEv, (s) => ({ ...s, tree: buildMosaic(flattenPanelIds(s.tree)) }))
      .on(arrangeRowsEv, (s) => ({ ...s, tree: buildRow(flattenPanelIds(s.tree)) }))
      .on(arrangeColumnsEv, (s) => ({ ...s, tree: buildColumn(flattenPanelIds(s.tree)) }))
      .on(arrangeEqualizeTilesEv, (s) => ({ ...s, tree: equalizeTree(s.tree) }))
      .on(setAllPanelsModeEv, (s, p) => {
        const allIds = Object.keys(s.panels);
        const panels = { ...s.panels };
        for (const id of allIds) panels[id] = { ...panels[id]!, mode: p.mode };
        if (p.mode === 'floating') return { ...s, panels, tree: null, floatingZOrder: allIds };
        return { ...s, panels, tree: buildMosaic(allIds), floatingZOrder: [] };
      })
      .on(startFloatingDragEv, (s, p) => {
        const panel = s.panels[p.id]; if (!panel || panel.mode !== 'floating') return s;
        const moved = moveFloatingTop(s, p.id);
        return { ...moved, interaction: { kind: 'drag-floating', id: p.id, offset: { x: p.px - panel.x, y: p.py - panel.y } } };
      })
      .on(startTileDragEv, (s, p) => {
        const panel = s.panels[p.id]; if (!panel || panel.mode !== 'tiled') return s;
        return { ...s, interaction: { kind: 'drag-tiled', id: p.id, targetLeafId: null, targetZone: null } };
      })
      .on(startFloatingResizeEv, (s, p) => {
        const panel = s.panels[p.id]; if (!panel || panel.mode !== 'floating') return s;
        const moved = moveFloatingTop(s, p.id);
        return { ...moved, interaction: { kind: 'resize-floating', id: p.id, startSize: { w: panel.w, h: panel.h }, startPointer: { x: p.px, y: p.py } } };
      })
      .on(startDividerResizeEv, (s, p) => {
        const c = findContainer(s.tree, p.containerId); if (!c) return s;
        return {
          ...s,
          interaction: {
            kind: 'divider-resize', containerId: p.containerId, dividerIdx: p.dividerIdx,
            startSizes: [...c.sizes], startPointer: c.dir === 'row' ? p.px : p.py,
            containerLength: p.containerLengthPx,
          },
        };
      })
      .on(applyMoveEv, (s, p) => {
        const inter = s.interaction; if (!inter) return s;
        const viewport = getViewport();
        if (inter.kind === 'drag-floating') {
          const panel = s.panels[inter.id]; if (!panel) return s;
          const moved = { ...panel, x: p.px - inter.offset.x, y: p.py - inter.offset.y };
          const clamped = clampPanelToViewport(moved, viewport);
          const others = Object.values(s.panels).filter((x) => x.id !== inter.id && x.mode === 'floating');
          const snapped = snapFloating(clamped, viewport, others);
          return { ...s, panels: { ...s.panels, [inter.id]: snapped } };
        }
        if (inter.kind === 'resize-floating') {
          const panel = s.panels[inter.id]; if (!panel) return s;
          const dx = p.px - inter.startPointer.x;
          const dy = p.py - inter.startPointer.y;
          const sized = clampResize(inter.startSize.w + dx, inter.startSize.h + dy, { x: panel.x, y: panel.y }, viewport);
          return { ...s, panels: { ...s.panels, [inter.id]: { ...panel, ...sized } } };
        }
        if (inter.kind === 'divider-resize') {
          const c = findContainer(s.tree, inter.containerId); if (!c) return s;
          const delta = (c.dir === 'row' ? p.px : p.py) - inter.startPointer;
          const next = resizeContainerDivider(inter.startSizes, inter.dividerIdx, delta, inter.containerLength);
          return { ...s, tree: setContainerSizes(s.tree!, inter.containerId, next) };
        }
        return s;
      })
      .on(setTileDropTargetEv, (s, p) => {
        const inter = s.interaction;
        if (inter?.kind !== 'drag-tiled') return s;
        if (inter.targetLeafId === p.leafId && inter.targetZone === p.zone) return s;
        return { ...s, interaction: { ...inter, targetLeafId: p.leafId, targetZone: p.zone } };
      })
      .on(pointerUpEv, (s) => ({ ...s, interaction: null }))
      .on(setCursorEv, (s, p) => {
        if (s.cursor.x === p.x && s.cursor.y === p.y && s.cursor.overPanelId === p.overPanelId) return s;
        return { ...s, cursor: { x: p.x, y: p.y, overPanelId: p.overPanelId } };
      })
      .on(resetEv, () => emptySnapshot())
      .on(loadLayoutEv, (s) => {
        const layout = readPersistedLayout();
        if (!layout) return s;
        const validIds = new Set(Object.keys(layout.panels));
        return {
          ...emptySnapshot(),
          panels: layout.panels,
          tree: layout.tree,
          floatingZOrder: layout.floatingZOrder.filter((id) => validIds.has(id)),
          focused: validIds.has(layout.focused ?? '') ? layout.focused : null,
        };
      });

    // ─── side-effects ────────────────────────────────────────────────
    const schedulePersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistLayout($workspace.getState());
      }, PERSIST_DEBOUNCE_MS);
    };
    $workspace.updates.watch(() => schedulePersist());
    resetEv.watch(() => clearPersistedLayout());

    const subs = new Set<(s: WS) => void>();
    const unwatch = $workspace.watch((s) => { for (const cb of subs) cb(s); });

    // ─── splitTile helper for pointerUp ──────────────────────────────
    const findByNode = (t: WS['tree'], nid: string): string | null => {
      if (!t) return null;
      if (t.kind === 'leaf') return t.id === nid ? t.panelId : null;
      for (const c of t.children) { const r = findByNode(c, nid); if (r) return r; }
      return null;
    };

    const engine: Engine = {
      snapshot: () => $workspace.getState(),
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },
      openPanel(kind, opts) {
        const reqId = ++openReqIdCounter;
        let id: string | null = null;
        openResolvers.set(reqId, (x) => { id = x; });
        openPanelEv({ kind, opts, reqId });
        return id;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, () => resolve());
          openModalEv({ spec: { kind: 'alert', id, title, body } });
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(Boolean(r)));
          openModalEv({ spec: { kind: 'confirm', id, title, body } });
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          openModalEv({ spec: { kind: 'command-palette', id, query: '', commands } });
        });
      },
      close: (id, result) => closeEv({ id, result }),
      focus: (id) => focusEv({ id }),
      setBody: (id, body) => setBodyEv({ id, body }),
      setInspectorMode: (id, mode) => setInspectorModeEv({ id, mode }),
      setQuery: (q) => setQueryEv({ q }),
      setPanelMode: (id, mode) => setPanelModeEv({ id, mode }),
      splitTile: (srcId, targetId, edge) => splitTileEv({ srcId, targetId, edge }),
      arrangeCascadeFloating: () => arrangeCascadeFloatingEv(),
      arrangeMosaicTiled: () => arrangeMosaicTiledEv(),
      arrangeRows: () => arrangeRowsEv(),
      arrangeColumns: () => arrangeColumnsEv(),
      arrangeEqualizeTiles: () => arrangeEqualizeTilesEv(),
      setAllPanelsMode: (mode) => setAllPanelsModeEv({ mode }),
      startFloatingDrag: (id, px, py) => startFloatingDragEv({ id, px, py }),
      startTileDrag: (id) => startTileDragEv({ id }),
      startFloatingResize: (id, px, py) => startFloatingResizeEv({ id, px, py }),
      startDividerResize: (containerId, dividerIdx, px, py, containerLengthPx) =>
        startDividerResizeEv({ containerId, dividerIdx, px, py, containerLengthPx }),
      pointerMove(px, py) {
        const s = $workspace.getState();
        if (!s.interaction) return;
        const now = performance.now();
        if (now - lastMoveTime < POINTER_THROTTLE_MS) return;
        lastMoveTime = now;
        applyMoveEv({ px, py });
      },
      setTileDropTarget: (leafId, zone) => setTileDropTargetEv({ leafId, zone }),
      pointerUp() {
        const s = $workspace.getState();
        const inter = s.interaction;
        if (!inter) return;
        if (inter.kind === 'drag-tiled' && inter.targetLeafId && inter.targetZone) {
          const targetPanelId = findByNode(s.tree, inter.targetLeafId);
          if (targetPanelId && targetPanelId !== inter.id) {
            const edge = inter.targetZone === 'center' ? 'right' : inter.targetZone;
            splitTileEv({ srcId: inter.id, targetId: targetPanelId, edge });
            return;
          }
        }
        pointerUpEv();
      },
      setCursor: (x, y, overPanelId) => setCursorEv({ x, y, overPanelId }),
      onKey({ key, meta, ctrl }) {
        const mod = meta || ctrl;
        const s = $workspace.getState();
        if (mod && (key === 'k' || key === 'K')) { this.openCommandPalette(COMMAND_PALETTE_COMMANDS); return true; }
        if (key === 'Escape') {
          const top = s.modals[s.modals.length - 1];
          if (top) { this.close(top.id, top.kind === 'confirm' ? false : top.kind === 'command-palette' ? null : undefined); return true; }
          if (s.focused) { this.close(s.focused); return true; }
          return false;
        }
        if (mod && (key === 'w' || key === 'W') && s.modals.length === 0 && s.focused) { this.close(s.focused); return true; }
        return false;
      },
      loadLayout: () => loadLayoutEv(),
      reset() {
        for (const [, r] of pendingResolvers) r(undefined);
        pendingResolvers.clear();
        resetEv();
      },
      dispose() {
        unwatch();
        if (persistTimer) clearTimeout(persistTimer);
        subs.clear();
        pendingResolvers.clear();
      },
    };
    return engine;
  },
};
