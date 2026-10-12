// Hazards: ECCC weather alerts (read live), fire detections and fire areas,
// tropical storms. Pure helpers are exported for tests; layer factories take Leaflet.

export const ALERTS_API = 'https://api.weather.gc.ca/collections/weather-alerts/items';
export const CWFIS_WFS = 'https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wfs';
export const LIST_PROPS = [
  'alert_name_en', 'alert_type', 'alert_code', 'risk_colour_en', 'status_en', 'feature_name_en', 'province',
  'publication_datetime', 'expiration_datetime', 'event_end_datetime', 'impact_en', 'confidence_en',
].join(',');

// ECCC wording (canada.ca/weather-alerts and the colour-coded alerts pages).
export const RISK = {
  red: { label: 'Red', fill: '#e0282e', line: '#7a0d10', ink: '#ffffff', rank: 3, meaning: 'Very dangerous and possibly life-threatening weather, will cause extreme damage and disruption. Red alerts are rare.' },
  orange: { label: 'Orange', fill: '#ff8a00', line: '#8a3d00', ink: '#16110a', rank: 2, meaning: 'Severe weather is likely to cause significant damage, disruption, or health impacts. Orange alerts are uncommon.' },
  yellow: { label: 'Yellow', fill: '#f7d117', line: '#7d6300', ink: '#16130a', rank: 1, meaning: 'Hazardous weather may cause damage, disruption, or health impacts. Yellow alerts are the most common.' },
  none: { label: 'No colour', fill: '#9aa7b4', line: '#4f5d6a', ink: '#0d1218', rank: 0, meaning: 'Special weather statements carry no colour. They are information only, not an alert.' },
};
export const TYPE = {
  warning: { label: 'Warning', rank: 3, meaning: 'Act now to protect yourself from severe weather. Severe weather is either happening or will happen.' },
  watch: { label: 'Watch', rank: 2, meaning: 'Get ready to protect yourself from potential severe weather. Conditions are favourable for it to develop.' },
  advisory: { label: 'Advisory', rank: 1, meaning: 'Act now to protect yourself from significant weather: less severe than a warning, but still significant.' },
  statement: { label: 'Special weather statement', rank: 0, meaning: 'Information only. Not an alert.' },
};
export const PROVINCES = {
  NL: 'Newfoundland and Labrador', PE: 'Prince Edward Island', NS: 'Nova Scotia', NB: 'New Brunswick', QC: 'Quebec', ON: 'Ontario',
  MB: 'Manitoba', SK: 'Saskatchewan', AB: 'Alberta', BC: 'British Columbia', YT: 'Yukon', NT: 'Northwest Territories', NU: 'Nunavut',
};

export const riskOf = (p) => (RISK[String(p?.risk_colour_en || '').toLowerCase()] ? String(p.risk_colour_en).toLowerCase() : 'none');
export const typeOf = (p) => (TYPE[String(p?.alert_type || '').toLowerCase()] ? String(p.alert_type).toLowerCase() : 'statement');
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

export function isActive(p, now = Date.now()) {
  if (!p) return false;
  if (String(p.status_en || '').toLowerCase() === 'ended') return false;
  const exp = Date.parse(p.expiration_datetime || '');
  return !(Number.isFinite(exp) && exp < now);
}

