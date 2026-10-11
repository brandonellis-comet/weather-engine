// Animated wind particles on a canvas over the map.
// Data: a global regular lat/lon grid of u/v (m/s), produced by the scheduled job
// from ECCC GDPS 10 m wind. Particles move at a constant on-screen speed per m/s,
// so the picture reads the same at every zoom.

const SPEED = 0.11;          // screen px per frame for 1 m/s
const MAX_AGE = 90;          // frames before a particle respawns
const FADE = 0.93;           // trail persistence per frame
const CELL = 5;              // screen-grid cell size for the precomputed field

export function createWindLayer(L) {
  return L.Layer.extend({
    options: { pane: 'windPane' },

    initialize(opts) { L.setOptions(this, opts); this._grid = null; },

    setGrid(grid) {
      this._grid = grid;
      if (this._map) this._reset();
    },

    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'wind-canvas');
      this._canvas.setAttribute('aria-hidden', 'true');
      map.getPane(this.options.pane).appendChild(this._canvas);
      this._onMoveStart = () => this._stop(true);
      this._onMoveEnd = () => this._reset();
      map.on('movestart zoomstart', this._onMoveStart);
      map.on('moveend zoomend resize', this._onMoveEnd);
      this._onVis = () => (document.hidden ? this._stop(false) : this._start());
      document.addEventListener('visibilitychange', this._onVis);
      this._reset();
    },

    onRemove(map) {
      this._stop(true);
      map.off('movestart zoomstart', this._onMoveStart);
      map.off('moveend zoomend resize', this._onMoveEnd);
      document.removeEventListener('visibilitychange', this._onVis);
      this._canvas.remove();
      this._map = null;
    },

    _stop(clear) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
      if (clear && this._ctx) this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    },

    _reset() {
      if (!this._map) return;
      this._stop(true);
      const map = this._map;
      const size = map.getSize();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const c = this._canvas;
      c.width = Math.round(size.x * dpr); c.height = Math.round(size.y * dpr);
      c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      this._ctx = c.getContext('2d');
      this._ctx.scale(dpr, dpr);
      this._w = size.x; this._h = size.y;
      if (!this._grid) return;
      this._buildField();
      const n = Math.min(4000, Math.round((size.x * size.y) / 380));
      this._parts = Array.from({ length: n }, () => this._spawn({}));
      if (!this.options.still) this._start();
      else this._drawStill();
    },

    // Precompute screen-space displacement per CELL so each frame is a cheap lookup.
    _buildField() {
      const g = this._grid, map = this._map;
      const cols = Math.ceil(this._w / CELL) + 1, rows = Math.ceil(this._h / CELL) + 1;
      const fx = new Float32Array(cols * rows), fy = new Float32Array(cols * rows), ok = new Uint8Array(cols * rows);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const ll = map.containerPointToLatLng([i * CELL, j * CELL]);
          const v = sample(g, ll.lat, ll.lng);
          const k = j * cols + i;
          if (v) { fx[k] = v[0] * SPEED; fy[k] = -v[1] * SPEED; ok[k] = 1; }
        }
      }
      this._field = { cols, rows, fx, fy, ok };
    },

    _vec(x, y) {
      const f = this._field;
      const i = Math.round(x / CELL), j = Math.round(y / CELL);
      if (i < 0 || j < 0 || i >= f.cols || j >= f.rows) return null;
      const k = j * f.cols + i;
      return f.ok[k] ? [f.fx[k], f.fy[k]] : null;
    },

    _spawn(p) {
      p.x = Math.random() * this._w; p.y = Math.random() * this._h;
      p.age = Math.floor(Math.random() * MAX_AGE);
      return p;
    },

    _start() {
      if (this._raf || !this._field || document.hidden) return;
      const ctx = this._ctx;
      const frame = () => {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.fillStyle = `rgba(0,0,0,${FADE})`;
        ctx.fillRect(0, 0, this._w, this._h);
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = 'rgba(255,255,255,0.82)';
        ctx.beginPath();
        for (const p of this._parts) {
          const v = this._vec(p.x, p.y);
          if (!v || ++p.age > MAX_AGE) { this._spawn(p); p.age = 0; continue; }
          const nx = p.x + v[0], ny = p.y + v[1];
          ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny);
          p.x = nx; p.y = ny;
          if (nx < 0 || ny < 0 || nx > this._w || ny > this._h) this._spawn(p);
        }
        ctx.stroke();
        this._raf = requestAnimationFrame(frame);
      };
      this._raf = requestAnimationFrame(frame);
    },

    // Reduced motion: short static streaks instead of animation.
    _drawStill() {
      const ctx = this._ctx;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const p of this._parts.slice(0, 1500)) {
        let { x, y } = p;
        ctx.moveTo(x, y);
        for (let s = 0; s < 8; s++) { const v = this._vec(x, y); if (!v) break; x += v[0] * 2; y += v[1] * 2; ctx.lineTo(x, y); }
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
