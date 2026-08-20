// Static presentation pass list.
//
// Order here is documentation only; the runtime sorts by each pass's `order`.
// Adding a module to this list is the single act that puts it in the world, so
// the list stays explicit rather than glob-discovered.
import skyAtmosphere from './sky-atmosphere.js';
import facadeArticulation from './facade-articulation.js';
import streetSurfaceDetail from './street-surface-detail.js';
import streetFurniture from './street-furniture.js';
import vehiclePresentation from './vehicle-presentation.js';
import streetLife from './street-life.js';

export const PASSES = Object.freeze([
  skyAtmosphere,
  facadeArticulation,
  streetSurfaceDetail,
  streetFurniture,
  vehiclePresentation,
  streetLife,
]);

export default PASSES;
