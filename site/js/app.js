// Weather Engine — map, time sync, point forecast, METAR/TAF.
import { parseMetar, parseTaf, metarToPlain, tafToPlain, tafRawLines } from './decoder.js';
import { parseExtent, snapTime, isoForWms, fmtZ } from './timeext.js';
import { createWindLayer, decodeGrid } from './wind.js';
import { createIsobarLayer, decodePressure, buildIsobars } from './isobars.js';
import { createCityLayer } from './cities.js';
import {
  ALERTS_API, CWFIS_WFS, LIST_PROPS, RISK, TYPE, PROVINCES, FUELS, FIRE_AGES, SATS, groupAlerts, isActive, inGeom, inPolys,
  riskOf, typeOf, nearPolys, polysOf, decodeFires, createFireLayer, summariseFires, stormCat, ktToKmh, buildTropicalLayer, buildAreaLayer, stormsAt,
} from './hazards.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MIN = 60000;
// Time slider: piecewise scale so the 3 h of observations get usable width.
const PAST = 180, FUT = 14400, SMAX = 1000, PF = 120;
const toPos = (off) => (off <= 0 ? (PF * (off + PAST)) / PAST : PF + ((SMAX - PF) * off) / FUT);
const toOff = (pos) => (pos <= PF ? -PAST + (PAST * pos) / PF : (FUT * (pos - PF)) / (SMAX - PF));
const round10 = (m) => Math.round(m / 10) * 10;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem('we:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('we:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const MODEL_COLOURS = { gem: 'var(--m-gem)', ecmwf: 'var(--m-ecmwf)', gfs: 'var(--m-gfs)' };
const MODEL_DEFAULTS = { gem: { id: 'gem_seamless', label: 'GEM (ECCC)' }, ecmwf: { id: 'ecmwf_ifs025', label: 'ECMWF IFS' }, gfs: { id: 'gfs_seamless', label: 'GFS (NOAA)' } };

const S = {
  config: null, catalog: null, status: null, metar: null, taf: null, stationIndex: new Map(),
  main: store.get('main', 'temp'), overlays: new Set(store.get('overlays', null) || []), base: store.get('base', 'osm'),
  now: Date.now(), offset: 0, playing: false, timer: null,
  view: store.get('view', 'plain'), point: null, tab: 'temp',
  wind: { index: null, cache: new Map(), layer: null, time: null },
  pres: { index: null, cache: new Map(), layer: null, time: null },
  legendCollapsed: store.get('legendCollapsed', matchMedia('(max-width: 760px)').matches),
  cities: { data: null, layer: null, loading: null },
  hz: {
    alerts: { list: null, at: 0, error: null, shapes: null, shapesAt: 0, layer: null, stmt: new Map(), stmtLayer: null, selLayer: null },
    fires: { meta: null, data: null, layer: null, loading: null },
    areas: { data: null, layer: null },
    trop: { data: null, layer: null },
  },
};

// ---------- map ----------
const map = L.map('map', { zoomControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 12, preferCanvas: true })
  .setView(store.get('center', [45.6, -63.2]), store.get('zoom', 5));
if (matchMedia('(pointer: fine)').matches) L.control.zoom({ position: 'bottomright' }).addTo(map);
map.attributionControl.setPrefix(false);
for (const [name, z] of [['mainPane', 300], ['stmtPane', 333], ['alertPane', 335], ['windPane', 340], ['isobarPane', 345], ['overlayPane2', 350],
  ['hazardPane', 352], ['firePane', 354], ['alertSelPane', 356], ['labelPane', 380], ['cityPane', 420], ['stationPane', 450]]) {
  map.createPane(name).style.zIndex = z;
}
map.getPane('labelPane').style.pointerEvents = 'none';
map.getPane('mainPane').style.pointerEvents = 'none';
map.getPane('overlayPane2').style.pointerEvents = 'none';
for (const p of ['windPane', 'isobarPane', 'cityPane', 'stmtPane', 'alertPane', 'hazardPane', 'firePane', 'alertSelPane']) map.getPane(p).style.pointerEvents = 'none';

const bases = {
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }),
  relief: L.tileLayer.wms('https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi', { layers: 'BlueMarble_ShadedRelief_Bathymetry', format: 'image/jpeg', version: '1.3.0', tileSize: 512, attribution: 'NASA GIBS' }),
};
let stationLayer = null;

// Gridded model fields (15 km for GDPS) are drawn as one image for the whole view,
// requested at about one pixel per grid cell. The browser stretches it with bilinear
// filtering, which blends the cells into smooth gradients with no tile seams.
// A new time or view loads underneath and fades in over the old image.
const FieldLayer = L.Layer.extend({
  options: { pane: 'mainPane', opacity: 0.8, gridKm: 15, url: '', layers: '', time: null, attribution: '' },
  initialize(opts) { L.setOptions(this, opts); },
  getAttribution() { return this.options.attribution; },
  onAdd(map) { this._map = map; map.on('moveend', this._update, this); this._update(); },
  onRemove(map) {
    map.off('moveend', this._update, this);
    for (const k of ['_img', '_next']) if (this[k]) { map.removeLayer(this[k]); this[k] = null; }
    this._url = null;
  },
  setTime(time) { this.options.time = time; this._update(); },
  _update() {
    const map = this._map;
    if (!map) return;
    const crs = map.options.crs, LIM = 20037508.34;
    const b = map.getBounds().pad(0.2);
    const sw = crs.project(b.getSouthWest()), ne = crs.project(b.getNorthEast());
    const x0 = Math.max(-LIM, sw.x), x1 = Math.min(LIM, ne.x), y0 = Math.max(-LIM, sw.y), y1 = Math.min(LIM, ne.y);
    if (x1 <= x0 || y1 <= y0) return;
    const lat = Math.max(-80, Math.min(80, map.getCenter().lat));
    const cellM = (this.options.gridKm * 1000) / Math.cos((lat * Math.PI) / 180);
    const size = map.getSize();
    const capX = Math.min(1600, size.x * 1.6), capY = Math.min(1600, size.y * 1.6);
    let w = (x1 - x0) / cellM, h = (y1 - y0) / cellM;
    const f = Math.min(1, capX / w, capY / h);
    w = Math.max(8, Math.round(w * f)); h = Math.max(8, Math.round(h * f));
    const q = { service: 'WMS', request: 'GetMap', version: '1.3.0', layers: this.options.layers, styles: '', format: 'image/png', transparent: 'true', crs: 'EPSG:3857', bbox: [x0, y0, x1, y1].map((v) => v.toFixed(0)).join(','), width: w, height: h };
    if (this.options.time) q.time = this.options.time;
    const url = `${this.options.url}?${new URLSearchParams(q)}`;
    if (url === this._url) return;
    this._url = url;
    const bounds = L.latLngBounds(crs.unproject(L.point(x0, y0)), crs.unproject(L.point(x1, y1)));
    const img = L.imageOverlay(url, bounds, { pane: this.options.pane, opacity: this._img ? 0 : this.options.opacity, interactive: false, className: 'field-img' });
    if (this._next) map.removeLayer(this._next);
    this._next = img;
    img.once('load', () => {
      if (this._next !== img || !this._map) return;
      const el = img.getElement();
      if (el && !reduceMotion) el.style.transition = 'opacity 380ms ease';
      img.setOpacity(this.options.opacity);
      const old = this._img;
      this._img = img; this._next = null;
      if (old) setTimeout(() => { if (this._img !== old && map.hasLayer(old)) map.removeLayer(old); }, 420);
    });
    img.once('error', () => { if (this._next === img) { map.removeLayer(img); this._next = null; this._url = null; } });
    img.addTo(map);
  },
});
const slots = new Map(); // layer id -> { lyr, time, pending }
const WindLayer = createWindLayer(L);
const IsobarLayer = createIsobarLayer(L);
const CityLayer = createCityLayer(L);
const FireLayer = createFireLayer(L);

// ---------- data ----------
async function getJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function loadCore() {
  S.config = await getJson('config/layers.json');
  try { S.catalog = await getJson('data/catalog.json'); } catch { S.catalog = null; }
  try { S.status = await getJson('data/status.json'); } catch { S.status = null; }
  if (!store.get('overlays', null)) S.config.layers.filter((l) => l.default).forEach((l) => S.overlays.add(l.id));
  if (!S.config.layers.some((l) => l.id === S.main && l.group === 'main')) S.main = 'temp';
  if (!store.get('windAdded', false)) { S.overlays.add('wind'); store.set('windAdded', true); store.set('overlays', [...S.overlays]); }
  // v3: isobars and city names on, airports off by default (cleaner map)
  if (!store.get('v3defaults', false)) {
    S.overlays.add('isobars'); S.overlays.add('cities'); S.overlays.delete('stations');
    store.set('v3defaults', true); store.set('overlays', [...S.overlays]);
  }
  // v4: ECCC alerts drawn from the live alert feed, tropical storms on
  if (!store.get('v4defaults', false)) {
    S.overlays.add('alerts'); S.overlays.add('tropical');
    store.set('v4defaults', true); store.set('overlays', [...S.overlays]);
  }
}

async function loadMetar() {
  try {
    S.metar = await getJson('data/metar.json');
    S.stationIndex = new Map(S.metar.stations.map((s) => [s[0], s]));
  } catch { S.metar = null; }
}
async function loadTaf() {
  if (S.taf) return S.taf;
  try { S.taf = await getJson('data/taf.json'); } catch { S.taf = { tafs: {} }; }
  return S.taf;
}

const defOf = (id) => S.config.layers.find((l) => l.id === id);
const entryOf = (id) => S.catalog?.layers?.[id] || null;
const kindOf = (def, e) => e?.kind || def.kind;
function available(def) {
  if (!S.catalog) return true; // no catalogue yet: try the configured names
  return !!entryOf(def.id);
}

// ---------- time ----------
function resolveTime(def, e, t) {
  const kind = kindOf(def, e);
  if (kind === 'static') return { show: true, param: null, label: 'current' };
  const ext = e?.time ? parseExtent(e.time.extent) : null;
  if (kind === 'obs') {
    if (t > S.now + 5 * MIN) return { show: false, label: 'observations only' };
    if (t >= S.now - 5 * MIN || !ext) {
      if (!ext) return { show: true, param: null, label: 'latest (no time sync)' };
      const old = S.now - ext.end > 20 * 3600e3;
      const when = old ? `${new Date(ext.end).toISOString().slice(5, 10)} ${fmtZ(ext.end)}` : fmtZ(ext.end);
      return { show: true, param: null, label: `latest ${when}`, warn: old };
    }
    const s = snapTime(ext, t, 'floor');
    if (s == null) return { show: false, label: 'no data this far back' };
    return { show: true, param: isoForWms(s, ext.dateOnly), label: fmtZ(s), ms: s };
  }
  if (kind === 'daily') {
    if (!ext) return { show: true, param: null, label: 'latest day' };
    const s = snapTime(ext, Math.min(t, ext.end), 'floor') ?? ext.end;
    return { show: true, param: isoForWms(s, true), label: new Date(s).toISOString().slice(0, 10) + (t > ext.end + 864e5 ? ' (latest)' : '') };
  }
  if (!ext) return { show: true, param: null, label: 'no time sync' };
  const s = snapTime(ext, alignTime(t), 'nearest');
  const outside = t < ext.start - 3 * 3600e3 || t > ext.end + 3 * 3600e3;
  return { show: true, param: isoForWms(s, ext.dateOnly), label: `valid ${fmtZd(s)}${outside ? ' (nearest)' : ''}`, ms: s, warn: outside };
}

