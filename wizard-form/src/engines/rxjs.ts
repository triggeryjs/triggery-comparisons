// RxJS — a single Subject<Action> feeds a `scan` reducer, with side-effects
// (email check, draft save, submit) wired via separate streams that share
// `actions$` upstream. Debounce uses the built-in `debounceTime` + `switchMap`;
// no hand-rolled timers.

import {
  BehaviorSubject,
  EMPTY,
  Subject,
  Subscription,
  combineLatest,
  defer,
  from,
  merge,
  of,
} from 'rxjs';
import {
  debounceTime,
  distinctUntilChanged,
  filter,
  map,
  scan,
  startWith,
  switchMap,
  tap,
  withLatestFrom,
} from 'rxjs/operators';
import type { Engine, EngineFactory, Unsubscribe } from '../engine';
import {
  DRAFT_DEBOUNCE_MS,
  EMAIL_DEBOUNCE_MS,
  REFERRAL_DEBOUNCE_MS,
  STORAGE_KEY,
  USERNAME_DEBOUNCE_MS,
  checkEmailAvailable,
  checkUsernameAvailable,
  emptyData,
  initialSnapshot,
  lookupReferralCode,
  nextStep,
  prevStep,
  progressFor,
  submitWizard,
  validateStep,
} from '../scenario';
import type { FieldName, Step, WizardData, WizardSnapshot } from '../types';

type Action =
  | { type: 'set'; name: FieldName; value: WizardData[FieldName] }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'submit' }
  | { type: 'reset' }
  | { type: 'loadDraft'; data: WizardData; step: Step }
  | { type: 'emailChecked'; reqId: number; available: boolean }
  | { type: 'usernameChecked'; reqId: number; available: boolean }
  | { type: 'referralLookedUp'; reqId: number; referrerName: string | null }
  | { type: 'submitDone'; ok: boolean; userId?: string; error?: string };

