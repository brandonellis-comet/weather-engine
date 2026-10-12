import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeFires, encodeFires, simplifyLine, simplifyRing, compactAreas, compactStorm, compactPoints, FIRE_GRID } from '../scripts/hazards.mjs';
import { decodeFires, fireLat, fireLon, fireAgeMin, fireBucket, summariseFires, groupAlerts, isActive, inPolys, inGeom, stormCat, stormsAt, riskOf, typeOf } from '../site/js/hazards.js';

const NOW = Date.parse('2026-10-12T18:00:00Z');
const HEAD = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight';
const csvA = [HEAD,
  '55.30288,-126.36388,330.1,0.4,0.4,2026-10-12,0130,N20,nominal,2.0NRT,290,12.5,N',
  '55.30401,-126.36299,331.0,0.4,0.4,2026-10-12,1530,N20,high,2.0NRT,290,40.2,D', // same 0.02° cell, later and stronger
  '10.00000,20.00000,320.0,0.4,0.4,2026-10-12,1200,N20,low,2.0NRT,290,3.0,D',      // low confidence: dropped
  '-19.08525,-169.85228,335.75,0.37,0.58,2026-10-11,0026,N20,nominal,2.0NRT,292.43,2.78,D', // older than 26 h: dropped
].join('\n');
const csvB = [HEAD, '55.30300,-126.36400,329.0,0.4,0.4,2026-10-12,1000,N21,nominal,2.0NRT,290,8.0,D', '-33.5,151.2,330,0.4,0.4,2026-10-12,0300,N,nominal,2.0NRT,290,5,N'].join('\n');

test('fires: merge onto the grid, drop low confidence and old rows', () => {
  const { cells, rows, kept } = mergeFires([csvA, csvB], NOW);
  assert.equal(rows, 6);
  assert.equal(kept, 4);
  assert.equal(cells.length, 2);
  const bc = cells.find((c) => c.gy === Math.round(55.303 * FIRE_GRID));
  assert.equal(bc.n, 3);
  assert.equal(bc.frp, 40.2);
  assert.equal(bc.t, Date.parse('2026-10-12T15:30:00Z'));
  assert.equal(bc.flags & 1, 1, 'high confidence flag');
  assert.equal(bc.flags & 2, 0, 'latest pass was by day');
  assert.equal(bc.flags & (8 | 16), 8 | 16, 'NOAA-20 and NOAA-21');
});

test('fires: binary round trip', () => {
  const { cells } = mergeFires([csvA, csvB], NOW);
  const buf = encodeFires(cells, NOW);
  assert.equal(buf.length, cells.length * 10);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const d = decodeFires({ count: cells.length, grid: FIRE_GRID, generated: new Date(NOW).toISOString() }, ab);
  // oldest first
  assert.ok(d.age[0] >= d.age[1]);
  const i = [0, 1].find((k) => fireLat(d, k) > 0);
  assert.ok(Math.abs(fireLat(d, i) - 55.30) < 0.011);
  assert.ok(Math.abs(fireLon(d, i) + 126.36) < 0.011);
  assert.equal(d.frp[i], 402);
  assert.equal(d.age[i], 150);
  assert.equal(d.cnt[i], 3);
  assert.equal(Math.round(fireAgeMin(d, i, NOW + 30 * 60000)), 180);
  assert.equal(fireBucket(150), 0);
  assert.equal(fireBucket(8 * 60), 1);
  assert.equal(fireBucket(20 * 60), 2);
  const sum = summariseFires(d, [i], NOW);
  assert.equal(sum.detections, 3);
  assert.equal(sum.frp, 40.2);
  assert.deepEqual(sum.satellites, ['NOAA-20', 'NOAA-21']);
  assert.ok(d.px[i] > 0 && d.px[i] < 1 && d.py[i] > 0 && d.py[i] < 0.5);
});

test('geometry: simplify keeps shape, never collapses a ring', () => {
  const line = Array.from({ length: 101 }, (_, k) => [k / 100, Math.sin(k / 10) * 0.0001]);
  assert.equal(simplifyLine(line, 0.001).length, 2);
  const tri = [[0, 0], [0.001, 0], [0, 0.001], [0, 0]];
  assert.equal(simplifyRing(tri, 0.01).length, 4);
  const sq = [[0, 0], [1, 0], [1, 0.5], [1, 1], [0, 1], [0, 0]];
  assert.equal(simplifyRing(sq, 0.01).length, 5);
});

test('fire areas: compact, fix lat/lon order, sort by size', () => {
  const ring = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
  const gj = { features: [
    { properties: { area: 75.6, firstdate: '2026-10-01T00:00:00Z', lastdate: '2026-10-10T00:00:00Z', hcount: 4 }, geometry: { type: 'Polygon', coordinates: [ring(-120, 55, 0.01)] } },
    { properties: { area: 72336.2, firstdate: '2026-07-14T07:17:00Z', lastdate: '2026-10-11T17:59:00Z', hcount: 227 }, geometry: { type: 'MultiPolygon', coordinates: [[ring(56, -121, 0.3).map(([a, b]) => [a, b])]] } },
  ] };
  // second feature is in lat/lon order (lat 56, lon -121)
  const areas = compactAreas(gj);
  assert.equal(areas.length, 2);
  assert.equal(areas[0].ha, 72336);
  assert.equal(areas[0].hotspots, 227);
  const [lon, lat] = areas[0].polys[0][0][0];
  assert.ok(lon < 0 && lat > 0, 'swapped to lon, lat');
  assert.ok(inPolys(areas[1].polys, -119.995, 55.005));
});