const selectedTime = () => S.now + S.offset * MIN;
// With wind or isobars on, every model layer shows their hour (3-hourly steps), so
// colours, particles and isobars always describe the same moment.
function clockIndex() {
  if (S.overlays.has('wind') && S.wind.index?.times?.length) return S.wind.index;
  if (S.overlays.has('isobars') && S.pres.index?.times?.length) return S.pres.index;
  return null;
}
function alignTime(t) { const idx = clockIndex(); return (idx && nearestTime(idx, t)) ?? t; }
// "Mon 00:00Z" when the time is on a different UTC day from now, else "00:00Z".
const fmtZd = (ms) => (new Date(ms).toISOString().slice(0, 10) === new Date(S.now).toISOString().slice(0, 10)
  ? fmtZ(ms) : `${new Intl.DateTimeFormat('en-CA', { weekday: 'short', timeZone: 'UTC' }).format(ms)} ${fmtZ(ms)}`);

function stepMinutes(dir) {
  if (S.offset + dir * 10 <= 0 && S.offset <= 0) return 10;
  const def = defOf(S.main); const e = entryOf(S.main);
  const ext = e?.time ? parseExtent(e.time.extent) : null;
  const period = ext?.ranges?.[0]?.period;
  return kindOf(def, e) === 'model' && period ? Math.max(60, period / MIN) : 60;
}

// ---------- layers ----------
const opacityOf = (def) => (def.group === 'main' ? 0.8 : 0.92);
function makeWms(def, time) {
  const e = entryOf(def.id);
  const src = S.config.sources[e?.source || def.source];
  const names = e?.names || (def.combine ? def.candidates : [def.candidates[0]]);
  const pane = def.group === 'main' ? 'mainPane' : def.id === 'labels' ? 'labelPane' : 'overlayPane2';
  const onFallback = e && def.fallback && e.source === def.fallback.source;
  const gridKm = (onFallback ? def.fallback.gridKm : def.gridKm) || 0;
  if (gridKm) return new FieldLayer({ url: src.wms, layers: names.join(','), time, gridKm, pane, opacity: opacityOf(def), attribution: src.label });
  const opts = {
    layers: names.join(','), styles: '', format: 'image/png', transparent: true, version: '1.3.0',
    tileSize: 512, pane, opacity: opacityOf(def), attribution: src.label, bounds: [[-85, -180], [85, 180]], noWrap: false, keepBuffer: 1,
  };
  if (time) opts.time = time;
  return L.tileLayer.wms(src.wms, opts);
}

// Show a layer at a time. A new time loads underneath and fades in over the old
// one, so scrubbing and playback flow instead of flashing blank tiles.
function showLayer(def, time) {
  const key = time || 'latest';
  let slot = slots.get(def.id);
  if (slot && slot.time === key) { if (!map.hasLayer(slot.lyr)) slot.lyr.addTo(map); return; }
  if (slot && slot.lyr instanceof FieldLayer) {
    slot.time = key; slot.lyr.setTime(time);
    if (!map.hasLayer(slot.lyr)) slot.lyr.addTo(map);
    return;
  }
  const lyr = makeWms(def, time);
  if (!slot || !map.hasLayer(slot.lyr) || reduceMotion) {
    if (slot) { if (slot.lyr) map.removeLayer(slot.lyr); if (slot.pending) map.removeLayer(slot.pending); }
    lyr.addTo(map);
    slots.set(def.id, { lyr, time: key, pending: null });
    return;
  }
  if (slot.pending) map.removeLayer(slot.pending);
  lyr.setOpacity(0);
  lyr.addTo(map);
  slot.pending = lyr;
  lyr.once('load', () => {
    if (slot.pending !== lyr) return;
    const c = lyr.getContainer();
    if (c) c.style.transition = 'opacity 380ms ease';
    lyr.setOpacity(opacityOf(def));
    const old = slot.lyr;
    slot.lyr = lyr; slot.time = key; slot.pending = null;
    setTimeout(() => { if (old !== slot.lyr && map.hasLayer(old)) map.removeLayer(old); }, 420);
  });
}
function hideLayer(id) {
  const slot = slots.get(id);
  if (!slot) return;
  if (slot.lyr && map.hasLayer(slot.lyr)) map.removeLayer(slot.lyr);
  if (slot.pending) { map.removeLayer(slot.pending); slot.pending = null; }
}
function resetLayers() { for (const id of [...slots.keys()]) hideLayer(id); slots.clear(); }

let paramTimer = null;
function applyTime(immediate = false) {
  updateReadout();
  clearTimeout(paramTimer);
  const run = () => { syncLayers(); syncWind(); syncPressure(); syncCities(); syncHazards(); renderChips(); renderQuick(); };
  if (immediate) run(); else { renderChips(); paramTimer = setTimeout(run, 220); }
}

const LOCAL_OVERLAYS = new Set(['stations', 'wind', 'isobars', 'cities', 'alerts', 'fires', 'tropical']);
function activeIds() {
  return [S.main, ...[...S.overlays].filter((id) => !LOCAL_OVERLAYS.has(id))];
}

function syncLayers() {
  const t = selectedTime();
  const want = new Set();
  for (const id of activeIds()) {
    const def = defOf(id); if (!def || !available(def)) continue;
    const r = resolveTime(def, entryOf(id), t);
    if (!r.show) continue;
    want.add(id);
    showLayer(def, r.param || null);
  }
  for (const id of slots.keys()) if (!want.has(id)) hideLayer(id);
  renderLegend();
}

// ---------- wind animation ----------
async function loadWindIndex() {
  try { S.wind.index = await getJson('data/wind/index.json'); } catch { S.wind.index = null; }
}
function windTimeFor(t) {
  const times = S.wind.index?.times;
  if (!times?.length) return null;
  let best = null;
  for (const s of times) { const ms = Date.parse(s); if (best == null || Math.abs(ms - t) < Math.abs(best - t)) best = ms; }
  return Math.abs(best - t) <= 3.1 * 3600e3 ? best : null;
}
async function syncWind() {
  const t = windTimeFor(selectedTime());
  if (!S.overlays.has('wind') || t == null) {
    if (S.wind.layer && map.hasLayer(S.wind.layer)) map.removeLayer(S.wind.layer);
    S.wind.time = null;
    return;
  }
  if (!S.wind.layer) S.wind.layer = new WindLayer({ still: reduceMotion });
  if (!map.hasLayer(S.wind.layer)) S.wind.layer.addTo(map);
  if (S.wind.time === t) return;
  S.wind.time = t;
  const name = S.wind.index.files[new Date(t).toISOString().replace('.000Z', 'Z')];
  let grid = S.wind.cache.get(name);
  if (!grid) {
    try {
      const res = await fetch(`data/wind/${name}`);
      if (!res.ok) throw new Error(res.status);
      grid = decodeGrid(S.wind.index, await res.arrayBuffer());
    } catch { return; }
    S.wind.cache.set(name, grid);
    if (S.wind.cache.size > 8) S.wind.cache.delete(S.wind.cache.keys().next().value);
  }
  if (S.wind.time === t) S.wind.layer.setGrid(grid);
}

// ---------- isobars ----------
async function loadPresIndex() {
  try { S.pres.index = await getJson('data/pressure/index.json'); } catch { S.pres.index = null; }
}
function nearestTime(index, t) {
  const times = index?.times;
  if (!times?.length) return null;
  let best = null;
  for (const s of times) { const ms = Date.parse(s); if (best == null || Math.abs(ms - t) < Math.abs(best - t)) best = ms; }
  return Math.abs(best - t) <= 3.1 * 3600e3 ? best : null;
}
async function syncPressure() {
  const t = nearestTime(S.pres.index, selectedTime());
  if (!S.overlays.has('isobars') || t == null) {
    if (S.pres.layer && map.hasLayer(S.pres.layer)) map.removeLayer(S.pres.layer);
    S.pres.time = null;
    return;
  }
  if (!S.pres.layer) S.pres.layer = new IsobarLayer();
  if (!map.hasLayer(S.pres.layer)) S.pres.layer.addTo(map);
  if (S.pres.time === t) return;
  S.pres.time = t;
  const name = S.pres.index.files[new Date(t).toISOString().replace('.000Z', 'Z')];
  let iso = S.pres.cache.get(name);
  if (!iso) {
    try {
      const res = await fetch(`data/pressure/${name}`);
      if (!res.ok) throw new Error(res.status);
      iso = buildIsobars(decodePressure(S.pres.index, await res.arrayBuffer()));
    } catch { return; }
    S.pres.cache.set(name, iso);
    if (S.pres.cache.size > 6) S.pres.cache.delete(S.pres.cache.keys().next().value);
  }
  if (S.pres.time === t) S.pres.layer.setData(iso);
}

// ---------- city names ----------
async function syncCities() {
  const on = S.overlays.has('cities');
  if (!on) { if (S.cities.layer && map.hasLayer(S.cities.layer)) map.removeLayer(S.cities.layer); return; }
  if (!S.cities.data) {
    S.cities.loading = S.cities.loading || getJson('data/cities.json').then((j) => (S.cities.data = j.cities)).catch(() => null);
    await S.cities.loading;
    if (!S.cities.data || !S.overlays.has('cities')) return;
  }
  if (!S.cities.layer) S.cities.layer = new CityLayer(S.cities.data);
  if (!map.hasLayer(S.cities.layer)) S.cities.layer.addTo(map);
}

// ---------- hazards: ECCC alerts ----------
const ALERT_REFRESH = 5 * MIN;
const fmtWhen = (iso) => (iso ? fmtLocal(Date.parse(iso)) : '—');
const provName = (p) => PROVINCES[p] || p || '';
const wxLink = (prov) => `https://weather.gc.ca/warnings/index_e.html${prov ? `?prov=${encodeURIComponent(prov.toLowerCase())}` : ''}`;

async function loadAlertList(force = false) {
  const A = S.hz.alerts;
  if (!force && A.list && Date.now() - A.at < ALERT_REFRESH) return;
  try {
    const j = await getJson(`${ALERTS_API}?f=json&limit=1000&skipGeometry=true&properties=${LIST_PROPS}`);
    A.list = j.features || []; A.at = Date.now(); A.error = null;
  } catch (e) { A.error = String(e.message || e); }
  renderHazardBtn(); renderChips();
}
async function loadAlertShapes(force = false) {
  const A = S.hz.alerts;
  if (!force && A.shapes && Date.now() - A.shapesAt < ALERT_REFRESH) return;
  if (A.shapesLoading) return A.shapesLoading;
  A.shapesLoading = (async () => {
    const res = await Promise.allSettled(['warning', 'watch', 'advisory'].map((t) => getJson(`${ALERTS_API}?f=json&limit=500&alert_type=${t}&properties=${LIST_PROPS}`)));
    if (res.some((r) => r.status === 'fulfilled')) {
      A.shapes = res.flatMap((r) => (r.status === 'fulfilled' ? r.value.features || [] : [])).filter((f) => isActive(f.properties));
      A.shapesAt = Date.now();
      A.stmt.clear();
    }
  })().finally(() => { A.shapesLoading = null; });
  return A.shapesLoading;
}
// Alerts: ECCC colour fill with a coloured edge on a dark casing, so each area reads
// clearly over any weather layer. Statements: grey dashed outline, light fill.
function alertStyle(f) {
  const st = typeOf(f.properties) === 'statement', r = RISK[riskOf(f.properties)];
  return st
    ? { color: '#3b4652', weight: 1.6, opacity: 0.95, dashArray: '6 4', fillColor: r.fill, fillOpacity: 0.12, interactive: false }
    : { color: r.fill, weight: 2.2, opacity: 1, fillColor: r.fill, fillOpacity: 0.42, interactive: false };
}
const casingStyle = (f) => (typeOf(f.properties) === 'statement'
  ? { stroke: false, fill: false, interactive: false }
  : { color: '#0d1218', weight: 5, opacity: 0.85, fill: false, interactive: false });
