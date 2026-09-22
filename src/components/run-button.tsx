'use client';

import { useState, useEffect, useRef } from 'react';

/** "Run default backtest" button (client). */
export function RunBacktestButton({ label = 'Run default backtest' }: { label?: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const submit = async () => {
    setState('busy');
    try {
      const res = await fetch('/api/backtests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (res.status === 400 && /body/i.test(json?.error?.code ?? '')) {
        // empty body rejected → send null-body default path
        const res2 = await fetch('/api/backtests', { method: 'POST', headers: { 'content-type': 'application/json' } });
        const json2 = await res2.json();
        if (!res2.ok) throw new Error(json2?.error?.message ?? `HTTP ${res2.status}`);
        setState('done');
        setMsg(`Run #${json2.data.runId} started in background`);
        return;
      }
      if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      setState('done');
      setMsg(`Run #${json.data.runId} started in background`);
    } catch (e) {
      setState('error');
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button className="btn primary" onClick={submit} disabled={state === 'busy'}>
        {state === 'busy' ? 'Starting…' : label}
      </button>
      {msg && <span className={`micro ${state === 'error' ? 'neg' : 'pos'}`}>{msg}</span>}
    </span>
  );
}

/** Polls backtest progress while the run is RUNNING; reloads on completion. */
export function RunProgressPoll({ runId, status }: { runId: number; status: string }) {
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null);
  const reloaded = useRef(false);
  useEffect(() => {
    if (status !== 'RUNNING') return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/backtests/${runId}`);
        const json = await res.json();
        const d = json?.data;
        if (d?.progress) setProgress(d.progress);
        if (d?.status && d.status !== 'RUNNING' && !reloaded.current) {
          reloaded.current = true;
          window.location.reload();
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
    return () => clearInterval(t);
  }, [runId, status]);
  if (status !== 'RUNNING') return null;
  return (
    <div className="notice info pulsing" style={{ marginTop: 10 }}>
      RUNNING — {progress ? `${progress.phase} · ${progress.done}/${progress.total}` : 'initialising'} · auto-refreshes on completion
    </div>
  );
}
