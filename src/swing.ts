// Swing: how much each place has moved, D minus R, against a baseline election.

import { side, type Candidate, type PastResult } from './api';
import { RACE_LABEL, YEARS, type RaceKind } from './elections';

/** A past election to compare against, e.g. the 2024 presidential race. */
export interface Baseline {
  race: RaceKind;
  year: number;
}

export const baselineId = (b: Baseline) => `${b.race}-${b.year}`;

export function baselineLabel(b: Baseline, short = false): string {
  const race = short ? { president: 'Pres', senate: 'Sen', governor: 'Gov', house: 'House' }[b.race] : RACE_LABEL[b.race];
  return `${b.year} ${race}`;
}

/**
 * What a race can be compared against: earlier presidential races (every county has
 * one) and earlier races for the same office. The House compares district by district,
 * so only earlier House races.
 */
export function baselineOptions(race: RaceKind, year: number): Baseline[] {
  const earlier = (r: RaceKind) => YEARS[r].filter((y) => y < year).map((y) => ({ race: r, year: y }));
  if (race === 'house') return earlier('house');
  if (race === 'president') return earlier('president');
  return [...earlier('president'), ...earlier(race)];
}

export function parseBaseline(id: string | null | undefined, race: RaceKind, year: number): Baseline | undefined {
  return baselineOptions(race, year).find((b) => baselineId(b) === id);
}

/**
 * Democratic, Republican and total votes, or null unless both a Democrat and a
 * Republican ran and votes are in: an uncontested race has no meaningful swing.
 */
export function toDR(cands: Candidate[]): PastResult | null {
  let d = 0, r = 0, t = 0, hasD = false, hasR = false;
  for (const c of cands) {
    const s = side(c.party);
    if (s === 'D') { d += c.votes; hasD = true; }
    if (s === 'R') { r += c.votes; hasR = true; }
    t += c.votes;
  }
  return hasD && hasR && t > 0 ? { d, r, t } : null;
}

/** D-minus-R margin as a share of all votes. */
export const margin = (p: PastResult) => (p.d - p.r) / p.t;

export interface AreaSwing {
  /** Vote-weighted average shift in the matched areas (positive = toward Democrats). */
  swing: number;
  /** Areas with results in both elections. */
  matched: number;
  /** Votes counted now in the matched areas (the weights). */
  votes: number;
}

/**
 * Average shift across areas (counties or districts) found in both elections, each
 * weighted by its votes now. Comparing area by area means an early count from friendly
 * territory doesn't look like a swing.
 */
export function areaSwing(now: Iterable<[string, PastResult]>, base: Record<string, PastResult>): AreaSwing | null {
  let sum = 0, votes = 0, matched = 0;
  for (const [id, cur] of now) {
    const b = base[id];
    if (!b || !cur.t || !b.t) continue;
    sum += (margin(cur) - margin(b)) * cur.t;
    votes += cur.t;
    matched++;
  }
  return votes ? { swing: sum / votes, matched, votes } : null;
}

/** Signed shift as "D+2.3" or "R+1.0"; "Even" under 0.05 points. */
export function fmtSwing(s: number): string {
  if (Math.abs(s) < 0.0005) return 'Even';
  return `${s > 0 ? 'D' : 'R'}+${(Math.abs(s) * 100).toFixed(1)}`;
}
