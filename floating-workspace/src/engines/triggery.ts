// Triggery — single `workspace` trigger dispatches a tagged action via a
// lookup table (built once per instance, not per event). Tree manipulation,
// arrange algorithms, snap and clamp logic — all imported from scenario.ts;
// the engine is the orchestration layer. `actions.throttle(16).move` does
// the pointer-move debounce in one declarative line. State is a closure
// (a tree is a tree, not a graph of stores).

import { createRuntime, createTrigger } from '@triggery/core';
import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS, MAX_PANELS, PERSIST_DEBOUNCE_MS, POINTER_THROTTLE_MS,
  appendToTreeRight, buildColumn, buildMosaic, buildRow, cascadeFloating,
  clampPanelToViewport, clampResize, clearPersistedLayout, defaultBody,
  defaultFloatingGeometry, defaultTitle, emptySnapshot, equalizeTree, findContainer,
  findLeaf, flattenPanelIds, genId, getViewport, persistLayout, readPersistedLayout,
  removeFromTree, resizeContainerDivider, setContainerSizes, snapFloating, splitAt,
} from '../scenario';
import type {
  InspectorMode, ModalSpec, Panel, PanelKind, Unsubscribe, WorkspaceSnapshot,
} from '../types';

type WS = WorkspaceSnapshot;

