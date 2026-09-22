/**
 * The agent loop.
 *
 * `stepAgent` is a pure function: snapshot + market data in, new snapshot out.
 * That makes the whole live agent testable without timers or network, and it is
 * the same `evaluate`/`openPosition`/`closePosition` path the backtester uses.
 *
 * The perception -> reasoning -> action -> record cycle:
 *   perceive  candles + tickers for the watchlist
 *   reason    `evaluate()` produces a decision and its rule trace
 *   act       risk gates, then sizing and a fill
 *   record    an AgentEvent with the trace, persisted for the audit log
 */

import type {
  AgentEvent,
  Candle,
  Decision,
  Order,
  Portfolio,
  RiskConfig,
  StrategyConfig,
  Ticker,
  Timeframe,
} from './types';
import { emptyPortfolio } from './types';
import { evaluate, positionSize } from './strategy';
import {
  checkExits,
  closePosition,
  equityOf,
  openPosition,
  unrealisedPnl,
  advancePosition,
} from './engine';
import { TIMEFRAME_MS } from './types';

export interface AgentSnapshot {
  portfolio: Portfolio;
  risk: RiskConfig;
  strategy: StrategyConfig;
  timeframe: Timeframe;
  running: boolean;
  halted: boolean;
  haltReason?: string;
  /** marketId -> epoch ms of the most recent exit, for the cooldown rule. */
  lastExitAt: Record<string, number>;
  equityCurve: { t: number; equity: number }[];
  events: AgentEvent[];
  decisions: Record<string, Decision>;
  lastTickAt?: number;
  source?: string;
}

export interface StepInput {
  candlesByMarket: Record<string, Candle[]>;
  tickersByMarket: Record<string, Ticker>;
  now?: number;
}

export interface StepResult {
  snapshot: AgentSnapshot;
  orders: Order[];
}

export const MAX_EVENTS = 200;

export function createSnapshot(
  risk: RiskConfig,
  strategy: StrategyConfig,
  timeframe: Timeframe,
): AgentSnapshot {
  return {
    portfolio: emptyPortfolio(risk.startingCash),
    risk,
    strategy,
    timeframe,
    running: false,
    halted: false,
    lastExitAt: {},
    equityCurve: [],
    events: [],
    decisions: {},
  };
}

let eventSeq = 0;
function event(e: Omit<AgentEvent, 'id' | 'at'>, at: number): AgentEvent {
  return { id: `ev-${at.toString(36)}-${(eventSeq++).toString(36)}`, at, ...e };
}

function pushEvents(events: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  return [...events, ...incoming].slice(-MAX_EVENTS);
}

/** Bars elapsed between the last exit and the last closed candle. */
function barsSinceExit(
  candles: Candle[],
  exitAt: number | undefined,
  timeframe: Timeframe,
): number {
  if (!exitAt || candles.length === 0) return Infinity;
  const step = TIMEFRAME_MS[timeframe];
  const lastClosed = candles[candles.length - 1].t;
  return Math.max(0, Math.floor((lastClosed - exitAt) / step));
}

