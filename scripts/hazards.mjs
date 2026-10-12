// Hazard data for the map (called by build-data.mjs every 30 minutes).
//  - Fire detections, last 24 h, worldwide: NASA FIRMS VIIRS (Suomi NPP, NOAA-20, NOAA-21).
//    Low-confidence detections are dropped; the rest are merged onto a 0.02° grid and
//    written as compact binary (data/fires.json + data/fires.bin).
//  - Active fire areas in Canada: CWFIS (Natural Resources Canada) M3 fire perimeters
//    with satellite hotspots in the last 7 days, simplified (data/fire-areas.json).
//  - Tropical storms: NOAA National Hurricane Center active storms with forecast cone,
//    track and points (data/tropical.json). When ECCC's Canadian Hurricane Centre is
//    tracking a storm, its cone and track are used instead.
// ECCC weather alerts are not built here: the page reads them live from api.weather.gc.ca.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const FIRMS = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire';
export const FIRMS_FILES = {
  N: `${FIRMS}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv`,
  N20: `${FIRMS}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv`,
  N21: `${FIRMS}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv`,
};
export const SAT_BIT = { N: 4, N20: 8, N21: 16 };
export const FIRE_GRID = 50; // cells per degree (0.02°, about 2 km)
const CWFIS_WFS = 'https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wfs';
const NHC_CURRENT = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const NHC_MS = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
const CHC = 'https://api.weather.gc.ca/collections';

// ---------- fires (NASA FIRMS) ----------
// Merge FIRMS CSV rows onto the grid. Each cell keeps: detection count, strongest
// fire radiative power (MW), latest detection time, and flags
// (bit 0 high confidence, bit 1 latest pass at night, bits 2-4 satellites).
export function mergeFires(texts, now = Date.now()) {
  const cells = new Map();
  let rows = 0, kept = 0;
  for (const text of texts) {
    const lines = text.split('\n');
    const head = lines[0].trim().split(',');
    const ix = Object.fromEntries(head.map((k, i) => [k, i]));
    if (ix.latitude == null || ix.longitude == null) continue;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      rows++;
      const c = line.split(',');
      const conf = c[ix.confidence];
      if (conf === 'low' || conf === 'l') continue;
      const lat = Number(c[ix.latitude]), lon = Number(c[ix.longitude]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const hhmm = String(c[ix.acq_time] || '').padStart(4, '0');
      const t = Date.parse(`${c[ix.acq_date]}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`);
      if (!Number.isFinite(t) || now - t > 26 * 3600e3) continue;
      kept++;
      const gy = Math.round(lat * FIRE_GRID), gx = Math.round(lon * FIRE_GRID);
      const key = gy * 100000 + gx;
      let cell = cells.get(key);
      if (!cell) { cell = { gy, gx, n: 0, frp: 0, t: 0, flags: 0 }; cells.set(key, cell); }
      cell.n++;
      const frp = Number(c[ix.frp]);
      if (frp > cell.frp) cell.frp = frp;
      if (t >= cell.t) { cell.t = t; cell.flags = (cell.flags & ~2) | (c[ix.daynight] === 'N' ? 2 : 0); }
      if (conf === 'high' || conf === 'h') cell.flags |= 1;
      cell.flags |= SAT_BIT[c[ix.satellite]] || 0;
    }
  }
  return { cells: [...cells.values()], rows, kept };
}

// Column layout, little-endian: gy Int16[n], gx Int16[n], frp×10 Uint16[n],
// age in minutes Uint16[n], count Uint8[n], flags Uint8[n]. Oldest first, so the
// newest detections draw on top.
export function encodeFires(cells, generated) {
  const list = [...cells].sort((a, b) => a.t - b.t);
  const n = list.length;
  const ab = new ArrayBuffer(n * 10);
  const gy = new Int16Array(ab, 0, n), gx = new Int16Array(ab, 2 * n, n);
  const frp = new Uint16Array(ab, 4 * n, n), age = new Uint16Array(ab, 6 * n, n);
  const cnt = new Uint8Array(ab, 8 * n, n), fl = new Uint8Array(ab, 9 * n, n);
  list.forEach((c, i) => {
    gy[i] = c.gy; gx[i] = c.gx;
    frp[i] = Math.min(65535, Math.round(c.frp * 10));
    age[i] = Math.max(0, Math.min(65535, Math.round((generated - c.t) / 60000)));
    cnt[i] = Math.min(255, c.n); fl[i] = c.flags;
  });
  return Buffer.from(ab);
}

