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

// Forecast hours to publish: one step back, then every 3 h to +48 h, then every 6 h
// to +120 h. Aligned to the model's own 3-hourly steps from the run time, so the
// particles always show the same hour as the GDPS colour layers.
export function targetTimes(ext, now = Date.now()) {
  const h = 3600e3, step = 3 * h;
  const base = ext.start + Math.floor((now - ext.start) / step) * step;
  const want = [base - step];
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

export const P_OFFSET = 1000, P_SCALE = 10; // stored Int16 = (hPa − 1000) × 10, −32768 = no data

export function encodePressure(hpa) {
  const out = Buffer.alloc(hpa.length * 2);
  for (let i = 0; i < hpa.length; i++) {
    const x = hpa[i];
    out.writeInt16LE(Number.isFinite(x) && x > 800 && x < 1100 ? Math.round((x - P_OFFSET) * P_SCALE) : -32768, i * 2);
  }
  return out;
}

// GeoMet may serve MSL pressure in Pa or hPa: normalise to hPa from the grid's median.
export function toHpa(values) {
  const sample = [];
  for (let i = 0; i < values.length; i += 97) if (Number.isFinite(values[i])) sample.push(values[i]);
  sample.sort((a, b) => a - b);
  const med = sample[Math.floor(sample.length / 2)] ?? 0;
  const f = med > 20000 ? 0.01 : 1;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i] * f;
  return out;
}

