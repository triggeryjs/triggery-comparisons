// Triggery (v0.10) — two declarative triggers describe the orchestration.
// Conditions live on the trigger config; setters push state in. Actions fan
// out through built-in channels (t.action(name).subscribe). Typing tracker is
// pure JS — pass-through events without gating need no trigger.

import { createRuntime } from '@triggery/core';
import { createTrigger } from '@triggery/core/builder';
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
    settings: Settings;
    activeChannelId: string | null;
    currentUser: User;
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
    description: 'Two triggers, inline conditions, action channels. Handlers read like a spec.',
    sourcePath: 'notifications-pipeline/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });
    const schedule = opts.schedule ?? 'microtask';
    const spamWindow = new Map<string, number[]>(); // R15: per-author timestamps

    const inbox = createTrigger<Inbox>(runtime)
      .id('inbox')
      .events(['new-message', 'channel-changed'])
      .conditions({
        settings: null,
        currentUser: null,
        activeChannelId: null,
        mutedChannels: new Set(),
      })
      .require('settings', 'currentUser')
      .concurrency('take-every')
      .schedule(schedule)
      .handle(({ event, conditions, actions, check }) => {
        if (event.name === 'channel-changed') {
          const id = event.payload;
          if (id != null) {
            actions.defer(2000).markRead?.(id);
            actions.defer(2000).clearBadge?.(id);
          }
          return;
        }
        const msg = event.payload;
        if (msg.author.id === conditions.currentUser.id) return;
        const isMention = msg.mentions.includes(conditions.currentUser.id);
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
      });

    const conn = createTrigger<Conn>(runtime)
      .id('conn')
      .events(['connection-changed'])
      .conditions({ previous: 'connecting' })
      .require('previous')
      .schedule(schedule)
      .handle(({ event, conditions, actions }) => {
        const next = event.payload;
        if (next === conditions.previous) return;
        if (next === 'disconnected') {
          actions.showToast?.(systemToast('Connection lost', 'Trying to reconnect…'));
        } else if (next === 'connected' && conditions.previous === 'disconnected') {
          actions.showToast?.(systemToast('Reconnected', ''));
          actions.playSound?.('reconnect');
        }
      });

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
        const a = inbox.action('showToast').subscribe(cb);
        const b = conn.action('showToast').subscribe(cb);
        return () => { a(); b(); };
      },
      onPlaySound: (cb) => {
        const a = inbox.action('playSound').subscribe(cb);
        const b = conn.action('playSound').subscribe(cb);
        return () => { a(); b(); };
      },
      onIncrementBadge: (cb) =>
        inbox.action('incrementBadge').subscribe((p) => cb(p.channelId, p.muted)),
      onClearBadge: (cb) => inbox.action('clearBadge').subscribe(cb),
      onTypingChange: (cb) => (typingSubs.add(cb), () => typingSubs.delete(cb)),
      onMarkChannelRead: (cb) => inbox.action('markRead').subscribe(cb),
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
