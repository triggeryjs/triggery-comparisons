// Effector — events + stores + samples wire the wizard into a graph. Effects
// handle async (email check, submit). Debounce / draft-save use hand-rolled
// timers because patronum is intentionally excluded for apples-to-apples.

import { combine, createEffect, createEvent, createStore, sample } from 'effector';
import type { Engine, EngineFactory, Unsubscribe } from '../engine';
import {
  DRAFT_DEBOUNCE_MS,
  EMAIL_DEBOUNCE_MS,
  STORAGE_KEY,
  checkEmailAvailable,
  emptyData,
  nextStep,
  prevStep,
  progressFor,
  submitWizard,
  validateStep,
} from '../scenario';
import type {
  EmailStatus,
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
    description: 'Events + stores + samples + effects wired into a reactive graph.',
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

    const checkEmailFx = createEffect(async (p: { reqId: number; value: string }) => {
      const available = await checkEmailAvailable(p.value);
      return { reqId: p.reqId, available };
    });
    const submitFx = createEffect((d: WizardData) => submitWizard(d));

    const $data = createStore<WizardData>(emptyData())
      .on(fieldChanged, (s, { name, value }) => ({ ...s, [name]: value }))
      .on(resetClicked, () => emptyData())
      .on(draftLoaded, (s, p) => (p ? { ...emptyData(), ...p.data } : s));

    const $step = createStore<Step>('account')
      .on(resetClicked, () => 'account' as Step)
      .on(draftLoaded, (s, p) => (p ? p.step : s));

    const $emailStatus = createStore<EmailStatus>('idle')
      .on(fieldChanged, (s, { name, value }) => {
        if (name !== 'email') return s;
        return value ? ('checking' as EmailStatus) : ('idle' as EmailStatus);
      })
      .on(emailChecked, (s, { available }) => (available ? 'available' : 'taken'))
      .on(resetClicked, () => 'idle' as EmailStatus);

    const $errors = createStore<Partial<Record<FieldName, string>>>({});
    const $submit = createStore<SubmitState>({ kind: 'idle' })
      .on(submitClicked, () => ({ kind: 'submitting' } as SubmitState))
      .on(submitFx.doneData, (_, r) =>
        r.ok
          ? ({ kind: 'success', userId: r.userId } as SubmitState)
          : ({ kind: 'error', message: r.error } as SubmitState),
      )
      .on(resetClicked, () => ({ kind: 'idle' } as SubmitState));

    // emailReqId guards against superseded checks
    const $emailReqId = createStore(0).on(fieldChanged, (n, { name }) => (name === 'email' ? n + 1 : n));

    // Validation: on `nextClicked`, compute errors; if empty, advance.
    sample({
      clock: nextClicked,
      source: { data: $data, step: $step, emailStatus: $emailStatus, sub: $submit },
      fn: ({ data, step, emailStatus, sub }) => {
        if (sub.kind === 'submitting') return { errs: {}, advance: null as Step | null };
        const errs = validateStep(step, data, emailStatus);
        if (Object.keys(errs).length > 0) return { errs, advance: null };
        return { errs: {}, advance: nextStep(step, data) };
      },
      target: createEvent<{ errs: Partial<Record<FieldName, string>>; advance: Step | null }>().prepend(
        (x: { errs: Partial<Record<FieldName, string>>; advance: Step | null }) => x,
      ),
    });

    const validationDone = createEvent<{ errs: Partial<Record<FieldName, string>>; advance: Step | null }>();
    sample({
      clock: nextClicked,
      source: { data: $data, step: $step, emailStatus: $emailStatus, sub: $submit },
      fn: ({ data, step, emailStatus, sub }) => {
        if (sub.kind === 'submitting') return { errs: {}, advance: null as Step | null };
        const errs = validateStep(step, data, emailStatus);
        if (Object.keys(errs).length > 0) return { errs, advance: null };
        return { errs: {}, advance: nextStep(step, data) };
      },
      target: validationDone,
    });
    $errors.on(validationDone, (_, { errs }) => errs);
    $step.on(validationDone, (s, { advance }) => advance ?? s);

    // Back: just compute previous step
    $step.on(backClicked, (s) =>
      // computed here using $data; we re-sample with data
      s,
    );
    sample({
      clock: backClicked,
      source: { step: $step, data: $data, sub: $submit },
      filter: ({ sub }) => sub.kind !== 'submitting',
      fn: ({ step, data }) => prevStep(step, data),
      target: createEvent<Step | null>().prepend((x: Step | null) => x),
    });
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

    // Submit gating: only fire submitFx when step === 'review'
    sample({
      clock: submitClicked,
      source: { step: $step, data: $data, sub: $submit },
      filter: ({ step, sub }) => step === 'review' && sub.kind !== 'submitting',
      fn: ({ data }) => data,
      target: submitFx,
    });

    // Email debounce — hand-rolled timer in closure
    let emailTimer: ReturnType<typeof setTimeout> | null = null;
    fieldChanged.watch(({ name, value }) => {
      if (name !== 'email') return;
      if (emailTimer) clearTimeout(emailTimer);
      if (!value) return;
      emailTimer = setTimeout(() => {
        emailTimer = null;
        checkEmailFx({ reqId: $emailReqId.getState(), value: value as string });
      }, EMAIL_DEBOUNCE_MS);
    });
    sample({
      clock: checkEmailFx.doneData,
      source: $emailReqId,
      filter: (current, r) => r.reqId === current,
      fn: (_, r) => r,
      target: emailChecked,
    });

    // Draft save — hand-rolled debounce on any field change; flush on next
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
      $data,
      $step,
      $errors,
      $emailStatus,
      $submit,
      (data, step, errors, emailStatus, sub): WizardSnapshot => ({
        data,
        step,
        errors,
        emailStatus,
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
        if (draftTimer) clearTimeout(draftTimer);
        subs.clear();
      },
    };
  },
};
