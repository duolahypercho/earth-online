import * as THREE from 'three';
import { existsSync } from 'node:fs';
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
const cardinalFixture = createFerryBuildingStreetscape({
  scene: new THREE.Scene(),
  tileBounds,
  elevationAt: () => 0,
  isSea: () => false,
  roads: [{ id: 26769726, name: 'Cardinal test', width: 8, points: [2200, 1800, 2250, 1800] }],
});
const diagonalFixture = createFerryBuildingStreetscape({
  scene: new THREE.Scene(),
  tileBounds,
  elevationAt: () => 0,
  isSea: () => false,
  roads: [{ id: 26769726, name: 'Diagonal test', width: 8, points: [2200, 1800, 2240, 1840] }],
});
const suppressedFixture = createFerryBuildingStreetscape({
  scene: new THREE.Scene(),
  tileBounds,
  elevationAt: () => 0,
  isSea: () => false,
  existingSurfaceLayers: { curbs: true, sidewalks: true },
  roads: [{ id: 26769726, name: 'Suppression test', width: 8, points: [2200, 1800, 2240, 1840] }],
});
const suppressedTransitionFixture = createFerryBuildingStreetscape({
  scene: new THREE.Scene(),
  tileBounds,
  elevationAt: () => 1.8,
  isSea: () => false,
  roadSurfaceLift: 0.46,
  existingSurfaceLayers: { curbs: true, sidewalks: true },
  roads: [{
    id: 283512618,
    name: 'The Embarcadero',
    width: 6.5,
    points: [[2169.7, 1947.1], [2264.2, 1824.2]],
  }],
});

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
};

const findMesh = (fixture, name) => fixture.root.children.find((child) => child.name === name);
const readInstanceMatrix = (mesh, index = 0) => {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  return matrix;
};
const assertMatrixAxis = (label, mesh, instanceIndex, column, expected) => {
  if (!mesh || mesh.count <= instanceIndex) return fail(`${label} instance missing`);
  const actual = new THREE.Vector3().setFromMatrixColumn(readInstanceMatrix(mesh, instanceIndex), column).normalize();
  if (actual.distanceTo(expected) > 1e-5) {
    fail(`${label} axis ${actual.toArray()} did not match ${expected.toArray()}`);
  }
};

if (!scene.children.includes(streetscape.root)) fail('streetscape did not attach to provided scene');
if (!streetscape.root.userData.heroStreetscape) fail('source-aligned root marker missing');
if (FERRY_BUILDING_STREETSCAPE_SOURCE.ferryBuildingWay !== 558731934) fail('Ferry Building source way changed');
if (streetscape.stats.drawCalls > FERRY_BUILDING_STREETSCAPE_BUDGET.maxDrawCalls) fail('draw-call budget exceeded');
if (streetscape.stats.drawCalls !== 18) fail('close-range curb transition pass did not retain its bounded batch budget');
if (streetscape.stats.instances > FERRY_BUILDING_STREETSCAPE_BUDGET.maxInstances) fail('instance budget exceeded');
if (streetscape.stats.triangles > FERRY_BUILDING_STREETSCAPE_BUDGET.maxTriangles) fail('triangle budget exceeded');
if (streetscape.stats.roads.length !== FERRY_BUILDING_STREETSCAPE_SOURCE.roadIds.length) {
  fail('expected OSM-aligned road details are absent');
}
if (streetscape.stats.pavingPaths.length !== FERRY_BUILDING_STREETSCAPE_SOURCE.pavingPathIds.length) {
  fail('expected Market Street OSM paving paths are absent');
}
if (streetscape.stats.derivedCrossings !== 2) fail('expected two source-derived Embarcadero crossings');
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
if (fallbackFixture.stats.roads.length !== FERRY_BUILDING_STREETSCAPE_SOURCE.roadIds.length) {
  fail('defaults were not restored when no matching caller road remained');
}

const cardinalCurb = findMesh(cardinalFixture, 'OSM-aligned curb returns');
const cardinalMarking = findMesh(cardinalFixture, 'OSM road markings');
assertMatrixAxis('cardinal curb', cardinalCurb, 0, 0, new THREE.Vector3(1, 0, 0));
assertMatrixAxis('cardinal crosswalk', cardinalMarking, cardinalMarking.count - 1, 2, new THREE.Vector3(0, 0, 1));
const diagonalCurb = findMesh(diagonalFixture, 'OSM-aligned curb returns');
const diagonalMarking = findMesh(diagonalFixture, 'OSM road markings');
const diagonalDirection = new THREE.Vector3(1, 0, 1).normalize();
const diagonalNormal = new THREE.Vector3(-1, 0, 1).normalize();
assertMatrixAxis('diagonal curb', diagonalCurb, 0, 0, diagonalDirection);
assertMatrixAxis('diagonal crosswalk', diagonalMarking, diagonalMarking.count - 1, 2, diagonalNormal);

