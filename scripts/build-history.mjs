// Builds static past-results JSON for the "compare to previous years" views.
//
// Sources (first one found wins):
//   1. MIT Election Data + Science Lab county presidential returns 2000–2024,
//      if you've downloaded it to data-raw/countypres_2000-2024.tab
//      (https://doi.org/10.7910/DVN/VOQCHQ — Dataverse asks for a short
//      guestbook form, so it can't be fetched automatically).
//   2. Otherwise, 2020 and 2024 county results from
//      https://github.com/tonmcg/US_County_Level_Election_Results_08-24 (MIT licence).
//      Its 2008–2016 files are incomplete, so they're skipped.
//
// Output:
//   public/data/history/national.json   { [year]: { [stateFips]: { d, r, t } } }
//   public/data/history/{stateFips}.json { [year]: { [countyFips]: { d, r, t } } }
// where d/r are Democratic/Republican votes and t is total votes.

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'data', 'history');
const medslPath = join(root, 'data-raw', 'countypres_2000-2024.tab');
const TONMCG = 'https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master';

const byState = {};
const national = {};
function add(year, fips, d, r, t) {
  if (!fips || fips === 'NA' || !(t > 0)) return;
  fips = fips.padStart(5, '0');
  const st = fips.slice(0, 2);
  ((byState[st] ??= {})[year] ??= {})[fips] = { d, r, t };
  const n = ((national[year] ??= {})[st] ??= { d: 0, r: 0, t: 0 });
  n.d += d; n.r += r; n.t += t;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function parseDelimited(text, sep) {
  const unquote = (s) => s.replace(/^"|"$/g, '');
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head.split(sep).map(unquote);
  // Neither source has quoted separators in the columns we read.
  return rows.map((line) => Object.fromEntries(line.split(sep).map((v, i) => [cols[i], unquote(v)])));
}

async function fromMedsl() {
  // Some states report one TOTAL row per candidate, others only per-mode rows
  // (absentee, election day, ...), and a few report both. Prefer TOTAL.
  const counties = new Map();
  for (const row of parseDelimited(await readFile(medslPath, 'utf8'), '\t')) {
    const key = `${row.year}|${row.county_fips}`;
    let c = counties.get(key);
    if (!c) {
      c = { year: row.year, fips: row.county_fips, total: null, modes: { d: 0, r: 0, o: 0 } };
      counties.set(key, c);
    }
    let bucket = c.modes;
    if (row.mode === 'TOTAL') bucket = c.total ??= { d: 0, r: 0, o: 0 };
    const k = row.party === 'DEMOCRAT' ? 'd' : row.party === 'REPUBLICAN' ? 'r' : 'o';
    bucket[k] += Number(row.candidatevotes) || 0;
  }
  for (const c of counties.values()) {
    const v = c.total ?? c.modes;
    add(c.year, c.fips, v.d, v.r, v.d + v.r + v.o);
  }
}

async function fromTonmcg() {
  for (const y of ['2020', '2024']) {
    const res = await fetch(`${TONMCG}/${y}_US_County_Level_Presidential_Results.csv`);
    if (!res.ok) throw new Error(`${y}: HTTP ${res.status}`);
    for (const row of parseDelimited(await res.text(), ',')) {
      add(y, row.county_fips, +row.votes_dem, +row.votes_gop, +row.total_votes);
    }
  }
}

const useMedsl = await exists(medslPath);
await (useMedsl ? fromMedsl() : fromTonmcg());

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'national.json'), JSON.stringify(national));
for (const [st, years] of Object.entries(byState)) {
  await writeFile(join(outDir, `${st}.json`), JSON.stringify(years));
}
console.log(
  `${useMedsl ? 'MEDSL' : 'tonmcg 2020/2024'}: wrote national.json + ${Object.keys(byState).length} state files ` +
  `(years ${Object.keys(national).sort().join(', ')})`,
);
