// Effector — events + stores + samples wire the wizard into a graph. Effects
// handle async (email check, username check, referral lookup, submit).
// Debounce / draft-save use hand-rolled timers (patronum intentionally excluded).

import { combine, createEffect, createEvent, createStore, sample } from 'effector';
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
  lookupReferralCode,
  nextStep,
  prevStep,
  progressFor,
  submitWizard,
  validateStep,
} from '../scenario';
import type {
  AsyncStatus,
  FieldName,
  Step,
  SubmitState,
  WizardData,
  WizardSnapshot,
} from '../types';

export const effectorFactory: EngineFactory = {
  meta: {
    id: 'effector',
    label: 'Effector',
    description: 'Events + stores + samples + effects wired into a reactive graph (×3 async).',
    sourcePath: 'wizard-form/src/engines/effector.ts',
  },
  create(): Engine {
    const fieldChanged = createEvent<{ name: FieldName; value: WizardData[FieldName] }>();
    const nextClicked = createEvent();
    const backClicked = createEvent();
    const submitClicked = createEvent();
    const resetClicked = createEvent();
    const draftLoaded = createEvent<{ data: WizardData; step: Step } | null>();
    const emailChecked = createEvent<{ reqId: number; available: boolean }>();
    const usernameChecked = createEvent<{ reqId: number; available: boolean }>();
    const referralLookedUp = createEvent<{ reqId: number; referrerName: string | null }>();

    const checkEmailFx = createEffect(async (p: { reqId: number; value: string }) => ({
      reqId: p.reqId,
      available: await checkEmailAvailable(p.value),
    }));
    const checkUsernameFx = createEffect(async (p: { reqId: number; value: string }) => ({
      reqId: p.reqId,
      available: await checkUsernameAvailable(p.value),
    }));
    const lookupReferralFx = createEffect(async (p: { reqId: number; value: string }) => ({
      reqId: p.reqId,
      referrerName: await lookupReferralCode(p.value),
    }));
    const submitFx = createEffect((d: WizardData) => submitWizard(d));

    const $data = createStore<WizardData>(emptyData())
      .on(fieldChanged, (s, { name, value }) => ({ ...s, [name]: value }))
      .on(resetClicked, () => emptyData())
      .on(draftLoaded, (s, p) => (p ? { ...emptyData(), ...p.data } : s));

    const $step = createStore<Step>('account')
      .on(resetClicked, () => 'account' as Step)
      .on(draftLoaded, (s, p) => (p ? p.step : s));

    const $emailStatus = createStore<AsyncStatus>('idle')
      .on(fieldChanged, (s, { name, value }) =>
        name === 'email' ? (value ? 'checking' : 'idle') : s,
      )
      .on(emailChecked, (_s, { available }) => (available ? 'valid' : 'invalid'))
      .on(resetClicked, () => 'idle' as AsyncStatus);

    const $usernameStatus = createStore<AsyncStatus>('idle')
      .on(fieldChanged, (s, { name, value }) =>
        name === 'username' ? (value ? 'checking' : 'idle') : s,
      )
      .on(usernameChecked, (_s, { available }) => (available ? 'valid' : 'invalid'))
      .on(resetClicked, () => 'idle' as AsyncStatus);

    const $referralStatus = createStore<AsyncStatus>('idle')
      .on(fieldChanged, (s, { name, value }) =>
        name === 'referralCode' ? (value ? 'checking' : 'idle') : s,
      )
      .on(referralLookedUp, (_s, { referrerName }) => (referrerName ? 'valid' : 'invalid'))
      .on(resetClicked, () => 'idle' as AsyncStatus);

    const $referrerName = createStore<string | null>(null)
      .on(fieldChanged, (s, { name, value }) =>
        name === 'referralCode' && !value ? null : s,
      )
      .on(referralLookedUp, (_s, { referrerName }) => referrerName)
      .on(resetClicked, () => null);

    const $errors = createStore<Partial<Record<FieldName, string>>>({});
    const $submit = createStore<SubmitState>({ kind: 'idle' })
      .on(submitClicked, () => ({ kind: 'submitting' } as SubmitState))
      .on(submitFx.doneData, (_, r) =>
        r.ok
          ? ({ kind: 'success', userId: r.userId } as SubmitState)
          : ({ kind: 'error', message: r.error } as SubmitState),
      )
      .on(resetClicked, () => ({ kind: 'idle' } as SubmitState));

    // Race-id stores — incremented on each new request; checked when async lands.
    const $emailReqId = createStore(0).on(fieldChanged, (n, { name }) => (name === 'email' ? n + 1 : n));
    const $usernameReqId = createStore(0).on(fieldChanged, (n, { name }) => (name === 'username' ? n + 1 : n));
    const $referralReqId = createStore(0).on(fieldChanged, (n, { name }) => (name === 'referralCode' ? n + 1 : n));

    // Validation on next-click: compute errors against the full state.
    const validationDone = createEvent<{ errs: Partial<Record<FieldName, string>>; advance: Step | null }>();
    sample({
      clock: nextClicked,
      source: {
        data: $data, step: $step, sub: $submit,
        emailStatus: $emailStatus, usernameStatus: $usernameStatus, referralStatus: $referralStatus,
      },
      fn: ({ data, step, emailStatus, usernameStatus, referralStatus, sub }) => {
        if (sub.kind === 'submitting') return { errs: {}, advance: null as Step | null };
        const errs = validateStep(step, data, emailStatus, usernameStatus, referralStatus);
        if (Object.keys(errs).length > 0) return { errs, advance: null };
        return { errs: {}, advance: nextStep(step, data) };
      },
      target: validationDone,
    });
    $errors.on(validationDone, (_, { errs }) => errs);
    $step.on(validationDone, (s, { advance }) => advance ?? s);

    const backResolved = createEvent<Step | null>();
    sample({
      clock: backClicked,
      source: { step: $step, data: $data, sub: $submit },
      filter: ({ sub }) => sub.kind !== 'submitting',
      fn: ({ step, data }) => prevStep(step, data),
      target: backResolved,
    });
    $step.on(backResolved, (s, x) => x ?? s);
    $errors.on(backResolved, () => ({}));

    sample({
      clock: submitClicked,
      source: { step: $step, data: $data, sub: $submit },
      filter: ({ step, sub }) => step === 'review' && sub.kind !== 'submitting',
      fn: ({ data }) => data,
      target: submitFx,
    });

    // Debounce timers — hand-rolled per field
    let emailTimer: ReturnType<typeof setTimeout> | null = null;
    let usernameTimer: ReturnType<typeof setTimeout> | null = null;
    let referralTimer: ReturnType<typeof setTimeout> | null = null;
    fieldChanged.watch(({ name, value }) => {
      if (name === 'email') {
        if (emailTimer) clearTimeout(emailTimer);
        if (!value) return;
        emailTimer = setTimeout(() => {
          emailTimer = null;
          checkEmailFx({ reqId: $emailReqId.getState(), value: value as string });
        }, EMAIL_DEBOUNCE_MS);
      } else if (name === 'username') {
        if (usernameTimer) clearTimeout(usernameTimer);
        if (!value) return;
        usernameTimer = setTimeout(() => {
          usernameTimer = null;
          checkUsernameFx({ reqId: $usernameReqId.getState(), value: value as string });
        }, USERNAME_DEBOUNCE_MS);
      } else if (name === 'referralCode') {
        if (referralTimer) clearTimeout(referralTimer);
        if (!value) return;
        referralTimer = setTimeout(() => {
          referralTimer = null;
          lookupReferralFx({ reqId: $referralReqId.getState(), value: value as string });
        }, REFERRAL_DEBOUNCE_MS);
      }
    });

    // Async result gating — only fire the *Checked event if reqId still matches.
    sample({
      clock: checkEmailFx.doneData,
      source: $emailReqId,
      filter: (cur, r) => r.reqId === cur,
      fn: (_, r) => r,
      target: emailChecked,
    });
    sample({
      clock: checkUsernameFx.doneData,
      source: $usernameReqId,
      filter: (cur, r) => r.reqId === cur,
      fn: (_, r) => r,
      target: usernameChecked,
    });
    sample({
      clock: lookupReferralFx.doneData,
      source: $referralReqId,
      filter: (cur, r) => r.reqId === cur,
      fn: (_, r) => r,
      target: referralLookedUp,
    });

    // Draft save: debounced on any field change; flushed on forward navigation.
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    const persist = (data: WizardData, step: Step) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, step }));
      } catch {
        // ignore
      }
    };
    fieldChanged.watch(() => {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        draftTimer = null;
        persist($data.getState(), $step.getState());
      }, DRAFT_DEBOUNCE_MS);
    });
    validationDone.watch(({ advance }) => {
      if (!advance) return;
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = null;
      persist($data.getState(), advance);
    });
    resetClicked.watch(() => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    });

    const $snapshot = combine(
      $data, $step, $errors, $emailStatus, $usernameStatus, $referralStatus, $referrerName, $submit,
      (data, step, errors, emailStatus, usernameStatus, referralStatus, referrerName, sub): WizardSnapshot => ({
        data, step, errors,
        emailStatus, usernameStatus, referralStatus, referrerName,
        progress: progressFor(step),
        submit: sub,
      }),
    );

    const subs = new Set<(s: WizardSnapshot) => void>();
    const unwatch = $snapshot.watch((snap) => {
      for (const cb of subs) cb(snap);
    });

    return {
      snapshot: () => $snapshot.getState(),
      subscribe(cb) {
        subs.add(cb);
        return (() => subs.delete(cb)) as Unsubscribe;
      },
      setField: (name, value) => fieldChanged({ name, value }),
      next: () => nextClicked(),
      back: () => backClicked(),
      submit: () => submitClicked(),
      reset: () => resetClicked(),
      loadDraft: () => {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          draftLoaded(raw ? (JSON.parse(raw) as { data: WizardData; step: Step }) : null);
        } catch {
          draftLoaded(null);
        }
      },
      dispose() {
        unwatch();
        if (emailTimer) clearTimeout(emailTimer);
        if (usernameTimer) clearTimeout(usernameTimer);
        if (referralTimer) clearTimeout(referralTimer);
        if (draftTimer) clearTimeout(draftTimer);
        subs.clear();
      },
    };
  },
};
