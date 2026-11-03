// Packages past general-election results (2020, 2022, 2024) from FiveThirtyEight's
// election-results repo (https://github.com/fivethirtyeight/election-results, CC BY 4.0)
// into public/data/past/{year}.json, shaped like civicAPI's regions so the site can
// draw them the same way:
//
//   { president?: Regions, senate: Regions, governor: Regions, house: Regions }
//   Regions = { [key]: { name, percent_reporting: 100, candidates: [{ name, party, votes, percent, winner }] } }
//
// Keys match civicAPI: "ga" for a state, "ga-special" for a special Senate race,
// "mi-07" / "ak-al" for House districts, "me-2" / "ne-2" for presidential districts.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'data', 'past');
const BASE = 'https://raw.githubusercontent.com/fivethirtyeight/election-results/main';
const YEARS = ['2020', '2022', '2024'];

const PARTY = {
  DEM: 'Democrat', REP: 'Republican', LIB: 'Libertarian', GRE: 'Green', IND: 'Independent',
  CON: 'Constitution', WFP: 'Working Families', NPA: 'No Party', UN: 'Unaffiliated', W: 'Write-in',
};

/** Minimal CSV parser that handles quoted fields. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

async function load(file) {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return parseCsv(await res.text()).filter(
    (r) => YEARS.includes(r.cycle) && STAGE_RANK[r.stage] && r.state_abbrev && r.candidate_name,
  );
}

// Louisiana's November election is a "jungle primary"; a December runoff follows if nobody
// gets a majority. Use the latest stage that happened.
const STAGE_RANK = { 'jungle primary': 1, general: 2, runoff: 3 };

/**
 * Groups result rows into one race per key, using the latest stage (see STAGE_RANK)
 * and the final round of ranked-choice counts.
 */
function build(rows, keyOf, nameOf) {
  const byYear = Object.fromEntries(YEARS.map((y) => [y, {}]));
  const groups = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    const id = `${r.cycle}|${key}`;
    const g = groups.get(id) ?? { year: r.cycle, key, rows: [] };
    g.rows.push(r);
    groups.set(id, g);
  }
  for (const { year, key, rows: rs } of groups.values()) {
    const stage = rs.reduce((best, r) => (STAGE_RANK[r.stage] > STAGE_RANK[best] ? r.stage : best), rs[0].stage);
    let pick = rs.filter((r) => r.stage === stage);
    const rounds = pick.map((r) => Number(r.ranked_choice_round) || 0);
    const last = Math.max(...rounds);
    if (last > 0) pick = pick.filter((r) => Number(r.ranked_choice_round) === last);
    // Collapse duplicate rows for the same candidate (e.g. fusion tickets), keeping the main party.
    const cands = new Map();
    for (const r of pick) {
      const votes = Number(r.votes) || 0;
      const c = cands.get(r.candidate_name);
      if (c) {
        c.votes += votes;
        c.winner ||= r.winner === 'true';
        if (r.ballot_party === 'DEM' || r.ballot_party === 'REP') c.party = PARTY[r.ballot_party];
      } else {
        cands.set(r.candidate_name, {
          name: r.candidate_name,
          party: PARTY[r.ballot_party] ?? (r.ballot_party || 'Other'),
          votes,
          winner: r.winner === 'true',
        });
      }
    }
    const list = [...cands.values()].sort((a, b) => b.votes - a.votes);
    const total = list.reduce((s, c) => s + c.votes, 0);
    for (const c of list) c.percent = total ? Math.round((c.votes / total) * 10000) / 100 : 0;
    byYear[year][key] = { name: nameOf(rs[0], key), percent_reporting: 100, candidates: list };
  }
  return byYear;
}

const state = (r) => r.state_abbrev.toLowerCase();

const [senateRows, govRows, houseRows, presRows] = await Promise.all([
  load('election_results_senate.csv'),
  load('election_results_gubernatorial.csv'),
  load('election_results_house.csv'),
  load('election_results_presidential.csv'),
]);

const senate = build(
  senateRows,
  (r) => `${state(r)}${r.special === 'true' ? '-special' : ''}`,
  (r) => `${r.state} U.S. Senate${r.special === 'true' ? ' (special)' : ''}`,
);
const governor = build(govRows, state, (r) => `${r.state} Governor`);

// States with a single district that cycle are at-large ("ak-al"), matching civicAPI and the maps.
const seatsPerState = {};
for (const r of houseRows) {
  if (r.special === 'true') continue;
  ((seatsPerState[r.cycle] ??= {})[r.state_abbrev] ??= new Set()).add(r.office_seat_name);
}
// Non-voting delegates (D.C., Puerto Rico, territories) don't count toward the 435.
const NON_VOTING = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP']);
const house = build(
  houseRows.filter((r) => r.special !== 'true' && !NON_VOTING.has(r.state_abbrev)),
  (r) => {
    const n = Number(r.office_seat_name.replace(/\D/g, ''));
    const atLarge = seatsPerState[r.cycle][r.state_abbrev].size === 1;
    return `${state(r)}-${atLarge ? 'al' : String(n).padStart(2, '0')}`;
  },
  (r, key) => `${r.state} ${key.endsWith('-al') ? 'at-large district' : `district ${Number(key.split('-')[1])}`}`,
);

// 538 codes Maine/Nebraska district results as M1, M2, N1, N2, N3.
const presKey = (r) => {
  const m = r.state_abbrev.match(/^([MN])(\d)$/);
  return m ? `${m[1] === 'M' ? 'me' : 'ne'}-${m[2]}` : r.state_abbrev === 'PR' ? null : state(r);
};
const president = build(presRows, presKey, (r, key) =>
  key.includes('-') ? `${key.startsWith('me') ? 'Maine' : 'Nebraska'} district ${key.split('-')[1]}` : r.state,
);

await mkdir(outDir, { recursive: true });
for (const y of YEARS) {
  const data = { senate: senate[y], governor: governor[y], house: house[y] };
  if (Object.keys(president[y]).length) data.president = president[y];
  await writeFile(join(outDir, `${y}.json`), JSON.stringify(data));
  console.log(
    `${y}: ${Object.keys(data.senate).length} senate, ${Object.keys(data.governor).length} governor, ` +
      `${Object.keys(data.house).length} house${data.president ? `, ${Object.keys(data.president).length} president` : ''}`,
  );
}
