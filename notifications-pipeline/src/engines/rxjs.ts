// RxJS — Subjects as inputs/outputs, observable pipeline as the rule.
// Mental model: a stream of messages goes through operators that gate, fork
// and debounce it. The "rule" is the operator chain.

import {
  BehaviorSubject,
  Subject,
  combineLatest,
  debounceTime,
  filter,
  map,
  withLatestFrom,
} from 'rxjs';
import type { Engine, EngineFactory } from '../engine';
import type { Message, Settings, Sound, ToastPayload } from '../types';

export const rxjsFactory: EngineFactory = {
  meta: {
    id: 'rxjs',
    label: 'RxJS',
    description: 'Subjects + operator pipeline.',
    sourcePath: 'notifications-pipeline/src/engines/rxjs.ts',
  },
  create(): Engine {
    // ───── inputs ──────────────────────────────────────────────────────────
    const newMessage$ = new Subject<Message>();
    const settings$ = new BehaviorSubject<Settings | null>(null);
    const activeChannelId$ = new BehaviorSubject<string | null>(null);
    const currentUserId$ = new BehaviorSubject<string | null>(null);

    const world$ = combineLatest([settings$, activeChannelId$, currentUserId$]).pipe(
      map(([settings, activeChannelId, currentUserId]) => ({
        settings,
        activeChannelId,
        currentUserId,
      })),
    );

    // Gated stream — same as effector's gatedMessage.
    const gated$ = newMessage$.pipe(
      withLatestFrom(world$),
      filter(
        ([msg, w]) =>
          w.settings != null &&
          w.currentUserId != null &&
          msg.channelId !== w.activeChannelId &&
          msg.authorId !== w.currentUserId,
      ),
      map(([msg]) => msg),
    );

    // ───── outputs ─────────────────────────────────────────────────────────
    const toast$ = new Subject<ToastPayload>();
    const sound$ = new Subject<Sound>();
    const badge$ = new Subject<string>();

    const toastSub = gated$
      .pipe(
        withLatestFrom(settings$),
        filter(([, s]) => s != null && s.notifications),
        map(([msg]) => ({ title: msg.author, body: msg.text })),
      )
      .subscribe(toast$);

    const soundSub = gated$
      .pipe(
        withLatestFrom(settings$),
        filter(([, s]) => s != null && s.sound && !s.dnd),
        debounceTime(800),
        map(() => 'beep' as const),
      )
      .subscribe(sound$);

    const badgeSub = gated$.pipe(map((msg) => msg.channelId)).subscribe(badge$);

    return {
      fireMessage: (msg) => newMessage$.next(msg),
      setSettings: (s) => settings$.next(s),
      setActiveChannel: (id) => activeChannelId$.next(id),
      setCurrentUser: (id) => currentUserId$.next(id),
      onShowToast: (cb) => {
        const s = toast$.subscribe(cb);
        return () => s.unsubscribe();
      },
      onPlaySound: (cb) => {
        const s = sound$.subscribe(cb);
        return () => s.unsubscribe();
      },
      onIncrementBadge: (cb) => {
        const s = badge$.subscribe(cb);
        return () => s.unsubscribe();
      },
      dispose: () => {
        toastSub.unsubscribe();
        soundSub.unsubscribe();
        badgeSub.unsubscribe();
        newMessage$.complete();
        toast$.complete();
        sound$.complete();
        badge$.complete();
      },
    };
  },
};
