// RTK listenerMiddleware — one slice for the workspace; listeners handle
// pointer-move throttling (cancelActiveListeners + delay) and persist
// debouncing (same pattern).

import {
  configureStore, createAction, createListenerMiddleware, createSlice,
  type PayloadAction,
} from '@reduxjs/toolkit';
import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS, MAX_PANELS, PERSIST_DEBOUNCE_MS, POINTER_THROTTLE_MS,
  clampPanelToViewport, clampResize, clearPersistedLayout, defaultBody, defaultPanelLayout,
  defaultTitle, emptySnapshot, genId, getViewport, persistLayout, readPersistedLayout, snapToEdges,
} from '../scenario';
import type {
  FloatingPanel, ModalSpec, PanelKind, Unsubscribe, WorkspaceSnapshot,
} from '../types';

function moveTop(z: readonly string[], id: string): string[] {
  return [...z.filter((x) => x !== id), id];
}

const slice = createSlice({
  name: 'ws',
  initialState: emptySnapshot() as WorkspaceSnapshot,
  reducers: {
    addPanel(s, a: PayloadAction<FloatingPanel>) {
      s.panels[a.payload.id] = a.payload;
      s.zOrder.push(a.payload.id);
      s.focused = a.payload.id;
    },
    addModal(s, a: PayloadAction<ModalSpec>) { s.modals.push(a.payload); },
    removeWindow(s, a: PayloadAction<string>) {
      if (s.panels[a.payload]) {
        delete s.panels[a.payload];
        s.zOrder = s.zOrder.filter((x) => x !== a.payload);
        if (s.focused === a.payload) s.focused = s.zOrder[s.zOrder.length - 1] ?? null;
      } else {
        s.modals = s.modals.filter((m) => m.id !== a.payload);
      }
    },
    focusPanel(s, a: PayloadAction<string>) {
      if (!s.panels[a.payload]) return;
      s.zOrder = moveTop(s.zOrder, a.payload);
      s.focused = a.payload;
    },
    setQuery(s, a: PayloadAction<string>) {
      const top = s.modals[s.modals.length - 1];
      if (top?.kind === 'command-palette') top.query = a.payload;
    },
    setBody(s, a: PayloadAction<{ id: string; body: string }>) {
      const p = s.panels[a.payload.id]; if (p) p.body = a.payload.body;
    },
    startDrag(s, a: PayloadAction<{ id: string; px: number; py: number }>) {
      const panel = s.panels[a.payload.id]; if (!panel) return;
      s.zOrder = moveTop(s.zOrder, a.payload.id);
      s.focused = a.payload.id;
      s.interaction = { kind: 'drag', id: a.payload.id, offset: { x: a.payload.px - panel.x, y: a.payload.py - panel.y } };
    },
    startResize(s, a: PayloadAction<{ id: string; px: number; py: number }>) {
      const panel = s.panels[a.payload.id]; if (!panel) return;
      s.zOrder = moveTop(s.zOrder, a.payload.id);
      s.focused = a.payload.id;
      s.interaction = { kind: 'resize', id: a.payload.id, startSize: { w: panel.w, h: panel.h }, startPointer: { x: a.payload.px, y: a.payload.py } };
    },
    applyMove(s, a: PayloadAction<{ px: number; py: number }>) {
      const inter = s.interaction; if (!inter) return;
      const panel = s.panels[inter.id]; if (!panel) return;
      const viewport = getViewport();
      if (inter.kind === 'drag') {
        const moved = { ...panel, x: a.payload.px - inter.offset.x, y: a.payload.py - inter.offset.y };
        s.panels[inter.id] = snapToEdges(clampPanelToViewport(moved, viewport), viewport);
      } else {
        const dx = a.payload.px - inter.startPointer.x;
        const dy = a.payload.py - inter.startPointer.y;
        const sized = clampResize(inter.startSize.w + dx, inter.startSize.h + dy, { x: panel.x, y: panel.y }, viewport);
        s.panels[inter.id] = { ...panel, ...sized };
      }
    },
    endInteraction(s) { s.interaction = null; },
    resetAll() { return emptySnapshot(); },
    restoreLayout(_, a: PayloadAction<WorkspaceSnapshot>) { return a.payload; },
  },
});

const pointerMoveAction = createAction<{ px: number; py: number }>('ws/pointerMoveExt');
const persistTrigger = createAction('ws/persistTrigger');

