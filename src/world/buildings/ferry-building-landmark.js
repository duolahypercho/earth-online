import * as THREE from 'three';

// This is an authored presentation layer, not survey-grade or photogrammetric
// reconstruction.  The OSM terminal footprint and the caller's ground sample
// remain the source of truth for its location and base volume.
export const FERRY_BUILDING_LANDMARK_SOURCE = Object.freeze({
  dataset: 'OpenStreetMap SF city snapshot',
  osmWay: 558731934,
  name: 'San Francisco Ferry Building',
});
export const FERRY_SANDSTONE_ALBEDO_URL = '/assets/polyhaven-sandstone-blocks-08-diffuse-2k.jpg';
export const FERRY_SANDSTONE_NORMAL_URL = '/assets/polyhaven-sandstone-blocks-08-normal-gl-2k.jpg';
export const FERRY_SANDSTONE_ORM_URL = '/assets/polyhaven-sandstone-blocks-08-orm-2k.png';

export const FERRY_BUILDING_LANDMARK_BUDGET = Object.freeze({
  // The authored facade stays batched by architectural role, never by bay.
  maxDrawCalls: 14,
  maxTriangles: 18000,
  maxInstances: 300,
});

const EPSILON = 0.08;
const FERRY_CLOCK_TOWER_HEIGHT_METRES = 74;
// The clock tower is the presentation anchor captured from the shipped OSM
// world tile. Its Y coordinate is the sampled ground elevation plus baseLift.
export const FERRY_CLOCK_TOWER_ANCHOR = Object.freeze([2281.5306, 1.88, 1936.6459]);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalisePoints(points) {
  if (!Array.isArray(points)) return [];
  const pairs = points.every(Number.isFinite)
    ? Array.from({ length: Math.floor(points.length / 2) }, (_, index) => [points[index * 2], points[index * 2 + 1]])
    : points.filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (pairs.length > 2 && Math.hypot(pairs[0][0] - pairs.at(-1)[0], pairs[0][1] - pairs.at(-1)[1]) < EPSILON) pairs.pop();
  return pairs;
}

function sourceIdMatches(value) {
  return String(value) === String(FERRY_BUILDING_LANDMARK_SOURCE.osmWay);
}

function isFerryBuilding(building) {
  return sourceIdMatches(building?.id) && normalisePoints(building?.points).length >= 3;
}

function sourceRenderMatches(mesh) {
  const data = mesh?.userData || {};
  // A multi-building instanced/chunked mesh cannot be hidden safely: doing so
  // would suppress unrelated OSM buildings, so it is intentionally refused.
  return sourceIdMatches(data.buildingId) || sourceIdMatches(data.building?.id);
}

function resolveElevation(building, elevationAt) {
  const points = normalisePoints(building.points);
  const samples = points.map(([x, z]) => Number(elevationAt(x, z))).filter(Number.isFinite);
  if (samples.length) return Math.min(...samples);
  const [x, z] = building.centroid || points[0];
  const sampled = Number(elevationAt(x, z));
  return Number.isFinite(sampled) ? sampled : 0;
}

