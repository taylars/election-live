// Saves civicAPI's 2026 congressional district map (TopoJSON, lon/lat) into
// public/data so the site serves its own copy. These are the lines in use for
// 2026, including the mid-decade redraws, which Census files don't have yet.
// Each district's id matches civicAPI's House race keys, e.g. "mi-07".

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://civicapi.org/data/geojson/US_House_2026_cd120.json';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'districts-2026.json');

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`);
const topo = await res.json();
const count = topo.objects?.districts?.geometries?.length;
if (topo.type !== 'Topology' || count !== 435) throw new Error(`Unexpected district file (${count} districts)`);

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(topo));
console.log(`Wrote ${count} districts to ${out}`);
