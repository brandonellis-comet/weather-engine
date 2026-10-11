// Minimal GeoTIFF reader for the gridded data ECCC GeoMet returns from WCS.
// Supports classic TIFF, strips or tiles, no compression or Deflate, 8/16/32/64-bit
// integer and float samples. Returns band arrays plus the georeferencing.
import { inflateSync } from 'node:zlib';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

export function readTiff(buf) {
  const order = buf.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') throw new Error('not a TIFF (got ' + JSON.stringify(buf.slice(0, 80).toString('latin1')) + ')');
  const le = order === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(2) !== 42) throw new Error('BigTIFF is not supported');

  const ifd = u32(4);
  const tags = {};
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = (TYPE_SIZE[type] || 1) * count;
    const off = size <= 4 ? e + 8 : u32(e + 8);
    const read = (o) => {
      switch (type) {
        case 3: return u16(o);
        case 4: return u32(o);
        case 8: return le ? buf.readInt16LE(o) : buf.readInt16BE(o);
        case 9: return le ? buf.readInt32LE(o) : buf.readInt32BE(o);
        case 11: return le ? buf.readFloatLE(o) : buf.readFloatBE(o);
        case 12: return le ? buf.readDoubleLE(o) : buf.readDoubleBE(o);
        default: return buf[o];
      }
    };
    if (type === 2) { tags[tag] = buf.toString('latin1', off, off + count).replace(/\0+$/, ''); continue; }
    const vals = new Array(count);
    for (let k = 0; k < count; k++) vals[k] = read(off + k * (TYPE_SIZE[type] || 1));
    tags[tag] = vals;
  }

  const W = tags[256][0], H = tags[257][0];
  const bps = tags[258]?.[0] ?? 8, comp = tags[259]?.[0] ?? 1, spp = tags[277]?.[0] ?? 1;
  const fmt = tags[339]?.[0] ?? 1, planar = tags[284]?.[0] ?? 1, pred = tags[317]?.[0] ?? 1;
  if (![1, 8, 32946].includes(comp)) throw new Error(`unsupported TIFF compression ${comp}`);
  if (pred !== 1) throw new Error(`unsupported TIFF predictor ${pred}`);

  const tiled = !!tags[324];
  const offs = tiled ? tags[324] : tags[273];
  const counts = tiled ? tags[325] : tags[279];
  const cw = tiled ? tags[322][0] : W;
  const ch = tiled ? tags[323][0] : (tags[278]?.[0] ?? H);
  const across = Math.ceil(W / cw);
  const per = Math.ceil(H / ch) * across; // chunks per band (planar=2)
  const bytes = bps / 8;
  const sample = (b, o) => {
    if (fmt === 3) return bps === 64 ? (le ? b.readDoubleLE(o) : b.readDoubleBE(o)) : (le ? b.readFloatLE(o) : b.readFloatBE(o));
    if (fmt === 2) return bps === 8 ? b.readInt8(o) : bps === 16 ? (le ? b.readInt16LE(o) : b.readInt16BE(o)) : (le ? b.readInt32LE(o) : b.readInt32BE(o));
    return bps === 8 ? b[o] : bps === 16 ? (le ? b.readUInt16LE(o) : b.readUInt16BE(o)) : (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  };

  const bands = Array.from({ length: spp }, () => new Float32Array(W * H));
  offs.forEach((off, idx) => {
    let raw = buf.subarray(off, off + counts[idx]);
    if (comp !== 1) raw = inflateSync(raw);
    const band = planar === 2 ? Math.floor(idx / per) : 0;
    const k = planar === 2 ? idx % per : idx;
    const x0 = (k % across) * cw, y0 = Math.floor(k / across) * ch;
    const step = planar === 2 ? 1 : spp;
    for (let y = 0; y < ch && y0 + y < H; y++) {
      for (let x = 0; x < cw && x0 + x < W; x++) {
        const base = ((y * cw + x) * step) * bytes;
        if (planar === 2) bands[band][(y0 + y) * W + x0 + x] = sample(raw, base);
        else for (let s = 0; s < spp; s++) bands[s][(y0 + y) * W + x0 + x] = sample(raw, base + s * bytes);
      }
    }
  });

  const nodataTxt = typeof tags[42113] === 'string' ? tags[42113].trim() : null;
  const tie = tags[33922], scale = tags[33550];
  return {
    width: W, height: H, bands, bitsPerSample: bps, sampleFormat: fmt, compression: comp, tiled,
    nodata: nodataTxt != null && nodataTxt !== '' ? Number(nodataTxt) : null,
    origin: tie ? { x: tie[3] - tie[0] * scale[0], y: tie[4] + tie[1] * scale[1] } : null,
    pixel: scale ? { x: scale[0], y: scale[1] } : null,
  };
}
