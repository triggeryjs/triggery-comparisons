// XState — the state machine wizards were built for. Every step is a state
// node; every transition is a `target` + `guard`. Email-debounce and draft-
// save use cancellable delayed raises (`raise({ delay, id })` + `cancel(id)`).
// Async submit is an invoked actor. The whole wizard is one declarative
// statechart — its `.value` is the truth for "what step are we on".

import { type ActorRefFrom, assign, cancel, createActor, fromPromise, raise, setup } from 'xstate';
import type { Engine, EngineFactory, Unsubscribe } from '../engine';
import {
  DRAFT_DEBOUNCE_MS,
  EMAIL_DEBOUNCE_MS,
  STORAGE_KEY,
  checkEmailAvailable,
  emptyData,
  progressFor,
  submitWizard,
  validateStep,
} from '../scenario';
import type {
  EmailStatus,
  FieldName,
  Step,
  WizardData,
  WizardSnapshot,
} from '../types';

type Ctx = {
  data: WizardData;
  errors: Partial<Record<FieldName, string>>;
  emailStatus: EmailStatus;
  emailReqId: number;
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
  | { type: 'EMAIL_CHECKED'; reqId: number; available: boolean }
  | { type: 'PERSIST_DRAFT' };

const machine = setup({
  types: { context: {} as Ctx, events: {} as Ev },
  actors: {
    emailCheck: fromPromise(async ({ input }: { input: { email: string } }) =>
      checkEmailAvailable(input.email),
    ),
    submitActor: fromPromise(async ({ input }: { input: { data: WizardData } }) =>
      submitWizard(input.data),
    ),
  },
  guards: {
    accountValid: ({ context }) =>
      Object.keys(validateStep('account', context.data, context.emailStatus)).length === 0,
    profileValid: ({ context }) =>
      Object.keys(validateStep('profile', context.data, context.emailStatus)).length === 0,
    teamSizeValid: ({ context }) =>
      Object.keys(validateStep('team-size', context.data, context.emailStatus)).length === 0,
    isManager: ({ context }) => context.data.role === 'manager',
  },
  actions: {
    setField: assign({
      data: ({ context, event }) => {
        if (event.type !== 'SET_FIELD') return context.data;
        return { ...context.data, [event.name]: event.value };
      },
      emailStatus: ({ context, event }) => {
        if (event.type !== 'SET_FIELD' || event.name !== 'email') return context.emailStatus;
        return (event.value as string) ? 'checking' : 'idle';
      },
      emailReqId: ({ context, event }) => {
        if (event.type !== 'SET_FIELD' || event.name !== 'email') return context.emailReqId;
        return context.emailReqId + 1;
      },
    }),
    runValidation: assign({
      errors: ({ context }) => {
        return validateStep(
          context.data.role === 'manager' && context.data.teamSize === ''
            ? 'team-size'
            : 'account',
          context.data,
          context.emailStatus,
        );
      },
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
    setEmailStatus: assign(({ context, event }) => {
      if (event.type !== 'EMAIL_CHECKED' || event.reqId !== context.emailReqId) return {};
      return { emailStatus: event.available ? ('available' as const) : ('taken' as const) };
    }),
    setSubmitSuccess: assign({
      submitResult: (_, params: { userId: string }) => ({ kind: 'success', userId: params.userId } as const),
    }),
    setSubmitError: assign({
      submitResult: (_, params: { message: string }) => ({ kind: 'error', message: params.message } as const),
    }),
  },
}).createMachine({
  id: 'wizard',
  initial: 'account',
  context: { data: emptyData(), errors: {}, emailStatus: 'idle', emailReqId: 0, submitResult: { kind: 'idle' } },
  on: {
    SET_FIELD: {
      actions: [
        'setField',
        cancel('email-debounce'),
        raise({ type: 'CHECK_EMAIL' }, { delay: EMAIL_DEBOUNCE_MS, id: 'email-debounce' }),
        cancel('draft-debounce'),
        raise({ type: 'PERSIST_DRAFT' }, { delay: DRAFT_DEBOUNCE_MS, id: 'draft-debounce' }),
      ],
    },
    CHECK_EMAIL: {
      // spawn the actor inline; result raises EMAIL_CHECKED with reqId
      actions: ({ context, self }) => {
        if (!context.data.email) return;
        const reqId = context.emailReqId;
        checkEmailAvailable(context.data.email).then((available) =>
          self.send({ type: 'EMAIL_CHECKED', reqId, available }),
        );
      },
    },
    EMAIL_CHECKED: { actions: 'setEmailStatus' },
    PERSIST_DRAFT: {
      actions: ({ context, self }) => {
        try {
          const snap = self.getSnapshot() as { value: Step | 'submitting' | 'success' | 'error' };
          const step = isStepValue(snap.value) ? snap.value : 'review';
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ data: context.data, step }));
        } catch {
          // ignore
        }
      },
    },
    LOAD_DRAFT: {
      actions: assign(({ context }) => {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return {};
          const parsed = JSON.parse(raw) as { data: WizardData; step: Step };
          return { data: { ...emptyData(), ...parsed.data } };
        } catch {
          return {};
        }
      }),
      // Note: restoring `step` is handled by emitting a series of NEXTs in the
      // engine façade. Keeping the machine itself pure makes guards predictable.
    },
    RESET: {
      target: '.account',
      actions: [
        cancel('email-debounce'),
        cancel('draft-debounce'),
        assign({
          data: () => emptyData(),
          errors: () => ({}),
          emailStatus: () => 'idle' as const,
          emailReqId: ({ context }) => context.emailReqId + 1,
          submitResult: () => ({ kind: 'idle' } as const),
        }),
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
    progress: progressFor(step),
    submit,
  };
}

export const xstateFactory: EngineFactory = {
  meta: {
    id: 'xstate',
    label: 'XState',
    description: 'Statechart: states + transitions + guards, debounce via raise/cancel.',
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
