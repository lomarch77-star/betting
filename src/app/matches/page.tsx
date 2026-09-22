import Link from 'next/link';
import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { upcomingCards, finishedCards, type MatchCard } from '@/lib/services/cardsService';
import { listCompetitions } from '@/lib/db/repos-core';
import { Panel, EmptyState } from '@/components/ui';
import { fmtPct, fmtOdds, fmtKickoffDay, fmtSignedPct } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function MatchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  ensureBootstrapped();
  const sp = await searchParams;
  const view = sp.view === 'finished' ? 'finished' : 'upcoming';
  const competitionId = sp.competitionId ? Number(sp.competitionId) : undefined;
  const db = getDb();
  const comps = listCompetitions(db);
  const cards =
    view === 'upcoming'
      ? upcomingCards(db, { competitionId, days: 45 })
      : finishedCards(db, { competitionId, limit: 80 });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Matches</div>
          <div className="page-sub">
            {view === 'upcoming'
              ? 'Scheduled fixtures with persisted model probabilities and current market prices'
              : 'Finished fixtures — full pre-match research view available per match'}
          </div>
        </div>
      </div>

      <Panel title={view === 'upcoming' ? "Upcoming Fixtures" : 'Finished Fixtures'} flush>
        <form className="filter-bar" method="get">
          <div className="field">
            <label>View</label>
            <select name="view" defaultValue={view}>
              <option value="upcoming">Upcoming</option>
              <option value="finished">Finished</option>
            </select>
          </div>
          <div className="field">
            <label>Competition</label>
            <select name="competitionId" defaultValue={sp.competitionId ?? ''}>
              <option value="">All</option>
              {comps.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn primary" type="submit">
            Apply
          </button>
        </form>
        <div className="table-wrap">
          {cards.length === 0 ? (
            <EmptyState text="No fixtures in this view yet — predictions for upcoming matches are generated at bootstrap." />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Kickoff</th>
                  <th>Competition</th>
                  <th>Fixture</th>
                  <th className="num">Model H/D/A</th>
                  <th className="num">Market H/D/A</th>
                  <th className="num">Fair H/D/A</th>
                  <th className="num">Best Diff</th>
                  <th>Agreement</th>
                  <th>DQ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => (
                  <CardRow key={c.id} c={c} finished={view === 'finished'} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>
    </>
  );
}

function CardRow({ c, finished }: { c: MatchCard; finished: boolean }) {
  const k = fmtKickoffDay(c.kickoff);
  return (
    <tr>
      <td className="small">
        <span className="dim">{k.day}</span> <span className="faint">{k.time}</span>
      </td>
      <td className="small faint">
        {c.competitionCode} · R{c.round}
      </td>
      <td className="strong">
        {c.homeTeam}{' '}
        {c.score ? (
          <span className="num accent">
            {c.score.home}–{c.score.away}
          </span>
        ) : (
          <span className="faint">vs</span>
        )}{' '}
        {c.awayTeam}
      </td>
      {c.model ? (
        <>
          <td className="num">
            {fmtPct(c.model.home, 0)} / {fmtPct(c.model.draw, 0)} / {fmtPct(c.model.away, 0)}
          </td>
          <td className="num dim">
            {c.marketConsensus
              ? `${fmtOdds(c.marketConsensus.home)} / ${fmtOdds(c.marketConsensus.draw)} / ${fmtOdds(c.marketConsensus.away)}`
              : '—'}
          </td>
          <td className="num dim">
            {c.fairOdds
              ? `${fmtOdds(c.fairOdds.home)} / ${fmtOdds(c.fairOdds.draw)} / ${fmtOdds(c.fairOdds.away)}`
              : '—'}
          </td>
          <td className={`num ${c.bestDiffPct != null && c.bestDiffPct > 0 ? 'pos' : 'faint'}`}>
            {finished ? '—' : fmtSignedPct(c.bestDiffPct)}
          </td>
          <td>
            {c.agreement ? (
              <span className={`badge ${c.agreement === 'BROAD' ? 'ok' : c.agreement === 'MODERATE' ? 'warn' : 'bad'}`}>
                {c.agreement}
              </span>
            ) : (
              <span className="faint">—</span>
            )}
          </td>
        </>
      ) : (
        <td colSpan={5} className="faint small">
          {finished ? 'finished · open for pre-match research view' : 'no persisted prediction yet'}
        </td>
      )}
      <td>
        <span className={`badge ${c.quality === 'VALID' ? 'ok' : 'warn'}`}>{c.quality}</span>
      </td>
      <td>
        <Link className="btn small" href={`/matches/${c.id}`}>
          Research →
        </Link>
      </td>
    </tr>
  );
}