const alertGeo = (features, pane) => L.layerGroup([
  L.geoJSON({ type: 'FeatureCollection', features }, { pane, style: casingStyle, interactive: false }),
  L.geoJSON({ type: 'FeatureCollection', features }, { pane, style: alertStyle, interactive: false }),
]);
async function syncAlerts() {
  const A = S.hz.alerts;
  if (!S.overlays.has('alerts')) {
    for (const k of ['layer', 'stmtLayer']) if (A[k] && map.hasLayer(A[k])) map.removeLayer(A[k]);
    return;
  }
  await loadAlertShapes();
  if (!S.overlays.has('alerts') || !A.shapes) return;
  if (A.layer?._at !== A.shapesAt) {
    if (A.layer) map.removeLayer(A.layer);
    const feats = [...A.shapes].sort((a, b) => RISK[riskOf(a.properties)].rank - RISK[riskOf(b.properties)].rank);
    A.layer = alertGeo(feats, 'alertPane');
    A.layer._at = A.shapesAt;
  }
  if (!map.hasLayer(A.layer)) A.layer.addTo(map);
  loadStatements();
}
// Special weather statements cover large areas, so they are drawn only when zoomed in,
// for the part of the map in view.
let stmtTimer = null;
function loadStatements() {
  clearTimeout(stmtTimer);
  stmtTimer = setTimeout(async () => {
    const A = S.hz.alerts;
    if (!S.overlays.has('alerts') || map.getZoom() < 6) { if (A.stmtLayer && map.hasLayer(A.stmtLayer)) map.removeLayer(A.stmtLayer); return; }
    const b = map.getBounds();
    const bbox = [Math.max(-180, b.getWest()), Math.max(-90, b.getSouth()), Math.min(180, b.getEast()), Math.min(90, b.getNorth())].map((v) => v.toFixed(3)).join(',');
    let j; try { j = await getJson(`${ALERTS_API}?f=json&limit=200&alert_type=statement&bbox=${bbox}&properties=${LIST_PROPS}`); } catch { return; }
    let added = false;
    for (const f of j.features || []) if (isActive(f.properties) && !A.stmt.has(f.id)) { A.stmt.set(f.id, f); added = true; }
    if (added || !A.stmtLayer || A.stmtLayer._at !== A.shapesAt) {
      if (A.stmtLayer) map.removeLayer(A.stmtLayer);
      A.stmtLayer = alertGeo([...A.stmt.values()], 'stmtPane');
      A.stmtLayer._at = A.shapesAt;
    }
    if (S.overlays.has('alerts') && map.getZoom() >= 6 && !map.hasLayer(A.stmtLayer)) A.stmtLayer.addTo(map);
  }, 350);
}
function highlight(features) {
  const A = S.hz.alerts;
  if (A.selLayer) { map.removeLayer(A.selLayer); A.selLayer = null; }
  if (!features?.length) return null;
  const fc = { type: 'FeatureCollection', features };
  A.selLayer = L.layerGroup([
    L.geoJSON(fc, { pane: 'alertSelPane', style: { color: '#ffffff', weight: 5.5, opacity: 0.95, fill: false, interactive: false } }),
    L.geoJSON(fc, { pane: 'alertSelPane', style: { color: '#0d1218', weight: 2.4, opacity: 1, fill: false, interactive: false } }),
  ]).addTo(map);
  return A.selLayer.getLayers()[0].getBounds();
}

// ---------- hazards: fires and storms ----------
async function loadFires() {
  const F = S.hz.fires;
  try {
    const meta = await getJson('data/fires.json');
    if (F.meta?.generated === meta.generated && F.data) return;
    const res = await fetch(`data/${meta.file || 'fires.bin'}?v=${encodeURIComponent(meta.generated)}`);
    if (!res.ok) throw new Error(res.status);
    F.data = decodeFires(meta, await res.arrayBuffer()); F.meta = meta;
  } catch { /* keep the last copy */ }
}
async function loadAreas() { try { S.hz.areas.data = await getJson('data/fire-areas.json'); } catch { /* keep */ } }
async function loadTropical() { try { S.hz.trop.data = await getJson('data/tropical.json'); } catch { /* keep */ } renderHazardBtn(); renderLegend(); renderChips(); }

async function syncFires() {
  const F = S.hz.fires, A = S.hz.areas;
  if (!S.overlays.has('fires')) { for (const l of [F.layer, A.layer]) if (l && map.hasLayer(l)) map.removeLayer(l); return; }
  if (!F.data) {
    F.loading = F.loading || Promise.all([loadFires(), loadAreas()]).finally(() => { F.loading = null; });
    await F.loading;
    if (!S.overlays.has('fires')) return;
    renderChips();
  }
  if (A.data && A.layer?._src !== A.data) { if (A.layer) map.removeLayer(A.layer); A.layer = buildAreaLayer(L, A.data.areas); A.layer._src = A.data; }
  if (A.layer && !map.hasLayer(A.layer)) A.layer.addTo(map);
  if (!F.data) return;
  if (!F.layer) F.layer = new FireLayer({ pane: 'firePane' });
  if (F.layer._d !== F.data) F.layer.setData(F.data);
  if (!map.hasLayer(F.layer)) F.layer.addTo(map);
}
async function syncTropical() {
  const T = S.hz.trop;
  if (!S.overlays.has('tropical')) { if (T.layer && map.hasLayer(T.layer)) map.removeLayer(T.layer); return; }
  if (!T.data) { await loadTropical(); if (!S.overlays.has('tropical') || !T.data) return; }
  if (T.layer?._src !== T.data) { if (T.layer) map.removeLayer(T.layer); T.layer = buildTropicalLayer(L, T.data.storms); T.layer._src = T.data; }
  if (!map.hasLayer(T.layer)) T.layer.addTo(map);
}
function syncHazards() { syncAlerts(); syncFires(); syncTropical(); }

// ---------- hazards: list, button, key ----------
function hazardCounts() {
  const groups = groupAlerts(S.hz.alerts.list || []);
  const alerts = groups.filter((g) => g.type !== 'statement');
  return { groups, alerts, statements: groups.filter((g) => g.type === 'statement'), storms: S.hz.trop.data?.storms || [] };
}
function renderHazardBtn() {
  const b = $('#hazardBtn'); if (!b) return;
  const { alerts, storms } = hazardCounts();
  const n = alerts.length + storms.length;
  const badge = b.querySelector('.badge');
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = !n;
  b.dataset.risk = alerts[0]?.risk || (storms.length ? 'storm' : '');
  b.title = `Active hazards: ${alerts.length} ECCC alert${alerts.length === 1 ? '' : 's'}, ${storms.length} tropical storm${storms.length === 1 ? '' : 's'}`;
}
const swatch = (k) => `<i class="sw" style="background:${RISK[k].fill};border-color:${RISK[k].line}"></i>`;
function hazardKeyHtml() {
  const rows = [];
  if (S.overlays.has('alerts')) rows.push(`<div class="key-row"><b>ECCC alerts</b>${['red', 'orange', 'yellow'].map((k) => `<span>${swatch(k)}${RISK[k].label}</span>`).join('')}<span><i class="sw dash"></i>Statement</span></div>`);
  if (S.overlays.has('fires')) rows.push(`<div class="key-row"><b>Fires</b>${FIRE_AGES.map((a) => `<span><i class="fd" style="background:${a.color}"></i>${a.label.replace('under ', '&lt;')}</span>`).join('')}<span><i class="sw area"></i>Fire area</span></div>`);
  if (S.overlays.has('tropical') && (S.hz.trop.data?.storms || []).length) rows.push(`<div class="key-row"><b>Storms</b><span><i class="sw cone"></i>Forecast cone</span>${[30, 50, 70, 90, 105, 120, 140].map((kt) => { const c = stormCat(kt); return `<span><i class="fd" style="background:${c.color}"></i>${c.code === 'TD' ? 'D' : c.code === 'TS' ? 'S' : c.code}</span>`; }).join('')}</div>`);
  return rows.length ? `<div class="hz-keys">${rows.join('')}</div>` : '';
}
function hazardChips() {
  const later = S.offset !== 0 ? ' · now, not forecast' : '';
  const out = [];
  if (S.overlays.has('alerts')) {
    const A = S.hz.alerts, n = hazardCounts().alerts.length;
    out.push(`<span class="chip${A.error ? ' warn' : ''}${later ? ' off' : ''}"><b>ECCC alerts</b>live · <span class="t">${A.list ? `${n} active` : A.error ? 'not answering' : 'loading'}${later}</span></span>`);
  }
  if (S.overlays.has('fires')) {
    const m = S.hz.fires.meta;
    out.push(`<span class="chip${later ? ' off' : ''}"><b>Fires</b>NASA FIRMS · <span class="t">${m ? `24 h to ${esc(fmtZ(Date.parse(m.generated)))}` : 'loading'}${later}</span></span>`);
  }
  if (S.overlays.has('tropical')) {
    const st = S.hz.trop.data?.storms;
    out.push(`<span class="chip${later ? ' off' : ''}"><b>Storms</b>NHC · <span class="t">${st ? (st.length ? `${st.length} active` : 'none active') : 'loading'}${later}</span></span>`);
  }
  return out.join('');
}

function alertItemHtml(g, i) {
  const r = RISK[g.risk], t = TYPE[g.type];
  const rk = g.type === 'statement' ? 'Statement' : `${r.label} ${t.label.toLowerCase()}`;
  return `<button type="button" class="hz-item" data-alert="${i}" style="--rk:${r.fill};--rl:${r.line}">
    <span class="hz-main"><b>${esc(g.name)}</b><span class="hz-meta"><span class="rk-tag" style="background:${r.fill};color:${r.ink}">${esc(rk)}</span> ${esc(provName(g.province))} · ${g.regions.length} area${g.regions.length === 1 ? '' : 's'}</span>
    <span class="hz-meta">${g.expires ? `Expires ${esc(fmtWhen(g.expires))}` : `Issued ${esc(fmtWhen(g.issued))}`}</span></span></button>`;
}
function keyDetailsHtml() {
  return `<details class="hz-key"><summary>What the colours and alert types mean</summary>
    <dl class="plain">${['red', 'orange', 'yellow'].map((k) => `<dt>${swatch(k)}${RISK[k].label}</dt><dd>${esc(RISK[k].meaning)}</dd>`).join('')}
    ${Object.values(TYPE).map((t) => `<dt>${esc(t.label)}</dt><dd>${esc(t.meaning)}</dd>`).join('')}</dl>
    <p class="note">ECCC picks the colour from expected impact and forecaster confidence. Wording from canada.ca/weather-alerts.</p></details>`;
}

