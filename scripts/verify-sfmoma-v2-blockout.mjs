import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import * as THREE from 'three';
import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_RELATIVE_PATH = 'src/citygen/landmarks/sfmoma-generated-v2.js';
const MODULE_PATH = path.join(REPO_ROOT, MODULE_RELATIVE_PATH);
const SPEC_PATH = path.join(REPO_ROOT, '.img2threejs/sfmoma-v2/object-sculpt-spec.json');
const REFERENCE_PATH = path.join(REPO_ROOT, 'public/assets/hero/sfmoma-img2threejs-v2/reference.png');
const QA_URL = process.env.SF_QA_URL || 'http://127.0.0.1:5173/';
const FIXED_TIME = 15;
const QA_ROOT_Y = 500;
const VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const PASS_ID = 'sfmoma-v2-blockout-v1';
const CANONICAL_BUILDING_ID = 'sf-building-41692824';
const REFERENCE_SHA256 = 'a5fc2bf43c65fc5ac065b1f8a7b5f0f27101e2339653cd4d20521f695460b4e6';

const COMPONENT_IDS = Object.freeze([
  'granitePodium',
  'brickWings',
  'brickCentralTower',
  'stripedTurret',
  'rippledExpansion',
  'glassAtriumCore',
]);
const FEATURE_IDS = Object.freeze(['oculusAssembly', 'oculusGlazing']);
const MESH_IDS = Object.freeze([...COMPONENT_IDS, 'oculusRing', 'oculusGlazing']);
const MATERIAL_IDS = Object.freeze(['granite', 'brick', 'stripedStone', 'frp', 'glass']);
const REPETITION_IDS = Object.freeze([
  'brickCourseRelief',
  'brickMortarJointGrid',
  'turretBandCourses',
  'oculusMullionRadials',
  'curtainWallMullionGrid',
  'frpRippleCourses',
  'podiumWindowArray',
  'oculusAnnulusLightStripes',
  'oculusAnnulusDarkStripes',
]);
const COMPONENT_TRANSFORMS = Object.freeze({
  granitePodium: { position: [0, 0.08, 0], dimensions: [1, 0.16, 0.42] },
  brickWings: { position: [-0.02, 0.4, 0.03], dimensions: [0.96, 0.64, 0.3] },
  brickCentralTower: { position: [-0.14, 0.51, -0.02], dimensions: [0.25, 0.86, 0.28] },
  stripedTurret: { position: [0.02, 0.53, 0.09], dimensions: [0.27, 0.74, 0.27] },
  rippledExpansion: { position: [0.24, 0.51, -0.03], dimensions: [0.58, 0.7, 0.24] },
  glassAtriumCore: { position: [0.17, 0.44, 0.18], dimensions: [0.14, 0.56, 0.1] },
});
const COMPONENT_MATERIALS = Object.freeze({
  granitePodium: 'granite',
  brickWings: 'brick',
  brickCentralTower: 'brick',
  stripedTurret: 'stripedStone',
  rippledExpansion: 'frp',
  glassAtriumCore: 'glass',
});
const SOURCE_BOUNDARY = Object.freeze({
  canonicalBuildingId: CANONICAL_BUILDING_ID,
  horizontalCrs: 'EPSG:26910',
  worldUnits: 'metres',
  authority: 'canonical OSM building polygon, height/source status, collision, terrain contact, portals, and building identity',
  assetRole: 'presentation-only blockout; source-safe near-LOD candidate',
  replacesCanonicalGeometry: false,
  mutatesCanonicalSource: false,
  referenceDimensions: 'reference-relative-not-surveyed',
  verticalStatus: 'preserved-by-canonical-source; not asserted by this asset',
  hiddenElevations: 'conservative attached approximations',
});
const SOURCE = Object.freeze({
  id: 'sfmoma-source-honest-landmark-v2',
  reference: '/assets/hero/sfmoma-img2threejs-v2/reference.png',
  referenceSha256: REFERENCE_SHA256,
  reconstruction: 'single-generated-reference-procedural-threejs-blockout',
  stage: 'blockout',
  presentationOnly: true,
  hiddenElevations: 'conservative-continuity-approximation',
  dimensionAuthority: 'reference-relative-not-surveyed',
});
const BUDGET = Object.freeze({
  maxDrawCalls: 8,
  maxTriangles: 4096,
  maxGeometries: 8,
  maxMaterials: 5,
  maxTextures: 0,
});
const OUTPUTS = Object.freeze({
  frontThreeQuarter: path.join(REPO_ROOT, '.qa-sfmoma-v2-blockout-front-three-quarter.png'),
  right: path.join(REPO_ROOT, '.qa-sfmoma-v2-blockout-right.png'),
  rear: path.join(REPO_ROOT, '.qa-sfmoma-v2-blockout-rear.png'),
  left: path.join(REPO_ROOT, '.qa-sfmoma-v2-blockout-left.png'),
  elevated: path.join(REPO_ROOT, '.qa-sfmoma-v2-blockout-elevated.png'),
  comparison: path.join(REPO_ROOT, '.qa-sfmoma-v2-blockout-comparison.png'),
  metrics: path.join(REPO_ROOT, '.qa-sfmoma-v2-blockout-metrics.json'),
});
const VIEWS = Object.freeze([
  { id: 'frontThreeQuarter', label: 'Front three-quarter', positionOffset: [58, 33, 72], targetOffset: [0, 18, 0], fov: 38 },
  { id: 'right', label: 'Right', positionOffset: [84, 27, 0], targetOffset: [0, 18, 0], fov: 38 },
  { id: 'rear', label: 'Rear', positionOffset: [-52, 31, -74], targetOffset: [0, 18, 0], fov: 38 },
  { id: 'left', label: 'Left', positionOffset: [-84, 27, 0], targetOffset: [0, 18, 0], fov: 38 },
  { id: 'elevated', label: 'Elevated orbit', positionOffset: [57, 72, 64], targetOffset: [0, 18, 0], fov: 40 },
]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function roundArray(values, precision = 8) {
  const scale = 10 ** precision;
  return values.map((value) => Math.round(value * scale) / scale);
}

function assertVector(actual, expected, label, epsilon = 1e-8) {
  assert.equal(actual.length, expected.length, `${label} length`);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= epsilon,
      `${label}[${index}] expected ${expected[index]}, received ${value}`);
  });
}

