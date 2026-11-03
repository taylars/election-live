// Packages county-level results for past Senate and Governor races into
// public/data/counties/{race}-{year}-{st}.json, shaped like civicAPI regions:
//
//   { [raceKey]: { [countyFips]: { name, percent_reporting: 100, candidates: [...] } } }
//
// raceKey matches public/data/past/{year}.json ("ga", "ga-special").
//
// Sources:
//   2022, 2024: MIT Election Data + Science Lab official returns on GitHub (MEDSL/20xx-elections-official):
//               the 2024 Senate county file, otherwise per-state precinct files summed to counties.
//   2020:       OpenElections (github.com/openelections), per-state county or precinct files.
//               (MIT's 2020 files are on Harvard Dataverse behind an institutional sign-in.)
//
// Every race is checked against the statewide result in public/data/past (built by
// `npm run past`): if its county totals for the top two candidates are more than 1% off,
// it's left out and the site shows the statewide result instead. Candidate names and
// parties are taken from those statewide results so they match the rest of the site.
//
// Usage: node scripts/build-counties.mjs [year] [senate|governor]

import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(root, 'data-raw');
const outDir = join(root, 'public', 'data', 'counties');
const GITHUB = 'https://raw.githubusercontent.com';

const OFFICES = {
  senate: { medsl: 'US SENATE', other: /^(u\.?\s?s\.?\s+senat(e|or)|united states senat(e|or))\b/i },
  governor: { medsl: 'GOVERNOR', other: /^governor\b(?!.*lieutenant)/i },
};

const STATE_FIPS = {
  al: '01', ak: '02', az: '04', ar: '05', ca: '06', co: '08', ct: '09', de: '10', fl: '12', ga: '13', hi: '15',
  id: '16', il: '17', in: '18', ia: '19', ks: '20', ky: '21', la: '22', me: '23', md: '24', ma: '25', mi: '26',
  mn: '27', ms: '28', mo: '29', mt: '30', ne: '31', nv: '32', nh: '33', nj: '34', nm: '35', ny: '36', nc: '37',
  nd: '38', oh: '39', ok: '40', or: '41', pa: '42', ri: '44', sc: '45', sd: '46', tn: '47', tx: '48', ut: '49',
  vt: '50', va: '51', wa: '53', wv: '54', wi: '55', wy: '56',
};

const SKIP_CANDIDATE = /^(total|totals|over ?votes?|under ?votes?|registered|ballots|times cast|blank|scattering|write[- ]?ins?|undervotes?|overvotes?|rejected|void)\b/i;

// ---------- helpers ----------

/** Splits one CSV line, honouring quoted fields. */
function splitCsv(line) {
  const out = [];
  let field = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

/** Streams a CSV file, calling `onRow` with an object per row (column names lower-cased). */
async function eachRow(file, onRow) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let cols;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const f = splitCsv(line);
    if (!cols) { cols = f.map((c) => c.trim().toLowerCase()); continue; }
    onRow(Object.fromEntries(cols.map((c, i) => [c, f[i]])));
  }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** Downloads once into data-raw; returns false on a 404. */
async function download(url, dest) {
  if (await exists(dest)) return true;
  const res = await fetch(url);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function unzipCsvs(zip, dir) {
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  const out = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (e.name.endsWith('.csv') && !e.name.startsWith('._')) out.push(join(d, e.name));
    }
  };
  await walk(dir);
  return out;
}

const countyKey = (name) =>
  name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+(county|parish|borough|census area|municipality|city and borough)$/, '')
    .replace(/&/g, 'and').replace(/^saint /, 'st ').replace(/[^a-z]/g, '')
    .replace(/^jeffdavis$/, 'jeffersondavis');

/**
 * Election authorities in 2020 OpenElections files that aren't counties, mapped to the
 * county they sit in (Illinois and Missouri cities that count their own votes).
 */
