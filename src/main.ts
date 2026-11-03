import './style.css';
import { geoPath } from 'd3-geo';
import {
  CHAMBER, NATIONAL_RACE, TEST_DATA, getForecast, getHistory, getRace, side,
  type Candidate, type Chamber, type History, type Race, type Rating, type Region,
} from './api';
import {
  NO_DATA, NO_RACE, PARTY, fmtMargin, liveFill, liveMargin, marginFill, partyColor,
  pastMargin, ranked, ratingFill, shiftFill,
} from './colors';
import { POSTAL_BY_FIPS, STATES, countyKey, loadAtlas, type Atlas, type Shape } from './geo';

const REFRESH_MS = 30_000;
const W = 975;
const H = 610;

/** live = 2026 results; a year = that presidential race; shift = 2026 margin vs latest presidential. */
type Mode = 'live' | 'shift' | `${number}`;

interface Route {
  chamber: Chamber;
  state?: string; // postal code, upper case
  mode: Mode;
}

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="top">
    <div class="brand"><span class="dot"></span> Election Live <small>Nov 3, 2026</small>${TEST_DATA ? '<span class="chip flip">SIMULATED DATA</span>' : ''}</div>
    <nav class="tabs" id="tabs"></nav>
    <nav class="modes" id="modes"></nav>
    <div class="status" id="status"></div>
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
    Past results: <a href="https://github.com/tonmcg/US_County_Level_Election_Results_08-24" target="_blank" rel="noopener">tonmcg county results</a> ·
    Results are unofficial until certified.
  </footer>`;

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const svg = $<SVGSVGElement>('#map');
const tip = $('#tip');
const path = geoPath();

const nationalRaces = new Map<Chamber, Race>();
const stateRaces = new Map<number, Race>();
let atlas: Atlas;
let route: Route = parseRoute();
let lastFetch = 0;
let error = '';
/** Tooltip HTML for the shape under the cursor, keyed by shape id. */
let tips = new Map<string, string>();

// ---------- routing ----------

function parseRoute(): Route {
  const [p, q] = location.hash.replace(/^#\/?/, '').split('?');
  const [c, s] = p.split('/');
  const chamber: Chamber = c === 'governor' || c === 'house' ? c : 'senate';
  const state = s && STATES[s.toUpperCase()] ? s.toUpperCase() : undefined;
  const m = new URLSearchParams(q).get('mode') ?? 'live';
  const mode = (m === 'shift' || /^\d{4}$/.test(m) ? m : 'live') as Mode;
  return { chamber, state, mode };
}

function href(r: Partial<Route>): string {
  const next = { ...route, ...r };
  const mode = next.mode === 'live' ? '' : `?mode=${next.mode}`;
  return `#/${next.chamber}${next.state ? `/${next.state.toLowerCase()}` : ''}${mode}`;
}

window.addEventListener('hashchange', () => {
  route = parseRoute();
  load();
});

// ---------- data ----------

function stateRegion(chamber: Chamber, postal: string): Region | undefined {
  return nationalRaces.get(chamber)?.region_results?.[postal.toLowerCase()];
}

function houseDistricts(postal: string): [string, Region][] {
  const all = Object.entries(nationalRaces.get('house')?.region_results ?? {});
  return all.filter(([k]) => k.startsWith(`${postal.toLowerCase()}-`));
}

async function fetchCurrent() {
  const { chamber, state } = route;
  nationalRaces.set(chamber, await getRace(NATIONAL_RACE[chamber]));
  const id = state && chamber !== 'house' ? stateRegion(chamber, state)?.election_id : undefined;
  if (id) stateRaces.set(id, await getRace(id));
  lastFetch = Date.now();
}

async function load() {
  render(); // immediate feedback from whatever is cached
  try {
    atlas ??= await loadAtlas();
    const needsFetch =
      !nationalRaces.has(route.chamber) ||
      (route.state && route.chamber !== 'house' && !stateRaces.has(stateRegion(route.chamber, route.state)?.election_id ?? -1));
    await Promise.all([
      needsFetch ? fetchCurrent() : null,
      getForecast(route.chamber),
      getHistory('national'),
      route.state ? getHistory(STATES[route.state].fips) : null,
    ]);
    error = '';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await render();
}

setInterval(async () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastFetch >= REFRESH_MS) {
    try {
      await fetchCurrent();
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    render();
  } else {
    renderStatus();
  }
}, 1000);