// ---------- geometry helpers ----------
function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
// Douglas-Peucker on an open or closed line (iterative, so long rings are safe).
export function simplifyLine(pts, tol) {
  if (pts.length <= 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let max = 0, idx = -1;
    for (let i = s + 1; i < e; i++) { const d = perpDist(pts[i], pts[s], pts[e]); if (d > max) { max = d; idx = i; } }
    if (max > tol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const r4 = (v) => Math.round(v * 1e4) / 1e4;
// Simplify a polygon ring; never collapse it below a closed triangle.
export function simplifyRing(ring, tol) {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const out = simplifyLine(ring, Math.min(tol, extent / 25)).map((p) => [r4(p[0]), r4(p[1])]);
  return out.length >= 4 ? out : ring.map((p) => [r4(p[0]), r4(p[1])]);
}
// GeoServer can answer in lat/lon order; Canadian fires must be lon < 0, lat > 0.
function lonLat(p) { return p[0] > 0 && p[1] < 0 ? [p[1], p[0]] : p; }
function polysOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

// ---------- fire areas (CWFIS M3 perimeters) ----------
export function compactAreas(geojson, tol = 0.003) {
  const areas = [];
  for (const f of geojson.features || []) {
    const p = f.properties || {};
    const polys = polysOf(f.geometry).map((poly) => poly.map((ring) => simplifyRing(ring.map(lonLat), tol))).filter((poly) => poly[0]?.length >= 4);
    if (!polys.length) continue;
    areas.push({
      ha: p.area != null ? Math.round(Number(p.area)) : null,
      first: p.firstdate || null,
      last: p.lastdate || null,
      hotspots: p.hcount != null ? Number(p.hcount) : null,
      polys,
    });
  }
  areas.sort((a, b) => (b.ha || 0) - (a.ha || 0));
  return areas;
}

// ---------- tropical (NOAA NHC, ECCC CHC) ----------
const CLASS = { HU: 'Hurricane', TS: 'Tropical storm', TD: 'Tropical depression', STS: 'Subtropical storm', STD: 'Subtropical depression', PTC: 'Post-tropical cyclone', PC: 'Potential tropical cyclone', TY: 'Typhoon', STY: 'Super typhoon' };
export const classLabel = (c) => CLASS[c] || c || 'Tropical cyclone';
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const r3 = (v) => Math.round(v * 1000) / 1000;
const pick = (p, keys) => { for (const k of keys) { const hit = Object.keys(p).find((x) => x.toLowerCase() === k); if (hit && p[hit] != null && p[hit] !== '') return p[hit]; } return null; };

export function compactStorm(s) {
  return {
    id: s.id, bin: s.binNumber, name: s.name, cls: s.classification, label: classLabel(s.classification),
    kt: num(s.intensity), mb: num(s.pressure),
    lat: num(s.latitudeNumeric), lon: num(s.longitudeNumeric),
    dir: num(s.movementDir), mph: num(s.movementSpeed),
    updated: s.lastUpdate || null,
    advisory: s.publicAdvisory?.url || null,
    graphics: s.forecastGraphics?.url || null,
  };
}
export function compactPoints(geojson) {
  return (geojson?.features || []).map((f) => {
    const p = f.properties || {};
    const c = f.geometry?.coordinates || [];
    return {
      lat: r3(num(pick(p, ['lat'])) ?? c[1]), lon: r3(num(pick(p, ['lon'])) ?? c[0]),
      tau: num(pick(p, ['tau', 'fcstprd'])),
      kt: num(pick(p, ['maxwind', 'intensity'])), gust: num(pick(p, ['gust'])), mb: num(pick(p, ['mslp'])),
      cls: pick(p, ['dvlbl', 'tcdvlp', 'stormtype']),
      when: pick(p, ['fldatelbl', 'datelbl', 'advdate']), valid: pick(p, ['validtime']),
    };
  }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).sort((a, b) => (a.tau ?? 0) - (b.tau ?? 0));
}
export function linesOf(geojson, tol = 0) {
  const out = [];
  for (const f of geojson?.features || []) {
    const g = f.geometry; if (!g) continue;
    const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const l of parts) out.push((tol ? simplifyLine(l, tol) : l).map((p) => [r3(p[0]), r3(p[1])]));
  }
  return out;
}
export function conesOf(geojson) {
  const out = [];
  for (const f of geojson?.features || []) for (const poly of polysOf(f.geometry)) out.push(poly.map((ring) => simplifyRing(ring, 0.02)));
  return out;
}

// ---------- I/O ----------
async function fetchBuf(url, ua, ms = 120000) {
  const res = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 90)}`);
  return Buffer.from(await res.arrayBuffer());
}
const fetchJson = async (url, ua, ms) => JSON.parse((await fetchBuf(url, ua, ms)).toString('utf8'));

async function copyPrev(names, { outDir, pagesUrl }) {
  if (!pagesUrl) return false;
  for (const n of names) {
    const res = await fetch(`${pagesUrl}/data/${n}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return false;
    await writeFile(path.join(outDir, n), Buffer.from(await res.arrayBuffer()));
  }
  return true;
}

