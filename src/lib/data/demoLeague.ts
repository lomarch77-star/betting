/**
 * Demo dataset generator — DETERMINISTIC synthetic football universe.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  CLEARLY LABELLED DEMO DATA — is_demo = 1 on every row.            │
 * │  No external provider is contacted. Nothing here is real, live,    │
 * │  or scraped. The generator exists so the entire product (models,   │
 * │  calibration, pricing, backtests, UI) runs offline.                │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Why a synthetic universe is scientifically useful: every match is sampled
 * from KNOWN true probabilities (λ_home, λ_away are stored nowhere but the
 * sampler used them directly). That means calibration metrics, backtests and
 * closing-line behaviour can be validated against ground truth — something
 * impossible with real scraped data of unknown provenance.
 *
 * Determinism: identical (seed, anchorDate) ⇒ identical database, byte for
 * byte. All draws flow through Rng (mulberry32).
 */

import { Rng } from '@/lib/quant/random';
import { independentPoissonMatrix, dixonColesAdjust, deriveMarkets } from '@/lib/quant/poisson';

// ─── League definitions ──────────────────────────────────────────────────────

interface LeagueSpec {
  code: string;
  name: string;
  tier: number;
  homeLogAdv: number;
  baseGoals: number; // league average goals per team
  teams: string[];
}

export const LEAGUES: LeagueSpec[] = [
  {
    code: 'MPL',
    name: 'Meridian Premier League',
    tier: 1,
    homeLogAdv: 0.27,
    baseGoals: 1.38,
    teams: [
      'Harbor City', 'Kingswood Athletic', 'Northgate United', 'Ashford Rovers',
      'Castlefeld Town', 'Millbrook FC', 'Redford County', 'Stannmore Vale',
      'Brentvale United', 'Oaksbury FC', 'Westmere Albion', 'Dunloch Rangers',
      'Eastport City', 'Foxham Wanderers', 'Graveney Forest', 'Halwick Town',
    ],
  },
  {
    code: 'CL',
    name: 'Continental Liga',
    tier: 1,
    homeLogAdv: 0.24,
    baseGoals: 1.3,
    teams: [
      'Costa Azul CF', 'Monte Verde', 'Rio Surco', 'Valle Alto',
      'Puerto Norte', 'Cabo Blanco', 'Sierra Dorada', 'Litoral FC',
      'Club Estrella', 'Deportivo Almazar', 'Real Bermeja', 'Atletico Osona',
      'Union Cardona', 'Sporting Itzal', 'CD Nuria', 'Marbella Costa',
    ],
  },
];

const CITIES = [
  'Port Perin', 'Kestrel Bay', 'Alderpoint', 'Lowhaven', 'Forge End', 'Cranefield',
  'Saltmoor', 'Highcross', 'Wrenbury', 'Emberfalls', 'Stonebridge', 'Gullrock',
  'Thornwick', 'Cinderhall', 'Palewater', 'Ironhaven',
];

export interface BookmakerSpec {
  code: string;
  name: string;
  margin: number; // target overround on 1X2
  sharpness: number; // 0..1 — how close closing prices land to truth
}

export const BOOKMAKERS: BookmakerSpec[] = [
  { code: 'ATLAS', name: 'Atlas Price Co', margin: 0.025, sharpness: 0.9 },
  { code: 'MERIDIAN', name: 'Meridian Odds', margin: 0.048, sharpness: 0.65 },
  { code: 'CROWN', name: 'Crown Sportsbook', margin: 0.07, sharpness: 0.4 },
];

// ─── Generated artifacts ─────────────────────────────────────────────────────

export interface GeneratedTeam {
  name: string;
  short: string;
  city: string;
  venue: string;
  /** persistent ability, log space */
  attack: number;
  defence: number;
}

export interface GeneratedMatch {
  leagueCode: string;
  seasonCode: string;
  round: number;
  kickoff: string; // ISO
  homeTeam: string;
  awayTeam: string;
  status: 'FINISHED' | 'SCHEDULED';
  homeGoals: number | null;
  awayGoals: number | null;
  homeXg: number | null;
  awayXg: number | null;
  homeShots: number | null;
  awayShots: number | null;
  homeShotsOn: number | null;
  awayShotsOn: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  possessionHome: number | null;
  trueLambdas: { home: number; away: number } | null; // ground truth (never persisted)
}