// One entry per alert: same type, name, colour and province. Regions are listed.
export function groupAlerts(features, now = Date.now()) {
  const groups = new Map();
  for (const f of features || []) {
    const p = f.properties || {};
    if (!isActive(p, now)) continue;
    const type = typeOf(p), risk = riskOf(p);
    const name = cap(p.alert_name_en || TYPE[type].label);
    const key = [type, name.toLowerCase(), risk, p.province || ''].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { key, type, risk, name, province: p.province || '', regions: [], ids: [], issued: null, expires: null, impact: p.impact_en || null, confidence: p.confidence_en || null };
      groups.set(key, g);
    }
    if (f.id != null && !g.ids.includes(f.id)) g.ids.push(f.id);
    if (p.feature_name_en && !g.regions.includes(p.feature_name_en)) g.regions.push(p.feature_name_en);
    if (p.publication_datetime && (!g.issued || p.publication_datetime > g.issued)) g.issued = p.publication_datetime;
    if (p.expiration_datetime && (!g.expires || p.expiration_datetime > g.expires)) g.expires = p.expiration_datetime;
    if (!g.text && p.alert_text_en) g.text = p.alert_text_en;
  }
  return [...groups.values()].sort((a, b) => RISK[b.risk].rank - RISK[a.risk].rank || TYPE[b.type].rank - TYPE[a.type].rank
    || String(b.issued).localeCompare(String(a.issued)) || a.name.localeCompare(b.name));
}

// ---------- geometry ----------
function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// polys: array of polygons, each [outer, ...holes], rings of [lon, lat].
export function inPolys(polys, lon, lat) {
  for (const poly of polys || []) {
    if (!poly?.[0] || !inRing(poly[0], lon, lat)) continue;
    if (!poly.slice(1).some((h) => inRing(h, lon, lat))) return true;
  }
  return false;
}
export function polysOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
export const inGeom = (geom, lon, lat) => inPolys(polysOf(geom), lon, lat);

// ---------- fires ----------
const mercY = (lat) => {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export function decodeFires(meta, buf) {
  const n = meta.count;
  const d = {
    n, grid: meta.grid, generated: Date.parse(meta.generated),
    gy: new Int16Array(buf, 0, n), gx: new Int16Array(buf, 2 * n, n),
    frp: new Uint16Array(buf, 4 * n, n), age: new Uint16Array(buf, 6 * n, n),
    cnt: new Uint8Array(buf, 8 * n, n), fl: new Uint8Array(buf, 9 * n, n),
    px: new Float32Array(n), py: new Float32Array(n), // Web Mercator, 0..1
  };
  for (let i = 0; i < n; i++) {
    d.px[i] = (d.gx[i] / d.grid + 180) / 360;
    d.py[i] = mercY(d.gy[i] / d.grid);
  }
  return d;
}
export const fireLat = (d, i) => d.gy[i] / d.grid;
export const fireLon = (d, i) => d.gx[i] / d.grid;
// Minutes between the detection and `now`.
export const fireAgeMin = (d, i, now = Date.now()) => d.age[i] + Math.max(0, (now - d.generated) / 60000);
export const FIRE_AGES = [
  { max: 6 * 60, color: '#ff2a12', label: 'under 6 h' },
  { max: 12 * 60, color: '#ff8c1a', label: '6 to 12 h' },
  { max: Infinity, color: '#ffd04d', label: '12 to 24 h' },
];
export const fireBucket = (ageMin) => FIRE_AGES.findIndex((b) => ageMin < b.max);
export const SATS = [[4, 'Suomi NPP'], [8, 'NOAA-20'], [16, 'NOAA-21']];

export function createFireLayer(L) {
  return L.Layer.extend({
    options: { pane: 'hazardPane' },
    initialize(opts) { L.setOptions(this, opts); this._d = null; },
    setData(d) { this._d = d; this._draw(); },
    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'fire-canvas');
      this._canvas.setAttribute('aria-hidden', 'true');
      map.getPane(this.options.pane).appendChild(this._canvas);
      this._hide = () => { this._canvas.style.visibility = 'hidden'; };
      map.on('zoomstart', this._hide);
      map.on('moveend zoomend resize', this._draw, this);
      this._draw();
    },
    onRemove(map) {
      map.off('zoomstart', this._hide);
      map.off('moveend zoomend resize', this._draw, this);
      this._canvas.remove();
      this._map = null;
    },
    _radius(z) { return z <= 3 ? 1.7 : z <= 5 ? 2.3 : z <= 7 ? 3.2 : 4.2; },
    _draw() {
      const map = this._map; if (!map) return;
      const size = map.getSize(), dpr = Math.min(window.devicePixelRatio || 1, 2), c = this._canvas;
      c.width = Math.round(size.x * dpr); c.height = Math.round(size.y * dpr);
      c.style.width = `${size.x}px`; c.style.height = `${size.y}px`;
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      c.style.visibility = '';
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const d = this._d; if (!d) return;
      const z = map.getZoom(), scale = 256 * 2 ** z, o = map.getPixelBounds().min;
      const r = this._radius(z), now = Date.now();
      const paths = FIRE_AGES.map(() => new Path2D());
      const pad = 8;
      for (let i = 0; i < d.n; i++) {
        const y = d.py[i] * scale - o.y;
        if (y < -pad || y > size.y + pad) continue;
        let x = d.px[i] * scale - o.x;
        x -= Math.floor((x + pad) / scale) * scale; // leftmost world copy on screen
        const b = fireBucket(fireAgeMin(d, i, now));
        const rr = r + (z >= 6 ? Math.min(2.5, Math.log10(1 + d.frp[i] / 10) * 1.2) : 0);
        for (; x < size.x + pad; x += scale) {
          if (x < -pad) continue;
          paths[b].moveTo(x + rr, y);
          paths[b].arc(x, y, rr, 0, 2 * Math.PI);
        }
      }
      ctx.lineWidth = z <= 4 ? 0.8 : 1.2;
      ctx.strokeStyle = 'rgb(40 8 0 / .85)';
      for (let b = FIRE_AGES.length - 1; b >= 0; b--) { // newest on top
        ctx.fillStyle = FIRE_AGES[b].color;
        ctx.fill(paths[b]); ctx.stroke(paths[b]);
      }
    },
    // Detections within `px` screen pixels of a container point, nearest first.
    hits(pt, px = 12) {
      const map = this._map, d = this._d; if (!map || !d) return [];
      const scale = 256 * 2 ** map.getZoom(), o = map.getPixelBounds().min;
      const out = [];
      for (let i = 0; i < d.n; i++) {
        const y = d.py[i] * scale - o.y; if (Math.abs(y - pt.y) > px) continue;
        let x = d.px[i] * scale - o.x;
        x -= Math.round((x - pt.x) / scale) * scale;
        const dist = Math.hypot(x - pt.x, y - pt.y);
        if (dist <= px) out.push({ i, dist });
      }
      return out.sort((a, b) => a.dist - b.dist);
    },
  });
}

