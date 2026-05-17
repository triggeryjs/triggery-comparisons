// RxJS — Subjects as inputs/outputs, observable pipelines as the rules.
// Each rule is a pipe chain; gating happens in `filter`, fan-out in
// independent subscriptions. Throttle/debounce/scan handled by built-in
// operators (advantage over the hand-rolled effector version).

import {
  BehaviorSubject,
  EMPTY,
  Subject,
  combineLatest,
  debounceTime,
  filter,
  map,
  merge,
  pairwise,
  scan,
  startWith,
  switchMap,
  throttleTime,
  timer,
  withLatestFrom,
} from 'rxjs';
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

export const rxjsFactory: EngineFactory = {
  meta: {
    id: 'rxjs',
    label: 'RxJS',
    description: 'Subjects + operator pipelines; built-in throttle/debounce.',
    sourcePath: 'notifications-pipeline/src/engines/rxjs.ts',
  },
  create(): Engine {
    // ───── inputs ────────────────────────────────────────────────────
    const newMessage$ = new Subject<Message>();
    const typingStart$ = new Subject<{ userId: string; channelId: string }>();
    const typingStop$ = new Subject<{ userId: string; channelId: string }>();
    const channelChanged$ = new Subject<string | null>();
    const connection$ = new BehaviorSubject<ConnectionState>('connecting');
    const settings$ = new BehaviorSubject<Settings | null>(null);
    const active$ = new BehaviorSubject<string | null>(null);
    const user$ = new BehaviorSubject<User | null>(null);
    const muted$ = new BehaviorSubject<ReadonlySet<string>>(new Set());

    const world$ = combineLatest([settings$, active$, user$, muted$]).pipe(
      map(([settings, active, user, muted]) => ({ settings, active, user, muted })),
    );

    // ───── outputs ───────────────────────────────────────────────────
    const showToast$ = new Subject<ToastPayload>();
    const playSound$ = new Subject<Sound>();
    const incBadge$ = new Subject<{ channelId: string; muted: boolean }>();
    const clearBadge$ = new Subject<string>();
    const typingChange$ = new Subject<TypingUpdate>();
    const markRead$ = new Subject<string>();

    const isMention = (m: Message, u: User | null) => !!u && m.mentions.includes(u.id);

    // R5 — badge unconditional (post auth gate)
    const badgeSub = newMessage$
      .pipe(
        withLatestFrom(world$),
        filter(([m, w]) => w.user != null && m.author.id !== w.user.id),
        map(([m, w]) => ({ channelId: m.channelId, muted: w.muted.has(m.channelId) })),
      )
      .subscribe(incBadge$);

    // R6-R7 — gated notifications stream (reused for both toast and sound)
    const notify$ = newMessage$.pipe(
      withLatestFrom(world$),
      filter(([m, w]) => {
        if (!w.user || !w.settings) return false;
        if (m.author.id === w.user.id) return false;
        if (m.channelId === w.active) return false;
        if (w.muted.has(m.channelId)) return false;
        if (!w.settings.notifications) return false;
        const mentioned = isMention(m, w.user);
        if (w.settings.mentionsOnly && !mentioned) return false;
        if (w.settings.dnd && !mentioned) return false;
        return true;
      }),
      map(([m, w]) => ({ m, mentioned: isMention(m, w.user) })),
    );

    // R7a — throttle 3/sec on toast
    const toastSub = notify$
      .pipe(
        throttleTime(1000 / 3, undefined, { leading: true, trailing: false }),
        map(({ m, mentioned }): ToastPayload => ({
          id: m.id,
          kind: mentioned ? 'mention' : 'message',
          title: m.author.name,
          body: m.text,
          channelId: m.channelId,
          authorAvatar: m.author.avatar,
          authorColor: m.author.color,
          emittedAt: m.emittedAt,
        })),
      )
      .subscribe(showToast$);

    // R7b — debounce 600 ms on sound
    const soundSub = notify$
      .pipe(
        debounceTime(600),
        map(({ mentioned }): Sound => (mentioned ? 'mention' : 'beep')),
      )
      .subscribe(playSound$);

    // R8-R9 — typing tracker as scan over start/stop
    const typingSub = merge(
      typingStart$.pipe(map((e) => ({ ...e, kind: 'start' as const }))),
      typingStop$.pipe(map((e) => ({ ...e, kind: 'stop' as const }))),
    )
      .pipe(
        scan(
          (acc, e) => {
            const set = new Set(acc.byChannel.get(e.channelId) ?? []);
            if (e.kind === 'start') set.add(e.userId);
            else set.delete(e.userId);
            const next = new Map(acc.byChannel);
            next.set(e.channelId, set);
            return { byChannel: next, channelId: e.channelId };
          },
          { byChannel: new Map<string, Set<string>>(), channelId: '' },
        ),
        map((s): TypingUpdate => ({
          channelId: s.channelId,
          userIds: [...(s.byChannel.get(s.channelId) ?? [])],
        })),
      )
      .subscribe(typingChange$);

    // R11 — channel change → debounced mark read (switchMap cancels prior timer)
    const markReadSub = channelChanged$
      .pipe(
        switchMap((id) => (id == null ? EMPTY : timer(2000).pipe(map(() => id)))),
      )
      .subscribe((id) => {
        markRead$.next(id);
        clearBadge$.next(id);
      });

    // R12-R13 — connection transitions
    const connSub = connection$
      .pipe(
        startWith<ConnectionState>('connecting'),
        pairwise(),
        filter(([prev, next]) => prev !== next),
      )
      .subscribe(([prev, next]) => {
        if (next === 'disconnected') {
          showToast$.next({
            id: `sys-${Date.now()}`,
            kind: 'system',
            title: 'Connection lost',
            body: 'Trying to reconnect…',
            emittedAt: Date.now(),
          });
        } else if (next === 'connected' && prev === 'disconnected') {
          showToast$.next({
            id: `sys-${Date.now()}`,
            kind: 'system',
            title: 'Reconnected',
            body: '',
            emittedAt: Date.now(),
          });
          playSound$.next('reconnect');
        }
      });

    return {
      fireMessage: (msg) => newMessage$.next(msg),
      fireTypingStart: (p) => typingStart$.next(p),
      fireTypingStop: (p) => typingStop$.next(p),
      fireChannelChanged: (id) => channelChanged$.next(id),
      setConnectionState: (s) => connection$.next(s),
      setSettings: (s) => settings$.next(s),
      setActiveChannel: (id) => active$.next(id),
      setCurrentUser: (u) => user$.next(u),
      setMutedChannels: (ids) => muted$.next(ids),
      onShowToast: (cb) => {
        const s = showToast$.subscribe(cb);
        return () => s.unsubscribe();
      },
      onPlaySound: (cb) => {
        const s = playSound$.subscribe(cb);
        return () => s.unsubscribe();
      },
      onIncrementBadge: (cb) => {
        const s = incBadge$.subscribe((p) => cb(p.channelId, p.muted));
        return () => s.unsubscribe();
      },
      onClearBadge: (cb) => {
        const s = clearBadge$.subscribe(cb);
        return () => s.unsubscribe();
      },
      onTypingChange: (cb) => {
        const s = typingChange$.subscribe(cb);
        return () => s.unsubscribe();
      },
      onMarkChannelRead: (cb) => {
        const s = markRead$.subscribe(cb);
        return () => s.unsubscribe();
      },
      dispose: () => {
        badgeSub.unsubscribe();
        toastSub.unsubscribe();
        soundSub.unsubscribe();
        typingSub.unsubscribe();
        markReadSub.unsubscribe();
        connSub.unsubscribe();
      },
    };
  },
};
