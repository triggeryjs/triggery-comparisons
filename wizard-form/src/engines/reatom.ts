// Reatom — atoms hold the state, actions mutate via ctx, debouncing is
// hand-rolled with timer handles in closure. Snapshot is derived from a
// computed atom that fans out to subscribers.

import { action, atom, createCtx } from '@reatom/core';
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

export const reatomFactory: EngineFactory = {
  meta: {
    id: 'reatom',
    label: 'Reatom',
    description: 'Atoms + actions, ctx-scoped state, hand-rolled debounce timers.',
    sourcePath: 'wizard-form/src/engines/reatom.ts',
  },
  create(): Engine {
    const ctx = createCtx();
    const dataAtom = atom<WizardData>(emptyData(), 'data');
    const stepAtom = atom<Step>('account', 'step');
    const errorsAtom = atom<Partial<Record<FieldName, string>>>({}, 'errors');
    const emailStatusAtom = atom<EmailStatus>('idle', 'emailStatus');
    const submitAtom = atom<SubmitState>({ kind: 'idle' }, 'submit');
    const snapshotAtom = atom<WizardSnapshot>((c) => {
      const step = c.spy(stepAtom);
      return {
        step,
        data: c.spy(dataAtom),
        errors: c.spy(errorsAtom),
        emailStatus: c.spy(emailStatusAtom),
        progress: progressFor(step),
        submit: c.spy(submitAtom),
      };
    }, 'snapshot');

    let emailTimer: ReturnType<typeof setTimeout> | null = null;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    let emailReqId = 0;

    const persist = (data: WizardData, step: Step) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, step }));
      } catch {
        // ignore
      }
    };

    const setField = action((c, name: FieldName, value: WizardData[FieldName]) => {
      dataAtom(c, { ...c.get(dataAtom), [name]: value });
      if (name === 'email') {
        if (emailTimer) clearTimeout(emailTimer);
        if (!value) {
          emailStatusAtom(c, 'idle');
          emailReqId++;
        } else {
          emailStatusAtom(c, 'checking');
          const v = value as string;
          emailTimer = setTimeout(async () => {
            emailTimer = null;
            const reqId = ++emailReqId;
            const ok = await checkEmailAvailable(v);
            if (reqId !== emailReqId) return;
            ctx.get(() => emailStatusAtom(ctx, ok ? 'available' : 'taken'));
          }, EMAIL_DEBOUNCE_MS);
        }
      }
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        draftTimer = null;
        persist(c.get(dataAtom), c.get(stepAtom));
      }, DRAFT_DEBOUNCE_MS);
    }, 'setField');

    const next = action((c) => {
      if (c.get(submitAtom).kind === 'submitting') return;
      const step = c.get(stepAtom);
      const data = c.get(dataAtom);
      const errs = validateStep(step, data, c.get(emailStatusAtom));
      if (Object.keys(errs).length > 0) {
        errorsAtom(c, errs);
        return;
      }
      const ns = nextStep(step, data);
      if (!ns) return;
      stepAtom(c, ns);
      errorsAtom(c, {});
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = null;
      persist(data, ns);
    }, 'next');

    const back = action((c) => {
      if (c.get(submitAtom).kind === 'submitting') return;
      const ps = prevStep(c.get(stepAtom), c.get(dataAtom));
      if (!ps) return;
      stepAtom(c, ps);
      errorsAtom(c, {});
    }, 'back');

    const submit = action(async (c) => {
      if (c.get(stepAtom) !== 'review' || c.get(submitAtom).kind === 'submitting') return;
      submitAtom(c, { kind: 'submitting' });
      const data = c.get(dataAtom);
      const res = await submitWizard(data);
      ctx.get(() =>
        submitAtom(
          ctx,
          res.ok
            ? { kind: 'success', userId: res.userId }
            : { kind: 'error', message: res.error },
        ),
      );
    }, 'submit');

    const reset = action((c) => {
      if (emailTimer) clearTimeout(emailTimer);
      if (draftTimer) clearTimeout(draftTimer);
      emailTimer = null;
      draftTimer = null;
      emailReqId++;
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
      dataAtom(c, emptyData());
      stepAtom(c, 'account');
      errorsAtom(c, {});
      emailStatusAtom(c, 'idle');
      submitAtom(c, { kind: 'idle' });
    }, 'reset');

    const loadDraft = action((c) => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { data: WizardData; step: Step };
        dataAtom(c, { ...emptyData(), ...parsed.data });
        stepAtom(c, parsed.step);
      } catch {
        // ignore
      }
    }, 'loadDraft');

    const subs = new Set<(s: WizardSnapshot) => void>();
    ctx.subscribe(snapshotAtom, (snap) => {
      for (const cb of subs) cb(snap);
    });

    return {
      snapshot: () => ctx.get(snapshotAtom),
      subscribe(cb) {
        subs.add(cb);
        return (() => subs.delete(cb)) as Unsubscribe;
      },
      setField: (name, value) => setField(ctx, name, value),
      next: () => next(ctx),
      back: () => back(ctx),
      submit: () => void submit(ctx),
      reset: () => reset(ctx),
      loadDraft: () => loadDraft(ctx),
      dispose() {
        if (emailTimer) clearTimeout(emailTimer);
        if (draftTimer) clearTimeout(draftTimer);
        subs.clear();
      },
    };
  },
};
