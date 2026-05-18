// Triggery — one trigger handles every event; actions.debounce(ms) gives us
// email-check and draft-save for free (no hand-rolled timers). Async work
// (email availability, submit) lives in action subscribers and feeds results
// back through dedicated events. State lives in a closure (a form is a form,
// not a graph), so `conditions` stays empty — we use triggery for what it's
// good at: declarative event handling + built-in debounce.

import { createRuntime, createTrigger } from '@triggery/core';
import type { Engine, EngineFactory, Unsubscribe } from '../engine';
import {
  DRAFT_DEBOUNCE_MS,
  EMAIL_DEBOUNCE_MS,
  STORAGE_KEY,
  checkEmailAvailable,
  emptyData,
  initialSnapshot,
  nextStep,
  prevStep,
  progressFor,
  submitWizard,
  validateStep,
} from '../scenario';
import type { FieldName, Step, WizardData, WizardSnapshot } from '../types';

type WizardSchema = {
  events: {
    'field-changed': { name: FieldName; value: unknown };
    next: void;
    back: void;
    submit: void;
    reset: void;
    'load-draft': void;
    'email-check-done': { reqId: number; available: boolean };
    'submit-done': { ok: boolean; userId?: string; error?: string };
  };
  actions: {
    checkEmail: { reqId: number; value: string };
    saveDraft: { data: WizardData; step: Step };
    doSubmit: WizardData;
    snapshot: WizardSnapshot;
  };
};

export const triggeryFactory: EngineFactory = {
  meta: {
    id: 'triggery',
    label: 'Triggery',
    description: 'One trigger, actions.debounce() for email + draft, async via action subscribers.',
    sourcePath: 'wizard-form/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });
    let state: WizardSnapshot = initialSnapshot();
    const subs = new Set<(s: WizardSnapshot) => void>();
    let emailReqId = 0;

    createTrigger<WizardSchema>({
      id: 'wizard',
      events: [
        'field-changed', 'next', 'back', 'submit', 'reset', 'load-draft',
        'email-check-done', 'submit-done',
      ],
      schedule: 'sync',
      handler: ({ event, actions }) => {
        if (event.name === 'field-changed') {
          const { name, value } = event.payload;
          state = { ...state, data: { ...state.data, [name]: value } };
          if (name === 'email') {
            if (value) {
              state = { ...state, emailStatus: 'checking' };
              actions.debounce(EMAIL_DEBOUNCE_MS).checkEmail?.({
                reqId: ++emailReqId,
                value: value as string,
              });
            } else {
              emailReqId++;
              state = { ...state, emailStatus: 'idle' };
            }
          }
          actions.debounce(DRAFT_DEBOUNCE_MS).saveDraft?.({ data: state.data, step: state.step });
        } else if (event.name === 'email-check-done') {
          const { reqId, available } = event.payload;
          if (reqId !== emailReqId) return;
          state = { ...state, emailStatus: available ? 'available' : 'taken' };
        } else if (event.name === 'next') {
          if (state.submit.kind === 'submitting') return;
          const errors = validateStep(state.step, state.data, state.emailStatus);
          if (Object.keys(errors).length > 0) {
            state = { ...state, errors };
          } else {
            const ns = nextStep(state.step, state.data);
            if (!ns) return;
            state = { ...state, step: ns, errors: {}, progress: progressFor(ns) };
            actions.saveDraft?.({ data: state.data, step: ns });
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
          emailReqId++;
          state = { ...initialSnapshot(), data: emptyData() };
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

    runtime.subscribeAction('wizard', 'checkEmail', async (p) => {
      const { reqId, value } = p as { reqId: number; value: string };
      const available = await checkEmailAvailable(value);
      runtime.fire('email-check-done', { reqId, available });
    });
    runtime.subscribeAction('wizard', 'saveDraft', (p) => {
      const { data, step } = p as { data: WizardData; step: Step };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, step }));
      } catch {
        // ignore
      }
    });
    runtime.subscribeAction('wizard', 'doSubmit', async (p) => {
      const res = await submitWizard(p as WizardData);
      runtime.fire('submit-done', res.ok ? { ok: true, userId: res.userId } : { ok: false, error: res.error });
    });
    runtime.subscribeAction('wizard', 'snapshot', (p) => {
      for (const cb of subs) cb(p as WizardSnapshot);
    });

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
