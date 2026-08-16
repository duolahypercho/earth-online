import * as THREE from 'three';

export const SFMOMA_V2_BLOCKOUT_SOURCE = Object.freeze({
  id: 'sfmoma-source-honest-landmark-v2',
  reference: '/assets/hero/sfmoma-img2threejs-v2/reference.png',
  referenceSha256: 'a5fc2bf43c65fc5ac065b1f8a7b5f0f27101e2339653cd4d20521f695460b4e6',
  reconstruction: 'single-generated-reference-procedural-threejs-blockout',
  stage: 'blockout',
  presentationOnly: true,
  hiddenElevations: 'conservative-continuity-approximation',
  dimensionAuthority: 'reference-relative-not-surveyed',
});

export const SFMOMA_V2_SOURCE_BOUNDARY = Object.freeze({
  canonicalBuildingId: 'sf-building-41692824',
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

export const SFMOMA_V2_BLOCKOUT_BUDGET = Object.freeze({
  maxDrawCalls: 8,
  maxTriangles: 4096,
  maxGeometries: 8,
  maxMaterials: 5,
  maxTextures: 0,
});

export const SFMOMA_V2_BLOCKOUT_COMPONENT_IDS = Object.freeze([
  'granitePodium',
  'brickWings',
  'brickCentralTower',
  'stripedTurret',
  'rippledExpansion',
  'glassAtriumCore',
]);

export const SFMOMA_V2_BLOCKOUT_REPETITION_IDS = Object.freeze([
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

const PASS_ID = 'sfmoma-v2-blockout-v1';
const FEATURE_IDS = Object.freeze(['oculusAssembly', 'oculusGlazing']);

export const SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT = Object.freeze({
  granitePodium: Object.freeze({
    dimensions: Object.freeze([1, 0.16, 0.42]),
    position: Object.freeze([0, 0.08, 0]),
    rotation: Object.freeze([0, 0, 0]),
    material: 'granite',
  }),
  brickWings: Object.freeze({
    dimensions: Object.freeze([0.96, 0.64, 0.3]),
    position: Object.freeze([-0.02, 0.4, 0.03]),
    rotation: Object.freeze([0, 0, 0]),
    material: 'brick',
  }),
  brickCentralTower: Object.freeze({
    dimensions: Object.freeze([0.25, 0.86, 0.28]),
    position: Object.freeze([-0.14, 0.51, -0.02]),
    rotation: Object.freeze([0, 0, 0]),
    material: 'brick',
  }),
  stripedTurret: Object.freeze({
    dimensions: Object.freeze([0.27, 0.74, 0.27]),
    position: Object.freeze([0.02, 0.53, 0.09]),
    rotation: Object.freeze([0, 0, 0]),
    material: 'stripedStone',
  }),
  rippledExpansion: Object.freeze({
    dimensions: Object.freeze([0.58, 0.7, 0.24]),
    position: Object.freeze([0.24, 0.51, -0.03]),
    rotation: Object.freeze([0, 0, 0]),
    material: 'frp',
  }),
  glassAtriumCore: Object.freeze({
    dimensions: Object.freeze([0.14, 0.56, 0.1]),
    position: Object.freeze([0.17, 0.44, 0.18]),
    rotation: Object.freeze([0, 0, 0]),
    material: 'glass',
  }),
});

export const SFMOMA_V2_BLOCKOUT_OCULUS_CONTRACT = Object.freeze({
  assembly: Object.freeze({
    parentId: 'stripedTurret',
    position: Object.freeze([0, 0.16, 0.13]),
    rotation: Object.freeze([0.24, 0, -0.28]),
    dimensions: Object.freeze([0.23, 0.28, 0.07]),
    contactType: 'embedded-seam',
  }),
  ring: Object.freeze({
    parentId: 'oculusAssembly',
    position: Object.freeze([0, 0, 0]),
    rotation: Object.freeze([0, 0, 0]),
    dimensions: Object.freeze([0.23, 0.28, 0.07]),
  }),
  glazing: Object.freeze({
    parentId: 'oculusAssembly',
    position: Object.freeze([0, 0, 0.035]),
    rotation: Object.freeze([0, 0, 0]),
    dimensions: Object.freeze([0.17, 0.22, 0.025]),
    contactType: 'embedded-seam',
  }),
});

function makeMaterials() {
  const materials = new Map([
    ['granite', new THREE.MeshStandardMaterial({
      name: 'SFMOMA v2 blockout charcoal granite',
      color: 0x303436,
      roughness: 0.78,
      metalness: 0,
    })],
    ['brick', new THREE.MeshStandardMaterial({
      name: 'SFMOMA v2 blockout red brick',
      color: 0x92503b,
      roughness: 0.78,
      metalness: 0,
    })],
    ['stripedStone', new THREE.MeshStandardMaterial({
      name: 'SFMOMA v2 blockout pale turret stone',
      color: 0xddd9d1,
      roughness: 0.78,
      metalness: 0,
    })],
    ['frp', new THREE.MeshStandardMaterial({
      name: 'SFMOMA v2 blockout pale expansion FRP',
      color: 0xe2e2df,
      roughness: 0.68,
      metalness: 0,
    })],
    ['glass', new THREE.MeshStandardMaterial({
      name: 'SFMOMA v2 blockout blue-gray glazing',
      color: 0x53696d,
      roughness: 0.24,
      metalness: 0,
    })],
  ]);

  for (const [id, material] of materials) {
    material.userData.materialId = id;
    material.userData.pass = PASS_ID;
  }
  return materials;
}

function fitGeometryToDimensions(geometry, dimensions) {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  if (![size.x, size.y, size.z].every((value) => Number.isFinite(value) && value > 0)) {
    geometry.dispose();
    throw new Error('SFMOMA v2 blockout geometry must have finite non-zero bounds.');
  }

  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(
    dimensions[0] / size.x,
    dimensions[1] / size.y,
    dimensions[2] / size.z,
  );
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function mergeNonIndexedGeometries(geometries) {
  const attributes = ['position', 'normal', 'uv'];
  const merged = new THREE.BufferGeometry();
  for (const attributeName of attributes) {
    const values = [];
    let itemSize = null;
    for (const sourceGeometry of geometries) {
      const geometry = sourceGeometry.index ? sourceGeometry.toNonIndexed() : sourceGeometry;
      const attribute = geometry.getAttribute(attributeName);
      if (!attribute) continue;
      itemSize ??= attribute.itemSize;
      values.push(...attribute.array);
      if (geometry !== sourceGeometry) geometry.dispose();
    }
    if (values.length > 0) {
      merged.setAttribute(attributeName, new THREE.Float32BufferAttribute(values, itemSize));
    }
  }
  geometries.forEach((geometry) => geometry.dispose());
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function makeBoxPart(size, position) {
  const geometry = new THREE.BoxGeometry(...size).toNonIndexed();
  geometry.translate(...position);
  return geometry;
}

function makeBrickWingsGeometry(dimensions) {
  const geometry = mergeNonIndexedGeometries([
    makeBoxPart([0.34, 0.74, 0.38], [-0.33, 0, 0]),
    makeBoxPart([0.27, 0.57, 0.38], [0.365, -0.085, 0]),
    makeBoxPart([0.2, 0.26, 0.38], [0.04, -0.24, 0]),
  ]);
  return fitGeometryToDimensions(geometry, dimensions);
}

function makeExpansionGeometry(dimensions) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.5);
  shape.lineTo(0.42, -0.5);
  shape.lineTo(0.42, 0.03);
  shape.bezierCurveTo(0.49, 0.12, 0.47, 0.25, 0.35, 0.33);
  shape.bezierCurveTo(0.2, 0.44, 0.02, 0.5, -0.18, 0.5);
  shape.bezierCurveTo(-0.36, 0.5, -0.48, 0.43, -0.5, 0.31);
  shape.closePath();
  return fitGeometryToDimensions(new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    steps: 1,
    bevelEnabled: false,
    curveSegments: 8,
  }), dimensions);
}

function makeOculusRingGeometry() {
  return fitGeometryToDimensions(
    new THREE.TorusGeometry(0.43, 0.07, 12, 48),
    [0.23, 0.28, 0.07],
  );
}

function makeOculusGlazingGeometry() {
  const geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32, 1, false);
  geometry.rotateX(Math.PI * 0.5);
  return fitGeometryToDimensions(geometry, [0.17, 0.22, 0.025]);
}

function addComponent(root, nodes, meshes, id, geometry, material) {
  const spec = SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT[id];
  const node = new THREE.Group();
  node.name = `sfmoma.v2.component.${id}`;
  node.position.set(...spec.position);
  node.rotation.set(...spec.rotation);
  node.userData.componentId = id;
  node.userData.pass = PASS_ID;
  node.userData.transformSpace = 'parent-local';
  node.userData.dimensions = [...spec.dimensions];

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `sfmoma.v2.mesh.${id}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.componentId = id;
  mesh.userData.pass = PASS_ID;
  mesh.userData.presentationOnly = true;
  mesh.userData.referenceAssetId = SFMOMA_V2_BLOCKOUT_SOURCE.id;
  node.add(mesh);
  root.add(node);
  nodes.set(id, node);
  meshes.set(id, mesh);
  return node;
}

function finiteAttribute(attribute) {
  if (!attribute) return false;
  for (const value of attribute.array) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

function countStats(root, textures) {
  const geometries = new Set();
  const materials = new Set();
  let drawCalls = 0;
  let triangles = 0;
  let vertices = 0;
  let finitePositions = true;
  let finiteNormals = true;

  root.traverse((object) => {
    if (!object.isMesh) return;
    drawCalls += 1;
    geometries.add(object.geometry);
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    meshMaterials.forEach((material) => materials.add(material));
    const elementCount = object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0;
    triangles += Math.floor(elementCount / 3);
    vertices += object.geometry.attributes.position?.count ?? 0;
    finitePositions = finitePositions && finiteAttribute(object.geometry.attributes.position);
    finiteNormals = finiteNormals && finiteAttribute(object.geometry.attributes.normal);
  });

  return Object.freeze({
    drawCalls,
    triangles,
    vertices,
    geometries: geometries.size,
    materials: materials.size,
    textures: textures.size,
    finitePositions,
    finiteNormals,
  });
}

function getFiniteBounds(root) {
  const bounds = new THREE.Box3().setFromObject(root);
  const size = bounds.getSize(new THREE.Vector3());
  const values = [
    bounds.min.x,
    bounds.min.y,
    bounds.min.z,
    bounds.max.x,
    bounds.max.y,
    bounds.max.z,
    size.x,
    size.y,
    size.z,
  ];
  const finite = values.every(Number.isFinite) && size.x > 0 && size.y > 0 && size.z > 0;
  return Object.freeze({
    finite,
    min: Object.freeze(bounds.min.toArray()),
    max: Object.freeze(bounds.max.toArray()),
    size: Object.freeze(size.toArray()),
  });
}

function getLocalGeometryBounds(geometry) {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const size = bounds.getSize(new THREE.Vector3());
  const values = [...bounds.min.toArray(), ...bounds.max.toArray(), ...size.toArray()];
  return Object.freeze({
    finite: values.every(Number.isFinite) && size.x > 0 && size.y > 0 && size.z > 0,
    min: Object.freeze(bounds.min.toArray()),
    max: Object.freeze(bounds.max.toArray()),
    size: Object.freeze(size.toArray()),
  });
}

function getComponentGeometryDiagnostics(nodes, meshes) {
  return Object.freeze(Object.fromEntries(SFMOMA_V2_BLOCKOUT_COMPONENT_IDS.map((id) => {
    const node = nodes.get(id);
    const mesh = meshes.get(id);
    const contract = SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT[id];
    return [id, Object.freeze({
      parentId: 'root',
      nodeName: node.name,
      meshName: mesh.name,
      position: Object.freeze([node.position.x, node.position.y, node.position.z]),
      rotation: Object.freeze([node.rotation.x, node.rotation.y, node.rotation.z]),
      declaredDimensions: Object.freeze([...contract.dimensions]),
      actualLocalBounds: getLocalGeometryBounds(mesh.geometry),
    })];
  })));
}

function getOculusContactDiagnostics(stripedTurretNode, oculusAssembly, oculusRing, oculusGlazing) {
  const turretBounds = new THREE.Box3().setFromObject(stripedTurretNode.children[0]);
  const ringBounds = new THREE.Box3().setFromObject(oculusRing);
  const glazingBounds = new THREE.Box3().setFromObject(oculusGlazing);
  return Object.freeze({
    assembly: Object.freeze({
      parentId: 'stripedTurret',
      parentChainIds: Object.freeze(['root', 'stripedTurret', 'oculusAssembly']),
      parentChainNames: Object.freeze([
        'sfmoma.v2.blockout',
        'sfmoma.v2.component.stripedTurret',
        'sfmoma.v2.feature.oculusAssembly',
      ]),
      localPosition: Object.freeze([
        oculusAssembly.position.x,
        oculusAssembly.position.y,
        oculusAssembly.position.z,
      ]),
      localRotation: Object.freeze([
        oculusAssembly.rotation.x,
        oculusAssembly.rotation.y,
        oculusAssembly.rotation.z,
      ]),
      contactType: SFMOMA_V2_BLOCKOUT_OCULUS_CONTRACT.assembly.contactType,
    }),
    ring: Object.freeze({
      parentId: 'oculusAssembly',
      parentChainIds: Object.freeze(['root', 'stripedTurret', 'oculusAssembly', 'oculusRing']),
      actualLocalBounds: getLocalGeometryBounds(oculusRing.geometry),
    }),
    glazing: Object.freeze({
      parentId: 'oculusAssembly',
      parentChainIds: Object.freeze(['root', 'stripedTurret', 'oculusAssembly', 'oculusGlazing']),
      localPosition: Object.freeze([
        oculusGlazing.position.x,
        oculusGlazing.position.y,
        oculusGlazing.position.z,
      ]),
      localRotation: Object.freeze([
        oculusGlazing.rotation.x,
        oculusGlazing.rotation.y,
        oculusGlazing.rotation.z,
      ]),
      actualLocalBounds: getLocalGeometryBounds(oculusGlazing.geometry),
      contactType: SFMOMA_V2_BLOCKOUT_OCULUS_CONTRACT.glazing.contactType,
    }),
    ringIntersectsTurret: ringBounds.intersectsBox(turretBounds),
    glazingIntersectsRing: glazingBounds.intersectsBox(ringBounds),
  });
}

export function createSfmomaGeneratedV2Blockout({ scale = 1 } = {}) {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new TypeError('SFMOMA v2 blockout scale must be a finite number greater than zero.');
  }

  const root = new THREE.Group();
  root.name = 'sfmoma.v2.blockout';
  root.scale.setScalar(scale);
  root.userData.pass = PASS_ID;
  root.userData.source = { ...SFMOMA_V2_BLOCKOUT_SOURCE };
  root.userData.sourceBoundary = { ...SFMOMA_V2_SOURCE_BOUNDARY };
  root.userData.componentIds = [...SFMOMA_V2_BLOCKOUT_COMPONENT_IDS];
  root.userData.featureIds = [...FEATURE_IDS];

  const nodes = new Map();
  const meshes = new Map();
  const materials = makeMaterials();
  const textures = new Set();

  const granitePodium = SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT.granitePodium;
  addComponent(
    root,
    nodes,
    meshes,
    'granitePodium',
    new THREE.BoxGeometry(...granitePodium.dimensions),
    materials.get(granitePodium.material),
  );

  const brickWings = SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT.brickWings;
  addComponent(
    root,
    nodes,
    meshes,
    'brickWings',
    makeBrickWingsGeometry(brickWings.dimensions),
    materials.get(brickWings.material),
  );

  const brickCentralTower = SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT.brickCentralTower;
  addComponent(
    root,
    nodes,
    meshes,
    'brickCentralTower',
    new THREE.BoxGeometry(...brickCentralTower.dimensions),
    materials.get(brickCentralTower.material),
  );

  const stripedTurret = SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT.stripedTurret;
  const stripedTurretNode = addComponent(
    root,
    nodes,
    meshes,
    'stripedTurret',
    new THREE.CylinderGeometry(
      stripedTurret.dimensions[0] * 0.5,
      stripedTurret.dimensions[0] * 0.5,
      stripedTurret.dimensions[1],
      48,
      1,
      false,
    ),
    materials.get(stripedTurret.material),
  );

  const rippledExpansion = SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT.rippledExpansion;
  addComponent(
    root,
    nodes,
    meshes,
    'rippledExpansion',
    makeExpansionGeometry(rippledExpansion.dimensions),
    materials.get(rippledExpansion.material),
  );

  const glassAtriumCore = SFMOMA_V2_BLOCKOUT_COMPONENT_CONTRACT.glassAtriumCore;
  addComponent(
    root,
    nodes,
    meshes,
    'glassAtriumCore',
    new THREE.BoxGeometry(...glassAtriumCore.dimensions),
    materials.get(glassAtriumCore.material),
  );

  const oculusAssembly = new THREE.Group();
  oculusAssembly.name = 'sfmoma.v2.feature.oculusAssembly';
  oculusAssembly.position.set(0, 0.16, 0.13);
  oculusAssembly.rotation.set(0.24, 0, -0.28);
  oculusAssembly.userData.componentId = 'oculusAssembly';
  oculusAssembly.userData.pass = PASS_ID;
  oculusAssembly.userData.transformSpace = 'parent-local';
  oculusAssembly.userData.contactType = 'embedded-seam';
  stripedTurretNode.add(oculusAssembly);
  nodes.set('oculusAssembly', oculusAssembly);

  const oculusRing = new THREE.Mesh(makeOculusRingGeometry(), materials.get('stripedStone'));
  oculusRing.name = 'sfmoma.v2.mesh.oculusRing';
  oculusRing.castShadow = true;
  oculusRing.receiveShadow = true;
  oculusRing.userData.componentId = 'oculusAssembly';
  oculusRing.userData.pass = PASS_ID;
  oculusRing.userData.presentationOnly = true;
  oculusAssembly.add(oculusRing);
  meshes.set('oculusRing', oculusRing);

  const oculusGlazing = new THREE.Mesh(makeOculusGlazingGeometry(), materials.get('glass'));
  oculusGlazing.name = 'sfmoma.v2.mesh.oculusGlazing';
  oculusGlazing.position.set(0, 0, 0.035);
  oculusGlazing.castShadow = false;
  oculusGlazing.receiveShadow = true;
  oculusGlazing.userData.componentId = 'oculusGlazing';
  oculusGlazing.userData.pass = PASS_ID;
  oculusGlazing.userData.transformSpace = 'parent-local';
  oculusGlazing.userData.contactType = 'embedded-seam';
  oculusGlazing.userData.presentationOnly = true;
  oculusAssembly.add(oculusGlazing);
  nodes.set('oculusGlazing', oculusGlazing);
  meshes.set('oculusGlazing', oculusGlazing);

  root.updateMatrixWorld(true);
  const stats = countStats(root, textures);
  const finiteBounds = getFiniteBounds(root);
  const componentGeometry = getComponentGeometryDiagnostics(nodes, meshes);
  const oculusContact = getOculusContactDiagnostics(
    stripedTurretNode,
    oculusAssembly,
    oculusRing,
    oculusGlazing,
  );
  let disposed = false;

  const sockets = new Map([
    ['stripedTurret.oculusSeat', Object.freeze({
      parentId: 'stripedTurret',
      localPosition: Object.freeze([0, 0.16, 0.13]),
      localRotation: Object.freeze([0.24, 0, -0.28]),
      contactType: 'embedded-seam',
    })],
    ['oculusAssembly.glazingSeat', Object.freeze({
      parentId: 'oculusAssembly',
      localPosition: Object.freeze([0, 0, 0.035]),
      localRotation: Object.freeze([0, 0, 0]),
      contactType: 'embedded-seam',
    })],
  ]);

  const getDiagnostics = () => ({
    schemaVersion: 1,
    pass: PASS_ID,
    source: { ...SFMOMA_V2_BLOCKOUT_SOURCE },
    sourceBoundary: { ...SFMOMA_V2_SOURCE_BOUNDARY },
    componentCounts: {
      macro: SFMOMA_V2_BLOCKOUT_COMPONENT_IDS.length,
      features: FEATURE_IDS.length,
      nodes: nodes.size,
      meshes: meshes.size,
    },
    componentIds: [...SFMOMA_V2_BLOCKOUT_COMPONENT_IDS],
    featureIds: [...FEATURE_IDS],
    componentGeometry,
    oculusContact,
    finiteBounds,
    stats,
    budget: { ...SFMOMA_V2_BLOCKOUT_BUDGET },
    withinBudget: stats.drawCalls <= SFMOMA_V2_BLOCKOUT_BUDGET.maxDrawCalls
      && stats.triangles <= SFMOMA_V2_BLOCKOUT_BUDGET.maxTriangles
      && stats.geometries <= SFMOMA_V2_BLOCKOUT_BUDGET.maxGeometries
      && stats.materials <= SFMOMA_V2_BLOCKOUT_BUDGET.maxMaterials
      && stats.textures <= SFMOMA_V2_BLOCKOUT_BUDGET.maxTextures,
    identityFeatures: {
      steppedBrickWings: true,
      embeddedTurretMass: true,
      tiltedOculusOpening: true,
      contiguousExpansionMass: true,
    },
    blockedRepetitions: {
      status: 'blocked',
      count: SFMOMA_V2_BLOCKOUT_REPETITION_IDS.length,
      ids: [...SFMOMA_V2_BLOCKOUT_REPETITION_IDS],
      reason: 'Deferred until the subject-specific structural pass; none are represented by blockout geometry.',
    },
    noTextures: textures.size === 0,
    disposed,
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    const geometries = new Set();
    root.traverse((object) => {
      if (object.isMesh) geometries.add(object.geometry);
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
  };

  root.userData.sculptRuntime = {
    pass: PASS_ID,
    componentIds: [...SFMOMA_V2_BLOCKOUT_COMPONENT_IDS],
    featureIds: [...FEATURE_IDS],
    nodes,
    meshes,
    materials,
    sockets,
    colliders: new Map(),
    destructionGroups: new Map(),
    collisionAuthority: SFMOMA_V2_SOURCE_BOUNDARY.canonicalBuildingId,
    getDiagnostics,
    dispose,
  };

  return {
    root,
    nodes,
    meshes,
    materials,
    textures,
    stats,
    getDiagnostics,
    dispose,
  };
}
