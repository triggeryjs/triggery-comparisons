// Naked baseline — plain JS. Mutable state, a Set of subscribers, manual
// debounce timers, no library. The honest reference: this is what you write
// when you say "I don't need a library, it's just a form".

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

export const nakedFactory: EngineFactory = {
  meta: {
    id: 'naked',
    label: 'Naked baseline',
    description: 'Plain JS — mutable state, Set of subscribers, hand-rolled timers.',
    sourcePath: 'wizard-form/src/engines/naked.ts',
  },
  create(): Engine {
    let state: WizardSnapshot = initialSnapshot();
    const subs = new Set<(s: WizardSnapshot) => void>();
    let emailTimer: ReturnType<typeof setTimeout> | null = null;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    let emailReqId = 0; // race-condition guard for async email check

    const emit = () => {
      for (const cb of subs) cb(state);
    };
    const merge = (patch: Partial<WizardSnapshot>) => {
      state = { ...state, ...patch };
      emit();
    };
    const persist = (data: WizardData, step: Step) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, step }));
      } catch {
        // localStorage unavailable / quota — silent
      }
    };
    const schedulePersist = () => {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        draftTimer = null;
        persist(state.data, state.step);
      }, DRAFT_DEBOUNCE_MS);
    };
    const flushPersist = () => {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = null;
      persist(state.data, state.step);
    };
    const scheduleEmailCheck = (value: string) => {
      if (emailTimer) clearTimeout(emailTimer);
      if (!value) {
        merge({ emailStatus: 'idle' });
        return;
      }
      emailTimer = setTimeout(async () => {
        emailTimer = null;
        const reqId = ++emailReqId;
        merge({ emailStatus: 'checking' });
        const ok = await checkEmailAvailable(value);
        if (reqId !== emailReqId) return; // superseded
        merge({ emailStatus: ok ? 'available' : 'taken' });
      }, EMAIL_DEBOUNCE_MS);
    };

    return {
      snapshot: () => state,
      subscribe(cb) {
        subs.add(cb);
        return (() => subs.delete(cb)) as Unsubscribe;
      },
      setField<K extends FieldName>(name: K, value: WizardData[K]) {
        const data = { ...state.data, [name]: value };
        merge({ data });
        if (name === 'email') scheduleEmailCheck(value as string);
        schedulePersist();
      },
      next() {
        if (state.submit.kind === 'submitting') return;
        const errors = validateStep(state.step, state.data, state.emailStatus);
        if (Object.keys(errors).length > 0) {
          merge({ errors });
          return;
        }
        const next = nextStep(state.step, state.data);
        if (!next) return;
        merge({ step: next, errors: {}, progress: progressFor(next) });
        flushPersist();
      },
      back() {
        if (state.submit.kind === 'submitting') return;
        const prev = prevStep(state.step, state.data);
        if (!prev) return;
        merge({ step: prev, errors: {}, progress: progressFor(prev) });
      },
      async submit() {
        if (state.step !== 'review' || state.submit.kind === 'submitting') return;
        merge({ submit: { kind: 'submitting' } });
        const res = await submitWizard(state.data);
        if (res.ok) merge({ submit: { kind: 'success', userId: res.userId } });
        else merge({ submit: { kind: 'error', message: res.error } });
      },
      reset() {
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
        state = { ...initialSnapshot(), data: emptyData() };
        emit();
      },
      loadDraft() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return;
          const parsed = JSON.parse(raw) as { data: WizardData; step: Step };
          merge({
            data: { ...emptyData(), ...parsed.data },
            step: parsed.step,
            progress: progressFor(parsed.step),
          });
        } catch {
          // ignore
        }
      },
      dispose() {
        if (emailTimer) clearTimeout(emailTimer);
        if (draftTimer) clearTimeout(draftTimer);
        subs.clear();
      },
    };
  },
};
