import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Engine } from './engine';
import { ENGINE_LIST, resolveEngineId } from './registry';
import { COMMAND_PALETTE_COMMANDS, filterCommands } from './scenario';
import type { DockAnchor, FloatingPanel, ModalSpec, WorkspaceSnapshot } from './types';
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

  // Command palette: when user picks a command, dispatch it via the engine.
  const runCommand = useMemo(() => {
    return (cmdId: string) => {
      const s = engine.snapshot();
      const focused = s.focused;
      if (cmdId === 'open:note') engine.openPanel('note');
      else if (cmdId === 'open:inspector') engine.openPanel('inspector');
      else if (cmdId === 'close:focused' && focused) engine.close(focused);
      else if (cmdId === 'dock:focused:left' && focused) engine.dock(focused, 'left');
      else if (cmdId === 'dock:focused:right' && focused) engine.dock(focused, 'right');
      else if (cmdId === 'dock:focused:bottom' && focused) engine.dock(focused, 'bottom');
      else if (cmdId === 'undock:focused' && focused) engine.undock(focused);
      else if (cmdId === 'workspace:reset') engine.reset();
    };
  }, [engine]);
  const openPalette = useMemo(() => {
    return async () => {
      const cmdId = await engine.openCommandPalette(COMMAND_PALETTE_COMMANDS);
      if (cmdId) runCommand(cmdId);
    };
  }, [engine, runCommand]);

  // Global keyboard handler. We intercept ⌘K / Ctrl+K ourselves so the
  // command palette result actually runs through `runCommand`. Everything
  // else (ESC / ⌘W) is engine business.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        openPalette();
        return;
      }
      if (engine.onKey({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey })) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [engine, openPalette]);

  // Global pointermove / pointerup (drag continues outside the window frame)
  useEffect(() => {
    const move = (e: PointerEvent) => engine.pointerMove(e.clientX, e.clientY);
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
  const wsClass = `workspace ${interactionKind ? `is-${interactionKind === 'drag' ? 'dragging' : 'resizing'}` : ''}`;
  const topModal = snap.modals[snap.modals.length - 1];

  // Find which panel is in each dock slot.
  const allPanels = Object.values(snap.panels);
  const dockLeft = allPanels.find((p) => p.dock === 'left');
  const dockRight = allPanels.find((p) => p.dock === 'right');
  const dockBottom = allPanels.find((p) => p.dock === 'bottom');

  const gridStyle = {
    '--dock-left-w': dockLeft ? `${snap.dockSizes.left}px` : '0px',
    '--dock-right-w': dockRight ? `${snap.dockSizes.right}px` : '0px',
    '--dock-bottom-h': dockBottom ? `${snap.dockSizes.bottom}px` : '0px',
  } as React.CSSProperties;

  return (
    <>
      <EngineBar engine={engine} currentId={engineId} snap={snap} />
      <div className={wsClass} style={gridStyle}>
        {dockLeft && (
          <DockSlot anchor="left" panel={dockLeft} focused={snap.focused === dockLeft.id} engine={engine} />
        )}
        <div className="main-area">
          <HeroBar engine={engine} hasPanels={snap.zOrder.length > 0} openPalette={openPalette} />
          {snap.zOrder.map((id, i) => {
            const p = snap.panels[id];
            if (!p || p.dock !== null) return null;
            return (
              <Panel
                key={p.id}
                panel={p}
                focused={snap.focused === p.id}
                z={i + 10}
                engine={engine}
              />
            );
          })}
        </div>
        {dockRight && (
          <DockSlot anchor="right" panel={dockRight} focused={snap.focused === dockRight.id} engine={engine} />
        )}
        {dockBottom && (
          <DockSlot anchor="bottom" panel={dockBottom} focused={snap.focused === dockBottom.id} engine={engine} />
        )}
      </div>
      {topModal && <ModalLayer engine={engine} modal={topModal} />}
    </>
  );
}

function DockSlot({
  anchor, panel, focused, engine,
}: { anchor: DockAnchor; panel: FloatingPanel; focused: boolean; engine: Engine }) {
  const handleResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    engine.startDockResize(anchor, e.clientX, e.clientY);
  };
  return (
    <div
      className={`dock dock-${anchor} ${focused ? 'is-focused' : ''} kind-${panel.kind}`}
      onPointerDown={() => engine.focus(panel.id)}
    >
      <PanelHeader panel={panel} focused={focused} engine={engine} dragEnabled={false} />
      <div className="body">
        {panel.kind === 'note' ? (
          <textarea
            value={panel.body}
            onChange={(e) => engine.setBody(panel.id, e.target.value)}
            placeholder="Start typing…"
          />
        ) : (
          <InspectorView body={panel.body} />
        )}
      </div>
      <div className={`dock-divider dock-divider-${anchor}`} onPointerDown={handleResize} />
    </div>
  );
}