async function openHazards() {
  S.point = null; highlight(null);
  openDrawer('Active hazards', 'Checking ECCC alerts…');
  S.drawer = 'hazards';
  renderHazards();
  await Promise.all([loadAlertList(), S.hz.trop.data ? null : loadTropical(), S.hz.fires.data ? null : Promise.all([loadFires(), loadAreas()])]);
  if (S.drawer === 'hazards') renderHazards();
}
function renderHazards() {
  const A = S.hz.alerts, body = $('#drawerBody');
  const { alerts, statements, storms } = hazardCounts();
  S.hzGroups = [...alerts, ...statements];
  $('#drawerSub').textContent = A.at ? `ECCC alerts checked ${new Intl.DateTimeFormat('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false }).format(A.at)} · tap an item for details` : (A.error ? 'ECCC alert feed not answering' : 'Checking ECCC alerts…');
  const alertList = A.list == null
    ? `<p class="${A.error ? 'err' : 'loading'}">${A.error ? `The ECCC alert feed didn't answer (${esc(A.error)}). Try again in a few minutes, or check weather.gc.ca.` : 'Loading…'}</p>`
    : `${alerts.length ? alerts.map((g, i) => alertItemHtml(g, i)).join('') : '<p class="note">No warnings, watches or advisories in effect.</p>'}
       ${statements.length ? `<h4 class="hz-sub">Special weather statements · information only</h4>${statements.map((g, i) => alertItemHtml(g, alerts.length + i)).join('')}` : ''}`;
  const F = S.hz.fires, areas = S.hz.areas.data?.areas || [];
  let inView = 0;
  if (F.data) { const b = map.getBounds(); for (let i = 0; i < F.data.n; i++) { const la = F.data.gy[i] / F.data.grid, lo = F.data.gx[i] / F.data.grid; if (b.contains([la, lo])) inView += F.data.cnt[i]; } }
  body.innerHTML = `
    <section>
      <div class="sec-h"><h3>ECCC weather alerts</h3><span class="aside">${alerts.length} in effect</span></div>
      <div class="hz-list">${alertList}</div>
      ${keyDetailsHtml()}
      <p class="note">Source: Environment and Climate Change Canada, read live. Text is shown as ECCC publishes it. Official alerts: <a href="${wxLink('')}" target="_blank" rel="noopener">weather.gc.ca</a>.</p>
    </section>
    <section>
      <div class="sec-h"><h3>Tropical storms</h3><span class="aside">${storms.length} active</span></div>
      <div class="hz-list">${storms.length ? storms.map((s, i) => { const c = stormCat(s.kt); return `<button type="button" class="hz-item" data-storm="${i}" style="--rk:${c.color};--rl:#0d1218"><span class="hz-main"><b>${esc(s.label)} ${esc(s.name)}</b><span class="hz-meta">${esc(c.label)}${s.kt != null ? ` · ${ktToKmh(s.kt)} km/h (${s.kt} kt)` : ''}${s.mb ? ` · ${s.mb} hPa` : ''}</span><span class="hz-meta">${s.forecastSource === 'CHC' ? 'ECCC Canadian Hurricane Centre' : 'NOAA National Hurricane Center'}${s.updated ? ` · ${esc(fmtWhen(s.updated))}` : ''}</span></span></button>`; }).join('') : '<p class="note">No active tropical cyclones in the Atlantic or eastern and central Pacific (NOAA NHC).</p>'}</div>
    </section>
    <section>
      <div class="sec-h"><h3>Wildfires</h3><span class="aside">${S.overlays.has('fires') ? '' : '<button type="button" class="linkish" data-show-fires>Show on map</button>'}</span></div>
      ${F.meta ? `<p class="hz-stat"><b>${F.meta.detections.toLocaleString('en-CA')}</b> satellite fire detections worldwide in the last 24 h${F.data ? `, <b>${inView.toLocaleString('en-CA')}</b> in the current view` : ''}.</p>` : '<p class="loading">Loading fire data…</p>'}
      ${S.hz.areas.data ? `<p class="hz-stat"><b>${areas.length}</b> active fire area${areas.length === 1 ? '' : 's'} in Canada (hotspots in the last 7 days).</p>
        <div class="hz-list">${areas.slice(0, 8).map((a, i) => `<button type="button" class="hz-item" data-area="${i}" style="--rk:#ff6a2b;--rl:#c2410c"><span class="hz-main"><b>About ${a.ha != null ? a.ha.toLocaleString('en-CA') : '?'} ha</b><span class="hz-meta">Last hotspot ${esc(fmtDay(a.last))} · first ${esc(fmtDay(a.first))}</span></span></button>`).join('')}</div>` : ''}
      <p class="note">Detections: NASA FIRMS (VIIRS, 375 m). Fire areas: Canadian Wildland Fire Information System (Natural Resources Canada), estimated from satellite hotspots. Not official fire perimeters.</p>
    </section>`;
}
const fmtShort = (iso) => new Intl.DateTimeFormat('en-CA', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(Date.parse(iso));
const fmtDay = (iso) => (iso ? new Intl.DateTimeFormat('en-CA', { day: 'numeric', month: 'short' }).format(Date.parse(iso)) : '—');

function onDrawerClick(e) {
  const a = e.target.closest('[data-alert]');
  if (a) return openAlert(S.hzGroups[Number(a.dataset.alert)], true);
  const st = e.target.closest('[data-storm]');
  if (st) return openStorm(Number(st.dataset.storm));
  const ar = e.target.closest('[data-area]');
  if (ar) {
    const area = S.hz.areas.data?.areas?.[Number(ar.dataset.area)];
    if (area) {
      if (!S.overlays.has('fires')) toggleOverlay('fires');
      map.fitBounds(L.latLngBounds(area.polys.flatMap((p) => p[0].map(([x, y]) => [y, x]))), { maxZoom: 10, ...fitPad() });
    }
    return;
  }
  if (e.target.closest('[data-show-fires]')) { if (!S.overlays.has('fires')) toggleOverlay('fires'); setTimeout(() => S.drawer === 'hazards' && renderHazards(), 1500); return; }
  if (e.target.closest('[data-back]')) return openHazards();
  const ga = e.target.closest('[data-open-group]');
  if (ga) {
    const k = ga.dataset.openGroup;
    const g = groupAlerts(S.hz.alerts.list || []).find((x) => x.key === k) || (S.pointGroups || []).find((x) => x.key === k);
    if (g) openAlert(g, false);
  }
}

function alertBanner(g) {
  const r = RISK[g.risk], t = TYPE[g.type];
  const lab = g.type === 'statement' ? 'Special weather statement' : `${r.label} ${t.label}`;
  return `<div class="alert-banner" style="--rk:${r.fill};--ink:${r.ink}"><span>${esc(lab)}</span><b>${esc(g.name)}</b></div>`;
}
const alertTextHtml = (text) => `<div class="report"><div class="report-head"><b>ECCC alert text</b><span>as published</span></div><pre class="alert-text">${esc(text)}</pre></div>`;

async function openAlert(g, fromList) {
  if (!g) return;
  S.point = null; S.drawer = 'alert';
  openDrawer(g.name, `${g.type === 'statement' ? 'Special weather statement' : `${RISK[g.risk].label} ${TYPE[g.type].label.toLowerCase()}`} · ${provName(g.province)}`);
  const r = RISK[g.risk], t = TYPE[g.type];
  $('#drawerBody').innerHTML = `
    ${fromList ? '<button type="button" class="linkish back" data-back>← All hazards</button>' : ''}
    <section>
      ${alertBanner(g)}
      <dl class="plain alert-dl">
        ${g.type !== 'statement' ? `<dt>Colour</dt><dd>${swatch(g.risk)}<b>${esc(r.label)}</b>: ${esc(r.meaning)}</dd>` : ''}
        <dt>Type</dt><dd><b>${esc(t.label)}</b>: ${esc(t.meaning)}</dd>
        ${g.impact ? `<dt>Impact</dt><dd>${esc(cap1(g.impact))}</dd>` : ''}
        ${g.confidence ? `<dt>Confidence</dt><dd>${esc(cap1(g.confidence))}</dd>` : ''}
        <dt>Issued</dt><dd>${esc(fmtWhen(g.issued))}</dd>
        <dt>Expires</dt><dd>${esc(fmtWhen(g.expires))}</dd>
        <dt>Areas (${g.regions.length})</dt><dd><ul class="areas">${g.regions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></dd>
      </dl>
    </section>
    <section id="alertText"><p class="loading">Loading the alert text from ECCC…</p></section>
    <p class="note">Source: Environment and Climate Change Canada. Contains information licenced under the Data Server End-use Licence of ECCC. Official alert: <a href="${wxLink(g.province)}" target="_blank" rel="noopener">weather.gc.ca warnings, ${esc(provName(g.province) || 'Canada')}</a>.</p>`;
  const ids = g.ids.slice(0, 60);
  const res = await Promise.allSettled(ids.map((id) => getJson(`${ALERTS_API}/${encodeURIComponent(id)}?f=json`)));
  if (S.drawer !== 'alert' || $('#drawerTitle').textContent !== g.name) return;
  const feats = res.filter((x) => x.status === 'fulfilled' && x.value?.geometry).map((x) => x.value);
  const b = highlight(feats);
  if (b?.isValid()) map.fitBounds(b, { maxZoom: 9, ...fitPad() });
  const text = feats.find((f) => f.properties?.alert_text_en)?.properties.alert_text_en || g.text;
  const sec = $('#alertText');
  if (sec) sec.innerHTML = text ? alertTextHtml(text) : '<p class="err">The alert text did not load. Use the weather.gc.ca link below.</p>';
}
// Keep fitted areas clear of the top bar, the time bar and (on wide screens) the drawer.
const fitPad = () => {
  const phone = matchMedia('(max-width: 760px)').matches, tb = ($('#timebar')?.offsetHeight || 100) + 24;
  return { paddingTopLeft: [phone ? 20 : 30, 70], paddingBottomRight: [phone ? 20 : 470, tb] };
};
const cap1 = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function stormHtml(s, compact) {
  const c = stormCat(s.kt);
  const mv = s.dir != null && s.mph != null ? `${compassFull(s.dir)} at ${Math.round(s.mph * 1.609)} km/h` : null;
  const pts = (s.points || []).filter((p) => p.tau > 0);
  return `<article class="hz-card" style="--rk:${c.color};--rl:#0d1218">
    <div class="hz-card-h"><span class="rk-pill" style="background:${c.color};color:#0d1218">${esc(c.code === 'TD' || c.code === 'TS' ? c.code : `Cat ${c.code}`)}</span><b>${esc(s.label)} ${esc(s.name)}</b></div>
    <dl class="plain">
      ${s.kt != null ? `<dt>Max wind</dt><dd>${ktToKmh(s.kt)} km/h (${s.kt} kt), ${esc(c.label.toLowerCase())}</dd>` : ''}
      ${s.mb ? `<dt>Pressure</dt><dd>${s.mb} hPa</dd>` : ''}
      ${s.lat != null ? `<dt>Centre</dt><dd>${Math.abs(s.lat).toFixed(1)}°${s.lat >= 0 ? 'N' : 'S'} ${Math.abs(s.lon).toFixed(1)}°${s.lon >= 0 ? 'E' : 'W'}</dd>` : ''}
      ${mv ? `<dt>Moving</dt><dd>${esc(mv)}</dd>` : ''}
      ${s.updated ? `<dt>Updated</dt><dd>${esc(fmtWhen(s.updated))}</dd>` : ''}
      <dt>Forecast</dt><dd>${s.forecastSource === 'CHC' ? 'ECCC Canadian Hurricane Centre' : 'NOAA National Hurricane Center'}</dd>
    </dl>
    ${!compact && pts.length ? `<table class="fc tc"><thead><tr><th>Forecast</th><th>Strength</th><th>Wind</th></tr></thead><tbody>${pts.map((p) => { const pc = stormCat(p.kt); return `<tr><td>${esc(p.valid ? fmtShort(p.valid) : p.when || (p.tau != null ? `+${p.tau} h` : ''))}</td><td><i class="fd" style="background:${pc.color}"></i>${esc(pc.label)}</td><td>${p.kt != null ? `${ktToKmh(p.kt)} km/h` : '–'}</td></tr>`; }).join('')}</tbody></table>` : ''}
    <p class="note">The cone shows where the centre will probably track. Wind, rain and surge often reach well outside it.${s.advisory ? ` <a href="${esc(s.advisory)}" target="_blank" rel="noopener">Official NHC advisory</a>.` : ''} For storms threatening Canada: <a href="https://weather.gc.ca/hurricane/index_e.html" target="_blank" rel="noopener">Canadian Hurricane Centre</a>.</p>
  </article>`;
}
const compassFull = (d) => ({ N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast', S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest' }[compass(d)] || '');

function openStorm(i) {
  const s = S.hz.trop.data?.storms?.[i]; if (!s) return;
  S.point = null; S.drawer = 'storm'; highlight(null);
  if (!S.overlays.has('tropical')) toggleOverlay('tropical');
  openDrawer(`${s.label} ${s.name}`, s.forecastSource === 'CHC' ? 'ECCC Canadian Hurricane Centre' : 'NOAA National Hurricane Center');
  $('#drawerBody').innerHTML = `<button type="button" class="linkish back" data-back>← All hazards</button>${stormHtml(s, false)}`;
  const ll = [[s.lat, s.lon], ...(s.points || []).map((p) => [p.lat, p.lon]), ...(s.cone || []).flatMap((poly) => poly[0].map(([x, y]) => [y, x]))].filter(([a, b]) => a != null && b != null);
  if (ll.length) map.fitBounds(L.latLngBounds(ll), { maxZoom: 7, ...fitPad() });
}

// Hazards at a tapped point: alerts (live), storms and fires (published data),
// plus CWFIS fire weather at the nearest Canadian hotspot.
async function renderPointHazards(lat, lon, pt) {
  const sec = $('#hzSec'); if (!sec) return;
  const same = () => S.point?.lat === lat && S.point?.lon === lon && $('#hzSec');
  const st = { alerts: '', storms: '', fires: '' };
  const draw = () => { if (!same()) return; const html = st.alerts + st.storms + st.fires; sec.innerHTML = html ? `<div class="sec-h"><h3>Hazards here</h3></div>${html}` : ''; sec.hidden = !html; };
  if (S.overlays.has('tropical')) st.storms = stormsAt(S.hz.trop.data?.storms, lat, lon, pt, (ll) => map.latLngToContainerPoint(ll)).map((s) => stormHtml(s, true)).join('');
  let fire = null, area = null;
  if (S.overlays.has('fires')) {
    const F = S.hz.fires;
    fire = F.data && F.layer ? summariseFires(F.data, F.layer.hits(pt, 14).map((h) => h.i)) : null;
    area = (S.hz.areas.data?.areas || []).find((a) => inPolys(a.polys, lon, lat)) || null;
    if (fire || area) st.fires = fireHtml(fire, area);
  }
  draw();
  const jobs = [];
  if (S.overlays.has('alerts')) jobs.push((async () => {
    const tol = (10 * metresPerPx()) / 111320; // about 10 screen pixels, in degrees
    const ex = tol / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    try {
      const j = await getJson(`${ALERTS_API}?f=json&limit=50&bbox=${(lon - ex).toFixed(4)},${(lat - tol).toFixed(4)},${(lon + ex).toFixed(4)},${(lat + tol).toFixed(4)}`);
      const feats = (j.features || []).filter((f) => isActive(f.properties) && (inGeom(f.geometry, lon, lat) || nearPolys(polysOf(f.geometry), lon, lat, tol)));
      if (!same()) return;
      highlight(feats);
      S.pointGroups = groupAlerts(feats);
      st.alerts = S.pointGroups.map((g) => `<article class="hz-card" style="--rk:${RISK[g.risk].fill};--rl:${RISK[g.risk].line}">
        ${alertBanner(g)}
        <p class="hz-meta">${g.expires ? `Expires ${esc(fmtWhen(g.expires))}` : `Issued ${esc(fmtWhen(g.issued))}`} · ${esc(g.regions[0] || provName(g.province))}</p>
        <p class="hz-mean">${esc(g.type === 'statement' ? TYPE.statement.meaning : RISK[g.risk].meaning)}</p>
        ${g.text ? `<details><summary>Read the ECCC alert text</summary><pre class="alert-text">${esc(g.text)}</pre></details>` : ''}
        <button type="button" class="linkish" data-open-group="${esc(g.key)}">All areas and details</button>
      </article>`).join('');
    } catch { st.alerts = '<p class="err">The ECCC alert feed did not answer for this point.</p>'; }
    draw();
  })());
  if (fire && lat > 41 && lat < 84 && lon > -142 && lon < -52) jobs.push((async () => {
    const d = 0.06;
    const q = new URLSearchParams({
      service: 'WFS', version: '1.0.0', request: 'GetFeature', typeName: 'public:hotspots_last24hrs', outputFormat: 'application/json', maxFeatures: '60',
      propertyName: 'lat,lon,rep_date,agency,fuel,fwi,isi,bui,hfi,ros,temp,rh,ws',
      CQL_FILTER: `lat BETWEEN ${(lat - d).toFixed(3)} AND ${(lat + d).toFixed(3)} AND lon BETWEEN ${(lon - d * 1.6).toFixed(3)} AND ${(lon + d * 1.6).toFixed(3)}`,
    });
    try {
      const j = await getJson(`${CWFIS_WFS}?${q}`);
      const near = (j.features || []).map((f) => f.properties).filter((p) => p && p.lat != null)
        .map((p) => ({ p, d: distKm(lat, lon, p.lat, p.lon) })).sort((a, b) => a.d - b.d)[0];
      if (!near || !same()) return;
      st.fires = fireHtml(fire, area, near);
      draw();
    } catch { /* fire weather is extra; skip quietly */ }
  })());
  await Promise.all(jobs);
}
function fireHtml(f, area, fw) {
  const ago = (m) => (m < 90 ? `${Math.round(m)} min` : `${Math.round(m / 6) / 10} h`);
  const p = fw?.p;
  const num1 = (v) => (v == null ? '–' : Math.round(v * 10) / 10);
  return `<article class="hz-card" style="--rk:#ff4a1a;--rl:#7a1d00">
    <div class="hz-card-h"><span class="rk-pill" style="background:#ff4a1a;color:#fff">Wildfire</span><b>${f ? 'Satellite fire detections' : 'Fire area'}</b></div>
    <dl class="plain">
      ${f ? `<dt>Detections</dt><dd>${f.detections} in the last 24 h, within about ${Math.max(1, Math.round(14 * metresPerPx() / 1000))} km</dd>
      <dt>Latest</dt><dd>${ago(f.newestMin)} ago${f.night ? ', night pass' : ''}</dd>
      <dt>Strongest</dt><dd>${Math.round(f.frp)} MW fire radiative power (heat output; higher is more intense)</dd>
      <dt>Confidence</dt><dd>${f.high ? 'High' : 'Nominal'}</dd>
      <dt>Satellites</dt><dd>${esc(f.satellites.join(', ') || '–')}</dd>` : ''}
      ${area ? `<dt>Fire area</dt><dd>About ${area.ha != null ? area.ha.toLocaleString('en-CA') : '?'} ha, estimated from hotspots</dd><dt>First hotspot</dt><dd>${esc(fmtDay(area.first))}</dd><dt>Last hotspot</dt><dd>${esc(fmtDay(area.last))}</dd>` : ''}
    </dl>
    ${p ? `<h4 class="hz-sub">Fire weather at the nearest Canadian hotspot (${fw.d < 1 ? '<1' : Math.round(fw.d)} km)</h4>
    <dl class="plain">
      ${p.fuel ? `<dt>Fuel type</dt><dd>${esc(p.fuel)}${FUELS[p.fuel] ? `: ${esc(FUELS[p.fuel])}` : ''}</dd>` : ''}
      <dt>Fire Weather Index</dt><dd>${num1(p.fwi)} (expected fire intensity; higher is more intense)</dd>
      <dt>Spread index (ISI)</dt><dd>${num1(p.isi)}</dd>
      <dt>Buildup index (BUI)</dt><dd>${num1(p.bui)}</dd>
      <dt>Head fire intensity</dt><dd>${p.hfi == null ? '–' : Math.round(p.hfi).toLocaleString('en-CA')} kW/m</dd>
      <dt>Rate of spread</dt><dd>${num1(p.ros)} m/min</dd>
      ${p.temp != null ? `<dt>Weather</dt><dd>${num1(p.temp)} °C, humidity ${Math.round(p.rh)} %, wind ${Math.round(p.ws)} km/h</dd>` : ''}
      <dt>Reported</dt><dd>${esc(fmtWhen(p.rep_date))}${p.agency ? ` · ${esc(p.agency)}` : ''}</dd>
    </dl>` : ''}
    <p class="note">A detection is a satellite pixel (375 m) much hotter than its surroundings: usually wildfire, sometimes a controlled burn, gas flare or industry. NASA FIRMS; CWFIS (Natural Resources Canada) fire areas and fire weather are model estimates, not official perimeters.</p>
  </article>`;
}
function metresPerPx() {
  const c = map.getCenter();
  return (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / (256 * 2 ** map.getZoom());
}

function renderChips() {
  const t = selectedTime();
  const html = activeIds().map((id) => {
    const def = defOf(id); if (!def) return '';
    if (!available(def)) return `<span class="chip off"><b>${esc(def.label)}</b> not available</span>`;
    const e = entryOf(id); const r = resolveTime(def, e, t);
    const model = e?.model || def.model;
    const ref = e?.reference && kindOf(def, e) === 'model' ? ` · run ${fmtZ(Date.parse(e.reference)).replace(':00Z', 'Z')}` : '';
    return `<span class="chip${r.show ? '' : ' off'}${r.warn || e?.stale ? ' warn' : ''}"><b>${esc(def.label)}</b>${model ? esc(model) + ' ·' : ''} <span class="t">${esc(r.label)}</span>${esc(ref)}</span>`;
  }).join('');
  let wind = '';
  if (S.overlays.has('wind')) {
    const wt = windTimeFor(t);
    wind = wt == null
      ? `<span class="chip off"><b>Wind animation</b> <span class="t">${S.wind.index ? 'no data for this time' : 'not available yet'}</span></span>`
      : `<span class="chip"><b>Wind animation</b>GDPS · <span class="t">valid ${esc(fmtZd(wt))}</span></span>`;
  }
  let pres = '';
  if (S.overlays.has('isobars')) {
    const pt = nearestTime(S.pres.index, t);
    pres = pt == null
      ? `<span class="chip off"><b>Isobars</b> <span class="t">${S.pres.index ? 'no data for this time' : 'not available yet'}</span></span>`
      : `<span class="chip"><b>Isobars</b>GDPS · 4 hPa · <span class="t">valid ${esc(fmtZd(pt))}</span></span>`;
  }
  const hz = hazardChips();
  $('#chips').innerHTML = html + wind + pres + hz;
  const lt = $('#legendTimes');
  if (lt) lt.innerHTML = html + wind + pres + hz;
}

function renderLegend() {
  const def = defOf(S.main); const e = entryOf(S.main); const el = $('#legend');
  if (!def) { el.hidden = true; return; }
  const src = S.config.sources[e?.source || def.source];
  const name = (e?.names || [def.candidates[0]])[0];
  const img = src.legend && name
    ? `<img alt="Colour scale for ${esc(def.label)}" onerror="this.remove()" src="${esc(`${src.wms}?service=WMS&version=1.3.0&request=GetLegendGraphic&sld_version=1.1.0&format=image/png&layer=${encodeURIComponent(name)}`)}">`
    : '';
  el.innerHTML = `<button type="button" class="legend-head" aria-expanded="${!S.legendCollapsed}"><span><b>${esc(def.label)}</b><small>${esc(e?.model || def.model || src.label)} · ${esc(def.coverage || '')}</small></span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14l5-5 5 5z"/></svg></button><div class="legend-body">${img}${e?.note ? `<div class="legend-note">${esc(e.note)}</div>` : ''}${hazardKeyHtml()}<div class="legend-times" id="legendTimes" aria-label="Layer times"></div></div>`;
  el.classList.toggle('collapsed', !!S.legendCollapsed);
  el.hidden = false;
}

// ---------- rail ----------
function renderRail() {
  const item = (def, role) => {
    const on = role === 'radio' ? S.main === def.id : S.overlays.has(def.id);
    const ok = available(def);
    const attr = role === 'radio' ? `role="radio" aria-checked="${on}"` : `aria-pressed="${on}"`;
    return `<button type="button" class="layer${ok ? '' : ' unavailable'}" data-id="${def.id}" data-role="${role}" ${attr} ${ok ? '' : 'aria-disabled="true"'}>
      <span class="mark"></span><span class="name">${esc(def.label)}</span>
      <span class="meta">${esc(ok ? def.coverage : 'not in source catalogue this run')}</span></button>`;
  };
  $('#mainList').innerHTML = S.config.layers.filter((l) => l.group === 'main').map((d) => item(d, 'radio')).join('');
  const local = [
    { id: 'wind', label: 'Wind animation', coverage: S.wind.index ? 'Global · ECCC GDPS 10 m wind' : 'waiting for first wind run' },
    { id: 'isobars', label: 'Isobars and pressure centres', coverage: S.pres.index ? 'Global · GDPS sea-level pressure, 4 hPa' : 'waiting for first pressure run' },
    { id: 'cities', label: 'City names', coverage: 'Natural Earth · more appear as you zoom' },
    { id: 'stations', label: 'Airports (METAR/TAF)', coverage: S.metar ? `${S.metar.stations.length.toLocaleString('en-CA')} stations · shown from regional zoom` : 'loading…' },
    { id: 'alerts', label: 'ECCC weather alerts', coverage: 'Canada · live from ECCC · tap an area for details' },
    { id: 'fires', label: 'Wildfires', coverage: 'Global satellite detections, last 24 h · Canadian fire areas' },
    { id: 'tropical', label: 'Tropical storms', coverage: 'Atlantic and Pacific · NOAA NHC, ECCC CHC' },
  ];
  const quickIds = new Set([...document.querySelectorAll('[data-quick]')].map((b) => b.dataset.quick));
  $('#overlayList').innerHTML = [...local, ...S.config.layers.filter((l) => l.group === 'overlay')].filter((d) => !quickIds.has(d.id)).map((d) => item(d, 'check')).join('');
  document.querySelectorAll('[data-base]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.base === S.base)));
}

function onRailClick(ev) {
  const b = ev.target.closest('.layer'); if (!b || b.getAttribute('aria-disabled') === 'true') return;
  const id = b.dataset.id;
  if (b.dataset.role === 'radio') { S.main = id; store.set('main', id); }
  else { S.overlays.has(id) ? S.overlays.delete(id) : S.overlays.add(id); store.set('overlays', [...S.overlays]); }
  renderRail(); updateStations(); applyTime(true);
}

// Quick toggles on the map edge mirror the overlay switches.
function toggleOverlay(id) {
  S.overlays.has(id) ? S.overlays.delete(id) : S.overlays.add(id);
  store.set('overlays', [...S.overlays]);
  renderRail(); updateStations(); applyTime(true);
}
function renderQuick() {
  document.querySelectorAll('[data-quick]').forEach((b) => {
    b.setAttribute('aria-pressed', String(S.overlays.has(b.dataset.quick)));
    if (b.dataset.quick === 'stations') b.title = map.getZoom() < 6 ? 'Airports (zoom in to see them)' : 'Airports';
  });
}

function setBase(id) {
  S.base = id; store.set('base', id);
  for (const [k, l] of Object.entries(bases)) { if (k === id) l.addTo(map); else map.removeLayer(l); }
  renderRail();
}

// ---------- stations ----------
function updateStations() {
  const want = S.overlays.has('stations') && S.metar && map.getZoom() >= 6;
  if (!want) { if (stationLayer) map.removeLayer(stationLayer); return; }
  if (!stationLayer) {
    const renderer = L.canvas({ pane: 'stationPane', padding: 0.3 });
    stationLayer = L.layerGroup(S.metar.stations.map((s) => {
      const m = L.circleMarker([s[1], s[2]], { renderer, radius: 4.5, weight: 2, color: '#0d1218', fillColor: '#ffffff', fillOpacity: 1, pane: 'stationPane' });
      m.on('click', (e) => { L.DomEvent.stopPropagation(e); openStation(s[0]); });
      m.bindTooltip(s[0], { direction: 'top', offset: [0, -4], className: 'station-label' });
      return m;
    }));
  }
  if (!map.hasLayer(stationLayer)) stationLayer.addTo(map);
}

function nearestStation(lat, lon, maxKm = 60) {
  if (!S.metar) return null;
  let best = null;
  for (const s of S.metar.stations) {
    const d = distKm(lat, lon, s[1], s[2]);
    if (d <= maxKm && (!best || d < best.d)) best = { s, d };
  }
  return best;
}
function distKm(a, b, c, d) {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------- time UI ----------
const fmtLocal = (ms, opts = {}) => new Intl.DateTimeFormat('en-CA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short', ...opts }).format(ms);

function updateReadout() {
  const t = selectedTime();
  $('#timeLocal').textContent = fmtLocal(t);
  const d = new Date(t);
  $('#timeZulu').textContent = `${d.toISOString().slice(0, 10)} ${fmtZ(t)}  ·  ${S.offset === 0 ? 'now' : (S.offset > 0 ? '+' : '−') + humanOffset(Math.abs(S.offset))}`;
  $('#timeSlider').value = String(Math.round(toPos(S.offset)));
}
function humanOffset(m) {
  if (m < 60) return `${m} min`;
  if (m < 2880) return `${Math.round(m / 6) / 10} h`.replace('.0 h', ' h');
  return `${Math.round(m / 144) / 10} d`.replace('.0 d', ' d');
}
function renderTicks() {
  const pos = (m) => `${(toPos(m) / SMAX) * 100}%`;
  const marks = [[-180, '−3h', 'first'], [0, 'now', 'now'], [1440, '+1d'], [2880, '+2d'], [4320, '+3d'], [7200, '+5d'], [10080, '+7d'], [14400, '+10d', 'last']];
  $('#ticks').innerHTML = marks.map(([m, l, c]) => `<span class="${c || ''}" style="left:${pos(m)}">${l}</span>`).join('');
}
function setOffset(m) {
  S.offset = Math.max(-PAST, Math.min(FUT, round10(m)));
  applyTime();
}
function step(dir) {
  const idx = clockIndex();
  if (idx && S.offset >= 0 && !(dir < 0 && S.offset === 0)) {
    const cur = alignTime(selectedTime());
    const times = idx.times.map((x) => Date.parse(x)).sort((a, b) => a - b);
    const next = dir > 0 ? times.find((x) => x > cur + 60e3) : [...times].reverse().find((x) => x < cur - 60e3);
    if (next != null) return setOffset(Math.max(0, (next - S.now) / MIN));
  }
  setOffset(S.offset + dir * stepMinutes(dir));
}
function togglePlay(force) {
  S.playing = force ?? !S.playing;
  $('#playBtn').setAttribute('aria-pressed', String(S.playing));
  clearInterval(S.timer);
  if (S.playing) {
    S.timer = setInterval(() => {
      if (S.offset >= FUT) return togglePlay(false);
      step(1); applyTime(true);
    }, 1400);
  }
}

// ---------- drawer ----------
function openDrawer(title, sub) {
  $('#drawerTitle').textContent = title;
  $('#drawerSub').textContent = sub || '';
  $('#drawer').hidden = false;
  $('#drawerBody').innerHTML = '';
}
function closeDrawer() { $('#drawer').hidden = true; S.point = null; S.drawer = null; highlight(null); }

async function openStation(id) {
  const s = S.stationIndex.get(id);
  if (!s) return;
  map.setView([s[1], s[2]], Math.max(map.getZoom(), 7), { animate: !reduceMotion });
  await openPoint(L.latLng(s[1], s[2]), { station: s, dist: 0 });
}

async function openPoint(latlng, near) {
  const lat = Math.round(latlng.lat * 1000) / 1000;
  const lon = Math.round(L.Util.wrapNum(latlng.lng, [-180, 180], true) * 1000) / 1000;
  S.point = { lat, lon }; S.drawer = 'point';
  highlight(null);
  near = near || nearestStation(lat, lon);
  const coord = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  openDrawer(near?.d === 0 ? `${near.s[0]}` : 'Point forecast', near?.d === 0 ? `${near.s[3] || 'Station'} · ${coord}` : coord);
  const body = $('#drawerBody');
  body.innerHTML = `<section id="hzSec" hidden></section><section id="stnSec"></section><section id="fcSec"><p class="loading">Loading forecasts from GEM, ECMWF and GFS…</p></section>`;
  if (near) renderStation(near); else $('#stnSec').remove();
  renderPointHazards(lat, lon, map.latLngToContainerPoint(latlng));
  await renderForecast(lat, lon);
}

// ---------- METAR / TAF ----------
async function renderStation(near) {
  const [id, , , name, raw, obsTime] = near.s;
  const sec = $('#stnSec'); if (!sec) return;
  const taf = (await loadTaf()).tafs?.[id];
  const age = obsTime ? Math.round((Date.now() - Date.parse(obsTime)) / MIN) : null;
  const old = age != null && age > 150;
  const view = S.view;
  const m = parseMetar(raw);
  const metarBody = view === 'raw'
    ? `<pre class="raw">${esc(raw)}</pre>`
    : `<dl class="plain">${metarToPlain(m).map(([k, v]) => `<dt${k === 'Not decoded' ? ' class="bad"' : ''}>${esc(k)}</dt><dd${k === 'Not decoded' ? ' class="bad"' : ''}>${esc(v)}</dd>`).join('')}</dl>`;
  let tafBody = '<p class="note" style="padding:8px 10px;margin:0">No TAF issued for this station.</p>';
  if (taf) {
    if (view === 'raw') {
      tafBody = `<pre class="raw">${tafRawLines(taf.raw).map((l, i) => i === 0 ? esc(l) : `<span class="grp">${esc(l.split(' ')[0])}</span>${esc(l.slice(l.split(' ')[0].length))}`).join('\n')}</pre>`;
    } else {
      tafBody = tafToPlain(parseTaf(taf.raw)).map((sct) => `<div class="taf-sec"><h4>${esc(sct.title)}</h4><dl class="plain">${sct.lines.map(([k, v]) => `<dt${k === 'Not decoded' ? ' class="bad"' : ''}>${esc(k)}</dt><dd${k === 'Not decoded' ? ' class="bad"' : ''}>${esc(v)}</dd>`).join('')}</dl></div>`).join('');
    }
  }
  sec.innerHTML = `
    <div class="sec-h"><h3>${esc(id)}${near.d ? ` · ${Math.round(near.d)} km away` : ''}</h3>
      <div class="seg" role="radiogroup" aria-label="Report view">
        <button type="button" data-view="raw" aria-pressed="${view === 'raw'}">Raw</button>
        <button type="button" data-view="plain" aria-pressed="${view === 'plain'}">Plain language</button>
      </div></div>
    ${name && near.d ? `<p class="note" style="margin:-4px 0 8px">${esc(name)}</p>` : ''}
    <div class="report"><div class="report-head"><b>${m.kind}</b><span class="${old ? 'old' : ''}">${age == null ? '' : `observed ${age < 90 ? age + ' min' : Math.round(age / 6) / 10 + ' h'} ago${old ? ' · old report' : ''}`}</span></div>${metarBody}</div>
    <div class="report"><div class="report-head"><b>TAF</b><span>${taf?.issued ? 'issued ' + esc(fmtZ(Date.parse(taf.issued))) : ''}</span></div>${tafBody}</div>
    <p class="note">Decoded by fixed rules, not AI. Anything the rules don't recognise is listed under "Not decoded". NOAA Aviation Weather Center data, pulled ${S.metar ? esc(fmtZ(Date.parse(S.metar.generated))) : '—'}.</p>`;
  sec.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    S.view = b.dataset.view; store.set('view', S.view); renderStation(near);
  }));
}

