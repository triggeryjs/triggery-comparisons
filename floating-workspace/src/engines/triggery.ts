// Triggery — single `workspace` trigger with one `mutate(fn)` event applies
// a reducer to closure state. `actions.debounce(1000).persist?.(s)` is the
// declarative one-liner for layout-persist. Pointer-move uses a closure
// throttle at the call site — the trigger pipeline is overkill for a 60 fps
// stream where 997/1000 events get dropped (and the 3 that survive go
// through `mutate(fn)` like everything else).

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

const moveTop = (s: WS, id: string): WS => ({
  ...s,
  floatingZOrder: [...s.floatingZOrder.filter((x) => x !== id), id],
  focused: id,
});

function applyMove(s: WS, px: number, py: number): WS {
  const inter = s.interaction;
  if (!inter) return s;
  const v = getViewport();
  if (inter.kind === 'drag-floating') {
    const p = s.panels[inter.id]; if (!p) return s;
    const moved = clampPanelToViewport({ ...p, x: px - inter.offset.x, y: py - inter.offset.y }, v);
    const others = Object.values(s.panels).filter((q) => q.id !== inter.id && q.mode === 'floating');
    return { ...s, panels: { ...s.panels, [inter.id]: snapFloating(moved, v, others) } };
  }
  if (inter.kind === 'resize-floating') {
    const p = s.panels[inter.id]; if (!p) return s;
    const sized = clampResize(inter.startSize.w + px - inter.startPointer.x, inter.startSize.h + py - inter.startPointer.y, { x: p.x, y: p.y }, v);
    return { ...s, panels: { ...s.panels, [inter.id]: { ...p, ...sized } } };
  }
  if (inter.kind === 'divider-resize') {
    const c = findContainer(s.tree, inter.containerId); if (!c) return s;
    const delta = (c.dir === 'row' ? px : py) - inter.startPointer;
    return { ...s, tree: setContainerSizes(s.tree!, inter.containerId, resizeContainerDivider(inter.startSizes, inter.dividerIdx, delta, inter.containerLength)) };
  }
  return s;
}

function findByNode(t: WS['tree'], nid: string): string | null {
  if (!t) return null;
  if (t.kind === 'leaf') return t.id === nid ? t.panelId : null;
  for (const c of t.children) { const r = findByNode(c, nid); if (r) return r; }
  return null;
}

