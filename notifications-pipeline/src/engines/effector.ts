// Effector — events + stores + samples. The scenario is a graph: incoming
// `newMessage` event is gated through three independent `sample`s into three
// derived events (toast, sound, badge). The "rule" is the wiring; mental
// model: data flow, not control flow.

import { combine, createEffect, createEvent, createStore, sample } from 'effector';
import type { Engine, EngineFactory } from '../engine';
import type { Message, Settings, Sound, ToastPayload } from '../types';

export const effectorFactory: EngineFactory = {
  meta: {
    id: 'effector',
    label: 'Effector',
    description: 'Events + stores + samples wired into a graph.',
    sourcePath: 'comparisons/notifications-pipeline/src/engines/effector.ts',
  },
  create(): Engine {
    // ───── inputs ──────────────────────────────────────────────────────────
    const newMessage = createEvent<Message>();
    const settingsChanged = createEvent<Settings>();
    const activeChannelChanged = createEvent<string | null>();
    const currentUserChanged = createEvent<string>();

    const $settings = createStore<Settings | null>(null).on(settingsChanged, (_, s) => s);
    const $activeChannelId = createStore<string | null>(null).on(
      activeChannelChanged,
      (_, id) => id,
    );
    const $currentUserId = createStore<string | null>(null).on(
      currentUserChanged,
      (_, id) => id,
    );

    const $world = combine($settings, $activeChannelId, $currentUserId, (settings, ach, cu) => ({
      settings,
      activeChannelId: ach,
      currentUserId: cu,
    }));

    // Gate: drop messages from the active channel or from self.
    const gatedMessage = sample({
      clock: newMessage,
      source: $world,
      filter: (w, msg) =>
        w.settings != null &&
        w.currentUserId != null &&
        msg.channelId !== w.activeChannelId &&
        msg.authorId !== w.currentUserId,
      fn: (_, msg) => msg,
    });

    // ───── outputs ─────────────────────────────────────────────────────────
    const showToast = createEvent<ToastPayload>();
    const playSound = createEvent<Sound>();
    const incrementBadge = createEvent<string>();

    sample({
      clock: gatedMessage,
      source: $settings,
      filter: (s) => s != null && s.notifications,
      fn: (_, msg) => ({ title: msg.author, body: msg.text }),
      target: showToast,
    });

    // Debounced sound — effector core doesn't ship debounce (patronum does).
    // Keeping it in-line so the LOC count includes the cost of doing it by hand.
    let soundTimer: ReturnType<typeof setTimeout> | null = null;
    const beepFx = createEffect(() => {
      if (soundTimer != null) clearTimeout(soundTimer);
      soundTimer = setTimeout(() => playSound('beep'), 800);
    });
    sample({
      clock: gatedMessage,
      source: $settings,
      filter: (s) => s != null && s.sound && !s.dnd,
      target: beepFx,
    });

    sample({ clock: gatedMessage, fn: (msg) => msg.channelId, target: incrementBadge });

    return {
      fireMessage: newMessage,
      setSettings: settingsChanged,
      setActiveChannel: activeChannelChanged,
      setCurrentUser: currentUserChanged,
      onShowToast: (cb) => showToast.watch(cb),
      onPlaySound: (cb) => playSound.watch(cb),
      onIncrementBadge: (cb) => incrementBadge.watch(cb),
      dispose: () => {
        if (soundTimer != null) clearTimeout(soundTimer);
      },
    };
  },
};
