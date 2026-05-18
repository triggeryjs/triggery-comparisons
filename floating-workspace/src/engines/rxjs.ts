// RxJS — single `Subject<Action>` upstream feeds a `scan` reducer. Pointer
// moves go through a parallel branch with `throttleTime(16)` then merge back
// in. Persist runs on `state$.pipe(debounceTime(1000))`. Drag-as-stream shape
// is rxjs's home turf.

import { BehaviorSubject, Subject, Subscription, merge } from 'rxjs';
import {
  debounceTime, distinctUntilChanged, filter, map, scan, share, tap, throttleTime,
} from 'rxjs/operators';
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

type Action =
  | { type: 'open-panel'; kind: PanelKind; opts?: { title?: string; body?: string; mode?: 'tiled' | 'floating' }; reqId: number }
  | { type: 'open-modal'; spec: ModalSpec }
  | { type: 'close'; id: string; result?: unknown }
  | { type: 'focus'; id: string }
  | { type: 'set-query'; q: string }
  | { type: 'set-body'; id: string; body: string }
  | { type: 'set-inspector-mode'; id: string; mode: InspectorMode }
  | { type: 'set-panel-mode'; id: string; mode: 'tiled' | 'floating' }
  | { type: 'split-tile'; srcId: string; targetId: string; edge: 'top' | 'right' | 'bottom' | 'left' }
  | { type: 'arrange-cascade-floating' }
  | { type: 'arrange-mosaic-tiled' }
  | { type: 'arrange-rows' }
  | { type: 'arrange-columns' }
  | { type: 'arrange-equalize' }
  | { type: 'set-all-mode'; mode: 'tiled' | 'floating' }
  | { type: 'start-floating-drag'; id: string; px: number; py: number }
  | { type: 'start-tile-drag'; id: string }
  | { type: 'start-floating-resize'; id: string; px: number; py: number }
  | { type: 'start-divider-resize'; containerId: string; dividerIdx: number; px: number; py: number; containerLengthPx: number }
  | { type: 'apply-move'; px: number; py: number }
  | { type: 'set-tile-drop-target'; leafId: string | null; zone: 'top' | 'right' | 'bottom' | 'left' | 'center' | null }
  | { type: 'pointer-up' }
  | { type: 'set-cursor'; x: number; y: number; overPanelId: string | null }
  | { type: 'reset' }
  | { type: 'load-layout' };

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

