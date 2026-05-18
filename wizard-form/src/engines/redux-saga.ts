// Redux + saga — generators handle the orchestration. `debounce(ms, action,
// saga)` is built-in and supersedes prior in-flight calls automatically.
// Three async fields = three debounce sagas, one per field. No hand-rolled
// timers.

import {
  configureStore,
  createAction,
  createSlice,
  type PayloadAction,
} from '@reduxjs/toolkit';
import createSagaMiddleware from 'redux-saga';
import { all, call, debounce, put, select, takeEvery } from 'redux-saga/effects';
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

const nextClicked = createAction('wizard/nextClicked');
const backClicked = createAction('wizard/backClicked');
const submitClicked = createAction('wizard/submitClicked');

export const reduxSagaFactory: EngineFactory = {
  meta: {
    id: 'redux-saga',
    label: 'Redux + saga',
    description: 'Generators + effect-as-data: debounce × 3 async, takeEvery / call.',
    sourcePath: 'wizard-form/src/engines/redux-saga.ts',
  },
  create(): Engine {
    function* emailSaga(action: ReturnType<typeof slice.actions.setField>): Generator {
      if (action.payload.name !== 'email') return;
      const value = action.payload.value as string;
      if (!value) return;
      const reqIdAtStart = (yield select((s: State) => s.emailReqId)) as number;
      const ok = (yield call(checkEmailAvailable, value)) as boolean;
      const current = (yield select((s: State) => s.emailReqId)) as number;
      if (current !== reqIdAtStart) return;
      yield put(slice.actions.setEmailStatus(ok ? 'valid' : 'invalid'));
    }
    function* usernameSaga(action: ReturnType<typeof slice.actions.setField>): Generator {
      if (action.payload.name !== 'username') return;
      const value = action.payload.value as string;
      if (!value) return;
      const reqIdAtStart = (yield select((s: State) => s.usernameReqId)) as number;
      const ok = (yield call(checkUsernameAvailable, value)) as boolean;
      const current = (yield select((s: State) => s.usernameReqId)) as number;
      if (current !== reqIdAtStart) return;
      yield put(slice.actions.setUsernameStatus(ok ? 'valid' : 'invalid'));
    }
    function* referralSaga(action: ReturnType<typeof slice.actions.setField>): Generator {
      if (action.payload.name !== 'referralCode') return;
      const value = action.payload.value as string;
      if (!value) return;
      const reqIdAtStart = (yield select((s: State) => s.referralReqId)) as number;
      const name = (yield call(lookupReferralCode, value)) as string | null;
      const current = (yield select((s: State) => s.referralReqId)) as number;
      if (current !== reqIdAtStart) return;
      yield put(
        slice.actions.setReferralResult({ status: name ? 'valid' : 'invalid', referrerName: name }),
      );
    }

    function* draftSaveSaga(): Generator {
      const { data, step } = (yield select((s: State) => ({ data: s.data, step: s.step }))) as {
        data: WizardData;
        step: Step;
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, step }));
      } catch {
        // ignore
      }
      yield;
    }

    function* handleNext(): Generator {
      const s = (yield select()) as State;
      if (s.submit.kind === 'submitting') return;
      const errs = validateStep(
        s.step, s.data, s.emailStatus, s.usernameStatus, s.referralStatus,
      );
      if (Object.keys(errs).length > 0) {
        yield put(slice.actions.setErrors(errs));
        return;
      }
      const ns = nextStep(s.step, s.data);
      if (!ns) return;
      yield put(slice.actions.setStep(ns));
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data: s.data, step: ns }));
      } catch {
        // ignore
      }
    }

    function* handleBack(): Generator {
      const s = (yield select()) as State;
      if (s.submit.kind === 'submitting') return;
      const ps = prevStep(s.step, s.data);
      if (!ps) return;
      yield put(slice.actions.setStep(ps));
    }

    function* handleSubmit(): Generator {
      const s = (yield select()) as State;
      if (s.step !== 'review' || s.submit.kind === 'submitting') return;
      yield put(slice.actions.setSubmit({ kind: 'submitting' }));
      const res = (yield call(submitWizard, s.data)) as
        | { ok: true; userId: string }
        | { ok: false; error: string };
      yield put(
        slice.actions.setSubmit(
          res.ok ? { kind: 'success', userId: res.userId } : { kind: 'error', message: res.error },
        ),
      );
    }

    function* root(): Generator {
      yield all([
        debounce(EMAIL_DEBOUNCE_MS, slice.actions.setField.type, emailSaga),
        debounce(USERNAME_DEBOUNCE_MS, slice.actions.setField.type, usernameSaga),
        debounce(REFERRAL_DEBOUNCE_MS, slice.actions.setField.type, referralSaga),
        debounce(DRAFT_DEBOUNCE_MS, slice.actions.setField.type, draftSaveSaga),
        takeEvery(nextClicked.type, handleNext),
        takeEvery(backClicked.type, handleBack),
        takeEvery(submitClicked.type, handleSubmit),
      ]);
    }

    const sagaMiddleware = createSagaMiddleware();
    const store = configureStore({
      reducer: slice.reducer,
      middleware: (gdm) => gdm({ serializableCheck: false, thunk: false }).concat(sagaMiddleware),
    });
    const rootTask = sagaMiddleware.run(root);

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
      setField: (name, value) => void store.dispatch(slice.actions.setField({ name, value })),
      next: () => void store.dispatch(nextClicked()),
      back: () => void store.dispatch(backClicked()),
      submit: () => void store.dispatch(submitClicked()),
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
        rootTask.cancel();
        unsubStore();
        subs.clear();
      },
    };
  },
};
