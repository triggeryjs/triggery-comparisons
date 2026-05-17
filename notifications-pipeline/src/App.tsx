// Discord-like shell. Talks only to the Engine contract — the same UI swaps
// engines via ?engine=… without knowing how the orchestration is done inside.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Engine } from './engine';
import { ENGINE_LIST, resolveEngineId } from './registry';
import { CHANNELS, ME, USERS, makeMessage } from './scenario';
import { createSimulator } from './simulator';
import type { ConnectionState, Message, Settings, Sound, ToastPayload, TypingUpdate, User } from './types';

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
};

export function App() {
  const engineId = useMemo(
    () => resolveEngineId(new URLSearchParams(window.location.search).get('engine')),
    [],
  );
  const factory = useMemo(() => ENGINE_LIST.find((e) => e.meta.id === engineId)!, [engineId]);
  // Ref-based lazy init survives StrictMode's synthetic unmount-remount —
  // useEffect cleanup would dispose the engine between the two mounts and
  // the second mount's subscriptions would talk to a disposed instance.
  // The engine is GC'd when the page navigates away (engine swap is a full
  // reload because the `<a href="?engine=…">` triggers it).
  const engineRef = useRef<Engine | null>(null);
  if (engineRef.current === null) engineRef.current = factory.create();
  const engine = engineRef.current;

  return (
    <>
      <EngineBar current={engineId} />
      <div className="layout">
        <ChatShell engine={engine} />
      </div>
    </>
  );
}

function EngineBar({ current }: { current: string }) {
  const meta = ENGINE_LIST.find((e) => e.meta.id === current)?.meta;
  return (
    <header className="engine-bar">
      <span className="label">Engine</span>
      {ENGINE_LIST.map((e) => (
        <a
          key={e.meta.id}
          className={`pill ${current === e.meta.id ? 'active' : ''}`}
          href={`?engine=${e.meta.id}`}
        >
          {e.meta.label}
        </a>
      ))}
      <span className="stats">
        <strong>{meta?.label}</strong> — same UI, different orchestration file
      </span>
    </header>
  );
}

