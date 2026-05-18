// XState — workspace state lives in context. The statechart has two states:
// `idle` and `interacting`. Pointer-move uses `cancel('m') + raise({ delay, id: 'm' })`
// for debounce (fires after pointer silence, not at fixed 16ms intervals —
// the closest stock-XState approximation to throttle without external timers).
// Modals/promises are tracked in factory closure resolvers.

import { type ActorRefFrom, assign, cancel, createActor, raise, setup } from 'xstate';
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

type Ctx = WorkspaceSnapshot & {
  pendingPointer: { x: number; y: number } | null;
};

type Ev =
  | { type: 'OPEN_PANEL'; kind: PanelKind; opts?: { title?: string; body?: string; mode?: 'tiled' | 'floating' }; reqId: number; id: string }
  | { type: 'OPEN_MODAL'; spec: ModalSpec }
  | { type: 'CLOSE'; id: string }
  | { type: 'FOCUS'; id: string }
  | { type: 'SET_QUERY'; q: string }
  | { type: 'SET_BODY'; id: string; body: string }
  | { type: 'SET_INSPECTOR_MODE'; id: string; mode: InspectorMode }
  | { type: 'SET_PANEL_MODE'; id: string; mode: 'tiled' | 'floating' }
  | { type: 'SPLIT_TILE'; srcId: string; targetId: string; edge: 'top' | 'right' | 'bottom' | 'left' }
  | { type: 'ARRANGE_CASCADE' }
  | { type: 'ARRANGE_MOSAIC' }
  | { type: 'ARRANGE_ROWS' }
  | { type: 'ARRANGE_COLS' }
  | { type: 'ARRANGE_EQUALIZE' }
  | { type: 'SET_ALL_MODE'; mode: 'tiled' | 'floating' }
  | { type: 'START_FLOATING_DRAG'; id: string; px: number; py: number }
  | { type: 'START_TILE_DRAG'; id: string }
  | { type: 'START_FLOATING_RESIZE'; id: string; px: number; py: number }
  | { type: 'START_DIVIDER_RESIZE'; containerId: string; dividerIdx: number; px: number; py: number; containerLengthPx: number }
  | { type: 'POINTER_MOVE'; px: number; py: number }
  | { type: 'APPLY_MOVE' }
  | { type: 'SET_TILE_DROP_TARGET'; leafId: string | null; zone: 'top' | 'right' | 'bottom' | 'left' | 'center' | null }
  | { type: 'POINTER_UP' }
  | { type: 'SET_CURSOR'; x: number; y: number; overPanelId: string | null }
  | { type: 'PERSIST' }
  | { type: 'RESET' }
  | { type: 'HYDRATE'; snapshot: WorkspaceSnapshot };

function moveFloatingTop(s: WorkspaceSnapshot, id: string): WorkspaceSnapshot {
  return {
    ...s,
    floatingZOrder: [...s.floatingZOrder.filter((x) => x !== id), id],
    focused: id,
  };
}

function findByNode(t: WorkspaceSnapshot['tree'], nid: string): string | null {
  if (!t) return null;
  if (t.kind === 'leaf') return t.id === nid ? t.panelId : null;
  for (const c of t.children) { const r = findByNode(c, nid); if (r) return r; }
  return null;
}