// ---------- rendering ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (n: number) => `${n.toFixed(1)}%`;
const num = (n: number) => n.toLocaleString('en-US');
const lastName = (n: string) => n.replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '').split(/\s+/).at(-1) ?? n;

async function render() {
  renderTabs();
  if (!atlas) {
    $('#panel').innerHTML = `<p class="muted">Loading maps…</p>`;
    return;
  }
  const history = await getHistory('national');
  const years = Object.keys(history).sort().reverse();
  renderModes(years);
  renderStatus();
  tips = new Map();
  tip.hidden = true;
  if (route.state) await renderState(years);
  else await renderNation(history);
}

function renderTabs() {
  $('#tabs').innerHTML = (Object.keys(CHAMBER) as Chamber[])
    .map((c) => `<a href="${href({ chamber: c })}" class="${c === route.chamber ? 'on' : ''}">${CHAMBER[c].label}</a>`)
    .join('');
}

function renderModes(years: string[]) {
  const modes: [Mode, string][] = [['live', '2026 live']];
  for (const y of years) modes.push([y as Mode, `${y} pres.`]);
  if (route.state && route.chamber !== 'house' && years[0]) modes.push(['shift', `Shift vs ${years[0]}`]);
  $('#modes').innerHTML = modes
    .map(([m, label]) => `<a href="${href({ mode: m })}" class="${m === route.mode ? 'on' : ''}">${label}</a>`)
    .join('');
}

function renderStatus() {
  const el = $('#status');
  if (error) {
    el.innerHTML = `<span class="err" title="${esc(error)}">⚠ Couldn't reach civicAPI, retrying</span>`;
    return;
  }
  if (!lastFetch) {
    el.textContent = 'Loading…';
    return;
  }
  const next = Math.max(0, Math.ceil((REFRESH_MS - (Date.now() - lastFetch)) / 1000));
  const t = new Date(lastFetch).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  el.innerHTML = `<span class="live"></span>Updated ${t} · refresh in ${next}s`;
}

function drawShapes(shapes: { shape: Shape; fill: string; cls?: string; link?: string }[], extra = '') {
  svg.innerHTML =
    shapes
      .map(({ shape, fill, cls, link }) => {
        const d = `<path d="${path(shape)}" fill="${fill}" class="${cls ?? ''}" data-id="${shape.id}"/>`;
        return link ? `<a href="${link}">${d}</a>` : d;
      })
      .join('') + extra;
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
  const total = cands.reduce((s, c) => s + c.votes, 0);
  return ranked(cands)
    .slice(0, limit)
    .map((c) => {
      const share = total ? (c.votes / total) * 100 : 0;
      return `
        <div class="cand ${c.winner ? 'won' : ''}">
          <span class="swatch" style="background:${partyColor(c)}"></span>
          <span class="name">${esc(c.name)}${c.incumbent ? ' <i title="Incumbent">inc.</i>' : ''}${c.winner ? ' <b class="check">✓</b>' : ''}
            <small>${esc(c.party)}</small></span>
          <span class="pct">${total ? pct(share) : '–'}</span>
          <span class="votes">${num(c.votes)}</span>
          <span class="bar"><span style="width:${share}%;background:${partyColor(c)}"></span></span>
        </div>`;
    })
    .join('');
}

function legend(kind: 'live' | 'past' | 'shift', note = '') {
  const items =
    kind === 'shift'
      ? [[shiftFill(0.15), 'Shift toward D'], [shiftFill(0.02), 'Small shift'], [shiftFill(-0.15), 'Shift toward R']]
      : kind === 'past'
        ? [[marginFill(0.4), 'D +40'], [marginFill(0.05), 'D +5'], [marginFill(-0.05), 'R +5'], [marginFill(-0.4), 'R +40']]
        : [[PARTY.D, 'D called'], [liveFill([{ party: 'Democratic', votes: 52, color: '', name: '', percent: 0, winner: false }, { party: 'Republican', votes: 48, color: '', name: '', percent: 0, winner: false }])!, 'D leading'],
           [liveFill([{ party: 'Republican', votes: 52, color: '', name: '', percent: 0, winner: false }, { party: 'Democratic', votes: 48, color: '', name: '', percent: 0, winner: false }])!, 'R leading'], [PARTY.R, 'R called'], [NO_DATA, 'No votes yet']];
  $('#legend').innerHTML =
    items.map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('') +
    (note ? `<span class="muted">${note}</span>` : '');
}

