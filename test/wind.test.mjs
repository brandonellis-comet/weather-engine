import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUV, encode, westerlyCheck, targetTimes, SCALE } from '../scripts/wind.mjs';
import { decodeGrid, sample } from '../site/js/wind.js';
import { parseExtent } from '../site/js/timeext.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('direction is where the wind comes from', () => {
  const { u, v } = toUV(new Float32Array([10, 10, 10]), new Float32Array([270, 0, 225]));
  close(u[0], 10); close(v[0], 0, 1e-5);      // westerly blows toward the east
  close(u[1], 0, 1e-5); close(v[1], -10);     // northerly blows toward the south
  close(u[2], 7.0710678, 1e-5); close(v[2], 7.0710678, 1e-5); // southwesterly → NE
});

test('encode/decode round trip with no-data and clamping', () => {
  const u = new Float32Array([1.26, -3, NaN, 99]), v = new Float32Array([0, 2.74, 1, -99]);
  const buf = encode(u, v);
  const g = decodeGrid({ nx: 4, ny: 1, scale: SCALE }, new Uint8Array(buf).buffer);
  assert.deepEqual([...g.u].map((x) => (Number.isNaN(x) ? 'nan' : x)), [1.5, -3, 'nan', 63.5]);
  assert.deepEqual([...g.v], [0, 2.5, 1, -63.5]);
});

test('bilinear sample wraps across the dateline', () => {
  const g = { nx: 4, ny: 2, lo1: -135, la1: 45, dx: 90, dy: 90, u: new Float32Array([0, 10, 20, 30, 0, 10, 20, 30]), v: new Float32Array(8) };
  close(sample(g, 45, -90)[0], 5);
  close(sample(g, 45, 180)[0], 15);   // halfway between lon 135 (30) and −135 (0)
  assert.equal(sample(g, 80, 0), null); // north of the grid rows
});

test('westerly check is positive for eastward flow at mid-latitudes', () => {
  const nx = 2, la1 = 50, dy = 10; // rows at 50 and 40
  assert.ok(westerlyCheck(new Float32Array([5, 5, 5, 5]), nx, la1, dy) > 0);
  assert.ok(westerlyCheck(new Float32Array([-5, -5, -5, -5]), nx, la1, dy) < 0);
});

test('target hours: 3-hourly to 48 h, 6-hourly to 120 h, aligned to model steps', () => {
  const now = Date.parse('2026-10-11T23:20:00Z');
  const ext = parseExtent('2026-10-11T12:00:00Z/2026-10-21T12:00:00Z/PT1H');
  const t = targetTimes(ext, now).map((x) => new Date(x).toISOString().slice(5, 13));
  assert.equal(t[0], '10-11T18');
  assert.equal(t[1], '10-11T21');
  assert.equal(t[2], '10-12T00');   // same 3-hourly steps as the GDPS layers (run 12Z)
  assert.equal(t.at(-1), '10-16T21');
  assert.equal(t.length, 1 + 17 + 12);
});

import { encodePressure, toHpa, P_OFFSET, P_SCALE } from '../scripts/wind.mjs';
import { decodePressure } from '../site/js/isobars.js';

test('pressure: Pa or hPa normalised, encoded to Int16 and back', () => {
  const pa = new Float32Array(200).fill(101325);
  assert.ok(Math.abs(toHpa(pa)[0] - 1013.25) < 1e-3);
  const hpa = new Float32Array([1013.25, 987.4, NaN, 1049.96]);
  assert.ok(Math.abs(toHpa(hpa)[1] - 987.4) < 1e-4);
  const buf = encodePressure(hpa);
  const g = decodePressure({ nx: 4, ny: 1, offset: P_OFFSET, scale: P_SCALE }, new Uint8Array(buf).buffer);
  assert.deepEqual([...g.p].map((x) => (Number.isNaN(x) ? 'nan' : Math.round(x * 10) / 10)), [1013.3, 987.4, 'nan', 1050]);
});
