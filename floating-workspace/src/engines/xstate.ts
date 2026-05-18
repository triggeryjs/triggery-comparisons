// XState — workspace state lives in context; drag/resize is a top-level
// statechart (`idle` ↔ `dragging` ↔ `resizing`) so the invariant "you can't
// resize during a drag" is enforced by the state graph, not by `if` checks.
// Pointer throttle uses `raise({ delay, id }) + cancel(id)`; persist
// debounce same pattern. Modals are queued in context; alert/confirm/palette
// each get a promise + resolver registry kept in factory closure.

import { type ActorRefFrom, assign, cancel, createActor, raise, setup } from 'xstate';
import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS,
  MAX_PANELS,
  PERSIST_DEBOUNCE_MS,
  POINTER_THROTTLE_MS,
  clampDockSize,
  clampPanelToViewport,
  clampResize,
  clearPersistedLayout,
  defaultBody,
  defaultPanelLayout,
  defaultTitle,
  emptySnapshot,
  genId,
  getViewport,
  panelInDock,
  persistLayout,
  readPersistedLayout,
  snapToEdges,
} from '../scenario';
import type {
  DockAnchor,
  FloatingPanel,
  Interaction,
  ModalSpec,
  PanelKind,
  Unsubscribe,
  WorkspaceSnapshot,
} from '../types';

type Ctx = WorkspaceSnapshot & {
  /** Latest pointer position — held in ctx so the throttled CHECK_MOVE
   *  raise can read the most-recent x/y at fire-time. */
  pendingPointer: { x: number; y: number } | null;
};

type Ev =
  | { type: 'OPEN_PANEL'; kind: PanelKind; opts?: { title?: string; body?: string }; reqId: number }
  | { type: 'OPEN_MODAL'; spec: ModalSpec }
  | { type: 'CLOSE'; id: string; result?: unknown }
  | { type: 'FOCUS'; id: string }
  | { type: 'SET_QUERY'; q: string }
  | { type: 'SET_BODY'; id: string; body: string }
  | { type: 'DOCK'; id: string; anchor: DockAnchor }
  | { type: 'UNDOCK'; id: string }
  | { type: 'START_DRAG'; id: string; px: number; py: number }
  | { type: 'START_RESIZE'; id: string; px: number; py: number }
  | { type: 'START_DOCK_RESIZE'; anchor: DockAnchor; px: number; py: number }
  | { type: 'POINTER_MOVE'; px: number; py: number }
  | { type: 'POINTER_UP' }
  | { type: 'APPLY_MOVE' }
  | { type: 'PERSIST' }
  | { type: 'KEY'; key: string; meta: boolean; ctrl: boolean }
  | { type: 'LOAD_LAYOUT' }
  | { type: 'RESET' };

function moveTop(z: readonly string[], id: string): string[] {
  return [...z.filter((x) => x !== id), id];
}

function applyPanelOpen(ctx: Ctx, kind: PanelKind, opts: { title?: string; body?: string } | undefined): { ctx: Partial<Ctx>; id: string | null } {
  if (Object.keys(ctx.panels).length >= MAX_PANELS) return { ctx: {}, id: null };
  const id = genId('panel');
  const panel: FloatingPanel = {
    id, kind,
    title: opts?.title ?? defaultTitle(kind),
    body: opts?.body ?? defaultBody(kind),
    ...defaultPanelLayout(kind),
  };
  return {
    ctx: {
      panels: { ...ctx.panels, [id]: panel },
      zOrder: [...ctx.zOrder, id],
      focused: id,
    },
    id,
  };
}

function applyClose(ctx: Ctx, id: string): Partial<Ctx> | null {
  if (ctx.modals.some((m) => m.id === id)) {
    return { modals: ctx.modals.filter((m) => m.id !== id) };
  }
  if (ctx.panels[id]) {
    const { [id]: _drop, ...rest } = ctx.panels;
    void _drop;
    const zOrder = ctx.zOrder.filter((x) => x !== id);
    return {
      panels: rest,
      zOrder,
      focused: ctx.focused === id ? (zOrder[zOrder.length - 1] ?? null) : ctx.focused,
    };
  }
  return null;
}

