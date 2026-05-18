// Redux + thunk — imperative pattern. Input actions trigger thunks; each thunk
// reads `getState()`, decides, and dispatches output actions. A tiny output-
// router middleware fans output actions out to React subscribers. Throttle &
// debounce are hand-rolled (vanilla redux-thunk has no scheduling primitives).

import {
  configureStore,
  createAction,
  createSlice,
  type Middleware,
  type PayloadAction,
  type ThunkAction,
  type UnknownAction,
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
  muted: string[];
  conn: ConnectionState;
  prevConn: ConnectionState;
};

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
    setConn: (s, a: PayloadAction<ConnectionState>) => {
      s.prevConn = s.conn;
      s.conn = a.payload;
    },
  },
});

type RootState = { world: WorldState };
type AppThunk = ThunkAction<void, RootState, unknown, UnknownAction>;

export const reduxThunkFactory: EngineFactory = {
  meta: {
    id: 'redux-thunk',
    label: 'Redux + thunk',
    description: 'Plain redux-thunk: dispatch thunks per event, imperative inside.',
    sourcePath: 'notifications-pipeline/src/engines/redux-thunk.ts',
  },
  create(): Engine {
    const typingByChannel = new Map<string, Set<string>>();
    const toastWindow: number[] = []; // R7: throttle 3/sec
    const soundTimer: { id: ReturnType<typeof setTimeout> | null } = { id: null };
    const markReadTimer: { id: ReturnType<typeof setTimeout> | null } = { id: null };
    const spamWindow = new Map<string, number[]>(); // R15

    const outSubs = {
      toast: new Set<(t: ToastPayload) => void>(),
      sound: new Set<(s: Sound) => void>(),
      incBadge: new Set<(channelId: string, muted: boolean) => void>(),
      clearBadge: new Set<(channelId: string) => void>(),
      typing: new Set<(u: TypingUpdate) => void>(),
      markRead: new Set<(channelId: string) => void>(),
    };

    const router: Middleware<{}, RootState> = () => (next) => (action) => {
      const result = next(action);
      const a = action as UnknownAction;
      if (showToast.match(a)) outSubs.toast.forEach((cb) => cb(a.payload));
      else if (playSound.match(a)) outSubs.sound.forEach((cb) => cb(a.payload));
      else if (incBadge.match(a))
        outSubs.incBadge.forEach((cb) => cb(a.payload.channelId, a.payload.muted));
      else if (clearBadge.match(a)) outSubs.clearBadge.forEach((cb) => cb(a.payload));
      else if (typingChange.match(a)) outSubs.typing.forEach((cb) => cb(a.payload));
      else if (markRead.match(a)) outSubs.markRead.forEach((cb) => cb(a.payload));
      return result;
    };

    const store = configureStore({
      reducer: { world: slice.reducer },
      middleware: (gdm) => gdm({ serializableCheck: false }).concat(router),
    });

    // R1-R7 + R15 — message rule
    const messageThunk =
      (msg: Message): AppThunk =>
      (dispatch, getState) => {
        const w = getState().world;
        if (!w.user || msg.author.id === w.user.id) return;
        const isMention = msg.mentions.includes(w.user.id);
        const isMuted = w.muted.includes(msg.channelId);
        dispatch(incBadge({ channelId: msg.channelId, muted: isMuted }));

        // R15: per-author sliding window
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

        // R7 throttle: 3 toasts / sec — hand-rolled
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
        // R7 debounce: 600 ms — hand-rolled
        if (soundTimer.id) clearTimeout(soundTimer.id);
        soundTimer.id = setTimeout(() => {
          soundTimer.id = null;
          store.dispatch(playSound(isMention ? 'mention' : 'beep'));
        }, 600);
      };

    // R8-R9 typing tracker — closure state, dispatched as a single output
    const typingThunk =
      (kind: 'add' | 'delete', userId: string, channelId: string): AppThunk =>
      (dispatch) => {
        let set = typingByChannel.get(channelId);
        if (!set) typingByChannel.set(channelId, (set = new Set()));
        set[kind](userId);
        dispatch(typingChange({ channelId, userIds: [...set] }));
      };

    // R11 — debounced mark-read on channel switch
    const channelChangedThunk =
      (id: string | null): AppThunk =>
      () => {
        if (markReadTimer.id) clearTimeout(markReadTimer.id);
        if (id == null) return;
        markReadTimer.id = setTimeout(() => {
          markReadTimer.id = null;
          store.dispatch(markRead(id));
          store.dispatch(clearBadge(id));
        }, 2000);
      };

    // R12-R14 — connection transitions
    const connectionThunk =
      (next: ConnectionState): AppThunk =>
      (dispatch, getState) => {
        const prev = getState().world.conn;
        dispatch(slice.actions.setConn(next));
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
      };

    return {
      fireMessage: (m) => void store.dispatch(messageThunk(m)),
      fireTypingStart: (p) => void store.dispatch(typingThunk('add', p.userId, p.channelId)),
      fireTypingStop: (p) => void store.dispatch(typingThunk('delete', p.userId, p.channelId)),
      fireChannelChanged: (id) => {
        store.dispatch(slice.actions.setActive(id));
        store.dispatch(channelChangedThunk(id));
      },
      setConnectionState: (s) => void store.dispatch(connectionThunk(s)),
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
      dispose: () => {
        if (soundTimer.id) clearTimeout(soundTimer.id);
        if (markReadTimer.id) clearTimeout(markReadTimer.id);
      },
    };
  },
};
