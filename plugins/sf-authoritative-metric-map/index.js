import { loadAuthoritativeFerryTiles } from '../../src/citygen/metric-tile-stream.js';

export const sfAuthoritativeMetricMapPlugin = Object.freeze({
  id: 'sf-authoritative-metric-map',
  name: 'Authoritative SF metric map',
  worldId: 'sf',
  owner: 'map',
  kind: 'map-source',
  runtimeEntry: 'plugins/sf-authoritative-metric-map/index.js',
  verificationPage: 'plugins/sf-authoritative-metric-map/verify.html',
  load(options) {
    return loadAuthoritativeFerryTiles(options);
  },
});

export default sfAuthoritativeMetricMapPlugin;
