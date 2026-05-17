// "Naked" baseline — no orchestration library. Plain JavaScript: a tiny
// emitter, three setters that mutate captured variables, one `fire` method
// that contains the rule top-to-bottom.
//
// This is what you write when you reach for "I don't need a library" and want
// to see how much that costs you in code-per-scenario. Honest comparison.

import type { Engine, EngineFactory } from '../engine';
import type { Message, Settings, Sound, ToastPayload } from '../types';

function emitter<T>() {
  const subs = new Set<(v: T) => void>();
  return {
    emit: (v: T) => {
      for (const s of subs) s(v);
    },
    on: (cb: (v: T) => void) => (subs.add(cb), () => subs.delete(cb)),
  };
}

export const nakedFactory: EngineFactory = {
  meta: {
    id: 'naked',
    label: 'Naked (no library)',
    description: 'Plain JS — tiny emitter + setters + a fire method.',
    sourcePath: 'notifications-pipeline/src/engines/naked.ts',
  },
  create(): Engine {
    let settings: Settings | null = null;
    let activeChannelId: string | null = null;
    let currentUserId: string | null = null;
    let soundTimer: ReturnType<typeof setTimeout> | null = null;

    const toast = emitter<ToastPayload>();
    const sound = emitter<Sound>();
    const badge = emitter<string>();

    return {
      fireMessage: (msg: Message) => {
        if (settings == null || currentUserId == null) return;
        if (msg.channelId === activeChannelId) return;
        if (msg.authorId === currentUserId) return;

        if (settings.notifications) {
          toast.emit({ title: msg.author, body: msg.text });
        }
        if (settings.sound && !settings.dnd) {
          if (soundTimer != null) clearTimeout(soundTimer);
          soundTimer = setTimeout(() => sound.emit('beep'), 800);
        }
        badge.emit(msg.channelId);
      },
      setSettings: (s) => (settings = s),
      setActiveChannel: (id) => (activeChannelId = id),
      setCurrentUser: (id) => (currentUserId = id),
      onShowToast: (cb) => toast.on(cb),
      onPlaySound: (cb) => sound.on(cb),
      onIncrementBadge: (cb) => badge.on(cb),
      dispose: () => {
        if (soundTimer != null) clearTimeout(soundTimer);
      },
    };
  },
};
