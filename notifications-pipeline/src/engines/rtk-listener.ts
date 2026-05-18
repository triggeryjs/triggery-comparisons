// RTK listenerMiddleware — slice holds the world; per-event listeners run the
// rules and dispatch output actions; per-output listeners fan out to React
// subscribers. Debounce via `cancelActiveListeners()` + `delay()`. Throttle
// done by hand (RTK has no built-in throttle).

import {
  configureStore,
  createAction,
  createListenerMiddleware,
  createSlice,
  type PayloadAction,
} from '@reduxjs/toolkit';
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

type WorldState = {
  settings: Settings | null;
  active: string | null;
  user: User | null;
  muted: string[]; // serializable: Set → array
  conn: ConnectionState;
  prevConn: ConnectionState;
};

const newMessage = createAction<Message>('inbox/newMessage');
const typingStart = createAction<{ userId: string; channelId: string }>('inbox/typingStart');
const typingStop = createAction<{ userId: string; channelId: string }>('inbox/typingStop');
const channelChanged = createAction<string | null>('inbox/channelChanged');
const connectionChanged = createAction<ConnectionState>('inbox/connectionChanged');

const showToast = createAction<ToastPayload>('out/showToast');
const playSound = createAction<Sound>('out/playSound');
const incBadge = createAction<{ channelId: string; muted: boolean }>('out/incrementBadge');
const clearBadge = createAction<string>('out/clearBadge');
const typingChange = createAction<TypingUpdate>('out/typingChange');
const markRead = createAction<string>('out/markRead');

const slice = createSlice({
  name: 'world',
  initialState: {
    settings: null,
    active: null,
    user: null,
    muted: [],
    conn: 'connecting',
    prevConn: 'connecting',
  } as WorldState,
  reducers: {
    setSettings: (s, a: PayloadAction<Settings>) => {
      s.settings = a.payload;
    },
    setActive: (s, a: PayloadAction<string | null>) => {
      s.active = a.payload;
    },
    setUser: (s, a: PayloadAction<User | null>) => {
      s.user = a.payload;
    },
    setMuted: (s, a: PayloadAction<string[]>) => {
      s.muted = a.payload;
    },
  },
  extraReducers: (b) =>
    b.addCase(connectionChanged, (s, a) => {
      s.prevConn = s.conn;
      s.conn = a.payload;
    }),
});

