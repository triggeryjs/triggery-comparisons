// Reatom — atoms hold conditions, actions carry events. Each rule is a few
// lines inside an action that reads ctx-scoped state and fires output actions.
// Using reatom v3 (the @reatom/core ^3.x line on npm).

import { action, atom, createCtx } from '@reatom/core';
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

export const reatomFactory: EngineFactory = {
  meta: {
    id: 'reatom',
    label: 'Reatom',
    description: 'Atoms hold conditions, actions read ctx and fire outputs.',
    sourcePath: 'notifications-pipeline/src/engines/reatom.ts',
  },
  create(): Engine {
    const ctx = createCtx();

    const settingsAtom = atom<Settings | null>(null, 'settings');
    const activeAtom = atom<string | null>(null, 'active');
    const userAtom = atom<User | null>(null, 'user');
    const mutedAtom = atom<Set<string>>(new Set<string>(), 'muted');
    const connAtom = atom<ConnectionState>('connecting', 'conn');

    const showToast = action((_, p: ToastPayload) => p, 'showToast');
    const playSound = action((_, s: Sound) => s, 'playSound');
    const incrementBadge = action(
      (_, p: { channelId: string; muted: boolean }) => p,
      'incrementBadge',
    );
    const clearBadge = action((_, channelId: string) => channelId, 'clearBadge');
    const typingChange = action((_, u: TypingUpdate) => u, 'typingChange');
    const markRead = action((_, channelId: string) => channelId, 'markRead');

    let prevConn: ConnectionState = 'connecting';
    let soundTimer: ReturnType<typeof setTimeout> | null = null;
    let channelTimer: ReturnType<typeof setTimeout> | null = null;
    const toastWindow: number[] = [];
    const typingByChannel = new Map<string, Set<string>>();

    const newMessage = action((c, msg: Message) => {
      const user = c.get(userAtom);
      const settings = c.get(settingsAtom);
      const active = c.get(activeAtom);
      const muted = c.get(mutedAtom);
      if (!user || msg.author.id === user.id) return;

      const isMention = msg.mentions.includes(user.id);
      const isMuted = muted.has(msg.channelId);
      incrementBadge(c, { channelId: msg.channelId, muted: isMuted });

      if (msg.channelId === active) return;
      if (isMuted) return;
      if (!settings || !settings.notifications) return;
      if (settings.mentionsOnly && !isMention) return;
      if (settings.dnd && !isMention) return;

      const now = Date.now();
      while (toastWindow.length && now - toastWindow[0]! >= 1000) toastWindow.shift();
      if (toastWindow.length < 3) {
        toastWindow.push(now);
        showToast(c, {
          id: msg.id,
          kind: isMention ? 'mention' : 'message',
          title: msg.author.name,
          body: msg.text,
          channelId: msg.channelId,
          authorAvatar: msg.author.avatar,
          authorColor: msg.author.color,
          emittedAt: msg.emittedAt,
        });
      }

      if (soundTimer) clearTimeout(soundTimer);
      soundTimer = setTimeout(
        () => playSound(c, isMention ? 'mention' : 'beep'),
        600,
      );
    }, 'newMessage');

    const typingStart = action((c, p: { userId: string; channelId: string }) => {
      let set = typingByChannel.get(p.channelId);
      if (!set) {
        set = new Set();
        typingByChannel.set(p.channelId, set);
      }
      set.add(p.userId);
      typingChange(c, { channelId: p.channelId, userIds: [...set] });
    }, 'typingStart');

    const typingStop = action((c, p: { userId: string; channelId: string }) => {
      const set = typingByChannel.get(p.channelId);
      if (!set) return;
      set.delete(p.userId);
      typingChange(c, { channelId: p.channelId, userIds: [...set] });
    }, 'typingStop');

    const channelChanged = action((c, id: string | null) => {
      if (channelTimer) clearTimeout(channelTimer);
      if (id == null) return;
      channelTimer = setTimeout(() => {
        markRead(c, id);
        clearBadge(c, id);
      }, 2000);
    }, 'channelChanged');

    const connectionChanged = action((c, next: ConnectionState) => {
      const prev = prevConn;
      prevConn = next;
      if (next === prev) return;
      if (next === 'disconnected') {
        showToast(c, {
          id: `sys-${Date.now()}`,
          kind: 'system',
          title: 'Connection lost',
          body: 'Trying to reconnect…',
          emittedAt: Date.now(),
        });
      } else if (next === 'connected' && prev === 'disconnected') {
        showToast(c, {
          id: `sys-${Date.now()}`,
          kind: 'system',
          title: 'Reconnected',
          body: '',
          emittedAt: Date.now(),
        });
        playSound(c, 'reconnect');
      }
      connAtom(c, next);
    }, 'connectionChanged');

    return {
      fireMessage: (m) => newMessage(ctx, m),
      fireTypingStart: (p) => typingStart(ctx, p),
      fireTypingStop: (p) => typingStop(ctx, p),
      fireChannelChanged: (id) => channelChanged(ctx, id),
      setConnectionState: (s) => connectionChanged(ctx, s),
      setSettings: (s) => settingsAtom(ctx, s),
      setActiveChannel: (id) => activeAtom(ctx, id),
      setCurrentUser: (u) => userAtom(ctx, u),
      setMutedChannels: (ids) => mutedAtom(ctx, new Set(ids)),
      onShowToast: (cb) =>
        ctx.subscribe(showToast, (calls) => {
          for (const c of calls) cb(c.payload);
        }),
      onPlaySound: (cb) =>
        ctx.subscribe(playSound, (calls) => {
          for (const c of calls) cb(c.payload);
        }),
      onIncrementBadge: (cb) =>
        ctx.subscribe(incrementBadge, (calls) => {
          for (const c of calls) cb(c.payload.channelId, c.payload.muted);
        }),
      onClearBadge: (cb) =>
        ctx.subscribe(clearBadge, (calls) => {
          for (const c of calls) cb(c.payload);
        }),
      onTypingChange: (cb) =>
        ctx.subscribe(typingChange, (calls) => {
          for (const c of calls) cb(c.payload);
        }),
      onMarkChannelRead: (cb) =>
        ctx.subscribe(markRead, (calls) => {
          for (const c of calls) cb(c.payload);
        }),
      dispose: () => {
        if (soundTimer) clearTimeout(soundTimer);
        if (channelTimer) clearTimeout(channelTimer);
      },
    };
  },
};
