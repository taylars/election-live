// Packages county-level results for past U.S. Senate races into
// public/data/counties/senate-{year}-{st}.json, shaped like civicAPI regions:
//
//   { [raceKey]: { [countyFips]: { name, percent_reporting: 100, candidates: [...] } } }
//
// raceKey matches public/data/past/{year}.json ("ga", "ga-special").
//
// Source: MIT Election Data + Science Lab official returns.
//   2024: county file in github.com/MEDSL/2024-elections-official
//   2022: precinct files per state in github.com/MEDSL/2022-elections-official, summed to counties
//   2020: precinct file from Harvard Dataverse (doi:10.7910/DVN/ER9XTV). Dataverse asks for a
//         short guestbook form, so download 2020-SENATE-precinct-general.csv yourself into
//         data-raw/ and this script will pick it up.
//
// Candidate names and parties are taken from the statewide results in public/data/past
// (built by `npm run past`) so they match the rest of the site.

import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(root, 'data-raw');
const outDir = join(root, 'public', 'data', 'counties');
const MEDSL = 'https://raw.githubusercontent.com/MEDSL';

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

/** Streams a CSV file, calling `onRow` with an object per row. */
async function eachRow(file, onRow) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let cols;
  for await (const line of lines) {
    if (!line) continue;
    const f = splitCsv(line);
    if (!cols) { cols = f; continue; }
    onRow(Object.fromEntries(cols.map((c, i) => [c, f[i]])));
  }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function download(url, dest) {
  if (await exists(dest)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

const COUNTY_TOTAL = /^COUNTY TOTAL$/i;

/**
 * Collects Senate votes per race / county / precinct / candidate, then sums to counties.
 * Within a precinct, some states give a TOTAL row alongside per-method rows (absentee,
 * election day, ...) and others only per-method rows, so TOTAL is used where present
 * and the methods are summed otherwise. Some states also add "COUNTY TOTAL" rows next
 * to their precincts (Idaho); where a county has those, only they are used.
 */
function makeTally() {
  // key: race|stage|fips|precinct|candidate -> { total: number|null, modes: number, party }
  const cells = new Map();
  const stages = new Map(); // race -> set of stages seen
  return {
    add(row) {
      if (row.office !== 'US SENATE') return;
      const fips = (row.county_fips || '').padStart(5, '0');
      if (!/^\d{5}$/.test(fips) || fips === '00000') return;
      if (row.writein === 'TRUE' || !row.candidate || /^(UNDERVOTES?|OVERVOTES?|BLANK|SCATTERING)$/i.test(row.candidate)) return;
      const race = `${row.state_po.toLowerCase()}${row.special === 'TRUE' ? '-special' : ''}`;
      const stage = row.stage || 'GEN';
      (stages.get(race) ?? stages.set(race, new Set()).get(race)).add(stage);
      const key = [race, stage, fips, row.precinct ?? '', row.candidate].join('|');
      const c = cells.get(key) ?? { total: null, modes: 0, party: row.party_simplified };
      const votes = Number(row.votes) || 0;
      if (row.mode === 'TOTAL') c.total = (c.total ?? 0) + votes;
      else c.modes += votes;
      cells.set(key, c);
    },
    /** { race: { fips: [{ candidate, party, votes }] } }, using the runoff where there was one. */
    result() {
      const keep = [];
      const hasCountyTotal = new Set();
      for (const [key, c] of cells) {
        const [race, stage, fips, precinct, candidate] = key.split('|');
        const used = stages.get(race).has('GEN RUNOFF') ? 'GEN RUNOFF' : 'GEN';
        if (stage !== used) continue;
        if (COUNTY_TOTAL.test(precinct)) hasCountyTotal.add(`${race}|${fips}`);
        keep.push({ race, fips, precinct, candidate, party: c.party, votes: c.total ?? c.modes });
      }
      const counties = new Map(); // race|fips|candidate -> row
      for (const k of keep) {
        if (hasCountyTotal.has(`${k.race}|${k.fips}`) !== COUNTY_TOTAL.test(k.precinct)) continue;
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

/**
 * Drops races whose county totals don't add up to the statewide result (within 1%),
 * which catches incomplete source files. Those races fall back to statewide on the site.
 */
function checked(byState, statewide, year) {
  for (const [st, races] of Object.entries(byState)) {
    for (const [race, counties] of Object.entries(races)) {
      const top = statewide[race]?.candidates?.slice(0, 2) ?? [];
      const off = top.find((c) => {
        const sum = Object.values(counties).reduce((n, r) => n + (r.candidates.find((x) => x.name === c.name)?.votes ?? 0), 0);
        return Math.abs(sum - c.votes) > c.votes * 0.01;
      });
      if (!top.length || off) {
        console.log(`${year} ${race}: county totals don't match statewide${off ? ` (${off.name})` : ''}; left out`);
        delete races[race];
      }
    }
    if (!Object.keys(races).length) delete byState[st];
  }
  return byState;
}

const lastName = (n) => n.toLowerCase().replace(/[.,"]/g, '').replace(/\s+(jr|sr|ii|iii|iv)$/, '').split(/\s+/).at(-1);
const titleCase = (n) => n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Converts tallies to region objects, borrowing statewide candidate names and parties. */
function toRegions(tallies, statewide) {
  const out = {};
  for (const [race, counties] of Object.entries(tallies)) {
    const known = statewide[race]?.candidates ?? [];
    for (const [fips, rows] of Object.entries(counties)) {
      const merged = new Map();
      for (const r of rows) {
        const match = known.find((k) => lastName(k.name) === lastName(r.candidate));
        const name = match?.name ?? titleCase(r.candidate);
        const party = match?.party ?? titleCase(r.party || 'Other');
        const m = merged.get(name) ?? { name, party, votes: 0 };
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
      ((out[race.slice(0, 2)] ??= {})[race] ??= {})[fips] = { name: fips, percent_reporting: 100, candidates: cands };
    }
  }
  return out; // { st: { race: { fips: region } } }
}

async function write(year, byState) {
  await mkdir(outDir, { recursive: true });
  for (const f of await readdir(outDir)) {
    if (f.startsWith(`senate-${year}-`)) await rm(join(outDir, f));
  }
  for (const [st, races] of Object.entries(byState)) {
    await writeFile(join(outDir, `senate-${year}-${st}.json`), JSON.stringify(races));
  }
  const counties = Object.values(byState).flatMap((r) => Object.values(r)).reduce((n, c) => n + Object.keys(c).length, 0);
  console.log(`${year}: ${Object.keys(byState).length} states, ${counties} county results`);
}

async function statewide(year) {
  return JSON.parse(await readFile(join(root, 'public', 'data', 'past', `${year}.json`), 'utf8')).senate ?? {};
}

async function build2024() {
  const file = join(rawDir, 'medsl-2024', '2024-senate-county.csv');
  await download(`${MEDSL}/2024-elections-official/main/2024-senate-county.csv`, file);
  const t = makeTally();
  await eachRow(file, (r) => t.add({ ...r, office: 'US SENATE', candidate: r.candidate, writein: r.writein }));
  const races = await statewide(2024);
  await write(2024, checked(toRegions(t.result(), races), races, 2024));
}

async function build2022() {
  const races = await statewide(2022);
  const states = [...new Set(Object.keys(races).map((k) => k.slice(0, 2)))];
  const t = makeTally();
  for (const st of states) {
    const zip = join(rawDir, 'medsl-2022', `${st}.zip`);
    await download(`${MEDSL}/2022-elections-official/main/individual_states/2022-${st}-local-precinct-general.zip`, zip);
    const dir = join(rawDir, 'medsl-2022', st);
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.csv'))) {
      await eachRow(join(dir, f), (r) => t.add(r));
    }
  }
  await write(2022, checked(toRegions(t.result(), races), races, 2022));
}

async function build2020() {
  const file = join(rawDir, '2020-SENATE-precinct-general.csv');
  if (!(await exists(file))) {
    console.log('2020: skipped (download 2020-SENATE-precinct-general.csv from doi:10.7910/DVN/ER9XTV into data-raw/)');
    return;
  }
  const t = makeTally();
  await eachRow(file, (r) => t.add({ ...r, office: r.office || 'US SENATE' }));
  const races = await statewide(2020);
  await write(2020, checked(toRegions(t.result(), races), races, 2020));
}

const only = process.argv[2];
if (!only || only === '2024') await build2024();
if (!only || only === '2022') await build2022();
if (!only || only === '2020') await build2020();
