import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

const now = new Date();
const iso = (h) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + h)).toISOString().replace('.000Z', 'Z');

// Synthetic fixtures shaped like the real sources (nested WMS layers, CSV header block, XML TAFs).
const geometCaps = `<?xml version="1.0"?><WMS_Capabilities><Capability><Layer><Title>MSC GeoMet</Title>
<Layer><Title>Global Deterministic Prediction System</Title>
  <Layer queryable="1"><Name>GDPS_15km_AirTemp_2m</Name><Title>GDPS - 15 km - Air temperature at 2 m above ground [°C]</Title>
    <Dimension name="time" units="ISO8601" default="${iso(0)}">${iso(-3)}/${iso(240)}/PT3H</Dimension>
    <Dimension name="reference_time" units="ISO8601" default="${iso(-6)}">${iso(-30)}/${iso(-6)}/PT12H</Dimension>
    <Style><Name>TEMPERATURE</Name><Title>Temp</Title></Style></Layer>
  <Layer queryable="1"><Name>GDPS-WEonG_15km_AirTemp</Name><Title>GDPS-WEonG - Air temperature</Title></Layer>
  <Layer queryable="1"><Name>GDPS.ETA_UU</Name><Title>GDPS.ETA - Winds [km/h]</Title>
    <Dimension name="time" units="ISO8601" default="${iso(0)}">${iso(0)}/${iso(240)}/PT3H</Dimension></Layer>
  <Layer queryable="1"><Name>GDPS.ETA_PR</Name><Title>GDPS.ETA - Precipitation accumulation [mm]</Title>
    <Dimension name="time" units="ISO8601">${iso(3)}/${iso(240)}/PT3H</Dimension></Layer>
</Layer>
<Layer><Title>Radar</Title>
  <Layer><Name>RADAR_1KM_RRAI</Name><Title>Radar precipitation rate (rain) [mm/h]</Title>
    <Dimension name="time" units="ISO8601">${iso(-3)}/${iso(0)}/PT6M</Dimension></Layer>
  <Layer><Name>RADAR_1KM_RSNO</Name><Title>Radar precipitation rate (snow) [cm/h]</Title>
    <Dimension name="time" units="ISO8601">${iso(-5)}/${iso(-3)}/PT6M</Dimension></Layer>
</Layer>
<Layer><Name>Current-Alerts</Name><Title>Current alerts</Title></Layer>
<Layer><Name>Lightning_2.5km_Density</Name><Title>Lightning flash density [flash/km2/min]</Title>
  <Dimension name="time" units="ISO8601">${iso(-3)}/${iso(0)}/PT10M</Dimension></Layer>
<Layer><Name>GDWPS_25km_HTSGW</Name><Title>GDWPS - Significant height of combined wind waves and swell [m]</Title>
  <Dimension name="time" units="ISO8601">${iso(0)}/${iso(120)}/PT1H</Dimension></Layer>
<Layer><Name>GDWPS_25km_SWELL</Name><Title>GDWPS - Significant height of swell [m]</Title></Layer>
<Layer><Name>RAQDPS_10km_PM2.5_Surface</Name><Title>RAQDPS - PM2.5 at surface</Title>
  <Dimension name="time" units="ISO8601">${iso(0)}/${iso(72)}/PT1H</Dimension></Layer>
</Layer></Capability></WMS_Capabilities>`;

const gibsCaps = `<WMS_Capabilities><Capability><Layer>
<Layer><Name>GHRSST_L4_MUR_Sea_Surface_Temperature</Name><Title>Sea Surface Temperature (L4, MUR)</Title>
  <Dimension name="time" units="ISO8601" default="2026-10-10">2002-06-01/2026-10-10/P1D</Dimension></Layer>
<Layer><Name>VIIRS_SNPP_CorrectedReflectance_TrueColor</Name><Title>Corrected Reflectance (True Color)</Title>
  <Dimension name="time" units="ISO8601" default="2026-10-11">2015-11-24/2026-10-11/P1D</Dimension></Layer>
<Layer><Name>Himawari_AHI_Band13_Clean_Infrared</Name><Title>Himawari IR</Title>
  <Dimension name="time" units="ISO8601">${iso(-24)}/${iso(0)}/PT10M</Dimension></Layer>
<Layer><Name>GOES-East_ABI_Band13_Clean_Infrared</Name><Title>GOES-East IR</Title>
  <Dimension name="time" units="ISO8601">${iso(-24)}/${iso(0)}/PT10M</Dimension></Layer>
<Layer><Name>Coastlines_15m</Name><Title>Coastlines</Title></Layer>
</Layer></Capability></WMS_Capabilities>`;

