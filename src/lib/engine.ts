/**
 * The execution half of the agent: applies decisions to a paper portfolio.
 *
 * Pure functions throughout — the portfolio goes in, a new portfolio comes
 * out. That is what makes the live engine and the backtester share exactly one
 * implementation of fills, fees and stops, so a backtest cannot drift from
 * live behaviour.
 */

import type { Order, Portfolio, Position, Trade, TradeExitReason } from './types';
import { roundToLot } from './strategy';

export interface Fill {
  portfolio: Portfolio;
  order: Order;
  position?: Position;
  trade?: Trade;
}

const now = () => Date.now();
let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Deterministic id, used by the backtester so replays are reproducible. */
export function makeUid(prefix: string, seed: number): string {
  return `${prefix}-${seed.toString(36)}`;
}

export interface FeeModel {
  feeBps: number;
  slippageBps: number;
}

/** Fill price after slippage — worse for the taker in both directions. */
export function applySlippage(price: number, side: 'buy' | 'sell', slippageBps: number): number {
  const s = slippageBps / 10_000;
  return side === 'buy' ? price * (1 + s) : price * (1 - s);
}

export function feeFor(notional: number, feeBps: number): number {
  return notional * (feeBps / 10_000);
}

export interface OpenArgs {
  marketId: string;
  price: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  time?: number;
  idSeed?: number;
}

export function openPosition(
  portfolio: Portfolio,
  args: OpenArgs,
  fees: FeeModel,
): Fill | { error: string } {
  const t = args.time ?? now();
  if (!(args.qty > 0)) return { error: 'Quantity must be positive.' };
  if (portfolio.positions[args.marketId]) {
    return { error: `Already holding a position in ${args.marketId}.` };
  }
  if (!(args.stopLoss < args.price)) {
    return { error: 'Stop loss must sit below the entry price.' };
  }

  const qty = roundToLot(args.qty, lotSizeFor(args.price));
  if (!(qty > 0)) return { error: 'Quantity rounds to zero at this price.' };

  const fillPrice = applySlippage(args.price, 'buy', fees.slippageBps);
  const notional = qty * fillPrice;
  const fee = feeFor(notional, fees.feeBps);
  const cost = notional + fee;

  if (cost > portfolio.cash + 1e-9) {
    return {
      error: `Insufficient cash: need ${cost.toFixed(2)}, have ${portfolio.cash.toFixed(2)}.`,
    };
  }

  const position: Position = {
    id: args.idSeed != null ? makeUid('pos', args.idSeed) : uid('pos'),
    marketId: args.marketId,
    side: 'long',
    qty,
    entryPrice: fillPrice,
    entryTime: t,
    stopLoss: args.stopLoss,
    takeProfit: args.takeProfit,
    highWaterMark: fillPrice,
    strategy: 'ema-atr',
  };

  const order: Order = {
    id: args.idSeed != null ? makeUid('ord', args.idSeed) : uid('ord'),
    marketId: args.marketId,
    side: 'buy',
    qty,
    price: fillPrice,
    fee,
    slippage: Math.abs(fillPrice - args.price) * qty,
    time: t,
    status: 'filled',
  };

  return {
    portfolio: {
      ...portfolio,
      cash: portfolio.cash - cost,
      positions: { ...portfolio.positions, [args.marketId]: position },
    },
    order,
    position,
  };
}

export interface CloseArgs {
  marketId: string;
  price: number;
  reason: TradeExitReason;
  time?: number;
  /** Bar index of entry, for `barsHeld` in a backtest. Optional. */
  barsHeld?: number;
  idSeed?: number;
}

export function closePosition(
  portfolio: Portfolio,
  args: CloseArgs,
  fees: FeeModel,
): Fill | { error: string } {
  const position = portfolio.positions[args.marketId];
  if (!position) return { error: `No open position in ${args.marketId}.` };

  const t = args.time ?? now();
  const fillPrice = applySlippage(args.price, 'sell', fees.slippageBps);
  const notional = position.qty * fillPrice;
  const fee = feeFor(notional, fees.feeBps);
  const proceeds = notional - fee;

  const entryNotional = position.qty * position.entryPrice;
  const entryFee = feeFor(entryNotional, fees.feeBps);
  const pnl = proceeds - (entryNotional + entryFee);

  const trade: Trade = {
    id: args.idSeed != null ? makeUid('trd', args.idSeed) : uid('trd'),
    marketId: args.marketId,
    side: position.side,
    qty: position.qty,
    entryPrice: position.entryPrice,
    entryTime: position.entryTime,
    exitPrice: fillPrice,
    exitTime: t,
    exitReason: args.reason,
    pnl,
    pnlPct: entryNotional === 0 ? 0 : (pnl / entryNotional) * 100,
    barsHeld: args.barsHeld ?? 0,
  };

  const order: Order = {
    id: args.idSeed != null ? makeUid('ord', args.idSeed) : uid('ord'),
    marketId: args.marketId,
    side: 'sell',
    qty: position.qty,
    price: fillPrice,
    fee,
    slippage: Math.abs(args.price - fillPrice) * position.qty,
    time: t,
    status: 'filled',
  };

  const positions = { ...portfolio.positions };
  delete positions[args.marketId];

  return {
    portfolio: {
      ...portfolio,
      cash: portfolio.cash + proceeds,
      positions,
      trades: [...portfolio.trades, trade],
    },
    order,
    trade,
  };
}