// Wind (speed + direction) and sea-level pressure for the same forecast hours.
export async function buildWind({ caps, outDir, pagesUrl, ua, log, status }) {
  const speedL = caps?.find((l) => l.name === 'GDPS_15km_WindSpeed_10m');
  const dirL = caps?.find((l) => l.name === 'GDPS_15km_WindDir_10m');
  const presL = caps?.find((l) => l.name === 'GDPS_15km_Pressure_MSL')
    || caps?.find((l) => /^GDPS_15km_/.test(l.name) && /pressure|MSL/i.test(`${l.name} ${l.title}`) && /MSL|sea level/i.test(`${l.name} ${l.title}`) && !/contour|tendency|anom/i.test(l.name));
  if (!speedL || !dirL || !speedL.dims.time) throw new Error('GDPS 10 m wind layers not found in GeoMet catalogue');
  const ext = parseExtent(speedL.dims.time.value);
  // Model run: reference_time if published, else the first forecast hour (= run time).
  const reference = speedL.dims.reference_time?.default || iso(ext.start);
  const times = targetTimes(ext);

  const prevIndex = async (name) => {
    if (!pagesUrl) return null;
    try { const r = await fetch(`${pagesUrl}/data/${name}/index.json`, { signal: AbortSignal.timeout(20000) }); return r.ok ? await r.json() : null; } catch { return null; }
  };
  const prevW = await prevIndex('wind'), prevP = await prevIndex('pressure');
  const reuseW = prevW && prevW.reference === reference && prevW.nx ? prevW : null;
  const reuseP = prevP && prevP.reference === reference && prevP.nx ? prevP : null;
  const copy = async (product, prev, t, dest) => {
    const f = prev?.files?.[iso(t)];
    if (!f) return false;
    try {
      const r = await fetch(`${pagesUrl}/data/${product}/${f}`, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) return false;
      await writeFile(dest, Buffer.from(await r.arrayBuffer()));
      return true;
    } catch { return false; }
  };

  const wcs = async (id, t) => {
    const url = `https://geo.weather.gc.ca/geomet?service=WCS&version=2.0.1&request=GetCoverage&CoverageId=${id}&format=image/tiff&subsettingcrs=EPSG:4326&outputcrs=EPSG:4326&subset=x(-180,180)&subset=y(-90,90)&resolution=x(1)&resolution=y(1)&TIME=${iso(t)}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(90000) });
      const b = Buffer.from(await r.arrayBuffer());
      if (r.status === 429) { await sleep(12000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${id}`);
      const t2 = readTiff(b);
      await sleep(PACE_MS);
      return t2;
    }
    throw new Error(`ECCC kept rate-limiting ${id}`);
  };

  const wDir = path.join(outDir, 'wind'), pDir = path.join(outDir, 'pressure');
  await mkdir(wDir, { recursive: true }); await mkdir(pDir, { recursive: true });
  let meta = reuseW ? { nx: reuseW.nx, ny: reuseW.ny, lo1: reuseW.lo1, la1: reuseW.la1, dx: reuseW.dx, dy: reuseW.dy } : null;
  const setMeta = (t) => { if (!meta) { const dx = 360 / t.width, dy = 180 / t.height; meta = { nx: t.width, ny: t.height, lo1: -180 + dx / 2, la1: 90 - dy / 2, dx, dy }; } };
  const wFiles = {}, pFiles = {};
  const n = { wFetched: 0, wCopied: 0, pFetched: 0, pCopied: 0 };
  let flip = false, pErr = null;

  for (const t of times) {
    const name = fileFor(t);
    // wind
    if (await copy('wind', reuseW, t, path.join(wDir, name))) { wFiles[iso(t)] = name; n.wCopied++; }
    else {
      const sp = await wcs(speedL.name, t);
      const dr = await wcs(dirL.name, t);
      setMeta(sp);
      const { u, v } = toUV(sp.bands[0], dr.bands[0]);
      if (n.wFetched === 0 && westerlyCheck(u, meta.nx, meta.la1, meta.dy) < 0) flip = true; // direction is "towards", not "from"
      if (flip) for (let i = 0; i < u.length; i++) { u[i] = -u[i]; v[i] = -v[i]; }
      await writeFile(path.join(wDir, name), encode(u, v));
      wFiles[iso(t)] = name; n.wFetched++;
    }
    // pressure (optional: wind still publishes if this fails)
    if (!presL || pErr) continue;
    if (await copy('pressure', reuseP, t, path.join(pDir, name))) { pFiles[iso(t)] = name; n.pCopied++; continue; }
    try {
      const pr = await wcs(presL.name, t);
      setMeta(pr);
      await writeFile(path.join(pDir, name), encodePressure(toHpa(pr.bands[0])));
      pFiles[iso(t)] = name; n.pFetched++;
    } catch (e) { pErr = String(e.message || e); }
  }

  const common = { generated: new Date().toISOString(), model: 'GDPS', reference, ...meta };
  const wIndex = { ...common, source: 'ECCC MSC GeoMet (GDPS 10 m wind)', scale: SCALE, times: Object.keys(wFiles), files: wFiles };
  await writeFile(path.join(wDir, 'index.json'), JSON.stringify(wIndex));
  status.sources.wind = { ok: true, count: wIndex.times.length, note: `${n.wFetched} hours from ECCC, ${n.wCopied} reused${flip ? ', direction flipped by check' : ''}`, latest: wIndex.times.at(-1) };

  if (presL && Object.keys(pFiles).length) {
    const pIndex = { ...common, source: `ECCC MSC GeoMet (${presL.name})`, units: 'hPa', offset: P_OFFSET, scale: P_SCALE, times: Object.keys(pFiles), files: pFiles };
    await writeFile(path.join(pDir, 'index.json'), JSON.stringify(pIndex));
    status.sources.pressure = { ok: !pErr, count: pIndex.times.length, name: presL.name, note: `${n.pFetched} hours from ECCC, ${n.pCopied} reused`, ...(pErr ? { error: pErr } : {}), latest: pIndex.times.at(-1) };
  } else {
    status.sources.pressure = { ok: false, error: presL ? (pErr || 'no pressure hours written') : 'GDPS sea-level pressure layer not found' };
  }
  log(`Wind: ${wIndex.times.length} hours (${n.wFetched} fetched, ${n.wCopied} reused); pressure: ${Object.keys(pFiles).length} hours (${n.pFetched} fetched); run ${reference}`);
  return wIndex;
}

// If ECCC can't be reached this run, republish the last good files so the map stays up.
export async function copyPrevious({ outDir, pagesUrl, status }) {
  if (!pagesUrl) return false;
  let any = false;
  for (const product of ['wind', 'pressure']) {
    try {
      const dir = path.join(outDir, product);
      await mkdir(dir, { recursive: true });
      const r = await fetch(`${pagesUrl}/data/${product}/index.json`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const prev = await r.json();
      for (const name of Object.values(prev.files || {})) {
        const f = await fetch(`${pagesUrl}/data/${product}/${name}`, { signal: AbortSignal.timeout(30000) });
        if (f.ok) await writeFile(path.join(dir, name), Buffer.from(await f.arrayBuffer()));
      }
      await writeFile(path.join(dir, 'index.json'), JSON.stringify({ ...prev, stale: true }));
      if (status.sources[product]) status.sources[product].stale = true;
      any = true;
    } catch { /* keep going */ }
  }
  return any;
}
