// City names drawn above the weather layers: dark text on a white halo so they stay
// readable over any colour field. More cities appear as you zoom in; labels that
// would overlap a more important one are skipped. Data: Natural Earth (public domain).

const RANK_FOR_ZOOM = [1, 1, 1, 2, 3, 4, 5, 7, 8, 9, 10, 10, 10]; // max scalerank shown per zoom
const MAX_LABELS = 140;

import { labelArea } from './isobars.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createCityLayer(L) {
  return L.Layer.extend({
    options: { pane: 'cityPane' },
    initialize(cities, opts) { this._cities = cities; L.setOptions(this, opts); },
    onAdd(map) {
      this._map = map;
      this._group = L.layerGroup().addTo(map);
      map.on('moveend zoomend', this._update, this);
      this._update();
    },
    onRemove(map) {
      map.off('moveend zoomend', this._update, this);
      this._group.remove(); this._group = null; this._map = null;
    },
    _update() {
      const map = this._map, g = this._group;
      if (!map || !g) return;
      g.clearLayers();
      const z = Math.round(map.getZoom());
      const maxRank = RANK_FOR_ZOOM[Math.max(0, Math.min(RANK_FOR_ZOOM.length - 1, z))];
      const b = map.getBounds().pad(0.05);
      const size = map.getSize();
      const placed = [];
      const safe = labelArea(size);
      let count = 0;
      for (const [name, lat, lon, rank] of this._cities) {
        if (rank > maxRank) break; // list is sorted by rank
        if (lat < b.getSouth() || lat > b.getNorth()) continue;
        // match the longitude copy that is on screen
        let ll = L.latLng(lat, lon);
        if (!b.contains(ll)) { ll = L.latLng(lat, lon + 360); if (!b.contains(ll)) { ll = L.latLng(lat, lon - 360); if (!b.contains(ll)) continue; } }
        const pt = map.latLngToContainerPoint(ll);
        const major = rank <= Math.max(2, maxRank - 3);
        const w = name.length * (major ? 8.2 : 7.2) + 10, h = major ? 20 : 17;
        const box = [pt.x - w / 2, pt.y - h - 4, pt.x + w / 2, pt.y + 4];
        if (box[0] < safe[0] || box[1] < safe[1] || box[2] > safe[2] || box[3] > safe[3]) continue;
        if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
        placed.push(box);
        L.marker(ll, {
          pane: this.options.pane, interactive: false, keyboard: false,
          icon: L.divIcon({ className: `city${major ? ' major' : ''}`, html: `<div><span class="nm">${esc(name)}</span><span class="dot"></span></div>`, iconSize: null }),
        }).addTo(g);
        if (++count >= MAX_LABELS) break;
      }
    },
  });
}