export function summariseFires(d, idx, now = Date.now()) {
  if (!idx.length) return null;
  let n = 0, frp = 0, newest = Infinity, high = false, night = false, sats = 0;
  for (const i of idx) {
    n += d.cnt[i]; frp = Math.max(frp, d.frp[i] / 10);
    const a = fireAgeMin(d, i, now);
    if (a < newest) { newest = a; night = !!(d.fl[i] & 2); }
    if (d.fl[i] & 1) high = true;
    sats |= d.fl[i];
  }
  return { cells: idx.length, detections: n, frp, newestMin: newest, high, night, satellites: SATS.filter(([bit]) => sats & bit).map(([, name]) => name) };
}

// ---------- tropical ----------
export function stormCat(kt) {
  if (kt == null) return { code: '?', label: 'Unknown strength', color: '#cfd8e0' };
  if (kt < 34) return { code: 'TD', label: 'Tropical depression', color: '#5ebaff' };
  if (kt < 64) return { code: 'TS', label: 'Tropical storm', color: '#00e0d8' };
  if (kt < 83) return { code: '1', label: 'Category 1', color: '#ffffcc' };
  if (kt < 96) return { code: '2', label: 'Category 2', color: '#ffe775' };
  if (kt < 113) return { code: '3', label: 'Category 3', color: '#ffc140' };
  if (kt < 137) return { code: '4', label: 'Category 4', color: '#ff8f20' };
  return { code: '5', label: 'Category 5', color: '#ff6060' };
}
export const ktToKmh = (kt) => (kt == null ? null : Math.round(kt * 1.852));
const toLL = (ring) => ring.map(([x, y]) => [y, x]);