export function stepAgent(snapshot: AgentSnapshot, input: StepInput): StepResult {
  const now = input.now ?? Date.now();
  const { risk, strategy, timeframe } = snapshot;
  const fees = { feeBps: risk.feeBps, slippageBps: risk.slippageBps };

  let portfolio: Portfolio = snapshot.portfolio;
  let lastExitAt = { ...snapshot.lastExitAt };
  let halted = snapshot.halted;
  let haltReason = snapshot.haltReason;
  const orders: Order[] = [];
  const events: AgentEvent[] = [];
  const decisions: Record<string, Decision> = { ...snapshot.decisions };

  // ---- Perceive -------------------------------------------------------
  const prices: Record<string, number> = {};
  for (const [id, t] of Object.entries(input.tickersByMarket)) {
    if (Number.isFinite(t.price) && t.price > 0) prices[id] = t.price;
  }
  for (const [id, candles] of Object.entries(input.candlesByMarket)) {
    if (!prices[id] && candles.length) prices[id] = candles[candles.length - 1].c;
  }

  // ---- Risk gates -----------------------------------------------------
  const equity = equityOf(portfolio, prices);
  const peak = Math.max(snapshot.portfolio.equityHighWaterMark, equity);

  if (!halted) {
    const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (drawdownPct >= risk.maxDrawdownPct) {
      halted = true;
      haltReason = `Drawdown ${drawdownPct.toFixed(1)}% hit the ${risk.maxDrawdownPct}% limit.`;
      events.push(event({ kind: 'halt', message: haltReason }, now));
    } else {
      const dayAgo = equityAt(snapshot.equityCurve, now - 86_400_000) ?? equity;
      if (dayAgo > 0) {
        const dayLossPct = ((dayAgo - equity) / dayAgo) * 100;
        if (dayLossPct >= risk.maxDailyLossPct) {
          halted = true;
          haltReason = `24h loss ${dayLossPct.toFixed(1)}% hit the ${risk.maxDailyLossPct}% limit.`;
          events.push(event({ kind: 'halt', message: haltReason }, now));
        }
      }
    }
  }

  // A halt flattens everything: a stopped agent holding risk is the worst state.
  if (halted) {
    for (const marketId of Object.keys(portfolio.positions)) {
      const px = prices[marketId];
      if (!px) continue;
      const result = closePosition(
        portfolio,
        { marketId, price: px, reason: 'risk_halt', time: now },
        fees,
      );
      if ('error' in result) continue;
      portfolio = result.portfolio;
      orders.push(result.order);
      lastExitAt[marketId] = now;
      events.push(
        event(
          {
            kind: 'order',
            marketId,
            message: `Flattened ${marketId} at ${px.toFixed(2)} — agent halted.`,
            action: 'CLOSE',
          },
          now,
        ),
      );
    }
  }

  // ---- Reason & act ---------------------------------------------------
  //
  // Evaluation always runs, even while stopped, so the Agent screen can show
  // what the rules say right now. Only the *acting* half is gated on `running`,
  // which makes the stopped state a genuine dry run: you can watch the agent
  // decide for as long as you like before letting it place a single order.
  const acting = !halted && snapshot.running;

  for (const [marketId, candles] of Object.entries(input.candlesByMarket)) {
    if (candles.length < 3) continue;
    const closed = candles.slice(0, -1);
    if (closed.length < 3) continue;

    const position = portfolio.positions[marketId];
    const lastCandle = closed[closed.length - 1];
    const price = prices[marketId] ?? lastCandle.c;

    // Bracket and trailing stop first — risk always outranks a new signal.
    if (position && acting) {
      const updated = advancePosition(position, lastCandle, atrNow(candles, strategy.atrPeriod), {
        useTrailingStop: strategy.useTrailingStop,
        atrStopMultiple: strategy.atrStopMultiple,
      });
      portfolio = { ...portfolio, positions: { ...portfolio.positions, [marketId]: updated } };

      const exit = checkExits(updated, lastCandle);
      if (exit) {
        const result = closePosition(
          portfolio,
          { marketId, price: exit.price, reason: exit.exit, time: lastCandle.t },
          fees,
        );
        if (!('error' in result)) {
          portfolio = result.portfolio;
          orders.push(result.order);
          lastExitAt[marketId] = lastCandle.t;
          events.push(
            event(
              {
                kind: 'order',
                marketId,
                message: `${label(exit.exit)} filled at ${exit.price.toFixed(2)} (${
                  result.trade!.pnl >= 0 ? '+' : ''
                }${result.trade!.pnl.toFixed(2)}).`,
                action: 'CLOSE',
              },
              lastCandle.t,
            ),
          );
        }
      }
    }

    const hasPosition = Boolean(portfolio.positions[marketId]);
    const decision = evaluate(candles, strategy, {
      index: candles.length - 2,
      hasOpenPosition: hasPosition,
      barsSinceExit: barsSinceExit(closed, lastExitAt[marketId], timeframe),
    });
    decisions[marketId] = decision;

    // Everything below places orders, so a stopped agent stops here.
    if (!acting) continue;

    if (decision.action === 'CLOSE' && hasPosition) {
      const result = closePosition(
        portfolio,
        { marketId, price, reason: 'signal', time: now },
        fees,
      );
      if (!('error' in result)) {
        portfolio = result.portfolio;
        orders.push(result.order);
        lastExitAt[marketId] = now;
        events.push(
          event(
            {
              kind: 'order',
              marketId,
              message: `${decision.reason}`,
              action: 'CLOSE',
              score: decision.score,
              checks: decision.checks,
            },
            now,
          ),
        );
      }
    } else if (decision.action === 'OPEN_LONG' && !hasPosition) {
      const openCount = Object.keys(portfolio.positions).length;
      if (openCount >= risk.maxOpenPositions) {
        events.push(
          event(
            {
              kind: 'tick',
              marketId,
              message: `Entry blocked: ${openCount}/${risk.maxOpenPositions} position slots used.`,
              action: 'HOLD',
              checks: decision.checks,
            },
            now,
          ),
        );
        continue;
      }

      const equityNow = equityOf(portfolio, prices);
      const stopLoss = decision.stopLoss ?? price * 0.98;
      const size = positionSize({
        equity: equityNow,
        price,
        stopLoss,
        riskPct: strategy.riskPerTradePct,
        maxPositionPct: strategy.maxPositionPct,
        availableCash: portfolio.cash,
        feeBps: risk.feeBps,
      });

      if (size.qty <= 0) {
        events.push(
          event(
            {
              kind: 'tick',
              marketId,
              message: `Entry sized to zero (capped by ${size.cappedBy}).`,
              action: 'HOLD',
              checks: decision.checks,
            },
            now,
          ),
        );
        continue;
      }

      const result = openPosition(
        portfolio,
        {
          marketId,
          price,
          qty: size.qty,
          stopLoss,
          takeProfit: decision.takeProfit ?? price * 1.05,
          time: now,
        },
        fees,
      );
      if ('error' in result) {
        events.push(
          event({ kind: 'error', marketId, message: `Order rejected: ${result.error}` }, now),
        );
      } else {
        portfolio = result.portfolio;
        orders.push(result.order);
        events.push(
          event(
            {
              kind: 'order',
              marketId,
              message: `Opened ${result.position!.qty.toFixed(6)} ${marketId} at ${price.toFixed(
                2,
              )} (stop ${stopLoss.toFixed(2)}, risk ${size.riskAmount.toFixed(
                2,
              )}, capped by ${size.cappedBy}).`,
              action: 'OPEN_LONG',
              score: decision.score,
              checks: decision.checks,
            },
            now,
          ),
        );
      }
    }
  }

  const finalEquity = equityOf(portfolio, prices);
  const equityCurve = appendPoint(snapshot.equityCurve, now, finalEquity);

  return {
    snapshot: {
      ...snapshot,
      portfolio: { ...portfolio, equityHighWaterMark: Math.max(peak, finalEquity) },
      lastExitAt,
      halted,
      haltReason,
      decisions,
      equityCurve,
      events: pushEvents(snapshot.events, events),
      lastTickAt: now,
      source: Object.values(input.tickersByMarket)[0]?.source,
    },
    orders,
  };
}

