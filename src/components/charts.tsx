/**
 * Hand-rolled SVG charts — deterministic, server-rendered, zero client JS.
 */

interface Pt {
  at: string;
  value: number;
}

const AX = '#1f2937';
const TXT = '#5d6c80';

function scalePath(series: Pt[], w: number, h: number, pad: number) {
  const xs = series.map((_, i) => i);
  const vs = series.map((p) => p.value);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (xs[i] / Math.max(1, xs.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - lo) / span) * (h - 2 * pad);
  return { x, y, lo, hi };
}

export function BankrollChart({ series, initial }: { series: Pt[]; initial: number }) {
  if (series.length < 2) return <div className="muted-box">No bankroll data.</div>;
  const w = 760;
  const h = 230;
  const pad = 26;
  const { x, y, lo, hi } = scalePath(series, w, h, pad);
  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(series.length - 1).toFixed(1)},${y(lo)} L${x(0).toFixed(1)},${y(lo)} Z`;
  const y0 = lo <= initial && hi >= initial ? y(initial) : null;
  const ticks = 4;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="bankroll curve">
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const v = lo + ((hi - lo) * i) / ticks;
        return (
          <g key={i}>
            <line x1={pad} x2={w - pad} y1={y(v)} y2={y(v)} stroke={AX} strokeWidth={0.5} />
            <text x={w - pad + 6} y={y(v) + 3} fontSize={9} fill={TXT} fontFamily="ui-monospace,monospace">
              {v.toFixed(1)}
            </text>
          </g>
        );
      })}
      {y0 != null && <line x1={pad} x2={w - pad} y1={y0} y2={y0} stroke="#3a4a5d" strokeDasharray="4 3" strokeWidth={0.8} />}
      <path d={area} fill="rgba(79,195,184,0.07)" />
      <path d={line} fill="none" stroke="#4fc3b8" strokeWidth={1.6} strokeLinejoin="round" />
      <text x={pad} y={14} fontSize={9.5} fill={TXT} fontFamily="ui-monospace,monospace">
        BANKROLL · start {initial.toFixed(0)} → {series[series.length - 1].value.toFixed(1)}
      </text>
    </svg>
  );
}

export function CalibrationCurve({
  bins,
  labels,
}: {
  bins: Array<{ count: number; meanPredicted: number; empirical: number }>;
  labels?: string;
}) {
  const w = 300;
  const h = 230;
  const pad = 26;
  const minS = 0.18;
  const maxS = 0.8;
  const sx = (v: number) => pad + ((v - minS) / (maxS - minS)) * (w - 2 * pad);
  const sy = (v: number) => h - pad - ((v - minS) / (maxS - minS)) * (h - 2 * pad);
  const pts = bins
    .filter((b) => b.count > 5)
    .map((b) => ({ x: sx(b.meanPredicted), y: sy(b.empirical), n: b.count }));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="calibration curve">
      <line x1={sx(minS)} y1={sy(minS)} x2={sx(maxS)} y2={sy(maxS)} stroke="#3a4a5d" strokeDasharray="4 3" strokeWidth={0.9} />
      {[0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((t) => (
        <g key={t}>
          <line x1={sx(t)} x2={sx(t)} y1={sy(minS)} y2={sy(maxS)} stroke={AX} strokeWidth={0.4} />
          <line x1={sx(minS)} x2={sx(maxS)} y1={sy(t)} y2={sy(t)} stroke={AX} strokeWidth={0.4} />
          <text x={sx(t)} y={h - 8} fontSize={8.5} fill={TXT} textAnchor="middle" fontFamily="ui-monospace,monospace">
            {t.toFixed(1)}
          </text>
        </g>
      ))}
      {pts.length > 1 && (
        <path
          d={pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
          fill="none"
          stroke="#4fc3b8"
          strokeWidth={1.7}
        />
      )}
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={Math.min(6, 1.8 + Math.sqrt(p.n) / 6)} fill="#0a0e13" stroke="#4fc3b8" strokeWidth={1.4} />
      ))}
      <text x={pad} y={14} fontSize={9.5} fill={TXT} fontFamily="ui-monospace,monospace">
        CALIBRATION{labels ? ` · ${labels}` : ''} · predicted vs empirical
      </text>
    </svg>
  );
}

export function ScoreHeatmap({
  matrix,
  maxShown = 7,
}: {
  matrix: number[][];
  maxShown?: number;
}) {
  const cap = Math.min(maxShown, matrix.length - 1);
  let maxP = 0;
  for (let h = 0; h <= cap; h++) for (let a = 0; a <= cap; a++) maxP = Math.max(maxP, matrix[h][a]);
  return (
    <div className="score-grid" style={{ gridTemplateColumns: `auto repeat(${cap + 1}, 1fr)` }}>
      <div className="score-cell score-axis">H\A</div>
      {Array.from({ length: cap + 1 }, (_, a) => (
        <div key={`a${a}`} className="score-cell score-axis">
          {a}
        </div>
      ))}
      {Array.from({ length: cap + 1 }, (_, h) => (
        <>
          <div key={`h${h}`} className="score-cell score-axis">
            {h}
          </div>
          {Array.from({ length: cap + 1 }, (_, a) => {
            const p = matrix[h][a];
            const t = maxP > 0 ? p / maxP : 0;
            return (
              <div
                key={`${h}-${a}`}
                className="score-cell"
                title={`${h}-${a}: ${(p * 100).toFixed(1)}%`}
                style={{
                  background: `rgba(79,195,184,${(0.04 + t * 0.55).toFixed(3)})`,
                  color: t > 0.42 ? '#dff7f4' : undefined,
                }}
              >
                {(p * 100).toFixed(1)}
              </div>
            );
          })}
        </>
      ))}
    </div>
  );
}

export function MovementChart({
  points,
  books,
}: {
  points: Array<{ takenAt: string; book: string; implied: number[] }>;
  books: string[];
}) {
  if (points.length < 2) return <div className="muted-box">Insufficient price history.</div>;
  const w = 340;
  const h = 150;
  const pad = 24;
  const times = [...new Set(points.map((p) => p.takenAt))].sort();
  const vs = points.flatMap((p) => p.implied);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const span = hi - lo || 0.01;
  const x = (t: string) => pad + (times.indexOf(t) / Math.max(1, times.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - lo) / span) * (h - 2 * pad);
  const colors = ['#4fc3b8', '#d9a441', '#6b9dd1'];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="price movement">
      <text x={pad} y={13} fontSize={9} fill={TXT} fontFamily="ui-monospace,monospace">
        1X2 implied prob (margin-removed) · home
      </text>
      {books.map((b, bi) => {
        const pts = points.filter((p) => p.book === b);
        if (pts.length < 2) return null;
        return (
          <path
            key={b}
            d={pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.takenAt).toFixed(1)},${y(p.implied[0]).toFixed(1)}`).join(' ')}
            fill="none"
            stroke={colors[bi % colors.length]}
            strokeWidth={1.4}
          />
        );
      })}
      {books.map((b, i) => (
        <text key={b} x={pad + i * 80} y={h - 6} fontSize={8.5} fill={colors[i % colors.length]} fontFamily="ui-monospace,monospace">
          ● {b}
        </text>
      ))}
    </svg>
  );
}

export function Sparkline({ values, tone = '#4fc3b8' }: { values: number[]; tone?: string }) {
  if (values.length < 2) return null;
  const w = 90;
  const h = 24;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - lo) / span) * (h - 6)).toFixed(1)}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h}>
      <polyline points={pts} fill="none" stroke={tone} strokeWidth={1.4} />
    </svg>
  );
}