const machine = setup({
  types: { context: {} as Ctx, events: {} as Ev },
  actions: {
    // Stubs — overridden per-instance via `.provide({ actions })` to close
    // over each engine instance's resolver Maps. setup() needs to know the
    // names so they can be referenced from `actions: 'openPanelAction'` etc.
    openPanelAction: () => {},
    closeAction: () => {},
    handleKey: () => {},
    setQuery: assign(({ context, event }) => {
      if (event.type !== 'SET_QUERY') return {};
      const top = context.modals[context.modals.length - 1];
      if (top?.kind !== 'command-palette') return {};
      return { modals: [...context.modals.slice(0, -1), { ...top, query: event.q }] };
    }),
    setBody: assign(({ context, event }) => {
      if (event.type !== 'SET_BODY') return {};
      const panel = context.panels[event.id];
      if (!panel) return {};
      return { panels: { ...context.panels, [event.id]: { ...panel, body: event.body } } };
    }),
    focusTop: assign(({ context, event }) => {
      if (event.type !== 'FOCUS' && event.type !== 'START_DRAG' && event.type !== 'START_RESIZE') return {};
      const id = event.id;
      const panel = context.panels[id];
      if (!panel) return {};
      if (panel.dock !== null) return { focused: id };
      return { zOrder: moveTop(context.zOrder, id), focused: id };
    }),
    dockAction: assign(({ context, event }) => {
      if (event.type !== 'DOCK') return {};
      const panel = context.panels[event.id];
      if (!panel) return {};
      const existing = panelInDock(context.panels, event.anchor);
      let panels = context.panels;
      let zOrder = context.zOrder;
      if (existing && existing.id !== event.id) {
        const restored: FloatingPanel = { ...existing, dock: null, x: 80, y: 80 };
        panels = { ...panels, [restored.id]: restored };
        if (!zOrder.includes(restored.id)) zOrder = [...zOrder, restored.id];
      }
      panels = { ...panels, [event.id]: { ...panel, dock: event.anchor } };
      zOrder = zOrder.filter((x) => x !== event.id);
      return { panels, zOrder, focused: event.id };
    }),
    undockAction: assign(({ context, event }) => {
      if (event.type !== 'UNDOCK') return {};
      const panel = context.panels[event.id];
      if (!panel || panel.dock === null) return {};
      const floating = { ...panel, dock: null, x: panel.x || 96, y: panel.y || 96 };
      return {
        panels: { ...context.panels, [event.id]: floating },
        zOrder: context.zOrder.includes(event.id) ? context.zOrder : [...context.zOrder, event.id],
        focused: event.id,
      };
    }),
    setDockResizeInteraction: assign(({ context, event }) => {
      if (event.type !== 'START_DOCK_RESIZE') return {};
      const interaction: Interaction = {
        kind: 'dock-resize',
        anchor: event.anchor,
        startSize: context.dockSizes[event.anchor],
        startPointer: event.anchor === 'bottom' ? event.py : event.px,
      };
      return { interaction };
    }),
    addModal: assign(({ context, event }) =>
      event.type === 'OPEN_MODAL' ? { modals: [...context.modals, event.spec] } : {},
    ),
    setPendingPointer: assign(({ event }) =>
      event.type === 'POINTER_MOVE' ? { pendingPointer: { x: event.px, y: event.py } } : {},
    ),
    setDragInteraction: assign(({ context, event }) => {
      if (event.type !== 'START_DRAG') return {};
      const panel = context.panels[event.id];
      if (!panel || panel.dock !== null) return {};
      const interaction: Interaction = {
        kind: 'drag', id: event.id,
        offset: { x: event.px - panel.x, y: event.py - panel.y },
      };
      return { interaction };
    }),
    setResizeInteraction: assign(({ context, event }) => {
      if (event.type !== 'START_RESIZE') return {};
      const panel = context.panels[event.id];
      if (!panel || panel.dock !== null) return {};
      const interaction: Interaction = {
        kind: 'resize', id: event.id,
        startSize: { w: panel.w, h: panel.h },
        startPointer: { x: event.px, y: event.py },
      };
      return { interaction };
    }),
    clearInteraction: assign({ interaction: () => null, pendingPointer: () => null }),
    applyMove: assign(({ context }) => {
      const inter = context.interaction;
      const p = context.pendingPointer;
      if (!inter || !p) return {};
      const viewport = getViewport();
      if (inter.kind === 'dock-resize') {
        const cur = inter.anchor === 'bottom' ? p.y : p.x;
        let delta = cur - inter.startPointer;
        if (inter.anchor === 'right' || inter.anchor === 'bottom') delta = -delta;
        const size = clampDockSize(inter.anchor, inter.startSize + delta, viewport);
        return { dockSizes: { ...context.dockSizes, [inter.anchor]: size } };
      }
      const panel = context.panels[inter.id];
      if (!panel) return {};
      if (inter.kind === 'drag') {
        const moved = { ...panel, x: p.x - inter.offset.x, y: p.y - inter.offset.y };
        const snapped = snapToEdges(clampPanelToViewport(moved, viewport), viewport);
        return { panels: { ...context.panels, [inter.id]: snapped } };
      }
      const dx = p.x - inter.startPointer.x;
      const dy = p.y - inter.startPointer.y;
      const sized = clampResize(
        inter.startSize.w + dx, inter.startSize.h + dy,
        { x: panel.x, y: panel.y }, viewport,
      );
      return { panels: { ...context.panels, [inter.id]: { ...panel, ...sized } } };
    }),
    persist: ({ context }) => persistLayout(context),
    loadLayout: assign(() => {
      const layout = readPersistedLayout();
      if (!layout) return {};
      const surviving = layout.zOrder.filter((id) => layout.panels[id] && layout.panels[id].dock === null);
      return {
        ...emptySnapshot(),
        panels: layout.panels,
        zOrder: surviving,
        dockSizes: layout.dockSizes ?? undefined,
        focused: surviving.includes(layout.focused ?? '') ? layout.focused : (surviving[surviving.length - 1] ?? null),
      };
    }),
    resetAll: assign(() => ({ ...emptySnapshot(), pendingPointer: null })),
    clearStorage: () => clearPersistedLayout(),
  },
}).createMachine({
  id: 'workspace',
  initial: 'idle',
  context: { ...emptySnapshot(), pendingPointer: null },
  on: {
    // Lifecycle — handled at the top level so they work in any state.
    // OPEN_PANEL needs to communicate the resulting id back to the caller;
    // we use a `reqId` and a closure-held resolver registry in the engine.
    OPEN_PANEL: { actions: ['openPanelAction', cancel('persist-debounce'), raise({ type: 'PERSIST' }, { delay: PERSIST_DEBOUNCE_MS, id: 'persist-debounce' })] },
    OPEN_MODAL: { actions: 'addModal' },
    CLOSE: { actions: ['closeAction', cancel('persist-debounce'), raise({ type: 'PERSIST' }, { delay: PERSIST_DEBOUNCE_MS, id: 'persist-debounce' })] },
    FOCUS: { actions: ['focusTop', cancel('persist-debounce'), raise({ type: 'PERSIST' }, { delay: PERSIST_DEBOUNCE_MS, id: 'persist-debounce' })] },
    SET_QUERY: { actions: 'setQuery' },
    SET_BODY: { actions: ['setBody', cancel('persist-debounce'), raise({ type: 'PERSIST' }, { delay: PERSIST_DEBOUNCE_MS, id: 'persist-debounce' })] },
    DOCK: { actions: ['dockAction', cancel('persist-debounce'), raise({ type: 'PERSIST' }, { delay: PERSIST_DEBOUNCE_MS, id: 'persist-debounce' })] },
    UNDOCK: { actions: ['undockAction', cancel('persist-debounce'), raise({ type: 'PERSIST' }, { delay: PERSIST_DEBOUNCE_MS, id: 'persist-debounce' })] },
    PERSIST: { actions: 'persist' },
    LOAD_LAYOUT: { actions: 'loadLayout' },
    RESET: { actions: ['resetAll', 'clearStorage'] },
    KEY: { actions: 'handleKey' },
  },
  states: {
    idle: {
      on: {
        START_DRAG: { target: 'dragging', actions: ['focusTop', 'setDragInteraction'] },
        START_RESIZE: { target: 'resizing', actions: ['focusTop', 'setResizeInteraction'] },
        START_DOCK_RESIZE: { target: 'dockResizing', actions: 'setDockResizeInteraction' },
      },
    },
    dragging: {
      on: {
        POINTER_MOVE: {
          actions: [
            'setPendingPointer',
            cancel('move-throttle'),
            raise({ type: 'APPLY_MOVE' }, { delay: POINTER_THROTTLE_MS, id: 'move-throttle' }),
          ],
        },
        APPLY_MOVE: { actions: 'applyMove' },
        POINTER_UP: { target: 'idle', actions: ['clearInteraction', 'persist'] },
      },
    },
    resizing: {
      on: {
        POINTER_MOVE: {
          actions: [
            'setPendingPointer',
            cancel('move-throttle'),
            raise({ type: 'APPLY_MOVE' }, { delay: POINTER_THROTTLE_MS, id: 'move-throttle' }),
          ],
        },
        APPLY_MOVE: { actions: 'applyMove' },
        POINTER_UP: { target: 'idle', actions: ['clearInteraction', 'persist'] },
      },
    },
    dockResizing: {
      on: {
        POINTER_MOVE: {
          actions: [
            'setPendingPointer',
            cancel('move-throttle'),
            raise({ type: 'APPLY_MOVE' }, { delay: POINTER_THROTTLE_MS, id: 'move-throttle' }),
          ],
        },
        APPLY_MOVE: { actions: 'applyMove' },
        POINTER_UP: { target: 'idle', actions: ['clearInteraction', 'persist'] },
      },
    },
  },
});

