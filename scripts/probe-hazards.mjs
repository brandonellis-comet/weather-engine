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

await probe('gfi', async () => {
  const u = 'https://geo.weather.gc.ca/geomet?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=Current-Alerts&query_layers=Current-Alerts&crs=EPSG:4326&bbox=45.4,-67.2,46.4,-66.2&width=100&height=100&i=50&j=50&info_format=application/json&feature_count=5';
  const r = await get(u);
  note(`gfi: ${r.status} ${r.type} acao=${r.acao} size=${r.size} body=${short(r.text, 600)}`);
});

await probe('dd root', async () => {
  const r = await get('https://dd.weather.gc.ca/');
  const names = [...r.text.matchAll(/href="([^"?/][^"]*)"/g)].map((m) => m[1]).slice(0, 40).join(' ');
  note(`dd root: ${r.status} acao=${r.acao} entries=${names}`);
});
for (const path of ['alerts/cap/', 'today/alerts/cap/']) {
  await probe(`dd ${path}`, async () => {
    const r = await get(`https://dd.weather.gc.ca/${path}`);
    const names = [...r.text.matchAll(/href="([^"?/][^"]*)"/g)].map((m) => m[1]).slice(-12).join(' ');
    note(`dd ${path}: ${r.status} entries(last)=${names}`);
  });
}
// Date-first layout (2025+): /YYYYMMDD/WXO-DD/alerts/cap/
await probe('dd dated', async () => {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const base = `https://dd.weather.gc.ca/${d}/WXO-DD/alerts/cap/`;
  const r = await get(base);
  const names = [...r.text.matchAll(/href="([^"?/][^"]*)"/g)].map((m) => m[1]).slice(0, 20).join(' ');
  note(`dd dated ${base}: ${r.status} entries=${names}`);
  if (r.status !== 200) return;
  // descend: office / hour / file
  const office = names.split(' ').find((n) => /^[A-Z]{3,5}\/?$/.test(n));
  if (!office) return;
  const r2 = await get(base + office);
  const hours = [...r2.text.matchAll(/href="(\d{2}\/?)"/g)].map((m) => m[1]);
  const hr = hours.at(-1);
  const r3 = await get(base + office + hr);
  const files = [...r3.text.matchAll(/href="([^"]+\.cap)"/g)].map((m) => m[1]);
  note(`dd dated ${office}${hr}: ${files.length} cap files, e.g. ${files.slice(0, 2).join(' ')}`);
  if (!files[0]) return;
  const cap = await get(base + office + hr + files[0]);
  const tags = ['msgType', 'event', 'severity', 'urgency', 'headline', 'expires', 'effective', 'areaDesc', 'polygon', 'valueName'];
  const found = tags.map((t) => `${t}=${(cap.text.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1]?.slice(0, 60) ?? '-'}`).join(' | ');
  const params = [...cap.text.matchAll(/<valueName>([^<]+)<\/valueName>\s*<value>([^<]*)<\/value>/g)].map((m) => `${m[1]}=${m[2]}`).slice(0, 14).join(' ; ');
  note(`cap sample: ${found}`);
  note(`cap params: ${short(params, 900)}`);
});

await probe('cwfis', async () => {
  const r = await get('https://cwfis.cfs.nrcan.gc.ca/downloads/activefires/activefires.csv');
  const lines = r.text.split('\n');
  note(`cwfis: ${r.status} ${r.type} rows=${lines.length} head=${short(lines[0], 300)} | row1=${short(lines[1] || '', 300)}`);
});

for (const [k, u] of [['firms-j1', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv'], ['firms-snpp', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv']]) {
  await probe(k, async () => {
    const r = await get(u);
    const lines = r.text.split('\n');
    note(`${k}: ${r.status} ${r.type} rows=${lines.length} size=${r.size} head=${short(lines[0], 200)}`);
  });
}

await probe('ogc', async () => {
  const r = await get('https://api.weather.gc.ca/collections?f=json');
  const j = JSON.parse(r.text);
  const ids = (j.collections || []).map((c) => c.id).filter((id) => /hurric|alert|warn|fire|smoke/i.test(id));
  note(`ogc collections (hazard-like): ${ids.join(' ')} acao=${r.acao}`);
  for (const id of ids.filter((x) => /hurric/i.test(x)).slice(0, 4)) {
    const r2 = await get(`https://api.weather.gc.ca/collections/${id}/items?f=json&limit=3`);
    const j2 = JSON.parse(r2.text);
    note(`ogc ${id}: ${r2.status} features=${j2.numberMatched ?? j2.features?.length} props=${Object.keys(j2.features?.[0]?.properties || {}).slice(0, 14).join(',')}`);
  }
});

console.log(notes.join('\n'));
// group into a few notices (GitHub shows a limited number per step)
for (let i = 0; i < notes.length; i += 2) console.log(`::notice title=probe ${i / 2 + 1}::${notes.slice(i, i + 2).join('  ||  ')}`);
