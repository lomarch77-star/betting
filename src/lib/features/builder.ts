/**
 * Streaming feature engine — the ONLY way features may be built (spec §6/§20).
 *
 * Leakage safety is structural, not procedural: a FeatureBuilder is fed
 * finished matches in strictly ascending kickoff order, and a feature
 * snapshot can only be requested for a kickoff AFTER everything consumed.
 * Backward jumps throw. There is no API to read "current" full state and no
 * way to access a match's statistics from a snapshot taken before it.
 *
 * Every snapshot carries an `asOf` (the prospective match's kickoff) — the
 * `available_at` timestamp spec §20 mandates for each feature.
 */

import type { MatchRow } from '@/lib/db/repos-core';
import { EloSystem, type EloParams, DEFAULT_ELO_PARAMS } from '@/lib/models/elo';
import { clamp } from '@/lib/quant/math';
import type { MatchResult3 } from '@/lib/types';

const DAY = 86_400_000;

interface PastMatch {
  kickoffMs: number;
  home: boolean;
  gf: number;
  ga: number;
  xgf: number;
  xga: number;
  pts: number;
  oppId: number;
}

interface TeamState {
  history: PastMatch[]; // ascending, capped
  lastKickoffMs: number | null;
  seasonId: number | null;
  seasonP: number;
  seasonPts: number;
  seasonGf: number;
  seasonGa: number;
}

function freshTeam(): TeamState {
  return {
    history: [],
    lastKickoffMs: null,
    seasonId: null,
    seasonP: 0,
    seasonPts: 0,
    seasonGf: 0,
    seasonGa: 0,
  };
}