export const xstateFactory: EngineFactory = {
  meta: {
    id: 'xstate',
    label: 'XState',
    description: 'Statechart: dragging/resizing as top-level states; throttle via raise/cancel.',
    sourcePath: 'floating-workspace/src/engines/xstate.ts',
  },
  create(): Engine {
    const pendingResolvers = new Map<string, (r: unknown) => void>();
    const openResolvers = new Map<number, (id: string | null) => void>();
    let openReqIdCounter = 0;
    let handledKey = false;

    // We provide some "actions" outside the .createMachine block because they
    // need access to the closure-held resolver maps. XState v5 supports this
    // via .provide(), but we wire them inline as `(_, params)`-shaped fns above
    // — except for these two which talk to closures:
    const wired = machine.provide({
      // biome-ignore lint/suspicious/noExplicitAny: machine.provide signature awkward
      actions: ({
        openPanelAction: assign(({ context, event }: { context: Ctx; event: Ev }) => {
          if (event.type !== 'OPEN_PANEL') return {};
          const { ctx, id } = applyPanelOpen(context, event.kind, event.opts);
          const resolver = openResolvers.get(event.reqId);
          openResolvers.delete(event.reqId);
          resolver?.(id);
          return ctx;
        }),
        closeAction: assign(({ context, event }: { context: Ctx; event: Ev }) => {
          if (event.type !== 'CLOSE') return {};
          if (context.modals.some((m) => m.id === event.id)) {
            const resolver = pendingResolvers.get(event.id);
            pendingResolvers.delete(event.id);
            resolver?.(event.result);
          }
          return applyClose(context, event.id) ?? {};
        }),
        handleKey: ({ context, event, self }: { context: Ctx; event: Ev; self: ActorRefFrom<typeof machine> }) => {
          if (event.type !== 'KEY') return;
          const { key, meta, ctrl } = event;
          const mod = meta || ctrl;
          if (mod && (key === 'k' || key === 'K')) {
            self.send({ type: 'OPEN_MODAL', spec: { kind: 'command-palette', id: genId('modal'), query: '', commands: COMMAND_PALETTE_COMMANDS } });
            handledKey = true;
            return;
          }
          if (key === 'Escape') {
            const top = context.modals[context.modals.length - 1];
            if (top) {
              self.send({ type: 'CLOSE', id: top.id, result: top.kind === 'confirm' ? false : top.kind === 'command-palette' ? null : undefined });
              handledKey = true;
            } else if (context.focused) {
              self.send({ type: 'CLOSE', id: context.focused });
              handledKey = true;
            }
            return;
          }
          if (mod && (key === 'w' || key === 'W') && context.modals.length === 0 && context.focused) {
            self.send({ type: 'CLOSE', id: context.focused });
            handledKey = true;
          }
        },
      // biome-ignore lint/suspicious/noExplicitAny: provide signature
      } as Record<string, any>),
    });

    const actor = createActor(wired);
    actor.start();

    const stripPending = (c: Ctx): WorkspaceSnapshot => {
      const { pendingPointer: _p, ...rest } = c;
      void _p;
      return rest;
    };
    let snap = stripPending(actor.getSnapshot().context);
    const subs = new Set<(s: WorkspaceSnapshot) => void>();
    const unsub = actor.subscribe(() => {
      snap = stripPending(actor.getSnapshot().context);
      for (const cb of subs) cb(snap);
    });

    return {
      snapshot: () => snap,
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },

      openPanel(kind, opts) {
        const reqId = ++openReqIdCounter;
        let id: string | null = null;
        openResolvers.set(reqId, (x) => { id = x; });
        actor.send({ type: 'OPEN_PANEL', kind, opts, reqId });
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
      close: (id, result) => actor.send({ type: 'CLOSE', id, result }),
      focus: (id) => actor.send({ type: 'FOCUS', id }),
      setQuery: (q) => actor.send({ type: 'SET_QUERY', q }),
      setBody: (id, body) => actor.send({ type: 'SET_BODY', id, body }),
      dock: (id, anchor) => actor.send({ type: 'DOCK', id, anchor }),
      undock: (id) => actor.send({ type: 'UNDOCK', id }),
      startDrag: (id, px, py) => actor.send({ type: 'START_DRAG', id, px, py }),
      startResize: (id, px, py) => actor.send({ type: 'START_RESIZE', id, px, py }),
      startDockResize: (anchor, px, py) => actor.send({ type: 'START_DOCK_RESIZE', anchor, px, py }),
      pointerMove: (px, py) => actor.send({ type: 'POINTER_MOVE', px, py }),
      pointerUp: () => actor.send({ type: 'POINTER_UP' }),
      onKey(e) {
        handledKey = false;
        actor.send({ type: 'KEY', ...e });
        return handledKey;
      },
      loadLayout: () => actor.send({ type: 'LOAD_LAYOUT' }),
      reset: () => {
        for (const [, r] of pendingResolvers) r(undefined);
        pendingResolvers.clear();
        actor.send({ type: 'RESET' });
      },
      dispose: () => {
        unsub.unsubscribe();
        actor.stop();
        subs.clear();
        pendingResolvers.clear();
      },
    };
  },
};