const suppressedCurbs = findMesh(suppressedFixture, 'OSM-aligned curb returns');
const suppressedSlabs = findMesh(suppressedFixture, 'Ferry Plaza sidewalk slabs');
const retainedSeams = findMesh(suppressedFixture, 'Sidewalk expansion seams');
const retainedMarkings = findMesh(suppressedFixture, 'OSM road markings');
const retainedFurniture = findMesh(suppressedFixture, 'Ferry Plaza bollards');
const retainedPaving = findMesh(suppressedFixture, 'Market Street OSM paving finish');
const retainedGutters = findMesh(suppressedFixture, 'Road-edge gutters and curb drains');
if (suppressedCurbs.count || suppressedSlabs.count) {
  fail('existing surface ownership did not suppress curb and sidewalk instances');
}
if (!retainedSeams.count || !retainedMarkings.count || !retainedFurniture.count || !retainedPaving.count || !retainedGutters.count) {
  fail('surface suppression removed retained paving, seams, markings, furniture, or non-duplicative gutters');
}
if (suppressedFixture.stats.layers.curbs || suppressedFixture.stats.layers.sidewalkSlabs) {
  fail('suppressed layer diagnostics are incorrect');
}
const transitionCurbs = findMesh(suppressedTransitionFixture, 'OSM-aligned curb returns');
const transitionTactile = findMesh(suppressedTransitionFixture, 'Source-derived tactile crossing plates');
const transitionTactileDots = findMesh(suppressedTransitionFixture, 'Source-derived tactile warning dots');
const transitionDrainage = findMesh(suppressedTransitionFixture, 'Road-edge gutters and curb drains');
if (transitionCurbs.count !== 0 || transitionTactile.count !== 2
  || transitionTactileDots.count !== 8 || transitionDrainage.count !== 8) {
  fail('existing curb ownership did not retain only non-duplicative source-derived transition detail');
}
const suppressedRoadY = 1.8 + 0.46;
const transitionGutterY = new THREE.Vector3().setFromMatrixPosition(readInstanceMatrix(transitionDrainage, 0)).y;
const transitionDrainY = new THREE.Vector3().setFromMatrixPosition(readInstanceMatrix(transitionDrainage, 2)).y;
const transitionTactileY = new THREE.Vector3().setFromMatrixPosition(readInstanceMatrix(transitionTactile)).y;
const transitionTactileDotY = new THREE.Vector3().setFromMatrixPosition(readInstanceMatrix(transitionTactileDots)).y;
if (Math.abs(transitionGutterY - (suppressedRoadY + 0.013)) > 1e-6
  || Math.abs(transitionDrainY - (suppressedRoadY + 0.014)) > 1e-6
  || Math.abs(transitionTactileY - (suppressedRoadY + 0.092)) > 1e-6
  || Math.abs(transitionTactileDotY - (suppressedRoadY + 0.124)) > 1e-6) {
  fail('suppressed curb transition detail is not lifted from its road/sidewalk datum');
}
if (Math.abs((transitionTactileDotY - 0.02) - (transitionTactileY + 0.012)) > 1e-6) {
  fail('tactile warning dots do not sit flush on the tactile plate');
}