// ---------- point forecast ----------
const VARS = 'temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,pressure_msl,cloud_cover';
const models = () => {
  const m = S.catalog?.models || {};
  return ['gem', 'ecmwf', 'gfs'].map((k) => ({ key: k, ...(m[k] || MODEL_DEFAULTS[k]) }));
};

async function renderForecast(lat, lon) {
  const sec = $('#fcSec'); if (!sec) return;
  const ms = models();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${VARS}&models=${ms.map((m) => m.id).join(',')}&wind_speed_unit=kmh&timeformat=unixtime&timezone=GMT&forecast_days=7`;
  let j;
  try {
    const res = await fetch(url);
    j = await res.json();
    if (!res.ok || j.error) throw new Error(j.reason || res.status);
  } catch (e) {
    if (S.point?.lat !== lat || S.point?.lon !== lon) return;
    sec.innerHTML = `<p class="err">The forecast service didn't answer (${esc(e.message || e)}). Tap the map again to retry.</p>`;
    return;
  }
  if (S.point?.lat !== lat || S.point?.lon !== lon) return; // user moved on
  const h = j.hourly;
  const series = (v, m) => h[`${v}_${m.id}`] || (ms.length === 1 ? h[v] : null) || [];
  const data = {
    time: h.time.map((s) => s * 1000),
    m: ms.map((m) => ({ ...m, t: series('temperature_2m', m), w: series('wind_speed_10m', m), wd: series('wind_direction_10m', m), g: series('wind_gusts_10m', m), p: series('precipitation', m), pr: series('pressure_msl', m), c: series('cloud_cover', m) })),
  };
  sec.innerHTML = `
    <div class="sec-h"><h3>Model comparison</h3><span class="aside">${j.elevation != null ? `${Math.round(j.elevation)} m elevation` : ''}</span></div>
    ${agreementHtml(data)}
    <div class="chart-box" id="chartBox" style="margin-top:12px"></div>
    <div class="tabs" role="tablist" id="fcTabs">
      ${[['temp', 'Temp'], ['wind', 'Wind'], ['precip', 'Precip'], ['pressure', 'Pressure'], ['cloud', 'Cloud']].map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}</button>`).join('')}
    </div>
    <div class="table-wrap" id="fcTable"></div>
    <p class="note">Spread = gap between the highest and lowest model. A wide spread means low confidence. Data: Open-Meteo (GEM from ECCC, ECMWF IFS, GFS from NOAA), CC BY 4.0. Times in your local time zone.</p>`;
  drawChart($('#chartBox'), data);
  const draw = () => { $('#fcTable').innerHTML = tableHtml(data, S.tab); };
  draw();
  $('#fcTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    S.tab = b.dataset.tab;
    $('#fcTabs').querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    draw();
  });
}

function spreadAt(arrs, i) {
  const v = arrs.map((a) => a[i]).filter((x) => x != null);
  return v.length >= 2 ? Math.max(...v) - Math.min(...v) : null;
}
function agreementHtml(d) {
  const start = d.time.findIndex((t) => t >= Date.now() - 3600e3);
  const win = (hrs) => {
    const tS = [], wS = [];
    for (let i = Math.max(0, start); i < Math.min(d.time.length, start + hrs); i++) {
      const a = spreadAt(d.m.map((m) => m.t), i); const b = spreadAt(d.m.map((m) => m.w), i);
      if (a != null) tS.push(a); if (b != null) wS.push(b);
    }
    const avg = (x) => (x.length ? x.reduce((p, c) => p + c, 0) / x.length : null);
    return { t: avg(tS), w: avg(wS) };
  };
  const grade = (s) => {
    if (s.t == null) return ['warn', 'Not enough model data'];
    if (s.t <= 2 && (s.w ?? 0) <= 8) return ['good', 'Models agree'];
    if (s.t <= 4 && (s.w ?? 0) <= 15) return ['warn', 'Some disagreement'];
    return ['bad', 'Models disagree'];
  };
  const a = win(24), b = win(72);
  const row = (label, s) => { const [c, txt] = grade(s); return `<div><span class="pill ${c}">${txt}</span> <span class="muted">${label}: temperature spread ${s.t?.toFixed(1) ?? '—'}°C, wind ${s.w != null ? Math.round(s.w) : '—'} km/h (average)</span></div>`; };
  return `<div class="agree">${row('Next 24 h', a)}${row('Next 72 h', b)}</div>`;
}

const compass = (d) => d == null ? '' : ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(d / 22.5) % 16];
const fmtRow = (ms) => new Intl.DateTimeFormat('en-CA', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);

function tableHtml(d, tab) {
  const rows = [];
  const start = d.time.findIndex((t) => t >= Date.now() - 3600e3);
  for (let i = Math.max(0, start); i < d.time.length; i += (i - start < 72 ? 6 : 12)) rows.push(i);
  const head = `<thead><tr><th>Time</th>${d.m.map((m) => `<th><i style="background:${MODEL_COLOURS[m.key]}"></i>${esc(m.label.split(' ')[0])}</th>`).join('')}${tab === 'wind' ? '' : '<th>Spread</th>'}</tr></thead>`;
  const sumP = (m, i, n) => { let s = 0, ok = false; for (let k = i; k < Math.min(i + n, m.p.length); k++) if (m.p[k] != null) { s += m.p[k]; ok = true; } return ok ? s : null; };
  let lastDay = null;
  const body = rows.map((i, idx) => {
    const n = idx + 1 < rows.length ? rows[idx + 1] - i : 6;
    const day = new Date(d.time[i]).toDateString();
    const dayCls = lastDay && day !== lastDay ? ' class="day"' : ''; lastDay = day;
    let cells, spread = null;
    if (tab === 'temp') { cells = d.m.map((m) => m.t[i]); spread = spreadAt(d.m.map((m) => m.t), i); cells = cells.map((v) => v == null ? '–' : `${Math.round(v)}°`); }
    else if (tab === 'wind') { cells = d.m.map((m) => m.w[i] == null ? '–' : `${compass(m.wd[i])} ${Math.round(m.w[i])}${m.g[i] != null ? ' G' + Math.round(m.g[i]) : ''}`); }
    else if (tab === 'precip') { const v = d.m.map((m) => sumP(m, i, n)); cells = v.map((x) => x == null ? '–' : x.toFixed(1)); const f = v.filter((x) => x != null); spread = f.length > 1 ? Math.max(...f) - Math.min(...f) : null; }
    else if (tab === 'pressure') { cells = d.m.map((m) => m.pr[i] == null ? '–' : Math.round(m.pr[i])); spread = spreadAt(d.m.map((m) => m.pr), i); }
    else { cells = d.m.map((m) => m.c[i] == null ? '–' : `${Math.round(m.c[i])}%`); spread = spreadAt(d.m.map((m) => m.c), i); }
    const hiLimit = { temp: 4, precip: 5, pressure: 6, cloud: 50 }[tab];
    const sp = tab === 'wind' ? '' : `<td class="spread${spread != null && spread > hiLimit ? ' hi' : ''}">${spread == null ? '–' : (tab === 'precip' ? spread.toFixed(1) : Math.round(spread))}</td>`;
    return `<tr${dayCls}><td>${esc(fmtRow(d.time[i]))}</td>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}${sp}</tr>`;
  }).join('');
  const unit = { temp: '°C', wind: 'km/h, direction wind is from, G = gusts', precip: `mm per period`, pressure: 'hPa, sea level', cloud: '% total cloud' }[tab];
  return `<table class="fc">${head}<tbody>${body}</tbody></table><p class="note">Units: ${unit}. Every 6 h for 3 days, then every 12 h.</p>`;
}

function drawChart(box, d) {
  const W = 400, H = 170, L0 = 30, R0 = 54, T0 = 10, B0 = 22;
  const idx = d.time.map((t, i) => i).filter((i) => d.time[i] >= Date.now() - 3600e3);
  if (idx.length < 2) { box.innerHTML = ''; return; }
  const t0 = d.time[idx[0]], t1 = d.time[idx[idx.length - 1]];
  const vals = d.m.flatMap((m) => idx.map((i) => m.t[i])).filter((v) => v != null);
  if (!vals.length) { box.innerHTML = ''; return; }
  let lo = Math.floor(Math.min(...vals) / 5) * 5, hi = Math.ceil(Math.max(...vals) / 5) * 5;
  if (hi - lo < 10) hi = lo + 10;
  const x = (t) => L0 + ((t - t0) / (t1 - t0)) * (W - L0 - R0);
  const y = (v) => T0 + (1 - (v - lo) / (hi - lo)) * (H - T0 - B0);
  const yt = []; for (let v = lo; v <= hi; v += (hi - lo > 25 ? 10 : 5)) yt.push(v);
  const days = []; const dd = new Date(t0); dd.setHours(24, 0, 0, 0);
  for (let t = dd.getTime(); t < t1; t += 864e5) days.push(t);
  const paths = d.m.map((m) => {
    let p = ''; let pen = false;
    for (const i of idx) { const v = m.t[i]; if (v == null) { pen = false; continue; } p += `${pen ? 'L' : 'M'}${x(d.time[i]).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }
    const lastI = [...idx].reverse().find((i) => m.t[i] != null);
    return { m, p, ly: lastI != null ? y(m.t[lastI]) : null };
  });
  // direct labels at line ends, nudged apart
  const lab = paths.filter((p) => p.ly != null).sort((a, b) => a.ly - b.ly);
  for (let k = 1; k < lab.length; k++) if (lab[k].ly - lab[k - 1].ly < 12) lab[k].ly = lab[k - 1].ly + 12;
  box.innerHTML = `
    <div class="chart-legend">${d.m.map((m) => `<span><i style="background:${MODEL_COLOURS[m.key]}"></i>${esc(m.label)}</span>`).join('')}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperature forecast by model for the next 7 days">
      ${yt.map((v) => `<line class="grid${v === 0 ? ' zero' : ''}" x1="${L0}" x2="${W - R0}" y1="${y(v)}" y2="${y(v)}"/><text x="${L0 - 5}" y="${y(v) + 3.5}" text-anchor="end">${v}°</text>`).join('')}
      ${days.map((t) => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T0}" y2="${H - B0}" stroke-dasharray="2 3"/><text x="${x(t) + 3}" y="${H - 7}">${new Intl.DateTimeFormat('en-CA', { weekday: 'short' }).format(t)}</text>`).join('')}
      ${paths.map((p) => `<path d="${p.p}" fill="none" stroke="${MODEL_COLOURS[p.m.key]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
      ${lab.map((p) => `<text class="lbl" x="${W - R0 + 6}" y="${p.ly + 4}" fill="${MODEL_COLOURS[p.m.key]}" style="fill:${MODEL_COLOURS[p.m.key]}">${esc(p.m.label.split(' ')[0])}</text>`).join('')}
      <line class="xhair" id="xh" x1="0" x2="0" y1="${T0}" y2="${H - B0}" visibility="hidden"/>
      <rect x="${L0}" y="${T0}" width="${W - L0 - R0}" height="${H - T0 - B0}" fill="transparent" id="hit"/>
    </svg><div class="tip" id="tip" hidden></div>`;
  const svg = box.querySelector('svg'); const xh = box.querySelector('#xh'); const tip = box.querySelector('#tip');
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((sx - L0) / (W - L0 - R0)) * (t1 - t0);
    let best = idx[0]; for (const i of idx) if (Math.abs(d.time[i] - t) < Math.abs(d.time[best] - t)) best = i;
    const px = x(d.time[best]);
    xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
    tip.innerHTML = `<div>${esc(fmtRow(d.time[best]))}</div>${d.m.map((m) => `<div><i style="background:${MODEL_COLOURS[m.key]}"></i>${esc(m.label.split(' ')[0])} ${m.t[best] == null ? '–' : m.t[best].toFixed(1) + '°C'}</div>`).join('')}`;
    tip.hidden = false;
    const left = (px / W) * r.width;
    tip.style.left = `${Math.min(left + 10, r.width - tip.offsetWidth)}px`;
    tip.style.top = `${28}px`;
  };
  const hit = box.querySelector('#hit');
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

// ---------- search ----------
let searchSeq = 0;
async function onSearch(q) {
  const list = $('#searchResults');
  q = q.trim();
  if (!q) { list.hidden = true; return; }
  const up = q.toUpperCase();
  const stn = S.stationIndex.get(up);
  const items = [];
  if (stn) items.push({ type: 'stn', id: up, label: `${up}`, sub: stn[3] || 'METAR station' });
  if (q.length >= 3) {
    const seq = ++searchSeq;
    try {
      const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
      if (seq !== searchSeq) return;
      for (const r of j.results || []) items.push({ type: 'place', lat: r.latitude, lon: r.longitude, label: r.name, sub: [r.admin1, r.country].filter(Boolean).join(', ') });
    } catch { /* geocoder down: stations still work */ }
  }
  if (!items.length) { list.innerHTML = `<li class="muted" style="padding:8px 10px">No match. Try a town name or a 4-letter ICAO code.</li>`; list.hidden = false; return; }
  list.innerHTML = items.map((it, i) => `<li><button type="button" data-i="${i}">${esc(it.label)}<small>${esc(it.sub)}</small></button></li>`).join('');
  list.hidden = false;
  list.onclick = (e) => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    const it = items[Number(b.dataset.i)];
    list.hidden = true; $('#searchInput').blur();
    if (it.type === 'stn') openStation(it.id);
    else { map.setView([it.lat, it.lon], 8, { animate: !reduceMotion }); openPoint(L.latLng(it.lat, it.lon)); }
  };
}

