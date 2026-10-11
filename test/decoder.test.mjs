import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetar, parseTaf, metarToPlain, tafToPlain, tafRawLines, parseRemarks } from '../site/js/decoder.js';

const line = (lines, label) => (lines.find(([l]) => l === label) || [])[1];

test('Canadian METAR with opacity remarks and SLP', () => {
  const r = parseMetar('METAR CYHZ 111500Z 25012G22KT 15SM -SHRA FEW020 BKN045 OVC090 08/04 A2987 RMK SC2SC3AC3 SLP117');
  assert.equal(r.station, 'CYHZ');
  assert.deepEqual(r.time, { day: 11, hour: 15, minute: 0 });
  assert.deepEqual(r.wind, { dir: 250, speed: 12, gust: 22, unit: 'KT' });
  assert.equal(r.visibility.value, 15);
  assert.equal(r.weather[0].text, 'light rain showers');
  assert.equal(r.sky.length, 3);
  assert.equal(r.ceiling, 4500);
  assert.deepEqual(r.temp, { air: 8, dew: 4 });
  assert.equal(r.altimeter.inHg, 29.87);
  assert.equal(r.unparsed.length, 0);
  const p = metarToPlain(r);
  assert.equal(line(p, 'Cloud layers (opacity, oktas)'), 'stratocumulus 2 oktas, stratocumulus 3 oktas, altocumulus 3 oktas');
  assert.equal(line(p, 'Sea-level pressure'), '1011.7 hPa');
  assert.match(line(p, 'Wind'), /From 250° true at 12 kt, gusting 22 kt/);
  assert.equal(line(p, 'Ceiling'), '4,500 ft AGL');
  assert.equal(line(p, 'Other remarks'), undefined);
});

test('SPECI with mixed-fraction visibility, vertical visibility, blowing snow', () => {
  const r = parseMetar('SPECI CYQX 111523Z AUTO 03018G30KT 1 1/2SM -SN BLSN VV008 M02/M03 A2958 RMK SN8 PRESFR SLP018');
  assert.equal(r.kind, 'SPECI');
  assert.ok(r.flags.includes('AUTO'));
  assert.equal(r.visibility.value, 1.5);
  assert.deepEqual(r.weather.map((w) => w.text), ['light snow', 'blowing snow']);
  assert.equal(r.ceiling, 800);
  assert.deepEqual(r.temp, { air: -2, dew: -3 });
  const p = metarToPlain(r);
  assert.match(line(p, 'Visibility'), /^1 1\/2 statute miles/);
  assert.equal(line(p, 'Cloud layers (opacity, oktas)'), 'snow 8 oktas');
  assert.equal(line(p, 'Pressure'), 'Falling rapidly');
  assert.equal(line(p, 'Sea-level pressure'), '1001.8 hPa');
  assert.equal(r.unparsed.length, 0);
});

test('International METAR: variable wind, metres, QNH, NOSIG', () => {
  const r = parseMetar('METAR EGLL 111520Z 22015KT 190V250 9999 FEW030 15/09 Q1012 NOSIG');
  assert.equal(r.wind.varFrom, 190);
  assert.equal(r.wind.varTo, 250);
  assert.equal(r.visibility.value, 9999);
  assert.equal(r.altimeter.hPa, 1012);
  const p = metarToPlain(r);
  assert.equal(line(p, 'Visibility'), '10 km or more');
  assert.match(line(p, 'Trend'), /No significant change/);
  assert.equal(line(p, 'Ceiling'), 'None (no broken or overcast layer)');
});

test('Calm wind, quarter-mile fog', () => {
  const r = parseMetar('METAR CYYT 111530Z 00000KT 1/4SM FG VV001 07/07 A3001 RMK FG8 SLP165');
  const p = metarToPlain(r);
  assert.equal(line(p, 'Wind'), 'Calm');
  assert.match(line(p, 'Visibility'), /^1\/4 statute mile \(402 m\)/);
  assert.equal(line(p, 'Weather'), 'Fog');
  assert.equal(r.ceiling, 100);
  assert.equal(line(p, 'Cloud layers (opacity, oktas)'), 'fog 8 oktas');
  assert.equal(line(p, 'Sea-level pressure'), '1016.5 hPa');
});

test('US METAR keeps unrecognised remarks as "Other remarks"', () => {
  const r = parseMetar('METAR KJFK 111551Z 19010KT 10SM CLR 18/06 A3004 RMK AO2 SLP172 T01780061');
  const p = metarToPlain(r);
  assert.equal(line(p, 'Sea-level pressure'), '1017.2 hPa');
  assert.equal(line(p, 'Other remarks'), 'AO2 T01780061');
  assert.match(line(p, 'Sky'), /No cloud detected below 12,000 ft/);
});

