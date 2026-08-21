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

/**
 * QA bisect hook. `?qaPasses=off` disables every presentation pass;
 * `?qaPasses=-street-furniture,-facade-articulation` disables the named ones;
 * `?qaPasses=street-life` runs only the named ones. Production is unaffected:
 * with no query parameter the full list is returned.
 *
 * This exists because a frame defect is often a question of WHICH layer, and
 * the world build is expensive enough that bisecting by rebuilding the code is
 * not practical.
 */
export function selectPasses(list, search) {
  const spec = typeof search === 'string'
    ? new URLSearchParams(search).get('qaPasses')
    : null;
  if (!spec) return list;
  if (spec === 'off') return [];
  const terms = spec.split(',').map((term) => term.trim()).filter(Boolean);
  const removals = terms.filter((term) => term.startsWith('-')).map((term) => term.slice(1));
  const keeps = terms.filter((term) => !term.startsWith('-'));
  let selected = keeps.length ? list.filter((pass) => keeps.includes(pass.id)) : list;
  if (removals.length) selected = selected.filter((pass) => !removals.includes(pass.id));
  return selected;
}

export const ALL_PASSES = Object.freeze([
  skyAtmosphere,
  facadeArticulation,
  streetSurfaceDetail,
  streetFurniture,
  vehiclePresentation,
  streetLife,
]);

export const PASSES = Object.freeze(
  selectPasses([...ALL_PASSES], typeof window !== 'undefined' ? window.location?.search : null),
);

export default PASSES;
