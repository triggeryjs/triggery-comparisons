// RTK listenerMiddleware — shared slice (see _redux-slice.ts) plus listeners
// for pointer-move throttling and persist debouncing. The listener pattern
// is `cancelActiveListeners() + delay()` — declarative throttle/debounce
// inside the store, not a side-channel.

import { configureStore, createAction, createListenerMiddleware } from '@reduxjs/toolkit';
import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS, MAX_PANELS, PERSIST_DEBOUNCE_MS, POINTER_THROTTLE_MS,
  clearPersistedLayout, emptySnapshot, genId, persistLayout, readPersistedLayout,
} from '../scenario';
import type { Unsubscribe, WorkspaceSnapshot } from '../types';
import { findByNode, slice, wsActions, type WS } from './_redux-slice';

const pointerMoveRequested = createAction<{ px: number; py: number }>('ws/pointerMoveRequested');
const pointerUpRequested = createAction('ws/pointerUpRequested');

export const rtkListenerFactory: EngineFactory = {
  meta: {
    id: 'rtk',
    label: 'RTK listenerMiddleware',
    description: 'Slice + listenerMiddleware; throttle/debounce via cancelActiveListeners + delay.',
    sourcePath: 'floating-workspace/src/engines/rtk-listener.ts',
  },
  create(): Engine {
    const pendingResolvers = new Map<string, (r: unknown) => void>();

    const listenerMiddleware = createListenerMiddleware();
    const startListening = listenerMiddleware.startListening.withTypes<WS>();

    // Throttle pointer-move: when one move comes in, cancel any in-flight,
    // delay 16ms, then apply.
    startListening({
      actionCreator: pointerMoveRequested,
      effect: async (action, api) => {
        const s = api.getState();
        if (!s.interaction) return;
        api.cancelActiveListeners();
        await api.delay(POINTER_THROTTLE_MS);
        api.dispatch(wsActions.applyMove(action.payload));
      },
    });

    // Resolve drag-tiled → split or just clear interaction.
    startListening({
      actionCreator: pointerUpRequested,
      effect: async (_action, api) => {
        const s = api.getState();
        const inter = s.interaction;
        if (!inter) return;
        if (inter.kind === 'drag-tiled' && inter.targetLeafId && inter.targetZone) {
          const targetPanelId = findByNode(s.tree, inter.targetLeafId);
          if (targetPanelId && targetPanelId !== inter.id) {
            const edge = inter.targetZone === 'center' ? 'right' : inter.targetZone;
            api.dispatch(wsActions.splitTile({ srcId: inter.id, targetId: targetPanelId, edge }));
            return;
          }
        }
        api.dispatch(wsActions.pointerUp());
      },
    });

    // Debounce persist on any state-changing action.
    startListening({
      predicate: (action) => {
        const t = (action as { type: string }).type;
        return t.startsWith('ws/') && t !== 'ws/setCursor' && t !== 'ws/applyMove';
      },
      effect: async (_action, api) => {
        api.cancelActiveListeners();
        await api.delay(PERSIST_DEBOUNCE_MS);
        persistLayout(api.getState());
      },
    });

    const store = configureStore({
      reducer: slice.reducer,
      middleware: (getDef) =>
        getDef({ serializableCheck: false }).prepend(listenerMiddleware.middleware),
    });

    let cachedSnap: WorkspaceSnapshot = store.getState();
    const subs = new Set<(s: WS) => void>();
    const unsubscribe = store.subscribe(() => {
      cachedSnap = store.getState();
      for (const cb of subs) cb(cachedSnap);
    });

    return {
      snapshot: () => cachedSnap,
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },

      openPanel(kind, opts) {
        const s = store.getState();
        if (Object.keys(s.panels).length >= MAX_PANELS) return null;
        const id = genId('panel');
        store.dispatch(wsActions.openPanel({ kind, opts, reqId: 0, id }));
        return id;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, () => resolve());
          store.dispatch(wsActions.openModal({ kind: 'alert', id, title, body }));
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(Boolean(r)));
          store.dispatch(wsActions.openModal({ kind: 'confirm', id, title, body }));
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          store.dispatch(wsActions.openModal({ kind: 'command-palette', id, query: '', commands }));
        });
      },
      close(id, result) {
        if (store.getState().modals.some((m) => m.id === id)) {
          const r = pendingResolvers.get(id); pendingResolvers.delete(id);
          store.dispatch(wsActions.closeWindow(id));
          r?.(result);
          return;
        }
        store.dispatch(wsActions.closeWindow(id));
      },
      focus: (id) => { store.dispatch(wsActions.focusPanel(id)); },
      setBody: (id, body) => { store.dispatch(wsActions.setBody({ id, body })); },
      setInspectorMode: (id, mode) => { store.dispatch(wsActions.setInspectorMode({ id, mode })); },
      setQuery: (q) => { store.dispatch(wsActions.setQuery(q)); },
      setPanelMode: (id, mode) => { store.dispatch(wsActions.setPanelMode({ id, mode })); },
      splitTile: (srcId, targetId, edge) => { store.dispatch(wsActions.splitTile({ srcId, targetId, edge })); },
      arrangeCascadeFloating: () => { store.dispatch(wsActions.arrangeCascadeFloating()); },
      arrangeMosaicTiled: () => { store.dispatch(wsActions.arrangeMosaicTiled()); },
      arrangeRows: () => { store.dispatch(wsActions.arrangeRows()); },
      arrangeColumns: () => { store.dispatch(wsActions.arrangeColumns()); },
      arrangeEqualizeTiles: () => { store.dispatch(wsActions.arrangeEqualizeTiles()); },
      setAllPanelsMode: (mode) => { store.dispatch(wsActions.setAllPanelsMode(mode)); },
      startFloatingDrag: (id, px, py) => { store.dispatch(wsActions.startFloatingDrag({ id, px, py })); },
      startTileDrag: (id) => { store.dispatch(wsActions.startTileDrag(id)); },
      startFloatingResize: (id, px, py) => { store.dispatch(wsActions.startFloatingResize({ id, px, py })); },
      startDividerResize: (containerId, dividerIdx, px, py, containerLengthPx) => {
        store.dispatch(wsActions.startDividerResize({ containerId, dividerIdx, px, py, containerLengthPx }));
      },
      pointerMove: (px, py) => { store.dispatch(pointerMoveRequested({ px, py })); },
      setTileDropTarget: (leafId, zone) => { store.dispatch(wsActions.setTileDropTarget({ leafId, zone })); },
      pointerUp: () => { store.dispatch(pointerUpRequested()); },
      setCursor: (x, y, overPanelId) => { store.dispatch(wsActions.setCursor({ x, y, overPanelId })); },
      onKey({ key, meta, ctrl }) {
        const mod = meta || ctrl;
        const s = store.getState();
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
        store.dispatch(wsActions.hydrate({
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
        store.dispatch(wsActions.reset());
        clearPersistedLayout();
      },
      dispose() {
        unsubscribe();
        listenerMiddleware.clearListeners();
        subs.clear();
        pendingResolvers.clear();
      },
    };
  },
};