async function buildFires(ctx) {
  const { outDir, ua, status, log } = ctx;
  const texts = [], sats = {};
  for (const [sat, url] of Object.entries(FIRMS_FILES)) {
    try { texts.push((await fetchBuf(url, ua, 180000)).toString('utf8')); sats[sat] = 'ok'; }
    catch (e) { sats[sat] = String(e.message || e).slice(0, 80); }
  }
  if (!texts.length) throw new Error(`no FIRMS file answered (${Object.values(sats).join('; ')})`);
  const generated = Date.now();
  const { cells, rows, kept } = mergeFires(texts, generated);
  const bin = encodeFires(cells, generated);
  await writeFile(path.join(outDir, 'fires.bin'), bin);
  await writeFile(path.join(outDir, 'fires.json'), JSON.stringify({
    generated: new Date(generated).toISOString(), grid: FIRE_GRID, count: cells.length, detections: kept, rows,
    satellites: sats, source: 'NASA FIRMS VIIRS 375 m (Suomi NPP, NOAA-20, NOAA-21), last 24 h', file: 'fires.bin',
  }));
  const missing = Object.entries(sats).filter(([, v]) => v !== 'ok').map(([k]) => k);
  status.sources.fires = { ok: !missing.length, count: kept, ...(missing.length ? { warning: `missing ${missing.join(', ')}` } : {}) };
  log(`Fires: ${rows} rows, ${kept} kept, ${cells.length} cells, ${Math.round(bin.length / 1024)} KB`);
  return `fires ${kept} det → ${cells.length} cells ${Math.round(bin.length / 1024)} KB`;
}

async function buildFireAreas(ctx) {
  const { outDir, ua, status, log } = ctx;
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const q = new URLSearchParams({
    service: 'WFS', version: '1.0.0', request: 'GetFeature', typeName: 'public:m3_polygons_current',
    outputFormat: 'application/json', srsName: 'EPSG:4326', CQL_FILTER: `lastdate >= '${since}'`,
  });
  const gj = await fetchJson(`${CWFIS_WFS}?${q}`, ua, 180000);
  const areas = compactAreas(gj);
  await writeFile(path.join(outDir, 'fire-areas.json'), JSON.stringify({
    generated: new Date().toISOString(), since, source: 'Canadian Wildland Fire Information System (Natural Resources Canada), M3 fire perimeters', areas,
  }));
  status.sources.fireAreas = { ok: true, count: areas.length };
  const c = areas[0]?.polys?.[0]?.[0]?.[0];
  log(`Fire areas: ${areas.length} since ${since}`);
  return `areas ${areas.length}${c ? ` first@${c[1]},${c[0]}` : ''}`;
}

