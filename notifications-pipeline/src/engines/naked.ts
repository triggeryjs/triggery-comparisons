// "Naked" baseline — no orchestration library. Plain JavaScript: a tiny
// emitter, captured-variable state, hand-rolled throttle + debounce timers,
// per-channel typing maps, all glued together in one factory function.
//
// This is what you write when you reach for "I don't need a library" on a
// real scenario. The honesty of the comparison.

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

function emitter<A extends unknown[]>() {
  const subs = new Set<(...a: A) => void>();
  return {
    emit: (...a: A) => {
      for (const s of subs) s(...a);
    },
    on: (cb: (...a: A) => void) => (subs.add(cb), () => subs.delete(cb)),
  };
}

export const nakedFactory: EngineFactory = {
  meta: {
    id: 'naked',
    label: 'Naked (no library)',
    description: 'Plain JS — emitters, captured state, hand-rolled timers.',
    sourcePath: 'notifications-pipeline/src/engines/naked.ts',
  },
  create(): Engine {
    let settings: Settings | null = null;
    let active: string | null = null;
    let user: User | null = null;
    let muted: ReadonlySet<string> = new Set();
    let prevConn: ConnectionState = 'connecting';

    let soundTimer: ReturnType<typeof setTimeout> | null = null;
    let channelTimer: ReturnType<typeof setTimeout> | null = null;
    const toastWindow: number[] = [];
    const typingByChannel = new Map<string, Set<string>>();
    const spamWindow = new Map<string, number[]>(); // R15

    const toastE = emitter<[ToastPayload]>();
    const soundE = emitter<[Sound]>();
    const incBadgeE = emitter<[string, boolean]>();
    const clearBadgeE = emitter<[string]>();
    const typingE = emitter<[TypingUpdate]>();
    const markReadE = emitter<[string]>();

    const emitToastThrottled = (p: ToastPayload) => {
      const now = Date.now();
      while (toastWindow.length && now - toastWindow[0]! >= 1000) toastWindow.shift();
      if (toastWindow.length >= 3) return;
      toastWindow.push(now);
      toastE.emit(p);
    };

    return {
      fireMessage: (msg: Message) => {
        if (!user || msg.author.id === user.id) return;
        const isMention = msg.mentions.includes(user.id);
        const isMuted = muted.has(msg.channelId);
        incBadgeE.emit(msg.channelId, isMuted);

        // R15: 5+ messages from this author in last 30 s → suppress
        const now = Date.now();
        const times = (spamWindow.get(msg.author.id) ?? []).filter((t) => t >= now - 30_000);
        times.push(now);
        spamWindow.set(msg.author.id, times);
        if (times.length >= 5) return;

        if (msg.channelId === active) return;
        if (isMuted) return;
        if (!settings?.notifications) return;
        if (settings.mentionsOnly && !isMention) return;
        if (settings.dnd && !isMention) return;

        emitToastThrottled({
          id: msg.id,
          kind: isMention ? 'mention' : 'message',
          title: msg.author.name,
          body: msg.text,
          channelId: msg.channelId,
          authorAvatar: msg.author.avatar,
          authorColor: msg.author.color,
          emittedAt: msg.emittedAt,
        });

        if (soundTimer) clearTimeout(soundTimer);
        soundTimer = setTimeout(() => soundE.emit(isMention ? 'mention' : 'beep'), 600);
      },
      fireTypingStart: ({ userId, channelId }) => {
        let set = typingByChannel.get(channelId);
        if (!set) {
          set = new Set();
          typingByChannel.set(channelId, set);
        }
        set.add(userId);
        typingE.emit({ channelId, userIds: [...set] });
      },
      fireTypingStop: ({ userId, channelId }) => {
        const set = typingByChannel.get(channelId);
        if (!set) return;
        set.delete(userId);
        typingE.emit({ channelId, userIds: [...set] });
      },
      fireChannelChanged: (id) => {
        if (channelTimer) clearTimeout(channelTimer);
        if (id == null) return;
        channelTimer = setTimeout(() => {
          markReadE.emit(id);
          clearBadgeE.emit(id);
        }, 2000);
      },
      setConnectionState: (next) => {
        const prev = prevConn;
        prevConn = next;
        if (next === prev) return;
        if (next === 'disconnected') {
          toastE.emit({
            id: `sys-${Date.now()}`,
            kind: 'system',
            title: 'Connection lost',
            body: 'Trying to reconnect…',
            emittedAt: Date.now(),
          });
        } else if (next === 'connected' && prev === 'disconnected') {
          toastE.emit({
            id: `sys-${Date.now()}`,
            kind: 'system',
            title: 'Reconnected',
            body: '',
            emittedAt: Date.now(),
          });
          soundE.emit('reconnect');
        }
      },
      setSettings: (s) => (settings = s),
      setActiveChannel: (id) => (active = id),
      setCurrentUser: (u) => (user = u),
      setMutedChannels: (ids) => (muted = ids),
      onShowToast: (cb) => toastE.on(cb),
      onPlaySound: (cb) => soundE.on(cb),
      onIncrementBadge: (cb) => incBadgeE.on(cb),
      onClearBadge: (cb) => clearBadgeE.on(cb),
      onTypingChange: (cb) => typingE.on(cb),
      onMarkChannelRead: (cb) => markReadE.on(cb),
      dispose: () => {
        if (soundTimer) clearTimeout(soundTimer);
        if (channelTimer) clearTimeout(channelTimer);
      },
    };
  },
};