function attributeHash(attribute) {
  const { array } = attribute;
  return sha256(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
}

function geometrySnapshot(geometry) {
  geometry.computeBoundingBox();
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  return {
    type: geometry.type,
    positionCount: position.count,
    normalCount: normal.count,
    indexCount: geometry.index?.count || 0,
    positionHash: attributeHash(position),
    normalHash: attributeHash(normal),
    indexHash: geometry.index ? attributeHash(geometry.index) : null,
    bounds: {
      min: roundArray(geometry.boundingBox.min.toArray()),
      max: roundArray(geometry.boundingBox.max.toArray()),
    },
  };
}

function assertGeometryIntegrity(mesh, aggregate) {
  const { geometry } = mesh;
  assert.ok(geometry?.isBufferGeometry, `${mesh.name} BufferGeometry`);
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  assert.ok(position && position.itemSize === 3 && position.count >= 3, `${mesh.name} positions`);
  assert.ok(normal && normal.itemSize === 3, `${mesh.name} normals`);
  assert.equal(normal.count, position.count, `${mesh.name} normal count`);
  assert.ok(Array.from(position.array).every(Number.isFinite), `${mesh.name} finite positions`);
  assert.ok(Array.from(normal.array).every(Number.isFinite), `${mesh.name} finite normals`);

  for (let index = 0; index < normal.count; index += 1) {
    const length = Math.hypot(normal.getX(index), normal.getY(index), normal.getZ(index));
    assert.ok(Number.isFinite(length) && length > 0.5 && length < 1.5,
      `${mesh.name} usable normal ${index}: ${length}`);
  }

  const indices = geometry.index
    ? Array.from(geometry.index.array)
    : Array.from({ length: position.count }, (_, index) => index);
  assert.equal(indices.length % 3, 0, `${mesh.name} triangle index alignment`);
  assert.ok(indices.length >= 3, `${mesh.name} has triangles`);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const ai = indices[offset];
    const bi = indices[offset + 1];
    const ci = indices[offset + 2];
    assert.ok(Number.isInteger(ai) && ai >= 0 && ai < position.count, `${mesh.name} index a`);
    assert.ok(Number.isInteger(bi) && bi >= 0 && bi < position.count, `${mesh.name} index b`);
    assert.ok(Number.isInteger(ci) && ci >= 0 && ci < position.count, `${mesh.name} index c`);
    a.fromBufferAttribute(position, ai);
    b.fromBufferAttribute(position, bi);
    c.fromBufferAttribute(position, ci);
    const doubledArea = cross.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).length();
    assert.ok(Number.isFinite(doubledArea) && doubledArea > 1e-10,
      `${mesh.name} positive triangle area at ${offset / 3}: ${doubledArea / 2}`);
  }
  aggregate.triangles += indices.length / 3;
  aggregate.vertices += position.count;
}

function modelSnapshot(asset) {
  const materialKeys = new Map([...asset.materials].map(([key, material]) => [material, key]));
  return {
    root: {
      name: asset.root.name,
      scale: roundArray(asset.root.scale.toArray()),
      children: asset.root.children.map((child) => child.name),
    },
    nodes: [...asset.nodes].map(([key, node]) => ({
      key,
      name: node.name,
      type: node.type,
      parent: node.parent?.name || null,
      position: roundArray(node.position.toArray()),
      rotation: roundArray(node.rotation.toArray().slice(0, 3)),
      scale: roundArray(node.scale.toArray()),
    })),
    meshes: [...asset.meshes].map(([key, mesh]) => ({
      key,
      name: mesh.name,
      parent: mesh.parent?.name || null,
      material: Array.isArray(mesh.material)
        ? mesh.material.map((material) => materialKeys.get(material) || null)
        : materialKeys.get(mesh.material) || null,
      geometry: geometrySnapshot(mesh.geometry),
    })),
    materials: [...asset.materials].map(([key, material]) => ({
      key,
      name: material.name,
      type: material.type,
      color: material.color?.getHexString() || null,
      roughness: material.roughness ?? null,
      metalness: material.metalness ?? null,
      transparent: material.transparent,
      opacity: material.opacity,
      side: material.side,
    })),
    stats: asset.stats,
    diagnostics: asset.getDiagnostics(),
  };
}

