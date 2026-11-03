// Packages congressional district lines (TopoJSON, lon/lat) for each election year
// into public/data/districts-{year}.json, one object "districts" whose features
// carry { id, state, name }. The id matches the race keys, e.g. "mi-07" or "ak-al".
//
//   2026: civicAPI's district map, which includes the 2025 mid-decade redraws.
//   2020–2024: Census cartographic boundary files for the Congress elected that year.

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shapefile from 'shapefile';
import { topology } from 'topojson-server';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'data');
const rawDir = join(root, 'data-raw');

const CENSUS = {
  2020: { congress: 116, url: 'https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_cd116_20m.zip' },
  2022: { congress: 118, url: 'https://www2.census.gov/geo/tiger/GENZ2022/shp/cb_2022_us_cd118_20m.zip' },
  2024: { congress: 119, url: 'https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_cd119_20m.zip' },
};

const POSTAL = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA',
  '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK',
  '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT',
  '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY',
};

async function save(year, topo) {
  const count = topo.objects.districts.geometries.length;
  if (count !== 435) throw new Error(`${year}: expected 435 districts, got ${count}`);
  await writeFile(join(outDir, `districts-${year}.json`), JSON.stringify(topo));
  console.log(`${year}: wrote ${count} districts`);
}

async function civicApi2026() {
  const url = 'https://civicapi.org/data/geojson/US_House_2026_cd120.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await save(2026, await res.json());
}

async function census(year, { congress, url }) {
  const dir = join(rawDir, `cd${congress}`);
  const zip = join(rawDir, `cd${congress}.zip`);
  await mkdir(dir, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);

  const base = join(dir, url.split('/').at(-1).replace('.zip', ''));
  const fc = await shapefile.read(await readFile(`${base}.shp`), await readFile(`${base}.dbf`));
  const cdField = `CD${congress}FP`;
  const features = fc.features
    .filter((f) => POSTAL[f.properties.STATEFP] && f.properties[cdField] !== 'ZZ')
    .map((f) => {
      const state = POSTAL[f.properties.STATEFP];
      const cd = f.properties[cdField];
      const atLarge = cd === '00' || cd === '98';
      return {
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          id: `${state.toLowerCase()}-${atLarge ? 'al' : cd}`,
          state,
          name: atLarge ? `${state} at-large district` : `${state} district ${Number(cd)}`,
        },
      };
    });
  const topo = topology({ districts: { type: 'FeatureCollection', features } }, 1e5);
  await save(year, topo);
}

await mkdir(outDir, { recursive: true });
const only = process.argv[2];
if (!only || only === '2026') await civicApi2026();
for (const [year, src] of Object.entries(CENSUS)) {
  if (!only || only === year) await census(year, src);
}