export interface GeneratedOdds {
  leagueCode: string;
  seasonCode: string;
  round: number;
  kickoff: string;
  homeTeam: string;
  awayTeam: string;
  bookmakerCode: string;
  marketCode: 'ONE_X_TWO' | 'OU_GOALS' | 'BTTS';
  line: number | null;
  selection: string;
  odds: number;
  takenAt: string;
  kind: 'OPEN' | 'MID' | 'CLOSE';
}

export interface GeneratedUniverse {
  anchorIso: string;
  seasons: Array<{ leagueCode: string; code: string; start: string; end: string; status: 'FINISHED' | 'ACTIVE' }>;
  teams: Record<string, GeneratedTeam[]>; // by league code
  matches: GeneratedMatch[];
  odds: GeneratedOdds[];
}

const DAY = 86_400_000;

function iso(d: Date): string {
  return d.toISOString();
}

/** Second Saturday of August for season (year). Deterministic. */
function seasonStart(year: number): Date {
  const d = new Date(Date.UTC(year, 7, 1, 12, 0, 0));
  const day = d.getUTCDay();
  const toSat = (6 - day + 7) % 7;
  return new Date(d.getTime() + (toSat + 7) * DAY);
}

/** Round-robin (circle method) for n teams — deterministic pairing order. */
function roundRobinPairs(n: number): Array<Array<[number, number]>> {
  const rounds: Array<Array<[number, number]>> = [];
  const teams = Array.from({ length: n }, (_, i) => i);
  for (let r = 0; r < n - 1; r++) {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < n / 2; i++) {
      const a = teams[i];
      const b = teams[n - 1 - i];
      pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    teams.splice(1, 0, teams.pop()!);
  }
  return rounds;
}

function shortName(name: string): string {
  const first = name.replace(/[^A-Za-z ]/g, '').trim().split(/\s+/);
  const base = (first[0] ?? name).slice(0, 3).toUpperCase();
  return base;
}

/**
 * Build the full universe: 4 completed seasons + current season partially
 * played + several scheduled rounds after the anchor date.
 */