export function buildTropicalLayer(L, storms, opts = {}) {
  const pane = opts.pane || 'hazardPane';
  const g = L.layerGroup();
  for (const s of storms || []) {
    for (const poly of s.cone || []) {
      L.polygon(poly.map(toLL), { pane, interactive: false, color: '#ffffff', weight: 1.6, opacity: 0.95, fillColor: '#ffffff', fillOpacity: 0.22 }).addTo(g);
    }
    for (const line of s.past || []) L.polyline(toLL(line), { pane, interactive: false, color: '#3b4652', weight: 2, opacity: 0.8 }).addTo(g);
    for (const line of s.track || []) {
      L.polyline(toLL(line), { pane, interactive: false, color: '#ffffff', weight: 4.5, opacity: 0.9 }).addTo(g);
      L.polyline(toLL(line), { pane, interactive: false, color: '#0d1218', weight: 2, opacity: 0.95 }).addTo(g);
    }
    for (const p of s.points || []) {
      if (p.tau === 0) continue;
      const c = stormCat(p.kt);
      L.marker([p.lat, p.lon], {
        pane, interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'tc-pt', iconSize: [0, 0], html: `<div style="background:${c.color}">${c.code === 'TD' ? 'D' : c.code === 'TS' ? 'S' : c.code}</div>` }),
      }).addTo(g);
    }
    if (s.lat != null && s.lon != null) {
      const c = stormCat(s.kt);
      L.marker([s.lat, s.lon], {
        pane, interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'tc-now', iconSize: [0, 0], html: `<div><b style="background:${c.color}">${c.code === 'TD' ? 'D' : c.code === 'TS' ? 'S' : c.code}</b><span>${String(s.name || '').replace(/[<>&"]/g, '')}</span></div>` }),
      }).addTo(g);
    }
  }
  return g;
}

export function buildAreaLayer(L, areas, opts = {}) {
  const pane = opts.pane || 'hazardPane';
  const g = L.layerGroup();
  for (const a of areas || []) {
    L.polygon(a.polys.map((poly) => poly.map(toLL)), { pane, interactive: false, color: '#c2410c', weight: 2, opacity: 0.95, fillColor: '#ff6a2b', fillOpacity: 0.22 }).addTo(g);
  }
  return g;
}

// Storms whose cone contains the point, or whose position or forecast points are
// within `px` pixels (project: [lat, lon] -> container point).
export function stormsAt(storms, lat, lon, pt, project, px = 22) {
  return (storms || []).filter((s) => {
    if ((s.cone || []).some((poly) => inPolys([poly], lon, lat))) return true;
    const pts = [[s.lat, s.lon], ...(s.points || []).map((p) => [p.lat, p.lon])].filter(([a, b]) => a != null && b != null);
    return pts.some((ll) => { const q = project(ll); return Math.hypot(q.x - pt.x, q.y - pt.y) <= px; });
  });
}

// FBP fuel types (Canadian Forest Fire Behavior Prediction System).
export const FUELS = {
  C1: 'Spruce-lichen woodland', C2: 'Boreal spruce', C3: 'Mature jack or lodgepole pine', C4: 'Immature jack or lodgepole pine',
  C5: 'Red and white pine', C6: 'Conifer plantation', C7: 'Ponderosa pine and Douglas-fir', D1: 'Leafless aspen', D2: 'Green aspen',
  M1: 'Boreal mixedwood, leafless', M2: 'Boreal mixedwood, green', M3: 'Dead balsam fir mixedwood, leafless', M4: 'Dead balsam fir mixedwood, green',
  S1: 'Jack or lodgepole pine slash', S2: 'White spruce and balsam slash', S3: 'Coastal cedar, hemlock and Douglas-fir slash',
  O1a: 'Matted grass', O1b: 'Standing grass', NF: 'Non-fuel', WA: 'Water',
};
