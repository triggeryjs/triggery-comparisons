// Shared scenario fixtures — pure functions used by every engine. Keeping
// validators + mock API + step-graph here makes the engine files focus on
// orchestration, not domain rules.

import type {
  AsyncStatus,
  FieldName,
  Role,
  Step,
  WizardData,
  WizardSnapshot,
} from './types';

export const STORAGE_KEY = 'triggery-comparison.wizard-draft.v2';

export const EMAIL_DEBOUNCE_MS = 500;
export const USERNAME_DEBOUNCE_MS = 300;
export const REFERRAL_DEBOUNCE_MS = 800;
export const DRAFT_DEBOUNCE_MS = 1000;

// Mock backend: emails / usernames marked as taken.
const TAKEN_EMAILS = new Set(['admin@example.com', 'taken@example.com']);
const TAKEN_USERNAMES = new Set(['admin', 'root', 'system', 'support', 'taken']);
const REFERRAL_DB: Record<string, string> = {
  ALEX2026: 'Alex Karp',
  TRIGGERY: 'Triggery Team',
  EARLYBIRD: 'Early Access',
};

/** Simulated network call. Resolves after ~250 ms with availability. */
export async function checkEmailAvailable(email: string): Promise<boolean> {
  await delay(250);
  return !TAKEN_EMAILS.has(email.trim().toLowerCase());
}

/** Username availability check. ~200 ms, simulates a faster endpoint. */
export async function checkUsernameAvailable(username: string): Promise<boolean> {
  await delay(200);
  return !TAKEN_USERNAMES.has(username.trim().toLowerCase());
}

/** Referral-code lookup. ~350 ms; resolves to a referrer name on hit, null on miss. */
export async function lookupReferralCode(code: string): Promise<string | null> {
  await delay(350);
  return REFERRAL_DB[code.trim().toUpperCase()] ?? null;
}

/** Simulated submit. 1-in-5 chance of failure, ~700ms latency. */
export async function submitWizard(
  data: WizardData,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  await delay(700);
  if (Math.random() < 0.2)
    return { ok: false, error: 'Something went wrong on our side. Try again.' };
  return { ok: true, userId: `u_${Math.random().toString(36).slice(2, 8)}` };
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function emptyData(): WizardData {
  return {
    email: '',
    username: '',
    password: '',
    passwordConfirm: '',
    name: '',
    role: '',
    referralCode: '',
    notifications: 'digest',
    marketingOptIn: false,
    teamSize: '',
  };
}

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

/** Resolve which step follows the given step, given the current data
 *  (branching on `role` after `profile`). Returns `null` if we're at the
 *  end (review → submit, handled separately). */
export function nextStep(current: Step, data: WizardData): Step | null {
  switch (current) {
    case 'account':
      return 'profile';
    case 'profile':
      return data.role === 'manager' ? 'team-size' : 'preferences';
    case 'preferences':
    case 'team-size':
      return 'review';
    case 'review':
      return null;
  }
}

export function prevStep(current: Step, data: WizardData): Step | null {
  switch (current) {
    case 'account':
      return null;
    case 'profile':
      return 'account';
    case 'preferences':
    case 'team-size':
      return 'profile';
    case 'review':
      return data.role === 'manager' ? 'team-size' : 'preferences';
  }
}

/** Numbering accounting for branching — review is always step 4 of 4. */
export function progressFor(step: Step): { current: number; total: number } {
  const idx: Record<Step, number> = {
    account: 1,
    profile: 2,
    preferences: 3,
    'team-size': 3,
    review: 4,
  };
  return { current: idx[step], total: 4 };
}

/** Synchronous validators per step. Returns an error message per offending
 *  field, or an empty object on success. */
export function validateStep(
  step: Step,
  data: WizardData,
  emailStatus: AsyncStatus,
  usernameStatus: AsyncStatus = 'idle',
  referralStatus: AsyncStatus = 'idle',
): Partial<Record<FieldName, string>> {
  const errs: Partial<Record<FieldName, string>> = {};
  if (step === 'account') {
    if (!EMAIL_RE.test(data.email)) errs.email = 'Enter a valid email.';
    if (emailStatus === 'invalid') errs.email = 'This email is already in use.';
    if (!USERNAME_RE.test(data.username)) errs.username = '3–20 letters, digits, underscore.';
    else if (usernameStatus === 'invalid') errs.username = 'Username already taken.';
    if (data.password.length < 8) errs.password = 'At least 8 characters.';
    if (data.password !== data.passwordConfirm)
      errs.passwordConfirm = 'Passwords do not match.';
  } else if (step === 'profile') {
    if (data.name.trim().length < 2) errs.name = 'Enter your full name.';
    if (data.role === '') errs.role = 'Pick a role.';
    // referralCode is optional but, if entered, must resolve.
    if (data.referralCode && referralStatus === 'invalid')
      errs.referralCode = 'Unknown referral code.';
  } else if (step === 'team-size') {
    if (data.teamSize === '') errs.teamSize = 'Pick a team size.';
  }
  return errs;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ROLES: readonly { id: Role; label: string }[] = [
  { id: 'developer', label: 'Developer' },
  { id: 'designer', label: 'Designer' },
  { id: 'manager', label: 'Manager' },
];

export const TEAM_SIZES: readonly { id: WizardData['teamSize']; label: string }[] = [
  { id: '1-5', label: '1–5 people' },
  { id: '6-20', label: '6–20 people' },
  { id: '21-100', label: '21–100 people' },
  { id: '100+', label: '100+ people' },
];

export const NOTIFICATION_FREQS: readonly {
  id: WizardData['notifications'];
  label: string;
}[] = [
  { id: 'realtime', label: 'Real-time' },
  { id: 'digest', label: 'Daily digest' },
  { id: 'never', label: 'Never' },
];

/** Helper for engines that want a one-call initial snapshot. */
export function initialSnapshot(): WizardSnapshot {
  return {
    step: 'account',
    data: emptyData(),
    errors: {},
    emailStatus: 'idle',
    usernameStatus: 'idle',
    referralStatus: 'idle',
    referrerName: null,
    progress: progressFor('account'),
    submit: { kind: 'idle' },
  };
}
