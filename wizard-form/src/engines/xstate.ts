// XState — the state machine wizards were built for. States are step nodes;
// transitions carry guards. Three async fields = three cancellable delayed
// raises (`raise(EV, { delay, id })` + `cancel(id)` per field) + three
// invoked-actor patterns. Async submit is its own invoked promise actor.

import {
  type ActorRefFrom,
  assign,
  cancel,
  createActor,
  fromPromise,
  raise,
  setup,
} from 'xstate';
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
  lookupReferralCode,
  progressFor,
  submitWizard,
  validateStep,
} from '../scenario';
import type {
  AsyncStatus,
  FieldName,
  Step,
  WizardData,
  WizardSnapshot,
} from '../types';

type Ctx = {
  data: WizardData;
  errors: Partial<Record<FieldName, string>>;
  emailStatus: AsyncStatus;
  usernameStatus: AsyncStatus;
  referralStatus: AsyncStatus;
  referrerName: string | null;
  emailReqId: number;
  usernameReqId: number;
  referralReqId: number;
  submitResult: { kind: 'idle' } | { kind: 'success'; userId: string } | { kind: 'error'; message: string };
};

type Ev =
  | { type: 'SET_FIELD'; name: FieldName; value: WizardData[FieldName] }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'SUBMIT' }
  | { type: 'RESET' }
  | { type: 'LOAD_DRAFT' }
  | { type: 'CHECK_EMAIL' }
  | { type: 'CHECK_USERNAME' }
  | { type: 'LOOKUP_REFERRAL' }
  | { type: 'EMAIL_CHECKED'; reqId: number; available: boolean }
  | { type: 'USERNAME_CHECKED'; reqId: number; available: boolean }
  | { type: 'REFERRAL_LOOKED_UP'; reqId: number; referrerName: string | null }
  | { type: 'PERSIST_DRAFT' };

