// Triggery — four triggers, one per concern, dispatched through lookup tables:
//   `lifecycle`  — open/close/focus, setQuery, setBody, modal resolvers
//   `pointer`    — drag/resize state machine; `actions.throttle(16)` for moves
//   `keyboard`   — ESC / ⌘W / ⌘K key routing
//   `persist`    — `actions.debounce(1000)` writes layout to localStorage
// State is a closure (a workspace is a record of windows + pointers, not a graph).
// Each trigger emits a `snapshot` action; subscribers fan out to the UI.

import { createRuntime, createTrigger } from '@triggery/core';
import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS,
  MAX_PANELS,
  PERSIST_DEBOUNCE_MS,
  POINTER_THROTTLE_MS,
  clampPanelToViewport,
  clampResize,
  clearPersistedLayout,
  defaultBody,
  defaultPanelLayout,
  defaultTitle,
  emptySnapshot,
  genId,
  getViewport,
  persistLayout,
  readPersistedLayout,
  snapToEdges,
} from '../scenario';
import type {
  FloatingPanel,
  ModalSpec,
  PanelKind,
  Unsubscribe,
  WorkspaceSnapshot,
} from '../types';

type LifecycleSchema = {
  events: {
    'open-panel': { kind: PanelKind; title?: string; body?: string; reqId: number };
    'open-modal': { spec: ModalSpec };
    'close': { id: string; result?: unknown };
    'focus': { id: string };
    'set-query': { q: string };
    'set-body': { id: string; body: string };
    'reset': void;
    'load-layout': void;
  };
  actions: { snapshot: WorkspaceSnapshot };
};
type PointerSchema = {
  events: {
    'start-drag': { id: string; px: number; py: number };
    'start-resize': { id: string; px: number; py: number };
    'pointer-move': { px: number; py: number };
    'pointer-up': void;
  };
  actions: {
    /** Debounced move emit — the actual pixel update goes through this. */
    'apply-move': { px: number; py: number };
    snapshot: WorkspaceSnapshot;
  };
};
type KeyboardSchema = {
  events: { 'key': { key: string; meta: boolean; ctrl: boolean } };
  actions: { snapshot: WorkspaceSnapshot };
};
type PersistSchema = {
  events: { 'changed': void; 'flush': void };
  actions: { 'write': WorkspaceSnapshot };
};

