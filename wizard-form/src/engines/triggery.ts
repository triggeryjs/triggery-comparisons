// Triggery — two triggers (editing + nav). Each handler dispatches through
// a lookup table built once per engine instance (no per-event allocation):
//   `editing` table: 'field-changed' / *-check-done / 'load-draft'
//   `nav` table:     'next' / 'back' / 'submit' / 'submit-done' / 'reset'
// Async-field config (debounce window, status key, action name) lives in
// one row per field — adding a 4th is a single object-literal entry.

import { createRuntime, createTrigger } from '@triggery/core';
import type { Engine, EngineFactory, Unsubscribe } from '../engine';
import {
  DRAFT_DEBOUNCE_MS, EMAIL_DEBOUNCE_MS, REFERRAL_DEBOUNCE_MS, STORAGE_KEY,
  USERNAME_DEBOUNCE_MS, checkEmailAvailable, checkUsernameAvailable,
  emptyData, initialSnapshot, lookupReferralCode, nextStep, prevStep,
  progressFor, submitWizard, validateStep,
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
    next: void; back: void; submit: void;
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
    description: 'Two triggers + table-driven dispatch; actions.debounce() for all 3 async fields.',
    sourcePath: 'wizard-form/src/engines/triggery.ts',
  },
  create(): Engine {
    const runtime = createRuntime({ inspector: false });
    let state: WizardSnapshot = initialSnapshot();
    const subs = new Set<(s: WizardSnapshot) => void>();
    const reqIds = { email: 0, username: 0, referralCode: 0 };

    // One row per async-validated field — adding a 4th = one more entry.
    const ASYNC = {
      email: { ms: EMAIL_DEBOUNCE_MS, status: 'emailStatus', action: 'checkEmail' },
      username: { ms: USERNAME_DEBOUNCE_MS, status: 'usernameStatus', action: 'checkUsername' },
      referralCode: { ms: REFERRAL_DEBOUNCE_MS, status: 'referralStatus', action: 'lookupReferral' },
    } as const;
    type AKey = keyof typeof ASYNC;

    // biome-ignore lint/suspicious/noExplicitAny: dispatch tables receive a discriminated union
    type Fn = (p: any, actions: any) => void;

    const editingTable: Record<string, Fn> = {
      'field-changed': ({ name, value }: { name: FieldName; value: unknown }, actions) => {
        state = { ...state, data: { ...state.data, [name]: value } };
        const cfg = (ASYNC as Record<string, { ms: number; status: string; action: string }>)[name];
        if (cfg) {
          const patch: Partial<WizardSnapshot> = { [cfg.status]: value ? 'checking' : 'idle' };
          if (!value && name === 'referralCode') patch.referrerName = null;
          state = { ...state, ...patch };
          const id = ++reqIds[name as AKey];
          if (value) actions.debounce(cfg.ms)[cfg.action]?.({ reqId: id, value: value as string });
        }
        actions.debounce(DRAFT_DEBOUNCE_MS).saveDraft?.({ data: state.data, step: state.step });
      },
      'email-check-done': ({ reqId, available }: { reqId: number; available: boolean }) => {
        if (reqId === reqIds.email)
          state = { ...state, emailStatus: available ? 'valid' : 'invalid' };
      },
      'username-check-done': ({ reqId, available }: { reqId: number; available: boolean }) => {
        if (reqId === reqIds.username)
          state = { ...state, usernameStatus: available ? 'valid' : 'invalid' };
      },
      'referral-lookup-done': ({ reqId, referrerName }: { reqId: number; referrerName: string | null }) => {
        if (reqId === reqIds.referralCode)
          state = { ...state, referralStatus: referrerName ? 'valid' : 'invalid', referrerName };
      },
      'load-draft': () => {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return;
          const p = JSON.parse(raw) as { data: WizardData; step: Step };
          state = { ...state, data: { ...emptyData(), ...p.data }, step: p.step, progress: progressFor(p.step) };
        } catch {
          // ignore
        }
      },
    };

    createTrigger<EditingSchema>({
      id: 'editing',
      events: ['field-changed', 'email-check-done', 'username-check-done', 'referral-lookup-done', 'load-draft'],
      schedule: 'sync',
      handler: ({ event, actions }) => {
        editingTable[event.name]?.(event.payload, actions);
        actions.snapshot?.(state);
      },
    }, runtime);

    const navTable: Record<string, Fn> = {
      next: (_p, actions) => {
        const errs = validateStep(
          state.step, state.data, state.emailStatus, state.usernameStatus, state.referralStatus,
        );
        if (Object.keys(errs).length > 0) { state = { ...state, errors: errs }; return; }
        const ns = nextStep(state.step, state.data);
        if (!ns) return;
        state = { ...state, step: ns, errors: {}, progress: progressFor(ns) };
        actions.flushDraft?.({ data: state.data, step: ns });
      },
      back: () => {
        const ps = prevStep(state.step, state.data);
        if (ps) state = { ...state, step: ps, errors: {}, progress: progressFor(ps) };
      },
      submit: (_p, actions) => {
        if (state.step !== 'review') return;
        state = { ...state, submit: { kind: 'submitting' } };
        actions.doSubmit?.(state.data);
      },
      'submit-done': (p: { ok: boolean; userId?: string; error?: string }) => {
        state = {
          ...state,
          submit: p.ok
            ? { kind: 'success', userId: p.userId as string }
            : { kind: 'error', message: p.error as string },
        };
      },
      reset: () => {
        reqIds.email = reqIds.username = reqIds.referralCode = 0;
        state = { ...initialSnapshot(), data: emptyData() };
      },
    };

    createTrigger<NavSchema>({
      id: 'nav',
      events: ['next', 'back', 'submit', 'submit-done', 'reset'],
      schedule: 'sync',
      handler: ({ event, actions }) => {
        // Submit lock: only `submit-done` is allowed once submission is in flight.
        const locked = state.submit.kind === 'submitting' && event.name !== 'submit-done';
        if (!locked) navTable[event.name]?.(event.payload, actions);
        actions.snapshot?.(state);
      },
    }, runtime);

    // Action subscribers — declarative debounce-emits turned into real I/O.
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
      subscribe(cb) { subs.add(cb); return (() => subs.delete(cb)) as Unsubscribe; },
      setField: (name, value) => runtime.fire('field-changed', { name, value }),
      next: () => runtime.fire('next'),
      back: () => runtime.fire('back'),
      submit: () => runtime.fire('submit'),
      reset: () => {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
        runtime.fire('reset');
      },
      loadDraft: () => runtime.fire('load-draft'),
      dispose: () => runtime.dispose(),
    };
  },
};
