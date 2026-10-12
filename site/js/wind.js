// Animated wind particles on a canvas over the map.
// Data: a global regular lat/lon grid of u/v (m/s), produced by the scheduled job
// from ECCC GDPS 10 m wind. Particles move at a constant on-screen speed per m/s,
// so the picture reads the same at every zoom.
//
// Performance notes (phones draw 2D canvas on the CPU):
// - Trails are redrawn every frame from each particle's last few positions, so
//   nothing builds up on the canvas (fading by over-painting leaves a grainy residue).
//   Each particle's trail is one short polyline per opacity band, with flat ends:
//   far fewer path pieces than one segment per step.
// - Motion is sub-stepped and trail points are taken at fixed intervals of motion
//   time, so trails keep the same length and stay smooth curves at any frame rate
//   (slow phones no longer get long, jagged, broken-looking trails).
// - Particle state lives in typed arrays; the frame loop allocates nothing.
// - Panning keeps the particles (shifted to the new view) and a new forecast hour
//   only swaps the flow field, so nothing jumps or blinks. Only a zoom respawns them.
// - If frames run slow (measured away from pans, zooms and page loading), the particle
//   count steps down, to no less than 45 % of full density, and stays down for the visit.
const C = {
  speed: 0.11,     // screen px per 60 Hz frame for 1 m/s
  maxAge: 110,     // frames (at 60 Hz) before a particle respawns
  trail: 8,        // trail points kept per particle
  step: 3,         // frames of motion (at 60 Hz) between trail points
  cell: 6,         // screen-grid cell size for the precomputed field
  bands: [0.16, 0.42, 0.85], // trail opacity, oldest to newest
  density: 500,    // screen px² per particle
  maxParts: 2600,
  minParts: 200,
  floor: 0.45,     // lowest share of full density the slow-frame check may go to
  maxDpr: 2,
  width: 1.35,
};