// ---------- feed status ----------
function renderStatus() {
  const st = S.status;
  const dot = $('#statusDot');
  if (!st) { dot.className = 'dot bad'; $('#statusBody').innerHTML = '<p>No feed check has run yet. It runs every 30 minutes once the site is deployed.</p>'; return; }
  const all = [...Object.values(st.sources), ...Object.values(st.layers), ...Object.values(st.models)];
  const bad = all.filter((v) => !v.ok).length;
  const age = Math.round((Date.now() - Date.parse(st.generated)) / MIN);
  dot.className = `dot ${age > 75 ? 'bad' : bad ? 'warn' : 'ok'}`;
  const label = (k) => defOf(k)?.label || { metar: 'METAR', taf: 'TAF', stations: 'Station names', geomet: 'ECCC GeoMet catalogue', gibs: 'NASA GIBS catalogue', fires: 'Fire detections (NASA FIRMS)', fireAreas: 'Fire areas (CWFIS)', tropical: 'Tropical storms (NHC)', cities: 'City names', wind: 'Wind grids', pressure: 'Pressure grids', gem: 'GEM point model', ecmwf: 'ECMWF point model', gfs: 'GFS point model' }[k] || k;
  const row = ([k, v]) => `<tr><td>${esc(label(k))}</td><td class="s"><span class="state"><span class="dot ${v.ok ? 'ok' : 'warn'}"></span>${v.ok ? 'OK' : 'Check'}</span></td><td>${v.name || v.id ? `<code>${esc(v.name || v.id)}</code>` : v.count != null ? esc(v.count.toLocaleString('en-CA')) : ''}${v.latest ? `<br><span class="muted">latest ${esc(fmtZ(Date.parse(v.latest)))}</span>` : ''}${v.error || v.warning || v.note ? `<br><span class="muted">${esc(v.error || v.warning || v.note)}</span>` : ''}</td></tr>`;
  $('#statusBody').innerHTML = `
    <p>Last check: <strong>${esc(fmtLocal(Date.parse(st.generated)))}</strong> (${age} min ago). ${bad ? `${bad === 1 ? '1 item needs' : bad + ' items need'} a look.` : 'Everything answered.'}</p>
    <table class="status"><thead><tr><th>Feed</th><th>Status</th><th>Detail</th></tr></thead><tbody>
      ${Object.entries(st.sources).map(row).join('')}${Object.entries(st.layers).map(row).join('')}${Object.entries(st.models).map(row).join('')}
    </tbody></table>`;
}

