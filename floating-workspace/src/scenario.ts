// Shared scenario fixtures + helpers used by every engine. Keeps validators,
// constants, persistence, and the command-palette command list out of the
// engine files so they focus on orchestration.

import type {
  DockAnchor,
  FloatingPanel,
  PanelKind,
  WorkspaceSnapshot,
} from './types';

export const STORAGE_KEY = 'triggery-comparison.floating-workspace.v3';

/** Drag/resize pointer updates are throttled to ~60 fps (16 ms). */
export const POINTER_THROTTLE_MS = 16;
/** Layout persistence — debounced after any change. */
export const PERSIST_DEBOUNCE_MS = 1000;
/** Max floating panels (modals not counted). */
export const MAX_PANELS = 5;
/** Snap-to-edge distance during drag. */
export const SNAP_PX = 12;
/** Floating-panel size constraints. */
export const MIN_PANEL = { w: 200, h: 120 };
/** Default + clamp range for dock sizes (width for left/right, height for bottom). */
export const DOCK_DEFAULT = { left: 280, right: 280, bottom: 220 } as const;
export const DOCK_MIN = 160;
/** Maximum dock size as ratio of viewport perpendicular dimension. */
export const DOCK_MAX_RATIO = 0.6;

/** Default seed positions — staggered so freshly opened panels don't overlap. */
let openCounter = 0;
export function defaultPanelLayout(kind: PanelKind): Pick<FloatingPanel, 'x' | 'y' | 'w' | 'h' | 'dock'> {
  openCounter += 1;
  const dx = (openCounter % 6) * 28;
  const dy = (openCounter % 6) * 28;
  return {
    dock: null,
    ...(kind === 'note'
      ? { x: 96 + dx, y: 96 + dy, w: 320, h: 220 }
      : { x: 540 + dx, y: 96 + dy, w: 280, h: 280 }),
  };
}

/** Find which panel currently occupies the given dock slot (if any). */
export function panelInDock(
  panels: Readonly<Record<string, FloatingPanel>>,
  anchor: DockAnchor,
): FloatingPanel | undefined {
  for (const p of Object.values(panels)) if (p.dock === anchor) return p;
  return undefined;
}

/** Clamp a dock's size to its allowed range, given the workspace viewport. */
export function clampDockSize(anchor: DockAnchor, size: number, viewport: { w: number; h: number }): number {
  const max = (anchor === 'bottom' ? viewport.h : viewport.w) * DOCK_MAX_RATIO;
  return Math.max(DOCK_MIN, Math.min(size, max));
}

export const COMMAND_PALETTE_COMMANDS = [
  { id: 'open:note', label: 'Open new note', hint: '⌘N-like' },
  { id: 'open:inspector', label: 'Open inspector', hint: '' },
  { id: 'dock:focused:left', label: 'Dock focused: left', hint: '' },
  { id: 'dock:focused:right', label: 'Dock focused: right', hint: '' },
  { id: 'dock:focused:bottom', label: 'Dock focused: bottom', hint: '' },
  { id: 'undock:focused', label: 'Undock focused → floating', hint: '' },
  { id: 'close:focused', label: 'Close focused window', hint: '⌘W' },
  { id: 'workspace:reset', label: 'Reset workspace', hint: 'destructive' },
];

export function defaultTitle(kind: PanelKind): string {
  return kind === 'note' ? `Note ${openCounter}` : `Inspector ${openCounter}`;
}

export function defaultBody(kind: PanelKind): string {
  if (kind === 'note') {
    return 'Click to edit. Drag the title bar to move, bottom-right corner to resize.';
  }
  // Inspector — JSON-shaped structured data the UI renders as a property list
  // instead of a plain string.
  const id = openCounter.toString(36).toUpperCase();
  return JSON.stringify(
    {
      Type: 'Selection',
      Id: `obj_${id}`,
      Name: `Element ${openCounter}`,
      Position: { x: 24, y: 56 },
      Size: { w: 320, h: 240 },
      Visible: true,
      Tags: ['draft', 'shared'],
      Modified: new Date().toISOString().slice(0, 16).replace('T', ' '),
    },
    null,
    2,
  );
}

let idCounter = 0;
export function genId(prefix: 'panel' | 'modal'): string {
  // Random suffix + monotonic counter — never collides with a previously
  // persisted id (which would otherwise dup-key React on engine switch).
  idCounter += 1;
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${r}${idCounter.toString(36)}`;
}

export function clampPanelToViewport(
  panel: FloatingPanel,
  viewport: { w: number; h: number },
): FloatingPanel {
  const w = Math.min(panel.w, viewport.w);
  const h = Math.min(panel.h, viewport.h);
  return {
    ...panel,
    w, h,
    x: Math.max(0, Math.min(panel.x, viewport.w - w)),
    y: Math.max(0, Math.min(panel.y, viewport.h - h)),
  };
}

/** Apply snap-to-edge during a drag — `panel` is the post-move position,
 *  `viewport` is the workspace area. */
export function snapToEdges(panel: FloatingPanel, viewport: { w: number; h: number }): FloatingPanel {
  let { x, y } = panel;
  if (x < SNAP_PX) x = 0;
  if (y < SNAP_PX) y = 0;
  if (x + panel.w > viewport.w - SNAP_PX) x = viewport.w - panel.w;
  if (y + panel.h > viewport.h - SNAP_PX) y = viewport.h - panel.h;
  return { ...panel, x, y };
}

export function clampResize(
  w: number,
  h: number,
  origin: { x: number; y: number },
  viewport: { w: number; h: number },
): { w: number; h: number } {
  return {
    w: Math.max(MIN_PANEL.w, Math.min(w, viewport.w - origin.x)),
    h: Math.max(MIN_PANEL.h, Math.min(h, viewport.h - origin.y)),
  };
}

export function emptySnapshot(): WorkspaceSnapshot {
  return {
    panels: {},
    zOrder: [],
    modals: [],
    focused: null,
    interaction: null,
    dockSizes: { left: DOCK_DEFAULT.left, right: DOCK_DEFAULT.right, bottom: DOCK_DEFAULT.bottom },
  };
}

export type PersistedLayout = {
  panels: Record<string, FloatingPanel>;
  zOrder: string[];
  focused: string | null;
  dockSizes: { left: number; right: number; bottom: number };
};

export function persistLayout(s: WorkspaceSnapshot): void {
  try {
    const layout: PersistedLayout = {
      panels: s.panels,
      zOrder: [...s.zOrder],
      focused: s.focused,
      dockSizes: s.dockSizes,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // ignore — quota / private mode / etc.
  }
}

export function readPersistedLayout(): PersistedLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedLayout) : null;
  } catch {
    return null;
  }
}

export function clearPersistedLayout(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getViewport(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 1280, h: 800 };
  return { w: window.innerWidth, h: window.innerHeight - 64 /* engine bar */ };
}

/** Filter command list against a fuzzy-ish query (substring, case-insensitive). */
export function filterCommands<T extends { label: string }>(
  commands: readonly T[],
  query: string,
): readonly T[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.label.toLowerCase().includes(q));
}
