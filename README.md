# PaperDesk

A local-first **crypto paper-trading agent** that runs on your phone as an installable web app.

It watches a crypto watchlist, applies a deterministic rule-based strategy, sizes positions against a
stop, and trades a simulated portfolio — entirely inside your browser tab. No server, no account, no
API keys, and no real orders. The only network traffic is public price data.

```
npm install
npm run dev          # http://localhost:5173
```

Open it on your phone on the same network, then use **Add to Home Screen** to install it.

---

## What it does

| Screen     | Purpose                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| **Desk**   | Equity, open positions, watchlist sparklines, start/stop the agent        |
| **Agent**  | The live rule-by-rule explanation of the current decision + activity log  |
| **Book**   | Performance stats, trade history, manual close, reset                    |
| **Test**   | Backtest the current strategy over history with the same engine          |
| **Setup**  | Risk limits, strategy parameters, data providers, watchlist              |

### The agent loop

A four-stage cycle, run on an interval that scales with your timeframe (15s on `1m`, up to 5min on `1d`):

1. **Perceive** — fetch candles and tickers for every watched market.
2. **Reason** — `evaluate()` computes EMA/RSI/ATR and returns a decision *plus a trace* of which rules
   passed, which failed, and the actual numbers behind each one.
3. **Act** — risk gates first (drawdown, 24h loss, position slots), then fixed-fractional sizing, then
   a paper fill with fees and slippage.
4. **Record** — an event with the full rule trace is appended to the activity log and persisted.

**Entries are a conjunction, not a vote.** Every enabled entry rule must pass:

- EMA(fast) crossed **above** EMA(slow) on this bar — a *fresh* cross, not merely a bullish stack
- Price above the trend EMA (optional)
- RSI below the overbought threshold (optional)
- Cooldown after a recent exit has elapsed

**Exits fire on the first bearish trigger**, so risk always outranks a new signal: ATR stop, ATR
target, optional trailing stop, or a bearish EMA cross. Within a single bar the stop is checked before
the target — intra-bar order is unknowable, so the pessimistic assumption is the honest one.

### Making the agent legible

The whole point of the Agent screen is that a decision is never a black box. Every tick records why:

```
✓  Trend filter (price > EMA100)     61240.50 vs EMA100 58911.20 — above
✓  EMA12/26 crossover                 Bullish cross on this bar (60110.40 > 59980.12).
–  RSI14 not overbought (< 70)        Disabled in strategy settings.
✓  Cooldown (3 bars after an exit)    No recent exit, or enough bars have passed.
```

Note the third line: a **disabled** filter reports `null` ("not applicable") rather than `true`
("passed"). The distinction matters — a skipped filter is not evidence in favour of a trade.

---

## Data sources

Prices come from public exchange REST APIs, tried in order and falling through on failure:

**Binance → Coinbase → Kraken → CoinGecko → built-in simulator**

You can reorder this in Setup, and each provider shows its health. Two details that matter in
practice:

- **Requests go through a same-origin dev proxy first** (configured in `vite.config.ts`), which avoids
  CORS entirely, then retry the public origin directly.
- **The app never hard-fails on the network.** A phone loses connectivity constantly. If every live
  source is down, or you turn on Offline mode, it serves the deterministic simulator and says so in a
  banner. The agent keeps working; only the `source` field changes.

---

## Trust boundaries

This is a paper-trading tool and is built to be honest about that:

- **No real orders.** There is no exchange credential path anywhere in the codebase. It cannot spend
  real money even if you wanted it to.
- **No backend.** State lives in `localStorage` under `paperdesk.state.v1`, versioned, and degrades to
  in-memory if storage is blocked (Safari private mode).
- **No identifying data leaves the device.** Price requests carry no account, key, or identifier —
  they are the same public quotes any browser can fetch.
- **Backtests are not forecasts.** The Test screen uses the live strategy and execution code so the
  numbers are consistent, but it replays history with today's settings, and the simulator's series is
  synthetic. It says so on screen, next to the results.

### Safety properties enforced in code

| Property                          | Where                                       |
| --------------------------------- | ------------------------------------------- |
| Stops checked before targets      | `engine.checkExits`                         |
| No entry without cash for fee     | `engine.openPosition`                       |
| Never size beyond available cash  | `strategy.positionSize` (`cappedBy` reported)|
| Stop must sit below entry         | `engine.openPosition`                       |
| No stacked positions per market   | `engine.openPosition`                       |
| Params clamped to sane ranges     | `lib/validate.ts`                           |
| Risk halt flattens all positions  | `agent.stepAgent`                           |
| Event log bounded at 200 entries  | `agent.MAX_EVENTS`                          |
| No look-ahead in backtests        | `backtest.runBacktest` (fills at next open) |

