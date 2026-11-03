import { geoAlbersUsa, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, FeatureCollection, Geometry, MultiLineString } from 'geojson';
import countiesUrl from 'us-atlas/counties-albers-10m.json?url';

export const STATES: Record<string, { fips: string; name: string }> = {
  AL: { fips: '01', name: 'Alabama' }, AK: { fips: '02', name: 'Alaska' }, AZ: { fips: '04', name: 'Arizona' },
  AR: { fips: '05', name: 'Arkansas' }, CA: { fips: '06', name: 'California' }, CO: { fips: '08', name: 'Colorado' },
  CT: { fips: '09', name: 'Connecticut' }, DE: { fips: '10', name: 'Delaware' }, DC: { fips: '11', name: 'District of Columbia' },
  FL: { fips: '12', name: 'Florida' }, GA: { fips: '13', name: 'Georgia' }, HI: { fips: '15', name: 'Hawaii' },
  ID: { fips: '16', name: 'Idaho' }, IL: { fips: '17', name: 'Illinois' }, IN: { fips: '18', name: 'Indiana' },
  IA: { fips: '19', name: 'Iowa' }, KS: { fips: '20', name: 'Kansas' }, KY: { fips: '21', name: 'Kentucky' },
  LA: { fips: '22', name: 'Louisiana' }, ME: { fips: '23', name: 'Maine' }, MD: { fips: '24', name: 'Maryland' },
  MA: { fips: '25', name: 'Massachusetts' }, MI: { fips: '26', name: 'Michigan' }, MN: { fips: '27', name: 'Minnesota' },
  MS: { fips: '28', name: 'Mississippi' }, MO: { fips: '29', name: 'Missouri' }, MT: { fips: '30', name: 'Montana' },
  NE: { fips: '31', name: 'Nebraska' }, NV: { fips: '32', name: 'Nevada' }, NH: { fips: '33', name: 'New Hampshire' },
  NJ: { fips: '34', name: 'New Jersey' }, NM: { fips: '35', name: 'New Mexico' }, NY: { fips: '36', name: 'New York' },
  NC: { fips: '37', name: 'North Carolina' }, ND: { fips: '38', name: 'North Dakota' }, OH: { fips: '39', name: 'Ohio' },
  OK: { fips: '40', name: 'Oklahoma' }, OR: { fips: '41', name: 'Oregon' }, PA: { fips: '42', name: 'Pennsylvania' },
  RI: { fips: '44', name: 'Rhode Island' }, SC: { fips: '45', name: 'South Carolina' }, SD: { fips: '46', name: 'South Dakota' },
  TN: { fips: '47', name: 'Tennessee' }, TX: { fips: '48', name: 'Texas' }, UT: { fips: '49', name: 'Utah' },
  VT: { fips: '50', name: 'Vermont' }, VA: { fips: '51', name: 'Virginia' }, WA: { fips: '53', name: 'Washington' },
  WV: { fips: '54', name: 'West Virginia' }, WI: { fips: '55', name: 'Wisconsin' }, WY: { fips: '56', name: 'Wyoming' },
};

export const POSTAL_BY_FIPS: Record<string, string> = Object.fromEntries(
  Object.entries(STATES).map(([postal, s]) => [s.fips, postal]),
);

export type Shape = Feature<Geometry, { name: string }> & { id: string };

export interface Atlas {
  states: Shape[];
  counties: Shape[];
  countyBorders: MultiLineString;
  stateBorders: MultiLineString;
  nation: Feature;
}

let atlas: Promise<Atlas> | undefined;

/** Loads the pre-projected (Albers USA, 975×610) state and county shapes once. */
export function loadAtlas(): Promise<Atlas> {
  atlas ??= fetch(countiesUrl)
    .then((r) => r.json())
    .then((topo: Topology) => {
      const o = topo.objects as Record<string, GeometryCollection<{ name: string }>>;
      const states = (feature(topo, o.states) as FeatureCollection<Geometry, { name: string }>).features as Shape[];
      const counties = (feature(topo, o.counties) as FeatureCollection<Geometry, { name: string }>).features as Shape[];
      return {
        states,
        counties,
        countyBorders: mesh(topo, o.counties, (a, b) => a !== b),
        stateBorders: mesh(topo, o.states, (a, b) => a !== b),
        nation: feature(topo, o.nation as GeometryCollection) as unknown as Feature,
      };
    });
  return atlas;
}

/** A 2026 congressional district, already projected to an SVG path in the atlas frame. */
export interface District {
  id: string; // civicAPI key, e.g. "mi-07"
  state: string; // postal code, upper case
  name: string;
  d: string;
  bounds: [[number, number], [number, number]];
}

const districts = new Map<number, Promise<District[]>>();

/** Loads one year's district lines (lon/lat) and projects them to match the us-atlas Albers frame. */
export function loadDistricts(year: number): Promise<District[]> {
  let p = districts.get(year);
  if (p) return p;
  p = fetch(`${import.meta.env.BASE_URL}data/districts-${year}.json`)
    .then((r) => r.json())
    .then((topo: Topology) => {
      type Props = { id: string; state: string; name: string };
      const o = topo.objects.districts as GeometryCollection<Props>;
      const fc = feature(topo, o) as FeatureCollection<Geometry, Props>;
      // us-atlas's *-albers-10m files use exactly this projection.
      const project = geoPath(geoAlbersUsa().scale(1300).translate([487.5, 305]));
      return fc.features.map((f) => ({
        id: f.properties.id,
        state: f.properties.state.toUpperCase(),
        name: f.properties.name,
        d: project(f) ?? '',
        bounds: project.bounds(f),
      }));
    });
  districts.set(year, p);
  return p;
}

const SUFFIX = /\s+(county|parish|borough|census area|municipality|city and borough|city)$/;

/** Normalises a county name so civicAPI and us-atlas spellings match ("St. Louis County" → "st louis"). */
export function countyKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(SUFFIX, '')
    .replace(/[.']/g, '')
    .replace(/^saint /, 'st ')
    .trim();
}