function assertFactoryContract(module, asset) {
  assert.equal(typeof module.createSfmomaGeneratedV2Blockout, 'function');
  assert.deepEqual(module.SFMOMA_V2_BLOCKOUT_SOURCE, SOURCE);
  assert.deepEqual(module.SFMOMA_V2_BLOCKOUT_BUDGET, BUDGET);
  assert.deepEqual(module.SFMOMA_V2_SOURCE_BOUNDARY, SOURCE_BOUNDARY);
  assert.deepEqual([...module.SFMOMA_V2_BLOCKOUT_COMPONENT_IDS], COMPONENT_IDS);
  assert.deepEqual([...module.SFMOMA_V2_BLOCKOUT_REPETITION_IDS], REPETITION_IDS);
  assert.deepEqual(module.SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT,
    Object.fromEntries(COMPONENT_IDS.map((id) => [id, {
      dimensions: COMPONENT_TRANSFORMS[id].dimensions,
      position: COMPONENT_TRANSFORMS[id].position,
      rotation: [0, 0, 0],
      material: COMPONENT_MATERIALS[id],
    }])));
  assert.deepEqual(module.SFMOMA_V2_BLOCKOUT_OCULUS_CONTRACT, {
    assembly: {
      parentId: 'stripedTurret',
      position: [0, 0.16, 0.13],
      rotation: [0.24, 0, -0.28],
      dimensions: [0.23, 0.28, 0.07],
      contactType: 'embedded-seam',
    },
    ring: {
      parentId: 'oculusAssembly',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      dimensions: [0.23, 0.28, 0.07],
    },
    glazing: {
      parentId: 'oculusAssembly',
      position: [0, 0, 0.035],
      rotation: [0, 0, 0],
      dimensions: [0.17, 0.22, 0.025],
      contactType: 'embedded-seam',
    },
  });
  assert.ok(Object.isFrozen(module.SFMOMA_V2_BLOCKOUT_SOURCE), 'source constant frozen');
  assert.ok(Object.isFrozen(module.SFMOMA_V2_BLOCKOUT_BUDGET), 'budget constant frozen');
  assert.ok(Object.isFrozen(module.SFMOMA_V2_SOURCE_BOUNDARY), 'source boundary frozen');
  assert.ok(Object.isFrozen(module.SFMOMA_V2_BLOCKOUT_COMPONENT_IDS), 'component IDs frozen');
  assert.ok(Object.isFrozen(module.SFMOMA_V2_BLOCKOUT_REPETITION_IDS), 'repetition IDs frozen');
  assert.ok(Object.isFrozen(module.SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT), 'component contract frozen');
  assert.ok(Object.isFrozen(module.SFMOMA_V2_BLOCKOUT_OCULUS_CONTRACT), 'oculus contract frozen');

  assert.equal(asset.root.name, 'sfmoma.v2.blockout');
  assert.ok(asset.root.isGroup, 'root is a Group');
  assert.deepEqual(asset.root.userData.source, SOURCE);
  assert.deepEqual(asset.root.userData.sourceBoundary, SOURCE_BOUNDARY);
  assert.equal(asset.root.userData.pass, PASS_ID);
  assert.deepEqual(asset.root.userData.componentIds, COMPONENT_IDS);
  assert.deepEqual(asset.root.userData.featureIds, FEATURE_IDS);
  assert.ok(asset.root.userData.sculptRuntime && typeof asset.root.userData.sculptRuntime === 'object',
    'sculpt runtime disclosure');
  assert.ok(asset.nodes instanceof Map, 'nodes Map');
  assert.ok(asset.meshes instanceof Map, 'meshes Map');
  assert.ok(asset.materials instanceof Map, 'materials Map');
  assert.ok(asset.textures instanceof Set, 'textures Set');
  assert.deepEqual([...asset.nodes.keys()], [...COMPONENT_IDS, ...FEATURE_IDS]);
  assert.deepEqual([...asset.meshes.keys()], MESH_IDS);
  assert.deepEqual([...asset.materials.keys()], MATERIAL_IDS);
  for (const [id, material] of asset.materials) {
    assert.equal(material.type, 'MeshStandardMaterial', `${id} deterministic WebGPU blockout material`);
  }
  assert.equal(asset.textures.size, 0, 'no blockout textures');
  assert.equal(typeof asset.getDiagnostics, 'function');
  assert.equal(typeof asset.dispose, 'function');

  assert.deepEqual(asset.root.children.map((child) => child.name),
    COMPONENT_IDS.map((id) => `sfmoma.v2.component.${id}`));
  for (const id of COMPONENT_IDS) {
    const node = asset.nodes.get(id);
    const mesh = asset.meshes.get(id);
    assert.ok(node?.isGroup, `${id} stable pivot Group`);
    assert.equal(node.name, `sfmoma.v2.component.${id}`);
    assert.equal(node.parent, asset.root, `${id} root parent`);
    assert.equal(mesh?.isMesh, true, `${id} mesh`);
    assert.equal(mesh.name, `sfmoma.v2.mesh.${id}`);
    assert.equal(mesh.parent, node, `${id} pivot parent`);
    assertVector(node.position.toArray(), COMPONENT_TRANSFORMS[id].position, `${id} position`);
    assertVector(node.rotation.toArray().slice(0, 3), [0, 0, 0], `${id} rotation`);
    const bounds = new THREE.Box3().setFromObject(mesh);
    assertVector(bounds.getSize(new THREE.Vector3()).toArray(), COMPONENT_TRANSFORMS[id].dimensions,
      `${id} reference-relative dimensions`, 1e-6);
  }

  const turret = asset.nodes.get('stripedTurret');
  const oculusAssembly = asset.nodes.get('oculusAssembly');
  const oculusRing = asset.meshes.get('oculusRing');
  const oculusGlazing = asset.meshes.get('oculusGlazing');
  assert.ok(oculusAssembly?.isGroup, 'oculus assembly Group');
  assert.equal(oculusAssembly.name, 'sfmoma.v2.feature.oculusAssembly');
  assert.equal(oculusAssembly.parent, turret, 'oculus assembly nested under turret');
  assertVector(oculusAssembly.position.toArray(), [0, 0.16, 0.13], 'oculus assembly position');
  assertVector(oculusAssembly.rotation.toArray().slice(0, 3), [0.24, 0, -0.28], 'oculus assembly rotation');
  assert.equal(oculusRing?.name, 'sfmoma.v2.mesh.oculusRing');
  assert.equal(oculusRing?.parent, oculusAssembly);
  assert.equal(oculusGlazing?.name, 'sfmoma.v2.mesh.oculusGlazing');
  assert.equal(oculusGlazing?.parent, oculusAssembly);
  assert.equal(asset.nodes.get('oculusGlazing'), oculusGlazing, 'oculus glazing stable node identity');
  assertVector(oculusGlazing.position.toArray(), [0, 0, 0.035], 'oculus glazing position');

  const aggregate = { triangles: 0, vertices: 0 };
  const geometries = new Set();
  const usedMaterials = new Set();
  asset.root.updateMatrixWorld(true);
  asset.root.traverse((object) => {
    assert.ok(object.matrixWorld.elements.every(Number.isFinite), `${object.name || object.type} finite matrix`);
    assert.notEqual(object.isLight, true, `${object.name || object.type} must not add a light`);
    assert.notEqual(object.isInstancedMesh, true, `${object.name || object.type} must not realize repetition blocks`);
    if (!object.isMesh) return;
    assert.notEqual(object.material?.isShaderMaterial, true, `${object.name} no ShaderMaterial`);
    assert.notEqual(object.material?.isRawShaderMaterial, true, `${object.name} no RawShaderMaterial`);
    assertGeometryIntegrity(object, aggregate);
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      assert.ok(material?.isMaterial, `${object.name} valid material`);
      usedMaterials.add(material);
      for (const value of Object.values(material)) {
        assert.notEqual(value?.isTexture, true, `${object.name}/${material.name} contains no texture resource`);
      }
    }
  });

  const diagnostics = asset.getDiagnostics();
  assert.equal(diagnostics.pass, PASS_ID);
  assert.deepEqual(diagnostics.sourceBoundary, SOURCE_BOUNDARY);
  assert.deepEqual(diagnostics.componentCounts, { macro: 6, features: 2, nodes: 8, meshes: 8 });
  assert.equal(diagnostics.finiteBounds.finite, true);
  assert.ok([
    ...diagnostics.finiteBounds.min,
    ...diagnostics.finiteBounds.max,
    ...diagnostics.finiteBounds.size,
  ].every(Number.isFinite), 'finite aggregate bounds');
  assert.ok(diagnostics.finiteBounds.size.every((value) => value > 0), 'positive aggregate bounds');
  assert.deepEqual(Object.keys(diagnostics.componentGeometry), COMPONENT_IDS);
  for (const id of COMPONENT_IDS) {
    const entry = diagnostics.componentGeometry[id];
    assert.equal(entry.parentId, 'root', `${id} diagnostic parent`);
    assert.equal(entry.nodeName, `sfmoma.v2.component.${id}`);
    assert.equal(entry.meshName, `sfmoma.v2.mesh.${id}`);
    assertVector(entry.position, COMPONENT_TRANSFORMS[id].position, `${id} diagnostic position`);
    assertVector(entry.rotation, [0, 0, 0], `${id} diagnostic rotation`);
    assertVector(entry.declaredDimensions, COMPONENT_TRANSFORMS[id].dimensions,
      `${id} diagnostic dimensions`);
    assert.equal(entry.actualLocalBounds.finite, true, `${id} finite local bounds`);
    assertVector(entry.actualLocalBounds.size, COMPONENT_TRANSFORMS[id].dimensions,
      `${id} actual local size`, 1e-6);
  }
  assert.deepEqual(diagnostics.oculusContact.assembly.parentChainIds,
    ['root', 'stripedTurret', 'oculusAssembly']);
  assert.deepEqual(diagnostics.oculusContact.assembly.parentChainNames, [
    'sfmoma.v2.blockout',
    'sfmoma.v2.component.stripedTurret',
    'sfmoma.v2.feature.oculusAssembly',
  ]);
  assert.equal(diagnostics.oculusContact.assembly.parentId, 'stripedTurret');
  assertVector(diagnostics.oculusContact.assembly.localPosition, [0, 0.16, 0.13],
    'oculus contact assembly position');
  assertVector(diagnostics.oculusContact.assembly.localRotation, [0.24, 0, -0.28],
    'oculus contact assembly rotation');
  assert.equal(diagnostics.oculusContact.assembly.contactType, 'embedded-seam');
  assert.deepEqual(diagnostics.oculusContact.ring.parentChainIds,
    ['root', 'stripedTurret', 'oculusAssembly', 'oculusRing']);
  assert.equal(diagnostics.oculusContact.ring.parentId, 'oculusAssembly');
  assertVector(diagnostics.oculusContact.ring.actualLocalBounds.size, [0.23, 0.28, 0.07],
    'oculus ring actual local size', 1e-6);
  assert.deepEqual(diagnostics.oculusContact.glazing.parentChainIds,
    ['root', 'stripedTurret', 'oculusAssembly', 'oculusGlazing']);
  assert.equal(diagnostics.oculusContact.glazing.parentId, 'oculusAssembly');
  assertVector(diagnostics.oculusContact.glazing.localPosition, [0, 0, 0.035],
    'oculus contact glazing position');
  assertVector(diagnostics.oculusContact.glazing.localRotation, [0, 0, 0],
    'oculus contact glazing rotation');
  assertVector(diagnostics.oculusContact.glazing.actualLocalBounds.size, [0.17, 0.22, 0.025],
    'oculus glazing actual local size', 1e-6);
  assert.equal(diagnostics.oculusContact.glazing.contactType, 'embedded-seam');
  assert.equal(diagnostics.oculusContact.ringIntersectsTurret, true, 'oculus ring contacts turret');
  assert.equal(diagnostics.oculusContact.glazingIntersectsRing, true, 'oculus glazing contacts ring');
  assert.equal(diagnostics.noTextures, true);
  assert.equal(diagnostics.disposed, false);
  assert.equal(diagnostics.blockedRepetitions.count, REPETITION_IDS.length);
  assert.deepEqual(diagnostics.blockedRepetitions.ids, REPETITION_IDS);
  assert.equal(diagnostics.blockedRepetitions.status, 'blocked');
  assert.ok(typeof diagnostics.blockedRepetitions.reason === 'string'
    && diagnostics.blockedRepetitions.reason.length >= 20, 'blocked repetition reason');
  assert.equal(geometries.size, asset.stats.geometries);
  assert.equal(usedMaterials.size, asset.stats.materials);
  assert.equal(asset.stats.drawCalls, asset.meshes.size);
  assert.equal(asset.stats.triangles, aggregate.triangles);
  assert.equal(asset.stats.vertices, aggregate.vertices);
  assert.equal(asset.stats.textures, 0);
  assert.ok(asset.stats.drawCalls <= BUDGET.maxDrawCalls, `draw calls ${asset.stats.drawCalls}`);
  assert.ok(asset.stats.triangles <= BUDGET.maxTriangles, `triangles ${asset.stats.triangles}`);
  assert.ok(asset.stats.geometries <= BUDGET.maxGeometries, `geometries ${asset.stats.geometries}`);
  assert.ok(asset.stats.materials <= BUDGET.maxMaterials, `materials ${asset.stats.materials}`);
  assert.equal(asset.stats.textures, BUDGET.maxTextures);
  assert.deepEqual(diagnostics.stats, asset.stats);
  return { aggregate, diagnostics, snapshot: modelSnapshot(asset) };
}

