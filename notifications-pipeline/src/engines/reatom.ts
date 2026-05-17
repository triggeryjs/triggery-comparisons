// Reatom — atoms hold conditions, actions carry events. The rule lives in a
// callback that reads ctx, fires the right output actions. Mental model: a
// scope with reactive atoms; actions are functions you wire side-effects to.
//
// Using reatom v3 (the @reatom/core ^3.x package on npm). The newer v1001
// branch reshuffles the public surface — we're sticking to v3 for parity
// with what most production reatom users see today.

import { action, atom, createCtx } from '@reatom/core';
import type { Engine, EngineFactory } from '../engine';
import type { Message, Settings, Sound, ToastPayload } from '../types';

export const reatomFactory: EngineFactory = {
  meta: {
    id: 'reatom',
    label: 'Reatom',
    description: 'Atoms hold conditions, actions carry events.',
    sourcePath: 'notifications-pipeline/src/engines/reatom.ts',
  },
  create(): Engine {
    const ctx = createCtx();

    const settingsAtom = atom<Settings | null>(null, 'settings');
    const activeChannelIdAtom = atom<string | null>(null, 'activeChannelId');
    const currentUserIdAtom = atom<string | null>(null, 'currentUserId');

    const showToastAction = action((_, p: ToastPayload) => p, 'showToast');
    const playSoundAction = action((_, s: Sound) => s, 'playSound');
    const incrementBadgeAction = action((_, channelId: string) => channelId, 'incrementBadge');

    let soundTimer: ReturnType<typeof setTimeout> | null = null;

    const newMessageAction = action((c, msg: Message) => {
      const settings = c.get(settingsAtom);
      const activeChannelId = c.get(activeChannelIdAtom);
      const currentUserId = c.get(currentUserIdAtom);

      if (settings == null || currentUserId == null) return;
      if (msg.channelId === activeChannelId) return;
      if (msg.authorId === currentUserId) return;

      if (settings.notifications) {
        showToastAction(c, { title: msg.author, body: msg.text });
      }
      if (settings.sound && !settings.dnd) {
        if (soundTimer != null) clearTimeout(soundTimer);
        soundTimer = setTimeout(() => playSoundAction(c, 'beep'), 800);
      }
      incrementBadgeAction(c, msg.channelId);
    }, 'newMessage');

    return {
      fireMessage: (msg) => newMessageAction(ctx, msg),
      setSettings: (s) => settingsAtom(ctx, s),
      setActiveChannel: (id) => activeChannelIdAtom(ctx, id),
      setCurrentUser: (id) => currentUserIdAtom(ctx, id),
      onShowToast: (cb) =>
        ctx.subscribe(showToastAction, (calls) => {
          for (const c of calls) cb(c.payload);
        }),
      onPlaySound: (cb) =>
        ctx.subscribe(playSoundAction, (calls) => {
          for (const c of calls) cb(c.payload);
        }),
      onIncrementBadge: (cb) =>
        ctx.subscribe(incrementBadgeAction, (calls) => {
          for (const c of calls) cb(c.payload);
        }),
      dispose: () => {
        if (soundTimer != null) clearTimeout(soundTimer);
      },
    };
  },
};
