// Isobars and pressure centres from a global sea-level pressure grid (ECCC GDPS).
// Contours every 4 hPa (standard surface-analysis interval), traced with marching
// squares, joined into continuous lines, lightly smoothed. Highs and lows are the
// local extremes that stand out from their surroundings.

export const INTERVAL = 4;

export function decodePressure(meta, buf) {
  const n = meta.nx * meta.ny;
  const dv = new DataView(buf);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = dv.getInt16(i * 2, true);
    p[i] = x === -32768 ? NaN : meta.offset + x / meta.scale;
  }
  return { ...meta, p };
}

// Isolines of `values` (row-major, row 0 = north) at `level`, in grid coordinates [x, y].
// With wrap, the east edge joins the west edge (global longitude grid).
export function isolines(values, nx, ny, level, wrap = true) {
  const W = wrap ? nx : nx - 1;
  const val = (i, j) => values[j * nx + (i % nx)];
  const keyH = (i, j) => `h${j}:${i % nx}`;          // edge between (i,j) and (i+1,j)
  const keyV = (i, j) => `v${j}:${i % nx}`;          // edge between (i,j) and (i,j+1)
  const ptH = (i, j) => { const a = val(i, j), b = val(i + 1, j); return [i + (level - a) / (b - a), j]; };
  const ptV = (i, j) => { const a = val(i, j), b = val(i, j + 1); return [i, j + (level - a) / (b - a)]; };
  const segs = [];
  const add = (e1, e2) => segs.push([e1[0], e1[1], e2[0], e2[1]]);
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < W; i++) {
      const a = val(i, j), b = val(i + 1, j), c = val(i + 1, j + 1), d = val(i, j + 1);
      if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) continue;
      const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = () => [keyH(i, j), ptH(i, j)];
      const B = () => [keyH(i, j + 1), ptH(i, j + 1)];
      const Lf = () => [keyV(i, j), ptV(i, j)];
      const R = () => [keyV(i + 1, j), ptV(i + 1, j)];
      const centreAbove = (a + b + c + d) / 4 > level;
      switch (idx) {
        case 1: case 14: add(Lf(), B()); break;
        case 2: case 13: add(B(), R()); break;
        case 3: case 12: add(Lf(), R()); break;
        case 4: case 11: add(T(), R()); break;
        case 6: case 9: add(T(), B()); break;
        case 7: case 8: add(Lf(), T()); break;
        case 5: if (centreAbove) { add(Lf(), T()); add(B(), R()); } else { add(T(), R()); add(Lf(), B()); } break;
        case 10: if (centreAbove) { add(T(), R()); add(Lf(), B()); } else { add(Lf(), T()); add(B(), R()); } break;
        default: break;
      }
    }
  }
  // Join segments that share an edge into continuous lines.
  const byKey = new Map();
  segs.forEach((s, k) => { for (const key of [s[0], s[2]]) { const l = byKey.get(key); if (l) l.push(k); else byKey.set(key, [k]); } });
  const used = new Uint8Array(segs.length);
  const next = (key) => (byKey.get(key) || []).find((k) => !used[k]);
  const lines = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const line = [segs[s][1], segs[s][3]];
    for (const [endKey, push] of [[segs[s][2], (p) => line.push(p)], [segs[s][0], (p) => line.unshift(p)]]) {
      let key = endKey, k;
      while ((k = next(key)) !== undefined) {
        used[k] = 1;
        const sg = segs[k];
        const [otherKey, otherPt] = sg[0] === key ? [sg[2], sg[3]] : [sg[0], sg[1]];
        push(otherPt);
        key = otherKey;
      }
    }
    lines.push(line);
  }
  // Split where a line crosses the wrap seam (x jumps from ~nx back to ~0).
  const out = [];
  for (const line of lines) {
    let cur = [line[0]];
    for (let k = 1; k < line.length; k++) {
      if (Math.abs(line[k][0] - line[k - 1][0]) > nx / 2) { if (cur.length > 1) out.push(cur); cur = []; }
      cur.push(line[k]);
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

// Chaikin corner cutting: rounder lines without moving them noticeably.
export function smooth(line, passes = 2) {
  let pts = line;
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) return pts;
    const closed = pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1];
    const out = closed ? [] : [pts[0]];
    for (let k = 0; k < pts.length - 1; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    if (closed) out.push(out[0]); else out.push(pts.at(-1));
    pts = out;
  }
  return pts;
}

// Highs and lows: grid points that are the extreme within `radius` cells and stand
// at least `minDiff` hPa above/below the mean of that window. Polar rows are skipped.
export function pressureCentres(g, radius = 8, minDiff = 4) {
  const { nx, ny, p } = g;
  const found = [];
  for (let j = radius; j < ny - radius; j++) {
    const lat = g.la1 - j * g.dy;
    if (Math.abs(lat) > 78) continue;
    for (let i = 0; i < nx; i++) {
      const v = p[j * nx + i];
      if (!Number.isFinite(v)) continue;
      let isMax = true, isMin = true, sum = 0, n = 0;
      for (let dj = -radius; dj <= radius && (isMax || isMin); dj++) {
        for (let di = -radius; di <= radius; di++) {
          if (!di && !dj) continue;
          const w = p[(j + dj) * nx + ((i + di + nx) % nx)];
          if (!Number.isFinite(w)) continue;
          if (w >= v) isMax = false;
          if (w <= v) isMin = false;
          sum += w; n++;
        }
      }
      if (!n) continue;
      const mean = sum / n;
      if (isMax && v - mean >= minDiff) found.push({ type: 'H', lat, lon: g.lo1 + i * g.dx, value: v });
      if (isMin && mean - v >= minDiff) found.push({ type: 'L', lat, lon: g.lo1 + i * g.dx, value: v });
    }
  }
  return found;
}