export const rtkListenerFactory: EngineFactory = {
  meta: {
    id: 'rtk',
    label: 'RTK listenerMiddleware',
    description: 'Slice + listeners; cancelActiveListeners+delay for throttle and persist debounce.',
    sourcePath: 'floating-workspace/src/engines/rtk-listener.ts',
  },
  create(): Engine {
    const listener = createListenerMiddleware();
    const store = configureStore({
      reducer: slice.reducer,
      middleware: (g) => g({ serializableCheck: false }).prepend(listener.middleware),
    });
    const modalResolvers = new Map<string, (r: unknown) => void>();
    let handledKey = false;

    // Pointer-move throttle (rtk-listener idiom: cancel + delay)
    listener.startListening({
      actionCreator: pointerMoveAction,
      effect: async (a, { cancelActiveListeners, delay, dispatch }) => {
        cancelActiveListeners();
        await delay(POINTER_THROTTLE_MS);
        dispatch(slice.actions.applyMove(a.payload));
      },
    });
    // Persist debounce
    listener.startListening({
      actionCreator: persistTrigger,
      effect: async (_a, { cancelActiveListeners, delay, getState }) => {
        cancelActiveListeners();
        await delay(PERSIST_DEBOUNCE_MS);
        persistLayout(getState() as WorkspaceSnapshot);
      },
    });

    // After any mutating action, schedule a persist. Skip the no-op
    // dispatches (persistTrigger doesn't change state) by reference-comparing.
    let lastState: WorkspaceSnapshot = store.getState() as WorkspaceSnapshot;
    let cachedSnap: WorkspaceSnapshot = lastState;
    const subs = new Set<(s: WorkspaceSnapshot) => void>();
    const unsubStore = store.subscribe(() => {
      const s = store.getState() as WorkspaceSnapshot;
      if (s === lastState) return;
      lastState = s;
      cachedSnap = s;
      for (const cb of subs) cb(cachedSnap);
      store.dispatch(persistTrigger());
    });

    return {
      snapshot: () => cachedSnap,
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },
      openPanel(kind, opts) {
        if (Object.keys(store.getState().panels).length >= MAX_PANELS) return null;
        const id = genId('panel');
        const panel: FloatingPanel = {
          id, kind,
          title: opts?.title ?? defaultTitle(kind),
          body: opts?.body ?? defaultBody(kind),
          ...defaultPanelLayout(kind),
        };
        store.dispatch(slice.actions.addPanel(panel));
        return id;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, () => resolve());
          store.dispatch(slice.actions.addModal({ kind: 'alert', id, title, body }));
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, (r) => resolve(Boolean(r)));
          store.dispatch(slice.actions.addModal({ kind: 'confirm', id, title, body }));
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          store.dispatch(slice.actions.addModal({ kind: 'command-palette', id, query: '', commands }));
        });
      },
      close(id, result) {
        const s = store.getState();
        if (s.modals.some((m) => m.id === id)) {
          const r = modalResolvers.get(id); modalResolvers.delete(id); r?.(result);
        }
        store.dispatch(slice.actions.removeWindow(id));
      },
      focus: (id) => store.dispatch(slice.actions.focusPanel(id)),
      setQuery: (q) => store.dispatch(slice.actions.setQuery(q)),
      setBody: (id, body) => store.dispatch(slice.actions.setBody({ id, body })),
      startDrag: (id, px, py) => store.dispatch(slice.actions.startDrag({ id, px, py })),
      startResize: (id, px, py) => store.dispatch(slice.actions.startResize({ id, px, py })),
      pointerMove: (px, py) => store.dispatch(pointerMoveAction({ px, py })),
      pointerUp() {
        store.dispatch(slice.actions.endInteraction());
        persistLayout(store.getState());
      },
      onKey({ key, meta, ctrl }) {
        handledKey = false;
        const mod = meta || ctrl;
        const s = store.getState();
        if (mod && (key === 'k' || key === 'K')) {
          this.openCommandPalette(COMMAND_PALETTE_COMMANDS); handledKey = true;
        } else if (key === 'Escape') {
          const top = s.modals[s.modals.length - 1];
          if (top) { this.close(top.id, top.kind === 'confirm' ? false : top.kind === 'command-palette' ? null : undefined); handledKey = true; }
          else if (s.focused) { this.close(s.focused); handledKey = true; }
        } else if (mod && (key === 'w' || key === 'W') && s.modals.length === 0 && s.focused) {
          this.close(s.focused); handledKey = true;
        }
        return handledKey;
      },
      loadLayout() {
        const layout = readPersistedLayout();
        if (!layout) return;
        const surviving = layout.zOrder.filter((id) => layout.panels[id]);
        store.dispatch(slice.actions.restoreLayout({
          ...emptySnapshot(),
          panels: layout.panels,
          zOrder: surviving,
          focused: surviving.includes(layout.focused ?? '') ? layout.focused : (surviving[surviving.length - 1] ?? null),
        }));
      },
      reset() {
        for (const [, r] of modalResolvers) r(undefined);
        modalResolvers.clear();
        store.dispatch(slice.actions.resetAll());
        clearPersistedLayout();
      },
      dispose() {
        listener.clearListeners();
        unsubStore();
        subs.clear();
        modalResolvers.clear();
      },
    };
  },
};
