// Screenshots of the live site in a real browser (run on demand by the Snapshot workflow).
// Lets the build be checked visually with live ECCC/NASA tiles and the wind animation.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const site = process.env.SITE_URL;
const log = [];
await mkdir('shots', { recursive: true });
const browser = await chromium.launch();

const views = [
  { name: 'phone-z7', vp: { width: 390, height: 844 }, dpr: 2, main: 'wind', center: [44.9, -63.5], zoom: 7 },
  { name: 'phone-z4', vp: { width: 390, height: 844 }, dpr: 2, main: 'wind', center: [45, -55], zoom: 4 },
  { name: 'phone-z8-airports', vp: { width: 390, height: 844 }, dpr: 2, main: 'temp', center: [44.8, -63.4], zoom: 8, click: '[data-quick="stations"]' },
  { name: 'desktop-z5-layers', vp: { width: 1280, height: 800 }, dpr: 1, main: 'pressure', center: [46, -60], zoom: 5, click: '#railToggle' },
];

for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.vp, deviceScaleFactor: v.dpr });
  await ctx.addInitScript((o) => {
    localStorage.setItem('we:main', JSON.stringify(o.main));
    localStorage.setItem('we:center', JSON.stringify(o.center));
    localStorage.setItem('we:zoom', JSON.stringify(o.zoom));
  }, v);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`[${v.name}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => log.push(`[${v.name}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => log.push(`[${v.name}] failed: ${r.url().slice(0, 200)} ${r.failure()?.errorText}`));
  await page.goto(`${site}?snap=${Date.now()}`, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => log.push(`goto: ${e.message}`));
  await page.waitForTimeout(6000);
  if (v.click) { await page.evaluate((sel) => document.querySelector(sel)?.click(), v.click); await page.waitForTimeout(2500); }
  await page.screenshot({ path: `shots/${v.name}.png` });
  const info = await page.evaluate(() => ({
    tiles: [...document.querySelectorAll('.leaflet-tile')].slice(0, 2).map((i) => i.src),
    wind: !!document.querySelector('.wind-canvas'),
    cities: document.querySelectorAll('.city').length,
    isobarLabels: document.querySelectorAll('.isobar-label').length,
    centres: [...document.querySelectorAll('.pcentre')].map((e) => e.innerText.replace(/\s+/g, '')).slice(0, 8).join(' '),
    chips: document.querySelector('#chips')?.innerText.replace(/\s+/g, ' '),
  }));
  log.push(`[${v.name}] wind canvas: ${info.wind} | cities: ${info.cities} | isobar labels: ${info.isobarLabels} | centres: ${info.centres}`);
  log.push(`[${v.name}] chips: ${info.chips}`);
  log.push(`[${v.name}] tiles: ${info.tiles.join(' | ')}`);
  if (v.name === 'phone-z7') {
    await page.evaluate(() => document.querySelector('[data-jump="1440"]').click()); // jump buttons are hidden on phones
    await page.waitForTimeout(6000);
    await page.screenshot({ path: 'shots/phone-z7-plus24h.png' });
    log.push(`[${v.name} +24h] chips: ${(await page.locator('#chips').innerText()).replace(/\s+/g, ' ')}`);
  }
  await ctx.close();
}
await writeFile('shots/log.txt', log.join('\n') + '\n');
await browser.close();
