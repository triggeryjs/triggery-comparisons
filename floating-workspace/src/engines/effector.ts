// Effector — events + a single `$workspace` store. Each input is an event;
// the store `.on()`s them. Pointer-move throttle and persist debounce are
// hand-rolled (patronum intentionally excluded for apples-to-apples).

import { createEvent, createStore } from 'effector';
import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS, MAX_PANELS, PERSIST_DEBOUNCE_MS, POINTER_THROTTLE_MS,
  clampDockSize, clampPanelToViewport, clampResize, clearPersistedLayout, defaultBody, defaultPanelLayout,
  defaultTitle, emptySnapshot, genId, getViewport, panelInDock, persistLayout, readPersistedLayout, snapToEdges,
} from '../scenario';
import type {
  DockAnchor, FloatingPanel, ModalSpec, PanelKind, Unsubscribe, WorkspaceSnapshot,
} from '../types';

function moveTop(z: readonly string[], id: string): string[] {
  return [...z.filter((x) => x !== id), id];
}

export const effectorFactory: EngineFactory = {
  meta: {
    id: 'effector',
    label: 'Effector',
    description: 'Events + one $workspace store; hand-rolled throttle + debounce.',
    sourcePath: 'floating-workspace/src/engines/effector.ts',
  },
  create(): Engine {
    const modalResolvers = new Map<string, (r: unknown) => void>();
    let lastMoveTime = 0;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let handledKey = false;

    const openPanel = createEvent<{ kind: PanelKind; opts?: { title?: string; body?: string }; reqId: number }>();
    const openModal = createEvent<{ spec: ModalSpec }>();
    const closeWindow = createEvent<{ id: string; result?: unknown }>();
    const focusPanel = createEvent<{ id: string }>();
    const setQueryEv = createEvent<{ q: string }>();
    const setBodyEv = createEvent<{ id: string; body: string }>();
    const startDragEv = createEvent<{ id: string; px: number; py: number }>();
    const startResizeEv = createEvent<{ id: string; px: number; py: number }>();
    const startDockResizeEv = createEvent<{ anchor: DockAnchor; px: number; py: number }>();
    const dockEv = createEvent<{ id: string; anchor: DockAnchor }>();
    const undockEv = createEvent<{ id: string }>();
    const applyMoveEv = createEvent<{ px: number; py: number }>();
    const pointerUpEv = createEvent();
    const resetEv = createEvent();
    const loadLayoutEv = createEvent();

    const openResolvers = new Map<number, (id: string | null) => void>();

    const $workspace = createStore<WorkspaceSnapshot>(emptySnapshot())
      .on(openPanel, (s, p) => {
        const resolver = openResolvers.get(p.reqId);
        openResolvers.delete(p.reqId);
        if (Object.keys(s.panels).length >= MAX_PANELS) { resolver?.(null); return s; }
        const id = genId('panel');
        const panel: FloatingPanel = {
          id, kind: p.kind,
          title: p.opts?.title ?? defaultTitle(p.kind),
          body: p.opts?.body ?? defaultBody(p.kind),
          ...defaultPanelLayout(p.kind),
        };
        resolver?.(id);
        return { ...s, panels: { ...s.panels, [id]: panel }, zOrder: [...s.zOrder, id], focused: id };
      })
      .on(openModal, (s, p) => ({ ...s, modals: [...s.modals, p.spec] }))
      .on(closeWindow, (s, p) => {
        if (s.modals.some((m) => m.id === p.id)) {
          const resolver = modalResolvers.get(p.id);
          modalResolvers.delete(p.id);
          resolver?.(p.result);
          return { ...s, modals: s.modals.filter((m) => m.id !== p.id) };
        }
        if (s.panels[p.id]) {
          const { [p.id]: _drop, ...rest } = s.panels;
          void _drop;
          const zOrder = s.zOrder.filter((x) => x !== p.id);
          return { ...s, panels: rest, zOrder, focused: s.focused === p.id ? (zOrder[zOrder.length - 1] ?? null) : s.focused };
        }
        return s;
      })
      .on(focusPanel, (s, p) => {
        const panel = s.panels[p.id];
        if (!panel) return s;
        if (panel.dock !== null) return { ...s, focused: p.id };
        return { ...s, zOrder: moveTop(s.zOrder, p.id), focused: p.id };
      })
      .on(setQueryEv, (s, p) => {
        const top = s.modals[s.modals.length - 1];
        if (top?.kind !== 'command-palette') return s;
        return { ...s, modals: [...s.modals.slice(0, -1), { ...top, query: p.q }] };
      })
      .on(setBodyEv, (s, p) => {
        const panel = s.panels[p.id];
        if (!panel) return s;
        return { ...s, panels: { ...s.panels, [p.id]: { ...panel, body: p.body } } };
      })
      .on(startDragEv, (s, p) => {
        const panel = s.panels[p.id];
        if (!panel || panel.dock !== null) return s;
        return {
          ...s, zOrder: moveTop(s.zOrder, p.id), focused: p.id,
          interaction: { kind: 'drag', id: p.id, offset: { x: p.px - panel.x, y: p.py - panel.y } },
        };
      })
      .on(startResizeEv, (s, p) => {
        const panel = s.panels[p.id];
        if (!panel || panel.dock !== null) return s;
        return {
          ...s, zOrder: moveTop(s.zOrder, p.id), focused: p.id,
          interaction: { kind: 'resize', id: p.id, startSize: { w: panel.w, h: panel.h }, startPointer: { x: p.px, y: p.py } },
        };
      })
      .on(applyMoveEv, (s, p) => {
        const inter = s.interaction;
        if (!inter) return s;
        const viewport = getViewport();
        if (inter.kind === 'dock-resize') {
          const cur = inter.anchor === 'bottom' ? p.py : p.px;
          let delta = cur - inter.startPointer;
          if (inter.anchor === 'right' || inter.anchor === 'bottom') delta = -delta;
          const size = clampDockSize(inter.anchor, inter.startSize + delta, viewport);
          return { ...s, dockSizes: { ...s.dockSizes, [inter.anchor]: size } };
        }
        const panel = s.panels[inter.id];
        if (!panel) return s;
        if (inter.kind === 'drag') {
          const moved = { ...panel, x: p.px - inter.offset.x, y: p.py - inter.offset.y };
          const snapped = snapToEdges(clampPanelToViewport(moved, viewport), viewport);
          return { ...s, panels: { ...s.panels, [inter.id]: snapped } };
        }
        const dx = p.px - inter.startPointer.x;
        const dy = p.py - inter.startPointer.y;
        const sized = clampResize(inter.startSize.w + dx, inter.startSize.h + dy, { x: panel.x, y: panel.y }, viewport);
        return { ...s, panels: { ...s.panels, [inter.id]: { ...panel, ...sized } } };
      })
      .on(startDockResizeEv, (s, p) => ({
        ...s,
        interaction: {
          kind: 'dock-resize', anchor: p.anchor,
          startSize: s.dockSizes[p.anchor],
          startPointer: p.anchor === 'bottom' ? p.py : p.px,
        },
      }))
      .on(dockEv, (s, p) => {
        const panel = s.panels[p.id];
        if (!panel) return s;
        const existing = panelInDock(s.panels, p.anchor);
        let panels = s.panels;
        let zOrder = s.zOrder;
        if (existing && existing.id !== p.id) {
          const restored: FloatingPanel = { ...existing, dock: null, x: 80, y: 80 };
          panels = { ...panels, [restored.id]: restored };
          if (!zOrder.includes(restored.id)) zOrder = [...zOrder, restored.id];
        }
        panels = { ...panels, [p.id]: { ...panel, dock: p.anchor } };
        zOrder = zOrder.filter((x) => x !== p.id);
        return { ...s, panels, zOrder, focused: p.id };
      })
      .on(undockEv, (s, p) => {
        const panel = s.panels[p.id];
        if (!panel || panel.dock === null) return s;
        const floating = { ...panel, dock: null, x: panel.x || 96, y: panel.y || 96 };
        return {
          ...s,
          panels: { ...s.panels, [p.id]: floating },
          zOrder: s.zOrder.includes(p.id) ? s.zOrder : [...s.zOrder, p.id],
          focused: p.id,
        };
      })
      .on(pointerUpEv, (s) => ({ ...s, interaction: null }))
      .on(resetEv, () => emptySnapshot())
      .on(loadLayoutEv, (s) => {
        const layout = readPersistedLayout();
        if (!layout) return s;
        const surviving = layout.zOrder.filter((id) => layout.panels[id] && layout.panels[id].dock === null);
        return {
          ...emptySnapshot(),
          panels: layout.panels,
          zOrder: surviving,
          dockSizes: layout.dockSizes ?? emptySnapshot().dockSizes,
          focused: layout.panels[layout.focused ?? ''] ? layout.focused : (surviving[surviving.length - 1] ?? null),
        };
      });

    const schedulePersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistLayout($workspace.getState());
      }, PERSIST_DEBOUNCE_MS);
    };
    const flushPersistNow = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      persistLayout($workspace.getState());
    };

    // After almost any mutating event, schedule persist
    $workspace.updates.watch(() => schedulePersist());
    pointerUpEv.watch(() => flushPersistNow());
    resetEv.watch(() => clearPersistedLayout());

    const subs = new Set<(s: WorkspaceSnapshot) => void>();
    const unwatch = $workspace.watch((s) => { for (const cb of subs) cb(s); });

    let openReqIdCounter = 0;

    return {
      snapshot: () => $workspace.getState(),
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },
      openPanel(kind, opts) {
        const reqId = ++openReqIdCounter;
        let id: string | null = null;
        openResolvers.set(reqId, (x) => { id = x; });
        openPanel({ kind, opts, reqId });
        return id;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, () => resolve());
          openModal({ spec: { kind: 'alert', id, title, body } });
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, (r) => resolve(Boolean(r)));
          openModal({ spec: { kind: 'confirm', id, title, body } });
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          openModal({ spec: { kind: 'command-palette', id, query: '', commands } });
        });
      },
      close: (id, result) => closeWindow({ id, result }),
      focus: (id) => focusPanel({ id }),
      setQuery: (q) => setQueryEv({ q }),
      setBody: (id, body) => setBodyEv({ id, body }),
      dock: (id, anchor) => dockEv({ id, anchor }),
      undock: (id) => undockEv({ id }),
      startDrag: (id, px, py) => startDragEv({ id, px, py }),
      startResize: (id, px, py) => startResizeEv({ id, px, py }),
      startDockResize: (anchor, px, py) => startDockResizeEv({ anchor, px, py }),
      pointerMove(px, py) {
        const now = performance.now();
        if (now - lastMoveTime < POINTER_THROTTLE_MS) return;
        lastMoveTime = now;
        applyMoveEv({ px, py });
      },
      pointerUp: () => pointerUpEv(),
      onKey({ key, meta, ctrl }) {
        handledKey = false;
        const mod = meta || ctrl;
        const s = $workspace.getState();
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
      loadLayout: () => loadLayoutEv(),
      reset() {
        for (const [, r] of modalResolvers) r(undefined);
        modalResolvers.clear();
        resetEv();
      },
      dispose() {
        unwatch();
        if (persistTimer) clearTimeout(persistTimer);
        subs.clear();
        modalResolvers.clear();
      },
    };
  },
};
