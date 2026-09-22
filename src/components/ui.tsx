/** Shared presentational primitives (server components). */

import type { ReactNode } from 'react';

export function Panel({
  title,
  right,
  children,
  flush,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        {right}
      </div>
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

export function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone ?? ''}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Notice({ kind, children }: { kind?: 'warn' | 'info'; children: ReactNode }) {
  return <div className={`notice ${kind ?? ''}`}>{children}</div>;
}

export function ProbBar({ label, p, tone }: { label: string; p: number; tone?: 'draw' | 'away' }) {
  return (
    <div className="prob-row">
      <span className="dim small">{label}</span>
      <div className="prob-bar">
        <div className={`prob-fill ${tone ?? ''}`} style={{ width: `${Math.min(100, p * 100)}%` }} />
      </div>
      <span className="num" style={{ textAlign: 'right' }}>
        {(p * 100).toFixed(1)}%
      </span>
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <div className="muted-box">{text}</div>;
}
