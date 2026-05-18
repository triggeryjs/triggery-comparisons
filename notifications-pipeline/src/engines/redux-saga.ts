// Redux + saga — effect-as-data via generators. Each rule is a saga;
// `takeEvery`/`throttle`/`debounce`/`select`/`put`/`delay` come from
// `redux-saga/effects`. R7 toast throttle + R7 sound debounce + R11 mark-read
// settled-read window — all built-in saga effects, no hand-rolled timers.

import {
  configureStore,
  createAction,
  createSlice,
  type PayloadAction,
} from '@reduxjs/toolkit';
import createSagaMiddleware, { type Task } from 'redux-saga';
import {
  all,
  call,
  cancel,
  debounce,
  delay,
  fork,
  put,
  select,
  take,
  takeEvery,
  throttle,
} from 'redux-saga/effects';
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

type RootState = { world: WorldState };

// Suppression gate — shared between toast (throttled) and sound (debounced)
function passesNotifyGate(w: WorldState, msg: Message): { ok: boolean; isMention: boolean } {
  if (!w.user || msg.author.id === w.user.id) return { ok: false, isMention: false };
  const isMention = msg.mentions.includes(w.user.id);
  if (w.muted.includes(msg.channelId)) return { ok: false, isMention };
  if (msg.channelId === w.active) return { ok: false, isMention };
  if (!w.settings?.notifications) return { ok: false, isMention };
  if (w.settings.mentionsOnly && !isMention) return { ok: false, isMention };
  if (w.settings.dnd && !isMention) return { ok: false, isMention };
  return { ok: true, isMention };
}

