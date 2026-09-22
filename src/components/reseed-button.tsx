'use client';

import { useState } from 'react';

export function ReseedButton() {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const submit = async () => {
    if (!window.confirm('Wipe and regenerate the deterministic demo universe? (demo data only)')) return;
    setState('busy');
    try {
      const res = await fetch('/api/admin/reseed', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      setState('done');
      setMsg(`Reseeded: ${json.data.seed.matches} matches, ${json.data.seed.oddsSnapshots} odds snapshots`);
    } catch (e) {
      setState('error');
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button className="btn" onClick={submit} disabled={state === 'busy'}>
        {state === 'busy' ? 'Reseeding…' : 'Reseed demo universe'}
      </button>
      {msg && <span className={`micro ${state === 'error' ? 'neg' : 'pos'}`}>{msg}</span>}
    </span>
  );
}
