import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readTiff } from '../scripts/tiff.mjs';

for (const name of ['plain.tif', 'deflate.tif']) {
  test(`reads float32 GeoTIFF (${name})`, async () => {
    const t = readTiff(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
    assert.equal(t.width, 7);
    assert.equal(t.height, 5);
    assert.equal(t.bands.length, 1);
    assert.equal(t.bands[0][0], 0.5);
    assert.equal(t.bands[0][3 * 7 + 4], 34.5);
    assert.equal(t.nodata, -9999);
    assert.deepEqual(t.origin, { x: -10, y: 50 });
    assert.deepEqual(t.pixel, { x: 2, y: 2 });
  });
}

test('rejects non-TIFF responses with the start of the body', () => {
  assert.throws(() => readTiff(Buffer.from('<ServiceExceptionReport>bad</ServiceExceptionReport>')), /not a TIFF.*ServiceException/);
});
