// Triggery — four triggers, one per scenario family. Each handler reads
// top-to-bottom like a spec. Conditions are pushed in via runtime setters
// captured in closures; actions fan out through registered handlers.

import { createRuntime, createTrigger } from '@triggery/core';
import type { Engine, EngineFactory } from '../engine';
import type {
  ConnectionState,
  Message,
  Settings,
  Sound,
  ToastPayload,
  TypingUpdate,
  User,
} from '../types';

type MessageSchema = {
  events: { 'new-message': Message };
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
  };
};

type ChannelSchema = {
  events: { 'channel-changed': string | null };
  conditions: Record<string, never>;
  actions: { markRead: string; clearBadge: string };
};

type TypingSchema = {
  events: {
    'typing-start': { userId: string; channelId: string };
    'typing-stop': { userId: string; channelId: string };
  };
  conditions: Record<string, never>;
  actions: { typingChange: TypingUpdate };
};

type ConnectionSchema = {
  events: { 'connection-changed': ConnectionState };
  conditions: { previous: ConnectionState };
  actions: { showToast: ToastPayload; playSound: Sound };
};

export const triggeryFactory: EngineFactory = {
  meta: {
    id: 'triggery',
    label: 'Triggery',
    description: 'One trigger per scenario family, each handler reads as a spec.',
    sourcePath: 'notifications-pipeline/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });

    let settings: Settings | null = null;
    let activeChannelId: string | null = null;
    let currentUser: User | null = null;
    let mutedChannels: ReadonlySet<string> = new Set();
    let previousConn: ConnectionState = 'connecting';
    const typingByChannel = new Map<string, Set<string>>();

    const subs = {
      toast: new Set<(t: ToastPayload) => void>(),
      sound: new Set<(s: Sound) => void>(),
      incBadge: new Set<(channelId: string, muted: boolean) => void>(),
      clearBadge: new Set<(channelId: string) => void>(),
      typing: new Set<(u: TypingUpdate) => void>(),
      markRead: new Set<(channelId: string) => void>(),
    };

    const messageTrigger = createTrigger<MessageSchema>(
      {
        id: 'message-received',
        events: ['new-message'],
        required: ['settings', 'currentUser'],
        handler({ event, conditions, actions, check }) {
          const msg = event.payload;
          const user = conditions.currentUser;
          if (!user || msg.author.id === user.id) return;

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

    const channelTrigger = createTrigger<ChannelSchema>(
      {
        id: 'channel-changed',
        events: ['channel-changed'],
        concurrency: 'take-latest',
        handler({ event, actions }) {
          const id = event.payload;
          if (id == null) return;
          // 2s settled-read window: a later fire aborts this run via take-latest.
          actions.defer(2000).markRead?.(id);
          actions.defer(2000).clearBadge?.(id);
        },
      },
      runtime,
    );

    const typingTrigger = createTrigger<TypingSchema>(
      {
        id: 'typing',
        events: ['typing-start', 'typing-stop'],
        handler({ event, actions }) {
          const { userId, channelId } = event.payload;
          let set = typingByChannel.get(channelId);
          if (!set) {
            set = new Set();
            typingByChannel.set(channelId, set);
          }
          if (event.name === 'typing-start') set.add(userId);
          else set.delete(userId);
          actions.typingChange?.({ channelId, userIds: [...set] });
        },
      },
      runtime,
    );

    const connectionTrigger = createTrigger<ConnectionSchema>(
      {
        id: 'connection',
        events: ['connection-changed'],
        required: ['previous'],
        handler({ event, conditions, actions }) {
          const next = event.payload;
          const prev = conditions.previous;
          if (next === prev) return;
          if (next === 'disconnected') {
            actions.showToast?.({
              id: `sys-${Date.now()}`,
              kind: 'system',
              title: 'Connection lost',
              body: 'Trying to reconnect…',
              emittedAt: Date.now(),
            });
          } else if (next === 'connected' && prev === 'disconnected') {
            actions.showToast?.({
              id: `sys-${Date.now()}`,
              kind: 'system',
              title: 'Reconnected',
              body: '',
              emittedAt: Date.now(),
            });
            actions.playSound?.('reconnect');
          }
        },
      },
      runtime,
    );

    runtime.registerCondition(messageTrigger.id, 'settings', () => settings);
    runtime.registerCondition(messageTrigger.id, 'activeChannelId', () => activeChannelId);
    runtime.registerCondition(messageTrigger.id, 'currentUser', () => currentUser);
    runtime.registerCondition(messageTrigger.id, 'mutedChannels', () => mutedChannels);
    runtime.registerCondition(connectionTrigger.id, 'previous', () => previousConn);

    const fan = <A extends unknown[]>(set: Set<(...a: A) => void>, ...args: A) => {
      for (const cb of set) cb(...args);
    };
    runtime.registerAction(messageTrigger.id, 'showToast', (p) =>
      fan(subs.toast, p as ToastPayload),
    );
    runtime.registerAction(messageTrigger.id, 'playSound', (s) => fan(subs.sound, s as Sound));
    runtime.registerAction(messageTrigger.id, 'incrementBadge', (p) => {
      const { channelId, muted } = p as { channelId: string; muted: boolean };
      fan(subs.incBadge, channelId, muted);
    });
    runtime.registerAction(channelTrigger.id, 'markRead', (id) =>
      fan(subs.markRead, id as string),
    );
    runtime.registerAction(channelTrigger.id, 'clearBadge', (id) =>
      fan(subs.clearBadge, id as string),
    );
    runtime.registerAction(typingTrigger.id, 'typingChange', (u) =>
      fan(subs.typing, u as TypingUpdate),
    );
    runtime.registerAction(connectionTrigger.id, 'showToast', (p) =>
      fan(subs.toast, p as ToastPayload),
    );
    runtime.registerAction(connectionTrigger.id, 'playSound', (s) =>
      fan(subs.sound, s as Sound),
    );

    return {
      fireMessage: (msg) => runtime.fire('new-message', msg),
      fireTypingStart: (p) => runtime.fire('typing-start', p),
      fireTypingStop: (p) => runtime.fire('typing-stop', p),
      fireChannelChanged: (id) => runtime.fire('channel-changed', id),
      setConnectionState: (s) => {
        runtime.fire('connection-changed', s);
        previousConn = s;
      },
      setSettings: (s) => (settings = s),
      setActiveChannel: (id) => (activeChannelId = id),
      setCurrentUser: (u) => (currentUser = u),
      setMutedChannels: (ids) => (mutedChannels = ids),
      onShowToast: (cb) => (subs.toast.add(cb), () => subs.toast.delete(cb)),
      onPlaySound: (cb) => (subs.sound.add(cb), () => subs.sound.delete(cb)),
      onIncrementBadge: (cb) => (subs.incBadge.add(cb), () => subs.incBadge.delete(cb)),
      onClearBadge: (cb) => (subs.clearBadge.add(cb), () => subs.clearBadge.delete(cb)),
      onTypingChange: (cb) => (subs.typing.add(cb), () => subs.typing.delete(cb)),
      onMarkChannelRead: (cb) => (subs.markRead.add(cb), () => subs.markRead.delete(cb)),
      dispose: () => runtime.dispose(),
    };
  },
};