async function chcStorms(ua) {
  const latest = {};
  for (const kind of ['track', 'error_cone']) {
    const j = await fetchJson(`${CHC}/hurricanes-${kind}-realtime/items?f=json&active=true&limit=200`, ua, 60000);
    for (const f of j.features || []) {
      const p = f.properties || {};
      const key = String(p.storm_name || '').toUpperCase();
      if (!key) continue;
      const s = (latest[key] ||= { name: p.storm_name, published: null, track: [], cone: [] });
      const pub = p.publication_datetime || '';
      if (!s.published || pub > s.published) { s.published = pub; s.track = []; s.cone = []; }
      if (pub !== s.published) continue;
      if (kind === 'track') s.track.push(...linesOf({ features: [f] }));
      else s.cone.push(...conesOf({ features: [f] }));
    }
  }
  return latest;
}

async function buildTropical(ctx) {
  const { outDir, ua, status, log } = ctx;
  const cur = await fetchJson(NHC_CURRENT, ua, 60000);
  const storms = (cur.activeStorms || []).map(compactStorm);
  const notes = [];
  if (storms.length) {
    let layers = [];
    try { layers = (await fetchJson(`${NHC_MS}?f=json`, ua, 60000)).layers || []; } catch (e) { notes.push(`mapserver ${e.message}`); }
    const layerId = (name) => layers.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;
    const query = async (name) => {
      const id = layerId(name);
      if (id == null) return null;
      return fetchJson(`${NHC_MS}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson`, ua, 60000);
    };
    for (const s of storms) {
      if (!s.bin) continue;
      try {
        const [cone, track, pts, past] = await Promise.all([`${s.bin} Forecast Cone`, `${s.bin} Forecast Track`, `${s.bin} Forecast Points`, `${s.bin} Past Track`].map(query));
        s.cone = conesOf(cone); s.track = linesOf(track); s.points = compactPoints(pts); s.past = linesOf(past, 0.05);
        s.forecastSource = 'NHC';
        notes.push(`${s.bin} cone${s.cone.length} track${s.track.length} pts${s.points.length}${pts?.features?.[0] ? ` keys=${Object.keys(pts.features[0].properties).slice(0, 14).join('/')}` : ''}`);
      } catch (e) { notes.push(`${s.bin} ${e.message}`); }
    }
  }
  let chc = {};
  try { chc = await chcStorms(ua); } catch (e) { notes.push(`chc ${e.message}`); }
  for (const [key, c] of Object.entries(chc)) {
    const s = storms.find((x) => String(x.name).toUpperCase() === key);
    if (s && (c.cone.length || c.track.length)) {
      if (c.cone.length) s.cone = c.cone;
      if (c.track.length) s.track = c.track;
      s.forecastSource = 'CHC'; s.chcPublished = c.published;
    } else if (!s) storms.push({ id: `chc-${key}`, name: c.name, label: 'Tropical cyclone', forecastSource: 'CHC', chcPublished: c.published, cone: c.cone, track: c.track, points: [] });
  }
  await writeFile(path.join(outDir, 'tropical.json'), JSON.stringify({ generated: new Date().toISOString(), storms }));
  status.sources.tropical = { ok: true, count: storms.length, ...(storms.length ? { note: storms.map((s) => s.name).join(', ') } : {}) };
  log(`Tropical: ${storms.length} storm(s) ${notes.join(' ')}`);
  return `storms ${storms.map((s) => `${s.name}(${s.forecastSource})`).join(',') || 'none'} ${notes.join(' ')}`;
}

export async function buildHazards({ outDir, pagesUrl, ua, log, status }) {
  const ctx = { outDir, pagesUrl, ua, log, status };
  const summary = [];
  const steps = [
    ['fires', buildFires, ['fires.json', 'fires.bin']],
    ['fireAreas', buildFireAreas, ['fire-areas.json']],
    ['tropical', buildTropical, ['tropical.json']],
  ];
  for (const [key, fn, files] of steps) {
    try { summary.push(await fn(ctx)); }
    catch (e) {
      const msg = String(e.message || e).slice(0, 160);
      status.sources[key] = { ok: false, error: msg };
      summary.push(`${key} FAILED ${msg}`);
      log(`${key} failed:`, msg);
      try { if (await copyPrev(files, ctx)) status.sources[key].stale = true; } catch { /* nothing to reuse */ }
    }
  }
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Hazards::${summary.join(' | ').replace(/\n/g, ' ').slice(0, 900)}`);
}
