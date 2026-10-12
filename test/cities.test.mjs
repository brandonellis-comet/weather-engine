import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactCities } from '../scripts/build-data.mjs';

test('Natural Earth places compacted and ordered by importance', () => {
  const fc = { features: [
    { properties: { name: 'Truro', latitude: 45.365, longitude: -63.28, scalerank: 8, pop_max: 23000 } },
    { properties: { name: 'Halifax', latitude: 44.65, longitude: -63.6, scalerank: 3, pop_max: 403000 } },
    { properties: { name: 'Toronto', latitude: 43.7, longitude: -79.42, scalerank: 1, pop_max: 5213000 } },
    { properties: { name: 'Dartmouth', latitude: 44.67, longitude: -63.57, scalerank: 3, pop_max: 92000 } },
    { properties: { latitude: 1, longitude: 2 } },
  ] };
  assert.deepEqual(compactCities(fc), [
    ['Toronto', 43.7, -79.42, 1], ['Halifax', 44.65, -63.6, 3], ['Dartmouth', 44.67, -63.57, 3], ['Truro', 45.37, -63.28, 8],
  ]);
});