function reduce(
  state: WS,
  action: Action,
  openResolvers: Map<number, (id: string | null) => void>,
  pendingResolvers: Map<string, (r: unknown) => void>,
): WS {
  switch (action.type) {
    case 'open-panel': {
      const resolver = openResolvers.get(action.reqId);
      openResolvers.delete(action.reqId);
      if (Object.keys(state.panels).length >= MAX_PANELS) { resolver?.(null); return state; }
      const id = genId('panel');
      const mode = action.opts?.mode ?? 'tiled';
      const panel: Panel = {
        id, kind: action.kind,
        title: action.opts?.title ?? defaultTitle(action.kind),
        body: action.opts?.body ?? defaultBody(action.kind),
        mode,
        ...defaultFloatingGeometry(action.kind),
        ...(action.kind === 'inspector' ? { inspectorMode: defaultInspectorMode() } : {}),
      };
      resolver?.(id);
      const panels = { ...state.panels, [id]: panel };
      if (mode === 'tiled') return { ...state, panels, tree: appendToTreeRight(state.tree, id), focused: id };
      return { ...state, panels, floatingZOrder: [...state.floatingZOrder, id], focused: id };
    }
    case 'open-modal':
      return { ...state, modals: [...state.modals, action.spec] };
    case 'close': {
      if (state.modals.some((m) => m.id === action.id)) {
        const r = pendingResolvers.get(action.id); pendingResolvers.delete(action.id);
        const next = { ...state, modals: state.modals.filter((m) => m.id !== action.id) };
        r?.(action.result);
        return next;
      }
      if (!state.panels[action.id]) return state;
      const { [action.id]: _drop, ...rest } = state.panels; void _drop;
      const tree = removeFromTree(state.tree, action.id);
      const floatingZOrder = state.floatingZOrder.filter((x) => x !== action.id);
      const focused = state.focused === action.id ? (floatingZOrder[floatingZOrder.length - 1] ?? null) : state.focused;
      return { ...state, panels: rest, tree, floatingZOrder, focused };
    }
    case 'focus': {
      const p = state.panels[action.id]; if (!p) return state;
      return p.mode === 'floating' ? moveFloatingTop(state, action.id) : { ...state, focused: action.id };
    }
    case 'set-query': {
      const top = state.modals[state.modals.length - 1];
      if (top?.kind !== 'command-palette') return state;
      return { ...state, modals: [...state.modals.slice(0, -1), { ...top, query: action.q }] };
    }
    case 'set-body': {
      const p = state.panels[action.id]; if (!p) return state;
      return { ...state, panels: { ...state.panels, [action.id]: { ...p, body: action.body } } };
    }
    case 'set-inspector-mode': {
      const p = state.panels[action.id]; if (!p || p.kind !== 'inspector') return state;
      return { ...state, panels: { ...state.panels, [action.id]: { ...p, inspectorMode: action.mode } } };
    }
    case 'set-panel-mode': {
      const p = state.panels[action.id]; if (!p || p.mode === action.mode) return state;
      if (action.mode === 'floating') {
        const updated: Panel = { ...p, mode: 'floating', x: p.x || 120, y: p.y || 120, w: p.w || 360, h: p.h || 240 };
        return {
          ...state,
          panels: { ...state.panels, [action.id]: updated },
          tree: removeFromTree(state.tree, action.id),
          floatingZOrder: [...state.floatingZOrder, action.id],
          focused: action.id,
        };
      }
      return {
        ...state,
        panels: { ...state.panels, [action.id]: { ...p, mode: 'tiled' } },
        tree: appendToTreeRight(state.tree, action.id),
        floatingZOrder: state.floatingZOrder.filter((x) => x !== action.id),
        focused: action.id,
      };
    }
    case 'split-tile': {
      const src = state.panels[action.srcId]; if (!src) return state;
      if (!findLeaf(state.tree, action.targetId) || action.srcId === action.targetId) return state;
      let tree = src.mode === 'tiled' ? removeFromTree(state.tree, action.srcId) : state.tree;
      let floatingZOrder = state.floatingZOrder;
      if (src.mode === 'floating') floatingZOrder = floatingZOrder.filter((x) => x !== action.srcId);
      if (!tree) tree = removeFromTree(state.tree, action.srcId);
      tree = splitAt(tree!, action.targetId, action.edge, action.srcId);
      return {
        ...state,
        panels: { ...state.panels, [action.srcId]: { ...src, mode: 'tiled' } },
        tree, floatingZOrder, focused: action.srcId, interaction: null,
      };
    }
    case 'arrange-cascade-floating': {
      const fpanels = state.floatingZOrder.map((id) => state.panels[id]).filter((x): x is Panel => !!x);
      if (fpanels.length === 0) return state;
      const next = cascadeFloating(fpanels, getViewport());
      const panels = { ...state.panels };
      for (const p of next) panels[p.id] = p;
      return { ...state, panels };
    }
    case 'arrange-mosaic-tiled':
      return { ...state, tree: buildMosaic(flattenPanelIds(state.tree)) };
    case 'arrange-rows':
      return { ...state, tree: buildRow(flattenPanelIds(state.tree)) };
    case 'arrange-columns':
      return { ...state, tree: buildColumn(flattenPanelIds(state.tree)) };
    case 'arrange-equalize':
      return { ...state, tree: equalizeTree(state.tree) };
    case 'set-all-mode': {
      const allIds = Object.keys(state.panels);
      const panels = { ...state.panels };
      for (const id of allIds) panels[id] = { ...panels[id]!, mode: action.mode };
      if (action.mode === 'floating') return { ...state, panels, tree: null, floatingZOrder: allIds };
      return { ...state, panels, tree: buildMosaic(allIds), floatingZOrder: [] };
    }
    case 'start-floating-drag': {
      const p = state.panels[action.id]; if (!p || p.mode !== 'floating') return state;
      const moved = moveFloatingTop(state, action.id);
      return { ...moved, interaction: { kind: 'drag-floating', id: action.id, offset: { x: action.px - p.x, y: action.py - p.y } } };
    }
    case 'start-tile-drag': {
      const p = state.panels[action.id]; if (!p || p.mode !== 'tiled') return state;
      return { ...state, interaction: { kind: 'drag-tiled', id: action.id, targetLeafId: null, targetZone: null } };
    }
    case 'start-floating-resize': {
      const p = state.panels[action.id]; if (!p || p.mode !== 'floating') return state;
      const moved = moveFloatingTop(state, action.id);
      return { ...moved, interaction: { kind: 'resize-floating', id: action.id, startSize: { w: p.w, h: p.h }, startPointer: { x: action.px, y: action.py } } };
    }
    case 'start-divider-resize': {
      const c = findContainer(state.tree, action.containerId); if (!c) return state;
      return {
        ...state,
        interaction: {
          kind: 'divider-resize', containerId: action.containerId, dividerIdx: action.dividerIdx,
          startSizes: [...c.sizes], startPointer: c.dir === 'row' ? action.px : action.py,
          containerLength: action.containerLengthPx,
        },
      };
    }
    case 'apply-move': {
      const inter = state.interaction; if (!inter) return state;
      const viewport = getViewport();
      if (inter.kind === 'drag-floating') {
        const p = state.panels[inter.id]; if (!p) return state;
        const moved = { ...p, x: action.px - inter.offset.x, y: action.py - inter.offset.y };
        const clamped = clampPanelToViewport(moved, viewport);
        const others = Object.values(state.panels).filter((x) => x.id !== inter.id && x.mode === 'floating');
        const snapped = snapFloating(clamped, viewport, others);
        return { ...state, panels: { ...state.panels, [inter.id]: snapped } };
      }
      if (inter.kind === 'resize-floating') {
        const p = state.panels[inter.id]; if (!p) return state;
        const dx = action.px - inter.startPointer.x;
        const dy = action.py - inter.startPointer.y;
        const sized = clampResize(inter.startSize.w + dx, inter.startSize.h + dy, { x: p.x, y: p.y }, viewport);
        return { ...state, panels: { ...state.panels, [inter.id]: { ...p, ...sized } } };
      }
      if (inter.kind === 'divider-resize') {
        const c = findContainer(state.tree, inter.containerId); if (!c) return state;
        const delta = (c.dir === 'row' ? action.px : action.py) - inter.startPointer;
        const next = resizeContainerDivider(inter.startSizes, inter.dividerIdx, delta, inter.containerLength);
        return { ...state, tree: setContainerSizes(state.tree!, inter.containerId, next) };
      }
      return state;
    }
    case 'set-tile-drop-target': {
      const inter = state.interaction;
      if (inter?.kind !== 'drag-tiled') return state;
      if (inter.targetLeafId === action.leafId && inter.targetZone === action.zone) return state;
      return { ...state, interaction: { ...inter, targetLeafId: action.leafId, targetZone: action.zone } };
    }
    case 'pointer-up':
      return { ...state, interaction: null };
    case 'set-cursor': {
      if (state.cursor.x === action.x && state.cursor.y === action.y && state.cursor.overPanelId === action.overPanelId) return state;
      return { ...state, cursor: { x: action.x, y: action.y, overPanelId: action.overPanelId } };
    }
    case 'reset':
      return emptySnapshot();
    case 'load-layout': {
      const layout = readPersistedLayout();
      if (!layout) return state;
      const validIds = new Set(Object.keys(layout.panels));
      return {
        ...emptySnapshot(),
        panels: layout.panels,
        tree: layout.tree,
        floatingZOrder: layout.floatingZOrder.filter((id) => validIds.has(id)),
        focused: validIds.has(layout.focused ?? '') ? layout.focused : null,
      };
    }
  }
}

