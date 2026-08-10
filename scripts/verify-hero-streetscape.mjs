import * as THREE from 'three';
import {
  createFerryBuildingStreetscape,
  FERRY_BUILDING_STREETSCAPE_BUDGET,
  FERRY_BUILDING_STREETSCAPE_SOURCE,
} from '../src/realmap/hero-streetscape.js';

const scene = new THREE.Scene();
const tileBounds = { minX: 2144, minZ: 1728, maxX: 2528, maxZ: 2112 };
const streetscape = createFerryBuildingStreetscape({
  scene,
  tileBounds,
  elevationAt: () => 1.8,
  isSea: () => false,
  roadSurfaceLift: 0.46,
});
const flatFixture = createFerryBuildingStreetscape({
  scene: new THREE.Scene(),
  tileBounds,
  elevationAt: () => 1.8,
  isSea: () => false,
  roads: [
    { id: 26769726, name: 'Ferry Plaza', width: '9.4 m', points: [2320.3, 1820.6, 2372.5, 1871.6] },
    { id: 88463826, name: 'The Embarcadero', lanes: '3', points: [2314.9, 1815, 2295.6, 1837.9] },
    { id: 88463827, name: 'The Embarcadero', lanes: 2, laneWidthM: 3.6, points: [2357.4, 1738.2, 2389, 1702] },
    { id: 88463831, name: 'Mission Street', lanes: 3, points: [2357.4, 1738.2, 2304.7, 1685.8] },
    { id: 999, name: 'Ignored unrelated road', width: 16, points: [2145, 1730, 2150, 1740] },
  ],
});
const nestedFixture = createFerryBuildingStreetscape({
  scene: new THREE.Scene(),
  tileBounds,
  elevationAt: () => 1.8,
  isSea: () => false,
  roads: [{ id: 26769726, name: 'Ferry Plaza', lanes: 2, points: [[2320.3, 1820.6], [2372.5, 1871.6]] }],
});
const fallbackFixture = createFerryBuildingStreetscape({
  scene: new THREE.Scene(),
  tileBounds,
  elevationAt: () => 1.8,
  isSea: () => false,
  roads: [
    { id: 26769726, name: 'Malformed matching road', points: [2320.3, 1820.6, 2372.5] },
    { id: 999, name: 'Ignored unrelated road', points: [2145, 1730, 2150, 1740] },
  ],
});

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
};

if (!scene.children.includes(streetscape.root)) fail('streetscape did not attach to provided scene');
if (!streetscape.root.userData.heroStreetscape) fail('source-aligned root marker missing');
if (FERRY_BUILDING_STREETSCAPE_SOURCE.ferryBuildingWay !== 558731934) fail('Ferry Building source way changed');
if (streetscape.stats.drawCalls > FERRY_BUILDING_STREETSCAPE_BUDGET.maxDrawCalls) fail('draw-call budget exceeded');
if (streetscape.stats.instances > FERRY_BUILDING_STREETSCAPE_BUDGET.maxInstances) fail('instance budget exceeded');
if (streetscape.stats.triangles > FERRY_BUILDING_STREETSCAPE_BUDGET.maxTriangles) fail('triangle budget exceeded');
if (streetscape.stats.roads.length < 4) fail('expected OSM-aligned road details are absent');
if (flatFixture.stats.roads.length !== 4 || flatFixture.stats.roads.some((road) => road.id === 999)) {
  fail('flat OSM points did not retain only matching caller roads');
}
const flatWidths = new Map(flatFixture.stats.roads.map((road) => [road.id, road.width]));
if (flatWidths.get(26769726) !== 9.4 || flatWidths.get(88463826) !== 9.75 || flatWidths.get(88463827) !== 7.2) {
  fail('caller source width fields were not resolved deterministically');
}
if (nestedFixture.stats.roads.length !== 1 || nestedFixture.stats.roads[0].id !== 26769726) {
  fail('nested point pairs did not retain a valid matching caller road');
}
if (fallbackFixture.stats.roads.length !== 4) fail('defaults were not restored when no matching caller road remained');

let facade = 0;
let markings = 0;
let curb = 0;
streetscape.root.traverse((object) => {
  if (!object.isInstancedMesh) return;
  if (object.name.includes('facade')) facade += object.count;
  if (object.name.includes('markings')) markings += object.count;
  if (object.name.includes('curb')) curb += object.count;
});
if (!facade || !markings || !curb) fail('expected facade, marking, and curb detail batches');

streetscape.setConditions({ wetness: 0.85 });
streetscape.update(1 / 30);
streetscape.dispose();
if (!streetscape.disposed || scene.children.includes(streetscape.root)) fail('dispose did not detach streetscape');
flatFixture.dispose();
nestedFixture.dispose();
fallbackFixture.dispose();

if (!process.exitCode) {
  console.log(JSON.stringify({
    result: 'passed',
    source: FERRY_BUILDING_STREETSCAPE_SOURCE,
    stats: streetscape.stats,
    flatFixture: flatFixture.stats,
    budget: FERRY_BUILDING_STREETSCAPE_BUDGET,
    detail: { facade, markings, curb },
  }, null, 2));
}
