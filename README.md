# Election Live

A "Magic Wall"-style election night site. Pick a race (President, Senate, Governor, House) and a year (2026 live, or 2024 / 2022 / 2020), then drill from the national map into a state, and for the House into a single district.

It's a static site (Vite + TypeScript + d3-geo) that runs on GitHub Pages. For 2026, visitors' browsers fetch live results from [civicAPI](https://civicapi.org); past years are packaged into the site.

## Views

- **National**: states, or all 435 districts for the House, coloured by leader. Live, a called race is solid; past years are shaded by margin. Before votes come in, 2026 races are shaded by civicAPI's forecast rating.
- **Tally**:
  - President: electoral votes, with Maine and Nebraska split by district.
  - 2026: secured seats (called races plus seats not up), and a projection that adds each uncalled race as *likely*, *lean* or *toss-up*. Before a race reaches 15% reporting its tier comes from civicAPI's forecast rating (Safe/Likely → likely, Lean/Tilt → lean); after that it comes from the live margin weighed against the share of the vote still out (`src/projection.ts`). Race cards show each race's current tier; a • marks tiers based on live results.
  - Past Senate/Governor: the chamber as seated the following January, plus seats won that year. Past House: seats won.
- **State**: counties coloured by the race: live 2026 county results, or past presidential, Senate and Governor county results where available (otherwise the statewide result).
- **County** (President, Senate, Governor): click a county on a state's map. Shows the selected race in that county (live 2026, or past presidential, Senate and Governor results) and the county's past presidential results.
- **State House delegation**: a state's House page tallies its seats by party (live: called seats plus the projection; past: seats won) and lists the delegation in other years.
- **District** (House): click a district on a state's map, or its card, for its result and the seat's results in 2020–2024.
- URLs are shareable, e.g. `#/senate/2024/ga`, `#/house/2026/mi/07` or `#/senate/2026/ga/county/13121`.
- Add `?testdata` to the URL (e.g. `/?testdata#/senate/2026`) to have civicAPI fill the races with simulated votes, for rehearsing before polls close.

### Live updates and caching

civicAPI responses are cached in localStorage for an hour, so reloading the page or switching tabs, states or years reuses them instead of calling the API. Auto-refresh polls the current view every 5 minutes (counted from page load or the last refresh), and the poll and the **Refresh** button skip the cache and update it. Auto-refresh can be switched off; the choice is remembered per browser.

## Data

| What | Source | Built by |
|---|---|---|
| Live 2026 results, calls, county breakdowns, ratings | [civicAPI](https://civicapi.org) (free, no key, attribution required) | fetched live |
| Past Senate, Governor, House and President results (2020–2024) | [FiveThirtyEight election-results](https://github.com/fivethirtyeight/election-results) (CC BY 4.0) | `npm run past` → `public/data/past/` |
| Past county Senate & Governor results | 2022 & 2024: [MIT Election Data + Science Lab](https://github.com/MEDSL) official returns (2024 Senate county file; otherwise precincts summed to counties). 2020: [OpenElections](https://github.com/openelections) county/precinct files | `npm run counties` → `public/data/counties/` |
| 2020 & 2024 county presidential results | [tonmcg/US_County_Level_Election_Results_08-24](https://github.com/tonmcg/US_County_Level_Election_Results_08-24) | `npm run history` → `public/data/history/` |
| District lines: 2026 | civicAPI's district map (includes the 2025 mid-decade redraws) | `npm run districts` → `public/data/districts-*.json` |
| District lines: 2020, 2022, 2024 | US Census Bureau cartographic boundary files (116th, 118th, 119th Congress) | `npm run districts` |
| State & county shapes | [us-atlas](https://github.com/topojson/us-atlas) | npm package |

All packaged data is committed, so builds don't need the network. County Senate and Governor results are checked against the statewide totals; a race whose top two candidates are more than 1% off is left out and shows the statewide result instead. Coverage: 2024 Senate 34/35 and Governor 9/11; 2022 Senate 32/36 and Governor 33/36; 2020 Senate 18/35 and Governor 8/11 (2020 relies on OpenElections, which is missing or incomplete for several states). For county presidential results back to 2000, download `countypres_2000-2024.tab` from [MIT Election Lab on Harvard Dataverse](https://doi.org/10.7910/DVN/VOQCHQ) (it asks you to fill in a short form), save it as `data-raw/countypres_2000-2024.tab`, and run `npm run history` again.

civicAPI's national roll-up races (Senate `87528`, Governor `87535`, House `87524`) link to every state and district race, so no race list needs to be maintained.

## Develop

```bash
npm install
npm run dev
```

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds and publishes to GitHub Pages. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions** (once).

## Known gaps

- Some past Senate and Governor races have no county breakdown (see coverage above).
- No "difference vs a past election" view yet.
- Counties are matched by FIPS code; where civicAPI reports by other areas (e.g. Connecticut planning regions), the map stays grey but the race totals still show.