// Everything the map layer needs for one forecast hour.
export function buildIsobars(g, interval = INTERVAL) {
  let lo = Infinity, hi = -Infinity;
  for (const v of g.p) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const lines = [], labels = [];
  for (let level = Math.ceil(lo / interval) * interval; level <= hi; level += interval) {
    for (const raw of isolines(g.p, g.nx, g.ny, level)) {
      if (raw.length < 4) continue; // drop specks
      const pts = smooth(raw);
      const latlngs = pts.map(([x, y]) => [g.la1 - y * g.dy, g.lo1 + x * g.dx]);
      lines.push({ level, latlngs });
      if (raw.length >= 10) {
        const every = Math.max(60, Math.floor(latlngs.length / 3));
        for (let k = Math.floor(Math.min(every, latlngs.length) / 2); k < latlngs.length; k += every) labels.push({ latlng: latlngs[k], text: String(level) });
      }
    }
  }
  return { lines, labels, centres: pressureCentres(g) };
}

export function createIsobarLayer(L) {
  return L.Layer.extend({
    options: { pane: 'isobarPane', maxLabels: 60 },
    initialize(opts) { L.setOptions(this, opts); this._data = null; },
    setData(data) { this._data = data; if (this._map) { this._drawLines(); this._drawLabels(); } },
    onAdd(map) {
      this._map = map;
      this._lines = L.layerGroup().addTo(map);
      this._labels = L.layerGroup().addTo(map);
      this._renderer = L.canvas({ pane: this.options.pane, padding: 0.5 });
      map.on('moveend', this._drawLabels, this);
      this._drawLines(); this._drawLabels();
    },
    onRemove(map) {
      map.off('moveend', this._drawLabels, this);
      this._lines.remove(); this._labels.remove(); this._map = null;
    },
    _drawLines() {
      const g = this._lines, d = this._data;
      if (!g) return;
      g.clearLayers();
      if (!d) return;
      const renderer = this._renderer, pane = this.options.pane;
      for (const ln of d.lines) {
        // light halo under a dark line: readable on both pale and dark colour layers
        L.polyline(ln.latlngs, { renderer, pane, color: '#ffffff', weight: 3.4, opacity: 0.55, interactive: false, smoothFactor: 1.2 }).addTo(g);
        L.polyline(ln.latlngs, { renderer, pane, color: '#121a22', weight: ln.level === 1012 ? 1.8 : 1.2, opacity: 0.9, interactive: false, smoothFactor: 1.2 }).addTo(g);
      }
    },
    // Label every isobar that is on screen (middle of its visible stretch), skip overlaps.
    _drawLabels() {
      const map = this._map, g = this._labels, d = this._data;
      if (!map || !g) return;
      g.clearLayers();
      if (!d) return;
      const pane = this.options.pane;
      const view = map.getBounds().pad(-0.06);
      const size = map.getSize();
      const placed = [];
      const fits = (pt, w, h) => {
        const box = [pt.x - w / 2, pt.y - h / 2, pt.x + w / 2, pt.y + h / 2];
        if (box[0] < 0 || box[1] < 0 || box[2] > size.x || box[3] > size.y) return false;
        if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) return false;
        placed.push(box); return true;
      };
      const onScreen = (ll) => {
        for (const shift of [0, 360, -360]) { const p = L.latLng(ll[0], ll[1] + shift); if (view.contains(p)) return p; }
        return null;
      };
      // centres first so line labels avoid them
      for (const c of d.centres) {
        const p = onScreen([c.lat, c.lon]);
        if (!p || !fits(map.latLngToContainerPoint(p), 44, 44)) continue;
        L.marker(p, { pane, interactive: false, keyboard: false, icon: L.divIcon({ className: `pcentre pc-${c.type}`, html: `<div><b>${c.type}</b><span>${Math.round(c.value)}</span></div>`, iconSize: null }) }).addTo(g);
      }
      let count = 0;
      for (const ln of d.lines) {
        let run = [];
        const flush = () => {
          if (run.length >= 3 && count < this.options.maxLabels) {
            const p = run[Math.floor(run.length / 2)];
            if (fits(map.latLngToContainerPoint(p), 38, 18)) {
              L.marker(p, { pane, interactive: false, keyboard: false, icon: L.divIcon({ className: 'isobar-label', html: `<span>${ln.level}</span>`, iconSize: null }) }).addTo(g);
              count++;
            }
          }
          run = [];
        };
        for (const ll of ln.latlngs) { const p = onScreen(ll); if (p) run.push(p); else flush(); }
        flush();
      }
    },
  });
}