const CITY_IN_COUNTY = {
  il: { cityofchicago: '17031', cityofbloomington: '17113', cityofeaststlouis: '17163', cityofrockford: '17201', cityofdanville: '17183', cityofgalesburg: '17095', cityofaurora: '17089' },
  mo: { kansascity: '29095' },
};

/** County name → FIPS within each state, from the same us-atlas shapes the site draws. */
async function countyLookup() {
  const topo = JSON.parse(await readFile(join(root, 'node_modules', 'us-atlas', 'counties-10m.json'), 'utf8'));
  const map = new Map();
  for (const f of feature(topo, topo.objects.counties).features) {
    // Independent cities (e.g. St. Louis city, 29510) share a name with a county; key them as "...city".
    const independentCity = Number(f.id.slice(2)) >= 500;
    map.set(`${f.id.slice(0, 2)}|${countyKey(f.properties.name)}${independentCity ? 'city' : ''}`, f.id);
  }
  return (st, name) => {
    const key = countyKey(name);
    return CITY_IN_COUNTY[st]?.[key] ?? map.get(`${STATE_FIPS[st]}|${key}`) ?? map.get(`${STATE_FIPS[st]}|${key.replace(/city$/, '')}`);
  };
}

// ---------- tallying ----------

const COUNTY_TOTAL = /^COUNTY TOTAL$/i;

/**
 * Collects votes per race / county / precinct / candidate, then sums to counties.
 * Within a precinct, a TOTAL row is used where present and per-method rows are summed
 * otherwise. Where a county's "COUNTY TOTAL" rows repeat its precincts (Idaho, and county
 * subtotal rows in some 2020 files), only the totals are used. A runoff replaces the general election it followed (Georgia).
 */
function makeTally() {
  const cells = new Map();
  const stages = new Map();
  return {
    /** row: { race, stage, fips, precinct, candidate, party, votes, total } */
    add(r) {
      if (!r.fips || !r.candidate || SKIP_CANDIDATE.test(r.candidate.trim())) return;
      (stages.get(r.race) ?? stages.set(r.race, new Set()).get(r.race)).add(r.stage);
      const key = [r.race, r.stage, r.fips, r.precinct ?? '', r.candidate.trim()].join('|');
      const c = cells.get(key) ?? { total: null, modes: 0, party: r.party };
      if (r.total) c.total = (c.total ?? 0) + r.votes;
      else c.modes += r.votes;
      cells.set(key, c);
    },
    result() {
      const keep = [];
      // Per race|county: votes in COUNTY TOTAL rows vs in the other rows.
      const sums = new Map();
      for (const [key, c] of cells) {
        const [race, stage, fips, precinct, candidate] = key.split('|');
        if (stage !== (stages.get(race).has('GEN RUNOFF') ? 'GEN RUNOFF' : 'GEN')) continue;
        const votes = c.total ?? c.modes;
        const s = sums.get(`${race}|${fips}`) ?? { countyTotal: 0, rest: 0 };
        if (COUNTY_TOTAL.test(precinct)) s.countyTotal += votes;
        else s.rest += votes;
        sums.set(`${race}|${fips}`, s);
        keep.push({ race, fips, precinct, candidate, party: c.party, votes });
      }
      // COUNTY TOTAL rows replace the precincts only when they repeat them (same total);
      // otherwise they're a real precinct that happens to share the county's name.
      const useCountyTotal = (race, fips) => {
        const s = sums.get(`${race}|${fips}`);
        return s.countyTotal > 0 && (s.rest === 0 || Math.abs(s.rest - s.countyTotal) <= s.countyTotal * 0.02);
      };
      const counties = new Map();
      for (const k of keep) {
        if (useCountyTotal(k.race, k.fips) && !COUNTY_TOTAL.test(k.precinct)) continue;
        const id = `${k.race}|${k.fips}|${k.candidate}`;
        const row = counties.get(id) ?? { ...k, votes: 0 };
        row.votes += k.votes;
        counties.set(id, row);
      }
      const out = {};
      for (const r of counties.values()) {
        ((out[r.race] ??= {})[r.fips] ??= []).push({ candidate: r.candidate, party: r.party, votes: r.votes });
      }
      return out;
    },
  };
}

