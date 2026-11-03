import type { Candidate, PastResult } from './api';
import { side } from './api';

export const PARTY = { D: '#2f6fe0', R: '#e0393e', O: '#a173e0' };
export const NO_DATA = '#353c4a';
export const NO_RACE = '#1d222c';
const BASE = '#2b313d';

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Blends a party colour into the base map colour; strength 0 = base, 1 = full colour. */
export function tint(color: string, strength: number): string {
  const s = Math.max(0, Math.min(1, strength));
  const a = hex(BASE);
  const b = hex(color);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * s)).join(',')})`;
}

export function partyColor(c: Pick<Candidate, 'party' | 'color'>): string {
  const s = side(c.party);
  return s === 'O' ? c.color || PARTY.O : PARTY[s];
}

export function ranked(cands: Candidate[]): Candidate[] {
  return [...cands].sort((a, b) => b.votes - a.votes);
}

/**
 * Leader's colour shaded by the size of the lead. With `showCalls`, a called race
 * is drawn solid instead (counties pass false: their "winner" flag isn't a call).
 */
export function liveFill(cands: Candidate[], showCalls = true): string | null {
  const [a, b] = ranked(cands);
  const total = cands.reduce((s, c) => s + c.votes, 0);
  if (!a || total === 0) return null;
  const winner = showCalls && cands.find((c) => c.winner);
  if (winner) return partyColor(winner);
  const margin = (a.votes - (b?.votes ?? 0)) / total;
  return tint(partyColor(a), (showCalls ? 0.3 : 0.25) + (showCalls ? 0.5 : 0.75) * Math.min(1, margin / 0.4));
}

/** D-minus-R margin as a share of all votes (positive = Democratic lead). */
export function liveMargin(cands: Candidate[]): number | null {
  const total = cands.reduce((s, c) => s + c.votes, 0);
  if (total === 0) return null;
  const d = cands.filter((c) => side(c.party) === 'D').reduce((s, c) => s + c.votes, 0);
  const r = cands.filter((c) => side(c.party) === 'R').reduce((s, c) => s + c.votes, 0);
  return (d - r) / total;
}

export function pastMargin(p: PastResult): number {
  return (p.d - p.r) / p.t;
}

export function marginFill(m: number): string {
  return tint(m >= 0 ? PARTY.D : PARTY.R, 0.25 + 0.75 * Math.min(1, Math.abs(m) / 0.4));
}

export function shiftFill(delta: number): string {
  return tint(delta >= 0 ? PARTY.D : PARTY.R, 0.15 + 0.85 * Math.min(1, Math.abs(delta) / 0.15));
}

const RATING_STRENGTH: Record<string, number> = { Safe: 0.55, Likely: 0.42, Lean: 0.3, Tilt: 0.2 };

/** Pre-results colouring from a forecast rating like "Lean R" or "Toss-up". */
export function ratingFill(rating: string | undefined): string | null {
  if (!rating) return null;
  const [level, who] = rating.split(' ');
  const strength = RATING_STRENGTH[level];
  if (!strength || (who !== 'D' && who !== 'R')) return '#5b5540';
  return tint(PARTY[who], strength);
}

export function fmtMargin(m: number): string {
  return `${m >= 0 ? 'D' : 'R'}+${(Math.abs(m) * 100).toFixed(1)}`;
}
