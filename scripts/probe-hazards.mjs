// One-off diagnostics for hazard sources (run by the Probe workflow).
// Prints GitHub notices so results show on the run page.
const UA = 'weather-engine (personal, non-commercial; github.com)';
const notes = [];
const note = (s) => { notes.push(s); };

async function get(url, opts = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Origin: 'https://example.github.io', ...(opts.headers || {}) }, signal: AbortSignal.timeout(60000) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type'), acao: r.headers.get('access-control-allow-origin'), text: buf.toString('utf8'), size: buf.length };
}
const short = (s, n = 260) => s.replace(/\s+/g, ' ').slice(0, n);
async function probe(label, fn) {
  try { await fn(); } catch (e) { note(`${label}: ERROR ${String(e.message || e).slice(0, 200)}`); }
}
const CW = 'https://cwfis.cfs.nrcan.gc.ca/geoserver';

await probe('alerts select', async () => {
  const props = 'alert_name_en,alert_type,risk_colour_en,status_en,feature_name_en,province,publication_datetime,expiration_datetime,alert_code,feature_id';
  const r = await get(`https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=1000&skipGeometry=true&properties=${props}`);
  const j = JSON.parse(r.text);
  const f = j.features || [];
  note(`alerts properties-select: ${r.status} size=${r.size} n=${f.length} keys=${Object.keys(f[0]?.properties || {}).join(',')}`);
  const st = {}; for (const x of f) st[x.properties.status_en] = (st[x.properties.status_en] || 0) + 1;
  const texts = new Set();
  const full = JSON.parse((await get('https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=1000&skipGeometry=true')).text).features;
  for (const x of full) texts.add(x.properties.alert_text_en);
  note(`alerts status values=${JSON.stringify(st)} distinct texts=${texts.size} id-sample=${JSON.stringify(f[0]?.id)} code-sample=${f.slice(0, 3).map((x) => x.properties.alert_code).join(',')}`);
  const withGeom = (await get('https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=1000&properties=alert_type,risk_colour_en,status_en')).size;
  note(`alerts geometry-only size=${withGeom}`);
  // a point inside a warning/advisory, for GetFeatureInfo
  const g = JSON.parse((await get('https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=20&alert_type=advisory')).text).features?.[0];
  if (g) {
    let ring = g.geometry.type === 'MultiPolygon' ? g.geometry.coordinates[0][0] : g.geometry.coordinates[0];
    const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length, lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const d = 0.05;
    const u = `https://geo.weather.gc.ca/geomet?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=Current-Alerts&query_layers=Current-Alerts&crs=EPSG:4326&bbox=${lat - d},${lon - d},${lat + d},${lon + d}&width=11&height=11&i=5&j=5&info_format=application/json&feature_count=10`;
    const r2 = await get(u);
    let info = short(r2.text, 300);
    try { const j2 = JSON.parse(r2.text); info = `n=${j2.features?.length} keys=${Object.keys(j2.features?.[0]?.properties || {}).join(',')} sample=${JSON.stringify(j2.features?.[0]?.properties).slice(0, 700)}`; } catch {}
    note(`gfi Current-Alerts @${lat.toFixed(2)},${lon.toFixed(2)} (${g.properties.feature_name_en}): ${r2.status} acao=${r2.acao} ${info}`);
    const r3 = await get(`https://api.weather.gc.ca/collections/weather-alerts/items?f=json&skipGeometry=true&bbox=${lon - d},${lat - d},${lon + d},${lat + d}`);
    note(`alerts bbox query: ${r3.status} n=${JSON.parse(r3.text).features?.length} size=${r3.size}`);
  }
});

await probe('cwfis layers', async () => {
  for (const ws of ['public', '']) {
    const base = ws ? `${CW}/${ws}` : CW;
    const r = await get(`${base}/wms?service=WMS&version=1.3.0&request=GetCapabilities`);
    const names = [...r.text.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]).filter((n) => /active|fire|ciffc|perim|m3|hotspot/i.test(n));
    note(`cwfis wms caps ${ws || 'root'}: ${r.status} n=${names.length} ${names.slice(0, 40).join(' ')}`);
  }
  for (const t of ['public:m3_polygons_current', 'public:hotspots_last24hrs', 'public:hotspots_24h', 'public:activefires_current', 'public:activefires', 'public:ciffc_activefires']) {
    const r2 = await get(`${CW}/public/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=${t}&outputFormat=application/json&count=2`);
    let info = short(r2.text, 160);
    try { const j = JSON.parse(r2.text); info = `matched=${j.numberMatched ?? j.totalFeatures} geom=${j.features?.[0]?.geometry?.type} props=${JSON.stringify(j.features?.[0]?.properties).slice(0, 600)}`; } catch {}
    note(`cwfis ${t}: ${r2.status} ${info}`);
  }
  const r3 = await get(`${CW}/public/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=public:m3_polygons_current&outputFormat=application/json`);
  note(`cwfis m3_polygons_current full size=${r3.size}`);
});

await probe('cwfis files', async () => {
  for (const u of [
    'https://cwfis.cfs.nrcan.gc.ca/downloads/activefires/activefires.csv',
    'https://cwfis.cfs.nrcan.gc.ca/downloads/activefires/',
    'https://cwfis.cfs.nrcan.gc.ca/datamart/download/activefires',
    'https://cwfis.cfs.nrcan.gc.ca/datamart/metadata/activefires',
    'https://cwfis.cfs.nrcan.gc.ca/report/activefires',
  ]) {
    const r = await get(u);
    const links = [...r.text.matchAll(/href="([^"]*(?:activefire|\.csv|\.json|\.zip)[^"]*)"/gi)].map((m) => m[1]).slice(0, 8).join(' ');
    note(`${u}: ${r.status} ${r.type} size=${r.size} links=${links}`);
  }
});

await probe('ciffc', async () => {
  for (const u of ['https://ciffc.net/api/v1/fires', 'https://ciffc.net/en/ciffc/public/', 'https://api.ciffc.net/v1/wildfires']) {
    const r = await get(u);
    note(`${u}: ${r.status} ${r.type} acao=${r.acao} ${short(r.text, 160)}`);
  }
});

console.log(notes.join('\n'));
for (let i = 0; i < notes.length; i += 2) console.log(`::notice title=probe ${i / 2 + 1}::${notes.slice(i, i + 2).join('  ||  ')}`);
