import './style.css';
import { geoPath } from 'd3-geo';
import {
  CHAMBER, NATIONAL_RACE, POLL_MS, TEST_DATA, getCountyResults, getForecast, getHistory, getPast, getRace, partyLabel, side,
  type Candidate, type Chamber, type History, type PastResult, type PastYear, type Race, type Rating, type Region, type Side,
} from './api';
import {
  LEVEL_FILL, NO_DATA, NO_RACE, PARTY, TOSSUP, finalFill, fmtMargin, liveFill, liveMargin, marginFill, partyColor,
  pastMargin, ranked, ratingFill,
} from './colors';
import { ALL_YEARS, LIVE_YEAR, RACE_LABEL, SEATED, YEARS, electoralVotes, type RaceKind } from './elections';
import { POSTAL_BY_FIPS, STATES, countyKey, loadAtlas, loadDistricts, type Atlas, type District, type Shape } from './geo';
import { MIN_REPORTING, projectRace, projected, projectionLabel, tally } from './projection';

const W = 975;
const H = 610;

interface Route {
  race: RaceKind;
  year: number;
  state?: string; // postal code, upper case
  district?: string; // House only, e.g. "mi-07"
  county?: string; // county FIPS, other races only, e.g. "13121"
}

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="top">
    <div class="brand"><span class="dot"></span> Election Live <small>Nov 3, 2026</small>${TEST_DATA ? '<span class="chip flip">SIMULATED DATA</span>' : ''}</div>
    <nav class="tabs" id="tabs"></nav>
    <nav class="modes" id="years"></nav>
    <div class="status" id="status">
      <span id="status-text"></span>
      <button data-action="refresh" title="Refresh now">↻ Refresh</button>
      <button data-action="toggle" class="toggle" role="switch" aria-checked="true"><span class="knob"></span>Auto-refresh</button>
    </div>
  </header>
  <main class="wall">
    <section class="map-wrap">
      <div class="crumbs" id="crumbs"></div>
      <svg id="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Results map"></svg>
      <div class="legend" id="legend"></div>
      <div class="tip" id="tip" hidden></div>
    </section>
    <aside class="panel" id="panel"></aside>
  </main>
  <footer class="foot">
    Live data: <a href="https://civicapi.org" target="_blank" rel="noopener">civicAPI</a> ·
    Past results: <a href="https://github.com/fivethirtyeight/election-results" target="_blank" rel="noopener">FiveThirtyEight</a>,
    <a href="https://github.com/tonmcg/US_County_Level_Election_Results_08-24" target="_blank" rel="noopener">tonmcg county results</a> ·
    District lines: civicAPI (2026), US Census Bureau (2020–2024) ·
    Results are unofficial until certified.
  </footer>`;

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const svg = $<SVGSVGElement>('#map');
const tip = $('#tip');
const path = geoPath();

const nationalRaces = new Map<Chamber, Race>();
const stateRaces = new Map<number, Race>();
const pastData = new Map<number, PastYear>();
let atlas: Atlas;
let route: Route = parseRoute();
let lastFetch = 0;
/** When the poll last ran (or the page loaded): it runs every POLL_MS from here, whatever the data's age. */
let lastPoll = Date.now();
let error = '';
let polling = readPolling();
/** Tooltip HTML for the shape under the cursor, keyed by shape id. */
let tips = new Map<string, string>();

// ---------- routing ----------

/**
 * Routes look like #/senate/2024/ga: race, year, then an optional state. Below a state,
 * the House can open a district (#/house/2024/mi/07) and the other races a county
 * (#/senate/2026/ga/county/13121).
 */
function parseRoute(): Route {
  const [r, y, s, d, e] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  const race: RaceKind = r in RACE_LABEL ? (r as RaceKind) : 'senate';
  const year = YEARS[race].includes(Number(y)) ? Number(y) : YEARS[race][0];
  const state = s && STATES[s.toUpperCase()] ? s.toUpperCase() : undefined;
  const district = race === 'house' && state && /^(\d{2}|al)$/.test(d ?? '') ? `${state.toLowerCase()}-${d}` : undefined;
  const county = race !== 'house' && state && d === 'county' && e?.length === 5 && e.startsWith(STATES[state].fips) ? e : undefined;
  return { race, year, state, district, county };
}

function href(r: Partial<Route>): string {
  const next = { ...route, ...r };
  // Keep the year when switching race if that race has one; otherwise its latest.
  const year = YEARS[next.race].includes(next.year) ? next.year : YEARS[next.race][0];
  const st = next.state ? STATES[next.state] : undefined;
  // A district only makes sense in the House view of its own state, a county in the others.
  let below = '';
  if (next.race === 'house' && next.state && next.district?.startsWith(`${next.state.toLowerCase()}-`)) {
    below = `/${next.district.split('-')[1]}`;
  } else if (next.race !== 'house' && st && next.county?.startsWith(st.fips)) {
    below = `/county/${next.county}`;
  }
  return `#/${next.race}/${year}${next.state ? `/${next.state.toLowerCase()}` : ''}${below}`;
}

window.addEventListener('hashchange', () => {
  route = parseRoute();
  load();
});

const isLive = (r: Route = route) => r.year === LIVE_YEAR && r.race !== 'president';

// ---------- data ----------

/** The current view's results: civicAPI regions for 2026, packaged results for past years. */
function currentRegions(): Record<string, Region> {
  if (isLive()) return nationalRaces.get(route.race as Chamber)?.region_results ?? {};
  return pastData.get(route.year)?.[route.race] ?? {};
}

/** A state's races in the current view: the regular one first, then any special. */
function stateRaceRegions(regions: Record<string, Region>, postal: string): [string, Region][] {
  const k = postal.toLowerCase();
  return [k, `${k}-special`].filter((key) => regions[key]).map((key) => [key, regions[key]]);
}

