import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Engine } from './engine';
import { ENGINE_LIST, resolveEngineId } from './registry';
import { COMMAND_PALETTE_COMMANDS, filterCommands } from './scenario';
import type { FloatingPanel, ModalSpec, WorkspaceSnapshot } from './types';
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

  // Global keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (engine.onKey({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey })) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [engine]);

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

  return (
    <>
      <EngineBar engine={engine} currentId={engineId} snap={snap} />
      <div className={wsClass}>
        <HeroBar engine={engine} hasPanels={Object.keys(snap.panels).length > 0} />
        {snap.zOrder.map((id, i) => {
          const p = snap.panels[id];
          if (!p) return null;
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
      {topModal && <ModalLayer engine={engine} modal={topModal} />}
    </>
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

function HeroBar({ engine, hasPanels }: { engine: Engine; hasPanels: boolean }) {
  return (
    <div className={`hero-bar ${hasPanels ? 'is-compact' : 'is-empty'}`}>
      {!hasPanels && (
        <p className="hero-tagline">
          Open windows, drag them around, resize from the corner.<br />
          Hit <kbd>⌘K</kbd> to run a command.
        </p>
      )}
      <div className="hero-actions">
        <button
          className="hero-btn primary"
          onClick={() => engine.openPanel('note')}
        >
          <span className="hero-btn-glyph">📝</span>
          <span>
            New note
            <small>editable text</small>
          </span>
        </button>
        <button
          className="hero-btn"
          onClick={() => engine.openPanel('inspector')}
        >
          <span className="hero-btn-glyph">🔍</span>
          <span>
            New inspector
            <small>structured info</small>
          </span>
        </button>
        <button
          className="hero-btn"
          onClick={() => engine.openCommandPalette(COMMAND_PALETTE_COMMANDS)}
        >
          <span className="hero-btn-glyph">⌘K</span>
          <span>
            Command palette
            <small>run any command</small>
          </span>
        </button>
      </div>
    </div>
  );
}

function Panel({
  panel, focused, z, engine,
}: { panel: FloatingPanel; focused: boolean; z: number; engine: Engine }) {
  const handleTitlePointer = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    engine.startDrag(panel.id, e.clientX, e.clientY);
  };
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
      <div className="title-bar" onPointerDown={handleTitlePointer}>
        <span className="kind-chip">{panel.kind}</span>
        <span className="title">{panel.title}</span>
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
