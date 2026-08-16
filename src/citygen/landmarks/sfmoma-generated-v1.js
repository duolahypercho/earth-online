import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const SFMOMA_GENERATED_V1_SOURCE = Object.freeze({
  id: 'sfmoma-generated-landmark-v1',
  reference: '/assets/hero/sfmoma-img2threejs-v1/reference.png',
  reconstruction: 'single-image-procedural-threejs',
  presentationOnly: true,
  hiddenElevations: 'approximate',
});

export const SFMOMA_GENERATED_V1_BUDGET = Object.freeze({
  maxDrawCalls: 42,
  maxTriangles: 48000,
  maxTextures: 6,
});

const box = (width, height, depth, radius = 0.08) => (
  new RoundedBoxGeometry(width, height, depth, 3, Math.min(radius, width * 0.2, height * 0.2, depth * 0.2))
);

function seededNoise(x, y, seed) {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

function configureTexture(texture, name, colorSpace) {
  texture.name = name;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 5);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function createSurfaceMaps(id, baseRgb, seed) {
  const size = 128;
  const albedo = new Uint8Array(size * size * 4);
  const roughness = new Uint8Array(size * size * 4);
  const height = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const grain = (seededNoise(x, y, seed) - 0.5) * 13;
      const broad = Math.sin((x + seed * 9) * 0.12) * 3 + Math.cos((y - seed * 5) * 0.09) * 2;
      const panelJoint = x % 41 <= 1 || y % 37 <= 1;
      albedo[offset] = THREE.MathUtils.clamp(baseRgb[0] + grain + broad - (panelJoint ? 15 : 0), 0, 255);
      albedo[offset + 1] = THREE.MathUtils.clamp(baseRgb[1] + grain + broad - (panelJoint ? 15 : 0), 0, 255);
      albedo[offset + 2] = THREE.MathUtils.clamp(baseRgb[2] + grain + broad - (panelJoint ? 15 : 0), 0, 255);
      albedo[offset + 3] = 255;
      const rough = THREE.MathUtils.clamp(188 + seededNoise(x + 19, y - 11, seed) * 38 + (panelJoint ? 20 : 0), 0, 255);
      roughness[offset] = rough;
      roughness[offset + 1] = rough;
      roughness[offset + 2] = rough;
      roughness[offset + 3] = 255;
      const relief = THREE.MathUtils.clamp(128 + grain * 2 - (panelJoint ? 32 : 0), 0, 255);
      height[offset] = relief;
      height[offset + 1] = relief;
      height[offset + 2] = relief;
      height[offset + 3] = 255;
    }
  }
  return {
    albedo: configureTexture(new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat), `${id}-albedo`, THREE.SRGBColorSpace),
    roughness: configureTexture(new THREE.DataTexture(roughness, size, size, THREE.RGBAFormat), `${id}-roughness`, THREE.NoColorSpace),
    height: configureTexture(new THREE.DataTexture(height, size, size, THREE.RGBAFormat), `${id}-height`, THREE.NoColorSpace),
  };
}