const baseMarking = findMesh(streetscape, 'OSM road markings');
const pavingFinish = findMesh(streetscape, 'Market Street OSM paving finish');
const facadeRelief = findMesh(streetscape, 'Ferry Building facade relief');
const drainageDetails = findMesh(streetscape, 'Road-edge gutters and curb drains');
const tactilePlates = findMesh(streetscape, 'Source-derived tactile crossing plates');
const tactileDots = findMesh(streetscape, 'Source-derived tactile warning dots');
const markingY = new THREE.Vector3().setFromMatrixPosition(readInstanceMatrix(baseMarking)).y;
const facadeY = new THREE.Vector3().setFromMatrixPosition(readInstanceMatrix(facadeRelief)).y;
if (Math.abs(markingY - (1.8 + 0.46 + 0.012)) > 1e-6) fail('marking lift is not relative to the road surface');
if (Math.abs(facadeY - (1.8 + 0.02 + 2.06)) > 1e-6) fail('facade relief incorrectly inherited the road surface lift');
const firstPavingDirection = new THREE.Vector3(33.4, 0, 33.7).normalize();
assertMatrixAxis('Market Street paving', pavingFinish, 0, 0, firstPavingDirection);
const pavingY = new THREE.Vector3().setFromMatrixPosition(readInstanceMatrix(pavingFinish)).y;
if (Math.abs(pavingY - (1.8 + 0.014)) > 1e-6) fail('pedestrian paving inherited the raised road datum');
if (!pavingFinish.count) fail('paving hierarchy is absent');
if (!existsSync(new URL('../public/assets/sf-ferry-plaza-pavers-albedo-v1.png', import.meta.url))) {
  fail('generated Ferry plaza paver albedo is absent');
}
if (pavingFinish.material.map.colorSpace !== THREE.SRGBColorSpace
  || pavingFinish.material.map.wrapS !== THREE.RepeatWrapping
  || pavingFinish.material.map.wrapT !== THREE.RepeatWrapping
  || pavingFinish.material.map.anisotropy !== 8
  || pavingFinish.material.map.userData.physicalRepeatMeters !== 2.5) {
  fail('paver albedo fallback is not color-managed and world-repeat configured');
}
if (streetscape.stats.pavingAlbedo.generatedAlbedoRequested
  || streetscape.stats.pavingAlbedo.source !== 'procedural-fallback') {
  fail('node verifier did not gracefully retain the procedural paver fallback');
}
const paverMix = pavingFinish.geometry.getAttribute('pavingAlbedoMix');
if (!paverMix || !Array.from(paverMix.array.slice(0, pavingFinish.count)).includes(1)
  || !Array.from(paverMix.array.slice(0, pavingFinish.count)).includes(0)) {
  fail('generated plaza pavers were not restricted to paving_stones instances');
}
if (pavingFinish.material.customProgramCacheKey?.() !== 'ferry-world-paving-2.500-0.640') {
  fail('paver albedo is not world projected with the 64% 2.5m texture blend');
}
if (streetscape.stats.curbTransitions.length !== 2
  || streetscape.stats.curbTransitionDetail.tactilePlates !== 4
  || streetscape.stats.curbTransitionDetail.tactileDots !== 16
  || streetscape.stats.curbTransitionDetail.drainBars !== 12
  || streetscape.stats.curbTransitionDetail.curbRamps !== 4) {
  fail('source-derived curb crossing transition detail is incomplete');
}
if (drainageDetails.count !== 20 || tactilePlates.count !== 4 || tactileDots.count !== 16) {
  fail('close-range curb, gutter, tactile, or drain geometry is incomplete');
}
if (streetscape.stats.roadEdgeGutters !== 8 || !drainageDetails.material.vertexColors) {
  fail('road-edge gutter hierarchy did not retain its bounded per-instance material finish');
}
const gutterColor = new THREE.Color();
const drainBarColor = new THREE.Color();
drainageDetails.getColorAt(0, gutterColor);
drainageDetails.getColorAt(streetscape.stats.roadEdgeGutters, drainBarColor);
if (gutterColor.getHex() === drainBarColor.getHex() || gutterColor.getHSL({}).l <= drainBarColor.getHSL({}).l) {
  fail('road-edge gutter highlight does not separate from the source-derived drain bars');
}
const gutterY = new THREE.Vector3().setFromMatrixPosition(readInstanceMatrix(drainageDetails)).y;
if (Math.abs(gutterY - (1.8 + 0.46 + 0.013)) > 1e-6) fail('gutter seam did not retain a non-z-fighting road-surface lift');

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
if (curb < 28) fail('curb face, capstone, and source-derived ramp detail is incomplete');

streetscape.setConditions({ wetness: 0.85 });
streetscape.update(1 / 30);
if (pavingFinish.material.roughness > 0.33) fail('drizzle did not create a materially smooth paving response');
if (pavingFinish.material.envMapIntensity < 1.2) fail('drizzle did not create a visible distributed paving reflection response');
if (drainageDetails.material.roughness > 0.22) fail('drizzle did not create a materially smooth curb-edge gutter response');
streetscape.dispose();
if (!streetscape.disposed || scene.children.includes(streetscape.root)) fail('dispose did not detach streetscape');
flatFixture.dispose();
nestedFixture.dispose();
fallbackFixture.dispose();
cardinalFixture.dispose();
diagonalFixture.dispose();
suppressedFixture.dispose();
suppressedTransitionFixture.dispose();

if (!process.exitCode) {
  console.log(JSON.stringify({
    result: 'passed',
    source: FERRY_BUILDING_STREETSCAPE_SOURCE,
    stats: streetscape.stats,
    flatFixture: flatFixture.stats,
    suppressedFixture: suppressedFixture.stats,
    suppressedTransitionFixture: suppressedTransitionFixture.stats,
    budget: FERRY_BUILDING_STREETSCAPE_BUDGET,
    detail: { facade, markings, curb },
  }, null, 2));
}