export function generateUniverse(seed: number, anchorIso: string): GeneratedUniverse {
  const rng = new Rng(seed);
  const anchor = new Date(anchorIso);
  const anchorMs = anchor.getTime();
  const anchorYear = anchor.getUTCFullYear();
  // current season starts the August on/before the anchor
  const currentStartYear =
    anchor.getUTCMonth() >= 6 ? anchorYear : anchorYear - 1;

  const seasonYears = [
    currentStartYear - 4,
    currentStartYear - 3,
    currentStartYear - 2,
    currentStartYear - 1,
    currentStartYear, // active
  ];

  const universe: GeneratedUniverse = {
    anchorIso: iso(anchor),
    seasons: [],
    teams: {},
    matches: [],
    odds: [],
  };

  for (const league of LEAGUES) {
    // Persistent team abilities (log space). Means ~0, spread tuned so the
    // best side is strongly but not absurdly superior.
    const teams: GeneratedTeam[] = league.teams.map((name, i) => ({
      name,
      short: shortName(name),
      city: CITIES[i],
      venue: `${name.split(' ')[0]} Park`,
      attack: rng.gaussian(0, 0.16),
      defence: rng.gaussian(0, 0.16),
    }));
    universe.teams[league.code] = teams;

    // Centre abilities
    const mA = teams.reduce((a, t) => a + t.attack, 0) / teams.length;
    const mD = teams.reduce((a, t) => a + t.defence, 0) / teams.length;
    for (const t of teams) {
      t.attack -= mA;
      t.defence -= mD;
    }

    const schedule = roundRobinPairs(teams.length);

    for (let s = 0; s < seasonYears.length; s++) {
      const year = seasonYears[s];
      const isActive = s === seasonYears.length - 1;
      const start = seasonStart(year);
      const seasonCode = `${year}-${String(year + 1).slice(2)}`;
      const roundsTotal = 2 * (teams.length - 1); // double round robin

      // per-season ability drift
      const drift = teams.map((t) => ({
        attack: t.attack + rng.gaussian(0, 0.05),
        defence: t.defence + rng.gaussian(0, 0.05),
      }));
      const md = drift.reduce((a, t) => a + t.defence, 0) / drift.length;
      const ma = drift.reduce((a, t) => a + t.attack, 0) / drift.length;
      for (const d of drift) {
        d.attack -= ma;
        d.defence -= md;
      }

      const fixturesRng = new Rng(seed * 31 + s * 7 + league.code.charCodeAt(0));

      // Round calendar: weekly with two deterministic "international breaks"
      const roundDates: number[] = [];
      let cursor = start.getTime();
      for (let r = 0; r < roundsTotal; r++) {
        roundDates.push(cursor);
        cursor += (r === 7 || r === 18 ? 14 : 7) * DAY;
      }
      const seasonEnd = iso(new Date(roundDates[roundsTotal - 1] + 6 * DAY));

      universe.seasons.push({
        leagueCode: league.code,
        code: seasonCode,
        start: iso(start),
        end: seasonEnd,
        status: isActive ? 'ACTIVE' : 'FINISHED',
      });

      for (let half = 0; half < 2; half++) {
        for (let r = 0; r < schedule.length; r++) {
          const roundNum = half * schedule.length + r;
          const matchDate = roundDates[roundNum];
          for (const [ai, bi] of schedule[r]) {
            const [homeIdx, awayIdx] = half === 0 ? [ai, bi] : [bi, ai];
            const kickoff = new Date(
              matchDate +
                fixturesRng.int(-1, 1) * DAY +
                fixturesRng.pick([12, 14, 15, 17, 19]) * 3_600_000,
            );
            if (kickoff.getTime() >= anchorMs && !isActive) continue;
            const finished = kickoff.getTime() < anchorMs;
            // scheduled window: include up to ~6 rounds ahead
            if (!finished && kickoff.getTime() > anchorMs + 45 * DAY) continue;

            const home = teams[homeIdx];
            const away = teams[awayIdx];
            const hd = drift[homeIdx];
            const ad = drift[awayIdx];
            const lambdaHome = Math.exp(
              Math.log(league.baseGoals) + league.homeLogAdv + hd.attack - ad.defence,
            );
            const lambdaAway = Math.exp(Math.log(league.baseGoals) + ad.attack - hd.defence);

            let match: GeneratedMatch;
            if (finished) {
              const hg = fixturesRng.poisson(lambdaHome);
              const ag = fixturesRng.poisson(lambdaAway);
              match = {
                leagueCode: league.code,
                seasonCode,
                round: roundNum + 1,
                kickoff: iso(kickoff),
                homeTeam: home.name,
                awayTeam: away.name,
                status: 'FINISHED',
                homeGoals: hg,
                awayGoals: ag,
                homeXg: round2(clamp(lambdaHome + fixturesRng.gaussian(0, 0.32), 0.05, 7.5)),
                awayXg: round2(clamp(lambdaAway + fixturesRng.gaussian(0, 0.32), 0.05, 7.5)),
                homeShots: Math.max(1, Math.round(7.5 + 2.9 * lambdaHome + fixturesRng.gaussian(0, 2.1))),
                awayShots: Math.max(1, Math.round(7.5 + 2.9 * lambdaAway + fixturesRng.gaussian(0, 2.1))),
                homeShotsOn: 0,
                awayShotsOn: 0,
                homeCorners: Math.max(0, Math.round(3.4 + 2.6 * lambdaHome + fixturesRng.gaussian(0, 1.6))),
                awayCorners: Math.max(0, Math.round(3.4 + 2.6 * lambdaAway + fixturesRng.gaussian(0, 1.6))),
                possessionHome: round2(
                  clamp(0.5 + 0.11 * (hd.attack - ad.attack) + fixturesRng.gaussian(0, 0.05), 0.22, 0.78),
                ),
                trueLambdas: { home: lambdaHome, away: lambdaAway },
              };
              match.homeShotsOn = Math.min(
                match.homeShots!,
                Math.max(match.homeGoals!, Math.round(match.homeShots! * (0.3 + 0.05 * lambdaHome))),
              );
              match.awayShotsOn = Math.min(
                match.awayShots!,
                Math.max(match.awayGoals!, Math.round(match.awayShots! * (0.3 + 0.05 * lambdaAway))),
              );
            } else {
              match = {
                leagueCode: league.code,
                seasonCode,
                round: roundNum + 1,
                kickoff: iso(kickoff),
                homeTeam: home.name,
                awayTeam: away.name,
                status: 'SCHEDULED',
                homeGoals: null,
                awayGoals: null,
                homeXg: null,
                awayXg: null,
                homeShots: null,
                awayShots: null,
                homeShotsOn: null,
                awayShotsOn: null,
                homeCorners: null,
                awayCorners: null,
                possessionHome: null,
                trueLambdas: { home: lambdaHome, away: lambdaAway },
              };
            }
            universe.matches.push(match);
            universe.odds.push(
              ...generateOdds(fixturesRng, match, lambdaHome, lambdaAway, anchorMs),
            );
          }
        }
      }
    }
  }

  universe.matches.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  return universe;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Bookmaker prices derived from the TRUE distribution, then corrupted by the
 * book's margin, pricing noise, and a closing-line drift toward truth scaled
 * by the book's sharpness. Produces OPEN / MID / CLOSE timestamps relative
 * to kickoff.
 */
function generateOdds(
  rng: Rng,
  match: GeneratedMatch,
  lambdaH: number,
  lambdaA: number,
  anchorMs: number,
): GeneratedOdds[] {
  const kickoffMs = Date.parse(match.kickoff);
  const matrix = dixonColesAdjust(independentPoissonMatrix(lambdaH, lambdaA, 11), lambdaH, lambdaA, -0.055);
  const markets = deriveMarkets(matrix, { ouLines: [2.5], ahLines: [], topScores: 4 });
  const trueP: Record<string, number> = {
    HOME: markets.oneXTwo.home,
    DRAW: markets.oneXTwo.draw,
    AWAY: markets.oneXTwo.away,
    OVER: markets.overUnder[0].over,
    UNDER: markets.overUnder[0].under,
    YES: markets.btts.yes,
    NO: markets.btts.no,
  };

  const out: GeneratedOdds[] = [];
  for (const book of BOOKMAKERS) {
    const emit = (
      marketCode: 'ONE_X_TWO' | 'OU_GOALS' | 'BTTS',
      line: number | null,
      selections: string[],
      snapshots: Array<{ kind: 'OPEN' | 'MID' | 'CLOSE'; offsetMs: number; noise: number; drift: number }>,
    ) => {
      for (const snap of snapshots) {
        const takenAt = new Date(kickoffMs - snap.offsetMs);
        if (takenAt.getTime() >= anchorMs && match.status === 'FINISHED') continue;
        if (takenAt.getTime() >= anchorMs) {
          // future snapshot times on scheduled matches: only OPEN (already priced)
          if (snap.kind !== 'OPEN') continue;
        }
        // per-book perceived probabilities: truth + market noise, drifted at close
        const margin = book.margin * (1 + rng.gaussian(0, 0.06));
        const implied: Record<string, number> = {};
        let total = 0;
        for (const sel of selections) {
          const noiseP = trueP[sel] * (1 + rng.gaussian(0, snap.noise));
          const drifted = (1 - snap.drift) * noiseP + snap.drift * trueP[sel];
          implied[sel] = drifted;
          total += drifted;
        }
        // apply margin via proportional inflation
        for (const sel of selections) {
          implied[sel] = (implied[sel] / total) * (1 + margin);
          const odds = roundToTick(1 / implied[sel]);
          out.push({
            leagueCode: match.leagueCode,
            seasonCode: match.seasonCode,
            round: match.round,
            kickoff: match.kickoff,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            bookmakerCode: book.code,
            marketCode,
            line,
            selection: sel,
            odds,
            takenAt: iso(takenAt),
            kind: snap.kind,
          });
        }
      }
    };

    emit('ONE_X_TWO', null, ['HOME', 'DRAW', 'AWAY'], [
      { kind: 'OPEN', offsetMs: 7 * DAY, noise: 0.09, drift: 0 },
      { kind: 'MID', offsetMs: 26 * 3_600_000, noise: 0.05, drift: 0.55 * book.sharpness },
      { kind: 'CLOSE', offsetMs: 12 * 60_000, noise: 0.02, drift: 0.9 * book.sharpness },
    ]);
    emit('OU_GOALS', 2.5, ['OVER', 'UNDER'], [
      { kind: 'OPEN', offsetMs: 7 * DAY, noise: 0.08, drift: 0 },
      { kind: 'MID', offsetMs: 26 * 3_600_000, noise: 0.045, drift: 0.55 * book.sharpness },
      { kind: 'CLOSE', offsetMs: 12 * 60_000, noise: 0.02, drift: 0.9 * book.sharpness },
    ]);
    emit('BTTS', null, ['YES', 'NO'], [
      { kind: 'OPEN', offsetMs: 7 * DAY, noise: 0.08, drift: 0 },
      { kind: 'CLOSE', offsetMs: 12 * 60_000, noise: 0.02, drift: 0.9 * book.sharpness },
    ]);
  }
  return out;
}

/** Realistic bookmaker rounding ticks. */
function roundToTick(odds: number): number {
  const rounded = odds < 3 ? Math.round(odds * 100) / 100 : odds < 10 ? Math.round(odds * 20) / 20 : Math.round(odds * 2) / 2;
  return Math.max(1.05, Math.min(rounded, 81));
}
