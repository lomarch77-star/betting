/**
 * Technical indicators.
 *
 * Every function returns an array the same length as the input, left-padded
 * with NaN for the warm-up region. That keeps indices aligned with the candle
 * array, so `rsi(close)[i]` is always the RSI of candle `i`.
 *
 * Smoothing follows the standard conventions: plain EMA for trend lines,
 * Wilder's smoothing for RSI and ATR.
 */

export const nan = (n: number): number[] => new Array<number>(n).fill(NaN);

export function sma(values: number[], period: number): number[] {
  if (period <= 0) return nan(values.length);
  const out = nan(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * values so it is unbiased at the start of a series.
 */
export function ema(values: number[], period: number): number[] {
  if (period <= 0) return nan(values.length);
  const out = nan(values.length);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/**
 * Relative Strength Index using Wilder's smoothing.
 * Returns exactly 100 when there is no downward movement in the window.
 */
export function rsi(values: number[], period = 14): number[] {
  const out = nan(values.length);
  if (values.length <= period || period <= 0) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = toRsi(gain, loss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi(gain, loss);
  }
  return out;
}

function toRsi(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

export function trueRange(high: number[], low: number[], close: number[]): number[] {
  const out = nan(high.length);
  for (let i = 0; i < high.length; i++) {
    if (i === 0) {
      out[i] = high[i] - low[i];
      continue;
    }
    const prev = close[i - 1];
    out[i] = Math.max(high[i] - low[i], Math.abs(high[i] - prev), Math.abs(low[i] - prev));
  }
  return out;
}

/** Average True Range, Wilder-smoothed. */
export function atr(high: number[], low: number[], close: number[], period = 14): number[] {
  const out = nan(high.length);
  if (high.length <= period || period <= 0) return out;
  const tr = trueRange(high, low, close);

  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  out[period] = seed / period;

  for (let i = period + 1; i < high.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => f[i] - s[i]);

  // Signal line is an EMA of the *defined* part of the MACD line. Computing it
  // over NaN-padded input would poison the whole series.
  const firstDefined = line.findIndex((v) => !Number.isNaN(v));
  const signal = nan(values.length);
  if (firstDefined >= 0) {
    const tail = line.slice(firstDefined);
    const sig = ema(tail, signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstDefined + i] = sig[i];
  }

  const histogram = line.map((v, i) =>
    Number.isNaN(v) || Number.isNaN(signal[i]) ? NaN : v - signal[i],
  );
  return { macd: line, signal, histogram };
}

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
}

export function bollinger(values: number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(values, period);
  const upper = nan(values.length);
  const lower = nan(values.length);
  const bandwidth = nan(values.length);

  for (let i = period - 1; i < values.length; i++) {
    const mean = middle[i];
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - mean) ** 2;
    const sd = Math.sqrt(acc / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
    bandwidth[i] = mean === 0 ? NaN : (upper[i] - lower[i]) / mean;
  }
  return { upper, middle, lower, bandwidth };
}

/** Linear-regression slope of the last `period` values, per bar. */
export function slope(values: number[], period = 20): number[] {
  const out = nan(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let j = 0; j < period; j++) {
      const x = j;
      const y = values[i - period + 1 + j];
      sx += x;
      sy += y;
      sxy += x * y;
      sxx += x * x;
    }
    const denom = period * sxx - sx * sx;
    out[i] = denom === 0 ? 0 : (period * sxy - sx * sy) / denom;
  }
  return out;
}

/** Annualised volatility from log returns, scaled by bars per year. */
export function annualisedVolatility(values: number[], barsPerYear: number): number {
  const rets: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0 && values[i] > 0) rets.push(Math.log(values[i] / values[i - 1]));
  }
  if (rets.length < 2) return NaN;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(barsPerYear);
}

/** Last non-NaN value in a series — handy for reading "current" indicator state. */
export function lastDefined(series: number[]): number {
  for (let i = series.length - 1; i >= 0; i--) {
    if (!Number.isNaN(series[i])) return series[i];
  }
  return NaN;
}

/** True only on the exact bar where `fast` crosses above `slow`. */
export function crossedAbove(fast: number[], slow: number[], i: number): boolean {
  if (i < 1) return false;
  const [f0, f1] = [fast[i - 1], fast[i]];
  const [s0, s1] = [slow[i - 1], slow[i]];
  if ([f0, f1, s0, s1].some(Number.isNaN)) return false;
  return f0 <= s0 && f1 > s1;
}

/** True only on the exact bar where `fast` crosses below `slow`. */
export function crossedBelow(fast: number[], slow: number[], i: number): boolean {
  if (i < 1) return false;
  const [f0, f1] = [fast[i - 1], fast[i]];
  const [s0, s1] = [slow[i - 1], slow[i]];
  if ([f0, f1, s0, s1].some(Number.isNaN)) return false;
  return f0 >= s0 && f1 < s1;
}
