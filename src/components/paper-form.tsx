'use client';

import { useState } from 'react';

/** Add-to-paper-portfolio form (client). Guarded server-side against post-kickoff entries. */
export function PaperEntryForm({
  matchId,
  defaultSelection,
  defaultOdds,
  modelProb,
  market,
  line,
}: {
  matchId: number;
  defaultSelection: string;
  defaultOdds: number | null;
  modelProb: number;
  market: string;
  line: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [odds, setOdds] = useState(defaultOdds?.toFixed(2) ?? '');
  const [stake, setStake] = useState('1');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  if (!open) {
    return (
      <button className="btn small" onClick={() => setOpen(true)}>
        + Paper ledger
      </button>
    );
  }

  const submit = async () => {
    setState('busy');
    setMsg('');
    try {
      const res = await fetch('/api/paper-portfolio', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          matchId,
          market,
          line,
          selection: defaultSelection,
          odds: Number(odds),
          modelProbability: modelProb,
          stake: Number(stake),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      setState('done');
      setMsg(`Recorded entry #${json.data.id} — simulated ledger, no real money.`);
    } catch (e) {
      setState('error');
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <input
        type="number"
        step="0.01"
        min="1.01"
        value={odds}
        onChange={(e) => setOdds(e.target.value)}
        style={{ width: 76, minWidth: 76 }}
        aria-label="odds"
      />
      <input
        type="number"
        step="0.5"
        min="0.5"
        value={stake}
        onChange={(e) => setStake(e.target.value)}
        style={{ width: 60, minWidth: 60 }}
        aria-label="stake"
      />
      <button className="btn small primary" disabled={state === 'busy'} onClick={submit}>
        {state === 'busy' ? '…' : 'Log'}
      </button>
      <button className="btn small" onClick={() => setOpen(false)}>
        ×
      </button>
      {msg && (
        <span className={`micro ${state === 'error' ? 'neg' : 'pos'}`} style={{ maxWidth: 260 }}>
          {msg}
        </span>
      )}
    </span>
  );
}
