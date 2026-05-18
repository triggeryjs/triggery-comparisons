// Redux + thunk — shared slice (see _redux-slice.ts). Pointer-move throttle
// and persist debounce are hand-rolled `setTimeout` in the factory closure.
// Thunks are used for `pointerMove` and `pointerUp` (the two methods that
// need to read store state to decide their effect).

import { configureStore, type ThunkAction, type UnknownAction } from '@reduxjs/toolkit';
import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS, MAX_PANELS, PERSIST_DEBOUNCE_MS, POINTER_THROTTLE_MS,
  clearPersistedLayout, emptySnapshot, genId, persistLayout, readPersistedLayout,
} from '../scenario';
import type { Unsubscribe, WorkspaceSnapshot } from '../types';
import { findByNode, slice, wsActions, type WS } from './_redux-slice';

type AppThunk<R = void> = ThunkAction<R, WS, undefined, UnknownAction>;

const pointerMoveThunk = (px: number, py: number): AppThunk => (dispatch, getState) => {
  const s = getState();
  if (!s.interaction) return;
  dispatch(wsActions.applyMove({ px, py }));
};

const pointerUpThunk = (): AppThunk => (dispatch, getState) => {
  const s = getState();
  const inter = s.interaction;
  if (!inter) return;
  if (inter.kind === 'drag-tiled' && inter.targetLeafId && inter.targetZone) {
    const targetPanelId = findByNode(s.tree, inter.targetLeafId);
    if (targetPanelId && targetPanelId !== inter.id) {
      const edge = inter.targetZone === 'center' ? 'right' : inter.targetZone;
      dispatch(wsActions.splitTile({ srcId: inter.id, targetId: targetPanelId, edge }));
      return;
    }
  }
  dispatch(wsActions.pointerUp());
};

export const reduxThunkFactory: EngineFactory = {
  meta: {
    id: 'redux-thunk',
    label: 'Redux + thunk',
    description: 'Slice + thunks; throttle/debounce via hand-rolled timers.',
    sourcePath: 'floating-workspace/src/engines/redux-thunk.ts',
  },
  create(): Engine {
    const pendingResolvers = new Map<string, (r: unknown) => void>();
    let lastMoveTime = 0;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const store = configureStore({
      reducer: slice.reducer,
      middleware: (getDef) => getDef({ serializableCheck: false }),
    });

    const schedulePersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistLayout(store.getState());
      }, PERSIST_DEBOUNCE_MS);
    };

    // Cached snapshot reference (avoids useSyncExternalStore infinite-loop).
    let cachedSnap: WorkspaceSnapshot = store.getState();
    const subs = new Set<(s: WS) => void>();
    const unsubscribe = store.subscribe(() => {
      cachedSnap = store.getState();
      schedulePersist();
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
      pointerMove(px, py) {
        const s = store.getState();
        if (!s.interaction) return;
        const now = performance.now();
        if (now - lastMoveTime < POINTER_THROTTLE_MS) return;
        lastMoveTime = now;
        store.dispatch(pointerMoveThunk(px, py));
      },
      setTileDropTarget: (leafId, zone) => { store.dispatch(wsActions.setTileDropTarget({ leafId, zone })); },
      pointerUp: () => { store.dispatch(pointerUpThunk()); },
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
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = null;
        store.dispatch(wsActions.reset());
        clearPersistedLayout();
      },
      dispose() {
        unsubscribe();
        if (persistTimer) clearTimeout(persistTimer);
        subs.clear();
        pendingResolvers.clear();
      },
    };
  },
};
