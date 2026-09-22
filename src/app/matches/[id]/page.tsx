import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { analyzeMatch, type PriceView } from '@/lib/services/predictionService';
import { analystSummary } from '@/lib/services/dashboardService';
import { Panel, ProbBar, Notice } from '@/components/ui';
import { ScoreHeatmap, MovementChart } from '@/components/charts';
import { PaperEntryForm } from '@/components/paper-form';
import {
  fmtPct,
  fmtOdds,
  fmtSignedPct,
  fmtKickoffDay,
  fmtNum,
  fmtInt,
} from '@/lib/format';

export const dynamic = 'force-dynamic';

const SELECTION_LABEL: Record<string, string> = {
  HOME: 'Home',
  DRAW: 'Draw',
  AWAY: 'Away',
  OVER: 'Over',
  UNDER: 'Under',
  YES: 'Yes',
  NO: 'No',
};

export default async function MatchResearchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  ensureBootstrapped();
  const { id } = await params;
  const analysis = await analyzeMatch(getDb(), Number(id));
  if (!analysis) notFound();
  const a = analysis;
  const m = a.match;
  const p = a.prediction;
  const k = fmtKickoffDay(m.kickoff);
  const analyst = analystSummary(a);
  const scheduled = m.status === 'SCHEDULED';

  return (
    <>
      <div className="page-head">
        <div className="page-sub">
          <Link href="/matches" className="accent">
            ← Matches
          </Link>{' '}
          · {m.competition} · {m.seasonCode} · Round {m.round}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="badge demo">DEMO MATCH</span>
          <span className={`badge ${m.qualityStatus === 'VALID' ? 'ok' : m.qualityStatus === 'WARNING' ? 'warn' : 'bad'}`}>
            DQ {m.qualityStatus}
          </span>
          <span className="badge">{m.status}</span>
        </div>
      </div>

      <Panel title="Fixture" flush>
        <div className="match-hero">
          <div className="side home">
            <div className="team-name">{m.homeTeam}</div>
            <div className="team-sub">HOME · model {p ? fmtPct(p.ensemble.home) : '—'}</div>
          </div>
          <div className="vs-box">
            {m.score ? (
              <div className="score">
                {m.score.home}–{m.score.away}
              </div>
            ) : (
              <div className="score" style={{ fontSize: 16 }}>
                VS
              </div>
            )}
            <div className="kick">
              {k.day} · {k.time}
            </div>
            <div className="comp">
              {m.competition} · round {m.round}
            </div>
          </div>
          <div className="side away">
            <div className="team-name">{m.awayTeam}</div>
            <div className="team-sub">AWAY · model {p ? fmtPct(p.ensemble.away) : '—'}</div>
          </div>
        </div>
      </Panel>

      <div style={{ height: 14 }} />

      {!p && (
        <Notice kind="warn">
          No model coverage for this fixture — the fitted ensemble lacks sufficient historical
          data at this kickoff's information horizon. Market data (if any) is still shown below.
        </Notice>
      )}

      {p && (
        <>
          <div className="grid cols-3">
            <Panel title="Model Probability (Calibrated Ensemble)">
              <ProbBar label="Home" p={p.ensemble.home} />
              <ProbBar label="Draw" p={p.ensemble.draw} tone="draw" />
              <ProbBar label="Away" p={p.ensemble.away} tone="away" />
              <div className="micro faint" style={{ marginTop: 10 }}>
                {p.modelVersionCode} · {p.calibrated ? 'isotonic-calibrated' : 'uncalibrated'} · trained on{' '}
                {fmtInt(p.trainedOn)} matches · as-of {p.asOf.slice(0, 16)}Z
              </div>
              <div className="micro faint" style={{ marginTop: 6 }}>
                probability ≠ certainty · fair_odds = 1 / probability
              </div>
            </Panel>

            <Panel title="Model / Market Difference — 1X2">
              <table className="data">
                <thead>
                  <tr>
                    <th></th>
                    <th className="num">Prob</th>
                    <th className="num">Fair</th>
                    <th className="num">Market</th>
                    <th className="num">Diff</th>
                    {scheduled && <th>Paper</th>}
                  </tr>
                </thead>
                <tbody>
                  {a.prices.oneXTwo.map((v) => (
                    <PriceRow key={v.selection} v={v} scheduled={scheduled} matchId={m.id} market="ONE_X_TWO" line={null} />
                  ))}
                </tbody>
              </table>
              {a.prices.overround && (
                <div className="micro faint" style={{ marginTop: 8 }}>
                  closing overround {(a.prices.overround.overround * 100).toFixed(1)}% · consensus is
                  margin-free-adjusted — raw bookmaker implied probability is never treated as truth
                </div>
              )}
            </Panel>

            <Panel title="Model Agreement — Component View">
              <table className="data">
                <thead>
                  <tr>
                    <th></th>
                    <th className="num">Home</th>
                    <th className="num">Draw</th>
                    <th className="num">Away</th>
                  </tr>
                </thead>
                <tbody>
                  {p.perModel.map((pm) => (
                    <tr key={pm.kind}>
                      <td className="faint small">{pm.kind}</td>
                      <td className="num">{fmtPct(pm.probs.home, 0)}</td>
                      <td className="num">{fmtPct(pm.probs.draw, 0)}</td>
                      <td className="num">{fmtPct(pm.probs.away, 0)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="strong small">ENSEMBLE</td>
                    <td className="num strong">{fmtPct(p.ensemble.home, 0)}</td>
                    <td className="num strong">{fmtPct(p.ensemble.draw, 0)}</td>
                    <td className="num strong">{fmtPct(p.ensemble.away, 0)}</td>
                  </tr>
                </tbody>
              </table>
              <div className="micro faint" style={{ marginTop: 8 }}>
                spread {fmtPct(p.uncertainty.meanSpread, 1)} ·{' '}
                <span className={p.uncertainty.modelAgreement === 'BROAD' ? 'pos' : 'amber'}>
                  {p.uncertainty.modelAgreement}
                </span>{' '}
                agreement — check whether a price gap is broad-based or driven by one model
              </div>
            </Panel>
          </div>

          <div style={{ height: 14 }} />

          <div className="grid cols-3">
            <Panel title="Derived Goal Markets (Fair Prices)">
              <table className="data">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th className="num">Prob</th>
                    <th className="num">Fair</th>
                    <th className="num">Market</th>
                    <th className="num">Diff</th>
                    {scheduled && <th>Paper</th>}
                  </tr>
                </thead>
                <tbody>
                  {a.prices.ou25.map((v) => (
                    <PriceRow key={`ou-${v.selection}`} v={v} scheduled={scheduled} matchId={m.id} market="OU_GOALS" line={2.5} label={`O/U 2.5 ${SELECTION_LABEL[v.selection] ?? v.selection}`} showPaper />
                  ))}
                  {a.prices.btts.map((v) => (
                    <PriceRow key={`btts-${v.selection}`} v={v} scheduled={scheduled} matchId={m.id} market="BTTS" line={null} label={`BTTS ${SELECTION_LABEL[v.selection] ?? v.selection}`} />
                  ))}
                  {p.derivedMarkets.overUnder
                    .filter((o) => o.line !== 2.5)
                    .map((o) => (
                      <tr key={`ou${o.line}`}>
                        <td className="small dim">O/U {o.line} Over</td>
                        <td className="num">{fmtPct(o.over)}</td>
                        <td className="num dim">{fmtOdds(1 / o.over)}</td>
                        <td className="num faint" colSpan={2}>
                          no demo market
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Panel>

            <Panel title="Result-Linked Derived Markets">
              <table className="data">
                <tbody>
                  <tr>
                    <td className="small">Double chance H/D</td>
                    <td className="num">{fmtPct(p.derivedMarkets.doubleChance.homeDraw)}</td>
                    <td className="num dim">{fmtOdds(1 / p.derivedMarkets.doubleChance.homeDraw)}</td>
                  </tr>
                  <tr>
                    <td className="small">Double chance A/D</td>
                    <td className="num">{fmtPct(p.derivedMarkets.doubleChance.awayDraw)}</td>
                    <td className="num dim">{fmtOdds(1 / p.derivedMarkets.doubleChance.awayDraw)}</td>
                  </tr>
                  <tr>
                    <td className="small">Draw no bet Home</td>
                    <td className="num">{fmtPct(p.derivedMarkets.drawNoBet.home)}</td>
                    <td className="num dim">{fmtOdds(1 / p.derivedMarkets.drawNoBet.home)}</td>
                  </tr>
                  <tr>
                    <td className="small">Draw no bet Away</td>
                    <td className="num">{fmtPct(p.derivedMarkets.drawNoBet.away)}</td>
                    <td className="num dim">{fmtOdds(1 / p.derivedMarkets.drawNoBet.away)}</td>
                  </tr>
                  <tr>
                    <td className="small">Home team over 1.5</td>
                    <td className="num">{fmtPct(p.derivedMarkets.homeTotals.find((t) => t.line === 1.5)?.over ?? 0)}</td>
                    <td className="num dim">{fmtOdds(1 / (p.derivedMarkets.homeTotals.find((t) => t.line === 1.5)?.over ?? 1))}</td>
                  </tr>
                  <tr>
                    <td className="small">Away team over 1.5</td>
                    <td className="num">{fmtPct(p.derivedMarkets.awayTotals.find((t) => t.line === 1.5)?.over ?? 0)}</td>
                    <td className="num dim">{fmtOdds(1 / (p.derivedMarkets.awayTotals.find((t) => t.line === 1.5)?.over ?? 1))}</td>
                  </tr>
                  <tr>
                    <td className="small">Asian handicap H −1.0</td>
                    <td className="num">{fmtPct(p.derivedMarkets.asianHandicapHome.find((x) => x.line === -1)?.cover ?? 0)}</td>
                    <td className="num dim faint">push-excluded</td>
                  </tr>
                  <tr>
                    <td className="small">Asian handicap H +1.0</td>
                    <td className="num">{fmtPct(p.derivedMarkets.asianHandicapHome.find((x) => x.line === 1)?.cover ?? 0)}</td>
                    <td className="num dim faint">push-excluded</td>
                  </tr>
                </tbody>
              </table>
              <div className="micro faint" style={{ marginTop: 8 }}>
                All derived from one ensemble-consistent score distribution (λ̂{' '}
                {fmtNum(p.lambdas.home)}–{fmtNum(p.lambdas.away)}; xĜ{' '}
                {fmtNum(p.expectedGoalsFromMatrix.home)}–{fmtNum(p.expectedGoalsFromMatrix.away)})
              </div>
            </Panel>

            <Panel title="Correct Score Matrix (Joint Distribution)">
              <ScoreHeatmap matrix={p.matrix} />
              <div className="micro faint" style={{ marginTop: 8 }}>
                Top: {p.matrixTop.slice(0, 4).map((s) => `${s.home}-${s.away} ${fmtPct(s.prob, 1)}`).join(' · ')}
              </div>
            </Panel>
          </div>

          <div style={{ height: 14 }} />
        </>
      )}

      <div className="grid cols-3">
        <Panel title="Why the Model Says This (Deterministic Factors)">
          {p && p.explanation.length > 0 ? (
            p.explanation.map((e, i) => (
              <div key={i} className="factor">
                <span className={`sign ${e.direction === '+' ? 'plus' : 'minus'}`}>{e.direction}</span>
                <span>{e.text}</span>
              </div>
            ))
          ) : (
            <div className="muted-box">No explanation available.</div>
          )}
          <div className="micro faint" style={{ marginTop: 10 }}>
            Factors are ranked by learned feature importances × observed values. Nothing in this
            panel is written by a language model.
          </div>
        </Panel>

        <Panel title="Uncertainty Profile">
          {p ? (
            <table className="data">
              <tbody>
                <tr><td>Model agreement</td><td className="num"><b>{p.uncertainty.modelAgreement}</b></td></tr>
                <tr><td>Data quality</td><td className="num"><b>{p.uncertainty.dataQuality}</b></td></tr>
                <tr><td>Calibration</td><td className="num"><b>{p.uncertainty.calibration}</b></td></tr>
                <tr><td>Historical sample</td><td className="num"><b>{fmtInt(p.uncertainty.historicalSample)}</b></td></tr>
                <tr><td>Overall uncertainty</td><td className="num"><span className={`badge ${p.uncertainty.overall === 'LOW' ? 'ok' : p.uncertainty.overall === 'MODERATE' ? 'warn' : 'bad'}`}>{p.uncertainty.overall}</span></td></tr>
              </tbody>
            </table>
          ) : (
            <div className="muted-box">—</div>
          )}
          {p?.uncertainty.notes.map((n, i) => (
            <div key={i} className="micro amber" style={{ marginTop: 6 }}>
              ▲ {n}
            </div>
          ))}
          <div className="micro faint" style={{ marginTop: 10 }}>
            By design there is no single fake "confidence = 92%" figure.
          </div>
        </Panel>

        <Panel title="Price Movement — 1X2 Implied Probability">
          <MovementChart points={a.prices.movement} books={a.prices.books} />
          <div className="micro faint" style={{ marginTop: 6 }}>
            Opening → closing drift per book (margin-removed). CLV is a diagnostic, not proof of profit.
          </div>
        </Panel>
      </div>

      <div style={{ height: 14 }} />

      <div className="grid cols-2">
        <Panel title={`Recent Form — ${m.homeShort}`}>
          <FormTable form={a.form.home.recent} />
        </Panel>
        <Panel title={`Recent Form — ${m.awayShort}`}>
          <FormTable form={a.form.away.recent} />
        </Panel>
      </div>

      <div style={{ height: 14 }} />

      <Panel
        title="Analyst Summary — Rules-Based (engine: deterministic-templates-v1)"
        right={<span className="badge info">NO FREE-TEXT STATISTICS</span>}
      >
        <div className="analyst-box">
          <span className="tag">summary</span>
          {analyst.summary}
        </div>
        <div style={{ height: 8 }} />
        {analyst.bullets.map((b, i) => (
          <div key={i} className="analyst-box" style={{ marginBottom: 6 }}>
            <span className="tag">{b.tag}</span>
            {b.text}
          </div>
        ))}
        <div className="micro faint" style={{ marginTop: 10 }}>
          {analyst.disclaimer} Evidence fields: {analyst.evidence.map((e) => e.field).join(' · ')}
        </div>
      </Panel>

      <div style={{ height: 14 }} />
      <Panel title="Audit & Provenance">
        <table className="data">
          <tbody>
            <tr><td>Data source</td><td className="num">{m.dataSource} {m.isDemo ? '(synthetic demo universe)' : ''}</td></tr>
            <tr><td>Model version</td><td className="num">{p?.modelVersionCode ?? '—'}</td></tr>
            <tr><td>Information horizon (as-of)</td><td className="num">{p?.asOf ?? '—'}</td></tr>
            <tr><td>Ensemble weights</td><td className="num">{p ? Object.entries(p.weights).map(([k, v]) => `${k} ${(Number(v) * 100).toFixed(0)}%`).join(' · ') : '—'}</td></tr>
            {m.score && (
              <tr>
                <td>Match statistics</td>
                <td className="num">
                  xG {fmtNum(m.stats.xg[0])}–{fmtNum(m.stats.xg[1])} · shots {m.stats.shots[0]}–{m.stats.shots[1]} · SoT {m.stats.shotsOn[0]}–{m.stats.shotsOn[1]} · corners {m.stats.corners[0]}–{m.stats.corners[1]} · poss {fmtPct(m.stats.possessionHome, 0)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

function PriceRow({
  v,
  scheduled,
  matchId,
  market,
  line,
  label,
  showPaper,
}: {
  v: PriceView;
  scheduled: boolean;
  matchId: number;
  market: string;
  line: number | null;
  label?: string;
  showPaper?: boolean;
}) {
  return (
    <tr>
      <td className="small dim">{label ?? SELECTION_LABEL[v.selection] ?? v.selection}</td>
      <td className="num strong">{fmtPct(v.modelProbability)}</td>
      <td className="num dim">{fmtOdds(v.fairOdds)}</td>
      <td className="num">
        {fmtOdds(v.consensusOdds)}{' '}
        <span className="faint micro">{v.bestOdds ? `(${v.bestOdds.toFixed(2)} ${v.bestBook ?? ''})` : ''}</span>
      </td>
      <td className={`diff-cell num ${v.diffPct != null && v.diffPct > 0 ? 'pos' : 'neg'}`}>
        {fmtSignedPct(v.diffPct)}
      </td>
      {scheduled && (
        <td>
          {(showPaper ?? true) && v.consensusOdds ? (
            <PaperEntryForm
              matchId={matchId}
              defaultSelection={v.selection}
              defaultOdds={v.consensusOdds}
              modelProb={v.modelProbability}
              market={market}
              line={line}
            />
          ) : null}
        </td>
      )}
    </tr>
  );
}

function FormTable({
  form,
}: {
  form: Array<{
    date: string;
    opponent: string;
    home: boolean;
    score: string;
    result: 'W' | 'D' | 'L';
    xgFor: number | null;
    xgAgainst: number | null;
  }>;
}) {
  if (form.length === 0) return <div className="muted-box">No pre-kickoff form.</div>;
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Date</th>
          <th></th>
          <th>Opp</th>
          <th className="num">Score</th>
          <th className="num">xG</th>
          <th className="num">xGA</th>
        </tr>
      </thead>
      <tbody>
        {form.map((r, i) => (
          <tr key={i}>
            <td className="small dim">{r.date}</td>
            <td>
              <span className={`badge ${r.result === 'W' ? 'ok' : r.result === 'D' ? '' : 'bad'}`}>{r.result}</span>
            </td>
            <td className="small">
              {r.home ? 'vs' : '@'} {r.opponent}
            </td>
            <td className="num">{r.score}</td>
            <td className="num dim">{fmtNum(r.xgFor)}</td>
            <td className="num dim">{fmtNum(r.xgAgainst)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