// ----- national view -----

async function renderNation(history: History) {
  const { chamber, mode } = route;
  const race = nationalRaces.get(chamber);
  const forecast = await getForecast(chamber);
  $('#crumbs').innerHTML = `<b>United States</b> · ${CHAMBER[chamber].label}`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const past = mode !== 'live' && mode !== 'shift' ? history[mode] : undefined;
  let usedForecast = false;
  const shapes = atlas.states.map((shape) => {
    const postal = POSTAL_BY_FIPS[shape.id];
    const name = STATES[postal]?.name ?? shape.properties.name;
    if (past) {
      const p = past[shape.id];
      if (!p) return { shape, fill: NO_RACE };
      tips.set(shape.id, `<b>${name}</b><div>${mode} president: ${fmtMargin(pastMargin(p))}</div><div class="muted">${num(p.t)} votes</div>`);
      return { shape, fill: marginFill(pastMargin(p)), link: href({ state: postal }) };
    }
    if (chamber === 'house') return houseState(shape, postal, name);
    const region = postal && stateRegion(chamber, postal);
    if (!region) {
      tips.set(shape.id, `<b>${name}</b><div class="muted">No ${CHAMBER[chamber].label.toLowerCase()} race</div>`);
      return { shape, fill: NO_RACE };
    }
    let fill = liveFill(region.candidates);
    const rating = forecast[postal];
    if (!fill) {
      fill = ratingFill(rating?.rating) ?? NO_DATA;
      usedForecast ||= !!rating;
    }
    tips.set(shape.id, `<b>${esc(region.name)}</b>${rating ? ` <span class="chip">${esc(rating.rating)}</span>` : ''}
      <div class="mini">${candidateRows(region.candidates, 3)}</div>
      <div class="muted">${pct(region.percent_reporting)} reporting</div>`);
    return { shape, fill, cls: 'race', link: href({ state: postal }) };
  });
  drawShapes(shapes, `<path class="borders" d="${path(atlas.nation as never)}"/>`);
  legend(past ? 'past' : 'live', usedForecast ? 'Lighter shades before votes: forecast rating' : '');

  const panel = $('#panel');
  if (!race) {
    panel.innerHTML = `<p class="muted">Loading results…</p>`;
    return;
  }
  if (past) {
    panel.innerHTML = balance(race) + pastSummary(past, mode);
  } else if (chamber === 'house') {
    panel.innerHTML = balance(race) + houseList(race);
  } else {
    panel.innerHTML = balance(race) + raceList(race, forecast);
  }
}

function houseState(shape: Shape, postal: string, name: string) {
  const districts = houseDistricts(postal);
  if (!districts.length) return { shape, fill: NO_RACE };
  let d = 0, r = 0, counted = 0;
  for (const [, reg] of districts) {
    const lead = ranked(reg.candidates)[0];
    if (!lead || !reg.candidates.some((c) => c.votes)) continue;
    counted++;
    if (side(lead.party) === 'D') d++;
    else if (side(lead.party) === 'R') r++;
  }
  tips.set(shape.id, `<b>${name}</b><div>${districts.length} district${districts.length > 1 ? 's' : ''}</div>
    <div>Leading: <span style="color:${PARTY.D}">D ${d}</span> · <span style="color:${PARTY.R}">R ${r}</span></div>`);
  const fill = counted ? marginFill((d - r) / counted / 2.5) : NO_DATA;
  return { shape, fill, cls: 'race', link: href({ state: postal }) };
}

function balance(race: Race): string {
  const info = CHAMBER[route.chamber];
  // Senate/governor roll-ups carry seat counts (holdovers + calls); the House one
  // doesn't, so count called districts instead.
  const regions = Object.values(race.region_results ?? {});
  const seats = (s: 'D' | 'R' | 'O') =>
    route.chamber === 'house'
      ? regions.filter((r) => r.candidates.some((c) => c.winner && side(c.party) === s)).length
      : race.candidates.filter((c) => side(c.party) === s).reduce((n, c) => n + (c.seats ?? 0), 0);
  const d = seats('D'), r = seats('R'), o = seats('O');
  const open = Math.max(0, info.total - d - r - o);
  const w = (n: number) => `${(n / info.total) * 100}%`;
  return `
    <div class="balance">
      <div class="nums"><b style="color:${PARTY.D}">D ${d}</b>${o ? `<b style="color:${PARTY.O}">Oth ${o}</b>` : ''}<b style="color:${PARTY.R}">R ${r}</b></div>
      <div class="seatbar">
        <span style="width:${w(d)};background:${PARTY.D}"></span><span style="width:${w(o)};background:${PARTY.O}"></span>
        <span style="width:${w(open)}" class="open"></span><span style="width:${w(r)};background:${PARTY.R}"></span>
        ${info.majority ? `<i class="maj" style="left:${w(info.majority)}"></i>` : ''}
      </div>
      <div class="muted">${open} ${info.unit} undecided${info.majority ? ` · ${info.majority} for control` : ''}${route.chamber === 'house' ? '' : ' · includes seats not up this year'}</div>
    </div>`;
}