export const rxjsFactory: EngineFactory = {
  meta: {
    id: 'rxjs',
    label: 'RxJS',
    description: 'Subject + scan reducer; throttleTime(16) for pointer-move; debounceTime(1000) for persist.',
    sourcePath: 'floating-workspace/src/engines/rxjs.ts',
  },
  create(): Engine {
    const pendingResolvers = new Map<string, (r: unknown) => void>();
    const openResolvers = new Map<number, (id: string | null) => void>();
    let openReqIdCounter = 0;

    const action$ = new Subject<Action>();
    const move$ = new Subject<{ px: number; py: number }>();
    const state$ = new BehaviorSubject<WS>(emptySnapshot());
    const subs = new Set<(s: WS) => void>();

    const subscription = new Subscription();

    // Throttled pointer-move stream → apply-move action
    const throttledMove$ = move$.pipe(
      throttleTime(POINTER_THROTTLE_MS, undefined, { leading: true, trailing: true }),
      map<{ px: number; py: number }, Action>(({ px, py }) => ({ type: 'apply-move', px, py })),
    );

    // Merged action stream → scan reducer → BehaviorSubject
    subscription.add(
      merge(action$, throttledMove$).pipe(
        scan<Action, WS>((acc, a) => reduce(acc, a, openResolvers, pendingResolvers), emptySnapshot()),
        share(),
      ).subscribe((s) => state$.next(s)),
    );

    // Fan-out to UI subscribers
    subscription.add(state$.subscribe((s) => { for (const cb of subs) cb(s); }));

    // Persist on debounced state change
    subscription.add(
      state$.pipe(
        debounceTime(PERSIST_DEBOUNCE_MS),
        distinctUntilChanged(),
      ).subscribe((s) => persistLayout(s)),
    );

    // Clear persistence on reset
    subscription.add(
      action$.pipe(filter((a) => a.type === 'reset'), tap(() => clearPersistedLayout())).subscribe(),
    );

    return {
      snapshot: () => state$.value,
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },
      openPanel(kind, opts) {
        const reqId = ++openReqIdCounter;
        let id: string | null = null;
        openResolvers.set(reqId, (x) => { id = x; });
        action$.next({ type: 'open-panel', kind, opts, reqId });
        return id;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, () => resolve());
          action$.next({ type: 'open-modal', spec: { kind: 'alert', id, title, body } });
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(Boolean(r)));
          action$.next({ type: 'open-modal', spec: { kind: 'confirm', id, title, body } });
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          pendingResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          action$.next({ type: 'open-modal', spec: { kind: 'command-palette', id, query: '', commands } });
        });
      },
      close: (id, result) => action$.next({ type: 'close', id, result }),
      focus: (id) => action$.next({ type: 'focus', id }),
      setBody: (id, body) => action$.next({ type: 'set-body', id, body }),
      setInspectorMode: (id, mode) => action$.next({ type: 'set-inspector-mode', id, mode }),
      setQuery: (q) => action$.next({ type: 'set-query', q }),
      setPanelMode: (id, mode) => action$.next({ type: 'set-panel-mode', id, mode }),
      splitTile: (srcId, targetId, edge) => action$.next({ type: 'split-tile', srcId, targetId, edge }),
      arrangeCascadeFloating: () => action$.next({ type: 'arrange-cascade-floating' }),
      arrangeMosaicTiled: () => action$.next({ type: 'arrange-mosaic-tiled' }),
      arrangeRows: () => action$.next({ type: 'arrange-rows' }),
      arrangeColumns: () => action$.next({ type: 'arrange-columns' }),
      arrangeEqualizeTiles: () => action$.next({ type: 'arrange-equalize' }),
      setAllPanelsMode: (mode) => action$.next({ type: 'set-all-mode', mode }),
      startFloatingDrag: (id, px, py) => action$.next({ type: 'start-floating-drag', id, px, py }),
      startTileDrag: (id) => action$.next({ type: 'start-tile-drag', id }),
      startFloatingResize: (id, px, py) => action$.next({ type: 'start-floating-resize', id, px, py }),
      startDividerResize: (containerId, dividerIdx, px, py, containerLengthPx) =>
        action$.next({ type: 'start-divider-resize', containerId, dividerIdx, px, py, containerLengthPx }),
      pointerMove(px, py) {
        if (!state$.value.interaction) return;
        move$.next({ px, py });
      },
      setTileDropTarget: (leafId, zone) => action$.next({ type: 'set-tile-drop-target', leafId, zone }),
      pointerUp() {
        const s = state$.value;
        const inter = s.interaction;
        if (!inter) return;
        if (inter.kind === 'drag-tiled' && inter.targetLeafId && inter.targetZone) {
          const targetPanelId = findByNode(s.tree, inter.targetLeafId);
          if (targetPanelId && targetPanelId !== inter.id) {
            const edge = inter.targetZone === 'center' ? 'right' : inter.targetZone;
            action$.next({ type: 'split-tile', srcId: inter.id, targetId: targetPanelId, edge });
            return;
          }
        }
        action$.next({ type: 'pointer-up' });
      },
      setCursor: (x, y, overPanelId) => action$.next({ type: 'set-cursor', x, y, overPanelId }),
      onKey({ key, meta, ctrl }) {
        const mod = meta || ctrl;
        const s = state$.value;
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
      loadLayout: () => action$.next({ type: 'load-layout' }),
      reset() {
        for (const [, r] of pendingResolvers) r(undefined);
        pendingResolvers.clear();
        action$.next({ type: 'reset' });
      },
      dispose() {
        subscription.unsubscribe();
        action$.complete();
        move$.complete();
        state$.complete();
        subs.clear();
        pendingResolvers.clear();
      },
    };
  },
};