export const rxjsFactory: EngineFactory = {
  meta: {
    id: 'rxjs',
    label: 'RxJS',
    description: 'Subject<Action> + scan reducer; debounce / switchMap for email + draft + submit.',
    sourcePath: 'wizard-form/src/engines/rxjs.ts',
  },
  create(): Engine {
    const actions$ = new Subject<Action>();
    const snapshot$ = new BehaviorSubject<WizardSnapshot>(initialSnapshot());
    let emailReqId = 0;
    let usernameReqId = 0;
    let referralReqId = 0;

    const persist = (data: WizardData, step: Step) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, step }));
      } catch {
        // ignore
      }
    };

    const reduce = (s: WizardSnapshot, a: Action): WizardSnapshot => {
      switch (a.type) {
        case 'set': {
          const data = { ...s.data, [a.name]: a.value };
          if (a.name === 'email') {
            return { ...s, data, emailStatus: a.value ? 'checking' : 'idle' };
          }
          if (a.name === 'username') {
            return { ...s, data, usernameStatus: a.value ? 'checking' : 'idle' };
          }
          if (a.name === 'referralCode') {
            return {
              ...s,
              data,
              referralStatus: a.value ? 'checking' : 'idle',
              referrerName: a.value ? s.referrerName : null,
            };
          }
          return { ...s, data };
        }
        case 'next': {
          if (s.submit.kind === 'submitting') return s;
          const errs = validateStep(
            s.step, s.data, s.emailStatus, s.usernameStatus, s.referralStatus,
          );
          if (Object.keys(errs).length > 0) return { ...s, errors: errs };
          const ns = nextStep(s.step, s.data);
          if (!ns) return s;
          return { ...s, step: ns, errors: {}, progress: progressFor(ns) };
        }
        case 'back': {
          if (s.submit.kind === 'submitting') return s;
          const ps = prevStep(s.step, s.data);
          if (!ps) return s;
          return { ...s, step: ps, errors: {}, progress: progressFor(ps) };
        }
        case 'submit': {
          if (s.step !== 'review' || s.submit.kind === 'submitting') return s;
          return { ...s, submit: { kind: 'submitting' } };
        }
        case 'submitDone':
          return {
            ...s,
            submit: a.ok
              ? { kind: 'success', userId: a.userId as string }
              : { kind: 'error', message: a.error as string },
          };
        case 'reset':
          return { ...initialSnapshot(), data: emptyData() };
        case 'loadDraft':
          return {
            ...s,
            data: { ...emptyData(), ...a.data },
            step: a.step,
            progress: progressFor(a.step),
          };
        case 'emailChecked':
          return { ...s, emailStatus: a.available ? 'valid' : 'invalid' };
        case 'usernameChecked':
          return { ...s, usernameStatus: a.available ? 'valid' : 'invalid' };
        case 'referralLookedUp':
          return {
            ...s,
            referralStatus: a.referrerName ? 'valid' : 'invalid',
            referrerName: a.referrerName,
          };
      }
    };

    const state$ = actions$.pipe(scan(reduce, initialSnapshot()), startWith(initialSnapshot()));

    // Email debounce — only emit on email-set actions; switchMap cancels in-flight.
    const emailSet$ = actions$.pipe(
      filter((a): a is Extract<Action, { type: 'set' }> => a.type === 'set' && a.name === 'email'),
    );
    const emailCheck$ = emailSet$.pipe(
      debounceTime(EMAIL_DEBOUNCE_MS),
      filter((a) => Boolean(a.value)),
      switchMap((a) => {
        const reqId = ++emailReqId;
        return from(checkEmailAvailable(a.value as string)).pipe(
          map((available) => ({ type: 'emailChecked', reqId, available }) as Action),
        );
      }),
    );

    const usernameSet$ = actions$.pipe(
      filter((a): a is Extract<Action, { type: 'set' }> => a.type === 'set' && a.name === 'username'),
    );
    const usernameCheck$ = usernameSet$.pipe(
      debounceTime(USERNAME_DEBOUNCE_MS),
      filter((a) => Boolean(a.value)),
      switchMap((a) => {
        const reqId = ++usernameReqId;
        return from(checkUsernameAvailable(a.value as string)).pipe(
          map((available) => ({ type: 'usernameChecked', reqId, available }) as Action),
        );
      }),
    );

    const referralSet$ = actions$.pipe(
      filter((a): a is Extract<Action, { type: 'set' }> => a.type === 'set' && a.name === 'referralCode'),
    );
    const referralLookup$ = referralSet$.pipe(
      debounceTime(REFERRAL_DEBOUNCE_MS),
      filter((a) => Boolean(a.value)),
      switchMap((a) => {
        const reqId = ++referralReqId;
        return from(lookupReferralCode(a.value as string)).pipe(
          map((referrerName) => ({ type: 'referralLookedUp', reqId, referrerName }) as Action),
        );
      }),
    );

    // Draft save — debounced on any `set`; flushed on `next`.
    const setAny$ = actions$.pipe(filter((a) => a.type === 'set'));
    const draftDebounced$ = setAny$.pipe(
      debounceTime(DRAFT_DEBOUNCE_MS),
      withLatestFrom(state$),
      tap(([, s]) => persist(s.data, s.step)),
    );
    const nextFlush$ = actions$.pipe(
      filter((a) => a.type === 'next'),
      withLatestFrom(state$),
      tap(([, s]) => {
        // re-derive step would be ideal, but persisting "after next" works since
        // state$ has already advanced by the time tap fires (scan is sync).
        persist(s.data, s.step);
      }),
    );

    // Submit — `defer` + `from` lets switchMap cancel if needed (won't happen in this scenario)
    const submitClick$ = actions$.pipe(filter((a) => a.type === 'submit'));
    const submit$ = submitClick$.pipe(
      withLatestFrom(state$),
      filter(([, s]) => s.step === 'review' && s.submit.kind !== 'submitting'),
      switchMap(([, s]) =>
        defer(() => from(submitWizard(s.data))).pipe(
          map(
            (r) =>
              ({ type: 'submitDone', ok: r.ok, userId: r.ok ? r.userId : undefined, error: r.ok ? undefined : r.error }) as Action,
          ),
        ),
      ),
    );

    const reset$ = actions$.pipe(
      filter((a) => a.type === 'reset'),
      tap(() => {
        emailReqId++;
        usernameReqId++;
        referralReqId++;
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
      }),
      switchMap(() => EMPTY),
    );

    // Feed derived actions back into the reducer pipeline
    const feedback$ = merge(emailCheck$, usernameCheck$, referralLookup$, submit$);
    const sub: Subscription = new Subscription();
    sub.add(feedback$.subscribe((a) => actions$.next(a)));
    sub.add(draftDebounced$.subscribe());
    sub.add(nextFlush$.subscribe());
    sub.add(reset$.subscribe());
    sub.add(state$.pipe(distinctUntilChanged()).subscribe((s) => snapshot$.next(s)));

    // Replay current state for combineLatest pattern correctness (touch).
    combineLatest([state$, of(0)]).pipe(map(([s]) => s));

    const subs = new Set<(s: WizardSnapshot) => void>();
    const snapSub = snapshot$.subscribe((s) => {
      for (const cb of subs) cb(s);
    });

    return {
      snapshot: () => snapshot$.getValue(),
      subscribe(cb) {
        subs.add(cb);
        return (() => subs.delete(cb)) as Unsubscribe;
      },
      setField: (name, value) => actions$.next({ type: 'set', name, value }),
      next: () => actions$.next({ type: 'next' }),
      back: () => actions$.next({ type: 'back' }),
      submit: () => actions$.next({ type: 'submit' }),
      reset: () => actions$.next({ type: 'reset' }),
      loadDraft: () => {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return;
          const parsed = JSON.parse(raw) as { data: WizardData; step: Step };
          actions$.next({ type: 'loadDraft', data: parsed.data, step: parsed.step });
        } catch {
          // ignore
        }
      },
      dispose() {
        sub.unsubscribe();
        snapSub.unsubscribe();
        subs.clear();
      },
    };
  },
};