// ---------- wiring ----------
function wire() {
  $('#rail').addEventListener('click', onRailClick);
  document.querySelectorAll('[data-base]').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
  const setRail = (open) => {
    $('#rail').classList.toggle('open', open); $('#railToggle').setAttribute('aria-expanded', String(open));
    store.set('railOpen', open);
  };
  $('#railToggle').addEventListener('click', () => setRail(!$('#rail').classList.contains('open')));
  if (store.get('railOpen', false) && matchMedia('(min-width: 761px)').matches) setRail(true);
  $('#quick').addEventListener('click', (e) => { const b = e.target.closest('[data-quick]'); if (b) toggleOverlay(b.dataset.quick); });
  $('#legend').addEventListener('click', (e) => {
    if (!e.target.closest('.legend-head')) return;
    S.legendCollapsed = !S.legendCollapsed; store.set('legendCollapsed', S.legendCollapsed); renderLegend(); renderChips();
  });
  $('#aboutLink').addEventListener('click', () => $('#aboutDlg').showModal());
  // Keep map controls, legend and panels clear of the floating time bar.
  const tb = $('#timebar');
  const setTb = () => document.documentElement.style.setProperty('--tb-h', `${Math.ceil(tb.getBoundingClientRect().height)}px`);
  setTb();
  if ('ResizeObserver' in window) new ResizeObserver(setTb).observe(tb); else addEventListener('resize', setTb);
  $('#timeSlider').addEventListener('input', (e) => { togglePlay(false); S.offset = Math.max(-PAST, Math.min(FUT, round10(toOff(Number(e.target.value))))); applyTime(); });
  $('#timebar').addEventListener('click', (e) => { const b = e.target.closest('[data-jump]'); if (b) { togglePlay(false); setOffset(Number(b.dataset.jump)); } });
  $('#stepBack').addEventListener('click', () => { togglePlay(false); step(-1); });
  $('#stepFwd').addEventListener('click', () => { togglePlay(false); step(1); });
  $('#playBtn').addEventListener('click', () => togglePlay());
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerBody').addEventListener('click', onDrawerClick);
  $('#hazardBtn').addEventListener('click', openHazards);
  map.on('click', (e) => {
    if (matchMedia('(max-width: 760px)').matches && $('#rail').classList.contains('open')) { setRail(false); return; }
    openPoint(e.latlng);
  });
  map.on('zoomend', () => { updateStations(); renderQuick(); });
  map.on('moveend', () => { if (S.overlays.has('alerts')) loadStatements(); });
  map.on('moveend', () => { store.set('center', [map.getCenter().lat, map.getCenter().lng]); store.set('zoom', map.getZoom()); });
  let st;
  $('#searchInput').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => onSearch(e.target.value), 280); });
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); onSearch($('#searchInput').value); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('#searchResults').hidden = true; });
  $('#locateBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((p) => {
      const ll = L.latLng(p.coords.latitude, p.coords.longitude);
      map.setView(ll, 8, { animate: !reduceMotion }); openPoint(ll);
    }, () => { $('#searchInput').placeholder = 'Location blocked. Search instead.'; });
  });
  $('#statusBtn').addEventListener('click', () => { renderStatus(); $('#statusDlg').showModal(); });
  $('#aboutBtn').addEventListener('click', () => $('#aboutDlg').showModal());
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input')) return;
    if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Escape') closeDrawer();
  });
}

