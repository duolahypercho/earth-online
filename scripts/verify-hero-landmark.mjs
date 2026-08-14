import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createFerryBuildingLandmark,
  FERRY_BUILDING_LANDMARK_BUDGET,
  FERRY_BUILDING_LANDMARK_SOURCE,
  FERRY_CLOCK_TOWER_ANCHOR,
  FERRY_SANDSTONE_ALBEDO_URL,
  FERRY_SANDSTONE_NORMAL_URL,
  FERRY_SANDSTONE_ORM_URL,
} from '../src/realmap/hero-landmark.js';

const building = {
  id: 558731934,
  name: 'San Francisco Ferry Building',
  height: 15,
  centroid: [2290.3, 1937.6],
  // Compact fixture matching the long, diagonal OSM terminal character.
  points: [2325.5, 1844.6, 2346.6, 1859.9, 2363.7, 1872.3, 2223, 2018.2, 2206.4, 2006.2, 2325.5, 1844.6],
};
const scene = new THREE.Scene();
const sourceMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
sourceMesh.userData.building = building;
scene.add(sourceMesh);
const landmark = createFerryBuildingLandmark({ scene, building, sourceMesh, elevationAt: () => 1.8 });

assert.equal(FERRY_BUILDING_LANDMARK_SOURCE.osmWay, 558731934, 'landmark must retain the exact OSM way');
assert.equal(FERRY_SANDSTONE_ALBEDO_URL, '/assets/polyhaven-sandstone-blocks-08-diffuse-2k.jpg', 'landmark must use the approved Poly Haven CC0 base color');
assert.equal(FERRY_SANDSTONE_NORMAL_URL, '/assets/polyhaven-sandstone-blocks-08-normal-gl-2k.jpg', 'landmark must use the approved Poly Haven OpenGL normal');
assert.equal(FERRY_SANDSTONE_ORM_URL, '/assets/polyhaven-sandstone-blocks-08-orm-2k.png', 'landmark must use its locally packed Poly Haven ORM asset');
assert.equal(landmark.root.userData.source.osmWay, 558731934, 'source diagnostics must expose the exact OSM way');
assert.ok(scene.children.includes(landmark.root), 'landmark should attach to the caller scene');
assert.equal(sourceMesh.visible, false, 'only the matching supplied source render should be hidden');
assert.equal(landmark.getDiagnostics().source.osmWay, 558731934, 'runtime diagnostics must retain source identity');
assert.equal(landmark.getDiagnostics().hiddenSourceRender, true, 'runtime diagnostics must record suppression');
const frame = landmark.getDiagnostics().frame;
const roofMatrix = new THREE.Matrix4();
const roofVolumes = landmark.root.getObjectByName('Ferry Building gabled terminal roof volumes');
roofVolumes.getMatrixAt(0, roofMatrix);
const roofAlong = new THREE.Vector2(roofMatrix.elements[0], roofMatrix.elements[2]).normalize();
const roofAcross = new THREE.Vector2(roofMatrix.elements[8], roofMatrix.elements[10]).normalize();
assert.ok(roofAlong.dot(new THREE.Vector2(...frame.along)) > 0.9999, 'local +X must align with the footprint along axis');
assert.ok(roofAcross.dot(new THREE.Vector2(...frame.across)) > 0.9999, 'local +Z must align with the footprint across axis');
assert.ok(landmark.stats.drawCalls <= FERRY_BUILDING_LANDMARK_BUDGET.maxDrawCalls, 'draw-call budget must hold');
assert.ok(landmark.stats.triangles <= FERRY_BUILDING_LANDMARK_BUDGET.maxTriangles, 'triangle budget must hold');
assert.ok(landmark.stats.instances <= FERRY_BUILDING_LANDMARK_BUDGET.maxInstances, 'instance budget must hold');
assert.ok(FERRY_BUILDING_LANDMARK_BUDGET.maxDrawCalls <= 14, 'landmark draw-call budget must remain hero-scene safe');
assert.ok(landmark.stats.facadeBaysPerSide >= 18, 'terminal must retain a broad historic bay rhythm');
assert.ok(landmark.stats.storefrontVariants >= 4, 'facade must retain authored storefront variation');
assert.ok(landmark.stats.segmentedFacadeOpenings >= landmark.stats.facadeBaysPerSide * 4, 'both long facades need a ground and upper opening per bay');
assert.ok(landmark.stats.facadeCavityDepthMetres >= 0.65, 'facade apertures must retain pedestrian-readable cavity depth');
assert.ok(landmark.stats.facadeReturnDepthMetres >= 0.6, 'facade apertures must retain real jamb/header/sill returns');
assert.ok(landmark.stats.facadeShadowRevealHeightMetres >= 0.2, 'facade stories require a physical self-shadow reveal, not a painted seam');
assert.ok(landmark.stats.arcadeCentreDivisions >= landmark.stats.facadeBaysPerSide * 2, 'every player-height arcade bay requires an authored centre division');
assert.ok(landmark.stats.clockFaceRecessDepthMetres >= 0.15, 'clock faces require a physical recessed backplate for skyline readability');
assert.equal(landmark.stats.facadeBackingClosed, true, 'authored facade cavities must remain closed rather than exposing a fake interior');
assert.ok(landmark.root.getObjectByName('Ferry Building clock tower pyramidal roof'), 'clock tower silhouette is required');
assert.ok(landmark.root.getObjectByName('Ferry Building clock faces').count === 4, 'all four clock faces are required');
assert.equal(landmark.root.getObjectByName('Ferry Building clock face stone bezels').count, 4, 'clock faces require four stone bezels');
assert.ok(landmark.root.getObjectByName('Ferry Building bronze storefront and window divisions').count > 0, 'recessed glazing needs a bounded mullion pass');
const facadeMaterial = landmark.root.getObjectByName('Ferry Building authoritative OSM footprint shell').material;
const towerMaterial = landmark.root.getObjectByName('Ferry Building clock tower tiers').material;
const windowMaterial = landmark.root.getObjectByName('Ferry Building recessed upper windows and tower louvers').material;
const clockMaterial = landmark.root.getObjectByName('Ferry Building clock faces').material;
assert.ok(facadeMaterial.roughness >= 0.8 && facadeMaterial.metalness === 0, 'facade must retain a matte stone response');
for (const material of [facadeMaterial, towerMaterial]) {
  assert.equal(material.map.colorSpace, THREE.SRGBColorSpace, 'sandstone base color must be decoded as sRGB');
  assert.equal(material.normalMap.colorSpace, THREE.NoColorSpace, 'normal maps must remain linear');
  assert.equal(material.aoMap.colorSpace, THREE.NoColorSpace, 'packed ORM maps must remain linear');
  assert.equal(material.roughnessMap, material.aoMap, 'roughness must sample the packed ORM texture');
  assert.equal(material.metalnessMap, material.aoMap, 'metalness must sample the packed ORM texture');
  assert.equal(material.normalMap.wrapS, THREE.RepeatWrapping, 'normal maps must repeat at facade edges');
  assert.equal(material.roughnessMap.wrapT, THREE.RepeatWrapping, 'ORM maps must repeat at facade edges');
  assert.equal(material.normalMap.minFilter, THREE.LinearMipmapLinearFilter, 'normal maps must minify with mipmaps');
  assert.ok(material.normalMap.anisotropy >= 8, 'normal maps must retain an anisotropic facade response');
}
assert.equal(landmark.getDiagnostics().pbr.presentationOnly, true, 'generated PBR material must never be presented as survey reconstruction');
assert.match(landmark.getDiagnostics().pbr.source, /Poly Haven.*CC0.*Rob Tuytel/, 'PBR diagnostics must retain Poly Haven CC0 provenance');
assert.equal(windowMaterial.transparent, false, 'windows must be opaque recessed glazing rather than a bright transparent grid');
assert.equal(windowMaterial.color.getHex(), 0x9bb8b4, 'upper glazing must retain its muted recessed-cavity response');
assert.ok(windowMaterial.roughness >= 0.48, 'upper glazing must stay matte enough to read as a cavity at card distance');
assert.equal(windowMaterial.metalness, 0, 'upper glazing must not introduce a chrome-like facade response');
assert.equal(clockMaterial.emissiveIntensity, 0, 'clock faces must not use an emissive toy-like treatment');
const windowBays = landmark.root.getObjectByName('Ferry Building ground-floor arched storefronts');
assert.ok(windowBays.geometry.attributes.position.count > 8, 'storefronts must use an authored arched silhouette');
assert.ok(windowBays.instanceColor, 'storefront bay variation must remain in one instanced draw');
const storefrontPalette = new Set();
const instanceColor = new THREE.Color();
for (let index = 0; index < windowBays.count; index += 1) {
  windowBays.getColorAt(index, instanceColor);
  storefrontPalette.add(instanceColor.getHexString());
}
assert.ok(storefrontPalette.size >= 4, 'storefront glazing must contain authored color variation');
const windowAcrossValues = [];
for (let index = 0; index < windowBays.count; index += 1) {
  windowBays.getMatrixAt(index, roofMatrix);
  const relative = new THREE.Vector2(
    roofMatrix.elements[12] - building.centroid[0],
    roofMatrix.elements[14] - building.centroid[1],
  );
  windowAcrossValues.push(relative.dot(new THREE.Vector2(...frame.across)));
}
assert.ok(Math.abs(Math.min(...windowAcrossValues) - frame.bounds.minAcross) < 0.5, 'landside windows must hug the authoritative footprint surface');
assert.ok(Math.abs(Math.max(...windowAcrossValues) - frame.bounds.maxAcross) < 0.5, 'bayside windows must hug the authoritative footprint surface');
const surroundAcrossValues = [];
const groundArcade = landmark.root.getObjectByName('Ferry Building segmented ground arcade masonry');
const upperFacade = landmark.root.getObjectByName('Ferry Building segmented upper facade masonry');
assert.equal(groundArcade.count, landmark.stats.facadeBaysPerSide * 2, 'each ground bay must be bounded by a masonry surround');
assert.equal(upperFacade.count, landmark.stats.facadeBaysPerSide * 2, 'each upper bay must be bounded by a masonry surround');
assert.equal(groundArcade.geometry.parameters.shapes.holes.length, 1, 'ground surrounds need a true arched aperture in their wall geometry');
assert.equal(upperFacade.geometry.parameters.shapes.holes.length, 1, 'upper surrounds need a true rectangular aperture in their wall geometry');
for (let index = 0; index < groundArcade.count; index += 1) {
  groundArcade.getMatrixAt(index, roofMatrix);
  const relative = new THREE.Vector2(roofMatrix.elements[12] - building.centroid[0], roofMatrix.elements[14] - building.centroid[1]);
  surroundAcrossValues.push(relative.dot(new THREE.Vector2(...frame.across)));
}
assert.ok(Math.min(...surroundAcrossValues) < Math.min(...windowAcrossValues) - 0.35, 'landside masonry surrounds must project beyond recessed storefront glazing');
assert.ok(Math.max(...surroundAcrossValues) > Math.max(...windowAcrossValues) + 0.35, 'bayside masonry surrounds must project beyond recessed storefront glazing');
assert.equal(groundArcade.material, facadeMaterial, 'segmented ground masonry must retain the Poly Haven sandstone material');
assert.equal(upperFacade.material, facadeMaterial, 'segmented upper masonry must retain the Poly Haven sandstone material');
roofVolumes.geometry.computeBoundingBox();
assert.ok(roofVolumes.geometry.boundingBox.max.y - roofVolumes.geometry.boundingBox.min.y > 0.9, 'terminal wings must use pitched roof volumes');
const clockFaces = landmark.root.getObjectByName('Ferry Building clock faces');
const shadowCourses = landmark.root.getObjectByName('Ferry Building weathered plinth and tower shadow courses');
assert.ok(shadowCourses.count >= 10, 'shadow-course batch must include facade reveals and all four clock backplates');
const clockNormals = [];
const clockCenters = [];
for (let index = 0; index < clockFaces.count; index += 1) {
  clockFaces.getMatrixAt(index, roofMatrix);
  clockNormals.push(new THREE.Vector2(roofMatrix.elements[8], roofMatrix.elements[10]).normalize());
  clockCenters.push(new THREE.Vector2(roofMatrix.elements[12], roofMatrix.elements[14]));
}
const frameAxes = [new THREE.Vector2(...frame.along), new THREE.Vector2(...frame.across)];
for (const axis of frameAxes) {
  assert.ok(clockNormals.some((normal) => Math.abs(normal.dot(axis)) > 0.9999), 'clock faces must remain normal to each footprint frame axis');
}
const towerMatrix = new THREE.Matrix4();
const towerTiers = landmark.root.getObjectByName('Ferry Building clock tower tiers');
towerTiers.getMatrixAt(0, towerMatrix);
const towerWorld = new THREE.Vector2(towerMatrix.elements[12], towerMatrix.elements[14]);
const clockCenter = clockCenters.reduce((sum, center) => sum.add(center), new THREE.Vector2()).multiplyScalar(1 / clockCenters.length);
assert.ok(clockCenter.distanceTo(towerWorld) < 1e-3, 'clock faces must remain centered around the clock tower anchor');
const marketAxisLandside = new THREE.Vector2(2259.739, 1918.918);
const marketAxisBayside = new THREE.Vector2(2299.660, 1959.198);
const marketAxisTarget = marketAxisLandside.clone().add(marketAxisBayside).multiplyScalar(0.5);
const marketAxisSpan = marketAxisBayside.clone().sub(marketAxisLandside);
const marketAxisProgress = towerWorld.clone().sub(marketAxisLandside).dot(marketAxisSpan) / marketAxisSpan.lengthSq();
assert.ok(towerWorld.distanceTo(marketAxisTarget) < 8, 'clock tower must stay near the central Market Street axis target');
assert.ok(marketAxisProgress >= 0 && marketAxisProgress <= 1, 'clock tower must remain between both Market-axis footprint intersections');
assert.ok(towerWorld.x >= marketAxisLandside.x && towerWorld.x <= marketAxisBayside.x, 'clock tower x must remain inside the Market-axis intersection bounds');
assert.ok(towerWorld.y >= marketAxisLandside.y && towerWorld.y <= marketAxisBayside.y, 'clock tower z must remain inside the Market-axis intersection bounds');
const relativeTower = towerWorld.clone().sub(new THREE.Vector2(...building.centroid));
const towerAlong = relativeTower.dot(new THREE.Vector2(...frame.along));
const towerAcross = relativeTower.dot(new THREE.Vector2(...frame.across));
assert.ok(towerAlong >= frame.bounds.minAlong && towerAlong <= frame.bounds.maxAlong, 'clock tower must remain within authoritative along bounds');
assert.ok(towerAcross >= frame.bounds.minAcross && towerAcross <= frame.bounds.maxAcross, 'clock tower must remain within authoritative across bounds');
assert.ok(towerWorld.distanceTo(new THREE.Vector2(landmark.getDiagnostics().towerAnchor[0], landmark.getDiagnostics().towerAnchor[2])) < 5e-4, 'tower diagnostics must report its true world anchor');
assert.equal(landmark.getDiagnostics().towerHeightMetres, 74, 'clock tower must retain its documented approximately 245 ft scale');
const finalTierMatrix = new THREE.Matrix4();
towerTiers.getMatrixAt(2, finalTierMatrix);
const finalTierScale = new THREE.Vector3();
finalTierMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), finalTierScale);
const finalTierTop = finalTierMatrix.elements[13] + finalTierScale.y * 0.5;
const towerRoof = landmark.root.getObjectByName('Ferry Building clock tower pyramidal roof');
towerRoof.geometry.computeBoundingBox();
towerRoof.updateMatrixWorld(true);
const towerRoofBounds = towerRoof.geometry.boundingBox.clone().applyMatrix4(towerRoof.matrixWorld);
const documentedAnchor = landmark.getDiagnostics().towerAnchor;
assert.ok(Math.abs(towerRoofBounds.min.y - finalTierTop) < 1e-5, 'pyramidal roof must sit directly on the final tower tier');
assert.ok(Math.abs(towerRoofBounds.max.y - documentedAnchor[1] - 74) < 1e-4, 'rendered tower geometry must reach its documented 74 m height');
assert.ok(Math.abs(documentedAnchor[0] - FERRY_CLOCK_TOWER_ANCHOR[0]) < 1e-4, 'tower X anchor must remain fixed to the Ferry Building OSM-world location');
assert.ok(Math.abs(documentedAnchor[1] - FERRY_CLOCK_TOWER_ANCHOR[1]) < 1e-4, 'tower Y anchor must remain fixed to sampled ground plus base lift');
assert.ok(Math.abs(documentedAnchor[2] - FERRY_CLOCK_TOWER_ANCHOR[2]) < 1e-4, 'tower Z anchor must remain fixed to the Ferry Building OSM-world location');

const unrelated = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
unrelated.userData.buildingId = 999;
const noHide = createFerryBuildingLandmark({ scene: new THREE.Scene(), building, sourceMesh: unrelated });
assert.equal(unrelated.visible, true, 'unrelated source render must never be hidden');
noHide.dispose();

assert.throws(
  () => createFerryBuildingLandmark({ scene: new THREE.Scene(), building: { ...building, id: 999 } }),
  /refused/,
  'missing the exact source building must fail closed',
);
landmark.update(1 / 30);
landmark.dispose();
assert.equal(landmark.disposed, true, 'dispose should be idempotently recorded');
assert.equal(landmark.root.parent, null, 'dispose should detach the landmark');
assert.equal(sourceMesh.visible, true, 'dispose should restore matching source visibility');
assert.equal(landmark.getDiagnostics().disposed, true, 'runtime diagnostics should report lifecycle state');

console.log(JSON.stringify({
  result: 'passed',
  source: FERRY_BUILDING_LANDMARK_SOURCE,
  towerWorld: landmark.getDiagnostics().towerAnchor,
  marketAxisTarget: marketAxisTarget.toArray(),
  stats: landmark.stats,
}, null, 2));