function principalFrame(points, fallbackCentroid) {
  const center = fallbackCentroid?.length === 2 && fallbackCentroid.every(Number.isFinite)
    ? new THREE.Vector2(fallbackCentroid[0], fallbackCentroid[1])
    : points.reduce((sum, [x, z]) => sum.add(new THREE.Vector2(x, z)), new THREE.Vector2()).multiplyScalar(1 / points.length);
  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (const [x, z] of points) {
    const dx = x - center.x;
    const dz = z - center.y;
    xx += dx * dx;
    zz += dz * dz;
    xz += dx * dz;
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  const along = new THREE.Vector2(Math.cos(angle), Math.sin(angle));
  // Make the terminal direction deterministic. On the shipped OSM footprint
  // this points from the Market Street tower end toward the water-side wing.
  if (along.x < 0 || (Math.abs(along.x) < EPSILON && along.y < 0)) along.multiplyScalar(-1);
  const across = new THREE.Vector2(-along.y, along.x);
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  let minAlongPoint = null;
  let maxAlongPoint = null;
  for (const [x, z] of points) {
    const relativeX = x - center.x;
    const relativeZ = z - center.y;
    const projectedAlong = relativeX * along.x + relativeZ * along.y;
    const projectedAcross = relativeX * across.x + relativeZ * across.y;
    if (projectedAlong < minAlong) {
      minAlong = projectedAlong;
      minAlongPoint = new THREE.Vector2(x, z);
    }
    if (projectedAlong > maxAlong) {
      maxAlong = projectedAlong;
      maxAlongPoint = new THREE.Vector2(x, z);
    }
    minAcross = Math.min(minAcross, projectedAcross);
    maxAcross = Math.max(maxAcross, projectedAcross);
  }
  return {
    center,
    along,
    across,
    // Three's positive Y rotation maps local +X to (cos(yaw), -sin(yaw))
    // in this X/Z world. Negating the mathematical X/Z heading makes local
    // +X = `along` and local +Z = `across`, exactly matching this frame.
    threeYaw: -Math.atan2(along.y, along.x),
    minAlong,
    maxAlong,
    minAcross,
    maxAcross,
    minAlongPoint,
    maxAlongPoint,
    length: maxAlong - minAlong,
    width: maxAcross - minAcross,
  };
}

function localToWorld(frame, along, across, y) {
  return new THREE.Vector3(
    frame.center.x + frame.along.x * along + frame.across.x * across,
    y,
    frame.center.y + frame.along.y * along + frame.across.y * across,
  );
}

function boxMatrix(matrix, frame, along, across, y, length, height, width, yaw = frame.threeYaw) {
  return matrix.compose(
    localToWorld(frame, along, across, y),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
    new THREE.Vector3(length, height, width),
  );
}

function configureSandstoneTexture(texture, { name, colorSpace }) {
  texture.name = name;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Poly Haven's source is a real 3 m-wide material scan; this repeat keeps
  // its broad ashlar rhythm at facade scale instead of a tiny tiled decal.
  texture.repeat.set(1.8, 3.0);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.channel = 0;
  texture.needsUpdate = true;
  return texture;
}

function createFallbackSandstoneTexture(data, options) {
  const texture = new THREE.DataTexture(new Uint8Array(data), 1, 1, THREE.RGBAFormat);
  return configureSandstoneTexture(texture, options);
}

function createSandstonePbrTextures() {
  const fallback = {
    albedo: createFallbackSandstoneTexture([255, 255, 255, 255], {
      name: 'Ferry Building sandstone albedo fallback',
      colorSpace: THREE.SRGBColorSpace,
    }),
    normal: createFallbackSandstoneTexture([128, 128, 255, 255], {
      name: 'Ferry Building sandstone normal fallback',
      colorSpace: THREE.NoColorSpace,
    }),
    orm: createFallbackSandstoneTexture([255, 224, 0, 255], {
      name: 'Ferry Building sandstone ORM fallback',
      colorSpace: THREE.NoColorSpace,
    }),
  };
  const textures = new Set(Object.values(fallback));
  let disposed = false;

  function loadInto(materials, canApply) {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return false;
    const targets = Array.isArray(materials) ? materials : [materials];
    const loads = [
      {
        url: FERRY_SANDSTONE_ALBEDO_URL,
        key: 'albedo',
        name: 'Ferry Building sandstone albedo v1',
        colorSpace: THREE.SRGBColorSpace,
        apply: (material, texture) => { material.map = texture; },
      },
      {
        url: FERRY_SANDSTONE_NORMAL_URL,
        key: 'normal',
        name: 'Ferry Building sandstone normal v1',
        colorSpace: THREE.NoColorSpace,
        apply: (material, texture) => {
          material.normalMap = texture;
          material.normalScale.setScalar(0.18);
        },
      },
      {
        url: FERRY_SANDSTONE_ORM_URL,
        key: 'orm',
        name: 'Ferry Building sandstone ORM v1',
        colorSpace: THREE.NoColorSpace,
        apply: (material, texture) => {
          // Three samples R for AO, G for roughness, and B for metalness.
          material.aoMap = texture;
          material.roughnessMap = texture;
          material.metalnessMap = texture;
        },
      },
    ];
    for (const load of loads) {
      try {
        let pending = null;
        pending = new THREE.TextureLoader().load(
          load.url,
          (texture) => {
            configureSandstoneTexture(texture, { name: load.name, colorSpace: load.colorSpace });
            if (disposed || !canApply()) {
              texture.dispose();
              return;
            }
            textures.add(texture);
            for (const material of targets) {
              load.apply(material, texture);
              material.needsUpdate = true;
            }
          },
          undefined,
          () => {
            // Keep the neutral generated fallback. A failed presentation asset
            // must never make the OSM-aligned landmark disappear.
            pending?.dispose();
          },
        );
        configureSandstoneTexture(pending, { name: load.name, colorSpace: load.colorSpace });
      } catch {
        // TextureLoader is unavailable in deterministic node verification.
      }
    }
    return true;
  }

  return {
    fallback,
    loadInto,
    dispose() {
      disposed = true;
      for (const texture of textures) texture.dispose();
      textures.clear();
    },
  };
}

function createMaterials(sandstonePbr) {
  const sandstoneOptions = {
    map: sandstonePbr.albedo,
    normalMap: sandstonePbr.normal,
    normalScale: new THREE.Vector2(0.18, 0.18),
    aoMap: sandstonePbr.orm,
    roughnessMap: sandstonePbr.orm,
    metalnessMap: sandstonePbr.orm,
  };
  const materials = {
    // Ferry Building reads as sun-aged masonry rather than a saturated game
    // prop: the base is warmer, while ledges and the tower catch more light.
    // The camera-facing Ferry facade is frequently outside the single hero
    // sun shadow frustum during the locked launch card.  A restrained warm
    // masonry bounce keeps its existing recess/shadow hierarchy readable
    // without turning the stone into an unlit card or adding a light.
    sandstone: new THREE.MeshStandardMaterial({
      color: 0xd2c29f,
      roughness: 0.86,
      metalness: 0.0,
      emissive: 0x7a5b3d,
      emissiveIntensity: 0.18,
      ...sandstoneOptions,
    }),
    trimStone: new THREE.MeshStandardMaterial({ color: 0xe0cfaa, roughness: 0.8, metalness: 0.0 }),
    // This is also the deliberate cavity/reveal material. It stays dark enough
    // to read as depth, but not so dark that an arcade becomes black voids.
    weatherStone: new THREE.MeshStandardMaterial({ color: 0x765f49, roughness: 0.94, metalness: 0.0 }),
    towerStone: new THREE.MeshStandardMaterial({
      color: 0xd6c7a5,
      roughness: 0.82,
      metalness: 0.0,
      emissive: 0x7a5b3d,
      emissiveIntensity: 0.15,
      ...sandstoneOptions,
    }),
    // A weathered, low-sheen roof catches broad daylight without reading as
    // chrome. The small metal component is for its seams, not a mirror gloss.
    roof: new THREE.MeshStandardMaterial({ color: 0x465257, roughness: 0.78, metalness: 0.14 }),
    // Keep the source-footprint openings visibly recessed under the existing
    // sun and plaza lights.  The prior near-white, glossy upper glazing read
    // as painted panels at card distance, flattening the historic facade.
    glass: new THREE.MeshPhysicalMaterial({ color: 0x9bb8b4, roughness: 0.48, metalness: 0.0, clearcoat: 0.02, transparent: false }),
    // Per-bay instance colour carries the storefront variation. Keep this
    // neutral base bright so that variation is not multiplied into black.
    storefrontGlass: new THREE.MeshPhysicalMaterial({ color: 0xf2f5e9, roughness: 0.42, metalness: 0.03, clearcoat: 0.08, transparent: false, side: THREE.DoubleSide }),
    mullion: new THREE.MeshStandardMaterial({ color: 0x292721, roughness: 0.68, metalness: 0.18 }),
    clock: new THREE.MeshStandardMaterial({ color: 0xd8c99f, roughness: 0.68, metalness: 0.02, emissive: 0x000000, emissiveIntensity: 0 }),
    clockHand: new THREE.MeshStandardMaterial({ color: 0x202b2d, roughness: 0.5, metalness: 0.38 }),
  };
  return materials;
}

function makeBatch(root, name, geometry, material, capacity) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return { mesh, capacity };
}

