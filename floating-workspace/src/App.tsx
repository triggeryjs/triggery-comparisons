import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { Engine } from './engine';
import { ENGINE_LIST, resolveEngineId } from './registry';
import {
  COMMAND_PALETTE_COMMANDS,
  INSPECTOR_MODE_LABELS,
  classifyDropZone,
  filterCommands,
  flattenPanelIds,
} from './scenario';
import type {
  InspectorMode,
  ModalSpec,
  Panel,
  TileNode,
  WorkspaceSnapshot,
} from './types';
import './styles.css';

export function App() {
  const engineId = useMemo(
    () => resolveEngineId(new URLSearchParams(window.location.search).get('engine')),
    [],
  );
  const factory = useMemo(() => ENGINE_LIST.find((e) => e.meta.id === engineId)!, [engineId]);
  const engine = useMemo(() => factory.create(), [factory]);
  useEffect(() => () => engine.dispose(), [engine]);
  useEffect(() => engine.loadLayout(), [engine]);

  // Command palette dispatcher — UI maps command ids to engine calls.
  const runCommand = useCallback((cmdId: string) => {
    const s = engine.snapshot();
    const focused = s.focused;
    switch (cmdId) {
      case 'open:note': engine.openPanel('note'); break;
      case 'open:inspector': engine.openPanel('inspector'); break;
      case 'mode:float-focused': if (focused) engine.setPanelMode(focused, 'floating'); break;
      case 'mode:tile-focused': if (focused) engine.setPanelMode(focused, 'tiled'); break;
      case 'mode:float-all': engine.setAllPanelsMode('floating'); break;
      case 'mode:tile-all': engine.setAllPanelsMode('tiled'); break;
      case 'arrange:cascade-floating': engine.arrangeCascadeFloating(); break;
      case 'arrange:mosaic-tiled': engine.arrangeMosaicTiled(); break;
      case 'arrange:rows': engine.arrangeRows(); break;
      case 'arrange:cols': engine.arrangeColumns(); break;
      case 'arrange:equalize': engine.arrangeEqualizeTiles(); break;
      case 'inspector:cursor':
      case 'inspector:state':
      case 'inspector:tree':
      case 'inspector:static': {
        const mode = cmdId.split(':')[1] as InspectorMode;
        if (focused && s.panels[focused]?.kind === 'inspector') engine.setInspectorMode(focused, mode);
        break;
      }
      case 'close:focused': if (focused) engine.close(focused); break;
      case 'workspace:reset': engine.reset(); break;
    }
  }, [engine]);

  const openPalette = useCallback(async () => {
    const cmdId = await engine.openCommandPalette(COMMAND_PALETTE_COMMANDS);
    if (cmdId) runCommand(cmdId);
  }, [engine, runCommand]);

  // Global keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        openPalette();
        return;
      }
      if (engine.onKey({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey })) e.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [engine, openPalette]);

  // Global pointer + cursor tracking
  useEffect(() => {
    const move = (e: PointerEvent) => {
      engine.pointerMove(e.clientX, e.clientY);
      // Cursor tracking — find topmost panel-bearing element under pointer.
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const carrier = el?.closest('[data-panel-id]') as HTMLElement | null;
      const overId = carrier?.dataset.panelId ?? null;
      engine.setCursor(e.clientX, e.clientY, overId);
    };
    const up = () => engine.pointerUp();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [engine]);

  const snap = useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.snapshot(),
    () => engine.snapshot(),
  );

  const interactionKind = snap.interaction?.kind;
  const wsClass = `workspace ${
    interactionKind === 'drag-floating' ? 'is-dragging'
    : interactionKind === 'resize-floating' ? 'is-resizing'
    : interactionKind === 'divider-resize' ? 'is-resizing'
    : interactionKind === 'drag-tiled' ? 'is-tile-drag'
    : ''
  }`;
  const topModal = snap.modals[snap.modals.length - 1];
  const hasAnyPanel = Object.keys(snap.panels).length > 0;

  return (
    <>
      <TopBar engine={engine} currentId={engineId} snap={snap} openPalette={openPalette} />
      <div className={wsClass}>
        <div className="main-area" data-main-area>
          {!hasAnyPanel && <HeroEmpty />}
          {snap.tree && <TreeView node={snap.tree} engine={engine} snap={snap} />}
          {/* Floating panels overlaid on top of tree */}
          {snap.floatingZOrder.map((id, i) => {
            const p = snap.panels[id];
            if (!p || p.mode !== 'floating') return null;
            return (
              <FloatingPanel
                key={p.id}
                panel={p}
                focused={snap.focused === p.id}
                z={50 + i}
                engine={engine}
                snap={snap}
              />
            );
          })}
        </div>
      </div>
      {topModal && <ModalLayer engine={engine} modal={topModal} />}
    </>
  );
}

