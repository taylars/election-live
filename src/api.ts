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

/**
 * How long a civicAPI response is reused for page loads and view switches. Fresh data
 * comes from the poll and the Refresh button, which skip the cache and update it.
 */
export const CACHE_TTL_MS = 60 * 60_000;
/** How often the current view is refreshed from civicAPI. */
export const POLL_MS = 5 * 60_000;
const CACHE_PREFIX = 'civicapi:';

export interface Fetched<T> {
  data: T;
  fetchedAt: number;
}

function readCache<T>(key: string): Fetched<T> | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Fetched<T>) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, entry: Fetched<unknown>) {
  const value = JSON.stringify(entry);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Probably over quota: drop our older entries and try once more, then give up quietly.
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(key, value);
    } catch {
      // Storage unavailable; the response is still used, just not kept.
    }
  }
}

/**
 * Fetches JSON from civicAPI, reusing a localStorage copy younger than CACHE_TTL_MS
 * so reloads and view switches don't hit the API. `force` skips the cache (refresh, polls).
 */
async function cachedJson<T>(url: string, force = false): Promise<Fetched<T>> {
  const key = CACHE_PREFIX + url;
  if (!force) {
    const hit = readCache<T>(key);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`civicAPI ${url.replace(API, '')}: HTTP ${res.status}`);
  const entry = { data: (await res.json()) as T, fetchedAt: Date.now() };
  writeCache(key, entry);
  return entry;
}

export function getRace(id: number, force = false): Promise<Fetched<Race>> {
  return cachedJson<Race>(`${API}/race/${id}${TEST_DATA ? '?testdata' : ''}`, force);
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
    p = cachedJson<{ states?: Record<string, Rating> }>(`${API}/forecast/${chamber}/2026/civicapi`)
      .then((j) => j.data.states ?? {})
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

/** Display name for a party: "Democrat" rather than civicAPI's "Democratic". */
export function partyLabel(party: string): string {
  const s = side(party);
  return s === 'D' ? 'Democrat' : s === 'R' ? 'Republican' : party;
}

/** Past general-election results, built by scripts/build-past.mjs, shaped like civicAPI regions. */
export type PastYear = Partial<Record<'president' | 'senate' | 'governor' | 'house', Record<string, Region>>>;

const past = new Map<number, Promise<PastYear>>();

/** Past county results for one state: race key ("ga", "ga-special") → county FIPS → result. */
export type CountyResults = Record<string, Record<string, Region>>;

const countyResults = new Map<string, Promise<CountyResults>>();

/** Packaged by scripts/build-senate-counties.mjs; empty where a state has none. */
export function getCountyResults(race: string, year: number, postal: string): Promise<CountyResults> {
  const file = `${race}-${year}-${postal.toLowerCase()}`;
  let p = countyResults.get(file);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}data/counties/${file}.json`)
      .then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : {}))
      .catch(() => ({}));
    countyResults.set(file, p);
  }
  return p;
}

export function getPast(year: number): Promise<PastYear> {
  let p = past.get(year);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}data/past/${year}.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    past.set(year, p);
  }
  return p;
}
