// Frame-rate check of the live site (run by the Snapshot workflow with views=perf).
// Chromium with a phone-sized screen and 4x CPU slowdown approximates a phone; the
// numbers are for before/after comparison, not absolute phone performance.
import { chromium } from 'playwright';
import { appendFile, mkdir } from 'node:fs/promises';

const site = process.env.SITE_URL;
await mkdir('shots', { recursive: true });
const out = [];
const browser = await chromium.launch();
const BASE = ['wind', 'isobars', 'cities', 'alerts', 'tropical', 'radar'];
const runs = [
  { name: 'phone-default', phone: true, overlays: BASE },
  { name: 'phone-no-wind', phone: true, overlays: BASE.filter((o) => o !== 'wind') },
  { name: 'phone-wind-only', phone: true, overlays: ['wind'] },
  { name: 'desktop-default', phone: false, overlays: BASE },
];

const measure = (ms) => new Promise((resolve) => {
  const iv = []; let last = performance.now(); let long = 0;
  let po = null;
  try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long += e.duration; }); po.observe({ type: 'longtask', buffered: false }); } catch { /* not supported */ }
  const end = last + ms;
  const f = (now) => { iv.push(now - last); last = now; if (now < end) requestAnimationFrame(f); else { po?.disconnect(); done(); } };
  requestAnimationFrame(f);
  function done() {
    const s = [...iv].sort((a, b) => a - b);
    const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
    resolve({ fps: Math.round(1000 / avg), p95: Math.round(s[Math.floor(s.length * 0.95)]), max: Math.round(s[s.length - 1]), over50: iv.filter((x) => x > 50).length, longtaskMs: Math.round(long) });
  }
});

for (const r of runs) {
  const ctx = await browser.newContext(r.phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((o) => {
    localStorage.setItem('we:main', '"temp"');
    localStorage.setItem('we:center', '[44.9,-63.5]');
    localStorage.setItem('we:zoom', '6');
    localStorage.setItem('we:overlays', JSON.stringify(o));
    for (const k of ['windAdded', 'v3defaults', 'v4defaults']) localStorage.setItem(`we:${k}`, 'true');
  }, r.overlays);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.push(`[${r.name}] pageerror: ${e.message}`));
  if (r.phone) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
  await page.goto(`${site}?snap=${Date.now()}`, { waitUntil: 'load', timeout: 45000 }).catch((e) => out.push(`[${r.name}] goto ${e.message}`));
  await page.waitForTimeout(12000);
  const idle = await page.evaluate(measure, 5000);
  // pan: drag across the map for about a second, measuring frames during and just after
  const pan = page.evaluate(measure, 2500);
  await page.mouse.move(200, 400);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) { await page.mouse.move(200 - i * 6, 400 - i * 3); await page.waitForTimeout(40); }
  await page.mouse.up();
  const panR = await pan;
  // time step: wind/isobars swap to the next hour
  const stepP = page.evaluate(measure, 2500);
  await page.evaluate(() => document.querySelector('#stepFwd').click());
  const stepR = await stepP;
  const fmt = (m) => `${m.fps} fps, p95 ${m.p95} ms, max ${m.max} ms, frames>50ms ${m.over50}, long tasks ${m.longtaskMs} ms`;
  out.push(`[${r.name}] idle: ${fmt(idle)}`, `[${r.name}] pan:  ${fmt(panR)}`, `[${r.name}] step: ${fmt(stepR)}`);
  await page.screenshot({ path: `shots/perf-${r.name}.png` });
  await ctx.close();
}
await browser.close();
console.log(out.join('\n'));
await appendFile('shots/perf.txt', out.join('\n') + '\n');
