// Scheduled data job (runs on GitHub Actions every 30 minutes).
//  1. Pulls current METAR/TAF from NOAA's Aviation Weather Center cache files.
//  2. Resolves every map layer in site/config/layers.json against the live
//     ECCC GeoMet and NASA GIBS catalogues (handles ECCC layer renames).
//  3. Checks the Open-Meteo model ids used for the point comparison.
//  4. Writes site/data/{metar,taf,catalog,status}.json.
// One failing source never stops the others. A failed pull falls back to the
// copy already published on the site (PAGES_URL) and is marked stale.
//
// Env: OUT_DIR (default site/data), FIXTURES_DIR (tests: read local files
// instead of the network), PAGES_URL (published site, for fallbacks).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExtent } from '../site/js/timeext.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.OUT_DIR || path.join(ROOT, 'site/data'));
const FIX = process.env.FIXTURES_DIR ? path.resolve(process.env.FIXTURES_DIR) : null;
const PAGES = (process.env.PAGES_URL || '').replace(/\/$/, '');
const UA = 'weather-engine (personal, non-commercial; github.com)';

const AWC = {
  metar: 'https://aviationweather.gov/data/cache/metars.cache.csv.gz',
  taf: 'https://aviationweather.gov/data/cache/tafs.cache.xml.gz',
  stations: 'https://aviationweather.gov/data/cache/stations.cache.json.gz',
};
const FIXTURE_FILES = {
  [AWC.metar]: 'metars.cache.csv.gz', [AWC.taf]: 'tafs.cache.xml.gz', [AWC.stations]: 'stations.cache.json.gz',
};

const status = { generated: new Date().toISOString(), sources: {}, layers: {}, models: {} };
const log = (...a) => console.log('[data]', ...a);

