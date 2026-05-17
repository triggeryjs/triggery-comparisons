// Single shared UI shell — every engine implements the same `Engine`
// contract so this component is identical across implementations. The only
// thing that changes between ?engine=triggery and ?engine=effector is which
// file in `src/engines/` is wired up.

import { useEffect, useMemo, useState } from 'react';
import type { Engine } from './engine';
import { ENGINE_LIST, resolveEngineId } from './registry';
import type { Settings, Sound, ToastPayload } from './types';

const CURRENT_USER = 'me';

export function App() {
  const engineId = useMemo(
    () => resolveEngineId(new URLSearchParams(window.location.search).get('engine')),
    [],
  );
  const engine = useMemo(() => {
    const factory = ENGINE_LIST.find((e) => e.meta.id === engineId);
    if (!factory) throw new Error(`Unknown engine: ${engineId}`);
    return factory.create();
  }, [engineId]);

  useEffect(() => () => engine.dispose(), [engine]);

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: 24,
        maxWidth: 720,
        margin: '0 auto',
        color: '#1c1a2e',
      }}
    >
      <Header current={engineId} />
      <SettingsPanel engine={engine} />
      <ChatPanel engine={engine} activeChannelId="general" />
      <NotificationLayer engine={engine} />
      <BadgePanel engine={engine} />
      <SoundLog engine={engine} />
    </main>
  );
}

function Header({ current }: { current: string }) {
  return (
    <header style={{ marginBottom: 24 }}>
      <h1 style={{ marginBottom: 4 }}>Notifications pipeline</h1>
      <p style={{ color: '#5b4d8e', marginBottom: 12 }}>
        Same scenario, six implementations. Swap via the URL.
      </p>
      <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {ENGINE_LIST.map((e) => (
          <a
            key={e.meta.id}
            href={`?engine=${e.meta.id}`}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #ccc',
              textDecoration: 'none',
              color: current === e.meta.id ? '#fff' : '#1c1a2e',
              background: current === e.meta.id ? '#af37c5' : '#f4eefb',
              fontSize: 13,
            }}
          >
            {e.meta.label}
          </a>
        ))}
      </nav>
    </header>
  );
}

function SettingsPanel({ engine }: { engine: Engine }) {
  const [settings, setSettings] = useState<Settings>({
    sound: true,
    notifications: true,
    dnd: false,
  });

  // Push current settings into engine on every change. Initial value is pushed
  // by the same effect on first render.
  useEffect(() => {
    engine.setSettings(settings);
  }, [engine, settings]);

  const toggle = (k: keyof Settings) => setSettings((s) => ({ ...s, [k]: !s[k] }));

  return (
    <fieldset style={{ marginBottom: 16 }}>
      <legend>Settings</legend>
      <label style={{ marginRight: 16 }}>
        <input
          type="checkbox"
          checked={settings.notifications}
          onChange={() => toggle('notifications')}
        />{' '}
        Show toasts
      </label>
      <label style={{ marginRight: 16 }}>
        <input type="checkbox" checked={settings.sound} onChange={() => toggle('sound')} /> Sound
      </label>
      <label>
        <input type="checkbox" checked={settings.dnd} onChange={() => toggle('dnd')} /> Do not
        disturb
      </label>
    </fieldset>
  );
}

function ChatPanel({ engine, activeChannelId }: { engine: Engine; activeChannelId: string }) {
  useEffect(() => {
    engine.setActiveChannel(activeChannelId);
    engine.setCurrentUser(CURRENT_USER);
  }, [engine, activeChannelId]);

  const fireExternal = () =>
    engine.fireMessage({
      id: crypto.randomUUID(),
      author: 'Alice',
      authorId: 'alice',
      text: 'hi from #design',
      channelId: 'design',
    });
  const fireSelf = () =>
    engine.fireMessage({
      id: crypto.randomUUID(),
      author: 'me',
      authorId: CURRENT_USER,
      text: 'echo from myself',
      channelId: 'general',
    });
  const fireActive = () =>
    engine.fireMessage({
      id: crypto.randomUUID(),
      author: 'Bob',
      authorId: 'bob',
      text: 'in the channel you are reading',
      channelId: 'general',
    });

  return (
    <section style={{ marginBottom: 16 }}>
      <h3>Chat</h3>
      <button type="button" onClick={fireExternal} style={{ marginRight: 8 }}>
        Message in #design
      </button>
      <button type="button" onClick={fireSelf} style={{ marginRight: 8 }}>
        From me (ignored)
      </button>
      <button type="button" onClick={fireActive}>
        In active #general (ignored)
      </button>
      <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>Active channel: {activeChannelId}</p>
    </section>
  );
}

function NotificationLayer({ engine }: { engine: Engine }) {
  const [toasts, setToasts] = useState<Array<{ id: string } & ToastPayload>>([]);

  useEffect(
    () =>
      engine.onShowToast((payload) => {
        setToasts((arr) => [{ id: crypto.randomUUID(), ...payload }, ...arr].slice(0, 5));
      }),
    [engine],
  );

  return (
    <section style={{ marginBottom: 16 }}>
      <h3>Toasts</h3>
      {toasts.length === 0 && <p style={{ opacity: 0.6 }}>(no toasts yet)</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {toasts.map((t) => (
          <li
            key={t.id}
            style={{
              padding: 8,
              marginBottom: 4,
              border: '1px solid #ccc',
              borderRadius: 6,
              background: '#f7f7f7',
            }}
          >
            <strong>{t.title}</strong>: {t.body}
          </li>
        ))}
      </ul>
    </section>
  );
}

function BadgePanel({ engine }: { engine: Engine }) {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(
    () =>
      engine.onIncrementBadge((channelId) => {
        setCounts((c) => ({ ...c, [channelId]: (c[channelId] ?? 0) + 1 }));
      }),
    [engine],
  );

  return (
    <section style={{ marginBottom: 16 }}>
      <h3>Unread badges</h3>
      {Object.keys(counts).length === 0 && <p style={{ opacity: 0.6 }}>(no unread)</p>}
      <ul>
        {Object.entries(counts).map(([ch, n]) => (
          <li key={ch}>
            #{ch}: <strong>{n}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SoundLog({ engine }: { engine: Engine }) {
  const [beeps, setBeeps] = useState<string[]>([]);

  useEffect(
    () =>
      engine.onPlaySound((sound: Sound) => {
        setBeeps((b) => [`${new Date().toLocaleTimeString()} ${sound}`, ...b].slice(0, 5));
      }),
    [engine],
  );

  return (
    <section>
      <h3>Sound log (debounced 800 ms)</h3>
      {beeps.length === 0 && <p style={{ opacity: 0.6 }}>(silence)</p>}
      <ul>
        {beeps.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
    </section>
  );
}