const machine = setup({
  types: { context: {} as Ctx, events: {} as Ev },
  actors: {
    submitActor: fromPromise(async ({ input }: { input: { data: WizardData } }) =>
      submitWizard(input.data),
    ),
  },
  guards: {
    accountValid: ({ context }) =>
      Object.keys(
        validateStep('account', context.data, context.emailStatus, context.usernameStatus),
      ).length === 0,
    profileValid: ({ context }) =>
      Object.keys(
        validateStep(
          'profile', context.data,
          context.emailStatus, context.usernameStatus, context.referralStatus,
        ),
      ).length === 0,
    teamSizeValid: ({ context }) =>
      Object.keys(validateStep('team-size', context.data, context.emailStatus)).length === 0,
    isManager: ({ context }) => context.data.role === 'manager',
  },
  actions: {
    setField: assign({
      data: ({ context, event }) =>
        event.type === 'SET_FIELD' ? { ...context.data, [event.name]: event.value } : context.data,
      emailStatus: ({ context, event }) =>
        event.type === 'SET_FIELD' && event.name === 'email'
          ? ((event.value as string) ? 'checking' : 'idle')
          : context.emailStatus,
      usernameStatus: ({ context, event }) =>
        event.type === 'SET_FIELD' && event.name === 'username'
          ? ((event.value as string) ? 'checking' : 'idle')
          : context.usernameStatus,
      referralStatus: ({ context, event }) =>
        event.type === 'SET_FIELD' && event.name === 'referralCode'
          ? ((event.value as string) ? 'checking' : 'idle')
          : context.referralStatus,
      referrerName: ({ context, event }) =>
        event.type === 'SET_FIELD' && event.name === 'referralCode' && !event.value
          ? null
          : context.referrerName,
      emailReqId: ({ context, event }) =>
        event.type === 'SET_FIELD' && event.name === 'email'
          ? context.emailReqId + 1
          : context.emailReqId,
      usernameReqId: ({ context, event }) =>
        event.type === 'SET_FIELD' && event.name === 'username'
          ? context.usernameReqId + 1
          : context.usernameReqId,
      referralReqId: ({ context, event }) =>
        event.type === 'SET_FIELD' && event.name === 'referralCode'
          ? context.referralReqId + 1
          : context.referralReqId,
    }),
    setEmailChecked: assign(({ context, event }) =>
      event.type === 'EMAIL_CHECKED' && event.reqId === context.emailReqId
        ? { emailStatus: event.available ? ('valid' as const) : ('invalid' as const) }
        : {},
    ),
    setUsernameChecked: assign(({ context, event }) =>
      event.type === 'USERNAME_CHECKED' && event.reqId === context.usernameReqId
        ? { usernameStatus: event.available ? ('valid' as const) : ('invalid' as const) }
        : {},
    ),
    setReferralLookedUp: assign(({ context, event }) => {
      if (event.type !== 'REFERRAL_LOOKED_UP') return {};
      if (event.reqId !== context.referralReqId) return {};
      return {
        referralStatus: event.referrerName ? ('valid' as const) : ('invalid' as const),
        referrerName: event.referrerName,
      };
    }),
    setSubmitSuccess: assign({
      submitResult: (_, params: { userId: string }) =>
        ({ kind: 'success', userId: params.userId } as const),
    }),
    setSubmitError: assign({
      submitResult: (_, params: { message: string }) =>
        ({ kind: 'error', message: params.message } as const),
    }),
    persistDraft: ({ context }, params?: { step: Step }) => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ data: context.data, step: params?.step ?? 'account' }),
        );
      } catch {
        // ignore
      }
    },
    clearDraft: () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    },
  },
}).createMachine({
  id: 'wizard',
  initial: 'account',
  context: {
    data: emptyData(),
    errors: {},
    emailStatus: 'idle',
    usernameStatus: 'idle',
    referralStatus: 'idle',
    referrerName: null,
    emailReqId: 0,
    usernameReqId: 0,
    referralReqId: 0,
    submitResult: { kind: 'idle' },
  },
  on: {
    SET_FIELD: {
      actions: [
        'setField',
        cancel('email-debounce'),
        raise({ type: 'CHECK_EMAIL' }, { delay: EMAIL_DEBOUNCE_MS, id: 'email-debounce' }),
        cancel('username-debounce'),
        raise({ type: 'CHECK_USERNAME' }, { delay: USERNAME_DEBOUNCE_MS, id: 'username-debounce' }),
        cancel('referral-debounce'),
        raise({ type: 'LOOKUP_REFERRAL' }, { delay: REFERRAL_DEBOUNCE_MS, id: 'referral-debounce' }),
        cancel('draft-debounce'),
        raise({ type: 'PERSIST_DRAFT' }, { delay: DRAFT_DEBOUNCE_MS, id: 'draft-debounce' }),
      ],
    },
    CHECK_EMAIL: {
      actions: ({ context, self }) => {
        if (!context.data.email) return;
        const reqId = context.emailReqId;
        checkEmailAvailable(context.data.email).then((available) =>
          self.send({ type: 'EMAIL_CHECKED', reqId, available }),
        );
      },
    },
    CHECK_USERNAME: {
      actions: ({ context, self }) => {
        if (!context.data.username) return;
        const reqId = context.usernameReqId;
        checkUsernameAvailable(context.data.username).then((available) =>
          self.send({ type: 'USERNAME_CHECKED', reqId, available }),
        );
      },
    },
    LOOKUP_REFERRAL: {
      actions: ({ context, self }) => {
        if (!context.data.referralCode) return;
        const reqId = context.referralReqId;
        lookupReferralCode(context.data.referralCode).then((referrerName) =>
          self.send({ type: 'REFERRAL_LOOKED_UP', reqId, referrerName }),
        );
      },
    },
    EMAIL_CHECKED: { actions: 'setEmailChecked' },
    USERNAME_CHECKED: { actions: 'setUsernameChecked' },
    REFERRAL_LOOKED_UP: { actions: 'setReferralLookedUp' },
    PERSIST_DRAFT: {
      actions: ({ context, self }) => {
        try {
          const snap = self.getSnapshot() as { value: Step | 'submitting' | 'success' };
          const step = isStepValue(snap.value) ? snap.value : 'review';
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ data: context.data, step }));
        } catch {
          // ignore
        }
      },
    },
    LOAD_DRAFT: {
      actions: assign(() => {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return {};
          const parsed = JSON.parse(raw) as { data: WizardData; step: Step };
          return { data: { ...emptyData(), ...parsed.data } };
        } catch {
          return {};
        }
      }),
    },
    RESET: {
      target: '.account',
      actions: [
        cancel('email-debounce'),
        cancel('username-debounce'),
        cancel('referral-debounce'),
        cancel('draft-debounce'),
        assign(({ context }) => ({
          data: emptyData(),
          errors: {},
          emailStatus: 'idle' as const,
          usernameStatus: 'idle' as const,
          referralStatus: 'idle' as const,
          referrerName: null,
          emailReqId: context.emailReqId + 1,
          usernameReqId: context.usernameReqId + 1,
          referralReqId: context.referralReqId + 1,
          submitResult: { kind: 'idle' } as const,
        })),
        'clearDraft',
      ],
    },
  },
  states: {
    account: {
      on: {
        NEXT: { target: 'profile', guard: 'accountValid', actions: [{ type: 'persistDraft', params: { step: 'profile' } }] },
      },
    },
    profile: {
      on: {
        NEXT: [
          { target: 'team-size', guard: 'isManager', actions: [{ type: 'persistDraft', params: { step: 'team-size' } }] },
          { target: 'preferences', guard: 'profileValid', actions: [{ type: 'persistDraft', params: { step: 'preferences' } }] },
        ],
        BACK: 'account',
      },
    },
    preferences: {
      on: {
        NEXT: { target: 'review', actions: [{ type: 'persistDraft', params: { step: 'review' } }] },
        BACK: 'profile',
      },
    },
    'team-size': {
      on: {
        NEXT: { target: 'review', guard: 'teamSizeValid', actions: [{ type: 'persistDraft', params: { step: 'review' } }] },
        BACK: 'profile',
      },
    },
    review: {
      on: {
        SUBMIT: 'submitting',
        BACK: [
          { target: 'team-size', guard: 'isManager' },
          { target: 'preferences' },
        ],
      },
    },
    submitting: {
      invoke: {
        src: 'submitActor',
        input: ({ context }) => ({ data: context.data }),
        onDone: [
          {
            target: 'success',
            guard: ({ event }) => (event.output as { ok: boolean }).ok,
            actions: { type: 'setSubmitSuccess', params: ({ event }) => ({ userId: (event.output as { userId: string }).userId }) },
          },
          {
            target: 'review',
            actions: { type: 'setSubmitError', params: ({ event }) => ({ message: (event.output as { error: string }).error }) },
          },
        ],
      },
    },
    success: { type: 'final' },
  },
});

