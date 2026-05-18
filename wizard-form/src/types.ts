// Domain types — shared between every engine. The UI talks only to these
// types; each engine implements the orchestration that drives them.

export type Role = 'developer' | 'designer' | 'manager';

export type TeamSize = '1-5' | '6-20' | '21-100' | '100+';

export type NotificationFreq = 'realtime' | 'digest' | 'never';

export type Step = 'account' | 'profile' | 'preferences' | 'team-size' | 'review';

export type WizardData = {
  // step 1 — account
  email: string;
  password: string;
  passwordConfirm: string;
  // step 2 — profile
  name: string;
  role: Role | '';
  // step 3a — preferences (non-managers)
  notifications: NotificationFreq;
  marketingOptIn: boolean;
  // step 3b — team-size (managers)
  teamSize: TeamSize | '';
};

export type FieldName = keyof WizardData;

export type EmailStatus = 'idle' | 'checking' | 'available' | 'taken';

export type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; userId: string }
  | { kind: 'error'; message: string };

export type WizardSnapshot = {
  step: Step;
  data: WizardData;
  errors: Partial<Record<FieldName, string>>;
  emailStatus: EmailStatus;
  /** 1-indexed; total accounts for branching (5 incl. review). */
  progress: { current: number; total: number };
  submit: SubmitState;
};