const plain = (n) => n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const lastName = (n) => plain(n).replace(/\s+(jr|sr|ii|iii|iv)$/, '').split(' ').at(-1);
/**
 * Whether a source candidate string names this statewide candidate: its last name appears
 * as a whole word (handles "MEHMET C OZ", "Ben David" for "Ben-David", and joint tickets
 * like "Doug Burgum and Brent Sanford").
 */
const sameCandidate = (known, source) => plain(source).split(' ').includes(lastName(known));
const titleCase = (n) => n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Converts tallies to regions, borrowing statewide names/parties; keeps only races that check out. */
function finish(tallies, statewide, label) {
  const byState = {};
  for (const [race, counties] of Object.entries(tallies)) {
    const known = statewide[race]?.candidates ?? [];
    const regions = {};
    for (const [fips, rows] of Object.entries(counties)) {
      const merged = new Map();
      for (const r of rows) {
        const match = known.find((k) => sameCandidate(k.name, r.candidate));
        const name = match?.name ?? titleCase(r.candidate);
        const m = merged.get(name) ?? { name, party: match?.party ?? titleCase(r.party || 'Other'), votes: 0 };
        m.votes += r.votes;
        merged.set(name, m);
      }
      const cands = [...merged.values()].sort((a, b) => b.votes - a.votes);
      const total = cands.reduce((s, c) => s + c.votes, 0);
      if (!total) continue;
      for (const c of cands) {
        c.percent = Math.round((c.votes / total) * 10000) / 100;
        c.winner = c === cands[0];
      }
      regions[fips] = { name: fips, percent_reporting: 100, candidates: cands };
    }
    const top = known.slice(0, 2);
    const sumFor = (name) => Object.values(regions).reduce((n, r) => n + (r.candidates.find((x) => x.name === name)?.votes ?? 0), 0);
    const off = top.find((c) => Math.abs(sumFor(c.name) - c.votes) > c.votes * 0.01);
    if (!top.length || off) {
      const ratio = off ? ` (${off.name}: ${(sumFor(off.name) / off.votes).toFixed(3)}× statewide)` : '';
      console.log(`  ${label} ${race}: county totals don't match statewide${ratio}; left out`);
      continue;
    }
    (byState[race.slice(0, 2)] ??= {})[race] = regions;
  }
  return byState;
}

async function write(kind, year, byState) {
  await mkdir(outDir, { recursive: true });
  for (const f of await readdir(outDir)) {
    if (f.startsWith(`${kind}-${year}-`)) await rm(join(outDir, f));
  }
  for (const [st, races] of Object.entries(byState)) {
    await writeFile(join(outDir, `${kind}-${year}-${st}.json`), JSON.stringify(races));
  }
  const races = Object.values(byState).reduce((n, r) => n + Object.keys(r).length, 0);
  console.log(`${year} ${kind}: ${races} races with county results`);
}

async function statewide(year, kind) {
  return JSON.parse(await readFile(join(root, 'public', 'data', 'past', `${year}.json`), 'utf8'))[kind] ?? {};
}

const states = (races) => [...new Set(Object.keys(races).map((k) => k.slice(0, 2)))];

// ---------- sources ----------

/** A MEDSL row → tally row. */
function medslRow(r, office) {
  if (r.office !== office) return null;
  const fips = (r.county_fips || '').padStart(5, '0');
  if (!/^\d{5}$/.test(fips) || fips === '00000' || r.writein === 'TRUE') return null;
  return {
    race: `${r.state_po.toLowerCase()}${r.special === 'TRUE' ? '-special' : ''}`,
    stage: r.stage || 'GEN',
    fips,
    precinct: r.precinct,
    candidate: r.candidate,
    party: r.party_simplified,
    votes: Number(r.votes) || 0,
    total: r.mode === 'TOTAL',
  };
}