function raceList(race: Race, forecast: Record<string, Rating>): string {
  const rows = Object.entries(race.region_results ?? {}).map(([key, reg]) => {
    const postal = key.toUpperCase();
    const top = ranked(reg.candidates);
    const total = reg.candidates.reduce((s, c) => s + c.votes, 0);
    const margin = total && top[1] ? (top[0].votes - top[1].votes) / total : 1;
    const winner = reg.candidates.find((c) => c.winner);
    const inc = forecast[postal]?.incumbent_party;
    const flip = winner && inc && side(winner.party) !== inc && side(winner.party) !== 'O';
    return { postal, reg, top, total, margin, winner, flip, rating: forecast[postal]?.rating };
  });
  // Races with votes and no call first, closest first; then the rest alphabetically.
  rows.sort((a, b) => {
    const ka = a.total && !a.winner ? 0 : 1;
    const kb = b.total && !b.winner ? 0 : 1;
    return ka - kb || (ka === 0 ? a.margin - b.margin : a.reg.name.localeCompare(b.reg.name));
  });
  return `<h3>Races</h3><div class="cards">${rows
    .map(
      (r) => `
      <a class="card" href="${href({ state: r.postal })}">
        <div class="card-h"><b>${esc(STATES[r.postal]?.name ?? r.reg.name)}</b>
          ${r.flip ? '<span class="chip flip">FLIP</span>' : ''}${r.rating && !r.total ? `<span class="chip">${esc(r.rating)}</span>` : ''}
          <span class="muted">${pct(r.reg.percent_reporting)}</span></div>
        ${r.top
          .slice(0, 2)
          .map((c) => `<div class="line"><i style="background:${partyColor(c)}"></i>${esc(lastName(c.name))}${c.winner ? ' ✓' : ''}<span>${r.total ? pct((c.votes / r.total) * 100) : ''}</span></div>`)
          .join('')}
      </a>`,
    )
    .join('')}</div>`;
}

function houseList(race: Race): string {
  const byState = new Map<string, Region[]>();
  for (const [k, reg] of Object.entries(race.region_results ?? {})) {
    const p = k.split('-')[0].toUpperCase();
    byState.set(p, [...(byState.get(p) ?? []), reg]);
  }
  const close = Object.entries(race.region_results ?? {})
    .map(([k, reg]) => {
      const [a, b] = ranked(reg.candidates);
      const total = reg.candidates.reduce((s, c) => s + c.votes, 0);
      return { k, reg, a, margin: total && b ? (a.votes - b.votes) / total : 2 };
    })
    .filter((x) => x.margin < 2 && !x.reg.candidates.some((c) => c.winner))
    .sort((x, y) => x.margin - y.margin)
    .slice(0, 12);
  return `
    ${close.length ? `<h3>Closest uncalled districts</h3><div class="cards">${close
      .map((x) => `<a class="card" href="${href({ state: x.k.split('-')[0].toUpperCase() })}"><div class="card-h"><b>${x.k.toUpperCase()}</b><span class="muted">${pct(x.reg.percent_reporting)}</span></div>
        <div class="line"><i style="background:${partyColor(x.a)}"></i>${esc(lastName(x.a.name))} +${(x.margin * 100).toFixed(1)}</div></a>`)
      .join('')}</div>` : ''}
    <h3>States</h3><div class="cards">${[...byState]
      .sort(([a], [b]) => (STATES[a]?.name ?? a).localeCompare(STATES[b]?.name ?? b))
      .map(([p, regs]) => {
        const won = (s: string) => regs.filter((r) => r.candidates.some((c) => c.winner && side(c.party) === s)).length;
        return `<a class="card" href="${href({ state: p })}"><div class="card-h"><b>${esc(STATES[p]?.name ?? p)}</b><span class="muted">${regs.length}</span></div>
          <div class="line">Called: <span style="color:${PARTY.D}">D ${won('D')}</span> · <span style="color:${PARTY.R}">R ${won('R')}</span></div></a>`;
      })
      .join('')}</div>`;
}