function TopBar({
  engine, currentId, snap, openPalette,
}: { engine: Engine; currentId: string; snap: WorkspaceSnapshot; openPalette: () => void }) {
  const panelCount = Object.keys(snap.panels).length;
  return (
    <div className="top-bar">
      <div className="top-bar-section">
        <span className="brand">Floating workspace</span>
        <span className="brand-sub">{panelCount}/8</span>
      </div>
      <div className="top-bar-section primary">
        <button className="action-btn primary" onClick={() => engine.openPanel('note')}>
          <span>📝</span> Note
        </button>
        <button className="action-btn" onClick={() => engine.openPanel('inspector')}>
          <span>🔍</span> Inspector
        </button>
        <button className="action-btn" onClick={openPalette}>
          <span>⌘K</span> Commands
        </button>
      </div>
      <div className="top-bar-section engines">
        {ENGINE_LIST.map((e) => (
          <a
            key={e.meta.id}
            href={`?engine=${e.meta.id}`}
            className={e.meta.id === currentId ? 'active' : ''}
            title={e.meta.description}
          >
            {e.meta.label}
          </a>
        ))}
      </div>
    </div>
  );
}

function HeroEmpty() {
  return (
    <div className="hero-empty">
      <p>
        Click <kbd>Note</kbd> or <kbd>Inspector</kbd> above to open a panel.<br />
        Hit <kbd>⌘K</kbd> for commands · drag tiles to split · use <kbd>↗</kbd> in a panel header to float.
      </p>
    </div>
  );
}

// ─── Tree rendering ──────────────────────────────────────────────────────

function TreeView({
  node, engine, snap,
}: { node: TileNode; engine: Engine; snap: WorkspaceSnapshot }) {
  if (node.kind === 'leaf') {
    const panel = snap.panels[node.panelId];
    if (!panel || panel.mode !== 'tiled') return null;
    return (
      <TiledLeaf
        leafId={node.id}
        panel={panel}
        focused={snap.focused === panel.id}
        engine={engine}
        snap={snap}
      />
    );
  }
  return (
    <Container container={node} engine={engine} snap={snap} />
  );
}