function assertIdempotentDisposal(asset) {
  const resources = [...new Set([
    ...[...asset.meshes.values()].map((mesh) => mesh.geometry),
    ...asset.materials.values(),
    ...asset.textures.values(),
  ])];
  const disposalCounts = new Map(resources.map((resource) => [resource, 0]));
  for (const resource of resources) {
    resource.addEventListener('dispose', () => {
      disposalCounts.set(resource, disposalCounts.get(resource) + 1);
    });
  }
  const parent = new THREE.Group();
  parent.add(asset.root);
  assert.doesNotThrow(() => asset.dispose(), 'first dispose');
  assert.equal(asset.root.parent, null, 'dispose detaches root');
  assert.equal(asset.getDiagnostics().disposed, true, 'disposed diagnostic');
  assert.doesNotThrow(() => asset.dispose(), 'second dispose');
  assert.equal(asset.root.parent, null, 'second dispose remains detached');
  for (const [resource, count] of disposalCounts) {
    assert.equal(count, 1, `${resource.name || resource.type} disposed exactly once`);
  }
}

async function fileEvidence(filePath) {
  const buffer = await readFile(filePath);
  return {
    path: path.relative(REPO_ROOT, filePath),
    bytes: buffer.byteLength,
    sha256: sha256(buffer),
  };
}

function imageDataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function decodeScreenshotPixels(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'capture is a PNG');
  let offset = 8;
  let header = null;
  const dataChunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      dataChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }
  assert.ok(header, 'PNG IHDR');
  assert.deepEqual({
    bitDepth: header.bitDepth,
    colorType: header.colorType,
    compression: header.compression,
    filter: header.filter,
    interlace: header.interlace,
  }, { bitDepth: 8, colorType: 2, compression: 0, filter: 0, interlace: 0 }, 'RGB8 capture format');
  assert.deepEqual([header.width, header.height], [VIEWPORT.width, VIEWPORT.height], 'capture dimensions');
  const bytesPerPixel = 3;
  const stride = header.width * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(dataChunks));
  assert.equal(filtered.length, (stride + 1) * header.height, 'PNG scanline length');
  const pixels = Buffer.alloc(stride * header.height);
  const paeth = (left, up, upperLeft) => {
    const estimate = left + up - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
    if (upDistance <= upperLeftDistance) return up;
    return upperLeft;
  };
  for (let y = 0; y < header.height; y += 1) {
    const filterType = filtered[y * (stride + 1)];
    assert.ok(filterType >= 0 && filterType <= 4, `PNG filter ${filterType}`);
    const sourceOffset = y * (stride + 1) + 1;
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset + x];
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[rowOffset + x - stride] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[rowOffset + x - stride - bytesPerPixel]
        : 0;
      let prediction = 0;
      if (filterType === 1) prediction = left;
      else if (filterType === 2) prediction = up;
      else if (filterType === 3) prediction = Math.floor((left + up) / 2);
      else if (filterType === 4) prediction = paeth(left, up, upperLeft);
      pixels[rowOffset + x] = (raw + prediction) & 0xff;
    }
  }
  return { ...header, pixels, pixelSha256: sha256(pixels) };
}

function compareCapturePixels(left, right) {
  assert.equal(left.width, right.width, 'capture comparison width');
  assert.equal(left.height, right.height, 'capture comparison height');
  assert.equal(left.pixels.length, right.pixels.length, 'capture comparison byte length');
  const bounds = { minX: left.width, minY: left.height, maxX: -1, maxY: -1 };
  let changedPixels = 0;
  let changedChannels = 0;
  let absoluteDelta = 0;
  let maxChannelDelta = 0;
  for (let offset = 0; offset < left.pixels.length; offset += 3) {
    let pixelChanged = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(left.pixels[offset + channel] - right.pixels[offset + channel]);
      if (delta > 0) {
        pixelChanged = true;
        changedChannels += 1;
        absoluteDelta += delta;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
      }
    }
    if (!pixelChanged) continue;
    changedPixels += 1;
    const pixelIndex = offset / 3;
    const x = pixelIndex % left.width;
    const y = Math.floor(pixelIndex / left.width);
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  return {
    changedPixels,
    changedPixelRatio: changedPixels / (left.width * left.height),
    changedChannels,
    meanAbsoluteDelta: absoluteDelta / left.pixels.length,
    maxChannelDelta,
    bounds: changedPixels > 0 ? bounds : null,
  };
}

async function makeComparisonSheet(browser, outputs) {
  const comparisonPage = await browser.newPage({ viewport: { width: 1920, height: 720 }, deviceScaleFactor: 1 });
  const tiles = [
    { label: 'Generated concept reference (not survey evidence)', path: REFERENCE_PATH },
    ...VIEWS.map((view) => ({ label: view.label, path: outputs[view.id] })),
  ];
  const images = await Promise.all(tiles.map(async (tile) => ({
    ...tile,
    src: imageDataUrl(await readFile(tile.path)),
  })));
  await comparisonPage.setContent(`<!doctype html>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #11161b; }
      main { display: grid; grid-template-columns: repeat(3, 640px); grid-template-rows: repeat(2, 360px); }
      figure { position: relative; margin: 0; overflow: hidden; border: 1px solid #56616b; background: #d7e2e6; }
      img { width: 100%; height: 100%; display: block; object-fit: contain; }
      figcaption { position: absolute; left: 12px; top: 12px; padding: 7px 10px; color: white; background: rgb(8 12 16 / 82%); font: 600 15px/1.1 system-ui, sans-serif; }
    </style>
    <main>${images.map((tile) => `<figure><img src="${tile.src}" alt=""><figcaption>${tile.label}</figcaption></figure>`).join('')}</main>`);
  assert.equal(await comparisonPage.locator('canvas').count(), 0, 'comparison sheet uses no canvas');
  await comparisonPage.screenshot({ path: OUTPUTS.comparison });
  await comparisonPage.close();
}