function createMachine() {
  return setup({
    types: {} as { context: Ctx; events: Ev },
    actions: {
      schedulePersist: raise({ type: 'PERSIST' } as const, { delay: PERSIST_DEBOUNCE_MS, id: 'persist' }),
      cancelPersist: cancel('persist'),
      doPersist: ({ context }) => persistLayout(context),
    },
  }).createMachine({
    id: 'workspace',
    context: { ...emptySnapshot(), pendingPointer: null },
    initial: 'idle',
    on: {
      OPEN_PANEL: {
        actions: [
          assign(({ context, event }) => {
            if (Object.keys(context.panels).length >= MAX_PANELS) return {};
            const mode = event.opts?.mode ?? 'tiled';
            const panel: Panel = {
              id: event.id, kind: event.kind,
              title: event.opts?.title ?? defaultTitle(event.kind),
              body: event.opts?.body ?? defaultBody(event.kind),
              mode,
              ...defaultFloatingGeometry(event.kind),
              ...(event.kind === 'inspector' ? { inspectorMode: defaultInspectorMode() } : {}),
            };
            const panels = { ...context.panels, [event.id]: panel };
            if (mode === 'tiled') return { panels, tree: appendToTreeRight(context.tree, event.id), focused: event.id };
            return { panels, floatingZOrder: [...context.floatingZOrder, event.id], focused: event.id };
          }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      OPEN_MODAL: { actions: assign({ modals: ({ context, event }) => [...context.modals, event.spec] }) },
      CLOSE: {
        actions: [
          assign(({ context, event }) => {
            if (context.modals.some((m) => m.id === event.id)) {
              return { modals: context.modals.filter((m) => m.id !== event.id) };
            }
            if (!context.panels[event.id]) return {};
            const { [event.id]: _drop, ...rest } = context.panels; void _drop;
            const tree = removeFromTree(context.tree, event.id);
            const floatingZOrder = context.floatingZOrder.filter((x) => x !== event.id);
            const focused = context.focused === event.id ? (floatingZOrder[floatingZOrder.length - 1] ?? null) : context.focused;
            return { panels: rest, tree, floatingZOrder, focused };
          }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      FOCUS: {
        actions: assign(({ context, event }) => {
          const p = context.panels[event.id]; if (!p) return {};
          if (p.mode === 'floating') return moveFloatingTop(context, event.id);
          return { focused: event.id };
        }),
      },
      SET_QUERY: {
        actions: assign({
          modals: ({ context, event }) => {
            const top = context.modals[context.modals.length - 1];
            if (top?.kind !== 'command-palette') return context.modals;
            return [...context.modals.slice(0, -1), { ...top, query: event.q }];
          },
        }),
      },
      SET_BODY: {
        actions: [
          assign({
            panels: ({ context, event }) => {
              const p = context.panels[event.id]; if (!p) return context.panels;
              return { ...context.panels, [event.id]: { ...p, body: event.body } };
            },
          }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      SET_INSPECTOR_MODE: {
        actions: assign({
          panels: ({ context, event }) => {
            const p = context.panels[event.id]; if (!p || p.kind !== 'inspector') return context.panels;
            return { ...context.panels, [event.id]: { ...p, inspectorMode: event.mode } };
          },
        }),
      },
      SET_PANEL_MODE: {
        actions: [
          assign(({ context, event }) => {
            const p = context.panels[event.id]; if (!p || p.mode === event.mode) return {};
            if (event.mode === 'floating') {
              const updated: Panel = { ...p, mode: 'floating', x: p.x || 120, y: p.y || 120, w: p.w || 360, h: p.h || 240 };
              return {
                panels: { ...context.panels, [event.id]: updated },
                tree: removeFromTree(context.tree, event.id),
                floatingZOrder: [...context.floatingZOrder, event.id],
                focused: event.id,
              };
            }
            return {
              panels: { ...context.panels, [event.id]: { ...p, mode: 'tiled' as const } },
              tree: appendToTreeRight(context.tree, event.id),
              floatingZOrder: context.floatingZOrder.filter((x) => x !== event.id),
              focused: event.id,
            };
          }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      SPLIT_TILE: {
        actions: [
          assign(({ context, event }) => {
            const src = context.panels[event.srcId]; if (!src) return {};
            if (!findLeaf(context.tree, event.targetId) || event.srcId === event.targetId) return {};
            let tree = src.mode === 'tiled' ? removeFromTree(context.tree, event.srcId) : context.tree;
            let floatingZOrder = context.floatingZOrder;
            if (src.mode === 'floating') floatingZOrder = floatingZOrder.filter((x) => x !== event.srcId);
            if (!tree) tree = removeFromTree(context.tree, event.srcId);
            tree = splitAt(tree!, event.targetId, event.edge, event.srcId);
            return {
              panels: { ...context.panels, [event.srcId]: { ...src, mode: 'tiled' as const } },
              tree, floatingZOrder, focused: event.srcId, interaction: null,
            };
          }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      ARRANGE_CASCADE: {
        actions: [
          assign({
            panels: ({ context }) => {
              const fpanels = context.floatingZOrder.map((id) => context.panels[id]).filter((x): x is Panel => !!x);
              if (fpanels.length === 0) return context.panels;
              const next = cascadeFloating(fpanels, getViewport());
              const panels = { ...context.panels };
              for (const p of next) panels[p.id] = p;
              return panels;
            },
          }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      ARRANGE_MOSAIC: {
        actions: [
          assign({ tree: ({ context }) => buildMosaic(flattenPanelIds(context.tree)) }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      ARRANGE_ROWS: {
        actions: [
          assign({ tree: ({ context }) => buildRow(flattenPanelIds(context.tree)) }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      ARRANGE_COLS: {
        actions: [
          assign({ tree: ({ context }) => buildColumn(flattenPanelIds(context.tree)) }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      ARRANGE_EQUALIZE: {
        actions: [
          assign({ tree: ({ context }) => equalizeTree(context.tree) }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      SET_ALL_MODE: {
        actions: [
          assign(({ context, event }) => {
            const allIds = Object.keys(context.panels);
            const panels = { ...context.panels };
            for (const id of allIds) panels[id] = { ...panels[id]!, mode: event.mode };
            if (event.mode === 'floating') return { panels, tree: null, floatingZOrder: allIds };
            return { panels, tree: buildMosaic(allIds), floatingZOrder: [] };
          }),
          'cancelPersist', 'schedulePersist',
        ],
      },
      SET_CURSOR: {
        actions: assign(({ context, event }) => {
          if (context.cursor.x === event.x && context.cursor.y === event.y && context.cursor.overPanelId === event.overPanelId) return {};
          return { cursor: { x: event.x, y: event.y, overPanelId: event.overPanelId } };
        }),
      },
      RESET: {
        actions: [
          assign({ ...emptySnapshot(), pendingPointer: null }),
          'cancelPersist',
          () => clearPersistedLayout(),
        ],
        target: '.idle',
      },
      HYDRATE: {
        actions: assign(({ event }) => ({ ...event.snapshot, pendingPointer: null })),
      },
      PERSIST: { actions: 'doPersist' },
    },
    states: {
      idle: {
        on: {
          START_FLOATING_DRAG: {
            target: 'interacting',
            actions: assign(({ context, event }) => {
              const p = context.panels[event.id]; if (!p || p.mode !== 'floating') return {};
              const moved = moveFloatingTop(context, event.id);
              return { ...moved, interaction: { kind: 'drag-floating' as const, id: event.id, offset: { x: event.px - p.x, y: event.py - p.y } } };
            }),
          },
          START_TILE_DRAG: {
            target: 'interacting',
            actions: assign(({ context, event }) => {
              const p = context.panels[event.id]; if (!p || p.mode !== 'tiled') return {};
              return { interaction: { kind: 'drag-tiled' as const, id: event.id, targetLeafId: null, targetZone: null } };
            }),
          },
          START_FLOATING_RESIZE: {
            target: 'interacting',
            actions: assign(({ context, event }) => {
              const p = context.panels[event.id]; if (!p || p.mode !== 'floating') return {};
              const moved = moveFloatingTop(context, event.id);
              return { ...moved, interaction: { kind: 'resize-floating' as const, id: event.id, startSize: { w: p.w, h: p.h }, startPointer: { x: event.px, y: event.py } } };
            }),
          },
          START_DIVIDER_RESIZE: {
            target: 'interacting',
            actions: assign(({ context, event }) => {
              const c = findContainer(context.tree, event.containerId); if (!c) return {};
              return {
                interaction: {
                  kind: 'divider-resize' as const, containerId: event.containerId, dividerIdx: event.dividerIdx,
                  startSizes: [...c.sizes], startPointer: c.dir === 'row' ? event.px : event.py,
                  containerLength: event.containerLengthPx,
                },
              };
            }),
          },
        },
      },
      interacting: {
        on: {
          POINTER_MOVE: {
            actions: [
              assign({ pendingPointer: ({ event }) => ({ x: event.px, y: event.py }) }),
              cancel('move'),
              raise({ type: 'APPLY_MOVE' } as const, { delay: POINTER_THROTTLE_MS, id: 'move' }),
            ],
          },
          APPLY_MOVE: {
            actions: assign(({ context }) => {
              const inter = context.interaction; if (!inter) return {};
              const p = context.pendingPointer; if (!p) return {};
              const viewport = getViewport();
              if (inter.kind === 'drag-floating') {
                const panel = context.panels[inter.id]; if (!panel) return {};
                const moved = { ...panel, x: p.x - inter.offset.x, y: p.y - inter.offset.y };
                const clamped = clampPanelToViewport(moved, viewport);
                const others = Object.values(context.panels).filter((x) => x.id !== inter.id && x.mode === 'floating');
                const snapped = snapFloating(clamped, viewport, others);
                return { panels: { ...context.panels, [inter.id]: snapped } };
              }
              if (inter.kind === 'resize-floating') {
                const panel = context.panels[inter.id]; if (!panel) return {};
                const dx = p.x - inter.startPointer.x;
                const dy = p.y - inter.startPointer.y;
                const sized = clampResize(inter.startSize.w + dx, inter.startSize.h + dy, { x: panel.x, y: panel.y }, viewport);
                return { panels: { ...context.panels, [inter.id]: { ...panel, ...sized } } };
              }
              if (inter.kind === 'divider-resize') {
                const c = findContainer(context.tree, inter.containerId); if (!c) return {};
                const delta = (c.dir === 'row' ? p.x : p.y) - inter.startPointer;
                const next = resizeContainerDivider(inter.startSizes, inter.dividerIdx, delta, inter.containerLength);
                return { tree: setContainerSizes(context.tree!, inter.containerId, next) };
              }
              return {};
            }),
          },
          SET_TILE_DROP_TARGET: {
            actions: assign(({ context, event }) => {
              const inter = context.interaction;
              if (inter?.kind !== 'drag-tiled') return {};
              if (inter.targetLeafId === event.leafId && inter.targetZone === event.zone) return {};
              return { interaction: { ...inter, targetLeafId: event.leafId, targetZone: event.zone } };
            }),
          },
          POINTER_UP: {
            target: 'idle',
            actions: [
              cancel('move'),
              assign({ interaction: null, pendingPointer: null }),
              'cancelPersist', 'schedulePersist',
            ],
          },
        },
      },
    },
  });
}

type Machine = ReturnType<typeof createMachine>;
type Actor = ActorRefFrom<Machine>;

export const xstateFactory: EngineFactory = {
  meta: {
    id: 'xstate',
    label: 'XState',
    description: 'idle ↔ interacting statechart; raise/cancel for pointer debounce + persist.',
    sourcePath: 'floating-workspace/src/engines/xstate.ts',
  },
  create(): Engine {
    const machine = createMachine();
    const actor: Actor = createActor(machine);
    actor.start();
    const pendingResolvers = new Map<string, (r: unknown) => void>();
    let openReqIdCounter = 0;

    const getCtx = (): WorkspaceSnapshot => {
      const s = actor.getSnapshot();
      const { pendingPointer: _pp, ...rest } = s.context;
      void _pp;
      return rest;
    };

    let cachedSnap: WorkspaceSnapshot = getCtx();
    const subs = new Set<(s: WorkspaceSnapshot) => void>();
    actor.subscribe((s) => {
      const { pendingPointer: _pp, ...rest } = s.context;
      void _pp;
      cachedSnap = rest;
      for (const cb of subs) cb(cachedSnap);
    });

    return {
      snapshot: () => cachedSnap,
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },

      openPanel(kind, opts) {
        const s = getCtx();
        if (Object.keys(s.panels).length >= MAX_PANELS) return null;
        const id = genId('panel');
        actor.send({ type: 'OPEN_PANEL', kind, opts, reqId: ++openReqIdCounter, id });
        return id;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, () => resolve());
          actor.send({ type: 'OPEN_MODAL', spec: { kind: 'alert', id, title, body } });
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(Boolean(r)));
          actor.send({ type: 'OPEN_MODAL', spec: { kind: 'confirm', id, title, body } });
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          actor.send({ type: 'OPEN_MODAL', spec: { kind: 'command-palette', id, query: '', commands } });
        });
      },
      close(id, result) {
        if (cachedSnap.modals.some((m) => m.id === id)) {
          const r = pendingResolvers.get(id); pendingResolvers.delete(id);
          actor.send({ type: 'CLOSE', id });
          r?.(result);
          return;
        }
        actor.send({ type: 'CLOSE', id });
      },
      focus: (id) => actor.send({ type: 'FOCUS', id }),
      setBody: (id, body) => actor.send({ type: 'SET_BODY', id, body }),
      setInspectorMode: (id, mode) => actor.send({ type: 'SET_INSPECTOR_MODE', id, mode }),
      setQuery: (q) => actor.send({ type: 'SET_QUERY', q }),
      setPanelMode: (id, mode) => actor.send({ type: 'SET_PANEL_MODE', id, mode }),
      splitTile: (srcId, targetId, edge) => actor.send({ type: 'SPLIT_TILE', srcId, targetId, edge }),
      arrangeCascadeFloating: () => actor.send({ type: 'ARRANGE_CASCADE' }),
      arrangeMosaicTiled: () => actor.send({ type: 'ARRANGE_MOSAIC' }),
      arrangeRows: () => actor.send({ type: 'ARRANGE_ROWS' }),
      arrangeColumns: () => actor.send({ type: 'ARRANGE_COLS' }),
      arrangeEqualizeTiles: () => actor.send({ type: 'ARRANGE_EQUALIZE' }),
      setAllPanelsMode: (mode) => actor.send({ type: 'SET_ALL_MODE', mode }),
      startFloatingDrag: (id, px, py) => actor.send({ type: 'START_FLOATING_DRAG', id, px, py }),
      startTileDrag: (id) => actor.send({ type: 'START_TILE_DRAG', id }),
      startFloatingResize: (id, px, py) => actor.send({ type: 'START_FLOATING_RESIZE', id, px, py }),
      startDividerResize: (containerId, dividerIdx, px, py, containerLengthPx) =>
        actor.send({ type: 'START_DIVIDER_RESIZE', containerId, dividerIdx, px, py, containerLengthPx }),
      pointerMove: (px, py) => actor.send({ type: 'POINTER_MOVE', px, py }),
      setTileDropTarget: (leafId, zone) => actor.send({ type: 'SET_TILE_DROP_TARGET', leafId, zone }),
      pointerUp() {
        const s = cachedSnap;
        const inter = s.interaction;
        if (!inter) return;
        if (inter.kind === 'drag-tiled' && inter.targetLeafId && inter.targetZone) {
          const targetPanelId = findByNode(s.tree, inter.targetLeafId);
          if (targetPanelId && targetPanelId !== inter.id) {
            const edge = inter.targetZone === 'center' ? 'right' : inter.targetZone;
            actor.send({ type: 'SPLIT_TILE', srcId: inter.id, targetId: targetPanelId, edge });
            actor.send({ type: 'POINTER_UP' });
            return;
          }
        }
        actor.send({ type: 'POINTER_UP' });
      },
      setCursor: (x, y, overPanelId) => actor.send({ type: 'SET_CURSOR', x, y, overPanelId }),
      onKey({ key, meta, ctrl }) {
        const mod = meta || ctrl;
        const s = cachedSnap;
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
        actor.send({
          type: 'HYDRATE',
          snapshot: {
            ...emptySnapshot(),
            panels: layout.panels,
            tree: layout.tree,
            floatingZOrder: layout.floatingZOrder.filter((id) => validIds.has(id)),
            focused: validIds.has(layout.focused ?? '') ? layout.focused : null,
          },
        });
      },
      reset() {
        for (const [, r] of pendingResolvers) r(undefined);
        pendingResolvers.clear();
        actor.send({ type: 'RESET' });
      },
      dispose() {
        actor.stop();
        subs.clear();
        pendingResolvers.clear();
      },
    };
  },
};
