/**
 * Production launch definitions for small, high-fidelity real-world areas.
 * Coordinates are local metres in the SF OSM dataset (not invented geometry).
 */
const FERRY_BUILDING_TILE = Object.freeze({
  id: 'sf-ferry-building-v1',
  place: 'ferry-building',
  label: 'Ferry Building / Embarcadero',
  city: 'San Francisco, CA',
  source: Object.freeze({
    dataset: 'OpenStreetMap SF city snapshot',
    landmarkOsmWay: 558731934,
    landmarkName: 'San Francisco Ferry Building',
  }),
  // 384 m production cell plus its 16 m generation/seam buffer.
  bounds: Object.freeze({ minX: 2144, minZ: 1728, maxX: 2528, maxZ: 2112 }),
  bufferedBounds: Object.freeze({ minX: 2128, minZ: 1712, maxX: 2544, maxZ: 2128 }),
  // The OSM Embarcadero / Ferry Plaza approach immediately north of the terminal.
  spawn: Object.freeze({ x: 2314.9, z: 1815, yaw: 0.78 }),
  camera: 'third-person',
});

export const HERO_TILES = Object.freeze({
  'ferry-building': FERRY_BUILDING_TILE,
});

export function heroTileFromSearch(search = '') {
  const params = new URLSearchParams(search);
  const place = params.get('place')?.trim().toLowerCase();
  const tile = place ? HERO_TILES[place] : null;
  if (!tile) return null;
  const mode = params.get('mode')?.trim().toLowerCase();
  return {
    tile,
    mode: mode === 'orbit' ? 'orbit' : 'walk',
  };
}

export function heroTilePolygon(tile) {
  const { minX, minZ, maxX, maxZ } = tile.bounds;
  return [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
  ];
}
