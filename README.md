# Weather Engine

Personal weather map built on open data, ECCC first. It has a global map with switchable layers and one time bar that drives every layer. Tap anywhere for a GEM / ECMWF / GFS model comparison. Tap any station for its METAR and TAF, in raw or plain language.

**Not an official forecast or warning service.** For official warnings use [weather.gc.ca](https://weather.gc.ca). For flight planning use NAV CANADA.

---

## 1. One-time setup (about 10 minutes)

| Step | Action |
|---|---|
| 1 | Create a free account at github.com. |
| 2 | Create a **public** repository named `weather-engine`. Free GitHub only hosts sites from public repositories. |
| 3 | Put these files in it. Claude can push them for you once GitHub is connected in your claude.ai settings. |
| 4 | In the repo, open **Settings → Pages**. Under *Build and deployment → Source*, pick **GitHub Actions**. |
| 5 | Open the **Actions** tab, select **Update data and deploy**, then **Run workflow**. The first run takes about 3 minutes. |
| 6 | Open `https://<your-username>.github.io/weather-engine/`. On your phone, use **Share → Add to Home Screen** so it opens like an app. |

After that it updates itself every 30 minutes.

## 2. Using it

| Control | What it does |
|---|---|
| **Main layer** (left panel, or the layers button on a phone) | One weather field at a time: temperature, wind, gusts, precipitation, pressure, cloud, thunderstorm potential, waves, ocean temperature, air quality, satellite. |
| **Overlays** | Stack on top of the main layer: radar (rain/snow), lightning, ECCC warnings, coastlines/labels, METAR stations. |
| **Wind animation** (overlay, on by default) | Moving particles from ECCC GDPS 10 m wind, synced to the time bar. Global, out to +5 days. |
| **Time bar** | One clock for every layer. Drag it, step it, press play, or use the jump buttons (−3h to +5d). The past is observations; the future is forecast. |
| **Chips under the time bar** | Show the time each layer is actually displaying, and the model run. If a layer can't match the selected time, its chip says so (e.g. radar shows *observations only* for future times). |
| **Tap the map** | Point forecast: GEM vs ECMWF vs GFS, a model-agreement rating, a 7-day temperature chart, and tables for temp, wind, precip, pressure and cloud. Shows the nearest station within 60 km. |
| **Tap a station dot / search an ICAO code** | METAR and TAF with a **Raw / Plain language** toggle. |
| **Feeds button** | Result of the last automatic check of every source. Green: all good. Amber: something needs a look. Red: no check in over 75 minutes. |

### METAR/TAF decoder
- Rule-based code, not AI. The same report always decodes the same way.
- Handles Canadian practice: cloud opacity remarks in oktas (`SC4AC2`), `SLP`, `PRESRR/PRESFR`, `DENSITY ALT`, `CIG RAG`, `NXT FCST BY`.
- Anything it doesn't recognise is shown under **Not decoded**, never dropped. Treat that as a prompt to check the raw report.

## 3. Source rules

1. Publicly accessible sources only. No restricted networks or logins.
2. Every source has a published reuse licence.
3. No DND/CAF METOC products.
4. ECCC first. Other agencies only fill gaps or serve for comparison.
5. ECCC warnings are shown as published (map layer from ECCC, unaltered).

| Source | Used for | Licence |
|---|---|---|
| ECCC MSC GeoMet | GDPS model fields, GDWPS waves, GIOPS ocean, RAQDPS air quality, radar, lightning, GOES-East satellite, warnings | [ECCC Data Server End-use Licence](https://eccc-msc.github.io/open-data/licence/readme_en/). Attribution shown; no ECCC endorsement implied. |
| Open-Meteo | Point forecasts: GEM (ECCC), ECMWF IFS, GFS (NOAA) | Data CC BY 4.0. Free API is for **non-commercial use only**; business use (e.g. Sackville Staining job planning) needs their paid tier or ECCC data directly. |
| NOAA Aviation Weather Center | METAR/TAF worldwide | US Government public data |
| NASA GIBS | Global satellite IR, true colour, sea surface temperature, satellite rain estimate, Blue Marble relief | NASA open data, attribution shown |
| OpenStreetMap | Street base map | © OpenStreetMap contributors, ODbL |

## 4. How it stays current

`.github/workflows/deploy.yml` runs every 30 minutes on GitHub's free runners:

1. Runs the decoder and data-job tests.
2. `scripts/build-data.mjs` pulls METAR/TAF, then reads the **live** ECCC and NASA layer catalogues and resolves each map layer by name and rule. ECCC is mid-way through renaming its GDPS layers (`GDPS.ETA_*` → `GDPS_15km_*`), so names are never hard-coded.
3. It builds the wind animation grids from ECCC GDPS 10 m wind (GeoMet WCS). Only new forecast hours are requested from ECCC; hours already published for the same model run are reused, and requests are paced because ECCC rate-limits rapid calls.
4. It checks every feed for age and availability and writes `status.json`. That is the **Feeds** button, and the run's *Summary* page on GitHub.
5. It republishes the site. If one source fails, the rest still publish, and the failed one keeps its last good copy marked *stale*.

## 5. Maintenance

| Symptom | Fix |
|---|---|
| A layer is struck through, or Feeds shows *Check* for it | ECCC or NASA renamed or retired it. Find the new name in the run's Summary or the source catalogue and add it to `candidates` in `site/config/layers.json`. |
| Site stops updating after ~2 months | GitHub pauses scheduled jobs in repos with no activity for 60 days. Actions tab → **Update data and deploy** → **Enable workflow**. Any commit also resets the clock. |
| A METAR shows lines under *Not decoded* | Real-world format the rules don't cover yet. Add a test in `test/decoder.test.mjs` with the report, then extend `site/js/decoder.js`. |
| Run the tests locally | `npm test` (Node 20+) |
| Check the live site visually | Actions tab → **Snapshot** → **Run workflow**. Screenshots land on the `snapshots` branch. |

## 6. Known gaps (version 1)

- **Radar** covers Canada and the USA only. No open global radar exists; use *Rain rate (satellite estimate)* elsewhere.
- **Lightning** covers Canada (+250 km) only.
- **Warnings** cover Canada only.
- **Global satellite IR** has no coverage over Europe, Africa or the Indian Ocean. NASA GIBS doesn't carry Meteosat; true colour covers it daily.
- **Wind animation** uses a 1° grid (about 110 km), so it shows the flow pattern, not local gusts. The colour layers underneath carry the 15 km detail.

## 7. Roadmap

- **Phase 2: analysis.** An AI watchdog reviews `status.json` and cross-checks layers (radar vs model vs METAR). Anomaly flags against ECCC climate normals. Daily brief.
- **Phase 3: depth.** Storm and tropical tracking (Canadian Hurricane Centre / NHC), real-time alerts. (Animated wind is done: built by the scheduled job from ECCC GDPS, no home server needed.)

## Layout

```
site/                  the published website
  index.html
  css/app.css
  js/app.js            map, time sync, point forecast, METAR/TAF panel
  js/decoder.js        METAR/TAF decoder (rule-based)
  js/timeext.js        time snapping shared by site and data job
  js/wind.js           wind particle animation
  config/layers.json   layer definitions: edit layers here
  data/                written by the scheduled job (not committed)
scripts/build-data.mjs scheduled data job
scripts/wind.mjs       wind animation grids from ECCC GDPS
scripts/tiff.mjs       GeoTIFF reader for ECCC raw data
scripts/snapshot.mjs   live-site screenshots (Snapshot workflow)
test/                  decoder, time and data-job tests
.github/workflows/     schedule + deploy
```