function ChatShell({ engine }: { engine: Engine }) {
  // ─── UI state ────────────────────────────────────────────────
  const [activeId, setActiveId] = useState<string>('general');
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [settings, setSettings] = useState<Settings>({
    notifications: true,
    sound: true,
    dnd: false,
    mentionsOnly: false,
  });
  const [muted, setMuted] = useState<Set<string>>(new Set(['announcements']));
  const [badges, setBadges] = useState<Record<string, { count: number; muted: boolean }>>({});
  const [toasts, setToasts] = useState<ToastPayload[]>([]);
  const [sounds, setSounds] = useState<{ id: string; time: number; sound: Sound }[]>([]);
  const [typingByChannel, setTypingByChannel] = useState<Record<string, string[]>>({});
  const [conn, setConn] = useState<ConnectionState>('connected');
  const [auto, setAuto] = useState(false);

  const messageListRef = useRef<HTMLDivElement>(null);

  // ─── engine wiring ───────────────────────────────────────────
  // Push current state into engine. Block bodies so the implicit return value
  // is discarded — useEffect treats non-undefined/non-function returns as
  // cleanup and throws in React 19.
  useEffect(() => {
    engine.setSettings(settings);
  }, [engine, settings]);
  useEffect(() => {
    engine.setActiveChannel(activeId);
  }, [engine, activeId]);
  useEffect(() => {
    engine.setCurrentUser(ME as User);
  }, [engine]);
  useEffect(() => {
    engine.setMutedChannels(muted);
  }, [engine, muted]);
  useEffect(() => {
    engine.setConnectionState(conn);
  }, [engine, conn]);

  // On channel switch — tell engine for the debounced mark-read rule
  useEffect(() => {
    engine.fireChannelChanged(activeId);
  }, [engine, activeId]);

  // Subscribe to outputs
  useEffect(
    () =>
      engine.onShowToast((t) => {
        setToasts((arr) => [t, ...arr].slice(0, 5));
        setTimeout(() => {
          setToasts((arr) => arr.filter((x) => x.id !== t.id));
        }, 4500);
      }),
    [engine],
  );
  useEffect(
    () =>
      engine.onPlaySound((s) => {
        setSounds((arr) =>
          [{ id: `${Date.now()}-${Math.random()}`, time: Date.now(), sound: s }, ...arr].slice(0, 6),
        );
      }),
    [engine],
  );
  useEffect(
    () =>
      engine.onIncrementBadge((channelId, isMuted) => {
        setBadges((b) => ({
          ...b,
          [channelId]: { count: (b[channelId]?.count ?? 0) + 1, muted: isMuted },
        }));
      }),
    [engine],
  );
  useEffect(
    () =>
      engine.onClearBadge((channelId) => {
        setBadges((b) => {
          const { [channelId]: _, ...rest } = b;
          return rest;
        });
      }),
    [engine],
  );
  useEffect(
    () =>
      engine.onTypingChange((u: TypingUpdate) => {
        setTypingByChannel((t) => ({ ...t, [u.channelId]: [...u.userIds] }));
      }),
    [engine],
  );
  useEffect(() => engine.onMarkChannelRead(() => undefined), [engine]);

  // Also push received messages into the visible message list (UI concern,
  // not engine concern). Subscribe to all toasts? No — we listen to a side
  // channel: every fireMessage call writes to messages too.
  const fireMessage = useCallback(
    (msg: Message) => {
      setMessages((m) => ({
        ...m,
        [msg.channelId]: [...(m[msg.channelId] ?? []).slice(-49), msg],
      }));
      engine.fireMessage(msg);
    },
    [engine],
  );

  // Simulator
  const simulator = useMemo(() => createSimulator({ ...engine, fireMessage }), [engine, fireMessage]);
  useEffect(() => {
    if (auto) simulator.start();
    return () => simulator.stop();
  }, [auto, simulator]);

  // Auto-scroll message list
  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages, activeId]);

  const activeChannel = CHANNELS.find((c) => c.id === activeId)!;
  const activeTyping = (typingByChannel[activeId] ?? []).filter((id) => id !== ME.id);

  const toggleSetting = (k: keyof Settings) => setSettings((s) => ({ ...s, [k]: !s[k] }));
  const toggleMute = (channelId: string) =>
    setMuted((m) => {
      const next = new Set(m);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });

  return (
    <>
      <aside className="sidebar">
        <h2>Channels</h2>
        <ul className="channel-list">
          {CHANNELS.map((c) => {
            const badge = badges[c.id]?.count ?? 0;
            const isMuted = muted.has(c.id);
            return (
              <li
                key={c.id}
                className={`channel-row ${c.id === activeId ? 'active' : ''} ${isMuted ? 'muted' : ''}`}
                onClick={() => setActiveId(c.id)}
              >
                <span className="hash">#</span>
                <span>{c.name}</span>
                {badge > 0 && <span className="badge">{badge}</span>}
                <button
                  className="mute-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleMute(c.id);
                  }}
                  title={isMuted ? 'unmute' : 'mute'}
                >
                  {isMuted ? '🔕' : '🔔'}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="user-strip">
          <span className="avatar">{ME.avatar}</span>
          <span className="name">{ME.name}</span>
          <span className={`conn ${conn}`}>{conn}</span>
        </div>
      </aside>

      <main className="main">
        <header className="main-header">
          <span className="hash">#</span>
          <span className="channel-name">{activeChannel.name}</span>
          <span className="topic">{activeChannel.topic}</span>
        </header>
        <div className="message-list" ref={messageListRef}>
          {(messages[activeId] ?? []).length === 0 && (
            <p className="empty">No messages in #{activeChannel.name} yet.</p>
          )}
          {(messages[activeId] ?? []).map((m) => (
            <div key={m.id} className="message-row">
              <span className="avatar">{m.author.avatar}</span>
              <div>
                <div>
                  <span className="author" style={{ color: m.author.color }}>
                    {m.author.name}
                  </span>
                  <span className="time">{fmtTime(m.emittedAt)}</span>
                </div>
                <div className="body">
                  {m.mentions.includes(ME.id) ? (
                    <>
                      {m.text.split('@me').map((part, i) =>
                        i === 0 ? part : (
                          <span key={i}>
                            <span className="mention">@me</span>
                            {part}
                          </span>
                        ),
                      )}
                    </>
                  ) : (
                    m.text
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="typing-bar">
          {activeTyping.length > 0 && (
            <>
              <span>
                {activeTyping
                  .map((id) => USERS.find((u) => u.id === id)?.name ?? id)
                  .join(', ')}{' '}
                is typing
              </span>
              <span style={{ marginLeft: 4 }}>
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </span>
            </>
          )}
        </div>
      </main>

      <aside className="right-panel">
        <section className="section">
          <h3>Settings</h3>
          <label>
            <input
              type="checkbox"
              checked={settings.notifications}
              onChange={() => toggleSetting('notifications')}
            />
            Show toasts
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.sound}
              onChange={() => toggleSetting('sound')}
            />
            Play sound
          </label>
          <label>
            <input type="checkbox" checked={settings.dnd} onChange={() => toggleSetting('dnd')} />
            Do not disturb
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.mentionsOnly}
              onChange={() => toggleSetting('mentionsOnly')}
            />
            Mentions only
          </label>
        </section>

        <section className="section">
          <h3>Simulator</h3>
          <div className="button-row">
            <button onClick={() => setAuto((a) => !a)} className={auto ? 'primary' : ''}>
              {auto ? '⏸ Stop auto-stream' : '▶ Start auto-stream'}
            </button>
            <span className="hint">One message every 1.5 s from a random user</span>
            <button
              onClick={() => fireMessage(makeMessage({ channelId: CHANNELS[(Math.random() * CHANNELS.length) | 0]!.id }))}
            >
              📨 One random message
            </button>
            <button
              onClick={() =>
                fireMessage(
                  makeMessage({
                    channelId: CHANNELS[(Math.random() * CHANNELS.length) | 0]!.id,
                    mention: true,
                  }),
                )
              }
            >
              📣 @-mention me
            </button>
            <span className="hint">Mentions override DND + mentions-only</span>
            <button
              onClick={() => {
                for (let i = 0; i < 10; i++) {
                  setTimeout(
                    () =>
                      fireMessage(
                        makeMessage({
                          channelId: CHANNELS[(Math.random() * CHANNELS.length) | 0]!.id,
                        }),
                      ),
                    i * 50,
                  );
                }
              }}
            >
              💥 Burst of 10
            </button>
            <span className="hint">Throttle drops most; only ~3 toasts/sec</span>
            <button onClick={() => simulator.makeTyping(3)}>⌨️ Someone is typing</button>
            <button onClick={() => simulator.simulateDisconnect()} className="danger">
              ⚡ Disconnect 2 s
            </button>
          </div>
        </section>

        <section className="section">
          <h3>Sound log (debounced 600 ms)</h3>
          <ul className="sound-log">
            {sounds.length === 0 && <li className="empty">silence</li>}
            {sounds.map((s) => (
              <li key={s.id}>
                <span className="time">{fmtTime(s.time)}</span>
                <span>
                  {s.sound === 'beep' ? '🔔' : s.sound === 'mention' ? '📣' : '🔌'} {s.sound}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </aside>

      <div className="toast-layer">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind !== 'system' && t.authorAvatar && (
              <span className="avatar" style={{ background: t.authorColor }}>
                {t.authorAvatar}
              </span>
            )}
            <div className="body-col">
              <div className="row-1">
                <span className="name">{t.title}</span>
                {t.channelId && <span className="channel">#{t.channelId}</span>}
              </div>
              <div className="body">{t.body}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
