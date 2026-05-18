// Reatom — single `workspaceAtom` holds the snapshot; one `mutate` action
// takes a reducer function and applies it. Pointer-move throttle + persist
// debounce are hand-rolled (`lastMoveTime` + `setTimeout`).

import { action, atom, createCtx } from '@reatom/core';
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

function moveFloatingTop(s: WS, id: string): WS {
  return {
    ...s,
    floatingZOrder: [...s.floatingZOrder.filter((x) => x !== id), id],
    focused: id,
  };
}

function findByNode(t: WS['tree'], nid: string): string | null {
  if (!t) return null;
  if (t.kind === 'leaf') return t.id === nid ? t.panelId : null;
  for (const c of t.children) { const r = findByNode(c, nid); if (r) return r; }
  return null;
}

export const reatomFactory: EngineFactory = {
  meta: {
    id: 'reatom',
    label: 'Reatom',
    description: 'Atoms + actions, ctx-scoped; hand-rolled throttle + debounce timers.',
    sourcePath: 'floating-workspace/src/engines/reatom.ts',
  },
  create(): Engine {
    const ctx = createCtx();
    const workspaceAtom = atom<WS>(emptySnapshot(), 'workspace');
    const pendingResolvers = new Map<string, (r: unknown) => void>();
    let lastMoveTime = 0;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistLayout(ctx.get(workspaceAtom));
      }, PERSIST_DEBOUNCE_MS);
    };

    const mutate = action((c, fn: (s: WS) => WS) => {
      workspaceAtom(c, fn(c.get(workspaceAtom)));
    }, 'mutate');

    const run = (fn: (s: WS) => WS) => {
      mutate(ctx, fn);
      schedulePersist();
    };

    const subs = new Set<(s: WS) => void>();
    const unsubscribe = ctx.subscribe(workspaceAtom, (s) => { for (const cb of subs) cb(s); });

    const engine: Engine = {
      snapshot: () => ctx.get(workspaceAtom),
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },

      openPanel(kind, opts) {
        const s = ctx.get(workspaceAtom);
        if (Object.keys(s.panels).length >= MAX_PANELS) return null;
        const id = genId('panel');
        const mode = opts?.mode ?? 'tiled';
        const panel: Panel = {
          id, kind,
          title: opts?.title ?? defaultTitle(kind),
          body: opts?.body ?? defaultBody(kind),
          mode,
          ...defaultFloatingGeometry(kind),
          ...(kind === 'inspector' ? { inspectorMode: defaultInspectorMode() } : {}),
        };
        run((cur) => {
          const panels = { ...cur.panels, [id]: panel };
          if (mode === 'tiled') return { ...cur, panels, tree: appendToTreeRight(cur.tree, id), focused: id };
          return { ...cur, panels, floatingZOrder: [...cur.floatingZOrder, id], focused: id };
        });
        return id;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, () => resolve());
          run((s) => ({ ...s, modals: [...s.modals, { kind: 'alert', id, title, body }] }));
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(Boolean(r)));
          run((s) => ({ ...s, modals: [...s.modals, { kind: 'confirm', id, title, body }] }));
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          run((s) => ({ ...s, modals: [...s.modals, { kind: 'command-palette', id, query: '', commands }] }));
        });
      },
      close(id, result) {
        const s = ctx.get(workspaceAtom);
        if (s.modals.some((m) => m.id === id)) {
          const r = pendingResolvers.get(id); pendingResolvers.delete(id);
          run((cur) => ({ ...cur, modals: cur.modals.filter((m) => m.id !== id) }));
          r?.(result);
          return;
        }
        run((cur) => {
          if (!cur.panels[id]) return cur;
          const { [id]: _drop, ...rest } = cur.panels; void _drop;
          const tree = removeFromTree(cur.tree, id);
          const floatingZOrder = cur.floatingZOrder.filter((x) => x !== id);
          const focused = cur.focused === id ? (floatingZOrder[floatingZOrder.length - 1] ?? null) : cur.focused;
          return { ...cur, panels: rest, tree, floatingZOrder, focused };
        });
      },
      focus(id) {
        run((s) => {
          const p = s.panels[id]; if (!p) return s;
          return p.mode === 'floating' ? moveFloatingTop(s, id) : { ...s, focused: id };
        });
      },
      setBody(id, body) {
        run((s) => {
          const p = s.panels[id]; if (!p) return s;
          return { ...s, panels: { ...s.panels, [id]: { ...p, body } } };
        });
      },
      setInspectorMode(id, mode) {
        run((s) => {
          const p = s.panels[id]; if (!p || p.kind !== 'inspector') return s;
          return { ...s, panels: { ...s.panels, [id]: { ...p, inspectorMode: mode } } };
        });
      },
      setQuery(q) {
        run((s) => {
          const top = s.modals[s.modals.length - 1];
          if (top?.kind !== 'command-palette') return s;
          return { ...s, modals: [...s.modals.slice(0, -1), { ...top, query: q }] };
        });
      },
      setPanelMode(id, mode) {
        run((s) => {
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
        run((s) => {
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
        run((s) => {
          const fpanels = s.floatingZOrder.map((id) => s.panels[id]).filter((x): x is Panel => !!x);
          if (fpanels.length === 0) return s;
          const next = cascadeFloating(fpanels, getViewport());
          const panels = { ...s.panels };
          for (const p of next) panels[p.id] = p;
          return { ...s, panels };
        });
      },
      arrangeMosaicTiled() { run((s) => ({ ...s, tree: buildMosaic(flattenPanelIds(s.tree)) })); },
      arrangeRows() { run((s) => ({ ...s, tree: buildRow(flattenPanelIds(s.tree)) })); },
      arrangeColumns() { run((s) => ({ ...s, tree: buildColumn(flattenPanelIds(s.tree)) })); },
      arrangeEqualizeTiles() { run((s) => ({ ...s, tree: equalizeTree(s.tree) })); },
      setAllPanelsMode(mode) {
        run((s) => {
          const allIds = Object.keys(s.panels);
          const panels = { ...s.panels };
          for (const id of allIds) panels[id] = { ...panels[id]!, mode };
          if (mode === 'floating') return { ...s, panels, tree: null, floatingZOrder: allIds };
          return { ...s, panels, tree: buildMosaic(allIds), floatingZOrder: [] };
        });
      },
      startFloatingDrag(id, px, py) {
        run((s) => {
          const p = s.panels[id]; if (!p || p.mode !== 'floating') return s;
          const moved = moveFloatingTop(s, id);
          return { ...moved, interaction: { kind: 'drag-floating', id, offset: { x: px - p.x, y: py - p.y } } };
        });
      },
      startTileDrag(id) {
        run((s) => {
          const p = s.panels[id]; if (!p || p.mode !== 'tiled') return s;
          return { ...s, interaction: { kind: 'drag-tiled', id, targetLeafId: null, targetZone: null } };
        });
      },
      startFloatingResize(id, px, py) {
        run((s) => {
          const p = s.panels[id]; if (!p || p.mode !== 'floating') return s;
          const moved = moveFloatingTop(s, id);
          return { ...moved, interaction: { kind: 'resize-floating', id, startSize: { w: p.w, h: p.h }, startPointer: { x: px, y: py } } };
        });
      },
      startDividerResize(containerId, dividerIdx, px, py, containerLengthPx) {
        run((s) => {
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
        const s = ctx.get(workspaceAtom);
        if (!s.interaction) return;
        const now = performance.now();
        if (now - lastMoveTime < POINTER_THROTTLE_MS) return;
        lastMoveTime = now;
        run((cur) => {
          const inter = cur.interaction; if (!inter) return cur;
          const viewport = getViewport();
          if (inter.kind === 'drag-floating') {
            const p = cur.panels[inter.id]; if (!p) return cur;
            const moved = { ...p, x: px - inter.offset.x, y: py - inter.offset.y };
            const clamped = clampPanelToViewport(moved, viewport);
            const others = Object.values(cur.panels).filter((x) => x.id !== inter.id && x.mode === 'floating');
            const snapped = snapFloating(clamped, viewport, others);
            return { ...cur, panels: { ...cur.panels, [inter.id]: snapped } };
          }
          if (inter.kind === 'resize-floating') {
            const p = cur.panels[inter.id]; if (!p) return cur;
            const dx = px - inter.startPointer.x;
            const dy = py - inter.startPointer.y;
            const sized = clampResize(inter.startSize.w + dx, inter.startSize.h + dy, { x: p.x, y: p.y }, viewport);
            return { ...cur, panels: { ...cur.panels, [inter.id]: { ...p, ...sized } } };
          }
          if (inter.kind === 'divider-resize') {
            const c = findContainer(cur.tree, inter.containerId); if (!c) return cur;
            const delta = (c.dir === 'row' ? px : py) - inter.startPointer;
            const next = resizeContainerDivider(inter.startSizes, inter.dividerIdx, delta, inter.containerLength);
            return { ...cur, tree: setContainerSizes(cur.tree!, inter.containerId, next) };
          }
          return cur;
        });
      },
      setTileDropTarget(leafId, zone) {
        run((s) => {
          const inter = s.interaction;
          if (inter?.kind !== 'drag-tiled') return s;
          if (inter.targetLeafId === leafId && inter.targetZone === zone) return s;
          return { ...s, interaction: { ...inter, targetLeafId: leafId, targetZone: zone } };
        });
      },
      pointerUp() {
        const s = ctx.get(workspaceAtom);
        const inter = s.interaction;
        if (!inter) return;
        if (inter.kind === 'drag-tiled' && inter.targetLeafId && inter.targetZone) {
          const targetPanelId = findByNode(s.tree, inter.targetLeafId);
          if (targetPanelId && targetPanelId !== inter.id) {
            const edge = inter.targetZone === 'center' ? 'right' : inter.targetZone;
            this.splitTile(inter.id, targetPanelId, edge);
            return;
          }
        }
        run((cur) => ({ ...cur, interaction: null }));
      },
      setCursor(x, y, overPanelId) {
        const s = ctx.get(workspaceAtom);
        if (s.cursor.x === x && s.cursor.y === y && s.cursor.overPanelId === overPanelId) return;
        run((cur) => ({ ...cur, cursor: { x, y, overPanelId } }));
      },
      onKey({ key, meta, ctrl }) {
        const mod = meta || ctrl;
        const s = ctx.get(workspaceAtom);
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
      loadLayout() {
        const layout = readPersistedLayout();
        if (!layout) return;
        const validIds = new Set(Object.keys(layout.panels));
        run(() => ({
          ...emptySnapshot(),
          panels: layout.panels,
          tree: layout.tree,
          floatingZOrder: layout.floatingZOrder.filter((id) => validIds.has(id)),
          focused: validIds.has(layout.focused ?? '') ? layout.focused : null,
        }));
      },
      reset() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = null;
        for (const [, r] of pendingResolvers) r(undefined);
        pendingResolvers.clear();
        run(() => emptySnapshot());
        clearPersistedLayout();
      },
      dispose() {
        unsubscribe();
        if (persistTimer) clearTimeout(persistTimer);
        subs.clear();
        pendingResolvers.clear();
      },
    };
    return engine;
  },
};