async function runBrowserCapture(structuralMetrics) {
  const systemChrome = process.env.SF_QA_EXECUTABLE
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
  });

  try {
    await page.goto(QA_URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => {
      const state = window.__CITYGEN__?.getState?.();
      return state?.webgpu && state?.buildings >= 700 && !state?.busy;
    }, null, { timeout: 90000 });
    await page.addStyleTag({
      content: `
        #app > :not(#scene-canvas) { display: none !important; }
        #scene-canvas { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; }
        html, body, #app { margin: 0 !important; width: 100% !important; height: 100% !important; overflow: hidden !important; }
      `,
    });

    const setup = await page.evaluate(async ({ passId, componentIds, featureIds, sourceBoundary, rootY }) => {
      const api = window.__CITYGEN__;
      const cityRenderer = api.getRenderer();
      const cityBounds = api.getCity().meta.bounds;
      const qaAnchor = [
        (cityBounds.minX + cityBounds.maxX) * 0.5,
        rootY,
        (cityBounds.minZ + cityBounds.maxZ) * 0.5,
      ];
      const module = await import('/src/citygen/landmarks/sfmoma-generated-v2.js');
      const asset = module.createSfmomaGeneratedV2Blockout({ scale: 40 });
      const canonicalChildren = cityRenderer.root.children.map((child) => ({
        object: child,
        visible: child.visible,
        name: child.name,
      }));
      window.__SFMOMA_V2_BLOCKOUT_QA__ = { asset, canonicalChildren };
      asset.root.position.set(...qaAnchor);
      cityRenderer.root.add(asset.root);
      cityRenderer.controls.enabled = false;
      api.setClock(15);
      await cityRenderer.renderer.setAnimationLoop(null);
      return {
        backend: cityRenderer.rendererBackend,
        canvasCountBefore: document.querySelectorAll('canvas').length,
        sceneCanvasCount: document.querySelectorAll('#scene-canvas').length,
        rendererCanvasIdentity: cityRenderer.renderer.domElement === document.querySelector('#scene-canvas'),
        canonicalRootVisible: cityRenderer.root.visible,
        canonicalChildCount: canonicalChildren.length,
        canonicalChildrenStillVisible: canonicalChildren.every((entry) => entry.object.visible === entry.visible),
        qaRootParent: asset.root.parent === cityRenderer.root,
        qaRootCount: cityRenderer.root.children.filter((child) => child.name === 'sfmoma.v2.blockout').length,
        canonicalLoopPausedForDeterministicEvidence: true,
        qaAnchor,
        pass: asset.root.userData.pass,
        componentIds: asset.root.userData.componentIds,
        featureIds: asset.root.userData.featureIds,
        sourceBoundary: asset.root.userData.sourceBoundary,
        diagnostics: asset.getDiagnostics(),
        expected: { passId, componentIds, featureIds, sourceBoundary },
      };
    }, {
      passId: PASS_ID,
      componentIds: COMPONENT_IDS,
      featureIds: FEATURE_IDS,
      sourceBoundary: SOURCE_BOUNDARY,
      rootY: QA_ROOT_Y,
    });

    assert.equal(setup.backend, 'webgpu', 'canonical WebGPU backend');
    assert.equal(setup.sceneCanvasCount, 1, 'one canonical scene canvas');
    assert.equal(setup.rendererCanvasIdentity, true, 'factory uses canonical renderer canvas');
    assert.equal(setup.canonicalRootVisible, true, 'canonical world remains visible');
    assert.equal(setup.canonicalChildrenStillVisible, true, 'canonical source child visibility unchanged');
    assert.equal(setup.qaRootParent, true, 'QA asset is an isolated canonical city-root child');
    assert.equal(setup.qaRootCount, 1, 'one QA blockout root');
    assert.equal(setup.pass, PASS_ID);
    assert.deepEqual(setup.componentIds, COMPONENT_IDS);
    assert.deepEqual(setup.featureIds, FEATURE_IDS);
    assert.deepEqual(setup.sourceBoundary, SOURCE_BOUNDARY);

    const baseline = await page.evaluate(() => {
      const cityRenderer = window.__CITYGEN__.getRenderer();
      return {
        canvasCount: document.querySelectorAll('canvas').length,
        drawCalls: cityRenderer.renderer.info.render.drawCalls,
        triangles: cityRenderer.renderer.info.render.triangles,
        textures: cityRenderer.renderer.info.memory.textures,
        geometries: cityRenderer.renderer.info.memory.geometries,
      };
    });
    assert.equal(baseline.canvasCount, setup.canvasCountBefore, 'asset creates no canvas');

    const viewMetrics = [];
    let lockedEnvironment = null;
    for (const view of VIEWS) {
      const position = view.positionOffset.map((value, index) => value + setup.qaAnchor[index]);
      const target = view.targetOffset.map((value, index) => value + setup.qaAnchor[index]);
      await page.evaluate(async ({ position, target, fov, fixedTime }) => {
        const api = window.__CITYGEN__;
        const cityRenderer = api.getRenderer();
        cityRenderer.camera.position.set(...position);
        cityRenderer.camera.fov = fov;
        cityRenderer.camera.near = 0.1;
        cityRenderer.camera.far = 1500;
        cityRenderer.camera.lookAt(...target);
        cityRenderer.camera.updateProjectionMatrix();
        cityRenderer.controls.target.set(...target);
        cityRenderer.controls.update();
        api.setClock(fixedTime);
        cityRenderer.updateWorldPartition(true, true);
        cityRenderer.updatePortalPartition(true, true);
        cityRenderer.updateParkedCarPartition(true, true);
        for (let warmup = 0; warmup < 3; warmup += 1) {
          await cityRenderer.renderer.renderAsync(cityRenderer.scene, cityRenderer.camera);
        }
        cityRenderer.renderer.shadowMap.autoUpdate = false;
        await cityRenderer.renderer.renderAsync(cityRenderer.scene, cityRenderer.camera);
      }, { position, target, fov: view.fov, fixedTime: FIXED_TIME });
      await page.waitForTimeout(100);
      for (let compositorWarmup = 0; compositorWarmup < 3; compositorWarmup += 1) {
        await page.evaluate(async () => {
          const cityRenderer = window.__CITYGEN__.getRenderer();
          await cityRenderer.renderer.renderAsync(cityRenderer.scene, cityRenderer.camera);
        });
        await page.waitForTimeout(100);
        await page.screenshot();
      }
      const beforeCapture = await page.evaluate(() => {
        const api = window.__CITYGEN__;
        const cityRenderer = api.getRenderer();
        return {
          time: api.getState().clock,
          camera: {
            position: cityRenderer.camera.position.toArray(),
            quaternion: cityRenderer.camera.quaternion.toArray(),
            fov: cityRenderer.camera.fov,
            near: cityRenderer.camera.near,
            far: cityRenderer.camera.far,
            target: cityRenderer.controls.target.toArray(),
          },
          background: cityRenderer.scene.background?.getHexString?.() || cityRenderer.scene.background?.type || null,
          fog: cityRenderer.scene.fog ? {
            color: cityRenderer.scene.fog.color.getHexString(),
            near: cityRenderer.scene.fog.near,
            far: cityRenderer.scene.fog.far,
          } : null,
          runtime: {
            drawCalls: cityRenderer.renderer.info.render.drawCalls,
            triangles: cityRenderer.renderer.info.render.triangles,
            textures: cityRenderer.renderer.info.memory.textures,
            geometries: cityRenderer.renderer.info.memory.geometries,
            shadowMapAutoUpdate: cityRenderer.renderer.shadowMap.autoUpdate,
          },
          frameBounds: (() => {
            const asset = window.__SFMOMA_V2_BLOCKOUT_QA__.asset;
            const ndc = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            asset.root.updateMatrixWorld(true);
            cityRenderer.camera.updateMatrixWorld(true);
            asset.root.traverse((object) => {
              if (!object.isMesh) return;
              object.geometry.computeBoundingBox();
              const { min, max } = object.geometry.boundingBox;
              for (const x of [min.x, max.x]) {
                for (const y of [min.y, max.y]) {
                  for (const z of [min.z, max.z]) {
                    const point = min.clone().set(x, y, z).applyMatrix4(object.matrixWorld).project(cityRenderer.camera);
                    ndc.minX = Math.min(ndc.minX, point.x);
                    ndc.minY = Math.min(ndc.minY, point.y);
                    ndc.maxX = Math.max(ndc.maxX, point.x);
                    ndc.maxY = Math.max(ndc.maxY, point.y);
                  }
                }
              }
            });
            return {
              ndc,
              widthRatio: (ndc.maxX - ndc.minX) * 0.5,
              heightRatio: (ndc.maxY - ndc.minY) * 0.5,
            };
          })(),
        };
      });
      assertVector(beforeCapture.camera.position, position, `${view.id} camera position`, 1e-6);
      assertVector(beforeCapture.camera.target, target, `${view.id} camera target`, 1e-6);
      assert.equal(beforeCapture.camera.fov, view.fov);
      assert.equal(beforeCapture.time, FIXED_TIME, `${view.id} fixed time`);
      assert.equal(beforeCapture.runtime.shadowMapAutoUpdate, false, `${view.id} locked shadow map`);
      const environment = { background: beforeCapture.background, fog: beforeCapture.fog };
      if (lockedEnvironment == null) lockedEnvironment = environment;
      else assert.deepEqual(environment, lockedEnvironment, `${view.id} locked background/fog`);
      assert.ok(beforeCapture.frameBounds.ndc.minX >= -0.98 && beforeCapture.frameBounds.ndc.maxX <= 0.98,
        `${view.id} horizontal framing ${JSON.stringify(beforeCapture.frameBounds)}`);
      assert.ok(beforeCapture.frameBounds.ndc.minY >= -0.98 && beforeCapture.frameBounds.ndc.maxY <= 0.98,
        `${view.id} vertical framing ${JSON.stringify(beforeCapture.frameBounds)}`);
      assert.ok(beforeCapture.frameBounds.widthRatio >= 0.2 && beforeCapture.frameBounds.widthRatio <= 0.82,
        `${view.id} useful width coverage ${beforeCapture.frameBounds.widthRatio}`);
      assert.ok(beforeCapture.frameBounds.heightRatio >= 0.3 && beforeCapture.frameBounds.heightRatio <= 0.88,
        `${view.id} useful height coverage ${beforeCapture.frameBounds.heightRatio}`);
      const captureBuffer = await page.screenshot();
      await page.evaluate(async () => {
        const cityRenderer = window.__CITYGEN__.getRenderer();
        await cityRenderer.renderer.renderAsync(cityRenderer.scene, cityRenderer.camera);
      });
      await page.waitForTimeout(100);
      const consecutiveCaptureBuffer = await page.screenshot();
      await page.evaluate(async () => {
        const cityRenderer = window.__CITYGEN__.getRenderer();
        await cityRenderer.renderer.renderAsync(cityRenderer.scene, cityRenderer.camera);
      });
      await page.waitForTimeout(100);
      const sameParityCaptureBuffer = await page.screenshot();
      await page.evaluate(async () => {
        const cityRenderer = window.__CITYGEN__.getRenderer();
        await cityRenderer.renderer.renderAsync(cityRenderer.scene, cityRenderer.camera);
      });
      await page.waitForTimeout(100);
      const alternateParityCaptureBuffer = await page.screenshot();
      const captureSha256 = sha256(captureBuffer);
      const capturePixels = decodeScreenshotPixels(captureBuffer);
      const consecutiveCapturePixels = decodeScreenshotPixels(consecutiveCaptureBuffer);
      const sameParityCapturePixels = decodeScreenshotPixels(sameParityCaptureBuffer);
      const alternateParityCapturePixels = decodeScreenshotPixels(alternateParityCaptureBuffer);
      const consecutiveStateDiff = compareCapturePixels(capturePixels, consecutiveCapturePixels);
      const sameParityDiff = compareCapturePixels(capturePixels, sameParityCapturePixels);
      const alternateParityDiff = compareCapturePixels(consecutiveCapturePixels, alternateParityCapturePixels);
      assert.equal(sameParityCapturePixels.pixelSha256, capturePixels.pixelSha256,
        `${view.id} deterministic A/C WebGPU presentation state: ${JSON.stringify(sameParityDiff)}`);
      assert.equal(alternateParityCapturePixels.pixelSha256, consecutiveCapturePixels.pixelSha256,
        `${view.id} deterministic B/D WebGPU presentation state: ${JSON.stringify(alternateParityDiff)}`);
      await writeFile(OUTPUTS[view.id], captureBuffer);
      viewMetrics.push({
        id: view.id,
        label: view.label,
        camera: beforeCapture.camera,
        time: beforeCapture.time,
        background: beforeCapture.background,
        fog: beforeCapture.fog,
        runtime: beforeCapture.runtime,
        frameBounds: beforeCapture.frameBounds,
        pixelSha256: capturePixels.pixelSha256,
        encodedPngSha256: captureSha256,
        presentationSequencePixelSha256: {
          A: capturePixels.pixelSha256,
          B: consecutiveCapturePixels.pixelSha256,
          C: sameParityCapturePixels.pixelSha256,
          D: alternateParityCapturePixels.pixelSha256,
        },
        repeatCaptureMode: 'fixed-3-render-plus-3-compositor-readback-prewarm-frozen-shadow-map-A-B-C-D-WebGPU-presentation-state',
        consecutiveStateDiff,
        sameParityDiff,
        alternateParityDiff,
        twoStateSequenceStable: true,
        evidence: await fileEvidence(OUTPUTS[view.id]),
      });
    }

    const finalRuntime = await page.evaluate(() => {
      const cityRenderer = window.__CITYGEN__.getRenderer();
      const qa = window.__SFMOMA_V2_BLOCKOUT_QA__;
      return {
        canvasCount: document.querySelectorAll('canvas').length,
        canonicalRootVisible: cityRenderer.root.visible,
        canonicalChildVisibilityUnchanged: qa.canonicalChildren.every((entry) => entry.object.visible === entry.visible),
        qaRootCount: cityRenderer.root.children.filter((child) => child.name === 'sfmoma.v2.blockout').length,
        rendererCanvasIdentity: cityRenderer.renderer.domElement === document.querySelector('#scene-canvas'),
        diagnostics: qa.asset.getDiagnostics(),
      };
    });
    assert.equal(finalRuntime.canvasCount, baseline.canvasCount, 'canvas count stable');
    assert.equal(finalRuntime.canonicalRootVisible, true, 'canonical world still visible');
    assert.equal(finalRuntime.canonicalChildVisibilityUnchanged, true, 'canonical child visibility remains unchanged');
    assert.equal(finalRuntime.qaRootCount, 1, 'one isolated QA root after captures');
    assert.equal(finalRuntime.rendererCanvasIdentity, true, 'canonical canvas identity stable');
    assert.deepEqual(errors, []);

    await makeComparisonSheet(browser, OUTPUTS);
    const metrics = {
      result: 'passed',
      scope: 'isolated blockout evidence only; not canonical integration or visual acceptance',
      qaUrl: QA_URL,
      viewport: VIEWPORT,
      fixedTime: FIXED_TIME,
      source: SOURCE,
      sourceBoundary: SOURCE_BOUNDARY,
      structural: structuralMetrics,
      setup,
      baseline,
      finalRuntime,
      views: viewMetrics,
      comparison: await fileEvidence(OUTPUTS.comparison),
    };
    await writeFile(OUTPUTS.metrics, `${JSON.stringify(metrics, null, 2)}\n`);
    return { ...metrics, metrics: await fileEvidence(OUTPUTS.metrics) };
  } finally {
    await browser.close();
  }
}