function put(batch, matrix, color = null) {
  if (batch.mesh.count >= batch.capacity) return false;
  const index = batch.mesh.count;
  batch.mesh.setMatrixAt(index, matrix);
  if (color != null) batch.mesh.setColorAt(index, color instanceof THREE.Color ? color : new THREE.Color(color));
  batch.mesh.count += 1;
  return true;
}

function createArchPanelGeometry(segments = 10) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.5);
  shape.lineTo(0.5, -0.5);
  shape.lineTo(0.5, 0);
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * Math.PI;
    shape.lineTo(Math.cos(angle) * 0.5, Math.sin(angle) * 0.5);
  }
  shape.lineTo(-0.5, -0.5);
  return new THREE.ShapeGeometry(shape, 1);
}

function createFacadeSurroundGeometry({ arched = false, segments = 12 } = {}) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.5);
  shape.lineTo(0.5, -0.5);
  shape.lineTo(0.5, 0.5);
  shape.lineTo(-0.5, 0.5);
  shape.closePath();

  const opening = new THREE.Path();
  if (arched) {
    const radius = 0.36;
    const bottom = -0.43;
    const spring = 0.05;
    opening.moveTo(-radius, bottom);
    opening.lineTo(-radius, spring);
    for (let index = 0; index <= segments; index += 1) {
      const angle = Math.PI - (index / segments) * Math.PI;
      opening.lineTo(Math.cos(angle) * radius, spring + Math.sin(angle) * radius);
    }
    opening.lineTo(radius, bottom);
    opening.closePath();
  } else {
    opening.moveTo(-0.34, -0.28);
    opening.lineTo(-0.34, 0.29);
    opening.lineTo(0.34, 0.29);
    opening.lineTo(0.34, -0.28);
    opening.closePath();
  }
  shape.holes.push(opening);

  // Extruding the aperture creates real jamb, header/arch, and sill returns.
  // Center local Z so the same PCA frame transform works on both facade sides.
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    bevelEnabled: false,
    curveSegments: 1,
    steps: 1,
  });
  geometry.translate(0, 0, -0.5);
  geometry.computeVertexNormals();
  return geometry;
}

