// Mock scenario data — channels, users, sample messages. Shared by every engine
// so the comparison is on the orchestration code, not on the mock fixtures.

import type { Channel, Message, User } from './types';

export const ME: User = { id: 'me', name: 'me', avatar: '🦊', color: '#af37c5' };

export const USERS: readonly User[] = [
  ME,
  { id: 'alice', name: 'Alice', avatar: '👩‍💻', color: '#5865f2' },
  { id: 'bob', name: 'Bob', avatar: '🧑‍🎨', color: '#23a55a' },
  { id: 'carol', name: 'Carol', avatar: '🧑‍🔬', color: '#f0b232' },
  { id: 'dave', name: 'Dave', avatar: '🧑‍🚀', color: '#ed4245' },
  { id: 'eve', name: 'Eve', avatar: '🧝', color: '#eb459e' },
];

export const CHANNELS: readonly Channel[] = [
  { id: 'general', name: 'general', topic: 'team-wide chat' },
  { id: 'design', name: 'design', topic: 'mockups + reviews' },
  { id: 'engineering', name: 'engineering', topic: 'merges and migrations' },
  { id: 'random', name: 'random', topic: 'gifs, memes, off-topic' },
  { id: 'announcements', name: 'announcements', topic: 'broadcast only' },
];

const TEMPLATES: readonly string[] = [
  'hey, did you see the new mockup?',
  'merged the PR, builds are green',
  'lunch in 10?',
  'reviewing your changes now',
  'we should probably refactor this',
  'this is wild, look at this number',
  'standing by in the call',
  'fixed the flaky test',
  'logs look clean now',
  'rolling out to staging',
  'who owns the auth module?',
  'CSS is fighting me again',
  'this feels overengineered',
  'noticed a regression in prod',
  'cache invalidation strikes again',
];

const MENTION_TEMPLATES: readonly string[] = [
  '@me can you take a look?',
  '@me PR is ready when you are',
  '@me thoughts on this approach?',
  'cc @me — relevant to your work',
  '@me ping when you have a sec',
];

let counter = 0;

export function makeMessage(opts?: {
  channelId?: string;
  authorId?: string;
  mention?: boolean;
}): Message {
  const channelId = opts?.channelId ?? CHANNELS[counter % CHANNELS.length]!.id;
  const author =
    USERS.find((u) => u.id === (opts?.authorId ?? 'alice')) ?? USERS[1]!;
  const mention = opts?.mention ?? Math.random() < 0.15;
  const text = mention
    ? MENTION_TEMPLATES[Math.floor(Math.random() * MENTION_TEMPLATES.length)]!
    : TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)]!;
  const mentions = mention ? ['me'] : [];

  return {
    id: `msg-${++counter}-${Math.random().toString(36).slice(2, 7)}`,
    author,
    channelId,
    text,
    mentions,
    emittedAt: Date.now(),
  };
}

export function randomMessage(): Message {
  const channel = CHANNELS[Math.floor(Math.random() * CHANNELS.length)]!;
  const others = USERS.filter((u) => u.id !== 'me');
  const author = others[Math.floor(Math.random() * others.length)]!;
  return makeMessage({ channelId: channel.id, authorId: author.id });
}
