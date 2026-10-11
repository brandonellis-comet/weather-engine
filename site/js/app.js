// Weather Engine — map, time sync, point forecast, METAR/TAF.
import { parseMetar, parseTaf, metarToPlain, tafToPlain, tafRawLines } from './decoder.js';
import { parseExtent, snapTime, isoForWms, fmtZ } from './timeext.js';

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
};

// ---------- map ----------
const map = L.map('map', { zoomControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 12, preferCanvas: true })
  .setView(store.get('center', [45.6, -63.2]), store.get('zoom', 5));
L.control.zoom({ position: 'topright' }).addTo(map);
for (const [name, z] of [['mainPane', 300], ['overlayPane2', 350], ['labelPane', 380], ['stationPane', 450]]) {
  map.createPane(name).style.zIndex = z;
}
map.getPane('labelPane').style.pointerEvents = 'none';
map.getPane('mainPane').style.pointerEvents = 'none';
map.getPane('overlayPane2').style.pointerEvents = 'none';

const bases = {
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }),
  relief: L.tileLayer.wms('https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi', { layers: 'BlueMarble_ShadedRelief_Bathymetry', format: 'image/jpeg', version: '1.3.0', tileSize: 512, attribution: 'NASA GIBS' }),
};
const live = new Map(); // layer id -> Leaflet layer
let stationLayer = null;

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
  if (!store.get('overlays', null)) { S.config.layers.filter((l) => l.default).forEach((l) => S.overlays.add(l.id)); S.overlays.add('stations'); }
  if (!S.config.layers.some((l) => l.id === S.main && l.group === 'main')) S.main = 'temp';
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
    if (t >= S.now - 5 * MIN || !ext) return { show: true, param: null, label: ext ? 'latest' : 'latest (no time sync)' };
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
  const s = snapTime(ext, t, 'nearest');
  const outside = t < ext.start - 3 * 3600e3 || t > ext.end + 3 * 3600e3;
  return { show: true, param: isoForWms(s, ext.dateOnly), label: `valid ${fmtZ(s)}${outside ? ' (nearest)' : ''}`, ms: s, warn: outside };
}

const selectedTime = () => S.now + S.offset * MIN;

function stepMinutes(dir) {
  if (S.offset + dir * 10 <= 0 && S.offset <= 0) return 10;
  const def = defOf(S.main); const e = entryOf(S.main);
  const ext = e?.time ? parseExtent(e.time.extent) : null;
  const period = ext?.ranges?.[0]?.period;
  return kindOf(def, e) === 'model' && period ? Math.max(60, period / MIN) : 60;
}

// ---------- layers ----------
function makeWms(def) {
  const e = entryOf(def.id);
  const src = S.config.sources[e?.source || def.source];
  const names = e?.names || (def.combine ? def.candidates : [def.candidates[0]]);
  const pane = def.group === 'main' ? 'mainPane' : def.id === 'labels' ? 'labelPane' : 'overlayPane2';
  return L.tileLayer.wms(src.wms, {
    layers: names.join(','), styles: '', format: 'image/png', transparent: true, version: '1.3.0',
    tileSize: 512, pane, opacity: def.group === 'main' ? 0.78 : 0.92,
    attribution: src.label, bounds: [[-85, -180], [85, 180]], noWrap: false,
  });
}

let paramTimer = null;
function applyTime(immediate = false) {
  updateReadout();
  clearTimeout(paramTimer);
  const run = () => { syncLayers(); renderChips(); };
  if (immediate) run(); else { renderChips(); paramTimer = setTimeout(run, 220); }
}

function activeIds() {
  return [S.main, ...[...S.overlays].filter((id) => id !== 'stations')];
}

function syncLayers() {
  const t = selectedTime();
  const want = new Set();
  for (const id of activeIds()) {
    const def = defOf(id); if (!def || !available(def)) continue;
    const r = resolveTime(def, entryOf(id), t);
    if (!r.show) continue;
    want.add(id);
    let lyr = live.get(id);
    if (!lyr) { lyr = makeWms(def); live.set(id, lyr); }
    const p = r.param || undefined;
    if (lyr.wmsParams.time !== p) {
      if (p) lyr.setParams({ time: p }, false); else { delete lyr.wmsParams.time; lyr.redraw(); }
    }
    if (!map.hasLayer(lyr)) lyr.addTo(map);
  }
  for (const [id, lyr] of live) if (!want.has(id) && map.hasLayer(lyr)) map.removeLayer(lyr);
  renderLegend();
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
  $('#chips').innerHTML = html;
}

