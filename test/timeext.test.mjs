import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtent, snapTime, parseDuration, isoForWms } from '../site/js/timeext.js';

const T = (s) => Date.parse(s);

test('durations', () => {
  assert.equal(parseDuration('PT6M'), 6 * 60000);
  assert.equal(parseDuration('PT3H'), 3 * 3600000);
  assert.equal(parseDuration('P1D'), 86400000);
});

test('model extent snaps to nearest step', () => {
  const e = parseExtent('2026-10-11T00:00:00Z/2026-10-21T00:00:00Z/PT3H');
  assert.equal(snapTime(e, T('2026-10-11T04:10:00Z')), T('2026-10-11T03:00:00Z'));
  assert.equal(snapTime(e, T('2026-10-11T04:40:00Z')), T('2026-10-11T06:00:00Z'));
  assert.equal(snapTime(e, T('2026-10-30T00:00:00Z')), T('2026-10-21T00:00:00Z'));
});

test('observation extent floors to the latest image at or before the time', () => {
  const e = parseExtent('2026-10-11T12:00:00Z/2026-10-11T15:00:00Z/PT6M');
  assert.equal(snapTime(e, T('2026-10-11T13:59:00Z'), 'floor'), T('2026-10-11T13:54:00Z'));
  assert.equal(snapTime(e, T('2026-10-11T11:00:00Z'), 'floor'), null);
});

test('lists and daily extents', () => {
  const l = parseExtent('2026-10-11T00:00:00Z,2026-10-11T06:00:00Z,2026-10-11T12:00:00Z');
  assert.equal(snapTime(l, T('2026-10-11T07:00:00Z')), T('2026-10-11T06:00:00Z'));
  const d = parseExtent('2002-06-01/2026-10-10/P1D');
  assert.equal(d.dateOnly, true);
  assert.equal(isoForWms(snapTime(d, T('2026-10-11T15:00:00Z'), 'floor'), true), '2026-10-10');
});
