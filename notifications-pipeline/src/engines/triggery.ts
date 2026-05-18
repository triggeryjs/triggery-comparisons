// Triggery (v0.10) — two declarative triggers describe the orchestration.
// Conditions live on the trigger config; setters push state in. Outputs fan
// out via `runtime.subscribeAction` — the lean main-bundle path, no builder
// subpath, no per-action channel layer. Typing tracker is pure JS (events
// without gating need no trigger).

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

type Inbox = {
  events: { 'new-message': Message; 'channel-changed': string | null };
  conditions: {
    settings: Settings | null;
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

export const createTriggeryFactory = (
  opts: { schedule?: 'microtask' | 'sync' } = {},
): EngineFactory => ({
  meta: {
    id: 'triggery',
    label: opts.schedule === 'sync' ? 'Triggery (fireSync)' : 'Triggery',
    description: 'Two triggers + plain typing fan-out. Handlers read like a spec.',
    sourcePath: 'notifications-pipeline/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });
    const schedule = opts.schedule ?? 'microtask';
    const spamWindow = new Map<string, number[]>(); // R15: per-author timestamps

    const inbox = createTrigger<Inbox>({
      id: 'inbox',
      events: ['new-message', 'channel-changed'],
      conditions: { settings: null, currentUser: null, activeChannelId: null, mutedChannels: new Set() },
      required: ['settings', 'currentUser'],
      concurrency: 'take-every',
      schedule,
      handler: ({ event, conditions, actions, check }) => {
        if (event.name === 'channel-changed') {
          const id = event.payload;
          if (id != null) {
            actions.defer(2000).markRead?.(id);
            actions.defer(2000).clearBadge?.(id);
          }
          return;
        }
        const msg = event.payload;
        const user = conditions.currentUser;
        if (!user || msg.author.id === user.id) return;
        const isMention = msg.mentions.includes(user.id);
        const isMuted = conditions.mutedChannels?.has(msg.channelId) ?? false;
        actions.incrementBadge?.({ channelId: msg.channelId, muted: isMuted });

        // R15: 5+ messages from this author in last 30 s → suppress notification
        const now = Date.now();
        const times = (spamWindow.get(msg.author.id) ?? []).filter((t) => t >= now - 30_000);
        times.push(now);
        spamWindow.set(msg.author.id, times);
        if (times.length >= 5) return;

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
    }, runtime);

    const conn = createTrigger<Conn>({
      id: 'conn',
      events: ['connection-changed'],
      conditions: { previous: 'connecting' },
      required: ['previous'],
      schedule,
      handler: ({ event, conditions, actions }) => {
        const next = event.payload;
        if (next === conditions.previous) return;
        if (next === 'disconnected') {
          actions.showToast?.(systemToast('Connection lost', 'Trying to reconnect…'));
        } else if (next === 'connected' && conditions.previous === 'disconnected') {
          actions.showToast?.(systemToast('Reconnected', ''));
          actions.playSound?.('reconnect');
        }
      },
    }, runtime);

    // Typing tracker: pure pass-through, no gating → no trigger.
    const typingByChannel = new Map<string, Set<string>>();
    const typingSubs = new Set<(u: TypingUpdate) => void>();
    const trackTyping = (kind: 'add' | 'delete', userId: string, channelId: string) => {
      let set = typingByChannel.get(channelId);
      if (!set) typingByChannel.set(channelId, (set = new Set()));
      set[kind](userId);
      const update = { channelId, userIds: [...set] };
      for (const cb of typingSubs) cb(update);
    };

    // Lean fan-out: subscribe to each trigger's action through the runtime.
    const on = (id: string, name: string, cb: (p: unknown) => void) =>
      runtime.subscribeAction(id, name, cb).unregister;

    return {
      fireMessage: (m) => runtime.fire('new-message', m),
      fireTypingStart: (p) => trackTyping('add', p.userId, p.channelId),
      fireTypingStop: (p) => trackTyping('delete', p.userId, p.channelId),
      fireChannelChanged: (id) => runtime.fire('channel-changed', id),
      setConnectionState: (s) => {
        runtime.fire('connection-changed', s);
        conn.setCondition('previous', s);
      },
      setSettings: (s) => inbox.setCondition('settings', s),
      setActiveChannel: (id) => inbox.setCondition('activeChannelId', id),
      setCurrentUser: (u) => inbox.setCondition('currentUser', u),
      setMutedChannels: (ids) => inbox.setCondition('mutedChannels', ids),
      onShowToast: (cb) => {
        const a = on('inbox', 'showToast', cb as (p: unknown) => void);
        const b = on('conn', 'showToast', cb as (p: unknown) => void);
        return () => { a(); b(); };
      },
      onPlaySound: (cb) => {
        const a = on('inbox', 'playSound', cb as (p: unknown) => void);
        const b = on('conn', 'playSound', cb as (p: unknown) => void);
        return () => { a(); b(); };
      },
      onIncrementBadge: (cb) =>
        on('inbox', 'incrementBadge', (p) => {
          const { channelId, muted } = p as { channelId: string; muted: boolean };
          cb(channelId, muted);
        }),
      onClearBadge: (cb) => on('inbox', 'clearBadge', cb as (p: unknown) => void),
      onTypingChange: (cb) => (typingSubs.add(cb), () => typingSubs.delete(cb)),
      onMarkChannelRead: (cb) => on('inbox', 'markRead', cb as (p: unknown) => void),
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
