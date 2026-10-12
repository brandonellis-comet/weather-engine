// One-off diagnostics for hazard sources (run by the Probe workflow).
const UA = 'weather-engine (personal, non-commercial; github.com)';
const notes = [];
const note = (s) => { notes.push(s); };
async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Origin: 'https://example.github.io' }, signal: AbortSignal.timeout(90000) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type'), acao: r.headers.get('access-control-allow-origin'), enc: r.headers.get('content-encoding'), text: buf.toString('utf8'), size: buf.length };
}
const short = (s, n = 260) => s.replace(/\s+/g, ' ').slice(0, n);
async function probe(label, fn) { try { await fn(); } catch (e) { note(`${label}: ERROR ${String(e.message || e).slice(0, 200)}`); } }
const CW = 'https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wfs';

await probe('nhc', async () => {
  const r = await get('https://www.nhc.noaa.gov/CurrentStorms.json');
  note(`nhc CurrentStorms: ${r.status} acao=${r.acao} size=${r.size} ${short(r.text, 900)}`);
  const r2 = await get('https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer?f=json');
  let info = short(r2.text, 200);
  try { const j = JSON.parse(r2.text); info = (j.layers || []).map((l) => `${l.id}:${l.name}`).join(' | ').slice(0, 1500); } catch {}
  note(`nhc mapserver: ${r2.status} acao=${r2.acao} ${info}`);
});
await probe('firms', async () => {
  for (const f of ['noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv', 'noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv', 'suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv']) {
    const r = await get(`https://firms.modaps.eosdis.nasa.gov/data/active_fire/${f}`);
    const lines = r.text.split('\n');
    const conf = {}; for (const l of lines.slice(1)) { const c = l.split(',')[8]; if (c) conf[c] = (conf[c] || 0) + 1; }
    note(`firms ${f.split('/').pop()}: ${r.status} rows=${lines.length - 1} size=${r.size} conf=${JSON.stringify(conf)} first=${short(lines[1] || '', 140)}`);
  }
});
await probe('cwfis cql', async () => {
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const r = await get(`${CW}?service=WFS&version=2.0.0&request=GetFeature&typeNames=public:m3_polygons_current&outputFormat=application/json&CQL_FILTER=${encodeURIComponent(`lastdate >= '${since}'`)}`);
  let info = short(r.text, 200);
  try { const j = JSON.parse(r.text); info = `n=${j.features.length} areas=${j.features.map((f) => Math.round(f.properties.area)).slice(0, 12).join(',')}`; } catch {}
  note(`cwfis m3 since ${since}: ${r.status} acao=${r.acao} size=${r.size} ${info}`);
  const r2 = await get(`${CW}?service=WFS&version=2.0.0&request=GetFeature&typeNames=public:hotspots_last24hrs&outputFormat=application/json&bbox=54,-127,56,-125,EPSG:4326&count=3`);
  let i2 = short(r2.text, 200);
  try { const j = JSON.parse(r2.text); i2 = `n=${j.features.length} geom=${JSON.stringify(j.features[0]?.geometry)}`; } catch {}
  note(`cwfis hotspots bbox: ${r2.status} acao=${r2.acao} ${i2}`);
  const r3 = await get(`${CW}?service=WFS&version=2.0.0&request=GetFeature&typeNames=public:hotspots_last24hrs&outputFormat=application/json&propertyName=lat,lon,rep_date,agency&count=2000`);
  note(`cwfis hotspots slim: ${r3.status} size=${r3.size} enc=${r3.enc}`);
});
await probe('eccc hurricanes all', async () => {
  for (const id of ['hurricanes-track-realtime', 'hurricanes-error_cone-realtime', 'hurricanes-cyclone-realtime', 'hurricanes-wind_radii-realtime']) {
    const r = await get(`https://api.weather.gc.ca/collections/${id}/items?f=json&limit=3`);
    const j = JSON.parse(r.text);
    note(`${id}: ${r.status} matched=${j.numberMatched} props=${JSON.stringify(j.features?.[0]?.properties).slice(0, 500)} geom=${j.features?.[0]?.geometry?.type}`);
  }
});
await probe('alerts legend', async () => {
  const r = await get('https://geo.weather.gc.ca/geomet?service=WMS&version=1.3.0&request=GetLegendGraphic&sld_version=1.1.0&format=application/json&layer=Current-Alerts');
  note(`alerts legend json: ${r.status} ${r.type} ${short(r.text, 900)}`);
  const r2 = await get('https://geo.weather.gc.ca/geomet?service=WMS&version=1.3.0&request=GetStyles&layers=Current-Alerts');
  const fills = [...r2.text.matchAll(/(?:Name|Title)>([^<]{1,60})<|"fill">(#[0-9a-fA-F]{6})/g)].map((m) => m[1] || m[2]).slice(0, 60).join(' ');
  note(`alerts styles: ${r2.status} ${r2.type} size=${r2.size} ${fills.slice(0, 1200)}`);
});
console.log(notes.join('\n'));
for (let i = 0; i < notes.length; i++) console.log(`::notice title=probe ${i + 1}::${notes[i]}`);
