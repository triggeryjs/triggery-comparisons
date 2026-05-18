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
  engine, currentId, snap,
}: { engine: Engine; currentId: string; snap: WorkspaceSnapshot }) {
  const panelCount = Object.keys(snap.panels).length;
  return (
    <div className="engine-bar">
      <span className="label">Floating workspace · {ENGINE_LIST.length} engines</span>
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
      <span className="hint" style={{ marginRight: 12 }}>{panelCount}/5 panels</span>
      <button className="toolbar-btn" onClick={() => engine.openPanel('note')}>+ Note</button>
      <button className="toolbar-btn" onClick={() => engine.openPanel('inspector')}>+ Inspector</button>
      <button className="toolbar-btn" onClick={() => engine.openCommandPalette(COMMAND_PALETTE_COMMANDS)}>
        <kbd style={{ fontSize: 11, marginRight: 4 }}>⌘K</kbd> commands
      </button>
      <span className="hint">
        <kbd>⌘W</kbd> close · <kbd>Esc</kbd> dismiss · drag title · drag bottom-right
      </span>
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
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{panel.body}</pre>
        )}
      </div>
      <div className="resize-handle" onPointerDown={handleResizePointer} />
    </div>
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
