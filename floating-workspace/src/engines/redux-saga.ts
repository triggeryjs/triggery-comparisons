// Redux + saga — shared slice (see _redux-slice.ts). Sagas declare throttle
// and debounce as effect vocabulary: `throttle(16, action, saga)` for
// pointer-move, `debounce(1000, action, saga)` for persist. Both built-in,
// no hand-rolled timers.

import { configureStore, createAction } from '@reduxjs/toolkit';
import createSagaMiddleware from 'redux-saga';
import { all, debounce, put, select, takeEvery, throttle } from 'redux-saga/effects';
import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS, MAX_PANELS, PERSIST_DEBOUNCE_MS, POINTER_THROTTLE_MS,
  clearPersistedLayout, emptySnapshot, genId, persistLayout, readPersistedLayout,
} from '../scenario';
import type { Unsubscribe, WorkspaceSnapshot } from '../types';
import { findByNode, slice, wsActions, type WS } from './_redux-slice';

const pointerMoveRequested = createAction<{ px: number; py: number }>('saga/pointerMoveRequested');
const pointerUpRequested = createAction('saga/pointerUpRequested');
const persistRequested = createAction('saga/persistRequested');

function* applyMoveSaga(action: ReturnType<typeof pointerMoveRequested>) {
  const s: WS = yield select();
  if (!s.interaction) return;
  yield put(wsActions.applyMove(action.payload));
}

function* pointerUpSaga() {
  const s: WS = yield select();
  const inter = s.interaction;
  if (!inter) return;
  if (inter.kind === 'drag-tiled' && inter.targetLeafId && inter.targetZone) {
    const targetPanelId = findByNode(s.tree, inter.targetLeafId);
    if (targetPanelId && targetPanelId !== inter.id) {
      const edge = inter.targetZone === 'center' ? 'right' : inter.targetZone;
      yield put(wsActions.splitTile({ srcId: inter.id, targetId: targetPanelId, edge }));
      return;
    }
  }
  yield put(wsActions.pointerUp());
}

function* persistSaga() {
  const s: WS = yield select();
  persistLayout(s);
}

function* rootSaga() {
  yield all([
    throttle(POINTER_THROTTLE_MS, pointerMoveRequested.type, applyMoveSaga),
    takeEvery(pointerUpRequested.type, pointerUpSaga),
    debounce(PERSIST_DEBOUNCE_MS, persistRequested.type, persistSaga),
  ]);
}

export const reduxSagaFactory: EngineFactory = {
  meta: {
    id: 'redux-saga',
    label: 'Redux + saga',
    description: 'Slice + sagas; throttle()/debounce() are effects, not timers.',
    sourcePath: 'floating-workspace/src/engines/redux-saga.ts',
  },
  create(): Engine {
    const pendingResolvers = new Map<string, (r: unknown) => void>();
    const sagaMiddleware = createSagaMiddleware();

    const store = configureStore({
      reducer: slice.reducer,
      middleware: (getDef) => getDef({ serializableCheck: false, thunk: false }).concat(sagaMiddleware),
    });
    const task = sagaMiddleware.run(rootSaga);

    let cachedSnap: WorkspaceSnapshot = store.getState();
    const subs = new Set<(s: WS) => void>();
    const unsubscribe = store.subscribe(() => {
      const next = store.getState();
      const stateChanged = next !== cachedSnap;
      cachedSnap = next;
      // Only schedule persist on real state changes (and not for the debounce
      // signal itself — `persistRequested` would otherwise re-enter and loop).
      if (stateChanged) store.dispatch(persistRequested());
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
        task.cancel();
        subs.clear();
        pendingResolvers.clear();
      },
    };
  },
};