function districtsIn(regions: Record<string, Region>, postal: string): [string, Region][] {
  const prefix = `${postal.toLowerCase()}-`;
  return Object.entries(regions)
    .filter(([k]) => k.startsWith(prefix) && k !== `${prefix}special`)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Loads the live view's races. Without `force`, a localStorage copy under five minutes
 * old is reused; the refresh button and the poll pass `force` to go to civicAPI.
 */
async function fetchCurrent(force = false) {
  if (!isLive()) return;
  const chamber = route.race as Chamber;
  const national = await getRace(NATIONAL_RACE[chamber], force);
  nationalRaces.set(chamber, national.data);
  let oldest = national.fetchedAt;
  // A state's own race carries its county breakdown (the House map stops at districts).
  const id = route.state && chamber !== 'house' ? national.data.region_results?.[route.state.toLowerCase()]?.election_id : undefined;
  if (id) {
    const state = await getRace(id, force);
    stateRaces.set(id, state.data);
    oldest = Math.min(oldest, state.fetchedAt);
  }
  lastFetch = oldest;
}

async function load() {
  render(); // immediate feedback from whatever is in memory
  try {
    atlas ??= await loadAtlas();
    const { race, year, state } = route;
    const tasks: Promise<unknown>[] = [];
    if (isLive()) {
      // Cheap when cached; also resets the "updated" time to this view's data.
      tasks.push(fetchCurrent());
      tasks.push(getForecast(race as Chamber));
    }
    // A district page lists the seat's results from every past year.
    // District pages list the seat's past results and state House pages the past delegations.
    const allPast = race === 'house' && state;
    const pastYears = allPast ? ALL_YEARS.filter((y) => y !== LIVE_YEAR) : isLive() ? [] : [year];
    for (const y of pastYears) {
      if (!pastData.has(y)) tasks.push(getPast(y).then((p) => pastData.set(y, p)));
    }
    if (race === 'house') tasks.push(loadDistricts(year));
    // County presidential results back the President map and every county page.
    if (state && (race === 'president' || route.county)) tasks.push(getHistory(STATES[state].fips));
    await Promise.all(tasks);
    error = '';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await render();
}

function readPolling(): boolean {
  try {
    return localStorage.getItem('polling') !== 'off';
  } catch {
    return true;
  }
}

function setPolling(on: boolean) {
  polling = on;
  try {
    localStorage.setItem('polling', on ? 'on' : 'off');
  } catch {
    // Storage unavailable (private mode etc.); the toggle still works for this visit.
  }
}

/** Fetches the current view from civicAPI, skipping and updating the cache, and restarts the poll timer. */
async function refresh() {
  lastPoll = Date.now();
  try {
    await fetchCurrent(true);
    error = '';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  render();
}

let refreshing = false;
setInterval(async () => {
  const due = isLive() && polling && !refreshing && document.visibilityState === 'visible' && Date.now() - lastPoll >= POLL_MS;
  if (due) {
    refreshing = true;
    await refresh();
    refreshing = false;
  } else {
    renderStatus();
  }
}, 1000);

$('#status').addEventListener('click', async (e) => {
  const action = (e.target as Element).closest('button')?.dataset.action;
  if (action === 'toggle') {
    setPolling(!polling);
    renderStatus();
  } else if (action === 'refresh' && !refreshing) {
    refreshing = true;
    renderStatus();
    await refresh();
    refreshing = false;
  }
});

// ---------- rendering ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (n: number) => `${n.toFixed(1)}%`;
const num = (n: number) => n.toLocaleString('en-US');
const lastName = (n: string) => n.replace(/,?\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '').split(/\s+/).at(-1) ?? n;
const totalVotes = (cands: Candidate[]) => cands.reduce((s, c) => s + c.votes, 0);
const winnerOf = (cands: Candidate[]) => cands.find((c) => c.winner);

/** Top-two margin as a share of the vote (always positive), or null with no votes. */
function topMargin(cands: Candidate[]): number | null {
  const [a, b] = ranked(cands);
  const total = totalVotes(cands);
  return a && total ? (a.votes - (b?.votes ?? 0)) / total : null;
}

/** Map colour for a race: live shows calls and leads (forecast before votes); past shows margins. */
function raceFill(region: Region | undefined, rating?: string): string {
  if (!region) return NO_DATA;
  if (isLive()) return liveFill(region.candidates) ?? ratingFill(rating) ?? NO_DATA;
  return finalFill(region.candidates) ?? NO_DATA;
}

async function render() {
  renderTabs();
  renderStatus();
  if (!atlas) {
    $('#panel').innerHTML = `<p class="muted">Loading maps…</p>`;
    return;
  }
  tips = new Map();
  tip.hidden = true;
  if (route.state) await renderState();
  else await renderNation();
}

function renderTabs() {
  $('#tabs').innerHTML = (Object.keys(RACE_LABEL) as RaceKind[])
    .map((r) => `<a href="${href({ race: r })}" class="${r === route.race ? 'on' : ''}">${RACE_LABEL[r]}</a>`)
    .join('');
  $('#years').innerHTML = ALL_YEARS.map((y) => {
    const label = `${y === LIVE_YEAR ? '<span class="livedot"></span>' : ''}${y}`;
    if (!YEARS[route.race].includes(y)) {
      return `<span class="off" title="No ${RACE_LABEL[route.race].toLowerCase()} race in ${y}">${label}</span>`;
    }
    return `<a href="${href({ year: y })}" class="${y === route.year ? 'on' : ''}">${label}</a>`;
  }).join('');
}

function renderStatus() {
  const status = $('#status');
  const text = $('#status-text');
  const live = isLive();
  status.classList.toggle('final', !live);
  if (!live) {
    text.innerHTML = `Final results · ${route.year}`;
    return;
  }
  const refreshBtn = $<HTMLButtonElement>('#status [data-action="refresh"]');
  const toggle = $('#status [data-action="toggle"]');
  refreshBtn.disabled = refreshing;
  refreshBtn.textContent = refreshing ? 'Refreshing…' : '↻ Refresh';
  toggle.classList.toggle('on', polling);
  toggle.setAttribute('aria-checked', String(polling));

  if (error) {
    text.innerHTML = `<span class="err" title="${esc(error)}">⚠ Couldn't reach civicAPI${polling ? ', retrying' : ''}</span>`;
  } else if (!lastFetch) {
    text.textContent = 'Loading…';
  } else {
    const t = new Date(lastFetch).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const left = Math.max(0, Math.ceil((POLL_MS - (Date.now() - lastPoll)) / 1000));
    const next = left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `${left}s`;
    text.innerHTML = polling
      ? `<span class="live"></span>Updated ${t} · next in ${next}`
      : `<span class="live paused"></span>Updated ${t} · paused`;
  }
}

interface Drawn {
  fill: string;
  cls?: string;
  link?: string;
}

/** Draws atlas shapes, or pre-projected districts, with optional overlay markup on top. */
function drawShapes(shapes: (Drawn & ({ shape: Shape } | { district: District }))[], extra = '') {
  // Draw a selected shape last so its outline sits on top of its neighbours.
  const ordered = [...shapes].sort((a, b) => Number(!!a.cls?.includes('selected')) - Number(!!b.cls?.includes('selected')));
  svg.innerHTML =
    ordered
      .map((s) => {
        const [id, d] = 'shape' in s ? [s.shape.id, path(s.shape)] : [s.district.id, s.district.d];
        const el = `<path d="${d}" fill="${s.fill}" class="${s.cls ?? ''}" data-id="${id}"/>`;
        return s.link ? `<a href="${s.link}">${el}</a>` : el;
      })
      .join('') + extra;
}

function districtShape(district: District, regions: Record<string, Region>, forecast: Record<string, Rating>, link?: string) {
  const region = regions[district.id];
  const rating = forecast[district.id.toUpperCase()];
  tips.set(
    district.id,
    `<b>${esc(district.id.toUpperCase())}</b>${rating && isLive() ? ` <span class="chip">${esc(rating.rating)}</span>` : ''}
     <div class="muted">${esc(district.name)}</div>
     ${region ? `<div class="mini">${candidateRows(region.candidates, 3)}</div>${isLive() ? `<div class="muted">${pct(region.percent_reporting)} reporting</div>` : ''}` : '<div class="muted">No result in data</div>'}`,
  );
  return { district, fill: raceFill(region, rating?.rating), cls: 'race district', link };
}

svg.addEventListener('mousemove', (e) => {
  const id = (e.target as Element).getAttribute?.('data-id');
  const html = id ? tips.get(id) : undefined;
  if (!html) {
    tip.hidden = true;
    return;
  }
  tip.innerHTML = html;
  tip.hidden = false;
  const box = svg.parentElement!.getBoundingClientRect();
  const x = e.clientX - box.left;
  const y = e.clientY - box.top;
  tip.style.left = `${Math.min(x + 14, box.width - tip.offsetWidth - 8)}px`;
  tip.style.top = `${y + 14 + tip.offsetHeight > box.height ? y - tip.offsetHeight - 10 : y + 14}px`;
});
svg.addEventListener('mouseleave', () => (tip.hidden = true));

function candidateRows(cands: Candidate[], limit = 6): string {
  const total = totalVotes(cands);
  return ranked(cands)
    .slice(0, limit)
    .map((c) => {
      const share = total ? (c.votes / total) * 100 : 0;
      return `
        <div class="cand ${c.winner ? 'won' : ''}">
          <span class="swatch" style="background:${partyColor(c)}"></span>
          <span class="name">${esc(c.name)}${c.incumbent ? ' <i title="Incumbent">inc.</i>' : ''}${c.winner ? ' <b class="check">✓</b>' : ''}
            <small>${esc(partyLabel(c.party))}</small></span>
          <span class="pct">${total ? pct(share) : '–'}</span>
          <span class="votes">${num(c.votes)}</span>
          <span class="bar"><span style="width:${share}%;background:${partyColor(c)}"></span></span>
        </div>`;
    })
    .join('');
}

const sample = (lead: string, trail: string) => [
  { party: lead, votes: 52, color: '', name: '', percent: 0, winner: false },
  { party: trail, votes: 48, color: '', name: '', percent: 0, winner: false },
];

function legend(note = '', showForecast = false) {
  const items = isLive()
    ? [[PARTY.D, 'D called'], [liveFill(sample('Democrat', 'Republican'))!, 'D leading'],
       [liveFill(sample('Republican', 'Democrat'))!, 'R leading'], [PARTY.R, 'R called'], [NO_DATA, 'No votes yet']]
    : [[marginFill(0.4), 'D +40'], [marginFill(0.05), 'D +5'], [marginFill(-0.05), 'R +5'], [marginFill(-0.4), 'R +40']];
  const swatches = (list: string[][]) => list.map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('');
  // Before votes, races are shaded by forecast rating in the seat bar's tier colours.
  const forecast = showForecast
    ? `<div class="legend-row"><span class="muted">Before votes:</span>${swatches([
        [ratingFill('Likely D')!, 'Likely D'], [ratingFill('Lean D')!, 'Lean D'], [ratingFill('Tossup')!, 'Toss-up'],
        [ratingFill('Lean R')!, 'Lean R'], [ratingFill('Likely R')!, 'Likely R'],
      ])}</div>`
    : '';
  $('#legend').innerHTML =
    `<div class="legend-row">${swatches(items)}</div>${forecast}` +
    (note ? `<div class="legend-row muted">${note}</div>` : '');
}

// ----- national view -----

async function renderNation() {
  const { race, year } = route;
  const regions = currentRegions();
  const forecast = isLive() ? await getForecast(race as Chamber) : {};
  $('#crumbs').innerHTML = `<b>United States</b> · ${year} ${RACE_LABEL[race]}`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const panel = $('#panel');

  if (race === 'house') {
    const districts = await loadDistricts(year);
    drawShapes(
      districts.map((d) => districtShape(d, regions, forecast, href({ state: d.state }))),
      `<path class="borders" d="${path(atlas.stateBorders)}"/><path class="borders" d="${path(atlas.nation as never)}"/>`,
    );
    legend('', isLive());
    const national = nationalRaces.get('house');
    if (isLive() && !national) panel.innerHTML = `<p class="muted">Loading results…</p>`;
    else panel.innerHTML = (isLive() ? balance(national!, forecast) : houseTally(regions)) + houseList(regions);
    return;
  }

  let usedForecast = false;
  const shapes = atlas.states.map((shape) => {
    const postal = POSTAL_BY_FIPS[shape.id];
    const name = STATES[postal]?.name ?? shape.properties.name;
    const races = postal ? stateRaceRegions(regions, postal) : [];
    if (!races.length) {
      tips.set(shape.id, `<b>${name}</b><div class="muted">No ${RACE_LABEL[race].toLowerCase()} race in ${year}</div>`);
      return { shape, fill: NO_RACE };
    }
    const rating = forecast[postal]?.rating;
    usedForecast ||= isLive() && !!rating && !totalVotes(races[0][1].candidates);
    const ev = race === 'president' ? ` <span class="chip">${evForState(postal)} EV</span>` : '';
    tips.set(
      shape.id,
      races
        .map(([, reg], i) => `<b>${esc(i ? reg.name : name)}</b>${ev && !i ? ev : ''}${rating && isLive() && !i ? ` <span class="chip">${esc(rating)}</span>` : ''}
          <div class="mini">${candidateRows(reg.candidates, 3)}</div>${isLive() ? `<div class="muted">${pct(reg.percent_reporting)} reporting</div>` : ''}`)
        .join(''),
    );
    return { shape, fill: raceFill(races[0][1], rating), cls: 'race', link: href({ state: postal }) };
  });
  drawShapes(shapes, `<path class="borders" d="${path(atlas.nation as never)}"/>`);
  legend('', usedForecast);

  if (isLive() && !nationalRaces.get(race as Chamber)) {
    panel.innerHTML = `<p class="muted">Loading results…</p>`;
    return;
  }
  const head =
    race === 'president' ? electoralTally(regions)
    : isLive() ? balance(nationalRaces.get(race as Chamber)!, forecast)
    : seatedTally(regions);
  panel.innerHTML = head + raceList(regions, forecast);
}

function evForState(postal: string): number {
  return electoralVotes(route.year, postal.toLowerCase()) +
    (postal === 'ME' ? 2 : postal === 'NE' ? 3 : 0); // plus each district's single vote
}

/** A seat bar with the majority line, plus headline numbers and notes. */
function seatBar(parts: { n: number; color: string; title: string }[], total: number, majority?: number): string {
  const w = (n: number) => `${(n / total) * 100}%`;
  return `<div class="seatbar">${parts
    .filter((p) => p.n > 0)
    .map((p) => `<span style="width:${w(p.n)};background:${p.color}" title="${p.title}: ${p.n}"></span>`)
    .join('')}${majority ? `<i class="maj" style="left:${w(majority)}"></i>` : ''}</div>`;
}

function headline(s: Side, big: string | number, sub = '', badge = '') {
  return `<div class="side ${s}"><b style="color:${PARTY[s]}">${big}</b>${sub ? `<span>${sub}</span>` : ''}${badge ? `<em>${badge}</em>` : ''}</div>`;
}

function electoralTally(regions: Record<string, Region>): string {
  const ev: Record<Side, number> = { D: 0, R: 0, O: 0 };
  const names: Partial<Record<Side, string>> = {};
  for (const [key, reg] of Object.entries(regions)) {
    const w = winnerOf(reg.candidates);
    if (!w) continue;
    const s = side(w.party);
    ev[s] += electoralVotes(route.year, key);
    names[s] ??= lastName(w.name);
  }
  const win = (s: Side) => (ev[s] >= 270 ? 'won' : '');
  return `
    <div class="balance">
      <div class="nums">
        ${headline('D', ev.D, names.D ?? 'Democrat', win('D'))}
        ${ev.O ? headline('O', ev.O, 'Other') : ''}
        ${headline('R', ev.R, names.R ?? 'Republican', win('R'))}
      </div>
      ${seatBar([
        { n: ev.D, color: PARTY.D, title: 'Democrat' },
        { n: ev.O, color: PARTY.O, title: 'Other' },
        { n: 538 - ev.D - ev.R - ev.O, color: '#3a4150', title: 'Unallocated' },
        { n: ev.R, color: PARTY.R, title: 'Republican' },
      ], 538, 270)}
      <div class="muted">Electoral votes · 270 to win · Maine and Nebraska split by district</div>
    </div>`;
}

/** Past Senate/Governor: the chamber as seated afterwards, and what changed hands that year. */
function seatedTally(regions: Record<string, Region>): string {
  const kind = route.race as 'senate' | 'governor';
  const info = CHAMBER[kind];
  const seated = SEATED[kind][route.year];
  const won: Record<Side, number> = { D: 0, R: 0, O: 0 };
  for (const reg of Object.values(regions)) {
    const w = winnerOf(reg.candidates);
    if (w) won[side(w.party)]++;
  }
  const control = (s: Side) => (info.majority && seated[s] >= info.majority ? 'majority' : '');
  return `
    <div class="balance">
      <div class="nums">
        ${headline('D', `D ${seated.D}`, '', control('D'))}
        ${seated.O ? headline('O', `Ind ${seated.O}`) : ''}
        ${headline('R', `R ${seated.R}`, '', control('R'))}
      </div>
      ${seatBar([
        { n: seated.D, color: PARTY.D, title: 'Democrat' },
        { n: seated.O, color: PARTY.O, title: 'Independent' },
        { n: seated.R, color: PARTY.R, title: 'Republican' },
      ], info.total, info.majority)}
      <div class="breakdown">Won in ${route.year}: <span style="color:${PARTY.D}">D ${won.D}</span> · <span style="color:${PARTY.R}">R ${won.R}</span>${won.O ? ` · Oth ${won.O}` : ''}</div>
      <div class="muted">${info.label === 'Senate' ? 'Senate' : 'Governors'} as seated in January ${route.year + 1}${seated.O ? '; independents caucused with Democrats' : ''}.</div>
    </div>`;
}

function houseTally(regions: Record<string, Region>): string {
  const won: Record<Side, number> = { D: 0, R: 0, O: 0 };
  for (const reg of Object.values(regions)) {
    const w = winnerOf(reg.candidates);
    if (w) won[side(w.party)]++;
  }
  const missing = 435 - won.D - won.R - won.O;
  const control = (s: Side) => (won[s] >= 218 ? 'majority' : '');
  return `
    <div class="balance">
      <div class="nums">${headline('D', `D ${won.D}`, '', control('D'))}${headline('R', `R ${won.R}`, '', control('R'))}</div>
      ${seatBar([
        { n: won.D, color: PARTY.D, title: 'Democrat' },
        { n: won.O, color: PARTY.O, title: 'Other' },
        { n: missing, color: '#3a4150', title: 'Not in data' },
        { n: won.R, color: PARTY.R, title: 'Republican' },
      ], 435, 218)}
      <div class="muted">Seats won in ${route.year} · 218 for control${missing ? ` · ${missing} uncontested seats not in the data` : ''}</div>
    </div>`;
}

/** Seats not up this year, by party, from the roll-up race's seat counts. */
function holdovers(race: Race): Record<Side, number> {
  const regions = Object.values(race.region_results ?? {});
  const seats = (s: Side) => race.candidates.filter((c) => side(c.party) === s).reduce((n, c) => n + (c.seats ?? 0), 0);
  const called = (s: Side) => regions.filter((r) => r.candidates.some((c) => c.winner && side(c.party) === s)).length;
  // civicAPI's seat counts are holdovers only (they sum to total minus races up).
  // If they ever start including calls too, take those back out so calls aren't counted twice.
  const sum = seats('D') + seats('R') + seats('O');
  const includesCalls = sum + regions.length > CHAMBER[route.race as Chamber].total;
  const h = (s: Side) => Math.max(0, seats(s) - (includesCalls ? called(s) : 0));
  return { D: h('D'), R: h('R'), O: h('O') };
}

/** Live tally: secured seats plus the projection for every uncalled race. */
function balance(race: Race, forecast: Record<string, Rating>): string {
  const info = CHAMBER[route.race as Chamber];
  const t = tally(race.region_results ?? {}, forecast, holdovers(race));
  const tiers = (s: Side, order: ('secured' | 'likely' | 'lean')[]) =>
    order.map((lvl) => ({ n: t[s][lvl], color: LEVEL_FILL[lvl](s), title: `${s} ${lvl}` }));
  const status = (s: Side) =>
    info.majority && t[s].secured >= info.majority ? 'wins control' : info.majority && projected(t, s) >= info.majority ? 'projected control' : '';
  const nums = (s: Side) => headline(s, `${s === 'O' ? 'Oth' : s} ${t[s].secured}`, `Projected <b>${projected(t, s)}</b>`, status(s));
  const breakdown = (s: Side) =>
    `<span style="color:${PARTY[s]}">${s}</span> ${t[s].secured} secured · ${t[s].likely} likely · ${t[s].lean} lean`;
  return `
    <div class="balance">
      <div class="nums">${nums('D')}${projected(t, 'O') ? nums('O') : ''}${nums('R')}</div>
      ${seatBar([
        ...tiers('D', ['secured', 'likely', 'lean']),
        ...tiers('O', ['secured', 'likely', 'lean']),
        { n: t.tossup, color: TOSSUP, title: 'Toss-up' },
        ...tiers('R', ['lean', 'likely', 'secured']),
      ], info.total, info.majority)}
      <div class="breakdown">${breakdown('D')}<br>${breakdown('R')}<br>${t.tossup} toss-up${info.majority ? ` · ${info.majority} for control` : ''}</div>
      <div class="muted">Big numbers are secured seats: called races${route.race === 'house' ? '' : ' and seats not up this year'}.
        Projections use forecast ratings until ${MIN_REPORTING}% of a race reports, then live margins and the vote still out.</div>
    </div>`;
}

function projectionChip(p: ReturnType<typeof projectRace>): string {
  const color = p.side && p.level !== 'tossup' ? PARTY[p.side] : 'var(--muted)';
  const title = p.source === 'live' ? 'From live results' : 'From the pre-election forecast';
  return `<span class="chip" style="color:${color}" title="${title}">${projectionLabel(p)}${p.source === 'live' ? ' •' : ''}</span>`;
}

function raceList(regions: Record<string, Region>, forecast: Record<string, Rating>): string {
  const live = isLive();
  const rows = Object.entries(regions)
    // Maine/Nebraska presidential districts show in their state's view.
    .filter(([key]) => !(route.race === 'president' && key.includes('-')))
    .map(([key, reg]) => {
      const postal = key.split('-')[0].toUpperCase();
      const top = ranked(reg.candidates);
      const total = totalVotes(reg.candidates);
      const margin = topMargin(reg.candidates) ?? 1;
      const winner = winnerOf(reg.candidates);
      const rating = forecast[postal];
      const flip = live && winner && rating?.incumbent_party && side(winner.party) !== rating.incumbent_party && side(winner.party) !== 'O';
      const projection = projectRace(reg.candidates, reg.percent_reporting, rating?.rating);
      const title = (STATES[postal]?.name ?? reg.name) + (key.endsWith('-special') ? ' (special)' : '');
      return { postal, reg, top, total, margin, winner, flip, projection, title };
    });
  rows.sort((a, b) => {
    if (!live) return a.margin - b.margin; // closest first
    // Live: races with votes and no call first, closest first; then the rest alphabetically.
    const ka = a.total && !a.winner ? 0 : 1;
    const kb = b.total && !b.winner ? 0 : 1;
    return ka - kb || (ka === 0 ? a.margin - b.margin : a.title.localeCompare(b.title));
  });
  return `<h3>${live ? 'Races' : 'Closest races'}</h3><div class="cards">${rows
    .map(
      (r) => `
      <a class="card" href="${href({ state: r.postal })}">
        <div class="card-h"><b>${esc(r.title)}</b>
          ${r.flip ? '<span class="chip flip">FLIP</span>' : ''}
          ${live && !r.winner && r.projection.source !== 'none' ? projectionChip(r.projection) : ''}
          ${route.race === 'president' ? `<span class="chip">${evForState(r.postal)} EV</span>` : ''}
          <span class="muted">${live ? pct(r.reg.percent_reporting) : ''}</span></div>
        ${r.top
          .slice(0, 2)
          .map((c) => `<div class="line"><i style="background:${partyColor(c)}"></i>${esc(lastName(c.name))}${c.winner ? ' ✓' : ''}<span>${r.total ? pct((c.votes / r.total) * 100) : ''}</span></div>`)
          .join('')}
      </a>`,
    )
    .join('')}</div>`;
}

function houseList(regions: Record<string, Region>): string {
  const live = isLive();
  const byState = new Map<string, Region[]>();
  for (const [k, reg] of Object.entries(regions)) {
    const p = k.split('-')[0].toUpperCase();
    byState.set(p, [...(byState.get(p) ?? []), reg]);
  }
  const close = Object.entries(regions)
    .map(([k, reg]) => ({ k, reg, a: ranked(reg.candidates)[0], margin: topMargin(reg.candidates) }))
    .filter((x) => x.margin != null && (!live || !winnerOf(x.reg.candidates)))
    .sort((x, y) => x.margin! - y.margin!)
    .slice(0, 12);
  return `
    ${close.length ? `<h3>${live ? 'Closest uncalled districts' : 'Closest districts'}</h3><div class="cards">${close
      .map((x) => `<a class="card" href="${href({ state: x.k.split('-')[0].toUpperCase() })}"><div class="card-h"><b>${x.k.toUpperCase()}</b><span class="muted">${live ? pct(x.reg.percent_reporting) : ''}</span></div>
        <div class="line"><i style="background:${partyColor(x.a)}"></i>${esc(lastName(x.a.name))}${x.a.winner ? ' ✓' : ''} +${(x.margin! * 100).toFixed(1)}</div></a>`)
      .join('')}</div>` : ''}
    <h3>States</h3><div class="cards">${[...byState]
      .sort(([a], [b]) => (STATES[a]?.name ?? a).localeCompare(STATES[b]?.name ?? b))
      .map(([p, regs]) => {
        const won = (s: string) => regs.filter((r) => r.candidates.some((c) => c.winner && side(c.party) === s)).length;
        return `<a class="card" href="${href({ state: p })}"><div class="card-h"><b>${esc(STATES[p]?.name ?? p)}</b><span class="muted">${regs.length}</span></div>
          <div class="line">${live ? 'Called' : 'Won'}: <span style="color:${PARTY.D}">D ${won('D')}</span> · <span style="color:${PARTY.R}">R ${won('R')}</span></div></a>`;
      })
      .join('')}</div>`;
}

// ----- state view -----

async function renderState() {
  const { race, year } = route;
  const postal = route.state!;
  const st = STATES[postal];
  const regions = currentRegions();
  const stateShape = atlas.states.find((s) => s.id === st.fips);
  const counties = atlas.counties.filter((c) => c.id.startsWith(st.fips));
  const outline = stateShape ? `<path class="borders state" d="${path(stateShape)}"/>` : '';
  const panel = $('#panel');

  const selectedCounty = route.county ? counties.find((c) => c.id === route.county) : undefined;
  const top = `<a href="${href({ state: undefined, district: undefined, county: undefined })}">United States</a> › `;
  const stateLink = `<a href="${href({ district: undefined, county: undefined })}">${st.name}</a>`;
  const leaf = route.district
    ? `${stateLink} › <b>${route.district.toUpperCase()}</b>`
    : selectedCounty
      ? `${stateLink} › <b>${esc(countyLabel(selectedCounty, postal))}</b>`
      : `<b>${st.name}</b>`;
  $('#crumbs').innerHTML = `${top}${leaf} · ${year} ${RACE_LABEL[race]}`;
  const focus = selectedCounty ?? stateShape;
  if (focus) {
    const [[x0, y0], [x1, y1]] = path.bounds(focus);
    // A county gets a wide margin so its neighbours show for context.
    const pad = Math.max(x1 - x0, y1 - y0) * (selectedCounty ? 0.9 : 0.06);
    svg.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`);
  }

  if (race === 'house') {
    const forecast = isLive() ? await getForecast('house') : {};
    const inState = (await loadDistricts(year)).filter((d) => d.state === postal);
    const selected = route.district ? inState.find((d) => d.id === route.district) : undefined;
    if (selected) {
      await renderDistrict(selected, inState, regions, forecast);
      return;
    }
    drawShapes(inState.map((d) => districtShape(d, regions, forecast, href({ district: d.id }))), outline);
    legend('', isLive());
    panel.innerHTML = stateHouseTally(regions, postal, forecast) + districtCards(regions, postal);
    return;
  }

  if (race === 'president') {
    await renderPresidentState(postal, regions, counties, outline);
    return;
  }

  const races = stateRaceRegions(regions, postal);
  if (!races.length) {
    drawShapes(counties.map((shape) => countyItem(shape, NO_RACE)), outline);
    legend();
    const none = `<p class="muted">No ${RACE_LABEL[race].toLowerCase()} race in ${st.name} in ${year}.</p>`;
    panel.innerHTML = selectedCounty ? await countyPanel(postal, selectedCounty, none) : `<h2>${st.name}</h2>${none}`;
    return;
  }

  if (!isLive()) {
    const byRace = await getCountyResults(race, year, postal);
    const mapped = byRace[races[0][0]];
    const statewide = races
      .map(([, reg]) => `<h2>${esc(reg.name)}</h2><div class="meta"><span>${year} final</span></div>${candidateRows(reg.candidates)}`)
      .join('');

    if (!mapped) {
      // No county breakdown packaged for this race: the whole state takes the result's colour.
      const fill = raceFill(races[0][1]);
      drawShapes(counties.map((shape) => countyItem(shape, fill)), outline);
      legend(`No county results for this ${RACE_LABEL[race]} race; showing the statewide result.`);
      panel.innerHTML = selectedCounty
        ? await countyPanel(postal, selectedCounty, `<p class="muted">No county results for this race. Statewide:</p>${races
            .map(([, reg]) => `<h3>${esc(reg.name)}</h3>${candidateRows(reg.candidates, 3)}`)
            .join('')}`)
        : statewide;
      return;
    }

    drawShapes(
      counties.map((shape) => {
        const reg = mapped[shape.id];
        tips.set(
          shape.id,
          `<b>${esc(countyLabel(shape, postal))}</b>` +
            (reg ? `<div class="mini">${candidateRows(reg.candidates, 3)}</div>` : '<div class="muted">No county result in data</div>'),
        );
        return countyItem(shape, (reg && finalFill(reg.candidates)) ?? NO_DATA);
      }),
      outline,
    );
    legend();
    if (selectedCounty) {
      // Every race in the state that year (regular and special) for this county.
      const here = races
        .map(([key, reg]) => [reg, byRace[key]?.[selectedCounty.id]] as const)
        .filter(([, r]) => r)
        .map(([reg, r]) => `${races.length > 1 ? `<h3>${esc(reg.name)}</h3>` : ''}${candidateRows(r!.candidates)}`)
        .join('');
      panel.innerHTML = await countyPanel(postal, selectedCounty, here || '<p class="muted">No county result in data.</p>');
    } else {
      panel.innerHTML = statewide + pastVoteBanks(mapped, counties, postal);
    }
    return;
  }

  // Live: county results from the state's own civicAPI race.
  const region = races[0][1];
  const stateRace = region.election_id ? stateRaces.get(region.election_id) : undefined;
  const byFips = new Map<string, Region>();
  if (stateRace?.region_results) {
    const byName = new Map(counties.map((c) => [countyKey(c.properties.name), c.id]));
    for (const reg of Object.values(stateRace.region_results)) {
      if (reg.type === 'State') continue;
      const fips = reg.fips && reg.fips.length === 5 ? reg.fips : byName.get(countyKey(reg.name));
      if (fips) byFips.set(fips, reg);
    }
  }
  drawShapes(
    counties.map((shape) => {
      const reg = byFips.get(shape.id);
      tips.set(
        shape.id,
        `<b>${esc(reg?.name ?? `${shape.properties.name} County`)}</b>` +
          (reg ? `<div class="mini">${candidateRows(reg.candidates, 3)}</div><div class="muted">${pct(reg.percent_reporting)} reporting</div>` : ''),
      );
      return countyItem(shape, (reg && liveFill(reg.candidates, false)) ?? NO_DATA);
    }),
    outline,
  );
  const regionCount = Object.values(stateRace?.region_results ?? {}).filter((r) => r.type !== 'State').length;
  legend(stateRace && regionCount && byFips.size < regionCount / 2 ? 'This race reports by areas that don’t match county shapes.' : '');

  if (selectedCounty) {
    const reg = byFips.get(selectedCounty.id);
    panel.innerHTML = await countyPanel(
      postal,
      selectedCounty,
      reg
        ? `<div class="meta"><span>${pct(reg.percent_reporting)} reporting</span></div>${candidateRows(reg.candidates)}`
        : `<p class="muted">No county results yet.</p>`,
    );
    return;
  }
  const forecast = (await getForecast(race as Chamber))[postal];
  panel.innerHTML = `
    <h2>${esc(stateRace?.election_name ?? region.name)}</h2>
    <div class="meta">
      <span>${pct(stateRace?.percent_reporting ?? region.percent_reporting)} reporting</span>
      ${forecast ? `<span class="chip">${esc(forecast.rating)}</span>` : ''}
      ${stateRace?.polls_close ? `<span class="muted">Polls close ${new Date(stateRace.polls_close).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</span>` : ''}
    </div>
    ${candidateRows(stateRace?.candidates ?? region.candidates)}
    ${races.slice(1).map(([, reg]) => `<h2 class="sub">${esc(reg.name)}</h2>${candidateRows(reg.candidates)}`).join('')}
    ${liveVoteBanks(byFips)}`;
}

async function renderPresidentState(postal: string, regions: Record<string, Region>, counties: Shape[], outline: string) {
  const year = String(route.year);
  const history: History = await getHistory(STATES[postal].fips);
  const results = history[year] ?? {};
  drawShapes(
    counties.map((shape) => {
      const p = results[shape.id];
      tips.set(
        shape.id,
        `<b>${esc(shape.properties.name)}</b>` +
          (p ? `<div>${fmtMargin(pastMargin(p))}</div><div class="muted">${num(p.t)} votes</div>` : '<div class="muted">No county result in data</div>'),
      );
      return countyItem(shape, p ? marginFill(pastMargin(p)) : NO_DATA);
    }),
    outline,
  );
  legend();

  const statewide = regions[postal.toLowerCase()];
  const county = route.county ? counties.find((c) => c.id === route.county) : undefined;
  if (county) {
    const p = results[county.id];
    $('#panel').innerHTML = await countyPanel(
      postal,
      county,
      p && statewide ? candidateRows(countyCandidates(p, statewide.candidates)) : '<p class="muted">No county result in data.</p>',
    );
    return;
  }

  const districts = Object.entries(regions).filter(([k]) => k.startsWith(`${postal.toLowerCase()}-`));
  const biggest = Object.entries(results)
    .sort(([, a], [, b]) => b.t - a.t)
    .slice(0, 12);
  const countyName = (fips: string) => counties.find((c) => c.id === fips)?.properties.name ?? fips;
  $('#panel').innerHTML = `
    <h2>${STATES[postal].name}</h2>
    <div class="meta"><span>${year} President</span><span class="chip">${evForState(postal)} EV</span></div>
    ${statewide ? candidateRows(statewide.candidates) : '<p class="muted">No statewide result in data.</p>'}
    ${districts.length ? `<h3>Districts (1 EV each)</h3>${districts.map(([k, reg]) => `<div class="district"><div class="card-h"><b>${k.toUpperCase()}</b></div>${candidateRows(reg.candidates, 2)}</div>`).join('')}` : ''}
    ${biggest.length ? `<h3>Biggest counties</h3><table class="tbl"><tr class="muted"><td>County</td><td>Votes</td><td>Margin</td></tr>${biggest
      .map(([f, p]) => `<tr><td>${esc(countyName(f))}</td><td class="muted">${num(p.t)}</td><td style="color:${p.d >= p.r ? PARTY.D : PARTY.R}">${fmtMargin(pastMargin(p))}</td></tr>`)
      .join('')}</table>` : ''}`;
}

function countyLabel(shape: Shape, postal: string): string {
  const name = shape.properties.name;
  if (postal === 'LA') return `${name} Parish`;
  if (postal === 'AK' || /\b(city|borough|area|municipality)$/i.test(name)) return name;
  return `${name} County`;
}

/** A county on a state map: clickable, and faded around the selected county. */
function countyItem(shape: Shape, fill: string) {
  const state = route.county ? (shape.id === route.county ? ' selected' : ' faded') : '';
  return { shape, fill, cls: `county${state}`, link: href({ county: shape.id }) };
}

/**
 * Turns a county's packaged presidential totals into candidate rows, borrowing the
 * names from the statewide result. Third parties are lumped together as "Other".
 */
function countyCandidates(p: PastResult, statewide: Candidate[]): Candidate[] {
  const named = (s: Side) => statewide.find((c) => side(c.party) === s);
  const row = (s: 'D' | 'R', votes: number, won: boolean): Candidate => ({
    name: named(s)?.name ?? (s === 'D' ? 'Democrat' : 'Republican'),
    party: s === 'D' ? 'Democrat' : 'Republican',
    color: '',
    votes,
    percent: (votes / p.t) * 100,
    winner: won,
  });
  const other = p.t - p.d - p.r;
  return [
    row('D', p.d, p.d > p.r),
    row('R', p.r, p.r > p.d),
    ...(other > 0 ? [{ name: 'Other', party: 'Other', color: '#808080', votes: other, percent: (other / p.t) * 100, winner: false }] : []),
  ];
}

/** A county's page: the selected race there, then its past presidential results. */
async function countyPanel(postal: string, shape: Shape, current: string): Promise<string> {
  const history = await getHistory(STATES[postal].fips);
  const years = Object.keys(history)
    .filter((y) => history[y][shape.id] && !(route.race === 'president' && Number(y) === route.year))
    .sort()
    .reverse();
  const rows = years
    .map((y) => {
      const p = history[y][shape.id];
      const m = pastMargin(p);
      return `<tr>
        <td><a href="${href({ race: 'president', year: Number(y) })}">${y}</a></td>
        <td style="color:${PARTY.D}">${pct((p.d / p.t) * 100)}</td>
        <td style="color:${PARTY.R}">${pct((p.r / p.t) * 100)}</td>
        <td style="color:${m >= 0 ? PARTY.D : PARTY.R}">${fmtMargin(m)}</td>
        <td class="muted">${num(p.t)}</td></tr>`;
    })
    .join('');
  return `
    <h2>${esc(countyLabel(shape, postal))}</h2>
    <div class="meta"><span>${STATES[postal].name}</span><span>${route.year} ${RACE_LABEL[route.race]}</span></div>
    ${current}
    ${rows ? `<h3>Past presidential results</h3>
      <table class="tbl"><tr class="muted"><td>Year</td><td>D</td><td>R</td><td>Margin</td><td>Votes</td></tr>${rows}</table>` : ''}`;
}

/** A finished race's biggest counties by votes, with each county's winning margin. */
function pastVoteBanks(byFips: Record<string, Region>, counties: Shape[], postal: string): string {
  const rows = Object.entries(byFips)
    .map(([fips, reg]) => ({ fips, reg, total: totalVotes(reg.candidates), a: ranked(reg.candidates)[0], m: topMargin(reg.candidates) }))
    .sort((x, y) => y.total - x.total)
    .slice(0, 12);
  if (!rows.length) return '';
  const name = (fips: string) => {
    const shape = counties.find((c) => c.id === fips);
    return shape ? countyLabel(shape, postal).replace(/ County$/, '') : fips;
  };
  return `<h3>Biggest counties</h3>
    <table class="tbl"><tr class="muted"><td>County</td><td>Votes</td><td>Margin</td></tr>${rows
      .map((r) => `<tr><td><a href="${href({ county: r.fips })}">${esc(name(r.fips))}</a></td><td class="muted">${num(r.total)}</td>
        <td style="color:${partyColor(r.a)}">${esc(lastName(r.a.name))} +${((r.m ?? 0) * 100).toFixed(1)}</td></tr>`)
      .join('')}</table>`;
}

/** The biggest counties by votes counted so far: the Magic Wall "where are the votes" view. */
function liveVoteBanks(byFips: Map<string, Region>): string {
  const rows = [...byFips.values()]
    .map((reg) => ({ reg, total: totalVotes(reg.candidates), m: liveMargin(reg.candidates) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);
  if (!rows.length) return '';
  return `<h3>Biggest counties so far</h3>
    <table class="tbl"><tr class="muted"><td>County</td><td>Rep.</td><td>Votes</td><td>Margin</td></tr>${rows
      .map((r) => `<tr><td>${esc(r.reg.name.replace(/ County$/, ''))}</td><td class="muted">${Math.round(r.reg.percent_reporting)}%</td>
        <td class="muted">${num(r.total)}</td>
        <td>${r.m == null ? '–' : `<span style="color:${r.m >= 0 ? PARTY.D : PARTY.R}">${fmtMargin(r.m)}</span>`}</td></tr>`)
      .join('')}</table>`;
}

function districtCards(regions: Record<string, Region>, postal: string): string {
  const districts = districtsIn(regions, postal);
  if (!districts.length) return `<p class="muted">No House results for ${STATES[postal].name} in ${route.year}.</p>`;
  return `<h3>Districts</h3><div class="districts">${districts
    .map(([k, reg]) => `<a class="district" href="${href({ district: k })}"><div class="card-h"><b>${k.toUpperCase()}</b><span class="muted">${isLive() ? pct(reg.percent_reporting) : ''}</span></div>${candidateRows(reg.candidates, 3)}</a>`)
    .join('')}</div>`;
}

/** Seats won by each party among a set of districts. */
function seatsWon(districts: [string, Region][]): Record<Side, number> {
  const won: Record<Side, number> = { D: 0, R: 0, O: 0 };
  for (const [, reg] of districts) {
    const w = winnerOf(reg.candidates);
    if (w) won[side(w.party)]++;
  }
  return won;
}

/**
 * A state's House delegation: live, called seats plus the projection (as in the national
 * tally); past years, seats won. Below it, the delegation in each other year.
 */
function stateHouseTally(regions: Record<string, Region>, postal: string, forecast: Record<string, Rating>): string {
  const districts = districtsIn(regions, postal);
  if (!districts.length) return `<h2>${STATES[postal].name} House</h2>`;
  const total = districts.length;
  let head: string;
  if (isLive()) {
    const t = tally(Object.fromEntries(districts), forecast, { D: 0, R: 0, O: 0 });
    const tiers = (s: Side, order: ('secured' | 'likely' | 'lean')[]) =>
      order.map((lvl) => ({ n: t[s][lvl], color: LEVEL_FILL[lvl](s), title: `${s} ${lvl}` }));
    head = `
      <div class="nums">
        ${headline('D', `D ${t.D.secured}`, `Projected <b>${projected(t, 'D')}</b>`)}
        ${projected(t, 'O') ? headline('O', `Oth ${t.O.secured}`, `Projected <b>${projected(t, 'O')}</b>`) : ''}
        ${headline('R', `R ${t.R.secured}`, `Projected <b>${projected(t, 'R')}</b>`)}
      </div>
      ${seatBar([...tiers('D', ['secured', 'likely', 'lean']), ...tiers('O', ['secured', 'likely', 'lean']),
        { n: t.tossup, color: TOSSUP, title: 'Toss-up' }, ...tiers('R', ['lean', 'likely', 'secured'])], total)}
      <div class="muted">${total} seats · big numbers are called races${t.tossup ? ` · ${t.tossup} toss-up` : ''}</div>`;
  } else {
    const won = seatsWon(districts);
    head = `
      <div class="nums">${headline('D', `D ${won.D}`)}${won.O ? headline('O', `Oth ${won.O}`) : ''}${headline('R', `R ${won.R}`)}</div>
      ${seatBar([
        { n: won.D, color: PARTY.D, title: 'Democrat' },
        { n: won.O, color: PARTY.O, title: 'Other' },
        { n: total - won.D - won.R - won.O, color: '#3a4150', title: 'Not in data' },
        { n: won.R, color: PARTY.R, title: 'Republican' },
      ], total)}
      <div class="muted">${total} seats won in ${route.year}</div>`;
  }
  const others = ALL_YEARS.filter((y) => y !== route.year && y !== LIVE_YEAR)
    .map((y) => {
      const past = districtsIn(pastData.get(y)?.house ?? {}, postal);
      if (!past.length) return '';
      const won = seatsWon(past);
      return `<tr><td><a href="${href({ year: y })}">${y}</a></td>
        <td style="color:${PARTY.D}">D ${won.D}</td><td style="color:${PARTY.R}">R ${won.R}</td>
        <td class="muted">${past.length} seats</td></tr>`;
    })
    .join('');
  return `
    <h2>${STATES[postal].name} House</h2>
    <div class="balance">${head}</div>
    ${others ? `<h3>Delegation in other years</h3><table class="tbl">${others}</table>` : ''}`;
}

/**
 * One House district: zoomed to its lines for the selected year, with neighbouring
 * districts faded. The panel adds the seat's results in every past year.
 */
async function renderDistrict(district: District, inState: District[], regions: Record<string, Region>, forecast: Record<string, Rating>) {
  const [[x0, y0], [x1, y1]] = district.bounds;
  const pad = Math.max(x1 - x0, y1 - y0) * 0.12;
  svg.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`);

  const region = regions[district.id];
  const live = isLive();
  // Neighbouring districts stay visible but faded, and link to their own pages.
  const others = inState
    .filter((d) => d !== district)
    .map((d) => ({ ...districtShape(d, regions, forecast, href({ district: d.id })), cls: 'race district faded' }));
  drawShapes([...others, districtShape(district, regions, forecast)], `<path class="borders state" d="${district.d}"/>`);
  legend('', live);

  const rating = forecast[district.id.toUpperCase()];
  $('#panel').innerHTML = `
    <h2>${esc(district.id.toUpperCase())}</h2>
    <div class="meta">
      <span>${esc(district.name)}</span>
      ${live && region ? `<span>${pct(region.percent_reporting)} reporting</span>` : `<span>${route.year} final</span>`}
      ${live && rating ? `<span class="chip">${esc(rating.rating)}</span>` : ''}
    </div>
    ${region ? candidateRows(region.candidates) : `<p class="muted">No result for this district in ${route.year}.</p>`}
    ${seatHistory(district.id)}`;
}

/** The same seat number in each past year. Lines may have been redrawn in between. */
function seatHistory(key: string): string {
  const rows = ALL_YEARS.filter((y) => y !== route.year && y !== LIVE_YEAR)
    .map((y) => {
      const reg = pastData.get(y)?.house?.[key];
      if (!reg) return '';
      const [a, b] = ranked(reg.candidates);
      const m = topMargin(reg.candidates);
      return `<tr>
        <td><a href="${href({ year: y })}">${y}</a></td>
        <td><span class="swatch-sm" style="background:${partyColor(a)}"></span>${esc(lastName(a.name))}${b ? ` <span class="muted">def. ${esc(lastName(b.name))}</span>` : ''}</td>
        <td style="color:${partyColor(a)}">${m == null ? '–' : `+${(m * 100).toFixed(1)}`}</td></tr>`;
    })
    .join('');
  return rows
    ? `<h3>Past results for ${esc(key.toUpperCase())}</h3><table class="tbl">${rows}</table>
       <p class="muted small">District lines can change between elections (2022 redistricting, plus some 2024 and 2026 redraws).</p>`
    : '';
}

load();
