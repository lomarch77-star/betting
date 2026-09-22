/**
 * Charts, hand-rolled as SVG.
 *
 * A charting library would be a large dependency in a bundle that has to load
 * and run on a mid-range phone with no network. These are ~100 lines each, scale
 * to their container, and never animate, so they stay cheap on a busy loop.
 */

import { useId } from 'react';
import type { Candle } from '../lib/types';

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  tone?: 'pos' | 'neg' | 'flat';
}

export function Sparkline({ values, width = 72, height = 28, tone }: SparklineProps) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden="true" />;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);

  const points = values
    .map((v, i) => `${(i * stepX).toFixed(2)},${(height - ((v - min) / span) * height).toFixed(2)}`)
    .join(' ');

  const dir = tone ?? (values[values.length - 1] >= values[0] ? 'pos' : 'neg');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={`var(--${dir})`}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface EquityChartProps {
  points: { t: number; equity: number }[];
  height?: number;
}

export function EquityChart({ points, height = 160 }: EquityChartProps) {
  const gradientId = useId();
  if (points.length < 2) {
    return (
      <div className="chart-empty" style={{ height }}>
        Not enough history yet — the curve appears once the agent has ticked a few times.
      </div>
    );
  }

  const width = 320;
  const values = points.map((p) => p.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(max * 0.01, 1);
  const pad = 6;

  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

  const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.equity).toFixed(2)}`).join(' ');
  const area = `${x(0).toFixed(2)},${height} ${line} ${x(points.length - 1).toFixed(2)},${height}`;
  const up = values[values.length - 1] >= values[0];

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      role="img"
      aria-label={`Equity curve, ${up ? 'up' : 'down'} from ${values[0].toFixed(2)} to ${values[values.length - 1].toFixed(2)}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`var(--${up ? 'pos' : 'neg'})`} stopOpacity="0.35" />
          <stop offset="100%" stopColor={`var(--${up ? 'pos' : 'neg'})`} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline
        points={line}
        fill="none"
        stroke={`var(--${up ? 'pos' : 'neg'})`}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface PriceChartProps {
  candles: Candle[];
  height?: number;
  /** Price levels to draw on top of the candles. */
  markers?: { price: number; label: string; tone: 'pos' | 'neg' }[];
  /** Timestamps to highlight as trades. */
  tradeMarkers?: { t: number; kind: 'entry' | 'exit' }[];
}

export function PriceChart({
  candles,
  height = 190,
  markers = [],
  tradeMarkers = [],
}: PriceChartProps) {
  if (candles.length < 2) {
    return (
      <div className="chart-empty" style={{ height }}>
        Waiting for candle data…
      </div>
    );
  }

  const width = 320;
  const shown = candles.slice(-140);
  const lows = shown.map((c) => c.l);
  const highs = shown.map((c) => c.h);
  const markerPrices = markers.map((m) => m.price).filter(Number.isFinite);
  const min = Math.min(...lows, ...markerPrices);
  const max = Math.max(...highs, ...markerPrices);
  const span = max - min || 1;
  const pad = 8;

  const x = (i: number) => (i / (shown.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

  const candleWidth = Math.max(width / shown.length - 1, 1.2);

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      role="img"
      aria-label="Recent price candles"
    >
      {shown.map((c, i) => {
        const rising = c.c >= c.o;
        const colour = rising ? 'var(--pos)' : 'var(--neg)';
        const top = y(Math.max(c.o, c.c));
        const bottom = y(Math.min(c.o, c.c));
        return (
          <g key={c.t}>
            <line
              x1={x(i)}
              x2={x(i)}
              y1={y(c.h)}
              y2={y(c.l)}
              stroke={colour}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              opacity="0.7"
            />
            <rect
              x={x(i) - candleWidth / 2}
              y={top}
              width={candleWidth}
              height={Math.max(bottom - top, 0.8)}
              fill={colour}
              opacity="0.9"
            />
          </g>
        );
      })}

      {markers
        .filter((m) => Number.isFinite(m.price))
        .map((m) => (
          <g key={m.label}>
            <line
              x1="0"
              x2={width}
              y1={y(m.price)}
              y2={y(m.price)}
              stroke={`var(--${m.tone})`}
              strokeWidth="1"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
              opacity="0.85"
            />
            <text x="4" y={y(m.price) - 3} className="chart-label" fill={`var(--${m.tone})`}>
              {m.label}
            </text>
          </g>
        ))}

      {tradeMarkers.map((m, i) => {
        const idx = shown.findIndex((c) => c.t >= m.t);
        if (idx < 0) return null;
        return (
          <circle
            key={`${m.t}-${i}`}
            cx={x(idx)}
            cy={y(shown[idx].c)}
            r="3"
            fill={m.kind === 'entry' ? 'var(--accent)' : 'var(--muted)'}
            stroke="var(--bg)"
            strokeWidth="1"
          />
        );
      })}
    </svg>
  );
}

/** A tiny bar strip used for the trade-history P&L distribution. */
export function PnlBars({ trades, height = 44 }: { trades: { pnl: number }[]; height?: number }) {
  if (trades.length === 0)
    return (
      <div className="chart-empty" style={{ height }}>
        No trades yet.
      </div>
    );
  const shown = trades.slice(-40);
  const max = Math.max(...shown.map((t) => Math.abs(t.pnl)), 1);
  const width = 320;
  const barWidth = width / shown.length;

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
    >
      <line
        x1="0"
        x2={width}
        y1={height / 2}
        y2={height / 2}
        stroke="var(--line)"
        strokeWidth="1"
      />
      {shown.map((t, i) => {
        const h = (Math.abs(t.pnl) / max) * (height / 2 - 2);
        const rising = t.pnl >= 0;
        return (
          <rect
            key={i}
            x={i * barWidth + barWidth * 0.15}
            y={rising ? height / 2 - h : height / 2}
            width={barWidth * 0.7}
            height={Math.max(h, 1)}
            fill={rising ? 'var(--pos)' : 'var(--neg)'}
            opacity="0.9"
          />
        );
      })}
    </svg>
  );
}
