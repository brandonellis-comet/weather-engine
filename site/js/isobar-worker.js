// Builds isobars off the main thread so stepping through time never stalls the map.
import { decodePressure, buildIsobars } from './isobars.js';

self.onmessage = (e) => {
  const { id, index, buf } = e.data;
  try { self.postMessage({ id, iso: buildIsobars(decodePressure(index, buf)) }); }
  catch (err) { self.postMessage({ id, error: String(err?.message || err) }); }
};
