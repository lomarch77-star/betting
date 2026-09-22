'use client';

import { useState } from 'react';

export function RunDqButton() {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const submit = async () => {
    setState('busy');
    try {
      const res = await fetch('/api/data-quality', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      setState('done');
      setMsg(`Report #${json.data.reportId}: ${json.data.counts.valid} valid / ${json.data.counts.warning} warnings / ${json.data.counts.invalid} invalid`);
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      setState('error');
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button className="btn" onClick={submit} disabled={state === 'busy'}>
        {state === 'busy' ? 'Running checks…' : 'Re-run checks'}
      </button>
      {msg && <span className={`micro ${state === 'error' ? 'neg' : 'pos'}`}>{msg}</span>}
    </span>
  );
}