function pastSummary(past: Record<string, { d: number; r: number; t: number }>, year: string): string {
  const d = Object.values(past).reduce((s, p) => s + p.d, 0);
  const r = Object.values(past).reduce((s, p) => s + p.r, 0);
  const t = Object.values(past).reduce((s, p) => s + p.t, 0);
  const close = Object.entries(past)
    .map(([f, p]) => ({ postal: POSTAL_BY_FIPS[f], m: pastMargin(p) }))
    .sort((a, b) => Math.abs(a.m) - Math.abs(b.m))
    .slice(0, 10);
  return `
    <h3>${year} presidential popular vote</h3>
    <div class="cand"><span class="swatch" style="background:${PARTY.D}"></span><span class="name">Democratic</span><span class="pct">${pct((d / t) * 100)}</span><span class="votes">${num(d)}</span></div>
    <div class="cand"><span class="swatch" style="background:${PARTY.R}"></span><span class="name">Republican</span><span class="pct">${pct((r / t) * 100)}</span><span class="votes">${num(r)}</span></div>
    <h3>Closest states</h3><div class="cards">${close
      .map((c) => `<a class="card" href="${href({ state: c.postal })}"><div class="card-h"><b>${STATES[c.postal]?.name}</b></div><div class="line">${fmtMargin(c.m)}</div></a>`)
      .join('')}</div>`;
}

// ----- state view -----

