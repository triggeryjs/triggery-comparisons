// Event-source simulator. Drives the engine the way a real WS server would —
// a stream of new messages, occasional typing indicators, sporadic
// disconnect/reconnect blips.

import type { Engine } from './engine';
import { CHANNELS, USERS, makeMessage, randomMessage } from './scenario';

export interface Simulator {
  start(): void;
  stop(): void;
  fireOne(): void;
  fireMention(): void;
  fireBurst(count: number): void;
  simulateDisconnect(): void;
  makeTyping(seconds?: number): void;
}

export function createSimulator(engine: Engine): Simulator {
  let autoTimer: ReturnType<typeof setInterval> | null = null;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    start() {
      if (autoTimer) return;
      autoTimer = setInterval(() => {
        engine.fireMessage(randomMessage());
      }, 1500);
    },
    stop() {
      if (autoTimer) clearInterval(autoTimer);
      autoTimer = null;
    },
    fireOne() {
      engine.fireMessage(randomMessage());
    },
    fireMention() {
      const others = USERS.filter((u) => u.id !== 'me');
      const author = others[Math.floor(Math.random() * others.length)]!;
      const channel = CHANNELS[Math.floor(Math.random() * CHANNELS.length)]!;
      engine.fireMessage(
        makeMessage({ channelId: channel.id, authorId: author.id, mention: true }),
      );
    },
    fireBurst(count) {
      for (let i = 0; i < count; i++) {
        setTimeout(() => engine.fireMessage(randomMessage()), i * 50);
      }
    },
    simulateDisconnect() {
      engine.setConnectionState('disconnected');
      setTimeout(() => engine.setConnectionState('connecting'), 500);
      setTimeout(() => engine.setConnectionState('connected'), 2500);
    },
    makeTyping(seconds = 3) {
      const others = USERS.filter((u) => u.id !== 'me');
      const author = others[Math.floor(Math.random() * others.length)]!;
      const channel = CHANNELS[Math.floor(Math.random() * CHANNELS.length)]!;
      engine.fireTypingStart({ userId: author.id, channelId: channel.id });
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        engine.fireTypingStop({ userId: author.id, channelId: channel.id });
      }, seconds * 1000);
    },
  };
}