// ---------- I/O ----------
async function getBuffer(url) {
  if (FIX) {
    const name = FIXTURE_FILES[url] || (url.includes('geo.weather.gc.ca') ? 'geomet-caps.xml'
      : url.includes('gibs.earthdata') ? 'gibs-caps.xml'
      : url.includes('open-meteo') ? `openmeteo-${new URL(url).searchParams.get('models')}.json` : null);
    if (!name) throw new Error(`no fixture for ${url}`);
    return readFile(path.join(FIX, name));
  }
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
async function getText(url) {
  const buf = await getBuffer(url);
  return (url.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8');
}
async function writeJson(name, obj) {
  await writeFile(path.join(OUT, name), JSON.stringify(obj));
}
async function previous(name) {
  if (!PAGES || FIX) return null;
  try {
    const res = await fetch(`${PAGES}/data/${name}`, { signal: AbortSignal.timeout(30000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// ---------- CSV / XML helpers ----------
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1].trim()) : null;
};
const decodeXml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// WMS capabilities → flat list of named layers with their own dimensions/styles.
export function parseCapabilities(xml) {
  const out = [];
  const chunks = xml.split(/<Layer[\s>]/).slice(1);
  for (let chunk of chunks) {
    const close = chunk.indexOf('</Layer>');
    if (close !== -1) chunk = chunk.slice(0, close);
    const name = tag(chunk, 'Name');
    if (!name) continue;
    const dims = {};
    for (const m of chunk.matchAll(/<Dimension([^>]*)>([\s\S]*?)<\/Dimension>/g)) {
      const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
      if (attrs.name) dims[attrs.name.toLowerCase()] = { value: m[2].trim(), default: attrs.default || null };
    }
    const styles = [...chunk.matchAll(/<Style>\s*<Name>([^<]+)<\/Name>/g)].map((m) => m[1].trim());
    out.push({ name, title: tag(chunk, 'Title') || '', dims, styles });
  }
  return out;
}

// ---------- 1. METAR / TAF ----------
async function buildAviation() {
  // Station names (optional, daily file)
  const names = {};
  try {
    const st = JSON.parse(await getText(AWC.stations));
    const list = Array.isArray(st) ? st : st.features?.map((f) => f.properties) || [];
    for (const s of list) {
      const id = s.icaoId || s.station_id || s.id;
      const nm = s.site || s.name || s.siteName;
      if (id && nm) names[id] = [nm, s.state || s.prior || '', s.country || ''].filter(Boolean).join(', ');
    }
    status.sources.stations = { ok: true, count: Object.keys(names).length };
  } catch (e) {
    status.sources.stations = { ok: false, error: String(e.message || e) };
  }

  // METAR
  try {
    const rows = parseCsv(await getText(AWC.metar));
    const h = rows.findIndex((r) => r[0] === 'raw_text');
    if (h === -1) throw new Error('METAR CSV header not found');
    const col = Object.fromEntries(rows[h].map((c, i) => [c, i]));
    const stations = [];
    for (const r of rows.slice(h + 1)) {
      const raw = r[col.raw_text]; const id = r[col.station_id];
      const lat = Number(r[col.latitude]); const lon = Number(r[col.longitude]);
      if (!raw || !id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      stations.push([id, Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000, names[id] || '', raw, r[col.observation_time] || '']);
    }
    if (!stations.length) throw new Error('no METARs parsed');
    await writeJson('metar.json', { generated: status.generated, source: 'NOAA Aviation Weather Center', stations });
    status.sources.metar = { ok: true, count: stations.length };
    log(`METAR: ${stations.length} stations`);
  } catch (e) {
    const prev = await previous('metar.json');
    if (prev) await writeJson('metar.json', prev);
    status.sources.metar = { ok: false, stale: !!prev, error: String(e.message || e) };
    log('METAR failed:', e.message);
  }

  // TAF
  try {
    const xml = await getText(AWC.taf);
    const tafs = {};
    for (const m of xml.matchAll(/<TAF>([\s\S]*?)<\/TAF>/g)) {
      const id = tag(m[1], 'station_id'); const raw = tag(m[1], 'raw_text');
      if (id && raw) tafs[id] = { raw, issued: tag(m[1], 'issue_time') || '' };
    }
    if (!Object.keys(tafs).length) throw new Error('no TAFs parsed');
    await writeJson('taf.json', { generated: status.generated, source: 'NOAA Aviation Weather Center', tafs });
    status.sources.taf = { ok: true, count: Object.keys(tafs).length };
    log(`TAF: ${Object.keys(tafs).length} stations`);
  } catch (e) {
    const prev = await previous('taf.json');
    if (prev) await writeJson('taf.json', prev);
    status.sources.taf = { ok: false, stale: !!prev, error: String(e.message || e) };
    log('TAF failed:', e.message);
  }
}

// ---------- 2. Layer catalogue ----------
export function resolveLayer(def, caps) {
  if (!caps) return null;
  const byName = new Map(caps.map((l) => [l.name, l]));
  const exact = (def.candidates || []).filter((n) => byName.has(n));
  if (def.combine && exact.length) return exact.map((n) => byName.get(n));
  if (exact.length) return [byName.get(exact[0])];
  const m = def.match;
  if (!m) return null;
  const rx = (s) => new RegExp(s, 'i');
  const hits = caps.filter((l) => {
    const hay = `${l.name} ${l.title}`;
    if (m.name && !rx(m.name).test(l.name)) return false;
    if (m.all && !m.all.every((p) => rx(p).test(hay))) return false;
    if (m.any && !m.any.some((p) => rx(p).test(hay))) return false;
    if (m.not && m.not.some((p) => rx(p).test(hay))) return false;
    if (m.notName && m.notName.some((p) => rx(p).test(l.name))) return false;
    return true;
  });
  hits.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return hits.length ? [hits[0]] : null;
}

// For layers that did not resolve (or fell back), list what the source does have,
// so the next fix is a one-line edit to layers.json.
function nearMatches(def, caps) {
  if (!caps || !def.match?.name) return undefined;
  const rx = new RegExp(def.match.name, 'i');
  return caps.filter((l) => rx.test(l.name)).slice(0, 40).map((l) => `${l.name} | ${l.title}`);
}

function entryFor(def, sourceId, layers) {
  const time = layers[0].dims.time || null;
  const ref = layers[0].dims.reference_time || null;
  const ext = time ? parseExtent(time.value) : null;
  return {
    id: def.id, source: sourceId, names: layers.map((l) => l.name), title: layers[0].title,
    style: layers[0].styles[0] || '',
    time: time ? { extent: time.value, default: time.default } : null,
    latest: ext ? new Date(ext.end).toISOString() : null,
    reference: ref ? (ref.default || ref.value.split(',').pop().split('/')[1] || null) : null,
  };
}

const CAPS = {};
async function buildCatalog(config) {
  const caps = CAPS;
  for (const [id, src] of Object.entries(config.sources)) {
    try {
      const xml = await getText(src.capabilities);
      caps[id] = parseCapabilities(xml);
      status.sources[id] = { ok: true, layers: caps[id].length };
      log(`${id}: ${caps[id].length} layers in catalogue`);
    } catch (e) {
      caps[id] = null;
      status.sources[id] = { ok: false, error: String(e.message || e) };
      log(`${id} catalogue failed:`, e.message);
    }
  }
  const catalog = { generated: status.generated, layers: {} };
  for (const def of config.layers) {
    let found = resolveLayer(def, caps[def.source]);
    let src = def.source; let note = null;
    if (!found && def.fallback) {
      found = resolveLayer({ ...def, ...def.fallback, match: null }, caps[def.fallback.source]);
      if (found) { src = def.fallback.source; note = `fallback: ${def.fallback.model || src}`; }
    }
    if (!found) {
      const unknown = caps[def.source] == null;
      status.layers[def.id] = { ok: false, error: unknown ? 'source catalogue unavailable' : 'no matching layer in source catalogue', seen: nearMatches(def, caps[def.source]) };
      // Keep the previous resolution if we could not check this run.
      if (unknown) catalog.layers[def.id] = null;
      continue;
    }
    const e = entryFor(def, src, found);
    if (note) e.note = note;
    if (def.fallback && src === def.fallback.source) { e.kind = def.fallback.kind; e.model = def.fallback.model; }
    catalog.layers[def.id] = e;
    const ageMin = e.latest ? Math.round((Date.now() - Date.parse(e.latest)) / 60000) : null;
    const kind = e.kind || def.kind;
    const stale = kind === 'obs' && ageMin != null && ageMin > (def.maxAgeMin || 90);
    status.layers[def.id] = { ok: !stale, name: e.names.join(','), latest: e.latest, reference: e.reference, ...(stale ? { warning: `latest image is ${ageMin} min old` } : {}), ...(note ? { note, seen: nearMatches(def, caps[def.source]) } : {}) };
  }
  // Layers we could not check this run: carry the last published resolution.
  const missing = Object.entries(catalog.layers).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length) {
    const prev = await previous('catalog.json');
    for (const k of missing) {
      if (prev?.layers?.[k]) { catalog.layers[k] = { ...prev.layers[k], stale: true }; }
      else delete catalog.layers[k];
    }
  }
  return catalog;
}

// ---------- 3. Open-Meteo model ids ----------
async function checkModels(config, catalog) {
  catalog.models = {};
  for (const [key, m] of Object.entries(config.models)) {
    if (key.startsWith('_')) continue;
    for (const id of m.candidates) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=44.8&longitude=-63.6&hourly=temperature_2m&forecast_days=1&models=${id}`;
        const j = JSON.parse(await getText(url));
        const series = j.hourly && (j.hourly.temperature_2m || j.hourly[`temperature_2m_${id}`]);
        if (series && series.some((v) => v != null)) { catalog.models[key] = { id, label: m.label }; break; }
      } catch { /* try next */ }
    }
    status.models[key] = catalog.models[key] ? { ok: true, id: catalog.models[key].id } : { ok: false, error: 'no candidate id answered' };
  }
}

// ---------- temporary: wind data probe (diagnostics for the wind animation) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wcs(id, extra = '') {
  const url = `https://geo.weather.gc.ca/geomet?service=WCS&version=2.0.1&request=GetCoverage&CoverageId=${encodeURIComponent(id)}&format=image/tiff&subsettingcrs=EPSG:4326&outputcrs=EPSG:4326&subset=x(-180,180)&subset=y(-90,90)&resolution=x(1)&resolution=y(1)${extra}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(90000) });
    const b = Buffer.from(await r.arrayBuffer());
    if (r.status === 429) { await sleep(12000); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${b.slice(0, 160).toString('latin1')}`);
    return b;
  }
  throw new Error('HTTP 429 three times');
}
async function windProbe() {
  if (FIX) return;
  const { readTiff } = await import('./tiff.mjs');
  const g = CAPS.geomet || [];
  const notes = [];
  const pick = (re) => g.find((l) => re.test(l.name));
  const spd = pick(/^GDPS_15km_WindSpeed_10m$/), dir = pick(/^GDPS_15km_WindDir_10m$/), vec = pick(/^GDPS_15km_Winds_10m$/);
  notes.push(`layers: speed=${spd?.name || '-'} dir=${dir?.name || '-'} vector=${vec?.name || '-'}`);
  notes.push(`speed time=${spd?.dims.time?.value.slice(0, 70)} default=${spd?.dims.time?.default}`);
  notes.push(`speed title=${spd?.title?.slice(0, 90)}`);
  const stats = (a, nd) => { let n = 0, s = 0, mn = Infinity, mx = -Infinity, bad = 0; for (const v of a) { if (!Number.isFinite(v) || v === nd || Math.abs(v) > 1e6) { bad++; continue; } n++; s += v; if (v < mn) mn = v; if (v > mx) mx = v; } return `n=${n} bad=${bad} min=${mn.toFixed(2)} max=${mx.toFixed(2)} mean=${(s / n).toFixed(2)}`; };
  for (const [label, l, extra] of [['speed', spd, ''], ['dir', dir, ''], ['vector', vec, '']]) {
    if (!l) continue;
    try {
      const t = readTiff(await wcs(l.name, extra));
      notes.push(`${label}: ${t.width}x${t.height} bands=${t.bands.length} bps=${t.bitsPerSample} fmt=${t.sampleFormat} comp=${t.compression} tiled=${t.tiled} nodata=${t.nodata} origin=${t.origin?.x},${t.origin?.y} px=${t.pixel?.x},${t.pixel?.y}`);
      t.bands.forEach((b, i) => notes.push(`${label} band${i}: ${stats(b, t.nodata)}`));
    } catch (e) { notes.push(`${label} failed: ${String(e.message || e).slice(0, 200)}`); }
    await sleep(2500);
  }
  // Does a TIME parameter select a different forecast step?
  const ext = spd?.dims.time ? parseExtent(spd.dims.time.value) : null;
  if (ext) {
    const later = new Date(Math.min(ext.end, ext.start + 48 * 3600e3)).toISOString().replace('.000Z', 'Z');
    for (const [label, extra] of [['TIME', `&TIME=${later}`], ['subset', `&subset=time("${later}")`]]) {
      try { const t = readTiff(await wcs(spd.name, extra)); notes.push(`speed@+48h via ${label}: ${stats(t.bands[0], t.nodata)}`); }
      catch (e) { notes.push(`speed@+48h via ${label} failed: ${String(e.message || e).slice(0, 160)}`); }
      await sleep(2500);
    }
  }
  status.diag = notes;
  for (const n of notes) console.log(`::notice title=wind probe::${n}`);
}

// ---------- main ----------
export async function main() {
  await mkdir(OUT, { recursive: true });
  const config = JSON.parse(await readFile(path.join(ROOT, 'site/config/layers.json'), 'utf8'));
  await buildAviation();
  const catalog = await buildCatalog(config);
  await checkModels(config, catalog);
  try { await windProbe(); } catch (e) { status.diag = { error: String(e) }; }
  await writeJson('catalog.json', catalog);
  await writeJson('status.json', status);
  const bad = [...Object.entries(status.sources), ...Object.entries(status.layers), ...Object.entries(status.models)].filter(([, v]) => !v.ok);
  log(bad.length ? `Done with ${bad.length} issue(s): ${bad.map(([k]) => k).join(', ')}` : 'Done, all sources OK');
  return { catalog, status };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