function label(reason: string): string {
  return reason.replace(/_/g, ' ');
}

/** Simple ATR over the trailing window — enough for the trailing stop. */
function atrNow(candles: Candle[], period: number): number {
  const i = candles.length - 1;
  if (i < period) return NaN;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const prev = candles[j - 1];
    const cur = candles[j];
    sum += Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
  }
  return sum / period;
}

/** Equity at or before `t`, from the sampled curve. */
export function equityAt(curve: { t: number; equity: number }[], t: number): number | null {
  let found: number | null = null;
  for (const p of curve) {
    if (p.t <= t) found = p.equity;
    else break;
  }
  return found;
}

/** Keeps one point per minute at most, capped at 2000 points. */
function appendPoint(
  curve: { t: number; equity: number }[],
  t: number,
  equity: number,
): { t: number; equity: number }[] {
  const last = curve[curve.length - 1];
  if (last && t - last.t < 60_000) {
    return [...curve.slice(0, -1), { t: last.t, equity }];
  }
  return [...curve, { t, equity }].slice(-2000);
}

/* ------------------------------- helpers ------------------------------- */

export interface PositionView {
  marketId: string;
  qty: number;
  entryPrice: number;
  price: number;
  value: number;
  pnl: number;
  pnlPct: number;
  stopLoss: number;
  takeProfit: number;
  since: number;
}

export function positionViews(
  portfolio: Portfolio,
  prices: Record<string, number>,
  risk: RiskConfig,
): PositionView[] {
  return Object.values(portfolio.positions).map((p) => {
    const price = prices[p.marketId] ?? p.entryPrice;
    const value = p.qty * price;
    const pnl = unrealisedPnl(p, price, risk.feeBps, risk.slippageBps);
    const cost = p.qty * p.entryPrice;
    return {
      marketId: p.marketId,
      qty: p.qty,
      entryPrice: p.entryPrice,
      price,
      value,
      pnl,
      pnlPct: cost > 0 ? (pnl / cost) * 100 : 0,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      since: p.entryTime,
    };
  });
}