const moduleSource = await readFile(MODULE_PATH, 'utf8');
const forbiddenSourcePatterns = [
  ['renderer construction', /\b(?:WebGLRenderer|WebGPURenderer)\b/],
  ['postprocessing composer', /\bEffectComposer\b/],
  ['controls', /\b(?:OrbitControls|TrackballControls|FlyControls|PointerLockControls)\b/],
  ['DOM document access', /\bdocument\s*\./],
  ['DOM window access', /\bwindow\s*\./],
  ['canvas creation', /(?:\bHTMLCanvasElement\b|\bOffscreenCanvas\b|\bcreateElement\s*\(\s*['"]canvas['"]\s*\))/],
  ['animation loop', /\b(?:requestAnimationFrame|setAnimationLoop)\s*\(/],
  ['light construction', /\bnew\s+(?:THREE\.)?(?:Ambient|Directional|Hemisphere|Point|RectArea|Spot)Light\s*\(/],
  ['texture construction', /\bnew\s+(?:THREE\.)?(?:Texture|CanvasTexture|DataTexture|VideoTexture|CompressedTexture)\s*\(/],
  ['generic repetition geometry', /\b(?:InstancedMesh|repetitionSystem|genericRepetition)\b/],
];
for (const [label, pattern] of forbiddenSourcePatterns) {
  assert.doesNotMatch(moduleSource, pattern, `blockout source contains no ${label}`);
}

const referenceBuffer = await readFile(REFERENCE_PATH);
assert.equal(sha256(referenceBuffer), REFERENCE_SHA256, 'reference image hash');
const sculptSpec = JSON.parse(await readFile(SPEC_PATH, 'utf8'));
const module = await import(`${pathToFileURL(MODULE_PATH).href}?qa=${Date.now()}`);
for (const id of COMPONENT_IDS) {
  const component = sculptSpec.componentTree.find((entry) => entry.id === id);
  assert.ok(component, `${id} exists in the source-honest sculpt spec`);
  const expected = module.SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT[id];
  assert.deepEqual([
    component.dimensions.width,
    component.dimensions.height,
    component.dimensions.depth,
  ], expected.dimensions, `${id} spec dimensions match the runtime contract`);
  assert.deepEqual(component.transform.position, expected.position,
    `${id} spec position matches the runtime contract`);
  assert.deepEqual(component.transform.rotation, expected.rotation,
    `${id} spec rotation matches the runtime contract`);
  assert.deepEqual(component.actionProfile.collider.scale, expected.dimensions,
    `${id} spec collider envelope matches the runtime contract`);
}
const firstAsset = module.createSfmomaGeneratedV2Blockout();
const secondAsset = module.createSfmomaGeneratedV2Blockout();
const first = assertFactoryContract(module, firstAsset);
const second = assertFactoryContract(module, secondAsset);
assert.deepEqual(second.snapshot, first.snapshot, 'factory output is structurally deterministic');
assert.notEqual(firstAsset.root, secondAsset.root, 'factory roots are independently owned');
for (const key of MESH_IDS) {
  assert.notEqual(firstAsset.meshes.get(key).geometry, secondAsset.meshes.get(key).geometry,
    `${key} geometry is independently owned`);
}
for (const key of MATERIAL_IDS) {
  assert.notEqual(firstAsset.materials.get(key), secondAsset.materials.get(key),
    `${key} material is independently owned`);
}
assertIdempotentDisposal(firstAsset);
assertIdempotentDisposal(secondAsset);

const structuralMetrics = {
  module: MODULE_RELATIVE_PATH,
  moduleSha256: sha256(Buffer.from(moduleSource)),
  pass: PASS_ID,
  componentIds: COMPONENT_IDS,
  featureIds: FEATURE_IDS,
  meshIds: MESH_IDS,
  materialIds: MATERIAL_IDS,
  blockedRepetitionIds: REPETITION_IDS,
  sourceBoundary: SOURCE_BOUNDARY,
  stats: first.snapshot.stats,
  geometry: first.aggregate,
  stableFactorySnapshotSha256: sha256(Buffer.from(JSON.stringify(first.snapshot))),
  idempotentDisposal: true,
};
const result = await runBrowserCapture(structuralMetrics);
console.log(JSON.stringify(result, null, 2));
