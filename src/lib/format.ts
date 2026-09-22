/** Display formatting. Presentation only — no logic depends on these. */

export function fmtMoney(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const decimals = n >= 1000 ? 2 : n >= 1 ? 3 : n >= 0.01 ? 5 : 8;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtPct(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}

export function fmtSigned(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '-'}${fmtMoney(Math.abs(n), decimals)}`;
}

export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

export function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

export function fmtRatio(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === Infinity) return '∞';
  return n.toFixed(2);
}

export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('en-GB', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtAgo(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function tone(n: number): 'pos' | 'neg' | 'flat' {
  if (!Number.isFinite(n) || n === 0) return 'flat';
  return n > 0 ? 'pos' : 'neg';
}