async function renderState(years: string[]) {
  const { chamber, mode } = route;
  const postal = route.state!;
  const st = STATES[postal];
  const history = await getHistory(st.fips);
  const stateShape = atlas.states.find((s) => s.id === st.fips);
  const counties = atlas.counties.filter((c) => c.id.startsWith(st.fips));

  $('#crumbs').innerHTML = `<a href="${href({ state: undefined })}">United States</a> › <b>${st.name}</b> · ${CHAMBER[chamber].label}`;
  if (stateShape) {
    const [[x0, y0], [x1, y1]] = path.bounds(stateShape);
    const pad = Math.max(x1 - x0, y1 - y0) * 0.06;
    svg.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`);
  }

  const region = chamber !== 'house' ? stateRegion(chamber, postal) : undefined;
  const race = region?.election_id ? stateRaces.get(region.election_id) : undefined;

  // Match civicAPI's county breakdown to map shapes by FIPS, falling back to name.
  const byFips = new Map<string, Region>();
  if (race?.region_results) {
    const byName = new Map(counties.map((c) => [countyKey(c.properties.name), c.id]));
    for (const reg of Object.values(race.region_results)) {
      if (reg.type === 'State') continue;
      const fips = reg.fips && reg.fips.length === 5 ? reg.fips : byName.get(countyKey(reg.name));
      if (fips) byFips.set(fips, reg);
    }
  }
  const latest = years[0];
  const compareYear = mode !== 'live' && mode !== 'shift' ? mode : latest;

  const shapes = counties.map((shape) => {
    const reg = byFips.get(shape.id);
    const p = history[compareYear]?.[shape.id];
    const pLatest = history[latest]?.[shape.id];
    const live = reg ? liveMargin(reg.candidates) : null;
    let fill = NO_DATA;
    if (mode === 'live') fill = (reg && liveFill(reg.candidates, false)) ?? NO_DATA;
    else if (mode === 'shift') fill = live != null && pLatest ? shiftFill(live - pastMargin(pLatest)) : NO_DATA;
    else if (p) fill = marginFill(pastMargin(p));

    const lines = [`<b>${esc(reg?.name ?? `${shape.properties.name} County`)}</b>`];
    if (reg) lines.push(`<div class="mini">${candidateRows(reg.candidates, 3)}</div><div class="muted">${pct(reg.percent_reporting)} reporting</div>`);
    for (const y of years) {
      const py = history[y]?.[shape.id];
      if (py) lines.push(`<div>${y} president: ${fmtMargin(pastMargin(py))} <span class="muted">(${num(py.t)} votes)</span></div>`);
    }
    if (live != null && pLatest) lines.push(`<div><b>Shift vs ${latest}: ${fmtMargin(live - pastMargin(pLatest))}</b></div>`);
    tips.set(shape.id, lines.join(''));
    return { shape, fill, cls: 'county' };
  });
  drawShapes(shapes, stateShape ? `<path class="borders state" d="${path(stateShape)}"/>` : '');

  const matched = byFips.size;
  const regionCount = Object.values(race?.region_results ?? {}).filter((r) => r.type !== 'State').length;
  const note =
    chamber === 'house' && mode === 'live'
      ? 'District shapes aren’t mapped yet. Switch to a past year to see counties.'
      : race && regionCount && matched < regionCount / 2
        ? 'This race reports by areas that don’t match county shapes; see the table.'
        : '';
  legend(mode === 'shift' ? 'shift' : 'past', note);

  const panel = $('#panel');
  if (chamber === 'house') {
    panel.innerHTML = districtCards(postal);
    return;
  }
  if (!region) {
    panel.innerHTML = `<h2>${st.name}</h2><p class="muted">No ${CHAMBER[chamber].label.toLowerCase()} race in ${st.name} this year.</p>${pastStatewide(history, years)}`;
    return;
  }
  const forecast = (await getForecast(chamber))[postal];
  const cands = race?.candidates ?? region.candidates;
  panel.innerHTML = `
    <h2>${esc(race?.election_name ?? region.name)}</h2>
    <div class="meta">
      <span>${pct(race?.percent_reporting ?? region.percent_reporting)} reporting</span>
      ${forecast ? `<span class="chip">${esc(forecast.rating)}</span>` : ''}
      ${race?.polls_close ? `<span class="muted">Polls close ${new Date(race.polls_close).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</span>` : ''}
    </div>
    ${candidateRows(cands)}
    ${pastStatewide(history, years)}
    ${voteBanks(byFips, history, latest)}`;
}

function pastStatewide(history: History, years: string[]): string {
  const rows = years
    .map((y) => {
      const all = Object.values(history[y] ?? {});
      if (!all.length) return '';
      const d = all.reduce((s, p) => s + p.d, 0), r = all.reduce((s, p) => s + p.r, 0), t = all.reduce((s, p) => s + p.t, 0);
      return `<tr><td>${y} president</td><td style="color:${d >= r ? PARTY.D : PARTY.R}">${fmtMargin((d - r) / t)}</td><td class="muted">${num(t)}</td></tr>`;
    })
    .join('');
  return rows ? `<h3>Past results</h3><table class="tbl">${rows}</table>` : '';
}

/** The biggest counties by vote, the Magic Wall "where are the votes still out" view. */
function voteBanks(byFips: Map<string, Region>, history: History, latest: string): string {
  const past = history[latest] ?? {};
  const rows = [...byFips]
    .map(([fips, reg]) => ({ fips, reg, size: past[fips]?.t ?? 0, live: liveMargin(reg.candidates) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 12);
  if (!rows.length) return '';
  return `<h3>Biggest counties</h3>
    <table class="tbl"><tr class="muted"><td>County</td><td>Rep.</td><td>Now</td><td>${latest}</td></tr>${rows
      .map((r) => {
        const p = past[r.fips];
        return `<tr><td>${esc(r.reg.name.replace(/ County$/, ''))}</td><td class="muted">${Math.round(r.reg.percent_reporting)}%</td>
          <td>${r.live == null ? '–' : `<span style="color:${r.live >= 0 ? PARTY.D : PARTY.R}">${fmtMargin(r.live)}</span>`}</td>
          <td>${p ? `<span style="color:${p.d >= p.r ? PARTY.D : PARTY.R}">${fmtMargin(pastMargin(p))}</span>` : '–'}</td></tr>`;
      })
      .join('')}</table>`;
}

function districtCards(postal: string): string {
  const districts = houseDistricts(postal).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  if (!districts.length) return `<p class="muted">No House races found for ${STATES[postal].name}.</p>`;
  return `<h2>${STATES[postal].name} House</h2><div class="districts">${districts
    .map(([k, reg]) => `<div class="district"><div class="card-h"><b>${k.toUpperCase()}</b><span class="muted">${pct(reg.percent_reporting)}</span></div>${candidateRows(reg.candidates, 3)}</div>`)
    .join('')}</div>`;
}

load();