const STEP_VALUES: readonly Step[] = ['account', 'profile', 'preferences', 'team-size', 'review'];
function isStepValue(v: unknown): v is Step {
  return typeof v === 'string' && (STEP_VALUES as readonly string[]).includes(v);
}

function snapshotFrom(actor: ActorRefFrom<typeof machine>): WizardSnapshot {
  const s = actor.getSnapshot();
  const value = s.value as string;
  const step: Step = isStepValue(value) ? value : 'review';
  const submitting = value === 'submitting';
  const submit: WizardSnapshot['submit'] = submitting
    ? { kind: 'submitting' }
    : s.context.submitResult;
  return {
    step,
    data: s.context.data,
    errors: s.context.errors,
    emailStatus: s.context.emailStatus,
    usernameStatus: s.context.usernameStatus,
    referralStatus: s.context.referralStatus,
    referrerName: s.context.referrerName,
    progress: progressFor(step),
    submit,
  };
}

export const xstateFactory: EngineFactory = {
  meta: {
    id: 'xstate',
    label: 'XState',
    description: 'Statechart: states + transitions + 3 cancellable raises + invoked submit actor.',
    sourcePath: 'wizard-form/src/engines/xstate.ts',
  },
  create(): Engine {
    const actor = createActor(machine);
    actor.start();
    const subs = new Set<(s: WizardSnapshot) => void>();
    let snap = snapshotFrom(actor);
    const unsubActor = actor.subscribe(() => {
      snap = snapshotFrom(actor);
      for (const cb of subs) cb(snap);
    });
    return {
      snapshot: () => snap,
      subscribe(cb) {
        subs.add(cb);
        return (() => subs.delete(cb)) as Unsubscribe;
      },
      setField: (name, value) =>
        actor.send({ type: 'SET_FIELD', name, value } as Extract<Ev, { type: 'SET_FIELD' }>),
      next: () => actor.send({ type: 'NEXT' }),
      back: () => actor.send({ type: 'BACK' }),
      submit: () => actor.send({ type: 'SUBMIT' }),
      reset: () => actor.send({ type: 'RESET' }),
      loadDraft: () => actor.send({ type: 'LOAD_DRAFT' }),
      dispose: () => {
        unsubActor.unsubscribe();
        actor.stop();
        subs.clear();
      },
    };
  },
};
