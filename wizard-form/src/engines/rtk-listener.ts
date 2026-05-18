// RTK + listenerMiddleware — one slice for the wizard state; listeners
// handle async (email, username, referral, submit) and debouncing (via
// cancelActiveListeners() + delay()). Three async fields = three listeners.

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
import type {
  AsyncStatus,
  FieldName,
  Step,
  SubmitState,
  WizardData,
  WizardSnapshot,
} from '../types';

type State = WizardSnapshot & {
  emailReqId: number;
  usernameReqId: number;
  referralReqId: number;
};

const startSubmit = createAction('wizard/startSubmit');
const fieldChangedAction = createAction<{ name: FieldName; value: WizardData[FieldName] }>(
  'wizard/field',
);

const slice = createSlice({
  name: 'wizard',
  initialState: {
    ...initialSnapshot(),
    emailReqId: 0,
    usernameReqId: 0,
    referralReqId: 0,
  } as State,
  reducers: {
    setField(s, a: PayloadAction<{ name: FieldName; value: WizardData[FieldName] }>) {
      s.data = { ...s.data, [a.payload.name]: a.payload.value };
      if (a.payload.name === 'email') {
        s.emailStatus = a.payload.value ? 'checking' : 'idle';
        s.emailReqId += 1;
      } else if (a.payload.name === 'username') {
        s.usernameStatus = a.payload.value ? 'checking' : 'idle';
        s.usernameReqId += 1;
      } else if (a.payload.name === 'referralCode') {
        s.referralStatus = a.payload.value ? 'checking' : 'idle';
        if (!a.payload.value) s.referrerName = null;
        s.referralReqId += 1;
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
    setEmailStatus(s, a: PayloadAction<AsyncStatus>) {
      s.emailStatus = a.payload;
    },
    setUsernameStatus(s, a: PayloadAction<AsyncStatus>) {
      s.usernameStatus = a.payload;
    },
    setReferralResult(s, a: PayloadAction<{ status: AsyncStatus; referrerName: string | null }>) {
      s.referralStatus = a.payload.status;
      s.referrerName = a.payload.referrerName;
    },
    setSubmit(s, a: PayloadAction<SubmitState>) {
      s.submit = a.payload;
    },
    resetAll() {
      return {
        ...initialSnapshot(),
        emailReqId: 0, usernameReqId: 0, referralReqId: 0,
      } as State;
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
    description: 'Slice + listeners; debounce via cancelActiveListeners() + delay() (×3 async).',
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

    listener.startListening({
      actionCreator: slice.actions.setField,
      effect: (a, api) => {
        api.dispatch(fieldChangedAction(a.payload));
      },
    });

    // Email debounce
    listener.startListening({
      predicate: (a) => fieldChangedAction.match(a) && a.payload.name === 'email',
      effect: async (a, { cancelActiveListeners, delay, getState, dispatch }) => {
        cancelActiveListeners();
        const value = (a as ReturnType<typeof fieldChangedAction>).payload.value as string;
        if (!value) return;
        await delay(EMAIL_DEBOUNCE_MS);
        const reqIdAtStart = (getState() as State).emailReqId;
        const ok = await checkEmailAvailable(value);
        if ((getState() as State).emailReqId !== reqIdAtStart) return;
        dispatch(slice.actions.setEmailStatus(ok ? 'valid' : 'invalid'));
      },
    });

    // Username debounce
    listener.startListening({
      predicate: (a) => fieldChangedAction.match(a) && a.payload.name === 'username',
      effect: async (a, { cancelActiveListeners, delay, getState, dispatch }) => {
        cancelActiveListeners();
        const value = (a as ReturnType<typeof fieldChangedAction>).payload.value as string;
        if (!value) return;
        await delay(USERNAME_DEBOUNCE_MS);
        const reqIdAtStart = (getState() as State).usernameReqId;
        const ok = await checkUsernameAvailable(value);
        if ((getState() as State).usernameReqId !== reqIdAtStart) return;
        dispatch(slice.actions.setUsernameStatus(ok ? 'valid' : 'invalid'));
      },
    });

    // Referral lookup
    listener.startListening({
      predicate: (a) => fieldChangedAction.match(a) && a.payload.name === 'referralCode',
      effect: async (a, { cancelActiveListeners, delay, getState, dispatch }) => {
        cancelActiveListeners();
        const value = (a as ReturnType<typeof fieldChangedAction>).payload.value as string;
        if (!value) return;
        await delay(REFERRAL_DEBOUNCE_MS);
        const reqIdAtStart = (getState() as State).referralReqId;
        const name = await lookupReferralCode(value);
        if ((getState() as State).referralReqId !== reqIdAtStart) return;
        dispatch(
          slice.actions.setReferralResult({
            status: name ? 'valid' : 'invalid',
            referrerName: name,
          }),
        );
      },
    });

    // Draft debounce — fires on any field change
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

    const computeSnap = (): WizardSnapshot => {
      const { emailReqId: _e, usernameReqId: _u, referralReqId: _r, ...rest } =
        store.getState() as State;
      void _e; void _u; void _r;
      return rest as WizardSnapshot;
    };
    let cachedSnap: WizardSnapshot = computeSnap();
    const snapshot = (): WizardSnapshot => cachedSnap;

    const subs = new Set<(s: WizardSnapshot) => void>();
    const unsubStore = store.subscribe(() => {
      cachedSnap = computeSnap();
      for (const cb of subs) cb(cachedSnap);
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
        const errs = validateStep(
          s.step, s.data, s.emailStatus, s.usernameStatus, s.referralStatus,
        );
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
