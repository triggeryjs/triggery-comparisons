// Triggery — two declarative triggers describe the orchestration. Typing
// indicator is plain in/out (no gating, no debounce — no need for a trigger).
// Conditions are pushed in via getters captured in closures; actions fan out
// through a tiny `output<>()` helper.

import { createRuntime, createTrigger } from '@triggery/core';
import type { Engine, EngineFactory, Unsubscribe } from '../engine';
import type {
  ConnectionState,
  Message,
  Settings,
  Sound,
  ToastPayload,
  TypingUpdate,
  User,
} from '../types';

type Inbox = {
  events: { 'new-message': Message; 'channel-changed': string | null };
  conditions: {
    settings: Settings;
    activeChannelId: string | null;
    currentUser: User | null;
    mutedChannels: ReadonlySet<string>;
  };
  actions: {
    showToast: ToastPayload;
    playSound: Sound;
    incrementBadge: { channelId: string; muted: boolean };
    markRead: string;
    clearBadge: string;
  };
};

type Conn = {
  events: { 'connection-changed': ConnectionState };
  conditions: { previous: ConnectionState };
  actions: { showToast: ToastPayload; playSound: Sound };
};

const output = <A extends unknown[]>() => {
  const subs = new Set<(...a: A) => void>();
  return {
    emit: (...a: A) => { for (const cb of subs) cb(...a); },
    on: (cb: (...a: A) => void): Unsubscribe => (subs.add(cb), () => subs.delete(cb)),
  };
};

export const createTriggeryFactory = (opts: { schedule?: 'microtask' | 'sync' } = {}): EngineFactory => ({
  meta: {
    id: 'triggery',
    label: opts.schedule === 'sync' ? 'Triggery (fireSync)' : 'Triggery',
    description: 'Two triggers + plain typing fan-out. Handlers read like a spec.',
    sourcePath: 'notifications-pipeline/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });
    const schedule = opts.schedule ?? 'microtask';

    let settings: Settings | null = null;
    let activeChannelId: string | null = null;
    let currentUser: User | null = null;
    let mutedChannels: ReadonlySet<string> = new Set();
    let previousConn: ConnectionState = 'connecting';

    const toast = output<[ToastPayload]>();
    const sound = output<[Sound]>();
    const incBadge = output<[string, boolean]>();
    const clearBadge = output<[string]>();
    const typing = output<[TypingUpdate]>();
    const markRead = output<[string]>();

    const inbox = createTrigger<Inbox>(
      {
        id: 'inbox',
        events: ['new-message', 'channel-changed'],
        required: ['settings', 'currentUser'],
        concurrency: 'take-latest',
        schedule,
        handler({ event, conditions, actions, check }) {
          if (event.name === 'channel-changed') {
            const id = event.payload;
            if (id != null) {
              actions.defer(2000).markRead?.(id);
              actions.defer(2000).clearBadge?.(id);
            }
            return;
          }

          const msg = event.payload;
          const user = conditions.currentUser!;
          if (msg.author.id === user.id) return;

          const isMention = msg.mentions.includes(user.id);
          const isMuted = conditions.mutedChannels?.has(msg.channelId) ?? false;
          actions.incrementBadge?.({ channelId: msg.channelId, muted: isMuted });

          if (msg.channelId === conditions.activeChannelId) return;
          if (isMuted) return;
          if (!check.is('settings', (s) => s.notifications)) return;
          if (check.is('settings', (s) => s.mentionsOnly) && !isMention) return;
          if (check.is('settings', (s) => s.dnd) && !isMention) return;

          actions.throttle(1000 / 3).showToast?.({
            id: msg.id,
            kind: isMention ? 'mention' : 'message',
            title: msg.author.name,
            body: msg.text,
            channelId: msg.channelId,
            authorAvatar: msg.author.avatar,
            authorColor: msg.author.color,
            emittedAt: msg.emittedAt,
          });
          actions.debounce(600).playSound?.(isMention ? 'mention' : 'beep');
        },
      },
      runtime,
    );

    const conn = createTrigger<Conn>(
      {
        id: 'conn',
        events: ['connection-changed'],
        required: ['previous'],
        schedule,
        handler({ event, conditions, actions }) {
          const next = event.payload;
          const prev = conditions.previous;
          if (next === prev) return;
          if (next === 'disconnected') {
            actions.showToast?.(systemToast('Connection lost', 'Trying to reconnect…'));
          } else if (next === 'connected' && prev === 'disconnected') {
            actions.showToast?.(systemToast('Reconnected', ''));
            actions.playSound?.('reconnect');
          }
        },
      },
      runtime,
    );

    runtime.registerCondition(inbox.id, 'settings', () => settings);
    runtime.registerCondition(inbox.id, 'activeChannelId', () => activeChannelId);
    runtime.registerCondition(inbox.id, 'currentUser', () => currentUser);
    runtime.registerCondition(inbox.id, 'mutedChannels', () => mutedChannels);
    runtime.registerCondition(conn.id, 'previous', () => previousConn);
    const wire = <K extends keyof Inbox['actions']>(name: K, fn: (p: Inbox['actions'][K]) => void) =>
      runtime.registerAction(inbox.id, name, fn as (p: unknown) => void);
    wire('showToast', toast.emit);
    wire('playSound', sound.emit);
    wire('incrementBadge', ({ channelId, muted }) => incBadge.emit(channelId, muted));
    wire('markRead', markRead.emit);
    wire('clearBadge', clearBadge.emit);
    runtime.registerAction(conn.id, 'showToast', toast.emit as (p: unknown) => void);
    runtime.registerAction(conn.id, 'playSound', sound.emit as (p: unknown) => void);

    // Typing: pure fan-out, no gating/throttle → no trigger needed.
    const typingByChannel = new Map<string, Set<string>>();
    const trackTyping = (kind: 'add' | 'delete', userId: string, channelId: string) => {
      let set = typingByChannel.get(channelId);
      if (!set) typingByChannel.set(channelId, (set = new Set()));
      set[kind](userId);
      typing.emit({ channelId, userIds: [...set] });
    };

    return {
      fireMessage: (m) => runtime.fire('new-message', m),
      fireTypingStart: (p) => trackTyping('add', p.userId, p.channelId),
      fireTypingStop: (p) => trackTyping('delete', p.userId, p.channelId),
      fireChannelChanged: (id) => runtime.fire('channel-changed', id),
      setConnectionState: (s) => {
        runtime.fire('connection-changed', s);
        previousConn = s;
      },
      setSettings: (s) => (settings = s),
      setActiveChannel: (id) => (activeChannelId = id),
      setCurrentUser: (u) => (currentUser = u),
      setMutedChannels: (ids) => (mutedChannels = ids),
      onShowToast: toast.on,
      onPlaySound: sound.on,
      onIncrementBadge: incBadge.on,
      onClearBadge: clearBadge.on,
      onTypingChange: typing.on,
      onMarkChannelRead: markRead.on,
      dispose: () => runtime.dispose(),
    };
  },
});

export const triggeryFactory = createTriggeryFactory();
export const triggerySyncFactory = createTriggeryFactory({ schedule: 'sync' });

const systemToast = (title: string, body: string): ToastPayload => ({
  id: `sys-${Date.now()}`,
  kind: 'system',
  title,
  body,
  emittedAt: Date.now(),
});
