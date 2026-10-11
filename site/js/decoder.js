// METAR / TAF decoder — rule-based, no AI.
// The same report must always decode the same way. Anything the rules do not
// recognise is kept and shown as "Not decoded" rather than silently dropped.
// Handles Canadian practice (MANOBS): cloud opacity remarks in oktas, SLP,
// PRESRR/PRESFR, "NXT FCST BY" TAF remarks.

// ---------- dictionaries ----------
export const WX_INTENSITY = { '-': 'light', '+': 'heavy', VC: 'in the vicinity' };
export const WX_DESCRIPTOR = {
  MI: 'shallow', PR: 'partial', BC: 'patches of', DR: 'low drifting', BL: 'blowing',
  SH: 'showers of', TS: 'thunderstorm', FZ: 'freezing',
};
export const WX_PHENOMENA = {
  DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals',
  PL: 'ice pellets', GR: 'hail', GS: 'small hail / snow pellets', UP: 'unknown precipitation',
  BR: 'mist', FG: 'fog', FU: 'smoke', VA: 'volcanic ash', DU: 'widespread dust',
  SA: 'sand', HZ: 'haze', PY: 'spray', PO: 'dust/sand whirls', SQ: 'squalls',
  FC: 'funnel cloud', SS: 'sandstorm', DS: 'duststorm',
};
export const SKY_COVER = {
  FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast',
};
// MANOBS cloud types used in Canadian opacity remarks
export const CLOUD_TYPES = {
  CI: 'cirrus', CS: 'cirrostratus', CC: 'cirrocumulus', AC: 'altocumulus',
  ACC: 'altocumulus castellanus', AS: 'altostratus', NS: 'nimbostratus',
  SC: 'stratocumulus', ST: 'stratus', SF: 'stratus fractus', CU: 'cumulus',
  CF: 'cumulus fractus', TCU: 'towering cumulus', CB: 'cumulonimbus',
};

const PHEN_CODES = Object.keys(WX_PHENOMENA).join('|');
const RE = {
  station: /^[A-Z][A-Z0-9]{3}$/,
  time: /^(\d{2})(\d{2})(\d{2})Z$/,
  wind: /^(\d{3}|VRB|\/{3})(\d{2,3}|\/{2})(?:G(\d{2,3}))?(KT|MPS|KMH)$/,
  windVar: /^(\d{3})V(\d{3})$/,
  visSM: /^(M|P)?(\d+\/\d+|\d+)SM$/,
  visWhole: /^\d{1,2}$/,
  visFrac: /^(M)?(\d\/\d{1,2})SM$/,
  visM: /^(\d{4})(NDV|N|NE|E|SE|S|SW|W|NW)?$/,
  rvr: /^R(\d{2}[LCR]?)\/(P|M)?(\d{4})(?:V(P|M)?(\d{4}))?(FT)?\/?([UDN])?$/,
  wx: new RegExp(`^(-|\\+|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:${PHEN_CODES})*)$`),
  recentWx: new RegExp(`^RE(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:${PHEN_CODES})*)$`),
  sky: /^(FEW|SCT|BKN|OVC)(\d{3}|\/{3})(CB|TCU|\/{3})?$/,
  vv: /^VV(\d{3}|\/{3})$/,
  clear: /^(SKC|CLR|NSC|NCD)$/,
  temp: /^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$/,
  altA: /^A(\d{4})$/,
  altQ: /^Q(\d{4})$/,
  tafValid: /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/,
  fm: /^FM(\d{2})(\d{2})(\d{2})$/,
  prob: /^PROB(30|40)$/,
  llws: /^WS(\d{3})\/(\d{3})(\d{2,3})(KT)$/,
  txtn: /^(TX|TN)(M?\d{2})\/(\d{2})(\d{2})Z$/,
};