function EngineBar({
  engine: _engine, currentId, snap,
}: { engine: Engine; currentId: string; snap: WorkspaceSnapshot }) {
  void _engine;
  const panelCount = Object.keys(snap.panels).length;
  return (
    <div className="engine-bar">
      <span className="label">Floating workspace · engine:</span>
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
      <span className="hint">{panelCount}/5 panels · <kbd>⌘W</kbd> close · <kbd>Esc</kbd> dismiss · drag title · drag bottom-right</span>
    </div>
  );
}

function HeroBar({
  engine, hasPanels, openPalette,
}: { engine: Engine; hasPanels: boolean; openPalette: () => void }) {
  return (
    <div className={`hero-bar ${hasPanels ? 'is-compact' : 'is-empty'}`}>
      {!hasPanels && (
        <p className="hero-tagline">
          Open windows, drag them around, resize from the corner.<br />
          Dock to <kbd>⇤</kbd> <kbd>⇩</kbd> <kbd>⇥</kbd> from the title bar.
          Hit <kbd>⌘K</kbd> for the command palette.
        </p>
      )}
      <div className="hero-actions">
        <button className="hero-btn primary" onClick={() => engine.openPanel('note')}>
          <span className="hero-btn-glyph">📝</span>
          <span>New note<small>editable text</small></span>
        </button>
        <button className="hero-btn" onClick={() => engine.openPanel('inspector')}>
          <span className="hero-btn-glyph">🔍</span>
          <span>New inspector<small>structured info</small></span>
        </button>
        <button className="hero-btn" onClick={openPalette}>
          <span className="hero-btn-glyph">⌘K</span>
          <span>Command palette<small>run any command</small></span>
        </button>
      </div>
    </div>
  );
}

function Panel({
  panel, focused, z, engine,
}: { panel: FloatingPanel; focused: boolean; z: number; engine: Engine }) {
  const handleResizePointer = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    engine.startResize(panel.id, e.clientX, e.clientY);
  };
  return (
    <div
      className={`panel kind-${panel.kind} ${focused ? 'is-focused' : ''}`}
      style={{
        left: panel.x, top: panel.y, width: panel.w, height: panel.h, zIndex: z,
      }}
      onPointerDown={() => engine.focus(panel.id)}
    >
      <PanelHeader panel={panel} focused={focused} engine={engine} dragEnabled />
      <div className="body">
        {panel.kind === 'note' ? (
          <textarea
            value={panel.body}
            onChange={(e) => engine.setBody(panel.id, e.target.value)}
            placeholder="Start typing…"
          />
        ) : (
          <InspectorView body={panel.body} />
        )}
      </div>
      <div className="resize-handle" onPointerDown={handleResizePointer} />
    </div>
  );
}