export const triggeryFactory: EngineFactory = {
  meta: {
    id: 'triggery',
    label: 'Triggery',
    description: 'Four triggers (lifecycle/pointer/keyboard/persist); throttle + debounce built in.',
    sourcePath: 'floating-workspace/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });
    let state: WorkspaceSnapshot = emptySnapshot();
    const subs = new Set<(s: WorkspaceSnapshot) => void>();
    const pendingResolvers = new Map<string, (r: unknown) => void>();
    let openReqId = 0;
    const openReqResolvers = new Map<number, (id: string | null) => void>();

    const emit = () => { for (const cb of subs) cb(state); };

    const moveTop = (id: string) => {
      const rest = state.zOrder.filter((x) => x !== id);
      state = { ...state, zOrder: [...rest, id], focused: id };
    };
    const setPanel = (panel: FloatingPanel) => {
      state = { ...state, panels: { ...state.panels, [panel.id]: panel } };
    };

    // biome-ignore lint/suspicious/noExplicitAny: dispatch tables keyed by discriminated union
    type Fn = (p: any) => void;

    const lifecycleTable: Record<string, Fn> = {
      'open-panel': (p: { kind: PanelKind; title?: string; body?: string; reqId: number }) => {
        const resolver = openReqResolvers.get(p.reqId);
        openReqResolvers.delete(p.reqId);
        if (Object.keys(state.panels).length >= MAX_PANELS) {
          resolver?.(null);
          return;
        }
        const id = genId('panel');
        const panel: FloatingPanel = {
          id, kind: p.kind,
          title: p.title ?? defaultTitle(p.kind),
          body: p.body ?? defaultBody(p.kind),
          ...defaultPanelLayout(p.kind),
        };
        setPanel(panel);
        state = { ...state, zOrder: [...state.zOrder, id], focused: id };
        resolver?.(id);
      },
      'open-modal': (p: { spec: ModalSpec }) => {
        state = { ...state, modals: [...state.modals, p.spec] };
      },
      'close': (p: { id: string; result?: unknown }) => {
        const modalIdx = state.modals.findIndex((m) => m.id === p.id);
        if (modalIdx >= 0) {
          const resolver = pendingResolvers.get(p.id);
          pendingResolvers.delete(p.id);
          state = { ...state, modals: state.modals.filter((m) => m.id !== p.id) };
          resolver?.(p.result);
          return;
        }
        if (state.panels[p.id]) {
          const { [p.id]: _drop, ...rest } = state.panels;
          void _drop;
          const zOrder = state.zOrder.filter((x) => x !== p.id);
          const focused = state.focused === p.id ? (zOrder[zOrder.length - 1] ?? null) : state.focused;
          state = { ...state, panels: rest, zOrder, focused };
        }
      },
      'focus': (p: { id: string }) => {
        if (state.panels[p.id]) moveTop(p.id);
      },
      'set-query': (p: { q: string }) => {
        const top = state.modals[state.modals.length - 1];
        if (top?.kind === 'command-palette') {
          state = { ...state, modals: [...state.modals.slice(0, -1), { ...top, query: p.q }] };
        }
      },
      'set-body': (p: { id: string; body: string }) => {
        const panel = state.panels[p.id];
        if (panel) setPanel({ ...panel, body: p.body });
      },
      'reset': () => {
        for (const [, resolver] of pendingResolvers) resolver(undefined);
        pendingResolvers.clear();
        state = emptySnapshot();
        clearPersistedLayout();
      },
      'load-layout': () => {
        const layout = readPersistedLayout();
        if (!layout) return;
        const surviving = layout.zOrder.filter((id) => layout.panels[id]);
        state = {
          ...emptySnapshot(),
          panels: layout.panels,
          zOrder: surviving,
          focused: surviving.includes(layout.focused ?? '') ? layout.focused : (surviving[surviving.length - 1] ?? null),
        };
      },
    };
    createTrigger<LifecycleSchema>({
      id: 'lifecycle',
      events: ['open-panel', 'open-modal', 'close', 'focus', 'set-query', 'set-body', 'reset', 'load-layout'],
      schedule: 'sync',
      handler: ({ event, actions }) => {
        lifecycleTable[event.name]?.(event.payload);
        actions.snapshot?.(state);
        runtime.fire('changed');
      },
    }, runtime);

    const pointerTable: Record<string, Fn> = {
      'start-drag': (p: { id: string; px: number; py: number }) => {
        const panel = state.panels[p.id];
        if (!panel) return;
        moveTop(p.id);
        state = {
          ...state,
          interaction: { kind: 'drag', id: p.id, offset: { x: p.px - panel.x, y: p.py - panel.y } },
        };
      },
      'start-resize': (p: { id: string; px: number; py: number }) => {
        const panel = state.panels[p.id];
        if (!panel) return;
        moveTop(p.id);
        state = {
          ...state,
          interaction: {
            kind: 'resize',
            id: p.id,
            startSize: { w: panel.w, h: panel.h },
            startPointer: { x: p.px, y: p.py },
          },
        };
      },
      'pointer-up': () => {
        if (state.interaction) {
          state = { ...state, interaction: null };
          runtime.fire('flush');
        }
      },
    };
    createTrigger<PointerSchema>({
      id: 'pointer',
      events: ['start-drag', 'start-resize', 'pointer-move', 'pointer-up'],
      schedule: 'sync',
      handler: ({ event, actions }) => {
        if (event.name === 'pointer-move') {
          if (!state.interaction) return;
          // The actual pixel write is throttled — the `apply-move` action
          // runs at most once per POINTER_THROTTLE_MS.
          actions.throttle(POINTER_THROTTLE_MS)['apply-move']?.(event.payload);
          return;
        }
        pointerTable[event.name]?.(event.payload);
        actions.snapshot?.(state);
        runtime.fire('changed');
      },
    }, runtime);

    runtime.subscribeAction('pointer', 'apply-move', (raw) => {
      const { px, py } = raw as { px: number; py: number };
      const inter = state.interaction;
      if (!inter) return;
      const panel = state.panels[inter.id];
      if (!panel) return;
      const viewport = getViewport();
      if (inter.kind === 'drag') {
        const moved = { ...panel, x: px - inter.offset.x, y: py - inter.offset.y };
        const clamped = clampPanelToViewport(moved, viewport);
        setPanel(snapToEdges(clamped, viewport));
      } else {
        const dx = px - inter.startPointer.x;
        const dy = py - inter.startPointer.y;
        const sized = clampResize(
          inter.startSize.w + dx,
          inter.startSize.h + dy,
          { x: panel.x, y: panel.y },
          viewport,
        );
        setPanel({ ...panel, ...sized });
      }
      emit();
    });

    createTrigger<KeyboardSchema>({
      id: 'keyboard',
      events: ['key'],
      schedule: 'sync',
      handler: ({ event }) => {
        const { key, meta, ctrl } = event.payload;
        const mod = meta || ctrl;
        if (mod && (key === 'k' || key === 'K')) {
          runtime.fire('open-modal', {
            spec: { kind: 'command-palette', id: genId('modal'), query: '', commands: COMMAND_PALETTE_COMMANDS },
          });
          handledKey = true;
          return;
        }
        if (key === 'Escape') {
          const top = state.modals[state.modals.length - 1];
          if (top) {
            runtime.fire('close', { id: top.id, result: top.kind === 'confirm' ? false : top.kind === 'command-palette' ? null : undefined });
            handledKey = true;
          } else if (state.focused) {
            runtime.fire('close', { id: state.focused });
            handledKey = true;
          }
          return;
        }
        if (mod && (key === 'w' || key === 'W') && state.modals.length === 0 && state.focused) {
          runtime.fire('close', { id: state.focused });
          handledKey = true;
        }
      },
    }, runtime);
    let handledKey = false;

    createTrigger<PersistSchema>({
      id: 'persist',
      events: ['changed', 'flush'],
      schedule: 'sync',
      handler: ({ event, actions }) => {
        if (event.name === 'flush') {
          actions.write?.(state);
        } else {
          actions.debounce(PERSIST_DEBOUNCE_MS).write?.(state);
        }
      },
    }, runtime);
    runtime.subscribeAction('persist', 'write', (s) => persistLayout(s as WorkspaceSnapshot));

    // Snapshot fan-out
    const fan = (s: unknown) => { for (const cb of subs) cb(s as WorkspaceSnapshot); };
    runtime.subscribeAction('lifecycle', 'snapshot', fan);
    runtime.subscribeAction('pointer', 'snapshot', fan);
    runtime.subscribeAction('keyboard', 'snapshot', fan);

    return {
      snapshot: () => state,
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },

      openPanel(kind, opts) {
        // We can't return synchronously through `fire(...)` because the action
        // dispatch is microtask-batched in real apps; but our schedule is 'sync'
        // so we can capture the new id from the lifecycle handler via reqId.
        const reqId = ++openReqId;
        let result: string | null = null;
        openReqResolvers.set(reqId, (id) => { result = id; });
        runtime.fire('open-panel', { kind, reqId, ...(opts ?? {}) });
        return result;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, () => resolve());
          runtime.fire('open-modal', { spec: { kind: 'alert', id, title, body } });
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(Boolean(r)));
          runtime.fire('open-modal', { spec: { kind: 'confirm', id, title, body } });
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          runtime.fire('open-modal', { spec: { kind: 'command-palette', id, query: '', commands } });
        });
      },
      close: (id, result) => runtime.fire('close', { id, result }),
      focus: (id) => runtime.fire('focus', { id }),
      setQuery: (q) => runtime.fire('set-query', { q }),
      setBody: (id, body) => runtime.fire('set-body', { id, body }),
      startDrag: (id, px, py) => runtime.fire('start-drag', { id, px, py }),
      startResize: (id, px, py) => runtime.fire('start-resize', { id, px, py }),
      pointerMove: (px, py) => runtime.fire('pointer-move', { px, py }),
      pointerUp: () => runtime.fire('pointer-up'),
      onKey(e) {
        handledKey = false;
        runtime.fire('key', e);
        return handledKey;
      },
      loadLayout: () => runtime.fire('load-layout'),
      reset: () => runtime.fire('reset'),
      dispose: () => runtime.dispose(),
    };
  },
};
