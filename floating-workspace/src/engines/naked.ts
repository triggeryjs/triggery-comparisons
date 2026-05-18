// Naked baseline — plain JS. Mutable state, Set of subscribers, manual
// throttle + debounce, no library. Reference implementation for the other
// engines to mirror.

import type { Engine, EngineFactory } from '../engine';
import {
  COMMAND_PALETTE_COMMANDS,
  MAX_PANELS,
  PERSIST_DEBOUNCE_MS,
  POINTER_THROTTLE_MS,
  appendToTreeRight,
  buildColumn,
  buildMosaic,
  buildRow,
  cascadeFloating,
  clampPanelToViewport,
  clampResize,
  clearPersistedLayout,
  defaultBody,
  defaultFloatingGeometry,
  defaultInspectorMode,
  defaultTitle,
  emptySnapshot,
  equalizeTree,
  findContainer,
  findLeaf,
  flattenPanelIds,
  genId,
  getViewport,
  persistLayout,
  readPersistedLayout,
  removeFromTree,
  resizeContainerDivider,
  setContainerSizes,
  snapFloating,
  splitAt,
} from '../scenario';
import type {
  ModalSpec,
  Panel,
  PanelKind,
  Unsubscribe,
  WorkspaceSnapshot,
} from '../types';

export const nakedFactory: EngineFactory = {
  meta: {
    id: 'naked',
    label: 'Naked baseline',
    description: 'Plain JS — mutable state, recursive tree helpers, hand-rolled timers.',
    sourcePath: 'floating-workspace/src/engines/naked.ts',
  },
  create(): Engine {
    let state: WorkspaceSnapshot = emptySnapshot();
    const subs = new Set<(s: WorkspaceSnapshot) => void>();
    const pendingResolvers = new Map<string, (r: unknown) => void>();
    let lastMoveTime = 0;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const emit = () => { for (const cb of subs) cb(state); };
    const merge = (patch: Partial<WorkspaceSnapshot>) => {
      state = { ...state, ...patch };
      emit();
    };
    const schedulePersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistLayout(state);
      }, PERSIST_DEBOUNCE_MS);
    };
    const flushPersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      persistLayout(state);
    };

    const totalPanels = () => Object.keys(state.panels).length;

    const moveFloatingTop = (id: string) => {
      const rest = state.floatingZOrder.filter((x) => x !== id);
      state = { ...state, floatingZOrder: [...rest, id], focused: id };
    };

    const pushModal = (spec: ModalSpec, resolver: (r: unknown) => void) => {
      pendingResolvers.set(spec.id, resolver);
      merge({ modals: [...state.modals, spec] });
    };

    return {
      snapshot: () => state,
      subscribe(cb) {
        subs.add(cb);
        return (() => subs.delete(cb)) as Unsubscribe;
      },

      openPanel(kind: PanelKind, opts) {
        if (totalPanels() >= MAX_PANELS) return null;
        const id = genId('panel');
        const mode = opts?.mode ?? 'tiled';
        const panel: Panel = {
          id, kind,
          title: opts?.title ?? defaultTitle(kind),
          body: opts?.body ?? defaultBody(kind),
          mode,
          ...defaultFloatingGeometry(kind),
          ...(kind === 'inspector' ? { inspectorMode: defaultInspectorMode() } : {}),
        };
        const panels = { ...state.panels, [id]: panel };
        if (mode === 'tiled') {
          state = {
            ...state, panels,
            tree: appendToTreeRight(state.tree, id),
            focused: id,
          };
        } else {
          state = {
            ...state, panels,
            floatingZOrder: [...state.floatingZOrder, id],
            focused: id,
          };
        }
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
        if (state.modals.some((m) => m.id === id)) {
          const resolver = pendingResolvers.get(id);
          pendingResolvers.delete(id);
          state = { ...state, modals: state.modals.filter((m) => m.id !== id) };
          emit();
          resolver?.(result);
          return;
        }
        // Panel
        if (!state.panels[id]) return;
        const { [id]: _drop, ...rest } = state.panels;
        void _drop;
        const tree = removeFromTree(state.tree, id);
        const floatingZOrder = state.floatingZOrder.filter((x) => x !== id);
        const focused =
          state.focused === id
            ? (floatingZOrder[floatingZOrder.length - 1] ?? null)
            : state.focused;
        state = { ...state, panels: rest, tree, floatingZOrder, focused };
        emit();
        schedulePersist();
      },

      focus(id) {
        const panel = state.panels[id];
        if (!panel) return;
        if (panel.mode === 'floating') {
          moveFloatingTop(id);
        } else {
          state = { ...state, focused: id };
        }
        emit();
      },

      setBody(id, body) {
        const panel = state.panels[id];
        if (!panel) return;
        state = { ...state, panels: { ...state.panels, [id]: { ...panel, body } } };
        emit();
        schedulePersist();
      },

      setInspectorMode(id, mode) {
        const panel = state.panels[id];
        if (!panel || panel.kind !== 'inspector') return;
        state = {
          ...state,
          panels: { ...state.panels, [id]: { ...panel, inspectorMode: mode } },
        };
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

      setPanelMode(id, mode) {
        const panel = state.panels[id];
        if (!panel || panel.mode === mode) return;
        if (mode === 'floating') {
          // Tiled → floating
          const tree = removeFromTree(state.tree, id);
          const updated: Panel = {
            ...panel,
            mode: 'floating',
            x: panel.x || 120,
            y: panel.y || 120,
            w: panel.w || 360,
            h: panel.h || 240,
          };
          state = {
            ...state,
            panels: { ...state.panels, [id]: updated },
            tree,
            floatingZOrder: [...state.floatingZOrder, id],
            focused: id,
          };
        } else {
          // Floating → tiled
          const updated: Panel = { ...panel, mode: 'tiled' };
          state = {
            ...state,
            panels: { ...state.panels, [id]: updated },
            tree: appendToTreeRight(state.tree, id),
            floatingZOrder: state.floatingZOrder.filter((x) => x !== id),
            focused: id,
          };
        }
        emit();
        schedulePersist();
      },

      splitTile(srcId, targetId, edge) {
        const srcPanel = state.panels[srcId];
        const targetLeaf = findLeaf(state.tree, targetId);
        if (!srcPanel || !targetLeaf || srcId === targetId) return;
        // Remove src from wherever it is.
        let tree = state.tree;
        let floatingZOrder = state.floatingZOrder;
        if (srcPanel.mode === 'tiled') {
          tree = removeFromTree(tree, srcId);
        } else {
          floatingZOrder = floatingZOrder.filter((x) => x !== srcId);
        }
        // Insert next to target.
        if (!tree) {
          // Shouldn't happen — target leaf was found, so tree exists. Safety.
          tree = removeFromTree(state.tree, srcId);
        }
        tree = splitAt(tree!, targetId, edge, srcId);
        const updatedSrc: Panel = { ...srcPanel, mode: 'tiled' };
        state = {
          ...state,
          panels: { ...state.panels, [srcId]: updatedSrc },
          tree,
          floatingZOrder,
          focused: srcId,
          interaction: null,
        };
        emit();
        schedulePersist();
      },

      arrangeCascadeFloating() {
        const fpanels = state.floatingZOrder
          .map((id) => state.panels[id])
          .filter((p): p is Panel => !!p);
        if (fpanels.length === 0) return;
        const viewport = getViewport();
        const next = cascadeFloating(fpanels, viewport);
        const panels = { ...state.panels };
        for (const p of next) panels[p.id] = p;
        state = { ...state, panels };
        emit();
        schedulePersist();
      },

      arrangeMosaicTiled() {
        const tiledIds = flattenPanelIds(state.tree);
        state = { ...state, tree: buildMosaic(tiledIds) };
        emit();
        schedulePersist();
      },
      arrangeRows() {
        const tiledIds = flattenPanelIds(state.tree);
        state = { ...state, tree: buildRow(tiledIds) };
        emit();
        schedulePersist();
      },
      arrangeColumns() {
        const tiledIds = flattenPanelIds(state.tree);
        state = { ...state, tree: buildColumn(tiledIds) };
        emit();
        schedulePersist();
      },
      arrangeEqualizeTiles() {
        state = { ...state, tree: equalizeTree(state.tree) };
        emit();
        schedulePersist();
      },

      setAllPanelsMode(mode) {
        const allIds = Object.keys(state.panels);
        if (mode === 'floating') {
          const panels = { ...state.panels };
          for (const id of allIds) panels[id] = { ...panels[id]!, mode: 'floating' };
          state = {
            ...state, panels,
            tree: null,
            floatingZOrder: allIds,
          };
        } else {
          const panels = { ...state.panels };
          for (const id of allIds) panels[id] = { ...panels[id]!, mode: 'tiled' };
          state = {
            ...state, panels,
            tree: buildMosaic(allIds),
            floatingZOrder: [],
          };
        }
        emit();
        schedulePersist();
      },

      startFloatingDrag(id, px, py) {
        const panel = state.panels[id];
        if (!panel || panel.mode !== 'floating') return;
        moveFloatingTop(id);
        state = {
          ...state,
          interaction: { kind: 'drag-floating', id, offset: { x: px - panel.x, y: py - panel.y } },
        };
        emit();
      },

      startTileDrag(id, _px, _py) {
        void _px; void _py;
        const panel = state.panels[id];
        if (!panel || panel.mode !== 'tiled') return;
        state = {
          ...state,
          interaction: { kind: 'drag-tiled', id, targetLeafId: null, targetZone: null },
        };
        emit();
      },

      startFloatingResize(id, px, py) {
        const panel = state.panels[id];
        if (!panel || panel.mode !== 'floating') return;
        moveFloatingTop(id);
        state = {
          ...state,
          interaction: {
            kind: 'resize-floating',
            id,
            startSize: { w: panel.w, h: panel.h },
            startPointer: { x: px, y: py },
          },
        };
        emit();
      },

      startDividerResize(containerId, dividerIdx, px, py, containerLengthPx) {
        const container = findContainer(state.tree, containerId);
        if (!container) return;
        state = {
          ...state,
          interaction: {
            kind: 'divider-resize',
            containerId,
            dividerIdx,
            startSizes: [...container.sizes],
            startPointer: container.dir === 'row' ? px : py,
            containerLength: containerLengthPx,
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

        if (inter.kind === 'drag-floating') {
          const panel = state.panels[inter.id];
          if (!panel) return;
          const moved = { ...panel, x: px - inter.offset.x, y: py - inter.offset.y };
          const clamped = clampPanelToViewport(moved, viewport);
          const others = Object.values(state.panels).filter((p) => p.id !== inter.id && p.mode === 'floating');
          const snapped = snapFloating(clamped, viewport, others);
          state = { ...state, panels: { ...state.panels, [inter.id]: snapped } };
          emit();
          return;
        }
        if (inter.kind === 'resize-floating') {
          const panel = state.panels[inter.id];
          if (!panel) return;
          const dx = px - inter.startPointer.x;
          const dy = py - inter.startPointer.y;
          const sized = clampResize(
            inter.startSize.w + dx,
            inter.startSize.h + dy,
            { x: panel.x, y: panel.y },
            viewport,
          );
          state = {
            ...state,
            panels: { ...state.panels, [inter.id]: { ...panel, ...sized } },
          };
          emit();
          return;
        }
        if (inter.kind === 'divider-resize') {
          const container = findContainer(state.tree, inter.containerId);
          if (!container) return;
          const delta = (container.dir === 'row' ? px : py) - inter.startPointer;
          const nextSizes = resizeContainerDivider(
            inter.startSizes,
            inter.dividerIdx,
            delta,
            inter.containerLength,
          );
          state = { ...state, tree: setContainerSizes(state.tree!, inter.containerId, nextSizes) };
          emit();
          return;
        }
        // drag-tiled — pointerMove doesn't update geometry; UI calls setTileDropTarget
      },

      setTileDropTarget(leafId, zone) {
        const inter = state.interaction;
        if (!inter || inter.kind !== 'drag-tiled') return;
        if (inter.targetLeafId === leafId && inter.targetZone === zone) return;
        state = {
          ...state,
          interaction: { ...inter, targetLeafId: leafId, targetZone: zone },
        };
        emit();
      },

      pointerUp() {
        const inter = state.interaction;
        if (!inter) return;
        if (inter.kind === 'drag-tiled' && inter.targetLeafId && inter.targetZone) {
          // Find target leaf's panel id from its node id.
          const findByNode = (t: WorkspaceSnapshot['tree'], nid: string): string | null => {
            if (!t) return null;
            if (t.kind === 'leaf') return t.id === nid ? t.panelId : null;
            for (const c of t.children) {
              const r = findByNode(c, nid);
              if (r) return r;
            }
            return null;
          };
          const targetPanelId = findByNode(state.tree, inter.targetLeafId);
          if (targetPanelId && targetPanelId !== inter.id) {
            // For 'center' drop we'd ideally swap; for simplicity treat as 'right'.
            const edge = inter.targetZone === 'center' ? 'right' : inter.targetZone;
            this.splitTile(inter.id, targetPanelId, edge);
            return;
          }
        }
        state = { ...state, interaction: null };
        emit();
        flushPersist();
      },

      setCursor(x, y, overPanelId) {
        if (state.cursor.x === x && state.cursor.y === y && state.cursor.overPanelId === overPanelId) return;
        state = { ...state, cursor: { x, y, overPanelId } };
        emit();
      },

      onKey({ key, meta, ctrl }) {
        const mod = meta || ctrl;
        if (mod && (key === 'k' || key === 'K')) {
          this.openCommandPalette(COMMAND_PALETTE_COMMANDS);
          return true;
        }
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
        // Drop ids that exist in tree/zOrder but not in panels.
        const validIds = new Set(Object.keys(layout.panels));
        const cleanedZOrder = layout.floatingZOrder.filter((id) => validIds.has(id));
        state = {
          ...emptySnapshot(),
          panels: layout.panels,
          tree: layout.tree,
          floatingZOrder: cleanedZOrder,
          focused: validIds.has(layout.focused ?? '') ? layout.focused : null,
        };
        emit();
      },

      reset() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = null;
        for (const [, r] of pendingResolvers) r(undefined);
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

