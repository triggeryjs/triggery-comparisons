// RTK listenerMiddleware — the "official Redux side-effects" approach since
// Redux Saga / Observable. Slice holds the world; one listener on `newMessage`
// reads the slice, gates and dispatches output actions; per-output listeners
// fan out to React subscribers.
//
// Uses `cancelActiveListeners()` + `delay()` for debounce — that's the
// idiomatic RTK pattern, not setTimeout in the effect body.

import {
  configureStore,
  createAction,
  createListenerMiddleware,
  createSlice,
} from '@reduxjs/toolkit';
import type { Engine, EngineFactory } from '../engine';
import type { Message, Settings, Sound, ToastPayload } from '../types';

type WorldState = {
  settings: Settings | null;
  activeChannelId: string | null;
  currentUserId: string | null;
};

const newMessage = createAction<Message>('inbox/newMessage');
const showToast = createAction<ToastPayload>('output/showToast');
const playSound = createAction<Sound>('output/playSound');
const incrementBadge = createAction<string>('output/incrementBadge');

const slice = createSlice({
  name: 'world',
  initialState: {
    settings: null,
    activeChannelId: null,
    currentUserId: null,
  } as WorldState,
  reducers: {
    setSettings: (s, a: { payload: Settings }) => {
      s.settings = a.payload;
    },
    setActiveChannel: (s, a: { payload: string | null }) => {
      s.activeChannelId = a.payload;
    },
    setCurrentUser: (s, a: { payload: string }) => {
      s.currentUserId = a.payload;
    },
  },
});

export const rtkListenerFactory: EngineFactory = {
  meta: {
    id: 'rtk',
    label: 'RTK listenerMiddleware',
    description: 'Redux Toolkit + listenerMiddleware.',
    sourcePath: 'notifications-pipeline/src/engines/rtk-listener.ts',
  },
  create(): Engine {
    const listener = createListenerMiddleware();

    const store = configureStore({
      reducer: { world: slice.reducer },
      middleware: (gdm) => gdm().prepend(listener.middleware),
    });

    const toastSubs = new Set<(p: ToastPayload) => void>();
    const soundSubs = new Set<(s: Sound) => void>();
    const badgeSubs = new Set<(channelId: string) => void>();

    listener.startListening({
      actionCreator: newMessage,
      effect: async (action, { getState, dispatch, cancelActiveListeners, delay }) => {
        const { settings, activeChannelId, currentUserId } = (
          getState() as { world: WorldState }
        ).world;
        const msg = action.payload;
        if (settings == null || currentUserId == null) return;
        if (msg.channelId === activeChannelId) return;
        if (msg.authorId === currentUserId) return;

        if (settings.notifications) {
          dispatch(showToast({ title: msg.author, body: msg.text }));
        }
        if (settings.sound && !settings.dnd) {
          cancelActiveListeners();
          await delay(800);
          dispatch(playSound('beep'));
        }
        dispatch(incrementBadge(msg.channelId));
      },
    });

    listener.startListening({
      actionCreator: showToast,
      effect: (a) => toastSubs.forEach((cb) => cb(a.payload)),
    });
    listener.startListening({
      actionCreator: playSound,
      effect: (a) => soundSubs.forEach((cb) => cb(a.payload)),
    });
    listener.startListening({
      actionCreator: incrementBadge,
      effect: (a) => badgeSubs.forEach((cb) => cb(a.payload)),
    });

    return {
      fireMessage: (msg) => void store.dispatch(newMessage(msg)),
      setSettings: (s) => void store.dispatch(slice.actions.setSettings(s)),
      setActiveChannel: (id) => void store.dispatch(slice.actions.setActiveChannel(id)),
      setCurrentUser: (id) => void store.dispatch(slice.actions.setCurrentUser(id)),
      onShowToast: (cb) => (toastSubs.add(cb), () => toastSubs.delete(cb)),
      onPlaySound: (cb) => (soundSubs.add(cb), () => soundSubs.delete(cb)),
      onIncrementBadge: (cb) => (badgeSubs.add(cb), () => badgeSubs.delete(cb)),
      dispose: () => listener.clearListeners(),
    };
  },
};
