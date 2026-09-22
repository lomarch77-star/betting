/** Shared formatting helpers — pure, no framework. */

export function fmtPct(p: number | null | undefined, digits = 1): string {
  if (p == null || Number.isNaN(p)) return '—';
  return `${(p * 100).toFixed(digits)}%`;
}

export function fmtOdds(o: number | null | undefined, digits = 2): string {
  if (o == null || !Number.isFinite(o)) return '—';
  return o.toFixed(digits);
}

export function fmtSignedPct(x: number | null | undefined, digits = 1): string {
  if (x == null || Number.isNaN(x)) return '—';
  const v = x * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function fmtNum(x: number | null | undefined, digits = 2): string {
  if (x == null || Number.isNaN(x)) return '—';
  return x.toFixed(digits);
}

export function fmtInt(x: number | null | undefined): string {
  if (x == null || Number.isNaN(x)) return '—';
  return x.toLocaleString('en-US');
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${iso.slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export function fmtKickoffDay(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return {
    day: `${days[d.getUTCDay()]} ${iso.slice(0, 10)}`,
    time: `${iso.slice(11, 16)} UTC`,
  };
}

export function pctClass(x: number | null | undefined, invert = false): string {
  if (x == null || Number.isNaN(x)) return '';
  const pos = invert ? x < 0 : x > 0;
  return pos ? 'pos' : 'neg';
}