/** Marks every open position to market. */
export function equityOf(portfolio: Portfolio, prices: Record<string, number>): number {
  let value = portfolio.cash;
  for (const p of Object.values(portfolio.positions)) {
    const px = prices[p.marketId];
    value += p.qty * (px ?? p.entryPrice);
  }
  return value;
}

/** Unrealised P&L of a single position, net of the exit fee it would cost. */
export function unrealisedPnl(
  position: Position,
  price: number,
  feeBps: number,
  slippageBps: number,
): number {
  const fill = applySlippage(price, 'sell', slippageBps);
  const proceeds = position.qty * fill - feeFor(position.qty * fill, feeBps);
  const cost =
    position.qty * position.entryPrice + feeFor(position.qty * position.entryPrice, feeBps);
  return proceeds - cost;
}

/**
 * Tests a position's bracket against a candle's range.
 *
 * Stop is checked before target: within a single bar we cannot know the order
 * prices were touched, so the pessimistic assumption is the honest one. Levels
 * are read straight off the position, so trailing is already reflected by the
 * time this runs.
 */
export function checkExits(
  position: Position,
  candle: { h: number; l: number },
): { exit: TradeExitReason; price: number } | null {
  if (candle.l <= position.stopLoss) return { exit: 'stop_loss', price: position.stopLoss };
  if (position.takeProfit > 0 && candle.h >= position.takeProfit) {
    return { exit: 'take_profit', price: position.takeProfit };
  }
  return null;
}

/**
 * Advances the high-water mark and ratchets the trailing stop.
 * A trailing stop only ever moves up, never down.
 */
export function updateTrail(
  position: Position,
  candle: { h: number },
  atrValue: number,
  atrStopMultiple: number,
): { highWaterMark: number; stopLoss: number } {
  const highWaterMark = Math.max(position.highWaterMark, candle.h);
  const trailed = highWaterMark - atrValue * atrStopMultiple;
  const stopLoss = Number.isFinite(trailed)
    ? Math.max(position.stopLoss, trailed)
    : position.stopLoss;
  return { highWaterMark, stopLoss };
}

/**
 * Applies one bar to an open position.
 *
 * The high-water mark is always tracked (it is what the UI shows as "best
 * price since entry"), but the stop only moves when the strategy actually asks
 * for a trailing stop. Gating that here rather than at each call site keeps the
 * live agent and the backtester from disagreeing about when the stop tightens.
 */
export function advancePosition(
  position: Position,
  candle: { h: number },
  atrValue: number,
  opts: { useTrailingStop: boolean; atrStopMultiple: number },
): Position {
  if (!opts.useTrailingStop) {
    return { ...position, highWaterMark: Math.max(position.highWaterMark, candle.h) };
  }
  const { highWaterMark, stopLoss } = updateTrail(position, candle, atrValue, opts.atrStopMultiple);
  return { ...position, highWaterMark, stopLoss };
}

export function lotSizeFor(price: number): number {
  // Mirrors typical exchange lot granularity: coarser for cheap assets.
  if (price >= 1000) return 1e-5;
  if (price >= 100) return 1e-4;
  if (price >= 1) return 1e-3;
  return 1e-2;
}

export function winStats(trades: Trade[]): {
  wins: number;
  losses: number;
  winRatePct: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  avgBarsHeld: number;
} {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    grossProfit,
    grossLoss,
    avgBarsHeld: trades.length ? trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length : 0,
  };
}

export function maxDrawdownPct(curve: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of curve) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst * 100;
}

/** Sharpe on per-bar returns, annualised by bars-per-year. Risk-free = 0. */
export function sharpeRatio(curve: number[], barsPerYear: number): number {
  const rets: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    if (curve[i - 1] > 0) rets.push(curve[i] / curve[i - 1] - 1);
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  return sd === 0 ? 0 : (mean / sd) * Math.sqrt(barsPerYear);
}