function Container({
  container, engine, snap,
}: { container: Extract<TileNode, { kind: 'container' }>; engine: Engine; snap: WorkspaceSnapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className={`tile-container dir-${container.dir}`}>
      {container.children.map((child, i) => (
        <div
          key={child.id}
          className="tile-slot"
          style={{ flexBasis: `${container.sizes[i]}%` }}
        >
          <TreeView node={child} engine={engine} snap={snap} />
          {i < container.children.length - 1 && (
            <DividerHandle
              container={container}
              dividerIdx={i}
              outerRef={ref}
              engine={engine}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function DividerHandle({
  container, dividerIdx, outerRef, engine,
}: {
  container: Extract<TileNode, { kind: 'container' }>;
  dividerIdx: number;
  outerRef: React.RefObject<HTMLDivElement | null>;
  engine: Engine;
}) {
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const containerEl = outerRef.current;
    const length = containerEl
      ? container.dir === 'row' ? containerEl.clientWidth : containerEl.clientHeight
      : 1000;
    engine.startDividerResize(container.id, dividerIdx, e.clientX, e.clientY, length);
  };
  return <div className={`divider divider-${container.dir}`} onPointerDown={onPointerDown} />;
}

function TiledLeaf({
  leafId, panel, focused, engine, snap,
}: { leafId: string; panel: Panel; focused: boolean; engine: Engine; snap: WorkspaceSnapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  const isDragging = snap.interaction?.kind === 'drag-tiled' && snap.interaction.id === panel.id;
  const isDropTarget =
    snap.interaction?.kind === 'drag-tiled'
    && snap.interaction.targetLeafId === leafId
    && snap.interaction.id !== panel.id;
  const dropZone =
    isDropTarget && snap.interaction?.kind === 'drag-tiled'
      ? snap.interaction.targetZone
      : null;
  // While dragging, when pointer is over this leaf, classify zone and inform engine.
  const onPointerOver = (e: React.PointerEvent) => {
    const inter = snap.interaction;
    if (inter?.kind !== 'drag-tiled' || inter.id === panel.id) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const zone = classifyDropZone(e.clientX, e.clientY, rect);
    engine.setTileDropTarget(leafId, zone);
  };
  const onPointerOut = () => {
    const inter = snap.interaction;
    if (inter?.kind !== 'drag-tiled' || inter.id === panel.id) return;
    engine.setTileDropTarget(null, null);
  };
  return (
    <div
      ref={ref}
      data-panel-id={panel.id}
      className={`tile-leaf kind-${panel.kind} ${focused ? 'is-focused' : ''} ${isDragging ? 'is-dragging' : ''}`}
      onPointerDown={() => engine.focus(panel.id)}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      <PanelHeader
        panel={panel}
        engine={engine}
        onTitleBarPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          engine.startTileDrag(panel.id, e.clientX, e.clientY);
        }}
      />
      <PanelBody panel={panel} engine={engine} snap={snap} />
      {dropZone && <DropZoneOverlay zone={dropZone} />}
    </div>
  );
}

function DropZoneOverlay({ zone }: { zone: 'top' | 'right' | 'bottom' | 'left' | 'center' }) {
  return <div className={`drop-zone drop-zone-${zone}`} />;
}

// ─── Floating panel ──────────────────────────────────────────────────────

function FloatingPanel({
  panel, focused, z, engine, snap,
}: { panel: Panel; focused: boolean; z: number; engine: Engine; snap: WorkspaceSnapshot }) {
  const onTitleBarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    engine.startFloatingDrag(panel.id, e.clientX, e.clientY);
  };
  const onResizePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    engine.startFloatingResize(panel.id, e.clientX, e.clientY);
  };
  return (
    <div
      data-panel-id={panel.id}
      className={`floating-panel kind-${panel.kind} ${focused ? 'is-focused' : ''}`}
      style={{
        left: panel.x, top: panel.y, width: panel.w, height: panel.h, zIndex: z,
      }}
      onPointerDown={() => engine.focus(panel.id)}
    >
      <PanelHeader panel={panel} engine={engine} onTitleBarPointerDown={onTitleBarPointerDown} draggable />
      <PanelBody panel={panel} engine={engine} snap={snap} />
      <div className="resize-handle" onPointerDown={onResizePointerDown} />
    </div>
  );
}

// ─── Panel header & body (shared between tiled + floating) ──────────────

function PanelHeader({
  panel, engine, onTitleBarPointerDown, draggable,
}: {
  panel: Panel;
  engine: Engine;
  onTitleBarPointerDown: (e: React.PointerEvent) => void;
  draggable?: boolean;
}) {
  const toggleMode = (e: React.MouseEvent) => {
    e.stopPropagation();
    engine.setPanelMode(panel.id, panel.mode === 'tiled' ? 'floating' : 'tiled');
  };
  return (
    <div
      className={`title-bar ${draggable ? 'draggable' : ''}`}
      onPointerDown={onTitleBarPointerDown}
    >
      <span className="kind-chip">{panel.kind}</span>
      <span className="title">{panel.title}</span>
      {panel.kind === 'inspector' && panel.mode === 'tiled' && (
        // Inline inspector-mode mini selector
        <InspectorModePicker
          current={panel.inspectorMode ?? 'static'}
          onChange={(m) => engine.setInspectorMode(panel.id, m)}
        />
      )}
      <button
        className="header-btn mode-btn"
        title={panel.mode === 'tiled' ? 'Float (detach from tile)' : 'Tile (snap back)'}
        onClick={toggleMode}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {panel.mode === 'tiled' ? '↗' : '⇲'}
      </button>
      <button
        className="header-btn close"
        title="Close"
        onClick={(e) => {
          e.stopPropagation();
          engine.close(panel.id);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        ×
      </button>
    </div>
  );
}

function InspectorModePicker({
  current, onChange,
}: { current: InspectorMode; onChange: (m: InspectorMode) => void }) {
  const modes: InspectorMode[] = ['static', 'state', 'cursor', 'tree'];
  return (
    <div className="inspector-mode-picker" onPointerDown={(e) => e.stopPropagation()}>
      {modes.map((m) => (
        <button
          key={m}
          className={`mode-pill ${current === m ? 'active' : ''}`}
          onClick={(e) => { e.stopPropagation(); onChange(m); }}
        >
          {INSPECTOR_MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

function PanelBody({ panel, engine, snap }: { panel: Panel; engine: Engine; snap: WorkspaceSnapshot }) {
  return (
    <div className="body">
      {panel.kind === 'note' ? (
        <textarea
          value={panel.body}
          onChange={(e) => engine.setBody(panel.id, e.target.value)}
          placeholder="Start typing…"
        />
      ) : (
        <InspectorView panel={panel} snap={snap} />
      )}
    </div>
  );
}

function InspectorView({ panel, snap }: { panel: Panel; snap: WorkspaceSnapshot }) {
  const mode = panel.inspectorMode ?? 'static';
  if (mode === 'cursor') return <CursorInspector snap={snap} />;
  if (mode === 'state') return <StateInspector snap={snap} />;
  if (mode === 'tree') return <TreeInspector snap={snap} />;
  // static
  let data: Record<string, unknown> | null = null;
  try { data = JSON.parse(panel.body) as Record<string, unknown>; } catch { /* ignore */ }
  if (!data) return <pre className="static-fallback">{panel.body}</pre>;
  return <PropertyList data={data} />;
}

function PropertyList({ data }: { data: Record<string, unknown> }) {
  return (
    <dl className="inspector">
      {Object.entries(data).map(([k, v]) => (
        <div className="row" key={k}>
          <dt>{k}</dt>
          <dd>{renderValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function renderValue(v: unknown): React.ReactNode {
  if (typeof v === 'boolean') return <span className={`pill ${v ? 'ok' : 'off'}`}>{v ? 'true' : 'false'}</span>;
  if (Array.isArray(v))
    return (
      <div className="tags">
        {v.map((t, i) => <span className="tag" key={i}>{String(t)}</span>)}
      </div>
    );
  if (v !== null && typeof v === 'object') return <code>{JSON.stringify(v)}</code>;
  if (v === null) return <span style={{ color: '#717280' }}>null</span>;
  return <span>{String(v)}</span>;
}

function CursorInspector({ snap }: { snap: WorkspaceSnapshot }) {
  const c = snap.cursor;
  const overPanel = c.overPanelId ? snap.panels[c.overPanelId] : null;
  return (
    <PropertyList
      data={{
        'cursor.x': c.x,
        'cursor.y': c.y,
        over: overPanel ? `${overPanel.kind}: ${overPanel.title}` : '— none —',
        'over.id': c.overPanelId ?? '—',
      }}
    />
  );
}

function StateInspector({ snap }: { snap: WorkspaceSnapshot }) {
  const focusedPanel = snap.focused ? snap.panels[snap.focused] : null;
  return (
    <PropertyList
      data={{
        'panels.total': Object.keys(snap.panels).length,
        'panels.tiled': flattenPanelIds(snap.tree).length,
        'panels.floating': snap.floatingZOrder.length,
        focused: focusedPanel ? `${focusedPanel.kind}: ${focusedPanel.title}` : '— none —',
        'focused.mode': focusedPanel?.mode ?? '—',
        interaction: snap.interaction ? snap.interaction.kind : 'idle',
        'modals.depth': snap.modals.length,
      }}
    />
  );
}

function TreeInspector({ snap }: { snap: WorkspaceSnapshot }) {
  if (!snap.tree) return <p className="static-fallback">— empty tree —</p>;
  return <pre className="tree-render">{renderTreeAscii(snap.tree, snap, 0)}</pre>;
}

function renderTreeAscii(node: TileNode, snap: WorkspaceSnapshot, depth: number): string {
  const pad = '  '.repeat(depth);
  if (node.kind === 'leaf') {
    const p = snap.panels[node.panelId];
    return `${pad}● ${p ? `${p.kind}: ${p.title}` : node.panelId}`;
  }
  const sizes = node.sizes.map((s) => `${Math.round(s)}%`).join(' / ');
  const head = `${pad}┌─ ${node.dir.toUpperCase()} [${sizes}]`;
  const childLines = node.children.map((c) => renderTreeAscii(c, snap, depth + 1));
  return [head, ...childLines].join('\n');
}

// ─── Modals ──────────────────────────────────────────────────────────────

function ModalLayer({ engine, modal }: { engine: Engine; modal: ModalSpec }) {
  const dismiss = (result?: unknown) => engine.close(modal.id, result);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget)
          dismiss(modal.kind === 'confirm' ? false : modal.kind === 'command-palette' ? null : undefined);
      }}
    >
      {modal.kind === 'alert' && (
        <div className="modal" role="dialog" aria-modal="true">
          <h2>{modal.title}</h2>
          <p>{modal.body}</p>
          <div className="actions">
            <button className="primary" onClick={() => dismiss()} autoFocus>OK</button>
          </div>
        </div>
      )}
      {modal.kind === 'confirm' && (
        <div className="modal" role="dialog" aria-modal="true">
          <h2>{modal.title}</h2>
          <p>{modal.body}</p>
          <div className="actions">
            <button onClick={() => dismiss(false)}>Cancel</button>
            <button className="primary" onClick={() => dismiss(true)} autoFocus>OK</button>
          </div>
        </div>
      )}
      {modal.kind === 'command-palette' && <CommandPalette engine={engine} modal={modal} />}
    </div>
  );
}

function CommandPalette({
  engine, modal,
}: { engine: Engine; modal: Extract<ModalSpec, { kind: 'command-palette' }> }) {
  const filtered = filterCommands(modal.commands, modal.query);
  const top = filtered[0];
  return (
    <div className="modal cmd-palette" role="dialog" aria-modal="true">
      <input
        autoFocus
        value={modal.query}
        onChange={(e) => engine.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && top) engine.close(modal.id, top.id);
        }}
        placeholder="Type a command…"
      />
      {filtered.length === 0 ? (
        <p className="empty">No commands match.</p>
      ) : (
        <ul>
          {filtered.map((c, i) => (
            <li
              key={c.id}
              className={i === 0 ? 'is-active' : ''}
              onPointerDown={(e) => { e.stopPropagation(); engine.close(modal.id, c.id); }}
            >
              <span className={`label ${c.hint === 'destructive' ? 'destructive' : ''}`}>{c.label}</span>
              {c.hint && <span className="hint">{c.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
