// Naked baseline — plain JS. Mutable state, Set of subscribers, manual
// timers for pointer throttling and layout persistence. No library.
//
// Every other engine effectively re-implements this with its own primitives;
// reading this file makes the others easier to read by inversion.

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
  filterCommands,
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

export const nakedFactory: EngineFactory = {
  meta: {
    id: 'naked',
    label: 'Naked baseline',
    description: 'Plain JS — mutable state, hand-rolled throttle + debounce.',
    sourcePath: 'floating-workspace/src/engines/naked.ts',
  },
  create(): Engine {
    let state: WorkspaceSnapshot = emptySnapshot();
    const subs = new Set<(s: WorkspaceSnapshot) => void>();
    // Pending modal promise resolvers, keyed by modal id.
    const pendingResolvers = new Map<string, (result: unknown) => void>();
    let lastMoveTime = 0;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const emit = () => {
      for (const cb of subs) cb(state);
    };
    const merge = (patch: Partial<WorkspaceSnapshot>) => {
      state = { ...state, ...patch };
      emit();
    };
    const setPanel = (panel: FloatingPanel) => {
      state = { ...state, panels: { ...state.panels, [panel.id]: panel } };
    };
    const schedulePersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistLayout(state);
      }, PERSIST_DEBOUNCE_MS);
    };
    const flushPersistNow = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      persistLayout(state);
    };

    const moveTop = (id: string) => {
      const rest = state.zOrder.filter((x) => x !== id);
      state = { ...state, zOrder: [...rest, id], focused: id };
    };

    const pushModal = (spec: ModalSpec, resolver: (r: unknown) => void) => {
      pendingResolvers.set(spec.id, resolver);
      state = { ...state, modals: [...state.modals, spec] };
      emit();
    };

    return {
      snapshot: () => state,
      subscribe(cb) {
        subs.add(cb);
        return (() => subs.delete(cb)) as Unsubscribe;
      },

      openPanel(kind: PanelKind, opts) {
        if (Object.keys(state.panels).length >= MAX_PANELS) return null;
        const id = genId('panel');
        const panel: FloatingPanel = {
          id,
          kind,
          title: opts?.title ?? defaultTitle(kind),
          body: opts?.body ?? defaultBody(kind),
          ...defaultPanelLayout(kind),
        };
        setPanel(panel);
        state = { ...state, zOrder: [...state.zOrder, id], focused: id };
        emit();
        schedulePersist();
        return id;
      },

      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          pushModal({ kind: 'alert', id, title, body }, () => resolve());
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          pushModal({ kind: 'confirm', id, title, body }, (r) => resolve(Boolean(r)));
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          pushModal(
            { kind: 'command-palette', id, query: '', commands },
            (r) => resolve(typeof r === 'string' ? r : null),
          );
        });
      },

      close(id, result) {
        // Modal?
        const modalIdx = state.modals.findIndex((m) => m.id === id);
        if (modalIdx >= 0) {
          const resolver = pendingResolvers.get(id);
          pendingResolvers.delete(id);
          state = { ...state, modals: state.modals.filter((m) => m.id !== id) };
          emit();
          resolver?.(result);
          return;
        }
        // Floating panel
        if (state.panels[id]) {
          const { [id]: _, ...rest } = state.panels;
          void _;
          const zOrder = state.zOrder.filter((x) => x !== id);
          const focused = state.focused === id ? (zOrder[zOrder.length - 1] ?? null) : state.focused;
          state = { ...state, panels: rest, zOrder, focused };
          emit();
          schedulePersist();
        }
      },

      focus(id) {
        if (!state.panels[id]) return;
        if (state.focused === id && state.zOrder[state.zOrder.length - 1] === id) return;
        moveTop(id);
        emit();
        schedulePersist();
      },

      setQuery(q) {
        const top = state.modals[state.modals.length - 1];
        if (!top || top.kind !== 'command-palette') return;
        state = {
          ...state,
          modals: [...state.modals.slice(0, -1), { ...top, query: q }],
        };
        emit();
      },

      setBody(id, body) {
        const panel = state.panels[id];
        if (!panel) return;
        setPanel({ ...panel, body });
        emit();
        schedulePersist();
      },

      startDrag(id, px, py) {
        const panel = state.panels[id];
        if (!panel) return;
        moveTop(id);
        state = {
          ...state,
          interaction: { kind: 'drag', id, offset: { x: px - panel.x, y: py - panel.y } },
        };
        emit();
      },

      startResize(id, px, py) {
        const panel = state.panels[id];
        if (!panel) return;
        moveTop(id);
        state = {
          ...state,
          interaction: {
            kind: 'resize',
            id,
            startSize: { w: panel.w, h: panel.h },
            startPointer: { x: px, y: py },
          },
        };
        emit();
      },

      pointerMove(px, py) {
        if (!state.interaction) return;
        const now = performance.now();
        if (now - lastMoveTime < POINTER_THROTTLE_MS) return;
        lastMoveTime = now;
        const viewport = getViewport();
        const inter = state.interaction;
        const panel = state.panels[inter.id];
        if (!panel) return;
        if (inter.kind === 'drag') {
          const moved = { ...panel, x: px - inter.offset.x, y: py - inter.offset.y };
          const clamped = clampPanelToViewport(moved, viewport);
          const snapped = snapToEdges(clamped, viewport);
          setPanel(snapped);
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
      },

      pointerUp() {
        if (!state.interaction) return;
        state = { ...state, interaction: null };
        emit();
        flushPersistNow();
      },

      onKey({ key, meta, ctrl }) {
        const mod = meta || ctrl;
        // Command palette
        if (mod && (key === 'k' || key === 'K')) {
          this.openCommandPalette(COMMAND_PALETTE_COMMANDS);
          return true;
        }
        // Close
        if (key === 'Escape') {
          const topModal = state.modals[state.modals.length - 1];
          if (topModal) {
            this.close(topModal.id, topModal.kind === 'confirm' ? false : topModal.kind === 'command-palette' ? null : undefined);
            return true;
          }
          if (state.focused) {
            this.close(state.focused);
            return true;
          }
          return false;
        }
        if (mod && (key === 'w' || key === 'W') && state.modals.length === 0 && state.focused) {
          this.close(state.focused);
          return true;
        }
        return false;
      },

      loadLayout() {
        const layout = readPersistedLayout();
        if (!layout) return;
        // Drop any panel ids not present in `panels`; preserve focused if it survives.
        const surviving = layout.zOrder.filter((id) => layout.panels[id]);
        state = {
          ...emptySnapshot(),
          panels: layout.panels,
          zOrder: surviving,
          focused: surviving.includes(layout.focused ?? '') ? layout.focused : (surviving[surviving.length - 1] ?? null),
        };
        emit();
      },

      reset() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = null;
        // Resolve any pending modal promises so callers don't hang.
        for (const [id, resolver] of pendingResolvers) {
          void id;
          resolver(undefined);
        }
        pendingResolvers.clear();
        state = emptySnapshot();
        emit();
        clearPersistedLayout();
      },

      dispose() {
        if (persistTimer) clearTimeout(persistTimer);
        subs.clear();
        pendingResolvers.clear();
      },
    };
  },
};