function renderLegend() {
  const def = defOf(S.main); const e = entryOf(S.main); const el = $('#legend');
  if (!def) { el.hidden = true; return; }
  const src = S.config.sources[e?.source || def.source];
  const name = (e?.names || [def.candidates[0]])[0];
  const img = src.legend && name
    ? `<img alt="Colour scale for ${esc(def.label)}" onerror="this.remove()" src="${esc(`${src.wms}?service=WMS&version=1.3.0&request=GetLegendGraphic&sld_version=1.1.0&format=image/png&layer=${encodeURIComponent(name)}`)}">`
    : '';
  el.innerHTML = `<b>${esc(def.label)}</b><div>${esc(e?.model || def.model || src.label)} · ${esc(def.coverage || '')}</div>${img}${e?.note ? `<div class="legend-note">${esc(e.note)}</div>` : ''}`;
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
  const stationsDef = { id: 'stations', label: 'METAR stations', coverage: S.metar ? `${S.metar.stations.length.toLocaleString('en-CA')} stations, worldwide` : 'loading…' };
  $('#overlayList').innerHTML = [...S.config.layers.filter((l) => l.group === 'overlay'), stationsDef].map((d) => item(d, 'check')).join('');
  document.querySelectorAll('[data-base]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.base === S.base)));
}

function onRailClick(ev) {
  const b = ev.target.closest('.layer'); if (!b || b.getAttribute('aria-disabled') === 'true') return;
  const id = b.dataset.id;
  if (b.dataset.role === 'radio') { S.main = id; store.set('main', id); }
  else { S.overlays.has(id) ? S.overlays.delete(id) : S.overlays.add(id); store.set('overlays', [...S.overlays]); }
  renderRail(); updateStations(); applyTime(true);
}

function setBase(id) {
  S.base = id; store.set('base', id);
  for (const [k, l] of Object.entries(bases)) { if (k === id) l.addTo(map); else map.removeLayer(l); }
  renderRail();
}

// ---------- stations ----------
function updateStations() {
  const want = S.overlays.has('stations') && S.metar && map.getZoom() >= 4;
  if (!want) { if (stationLayer) map.removeLayer(stationLayer); return; }
  if (!stationLayer) {
    const renderer = L.canvas({ pane: 'stationPane', padding: 0.3 });
    stationLayer = L.layerGroup(S.metar.stations.map((s) => {
      const m = L.circleMarker([s[1], s[2]], { renderer, radius: 4, weight: 1.5, color: '#0e151c', fillColor: '#e7eef4', fillOpacity: 0.95, pane: 'stationPane' });
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
function closeDrawer() { $('#drawer').hidden = true; S.point = null; }

async function openStation(id) {
  const s = S.stationIndex.get(id);
  if (!s) return;
  map.setView([s[1], s[2]], Math.max(map.getZoom(), 7), { animate: !reduceMotion });
  await openPoint(L.latLng(s[1], s[2]), { station: s, dist: 0 });
}

async function openPoint(latlng, near) {
  const lat = Math.round(latlng.lat * 1000) / 1000;
  const lon = Math.round(L.Util.wrapNum(latlng.lng, [-180, 180], true) * 1000) / 1000;
  S.point = { lat, lon };
  near = near || nearestStation(lat, lon);
  const coord = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  openDrawer(near?.d === 0 ? `${near.s[0]}` : 'Point forecast', near?.d === 0 ? `${near.s[3] || 'Station'} · ${coord}` : coord);
  const body = $('#drawerBody');
  body.innerHTML = `<section id="stnSec"></section><section id="fcSec"><p class="loading">Loading forecasts from GEM, ECMWF and GFS…</p></section>`;
  if (near) renderStation(near); else $('#stnSec').remove();
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
  const label = (k) => defOf(k)?.label || { metar: 'METAR', taf: 'TAF', stations: 'Station names', geomet: 'ECCC GeoMet catalogue', gibs: 'NASA GIBS catalogue', gem: 'GEM point model', ecmwf: 'ECMWF point model', gfs: 'GFS point model' }[k] || k;
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
  $('#railToggle').addEventListener('click', () => {
    const open = !$('#rail').classList.contains('open');
    $('#rail').classList.toggle('open', open); $('#railToggle').setAttribute('aria-expanded', String(open));
  });
  $('#timeSlider').addEventListener('input', (e) => { togglePlay(false); S.offset = Math.max(-PAST, Math.min(FUT, round10(toOff(Number(e.target.value))))); applyTime(); });
  $('#jumps').addEventListener('click', (e) => { const b = e.target.closest('[data-jump]'); if (b) { togglePlay(false); setOffset(Number(b.dataset.jump)); } });
  $('#stepBack').addEventListener('click', () => { togglePlay(false); step(-1); });
  $('#stepFwd').addEventListener('click', () => { togglePlay(false); step(1); });
  $('#playBtn').addEventListener('click', () => togglePlay());
  $('#drawerClose').addEventListener('click', closeDrawer);
  map.on('click', (e) => { $('#rail').classList.remove('open'); openPoint(e.latlng); });
  map.on('zoomend', updateStations);
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
  try { S.catalog = await getJson('data/catalog.json'); } catch { /* keep last */ }
  try { S.status = await getJson('data/status.json'); } catch { /* keep last */ }
  await loadMetar();
  S.taf = null;
  if (stationLayer) { map.removeLayer(stationLayer); stationLayer = null; }
  if (atNow) S.offset = 0;
  renderRail(); renderStatus(); updateStations(); applyTime(true);
}

(async function init() {
  await loadCore();
  setBase(S.base in bases ? S.base : 'osm');
  renderRail(); renderTicks(); wire(); renderStatus();
  applyTime(true);
  await loadMetar();
  renderRail(); updateStations();
  setInterval(refresh, 10 * MIN);
})();
