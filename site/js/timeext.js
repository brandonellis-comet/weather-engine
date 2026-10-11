// Time handling shared by the site and the data job.
// One clock drives every layer: each layer snaps the selected time to a time
// it actually has, and reports what it snapped to.

export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => Number(x || 0));
  const ms = ((d * 24 + h) * 60 + mi) * 60000 + s * 1000;
  return ms || null;
}

const toMs = (s) => {
  const t = Date.parse(s.length === 10 ? s + 'T00:00:00Z' : s);
  return Number.isNaN(t) ? null : t;
};

// WMS dimension text: "start/end/period" (possibly several, comma separated) or a list of instants.
export function parseExtent(text) {
  if (!text) return null;
  const parts = text.trim().split(',').map((p) => p.trim()).filter(Boolean);
  const ranges = [];
  const values = [];
  for (const p of parts) {
    const seg = p.split('/');
    if (seg.length === 3) {
      const start = toMs(seg[0]); const end = toMs(seg[1]); const period = parseDuration(seg[2]);
      if (start != null && end != null && period) ranges.push({ start, end, period });
    } else {
      const v = toMs(p);
      if (v != null) values.push(v);
    }
  }
  if (!ranges.length && !values.length) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}(\/|$)/.test(parts[parts.length - 1]);
  const all = [...values, ...ranges.flatMap((r) => [r.start, r.end])];
  return { ranges, values: values.sort((a, b) => a - b), start: Math.min(...all), end: Math.max(...all), dateOnly };
}

// Nearest time the layer has. mode "floor" = latest at or before t (observations).
export function snapTime(ext, t, mode = 'nearest') {
  if (!ext) return null;
  let best = null;
  const consider = (v) => {
    if (mode === 'floor' && v > t) return;
    if (best == null || Math.abs(v - t) < Math.abs(best - t)) best = v;
  };
  for (const r of ext.ranges) {
    if (t <= r.start) consider(r.start);
    else if (t >= r.end) consider(r.end);
    else {
      const k = Math.floor((t - r.start) / r.period);
      consider(r.start + k * r.period);
      consider(Math.min(r.start + (k + 1) * r.period, r.end));
    }
  }
  for (const v of ext.values) consider(v);
  return best;
}

export function isoForWms(ms, dateOnly) {
  const iso = new Date(ms).toISOString();
  return dateOnly ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, 'Z');
}

export function fmtZ(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
}
