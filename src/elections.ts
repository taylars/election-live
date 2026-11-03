// Fixed facts about the elections the site covers.

import type { Side } from './api';

export type RaceKind = 'president' | 'senate' | 'governor' | 'house';

export const LIVE_YEAR = 2026;

/** Years each race can be shown for, newest first. */
export const YEARS: Record<RaceKind, number[]> = {
  president: [2024, 2020],
  senate: [2026, 2024, 2022, 2020],
  governor: [2026, 2024, 2022, 2020],
  house: [2026, 2024, 2022, 2020],
};
export const ALL_YEARS = [2026, 2024, 2022, 2020];

export const RACE_LABEL: Record<RaceKind, string> = {
  president: 'President', senate: 'Senate', governor: 'Governor', house: 'House',
};

/** Electoral votes by state: 2024 uses the 2020 census apportionment, 2020 the 2010 one. */
const EV_2024: Record<string, number> = {
  AL: 9, AK: 3, AZ: 11, AR: 6, CA: 54, CO: 10, CT: 7, DE: 3, DC: 3, FL: 30, GA: 16, HI: 4, ID: 4, IL: 19,
  IN: 11, IA: 6, KS: 6, KY: 8, LA: 8, ME: 4, MD: 10, MA: 11, MI: 15, MN: 10, MS: 6, MO: 10, MT: 4, NE: 5,
  NV: 6, NH: 4, NJ: 14, NM: 5, NY: 28, NC: 16, ND: 3, OH: 17, OK: 7, OR: 8, PA: 19, RI: 4, SC: 9, SD: 3,
  TN: 11, TX: 40, UT: 6, VT: 3, VA: 13, WA: 12, WV: 4, WI: 10, WY: 3,
};
const EV_2020: Record<string, number> = {
  ...EV_2024, CA: 55, CO: 9, FL: 29, IL: 20, MI: 16, MT: 3, NY: 29, NC: 15, OH: 18, OR: 7, PA: 20, TX: 38, WV: 5,
};
export const ELECTORAL_VOTES: Record<number, Record<string, number>> = { 2024: EV_2024, 2020: EV_2020 };

/**
 * Electoral votes decided by one result key. Maine and Nebraska give 2 votes to the
 * statewide winner ("me") and 1 per congressional district ("me-2").
 */
export function electoralVotes(year: number, key: string): number {
  if (key.includes('-')) return 1;
  const postal = key.toUpperCase();
  if (postal === 'ME' || postal === 'NE') return 2;
  return ELECTORAL_VOTES[year]?.[postal] ?? 0;
}

/**
 * Chamber make-up as seated the January after each past election. The past-results
 * data only covers the seats up that year, so the rest comes from here.
 * Independents (who caucus with Democrats in the Senate) are in O.
 */
export const SEATED: Record<'senate' | 'governor', Record<number, Record<Side, number>>> = {
  senate: {
    2020: { D: 48, R: 50, O: 2 },
    2022: { D: 48, R: 49, O: 3 },
    2024: { D: 45, R: 53, O: 2 },
  },
  governor: {
    2020: { D: 23, R: 27, O: 0 },
    2022: { D: 24, R: 26, O: 0 },
    2024: { D: 23, R: 27, O: 0 },
  },
};