function PanelHeader({
  panel, focused, engine, dragEnabled,
}: { panel: FloatingPanel; focused: boolean; engine: Engine; dragEnabled: boolean }) {
  void focused;
  const handleTitlePointer = (e: React.PointerEvent) => {
    if (!dragEnabled || e.button !== 0) return;
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    engine.startDrag(panel.id, e.clientX, e.clientY);
  };
  const docked = panel.dock !== null;
  return (
    <div
      className={`title-bar ${dragEnabled ? '' : 'no-drag'}`}
      onPointerDown={handleTitlePointer}
    >
      <span className="kind-chip">{panel.kind}</span>
      <span className="title">{panel.title}</span>
      <div className="dock-buttons" onPointerDown={(e) => e.stopPropagation()}>
        {docked ? (
          <button className="dock-btn" title="Float" onClick={() => engine.undock(panel.id)}>↗</button>
        ) : (
          <>
            <button className="dock-btn" title="Dock left" onClick={() => engine.dock(panel.id, 'left')}>⇤</button>
            <button className="dock-btn" title="Dock bottom" onClick={() => engine.dock(panel.id, 'bottom')}>⇩</button>
            <button className="dock-btn" title="Dock right" onClick={() => engine.dock(panel.id, 'right')}>⇥</button>
          </>
        )}
      </div>
      <button
        className="close"
        aria-label="Close"
        onClick={(e) => {
          e.stopPropagation();
          engine.close(panel.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

function InspectorView({ body }: { body: string }) {
  // Inspector body is JSON; render as a key/value property list.
  // Falls back to raw text if it doesn't parse (e.g. user edited via DevTools).
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // ignore
  }
  if (!data || typeof data !== 'object') {
    return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{body}</pre>;
  }
  return (
    <dl className="inspector">
      {Object.entries(data).map(([k, v]) => (
        <div className="row" key={k}>
          <dt>{k}</dt>
          <dd>
            {typeof v === 'boolean' ? (
              <span className={`pill ${v ? 'ok' : 'off'}`}>{v ? 'true' : 'false'}</span>
            ) : Array.isArray(v) ? (
              <div className="tags">
                {v.map((tag, i) => (
                  <span className="tag" key={i}>{String(tag)}</span>
                ))}
              </div>
            ) : v !== null && typeof v === 'object' ? (
              <code>{JSON.stringify(v)}</code>
            ) : (
              <span>{String(v)}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ModalLayer({ engine, modal }: { engine: Engine; modal: ModalSpec }) {
  const dismiss = (result?: unknown) => engine.close(modal.id, result);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) dismiss(modal.kind === 'confirm' ? false : modal.kind === 'command-palette' ? null : undefined);
      }}
    >
      {modal.kind === 'alert' && (
        <div className="modal" role="dialog" aria-modal="true">
          <h2>{modal.title}</h2>
          <p>{modal.body}</p>
          <div className="actions">
            <button className="primary" onClick={() => dismiss()} autoFocus>
              OK
            </button>
          </div>
        </div>
      )}
      {modal.kind === 'confirm' && (
        <div className="modal" role="dialog" aria-modal="true">
          <h2>{modal.title}</h2>
          <p>{modal.body}</p>
          <div className="actions">
            <button onClick={() => dismiss(false)}>Cancel</button>
            <button className="primary" onClick={() => dismiss(true)} autoFocus>
              OK
            </button>
          </div>
        </div>
      )}
      {modal.kind === 'command-palette' && (
        <CommandPalette engine={engine} modal={modal} />
      )}
    </div>
  );
}

function CommandPalette({
  engine, modal,
}: {
  engine: Engine;
  modal: Extract<ModalSpec, { kind: 'command-palette' }>;
}) {
  const filtered = filterCommands(modal.commands, modal.query);
  const top = filtered[0];
  return (
    <div className="modal cmd-palette" role="dialog" aria-modal="true">
      <input
        autoFocus
        value={modal.query}
        onChange={(e) => engine.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && top) {
            engine.close(modal.id, top.id);
          }
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
              onPointerDown={(e) => {
                e.stopPropagation();
                engine.close(modal.id, c.id);
              }}
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
