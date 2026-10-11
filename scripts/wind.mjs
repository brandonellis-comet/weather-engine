// Wind grids for the animated particles.
// Source: ECCC GDPS 10 m wind speed (m/s) and direction (degrees, direction the
// wind blows FROM), fetched as global 1° GeoTIFFs through MSC GeoMet WCS.
// Output: data/wind/index.json + one Int8 file per forecast hour (u block, then v block).
// Only new hours are fetched from ECCC; hours already published for the same model
// run are copied from the live site, so a normal run makes few or no ECCC requests.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readTiff } from './tiff.mjs';
import { parseExtent, snapTime } from '../site/js/timeext.js';

export const SCALE = 2;          // stored value = m/s * SCALE, Int8 (−128 = no data)
const PACE_MS = 2500;            // ECCC rate-limits rapid requests
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Meteorological convention: direction is where the wind comes FROM.
export function toUV(speed, dir) {
  const n = speed.length;
  const u = new Float32Array(n), v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = speed[i], d = (dir[i] * Math.PI) / 180;
    if (!Number.isFinite(s) || !Number.isFinite(dir[i]) || s < 0 || s > 200) { u[i] = NaN; v[i] = NaN; continue; }
    u[i] = -s * Math.sin(d);
    v[i] = -s * Math.cos(d);
  }
  return { u, v };
}

export function encode(u, v) {
  const n = u.length;
  const out = new Int8Array(2 * n);
  const q = (x) => (Number.isFinite(x) ? Math.max(-127, Math.min(127, Math.round(x * SCALE))) : -128);
  for (let i = 0; i < n; i++) { out[i] = q(u[i]); out[n + i] = q(v[i]); }
  return Buffer.from(out.buffer);
}

// Mean u between 35°N and 60°N: must be positive (prevailing westerlies). Guards the direction convention.
export function westerlyCheck(u, nx, la1, dy) {
  let s = 0, n = 0;
  for (let j = 0; j < u.length / nx; j++) {
    const lat = la1 - j * dy;
    if (lat < 35 || lat > 60) continue;
    for (let i = 0; i < nx; i++) { const x = u[j * nx + i]; if (Number.isFinite(x)) { s += x; n++; } }
  }
  return n ? s / n : 0;
}

// Forecast hours to publish: −3 h, then every 3 h to +48 h, then every 6 h to +120 h,
// snapped to hours the model actually has.
export function targetTimes(ext, now = Date.now()) {
  const h = 3600e3, base = Math.floor(now / h) * h;
  const want = [base - 3 * h];
  for (let k = 0; k <= 48; k += 3) want.push(base + k * h);
  for (let k = 54; k <= 120; k += 6) want.push(base + k * h);
  const out = new Set();
  for (const t of want) {
    if (t < ext.start - h || t > ext.end + h) continue;
    out.add(snapTime(ext, t, 'nearest'));
  }
  return [...out].sort((a, b) => a - b);
}

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const fileFor = (ms) => iso(ms).replace(/[-:]/g, '') + '.bin';

