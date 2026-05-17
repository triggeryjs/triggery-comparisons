// Effector — events + stores + samples. Each rule becomes a sample with
// filter+fn into a target event. Debounce/throttle done by hand (patronum
// has them — we keep it bare to keep LOC and bundle honest).

import { combine, createEffect, createEvent, createStore, sample } from 'effector';
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

export const effectorFactory: EngineFactory = {
  meta: {
    id: 'effector',
    label: 'Effector',
    description: 'Events + stores + samples wired into a graph.',
    sourcePath: 'notifications-pipeline/src/engines/effector.ts',
  },
  create(): Engine {
    // ───── inputs ────────────────────────────────────────────────────
    const newMessage = createEvent<Message>();
    const typingStart = createEvent<{ userId: string; channelId: string }>();
    const typingStop = createEvent<{ userId: string; channelId: string }>();
    const channelChanged = createEvent<string | null>();
    const connectionChanged = createEvent<ConnectionState>();
    const settingsChanged = createEvent<Settings>();
    const activeChannelSet = createEvent<string | null>();
    const currentUserSet = createEvent<User | null>();
    const mutedSet = createEvent<ReadonlySet<string>>();

    const $settings = createStore<Settings | null>(null).on(settingsChanged, (_, s) => s);
    const $active = createStore<string | null>(null).on(activeChannelSet, (_, id) => id);
    const $user = createStore<User | null>(null).on(currentUserSet, (_, u) => u);
    const $muted = createStore<ReadonlySet<string>>(new Set()).on(mutedSet, (_, ids) => ids);
    const $conn = createStore<ConnectionState>('connecting');
    const $prevConn = createStore<ConnectionState>('connecting');
    sample({ clock: connectionChanged, source: $conn, target: $prevConn });
    $conn.on(connectionChanged, (_, s) => s);

    const $world = combine({ settings: $settings, active: $active, user: $user, muted: $muted });

    // ───── outputs ───────────────────────────────────────────────────
    const showToast = createEvent<ToastPayload>();
    const playSound = createEvent<Sound>();
    const incrementBadge = createEvent<{ channelId: string; muted: boolean }>();
    const clearBadge = createEvent<string>();
    const typingChange = createEvent<TypingUpdate>();
    const markRead = createEvent<string>();

    // R5 — badge unconditional (after auth gate)
    sample({
      clock: newMessage,
      source: $world,
      filter: (w, m) => w.user != null && m.author.id !== w.user.id,
      fn: (w, m) => ({ channelId: m.channelId, muted: w.muted.has(m.channelId) }),
      target: incrementBadge,
    });

    // R6 gate predicate, factored out (reused for toast + sound)
    const shouldNotify = (
      w: { settings: Settings | null; active: string | null; user: User | null; muted: ReadonlySet<string> },
      m: Message,
    ): boolean => {
      if (!w.user || !w.settings) return false;
      if (m.author.id === w.user.id) return false;
      if (m.channelId === w.active) return false;
      if (w.muted.has(m.channelId)) return false;
      if (!w.settings.notifications) return false;
      const isMention = m.mentions.includes(w.user.id);
      if (w.settings.mentionsOnly && !isMention) return false;
      if (w.settings.dnd && !isMention) return false;
      return true;
    };

    // R7a — toast (throttled to 3/sec by hand)
    const toastWindow: number[] = [];
    const throttledShow = createEffect((p: ToastPayload) => {
      const now = Date.now();
      while (toastWindow.length && now - toastWindow[0]! >= 1000) toastWindow.shift();
      if (toastWindow.length >= 3) return;
      toastWindow.push(now);
      showToast(p);
    });
    sample({
      clock: newMessage,
      source: $world,
      filter: shouldNotify,
      fn: (w, m): ToastPayload => {
        const isMention = m.mentions.includes(w.user!.id);
        return {
          id: m.id,
          kind: isMention ? 'mention' : 'message',
          title: m.author.name,
          body: m.text,
          channelId: m.channelId,
          authorAvatar: m.author.avatar,
          authorColor: m.author.color,
          emittedAt: m.emittedAt,
        };
      },
      target: throttledShow,
    });

    // R7b — sound (debounced 600 ms)
    let soundTimer: ReturnType<typeof setTimeout> | null = null;
    const beepFx = createEffect((isMention: boolean) => {
      if (soundTimer) clearTimeout(soundTimer);
      soundTimer = setTimeout(() => playSound(isMention ? 'mention' : 'beep'), 600);
    });
    sample({
      clock: newMessage,
      source: $world,
      filter: shouldNotify,
      fn: (w, m) => m.mentions.includes(w.user!.id),
      target: beepFx,
    });

    // R8-R9 — typing tracker
    const $typing = createStore<Map<string, Set<string>>>(new Map())
      .on(typingStart, (m, { channelId, userId }) => {
        const next = new Map(m);
        const set = new Set(next.get(channelId) ?? []);
        set.add(userId);
        next.set(channelId, set);
        return next;
      })
      .on(typingStop, (m, { channelId, userId }) => {
        const next = new Map(m);
        const set = new Set(next.get(channelId) ?? []);
        set.delete(userId);
        next.set(channelId, set);
        return next;
      });
    sample({
      clock: [typingStart, typingStop],
      source: $typing,
      fn: (m, e): TypingUpdate => ({
        channelId: e.channelId,
        userIds: [...(m.get(e.channelId) ?? [])],
      }),
      target: typingChange,
    });

    // R11 — debounced mark-read on channel switch
    let channelTimer: ReturnType<typeof setTimeout> | null = null;
    const markReadFx = createEffect((id: string) => {
      if (channelTimer) clearTimeout(channelTimer);
      channelTimer = setTimeout(() => {
        markRead(id);
        clearBadge(id);
      }, 2000);
    });
    sample({ clock: channelChanged, filter: (id): id is string => id != null, target: markReadFx });

    // R12-R13 — connection-state toasts + sound
    sample({
      clock: connectionChanged,
      source: $prevConn,
      filter: (prev, next) => next === 'disconnected' && prev !== 'disconnected',
      fn: (): ToastPayload => ({
        id: `sys-${Date.now()}`,
        kind: 'system',
        title: 'Connection lost',
        body: 'Trying to reconnect…',
        emittedAt: Date.now(),
      }),
      target: showToast,
    });
    sample({
      clock: connectionChanged,
      source: $prevConn,
      filter: (prev, next) => next === 'connected' && prev === 'disconnected',
      fn: (): ToastPayload => ({
        id: `sys-${Date.now()}`,
        kind: 'system',
        title: 'Reconnected',
        body: '',
        emittedAt: Date.now(),
      }),
      target: showToast,
    });
    sample({
      clock: connectionChanged,
      source: $prevConn,
      filter: (prev, next) => next === 'connected' && prev === 'disconnected',
      fn: (): Sound => 'reconnect',
      target: playSound,
    });

    return {
      fireMessage: newMessage,
      fireTypingStart: typingStart,
      fireTypingStop: typingStop,
      fireChannelChanged: channelChanged,
      setConnectionState: connectionChanged,
      setSettings: settingsChanged,
      setActiveChannel: activeChannelSet,
      setCurrentUser: currentUserSet,
      setMutedChannels: mutedSet,
      onShowToast: (cb) => showToast.watch(cb),
      onPlaySound: (cb) => playSound.watch(cb),
      onIncrementBadge: (cb) => incrementBadge.watch((p) => cb(p.channelId, p.muted)),
      onClearBadge: (cb) => clearBadge.watch(cb),
      onTypingChange: (cb) => typingChange.watch(cb),
      onMarkChannelRead: (cb) => markRead.watch(cb),
      dispose: () => {
        if (soundTimer) clearTimeout(soundTimer);
        if (channelTimer) clearTimeout(channelTimer);
      },
    };
  },
};
