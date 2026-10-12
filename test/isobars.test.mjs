import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolines, smooth, pressureCentres, buildIsobars } from '../site/js/isobars.js';

// Synthetic global 1° grid: a 980 hPa low near 45N 60W, a 1035 hPa high near 35N 30W.
function field(nx = 360, ny = 180) {
  const p = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const lat = 89.5 - j, lon = -179.5 + i;
      const d1 = ((lat - 45) ** 2 + ((lon + 60) * Math.cos(0.785)) ** 2) / 120;
      const d2 = ((lat - 35) ** 2 + ((lon + 30) * Math.cos(0.61)) ** 2) / 150;
      p[j * nx + i] = 1013 - 33 * Math.exp(-d1) + 22 * Math.exp(-d2);
    }
  }
  return { nx, ny, lo1: -179.5, la1: 89.5, dx: 1, dy: 1, p };
}

test('closed isobar around a low is one continuous ring', () => {
  const g = field();
  const lines = isolines(g.p, g.nx, g.ny, 992);
  assert.equal(lines.length, 1);
  const ring = lines[0];
  assert.ok(ring.length > 20);
  assert.ok(Math.hypot(ring[0][0] - ring.at(-1)[0], ring[0][1] - ring.at(-1)[1]) < 1e-9, 'ring closes on itself');
  // every point on the contour interpolates to the level
  const lon = -179.5 + ring[5][0], lat = 89.5 - ring[5][1];
  assert.ok(lon > -90 && lon < -30 && lat > 25 && lat < 65);
});

test('a line crossing the dateline is split, not drawn across the map', () => {
  const nx = 8, ny = 4;
  const v = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = j < 2 ? 1000 : 1010; // zonal band
  const lines = isolines(v, nx, ny, 1005);
  for (const l of lines) for (let k = 1; k < l.length; k++) assert.ok(Math.abs(l[k][0] - l[k - 1][0]) <= nx / 2);
  const xs = lines.flat().map((p) => p[0]);
  assert.ok(Math.max(...xs) >= nx - 1 && Math.min(...xs) <= 0, 'covers the full circle');
});

test('no-data cells are skipped', () => {
  const v = new Float32Array([1000, NaN, 1010, 1000, 1010, 1010, 1000, 1010, 1010]);
  assert.doesNotThrow(() => isolines(v, 3, 3, 1005, false));
});

test('smoothing keeps endpoints of open lines and closure of rings', () => {
  const open = smooth([[0, 0], [1, 1], [2, 0]]);
  assert.deepEqual(open[0], [0, 0]); assert.deepEqual(open.at(-1), [2, 0]);
  const ring = smooth([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  assert.deepEqual(ring[0], ring.at(-1));
});

test('finds the high and the low, nothing else', () => {
  const c = pressureCentres(field());
  const H = c.filter((x) => x.type === 'H'), Lo = c.filter((x) => x.type === 'L');
  assert.equal(H.length, 1); assert.equal(Lo.length, 1);
  assert.ok(Math.abs(Lo[0].lat - 45) <= 1 && Math.abs(Lo[0].lon + 60) <= 1 && Lo[0].value < 981);
  assert.ok(Math.abs(H[0].lat - 35) <= 1 && Math.abs(H[0].lon + 30) <= 1 && H[0].value > 1034);
});

test('buildIsobars: 4 hPa levels with labels', () => {
  const r = buildIsobars(field());
  const levels = [...new Set(r.lines.map((l) => l.level))].sort((a, b) => a - b);
  assert.ok(levels.every((x) => x % 4 === 0));
  assert.equal(levels[0], 984); assert.equal(levels.at(-1), 1032);
  assert.ok(r.labels.length >= levels.length - 2);
  assert.equal(r.centres.length, 2);
});