function createGableRoofGeometry() {
  const positions = new Float32Array([
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
    0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex([
    0, 2, 1, 3, 4, 5,
    0, 3, 5, 0, 5, 2,
    1, 2, 5, 1, 5, 4,
    0, 1, 4, 0, 4, 3,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

function createFootprintShell(points, baseY, height, material) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, baseY + height, 0);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Ferry Building authoritative OSM footprint shell';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function finishBatches(batches) {
  for (const batch of batches) {
    batch.mesh.instanceMatrix.needsUpdate = true;
    if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
    batch.mesh.computeBoundingSphere();
  }
}

function meshTriangleCount(mesh) {
  const vertices = mesh.geometry.index?.count || mesh.geometry.attributes.position?.count || 0;
  return (vertices / 3) * (mesh.isInstancedMesh ? mesh.count : 1);
}

function countMeshes(root) {
  const meshes = [];
  root.traverse((object) => { if (object.isMesh) meshes.push(object); });
  return meshes;
}

/**
 * Builds a low-call, source-aligned Ferry Building presentation. `building`
 * must be the exact OSM way; there is deliberately no coordinate fallback.
 * `sourceMesh` is optional and hidden only when it is itself the exact source
 * building render, then restored verbatim by dispose().
 */
export function createFerryBuildingLandmark(options = {}) {
  const scene = options.scene;
  if (!scene?.isObject3D) throw new Error('createFerryBuildingLandmark requires a Three.js scene or parent group.');
  const building = options.building;
  if (!isFerryBuilding(building)) {
    throw new Error(`Ferry Building landmark refused: expected OSM way ${FERRY_BUILDING_LANDMARK_SOURCE.osmWay} with a valid footprint.`);
  }
  const parent = options.parent?.isObject3D ? options.parent : scene;
  const points = normalisePoints(building.points);
  const frame = principalFrame(points, building.centroid);
  if (frame.length < 30 || frame.width < 10) {
    throw new Error('Ferry Building landmark refused: authoritative footprint is too small to articulate safely.');
  }
  const elevationAt = typeof options.elevationAt === 'function'
    ? options.elevationAt
    : typeof options.getElevation === 'function' ? options.getElevation : () => 0;
  const baseY = resolveElevation(building, elevationAt) + (Number.isFinite(options.baseLift) ? options.baseLift : 0.08);
  const sourceHeight = Number(building.height);
  const hallHeight = clamp(Number.isFinite(sourceHeight) ? sourceHeight : 15, 12, 18);
  const hallLength = frame.length * 0.91;
  const hallWidth = frame.width * 0.74;
  const hallCenterAlong = (frame.minAlong + frame.maxAlong) * 0.5;
  // The Market Street axis crosses the source footprint near its oriented
  // centre, not at either terminal end. The oriented-bounds midpoint is the
  // deterministic footprint-only equivalent of that source-road intersection.
  // Preserve the known OSM-world tower position instead of allowing minor
  // footprint simplification differences to make its skyline anchor drift.
  const canonicalTowerOffset = new THREE.Vector2(
    FERRY_CLOCK_TOWER_ANCHOR[0] - frame.center.x,
    FERRY_CLOCK_TOWER_ANCHOR[2] - frame.center.y,
  );
  const towerAlong = canonicalTowerOffset.dot(frame.along);
  const towerAcross = canonicalTowerOffset.dot(frame.across);
  const towerAnchor = localToWorld(frame, towerAlong, towerAcross, baseY);
  const sandstonePbr = createSandstonePbrTextures();
  const materials = createMaterials(sandstonePbr.fallback);
  let landmarkActive = true;
  const root = new THREE.Group();
  root.name = 'San Francisco Ferry Building landmark (OSM way 558731934)';
  root.userData.heroLandmark = true;
  root.userData.source = FERRY_BUILDING_LANDMARK_SOURCE;
  root.userData.proceduralApproximation = true;
  parent.add(root);
  sandstonePbr.loadInto(
    [materials.sandstone, materials.towerStone],
    () => landmarkActive,
  );

  const ownedGeometries = [];
  const shell = createFootprintShell(points, baseY, hallHeight, materials.sandstone);
  root.add(shell);
  ownedGeometries.push(shell.geometry);

  const cube = new THREE.BoxGeometry(1, 1, 1);
  const archPanel = createArchPanelGeometry();
  const groundSurround = createFacadeSurroundGeometry({ arched: true });
  const upperSurroundGeometry = createFacadeSurroundGeometry();
  const gableRoof = createGableRoofGeometry();
  const clockDisc = new THREE.CylinderGeometry(0.5, 0.5, 0.08, 20);
  clockDisc.rotateX(Math.PI / 2);
  const clockRing = new THREE.TorusGeometry(0.5, 0.045, 6, 20);
  const pyramid = new THREE.ConeGeometry(0.5, 1, 4);
  ownedGeometries.push(cube, archPanel, groundSurround, upperSurroundGeometry, gableRoof, clockDisc, clockRing, pyramid);
  const batches = [
    makeBatch(root, 'Ferry Building gabled terminal roof volumes', gableRoof, materials.roof, 4),
    makeBatch(root, 'Ferry Building ground-floor arched storefronts', archPanel, materials.storefrontGlass, 56),
    makeBatch(root, 'Ferry Building recessed upper windows and tower louvers', cube, materials.glass, 68),
    makeBatch(root, 'Ferry Building segmented ground arcade masonry', groundSurround, materials.sandstone, 56),
    makeBatch(root, 'Ferry Building segmented upper facade masonry', upperSurroundGeometry, materials.sandstone, 56),
    makeBatch(root, 'Ferry Building masonry courses cornices and canopies', cube, materials.trimStone, 32),
    makeBatch(root, 'Ferry Building bronze storefront and window divisions', cube, materials.mullion, 60),
    makeBatch(root, 'Ferry Building weathered plinth and tower shadow courses', cube, materials.weatherStone, 12),
    makeBatch(root, 'Ferry Building clock tower tiers', cube, materials.towerStone, 8),
    makeBatch(root, 'Ferry Building clock faces', clockDisc, materials.clock, 4),
    makeBatch(root, 'Ferry Building clock face stone bezels', clockRing, materials.trimStone, 4),
    makeBatch(root, 'Ferry Building clock hands', cube, materials.clockHand, 8),
  ];
  const [roof, storefront, upperWindow, groundArcade, upperFacade, cornice, mullion, weathering, tower, clockFace, clockBezel, clockHands] = batches;
  const matrix = new THREE.Matrix4();

  // Two pitched terminal wings terminate cleanly at the tower instead of one
  // flat lid spanning the entire OSM shell.
  const hallMinAlong = hallCenterAlong - hallLength * 0.5;
  const hallMaxAlong = hallCenterAlong + hallLength * 0.5;
  const roofGap = Math.min(15, hallLength * 0.09);
  const westRoofLength = Math.max(8, towerAlong - roofGap * 0.5 - hallMinAlong);
  const eastRoofLength = Math.max(8, hallMaxAlong - towerAlong - roofGap * 0.5);
  put(roof, boxMatrix(matrix, frame, hallMinAlong + westRoofLength * 0.5, 0, baseY + hallHeight, westRoofLength, 3.25, hallWidth * 0.94));
  put(roof, boxMatrix(matrix, frame, towerAlong + roofGap * 0.5 + eastRoofLength * 0.5, 0, baseY + hallHeight, eastRoofLength, 3.25, hallWidth * 0.94));
  for (const side of [-1, 1]) {
    const facadeAcross = side < 0 ? frame.minAcross : frame.maxAcross;
    put(cornice, boxMatrix(matrix, frame, hallCenterAlong, facadeAcross + side * 0.34, baseY + hallHeight - 0.18, hallLength + 0.55, 0.62, 0.52));
    put(cornice, boxMatrix(matrix, frame, hallCenterAlong, facadeAcross + side * 0.30, baseY + hallHeight * 0.60, hallLength * 0.985, 0.28, 0.38));
    put(cornice, boxMatrix(matrix, frame, hallCenterAlong, facadeAcross + side * 0.28, baseY + hallHeight * 0.20, hallLength * 0.985, 0.18, 0.32));
    put(weathering, boxMatrix(matrix, frame, hallCenterAlong, facadeAcross + side * 0.24, baseY + 0.52, hallLength * 0.99, 0.92, 0.28));
  }

  // Broad historic bays read more clearly at pedestrian distance than the
  // previous dense grid, and leave room for visible masonry between openings.
  const bayCount = clamp(Math.round(hallLength / 8.4), 18, 24);
  const baySpacing = hallLength / bayCount;
  const facadeCavityDepthMetres = 0.70;
  const surroundDepthMetres = 0.64;
  const groundBandHeight = 7.15;
  const upperBandHeight = hallHeight - groundBandHeight - 0.22;
  const facadeShadowRevealHeightMetres = 0.20;
  const upperGlassColors = [0x6f8d8e, 0x54777b, 0x8ba19d, 0x607f83];
  const storefrontColors = [0x52777a, 0x80644c, 0x416f72, 0x91734f, 0x5a7876];
  for (const side of [-1, 1]) {
    const facadeAcross = side < 0 ? frame.minAcross : frame.maxAcross;
    // Keep the whole surround outside the footprint shell. The rear return is
    // 12 cm proud of the source skin and the glazing is 6 cm proud, so the
    // authoritative backing cannot occlude the recessed pane.
    const surroundAcross = facadeAcross + side * 0.44;
    const glazingAcross = facadeAcross + side * 0.06;
    const divisionAcross = facadeAcross + side * 0.08;
    // A continuous shadowed stringcourse sits directly behind the proud trim.
    // It is intentionally a real volume (not a decal), making the two facade
    // stories read in sun and overcast while staying in the existing batch.
    put(weathering, boxMatrix(
      matrix,
      frame,
      hallCenterAlong,
      facadeAcross + side * 0.31,
      baseY + groundBandHeight + facadeShadowRevealHeightMetres * 0.5,
      hallLength * 0.992,
      facadeShadowRevealHeightMetres,
      0.34,
    ));
    for (let index = 0; index < bayCount; index += 1) {
      const along = hallCenterAlong - hallLength * 0.5 + baySpacing * (index + 0.5);
      const entranceBay = Math.abs(along - towerAlong) < baySpacing * 1.25;
      const serviceBay = index % 6 === (side > 0 ? 1 : 4);
      const upperWidth = baySpacing * 0.68;
      const upperHeight = upperBandHeight * 0.57;
      const upperY = baseY + groundBandHeight + upperBandHeight * 0.505;
      const storefrontWidth = baySpacing * 0.72;
      const storefrontHeight = groundBandHeight * 0.86;

      // Each masonry instance is an extruded wall segment with a true hole.
      // Its interior perimeter supplies the visible jamb/header/sill returns;
      // glazing closes the shallow cavity well behind the outer stone face.
      put(groundArcade, boxMatrix(matrix, frame, along, surroundAcross, baseY + groundBandHeight * 0.5, baySpacing + 0.035, groundBandHeight, surroundDepthMetres));
      put(upperFacade, boxMatrix(matrix, frame, along, surroundAcross, baseY + groundBandHeight + upperBandHeight * 0.5, baySpacing + 0.035, upperBandHeight, surroundDepthMetres));
      put(upperWindow, boxMatrix(matrix, frame, along, glazingAcross, upperY, upperWidth, upperHeight, 0.12), upperGlassColors[(index + (side > 0 ? 1 : 0)) % upperGlassColors.length]);
      put(storefront, boxMatrix(matrix, frame, along, glazingAcross, baseY + groundBandHeight * 0.46, storefrontWidth, storefrontHeight, 1), storefrontColors[(index * 2 + (side > 0 ? 1 : 0)) % storefrontColors.length]);

      // The arcade is the player-height read, so reserve the limited mullion
      // budget for one true centre division in every ground opening first.
      // Upper openings receive a slower rhythm instead of starving one whole
      // facade side when the bounded instanced batch reaches capacity.
      put(mullion, boxMatrix(matrix, frame, along, divisionAcross, baseY + groundBandHeight * 0.46, 0.11, storefrontHeight * 0.76, 0.12));
      if (index % 4 === 1) {
        put(mullion, boxMatrix(matrix, frame, along, divisionAcross, upperY, 0.085, upperHeight * 0.94, 0.10));
      }
      if (entranceBay || index % 6 === (side > 0 ? 4 : 1)) {
        put(cornice, boxMatrix(matrix, frame, along, facadeAcross + side * 0.68, baseY + 6.35, baySpacing * 0.78, 0.17, 1.28));
      }
    }
  }

  // Market Street axis: the clocked campanile provides the dominant hierarchy.
  const entranceAcross = towerAcross;
  const towerBase = Math.min(hallWidth * 0.5, 10.5);
  // The historic clock tower is approximately 245 ft tall. Keep that known
  // landmark scale explicit instead of deriving it from the 15 m terminal hall.
  const towerHeight = FERRY_CLOCK_TOWER_HEIGHT_METRES;
  const towerRoofHeight = towerBase * 0.54;
  const towerTierTopY = baseY + towerHeight - towerRoofHeight;
  const lowerTierHeight = towerHeight * 0.44;
  const middleTierHeight = towerHeight * 0.29;
  const clockTierHeight = towerTierTopY - baseY - lowerTierHeight - middleTierHeight;
  put(tower, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + lowerTierHeight * 0.5, towerBase, lowerTierHeight, towerBase));
  put(tower, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + lowerTierHeight + middleTierHeight * 0.5, towerBase * 0.77, middleTierHeight, towerBase * 0.77));
  put(tower, boxMatrix(matrix, frame, towerAlong, entranceAcross, towerTierTopY - clockTierHeight * 0.5, towerBase * 0.94, clockTierHeight, towerBase * 0.94));
  // Shadow courses articulate the otherwise tall shaft and visually seat the
  // enlarged clock stage without adding a mesh per tower face.
  put(weathering, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + lowerTierHeight, towerBase * 1.05, 0.42, towerBase * 1.05));
  put(weathering, boxMatrix(matrix, frame, towerAlong, entranceAcross, baseY + lowerTierHeight + middleTierHeight, towerBase * 0.87, 0.38, towerBase * 0.87));
  const towerRoof = new THREE.Mesh(pyramid, materials.roof);
  towerRoof.name = 'Ferry Building clock tower pyramidal roof';
  towerRoof.position.copy(localToWorld(frame, towerAlong, entranceAcross, towerTierTopY + towerRoofHeight * 0.5));
  towerRoof.scale.set(towerBase * 1.12, towerRoofHeight, towerBase * 1.12);
  towerRoof.rotation.y = frame.threeYaw + Math.PI / 4;
  towerRoof.castShadow = true;
  root.add(towerRoof);

  const louverY = baseY + lowerTierHeight + middleTierHeight * 0.48;
  const louverHeight = 4.6;
  for (const side of [-1, 1]) {
    const faceAcross = entranceAcross + side * (towerBase * 0.385 + 0.05);
    for (const offset of [-towerBase * 0.17, towerBase * 0.17]) {
      put(upperWindow, boxMatrix(matrix, frame, towerAlong + offset, faceAcross, louverY, towerBase * 0.20, louverHeight, 0.12), 0x35474a);
    }
  }
  for (const side of [-1, 1]) {
    const yaw = frame.threeYaw + Math.PI / 2;
    const faceAlong = towerAlong + side * (towerBase * 0.385 + 0.05);
    for (const offset of [-towerBase * 0.17, towerBase * 0.17]) {
      put(upperWindow, boxMatrix(matrix, frame, faceAlong, entranceAcross + offset, louverY, towerBase * 0.20, louverHeight, 0.12, yaw), 0x35474a);
    }
  }

  const clockY = towerTierTopY - clockTierHeight * 0.47;
  const clockDiameter = towerBase * 0.64;
  const clockFaceRecessDepthMetres = 0.18;
  for (const side of [-1, 1]) {
    const faceAcross = entranceAcross + side * (towerBase * 0.5 + 0.06);
    const handAcross = entranceAcross + side * (towerBase * 0.5 + 0.12);
    // Dark backplates turn the clock bezel into a legible stacked volume,
    // particularly against haze, without moving the documented clock anchor.
    put(weathering, boxMatrix(matrix, frame, towerAlong, entranceAcross + side * (towerBase * 0.5 - clockFaceRecessDepthMetres * 0.5), clockY, clockDiameter * 1.20, clockDiameter * 1.20, clockFaceRecessDepthMetres));
    put(clockFace, boxMatrix(matrix, frame, towerAlong, faceAcross, clockY, clockDiameter, clockDiameter, 1));
    put(clockBezel, boxMatrix(matrix, frame, towerAlong, faceAcross + side * 0.07, clockY, clockDiameter * 1.08, clockDiameter * 1.08, 1));
    put(clockHands, boxMatrix(matrix, frame, towerAlong + clockDiameter * 0.08, handAcross, clockY + clockDiameter * 0.035, clockDiameter * 0.04, clockDiameter * 0.05, clockDiameter * 0.55));
    put(clockHands, boxMatrix(matrix, frame, towerAlong - clockDiameter * 0.06, handAcross, clockY - clockDiameter * 0.035, clockDiameter * 0.42, clockDiameter * 0.05, clockDiameter * 0.04));
  }
  for (const side of [-1, 1]) {
    const yaw = frame.threeYaw + Math.PI / 2;
    const faceAlong = towerAlong + side * (towerBase * 0.5 + 0.06);
    const handAlong = towerAlong + side * (towerBase * 0.5 + 0.12);
    put(weathering, boxMatrix(matrix, frame, towerAlong + side * (towerBase * 0.5 - clockFaceRecessDepthMetres * 0.5), entranceAcross, clockY, clockDiameter * 1.20, clockDiameter * 1.20, clockFaceRecessDepthMetres, yaw));
    put(clockFace, boxMatrix(matrix, frame, faceAlong, entranceAcross, clockY, clockDiameter, clockDiameter, 1, yaw));
    put(clockBezel, boxMatrix(matrix, frame, faceAlong + side * 0.07, entranceAcross, clockY, clockDiameter * 1.08, clockDiameter * 1.08, 1, yaw));
    put(clockHands, boxMatrix(matrix, frame, handAlong, entranceAcross + clockDiameter * 0.08, clockY + clockDiameter * 0.035, clockDiameter * 0.04, clockDiameter * 0.05, clockDiameter * 0.55, yaw));
    put(clockHands, boxMatrix(matrix, frame, handAlong, entranceAcross - clockDiameter * 0.06, clockY - clockDiameter * 0.035, clockDiameter * 0.42, clockDiameter * 0.05, clockDiameter * 0.04, yaw));
  }
  finishBatches(batches);

  const meshes = countMeshes(root);
  const stats = Object.freeze({
    drawCalls: meshes.length,
    triangles: meshes.reduce((total, mesh) => total + meshTriangleCount(mesh), 0),
    instances: batches.reduce((total, batch) => total + batch.mesh.count, 0),
    sourceWay: FERRY_BUILDING_LANDMARK_SOURCE.osmWay,
    footprintPoints: points.length,
    hiddenSourceRender: Boolean(options.sourceMesh?.isObject3D && sourceRenderMatches(options.sourceMesh)),
    facadeBaysPerSide: bayCount,
    storefrontVariants: storefrontColors.length,
    segmentedFacadeOpenings: bayCount * 4,
    facadeCavityDepthMetres,
    facadeReturnDepthMetres: surroundDepthMetres,
    facadeShadowRevealHeightMetres,
    arcadeCentreDivisions: bayCount * 2,
    clockFaceRecessDepthMetres,
    facadeBackingClosed: true,
  });
  if (stats.drawCalls > FERRY_BUILDING_LANDMARK_BUDGET.maxDrawCalls
    || stats.triangles > FERRY_BUILDING_LANDMARK_BUDGET.maxTriangles
    || stats.instances > FERRY_BUILDING_LANDMARK_BUDGET.maxInstances) {
    root.removeFromParent();
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of Object.values(materials)) material.dispose();
    landmarkActive = false;
    sandstonePbr.dispose();
    throw new Error(`Ferry Building landmark exceeded its rendering budget (${stats.drawCalls} draws, ${stats.triangles} triangles, ${stats.instances} instances).`);
  }

  const sourceMesh = options.sourceMesh?.isObject3D && sourceRenderMatches(options.sourceMesh) ? options.sourceMesh : null;
  const originalSourceVisibility = sourceMesh?.visible;
  if (sourceMesh) sourceMesh.visible = false;
  let disposed = false;
  function update() {
    if (disposed) return;
    // Materials deliberately stay passive: the landmark has no emissive
    // clock pulse. Keep this method for the streaming lifecycle contract.
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    landmarkActive = false;
    if (sourceMesh) sourceMesh.visible = originalSourceVisibility;
    root.removeFromParent();
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of Object.values(materials)) material.dispose();
    sandstonePbr.dispose();
  }
  function getDiagnostics() {
    return {
      source: FERRY_BUILDING_LANDMARK_SOURCE,
      attached: Boolean(root.parent),
      hiddenSourceRender: Boolean(sourceMesh && !sourceMesh.visible),
      proceduralApproximation: true,
      frame: {
        along: [frame.along.x, frame.along.y],
        across: [frame.across.x, frame.across.y],
        threeYaw: frame.threeYaw,
        bounds: {
          minAlong: frame.minAlong,
          maxAlong: frame.maxAlong,
          minAcross: frame.minAcross,
          maxAcross: frame.maxAcross,
        },
        marketEndTarget: [frame.maxAlongPoint.x, frame.maxAlongPoint.y],
        oppositeEndTarget: [frame.minAlongPoint.x, frame.minAlongPoint.y],
      },
      towerAnchor: [towerAnchor.x, towerAnchor.y, towerAnchor.z],
      towerHeightMetres: towerHeight,
      pbr: {
        albedo: FERRY_SANDSTONE_ALBEDO_URL,
        normal: FERRY_SANDSTONE_NORMAL_URL,
        orm: FERRY_SANDSTONE_ORM_URL,
        presentationOnly: true,
        source: 'Poly Haven sandstone_blocks_08, CC0, Rob Tuytel, 3m source width',
      },
      disposed,
      stats,
    };
  }
  return Object.freeze({
    root,
    stats,
    update,
    getDiagnostics,
    dispose,
    get disposed() { return disposed; },
  });
}