test('Thunderstorm, CB layer, density altitude', () => {
  const r = parseMetar('METAR CYUL 111500Z 27008KT 15SM +TSRA BKN040CB 22/18 A2990 RMK CB5AC2 SLP126 DENSITY ALT 1500FT');
  const p = metarToPlain(r);
  assert.equal(line(p, 'Weather'), 'Heavy thunderstorm with rain');
  assert.equal(line(p, 'Sky'), 'Broken cumulonimbus at 4,000 ft AGL');
  assert.equal(line(p, 'Cloud layers (opacity, oktas)'), 'cumulonimbus 5 oktas, altocumulus 2 oktas');
  assert.equal(line(p, 'Density altitude'), '1,500 ft');
});

test('Unknown groups are surfaced, never dropped', () => {
  const r = parseMetar('METAR CYHZ 111500Z 25012KT 15SM FEW020 08/04 A2987 XYZZY');
  assert.deepEqual(r.unparsed, ['XYZZY']);
  assert.equal(line(metarToPlain(r), 'Not decoded'), 'XYZZY');
});

test('Canadian TAF with TEMPO, FM, BECMG, PROB and NXT FCST BY', () => {
  const raw = 'TAF CYHZ 111440Z 1115/1218 25015G25KT P6SM SCT030 BKN060 TEMPO 1115/1118 5SM -SHRA BKN025 FM111900 27012KT P6SM FEW040 BECMG 1206/1208 30010KT PROB30 1209/1212 2SM BR OVC008 RMK NXT FCST BY 18Z';
  const r = parseTaf(raw);
  assert.equal(r.station, 'CYHZ');
  assert.deepEqual(r.valid, { from: { day: 11, hour: 15 }, to: { day: 12, hour: 18 } });
  assert.deepEqual(r.groups.map((g) => g.change), ['BASE', 'TEMPO', 'FM', 'BECMG', 'PROB']);
  assert.equal(r.groups[0].elements.visibility.modifier, 'P');
  assert.equal(r.groups[4].prob, 30);
  assert.equal(r.unparsed.length, 0);
  const s = tafToPlain(r);
  assert.match(line(s[1].lines, 'Visibility'), /^more than 6 statute miles/);
  assert.equal(line(s[1].lines, 'Ceiling'), '6,000 ft AGL');
  assert.equal(s[2].title, 'Temporarily, day 11 15:00Z to day 11 18:00Z');
  assert.equal(s[3].title, 'From day 11, 19:00Z');
  assert.equal(s[5].title, '30% chance, day 12 09:00Z to day 12 12:00Z');
  assert.equal(line(s[5].lines, 'Weather'), 'Mist');
  assert.equal(line(s[6].lines, 'Next forecast'), 'By 18:00Z');
  const lines = tafRawLines(raw);
  assert.equal(lines.length, 6);
  assert.match(lines[4], /^PROB30 1209\/1212/);
});

test('Amended TAF with low-level wind shear and PROB40 TEMPO', () => {
  const r = parseTaf('TAF AMD CYQX 111600Z 1116/1212 VRB03KT P6SM SKC WS015/27045KT PROB40 TEMPO 1200/1206 1/2SM -FZDZ OVC003');
  assert.ok(r.flags.includes('AMD'));
  assert.deepEqual(r.groups[0].elements.windShear, { height: 1500, dir: 270, speed: 45 });
  assert.equal(r.groups[1].tempo, true);
  const s = tafToPlain(r);
  assert.equal(line(s[1].lines, 'Low-level wind shear'), 'At 1,500 ft AGL, wind from 270° at 45 kt');
  assert.equal(line(s[2].lines, 'Weather'), 'Light freezing drizzle');
  assert.equal(line(s[2].lines, 'Ceiling'), '300 ft AGL');
  assert.equal(tafRawLines(r.raw)[1], 'PROB40 TEMPO 1200/1206 1/2SM -FZDZ OVC003');
});

test('Remarks parser leaves non-opacity text alone', () => {
  const r = parseRemarks('VIS NW 1/2 CIG RAG SLP998');
  assert.equal(r.items.find((x) => x.code === 'SLP998').text, '999.8 hPa');
  assert.equal(r.items.find((x) => x.code === 'CIG RAG').text, 'Ragged');
  assert.equal(r.other, 'VIS NW 1/2');
});
