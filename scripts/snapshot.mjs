// Screenshots of the live site in a real browser (run on demand by the Snapshot workflow).
// Lets the build be checked visually with live ECCC/NASA data and the wind animation.
import { chromium, webkit, devices } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const site = process.env.SITE_URL;
const only = (process.env.VIEWS || '').split(',').filter(Boolean);
const log = [];
await mkdir('shots', { recursive: true });
const browsers = { chromium: await chromium.launch(), webkit: await webkit.launch() };

const iphone = devices['iPhone 13'];
const HZ = ['alerts', 'tropical', 'cities', 'isobars'];
const strongestFire = async (page) => page.evaluate(() => {
  const d = window.__we?.S.hz.fires.data; if (!d) return null;
  let best = -1, bi = -1;
  for (let i = 0; i < d.n; i++) { const lat = d.gy[i] / d.grid, lon = d.gx[i] / d.grid; if (lat > 42 && lat < 70 && lon > -140 && lon < -55 && d.frp[i] > best) { best = d.frp[i]; bi = i; } }
  if (bi < 0) for (let i = 0; i < d.n; i++) if (d.frp[i] > best) { best = d.frp[i]; bi = i; }
  return bi < 0 ? null : [d.gy[bi] / d.grid, d.gx[bi] / d.grid];
});
// Phones run in WebKit (Safari's engine) with an iPhone profile; desktop in Chromium.
const views = [
  { name: 'iphone-z7', engine: 'webkit', device: iphone, main: 'wind', center: [44.9, -63.5], zoom: 7, wait: 20000 },
  { name: 'iphone-layers', engine: 'webkit', device: iphone, main: 'temp', center: [44.8, -63.4], zoom: 6, click: '#railToggle' },
  { name: 'iphone-alerts-map', engine: 'webkit', device: iphone, main: 'temp', center: [47, -66], zoom: 5, overlays: HZ },
  { name: 'iphone-alerts-z7', engine: 'webkit', device: iphone, main: 'temp', center: [46.3, -66.2], zoom: 7, overlays: HZ, wait: 10000 },
  { name: 'iphone-hazards', engine: 'webkit', device: iphone, main: 'temp', center: [47, -66], zoom: 5, overlays: HZ, click: '#hazardBtn', after: 4000 },
  { name: 'iphone-alert-detail', engine: 'webkit', device: iphone, main: 'temp', center: [47, -66], zoom: 5, overlays: HZ,
    run: async (page) => { await page.evaluate(() => document.querySelector('#hazardBtn').click()); await page.waitForTimeout(4000); await page.evaluate(() => document.querySelector('[data-alert]')?.click()); await page.waitForTimeout(5000); } },
  { name: 'iphone-alert-tap', engine: 'webkit', device: iphone, main: 'temp', center: [47, -66], zoom: 5, overlays: HZ,
    run: async (page) => {
      const ll = await page.evaluate(() => { const sh = window.__we?.S.hz.alerts.shapes || []; const f = sh.find((x) => /frost|rain|wind|snow/i.test(x.properties.alert_name_en || '') && x.geometry) || sh.find((x) => x.geometry); if (!f) return null; const g = f.geometry; const ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0]; let x = 0, y = 0; for (const p of ring) { x += p[0]; y += p[1]; } return [y / ring.length, x / ring.length]; });
      log.push(`[iphone-alert-tap] point ${JSON.stringify(ll)}`);
      if (ll) { await page.evaluate((p) => { window.__we.map.setView(p, 7); window.__we.openPoint(L.latLng(p[0], p[1])); }, ll); await page.waitForTimeout(6000); }
    } },
  { name: 'desktop-storm', engine: 'chromium', vp: { width: 1280, height: 800 }, dpr: 1, main: 'wind', center: [20, -100], zoom: 4, overlays: [...HZ, 'wind'],
    run: async (page) => { await page.evaluate(() => window.__we?.openStorm(0)); await page.waitForTimeout(5000); } },
  { name: 'desktop-fires', engine: 'chromium', vp: { width: 1280, height: 800 }, dpr: 1, main: 'temp', center: [10, 15], zoom: 3, overlays: ['fires', 'cities'], wait: 12000 },
  { name: 'iphone-fire-tap', engine: 'webkit', device: iphone, main: 'temp', center: [55, -110], zoom: 4, overlays: ['fires', 'cities'], wait: 12000,
    run: async (page) => {
      const ll = await strongestFire(page);
      log.push(`[iphone-fire-tap] fire ${JSON.stringify(ll)}`);
      if (ll) { await page.evaluate((p) => { window.__we.map.setView(p, 8); }, ll); await page.waitForTimeout(2500); await page.evaluate((p) => window.__we.openPoint(L.latLng(p[0], p[1])), ll); await page.waitForTimeout(7000); }
    } },
  { name: 'iphone-fires-map', engine: 'webkit', device: iphone, main: 'temp', center: [55, -110], zoom: 4, overlays: ['fires', 'cities'], wait: 12000,
    run: async (page) => { const ll = await strongestFire(page); if (ll) { await page.evaluate((p) => window.__we.map.setView(p, 8), ll); await page.waitForTimeout(4000); } } },
  { name: 'desktop-z5', engine: 'chromium', vp: { width: 1280, height: 800 }, dpr: 1, main: 'pressure', center: [46, -60], zoom: 5, click: '.legend-head' },
].filter((v) => !only.length || only.includes(v.name));