test('tropical: storm and forecast points', () => {
  const s = compactStorm({ id: 'ep202026', binNumber: 'EP5', name: 'Simon', classification: 'HU', intensity: '90', pressure: '965', latitudeNumeric: 20.2, longitudeNumeric: -106.6, movementDir: 270, movementSpeed: 2, lastUpdate: '2026-10-12T18:00:00.000Z', publicAdvisory: { url: 'https://www.nhc.noaa.gov/text/MIATCPEP5.shtml' } });
  assert.equal(s.label, 'Hurricane');
  assert.equal(s.kt, 90);
  assert.equal(s.mb, 965);
  assert.equal(stormCat(s.kt).code, '2');
  assert.equal(stormCat(30).code, 'TD');
  assert.equal(stormCat(140).code, '5');
  const pts = compactPoints({ features: [
    { properties: { TAU: 24, MAXWIND: 80, DVLBL: 'H', FLDATELBL: '12:00 PM Tue' }, geometry: { type: 'Point', coordinates: [-107.5, 20.8] } },
    { properties: { TAU: 0, MAXWIND: 90 }, geometry: { type: 'Point', coordinates: [-106.6, 20.2] } },
  ] });
  assert.equal(pts[0].tau, 0);
  assert.equal(pts[1].kt, 80);
  assert.equal(pts[1].when, '12:00 PM Tue');
  s.points = pts;
  s.cone = [[[[-110, 18], [-104, 18], [-104, 24], [-110, 24], [-110, 18]]]];
  const far = { x: 1e6, y: 1e6 };
  assert.equal(stormsAt([s], 21, -107, far, () => ({ x: 0, y: 0 })).length, 1, 'inside cone');
  assert.equal(stormsAt([s], 40, -60, far, () => ({ x: 0, y: 0 })).length, 0);
  assert.equal(stormsAt([s], 40, -60, { x: 5, y: 5 }, () => ({ x: 0, y: 0 })).length, 1, 'near a point on screen');
});

test('alerts: active filter, grouping and order', () => {
  const f = (id, p) => ({ id, properties: { status_en: 'issued', publication_datetime: '2026-10-12T05:00:00Z', expiration_datetime: '2026-10-13T05:00:00Z', province: 'NB', ...p } });
  const feats = [
    f('1', { alert_type: 'statement', alert_name_en: 'special weather statement', risk_colour_en: null, feature_name_en: 'Fredericton' }),
    f('2', { alert_type: 'advisory', alert_name_en: 'frost advisory', risk_colour_en: 'yellow', feature_name_en: 'Fredericton' }),
    f('3', { alert_type: 'advisory', alert_name_en: 'frost advisory', risk_colour_en: 'yellow', feature_name_en: 'Oromocto' }),
    f('4', { alert_type: 'warning', alert_name_en: 'rainfall warning', risk_colour_en: 'Orange', feature_name_en: 'Moncton', alert_text_en: 'Heavy rain.\nUp to 100 mm.' }),
    f('5', { alert_type: 'warning', alert_name_en: 'wind warning', risk_colour_en: 'yellow', feature_name_en: 'Saint John' }),
    f('6', { alert_type: 'advisory', alert_name_en: 'fog advisory', risk_colour_en: 'yellow', status_en: 'ended', feature_name_en: 'Bathurst' }),
    f('7', { alert_type: 'advisory', alert_name_en: 'fog advisory', risk_colour_en: 'yellow', expiration_datetime: '2026-10-12T06:00:00Z', feature_name_en: 'Miramichi' }),
  ];
  assert.equal(isActive(feats[5].properties, NOW), false);
  assert.equal(isActive(feats[6].properties, NOW), false);
  const g = groupAlerts(feats, NOW);
  assert.deepEqual(g.map((x) => x.name), ['Rainfall warning', 'Wind warning', 'Frost advisory', 'Special weather statement']);
  assert.equal(g[0].risk, 'orange');
  assert.equal(g[0].text, 'Heavy rain.\nUp to 100 mm.');
  assert.deepEqual(g[2].regions, ['Fredericton', 'Oromocto']);
  assert.deepEqual(g[2].ids, ['2', '3']);
  assert.equal(riskOf({ risk_colour_en: null }), 'none');
  assert.equal(typeOf({ alert_type: 'WATCH' }), 'watch');
});

test('alerts: point in polygon with holes and multipolygons', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  const poly = { type: 'Polygon', coordinates: [outer, hole] };
  assert.equal(inGeom(poly, 2, 2), true);
  assert.equal(inGeom(poly, 5, 5), false);
  assert.equal(inGeom(poly, 11, 5), false);
  const multi = { type: 'MultiPolygon', coordinates: [[outer], [[[20, 20], [30, 20], [30, 30], [20, 20]]]] };
  assert.equal(inGeom(multi, 28, 22), true);
  assert.equal(inGeom(null, 1, 1), false);
});
