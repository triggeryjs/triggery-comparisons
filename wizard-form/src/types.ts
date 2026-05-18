// Domain types — shared between every engine. The UI talks only to these
// types; each engine implements the orchestration that drives them.

export type Role = 'developer' | 'designer' | 'manager';

export type TeamSize = '1-5' | '6-20' | '21-100' | '100+';

export type NotificationFreq = 'realtime' | 'digest' | 'never';

export type Step = 'account' | 'profile' | 'preferences' | 'team-size' | 'review';

export type WizardData = {
  // step 1 — account
  email: string;
  username: string;
  password: string;
  passwordConfirm: string;
  // step 2 — profile
  name: string;
  role: Role | '';
  referralCode: string;
  // step 3a — preferences (non-managers)
  notifications: NotificationFreq;
  marketingOptIn: boolean;
  // step 3b — team-size (managers)
  teamSize: TeamSize | '';
};

export type FieldName = keyof WizardData;

/** Shared status type for async-validated fields (email, username, referral). */
export type AsyncStatus = 'idle' | 'checking' | 'valid' | 'invalid';

/** Legacy alias — kept so existing engines keep compiling without renames. */
export type EmailStatus = AsyncStatus;

export type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; userId: string }
  | { kind: 'error'; message: string };

export type WizardSnapshot = {
  step: Step;
  data: WizardData;
  errors: Partial<Record<FieldName, string>>;
  emailStatus: AsyncStatus;
  usernameStatus: AsyncStatus;
  /** Per-field lookup result for referralCode. `null` while idle / checking;
   *  otherwise the resolved referrer's display name (or `''` when invalid). */
  referralStatus: AsyncStatus;
  referrerName: string | null;
  /** 1-indexed; total accounts for branching (5 incl. review). */
  progress: { current: number; total: number };
  submit: SubmitState;
};
