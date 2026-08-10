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

if (!process.exitCode) {
  console.log(JSON.stringify({
    result: 'passed',
    source: FERRY_BUILDING_STREETSCAPE_SOURCE,
    stats: streetscape.stats,
    budget: FERRY_BUILDING_STREETSCAPE_BUDGET,
    detail: { facade, markings, curb },
  }, null, 2));
}
