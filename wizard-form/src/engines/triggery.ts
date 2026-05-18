// Triggery — two triggers split by concern:
//   `editing`     handles field-changed + 3 async results (email/username/
//                 referral) + load-draft. `actions.debounce(N).checkX()`
//                 gives one-liner debounce per field. Async work runs in
//                 action subscribers and feeds results back via dedicated
//                 events; reqId tags guard against superseded responses.
//   `navigation`  handles next / back / submit / submit-done / reset.
//                 Sync validation lives here, draft flush on forward move.
// State is a closure (a form is a form, not a graph); both triggers mutate
// it and emit a fresh snapshot through the `snapshot` action.

import { createRuntime, createTrigger } from '@triggery/core';
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

type EditingSchema = {
  events: {
    'field-changed': { name: FieldName; value: unknown };
    'email-check-done': { reqId: number; available: boolean };
    'username-check-done': { reqId: number; available: boolean };
    'referral-lookup-done': { reqId: number; referrerName: string | null };
    'load-draft': void;
  };
  actions: {
    checkEmail: { reqId: number; value: string };
    checkUsername: { reqId: number; value: string };
    lookupReferral: { reqId: number; value: string };
    saveDraft: { data: WizardData; step: Step };
    snapshot: WizardSnapshot;
  };
};

type NavSchema = {
  events: {
    next: void;
    back: void;
    submit: void;
    'submit-done': { ok: boolean; userId?: string; error?: string };
    reset: void;
  };
  actions: {
    doSubmit: WizardData;
    flushDraft: { data: WizardData; step: Step };
    snapshot: WizardSnapshot;
  };
};