function createMaterials() {
  const concreteMaps = createSurfaceMaps('sfmoma-concrete-v1', [226, 224, 215], 2.1);
  const redMaps = createSurfaceMaps('sfmoma-red-cladding-v1', [142, 35, 28], 7.4);
  const materials = {
    concrete: new THREE.MeshStandardMaterial({
      name: 'SFMOMA pale precast concrete',
      color: 0xffffff,
      map: concreteMaps.albedo,
      roughness: 0.78,
      roughnessMap: concreteMaps.roughness,
      bumpMap: concreteMaps.height,
      bumpScale: 0.045,
      metalness: 0.02,
    }),
    redCladding: new THREE.MeshStandardMaterial({
      name: 'SFMOMA red ribbed cladding',
      color: 0xffffff,
      map: redMaps.albedo,
      roughness: 0.62,
      roughnessMap: redMaps.roughness,
      bumpMap: redMaps.height,
      bumpScale: 0.035,
      metalness: 0.12,
    }),
    redRibs: new THREE.MeshStandardMaterial({
      name: 'SFMOMA red tower ribs',
      color: 0x8f251f,
      roughness: 0.48,
      metalness: 0.22,
    }),
    charcoal: new THREE.MeshStandardMaterial({
      name: 'SFMOMA charcoal metal',
      color: 0x2b3033,
      roughness: 0.48,
      metalness: 0.38,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      name: 'SFMOMA blue-gray architectural glass',
      color: 0x577684,
      roughness: 0.16,
      metalness: 0.08,
      clearcoat: 0.82,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.15,
    }),
    warmInterior: new THREE.MeshStandardMaterial({
      name: 'SFMOMA warm interior glazing backing',
      color: 0x6f4b2b,
      emissive: 0xd18b45,
      emissiveIntensity: 0.52,
      roughness: 0.7,
      metalness: 0,
    }),
  };
  return { materials, textures: new Set([...Object.values(concreteMaps), ...Object.values(redMaps)]) };
}

function addMesh(parent, name, geometry, material, position, { rotation = [0, 0, 0], cast = true, receive = true } = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  parent.add(mesh);
  return mesh;
}

function makeTowerFoldGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-2.55, 0);
  shape.lineTo(2.25, 0);
  shape.lineTo(1.55, 31.8);
  shape.lineTo(-0.4, 34.2);
  shape.lineTo(-2.1, 29.4);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 5.4,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.09,
    bevelThickness: 0.09,
    curveSegments: 2,
  });
  geometry.translate(0, 0, -2.7);
  geometry.computeVertexNormals();
  return geometry;
}

function makeTowerWingGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-8.5, 0);
  shape.lineTo(1.5, 0);
  shape.lineTo(1.05, 24.0);
  shape.lineTo(-1.2, 20.8);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 3.8,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.08,
    bevelThickness: 0.08,
    curveSegments: 2,
  });
  geometry.translate(0, 0, -1.9);
  geometry.computeVertexNormals();
  return geometry;
}

function createInstancedBoxes(parent, name, geometry, material, transforms) {
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  transforms.forEach((transform, index) => {
    position.set(...transform.position);
    quaternion.setFromEuler(new THREE.Euler(...(transform.rotation || [0, 0, 0])));
    scale.set(...transform.scale);
    mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
  });
  mesh.instanceMatrix.needsUpdate = true;
  parent.add(mesh);
  return mesh;
}

function countStats(root, textures) {
  const geometries = new Set();
  const materials = new Set();
  let drawCalls = 0;
  let triangles = 0;
  let instances = 0;
  root.traverse((object) => {
    if (!object.isMesh) return;
    drawCalls += 1;
    geometries.add(object.geometry);
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    meshMaterials.forEach((material) => materials.add(material));
    const indexCount = object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0;
    const count = object.isInstancedMesh ? object.count : 1;
    triangles += Math.floor(indexCount / 3) * count;
    instances += count;
  });
  return Object.freeze({
    drawCalls,
    triangles,
    instances,
    geometries: geometries.size,
    materials: materials.size,
    textures: textures.size,
  });
}