export function createWindLayer(L) {
  return L.Layer.extend({
    options: { pane: 'windPane' },

    initialize(opts) { L.setOptions(this, opts); this._grid = null; this._q = 1; this._n = 0; this._quietAt = 0; },

    // New forecast hour: swap the flow field under the existing particles.
    setGrid(grid) {
      this._grid = grid;
      if (!this._map) return;
      if (this._field && this._parts && !this.options.still) { this._buildField(); this._start(); }
      else this._reset();
    },

    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'wind-canvas');
      this._canvas.setAttribute('aria-hidden', 'true');
      map.getPane(this.options.pane).appendChild(this._canvas);
      this._onZoomStart = () => { this._zooming = true; this._stop(true); };
      this._onMoveStart = () => { this._quietAt = Infinity; };
      this._onMoveEnd = () => this._moved();
      this._onResize = () => this._reset();
      map.on('zoomstart', this._onZoomStart);
      map.on('movestart', this._onMoveStart);
      map.on('moveend', this._onMoveEnd);
      map.on('resize', this._onResize);
      this._onVis = () => (document.hidden ? this._stop(false) : this._start());
      document.addEventListener('visibilitychange', this._onVis);
      this._reset();
    },

    onRemove(map) {
      this._stop(true);
      map.off('zoomstart', this._onZoomStart);
      map.off('movestart', this._onMoveStart);
      map.off('moveend', this._onMoveEnd);
      map.off('resize', this._onResize);
      document.removeEventListener('visibilitychange', this._onVis);
      this._canvas.remove();
      this._map = null;
    },

    _stop(clear) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
      if (clear && this._ctx) this._ctx.clearRect(0, 0, this._w || 0, this._h || 0);
    },

    // After a pan, keep every particle where it is on the map: shift it into the
    // re-anchored canvas. After a zoom, start fresh.
    _moved() {
      const map = this._map; if (!map) return;
      this._quietAt = performance.now() + 1500;
      const origin = map.containerPointToLayerPoint([0, 0]);
      if (this._zooming || !this._parts || map.getZoom() !== this._zoom || !this._origin) { this._zooming = false; this._reset(); return; }
      const dx = this._origin.x - origin.x, dy = this._origin.y - origin.y;
      if (dx || dy) {
        const { px, py, hx, hy } = this._parts;
        for (let i = 0; i < px.length; i++) { px[i] += dx; py[i] += dy; }
        for (let i = 0; i < hx.length; i++) { hx[i] += dx; hy[i] += dy; }
      }
      this._origin = origin;
      L.DomUtil.setPosition(this._canvas, origin);
      if (this._grid) this._buildField();
      this._start();
    },

    _reset() {
      if (!this._map) return;
      this._stop(true);
      const map = this._map, size = map.getSize();
      const dpr = Math.min(window.devicePixelRatio || 1, C.maxDpr);
      const c = this._canvas;
      c.width = Math.round(size.x * dpr); c.height = Math.round(size.y * dpr);
      c.style.width = `${size.x}px`; c.style.height = `${size.y}px`;
      this._origin = map.containerPointToLayerPoint([0, 0]);
      this._zoom = map.getZoom();
      L.DomUtil.setPosition(c, this._origin);
      this._ctx = c.getContext('2d');
      this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._w = size.x; this._h = size.y;
      if (!this._grid) return;
      this._buildField();
      const max = Math.max(C.minParts, Math.min(C.maxParts, Math.round((size.x * size.y) / C.density)));
      this._max = max;
      this._n = Math.max(Math.min(max, C.minParts), Math.round(max * this._q));
      this._quietAt = Math.max(this._quietAt, performance.now() + 2500);
      const T = C.trail;
      this._parts = {
        px: new Float32Array(max), py: new Float32Array(max), age: new Float32Array(max),
        hx: new Float32Array(max * T), hy: new Float32Array(max * T), head: new Uint8Array(max), cnt: new Uint8Array(max),
      };
      for (let i = 0; i < max; i++) this._spawn(i, Math.random() * C.maxAge);
      if (!this.options.still) this._start();
      else this._drawStill();
    },

    // Precompute screen-space displacement per cell so each frame is a cheap lookup.
    // In Web Mercator, longitude depends only on x and latitude only on y.
    _buildField() {
      const g = this._grid, map = this._map, cs = C.cell;
      const cols = Math.ceil(this._w / cs) + 1, rows = Math.ceil(this._h / cs) + 1;
      const fx = new Float32Array(cols * rows), fy = new Float32Array(cols * rows), ok = new Uint8Array(cols * rows);
      const xs = new Float64Array(cols), ys = new Float64Array(rows);
      for (let i = 0; i < cols; i++) { const lon = map.containerPointToLatLng([i * cs, 0]).lng; xs[i] = ((((lon - g.lo1) % 360) + 360) % 360) / g.dx; }
      for (let j = 0; j < rows; j++) ys[j] = (g.la1 - map.containerPointToLatLng([0, j * cs]).lat) / g.dy;
      const { nx, ny, u, v } = g, sp = C.speed;
      for (let j = 0; j < rows; j++) {
        const y = ys[j];
        if (!(y >= 0 && y <= ny - 1)) continue;
        const y0 = Math.floor(y), y1 = Math.min(y0 + 1, ny - 1), wy = y - y0;
        const r0 = y0 * nx, r1 = y1 * nx;
        for (let i = 0; i < cols; i++) {
          const x = xs[i], x0 = Math.floor(x) % nx, x1 = (x0 + 1) % nx, wx = x - Math.floor(x);
          const a = (1 - wx) * (1 - wy), b = wx * (1 - wy), c = (1 - wx) * wy, d = wx * wy;
          const uu = u[r0 + x0] * a + u[r0 + x1] * b + u[r1 + x0] * c + u[r1 + x1] * d;
          const vv = v[r0 + x0] * a + v[r0 + x1] * b + v[r1 + x0] * c + v[r1 + x1] * d;
          if (uu === uu && vv === vv) { const k = j * cols + i; fx[k] = uu * sp; fy[k] = -vv * sp; ok[k] = 1; }
        }
      }
      this._field = { cols, rows, fx, fy, ok };
    },

    _spawn(i, age = 0) {
      const P = this._parts, T = C.trail;
      const x = Math.random() * this._w, y = Math.random() * this._h;
      P.px[i] = x; P.py[i] = y; P.age[i] = age;
      P.head[i] = 0; P.cnt[i] = 1; P.hx[i * T] = x; P.hy[i * T] = y; // fresh trail: no line back to the old spot
    },

    _start() {
      if (this._raf || !this._field || !this._parts || document.hidden || this.options.still) return;
      const ctx = this._ctx, T = C.trail, bands = C.bands, nb = bands.length;
      const styles = bands.map((a) => `rgba(255,255,255,${a})`);
      let last = performance.now(), acc = 0, frames = 0, simT = 0;
      const frame = (now) => {
        this._raf = requestAnimationFrame(frame);
        // slow-frame check over ~1 s windows, only while the map is still and settled
        if (now > this._quietAt) {
          acc += now - last; frames++;
          if (frames >= 60) {
            const floor = Math.round(this._max * C.floor);
            if (acc / frames > 24 && this._n > floor) { this._n = Math.max(floor, Math.round(this._n * 0.85)); this._q = this._n / this._max; }
            acc = 0; frames = 0;
          }
        } else { acc = 0; frames = 0; }
        const dt = Math.min(3, Math.max(0.25, (now - last) / 16.667));
        last = now;
        const f = this._field, P = this._parts, n = this._n, w = this._w, h = this._h, cs = C.cell, maxAge = C.maxAge, STEP = C.step;
        const { px, py, age, hx, hy, head, cnt } = P;
        const steps = Math.ceil(dt), sdt = dt / steps;
        for (let st = 0; st < steps; st++) {
          simT += sdt;
          const push = simT >= STEP;
          if (push) simT -= STEP;
          for (let i = 0; i < n; i++) {
            const x = px[i], y = py[i];
            const ci = Math.round(x / cs), cj = Math.round(y / cs);
            const k = cj * f.cols + ci;
            age[i] += sdt;
            if (ci < 0 || cj < 0 || ci >= f.cols || cj >= f.rows || !f.ok[k] || age[i] > maxAge) { this._spawn(i); continue; }
            const nx = x + f.fx[k] * sdt, ny = y + f.fy[k] * sdt;
            if (nx < 0 || ny < 0 || nx > w || ny > h) { this._spawn(i); continue; }
            px[i] = nx; py[i] = ny;
            if (push) { const hd = (head[i] + 1) % T; head[i] = hd; hx[i * T + hd] = nx; hy[i * T + hd] = ny; if (cnt[i] < T) cnt[i]++; }
          }
        }
        // draw: clear, then one stroke per opacity band (oldest part of each trail faintest).
        // A trail is its stored points, oldest first, then the particle's current position.
        ctx.clearRect(0, 0, w, h);
        ctx.lineWidth = C.width; ctx.lineCap = 'butt'; ctx.lineJoin = 'bevel';
        for (let b = 0; b < nb; b++) {
          ctx.strokeStyle = styles[b];
          ctx.beginPath();
          for (let i = 0; i < n; i++) {
            const c = cnt[i], segs = c;
            const k0 = Math.floor((b * segs) / nb), k1 = Math.floor(((b + 1) * segs) / nb);
            if (k1 <= k0) continue;
            const base = i * T, first = head[i] - (c - 1) + T;
            for (let k = k0; k <= k1; k++) {
              let x, y;
              if (k < c) { const q = base + ((first + k) % T); x = hx[q]; y = hy[q]; } else { x = px[i]; y = py[i]; }
              if (k === k0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
          }
          ctx.stroke();
        }
      };
      this._raf = requestAnimationFrame(frame);
    },

    // Reduced motion: short static streaks instead of animation.
    _drawStill() {
      const ctx = this._ctx, f = this._field, cs = C.cell, P = this._parts;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < Math.min(1500, this._n); i++) {
        let x = P.px[i], y = P.py[i];
        ctx.moveTo(x, y);
        for (let s = 0; s < 8; s++) {
          const ci = Math.round(x / cs), cj = Math.round(y / cs), k = cj * f.cols + ci;
          if (ci < 0 || cj < 0 || ci >= f.cols || cj >= f.rows || !f.ok[k]) break;
          x += f.fx[k] * 2; y += f.fy[k] * 2; ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    },
  });
}