export const triggeryFactory: EngineFactory = {
  meta: {
    id: 'triggery',
    label: 'Triggery',
    description: 'Single trigger + dispatch table; actions.throttle(16) + actions.debounce(1000).',
    sourcePath: 'floating-workspace/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });
    let state: WS = emptySnapshot();
    const subs = new Set<(s: WS) => void>();
    const pendingResolvers = new Map<string, (r: unknown) => void>();

    const emit = () => { for (const cb of subs) cb(state); };
    const set = (next: WS) => { state = next; emit(); };
    const patch = (p: Partial<WS>) => set({ ...state, ...p });

    type Schema = {
      events: {
        mutate: { fn: (s: WS) => WS };
        'pointer-move': { px: number; py: number };
      };
      actions: {
        'apply-move': { px: number; py: number };
        persist: WS;
        snapshot: WS;
      };
    };

    createTrigger<Schema>({
      id: 'workspace',
      events: ['mutate', 'pointer-move'],
      schedule: 'sync',
      handler: ({ event, actions }) => {
        if (event.name === 'pointer-move') {
          actions.throttle(POINTER_THROTTLE_MS)['apply-move']?.(event.payload);
          return;
        }
        // mutate
        state = event.payload.fn(state);
        actions.snapshot?.(state);
        actions.debounce(PERSIST_DEBOUNCE_MS).persist?.(state);
      },
    }, runtime);

    runtime.subscribeAction('workspace', 'apply-move', (raw) => {
      const { px, py } = raw as { px: number; py: number };
      const inter = state.interaction;
      if (!inter) return;
      const viewport = getViewport();
      if (inter.kind === 'drag-floating') {
        const panel = state.panels[inter.id];
        if (!panel) return;
        const moved = { ...panel, x: px - inter.offset.x, y: py - inter.offset.y };
        const clamped = clampPanelToViewport(moved, viewport);
        const others = Object.values(state.panels).filter((p) => p.id !== inter.id && p.mode === 'floating');
        const snapped = snapFloating(clamped, viewport, others);
        set({ ...state, panels: { ...state.panels, [inter.id]: snapped } });
      } else if (inter.kind === 'resize-floating') {
        const panel = state.panels[inter.id];
        if (!panel) return;
        const dx = px - inter.startPointer.x;
        const dy = py - inter.startPointer.y;
        const sized = clampResize(inter.startSize.w + dx, inter.startSize.h + dy, { x: panel.x, y: panel.y }, viewport);
        set({ ...state, panels: { ...state.panels, [inter.id]: { ...panel, ...sized } } });
      } else if (inter.kind === 'divider-resize') {
        const container = findContainer(state.tree, inter.containerId);
        if (!container) return;
        const delta = (container.dir === 'row' ? px : py) - inter.startPointer;
        const next = resizeContainerDivider(inter.startSizes, inter.dividerIdx, delta, inter.containerLength);
        set({ ...state, tree: setContainerSizes(state.tree!, inter.containerId, next) });
      }
    });
    runtime.subscribeAction('workspace', 'persist', (s) => persistLayout(s as WS));
    runtime.subscribeAction('workspace', 'snapshot', (s) => {
      for (const cb of subs) cb(s as WS);
    });

    const mutate = (fn: (s: WS) => WS) => runtime.fire('mutate', { fn });

    // ─── reducer helpers ─────────────────────────────────────────────
    const total = (s: WS) => Object.keys(s.panels).length;
    const moveFloatingTop = (s: WS, id: string): WS => ({
      ...s,
      floatingZOrder: [...s.floatingZOrder.filter((x) => x !== id), id],
      focused: id,
    });
    const pushModal = (s: WS, spec: ModalSpec): WS => ({ ...s, modals: [...s.modals, spec] });

    return {
      snapshot: () => state,
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },

      openPanel(kind: PanelKind, opts) {
        if (total(state) >= MAX_PANELS) return null;
        const id = genId('panel');
        const mode = opts?.mode ?? 'tiled';
        const panel: Panel = {
          id, kind,
          title: opts?.title ?? defaultTitle(kind),
          body: opts?.body ?? defaultBody(kind),
          mode,
          ...defaultFloatingGeometry(kind),
          ...(kind === 'inspector' ? { inspectorMode: 'static' as InspectorMode } : {}),
        };
        mutate((s) => {
          const panels = { ...s.panels, [id]: panel };
          if (mode === 'tiled') {
            return { ...s, panels, tree: appendToTreeRight(s.tree, id), focused: id };
          }
          return { ...s, panels, floatingZOrder: [...s.floatingZOrder, id], focused: id };
        });
        return id;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, () => resolve());
          mutate((s) => pushModal(s, { kind: 'alert', id, title, body }));
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(Boolean(r)));
          mutate((s) => pushModal(s, { kind: 'confirm', id, title, body }));
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          mutate((s) => pushModal(s, { kind: 'command-palette', id, query: '', commands }));
        });
      },
      close(id, result) {
        if (state.modals.some((m) => m.id === id)) {
          const r = pendingResolvers.get(id); pendingResolvers.delete(id);
          mutate((s) => ({ ...s, modals: s.modals.filter((m) => m.id !== id) }));
          r?.(result);
          return;
        }
        mutate((s) => {
          if (!s.panels[id]) return s;
          const { [id]: _drop, ...rest } = s.panels; void _drop;
          const tree = removeFromTree(s.tree, id);
          const floatingZOrder = s.floatingZOrder.filter((x) => x !== id);
          const focused = s.focused === id ? (floatingZOrder[floatingZOrder.length - 1] ?? null) : s.focused;
          return { ...s, panels: rest, tree, floatingZOrder, focused };
        });
      },
      focus(id) {
        mutate((s) => {
          const p = s.panels[id]; if (!p) return s;
          return p.mode === 'floating' ? moveFloatingTop(s, id) : { ...s, focused: id };
        });
      },
      setBody(id, body) {
        mutate((s) => {
          const p = s.panels[id]; if (!p) return s;
          return { ...s, panels: { ...s.panels, [id]: { ...p, body } } };
        });
      },
      setInspectorMode(id, mode) {
        mutate((s) => {
          const p = s.panels[id]; if (!p || p.kind !== 'inspector') return s;
          return { ...s, panels: { ...s.panels, [id]: { ...p, inspectorMode: mode } } };
        });
      },
      setQuery(q) {
        mutate((s) => {
          const top = s.modals[s.modals.length - 1];
          if (top?.kind !== 'command-palette') return s;
          return { ...s, modals: [...s.modals.slice(0, -1), { ...top, query: q }] };
        });
      },
      setPanelMode(id, mode) {
        mutate((s) => {
          const p = s.panels[id]; if (!p || p.mode === mode) return s;
          if (mode === 'floating') {
            return {
              ...s,
              panels: { ...s.panels, [id]: { ...p, mode: 'floating', x: p.x || 120, y: p.y || 120, w: p.w || 360, h: p.h || 240 } },
              tree: removeFromTree(s.tree, id),
              floatingZOrder: [...s.floatingZOrder, id],
              focused: id,
            };
          }
          return {
            ...s,
            panels: { ...s.panels, [id]: { ...p, mode: 'tiled' } },
            tree: appendToTreeRight(s.tree, id),
            floatingZOrder: s.floatingZOrder.filter((x) => x !== id),
            focused: id,
          };
        });
      },
      splitTile(srcId, targetId, edge) {
        mutate((s) => {
          const src = s.panels[srcId]; if (!src) return s;
          if (!findLeaf(s.tree, targetId) || srcId === targetId) return s;
          let tree = src.mode === 'tiled' ? removeFromTree(s.tree, srcId) : s.tree;
          let floatingZOrder = s.floatingZOrder;
          if (src.mode === 'floating') floatingZOrder = floatingZOrder.filter((x) => x !== srcId);
          if (!tree) tree = removeFromTree(s.tree, srcId);
          tree = splitAt(tree!, targetId, edge, srcId);
          return {
            ...s,
            panels: { ...s.panels, [srcId]: { ...src, mode: 'tiled' } },
            tree, floatingZOrder, focused: srcId, interaction: null,
          };
        });
      },
      arrangeCascadeFloating() {
        mutate((s) => {
          const fpanels = s.floatingZOrder.map((id) => s.panels[id]).filter((p): p is Panel => !!p);
          if (fpanels.length === 0) return s;
          const next = cascadeFloating(fpanels, getViewport());
          const panels = { ...s.panels };
          for (const p of next) panels[p.id] = p;
          return { ...s, panels };
        });
      },
      arrangeMosaicTiled() { mutate((s) => ({ ...s, tree: buildMosaic(flattenPanelIds(s.tree)) })); },
      arrangeRows() { mutate((s) => ({ ...s, tree: buildRow(flattenPanelIds(s.tree)) })); },
      arrangeColumns() { mutate((s) => ({ ...s, tree: buildColumn(flattenPanelIds(s.tree)) })); },
      arrangeEqualizeTiles() { mutate((s) => ({ ...s, tree: equalizeTree(s.tree) })); },
      setAllPanelsMode(mode) {
        mutate((s) => {
          const allIds = Object.keys(s.panels);
          const panels = { ...s.panels };
          for (const id of allIds) panels[id] = { ...panels[id]!, mode };
          if (mode === 'floating') return { ...s, panels, tree: null, floatingZOrder: allIds };
          return { ...s, panels, tree: buildMosaic(allIds), floatingZOrder: [] };
        });
      },
      startFloatingDrag(id, px, py) {
        mutate((s) => {
          const p = s.panels[id]; if (!p || p.mode !== 'floating') return s;
          const moved = moveFloatingTop(s, id);
          return { ...moved, interaction: { kind: 'drag-floating', id, offset: { x: px - p.x, y: py - p.y } } };
        });
      },
      startTileDrag(id) {
        mutate((s) => {
          const p = s.panels[id]; if (!p || p.mode !== 'tiled') return s;
          return { ...s, interaction: { kind: 'drag-tiled', id, targetLeafId: null, targetZone: null } };
        });
      },
      startFloatingResize(id, px, py) {
        mutate((s) => {
          const p = s.panels[id]; if (!p || p.mode !== 'floating') return s;
          const moved = moveFloatingTop(s, id);
          return { ...moved, interaction: { kind: 'resize-floating', id, startSize: { w: p.w, h: p.h }, startPointer: { x: px, y: py } } };
        });
      },
      startDividerResize(containerId, dividerIdx, px, py, containerLengthPx) {
        mutate((s) => {
          const c = findContainer(s.tree, containerId); if (!c) return s;
          return {
            ...s,
            interaction: {
              kind: 'divider-resize', containerId, dividerIdx,
              startSizes: [...c.sizes], startPointer: c.dir === 'row' ? px : py,
              containerLength: containerLengthPx,
            },
          };
        });
      },
      pointerMove(px, py) {
        if (!state.interaction) return;
        runtime.fire('pointer-move', { px, py });
      },
      setTileDropTarget(leafId, zone) {
        mutate((s) => {
          const inter = s.interaction;
          if (inter?.kind !== 'drag-tiled') return s;
          if (inter.targetLeafId === leafId && inter.targetZone === zone) return s;
          return { ...s, interaction: { ...inter, targetLeafId: leafId, targetZone: zone } };
        });
      },
      pointerUp() {
        const inter = state.interaction;
        if (!inter) return;
        if (inter.kind === 'drag-tiled' && inter.targetLeafId && inter.targetZone) {
          const findByNode = (t: WS['tree'], nid: string): string | null => {
            if (!t) return null;
            if (t.kind === 'leaf') return t.id === nid ? t.panelId : null;
            for (const c of t.children) { const r = findByNode(c, nid); if (r) return r; }
            return null;
          };
          const targetPanelId = findByNode(state.tree, inter.targetLeafId);
          if (targetPanelId && targetPanelId !== inter.id) {
            const edge = inter.targetZone === 'center' ? 'right' : inter.targetZone;
            this.splitTile(inter.id, targetPanelId, edge);
            return;
          }
        }
        mutate((s) => ({ ...s, interaction: null }));
      },
      setCursor(x, y, overPanelId) {
        if (state.cursor.x === x && state.cursor.y === y && state.cursor.overPanelId === overPanelId) return;
        mutate((s) => ({ ...s, cursor: { x, y, overPanelId } }));
      },
      onKey({ key, meta, ctrl }) {
        const mod = meta || ctrl;
        if (mod && (key === 'k' || key === 'K')) { this.openCommandPalette(COMMAND_PALETTE_COMMANDS); return true; }
        if (key === 'Escape') {
          const tm = state.modals[state.modals.length - 1];
          if (tm) { this.close(tm.id, tm.kind === 'confirm' ? false : tm.kind === 'command-palette' ? null : undefined); return true; }
          if (state.focused) { this.close(state.focused); return true; }
          return false;
        }
        if (mod && (key === 'w' || key === 'W') && state.modals.length === 0 && state.focused) {
          this.close(state.focused); return true;
        }
        return false;
      },
      loadLayout() {
        const layout = readPersistedLayout();
        if (!layout) return;
        const validIds = new Set(Object.keys(layout.panels));
        mutate(() => ({
          ...emptySnapshot(),
          panels: layout.panels,
          tree: layout.tree,
          floatingZOrder: layout.floatingZOrder.filter((id) => validIds.has(id)),
          focused: validIds.has(layout.focused ?? '') ? layout.focused : null,
        }));
      },
      reset() {
        for (const [, r] of pendingResolvers) r(undefined);
        pendingResolvers.clear();
        mutate(() => emptySnapshot());
        clearPersistedLayout();
      },
      dispose() { runtime.dispose(); subs.clear(); pendingResolvers.clear(); },
    };
  },
};