---

## Architecture

```
src/
  lib/
    types.ts        Domain types + defaults (all JSON-serialisable)
    indicators.ts   EMA/SMA/RSI/ATR/MACD/Bollinger/slope — aligned, NaN-padded
    strategy.ts     evaluate() → Decision { action, score, checks[], brackets }
    engine.ts       Fills, fees, slippage, sizing, stops, equity, stats
    backtest.ts     Replays history through the *same* strategy + engine
    agent.ts        stepAgent(): pure, snapshot in → snapshot out
    validate.ts     Clamps user input to ranges the engine can reason about
    storage.ts      Versioned localStorage with degradation
  lib/data/
    providers.ts    Binance / Coinbase / Kraken / CoinGecko adapters
    markets.ts      Canonical market list + symbol mapping
    simulator.ts    Seeded GBM — offline fallback and test fixture
    index.ts        Failover orchestration and source health
  state/
    store.ts        Observable store; owns the loop, timers, persistence
    StoreProvider.tsx  React glue (useSyncExternalStore)
  components/       Hand-rolled SVG charts, UI primitives
  screens/          Desk, Agent, Book, Test, Setup
```

Two design decisions carry most of the weight:

**`stepAgent` is a pure function.** Snapshot plus market data in, new snapshot out. No timers, no
network, no globals. That makes the agent loop fully testable without mocking anything, and it means
the same code path runs whether you started it or a test did.

**The backtester shares the live execution code.** It calls the same `evaluate`, `openPosition`,
`closePosition`, `checkExits` and `positionSize` as the live agent. A backtest that reimplemented the
logic would be a second source of truth, and the two always drift apart.

Charts are hand-rolled SVG rather than a charting library: the whole bundle is ~68 kB gzipped, which is
what you want on a mid-range phone on a slow connection.

---

## Tests

```
npm test        # 156 tests
npm run build   # typecheck + production build
```

| Suite                  | Covers                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| `indicators.test.ts`   | Hand-computed EMA/RSI/ATR/Bollinger values, bounds, cross detection  |
| `simulator.test.ts`    | Seed determinism, well-formed OHLCV, timeframe alignment             |
| `strategy.test.ts`     | Every entry rule in isolation, cooldowns, brackets, sizing caps      |
| `engine.test.ts`       | Fees, slippage, P&L, stop-before-target, immutability, drawdown      |
| `backtest.test.ts`     | Determinism, flat-market no-op, buy-and-hold, equity curve length    |
| `agent.test.ts`        | Live loop: entries, exits, limits, risk halts, purity, dry running   |
| `validate.test.ts`     | Clamping, NaN/Infinity repair, derived constraints                   |
| `App.test.tsx`         | Full UI in jsdom: boot, all five screens, agent lifecycle, halts     |

The UI suite runs against the offline simulator (seeded via `localStorage`), so the entire app is
testable with no network — which is also how it proves the offline path works.

Two behaviours the tests pin down deliberately:

- **A stopped agent is a dry run.** It keeps evaluating and publishing decisions so you can watch what
  it *would* do, but places no orders and does not advance a trailing stop. Frozen means frozen.
- **The simulator is a floor, not a choice.** It is pinned last in the provider list and is not
  reorderable, because it is what catches you when everything else is down.

---

## Limitations

Honest list, since this is a trading tool:

- **No shorting or leverage.** Long-only spot, `maxLeverage` is fixed at 1.
- **One position per market**, no position scaling or pyramiding.
- **Bars are the resolution.** Signals are evaluated on closed bars, so nothing acts intra-bar.
- **CoinGecko cannot serve arbitrary intervals** — its granularity is fixed by the `days` parameter, so
  it is coarse and last-resort.
- **The simulator is synthetic.** It has volatility clustering and drift but no order-book dynamics;
  it will not match any real market.
- **Single tab.** Two tabs running the agent will fight over the same `localStorage` key; the last
  write wins.
- **Not investment advice.** Nothing here is a recommendation, and passing a backtest is not evidence
  of anything except that the code ran.

## Install on your phone

1. `npm run dev`, then open `http://<your-computer-ip>:5173` on the phone (same Wi‑Fi).
2. **iOS Safari:** Share → Add to Home Screen. **Android Chrome:** ⋮ → Add to Home screen.
3. It launches standalone, works offline, and keeps its portfolio between launches.

For a permanent install, `npm run build` produces a static `dist/` you can host anywhere (it needs no
server-side code), or use `npm run preview` to serve the production build with the service worker
active.