export const rtkListenerFactory: EngineFactory = {
  meta: {
    id: 'rtk',
    label: 'RTK listenerMiddleware',
    description: 'Redux Toolkit + listenerMiddleware, idiomatic debounce via delay().',
    sourcePath: 'notifications-pipeline/src/engines/rtk-listener.ts',
  },
  create(): Engine {
    const listener = createListenerMiddleware();
    const store = configureStore({
      reducer: { world: slice.reducer },
      middleware: (gdm) => gdm({ serializableCheck: false }).prepend(listener.middleware),
    });

    const typingByChannel = new Map<string, Set<string>>();
    const toastWindow: number[] = [];
    const spamWindow = new Map<string, number[]>(); // R15

    // R1-R7 — main message rule
    listener.startListening({
      actionCreator: newMessage,
      effect: async (a, { getState, dispatch, cancelActiveListeners, delay }) => {
        const w = (getState() as { world: WorldState }).world;
        const msg = a.payload;
        if (!w.user || msg.author.id === w.user.id) return;

        const isMention = msg.mentions.includes(w.user.id);
        const isMuted = w.muted.includes(msg.channelId);
        dispatch(incBadge({ channelId: msg.channelId, muted: isMuted }));

        // R15: 5+ messages from this author in last 30 s → suppress
        const now = Date.now();
        const times = (spamWindow.get(msg.author.id) ?? []).filter((t) => t >= now - 30_000);
        times.push(now);
        spamWindow.set(msg.author.id, times);
        if (times.length >= 5) return;

        if (msg.channelId === w.active) return;
        if (isMuted) return;
        if (!w.settings?.notifications) return;
        if (w.settings.mentionsOnly && !isMention) return;
        if (w.settings.dnd && !isMention) return;

        while (toastWindow.length && now - toastWindow[0]! >= 1000) toastWindow.shift();
        if (toastWindow.length < 3) {
          toastWindow.push(now);
          dispatch(
            showToast({
              id: msg.id,
              kind: isMention ? 'mention' : 'message',
              title: msg.author.name,
              body: msg.text,
              channelId: msg.channelId,
              authorAvatar: msg.author.avatar,
              authorColor: msg.author.color,
              emittedAt: msg.emittedAt,
            }),
          );
        }

        cancelActiveListeners();
        await delay(600);
        dispatch(playSound(isMention ? 'mention' : 'beep'));
      },
    });

    // R8-R9 — typing tracker
    listener.startListening({
      matcher: (a): a is ReturnType<typeof typingStart> | ReturnType<typeof typingStop> =>
        typingStart.match(a) || typingStop.match(a),
      effect: (a, { dispatch }) => {
        const { userId, channelId } = a.payload;
        let set = typingByChannel.get(channelId);
        if (!set) {
          set = new Set();
          typingByChannel.set(channelId, set);
        }
        if (typingStart.match(a)) set.add(userId);
        else set.delete(userId);
        dispatch(typingChange({ channelId, userIds: [...set] }));
      },
    });

    // R11 — debounced mark-read on channel switch
    listener.startListening({
      actionCreator: channelChanged,
      effect: async (a, { dispatch, cancelActiveListeners, delay }) => {
        if (a.payload == null) return;
        cancelActiveListeners();
        await delay(2000);
        dispatch(markRead(a.payload));
        dispatch(clearBadge(a.payload));
      },
    });

    // R12-R13 — connection transitions
    listener.startListening({
      actionCreator: connectionChanged,
      effect: (_, { dispatch, getOriginalState, getState }) => {
        const prev = (getOriginalState() as { world: WorldState }).world.conn;
        const next = (getState() as { world: WorldState }).world.conn;
        if (next === prev) return;
        if (next === 'disconnected') {
          dispatch(
            showToast({
              id: `sys-${Date.now()}`,
              kind: 'system',
              title: 'Connection lost',
              body: 'Trying to reconnect…',
              emittedAt: Date.now(),
            }),
          );
        } else if (next === 'connected' && prev === 'disconnected') {
          dispatch(
            showToast({
              id: `sys-${Date.now()}`,
              kind: 'system',
              title: 'Reconnected',
              body: '',
              emittedAt: Date.now(),
            }),
          );
          dispatch(playSound('reconnect'));
        }
      },
    });

    // Fan-out per output action
    const outSubs = {
      toast: new Set<(t: ToastPayload) => void>(),
      sound: new Set<(s: Sound) => void>(),
      incBadge: new Set<(channelId: string, muted: boolean) => void>(),
      clearBadge: new Set<(channelId: string) => void>(),
      typing: new Set<(u: TypingUpdate) => void>(),
      markRead: new Set<(channelId: string) => void>(),
    };
    listener.startListening({
      actionCreator: showToast,
      effect: (a) => outSubs.toast.forEach((cb) => cb(a.payload)),
    });
    listener.startListening({
      actionCreator: playSound,
      effect: (a) => outSubs.sound.forEach((cb) => cb(a.payload)),
    });
    listener.startListening({
      actionCreator: incBadge,
      effect: (a) => outSubs.incBadge.forEach((cb) => cb(a.payload.channelId, a.payload.muted)),
    });
    listener.startListening({
      actionCreator: clearBadge,
      effect: (a) => outSubs.clearBadge.forEach((cb) => cb(a.payload)),
    });
    listener.startListening({
      actionCreator: typingChange,
      effect: (a) => outSubs.typing.forEach((cb) => cb(a.payload)),
    });
    listener.startListening({
      actionCreator: markRead,
      effect: (a) => outSubs.markRead.forEach((cb) => cb(a.payload)),
    });

    return {
      fireMessage: (m) => void store.dispatch(newMessage(m)),
      fireTypingStart: (p) => void store.dispatch(typingStart(p)),
      fireTypingStop: (p) => void store.dispatch(typingStop(p)),
      fireChannelChanged: (id) => void store.dispatch(channelChanged(id)),
      setConnectionState: (s) => void store.dispatch(connectionChanged(s)),
      setSettings: (s) => void store.dispatch(slice.actions.setSettings(s)),
      setActiveChannel: (id) => void store.dispatch(slice.actions.setActive(id)),
      setCurrentUser: (u) => void store.dispatch(slice.actions.setUser(u)),
      setMutedChannels: (ids) => void store.dispatch(slice.actions.setMuted([...ids])),
      onShowToast: (cb) => (outSubs.toast.add(cb), () => outSubs.toast.delete(cb)),
      onPlaySound: (cb) => (outSubs.sound.add(cb), () => outSubs.sound.delete(cb)),
      onIncrementBadge: (cb) => (outSubs.incBadge.add(cb), () => outSubs.incBadge.delete(cb)),
      onClearBadge: (cb) => (outSubs.clearBadge.add(cb), () => outSubs.clearBadge.delete(cb)),
      onTypingChange: (cb) => (outSubs.typing.add(cb), () => outSubs.typing.delete(cb)),
      onMarkChannelRead: (cb) => (outSubs.markRead.add(cb), () => outSubs.markRead.delete(cb)),
      dispose: () => listener.clearListeners(),
    };
  },
};