export const reduxSagaFactory: EngineFactory = {
  meta: {
    id: 'redux-saga',
    label: 'Redux + saga',
    description: 'Generators + effect-as-data (takeEvery / throttle / debounce / select).',
    sourcePath: 'notifications-pipeline/src/engines/redux-saga.ts',
  },
  create(): Engine {
    const typingByChannel = new Map<string, Set<string>>();
    const spamWindow = new Map<string, number[]>(); // R15

    const outSubs = {
      toast: new Set<(t: ToastPayload) => void>(),
      sound: new Set<(s: Sound) => void>(),
      incBadge: new Set<(channelId: string, muted: boolean) => void>(),
      clearBadge: new Set<(channelId: string) => void>(),
      typing: new Set<(u: TypingUpdate) => void>(),
      markRead: new Set<(channelId: string) => void>(),
    };

    // R1, R2, R5 + R15 update — fires on EVERY message (badge always)
    function* handleBadge(action: ReturnType<typeof newMessage>): Generator {
      const w = (yield select((s: RootState) => s.world)) as WorldState;
      const msg = action.payload;
      if (!w.user || msg.author.id === w.user.id) return;
      yield put(
        incBadge({ channelId: msg.channelId, muted: w.muted.includes(msg.channelId) }),
      );
      // R15: maintain per-author sliding window — counted on every (non-echo) message
      const now = Date.now();
      const times = (spamWindow.get(msg.author.id) ?? []).filter((t) => t >= now - 30_000);
      times.push(now);
      spamWindow.set(msg.author.id, times);
    }

    // R6 + R7 toast — throttled 3/sec
    function* handleToast(action: ReturnType<typeof newMessage>): Generator {
      const w = (yield select((s: RootState) => s.world)) as WorldState;
      const msg = action.payload;
      const { ok, isMention } = passesNotifyGate(w, msg);
      if (!ok) return;
      if ((spamWindow.get(msg.author.id)?.length ?? 0) >= 5) return; // R15
      yield put(
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

    // R6 + R7 sound — debounced 600 ms (fires on the last message of the burst)
    function* handleSound(action: ReturnType<typeof newMessage>): Generator {
      const w = (yield select((s: RootState) => s.world)) as WorldState;
      const msg = action.payload;
      const { ok, isMention } = passesNotifyGate(w, msg);
      if (!ok) return;
      if ((spamWindow.get(msg.author.id)?.length ?? 0) >= 5) return; // R15
      yield put(playSound(isMention ? 'mention' : 'beep'));
    }

    // R8-R9 typing tracker — closure-held per-channel Set
    function* handleTyping(
      action: ReturnType<typeof typingStart> | ReturnType<typeof typingStop>,
    ): Generator {
      const { userId, channelId } = action.payload;
      let set = typingByChannel.get(channelId);
      if (!set) typingByChannel.set(channelId, (set = new Set()));
      if (typingStart.match(action)) set.add(userId);
      else set.delete(userId);
      yield put(typingChange({ channelId, userIds: [...set] }));
    }

    // R11 — settled-read window: fork + cancel + delay
    function* watchChannelChanged(): Generator {
      let pending: Task | null = null;
      while (true) {
        const action = (yield take(channelChanged)) as ReturnType<typeof channelChanged>;
        if (pending) yield cancel(pending);
        if (action.payload == null) continue;
        const id = action.payload;
        pending = (yield fork(function* () {
          yield delay(2000);
          yield put(markRead(id));
          yield put(clearBadge(id));
        })) as Task;
      }
    }

    // R12-R14 — connection transitions
    function* handleConnection(action: ReturnType<typeof connectionChanged>): Generator {
      const prev = (yield select((s: RootState) => s.world.prevConn)) as ConnectionState;
      const next = action.payload;
      if (next === prev) return;
      if (next === 'disconnected') {
        yield put(
          showToast({
            id: `sys-${Date.now()}`,
            kind: 'system',
            title: 'Connection lost',
            body: 'Trying to reconnect…',
            emittedAt: Date.now(),
          }),
        );
      } else if (next === 'connected' && prev === 'disconnected') {
        yield put(
          showToast({
            id: `sys-${Date.now()}`,
            kind: 'system',
            title: 'Reconnected',
            body: '',
            emittedAt: Date.now(),
          }),
        );
        yield put(playSound('reconnect'));
      }
    }

    // Output fan-out — listen to output actions, dispatch to React subscribers
    function* fanOut(): Generator {
      yield takeEvery(showToast, function* (a: ReturnType<typeof showToast>) {
        outSubs.toast.forEach((cb) => cb(a.payload));
        yield;
      });
      yield takeEvery(playSound, function* (a: ReturnType<typeof playSound>) {
        outSubs.sound.forEach((cb) => cb(a.payload));
        yield;
      });
      yield takeEvery(incBadge, function* (a: ReturnType<typeof incBadge>) {
        outSubs.incBadge.forEach((cb) => cb(a.payload.channelId, a.payload.muted));
        yield;
      });
      yield takeEvery(clearBadge, function* (a: ReturnType<typeof clearBadge>) {
        outSubs.clearBadge.forEach((cb) => cb(a.payload));
        yield;
      });
      yield takeEvery(typingChange, function* (a: ReturnType<typeof typingChange>) {
        outSubs.typing.forEach((cb) => cb(a.payload));
        yield;
      });
      yield takeEvery(markRead, function* (a: ReturnType<typeof markRead>) {
        outSubs.markRead.forEach((cb) => cb(a.payload));
        yield;
      });
    }

    function* root(): Generator {
      yield all([
        takeEvery(newMessage, handleBadge),
        throttle(1000 / 3, newMessage, handleToast),
        debounce(600, newMessage, handleSound),
        takeEvery([typingStart.type, typingStop.type], handleTyping),
        call(watchChannelChanged),
        takeEvery(connectionChanged, handleConnection),
        call(fanOut),
      ]);
    }

    const sagaMiddleware = createSagaMiddleware();
    const store = configureStore({
      reducer: { world: slice.reducer },
      middleware: (gdm) => gdm({ serializableCheck: false, thunk: false }).concat(sagaMiddleware),
    });
    const rootTask = sagaMiddleware.run(root);

    return {
      fireMessage: (m) => void store.dispatch(newMessage(m)),
      fireTypingStart: (p) => void store.dispatch(typingStart(p)),
      fireTypingStop: (p) => void store.dispatch(typingStop(p)),
      fireChannelChanged: (id) => {
        store.dispatch(slice.actions.setActive(id));
        store.dispatch(channelChanged(id));
      },
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
      dispose: () => rootTask.cancel(),
    };
  },
};