export const triggeryFactory: EngineFactory = {
  meta: {
    id: 'triggery',
    label: 'Triggery',
    description: 'Single trigger, mutate(fn) event; actions.debounce(1000).persist declarative.',
    sourcePath: 'floating-workspace/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });
    let state: WS = emptySnapshot();
    const subs = new Set<(s: WS) => void>();
    const resolvers = new Map<string, (r: unknown) => void>();
    let lastMove = 0;

    createTrigger<{ events: { mutate: { fn: (s: WS) => WS } }; actions: { persist: WS } }>({
      id: 'workspace',
      events: ['mutate'],
      schedule: 'sync',
      handler: ({ event, actions }) => {
        state = event.payload.fn(state);
        for (const cb of subs) cb(state);
        actions.debounce(PERSIST_DEBOUNCE_MS).persist?.(state);
      },
    }, runtime);
    runtime.subscribeAction('workspace', 'persist', (s) => persistLayout(s as WS));

    const mutate = (fn: (s: WS) => WS) => runtime.fire('mutate', { fn });
    const openModal = (spec: ModalSpec, resolver: (r: unknown) => void) => {
      resolvers.set(spec.id, resolver);
      mutate((s) => ({ ...s, modals: [...s.modals, spec] }));
    };

    return {
      snapshot: () => state,
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },

      openPanel(kind, opts) {
        if (Object.keys(state.panels).length >= MAX_PANELS) return null;
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
          return mode === 'tiled'
            ? { ...s, panels, tree: appendToTreeRight(s.tree, id), focused: id }
            : { ...s, panels, floatingZOrder: [...s.floatingZOrder, id], focused: id };
        });
        return id;
      },
      alert: (title, body) => new Promise<void>((res) => openModal({ kind: 'alert', id: genId('modal'), title, body }, () => res())),
      confirm: (title, body) => new Promise<boolean>((res) => openModal({ kind: 'confirm', id: genId('modal'), title, body }, (r) => res(Boolean(r)))),
      openCommandPalette: (commands) => new Promise<string | null>((res) => openModal({ kind: 'command-palette', id: genId('modal'), query: '', commands }, (r) => res(typeof r === 'string' ? r : null))),

      close(id, result) {
        if (state.modals.some((m) => m.id === id)) {
          const r = resolvers.get(id); resolvers.delete(id);
          mutate((s) => ({ ...s, modals: s.modals.filter((m) => m.id !== id) }));
          r?.(result);
          return;
        }
        mutate((s) => {
          if (!s.panels[id]) return s;
          const { [id]: _d, ...rest } = s.panels; void _d;
          const fz = s.floatingZOrder.filter((x) => x !== id);
          return {
            ...s, panels: rest, tree: removeFromTree(s.tree, id), floatingZOrder: fz,
            focused: s.focused === id ? (fz[fz.length - 1] ?? null) : s.focused,
          };
        });
      },
      focus(id) {
        mutate((s) => {
          const p = s.panels[id]; if (!p) return s;
          return p.mode === 'floating' ? moveTop(s, id) : { ...s, focused: id };
        });
      },
      setBody(id, body) {
        mutate((s) => s.panels[id] ? { ...s, panels: { ...s.panels, [id]: { ...s.panels[id]!, body } } } : s);
      },
      setInspectorMode(id, mode) {
        mutate((s) => {
          const p = s.panels[id];
          return p?.kind === 'inspector' ? { ...s, panels: { ...s.panels, [id]: { ...p, inspectorMode: mode } } } : s;
        });
      },
      setQuery(q) {
        mutate((s) => {
          const top = s.modals[s.modals.length - 1];
          return top?.kind === 'command-palette' ? { ...s, modals: [...s.modals.slice(0, -1), { ...top, query: q }] } : s;
        });
      },
      setPanelMode(id, mode) {
        mutate((s) => {
          const p = s.panels[id]; if (!p || p.mode === mode) return s;
          if (mode === 'floating') return {
            ...s,
            panels: { ...s.panels, [id]: { ...p, mode: 'floating', x: p.x || 120, y: p.y || 120, w: p.w || 360, h: p.h || 240 } },
            tree: removeFromTree(s.tree, id),
            floatingZOrder: [...s.floatingZOrder, id],
            focused: id,
          };
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
          const src = s.panels[srcId]; if (!src || srcId === targetId || !findLeaf(s.tree, targetId)) return s;
          const fz = src.mode === 'floating' ? s.floatingZOrder.filter((x) => x !== srcId) : s.floatingZOrder;
          const treeAfterRemove = removeFromTree(s.tree, srcId);
          return {
            ...s,
            panels: { ...s.panels, [srcId]: { ...src, mode: 'tiled' } },
            tree: splitAt(treeAfterRemove!, targetId, edge, srcId),
            floatingZOrder: fz, focused: srcId, interaction: null,
          };
        });
      },
      arrangeCascadeFloating() {
        mutate((s) => {
          const fp = s.floatingZOrder.map((id) => s.panels[id]).filter((p): p is Panel => !!p);
          if (fp.length === 0) return s;
          const next = cascadeFloating(fp, getViewport());
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
          const ids = Object.keys(s.panels);
          const panels = { ...s.panels };
          for (const id of ids) panels[id] = { ...panels[id]!, mode };
          return mode === 'floating'
            ? { ...s, panels, tree: null, floatingZOrder: ids }
            : { ...s, panels, tree: buildMosaic(ids), floatingZOrder: [] };
        });
      },
      startFloatingDrag(id, px, py) {
        mutate((s) => {
          const p = s.panels[id]; if (!p || p.mode !== 'floating') return s;
          return { ...moveTop(s, id), interaction: { kind: 'drag-floating', id, offset: { x: px - p.x, y: py - p.y } } };
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
          return { ...moveTop(s, id), interaction: { kind: 'resize-floating', id, startSize: { w: p.w, h: p.h }, startPointer: { x: px, y: py } } };
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
        const now = performance.now();
        if (now - lastMove < POINTER_THROTTLE_MS) return;
        lastMove = now;
        mutate((s) => applyMove(s, px, py));
      },
      setTileDropTarget(leafId, zone) {
        mutate((s) => {
          const i = s.interaction;
          if (i?.kind !== 'drag-tiled' || (i.targetLeafId === leafId && i.targetZone === zone)) return s;
          return { ...s, interaction: { ...i, targetLeafId: leafId, targetZone: zone } };
        });
      },
      pointerUp() {
        const i = state.interaction;
        if (!i) return;
        if (i.kind === 'drag-tiled' && i.targetLeafId && i.targetZone) {
          const target = findByNode(state.tree, i.targetLeafId);
          if (target && target !== i.id) {
            this.splitTile(i.id, target, i.targetZone === 'center' ? 'right' : i.targetZone);
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
        const valid = new Set(Object.keys(layout.panels));
        mutate(() => ({
          ...emptySnapshot(),
          panels: layout.panels,
          tree: layout.tree,
          floatingZOrder: layout.floatingZOrder.filter((id) => valid.has(id)),
          focused: valid.has(layout.focused ?? '') ? layout.focused : null,
        }));
      },
      reset() {
        for (const [, r] of resolvers) r(undefined);
        resolvers.clear();
        mutate(() => emptySnapshot());
        clearPersistedLayout();
      },
      dispose() { runtime.dispose(); subs.clear(); resolvers.clear(); },
    };
  },
};
