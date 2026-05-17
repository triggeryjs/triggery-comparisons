// Shared domain types — same across every engine implementation.

export type Message = {
  id: string;
  author: string;
  authorId: string;
  text: string;
  channelId: string;
};

export type Settings = {
  sound: boolean;
  notifications: boolean;
  dnd: boolean;
};

export type Sound = 'beep' | 'mention';

export type ToastPayload = { title: string; body: string };