const shoot = async (v) => {
  const ctx = await browsers[v.engine].newContext(v.device ? { ...v.device } : { viewport: v.vp, deviceScaleFactor: v.dpr });
  await ctx.addInitScript((o) => {
    localStorage.setItem('we:main', JSON.stringify(o.main));
    localStorage.setItem('we:center', JSON.stringify(o.center));
    localStorage.setItem('we:zoom', JSON.stringify(o.zoom));
    if (o.overlays) {
      localStorage.setItem('we:overlays', JSON.stringify(o.overlays));
      for (const k of ['windAdded', 'v3defaults', 'v4defaults']) localStorage.setItem(`we:${k}`, 'true');
    }
  }, v);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`[${v.name}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => log.push(`[${v.name}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => log.push(`[${v.name}] failed: ${r.url().slice(0, 200)} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) log.push(`[${v.name}] HTTP ${r.status()}: ${r.url().slice(0, 200)}`); });
  const t0 = Date.now();
  await page.goto(`${site}?snap=${Date.now()}`, { waitUntil: 'load', timeout: 45000 }).catch((e) => log.push(`goto: ${e.message}`));
  await page.waitForTimeout(v.wait || 7000);
  if (v.click) { await page.evaluate((sel) => document.querySelector(sel)?.click(), v.click); await page.waitForTimeout(v.after || 2500); }
  if (v.run) await v.run(page).catch((e) => log.push(`[${v.name}] run: ${e.message}`));
  await page.screenshot({ path: `shots/${v.name}.png` });
  const info = await page.evaluate(() => {
    const S = window.__we?.S;
    return {
      cities: document.querySelectorAll('.city').length,
      chips: document.querySelector('#chips')?.innerText.replace(/\s+/g, ' '),
      badge: document.querySelector('#hazardBtn .badge')?.textContent,
      alerts: S ? `list=${S.hz.alerts.list?.length} shapes=${S.hz.alerts.shapes?.length} stmt=${S.hz.alerts.stmt.size} err=${S.hz.alerts.error}` : 'no handle',
      fires: S?.hz.fires.meta ? `${S.hz.fires.meta.count} cells, ${S.hz.fires.meta.detections} det, areas=${S.hz.areas.data?.areas?.length}` : 'none',
      storms: S?.hz.trop.data ? S.hz.trop.data.storms.map((s) => `${s.name} cone=${s.cone?.length} track=${s.track?.length} pts=${s.points?.length} src=${s.forecastSource}`).join('; ') : 'none',
      drawer: document.querySelector('#drawer')?.hidden ? '' : document.querySelector('#drawerBody')?.innerText.replace(/\s+/g, ' ').slice(0, 700),
    };
  });
  for (const [k, val] of Object.entries(info)) log.push(`[${v.name}] ${k}: ${val}`);
  if (v.name === 'iphone-z7') {
    await page.evaluate(() => document.querySelector('[data-jump="1440"]').click()); // jump buttons are hidden on phones
    await page.waitForTimeout(6000);
    await page.screenshot({ path: 'shots/iphone-z7-plus24h.png' });
    log.push(`[${v.name} +24h] chips: ${(await page.locator('#chips').innerText()).replace(/\s+/g, ' ')}`);
  }
  log.push(`[${v.name}] took ${Math.round((Date.now() - t0) / 1000)} s`);
  await ctx.close();
};
for (const v of views) {
  let timer;
  await Promise.race([shoot(v), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('view timed out')), 100000); })])
    .catch((e) => log.push(`[${v.name}] ERROR ${e.message}`));
  clearTimeout(timer);
  await writeFile('shots/log.txt', log.join('\n') + '\n');
}
await writeFile('shots/log.txt', log.join('\n') + '\n');
for (const b of Object.values(browsers)) await b.close();