/** MEDSL per-state precinct zips (2022 names them 2022-xx-local-precinct-general.zip, 2024 xx24.zip). */
async function medslStates(year, kind) {
  const races = await statewide(year, kind);
  const t = makeTally();
  for (const st of states(races)) {
    const name = year === 2022 ? `2022-${st}-local-precinct-general.zip` : `${st}24.zip`;
    const zip = join(rawDir, `medsl-${year}`, name);
    if (!(await download(`${GITHUB}/MEDSL/${year}-elections-official/main/individual_states/${name}`, zip))) continue;
    for (const csv of await unzipCsvs(zip, join(rawDir, `medsl-${year}`, st))) {
      await eachRow(csv, (r) => {
        const row = medslRow(r, OFFICES[kind].medsl);
        if (row) t.add(row);
      });
    }
  }
  return finish(t.result(), races, `${year} ${kind}`);
}

async function medsl2024SenateCounty() {
  const file = join(rawDir, 'medsl-2024', '2024-senate-county.csv');
  await download(`${GITHUB}/MEDSL/2024-elections-official/main/2024-senate-county.csv`, file);
  const t = makeTally();
  await eachRow(file, (r) => {
    const row = medslRow({ ...r, office: 'US SENATE' }, 'US SENATE');
    if (row) t.add(row);
  });
  return finish(t.result(), await statewide(2024, 'senate'), '2024 senate');
}

/** OpenElections 2020: prefers a state's county file, falling back to its precinct file. */
async function openElections2020(kind, lookup) {
  const races = await statewide(2020, kind);
  const t = makeTally();
  const unmatched = new Set();
  for (const st of states(races)) {
    // Which of the state's race keys this office's rows belong to (e.g. Arizona's 2020 race was a special).
    const race = races[st] ? st : races[`${st}-special`] ? `${st}-special` : null;
    if (!race || races[st] && races[`${st}-special`]) continue; // two races in one state can't be told apart
    let file = null;
    for (const level of ['county', 'precinct']) {
      const name = `20201103__${st}__general__${level}.csv`;
      const dest = join(rawDir, 'openelections-2020', name);
      if (await download(`${GITHUB}/openelections/openelections-data-${st}/master/2020/${name}`, dest)) { file = dest; break; }
    }
    if (!file) continue;
    await eachRow(file, (r) => {
      if (!OFFICES[kind].other.test((r.office ?? '').trim())) return;
      const county = (r.county ?? '').trim();
      const precinct = (r.precinct ?? '').trim();
      if (/total|statewide/i.test(county) || /^(.* )?totals?$/i.test(precinct)) return;
      const fips = lookup(st, county);
      if (!fips) { if (county) unmatched.add(`${st}:${county}`); return; }
      t.add({
        race, stage: 'GEN', fips,
        precinct: precinct && countyKey(precinct) === countyKey(county) ? 'COUNTY TOTAL' : precinct,
        candidate: r.candidate ?? '',
        party: r.party ?? '',
        votes: Number(String(r.votes ?? '').replace(/,/g, '')) || 0,
        total: true,
      });
    });
  }
  if (unmatched.size) console.log(`  2020 ${kind}: ${unmatched.size} county names not matched, e.g. ${[...unmatched].slice(0, 5).join(', ')}`);
  return finish(t.result(), races, `2020 ${kind}`);
}

// ---------- main ----------

const [onlyYear, onlyKind] = process.argv.slice(2);
const want = (year, kind) => (!onlyYear || onlyYear === String(year)) && (!onlyKind || onlyKind === kind);
const lookup = await countyLookup();

if (want(2024, 'senate')) await write('senate', 2024, await medsl2024SenateCounty());
if (want(2024, 'governor')) await write('governor', 2024, await medslStates(2024, 'governor'));
for (const kind of ['senate', 'governor']) {
  if (want(2022, kind)) await write(kind, 2022, await medslStates(2022, kind));
  if (want(2020, kind)) await write(kind, 2020, await openElections2020(kind, lookup));
}
