// RTK + listenerMiddleware — one slice for the wizard state; listeners
// handle async (email check, submit) and debouncing (email, draft) via
// cancelActiveListeners() + delay(). Snapshot is the entire slice state.

import {
  configureStore,
  createAction,
  createListenerMiddleware,
  createSlice,
  type PayloadAction,
} from '@reduxjs/toolkit';
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
import type {
  EmailStatus,
  FieldName,
  Step,
  SubmitState,
  WizardData,
  WizardSnapshot,
} from '../types';

type State = WizardSnapshot & { emailReqId: number };

const startSubmit = createAction('wizard/startSubmit');
const fieldChangedAction = createAction<{ name: FieldName; value: WizardData[FieldName] }>(
  'wizard/field',
);

const slice = createSlice({
  name: 'wizard',
  initialState: { ...initialSnapshot(), emailReqId: 0 } as State,
  reducers: {
    setField(s, a: PayloadAction<{ name: FieldName; value: WizardData[FieldName] }>) {
      s.data = { ...s.data, [a.payload.name]: a.payload.value };
      if (a.payload.name === 'email') {
        s.emailStatus = (a.payload.value as string) ? 'checking' : 'idle';
        s.emailReqId += 1;
      }
    },
    setErrors(s, a: PayloadAction<Partial<Record<FieldName, string>>>) {
      s.errors = a.payload;
    },
    setStep(s, a: PayloadAction<Step>) {
      s.step = a.payload;
      s.errors = {};
      s.progress = progressFor(a.payload);
    },
    setEmailStatus(s, a: PayloadAction<EmailStatus>) {
      s.emailStatus = a.payload;
    },
    setSubmit(s, a: PayloadAction<SubmitState>) {
      s.submit = a.payload;
    },
    resetAll() {
      return { ...initialSnapshot(), emailReqId: 0 } as State;
    },
    restoreDraft(s, a: PayloadAction<{ data: WizardData; step: Step }>) {
      s.data = { ...emptyData(), ...a.payload.data };
      s.step = a.payload.step;
      s.progress = progressFor(a.payload.step);
    },
  },
});

export const rtkListenerFactory: EngineFactory = {
  meta: {
    id: 'rtk',
    label: 'RTK listenerMiddleware',
    description: 'Slice + listeners; debounce via cancelActiveListeners() + delay().',
    sourcePath: 'wizard-form/src/engines/rtk-listener.ts',
  },
  create(): Engine {
    const listener = createListenerMiddleware();
    const store = configureStore({
      reducer: slice.reducer,
      middleware: (gdm) => gdm({ serializableCheck: false }).prepend(listener.middleware),
    });

    const persist = (data: WizardData, step: Step) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, step }));
      } catch {
        // ignore
      }
    };

    // Forward `setField` to a separate action so listeners can react without
    // colliding on the slice reducer.
    listener.startListening({
      actionCreator: slice.actions.setField,
      effect: (a, api) => {
        api.dispatch(fieldChangedAction(a.payload));
      },
    });

    // Email debounce listener
    listener.startListening({
      actionCreator: fieldChangedAction,
      effect: async (a, { cancelActiveListeners, delay, getState, dispatch }) => {
        if (a.payload.name !== 'email') return;
        cancelActiveListeners();
        const value = a.payload.value as string;
        if (!value) return;
        await delay(EMAIL_DEBOUNCE_MS);
        const reqIdAtStart = (getState() as State).emailReqId;
        const ok = await checkEmailAvailable(value);
        if ((getState() as State).emailReqId !== reqIdAtStart) return;
        dispatch(slice.actions.setEmailStatus(ok ? 'available' : 'taken'));
      },
    });

    // Draft debounce listener
    listener.startListening({
      actionCreator: fieldChangedAction,
      effect: async (_a, { cancelActiveListeners, delay, getState }) => {
        cancelActiveListeners();
        await delay(DRAFT_DEBOUNCE_MS);
        const s = getState() as State;
        persist(s.data, s.step);
      },
    });

    // Submit listener
    listener.startListening({
      actionCreator: startSubmit,
      effect: async (_a, { dispatch, getState }) => {
        const s = getState() as State;
        if (s.step !== 'review' || s.submit.kind === 'submitting') return;
        dispatch(slice.actions.setSubmit({ kind: 'submitting' }));
        const res = await submitWizard(s.data);
        dispatch(
          slice.actions.setSubmit(
            res.ok
              ? { kind: 'success', userId: res.userId }
              : { kind: 'error', message: res.error },
          ),
        );
      },
    });

    const snapshot = (): WizardSnapshot => {
      const { emailReqId: _r, ...rest } = store.getState() as State;
      void _r;
      return rest as WizardSnapshot;
    };

    const subs = new Set<(s: WizardSnapshot) => void>();
    const unsubStore = store.subscribe(() => {
      const snap = snapshot();
      for (const cb of subs) cb(snap);
    });

    return {
      snapshot,
      subscribe(cb) {
        subs.add(cb);
        return (() => subs.delete(cb)) as Unsubscribe;
      },
      setField: (name, value) => void store.dispatch(slice.actions.setField({ name, value })),
      next: () => {
        const s = store.getState() as State;
        if (s.submit.kind === 'submitting') return;
        const errs = validateStep(s.step, s.data, s.emailStatus);
        if (Object.keys(errs).length > 0) {
          store.dispatch(slice.actions.setErrors(errs));
          return;
        }
        const ns = nextStep(s.step, s.data);
        if (!ns) return;
        store.dispatch(slice.actions.setStep(ns));
        persist(s.data, ns);
      },
      back: () => {
        const s = store.getState() as State;
        if (s.submit.kind === 'submitting') return;
        const ps = prevStep(s.step, s.data);
        if (!ps) return;
        store.dispatch(slice.actions.setStep(ps));
      },
      submit: () => void store.dispatch(startSubmit()),
      reset: () => {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
        store.dispatch(slice.actions.resetAll());
      },
      loadDraft: () => {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return;
          const parsed = JSON.parse(raw) as { data: WizardData; step: Step };
          store.dispatch(slice.actions.restoreDraft(parsed));
        } catch {
          // ignore
        }
      },
      dispose: () => {
        listener.clearListeners();
        unsubStore();
        subs.clear();
      },
    };
  },
};
