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

await probe('alerts', async () => {
  const r = await get('https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=500');
  const j = JSON.parse(r.text);
  const f = j.features || [];
  note(`alerts: ${r.status} acao=${r.acao} features=${f.length} matched=${j.numberMatched} size=${r.size}`);
  const p = f[0]?.properties || {};
  note(`alert keys: ${Object.keys(p).join(',')}`);
  const pick = (k) => `${k}=${JSON.stringify(p[k])?.slice(0, 160)}`;
  note(`alert sample: ${Object.keys(p).filter((k) => /risk|colour|color|status|type|name_en|area|province|feature_name|text|impact|confidence|urgency|severity|lang/i.test(k) && !/_fr$/.test(k)).map(pick).join(' | ').slice(0, 1600)}`);
  const r2 = await get('https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=500&skipGeometry=true');
  note(`alerts skipGeometry size=${r2.size} (with geometry ${r.size})`);
  const kinds = {};
  for (const x of f) { const k = `${x.properties.alert_type}/${x.properties.risk_colour_en ?? x.properties.colour ?? '?'}`; kinds[k] = (kinds[k] || 0) + 1; }
  note(`alert kinds: ${JSON.stringify(kinds)}`);
});

await probe('cwfis wfs', async () => {
  const r = await get('https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wfs?service=WFS&version=2.0.0&request=GetCapabilities');
  const names = [...r.text.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]).filter((n) => /fire|hotspot|perim|m3/i.test(n));
  note(`cwfis wfs caps: ${r.status} acao=${r.acao} fire layers=${names.slice(0, 30).join(' ')}`);
  for (const t of ['public:activefires_current', 'public:activefires']) {
    const r2 = await get(`https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=${t}&outputFormat=application/json&count=3`);
    let info = short(r2.text, 200);
    try { const j = JSON.parse(r2.text); info = `features=${j.numberMatched ?? j.totalFeatures ?? j.features?.length} props=${JSON.stringify(j.features?.[0]?.properties).slice(0, 500)}`; } catch {}
    note(`cwfis ${t}: ${r2.status} acao=${r2.acao} ${info}`);
  }
});

await probe('hurricanes active', async () => {
  for (const id of ['hurricanes-track-realtime', 'hurricanes-error_cone-realtime', 'hurricanes-cyclone-realtime']) {
    const r = await get(`https://api.weather.gc.ca/collections/${id}/items?f=json&active=true&limit=50`);
    const j = JSON.parse(r.text);
    const names = [...new Set((j.features || []).map((x) => x.properties.storm_name))].join(',');
    note(`${id} active=true: ${r.status} features=${j.features?.length} storms=${names} size=${r.size}`);
  }
});

console.log(notes.join('\n'));
// group into a few notices (GitHub shows a limited number per step)
for (let i = 0; i < notes.length; i += 2) console.log(`::notice title=probe ${i / 2 + 1}::${notes.slice(i, i + 2).join('  ||  ')}`);
