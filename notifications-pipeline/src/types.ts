// Shared domain types — same across every engine implementation.
// Scenario: a Discord-like chat client.

export type User = {
  id: string;
  name: string;
  avatar: string; // emoji or single letter
  color: string;  // hex
};

export type Channel = {
  id: string;
  name: string;
  topic: string;
};

export type Message = {
  id: string;
  author: User;
  channelId: string;
  text: string;
  // Pre-extracted: user ids mentioned via @name in the text.
  mentions: readonly string[];
  emittedAt: number;
};

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export type Settings = {
  notifications: boolean;
  sound: boolean;
  dnd: boolean;
  // If true, suppress all toasts except @mentions.
  mentionsOnly: boolean;
};

export type Sound = 'beep' | 'mention' | 'reconnect';

export type ToastKind = 'message' | 'mention' | 'system';

export type ToastPayload = {
  id: string;
  kind: ToastKind;
  title: string;
  body: string;
  channelId?: string;
  authorAvatar?: string;
  authorColor?: string;
  emittedAt: number;
};

export type TypingUpdate = {
  channelId: string;
  userIds: readonly string[];
};

export type BadgeUpdate = {
  channelId: string;
  // Muted channels still get counted but rendered as grey in the sidebar.
  muted: boolean;
};
