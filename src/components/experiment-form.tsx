'use client';

import { useState } from 'react';

const FEATURES = [
  'eloDiff',
  'restDaysDiff',
  'congestionDiff',
  'combinedGoalExpectancy',
  'attackDefenceEdge',
  'xgRate5Diff',
  'gdRate5Diff',
  'seasonPtsRateDiff',
  'positionDiff',
  'venuePtsRateDiff',
];

export function ExperimentForm({ defaultFrom, defaultTo }: { defaultFrom: string; defaultTo: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [title, setTitle] = useState('');
  const [hypothesis, setHypothesis] = useState('');
  const [market, setMarket] = useState('ONE_X_TWO');
  const [feature, setFeature] = useState('combinedGoalExpectancy');
  const [op, setOp] = useState('>=');
  const [value, setValue] = useState('0.4');
  const [edgeMin, setEdgeMin] = useState('0.01');

  const submit = async () => {
    setState('busy');
    setMsg('');
    try {
      const createRes = await fetch('/api/experiments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          hypothesis,
          config: {
            dataset: {
              competitionId: null,
              testFrom: `${defaultFrom}T00:00:00Z`,
              testTo: `${defaultTo}T00:00:00Z`,
              trainSpanDays: 760,
            },
            market,
            ...(market === 'OU_GOALS' ? { line: 2.5 } : {}),
            matchFilters: [{ feature, op, value: Number(value) }],
            methodology: {
              refitEveryRounds: 4,
              edgeMin: Number(edgeMin),
              entryPrice: 'best',
              calibrationMethod: 'isotonic',
            },
          },
        }),
      });
      const created = await createRes.json();
      if (!createRes.ok) throw new Error(created?.error?.message ?? `HTTP ${createRes.status}`);
      const id = created.data.id;
      const runRes = await fetch(`/api/experiments/${id}/run`, { method: 'POST' });
      const runJson = await runRes.json();
      if (!runRes.ok) throw new Error(runJson?.error?.message ?? `HTTP ${runRes.status}`);
      setState('done');
      setMsg(`Experiment #${id} is running as a walk-forward validation (status: VALIDATING). Refresh in ~30–60s.`);
    } catch (e) {
      setState('error');
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="field">
        <label>Experiment title</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. High combined goal expectancy → Over 2.5" style={{ minWidth: 340 }} />
      </div>
      <div className="field">
        <label>Hypothesis (falsifiable statement)</label>
        <textarea value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} placeholder="Fixtures matching X show a systematically higher/lower probability of Y than market prices imply." />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div className="field">
          <label>Market</label>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="ONE_X_TWO">1X2</option>
            <option value="OU_GOALS">Over/Under 2.5</option>
          </select>
        </div>
        <div className="field">
          <label>Condition feature</label>
          <select value={feature} onChange={(e) => setFeature(e.target.value)}>
            {FEATURES.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Operator</label>
          <select value={op} onChange={(e) => setOp(e.target.value)}>
            <option value=">=">≥</option>
            <option value="<=">≤</option>
          </select>
        </div>
        <div className="field">
          <label>Threshold</label>
          <input type="number" step="0.05" value={value} onChange={(e) => setValue(e.target.value)} style={{ minWidth: 80 }} />
        </div>
        <div className="field">
          <label>Min model EV</label>
          <input type="number" step="0.01" min="0" max="0.5" value={edgeMin} onChange={(e) => setEdgeMin(e.target.value)} style={{ minWidth: 80 }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn primary" onClick={submit} disabled={state === 'busy' || title.length < 5 || hypothesis.length < 10}>
          {state === 'busy' ? 'Submitting…' : 'RUN EXPERIMENT'}
        </button>
        <span className="micro faint">
          window {defaultFrom} → {defaultTo} · walk-forward · hold-out validation · no shuffling
        </span>
      </div>
      {msg && <span className={`micro ${state === 'error' ? 'neg' : 'pos'}`}>{msg}</span>}
    </div>
  );
}
