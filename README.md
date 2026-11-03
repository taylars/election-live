# Election Live

A "Magic Wall"-style election night site: a national map for the Senate, Governor and House races, with drill-down into county results for each state and comparisons with past presidential results.

It's a static site (Vite + TypeScript + d3-geo) that runs on GitHub Pages. Visitors' browsers fetch live results from [civicAPI](https://civicapi.org) every 30 seconds.

## Views

- **National**: states coloured by leader (solid = called). Before any votes are in, states are shaded by civicAPI's forecast rating. Includes a balance-of-power bar and race cards sorted closest-first.
- **State**: click a state to see its counties, the race details, past statewide results, and the biggest counties ("where the votes are").
- **Modes**: `2026 live`, `2024 pres.` / `2020 pres.` (past maps), and in a state, `Shift vs 2024` (how far each county has moved since 2024).
- URLs are shareable, e.g. `#/senate/ga?mode=shift`.
- Add `?testdata` to the URL (e.g. `/?testdata#/senate`) to have civicAPI fill the races with simulated votes, for rehearsing before polls close.

## Data

| What | Source |
|---|---|
| Live 2026 results, calls, county breakdowns, ratings | [civicAPI](https://civicapi.org) (free, no key, attribution required) |
| 2020 & 2024 county presidential results | [tonmcg/US_County_Level_Election_Results_08-24](https://github.com/tonmcg/US_County_Level_Election_Results_08-24) |
| Map shapes | [us-atlas](https://github.com/topojson/us-atlas) |

Past results are pre-built into `public/data/history/` by `npm run history`. For 2000–2024, download `countypres_2000-2024.tab` from [MIT Election Lab on Harvard Dataverse](https://doi.org/10.7910/DVN/VOQCHQ) (it asks you to fill in a short form), save it as `data-raw/countypres_2000-2024.tab`, and run `npm run history` again.

civicAPI's national roll-up races (Senate `87528`, Governor `87535`, House `87524`) link to every state race, so no race list needs to be maintained.

## Develop

```bash
npm install
npm run dev
```

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds and publishes to GitHub Pages. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions** (once).

## Known gaps

- The House has no district map yet. The state view lists districts as cards.
- Counties are matched by FIPS code; where civicAPI reports by other areas (e.g. Connecticut planning regions), the map stays grey but the race totals still show.
