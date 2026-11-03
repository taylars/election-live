// Turns each race into a projection tier (secured / likely / lean / toss-up)
// and rolls them up into a projected seat tally.
//
// Before votes, the tier comes from civicAPI's forecast rating. Once enough of
// the vote is in, it comes from the live margin, weighed against how much of
// the vote is still out, so races firm up (or loosen) as the night goes on.

import { side, type Candidate, type Rating, type Region, type Side } from './api';

export type Level = 'secured' | 'likely' | 'lean' | 'tossup';

export interface Projection {
  side: Side | null; // null for a toss-up
  level: Level;
  source: 'call' | 'live' | 'forecast' | 'none';
}

/** Below this share reporting, early returns are too lopsided to trust over the forecast. */
export const MIN_REPORTING = 15;
/** Thresholds on the margin divided by the square root of the share still out. */
const LIKELY = 0.15;
const LEAN = 0.05;

export function projectRace(cands: Candidate[], reporting: number, rating?: string): Projection {
  const winner = cands.find((c) => c.winner);
  if (winner) return { side: side(winner.party), level: 'secured', source: 'call' };

  const total = cands.reduce((s, c) => s + c.votes, 0);
  if (total > 0 && reporting >= MIN_REPORTING) {
    const [a, b] = [...cands].sort((x, y) => y.votes - x.votes);
    const margin = (a.votes - (b?.votes ?? 0)) / total;
    const outstanding = Math.max(0, 1 - reporting / 100);
    // The more of the vote is still out, the bigger a lead has to be to mean much.
    const strength = margin / Math.sqrt(outstanding + 0.01);
    const level: Level = strength >= LIKELY ? 'likely' : strength >= LEAN ? 'lean' : 'tossup';
    return { side: level === 'tossup' ? null : side(a.party), level, source: 'live' };
  }

  return fromRating(rating);
}

function fromRating(rating?: string): Projection {
  const [tier, who] = (rating ?? '').split(' ');
  if (who !== 'D' && who !== 'R') return { side: null, level: 'tossup', source: rating ? 'forecast' : 'none' };
  const level: Level = tier === 'Safe' || tier === 'Likely' ? 'likely' : 'lean'; // Lean and Tilt
  return { side: who, level, source: 'forecast' };
}

export function projectionLabel(p: Projection): string {
  if (p.level === 'tossup') return 'Toss-up';
  if (p.level === 'secured') return `Called ${p.side}`;
  return `${p.level === 'likely' ? 'Likely' : 'Lean'} ${p.side}`;
}

export type Tally = Record<Side, Record<Exclude<Level, 'tossup'>, number>> & { tossup: number };

/**
 * Adds up a chamber. `holdovers` are seats not up this year, which count as secured.
 * `forecast` is keyed by upper-cased region key ("GA", "MI-07").
 */
export function tally(
  regions: Record<string, Region>,
  forecast: Record<string, Rating>,
  holdovers: Record<Side, number>,
): Tally {
  const t: Tally = {
    D: { secured: holdovers.D, likely: 0, lean: 0 },
    R: { secured: holdovers.R, likely: 0, lean: 0 },
    O: { secured: holdovers.O, likely: 0, lean: 0 },
    tossup: 0,
  };
  for (const [key, reg] of Object.entries(regions)) {
    const p = projectRace(reg.candidates, reg.percent_reporting, forecast[key.toUpperCase()]?.rating);
    if (p.level === 'tossup' || !p.side) t.tossup++;
    else t[p.side][p.level]++;
  }
  return t;
}

export const projected = (t: Tally, s: Side) => t[s].secured + t[s].likely + t[s].lean;