const metarCsv = [
  'No errors', 'No warnings', '12 ms', 'data source=metars', '3 results',
  'raw_text,station_id,observation_time,latitude,longitude,temp_c',
  'CYHZ 111500Z 25012G22KT 15SM -SHRA FEW020 BKN045 08/04 A2987 RMK SC2SC3 SLP117,CYHZ,2026-10-11T15:00:00Z,44.88,-63.51,8',
  'CYQX 111500Z 03018KT 3SM -SN OVC010 M02/M03 A2958 RMK SC8 SLP018,CYQX,2026-10-11T15:00:00Z,48.94,-54.57,-2',
  'EGLL 111520Z 22015KT 9999 FEW030 15/09 Q1012 NOSIG,EGLL,2026-10-11T15:20:00Z,51.48,-0.45,15',
].join('\n');

const tafXml = `<response><data num_results="1"><TAF><raw_text>TAF CYHZ 111440Z 1115/1218 25015G25KT P6SM SCT030 BKN060 RMK NXT FCST BY 18Z</raw_text><station_id>CYHZ</station_id><issue_time>2026-10-11T14:40:00Z</issue_time></TAF></data></response>`;
const stations = [{ icaoId: 'CYHZ', site: 'Halifax/Stanfield Intl', state: 'NS', country: 'CA' }];
const om = (vals) => JSON.stringify({ hourly: { time: ['2026-10-11T00:00'], temperature_2m: vals } });

test('data job builds METAR, TAF, catalogue and status from source-shaped inputs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'we-'));
  const fx = path.join(dir, 'fx'); const out = path.join(dir, 'out');
  await mkdir(fx);
  await writeFile(path.join(fx, 'geomet-caps.xml'), geometCaps);
  await writeFile(path.join(fx, 'gibs-caps.xml'), gibsCaps);
  await writeFile(path.join(fx, 'metars.cache.csv.gz'), gzipSync(metarCsv));
  await writeFile(path.join(fx, 'tafs.cache.xml.gz'), gzipSync(tafXml));
  await writeFile(path.join(fx, 'stations.cache.json.gz'), gzipSync(JSON.stringify(stations)));
  await writeFile(path.join(fx, 'openmeteo-gem_seamless.json'), om([10]));
  await writeFile(path.join(fx, 'openmeteo-ecmwf_ifs025.json'), om([null]));
  await writeFile(path.join(fx, 'openmeteo-ecmwf_ifs.json'), om([11]));
  await writeFile(path.join(fx, 'openmeteo-gfs_seamless.json'), om([12]));
  process.env.FIXTURES_DIR = fx; process.env.OUT_DIR = out;

  const { main } = await import('../scripts/build-data.mjs');
  await main();
  const read = async (n) => JSON.parse(await readFile(path.join(out, n), 'utf8'));
  const metar = await read('metar.json'); const taf = await read('taf.json');
  const cat = await read('catalog.json'); const st = await read('status.json');

  assert.equal(metar.stations.length, 3);
  assert.deepEqual(metar.stations[0].slice(0, 4), ['CYHZ', 44.88, -63.51, 'Halifax/Stanfield Intl, NS, CA']);
  assert.match(taf.tafs.CYHZ.raw, /^TAF CYHZ/);

  // exact candidate, legacy fallback name, regex match, and GIBS fallback
  assert.deepEqual(cat.layers.temp.names, ['GDPS_15km_AirTemp_2m']);
  assert.equal(cat.layers.temp.reference, iso(-6));
  assert.deepEqual(cat.layers.wind.names, ['GDPS.ETA_UU']);
  assert.deepEqual(cat.layers.precip.names, ['GDPS.ETA_PR']);
  assert.deepEqual(cat.layers.waves.names, ['GDWPS_25km_HTSGW']);
  assert.deepEqual(cat.layers.aq.names, ['RAQDPS_10km_PM2.5_Surface']);
  assert.deepEqual(cat.layers.sst.names, ['GHRSST_L4_MUR_Sea_Surface_Temperature']);
  assert.equal(cat.layers.sst.source, 'gibs');
  assert.equal(cat.layers.sst.kind, 'daily');
  assert.deepEqual(cat.layers.sat_ir.names, ['Himawari_AHI_Band13_Clean_Infrared', 'GOES-East_ABI_Band13_Clean_Infrared']);
  assert.deepEqual(cat.layers.lightning.names, ['Lightning_2.5km_Density']);
  assert.equal(cat.layers.cape, undefined);
  assert.deepEqual(cat.models.ecmwf, { id: 'ecmwf_ifs', label: 'ECMWF IFS' });

  // watchdog: snow radar 3 h old is flagged; missing layer reported
  assert.equal(st.layers.radar.ok, true);
  assert.equal(st.layers.radar_snow.ok, false);
  assert.match(st.layers.radar_snow.warning, /min old/);
  assert.equal(st.layers.cape.ok, false);
  assert.equal(st.sources.metar.count, 3);
});
