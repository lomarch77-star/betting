import Link from 'next/link';
import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { runScanner, type ScannerQuery } from '@/lib/services/scannerService';
import { listCompetitions } from '@/lib/db/repos-core';
import { Panel, Notice, EmptyState } from '@/components/ui';
import { fmtPct, fmtOdds, fmtSignedPct, fmtKickoffDay } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ScannerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  ensureBootstrapped();
  const sp = await searchParams;
  const db = getDb();
  const comps = listCompetitions(db);

  const q: ScannerQuery = {
    market: (sp.market as ScannerQuery['market']) || undefined,
    competitionId: sp.competitionId ? Number(sp.competitionId) : undefined,
    minAbsDiffPct: sp.minAbsDiffPct ? Number(sp.minAbsDiffPct) : undefined,
    minEv: sp.minEv ? Number(sp.minEv) : undefined,
    agreement: (sp.agreement as ScannerQuery['agreement']) || undefined,
    quality: (sp.quality as ScannerQuery['quality']) || undefined,
    sortBy: (sp.sortBy as ScannerQuery['sortBy']) || 'diffPct',
    sortDir: (sp.sortDir as ScannerQuery['sortDir']) || 'desc',
    limit: 250,
  };
  const rows = await runScanner(db, q);

  const sortLink = (field: string, label: string) => {
    const dir = q.sortBy === field && q.sortDir === 'desc' ? 'asc' : 'desc';
    const params = new URLSearchParams({ ...sp, sortBy: field, sortDir: dir });
    return <Link href={`/scanner?${params}`}>{label}{q.sortBy === field ? (q.sortDir === 'desc' ? ' ▾' : ' ▴') : ''}</Link>;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Market Scanner</div>
          <div className="page-sub">
            Upcoming fixtures × price-supported markets · filters and sorts are measurable fields
            ONLY — nothing here is a "best bet" ranking
          </div>
        </div>
        <span className="badge info">{rows.length} rows</span>
      </div>

      <Notice kind="info">
        Model/market difference is a research starting point. It does not account for information
        the market may price that the model lacks, and small differences are usually noise.
      </Notice>
      <div style={{ height: 14 }} />

      <Panel title="Filters" flush>
        <form className="filter-bar" method="get">
          <div className="field">
            <label>Competition</label>
            <select name="competitionId" defaultValue={sp.competitionId ?? ''}>
              <option value="">All</option>
              {comps.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Market</label>
            <select name="market" defaultValue={sp.market ?? ''}>
              <option value="">All priced</option>
              <option value="ONE_X_TWO">1X2</option>
              <option value="OU_GOALS">Over/Under 2.5</option>
              <option value="BTTS">BTTS</option>
            </select>
          </div>
          <div className="field">
            <label>Min |price diff| (0–1)</label>
            <input name="minAbsDiffPct" type="number" step="0.01" min="0" max="1" defaultValue={sp.minAbsDiffPct ?? ''} style={{ minWidth: 90 }} />
          </div>
          <div className="field">
            <label>Min EV (0–1)</label>
            <input name="minEv" type="number" step="0.01" min="-1" max="1" defaultValue={sp.minEv ?? ''} style={{ minWidth: 90 }} />
          </div>
          <div className="field">
            <label>Model agreement</label>
            <select name="agreement" defaultValue={sp.agreement ?? ''}>
              <option value="">Any</option>
              <option value="BROAD">Broad</option>
              <option value="MODERATE">Moderate</option>
              <option value="SPLIT">Split</option>
            </select>
          </div>
          <div className="field">
            <label>Data quality</label>
            <select name="quality" defaultValue={sp.quality ?? ''}>
              <option value="">Any (excl. INVALID)</option>
              <option value="VALID">VALID only</option>
              <option value="WARNING">WARNING</option>
            </select>
          </div>
          <button className="btn primary" type="submit">Apply</button>
        </form>

        <div className="table-wrap">
          {rows.length === 0 ? (
            <EmptyState text="No rows match the current filters (or predictions are still being generated at bootstrap)." />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Kickoff</th>
                  <th>Fixture</th>
                  <th>Market</th>
                  <th>Selection</th>
                  <th className="num">{sortLink('modelProbability', 'Model Prob')}</th>
                  <th className="num">Fair</th>
                  <th className="num">Consensus</th>
                  <th className="num">{sortLink('diffPct', 'Price Diff')}</th>
                  <th className="num">{sortLink('ev', 'EV')}</th>
                  <th>Agreement</th>
                  <th>DQ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const k = fmtKickoffDay(r.kickoff);
                  return (
                    <tr key={i}>
                      <td className="small dim">{k.day.slice(0, 3)} {r.kickoff.slice(5, 10)} {k.time.slice(0, 5)}</td>
                      <td>
                        <Link href={`/matches/${r.matchId}`}>
                          {r.homeShort} <span className="faint">vs</span> {r.awayShort}
                        </Link>{' '}
                        <span className="faint micro">{r.competitionCode}</span>
                      </td>
                      <td className="small dim">{r.market === 'OU_GOALS' ? `O/U ${r.line}` : r.market === 'ONE_X_TWO' ? '1X2' : 'BTTS'}</td>
                      <td className="small strong">{r.selection}</td>
                      <td className="num strong">{fmtPct(r.modelProbability)}</td>
                      <td className="num dim">{fmtOdds(r.fairOdds)}</td>
                      <td className="num">{fmtOdds(r.consensusOdds)} <span className="faint micro">{r.bookCount > 0 ? `×${r.bookCount}b` : ''}</span></td>
                      <td className={`diff-cell num ${r.diffPct != null && r.diffPct > 0 ? 'pos' : 'neg'}`}>{fmtSignedPct(r.diffPct)}</td>
                      <td className={`diff-cell num ${r.ev != null && r.ev > 0 ? 'pos' : 'neg'}`}>{fmtSignedPct(r.ev)}</td>
                      <td>
                        <span className={`badge ${r.agreement === 'BROAD' ? 'ok' : r.agreement === 'MODERATE' ? 'warn' : 'bad'}`}>{r.agreement}</span>
                      </td>
                      <td>
                        <span className={`badge ${r.dataQuality === 'VALID' ? 'ok' : 'warn'}`}>{r.dataQuality}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Panel>
    </>
  );
}
