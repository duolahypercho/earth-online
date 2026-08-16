import {
  deriveBuildingEntrances,
  summarizeInteriorCoverage,
} from '../../src/citygen/interiors.js';

export const sfBuildingInteriorsPlugin = Object.freeze({
  id: 'sf-building-interiors',
  name: 'San Francisco building interiors',
  worldId: 'sf',
  owner: 'simulation',
  kind: 'world-feature',
  runtimeEntry: 'plugins/sf-building-interiors/index.js',
  verificationPage: 'plugins/sf-building-interiors/verify.html',
  load({ city }) {
    const portals = deriveBuildingEntrances(city);
    return {
      portals,
      coverage: summarizeInteriorCoverage(city, portals),
    };
  },
});

export default sfBuildingInteriorsPlugin;