export function createSfmomaGeneratedLandmark({ scale = 1 } = {}) {
  const root = new THREE.Group();
  root.name = 'SFMOMA generated landmark v1';
  root.scale.setScalar(scale);
  root.userData.source = { ...SFMOMA_GENERATED_V1_SOURCE };
  root.userData.componentIds = [];
  const { materials, textures } = createMaterials();

  const ground = new THREE.Group();
  ground.name = 'sfmoma.darkPodium';
  ground.userData.componentId = 'darkPodium';
  root.userData.componentIds.push('darkPodium');
  root.add(ground);
  addMesh(ground, 'SFMOMA podium shell', box(38.0, 5.3, 14.4, 0.16), materials.charcoal, [0, 2.65, 0]);
  addMesh(ground, 'SFMOMA podium floating canopy', box(18.5, 0.45, 2.4, 0.08), materials.concrete, [-1.8, 5.28, 6.35]);
  addMesh(ground, 'SFMOMA deep entry reveal', box(7.2, 3.75, 0.36, 0.06), materials.charcoal, [-2.7, 2.15, 7.28]);
  addMesh(ground, 'SFMOMA entry warm backing', box(6.4, 3.1, 0.12, 0.03), materials.warmInterior, [-2.7, 2.15, 7.5], { cast: false });

  const galleryStack = new THREE.Group();
  galleryStack.name = 'sfmoma.galleryStack';
  galleryStack.userData.componentId = 'galleryStack';
  root.userData.componentIds.push('galleryStack');
  root.add(galleryStack);
  const galleryVolumes = [
    { id: 'lower-left', size: [16.8, 5.8, 11.8], position: [-9.6, 7.9, -0.35] },
    { id: 'lower-right', size: [19.8, 6.4, 12.4], position: [8.2, 8.2, -0.15] },
    { id: 'middle-left', size: [17.5, 6.0, 10.6], position: [-10.0, 14.0, -0.85] },
    { id: 'middle-bridge', size: [22.5, 4.8, 10.2], position: [5.0, 15.4, -0.45] },
    { id: 'upper-gallery', size: [18.8, 5.4, 8.7], position: [-7.0, 20.7, -0.7] },
    { id: 'roof-gallery', size: [14.4, 4.9, 7.6], position: [-8.8, 26.0, -1.0] },
  ];
  for (const volume of galleryVolumes) {
    const mesh = addMesh(
      galleryStack,
      `SFMOMA gallery ${volume.id}`,
      box(...volume.size, 0.16),
      materials.concrete,
      volume.position,
    );
    mesh.userData.componentId = `gallery-${volume.id}`;
    root.userData.componentIds.push(mesh.userData.componentId);
  }

  const tower = new THREE.Group();
  tower.name = 'sfmoma.redTower';
  tower.userData.componentId = 'redTower';
  tower.position.set(5.45, 4.7, 0.4);
  tower.rotation.y = -0.035;
  root.userData.componentIds.push('redTower');
  root.add(tower);
  addMesh(tower, 'SFMOMA red folded tower mass', makeTowerFoldGeometry(), materials.redCladding, [0, 0, 0]);
  addMesh(tower, 'SFMOMA red folded tower wing', makeTowerWingGeometry(), materials.redCladding, [-0.2, 4.8, 0.65], { rotation: [0, -0.08, 0] });
  addMesh(tower, 'SFMOMA red tower glazed slot', box(1.35, 23.5, 0.22, 0.05), materials.glass, [-0.36, 17.0, 2.8], { cast: false });
  addMesh(tower, 'SFMOMA red tower crown', box(4.5, 2.2, 5.7, 0.16), materials.redCladding, [-0.25, 33.2, 0]);
  const ribTransforms = [];
  for (let index = 0; index < 20; index += 1) {
    const ratio = index / 19;
    const x = -2.15 + ratio * 4.0;
    const height = 27.0 + Math.sin(ratio * Math.PI) * 4.4;
    ribTransforms.push({
      position: [x, height * 0.5 + 1.5, 2.83],
      scale: [0.085, height, 0.17],
    });
    ribTransforms.push({
      position: [x, height * 0.5 + 1.5, -2.83],
      scale: [0.085, height, 0.17],
    });
  }
  createInstancedBoxes(tower, 'SFMOMA red tower vertical ribs', new THREE.BoxGeometry(1, 1, 1), materials.redRibs, ribTransforms);

  const glazing = new THREE.Group();
  glazing.name = 'sfmoma.glassSystems';
  glazing.userData.componentId = 'glassSystems';
  root.userData.componentIds.push('glassSystems');
  root.add(glazing);
  const glassBands = [
    { id: 'entry', face: 1, position: [-2.7, 2.15, 7.58], size: [6.3, 3.0, 0.15] },
    { id: 'lower', face: 1, position: [-2.0, 5.65, 7.34], size: [30.5, 1.55, 0.18] },
    { id: 'middle', face: 1, position: [-0.5, 15.8, 4.75], size: [25.5, 1.55, 0.18] },
    { id: 'upper', face: 1, position: [-7.2, 22.2, 3.72], size: [12.0, 1.45, 0.18] },
    { id: 'rear-lower', face: -1, position: [-5.8, 8.1, -6.31], size: [21.0, 1.5, 0.18] },
    { id: 'rear-middle', face: -1, position: [4.8, 15.7, -5.58], size: [19.0, 1.45, 0.18] },
    { id: 'rear-upper', face: -1, position: [-7.6, 23.0, -4.83], size: [11.0, 1.35, 0.18] },
  ];
  for (const band of glassBands) {
    addMesh(glazing, `SFMOMA curtain wall ${band.id}`, box(...band.size, 0.035), materials.glass, band.position, { cast: false });
    addMesh(glazing, `SFMOMA curtain wall ${band.id} warmth`, box(band.size[0] * 0.94, band.size[1] * 0.78, 0.08, 0.02), materials.warmInterior, [band.position[0], band.position[1], band.position[2] - band.face * 0.14], { cast: false });
  }
  const mullions = [];
  for (const band of glassBands) {
    const count = Math.max(4, Math.round(band.size[0] / 1.05));
    for (let index = 0; index <= count; index += 1) {
      mullions.push({
        position: [band.position[0] - band.size[0] * 0.5 + band.size[0] * index / count, band.position[1], band.position[2] + band.face * 0.11],
        scale: [0.055, band.size[1] * 1.03, 0.065],
      });
    }
    mullions.push({ position: [band.position[0], band.position[1], band.position[2] + band.face * 0.11], scale: [band.size[0], 0.055, 0.065] });
  }
  createInstancedBoxes(glazing, 'SFMOMA curtain-wall mullions', new THREE.BoxGeometry(1, 1, 1), materials.charcoal, mullions);

  const doors = [];
  for (let index = 0; index < 4; index += 1) {
    doors.push({ position: [-5.0 + index * 1.52, 1.72, 7.7], scale: [1.34, 2.58, 0.08] });
  }
  createInstancedBoxes(glazing, 'SFMOMA entry door glazing', new THREE.BoxGeometry(1, 1, 1), materials.glass, doors);
  const doorFrames = [];
  for (let index = 0; index <= 4; index += 1) {
    doorFrames.push({ position: [-5.75 + index * 1.52, 1.72, 7.76], scale: [0.07, 2.72, 0.09] });
  }
  doorFrames.push({ position: [-2.71, 3.06, 7.76], scale: [6.18, 0.08, 0.09] });
  createInstancedBoxes(glazing, 'SFMOMA entry door frames', new THREE.BoxGeometry(1, 1, 1), materials.charcoal, doorFrames);

  const stairs = [];
  for (let index = 0; index < 8; index += 1) {
    stairs.push({
      position: [-4.55 + index * 0.58, 0.72 + index * 0.19, 7.05 - index * 0.18],
      scale: [0.58, 0.18, 1.25],
    });
  }
  createInstancedBoxes(glazing, 'SFMOMA visible interior stair', new THREE.BoxGeometry(1, 1, 1), materials.concrete, stairs);

  const details = new THREE.Group();
  details.name = 'sfmoma.architecturalDetails';
  details.userData.componentId = 'architecturalDetails';
  root.userData.componentIds.push('architecturalDetails');
  root.add(details);
  const seams = [];
  for (const volume of galleryVolumes) {
    const [width, height, depth] = volume.size;
    const frontZ = volume.position[2] + depth * 0.5 + 0.015;
    const columns = Math.max(2, Math.floor(width / 3.2));
    for (let index = 1; index < columns; index += 1) {
      seams.push({
        position: [volume.position[0] - width * 0.5 + width * index / columns, volume.position[1], frontZ],
        scale: [0.035, height * 0.94, 0.025],
      });
    }
    seams.push({ position: [volume.position[0], volume.position[1], frontZ], scale: [width * 0.96, 0.035, 0.025] });
  }
  createInstancedBoxes(details, 'SFMOMA concrete panel seam relief', new THREE.BoxGeometry(1, 1, 1), materials.charcoal, seams);

  const louvers = [];
  for (let index = 0; index < 12; index += 1) {
    louvers.push({ position: [2.2, 0.72 + index * 0.25, 7.43], scale: [5.4, 0.08, 0.11] });
  }
  createInstancedBoxes(details, 'SFMOMA dark podium louver band', new THREE.BoxGeometry(1, 1, 1), materials.charcoal, louvers);

  const parapets = galleryVolumes.slice(2).map((volume) => ({
    position: [volume.position[0], volume.position[1] + volume.size[1] * 0.5 + 0.28, volume.position[2] + volume.size[2] * 0.5 - 0.2],
    scale: [volume.size[0] * 0.94, 0.48, 0.22],
  }));
  createInstancedBoxes(details, 'SFMOMA stepped roof parapets', new THREE.BoxGeometry(1, 1, 1), materials.concrete, parapets);

  const guards = [
    { position: [-9.25, 10.55, 4.1], scale: [5.5, 1.05, 0.12] },
    { position: [7.0, 12.2, 4.95], scale: [5.2, 1.05, 0.12] },
    { position: [-6.2, 16.25, 3.8], scale: [6.6, 1.0, 0.12] },
  ];
  createInstancedBoxes(details, 'SFMOMA terrace glass guards', new THREE.BoxGeometry(1, 1, 1), materials.glass, guards);

  addMesh(details, 'SFMOMA entry threshold', box(7.1, 0.18, 1.25, 0.035), materials.concrete, [-2.7, 0.18, 7.72]);
  addMesh(details, 'SFMOMA plaza grounding slab', box(29, 0.22, 16.0, 0.04), materials.charcoal, [0, -0.13, 0], { cast: false });

  root.traverse((object) => {
    if (object.isMesh) {
      object.userData.presentationOnly = true;
      object.userData.referenceAssetId = SFMOMA_GENERATED_V1_SOURCE.id;
    }
  });
  root.updateMatrixWorld(true);
  const stats = countStats(root, textures);
  let disposed = false;

  const diagnostics = {
    schemaVersion: 1,
    pass: 'sfmoma-img2threejs-v1',
    source: { ...SFMOMA_GENERATED_V1_SOURCE },
    componentIds: [...root.userData.componentIds],
    identityFeatures: {
      stackedGalleryVolumes: galleryVolumes.length,
      redTowerRibs: ribTransforms.length,
      rearCurtainWalls: glassBands.filter((band) => band.face === -1).length,
      curtainWallMullions: mullions.length,
      concreteSeams: seams.length,
      louvers: louvers.length,
      terraceGuards: guards.length,
      entryDoors: doors.length,
    },
    pbr: {
      independentChannels: true,
      concrete: { albedo: 'generated', roughness: 'generated-independent', bump: 'generated-independent' },
      redCladding: { albedo: 'generated', roughness: 'generated-independent', bump: 'generated-independent' },
      exactRecoveryClaimed: false,
    },
    stats,
    disposed: false,
  };

  return {
    root,
    materials,
    textures,
    stats,
    getDiagnostics: () => ({ ...diagnostics, disposed }),
    dispose() {
      if (disposed) return;
      disposed = true;
      const geometries = new Set();
      const materialSet = new Set();
      root.traverse((object) => {
        if (!object.isMesh) return;
        geometries.add(object.geometry);
        (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => materialSet.add(material));
      });
      root.removeFromParent();
      geometries.forEach((geometry) => geometry.dispose());
      materialSet.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
    },
  };
}