export const triggeryFactory: EngineFactory = {
  meta: {
    id: 'triggery',
    label: 'Triggery',
    description: 'Two triggers (editing + nav); actions.debounce() for all 3 async fields.',
    sourcePath: 'wizard-form/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });
    let state: WizardSnapshot = initialSnapshot();
    const subs = new Set<(s: WizardSnapshot) => void>();
    let emailReqId = 0;
    let usernameReqId = 0;
    let referralReqId = 0;

    createTrigger<EditingSchema>({
      id: 'editing',
      events: [
        'field-changed', 'email-check-done', 'username-check-done',
        'referral-lookup-done', 'load-draft',
      ],
      schedule: 'sync',
      handler: ({ event, actions }) => {
        if (event.name === 'field-changed') {
          const { name, value } = event.payload;
          state = { ...state, data: { ...state.data, [name]: value } };
          if (name === 'email') {
            state = { ...state, emailStatus: value ? 'checking' : 'idle' };
            if (value) actions.debounce(EMAIL_DEBOUNCE_MS).checkEmail?.({
              reqId: ++emailReqId, value: value as string });
            else emailReqId++;
          } else if (name === 'username') {
            state = { ...state, usernameStatus: value ? 'checking' : 'idle' };
            if (value) actions.debounce(USERNAME_DEBOUNCE_MS).checkUsername?.({
              reqId: ++usernameReqId, value: value as string });
            else usernameReqId++;
          } else if (name === 'referralCode') {
            state = {
              ...state,
              referralStatus: value ? 'checking' : 'idle',
              referrerName: value ? state.referrerName : null,
            };
            if (value) actions.debounce(REFERRAL_DEBOUNCE_MS).lookupReferral?.({
              reqId: ++referralReqId, value: value as string });
            else referralReqId++;
          }
          actions.debounce(DRAFT_DEBOUNCE_MS).saveDraft?.({ data: state.data, step: state.step });
        } else if (event.name === 'email-check-done') {
          if (event.payload.reqId !== emailReqId) return;
          state = { ...state, emailStatus: event.payload.available ? 'valid' : 'invalid' };
        } else if (event.name === 'username-check-done') {
          if (event.payload.reqId !== usernameReqId) return;
          state = { ...state, usernameStatus: event.payload.available ? 'valid' : 'invalid' };
        } else if (event.name === 'referral-lookup-done') {
          if (event.payload.reqId !== referralReqId) return;
          const name = event.payload.referrerName;
          state = { ...state, referralStatus: name ? 'valid' : 'invalid', referrerName: name };
        } else if (event.name === 'load-draft') {
          try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
              const parsed = JSON.parse(raw) as { data: WizardData; step: Step };
              state = {
                ...state,
                data: { ...emptyData(), ...parsed.data },
                step: parsed.step,
                progress: progressFor(parsed.step),
              };
            }
          } catch {
            // ignore
          }
        }
        actions.snapshot?.(state);
      },
    }, runtime);

    createTrigger<NavSchema>({
      id: 'nav',
      events: ['next', 'back', 'submit', 'submit-done', 'reset'],
      schedule: 'sync',
      handler: ({ event, actions }) => {
        if (event.name === 'next') {
          if (state.submit.kind === 'submitting') return;
          const errs = validateStep(
            state.step, state.data,
            state.emailStatus, state.usernameStatus, state.referralStatus,
          );
          if (Object.keys(errs).length > 0) {
            state = { ...state, errors: errs };
          } else {
            const ns = nextStep(state.step, state.data);
            if (!ns) return;
            state = { ...state, step: ns, errors: {}, progress: progressFor(ns) };
            actions.flushDraft?.({ data: state.data, step: ns });
          }
        } else if (event.name === 'back') {
          if (state.submit.kind === 'submitting') return;
          const ps = prevStep(state.step, state.data);
          if (!ps) return;
          state = { ...state, step: ps, errors: {}, progress: progressFor(ps) };
        } else if (event.name === 'submit') {
          if (state.step !== 'review' || state.submit.kind === 'submitting') return;
          state = { ...state, submit: { kind: 'submitting' } };
          actions.doSubmit?.(state.data);
        } else if (event.name === 'submit-done') {
          state = {
            ...state,
            submit: event.payload.ok
              ? { kind: 'success', userId: event.payload.userId as string }
              : { kind: 'error', message: event.payload.error as string },
          };
        } else if (event.name === 'reset') {
          emailReqId++; usernameReqId++; referralReqId++;
          state = { ...initialSnapshot(), data: emptyData() };
        }
        actions.snapshot?.(state);
      },
    }, runtime);

    // Action subscribers: turn declarative debounce-emits into real I/O.
    runtime.subscribeAction('editing', 'checkEmail', async (p) => {
      const { reqId, value } = p as { reqId: number; value: string };
      runtime.fire('email-check-done', { reqId, available: await checkEmailAvailable(value) });
    });
    runtime.subscribeAction('editing', 'checkUsername', async (p) => {
      const { reqId, value } = p as { reqId: number; value: string };
      runtime.fire('username-check-done', { reqId, available: await checkUsernameAvailable(value) });
    });
    runtime.subscribeAction('editing', 'lookupReferral', async (p) => {
      const { reqId, value } = p as { reqId: number; value: string };
      runtime.fire('referral-lookup-done', { reqId, referrerName: await lookupReferralCode(value) });
    });
    const persist = (p: unknown) => {
      const { data, step } = p as { data: WizardData; step: Step };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, step }));
      } catch {
        // ignore
      }
    };
    runtime.subscribeAction('editing', 'saveDraft', persist);
    runtime.subscribeAction('nav', 'flushDraft', persist);
    runtime.subscribeAction('nav', 'doSubmit', async (p) => {
      const res = await submitWizard(p as WizardData);
      runtime.fire('submit-done',
        res.ok ? { ok: true, userId: res.userId } : { ok: false, error: res.error });
    });
    const fan = (s: unknown) => {
      for (const cb of subs) cb(s as WizardSnapshot);
    };
    runtime.subscribeAction('editing', 'snapshot', fan);
    runtime.subscribeAction('nav', 'snapshot', fan);

    return {
      snapshot: () => state,
      subscribe(cb) {
        subs.add(cb);
        return (() => subs.delete(cb)) as Unsubscribe;
      },
      setField: (name, value) => runtime.fire('field-changed', { name, value }),
      next: () => runtime.fire('next'),
      back: () => runtime.fire('back'),
      submit: () => runtime.fire('submit'),
      reset: () => {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
        runtime.fire('reset');
      },
      loadDraft: () => runtime.fire('load-draft'),
      dispose: () => runtime.dispose(),
    };
  },
};