export async function buildWind({ caps, outDir, pagesUrl, ua, log, status }) {
  const dir = path.join(outDir, 'wind');
  await mkdir(dir, { recursive: true });
  const speedL = caps?.find((l) => l.name === 'GDPS_15km_WindSpeed_10m');
  const dirL = caps?.find((l) => l.name === 'GDPS_15km_WindDir_10m');
  if (!speedL || !dirL || !speedL.dims.time) throw new Error('GDPS 10 m wind layers not found in GeoMet catalogue');
  const ext = parseExtent(speedL.dims.time.value);
  // Model run: reference_time if published, else the first forecast hour (= run time).
  const reference = speedL.dims.reference_time?.default || new Date(ext.start).toISOString().replace('.000Z', 'Z');
  const times = targetTimes(ext);

  let prev = null;
  if (pagesUrl) {
    try { const r = await fetch(`${pagesUrl}/data/wind/index.json`, { signal: AbortSignal.timeout(20000) }); if (r.ok) prev = await r.json(); } catch { /* first run */ }
  }
  const sameRun = prev && prev.reference === reference && prev.nx;

  const wcs = async (id, t) => {
    const url = `https://geo.weather.gc.ca/geomet?service=WCS&version=2.0.1&request=GetCoverage&CoverageId=${id}&format=image/tiff&subsettingcrs=EPSG:4326&outputcrs=EPSG:4326&subset=x(-180,180)&subset=y(-90,90)&resolution=x(1)&resolution=y(1)&TIME=${iso(t)}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(90000) });
      const b = Buffer.from(await r.arrayBuffer());
      if (r.status === 429) { await sleep(12000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${id}`);
      return readTiff(b);
    }
    throw new Error(`ECCC kept rate-limiting ${id}`);
  };

  let meta = sameRun ? { nx: prev.nx, ny: prev.ny, lo1: prev.lo1, la1: prev.la1, dx: prev.dx, dy: prev.dy } : null;
  let fetched = 0, copied = 0, flip = false;
  const files = {};
  for (const t of times) {
    const name = fileFor(t);
    if (sameRun && prev.files?.[iso(t)]) {
      try {
        const r = await fetch(`${pagesUrl}/data/wind/${prev.files[iso(t)]}`, { signal: AbortSignal.timeout(30000) });
        if (r.ok) { await writeFile(path.join(dir, name), Buffer.from(await r.arrayBuffer())); files[iso(t)] = name; copied++; continue; }
      } catch { /* fall through to ECCC */ }
    }
    const sp = await wcs(speedL.name, t); await sleep(PACE_MS);
    const dr = await wcs(dirL.name, t); await sleep(PACE_MS);
    if (!meta) {
      const dx = 360 / sp.width, dy = 180 / sp.height;
      meta = { nx: sp.width, ny: sp.height, lo1: -180 + dx / 2, la1: 90 - dy / 2, dx, dy };
    }
    const { u, v } = toUV(sp.bands[0], dr.bands[0]);
    if (fetched === 0 && westerlyCheck(u, meta.nx, meta.la1, meta.dy) < 0) flip = true; // direction is "towards", not "from"
    if (flip) for (let i = 0; i < u.length; i++) { u[i] = -u[i]; v[i] = -v[i]; }
    await writeFile(path.join(dir, name), encode(u, v));
    files[iso(t)] = name;
    fetched++;
  }
  const index = { generated: new Date().toISOString(), model: 'GDPS', source: 'ECCC MSC GeoMet (GDPS 10 m wind)', reference, scale: SCALE, ...meta, times: Object.keys(files), files };
  await writeFile(path.join(dir, 'index.json'), JSON.stringify(index));
  status.sources.wind = { ok: true, count: index.times.length, note: `${fetched} hours from ECCC, ${copied} reused${flip ? ', direction flipped by check' : ''}`, latest: index.times[index.times.length - 1] };
  log(`Wind: ${index.times.length} hours (${fetched} fetched, ${copied} reused), run ${reference}`);
  return index;
}

// If ECCC can't be reached this run, republish the last good wind files so the animation stays up.
export async function copyPrevious({ outDir, pagesUrl, status }) {
  if (!pagesUrl) return false;
  const dir = path.join(outDir, 'wind');
  await mkdir(dir, { recursive: true });
  const r = await fetch(`${pagesUrl}/data/wind/index.json`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return false;
  const prev = await r.json();
  for (const name of Object.values(prev.files || {})) {
    const f = await fetch(`${pagesUrl}/data/wind/${name}`, { signal: AbortSignal.timeout(30000) });
    if (f.ok) await writeFile(path.join(dir, name), Buffer.from(await f.arrayBuffer()));
  }
  await writeFile(path.join(dir, 'index.json'), JSON.stringify({ ...prev, stale: true }));
  if (status.sources.wind) status.sources.wind.stale = true;
  return true;
}
