// civicAPI client (https://civicapi.org) plus the static history files built by
// scripts/build-history.mjs.

const API = 'https://civicapi.org/api/v2';

export interface Candidate {
  name: string;
  party: string;
  color: string;
  votes: number;
  percent: number;
  winner: boolean;
  incumbent?: boolean;
  seats?: number;
}

export interface Region {
  name: string;
  type: string;
  fips?: string;
  election_id?: number;
  percent_reporting: number;
  candidates: Candidate[];
}

export interface Race {
  election_name: string;
  election_type: string;
  election_date: string;
  province: string | null;
  percent_reporting: number;
  last_updated: string;
  polls_close: string | null;
  is_disputed: boolean;
  test_data: boolean;
  candidates: Candidate[];
  region_results?: Record<string, Region>;
}

export type Chamber = 'senate' | 'governor' | 'house';

/** civicAPI's national roll-up races: one region per state (or district) with that race's election_id. */
export const NATIONAL_RACE: Record<Chamber, number> = { senate: 87528, governor: 87535, house: 87524 };

export const CHAMBER: Record<Chamber, { label: string; total: number; majority?: number; unit: string }> = {
  senate: { label: 'Senate', total: 100, majority: 51, unit: 'seats' },
  governor: { label: 'Governor', total: 50, unit: 'governorships' },
  house: { label: 'House', total: 435, majority: 218, unit: 'seats' },
};

/** Add ?testdata to the page URL to have civicAPI fill races with simulated votes. */
export const TEST_DATA = new URLSearchParams(location.search).has('testdata');

export async function getRace(id: number): Promise<Race> {
  const res = await fetch(`${API}/race/${id}${TEST_DATA ? '?testdata' : ''}`);
  if (!res.ok) throw new Error(`civicAPI race ${id}: HTTP ${res.status}`);
  return res.json();
}

export interface Rating {
  rating: string;
  incumbent_party: string;
}

const forecasts = new Map<Chamber, Promise<Record<string, Rating>>>();

/**
 * civicAPI's own pre-election ratings, keyed by upper-case postal code
 * ("MI"), or by district for the House ("MI-07"). Empty if unavailable.
 */
export function getForecast(chamber: Chamber): Promise<Record<string, Rating>> {
  let p = forecasts.get(chamber);
  if (!p) {
    p = fetch(`${API}/forecast/${chamber}/2026/civicapi`)
      .then((r) => (r.ok ? r.json() : { states: {} }))
      .then((j) => j.states ?? {})
      .catch(() => ({}));
    forecasts.set(chamber, p);
  }
  return p;
}

/** Presidential totals: Democratic, Republican and all votes. */
export interface PastResult {
  d: number;
  r: number;
  t: number;
}
export type History = Record<string, Record<string, PastResult>>; // year -> fips -> result

const history = new Map<string, Promise<History>>();

/** `national` gives state totals keyed by state FIPS; a state FIPS gives county totals. */
export function getHistory(scope: 'national' | string): Promise<History> {
  let p = history.get(scope);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}data/history/${scope}.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    history.set(scope, p);
  }
  return p;
}

export type Side = 'D' | 'R' | 'O';

export function side(party: string): Side {
  const p = party.toLowerCase();
  if (p.startsWith('democrat')) return 'D';
  if (p.startsWith('republican')) return 'R';
  return 'O';
}