// Bilinear sample of the grid at lat/lon → [u, v] in m/s, or null outside data.
export function sample(g, lat, lon) {
  const x = ((((lon - g.lo1) % 360) + 360) % 360) / g.dx;
  const y = (g.la1 - lat) / g.dy;
  if (y < 0 || y > g.ny - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = (x0 + 1) % g.nx, y1 = Math.min(y0 + 1, g.ny - 1);
  const fx = x - x0, fy = y - y0;
  const at = (a, i, j) => a[j * g.nx + (i % g.nx)];
  const lerp = (a) => {
    const v00 = at(a, x0, y0), v10 = at(a, x1, y0), v01 = at(a, x0, y1), v11 = at(a, x1, y1);
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  };
  const u = lerp(g.u), v = lerp(g.v);
  return Number.isFinite(u) && Number.isFinite(v) ? [u, v] : null;
}

// Grid files: Int8 pairs (u then v, each nx*ny), value = m/s * scale.
export function decodeGrid(meta, buf) {
  const n = meta.nx * meta.ny;
  const a = new Int8Array(buf);
  const u = new Float32Array(n), v = new Float32Array(n);
  const s = 1 / meta.scale;
  for (let i = 0; i < n; i++) {
    u[i] = a[i] === -128 ? NaN : a[i] * s;
    v[i] = a[n + i] === -128 ? NaN : a[n + i] * s;
  }
  return { ...meta, u, v };
}
