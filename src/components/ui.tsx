import { useState, type ReactNode } from 'react';
import { fmtPct, tone } from '../lib/format';

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  valueTone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  valueTone?: 'pos' | 'neg' | 'flat';
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${valueTone ?? ''}`}>{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export function Badge({
  children,
  kind = 'neutral',
}: {
  children: ReactNode;
  kind?: 'neutral' | 'pos' | 'neg' | 'warn' | 'live' | 'sim';
}) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function ChangeBadge({ value }: { value: number }) {
  if (!Number.isFinite(value)) return <span className="badge badge-neutral">—</span>;
  return (
    <span className={`badge badge-${tone(value) === 'flat' ? 'neutral' : tone(value)}`}>
      {fmtPct(value)}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  hint,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  suffix?: string;
}) {
  // The committed value is clamped by the store, so feedback from props would
  // fight the user mid-edit: clearing the field to retype a number would snap
  // straight back to the minimum. Holding a local draft while the field is
  // focused keeps typing natural, and blur re-syncs to the sanitised value.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (Number.isFinite(value) ? String(value) : '');

  return (
    <Field label={suffix ? `${label} (${suffix})` : label} hint={hint}>
      <input
        className="input"
        type="number"
        inputMode="decimal"
        value={shown}
        min={min}
        max={max}
        step={step}
        onFocus={() => setDraft(Number.isFinite(value) ? String(value) : '')}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          // An empty box is a valid intermediate state, not a zero.
          if (raw === '') return;
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setDraft(null)}
      />
    </Field>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="toggle">
      <span className="toggle-text">
        <span className="field-label">{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="toggle-input"
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Row({ left, right, sub }: { left: ReactNode; right: ReactNode; sub?: ReactNode }) {
  return (
    <div className="row">
      <div className="row-left">
        <span className="row-main">{left}</span>
        {sub && <span className="row-sub">{sub}</span>}
      </div>
      <div className="row-right">{right}</div>
    </div>
  );
}
