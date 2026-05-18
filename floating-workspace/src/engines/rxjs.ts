// RxJS — single `Subject<Action>` upstream feeds a `scan` reducer. Pointer
// moves go through a parallel branch with `throttleTime(16)` then merge back
// in. Persist runs on `state$.pipe(debounceTime(1000))`. Drag-as-stream
// shape is rxjs's home turf.

import {
  BehaviorSubject, Subject, Subscription, merge,
} from 'rxjs';
import {
  debounceTime, distinctUntilChanged, filter, map, scan, share, tap, throttleTime, withLatestFrom,
} from 'rxjs/operators';
import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS, MAX_PANELS, PERSIST_DEBOUNCE_MS, POINTER_THROTTLE_MS,
  clampPanelToViewport, clampResize, clearPersistedLayout, defaultBody, defaultPanelLayout,
  defaultTitle, emptySnapshot, genId, getViewport, persistLayout, readPersistedLayout, snapToEdges,
} from '../scenario';
import type {
  FloatingPanel, ModalSpec, PanelKind, Unsubscribe, WorkspaceSnapshot,
} from '../types';

type Action =
  | { type: 'open-panel'; kind: PanelKind; opts?: { title?: string; body?: string }; reqId: number }
  | { type: 'open-modal'; spec: ModalSpec }
  | { type: 'close'; id: string; result?: unknown }
  | { type: 'focus'; id: string }
  | { type: 'set-query'; q: string }
  | { type: 'set-body'; id: string; body: string }
  | { type: 'start-drag'; id: string; px: number; py: number }
  | { type: 'start-resize'; id: string; px: number; py: number }
  | { type: 'pointer-move'; px: number; py: number }
  | { type: 'pointer-up' }
  | { type: 'reset' }
  | { type: 'load-layout' };

function moveTop(z: readonly string[], id: string): string[] {
  return [...z.filter((x) => x !== id), id];
}

function reduce(state: WorkspaceSnapshot, a: Action, openResolvers: Map<number, (id: string | null) => void>, modalResolvers: Map<string, (r: unknown) => void>): WorkspaceSnapshot {
  switch (a.type) {
    case 'open-panel': {
      const resolver = openResolvers.get(a.reqId);
      openResolvers.delete(a.reqId);
      if (Object.keys(state.panels).length >= MAX_PANELS) { resolver?.(null); return state; }
      const id = genId('panel');
      const panel: FloatingPanel = {
        id, kind: a.kind,
        title: a.opts?.title ?? defaultTitle(a.kind),
        body: a.opts?.body ?? defaultBody(a.kind),
        ...defaultPanelLayout(a.kind),
      };
      resolver?.(id);
      return { ...state, panels: { ...state.panels, [id]: panel }, zOrder: [...state.zOrder, id], focused: id };
    }
    case 'open-modal':
      return { ...state, modals: [...state.modals, a.spec] };
    case 'close': {
      if (state.modals.some((m) => m.id === a.id)) {
        const resolver = modalResolvers.get(a.id);
        modalResolvers.delete(a.id);
        resolver?.(a.result);
        return { ...state, modals: state.modals.filter((m) => m.id !== a.id) };
      }
      if (state.panels[a.id]) {
        const { [a.id]: _drop, ...rest } = state.panels;
        void _drop;
        const zOrder = state.zOrder.filter((x) => x !== a.id);
        return {
          ...state, panels: rest, zOrder,
          focused: state.focused === a.id ? (zOrder[zOrder.length - 1] ?? null) : state.focused,
        };
      }
      return state;
    }
    case 'focus':
      if (!state.panels[a.id]) return state;
      return { ...state, zOrder: moveTop(state.zOrder, a.id), focused: a.id };
    case 'set-query': {
      const top = state.modals[state.modals.length - 1];
      if (top?.kind !== 'command-palette') return state;
      return { ...state, modals: [...state.modals.slice(0, -1), { ...top, query: a.q }] };
    }
    case 'set-body': {
      const panel = state.panels[a.id];
      if (!panel) return state;
      return { ...state, panels: { ...state.panels, [a.id]: { ...panel, body: a.body } } };
    }
    case 'start-drag': {
      const panel = state.panels[a.id];
      if (!panel) return state;
      return {
        ...state,
        zOrder: moveTop(state.zOrder, a.id),
        focused: a.id,
        interaction: { kind: 'drag', id: a.id, offset: { x: a.px - panel.x, y: a.py - panel.y } },
      };
    }
    case 'start-resize': {
      const panel = state.panels[a.id];
      if (!panel) return state;
      return {
        ...state,
        zOrder: moveTop(state.zOrder, a.id),
        focused: a.id,
        interaction: {
          kind: 'resize', id: a.id,
          startSize: { w: panel.w, h: panel.h },
          startPointer: { x: a.px, y: a.py },
        },
      };
    }
    case 'pointer-move': {
      const inter = state.interaction;
      if (!inter) return state;
      const panel = state.panels[inter.id];
      if (!panel) return state;
      const viewport = getViewport();
      if (inter.kind === 'drag') {
        const moved = { ...panel, x: a.px - inter.offset.x, y: a.py - inter.offset.y };
        const snapped = snapToEdges(clampPanelToViewport(moved, viewport), viewport);
        return { ...state, panels: { ...state.panels, [inter.id]: snapped } };
      }
      const dx = a.px - inter.startPointer.x;
      const dy = a.py - inter.startPointer.y;
      const sized = clampResize(
        inter.startSize.w + dx, inter.startSize.h + dy,
        { x: panel.x, y: panel.y }, viewport,
      );
      return { ...state, panels: { ...state.panels, [inter.id]: { ...panel, ...sized } } };
    }
    case 'pointer-up':
      return { ...state, interaction: null };
    case 'reset':
      return emptySnapshot();
    case 'load-layout': {
      const layout = readPersistedLayout();
      if (!layout) return state;
      const surviving = layout.zOrder.filter((id) => layout.panels[id]);
      return {
        ...emptySnapshot(),
        panels: layout.panels,
        zOrder: surviving,
        focused: surviving.includes(layout.focused ?? '') ? layout.focused : (surviving[surviving.length - 1] ?? null),
      };
    }
  }
}

