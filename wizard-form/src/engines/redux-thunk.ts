// Redux + thunk — slice for state; thunks run validation + transitions
// + async work. Three async fields = three hand-rolled debounce timers
// in the file-level closure.

import {
  configureStore,
  createSlice,
  type PayloadAction,
  type ThunkAction,
  type UnknownAction,
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

const slice = createSlice({
  name: 'wizard',
  initialState: {
    ...initialSnapshot(),
    emailReqId: 0, usernameReqId: 0, referralReqId: 0,
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

type RootState = State;
type AppThunk = ThunkAction<void, RootState, unknown, UnknownAction>;

export const reduxThunkFactory: EngineFactory = {
  meta: {
    id: 'redux-thunk',
    label: 'Redux + thunk',
    description: 'Thunks orchestrate transitions + async; hand-rolled timers (×3 async).',
    sourcePath: 'wizard-form/src/engines/redux-thunk.ts',
  },
  create(): Engine {
    const store = configureStore({ reducer: slice.reducer, middleware: (g) => g({ serializableCheck: false }) });
    let emailTimer: ReturnType<typeof setTimeout> | null = null;
    let usernameTimer: ReturnType<typeof setTimeout> | null = null;
    let referralTimer: ReturnType<typeof setTimeout> | null = null;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;

    const persist = (data: WizardData, step: Step) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, step }));
      } catch {
        // ignore
      }
    };

    const fieldThunk =
      (name: FieldName, value: WizardData[FieldName]): AppThunk =>
      (dispatch, getState) => {
        dispatch(slice.actions.setField({ name, value }));
        if (name === 'email') {
          if (emailTimer) clearTimeout(emailTimer);
          if (value) {
            emailTimer = setTimeout(async () => {
              emailTimer = null;
              const reqIdAtStart = getState().emailReqId;
              const ok = await checkEmailAvailable(value as string);
              if (getState().emailReqId !== reqIdAtStart) return;
              dispatch(slice.actions.setEmailStatus(ok ? 'valid' : 'invalid'));
            }, EMAIL_DEBOUNCE_MS);
          }
        } else if (name === 'username') {
          if (usernameTimer) clearTimeout(usernameTimer);
          if (value) {
            usernameTimer = setTimeout(async () => {
              usernameTimer = null;
              const reqIdAtStart = getState().usernameReqId;
              const ok = await checkUsernameAvailable(value as string);
              if (getState().usernameReqId !== reqIdAtStart) return;
              dispatch(slice.actions.setUsernameStatus(ok ? 'valid' : 'invalid'));
            }, USERNAME_DEBOUNCE_MS);
          }
        } else if (name === 'referralCode') {
          if (referralTimer) clearTimeout(referralTimer);
          if (value) {
            referralTimer = setTimeout(async () => {
              referralTimer = null;
              const reqIdAtStart = getState().referralReqId;
              const refName = await lookupReferralCode(value as string);
              if (getState().referralReqId !== reqIdAtStart) return;
              dispatch(
                slice.actions.setReferralResult({
                  status: refName ? 'valid' : 'invalid',
                  referrerName: refName,
                }),
              );
            }, REFERRAL_DEBOUNCE_MS);
          }
        }
        if (draftTimer) clearTimeout(draftTimer);
        draftTimer = setTimeout(() => {
          draftTimer = null;
          const s = getState();
          persist(s.data, s.step);
        }, DRAFT_DEBOUNCE_MS);
      };

    const nextThunk = (): AppThunk => (dispatch, getState) => {
      const s = getState();
      if (s.submit.kind === 'submitting') return;
      const errs = validateStep(
        s.step, s.data, s.emailStatus, s.usernameStatus, s.referralStatus,
      );
      if (Object.keys(errs).length > 0) {
        dispatch(slice.actions.setErrors(errs));
        return;
      }
      const ns = nextStep(s.step, s.data);
      if (!ns) return;
      dispatch(slice.actions.setStep(ns));
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = null;
      persist(s.data, ns);
    };

    const backThunk = (): AppThunk => (dispatch, getState) => {
      const s = getState();
      if (s.submit.kind === 'submitting') return;
      const ps = prevStep(s.step, s.data);
      if (!ps) return;
      dispatch(slice.actions.setStep(ps));
    };

    const submitThunk = (): AppThunk => async (dispatch, getState) => {
      const s = getState();
      if (s.step !== 'review' || s.submit.kind === 'submitting') return;
      dispatch(slice.actions.setSubmit({ kind: 'submitting' }));
      const res = await submitWizard(s.data);
      dispatch(
        slice.actions.setSubmit(
          res.ok ? { kind: 'success', userId: res.userId } : { kind: 'error', message: res.error },
        ),
      );
    };

    const computeSnap = (): WizardSnapshot => {
      const { emailReqId: _e, usernameReqId: _u, referralReqId: _r, ...rest } = store.getState();
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
      setField: (name, value) => void store.dispatch(fieldThunk(name, value)),
      next: () => void store.dispatch(nextThunk()),
      back: () => void store.dispatch(backThunk()),
      submit: () => void store.dispatch(submitThunk()),
      reset: () => {
        if (emailTimer) clearTimeout(emailTimer);
        if (usernameTimer) clearTimeout(usernameTimer);
        if (referralTimer) clearTimeout(referralTimer);
        if (draftTimer) clearTimeout(draftTimer);
        emailTimer = usernameTimer = referralTimer = draftTimer = null;
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
        if (emailTimer) clearTimeout(emailTimer);
        if (usernameTimer) clearTimeout(usernameTimer);
        if (referralTimer) clearTimeout(referralTimer);
        if (draftTimer) clearTimeout(draftTimer);
        unsubStore();
        subs.clear();
      },
    };
  },
};
