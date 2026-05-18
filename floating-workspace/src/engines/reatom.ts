// Reatom — single `workspaceAtom` holds the snapshot; one big mutator
// action does state transitions. Pointer-move throttle + persist debounce
// are hand-rolled (`lastMoveTime` + `setTimeout`).

import { action, atom, createCtx } from '@reatom/core';
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

export const reatomFactory: EngineFactory = {
  meta: {
    id: 'reatom',
    label: 'Reatom',
    description: 'Atoms + actions, ctx-scoped; hand-rolled throttle + debounce timers.',
    sourcePath: 'floating-workspace/src/engines/reatom.ts',
  },
  create(): Engine {
    const ctx = createCtx();
    const workspaceAtom = atom<WorkspaceSnapshot>(emptySnapshot(), 'workspace');
    const modalResolvers = new Map<string, (r: unknown) => void>();
    let lastMoveTime = 0;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let handledKey = false;

    const schedulePersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistLayout(ctx.get(workspaceAtom));
      }, PERSIST_DEBOUNCE_MS);
    };
    const flushPersistNow = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      persistLayout(ctx.get(workspaceAtom));
    };

    const mutate = action((c, fn: (s: WorkspaceSnapshot) => WorkspaceSnapshot) => {
      workspaceAtom(c, fn(c.get(workspaceAtom)));
    }, 'mutate');

    const subs = new Set<(s: WorkspaceSnapshot) => void>();
    ctx.subscribe(workspaceAtom, (snap) => { for (const cb of subs) cb(snap); });

    return {
      snapshot: () => ctx.get(workspaceAtom),
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },

      openPanel(kind, opts) {
        const cur = ctx.get(workspaceAtom);
        if (Object.keys(cur.panels).length >= MAX_PANELS) return null;
        const id = genId('panel');
        const panel: FloatingPanel = {
          id, kind,
          title: opts?.title ?? defaultTitle(kind),
          body: opts?.body ?? defaultBody(kind),
          ...defaultPanelLayout(kind),
        };
        mutate(ctx, (s) => ({ ...s, panels: { ...s.panels, [id]: panel }, zOrder: [...s.zOrder, id], focused: id }));
        schedulePersist();
        return id;
      },
      alert(title, body) {
        return new Promise<void>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, () => resolve());
          mutate(ctx, (s) => ({ ...s, modals: [...s.modals, { kind: 'alert', id, title, body }] }));
        });
      },
      confirm(title, body) {
        return new Promise<boolean>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, (r) => resolve(Boolean(r)));
          mutate(ctx, (s) => ({ ...s, modals: [...s.modals, { kind: 'confirm', id, title, body }] }));
        });
      },
      openCommandPalette(commands) {
        return new Promise<string | null>((resolve) => {
          const id = genId('modal');
          modalResolvers.set(id, (r) => resolve(typeof r === 'string' ? r : null));
          mutate(ctx, (s) => ({ ...s, modals: [...s.modals, { kind: 'command-palette', id, query: '', commands }] }));
        });
      },
      close(id, result) {
        const cur = ctx.get(workspaceAtom);
        if (cur.modals.some((m) => m.id === id)) {
          const resolver = modalResolvers.get(id);
          modalResolvers.delete(id);
          mutate(ctx, (s) => ({ ...s, modals: s.modals.filter((m) => m.id !== id) }));
          resolver?.(result);
          return;
        }
        if (cur.panels[id]) {
          mutate(ctx, (s) => {
            const { [id]: _drop, ...rest } = s.panels;
            void _drop;
            const zOrder = s.zOrder.filter((x) => x !== id);
            return { ...s, panels: rest, zOrder, focused: s.focused === id ? (zOrder[zOrder.length - 1] ?? null) : s.focused };
          });
          schedulePersist();
        }
      },
      focus(id) {
        const cur = ctx.get(workspaceAtom);
        const panel = cur.panels[id];
        if (!panel) return;
        if (panel.dock !== null) {
          mutate(ctx, (s) => ({ ...s, focused: id }));
          return;
        }
        mutate(ctx, (s) => ({ ...s, zOrder: moveTop(s.zOrder, id), focused: id }));
        schedulePersist();
      },
      dock(id, anchor) {
        mutate(ctx, (s) => {
          const panel = s.panels[id];
          if (!panel) return s;
          const existing = panelInDock(s.panels, anchor);
          let panels = s.panels;
          let zOrder = s.zOrder;
          if (existing && existing.id !== id) {
            const restored: FloatingPanel = { ...existing, dock: null, x: 80, y: 80 };
            panels = { ...panels, [restored.id]: restored };
            if (!zOrder.includes(restored.id)) zOrder = [...zOrder, restored.id];
          }
          panels = { ...panels, [id]: { ...panel, dock: anchor } };
          zOrder = zOrder.filter((x) => x !== id);
          return { ...s, panels, zOrder, focused: id };
        });
        schedulePersist();
      },
      undock(id) {
        mutate(ctx, (s) => {
          const panel = s.panels[id];
          if (!panel || panel.dock === null) return s;
          const floating = { ...panel, dock: null, x: panel.x || 96, y: panel.y || 96 };
          return {
            ...s,
            panels: { ...s.panels, [id]: floating },
            zOrder: s.zOrder.includes(id) ? s.zOrder : [...s.zOrder, id],
            focused: id,
          };
        });
        schedulePersist();
      },
      setQuery(q) {
        mutate(ctx, (s) => {
          const top = s.modals[s.modals.length - 1];
          if (top?.kind !== 'command-palette') return s;
          return { ...s, modals: [...s.modals.slice(0, -1), { ...top, query: q }] };
        });
      },
      setBody(id, body) {
        const cur = ctx.get(workspaceAtom);
        const panel = cur.panels[id];
        if (!panel) return;
        mutate(ctx, (s) => ({ ...s, panels: { ...s.panels, [id]: { ...panel, body } } }));
        schedulePersist();
      },
      startDrag(id, px, py) {
        const cur = ctx.get(workspaceAtom);
        const panel = cur.panels[id];
        if (!panel || panel.dock !== null) return;
        mutate(ctx, (s) => ({
          ...s, zOrder: moveTop(s.zOrder, id), focused: id,
          interaction: { kind: 'drag', id, offset: { x: px - panel.x, y: py - panel.y } },
        }));
      },
      startResize(id, px, py) {
        const cur = ctx.get(workspaceAtom);
        const panel = cur.panels[id];
        if (!panel || panel.dock !== null) return;
        mutate(ctx, (s) => ({
          ...s, zOrder: moveTop(s.zOrder, id), focused: id,
          interaction: { kind: 'resize', id, startSize: { w: panel.w, h: panel.h }, startPointer: { x: px, y: py } },
        }));
      },
      startDockResize(anchor, px, py) {
        mutate(ctx, (s) => ({
          ...s,
          interaction: {
            kind: 'dock-resize', anchor,
            startSize: s.dockSizes[anchor],
            startPointer: anchor === 'bottom' ? py : px,
          },
        }));
      },
      pointerMove(px, py) {
        const cur = ctx.get(workspaceAtom);
        if (!cur.interaction) return;
        const now = performance.now();
        if (now - lastMoveTime < POINTER_THROTTLE_MS) return;
        lastMoveTime = now;
        mutate(ctx, (s) => {
          const inter = s.interaction;
          if (!inter) return s;
          const viewport = getViewport();
          if (inter.kind === 'dock-resize') {
            const cur = inter.anchor === 'bottom' ? py : px;
            let delta = cur - inter.startPointer;
            if (inter.anchor === 'right' || inter.anchor === 'bottom') delta = -delta;
            const size = clampDockSize(inter.anchor, inter.startSize + delta, viewport);
            return { ...s, dockSizes: { ...s.dockSizes, [inter.anchor]: size } };
          }
          const panel = s.panels[inter.id];
          if (!panel) return s;
          if (inter.kind === 'drag') {
            const moved = { ...panel, x: px - inter.offset.x, y: py - inter.offset.y };
            const snapped = snapToEdges(clampPanelToViewport(moved, viewport), viewport);
            return { ...s, panels: { ...s.panels, [inter.id]: snapped } };
          }
          const dx = px - inter.startPointer.x;
          const dy = py - inter.startPointer.y;
          const sized = clampResize(inter.startSize.w + dx, inter.startSize.h + dy, { x: panel.x, y: panel.y }, viewport);
          return { ...s, panels: { ...s.panels, [inter.id]: { ...panel, ...sized } } };
        });
      },
      pointerUp() {
        const cur = ctx.get(workspaceAtom);
        if (!cur.interaction) return;
        mutate(ctx, (s) => ({ ...s, interaction: null }));
        flushPersistNow();
      },
      onKey({ key, meta, ctrl }) {
        handledKey = false;
        const mod = meta || ctrl;
        const s = ctx.get(workspaceAtom);
        if (mod && (key === 'k' || key === 'K')) {
          this.openCommandPalette(COMMAND_PALETTE_COMMANDS);
          handledKey = true;
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
        const surviving = layout.zOrder.filter((id) => layout.panels[id] && layout.panels[id].dock === null);
        mutate(ctx, () => ({
          ...emptySnapshot(),
          panels: layout.panels,
          zOrder: surviving,
          dockSizes: layout.dockSizes ?? emptySnapshot().dockSizes,
          focused: layout.panels[layout.focused ?? ''] ? layout.focused : (surviving[surviving.length - 1] ?? null),
        }));
      },
      reset() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = null;
        for (const [, r] of modalResolvers) r(undefined);
        modalResolvers.clear();
        mutate(ctx, () => emptySnapshot());
        clearPersistedLayout();
      },
      dispose() {
        if (persistTimer) clearTimeout(persistTimer);
        subs.clear();
        modalResolvers.clear();
      },
    };
  },
};