export const rxjsFactory: EngineFactory = {
  meta: {
    id: 'rxjs',
    label: 'RxJS',
    description: 'Subject<Action> + scan reducer; throttleTime for drag, debounceTime for persist.',
    sourcePath: 'floating-workspace/src/engines/rxjs.ts',
  },
  create(): Engine {
    const actions$ = new Subject<Action>();
    const modalResolvers = new Map<string, (r: unknown) => void>();
    const openResolvers = new Map<number, (id: string | null) => void>();
    let openReqIdCounter = 0;
    let handledKey = false;

    // Pointer moves are throttled to 16ms; all other actions flow through immediately.
    const moves$ = actions$.pipe(
      filter((a): a is Extract<Action, { type: 'pointer-move' }> => a.type === 'pointer-move'),
      throttleTime(POINTER_THROTTLE_MS, undefined, { leading: true, trailing: true }),
    );
    const others$ = actions$.pipe(filter((a) => a.type !== 'pointer-move'));
    const merged$ = merge(others$, moves$);

    const state$ = merged$.pipe(
      scan((s: WorkspaceSnapshot, a) => reduce(s, a, openResolvers, modalResolvers), emptySnapshot()),
      share({ resetOnRefCountZero: false }),
    );

    const snapshot$ = new BehaviorSubject<WorkspaceSnapshot>(emptySnapshot());
    const subscription = new Subscription();
    subscription.add(state$.pipe(distinctUntilChanged()).subscribe((s) => snapshot$.next(s)));

    // Persist on every change, debounced
    subscription.add(
      snapshot$.pipe(
        // Skip initial empty snapshot
        filter((s) => Object.keys(s.panels).length > 0 || s.modals.length > 0),
        debounceTime(PERSIST_DEBOUNCE_MS),
        tap((s) => persistLayout(s)),
      ).subscribe(),
    );

    // Reset clears storage
    subscription.add(
      actions$.pipe(filter((a) => a.type === 'reset'), tap(() => clearPersistedLayout())).subscribe(),
    );

    // Flush persist on pointer-up so drag-end is durable.
    subscription.add(
      actions$.pipe(
        filter((a) => a.type === 'pointer-up'),
        withLatestFrom(snapshot$),
        map(([, s]) => s),
        tap((s) => persistLayout(s)),
      ).subscribe(),
    );

    const subs = new Set<(s: WorkspaceSnapshot) => void>();
    subscription.add(snapshot$.subscribe((s) => { for (const cb of subs) cb(s); }));

    return {
      snapshot: () => snapshot$.getValue(),
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },

      openPanel(kind, opts) {
        const reqId = ++openReqIdCounter;
        let id: string | null = null;
        openResolvers.set(reqId, (x) => { id = x; });
        actions$.next({ type: 'open-panel', kind, opts, reqId });
        return id;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, () => resolve());
          actions$.next({ type: 'open-modal', spec: { kind: 'alert', id, title, body } });
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, (r) => resolve(Boolean(r)));
          actions$.next({ type: 'open-modal', spec: { kind: 'confirm', id, title, body } });
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          actions$.next({ type: 'open-modal', spec: { kind: 'command-palette', id, query: '', commands } });
        });
      },
      close: (id, result) => actions$.next({ type: 'close', id, result }),
      focus: (id) => actions$.next({ type: 'focus', id }),
      setQuery: (q) => actions$.next({ type: 'set-query', q }),
      setBody: (id, body) => actions$.next({ type: 'set-body', id, body }),
      startDrag: (id, px, py) => actions$.next({ type: 'start-drag', id, px, py }),
      startResize: (id, px, py) => actions$.next({ type: 'start-resize', id, px, py }),
      pointerMove: (px, py) => actions$.next({ type: 'pointer-move', px, py }),
      pointerUp: () => actions$.next({ type: 'pointer-up' }),
      onKey({ key, meta, ctrl }) {
        handledKey = false;
        const mod = meta || ctrl;
        const s = snapshot$.getValue();
        if (mod && (key === 'k' || key === 'K')) {
          actions$.next({ type: 'open-modal', spec: { kind: 'command-palette', id: genId('modal'), query: '', commands: COMMAND_PALETTE_COMMANDS } });
          handledKey = true;
        } else if (key === 'Escape') {
          const top = s.modals[s.modals.length - 1];
          if (top) {
            actions$.next({ type: 'close', id: top.id, result: top.kind === 'confirm' ? false : top.kind === 'command-palette' ? null : undefined });
            handledKey = true;
          } else if (s.focused) {
            actions$.next({ type: 'close', id: s.focused });
            handledKey = true;
          }
        } else if (mod && (key === 'w' || key === 'W') && s.modals.length === 0 && s.focused) {
          actions$.next({ type: 'close', id: s.focused });
          handledKey = true;
        }
        return handledKey;
      },
      loadLayout: () => actions$.next({ type: 'load-layout' }),
      reset: () => {
        for (const [, r] of modalResolvers) r(undefined);
        modalResolvers.clear();
        actions$.next({ type: 'reset' });
      },
      dispose: () => { subscription.unsubscribe(); subs.clear(); modalResolvers.clear(); },
    };
  },
};
