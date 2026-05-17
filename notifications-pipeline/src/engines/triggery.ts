// Triggery — one trigger file describes the whole rule. Conditions flow in
// via setters, actions flow out via subscriptions. The handler reads like a
// spec; ordering, gating and the debounce live in one place.

import { createRuntime, createTrigger } from '@triggery/core';
import type { Engine, EngineFactory } from '../engine';
import type { Message, Settings, Sound, ToastPayload } from '../types';

type Schema = {
  events: { 'new-message': Message };
  conditions: { settings: Settings; activeChannelId: string | null; currentUserId: string };
  actions: {
    showToast: ToastPayload;
    playSound: Sound;
    incrementBadge: string;
  };
};

export const triggeryFactory: EngineFactory = {
  meta: {
    id: 'triggery',
    label: 'Triggery',
    description: 'One trigger file describes the rule top-to-bottom.',
    sourcePath: 'comparisons/notifications-pipeline/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });

    let settings: Settings | null = null;
    let activeChannelId: string | null = null;
    let currentUserId: string | null = null;

    const toastSubs = new Set<(p: ToastPayload) => void>();
    const soundSubs = new Set<(s: Sound) => void>();
    const badgeSubs = new Set<(channelId: string) => void>();

    const trigger = createTrigger<Schema>(
      {
        id: 'message-received',
        events: ['new-message'],
        required: ['settings', 'currentUserId'],
        handler({ event, conditions, actions, check }) {
          const msg = event.payload;
          if (msg.channelId === conditions.activeChannelId) return;
          if (msg.authorId === conditions.currentUserId) return;

          if (check.is('settings', (s) => s.notifications)) {
            actions.showToast?.({ title: msg.author, body: msg.text });
          }
          if (check.is('settings', (s) => s.sound && !s.dnd)) {
            actions.debounce(800).playSound?.('beep');
          }
          actions.incrementBadge?.(msg.channelId);
        },
      },
      runtime,
    );

    runtime.registerCondition(trigger.id, 'settings', () => settings);
    runtime.registerCondition(trigger.id, 'activeChannelId', () => activeChannelId);
    runtime.registerCondition(trigger.id, 'currentUserId', () => currentUserId);

    runtime.registerAction(trigger.id, 'showToast', (p) => {
      for (const s of toastSubs) s(p as ToastPayload);
    });
    runtime.registerAction(trigger.id, 'playSound', (s) => {
      for (const sub of soundSubs) sub(s as Sound);
    });
    runtime.registerAction(trigger.id, 'incrementBadge', (id) => {
      for (const sub of badgeSubs) sub(id as string);
    });

    return {
      fireMessage: (msg) => runtime.fire('new-message', msg),
      setSettings: (s) => (settings = s),
      setActiveChannel: (id) => (activeChannelId = id),
      setCurrentUser: (id) => (currentUserId = id),
      onShowToast: (cb) => (toastSubs.add(cb), () => toastSubs.delete(cb)),
      onPlaySound: (cb) => (soundSubs.add(cb), () => soundSubs.delete(cb)),
      onIncrementBadge: (cb) => (badgeSubs.add(cb), () => badgeSubs.delete(cb)),
      dispose: () => runtime.dispose(),
    };
  },
};