async function refresh() {
  const atNow = S.offset === 0;
  S.now = Date.now();
  const names = (c) => JSON.stringify(Object.fromEntries(Object.entries(c?.layers || {}).map(([k, v]) => [k, v?.names])));
  const before = names(S.catalog);
  try { S.catalog = await getJson('data/catalog.json'); } catch { /* keep last */ }
  try { S.status = await getJson('data/status.json'); } catch { /* keep last */ }
  if (names(S.catalog) !== before) resetLayers();
  const windRun = S.wind.index?.generated, presRun = S.pres.index?.generated;
  await Promise.all([loadWindIndex(), loadPresIndex()]);
  if (S.wind.index?.generated !== windRun) { S.wind.cache.clear(); S.wind.time = null; }
  if (S.pres.index?.generated !== presRun) { S.pres.cache.clear(); S.pres.time = null; }
  await Promise.all([loadMetar(), loadTropical(), S.hz.fires.data ? loadFires() : null, S.hz.areas.data ? loadAreas() : null]);
  S.taf = null;
  if (stationLayer) { map.removeLayer(stationLayer); stationLayer = null; }
  if (atNow) S.offset = 0;
  renderRail(); renderStatus(); updateStations(); applyTime(true);
}

(async function init() {
  await loadCore();
  setBase(S.base in bases ? S.base : 'osm');
  await Promise.all([loadWindIndex(), loadPresIndex()]);
  renderRail(); renderTicks(); wire(); renderStatus(); renderQuick();
  applyTime(true);
  loadAlertList(); loadTropical();
  await loadMetar();
  renderRail(); updateStations();
  setInterval(refresh, 10 * MIN);
  // Screenshot runs (Snapshot workflow) drive the page through this handle.
  if (new URLSearchParams(location.search).has('snap')) window.__we = { S, map, openPoint, openHazards, openStorm, openAlert };
  setInterval(() => { loadAlertList(true).then(() => { renderChips(); if (S.drawer === 'hazards') renderHazards(); }); if (S.overlays.has('alerts')) loadAlertShapes(true).then(syncAlerts); }, ALERT_REFRESH);
})();