// ---------- helpers ----------
const num = (s) => (s && s.startsWith('M') ? -Number(s.slice(1)) : Number(s));
const pad2 = (n) => String(n).padStart(2, '0');
const fmtNum = (n) => n.toLocaleString('en-CA');
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${Math.round(km * 10) / 10} km`);
const deg = (d) => String(d).padStart(3, '0');

function fracToNum(s) {
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return a / b; }
  return Number(s);
}

function describeWx(code) {
  const m = code.match(RE.wx);
  if (!m || (!m[2] && !m[3])) return null;
  const [, inten, desc, phen] = m;
  const phenList = (phen.match(/.{2}/g) || []).map((p) => WX_PHENOMENA[p]);
  let words = [];
  if (inten && inten !== 'VC') words.push(WX_INTENSITY[inten]);
  if (desc === 'TS') {
    words.push('thunderstorm');
    if (phenList.length) words.push('with ' + phenList.join(' and '));
  } else if (desc === 'SH') {
    words.push(phenList.length ? phenList.join(' and ') + ' showers' : 'showers');
  } else {
    if (desc) words.push(WX_DESCRIPTOR[desc]);
    words.push(phenList.join(' and '));
  }
  if (inten === 'VC') words.push('in the vicinity');
  return words.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function describeVisibility(v) {
  if (v.cavok) return 'CAVOK: visibility 10 km or more, no cloud below 5,000 ft, no significant weather';
  if (v.unit === 'SM') {
    const lead = v.modifier === 'P' ? 'more than ' : v.modifier === 'M' ? 'less than ' : '';
    const plural = v.value > 1 || lead ? 's' : '';
    return `${lead}${v.text} statute mile${plural} (${fmtKm(v.value * 1.609)})`;
  }
  if (v.value === 9999) return '10 km or more';
  return `${fmtNum(v.value)} m${v.direction ? ' (minimum, toward ' + v.direction + ')' : ''}`;
}

function describeWind(w) {
  if (w.missing) return 'Wind missing';
  const u = w.unit === 'KT' ? 'kt' : w.unit === 'MPS' ? 'm/s' : 'km/h';
  if (w.speed === 0 && w.dir === 0) return 'Calm';
  const dir = w.dir === 'VRB' ? 'Variable direction' : `From ${deg(w.dir)}° true`;
  let s = `${dir} at ${w.speed} ${u}`;
  if (w.gust) s += `, gusting ${w.gust} ${u}`;
  if (w.unit === 'KT') s += ` (${Math.round(w.speed * 1.852)} km/h${w.gust ? ', gusts ' + Math.round(w.gust * 1.852) : ''})`;
  if (w.varFrom != null) s += `; varying between ${deg(w.varFrom)}° and ${deg(w.varTo)}°`;
  return s;
}

function describeSky(layer) {
  if (layer.clear) {
    return { SKC: 'Sky clear', CLR: 'No cloud detected below 12,000 ft (automated)', NSC: 'No significant cloud', NCD: 'No cloud detected (automated)' }[layer.clear];
  }
  if (layer.vv !== undefined) return layer.vv == null ? 'Sky obscured, vertical visibility not measured' : `Sky obscured, vertical visibility ${fmtNum(layer.vv)} ft`;
  const h = layer.height == null ? 'unknown height' : `${fmtNum(layer.height)} ft AGL`;
  const t = layer.type === 'CB' ? ' cumulonimbus' : layer.type === 'TCU' ? ' towering cumulus' : '';
  return `${SKY_COVER[layer.cover]}${t} at ${h}`;
}

// Ceiling = lowest BKN/OVC layer or vertical visibility.
export function ceilingOf(sky) {
  let c = null;
  for (const l of sky) {
    if ((l.cover === 'BKN' || l.cover === 'OVC') && l.height != null) c = c == null ? l.height : Math.min(c, l.height);
    if (l.vv != null) c = c == null ? l.vv : Math.min(c, l.vv);
  }
  return c;
}

// ---------- shared element parser (METAR body + TAF groups) ----------
// Returns number of tokens consumed (0 if not recognised).
function parseElement(t, i, out) {
  const tok = t[i];
  let m;
  if ((m = tok.match(RE.wind))) {
    out.wind = m[1] === '///' || m[2] === '//'
      ? { missing: true }
      : { dir: m[1] === 'VRB' ? 'VRB' : Number(m[1]), speed: Number(m[2]), gust: m[3] ? Number(m[3]) : null, unit: m[4] };
    if (t[i + 1] && (m = t[i + 1].match(RE.windVar)) && out.wind && !out.wind.missing) {
      out.wind.varFrom = Number(m[1]); out.wind.varTo = Number(m[2]);
      return 2;
    }
    return 1;
  }
  if (tok === 'CAVOK') { out.visibility = { cavok: true }; return 1; }
  // "1 1/2SM"
  if (RE.visWhole.test(tok) && t[i + 1] && (m = t[i + 1].match(RE.visFrac))) {
    const value = Number(tok) + fracToNum(m[2]);
    out.visibility = { unit: 'SM', value, text: `${tok} ${m[2]}`, modifier: m[1] || null };
    return 2;
  }
  if ((m = tok.match(RE.visSM))) {
    out.visibility = { unit: 'SM', value: fracToNum(m[2]), text: m[2], modifier: m[1] || null };
    return 1;
  }
  if (!out.visibility && (m = tok.match(RE.visM)) && !RE.time.test(tok)) {
    out.visibility = { unit: 'm', value: Number(m[1]), direction: m[2] && m[2] !== 'NDV' ? m[2] : null };
    return 1;
  }
  if ((m = tok.match(RE.rvr))) {
    out.rvr = out.rvr || [];
    out.rvr.push({ runway: m[1], mod: m[2] || null, value: Number(m[3]), varMod: m[4] || null, varValue: m[5] ? Number(m[5]) : null, unit: m[6] ? 'ft' : 'm', trend: m[7] || null });
    return 1;
  }
  if (tok === 'NSW') { out.weather = out.weather || []; out.weather.push({ code: 'NSW', text: 'No significant weather' }); return 1; }
  if ((m = tok.match(RE.sky))) {
    out.sky = out.sky || [];
    out.sky.push({ cover: m[1], height: m[2] === '///' ? null : Number(m[2]) * 100, type: m[3] && m[3] !== '///' ? m[3] : null });
    return 1;
  }
  if ((m = tok.match(RE.vv))) { out.sky = out.sky || []; out.sky.push({ vv: m[1] === '///' ? null : Number(m[1]) * 100 }); return 1; }
  if ((m = tok.match(RE.clear))) { out.sky = out.sky || []; out.sky.push({ clear: m[1] }); return 1; }
  if ((m = tok.match(RE.llws))) {
    out.windShear = { height: Number(m[1]) * 100, dir: Number(m[2]), speed: Number(m[3]) };
    return 1;
  }
  if ((m = tok.match(RE.txtn))) {
    out.tempExtremes = out.tempExtremes || [];
    out.tempExtremes.push({ kind: m[1], value: num(m[2]), day: Number(m[3]), hour: Number(m[4]) });
    return 1;
  }
  if ((m = tok.match(RE.recentWx)) && (m[1] || m[2])) {
    out.recent = out.recent || [];
    out.recent.push({ code: tok, text: describeWx((m[1] || '') + (m[2] || '')) });
    return 1;
  }
  const wxText = describeWx(tok);
  if (wxText && tok.length >= 2) {
    out.weather = out.weather || [];
    out.weather.push({ code: tok, text: wxText });
    return 1;
  }
  return 0;
}

// ---------- Canadian remarks ----------
const OPACITY_RE = new RegExp(`(BLSN|DRSN|${Object.keys(CLOUD_TYPES).sort((a, b) => b.length - a.length).join('|')}|${PHEN_CODES})(\\d)`, 'g');

export function parseRemarks(text) {
  const items = [];
  let rest = ` ${text} `;
  const take = (re, fn) => {
    rest = rest.replace(re, (...args) => {
      const r = fn(...args);
      if (!r) return args[0];
      items.push(r);
      return ' ';
    });
  };
  // Cloud / obscuration opacity groups, e.g. SC4AC2, SF1SC4, FG2SC3
  take(/\s((?:(?:ACC|TCU|CI|CS|CC|AC|AS|NS|SC|ST|SF|CU|CF|CB|BLSN|DRSN|[A-Z]{2})\d)+)(?=\s)/g, (all, grp) => {
    const parts = [...grp.matchAll(OPACITY_RE)];
    const joined = parts.map((p) => p[0]).join('');
    if (!parts.length || joined !== grp) return null;
    const desc = parts.map(([, code, okta]) => {
      const name = CLOUD_TYPES[code] || WX_PHENOMENA[code] || (code === 'BLSN' ? 'blowing snow' : code === 'DRSN' ? 'drifting snow' : code);
      return `${name} ${okta} okta${okta === '1' ? '' : 's'}`;
    });
    return { code: grp, label: 'Cloud layers (opacity, oktas)', text: desc.join(', ') };
  });
  take(/\sSLP(\d{3})(?=\s)/g, (all, p) => {
    const v = Number(p) / 10; const hpa = v < 50 ? 1000 + v : 900 + v;
    return { code: `SLP${p}`, label: 'Sea-level pressure', text: `${hpa.toFixed(1)} hPa` };
  });
  take(/\sPRESRR(?=\s)/g, () => ({ code: 'PRESRR', label: 'Pressure', text: 'Rising rapidly' }));
  take(/\sPRESFR(?=\s)/g, () => ({ code: 'PRESFR', label: 'Pressure', text: 'Falling rapidly' }));
  take(/\sDENSITY ALT (-?\d+)FT(?=\s)/g, (all, ft) => ({ code: `DENSITY ALT ${ft}FT`, label: 'Density altitude', text: `${fmtNum(Number(ft))} ft` }));
  take(/\sNXT FCST BY (\d{2})(\d{2})?(\d{2})?Z(?=\s)/g, (all, a, b, c) => {
    const text = c ? `By day ${a}, ${b}:${c}Z` : b ? `By ${a}:${b}Z` : `By ${a}:00Z`;
    return { code: 'NXT FCST BY', label: 'Next forecast', text };
  });
  take(/\sCIG RAG(?=\s)/g, () => ({ code: 'CIG RAG', label: 'Ceiling', text: 'Ragged' }));
  take(/\sFROIN(?=\s)/g, () => ({ code: 'FROIN', label: 'Remark', text: 'Frost on the indicator' }));
  const leftover = rest.trim().replace(/\s+/g, ' ');
  return { items, other: leftover || null };
}

// ---------- METAR ----------
export function parseMetar(raw) {
  const clean = String(raw || '').trim().replace(/=$/, '').replace(/\s+/g, ' ');
  const [body, rmk] = splitOnce(clean, ' RMK ');
  const t = body.split(' ');
  const r = { raw: clean, kind: 'METAR', flags: [], unparsed: [] };
  let i = 0;
  if (t[i] === 'METAR' || t[i] === 'SPECI') r.kind = t[i++];
  if (t[i] === 'COR') { r.flags.push('COR'); i++; }
  if (t[i] && RE.station.test(t[i])) r.station = t[i++];
  let m;
  if (t[i] && (m = t[i].match(RE.time))) { r.time = { day: Number(m[1]), hour: Number(m[2]), minute: Number(m[3]) }; i++; }
  while (t[i] === 'AUTO' || t[i] === 'COR' || t[i] === 'NIL') { r.flags.push(t[i]); i++; }

  for (; i < t.length; i++) {
    const tok = t[i];
    if (tok === 'NOSIG' || tok === 'BECMG' || tok === 'TEMPO') { r.trend = t.slice(i).join(' '); break; }
    if (tok === 'WS') { // WS RWY24 / WS ALL RWY
      const end = t.slice(i).findIndex((x, k) => k > 0 && !/^(ALL|RWY\d*[LCR]?|R\d{2}[LCR]?)$/.test(x));
      const n = end === -1 ? t.length - i : end;
      r.windShearRwy = t.slice(i, i + n).join(' ');
      i += n - 1; continue;
    }
    if (tok.length >= 4 && !r.temp && (m = tok.match(RE.temp))) {
      r.temp = { air: m[1] === '//' ? null : num(m[1]), dew: !m[2] || m[2] === '//' ? null : num(m[2]) };
      continue;
    }
    if ((m = tok.match(RE.altA))) { r.altimeter = { inHg: Number(m[1]) / 100, hPa: Math.round(Number(m[1]) / 100 * 33.8639) }; continue; }
    if ((m = tok.match(RE.altQ))) { r.altimeter = { hPa: Number(m[1]), inHg: Math.round(Number(m[1]) / 33.8639 * 100) / 100 }; continue; }
    const used = parseElement(t, i, r);
    if (used) { i += used - 1; continue; }
    r.unparsed.push(tok);
  }
  if (rmk) r.remarks = { raw: rmk, ...parseRemarks(rmk) };
  r.ceiling = ceilingOf(r.sky || []);
  return r;
}

function splitOnce(s, sep) {
  const k = s.indexOf(sep);
  return k === -1 ? [s, null] : [s.slice(0, k), s.slice(k + sep.length)];
}

// ---------- TAF ----------
export function parseTaf(raw) {
  const clean = String(raw || '').trim().replace(/=$/, '').replace(/\s+/g, ' ');
  const [body, rmk] = splitOnce(clean, ' RMK ');
  const t = body.split(' ');
  const r = { raw: clean, flags: [], groups: [], unparsed: [] };
  let i = 0, m;
  if (t[i] === 'TAF') i++;
  while (t[i] === 'AMD' || t[i] === 'COR' || t[i] === 'RTD') r.flags.push(t[i++]);
  if (t[i] && RE.station.test(t[i])) r.station = t[i++];
  if (t[i] && (m = t[i].match(RE.time))) { r.issued = { day: Number(m[1]), hour: Number(m[2]), minute: Number(m[3]) }; i++; }
  if (t[i] && (m = t[i].match(RE.tafValid))) { r.valid = period(m); i++; }
  if (t[i] === 'NIL' || t[i] === 'CNL') { r.flags.push(t[i]); i++; }

  let g = { change: 'BASE', elements: {} };
  r.groups.push(g);
  for (; i < t.length; i++) {
    const tok = t[i];
    let next = null;
    if ((m = tok.match(RE.fm))) {
      next = { change: 'FM', from: { day: Number(m[1]), hour: Number(m[2]), minute: Number(m[3]) }, elements: {} };
    } else if (tok === 'BECMG' || tok === 'TEMPO') {
      next = { change: tok, elements: {} };
      if (t[i + 1] && (m = t[i + 1].match(RE.tafValid))) { next.period = period(m); i++; }
    } else if ((m = tok.match(RE.prob))) {
      next = { change: 'PROB', prob: Number(m[1]), elements: {} };
      if (t[i + 1] === 'TEMPO') { next.tempo = true; i++; }
      if (t[i + 1] && (m = t[i + 1].match(RE.tafValid))) { next.period = period(m); i++; }
    }
    if (next) { g = next; r.groups.push(g); continue; }
    const used = parseElement(t, i, g.elements);
    if (used) { i += used - 1; continue; }
    (g.elements.unparsed = g.elements.unparsed || []).push(tok);
    r.unparsed.push(tok);
  }
  if (rmk) r.remarks = { raw: rmk, ...parseRemarks(rmk) };
  return r;
}

function period(m) {
  return { from: { day: Number(m[1]), hour: Number(m[2]) }, to: { day: Number(m[3]), hour: Number(m[4]) } };
}

// ---------- plain language ----------
export const fmtDayTime = (d) => d ? `day ${d.day}, ${pad2(d.hour)}:${pad2(d.minute ?? 0)}Z` : '';
const fmtPeriod = (p) => `day ${p.from.day} ${pad2(p.from.hour)}:00Z to day ${p.to.day} ${pad2(p.to.hour)}:00Z`;

function elementLines(e) {
  const L = [];
  if (e.wind) L.push(['Wind', describeWind(e.wind)]);
  if (e.visibility) L.push(['Visibility', describeVisibility(e.visibility)]);
  if (e.rvr) for (const v of e.rvr) {
    const val = (x, mod) => `${mod === 'P' ? 'more than ' : mod === 'M' ? 'less than ' : ''}${fmtNum(x)} ${v.unit}`;
    L.push([`Runway ${v.runway} visual range`, val(v.value, v.mod) + (v.varValue ? ` varying to ${val(v.varValue, v.varMod)}` : '') + (v.trend ? `, ${{ U: 'improving', D: 'deteriorating', N: 'no change' }[v.trend]}` : '')]);
  }
  if (e.weather) L.push(['Weather', e.weather.map((w) => capitalise(w.text)).join('; ')]);
  if (e.sky) L.push(['Sky', e.sky.map(describeSky).join('; ')]);
  if (e.windShear) L.push(['Low-level wind shear', `At ${fmtNum(e.windShear.height)} ft AGL, wind from ${String(e.windShear.dir).padStart(3, '0')}° at ${e.windShear.speed} kt`]);
  if (e.tempExtremes) for (const x of e.tempExtremes) L.push([x.kind === 'TX' ? 'Maximum temperature' : 'Minimum temperature', `${x.value}°C at day ${x.day} ${pad2(x.hour)}:00Z`]);
  if (e.recent) L.push(['Recent weather', e.recent.map((w) => capitalise(w.text)).join('; ')]);
  return L;
}

const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function metarToPlain(r) {
  const L = [];
  const flags = r.flags.filter((f) => f !== 'COR');
  L.push(['Report', `${r.kind === 'SPECI' ? 'Special report (SPECI)' : 'Routine report (METAR)'}${r.station ? ' for ' + r.station : ''}${r.flags.includes('COR') ? ', corrected' : ''}${flags.includes('AUTO') ? ', automated station' : ''}`]);
  if (r.time) L.push(['Observed', fmtDayTime(r.time)]);
  if (r.flags.includes('NIL')) { L.push(['Status', 'Report missing (NIL)']); return L; }
  L.push(...elementLines(r));
  if (r.ceiling != null) L.push(['Ceiling', `${fmtNum(r.ceiling)} ft AGL`]);
  else if (r.sky) L.push(['Ceiling', 'None (no broken or overcast layer)']);
  if (r.temp) {
    const { air, dew } = r.temp;
    let s = air == null ? 'Temperature missing' : `${air}°C`;
    if (dew != null) s += `, dew point ${dew}°C`;
    if (air != null && dew != null) s += ` (spread ${air - dew}°C)`;
    L.push(['Temperature', s]);
  }
  if (r.altimeter) L.push(['Altimeter', `${r.altimeter.inHg.toFixed(2)} inHg (${r.altimeter.hPa} hPa)`]);
  if (r.windShearRwy) L.push(['Wind shear', r.windShearRwy.replace('WS', 'Wind shear reported:').replace('ALL RWY', 'all runways')]);
  if (r.trend) L.push(['Trend', r.trend === 'NOSIG' ? 'No significant change expected in the next 2 hours' : r.trend]);
  if (r.remarks) {
    for (const it of r.remarks.items) L.push([it.label, it.text]);
    if (r.remarks.other) L.push(['Other remarks', r.remarks.other]);
  }
  if (r.unparsed.length) L.push(['Not decoded', r.unparsed.join(' ')]);
  return L;
}

export function tafToPlain(r) {
  const sections = [];
  const head = [];
  head.push(['Forecast', `Terminal aerodrome forecast${r.station ? ' for ' + r.station : ''}${r.flags.includes('AMD') ? ', amended' : ''}${r.flags.includes('COR') ? ', corrected' : ''}`]);
  if (r.issued) head.push(['Issued', fmtDayTime(r.issued)]);
  if (r.valid) head.push(['Valid', fmtPeriod(r.valid)]);
  if (r.flags.includes('NIL')) head.push(['Status', 'No forecast (NIL)']);
  if (r.flags.includes('CNL')) head.push(['Status', 'Forecast cancelled']);
  sections.push({ title: 'Header', lines: head });
  for (const g of r.groups) {
    let title;
    if (g.change === 'BASE') title = 'Initial conditions';
    else if (g.change === 'FM') title = `From ${fmtDayTime(g.from)}`;
    else if (g.change === 'BECMG') title = `Becoming, ${g.period ? fmtPeriod(g.period) : ''}`;
    else if (g.change === 'TEMPO') title = `Temporarily, ${g.period ? fmtPeriod(g.period) : ''}`;
    else if (g.change === 'PROB') title = `${g.prob}% chance${g.tempo ? ' (temporary)' : ''}, ${g.period ? fmtPeriod(g.period) : ''}`;
    const lines = elementLines(g.elements);
    if (g.elements.sky) {
      const c = ceilingOf(g.elements.sky);
      lines.push(['Ceiling', c == null ? 'None' : `${fmtNum(c)} ft AGL`]);
    }
    if (g.elements.unparsed) lines.push(['Not decoded', g.elements.unparsed.join(' ')]);
    sections.push({ title, change: g.change, lines });
  }
  if (r.remarks) {
    const lines = r.remarks.items.map((it) => [it.label, it.text]);
    if (r.remarks.other) lines.push(['Other remarks', r.remarks.other]);
    sections.push({ title: 'Remarks', lines });
  }
  return sections;
}

// Split a raw TAF into display lines at each change group (standard layout).
export function tafRawLines(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ')
    .replace(/\s(FM\d{6}|BECMG|TEMPO|PROB(?:30|40)(?:\sTEMPO)?|RMK)\s/g, '\n$1 ')
    .replace(/\n(PROB(?:30|40))\n?TEMPO/g, '\n$1 TEMPO')
    .split('\n');
}