export const FEATURE_NAMES = [
  'eloDiff',
  'eloExpected',
  'ptsRate5Diff',
  'ptsRate10Diff',
  'gdRate5Diff',
  'gdRate10Diff',
  'xgRate5Diff',
  'attackDefenceEdge',
  'venuePtsRateDiff',
  'restDaysDiff',
  'congestionDiff',
  'seasonPtsRateDiff',
  'cleanSheetDiff',
  'bttsRateDiff',
  'positionDiff',
  'awayStreakDiff',
  'combinedGoalExpectancy',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export interface FeatureSnapshot {
  asOf: string;
  homeTeamId: number;
  awayTeamId: number;
  x: number[];
  byName: Record<FeatureName, number>;
  /** raw underlyings for the UI explanation panel */
  context: {
    eloHome: number;
    eloAway: number;
    homeLast5: { gf: number; ga: number; pts: number; n: number };
    awayLast5: { gf: number; ga: number; pts: number; n: number };
    homeXg5: { xgf: number; xga: number; n: number };
    awayXg5: { xgf: number; xga: number; n: number };
    restDays: { home: number; away: number };
    congestion14d: { home: number; away: number };
    seasonPtsRate: { home: number; away: number };
    positions: { home: number | null; away: number | null; tableSize: number };
  };
}

export interface TrainingRow {
  matchId: number;
  kickoff: string;
  competitionId: number;
  seasonId: number;
  round: number;
  homeTeamId: number;
  awayTeamId: number;
  label: 0 | 1 | 2;
  homeGoals: number;
  awayGoals: number;
  x: number[];
  eloHomePre: number;
  eloAwayPre: number;
  leagueAvgGoalsPerTeam: number;
}

export class FeatureBuilder {
  private teams = new Map<number, TeamState>();
  private eloByComp = new Map<number, EloSystem>();
  private goalsByComp = new Map<number, { goals: number; matches: number }>();
  private pointerMs = -Infinity;
  private readonly eloParams: EloParams;

  constructor(eloParams: EloParams = DEFAULT_ELO_PARAMS) {
    this.eloParams = eloParams;
  }

  private team(id: number): TeamState {
    let t = this.teams.get(id);
    if (!t) {
      t = freshTeam();
      this.teams.set(id, t);
    }
    return t;
  }

  private elo(compId: number): EloSystem {
    let e = this.eloByComp.get(compId);
    if (!e) {
      e = new EloSystem(this.eloParams);
      this.eloByComp.set(compId, e);
    }
    return e;
  }

  /** Current rating view (post everything consumed so far). */
  eloSystem(compId: number): EloSystem {
    return this.elo(compId);
  }

  /** Pre-match ratings for a prospective fixture + derived Elo features. */
  ratingsFor(compId: number, homeId: number, awayId: number): {
    home: number;
    away: number;
  } {
    const e = this.elo(compId);
    return { home: e.rating(homeId), away: e.rating(awayId) };
  }

  leagueAvgGoalsPerTeam(compId: number): number {
    const g = this.goalsByComp.get(compId);
    if (!g || g.matches === 0) return 1.35;
    return g.goals / (2 * g.matches);
  }

  /**
   * Feed one finished match. kickoff must be > every previously consumed
   * kickoff (strictly increasing; simultaneous kickoffs are ordered by id).
   */
  consume(m: MatchRow): void {
    const ms = Date.parse(m.kickoff_utc);
    if (ms < this.pointerMs) {
      throw new Error(
        `FeatureBuilder.consume: out-of-order match — got ${m.kickoff_utc} after ${new Date(this.pointerMs).toISOString()}. Chronological integrity violated.`,
      );
    }
    this.pointerMs = ms;
    if (m.home_goals == null || m.away_goals == null) return;

    const hg = m.home_goals;
    const ag = m.away_goals;
    const result: MatchResult3 = hg > ag ? 'H' : hg === ag ? 'D' : 'A';

    // Elo update (also yields nothing future-dependent)
    this.elo(m.competition_id).update({
      homeTeamId: m.home_team_id,
      awayTeamId: m.away_team_id,
      result,
      homeGoals: hg,
      awayGoals: ag,
      kickoff: m.kickoff_utc,
    });

    const g = this.goalsByComp.get(m.competition_id) ?? { goals: 0, matches: 0 };
    g.goals += hg + ag;
    g.matches += 1;
    this.goalsByComp.set(m.competition_id, g);

    const hxg = m.home_xg ?? hg;
    const axg = m.away_xg ?? ag;

    const home = this.team(m.home_team_id);
    const away = this.team(m.away_team_id);
    // season rollover resets
    if (home.seasonId !== m.season_id) {
      Object.assign(home, { seasonId: m.season_id, seasonP: 0, seasonPts: 0, seasonGf: 0, seasonGa: 0 });
    }
    if (away.seasonId !== m.season_id) {
      Object.assign(away, { seasonId: m.season_id, seasonP: 0, seasonPts: 0, seasonGf: 0, seasonGa: 0 });
    }

    home.history.push({
      kickoffMs: ms,
      home: true,
      gf: hg, ga: ag, xgf: hxg, xga: axg,
      pts: result === 'H' ? 3 : result === 'D' ? 1 : 0,
      oppId: m.away_team_id,
    });
    away.history.push({
      kickoffMs: ms,
      home: false,
      gf: ag, ga: hg, xgf: axg, xga: hxg,
      pts: result === 'A' ? 3 : result === 'D' ? 1 : 0,
      oppId: m.home_team_id,
    });
    if (home.history.length > 80) home.history.splice(0, home.history.length - 80);
    if (away.history.length > 80) away.history.splice(0, away.history.length - 80);

    home.lastKickoffMs = ms;
    away.lastKickoffMs = ms;
    home.seasonP++;
    away.seasonP++;
    home.seasonGf += hg;
    home.seasonGa += ag;
    away.seasonGf += ag;
    away.seasonGa += hg;
    const pts = { H: [3, 0], D: [1, 1], A: [0, 3] }[result];
    home.seasonPts += pts[0];
    away.seasonPts += pts[1];
  }

  /** Season-to-date league table (points, then GD) for position features. */
  private table(seasonId: number): Map<number, { pts: number; gd: number; p: number }> {
    const t = new Map<number, { pts: number; gd: number; p: number }>();
    for (const [teamId, st] of this.teams) {
      if (st.seasonId !== seasonId) continue;
      t.set(teamId, { pts: st.seasonPts, gd: st.seasonGf - st.seasonGa, p: st.seasonP });
    }
    return t;
  }

  private positionOf(seasonId: number, teamId: number): { pos: number; size: number } {
    const t = [...this.table(seasonId)].sort((a, b) => b[1].pts - a[1].pts || b[1].gd - a[1].gd);
    const idx = t.findIndex(([id]) => id === teamId);
    return { pos: idx === -1 ? 0 : idx + 1, size: t.length };
  }

  private window(t: TeamState, n: number): PastMatch[] {
    return t.history.slice(Math.max(0, t.history.length - n));
  }

  private venueWindow(t: TeamState, homeVenue: boolean, n: number): PastMatch[] {
    return t.history.filter((h) => h.home === homeVenue).slice(-n);
  }

  /**
   * Snapshot features for a prospective match. REQUIRES kickoff after every
   * consumed match — enforcing the information horizon.
   */
  snapshot(
    competitionId: number,
    seasonId: number,
    homeId: number,
    awayId: number,
    kickoffIso: string,
  ): FeatureSnapshot {
    const ms = Date.parse(kickoffIso);
    // Equality allowed: a fixture kicking off at the same instant as already-
    // consumed matches cannot know their results yet — still safe.
    if (ms < this.pointerMs) {
      throw new Error(
        `FeatureBuilder.snapshot: kickoff ${kickoffIso} precedes consumed history (${new Date(this.pointerMs).toISOString()}) — refusing to build features across the information horizon.`,
      );
    }
    const home = this.team(homeId);
    const away = this.team(awayId);
    const elo = this.elo(competitionId);
    const lg = this.leagueAvgGoalsPerTeam(competitionId);

    const eloHome = elo.rating(homeId);
    const eloAway = elo.rating(awayId);
    const eloDiff = eloHome + this.eloParams.homeAdvantage - eloAway;
    const eloExpected = 1 / (1 + Math.pow(10, -eloDiff / 400));

    const h5 = this.window(home, 5);
    const a5 = this.window(away, 5);
    const h10 = this.window(home, 10);
    const a10 = this.window(away, 10);

    const rate = (rows: PastMatch[], f: (r: PastMatch) => number) =>
      rows.length === 0 ? 0 : rows.reduce((a, r) => a + f(r), 0) / rows.length;

    const ptsRate5Diff = rate(h5, (r) => r.pts) - rate(a5, (r) => r.pts);
    const ptsRate10Diff = rate(h10, (r) => r.pts) - rate(a10, (r) => r.pts);
    const gdRate5Diff = rate(h5, (r) => r.gf - r.ga) - rate(a5, (r) => r.gf - r.ga);
    const gdRate10Diff = rate(h10, (r) => r.gf - r.ga) - rate(a10, (r) => r.gf - r.ga);
    const xgRate5Diff = rate(h5, (r) => r.xgf - r.xga) - rate(a5, (r) => r.xgf - r.xga);

    // opponent-adjusted attack/defence edge (league-relative, log space)
    const emaGF = (t: TeamState) => {
      const rows = this.window(t, 10);
      let num = 0, den = 0;
      rows.forEach((r, i) => {
        const w = Math.pow(0.78, rows.length - 1 - i);
        num += w * r.gf;
        den += w;
      });
      return den > 0 ? num / den : lg;
    };
    const emaGA = (t: TeamState) => {
      const rows = this.window(t, 10);
      let num = 0, den = 0;
      rows.forEach((r, i) => {
        const w = Math.pow(0.78, rows.length - 1 - i);
        num += w * r.ga;
        den += w;
      });
      return den > 0 ? num / den : lg;
    };
    const safe = (v: number) => Math.max(0.15, v);
    const homeMatchup = Math.log(safe(emaGF(home)) / lg) - Math.log(safe(emaGA(away)) / lg);
    const awayMatchup = Math.log(safe(emaGF(away)) / lg) - Math.log(safe(emaGA(home)) / lg);
    const attackDefenceEdge = homeMatchup - awayMatchup;
    // summed (not diffed): high values = BOTH attacks outperform BOTH defences
    // → high-scoring environments; drives totals-market research.
    const combinedGoalExpectancy = homeMatchup + awayMatchup;

    const hv10 = this.venueWindow(home, true, 10);
    const av10 = this.venueWindow(away, false, 10);
    const venuePtsRateDiff = rate(hv10, (r) => r.pts) - rate(av10, (r) => r.pts);

    const restHome = home.lastKickoffMs == null ? 12 : (ms - home.lastKickoffMs) / DAY;
    const restAway = away.lastKickoffMs == null ? 12 : (ms - away.lastKickoffMs) / DAY;
    const restDaysDiff = clamp(restHome, 0, 16) - clamp(restAway, 0, 16);

    const in14 = (t: TeamState) =>
      t.history.filter((r) => ms - r.kickoffMs <= 14 * DAY).length;
    const congHome = in14(home);
    const congAway = in14(away);
    const congestionDiff = congAway - congHome; // positive = home less congested

    const seasonPtsHome = home.seasonId === seasonId && home.seasonP > 0 ? home.seasonPts / home.seasonP : 0;
    const seasonPtsAway = away.seasonId === seasonId && away.seasonP > 0 ? away.seasonPts / away.seasonP : 0;
    const seasonPtsRateDiff = seasonPtsHome - seasonPtsAway;

    const csRate = (rows: PastMatch[]) => rate(rows, (r) => (r.ga === 0 ? 1 : 0));
    const cleanSheetDiff = csRate(h10) - csRate(a10);
    const bttsRate = (rows: PastMatch[]) => rate(rows, (r) => (r.gf > 0 && r.ga > 0 ? 1 : 0));
    const bttsRateDiff = bttsRate(h10) - bttsRate(a10);

    const posH = this.positionOf(seasonId, homeId);
    const posA = this.positionOf(seasonId, awayId);
    const positionDiff =
      posH.pos === 0 || posA.pos === 0 || posH.size < 2
        ? 0
        : (posA.pos - posH.pos) / (posH.size - 1);

    const awayStreak = (t: TeamState) => {
      let n = 0;
      for (let i = t.history.length - 1; i >= 0; i--) {
        if (!t.history[i].home) n++;
        else break;
      }
      return n;
    };
    const awayStreakDiff = awayStreak(away) - awayStreak(home);

    const x: Record<FeatureName, number> = {
      eloDiff,
      eloExpected,
      ptsRate5Diff,
      ptsRate10Diff,
      gdRate5Diff,
      gdRate10Diff,
      xgRate5Diff,
      attackDefenceEdge,
      venuePtsRateDiff,
      restDaysDiff,
      congestionDiff,
      seasonPtsRateDiff,
      cleanSheetDiff,
      bttsRateDiff,
      positionDiff,
      awayStreakDiff,
      combinedGoalExpectancy,
    };

    return {
      asOf: kickoffIso,
      homeTeamId: homeId,
      awayTeamId: awayId,
      x: FEATURE_NAMES.map((n) => x[n]),
      byName: x,
      context: {
        eloHome,
        eloAway,
        homeLast5: {
          gf: h5.reduce((a, r) => a + r.gf, 0),
          ga: h5.reduce((a, r) => a + r.ga, 0),
          pts: h5.reduce((a, r) => a + r.pts, 0),
          n: h5.length,
        },
        awayLast5: {
          gf: a5.reduce((a, r) => a + r.gf, 0),
          ga: a5.reduce((a, r) => a + r.ga, 0),
          pts: a5.reduce((a, r) => a + r.pts, 0),
          n: a5.length,
        },
        homeXg5: {
          xgf: h5.reduce((a, r) => a + r.xgf, 0),
          xga: h5.reduce((a, r) => a + r.xga, 0),
          n: h5.length,
        },
        awayXg5: {
          xgf: a5.reduce((a, r) => a + r.xgf, 0),
          xga: a5.reduce((a, r) => a + r.xga, 0),
          n: a5.length,
        },
        restDays: { home: Math.round(restHome), away: Math.round(restAway) },
        congestion14d: { home: congHome, away: congAway },
        seasonPtsRate: { home: round2(seasonPtsHome), away: round2(seasonPtsAway) },
        positions: { home: posH.pos || null, away: posA.pos || null, tableSize: posH.size },
      },
    };
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Build leakage-safe training rows in a single chronological pass: for each
 * candidate match, the label is its result and the features are snapshotted
 * BEFORE the match is consumed. Matches before `fromIso` are consumed for
 * state only (warmup), never emitted.
 */
export function buildRowsWithBuilder(
  matches: MatchRow[], // ascending kickoff — caller must guarantee (finishedBefore does)
  opts: { fromIso?: string; minHistoryMatches?: number } = {},
): { rows: TrainingRow[]; builder: FeatureBuilder } {
  const builder = new FeatureBuilder();
  const rows: TrainingRow[] = [];
  const minHist = opts.minHistoryMatches ?? 3;
  for (const m of matches) {
    if (m.home_goals == null || m.away_goals == null) continue;
    const emit = opts.fromIso == null || m.kickoff_utc >= opts.fromIso;
    if (emit) {
      const snap = builder.snapshot(
        m.competition_id,
        m.season_id,
        m.home_team_id,
        m.away_team_id,
        m.kickoff_utc,
      );
      const enoughHistory = snap.context.homeLast5.n >= minHist || snap.context.awayLast5.n >= minHist;
      if (enoughHistory) {
        const { home, away } = builder.ratingsFor(m.competition_id, m.home_team_id, m.away_team_id);
        rows.push({
          matchId: m.id,
          kickoff: m.kickoff_utc,
          competitionId: m.competition_id,
          seasonId: m.season_id,
          round: m.round,
          homeTeamId: m.home_team_id,
          awayTeamId: m.away_team_id,
          label: m.home_goals > m.away_goals ? 0 : m.home_goals === m.away_goals ? 1 : 2,
          homeGoals: m.home_goals,
          awayGoals: m.away_goals,
          x: snap.x,
          eloHomePre: home,
          eloAwayPre: away,
          leagueAvgGoalsPerTeam: builder.leagueAvgGoalsPerTeam(m.competition_id),
        });
      }
    }
    builder.consume(m);
  }
  return { rows, builder };
}

/** Convenience wrapper when the final builder state is not needed. */
export function buildTrainingRows(
  matches: MatchRow[],
  opts: { fromIso?: string; minHistoryMatches?: number } = {},
): TrainingRow[] {
  return buildRowsWithBuilder(matches, opts).rows;
}
