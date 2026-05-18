import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Engine } from './engine';
import { ENGINE_LIST, resolveEngineId } from './registry';
import { NOTIFICATION_FREQS, ROLES, TEAM_SIZES } from './scenario';
import type { WizardData } from './types';
import './styles.css';

export function App() {
  const engineId = useMemo(
    () => resolveEngineId(new URLSearchParams(window.location.search).get('engine')),
    [],
  );
  const factory = useMemo(() => ENGINE_LIST.find((e) => e.meta.id === engineId)!, [engineId]);
  const engine = useMemo(() => factory.create(), [factory]);
  useEffect(() => () => engine.dispose(), [engine]);
  // engine.loadDraft() — restore session on mount (R5)
  useEffect(() => engine.loadDraft(), [engine]);

  const snap = useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.snapshot(),
    () => engine.snapshot(),
  );

  return (
    <div className="app">
      <p className="title">
        Wizard form · same UI, {ENGINE_LIST.length} engines · currently {factory.meta.label}
      </p>
      <EngineBar current={engineId} />
      <Wizard engine={engine} snap={snap} />
    </div>
  );
}

function EngineBar({ current }: { current: string }) {
  return (
    <div className="engine-bar">
      {ENGINE_LIST.map((e) => (
        <a
          key={e.meta.id}
          href={`?engine=${e.meta.id}`}
          className={e.meta.id === current ? 'active' : ''}
          title={e.meta.description}
        >
          {e.meta.label}
        </a>
      ))}
    </div>
  );
}

function Wizard({ engine, snap }: { engine: Engine; snap: ReturnType<Engine['snapshot']> }) {
  const { step, data, errors, emailStatus, progress, submit } = snap;
  const isSubmitting = submit.kind === 'submitting';
  const set = <K extends keyof WizardData>(k: K) => (v: WizardData[K]) => engine.setField(k, v);

  return (
    <div className="wizard">
      <h1>
        {step === 'account' && 'Create your account'}
        {step === 'profile' && 'Tell us about you'}
        {step === 'preferences' && 'Notification preferences'}
        {step === 'team-size' && 'How big is your team?'}
        {step === 'review' && 'Review and submit'}
      </h1>
      <p className="step-meta">
        Step {progress.current} of {progress.total}
      </p>
      <div className="progress" aria-hidden>
        {Array.from({ length: progress.total }).map((_, i) => (
          <div
            key={i}
            className={`pip ${
              i + 1 < progress.current ? 'done' : i + 1 === progress.current ? 'current' : ''
            }`}
          />
        ))}
      </div>

      {submit.kind === 'success' && (
        <div className="banner success">Welcome! Your account id is {submit.userId}.</div>
      )}
      {submit.kind === 'error' && <div className="banner error">{submit.message}</div>}

      {step === 'account' && (
        <>
          <Field
            label="Email"
            value={data.email}
            onChange={(v) => set('email')(v)}
            error={errors.email}
            hint={
              emailStatus === 'checking'
                ? 'Checking availability…'
                : emailStatus === 'available'
                  ? 'Email is available.'
                  : ''
            }
            type="email"
            disabled={isSubmitting}
            autoFocus
          />
          <Field
            label="Password"
            value={data.password}
            onChange={(v) => set('password')(v)}
            error={errors.password}
            type="password"
            disabled={isSubmitting}
          />
          <Field
            label="Confirm password"
            value={data.passwordConfirm}
            onChange={(v) => set('passwordConfirm')(v)}
            error={errors.passwordConfirm}
            type="password"
            disabled={isSubmitting}
          />
        </>
      )}

      {step === 'profile' && (
        <>
          <Field
            label="Full name"
            value={data.name}
            onChange={(v) => set('name')(v)}
            error={errors.name}
            disabled={isSubmitting}
            autoFocus
          />
          <div className="field">
            <label>Role</label>
            <div className="choices">
              {ROLES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={data.role === r.id}
                  onClick={() => set('role')(r.id)}
                  disabled={isSubmitting}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <div className="err">{errors.role ?? ''}</div>
          </div>
        </>
      )}

      {step === 'preferences' && (
        <>
          <div className="field">
            <label>Notifications</label>
            <div className="choices">
              {NOTIFICATION_FREQS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={data.notifications === f.id}
                  onClick={() => set('notifications')(f.id)}
                  disabled={isSubmitting}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="hint">How often we should email you product updates.</div>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={data.marketingOptIn}
              onChange={(e) => set('marketingOptIn')(e.target.checked)}
              disabled={isSubmitting}
            />
            Send me occasional marketing emails too.
          </label>
        </>
      )}

      {step === 'team-size' && (
        <div className="field">
          <label>Team size</label>
          <div className="choices">
            {TEAM_SIZES.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={data.teamSize === t.id}
                onClick={() => set('teamSize')(t.id)}
                disabled={isSubmitting}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="err">{errors.teamSize ?? ''}</div>
        </div>
      )}

      {step === 'review' && (
        <dl className="review">
          <dt>Email</dt>
          <dd>{data.email}</dd>
          <dt>Name</dt>
          <dd>{data.name}</dd>
          <dt>Role</dt>
          <dd>{data.role || '—'}</dd>
          {data.role === 'manager' ? (
            <>
              <dt>Team size</dt>
              <dd>{data.teamSize || '—'}</dd>
            </>
          ) : (
            <>
              <dt>Notifications</dt>
              <dd>{data.notifications}</dd>
              <dt>Marketing</dt>
              <dd>{data.marketingOptIn ? 'opted in' : 'no thanks'}</dd>
            </>
          )}
        </dl>
      )}

      <div className="nav">
        <button onClick={() => engine.back()} disabled={step === 'account' || isSubmitting}>
          ← Back
        </button>
        {step === 'review' ? (
          <button className="primary" onClick={() => engine.submit()} disabled={isSubmitting}>
            {isSubmitting ? 'Submitting…' : 'Submit'}
          </button>
        ) : (
          <button className="primary" onClick={() => engine.next()} disabled={isSubmitting}>
            Continue →
          </button>
        )}
      </div>
      <ResetRow engine={engine} />
    </div>
  );
}

function ResetRow({ engine }: { engine: Engine }) {
  const [shown, setShown] = useState(false);
  return (
    <p style={{ color: '#717280', fontSize: 12, marginTop: 24, textAlign: 'right' }}>
      {shown ? (
        <>
          Sure?{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              engine.reset();
              setShown(false);
            }}
            style={{ color: '#f87171' }}
          >
            Yes, reset.
          </a>{' '}
          ·{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setShown(false);
            }}
          >
            Cancel
          </a>
        </>
      ) : (
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setShown(true);
          }}
          style={{ color: 'inherit' }}
        >
          Reset wizard
        </a>
      )}
    </p>
  );
}

function Field({
  label,
  value,
  onChange,
  error,
  hint,
  type = 'text',
  disabled,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  type?: 'text' | 'email' | 'password';
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      <div className="err">{error ?? ''}</div>
      <div className="hint">{hint ?? ''}</div>
    </div>
  );
}
