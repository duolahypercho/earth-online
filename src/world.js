import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { applyTrafficSignalLensPhase, signalOffsetForPosition, signalPhaseAt } from './signals.js';
import interiorMaterialAtlasUrl from '../assets/interiors/sf-interior-material-atlas-v1.png';

const publicAsset = (path) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;

const CITY_HALF_X = 98;
const CITY_HALF_Z = 74;
const ROAD_HALF_WIDTH = 7;
const SIDEWALK_WIDTH = 3.8;
const GRADE_X = 0.022;
// The waterfront approach rises at a plausible four-percent urban grade.
// The previous eleven-percent climb placed the seawall above the opening
// camera's eye line, physically hiding the entire Bay behind the road crest.
const GRADE_Z = 0.042;

const X_ROADS = [-84, -28, 28, 84];
const Z_ROADS = [-64, 0, 64];

function streetHeight(x, z) {
  return GRADE_X * x + GRADE_Z * z;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function byteRgb(hex) {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function surfaceNoise(x, y, seed) {
  const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

function makeSurfaceTextures({ kind, base, accent, seed, repeat = 1 }) {
  const size = 128;
  const colorData = new Uint8Array(size * size * 4);
  const roughnessData = new Uint8Array(size * size * 4);
  const normalData = new Uint8Array(size * size * 4);
  const baseRgb = byteRgb(base);
  const accentRgb = byteRgb(accent);
  const heightAt = (px, py) => {
    const grain = surfaceNoise(px, py, seed);
    if (kind === 'brick') {
      const row = Math.floor(py / 14);
      const localX = (px + (row % 2) * 16) % 32;
      return py % 14 < 2 || localX < 2 ? 0.24 : grain * 0.035;
    }
    if (kind === 'asphalt') return grain * 0.04;
    if (kind === 'concrete') return grain * 0.06;
    return grain * 0.035;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const grain = surfaceNoise(x, y, seed);
      let mix = 0.08 + grain * 0.12;
      let roughness = 0.78 + grain * 0.16;
      let isSeam = false;

      if (kind === 'brick') {
        const row = Math.floor(y / 14);
        const localX = (x + (row % 2) * 16) % 32;
        isSeam = y % 14 < 2 || localX < 2;
        mix = isSeam ? 0.72 : 0.06 + grain * 0.15;
        roughness = isSeam ? 0.92 : 0.8 + grain * 0.14;
      } else if (kind === 'stucco') {
        mix = grain * 0.11;
        roughness = 0.76 + grain * 0.2;
      } else if (kind === 'asphalt') {
        const patch = surfaceNoise(Math.floor(x / 12), Math.floor(y / 12), seed + 4);
        mix = 0.06 + grain * 0.14 + (patch > 0.78 ? 0.12 : 0);
        roughness = 0.88 + grain * 0.1;
      } else if (kind === 'concrete') {
        mix = 0.12 + grain * 0.16;
        roughness = 0.86 + grain * 0.1;
      } else if (kind === 'glass') {
        const panelEdge = x % 24 < 2 || y % 32 < 2;
        mix = panelEdge ? 0.34 : 0.04 + grain * 0.08;
        roughness = panelEdge ? 0.38 : 0.18 + grain * 0.08;
      }

      const color = isSeam
        ? accentRgb
        : baseRgb.map((channel, channelIndex) => (
          Math.max(0, Math.min(255, Math.round(channel * (1 - mix) + accentRgb[channelIndex] * mix)))
        ));
      colorData[index] = color[0];
      colorData[index + 1] = color[1];
      colorData[index + 2] = color[2];
      colorData[index + 3] = 255;
      const rough = Math.round(roughness * 255);
      roughnessData[index] = rough;
      roughnessData[index + 1] = rough;
      roughnessData[index + 2] = rough;
      roughnessData[index + 3] = 255;

      const dx = heightAt(x + 1, y) - heightAt(x - 1, y);
      const dy = heightAt(x, y + 1) - heightAt(x, y - 1);
      const nx = -dx * 2.4;
      const ny = -dy * 2.4;
      const nz = 1;
      const normalLength = Math.hypot(nx, ny, nz);
      normalData[index] = Math.round((nx / normalLength * 0.5 + 0.5) * 255);
      normalData[index + 1] = Math.round((ny / normalLength * 0.5 + 0.5) * 255);
      normalData[index + 2] = Math.round((nz / normalLength * 0.5 + 0.5) * 255);
      normalData[index + 3] = 255;
    }
  }

  const colorMap = new THREE.DataTexture(colorData, size, size, THREE.RGBAFormat);
  colorMap.colorSpace = THREE.SRGBColorSpace;
  colorMap.wrapS = THREE.RepeatWrapping;
  colorMap.wrapT = THREE.RepeatWrapping;
  colorMap.repeat.set(repeat, repeat);
  colorMap.needsUpdate = true;

  const roughnessMap = new THREE.DataTexture(roughnessData, size, size, THREE.RGBAFormat);
  roughnessMap.colorSpace = THREE.NoColorSpace;
  roughnessMap.wrapS = THREE.RepeatWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.repeat.set(repeat, repeat);
  roughnessMap.needsUpdate = true;

  const normalMap = new THREE.DataTexture(normalData, size, size, THREE.RGBAFormat);
  normalMap.colorSpace = THREE.NoColorSpace;
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(repeat, repeat);
  normalMap.needsUpdate = true;

  return { colorMap, roughnessMap, normalMap };
}

function applySurface(material, textures) {
  material.map = textures.colorMap;
  material.map.anisotropy = 4;
  material.roughnessMap = textures.roughnessMap;
  material.normalMap = textures.normalMap;
  material.normalScale.set(0.22, 0.22);
  material.needsUpdate = true;
}

function slopedPlateGeometry(x0, x1, z0, z1, topOffset, depth) {
  const top = [
    streetHeight(x0, z0) + topOffset,
    streetHeight(x1, z0) + topOffset,
    streetHeight(x1, z1) + topOffset,
    streetHeight(x0, z1) + topOffset,
  ];

  const positions = new Float32Array([
    x0, top[0], z0,
    x1, top[1], z0,
    x1, top[2], z1,
    x0, top[3], z1,
    x0, top[0] - depth, z0,
    x1, top[1] - depth, z0,
    x1, top[2] - depth, z1,
    x0, top[3] - depth, z1,
  ]);

  const indices = [
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
  ], 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// A flat CircleGeometry makes puddles read as UI decals from a street-level
// camera.  This keeps the surface nearly planar for stable vehicle contact,
// while giving each wet patch an irregular, naturally worn shoreline.
function irregularSurfaceGeometry(seed = 1, segments = 18) {
  const positions = [0, 0, 0];
  const indices = [];
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5) >>> 0;
    return ((state ^ (state >>> 13)) >>> 0) / 4294967296;
  };
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const radius = 0.82 + next() * 0.22;
    positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
  }
  for (let index = 0; index < segments; index += 1) {
    const nextIndex = (index + 1) % segments;
    indices.push(0, index + 1, nextIndex + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function roundedFootprintGeometry(width, depth, height, radius = 0.3) {
  const halfWidth = width * 0.5;
  const halfDepth = depth * 0.5;
  const corner = Math.min(radius, halfWidth * 0.35, halfDepth * 0.35);
  const shape = new THREE.Shape();

  shape.moveTo(-halfWidth + corner, -halfDepth);
  shape.lineTo(halfWidth - corner, -halfDepth);
  shape.quadraticCurveTo(halfWidth, -halfDepth, halfWidth, -halfDepth + corner);
  shape.lineTo(halfWidth, halfDepth - corner);
  shape.quadraticCurveTo(halfWidth, halfDepth, halfWidth - corner, halfDepth);
  shape.lineTo(-halfWidth + corner, halfDepth);
  shape.quadraticCurveTo(-halfWidth, halfDepth, -halfWidth, halfDepth - corner);
  shape.lineTo(-halfWidth, -halfDepth + corner);
  shape.quadraticCurveTo(-halfWidth, -halfDepth, -halfWidth + corner, -halfDepth);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: corner * 0.55,
    bevelThickness: corner * 0.55,
    curveSegments: 2,
  });
  geometry.rotateX(-Math.PI * 0.5);
  geometry.computeVertexNormals();
  return geometry;
}

function gradeQuaternion(heading = 0) {
  const forward = new THREE.Vector3(
    Math.sin(heading),
    GRADE_X * Math.sin(heading) + GRADE_Z * Math.cos(heading),
    Math.cos(heading),
  ).normalize();
  const normal = new THREE.Vector3(-GRADE_X, 1, -GRADE_Z).normalize();
  const right = new THREE.Vector3().crossVectors(normal, forward).normalize();
  const correctedUp = new THREE.Vector3().crossVectors(forward, right).normalize();
  const basis = new THREE.Matrix4().makeBasis(right, correctedUp, forward);
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

function matrixAtGrade(x, z, yOffset, width, height, depth, heading = 0) {
  const position = new THREE.Vector3(x, streetHeight(x, z) + yOffset, z);
  const scale = new THREE.Vector3(width, height, depth);
  return new THREE.Matrix4().compose(position, gradeQuaternion(heading), scale);
}

/**
 * Creates a deterministic, compact San Francisco-inspired city district.
 *
 * @param {{ scene: THREE.Scene, renderer?: THREE.WebGLRenderer }} options
 */
export function createCity({ scene, renderer }) {
  if (!scene?.isScene) {
    throw new TypeError('createCity requires a THREE.Scene.');
  }

  const random = mulberry32(0x53464349);
  const group = new THREE.Group();
  group.name = 'San Francisco Micro District';
  const hasExternalLighting = scene.children.some((child) => child.isLight);

  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x5b789e) },
      horizonColor: { value: new THREE.Color(0xe3b8a0) },
      sunColor: { value: new THREE.Color(0xffd0a0) },
      sunDirection: { value: new THREE.Vector3(-0.62, 0.67, 0.37).normalize() },
      time: { value: 0 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 sunColor;
      uniform vec3 sunDirection;
      uniform float time;
      varying vec3 vWorldPosition;
      void main() {
        vec3 viewDirection = normalize(vWorldPosition - cameraPosition);
        float height = clamp(viewDirection.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 sky = mix(horizonColor, topColor, smoothstep(0.12, 0.82, height));
        vec2 cloudUv = vWorldPosition.xz * 0.012 + vec2(time * 0.00075, time * 0.00028);
        float cloudField = sin(cloudUv.x + sin(cloudUv.y * 1.7) * 1.4) * 0.5 + 0.5;
        cloudField += (sin(cloudUv.x * 2.7 + cloudUv.y * 1.3) * 0.5 + 0.5) * 0.28;
        float horizonCloud = 1.0 - smoothstep(0.02, 0.42, abs(viewDirection.y));
        float cloud = smoothstep(0.62, 0.9, cloudField) * horizonCloud;
        sky = mix(sky, sky * 1.07 + vec3(0.025, 0.022, 0.018), cloud * 0.22);
        float sun = max(dot(viewDirection, sunDirection), 0.0);
        sky += sunColor * pow(sun, 160.0) * 0.75;
        sky += sunColor * pow(sun, 10.0) * 0.06;
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(360, 48, 24), skyMaterial);
  sky.name = 'Procedural Pacific sky';
  sky.frustumCulled = false;
  sky.renderOrder = -100;
  group.add(sky);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  // A higher-resolution icosphere keeps the instanced street trees cheap while
  // removing the obvious dodecahedron facets that made every canopy read like
  // a toy lollipop at the hero distance.
  const lowPolySphere = new THREE.IcosahedronGeometry(1, 2);
  const roundedVehicleGeometry = new RoundedBoxGeometry(1, 1, 1, 0.11, 3);
  const wheelGeometry = new THREE.CylinderGeometry(0.28, 0.28, 0.2, 10);
  const signalLensGeometry = new THREE.SphereGeometry(0.16, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.58);
  const manholeRingGeometry = new THREE.TorusGeometry(0.39, 0.022, 8, 24);

  const materials = {
    asphalt: new THREE.MeshStandardMaterial({ color: 0x4d5152, roughness: 0.86, metalness: 0.04 }),
    asphaltEdge: new THREE.MeshStandardMaterial({ color: 0x5c5f5e, roughness: 0.94 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0xb6afa4, roughness: 0.88 }),
    curb: new THREE.MeshStandardMaterial({ color: 0xd2cbc0, roughness: 0.82 }),
    sidewalkSeam: new THREE.MeshStandardMaterial({ color: 0x827e78, roughness: 0.98 }),
    lot: new THREE.MeshStandardMaterial({ color: 0x8e897f, roughness: 0.94 }),
    earth: new THREE.MeshStandardMaterial({ color: 0x4d5545, roughness: 1 }),
    laneWhite: new THREE.MeshStandardMaterial({ color: 0xd5d0c3, roughness: 0.84 }),
    laneYellow: new THREE.MeshStandardMaterial({ color: 0xc59e42, roughness: 0.86 }),
    metalDark: new THREE.MeshStandardMaterial({ color: 0x20272a, roughness: 0.48, metalness: 0.76 }),
    paintedMetal: new THREE.MeshStandardMaterial({ color: 0x354043, roughness: 0.56, metalness: 0.52 }),
    signGreen: new THREE.MeshStandardMaterial({ color: 0x1c634d, roughness: 0.58, metalness: 0.18 }),
    signLetter: new THREE.MeshStandardMaterial({ color: 0xf2eee2, roughness: 0.72 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x3e5c63,
      emissive: 0x09171c,
      emissiveIntensity: 0.05,
      roughness: 0.3,
      metalness: 0.28,
      envMapIntensity: 1.25,
      envMap: scene.environment,
    }),
    glassLight: new THREE.MeshStandardMaterial({
      color: 0x8c9fa0,
      emissive: 0x101b1c,
      emissiveIntensity: 0.04,
      roughness: 0.3,
      metalness: 0.2,
      envMap: scene.environment,
    }),
    limestone: new THREE.MeshStandardMaterial({ color: 0xcac0aa, roughness: 0.7, metalness: 0.04 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x4c5252, roughness: 0.72, metalness: 0.32 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x85553b, roughness: 0.76 }),
    planter: new THREE.MeshStandardMaterial({ color: 0x6b5041, roughness: 0.9 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x654838, roughness: 1 }),
    foliage: new THREE.MeshStandardMaterial({ color: 0x55794f, roughness: 0.96 }),
    foliageSun: new THREE.MeshStandardMaterial({ color: 0x718d55, roughness: 0.94 }),
    fireEscape: new THREE.MeshStandardMaterial({ color: 0x1e2526, roughness: 0.5, metalness: 0.78 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x17191a, roughness: 0.9 }),
    carGlass: new THREE.MeshStandardMaterial({ color: 0x243b46, roughness: 0.18, metalness: 0.46, envMap: scene.environment }),
    hydrant: new THREE.MeshStandardMaterial({ color: 0xa63e2f, roughness: 0.6, metalness: 0.4 }),
    wire: new THREE.MeshStandardMaterial({
      color: 0x667571,
      roughness: 0.9,
      metalness: 0.12,
      transparent: true,
      opacity: 0.43,
      depthWrite: false,
    }),
    manhole: new THREE.MeshStandardMaterial({ color: 0x646766, roughness: 0.74, metalness: 0.72 }),
    drain: new THREE.MeshStandardMaterial({ color: 0x2a2d2d, roughness: 0.86, metalness: 0.55 }),
  };

  // Shared, mid-value finishes for the transit hardware. These are declared
  // before the overhead trolley supports are assembled below; keeping them in
  // one place also prevents the mast, signal, and lamp materials from falling
  // back to near-black silhouettes under the cinematic exposure.
  const infrastructureMaterial = new THREE.MeshStandardMaterial({
    color: 0x3d4c4a,
    roughness: 0.68,
    metalness: 0.5,
    envMap: scene.environment,
    envMapIntensity: 0.72,
  });
  const infrastructureHousingMaterial = new THREE.MeshStandardMaterial({
    color: 0x2f3d3b,
    roughness: 0.74,
    metalness: 0.38,
    envMap: scene.environment,
    envMapIntensity: 0.64,
  });

  const masonryMaterials = [
    new THREE.MeshStandardMaterial({ color: 0x9f6658, roughness: 0.83 }),
    new THREE.MeshStandardMaterial({ color: 0xb78d69, roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ color: 0x75868a, roughness: 0.76 }),
    new THREE.MeshStandardMaterial({ color: 0xd0b48a, roughness: 0.84 }),
    new THREE.MeshStandardMaterial({ color: 0x826a72, roughness: 0.81 }),
    new THREE.MeshStandardMaterial({ color: 0xddd2bd, roughness: 0.78 }),
    new THREE.MeshStandardMaterial({ color: 0x6f8072, roughness: 0.82 }),
  ];
  let heroRoadMaterial = null;
  let heroSidewalkMaterial = null;
  let heroGutterMaterial = null;
  let heroPuddleMaterial = null;
  let heroPuddleEdgeMaterial = null;
  let heroPuddleSheenMaterial = null;
  let heroSidewalkSeamMaterial = null;
  let heroSidewalkWearMaterial = null;
  let heroCurbMaterial = null;
  let heroDrainMaterial = null;
  const heroPuddles = [];
  const heroPuddleEdges = [];
  const heroPuddleSheens = [];

  applySurface(
    materials.asphalt,
    makeSurfaceTextures({ kind: 'asphalt', base: 0x4d5152, accent: 0x858888, seed: 11, repeat: 9 }),
  );
  applySurface(
    materials.concrete,
    makeSurfaceTextures({ kind: 'concrete', base: 0xb6afa4, accent: 0x8b877e, seed: 14, repeat: 5 }),
  );
  applySurface(
    materials.curb,
    makeSurfaceTextures({ kind: 'concrete', base: 0xd2cbc0, accent: 0x9e978c, seed: 18, repeat: 4 }),
  );
  masonryMaterials.forEach((material, index) => {
    const kind = index % 3 === 0 ? 'brick' : index % 3 === 1 ? 'stucco' : 'concrete';
    applySurface(
      material,
      makeSurfaceTextures({
        kind,
        base: material.color.getHex(),
        accent: index % 2 ? 0x4b403b : 0xddd6c7,
        seed: 30 + index,
        repeat: kind === 'brick' ? 4 : 3,
      }),
    );
  });
  applySurface(
    materials.glass,
    makeSurfaceTextures({ kind: 'glass', base: 0x3e606a, accent: 0x9ab3b2, seed: 71, repeat: 9 }),
  );
  applySurface(
    materials.glassLight,
    makeSurfaceTextures({ kind: 'glass', base: 0x719093, accent: 0xc1cfca, seed: 73, repeat: 8 }),
  );
  materials.glass.normalScale.set(0.08, 0.08);
  materials.glassLight.normalScale.set(0.06, 0.06);

  // A photographic plaster/brick scan is used on the hero masonry instead
  // of relying on a single-color shader. Keep the procedural maps on the
  // remaining buildings so the district still has controlled variation.
  if (typeof document !== 'undefined') {
    const facadeTexture = new THREE.TextureLoader().load(publicAsset('assets/sf-facade-plaster.png'));
    facadeTexture.colorSpace = THREE.SRGBColorSpace;
    facadeTexture.wrapS = THREE.RepeatWrapping;
    facadeTexture.wrapT = THREE.RepeatWrapping;
    // Keep the hero material large enough to read as a continuous wall. A
    // tight repeat made the photographic detail announce itself as a game
    // texture instead of weathered masonry.
    facadeTexture.repeat.set(0.82, 1.35);
    [masonryMaterials[0], masonryMaterials[2], masonryMaterials[5]].forEach((material) => {
      material.color.set(0xffffff);
      material.map = facadeTexture;
      material.needsUpdate = true;
    });

    const sidingTexture = new THREE.TextureLoader().load(publicAsset('assets/sf-victorian-siding.png'));
    sidingTexture.colorSpace = THREE.SRGBColorSpace;
    sidingTexture.wrapS = THREE.RepeatWrapping;
    sidingTexture.wrapT = THREE.RepeatWrapping;
    sidingTexture.repeat.set(0.78, 2.15);
    [masonryMaterials[3], masonryMaterials[4], masonryMaterials[6]].forEach((material) => {
      material.color.set(0xffffff);
      material.map = sidingTexture;
      material.needsUpdate = true;
    });

    const asphaltPhoto = new THREE.TextureLoader().load(publicAsset('assets/sf-asphalt.png'));
    asphaltPhoto.colorSpace = THREE.SRGBColorSpace;
    asphaltPhoto.wrapS = THREE.RepeatWrapping;
    asphaltPhoto.wrapT = THREE.RepeatWrapping;
    // The authored hero plate is 14 × 128 m. Fewer than three repeats made
    // the photographed aggregate several decimetres wide in the beauty view.
    // Keep every channel on a shared physical scale so gravel, roughness and
    // normals remain aligned instead of sliding at different frequencies.
    const asphaltTileMeters = 2.8;
    const asphaltRepeat = new THREE.Vector2(
      14 / asphaltTileMeters,
      128 / asphaltTileMeters,
    );
    const asphaltAnisotropy = Math.min(
      8,
      renderer?.capabilities?.getMaxAnisotropy?.() ?? 1,
    );
    asphaltPhoto.repeat.copy(asphaltRepeat);
    asphaltPhoto.anisotropy = asphaltAnisotropy;
    heroRoadMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: asphaltPhoto,
      roughness: 0.94,
      metalness: 0.02,
      clearcoat: 0.02,
      clearcoatRoughness: 0.46,
    });
    const heroAsphaltDetail = makeSurfaceTextures({
      kind: 'asphalt',
      base: 0x4a5050,
      accent: 0x858a88,
      seed: 111,
      repeat: 5,
    });
    heroAsphaltDetail.roughnessMap.repeat.copy(asphaltRepeat);
    heroAsphaltDetail.normalMap.repeat.copy(asphaltRepeat);
    heroAsphaltDetail.roughnessMap.anisotropy = asphaltAnisotropy;
    heroAsphaltDetail.normalMap.anisotropy = asphaltAnisotropy;
    heroRoadMaterial.roughnessMap = heroAsphaltDetail.roughnessMap;
    heroRoadMaterial.normalMap = heroAsphaltDetail.normalMap;
    heroRoadMaterial.normalScale.set(0.18, 0.18);
    heroRoadMaterial.envMap = scene.environment;
    heroRoadMaterial.envMapIntensity = 0.42;
    const heroRoadSurface = new THREE.Mesh(
      slopedPlateGeometry(21, 35, -64, 64, 0.035, 0.025),
      heroRoadMaterial,
    );
    heroRoadSurface.name = 'Photographic hero asphalt';
    heroRoadSurface.receiveShadow = true;
    group.add(heroRoadSurface);

    const sidewalkPhoto = new THREE.TextureLoader().load(publicAsset('assets/sf-sidewalk.png'));
    sidewalkPhoto.colorSpace = THREE.SRGBColorSpace;
    sidewalkPhoto.wrapS = THREE.RepeatWrapping;
    sidewalkPhoto.wrapT = THREE.RepeatWrapping;
    sidewalkPhoto.repeat.set(0.72, 2.84);
    heroSidewalkMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: sidewalkPhoto,
      roughness: 0.9,
      metalness: 0.01,
    });
    const heroConcreteDetail = makeSurfaceTextures({
      kind: 'concrete',
      base: 0xb8b2a9,
      accent: 0x77736c,
      seed: 118,
      repeat: 4,
    });
    heroSidewalkMaterial.roughnessMap = heroConcreteDetail.roughnessMap;
    heroSidewalkMaterial.normalMap = heroConcreteDetail.normalMap;
    heroSidewalkMaterial.normalScale.set(0.18, 0.18);
    [
      [17.2, 21],
      [35, 38.8],
    ].forEach(([x0, x1], index) => {
      const sidewalkSurface = new THREE.Mesh(
        slopedPlateGeometry(x0, x1, -64, 64, 0.25, 0.01),
        heroSidewalkMaterial,
      );
      sidewalkSurface.name = `Photographic hero sidewalk ${index + 1}`;
      sidewalkSurface.receiveShadow = true;
      group.add(sidewalkSurface);
    });

    // A narrow, darker curb channel and a handful of shallow puddles stop
    // the photo sidewalk from reading as a clean rectangular mask. They are
    // deliberately independent of the base map so drizzle can change their
    // response without reauthoring the sidewalk texture.
    heroGutterMaterial = new THREE.MeshStandardMaterial({
      color: 0x566466,
      roughness: 0.78,
      metalness: 0.04,
    });
    [
      [20.35, 21.0],
      [35.0, 35.65],
    ].forEach(([x0, x1], index) => {
      const gutter = new THREE.Mesh(
        slopedPlateGeometry(x0, x1, -64, 64, 0.09, 0.008),
        heroGutterMaterial,
      );
      gutter.name = `Hero curb channel ${index + 1}`;
      gutter.receiveShadow = true;
      group.add(gutter);
    });
    // Raised curb noses and proper drainage slots give the photograph-based
    // sidewalk a physical edge instead of a flat rectangular overlay.
    heroCurbMaterial = new THREE.MeshStandardMaterial({
      color: 0xb9b2a8,
      roughness: 0.88,
      metalness: 0.02,
    });
    [
      [20.62, 21.06],
      [34.94, 35.38],
    ].forEach(([x0, x1], index) => {
      const curb = new THREE.Mesh(
        slopedPlateGeometry(x0, x1, -64, 64, 0.31, 0.17),
        heroCurbMaterial,
      );
      curb.name = `Raised hero curb ${index + 1}`;
      curb.castShadow = true;
      curb.receiveShadow = true;
      group.add(curb);
    });

    heroDrainMaterial = new THREE.MeshStandardMaterial({
      color: 0x232b2b,
      roughness: 0.48,
      metalness: 0.68,
    });
    for (const z of [-47, -31, -15, 2, 19, 36, 53]) {
      for (const x of [20.83, 35.17]) {
        const grate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.045, 0.16), heroDrainMaterial);
        grate.position.set(x, streetHeight(x, z) + 0.326, z);
        grate.userData.noShadow = true;
        grate.userData.noReceiveShadow = true;
        group.add(grate);
        for (let slot = -1; slot <= 1; slot += 1) {
          const slotMesh = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.2), heroDrainMaterial);
          slotMesh.position.set(x + slot * 0.12, streetHeight(x, z) + 0.355, z);
          slotMesh.userData.noShadow = true;
          slotMesh.userData.noReceiveShadow = true;
          group.add(slotMesh);
        }
      }
    }

    // San Francisco curb ramps are visually legible from half a block away
    // because the ochre truncated-dome pads interrupt the otherwise pale
    // concrete. One shared procedural texture and one instanced draw retain
    // that public-realm specificity without adding dozens of dome meshes.
    const tactileCanvas = document.createElement('canvas');
    tactileCanvas.width = 96;
    tactileCanvas.height = 128;
    const tactileContext = tactileCanvas.getContext('2d');
    tactileContext.fillStyle = '#b79235';
    tactileContext.fillRect(0, 0, tactileCanvas.width, tactileCanvas.height);
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        const centerX = 10 + column * 19;
        const centerY = 11 + row * 21;
        const dome = tactileContext.createRadialGradient(
          centerX - 1.5, centerY - 1.5, 1,
          centerX, centerY, 6.2,
        );
        dome.addColorStop(0, '#e0c56d');
        dome.addColorStop(0.56, '#c9a64a');
        dome.addColorStop(1, '#896c29');
        tactileContext.fillStyle = dome;
        tactileContext.beginPath();
        tactileContext.arc(centerX, centerY, 6.2, 0, Math.PI * 2);
        tactileContext.fill();
      }
    }
    const tactileTexture = new THREE.CanvasTexture(tactileCanvas);
    tactileTexture.colorSpace = THREE.SRGBColorSpace;
    tactileTexture.anisotropy = asphaltAnisotropy;
    const tactileMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tactileTexture,
      bumpMap: tactileTexture,
      bumpScale: 0.065,
      roughness: 0.9,
      metalness: 0,
    });
    const tactilePads = new THREE.InstancedMesh(unitBox, tactileMaterial, 4);
    [
      [19.28, -5.45],
      [36.72, -5.45],
      [19.28, 5.45],
      [36.72, 5.45],
    ].forEach(([x, z], index) => {
      tactilePads.setMatrixAt(index, matrixAtGrade(x, z, 0.286, 1.34, 0.026, 1.68));
    });
    tactilePads.name = 'Central intersection tactile curb ramps';
    tactilePads.instanceMatrix.needsUpdate = true;
    tactilePads.computeBoundingSphere();
    tactilePads.receiveShadow = true;
    tactilePads.userData.noShadow = true;
    group.add(tactilePads);

    // Utility cuts, crack-seal lines and wheel-polished channels interrupt
    // the photographic road plane at a real street-maintenance scale. Both
    // families are instanced, adding two draw calls for the whole hero block.
    const utilityCutMaterial = new THREE.MeshStandardMaterial({
      color: 0x5b6060,
      roughness: 0.98,
      metalness: 0,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    const utilityCuts = new THREE.InstancedMesh(unitBox, utilityCutMaterial, 5);
    [
      [24.1, -49, 1.55, 4.8, -0.025],
      [31.7, -27, 1.2, 3.9, 0.035],
      [25.3, -8, 1.8, 5.4, -0.018],
      [31.9, 24, 1.45, 4.4, 0.028],
      [24.5, 47, 1.1, 3.6, -0.032],
    ].forEach(([x, z, width, depth, heading], index) => {
      utilityCuts.setMatrixAt(
        index,
        matrixAtGrade(x, z, 0.051, width, 0.018, depth, heading),
      );
    });
    utilityCuts.name = 'Hero avenue utility trench repairs';
    utilityCuts.instanceMatrix.needsUpdate = true;
    utilityCuts.computeBoundingSphere();
    utilityCuts.receiveShadow = true;
    utilityCuts.userData.noShadow = true;
    group.add(utilityCuts);

    const crackSealMaterial = new THREE.MeshStandardMaterial({
      color: 0x202727,
      roughness: 0.78,
      transparent: true,
      opacity: 0.46,
      depthWrite: false,
    });
    const crackSeals = new THREE.InstancedMesh(unitBox, crackSealMaterial, 12);
    [
      [22.8, -55, 0.025, 2.1, -0.14], [29.8, -45, 0.035, 1.6, 0.09],
      [33.2, -36, 0.028, 2.8, -0.07], [26.5, -31, 0.024, 1.7, 0.16],
      [23.5, -20, 0.03, 2.4, -0.11], [31.2, -13, 0.024, 1.8, 0.08],
      [24.9, 9, 0.032, 2.1, 0.13], [32.5, 16, 0.026, 2.9, -0.12],
      [22.7, 29, 0.025, 1.9, 0.1], [29.4, 35, 0.034, 2.5, -0.08],
      [33.1, 44, 0.024, 1.7, 0.15], [25.8, 55, 0.03, 2.2, -0.1],
    ].forEach(([x, z, width, depth, heading], index) => {
      crackSeals.setMatrixAt(
        index,
        matrixAtGrade(x, z, 0.063, width, 0.012, depth, heading),
      );
    });
    crackSeals.name = 'Hero avenue crack-seal repairs';
    crackSeals.instanceMatrix.needsUpdate = true;
    crackSeals.computeBoundingSphere();
    crackSeals.userData.noShadow = true;
    crackSeals.userData.noReceiveShadow = true;
    group.add(crackSeals);

    heroSidewalkSeamMaterial = new THREE.MeshStandardMaterial({
      color: 0x625f5a,
      roughness: 0.98,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    });
    heroSidewalkWearMaterial = new THREE.MeshStandardMaterial({
      color: 0x5f5d59,
      roughness: 1,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    });
    const seamGeometry = new THREE.BoxGeometry(1, 1, 1);
    for (const x of [19.1, 37.05]) {
      for (let z = -60; z <= 60; z += 4.5) {
        const seam = new THREE.Mesh(seamGeometry, heroSidewalkSeamMaterial);
        seam.position.set(x, streetHeight(x, z) + 0.285, z);
        seam.scale.set(3.45, 0.018, 0.035);
        seam.rotation.y = 0;
        seam.userData.noShadow = true;
        seam.userData.noReceiveShadow = true;
        group.add(seam);
      }
    }
    for (const [x, z, width, depth, seed] of [
      [18.45, -38, 1.15, 0.48, 401], [19.0, -4, 1.55, 0.55, 402],
      [18.6, 31, 0.92, 0.72, 403], [37.38, -24, 1.2, 0.5, 404],
      [36.9, 14, 1.42, 0.42, 405], [37.25, 49, 0.9, 0.66, 406],
    ]) {
      const wear = new THREE.Mesh(irregularSurfaceGeometry(seed, 14), heroSidewalkWearMaterial);
      wear.position.set(x, streetHeight(x, z) + 0.294, z);
      wear.rotation.x = -Math.PI * 0.5;
      wear.scale.set(width, depth, 1);
      wear.userData.noShadow = true;
      wear.userData.noReceiveShadow = true;
      group.add(wear);
    }

    heroPuddleMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x5f7377,
      roughness: 0.08,
      metalness: 0.16,
      clearcoat: 0.62,
      clearcoatRoughness: 0.14,
      reflectivity: 0.88,
      envMap: scene.environment,
      envMapIntensity: 1.35,
      transparent: true,
      opacity: 0.02,
      depthWrite: false,
    });
    heroPuddleEdgeMaterial = new THREE.MeshStandardMaterial({
      color: 0x303d3e,
      roughness: 0.58,
      metalness: 0.06,
      transparent: true,
      opacity: 0.02,
      depthWrite: false,
    });
    // RoomEnvironment reflections give puddles a believable broad response,
    // but cannot reflect the live bridge, cars, or lamps. A restrained
    // procedural sky streak supplies that missing localized specular cue while
    // remaining stable on WebGL2 and inexpensive to share across the puddles.
    heroPuddleSheenMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
        uSkyColor: { value: new THREE.Color(0xb7ced1) },
        uWarmColor: { value: new THREE.Color(0xcaa17f) },
      },
      vertexShader: `
        varying vec2 vLocalPosition;
        void main() {
          vLocalPosition = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix
            * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vLocalPosition;
        uniform float uOpacity;
        uniform vec3 uSkyColor;
        uniform vec3 uWarmColor;
        void main() {
          float radial = clamp(length(vLocalPosition), 0.0, 1.0);
          float broad = 1.0 - smoothstep(0.3, 1.02, radial);
          float streakAxis = abs(vLocalPosition.y * 0.86 + vLocalPosition.x * 0.22 - 0.12);
          float streak = (1.0 - smoothstep(0.035, 0.42, streakAxis)) * broad;
          float edgeFade = 1.0 - smoothstep(0.88, 1.02, radial);
          vec3 tint = mix(uSkyColor, uWarmColor,
            clamp(0.28 + vLocalPosition.x * 0.2, 0.0, 1.0));
          float alpha = uOpacity * (streak * 0.78 + broad * 0.03) * edgeFade;
          gl_FragColor = vec4(tint, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      toneMapped: true,
    });
    const puddlePlacements = [
      [19.25, -30, 1.35, 0.64, 501], [36.65, -11, 1.18, 0.52, 502],
      [19.55, 23, 1.06, 0.48, 503], [36.55, 46, 1.52, 0.66, 504],
      [22.45, -18, 0.56, 4.0, 505], [33.45, -3, 0.72, 3.25, 506],
      [23.05, 28, 0.64, 4.35, 507], [32.9, 48, 0.84, 3.7, 508],
    ];
    // The three layers share one organic outline apiece and retain individual
    // scale/rotation at every authored placement. This preserves the visible
    // wet patches while replacing 24 transparent submissions with three
    // bounded instanced draws in drizzle.
    const puddleEdgeBatch = new THREE.InstancedMesh(
      irregularSurfaceGeometry(501, 18),
      heroPuddleEdgeMaterial,
      puddlePlacements.length,
    );
    const puddleBatch = new THREE.InstancedMesh(
      irregularSurfaceGeometry(1501, 18),
      heroPuddleMaterial,
      puddlePlacements.length,
    );
    const puddleSheenBatch = new THREE.InstancedMesh(
      irregularSurfaceGeometry(2501, 18),
      heroPuddleSheenMaterial,
      puddlePlacements.length,
    );
    const puddlePosition = new THREE.Vector3();
    const puddleScale = new THREE.Vector3();
    const puddleRotation = new THREE.Quaternion();
    const puddleMatrix = new THREE.Matrix4();
    puddlePlacements.forEach(([x, z, width, depth, seed], index) => {
      // Four of the hero patches live on the raised photographic sidewalks;
      // the remaining four sit over the hero asphalt. Keep all three layers
      // just above their actual host surface so they catch light without
      // floating above the road or disappearing under the sidewalk slab.
      const onSidewalk = x < 21.0 || x > 35.0;
      const edgeOffset = onSidewalk ? 0.258 : 0.044;
      const puddleOffset = onSidewalk ? 0.268 : 0.054;
      const sheenOffset = onSidewalk ? 0.276 : 0.062;
      puddleRotation.setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, 0));
      puddleEdgeBatch.setMatrixAt(
        index,
        puddleMatrix.compose(
          puddlePosition.set(x, streetHeight(x, z) + edgeOffset, z),
          puddleRotation,
          puddleScale.set(width * 1.08, depth * 1.08, 1),
        ),
      );
      puddleBatch.setMatrixAt(
        index,
        puddleMatrix.compose(
          puddlePosition.set(x, streetHeight(x, z) + puddleOffset, z),
          puddleRotation,
          puddleScale.set(width, depth, 1),
        ),
      );
      puddleRotation.setFromEuler(new THREE.Euler(
        -Math.PI * 0.5,
        0,
        ((seed % 7) - 3) * 0.08,
      ));
      puddleSheenBatch.setMatrixAt(
        index,
        puddleMatrix.compose(
          puddlePosition.set(x, streetHeight(x, z) + sheenOffset, z),
          puddleRotation,
          puddleScale.set(width * 0.94, depth * 0.94, 1),
        ),
      );
    });
    [
      [puddleEdgeBatch, 'Natural puddle shorelines'],
      [puddleBatch, 'Shallow curb puddles'],
      [puddleSheenBatch, 'Puddle sky sheens'],
    ].forEach(([batch, name]) => {
      batch.name = name;
      batch.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      batch.instanceMatrix.needsUpdate = true;
      batch.computeBoundingSphere();
      batch.userData.noShadow = true;
      batch.userData.noReceiveShadow = true;
      batch.visible = false;
      group.add(batch);
    });
    puddleSheenBatch.renderOrder = 2;
    heroPuddleEdges.push(puddleEdgeBatch);
    heroPuddles.push(puddleBatch);
    heroPuddleSheens.push(puddleSheenBatch);
  }

  const coolWindowMaterial = new THREE.MeshStandardMaterial({
    color: 0x3c5b60,
    emissive: 0x0b1517,
    emissiveIntensity: 0.025,
    roughness: 0.28,
    metalness: 0.22,
    envMapIntensity: 1.3,
    envMap: scene.environment,
  });
  const coolWindowDarkMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b454b,
    emissive: 0x050d10,
    emissiveIntensity: 0.025,
    roughness: 0.3,
    metalness: 0.2,
    envMapIntensity: 1.25,
    envMap: scene.environment,
  });
  const coolWindowLightMaterial = new THREE.MeshStandardMaterial({
    color: 0x648284,
    emissive: 0x0e1718,
    emissiveIntensity: 0.025,
    roughness: 0.28,
    metalness: 0.18,
    envMapIntensity: 1.2,
    envMap: scene.environment,
  });
  const warmWindowMaterial = new THREE.MeshStandardMaterial({
    color: 0x9b6c47,
    emissive: 0xff9954,
    emissiveIntensity: 0.72,
    roughness: 0.3,
    metalness: 0.1,
  });
  const windowFrameMaterial = new THREE.MeshStandardMaterial({
    color: 0x464e4f,
    roughness: 0.62,
    metalness: 0.34,
  });
  const lampBulbMaterial = new THREE.MeshStandardMaterial({
    color: 0xffd09a,
    emissive: 0xff9f53,
    emissiveIntensity: 2.5,
    roughness: 0.22,
  });
  const beaconMaterial = new THREE.MeshStandardMaterial({
    color: 0xffd5ac,
    emissive: 0xff5b37,
    emissiveIntensity: 3.2,
    roughness: 0.2,
  });

  const addBox = (
    parent,
    width,
    height,
    depth,
    material,
    x = 0,
    y = 0,
    z = 0,
    rotationY = 0,
  ) => {
    const mesh = new THREE.Mesh(unitBox, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(width, height, depth);
    mesh.rotation.y = rotationY;
    parent.add(mesh);
    return mesh;
  };

  const addCylinder = (
    parent,
    radius,
    height,
    material,
    x = 0,
    y = 0,
    z = 0,
  ) => {
    const mesh = new THREE.Mesh(unitCylinder, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(radius * 2, height, radius * 2);
    parent.add(mesh);
    return mesh;
  };

  const addRod = (parent, start, end, radius, material) => {
    const direction = end.clone().sub(start);
    const rod = new THREE.Mesh(unitCylinder, material);
    rod.position.copy(start).add(end).multiplyScalar(0.5);
    rod.scale.set(radius * 2, direction.length(), radius * 2);
    rod.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.normalize(),
    );
    parent.add(rod);
    return rod;
  };

  const addPlate = (x0, x1, z0, z1, offset, depth, material, name) => {
    const mesh = new THREE.Mesh(
      slopedPlateGeometry(x0, x1, z0, z1, offset, depth),
      material,
    );
    mesh.name = name;
    mesh.userData.noShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Stop the graded city mass at the seawall. Extending this plate through
  // the Bay occluded the water and created a giant rising horizon slab.
  addPlate(-180, 180, -165, 84, -0.16, 2.4, materials.earth, 'Graded terrain');

  const distantHillMaterials = [
    new THREE.MeshStandardMaterial({ color: 0x42565c, roughness: 1, fog: true }),
    new THREE.MeshStandardMaterial({ color: 0x536165, roughness: 1, fog: true }),
  ];
  const distantHillGeometry = new THREE.SphereGeometry(1, 32, 16);
  [
    // Uneven headlands leave a low central water notch instead of forming one
    // continuous pastel horizon bar. The overlapping shoulders also retain
    // recognizable Marin/East Bay depth when fog removes fine detail.
    { x: -150, y: 8.5, z: 238, sx: 72, sy: 15, sz: 42, rotation: 0.18 },
    { x: -55, y: 4.0, z: 264, sx: 45, sy: 7.2, sz: 34, rotation: -0.12 },
    { x: 86, y: 5.2, z: 258, sx: 48, sy: 8.2, sz: 36, rotation: 0.1 },
    { x: 175, y: 9.5, z: 236, sx: 68, sy: 15.5, sz: 40, rotation: -0.16 },
  ].forEach(({ x, y, z, sx, sy, sz, rotation }, index) => {
    const hill = new THREE.Mesh(
      distantHillGeometry,
      distantHillMaterials[index % distantHillMaterials.length],
    );
    hill.name = `Distant Bay hill ${index + 1}`;
    hill.position.set(x, y, z);
    hill.scale.set(sx, sy, sz);
    hill.rotation.y = rotation;
    hill.renderOrder = -5;
    group.add(hill);
  });

  // Three very thin depth-separated veils replace the old opaque-looking
  // horizon wash. Shared low-frequency breakup leaves clear pockets between
  // the waterfront, Alcatraz and the Marin hills while retaining the layered
  // marine atmosphere characteristic of the Bay.
  const createMarineHazeLayer = ({
    z,
    y,
    width,
    height,
    density,
    seed,
    scale,
  }) => {
    const haze = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xa4a5a0) },
        uDensity: { value: density },
        uTime: { value: 0 },
        uSeed: { value: seed },
        uScale: { value: scale },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform vec3 uColor;
        uniform float uDensity;
        uniform float uTime;
        uniform float uSeed;
        uniform float uScale;
        void main() {
          vec2 flow = vec2(
            vUv.x * uScale + uTime * 0.0015,
            vUv.y * 2.2 - uTime * 0.00042
          );
          float broad = sin(
            flow.x * 6.283 + sin(flow.y * 4.1 + uSeed) * 1.2 + uSeed
          ) * 0.5 + 0.5;
          float detail = sin(
            flow.x * 15.7 - flow.y * 7.3 + uSeed * 5.2
          ) * 0.5 + 0.5;
          float crossFlow = sin(
            flow.x * 3.7 + flow.y * 9.4 - uSeed * 2.1
          ) * 0.5 + 0.5;
          float field = broad * 0.58 + detail * 0.26 + crossFlow * 0.16;
          float lowerFade = smoothstep(0.015, 0.16, vUv.y);
          float upperFade = 1.0 - smoothstep(0.46, 0.94, vUv.y);
          float sideFade = smoothstep(0.0, 0.11, vUv.x)
            * (1.0 - smoothstep(0.89, 1.0, vUv.x));
          float verticalBreak = 0.72 + 0.28 * sin(
            vUv.y * 21.0 + broad * 3.4 + uSeed
          );
          float brokenCloud = smoothstep(0.34, 0.81, field + vUv.y * 0.05);
          float alpha = uDensity * lowerFade * upperFade * sideFade
            * mix(0.12, 1.0, brokenCloud) * verticalBreak;
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
      fog: false,
      }),
    );
    haze.name = 'Bay marine atmospheric depth layer';
    haze.position.set(0, y, z);
    haze.renderOrder = 3;
    haze.userData.baseDensity = density;
    haze.userData.noShadow = true;
    haze.userData.noReceiveShadow = true;
    group.add(haze);
    return haze;
  };
  const marineHazeLayers = [
    createMarineHazeLayer({
      z: 122, y: 17, width: 360, height: 34, density: 0.038, seed: 0.31, scale: 5.4,
    }),
    createMarineHazeLayer({
      z: 196, y: 27, width: 430, height: 62, density: 0.075, seed: 3.17, scale: 3.5,
    }),
    createMarineHazeLayer({
      z: 278, y: 34, width: 500, height: 82, density: 0.115, seed: 5.43, scale: 2.7,
    }),
  ];

  const bayWater = new THREE.Mesh(
    new THREE.PlaneGeometry(460, 240, 48, 28),
    new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSunDirection: { value: new THREE.Vector3(-0.62, 0.67, 0.37).normalize() },
        uFogColor: { value: new THREE.Color(0x87999d) },
        uFogNear: { value: 60 },
        uFogFar: { value: 165 },
        uShallowColor: { value: new THREE.Color(0x4d7378) },
        uDeepColor: { value: new THREE.Color(0x2a4953) },
        uSkyHorizon: { value: new THREE.Color(0xd6aa93) },
        uSkyZenith: { value: new THREE.Color(0x66849e) },
        uWeatherMix: { value: 0 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        varying vec2 vUv;
        varying float vWaveHeight;
        uniform float uTime;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          float phase1 = worldPosition.x * 0.075 + worldPosition.z * 0.035 + uTime * 0.24;
          float phase2 = worldPosition.x * 0.16 - worldPosition.z * 0.11 - uTime * 0.38;
          float phase3 = worldPosition.x * 0.34 + worldPosition.z * 0.27 + uTime * 0.58;
          float wave1 = sin(phase1) * 0.19;
          float wave2 = sin(phase2) * 0.075;
          float wave3 = sin(phase3) * 0.025;
          float waveHeight = wave1 + wave2 + wave3;
          float dhdx = cos(phase1) * 0.19 * 0.075
            + cos(phase2) * 0.075 * 0.16
            + cos(phase3) * 0.025 * 0.34;
          float dhdz = cos(phase1) * 0.19 * 0.035
            - cos(phase2) * 0.075 * 0.11
            + cos(phase3) * 0.025 * 0.27;
          worldPosition.y += waveHeight;
          vWorldPosition = worldPosition.xyz;
          vWorldNormal = normalize(vec3(-dhdx, 1.0, -dhdz));
          vWaveHeight = waveHeight;
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        varying vec2 vUv;
        varying float vWaveHeight;
        uniform vec3 uSunDirection;
        uniform vec3 uFogColor;
        uniform float uFogNear;
        uniform float uFogFar;
        uniform vec3 uShallowColor;
        uniform vec3 uDeepColor;
        uniform vec3 uSkyHorizon;
        uniform vec3 uSkyZenith;
        uniform float uWeatherMix;
        uniform float uTime;
        void main() {
          vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
          vec3 microNormal = vec3(
            sin(vWorldPosition.x * 0.92 + vWorldPosition.z * 0.37 + uTime * 0.9),
            0.0,
            cos(vWorldPosition.z * 0.84 - vWorldPosition.x * 0.31 - uTime * 0.72)
          ) * 0.018;
          vec3 normal = normalize(vWorldNormal + microNormal);
          float facing = max(dot(normal, viewDirection), 0.0);
          float fresnel = 0.025 + 0.975 * pow(1.0 - facing, 4.6);
          vec3 halfway = normalize(viewDirection + uSunDirection);
          float broadSpecular = pow(max(dot(normal, halfway), 0.0), 72.0) * 0.14;
          float sharpSpecular = pow(max(dot(normal, halfway), 0.0), 310.0) * 0.34;
          float sunReflection = pow(
            max(dot(reflect(-uSunDirection, normal), viewDirection), 0.0),
            105.0
          ) * 0.24;
          float shoreDepth = smoothstep(98.0, 162.0, vWorldPosition.z);
          float horizonDepth = smoothstep(160.0, 286.0, vWorldPosition.z);
          vec3 waterColor = mix(uShallowColor, uDeepColor, shoreDepth * 0.82);
          vec3 reflectedSky = mix(
            uSkyHorizon,
            uSkyZenith,
            clamp(fresnel * 0.62 + horizonDepth * 0.24, 0.0, 1.0)
          );
          waterColor = mix(
            waterColor,
            reflectedSky,
            fresnel * mix(0.48, 0.4, uWeatherMix)
          );
          float crest = smoothstep(0.08, 0.27, vWaveHeight) * (1.0 - uWeatherMix * 0.34);
          float longRipple = sin(vWorldPosition.x * 0.19 + vWorldPosition.z * 0.08 + uTime * 0.34)
            * sin(vWorldPosition.x * 0.41 - vWorldPosition.z * 0.14 - uTime * 0.27);
          // Long, broken reflection columns tie the water to the authored
          // shoreline masses. They are deliberately diffuse rather than
          // mirror-perfect: wind and ferry wakes fragment reflections on the
          // real Bay even in clear late-afternoon light.
          float cityRhythm = pow(
            max(0.0, sin(vWorldPosition.x * 0.34 + 1.2))
              * max(0.0, sin(vWorldPosition.x * 0.79 - 0.4)),
            1.25
          );
          float reflectionGrain = 0.52 + 0.48 * sin(
            vWorldPosition.z * 0.72
              + sin(vWorldPosition.x * 0.24 + uTime * 0.18) * 2.1
          );
          float shoreReach = (1.0 - smoothstep(92.0, 176.0, vWorldPosition.z))
            * smoothstep(84.0, 94.0, vWorldPosition.z);
          float ferryColumn = exp(-pow((vWorldPosition.x + 8.0) / 16.0, 2.0))
            * (1.0 - smoothstep(104.0, 194.0, vWorldPosition.z));
          float bridgeColumn = exp(-pow((vWorldPosition.x - 78.0) / 24.0, 2.0))
            * smoothstep(116.0, 152.0, vWorldPosition.z)
            * (1.0 - smoothstep(152.0, 238.0, vWorldPosition.z));
          float reflectedArchitecture = max(
            cityRhythm * shoreReach,
            max(ferryColumn * 0.62, bridgeColumn * 0.42)
          ) * (0.38 + max(reflectionGrain, 0.0) * 0.62);
          float seawallWash = (1.0 - smoothstep(86.0, 94.0, vWorldPosition.z))
            * smoothstep(83.8, 86.7, vWorldPosition.z);
          waterColor += vec3(0.026, 0.04, 0.045) * max(longRipple, 0.0);
          waterColor += vec3(0.1, 0.16, 0.18) * crest;
          waterColor += vec3(0.18, 0.22, 0.24) * broadSpecular;
          waterColor += vec3(0.42, 0.5, 0.53) * sharpSpecular;
          waterColor += vec3(0.96, 0.72, 0.42) * sunReflection;
          waterColor += mix(
            vec3(0.16, 0.19, 0.18),
            vec3(0.42, 0.23, 0.14),
            bridgeColumn
          ) * reflectedArchitecture * mix(0.24, 0.13, uWeatherMix);
          waterColor += vec3(0.34, 0.43, 0.44) * seawallWash
            * (0.35 + max(longRipple, 0.0) * 0.65);
          waterColor *= mix(1.0, 0.91, horizonDepth);
          float dist = length(vWorldPosition - cameraPosition);
          float fogFactor = smoothstep(uFogNear, uFogFar, dist);
          // Keep a restrained blue-green Bay read through the marine layer;
          // full fog replacement turns the water into the same blank slab as
          // the distant road and destroys the waterfront cue.
          waterColor = mix(waterColor, uFogColor, fogFactor * mix(0.48, 0.58, uWeatherMix));
          gl_FragColor = vec4(waterColor, 1.0);
        }
      `,
      transparent: false,
      depthWrite: true,
    }),
  );
  bayWater.name = 'San Francisco Bay water';
  bayWater.rotation.x = -Math.PI * 0.5;
  bayWater.position.set(0, streetHeight(0, 84) - 0.46, 198);
  bayWater.renderOrder = -6;
  bayWater.frustumCulled = false;
  bayWater.userData.waterMaterial = true;
  group.add(bayWater);

  const roadNetwork = {
    roads: [],
    intersections: [],
  };

  for (const x of X_ROADS) {
    for (let segment = 0; segment < Z_ROADS.length - 1; segment += 1) {
      const startZ = Z_ROADS[segment];
      const endZ = Z_ROADS[segment + 1];
      roadNetwork.roads.push({
        start: new THREE.Vector3(x, streetHeight(x, startZ), startZ),
        end: new THREE.Vector3(x, streetHeight(x, endZ), endZ),
        lanes: 2,
        speedLimit: 25,
      });
    }
    addPlate(
      x - ROAD_HALF_WIDTH,
      x + ROAD_HALF_WIDTH,
      -CITY_HALF_Z,
      CITY_HALF_Z,
      0,
      0.32,
      materials.asphalt,
      'North-south road',
    );
  }

  for (const z of Z_ROADS) {
    for (let segment = 0; segment < X_ROADS.length - 1; segment += 1) {
      const startX = X_ROADS[segment];
      const endX = X_ROADS[segment + 1];
      roadNetwork.roads.push({
        start: new THREE.Vector3(startX, streetHeight(startX, z), z),
        end: new THREE.Vector3(endX, streetHeight(endX, z), z),
        lanes: 2,
        speedLimit: z === 0 ? 20 : 25,
      });
    }
    addPlate(
      -CITY_HALF_X,
      CITY_HALF_X,
      z - ROAD_HALF_WIDTH,
      z + ROAD_HALF_WIDTH,
      -0.012,
      0.32,
      materials.asphalt,
      'Cross-town road',
    );
  }

  const addGradedManholeRing = (x, z) => {
    const ring = new THREE.Mesh(manholeRingGeometry, materials.manhole);
    ring.position.set(x, streetHeight(x, z) + 0.095, z);
    ring.quaternion.copy(gradeQuaternion(0));
    ring.quaternion.multiply(new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-Math.PI * 0.5, 0, 0),
    ));
    ring.userData.noShadow = true;
    ring.userData.noReceiveShadow = true;
    group.add(ring);
  };

  // Small maintenance details break up the uninterrupted asphalt and give
  // the street a believable service layer at eye level.
  for (const x of X_ROADS) {
    for (const z of [-40, 24]) {
      const manhole = addCylinder(group, 0.46, 0.055, materials.manhole, x, streetHeight(x, z) + 0.06, z);
      manhole.quaternion.copy(gradeQuaternion(0));
      const drain = addCylinder(group, 0.31, 0.062, materials.drain, x, streetHeight(x, z) + 0.091, z);
      drain.quaternion.copy(gradeQuaternion(0));
      addGradedManholeRing(x, z);
    }
  }
  for (const z of Z_ROADS) {
    for (const x of [-56, 0, 56]) {
      const manhole = addCylinder(group, 0.46, 0.055, materials.manhole, x, streetHeight(x, z) + 0.06, z);
      manhole.quaternion.copy(gradeQuaternion(0));
      const drain = addCylinder(group, 0.31, 0.062, materials.drain, x, streetHeight(x, z) + 0.091, z);
      drain.quaternion.copy(gradeQuaternion(0));
      addGradedManholeRing(x, z);
    }
  }

  for (const x of X_ROADS) {
    for (const z of Z_ROADS) {
      roadNetwork.intersections.push(
        new THREE.Vector3(x, streetHeight(x, z) + 0.04, z),
      );
    }
  }

  const paintWhite = [];
  const paintYellow = [];
  const addPaint = (target, x, z, width, depth, heading = 0) => {
    target.push(matrixAtGrade(x, z, 0.075, width, 0.025, depth, heading));
  };
  const nearAny = (value, coordinates, distance) => (
    coordinates.some((coordinate) => Math.abs(value - coordinate) < distance)
  );
  for (const x of X_ROADS) {
    for (let z = -69; z <= 69; z += 8.5) {
      if (!nearAny(z, Z_ROADS, 8.5)) {
        addPaint(paintYellow, x - 0.13, z, 0.11, 4.4);
        addPaint(paintYellow, x + 0.13, z, 0.11, 4.4);
      }
    }
    for (const z of [-70, -32, 32, 70]) {
      const depth = Math.abs(z) > 60 ? 7 : 42;
      addPaint(paintWhite, x - 5.2, z, 0.12, depth);
      addPaint(paintWhite, x + 5.2, z, 0.12, depth);
    }
  }

  for (const z of Z_ROADS) {
    for (let x = -93; x <= 93; x += 8.5) {
      if (!nearAny(x, X_ROADS, 8.5)) {
        addPaint(paintYellow, x, z - 0.13, 0.11, 4.4, Math.PI * 0.5);
        addPaint(paintYellow, x, z + 0.13, 0.11, 4.4, Math.PI * 0.5);
      }
    }
    for (const x of [-93, -56, 0, 56, 93]) {
      const width = Math.abs(x) > 90 ? 5 : 42;
      addPaint(paintWhite, x, z - 5.2, 0.12, width, Math.PI * 0.5);
      addPaint(paintWhite, x, z + 5.2, 0.12, width, Math.PI * 0.5);
    }
  }

  // Zebra crossings sit just outside each intersection box.
  for (const x of X_ROADS) {
    for (const z of Z_ROADS) {
      for (let stripe = -2.5; stripe <= 2.5; stripe += 1) {
        addPaint(paintWhite, x, z + 5.2 + stripe * 0.5, 10.8, 0.32);
        addPaint(paintWhite, x + 5.2 + stripe * 0.5, z, 0.32, 10.8);
      }
    }
  }

  const installPaint = (matrices, material, name) => {
    const mesh = new THREE.InstancedMesh(unitBox, material, matrices.length);
    mesh.name = name;
    mesh.userData.noShadow = true;
    mesh.userData.noReceiveShadow = true;
    matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  };
  installPaint(paintWhite, materials.laneWhite, 'White lane paint and crossings');
  installPaint(paintYellow, materials.laneYellow, 'Double yellow lane paint');

  const asphaltPatchMaterial = new THREE.MeshStandardMaterial({
    color: 0x303839,
    roughness: 0.98,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const asphaltPatchGeometry = new THREE.CircleGeometry(1, 9);
  [
    [27.2, -54, 1.9, 0.72], [29.1, -43, 1.25, 0.55],
    [26.7, -22, 1.6, 0.62], [32.4, -6, 1.1, 0.46],
    [6, -1.3, 2.4, 0.6], [-40, 0.8, 1.5, 0.52],
    [56, 64, 2.1, 0.58], [-76, 63, 1.7, 0.5],
  ].forEach(([x, z, radius, flatten]) => {
    const patchMesh = new THREE.Mesh(asphaltPatchGeometry, asphaltPatchMaterial);
    patchMesh.position.set(x, streetHeight(x, z) + 0.045, z);
    patchMesh.quaternion.copy(gradeQuaternion(0));
    patchMesh.quaternion.multiply(new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-Math.PI * 0.5, 0, random() * Math.PI),
    ));
    patchMesh.scale.set(radius, radius * flatten, 1);
    patchMesh.userData.noShadow = true;
    patchMesh.userData.noReceiveShadow = true;
    group.add(patchMesh);
  });

  const sidewalkNetwork = {
    paths: [],
    crossings: roadNetwork.intersections.flatMap((point) => {
      const horizontalEntry = new THREE.Vector3(
        point.x - 6.4,
        streetHeight(point.x - 6.4, point.z - 5.2) + 0.36,
        point.z - 5.2,
      );
      const horizontalExit = new THREE.Vector3(
        point.x + 6.4,
        streetHeight(point.x + 6.4, point.z - 5.2) + 0.36,
        point.z - 5.2,
      );
      const verticalEntry = new THREE.Vector3(
        point.x - 5.2,
        streetHeight(point.x - 5.2, point.z - 6.4) + 0.36,
        point.z - 6.4,
      );
      const verticalExit = new THREE.Vector3(
        point.x - 5.2,
        streetHeight(point.x - 5.2, point.z + 6.4) + 0.36,
        point.z + 6.4,
      );
      return [
        { entry: horizontalEntry, exit: horizontalExit, center: point.clone() },
        { entry: verticalEntry, exit: verticalExit, center: point.clone() },
      ];
    }),
  };

  const blockBounds = [];
  for (let row = 0; row < Z_ROADS.length - 1; row += 1) {
    for (let column = 0; column < X_ROADS.length - 1; column += 1) {
      const x0 = X_ROADS[column] + ROAD_HALF_WIDTH;
      const x1 = X_ROADS[column + 1] - ROAD_HALF_WIDTH;
      const z0 = Z_ROADS[row] + ROAD_HALF_WIDTH;
      const z1 = Z_ROADS[row + 1] - ROAD_HALF_WIDTH;
      const innerX0 = x0 + SIDEWALK_WIDTH;
      const innerX1 = x1 - SIDEWALK_WIDTH;
      const innerZ0 = z0 + SIDEWALK_WIDTH;
      const innerZ1 = z1 - SIDEWALK_WIDTH;

      blockBounds.push({ x0, x1, z0, z1, innerX0, innerX1, innerZ0, innerZ1 });
      addPlate(x0, x1, z0, z1, 0.24, 0.42, materials.curb, 'Raised sidewalk block');
      addPlate(innerX0, innerX1, innerZ0, innerZ1, 0.31, 0.38, materials.lot, 'Inner parcel');

      const pathInset = 1.85;
      const px0 = x0 + pathInset;
      const px1 = x1 - pathInset;
      const pz0 = z0 + pathInset;
      const pz1 = z1 - pathInset;
      const point = (x, z) => new THREE.Vector3(x, streetHeight(x, z) + 0.31, z);
      sidewalkNetwork.paths.push([
        point(px0, pz0),
        point((px0 + px1) * 0.5, pz0),
        point(px1, pz0),
        point(px1, (pz0 + pz1) * 0.5),
        point(px1, pz1),
        point((px0 + px1) * 0.5, pz1),
        point(px0, pz1),
        point(px0, (pz0 + pz1) * 0.5),
        point(px0, pz0),
      ]);
    }
  }

  // Concrete sidewalks are poured in short slabs, not as one immaculate
  // surface. Hairline joints are deliberately subtle so they read as scale
  // and wear without competing with the traffic.
  for (const bounds of blockBounds) {
    const southZ = bounds.z0 + SIDEWALK_WIDTH * 0.5;
    const northZ = bounds.z1 - SIDEWALK_WIDTH * 0.5;
    for (let x = bounds.x0 + 4.5; x < bounds.x1; x += 4.5) {
      addBox(group, 0.045, 0.026, SIDEWALK_WIDTH, materials.sidewalkSeam,
        x, streetHeight(x, southZ) + 0.27, southZ);
      addBox(group, 0.045, 0.026, SIDEWALK_WIDTH, materials.sidewalkSeam,
        x, streetHeight(x, northZ) + 0.27, northZ);
    }

    const westX = bounds.x0 + SIDEWALK_WIDTH * 0.5;
    const eastX = bounds.x1 - SIDEWALK_WIDTH * 0.5;
    for (let z = bounds.z0 + 4.5; z < bounds.z1; z += 4.5) {
      addBox(group, SIDEWALK_WIDTH, 0.026, 0.045, materials.sidewalkSeam,
        westX, streetHeight(westX, z) + 0.27, z);
      addBox(group, SIDEWALK_WIDTH, 0.026, 0.045, materials.sidewalkSeam,
        eastX, streetHeight(eastX, z) + 0.27, z);
    }
  }

  const windowCool = [];
  const windowCoolDark = [];
  const windowCoolLight = [];
  const windowWarm = [];
  const windowFrame = [];
  let buildingCount = 0;
  let generatedBuildingCount = 0;
  const portals = [];
  const collisionMeshes = [];
  const portalSignGeometry = new THREE.PlaneGeometry(1, 1);
  const portalSignMaterials = new Map();
  const portalSignPalette = Object.freeze({
    residential: Object.freeze({ background: '#493a53', border: '#e5b7a7' }),
    market: Object.freeze({ background: '#174f4a', border: '#8cddc3' }),
    civic: Object.freeze({ background: '#193d50', border: '#bdd9e4' }),
    industrial: Object.freeze({ background: '#4a3928', border: '#e7bc72' }),
    waterfront: Object.freeze({ background: '#123f49', border: '#f0c66d' }),
    landmark: Object.freeze({ background: '#6b3028', border: '#f3c885' }),
  });

  const registerPortal = ({
    x,
    z,
    label,
    variant = 0,
    roomKind = null,
    door = null,
    radius = 7.5,
    featured = false,
    approachRoute = null,
    heading = Math.PI,
    district = 'sf-inspired-core',
    source = 'authored-building',
    wayfindingStyle = 'civic',
  }) => {
    const portal = {
      id: `door-${portals.length + 1}`,
      label,
      variant,
      roomKind,
      position: new THREE.Vector3(x, streetHeight(x, z) + 0.72, z),
      radius,
      door,
      room: null,
      featured,
      sign: null,
      signposted: false,
      heading: Number.isFinite(heading) ? heading : Math.PI,
      district,
      source,
      wayfindingStyle,
      approachRoute: Array.isArray(approachRoute)
        ? approachRoute.map((point) => new THREE.Vector3(
          point.x,
          streetHeight(point.x, point.z) + 0.72,
          point.z,
        ))
        : null,
    };
    if (door) {
      door.name = door.name || `${label} enterable door`;
      door.userData.enterable = true;
      door.userData.portalId = portal.id;
      door.userData.portalSource = source;
    }
    portals.push(portal);
    return portal;
  };

  const getPortalSignMaterial = (text, tone) => {
    const palette = portalSignPalette[tone] || portalSignPalette.civic;
    const key = `${tone}:${text}`;
    if (portalSignMaterials.has(key)) return portalSignMaterials.get(key);
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 768;
    signCanvas.height = 144;
    const context = signCanvas.getContext('2d');
    context.fillStyle = palette.background;
    context.fillRect(0, 0, signCanvas.width, signCanvas.height);
    context.strokeStyle = palette.border;
    context.lineWidth = 9;
    context.strokeRect(10, 10, signCanvas.width - 20, signCanvas.height - 20);
    context.fillStyle = '#fff4dc';
    context.font = '700 50px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text.toUpperCase(), signCanvas.width * 0.5, signCanvas.height * 0.52);

    const texture = new THREE.CanvasTexture(signCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(
      8,
      renderer?.capabilities?.getMaxAnisotropy?.() ?? 1,
    );
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      emissive: new THREE.Color(palette.background),
      emissiveIntensity: 0.58,
      roughness: 0.58,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
    portalSignMaterials.set(key, material);
    return material;
  };

  const addPortalWayfindingSign = (
    portal,
    text,
    { tone = portal?.wayfindingStyle || 'civic', compact = false } = {},
  ) => {
    if (!portal?.door || typeof document === 'undefined') return null;
    if (portal.sign) return portal.sign;
    const heading = Number.isFinite(portal.heading) ? portal.heading : Math.PI;
    const outward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    const sign = new THREE.Mesh(
      portalSignGeometry,
      getPortalSignMaterial(text, tone),
    );
    sign.name = `${portal.label} public entrance sign`;
    sign.position.copy(portal.door.position);
    sign.position.y += compact ? 1.65 : 1.82;
    sign.position.addScaledVector(outward, 0.18);
    sign.scale.set(compact ? 2.45 : 3.65, compact ? 0.54 : 0.68, 1);
    sign.rotation.y = heading;
    sign.userData.noShadow = true;
    sign.userData.noReceiveShadow = true;
    sign.userData.portalId = portal.id;
    sign.userData.wayfinding = true;
    group.add(sign);
    portal.sign = sign;
    portal.signposted = true;
    return sign;
  };

  const pushWindow = (x, y, z, width, height, rotationY, warm) => {
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotationY, 0));
    const frameMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      rotation,
      new THREE.Vector3(width + 0.1, height + 0.1, 0.035),
    );
    windowFrame.push(frameMatrix);
    windowFrame.push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z + 0.035),
      rotation,
      new THREE.Vector3(0.045, height + 0.08, 0.045),
    ));
    windowFrame.push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z + 0.036),
      rotation,
      new THREE.Vector3(width + 0.08, 0.045, 0.045),
    ));
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      rotation,
      new THREE.Vector3(width, height, 0.06),
    );
    if (warm) {
      windowWarm.push(matrix);
    } else {
      const variation = random();
      (variation < 0.2 ? windowCoolDark : variation > 0.82 ? windowCoolLight : windowCool).push(matrix);
    }
  };

  const addWindowGrid = ({ x, z, width, depth, height, baseY, style }) => {
    const floorSpacing = style === 'glass' ? 2.55 : 2.8;
    const windowWidth = style === 'glass' ? 1.15 : 0.72;
    const windowHeight = style === 'glass' ? 1.5 : 1.02;
    const columnSpacing = style === 'glass' ? 1.65 : 1.85;
    const facadeOffset = style === 'glass' ? 0.32 : 0.17;
    const xColumns = Math.max(2, Math.floor((width - 1.6) / columnSpacing));
    const zColumns = Math.max(2, Math.floor((depth - 1.6) / columnSpacing));
    const facadeWidth = Math.min(width - 1.4, (xColumns - 1) * columnSpacing);
    const facadeDepth = Math.min(depth - 1.4, (zColumns - 1) * columnSpacing);
    const sillMaterial = style === 'glass' ? materials.glassLight : materials.limestone;

    for (let y = baseY + 3.15; y < baseY + height - 1.15; y += floorSpacing) {
      for (let column = 0; column < xColumns; column += 1) {
        const offset = xColumns === 1 ? 0 : -facadeWidth * 0.5 + (facadeWidth * column) / (xColumns - 1);
        pushWindow(x + offset, y, z - depth * 0.5 - facadeOffset, windowWidth, windowHeight, 0, random() > 0.87);
        pushWindow(x + offset, y, z + depth * 0.5 + facadeOffset, windowWidth, windowHeight, 0, random() > 0.91);
      }
      for (let column = 0; column < zColumns; column += 1) {
        const offset = zColumns === 1 ? 0 : -facadeDepth * 0.5 + (facadeDepth * column) / (zColumns - 1);
        pushWindow(x - width * 0.5 - facadeOffset, y, z + offset, windowWidth, windowHeight, Math.PI * 0.5, random() > 0.9);
        pushWindow(x + width * 0.5 + facadeOffset, y, z + offset, windowWidth, windowHeight, Math.PI * 0.5, random() > 0.88);
      }

      // Continuous sills and lintels add the shallow cast shadows that
      // separate real façade floors from a flat window texture.
      const sillY = y - windowHeight * 0.62;
      addBox(group, facadeWidth + 0.7, 0.07, 0.1, sillMaterial,
        x, sillY, z - depth * 0.5 - facadeOffset - 0.03);
      addBox(group, facadeWidth + 0.7, 0.07, 0.1, sillMaterial,
        x, sillY, z + depth * 0.5 + facadeOffset + 0.03);
      addBox(group, 0.1, 0.07, facadeDepth + 0.7, sillMaterial,
        x - width * 0.5 - facadeOffset - 0.03, sillY, z);
      addBox(group, 0.1, 0.07, facadeDepth + 0.7, sillMaterial,
        x + width * 0.5 + facadeOffset + 0.03, sillY, z);
    }
  };

  const addFireEscape = (x, frontZ, baseY, height, width) => {
    const escape = new THREE.Group();
    escape.name = 'Fire escape';
    const platformWidth = Math.min(4.2, width * 0.5);
    const levels = Math.min(5, Math.max(2, Math.floor((height - 4) / 5)));

    for (let level = 0; level < levels; level += 1) {
      const y = baseY + 4.8 + level * 4.2;
      addBox(escape, platformWidth, 0.12, 1.05, materials.fireEscape, 0, y, frontZ);
      addBox(escape, platformWidth, 0.08, 0.08, materials.fireEscape, 0, y + 0.92, frontZ - 0.46);
      for (const side of [-1, 1]) {
        addBox(
          escape,
          0.07,
          1.05,
          0.07,
          materials.fireEscape,
          side * platformWidth * 0.47,
          y + 0.47,
          frontZ - 0.46,
        );
      }
      if (level < levels - 1) {
        const ladder = addBox(
          escape,
          0.08,
          4.35,
          0.08,
          materials.fireEscape,
          platformWidth * 0.28,
          y + 2.08,
          frontZ - 0.52,
        );
        ladder.rotation.z = -0.22;
      }
    }
    escape.position.x = x;
    group.add(escape);
  };

  const addFoundation = (x, z, width, depth, foundationMaterial = materials.concrete) => {
    const cornerHeights = [
      streetHeight(x - width * 0.5, z - depth * 0.5),
      streetHeight(x + width * 0.5, z - depth * 0.5),
      streetHeight(x + width * 0.5, z + depth * 0.5),
      streetHeight(x - width * 0.5, z + depth * 0.5),
    ];
    const low = Math.min(...cornerHeights);
    const high = Math.max(...cornerHeights) + 0.38;
    addBox(
      group,
      width + 0.55,
      high - low + 0.22,
      depth + 0.55,
      foundationMaterial,
      x,
      low + (high - low) * 0.5,
      z,
    );
    return high;
  };

  const districtProfiles = Object.freeze({
    'western-addition': Object.freeze({ label: 'Western Addition', tone: 'residential' }),
    'russian-hill': Object.freeze({ label: 'Russian Hill', tone: 'residential' }),
    'civic-center': Object.freeze({ label: 'Civic Center', tone: 'civic' }),
    'south-market': Object.freeze({ label: 'South Market', tone: 'industrial' }),
    'jackson-square': Object.freeze({ label: 'Jackson Square', tone: 'market' }),
    'north-beach': Object.freeze({ label: 'North Beach', tone: 'market' }),
    embarcadero: Object.freeze({ label: 'Embarcadero', tone: 'waterfront' }),
    'distant-downtown': Object.freeze({ label: 'Downtown', tone: 'civic' }),
  });
  const inferDistrict = (x, z, style = 'masonry') => {
    if (Math.abs(x) > CITY_HALF_X * 2 || Math.abs(z) > CITY_HALF_Z * 2) {
      return 'distant-downtown';
    }
    if (x < -28) return z < 0 ? 'western-addition' : 'russian-hill';
    if (x > 28 && z > 28) return 'embarcadero';
    if (x > 28 && z < 0) return 'south-market';
    if (z > 0) return x > 8 ? 'north-beach' : 'jackson-square';
    return 'civic-center';
  };
  const entranceTextFor = (roomKind, style) => {
    if (roomKind === 'rowhouse') return 'Residents · Enter';
    if (roomKind === 'market') return 'Market · Enter';
    if (roomKind === 'cafe') return 'Cafe · Enter';
    if (roomKind === 'ferry') return 'Market Hall · Enter';
    if (roomKind === 'coit') return 'Museum · Enter';
    return style === 'glass' ? 'Lobby · Enter' : 'Public · Enter';
  };
  const addPublicEntrance = ({
    x,
    z,
    baseY,
    heading = Math.PI,
    accent,
    variant = 0,
    style = 'masonry',
  }) => {
    const outward = new THREE.Vector2(Math.sin(heading), Math.cos(heading));
    const tangent = new THREE.Vector2(Math.cos(heading), -Math.sin(heading));
    const at = (tangentOffset = 0, outwardOffset = 0) => ({
      x: x + tangent.x * tangentOffset + outward.x * outwardOffset,
      z: z + tangent.y * tangentOffset + outward.y * outwardOffset,
    });
    const addEntranceBox = (
      width,
      height,
      depth,
      material,
      y,
      tangentOffset = 0,
      outwardOffset = 0,
    ) => {
      const point = at(tangentOffset, outwardOffset);
      const mesh = addBox(group, width, height, depth, material, point.x, y, point.z, heading);
      mesh.userData.noShadow = true;
      return mesh;
    };

    addEntranceBox(1.72, 2.78, 0.18, accent, baseY + 1.4);
    addEntranceBox(1.34, 2.48, 0.1, materials.roof, baseY + 1.3, 0, 0.1);
    const door = addEntranceBox(
      1.06,
      2.16,
      0.08,
      style === 'rowhouse' ? materials.wood : materials.metalDark,
      baseY + 1.2,
      0,
      0.17,
    );
    addEntranceBox(1.06, 0.32, 0.07, materials.glassLight, baseY + 2.47, 0, 0.19);
    addEntranceBox(1.48, 0.12, 0.72, materials.concrete, baseY + 0.08, 0, 0.34);
    addEntranceBox(0.07, 0.11, 0.06, lampBulbMaterial, baseY + 1.2, 0.32, 0.23);
    addEntranceBox(0.36, 0.18, 0.06, materials.signLetter, baseY + 2.15, -0.54, 0.21);

    const treatment = Math.abs(variant) % 3;
    if (treatment === 0) {
      addEntranceBox(2.15, 0.12, 0.74, accent, baseY + 2.93, 0, 0.26);
      for (const support of [-0.86, 0.86]) {
        addEntranceBox(0.07, 0.54, 0.07, materials.metalDark, baseY + 2.67, support, 0.5);
      }
    } else if (treatment === 1) {
      addEntranceBox(2.08, 0.28, 0.24, accent, baseY + 2.91, 0, 0.06);
      addEntranceBox(1.42, 0.08, 0.32, materials.metalDark, baseY + 2.7, 0, 0.14);
    } else {
      for (const side of [-0.78, 0.78]) {
        addEntranceBox(0.16, 2.64, 0.24, accent, baseY + 1.35, side, 0.04);
      }
      addEntranceBox(2.02, 0.16, 0.38, materials.metalDark, baseY + 2.79, 0, 0.16);
    }
    door.userData.entranceTreatment = treatment;
    return door;
  };

  const addBuilding = ({
    x,
    z,
    width,
    depth,
    height,
    material,
    accent = materials.limestone,
    style = 'masonry',
    fireEscape = false,
    label = null,
    interiorKind = null,
    portalConfig = null,
    district = null,
    source = 'authored-building',
  }) => {
    const baseY = addFoundation(x, z, width, depth, material);
    const building = new THREE.Mesh(
      roundedFootprintGeometry(width, depth, height, style === 'glass' ? 0.45 : 0.26),
      material,
    );
    building.name = `${style} building`;
    building.position.set(x, baseY, z);
    building.castShadow = true;
    building.receiveShadow = true;
    group.add(building);
    collisionMeshes.push(building);

    addBox(group, width + 0.35, 0.42, depth + 0.35, accent, x, baseY + height - 0.18, z);
    addBox(group, width * 0.86, 0.24, depth * 0.86, materials.roof, x, baseY + height + 0.22, z);

    const facadeTrim = style === 'glass' ? materials.paintedMetal : accent;
    const cornerTrim = style === 'glass' ? materials.metalDark : accent;
    for (const sideX of [-1, 1]) {
      for (const sideZ of [-1, 1]) {
        addBox(group, 0.24, Math.max(4, height - 0.7), 0.24, cornerTrim,
          x + sideX * (width * 0.5 + 0.08),
          baseY + Math.max(4, height - 0.7) * 0.5,
          z + sideZ * (depth * 0.5 + 0.08));
      }
    }
    const floorBands = Math.min(12, Math.max(2, Math.floor((height - 2) / 4.1)));
    for (let band = 0; band < floorBands; band += 1) {
      const bandY = baseY + 2.7 + band * 4.1;
      addBox(group, width + 0.28, 0.065, 0.14, facadeTrim,
        x, bandY, z - depth * 0.5 - 0.12);
      addBox(group, width + 0.28, 0.065, 0.14, facadeTrim,
        x, bandY, z + depth * 0.5 + 0.12);
      addBox(group, 0.14, 0.065, depth + 0.28, facadeTrim,
        x - width * 0.5 - 0.12, bandY, z);
      addBox(group, 0.14, 0.065, depth + 0.28, facadeTrim,
        x + width * 0.5 + 0.12, bandY, z);
    }

    const eqStyle = style === 'glass' ? 'modern' : (height > 32 ? 'tower' : 'lowrise');
    const primaryACW = Math.min(2.8, width * 0.25);
    const primaryACD = Math.min(2.2, depth * 0.25);
    const primaryACH = 0.65 + random() * 0.55;
    addBox(
      group,
      primaryACW,
      primaryACH,
      primaryACD,
      eqStyle === 'modern' ? materials.metalDark : materials.paintedMetal,
      x + width * 0.18,
      baseY + height + primaryACH * 0.5 + 0.32,
      z - depth * 0.1,
    );
    if (width > 15 && random() > 0.35) {
      const secondaryACH = 0.45 + random() * 0.4;
      addBox(
        group,
        Math.min(1.9, width * 0.16),
        secondaryACH,
        Math.min(1.5, depth * 0.18),
        eqStyle === 'modern' ? materials.paintedMetal : materials.metalDark,
        x - width * 0.22,
        baseY + height + secondaryACH * 0.5 + 0.3,
        z + depth * 0.12,
      );
    }
    const ventCount = eqStyle === 'tower' ? 4 : (eqStyle === 'modern' ? 2 : 3);
    for (let vent = 0; vent < ventCount; vent += 1) {
      const ventOffset = (vent - (ventCount - 1) * 0.5) * Math.min(2.5, width * 0.22) / Math.max(1, ventCount - 1);
      const ventRadius = 0.18 + random() * 0.14;
      const ventHeight = 0.42 + random() * 0.45;
      addCylinder(
        group,
        ventRadius,
        ventHeight,
        random() > 0.5 ? materials.paintedMetal : materials.metalDark,
        x + ventOffset,
        baseY + height + ventHeight * 0.5 + 0.28,
        z + depth * 0.16,
      );
      if (vent % 2 === 0) {
        addCylinder(
          group,
          ventRadius * 1.2,
          0.06,
          materials.metalDark,
          x + ventOffset,
          baseY + height + ventHeight * 0.5 + 0.28 + ventHeight * 0.5,
          z + depth * 0.16,
        );
      }
    }
    if (height > 24) {
      const mastOffset = x + width * (random() > 0.5 ? -0.22 : 0.22);
      const mastHeight = 2.2 + random() * 2.8;
      addCylinder(
        group,
        0.06,
        mastHeight,
        materials.metalDark,
        mastOffset,
        baseY + height + mastHeight * 0.5 + 0.3,
        z + depth * 0.1,
      );
      if (random() > 0.4) {
        addBox(
          group,
          0.55,
          0.16,
          0.04,
          materials.paintedMetal,
          mastOffset + 0.22,
          baseY + height + mastHeight * 0.6 + 0.4,
          z + depth * 0.1,
        );
      }
    }
    if (height > 18 && height < 45 && random() > 0.55) {
      const penthouseW = Math.min(3.8, width * 0.34);
      const penthouseD = Math.min(2.8, depth * 0.28);
      const penthouseH = 1.5 + random() * 1.1;
      addBox(
        group,
        penthouseW,
        penthouseH,
        penthouseD,
        eqStyle === 'modern' ? materials.glassLight : materials.limestone,
        x - width * 0.15,
        baseY + height + penthouseH * 0.5 + 0.32,
        z + depth * 0.15,
      );
      addBox(
        group,
        penthouseW + 0.35,
        0.15,
        penthouseD + 0.35,
        materials.metalDark,
        x - width * 0.15,
        baseY + height + penthouseH + 0.38,
        z + depth * 0.15,
      );
    }
    if (height > 40 && random() > 0.6) {
      const beaconX = x + width * 0.32;
      const beaconZ = z - depth * 0.28;
      const beaconH = 2.8;
      addCylinder(group, 0.05, beaconH, materials.metalDark,
        beaconX, baseY + height + beaconH * 0.5 + 0.35, beaconZ);
      const beaconBulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 5), beaconMaterial);
      beaconBulb.position.set(beaconX, baseY + height + beaconH + 0.5, beaconZ);
      group.add(beaconBulb);
    }

    if (style === 'rowhouse') {
      const bayWidth = Math.min(2.15, width * 0.3);
      for (const side of [-1, 1]) {
        addBox(
          group,
          bayWidth,
          Math.max(5, height - 4),
          0.7,
          accent,
          x + side * width * 0.24,
          baseY + 2 + Math.max(5, height - 4) * 0.5,
          z - depth * 0.5 - 0.32,
        );
      }
      addBox(
        group,
        width * 0.82,
        0.48,
        0.8,
        accent,
        x,
        baseY + height - 0.55,
        z - depth * 0.5 - 0.34,
      );
    }

    if (style !== 'glass') {
      const storefrontWidth = Math.max(2.4, width * 0.52);
      addBox(
        group,
        storefrontWidth,
        2.05,
        0.16,
        materials.glass,
        x,
        baseY + 1.35,
        z - depth * 0.5 - 0.13,
      );
      addBox(
        group,
        storefrontWidth + 0.7,
        0.22,
        0.62,
        accent,
        x,
        baseY + 2.55,
        z - depth * 0.5 - 0.32,
      );
    }

    const entryZ = z - depth * 0.5 - 0.34;
    const resolvedDistrict = district || inferDistrict(x, z, style);
    const districtProfile = districtProfiles[resolvedDistrict] || districtProfiles['civic-center'];
    const resolvedRoomKind = interiorKind || (style === 'rowhouse' ? 'rowhouse' : 'civic');
    const entryDoor = addPublicEntrance({
      x,
      z: entryZ,
      baseY,
      heading: Math.PI,
      accent,
      variant: buildingCount,
      style,
    });

    addWindowGrid({ x, z, width, depth, height, baseY, style });
    if (fireEscape) {
      addFireEscape(x, z - depth * 0.5 - 0.7, baseY, height, width);
    }
    const portal = registerPortal({
      x,
      z: entryZ - 0.85,
      label: label || `${districtProfile.label} ${
        style === 'rowhouse' ? 'residence' : 'lobby'
      } ${String(buildingCount + 1).padStart(2, '0')}`,
      variant: buildingCount % 3,
      roomKind: resolvedRoomKind,
      door: entryDoor,
      radius: portalConfig?.radius ?? 7.5,
      featured: portalConfig?.featured === true,
      approachRoute: portalConfig?.approachRoute ?? null,
      heading: Math.PI,
      district: resolvedDistrict,
      source,
      wayfindingStyle: portalConfig?.wayfindingStyle ?? districtProfile.tone,
    });
    addPortalWayfindingSign(
      portal,
      portalConfig?.wayfindingText ?? entranceTextFor(resolvedRoomKind, style),
      {
        tone: portal.wayfindingStyle,
        compact: width < 9,
      },
    );
    buildingCount += 1;
    return { baseY, height, portal };
  };

  const addGeneratedFabricBuilding = ({
    x,
    z,
    width,
    depth,
    height,
    heading,
    district,
    label,
    roomKind,
    materialIndex,
    architecture,
    variant,
  }) => {
    const profile = districtProfiles[district] || districtProfiles['civic-center'];
    const bodyMaterial = masonryMaterials[materialIndex % masonryMaterials.length];
    const accent = masonryMaterials[(materialIndex + 2) % masonryMaterials.length];
    const baseY = addFoundation(x, z, width, depth, bodyMaterial);
    const building = addBox(
      group,
      width,
      height,
      depth,
      bodyMaterial,
      x,
      baseY + height * 0.5,
      z,
    );
    building.name = `${profile.label} generated ${architecture} building`;
    building.castShadow = true;
    building.receiveShadow = true;
    building.userData.cityFabric = true;
    building.userData.district = district;
    building.userData.source = 'generated-fabric';
    collisionMeshes.push(building);

    addBox(group, width + 0.28, 0.36, depth + 0.28, accent,
      x, baseY + height + 0.02, z);
    addBox(group, width * 0.88, 0.16, depth * 0.86, materials.roof,
      x, baseY + height + 0.28, z);

    const outward = new THREE.Vector2(Math.sin(heading), Math.cos(heading));
    const tangent = new THREE.Vector2(Math.cos(heading), -Math.sin(heading));
    const frontage = Math.abs(tangent.x) * width + Math.abs(tangent.y) * depth;
    const faceDistance = Math.abs(outward.x) * width * 0.5
      + Math.abs(outward.y) * depth * 0.5;
    const facadeCenter = new THREE.Vector2(
      x + outward.x * (faceDistance + 0.14),
      z + outward.y * (faceDistance + 0.14),
    );
    const facadePoint = (tangentOffset = 0, outwardOffset = 0) => ({
      x: facadeCenter.x + tangent.x * tangentOffset + outward.x * outwardOffset,
      z: facadeCenter.y + tangent.y * tangentOffset + outward.y * outwardOffset,
    });
    const addFacadeBox = (
      boxWidth,
      boxHeight,
      boxDepth,
      material,
      y,
      tangentOffset = 0,
      outwardOffset = 0,
    ) => {
      const point = facadePoint(tangentOffset, outwardOffset);
      const mesh = addBox(
        group,
        boxWidth,
        boxHeight,
        boxDepth,
        material,
        point.x,
        y,
        point.z,
        heading,
      );
      mesh.userData.noShadow = true;
      return mesh;
    };

    const floorCount = Math.min(6, Math.max(2, Math.floor((height - 4) / 3.2)));
    const columnCount = Math.min(5, Math.max(2, Math.floor((frontage - 1.8) / 2.1)));
    const windowSpan = Math.min(frontage - 1.9, (columnCount - 1) * 2.05);
    for (let floor = 0; floor < floorCount; floor += 1) {
      const windowY = baseY + 4.25 + floor * 3.15;
      if (windowY > baseY + height - 1.05) break;
      for (let column = 0; column < columnCount; column += 1) {
        const offset = columnCount === 1
          ? 0
          : -windowSpan * 0.5 + (windowSpan * column) / (columnCount - 1);
        const point = facadePoint(offset, 0.02);
        pushWindow(
          point.x,
          windowY,
          point.z,
          architecture === 'industrial' ? 1.14 : 0.86,
          architecture === 'industrial' ? 1.35 : 1.12,
          heading,
          random() > 0.86,
        );
      }
    }

    if (architecture === 'industrial') {
      for (let y = baseY + 4.0; y < baseY + height - 1; y += 4.1) {
        addFacadeBox(frontage * 0.94, 0.11, 0.18, materials.paintedMetal, y);
      }
      addBox(group, width * 0.46, 1.05, depth * 0.3, materials.roof,
        x, baseY + height + 0.82, z);
      addFacadeBox(Math.min(4.5, frontage * 0.48), 0.16, 1.12, materials.paintedMetal,
        baseY + 3.08, 0, 0.44);
    } else if (architecture === 'mercantile') {
      for (const offset of [-frontage * 0.43, frontage * 0.43]) {
        addFacadeBox(0.24, height - 0.7, 0.3, accent,
          baseY + (height - 0.7) * 0.5, offset);
      }
      addFacadeBox(frontage + 0.35, 0.28, 0.48, accent, baseY + height - 0.38);
      addFacadeBox(Math.min(3.8, frontage * 0.42), 0.12, 0.9, materials.signGreen,
        baseY + 3.16, 0, 0.36);
    } else if (architecture === 'italianate') {
      for (const offset of [-frontage * 0.27, frontage * 0.27]) {
        addFacadeBox(1.55, Math.max(5, height - 4.2), 0.48, accent,
          baseY + 2.1 + Math.max(5, height - 4.2) * 0.5, offset, 0.2);
      }
      addFacadeBox(frontage * 0.92, 0.42, 0.6, accent, baseY + height - 0.55);
      addFacadeBox(Math.min(3.6, frontage * 0.44), 0.13, 0.92, materials.signGreen,
        baseY + 3.04, 0, 0.4);
    } else {
      addFacadeBox(frontage * 0.88, 0.22, 0.72, materials.paintedMetal,
        baseY + 3.22, 0, 0.3);
      addBox(group, width * 0.52, 1.1, depth * 0.32, materials.glassLight,
        x, baseY + height + 0.82, z);
      addFacadeBox(frontage * 0.72, 0.3, 0.34, accent, baseY + height - 0.5);
    }

    const entryPoint = facadePoint(0, 0.13);
    const door = addPublicEntrance({
      x: entryPoint.x,
      z: entryPoint.z,
      baseY,
      heading,
      accent,
      variant,
      style: roomKind === 'rowhouse' ? 'rowhouse' : 'masonry',
    });
    const promptPoint = facadePoint(0, 1.02);
    const portal = registerPortal({
      x: promptPoint.x,
      z: promptPoint.z,
      label,
      variant,
      roomKind,
      door,
      radius: 6.2,
      heading,
      district,
      source: 'generated-fabric',
      wayfindingStyle: profile.tone,
    });
    addPortalWayfindingSign(portal, entranceTextFor(roomKind, 'masonry'), {
      tone: profile.tone,
      compact: frontage < 10,
    });
    buildingCount += 1;
    generatedBuildingCount += 1;
    return { baseY, height, portal, building };
  };

  // Lower western slope: tight pastel rowhouses and one larger apartment slab.
  const rowhousePalette = [3, 4, 5, 6];
  [-69, -61, -53, -45].forEach((x, index) => {
    addBuilding({
      x,
      z: -44.5,
      width: 6.2,
      depth: 13.5,
      height: 14 + index * 1.7,
      material: masonryMaterials[rowhousePalette[index]],
      accent: masonryMaterials[(rowhousePalette[index] + 2) % masonryMaterials.length],
      style: 'rowhouse',
    });
  });
  addBuilding({
    x: -56,
    z: -23.5,
    width: 28,
    depth: 14,
    height: 24,
    material: masonryMaterials[0],
    fireEscape: true,
    interiorKind: 'market',
    label: 'Fillmore Corner Market',
  });

  // Civic/commercial middle blocks.
  addBuilding({
    x: -10,
    z: -36,
    width: 15,
    depth: 21,
    height: 31,
    material: masonryMaterials[2],
    fireEscape: true,
    interiorKind: 'cafe',
    label: 'Civic Center Espresso',
  });
  addBuilding({
    x: 10,
    z: -38,
    width: 13,
    depth: 19,
    height: 38,
    material: masonryMaterials[3],
    accent: masonryMaterials[1],
    interiorKind: 'rowhouse',
    label: 'Van Ness Residence Hotel',
  });
  addBuilding({
    x: 0,
    z: -17,
    width: 28,
    depth: 10,
    height: 16,
    material: masonryMaterials[1],
    interiorKind: 'market',
    label: 'Midtown Produce Market',
  });

  // Glass cluster catches the low sun at the downhill end of the canyon.
  addBuilding({
    // Keep the procedural glass district beyond the authored hero lens. Its
    // sparse window grid survives the marine fog as detached floating cards;
    // the near corridor is carried by the textured Edwardian frontage.
    x: 800,
    z: 800,
    width: 16,
    depth: 21,
    height: 39,
    material: materials.glass,
    accent: materials.glassLight,
    style: 'glass',
  });
  addBuilding({
    x: 824,
    z: 812,
    width: 11,
    depth: 18,
    height: 29,
    material: materials.glassLight,
    accent: materials.metalDark,
    style: 'glass',
  });
  addBuilding({
    x: 796,
    z: 788,
    width: 22,
    depth: 10,
    height: 16,
    material: masonryMaterials[2],
    accent: materials.glassLight,
  });

  // Layered uphill homes create the characteristic stacked-hillside read.
  [-69, -61, -53, -45].forEach((x, index) => {
    addBuilding({
      x,
      z: 18.5,
      width: 6.3,
      depth: 13,
      height: 15 + index * 2,
      material: masonryMaterials[(index + 1) % masonryMaterials.length],
      accent: masonryMaterials[(index + 4) % masonryMaterials.length],
      style: 'rowhouse',
      // The middle terrace opens its ground floor as a corner cafe so the
      // uphill rowhouse band is not exclusively residential behind glass.
      label: index === 2 ? 'Russian Hill Terrace Cafe' : null,
      interiorKind: index === 2 ? 'cafe' : null,
    });
  });
  addBuilding({
    x: -63,
    z: 40,
    width: 17,
    depth: 20,
    height: 25,
    material: masonryMaterials[0],
    fireEscape: true,
    interiorKind: 'cafe',
    label: 'Russian Hill Corner Cafe',
  });
  addBuilding({
    x: -44,
    z: 40,
    width: 11,
    depth: 20,
    height: 30,
    material: masonryMaterials[3],
    interiorKind: 'rowhouse',
    label: 'Lombard Terrace Residence',
  });

  // A low annex frames the landmark's plaza.
  addBuilding({
    x: -11,
    z: 17,
    width: 15,
    depth: 8,
    height: 10,
    material: masonryMaterials[5],
    accent: materials.limestone,
    interiorKind: 'cafe',
    label: 'Pyramid Plaza Cafe',
  });

  // One downtown-style glass slab inside the walkable core gives the glass
  // style a real enterable lobby; the only other glass towers are parked far
  // outside the core as distant sun catchers without walkable thresholds.
  addBuilding({
    x: 26,
    z: -27,
    width: 11,
    depth: 15,
    height: 33,
    material: materials.glass,
    accent: materials.glassLight,
    style: 'glass',
    label: 'South Market Tower Lobby',
    interiorKind: 'civic',
  });

  const addTransamericaTower = () => {
    const x = 18;
    const z = 58;
    const baseY = addFoundation(x, z, 13, 13);
    const tower = new THREE.Group();
    tower.name = 'Transamerica-inspired spire';
    tower.position.set(x, baseY, z);

    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 6.25, 39.5, 4, 1, false, Math.PI * 0.25),
      materials.limestone,
    );
    core.position.y = 19.8;
    core.castShadow = true;
    core.receiveShadow = true;
    tower.add(core);

    // The pyramid is not a smooth cone in real life. Four tapered, recessed
    // glazing fields break the mass into the recognizable white granite and
    // dark vertical window planes seen from the street.
    const taperedPanelGeometry = (angle) => {
      const radial = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
      const tangent = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle));
      const bottomCenter = radial.clone().multiplyScalar(6.29);
      const topCenter = radial.clone().multiplyScalar(1.65);
      bottomCenter.y = 3.1;
      topCenter.y = 38.6;
      const bottomHalfWidth = 1.7;
      const topHalfWidth = 0.33;
      const vertices = [
        bottomCenter.clone().addScaledVector(tangent, -bottomHalfWidth),
        bottomCenter.clone().addScaledVector(tangent, bottomHalfWidth),
        topCenter.clone().addScaledVector(tangent, topHalfWidth),
        topCenter.clone().addScaledVector(tangent, -topHalfWidth),
      ];
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(
        vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z]),
        3,
      ));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
        0, 0, 1, 0, 0.72, 1, 0.28, 1,
      ], 2));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      geometry.computeVertexNormals();
      return geometry;
    };
    [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5].forEach((angle, index) => {
      const panel = new THREE.Mesh(
        taperedPanelGeometry(angle),
        index % 2 ? coolWindowMaterial : coolWindowDarkMaterial,
      );
      panel.castShadow = true;
      panel.receiveShadow = true;
      tower.add(panel);
    });

    for (let tier = 0; tier < 12; tier += 1) {
      const progress = tier / 11;
      const radius = THREE.MathUtils.lerp(6.28, 1.65, progress);
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(radius + 0.07, radius + 0.07, 0.075, 4, 1, false, Math.PI * 0.25),
        coolWindowDarkMaterial,
      );
      band.position.y = 4.75 + tier * 2.85;
      band.castShadow = true;
      tower.add(band);
    }

    addBox(tower, 3.6, 14, 3.0, materials.limestone, -5.1, 7.3, 0);
    addBox(tower, 3.6, 14, 3.0, materials.limestone, 5.1, 7.3, 0);
    addBox(tower, 3.0, 11, 3.6, materials.limestone, 0, 6.0, -5.1);
    addBox(tower, 3.0, 11, 3.6, materials.limestone, 0, 6.0, 5.1);

    const crown = new THREE.Mesh(
      new THREE.ConeGeometry(2.65, 9, 4, 1, false, Math.PI * 0.25),
      materials.limestone,
    );
    crown.position.y = 44.0;
    crown.rotation.y = Math.PI * 0.25;
    tower.add(crown);
    addCylinder(tower, 0.13, 9, materials.metalDark, 0, 53.0, 0);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 6), beaconMaterial);
    beacon.position.y = 58.0;
    tower.add(beacon);
    // Pull the spire into the marine layer and scale it to a skyline cue;
    // the original street-edge placement projected a giant pale wedge into
    // the hero lens instead of reading as a distant landmark.
    tower.scale.setScalar(0.5);
    group.add(tower);
    buildingCount += 1;
  };
  // Omit the spire from the default hero lens: the bridge and Coit Tower
  // carry the skyline read without introducing a low-detail foreground cue.

  // A second, fog-softened landmark gives the opening gap a distinctly Bay
  // Area silhouette even when the camera is framed down the avenue.
  const coitConcreteMaterial = new THREE.MeshStandardMaterial({
    color: 0xb8ad98,
    roughness: 0.94,
    metalness: 0,
    // Coit sits in the same marine layer as the bridge, but Three's built-in
    // linear fog fully replaces the limestone with the horizon color at this
    // hero distance. Weather-specific colors below retain a capped amount of
    // warm concrete contrast instead of producing a white lighthouse shape.
    fog: false,
  });
  const coitTower = new THREE.Group();
  coitTower.name = 'Coit Tower skyline cue';
  // From a northbound Embarcadero view, Telegraph Hill belongs well west of
  // the road axis rather than directly in front of the bay crossing.
  // Keep Coit on the authored land mass, above Telegraph Hill, instead of
  // floating in the same Bay plane as Alcatraz. The tighter scale and nearer
  // land placement make it a lateral city landmark rather than a second
  // centerline postcard prop.
  const coitX = 82;
  const coitZ = 126;
  const coitBaseY = streetHeight(coitX, coitZ);
  const coitStem = new THREE.Mesh(
    new THREE.CylinderGeometry(1.78, 2.48, 13.6, 20),
    coitConcreteMaterial,
  );
  coitStem.position.y = 6.9;
  coitStem.castShadow = true;
  coitTower.add(coitStem);
  const coitObservationDeck = new THREE.Mesh(
    new THREE.CylinderGeometry(2.24, 2.16, 1.25, 20),
    coitConcreteMaterial,
  );
  coitObservationDeck.position.y = 13.35;
  coitObservationDeck.castShadow = true;
  coitTower.add(coitObservationDeck);
  const coitCrown = new THREE.Mesh(
    new THREE.CylinderGeometry(1.72, 1.9, 2.25, 20),
    coitConcreteMaterial,
  );
  coitCrown.position.y = 15.1;
  coitCrown.castShadow = true;
  coitTower.add(coitCrown);
  const coitRoof = new THREE.Mesh(
    new THREE.CylinderGeometry(1.62, 1.84, 0.62, 20),
    coitConcreteMaterial,
  );
  coitRoof.position.y = 16.55;
  coitRoof.castShadow = true;
  coitTower.add(coitRoof);
  addCylinder(coitTower, 0.065, 1.35, materials.metalDark, 0, 17.52, 0);
  coitTower.position.set(coitX, coitBaseY, coitZ);
  coitTower.scale.setScalar(0.76);
  group.add(coitTower);
  const coitDoor = addPublicEntrance({
    x: coitX,
    z: coitZ - 2.08,
    baseY: coitBaseY,
    heading: Math.PI,
    accent: coitConcreteMaterial,
    variant: 2,
    style: 'masonry',
  });
  const coitPortal = registerPortal({
    x: coitX,
    z: coitZ - 3.2,
    label: 'Coit Tower observation deck',
    variant: 2,
    roomKind: 'coit',
    radius: 6.5,
    door: coitDoor,
    heading: Math.PI,
    district: 'telegraph-hill',
    source: 'authored-landmark',
    wayfindingStyle: 'landmark',
  });
  addPortalWayfindingSign(coitPortal, 'Museum · Enter', { tone: 'landmark', compact: true });

  // Four narrow pier-head buildings establish the attached, address-by-
  // address rhythm of the Embarcadero approach. The inner pair hugs the
  // avenue sidewalks and frames a deliberate water slot; the outer pair
  // finishes each parcel instead of leaving two broad, blank concrete aprons.
  const outerLeftApproach = addBuilding({
    x: -12,
    z: 46.2,
    width: 16,
    depth: 12.6,
    height: 7.1,
    material: masonryMaterials[0],
    accent: masonryMaterials[5],
    style: 'masonry',
    interiorKind: 'ferry',
    label: 'Pierhead Chandler',
  });
  const leftApproach = addBuilding({
    x: 10,
    z: 44.4,
    width: 19,
    depth: 15.2,
    height: 9.2,
    material: masonryMaterials[4],
    accent: masonryMaterials[1],
    style: 'masonry',
    interiorKind: 'ferry',
    label: 'Pierhead Fish Market',
  });
  const rightApproach = addBuilding({
    x: 46,
    z: 44.6,
    width: 19,
    depth: 15,
    height: 8.8,
    material: masonryMaterials[1],
    accent: masonryMaterials[3],
    style: 'masonry',
    label: 'Embarcadero Welcome Center',
    interiorKind: 'civic',
    portalConfig: {
      featured: true,
      wayfindingText: 'Public Lobby · Enter',
      wayfindingStyle: 'waterfront',
      // A short, open-air route from the default avenue focus to a point
      // inside the normal prompt radius. This metadata is shared by HUD and
      // QA without changing or teleporting normal player movement.
      approachRoute: [
        { x: 28, z: 38 },
        { x: 40, z: 31 },
        { x: 46, z: 31 },
      ],
    },
  });
  const outerRightApproach = addBuilding({
    x: 68,
    z: 46.1,
    width: 16,
    depth: 12.8,
    height: 7.4,
    material: masonryMaterials[2],
    accent: masonryMaterials[5],
    style: 'masonry',
    interiorKind: 'ferry',
    label: 'Pierhead Ferry Gifts',
  });
  addPortalWayfindingSign(rightApproach.portal, 'Public lobby · Enter');

  // Carry one authored facade atlas into the approach so the added massing
  // belongs to the same visual language as the near Edwardian frontage. The
  // underlying building remains collision/portal geometry; this is only the
  // street-facing weathered skin seen from the beauty camera.
  const addApproachFacade = (building, x, z, width, depth, height, crop = 0) => {
    const texture = new THREE.TextureLoader().load(publicAsset('assets/sf-edwardian-facade-2.png'));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 8;
    texture.offset.x = crop;
    texture.repeat.x = 0.68;
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      bumpMap: texture,
      bumpScale: 0.09,
      roughness: 0.86,
      metalness: 0.01,
      side: THREE.DoubleSide,
    });
    const facade = new THREE.Mesh(
      new THREE.PlaneGeometry(width - 0.55, height - 0.5, 2, 2),
      material,
    );
    facade.name = 'Authored midground approach facade';
    facade.position.set(
      x,
      building.baseY + height * 0.5,
      z - depth * 0.5 - 0.065,
    );
    facade.rotation.y = Math.PI;
    facade.userData.noShadow = true;
    facade.userData.noReceiveShadow = true;
    group.add(facade);
  };
  addApproachFacade(outerLeftApproach, -12, 46.2, 16, 12.6, 7.1, 0.02);
  addApproachFacade(leftApproach, 10, 44.4, 19, 15.2, 9.2, 0.12);
  addApproachFacade(rightApproach, 46, 44.6, 19, 15, 8.8, 0.2);
  addApproachFacade(outerRightApproach, 68, 46.1, 16, 12.8, 7.4, 0.28);

  // Low pier sheds frame the terminus without sealing it off. Deep loading
  // bays, roof monitors and painted Port signage replace the anonymous cream
  // blocks that previously occupied the entire horizon on either side.
  const wharfDoorMaterial = new THREE.MeshStandardMaterial({
    color: 0x273437,
    roughness: 0.54,
    metalness: 0.34,
  });
  const wharfTrimMaterial = new THREE.MeshStandardMaterial({
    color: 0xb7aa91,
    roughness: 0.82,
    metalness: 0.05,
  });
  const addWharfShedDetails = (building, x, z, width, depth, height, label) => {
    const frontZ = z - depth * 0.5 - 0.22;
    for (const offset of [-0.28, 0, 0.28]) {
      const doorX = x + width * offset;
      addBox(group, width * 0.21, 3.15, 0.18, wharfDoorMaterial,
        doorX, building.baseY + 1.8, frontZ);
      addBox(group, width * 0.23, 0.17, 0.28, wharfTrimMaterial,
        doorX, building.baseY + 3.42, frontZ - 0.02);
      addBox(group, 0.14, 3.42, 0.24, wharfTrimMaterial,
        doorX - width * 0.115, building.baseY + 1.78, frontZ - 0.01);
      addBox(group, 0.14, 3.42, 0.24, wharfTrimMaterial,
        doorX + width * 0.115, building.baseY + 1.78, frontZ - 0.01);
    }
    addBox(group, width * 0.58, 1.25, depth * 0.28, materials.glassLight,
      x, building.baseY + height + 0.74, z + depth * 0.06);
    addBox(group, width * 0.61, 0.18, depth * 0.32, materials.roof,
      x, building.baseY + height + 1.39, z + depth * 0.06);

    if (typeof document !== 'undefined') {
      const signCanvas = document.createElement('canvas');
      signCanvas.width = 512;
      signCanvas.height = 96;
      const context = signCanvas.getContext('2d');
      context.fillStyle = '#173f43';
      context.fillRect(0, 0, signCanvas.width, signCanvas.height);
      context.strokeStyle = '#d7c99f';
      context.lineWidth = 5;
      context.strokeRect(7, 7, signCanvas.width - 14, signCanvas.height - 14);
      context.fillStyle = '#eee4c8';
      context.font = '600 35px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, signCanvas.width * 0.5, signCanvas.height * 0.52);
      const signTexture = new THREE.CanvasTexture(signCanvas);
      signTexture.colorSpace = THREE.SRGBColorSpace;
      signTexture.anisotropy = Math.min(
        8,
        renderer?.capabilities?.getMaxAnisotropy?.() ?? 1,
      );
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(width * 0.66, 1.28),
        new THREE.MeshStandardMaterial({
          map: signTexture,
          roughness: 0.76,
          metalness: 0.04,
          side: THREE.DoubleSide,
        }),
      );
      sign.name = `${label} painted wharf sign`;
      sign.position.set(x, building.baseY + height - 0.9, frontZ - 0.12);
      sign.rotation.y = Math.PI;
      sign.userData.noShadow = true;
      sign.userData.noReceiveShadow = true;
      group.add(sign);
    }
  };
  addWharfShedDetails(outerLeftApproach, -12, 46.2, 16, 12.6, 7.1, 'PIER 9');
  addWharfShedDetails(leftApproach, 10, 44.4, 19, 15.2, 9.2, 'PORT OF SAN FRANCISCO');
  addWharfShedDetails(rightApproach, 46, 44.6, 19, 15, 8.8, 'EMBARCADERO');
  addWharfShedDetails(outerRightApproach, 68, 46.1, 16, 12.8, 7.4, 'PIER 3');

  // Coit Tower's silhouette is simple by design, but its concrete datum still
  // needs the banding and observation slits that keep it from reading as a
  // single white cone in the center of the frame.
  const coitBandMaterial = new THREE.MeshStandardMaterial({
    color: 0x8d8373,
    roughness: 0.88,
    fog: false,
  });
  const coitWindowMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b3d40,
    roughness: 0.34,
    metalness: 0.16,
  });
  [3.35, 6.75, 10.15, 12.7, 13.95, 16.1].forEach((y) => {
    const radius = y < 12.7 ? THREE.MathUtils.lerp(2.31, 1.82, y / 13.6) : (y < 14 ? 2.25 : 1.8);
    const band = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.055, 6, 28), coitBandMaterial);
    band.rotation.x = Math.PI * 0.5;
    band.position.y = y;
    coitTower.add(band);
  });
  for (let index = 0; index < 10; index += 1) {
    const angle = (index / 10) * Math.PI * 2;
    const flute = new THREE.Mesh(new THREE.BoxGeometry(0.13, 9.7, 0.18), coitBandMaterial);
    flute.position.set(Math.cos(angle) * 1.91, 7.1, Math.sin(angle) * 1.91);
    flute.rotation.y = -angle;
    coitTower.add(flute);
  }
  for (const y of [10.9, 13.45, 15.15]) {
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2;
      const slit = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.38, 0.24), coitWindowMaterial);
      const radius = y < 12 ? 1.68 : y < 14 ? 2.18 : 1.84;
      slit.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      slit.rotation.y = -angle;
      coitTower.add(slit);
    }
  }
  // Landmark portals need the same exterior camera protection as ordinary
  // buildings. Keep the tower’s authored meshes in the camera collision list
  // so orbiting toward the observation-deck door cannot clip through it.
  coitTower.traverse((object) => {
    if (object.isMesh) collisionMeshes.push(object);
  });

  const skylineSilhouetteMaterial = new THREE.MeshStandardMaterial({
    color: 0x566370,
    roughness: 1,
    fog: true,
  });
  const downtownSilhouettes = [
    [-88, 160, 13, 8, 18],
    [-74, 170, 9, 10, 27],
    [-61, 164, 12, 8, 20],
    [-48, 176, 8, 9, 24],
    [-37, 168, 10, 8, 16],
    [-101, 178, 15, 10, 12],
  ];
  const downtownMassing = new THREE.InstancedMesh(
    unitBox,
    skylineSilhouetteMaterial,
    downtownSilhouettes.length,
  );
  downtownSilhouettes.forEach(([x, z, width, depth, height], index) => {
    downtownMassing.setMatrixAt(index, new THREE.Matrix4().compose(
      new THREE.Vector3(x, bayWater.position.y + height * 0.5, z),
      new THREE.Quaternion(),
      new THREE.Vector3(width, height, depth),
    ));
  });
  downtownMassing.name = 'Distant downtown waterfront silhouette';
  downtownMassing.instanceMatrix.needsUpdate = true;
  downtownMassing.computeBoundingSphere();
  downtownMassing.userData.noShadow = true;
  downtownMassing.userData.noReceiveShadow = true;
  group.add(downtownMassing);
  const transamericaSilhouette = new THREE.Mesh(
    new THREE.ConeGeometry(5.5, 34, 4, 1, false, Math.PI * 0.25),
    skylineSilhouetteMaterial,
  );
  transamericaSilhouette.name = 'Distant Transamerica skyline silhouette';
  transamericaSilhouette.position.set(-56, bayWater.position.y + 17, 184);
  transamericaSilhouette.rotation.y = Math.PI * 0.25;
  transamericaSilhouette.userData.noShadow = true;
  transamericaSilhouette.userData.noReceiveShadow = true;
  group.add(transamericaSilhouette);
  const bridgeOrange = new THREE.MeshStandardMaterial({
    color: 0x984033,
    roughness: 0.76,
    metalness: 0.08,
    // The landmark uses a capped, weather-authored atmosphere response in
    // setWeather. Full linear fog erased International Orange in clear and
    // turned the entire bridge white in drizzle.
    fog: false,
  });
  const bridgeOrangeShadow = new THREE.MeshStandardMaterial({
    color: 0x5f2b28,
    roughness: 0.86,
    metalness: 0.05,
    fog: false,
  });
  const bridgeCableMaterial = new THREE.MeshStandardMaterial({
    color: 0x514847,
    roughness: 0.96,
    metalness: 0.02,
    transparent: true,
    opacity: 0.74,
    depthWrite: false,
    fog: false,
  });
  // Keep the bridge skyline open. The old row of anonymous skyline boxes
  // turned into pale wedges through the marine fog and read as placeholders
  // beside the authored facades; the bridge towers and distant hills now do
  // the silhouette work without those false masses.
  // Keep bridge construction in a local group so its postcard-scale model can
  // sit as a distant westward glimpse. The old centerline placement stacked
  // it directly behind Coit Tower and read as an impossible theme-park vista.
  const bridgeLandmarkGroup = new THREE.Group();
  bridgeLandmarkGroup.name = 'Distant Golden Gate Bridge landmark';
  bridgeLandmarkGroup.position.set(78, 6, 150);
  bridgeLandmarkGroup.scale.setScalar(0.34);
  group.add(bridgeLandmarkGroup);
  const bridgeZ = 116;
  const bridgeDeckY = streetHeight(0, bridgeZ) + 13.2;
  const addBridgeBrace = (start, end, radius = 0.16, material = bridgeCableMaterial) => {
    const direction = end.clone().sub(start);
    const brace = new THREE.Mesh(unitCylinder, material);
    brace.position.copy(start).add(end).multiplyScalar(0.5);
    brace.scale.set(radius * 2, direction.length(), radius * 2);
    brace.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.normalize(),
    );
    brace.castShadow = true;
    bridgeLandmarkGroup.add(brace);
  };
  addBox(bridgeLandmarkGroup, 116, 0.9, 2.3, bridgeOrange, 0, bridgeDeckY, bridgeZ);
  addBox(bridgeLandmarkGroup, 116, 0.14, 2.36, bridgeOrangeShadow, 0, bridgeDeckY + 0.53, bridgeZ);
  addBox(bridgeLandmarkGroup, 116, 0.38, 0.22, bridgeOrangeShadow, 0, bridgeDeckY - 0.62, bridgeZ - 1.12);
  addBox(bridgeLandmarkGroup, 116, 0.38, 0.22, bridgeOrangeShadow, 0, bridgeDeckY - 0.62, bridgeZ + 1.12);
  const bridgePierHeight = bridgeDeckY - bayWater.position.y;
  for (const towerX of [-42, 42]) {
    // Open portal frames retain a recognizable suspension-bridge silhouette
    // without the monolithic orange slabs of the previous tower masses.
    for (const legOffset of [-2.25, 2.25]) {
      addBox(bridgeLandmarkGroup, 1.45, 29, 2.05, bridgeOrange,
        towerX + legOffset, bridgeDeckY + 14, bridgeZ);
      addBox(bridgeLandmarkGroup, 1.04, bridgePierHeight, 1.7, bridgeOrange,
        towerX + legOffset, bayWater.position.y + bridgePierHeight * 0.5, bridgeZ);
    }
    for (const beamY of [9.2, 18.2, 26.2]) {
      addBox(bridgeLandmarkGroup, 6.5, 0.94, 2.0, bridgeOrange,
        towerX, bridgeDeckY + beamY, bridgeZ);
      addBox(bridgeLandmarkGroup, 5.0, 0.18, 2.08, bridgeOrangeShadow,
        towerX, bridgeDeckY + beamY - 0.47, bridgeZ);
    }
    // Diagonal portal bracing gives the International Orange towers a real
    // load-bearing silhouette instead of a pair of flat ladder boxes.
    for (const zOffset of [-0.82, 0.82]) {
      addBridgeBrace(
        new THREE.Vector3(towerX - 2.25, bridgeDeckY + 1.2, bridgeZ + zOffset),
        new THREE.Vector3(towerX + 2.25, bridgeDeckY + 11.6, bridgeZ + zOffset),
        0.17,
        bridgeOrangeShadow,
      );
      addBridgeBrace(
        new THREE.Vector3(towerX + 2.25, bridgeDeckY + 1.2, bridgeZ + zOffset),
        new THREE.Vector3(towerX - 2.25, bridgeDeckY + 11.6, bridgeZ + zOffset),
        0.17,
        bridgeOrangeShadow,
      );
      addBridgeBrace(
        new THREE.Vector3(towerX - 2.25, bridgeDeckY + 15.0, bridgeZ + zOffset),
        new THREE.Vector3(towerX + 2.25, bridgeDeckY + 25.0, bridgeZ + zOffset),
        0.17,
        bridgeOrangeShadow,
      );
      addBridgeBrace(
        new THREE.Vector3(towerX + 2.25, bridgeDeckY + 15.0, bridgeZ + zOffset),
        new THREE.Vector3(towerX - 2.25, bridgeDeckY + 25.0, bridgeZ + zOffset),
        0.17,
        bridgeOrangeShadow,
      );
    }
  }

  // A shallow repeating under-deck rhythm gives the span scale and prevents
  // the long horizontal edge from reading as an unshaded rectangular bar.
  for (let x = -54; x <= 54; x += 6) {
    addBox(bridgeLandmarkGroup, 0.24, 1.2, 2.2, bridgeOrangeShadow,
      x, bridgeDeckY - 0.7, bridgeZ);
    for (const side of [-1, 1]) {
      const sideZ = bridgeZ + side * 1.08;
      addBox(bridgeLandmarkGroup, 0.2, 1.08, 0.16, bridgeOrangeShadow,
        x, bridgeDeckY - 0.62, sideZ);
    }
    if (x < 54) {
      for (const side of [-1, 1]) {
        const z = bridgeZ + side * 1.08;
        addBridgeBrace(
          new THREE.Vector3(x, bridgeDeckY - 0.1, z),
          new THREE.Vector3(x + 3, bridgeDeckY - 1.0, z),
          0.1,
          bridgeOrangeShadow,
        );
        addBridgeBrace(
          new THREE.Vector3(x + 3, bridgeDeckY - 1.0, z),
          new THREE.Vector3(x + 6, bridgeDeckY - 0.1, z),
          0.1,
          bridgeOrangeShadow,
        );
      }
    }
  }

  // Gusseted tower shoes visually tie the orange portals into the deck and
  // keep the bridge connection from reading as two disconnected skyline bars.
  for (const towerX of [-42, 42]) {
    for (const legOffset of [-2.25, 2.25]) {
      addBridgeBrace(
        new THREE.Vector3(towerX + legOffset, bridgeDeckY + 0.1, bridgeZ - 0.88),
        new THREE.Vector3(towerX + legOffset * 0.65, bridgeDeckY + 3.0, bridgeZ - 1.12),
        0.11,
        bridgeOrange,
      );
      addBridgeBrace(
        new THREE.Vector3(towerX + legOffset, bridgeDeckY + 0.1, bridgeZ + 0.88),
        new THREE.Vector3(towerX + legOffset * 0.65, bridgeDeckY + 3.0, bridgeZ + 1.12),
        0.11,
        bridgeOrange,
      );
    }
  }

  // The suspension profile is deliberately legible from the hero avenue: a
  // warm International Orange silhouette plus a sagging main cable reads as
  // a bridge instead of a pair of anonymous skyline boxes.
  const addBridgeCable = (side) => {
    const z = bridgeZ + side * 1.05;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-58, bridgeDeckY + 3.8, z),
      new THREE.Vector3(-42, bridgeDeckY + 29.8, z),
      new THREE.Vector3(0, bridgeDeckY + 13.8, z),
      new THREE.Vector3(42, bridgeDeckY + 29.8, z),
      new THREE.Vector3(58, bridgeDeckY + 3.8, z),
    ]);
    bridgeLandmarkGroup.add(new THREE.Mesh(
      new THREE.TubeGeometry(curve, 48, 0.1, 8, false),
      bridgeCableMaterial,
    ));
    for (let x = -36; x <= 36; x += 4) {
      const spanRatio = Math.abs(x) / 42;
      const cableY = bridgeDeckY + 13.8 + 16 * spanRatio * spanRatio;
      const suspender = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.LineCurve3(
          new THREE.Vector3(x, bridgeDeckY + 0.4, z),
          new THREE.Vector3(x, cableY, z),
        ), 2, 0.052, 6, false),
        bridgeCableMaterial,
      );
      bridgeLandmarkGroup.add(suspender);
    }
  };
  addBridgeCable(-1);
  addBridgeCable(1);

  // Embarcadero edge: a readable promenade, timber piers, ferry terminal,
  // and a few small boats give the distant gap an actual waterfront scale.
  const waterfrontWood = new THREE.MeshStandardMaterial({ color: 0x6e5140, roughness: 0.9 });
  const waterfrontMetal = new THREE.MeshStandardMaterial({ color: 0x3a4241, roughness: 0.58, metalness: 0.7 });
  const seawallStone = new THREE.MeshStandardMaterial({ color: 0x756f66, roughness: 0.94, metalness: 0.02 });
  const ferryStone = new THREE.MeshStandardMaterial({ color: 0xcdbfa6, roughness: 0.76 });
  const ferryRoof = new THREE.MeshStandardMaterial({ color: 0x5b5550, roughness: 0.66, metalness: 0.24 });
  const boatHull = new THREE.MeshStandardMaterial({ color: 0x6c3c34, roughness: 0.56, metalness: 0.12 });
  const boatTrim = new THREE.MeshStandardMaterial({ color: 0xe3d4b5, roughness: 0.68 });
  addPlate(-108, 108, 78, 84, 0.3, 0.18, materials.concrete, 'Embarcadero promenade');
  addPlate(-108, 108, 83.65, 84.35, 0.18, 1.2, seawallStone, 'Granite Embarcadero seawall face');
  addBox(group, 216, 0.18, 0.22, materials.curb, 0, streetHeight(0, 84) + 0.43, 84);
  const waterfrontRailXs = [-94, -70, -46, -22, 2, 26, 50, 74, 98];
  for (const x of waterfrontRailXs) {
    addCylinder(group, 0.06, 1.2, waterfrontMetal, x, streetHeight(x, 83.5) + 0.92, 83.5);
  }
  for (let index = 0; index < waterfrontRailXs.length - 1; index += 1) {
    const startX = waterfrontRailXs[index];
    const endX = waterfrontRailXs[index + 1];
    for (const railHeight of [0.92, 1.47]) {
      addRod(
        group,
        new THREE.Vector3(startX, streetHeight(startX, 83.5) + railHeight, 83.5),
        new THREE.Vector3(endX, streetHeight(endX, 83.5) + railHeight, 83.5),
        railHeight > 1 ? 0.045 : 0.032,
        waterfrontMetal,
      );
    }
  }
  for (const x of [-82, -34, 14, 62, 88]) {
    addCylinder(group, 0.18, 0.56, waterfrontMetal,
      x, streetHeight(x, 81.4) + 0.6, 81.4);
    addCylinder(group, 0.25, 0.1, waterfrontMetal,
      x, streetHeight(x, 81.4) + 0.92, 81.4);
  }
  const shorelineFoam = new THREE.Mesh(
    new THREE.PlaneGeometry(216, 2.8),
    new THREE.MeshBasicMaterial({
      color: 0xc2d8d4,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      toneMapped: true,
    }),
  );
  shorelineFoam.name = 'Broken Bay shoreline wash';
  shorelineFoam.rotation.x = -Math.PI * 0.5;
  shorelineFoam.position.set(0, bayWater.position.y + 0.075, 85.8);
  shorelineFoam.renderOrder = 1;
  shorelineFoam.userData.noShadow = true;
  shorelineFoam.userData.noReceiveShadow = true;
  group.add(shorelineFoam);

  const addPier = (x, length = 26) => {
    const z = 96;
    const pier = new THREE.Group();
    pier.name = 'Embarcadero timber pier';
    addBox(pier, 13, 0.34, length, waterfrontWood, 0, 0, 0);
    addBox(pier, 13.2, 0.08, length + 0.2, waterfrontMetal, 0, 0.28, 0);
    for (const side of [-1, 1]) {
      addBox(pier, 0.08, 0.8, length, waterfrontMetal, side * 6.1, 0.62, 0);
      for (let zOffset = -length * 0.5 + 3; zOffset <= length * 0.5 - 3; zOffset += 5) {
        addCylinder(pier, 0.16, 2.7, waterfrontWood, side * 5.2, -1.25, zOffset);
      }
    }
    pier.position.set(x, streetHeight(x, z) + 0.9, z);
    group.add(pier);
  };
  [-64, 14, 58].forEach((x) => addPier(x));

  const ferryBuilding = new THREE.Group();
  ferryBuilding.name = 'Ferry Building waterfront terminal';
  const ferryX = -8;
  const ferryZ = 104;
  const ferryBase = streetHeight(ferryX, ferryZ);
  addBox(ferryBuilding, 34, 9.8, 7.6, ferryStone, 0, 4.9, 0);
  addBox(ferryBuilding, 35.5, 0.45, 8.6, ferryRoof, 0, 10.0, 0);
  const ferryArchGeometry = new THREE.CircleGeometry(1, 18, 0, Math.PI);
  for (const openingX of [-14, -10, -6, -2, 2, 6, 10, 14]) {
    addBox(ferryBuilding, 2.12, 2.55, 0.16, materials.glass,
      openingX, 2.04, -4.0);
    const arch = new THREE.Mesh(ferryArchGeometry, materials.glass);
    arch.position.set(openingX, 3.31, -4.01);
    arch.scale.set(1.06, 1.06, 1);
    arch.rotation.y = Math.PI;
    ferryBuilding.add(arch);
    addBox(ferryBuilding, 0.12, 3.72, 0.22, waterfrontMetal,
      openingX - 1.13, 2.42, -4.08);
    addBox(ferryBuilding, 0.12, 3.72, 0.22, waterfrontMetal,
      openingX + 1.13, 2.42, -4.08);
    addBox(ferryBuilding, 2.34, 0.13, 0.22, waterfrontMetal,
      openingX, 0.74, -4.08);
  }
  addBox(ferryBuilding, 8.2, 21.5, 8.2, ferryStone, 0, 10.7, 0);
  addBox(ferryBuilding, 9.2, 0.5, 9.1, ferryRoof, 0, 21.65, 0);
  addBox(ferryBuilding, 3.1, 5.2, 3.1, ferryStone, 0, 24.45, 0);
  const clockFaceMat = new THREE.MeshStandardMaterial({
    color: 0xf7efe0,
    roughness: 0.55,
    emissive: 0x3a3428,
    emissiveIntensity: 0.22,
    side: THREE.DoubleSide,
  });
  const clockFace = new THREE.Mesh(new THREE.CircleGeometry(2.85, 28), clockFaceMat);
  clockFace.position.set(0, 12.6, -4.18);
  ferryBuilding.add(clockFace);
  // Bay-facing clock so waterfront hero reads from +Z approaches too.
  const clockFaceBay = new THREE.Mesh(new THREE.CircleGeometry(2.85, 28), clockFaceMat.clone());
  clockFaceBay.position.set(0, 12.6, 4.18);
  clockFaceBay.rotation.y = Math.PI;
  ferryBuilding.add(clockFaceBay);
  const clockRim = new THREE.Mesh(
    new THREE.TorusGeometry(2.95, 0.14, 8, 32),
    waterfrontMetal,
  );
  clockRim.position.set(0, 12.6, -4.25);
  clockRim.rotation.y = Math.PI;
  ferryBuilding.add(clockRim);
  const clockRimBay = new THREE.Mesh(
    new THREE.TorusGeometry(2.95, 0.14, 8, 32),
    waterfrontMetal,
  );
  clockRimBay.position.set(0, 12.6, 4.25);
  ferryBuilding.add(clockRimBay);
  addBox(ferryBuilding, 0.12, 2.2, 0.06, waterfrontMetal, 0, 12.7, -4.24);
  addBox(ferryBuilding, 1.7, 0.12, 0.06, waterfrontMetal, 0, 12.7, -4.24, Math.PI * 0.5);
  addBox(ferryBuilding, 0.12, 2.2, 0.06, waterfrontMetal, 0, 12.7, 4.24);
  addBox(ferryBuilding, 1.7, 0.12, 0.06, waterfrontMetal, 0, 12.7, 4.24, Math.PI * 0.5);
  const ferryCrown = new THREE.Mesh(
    new THREE.ConeGeometry(2.62, 4.4, 4, 1, false, Math.PI * 0.25),
    ferryRoof,
  );
  ferryCrown.position.y = 29.1;
  ferryCrown.rotation.y = Math.PI * 0.25;
  ferryBuilding.add(ferryCrown);
  addCylinder(ferryBuilding, 0.07, 3.8, waterfrontMetal, 0, 33.0, 0);
  for (let column = -14; column <= 14; column += 4) {
    addBox(ferryBuilding, 0.26, 5.8, 0.32, ferryStone, column, 2.9, -4.02);
    addBox(ferryBuilding, 2.8, 0.22, 0.36, ferryStone, column, 5.8, -4.02);
  }
  ferryBuilding.position.set(ferryX, ferryBase, ferryZ);
  // Pass18: full-scale Ferry Building for Embarcadero ≥7.0 waterfront hero.
  ferryBuilding.scale.setScalar(1.05);
  ferryBuilding.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    collisionMeshes.push(object);
  });
  group.add(ferryBuilding);
  const ferryDoor = addPublicEntrance({
    x: ferryX,
    z: ferryZ - 3.46,
    baseY: ferryBase,
    heading: Math.PI,
    accent: ferryStone,
    variant: 1,
    style: 'masonry',
  });
  const ferryPortal = registerPortal({
    x: ferryX,
    z: ferryZ - 4.8,
    label: 'Ferry Building market hall',
    variant: 1,
    roomKind: 'ferry',
    radius: 7.5,
    door: ferryDoor,
    heading: Math.PI,
    district: 'embarcadero',
    source: 'authored-landmark',
    wayfindingStyle: 'waterfront',
  });
  addPortalWayfindingSign(ferryPortal, 'Market Hall · Enter', {
    tone: 'waterfront',
  });

  const bayY = bayWater.position.y;
  const bayBoatPlacements = [
    [-48, 134, 0.08, 0x6c3c34],
    [28, 116, -0.16, 0x31566b],
    [70, 148, 0.22, 0x7c6a3e],
  ];
  for (const [x, z, heading, color] of bayBoatPlacements) {
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(roundedVehicleGeometry, boatHull.clone());
    hull.material.color.set(color);
    hull.scale.set(2.2, 0.32, 5.6);
    hull.position.y = 0.12;
    boat.add(hull);
    const cabin = new THREE.Mesh(roundedVehicleGeometry, boatTrim);
    cabin.scale.set(1.25, 0.42, 1.8);
    cabin.position.set(0, 0.48, -0.35);
    boat.add(cabin);
    boat.position.set(x, bayY + 0.14, z);
    boat.rotation.y = heading;
    boat.name = 'Bay launch boat';
    boat.traverse((object) => {
      if (object.isMesh) object.receiveShadow = true;
    });
    group.add(boat);
  }
  const wakeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xd6e2dd) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix
          * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor;
      void main() {
        vec2 centered = vUv - 0.5;
        float tail = 1.0 - smoothstep(-0.42, 0.52, centered.y);
        float opening = mix(0.08, 0.48, vUv.y);
        float shoulders = 1.0 - smoothstep(opening * 0.72, opening, abs(centered.x));
        float centerGap = smoothstep(0.035, 0.12, abs(centered.x));
        float broken = 0.72 + sin(vUv.y * 48.0 + centered.x * 19.0) * 0.18;
        gl_FragColor = vec4(uColor, tail * shoulders * centerGap * broken * 0.26);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: true,
  });
  const bayWakes = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    wakeMaterial,
    bayBoatPlacements.length,
  );
  bayBoatPlacements.forEach(([x, z, heading], index) => {
    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-Math.PI * 0.5, 0, heading),
    );
    bayWakes.setMatrixAt(index, new THREE.Matrix4().compose(
      new THREE.Vector3(x, bayY + 0.2, z + 5.2),
      rotation,
      new THREE.Vector3(2.6, 8.6, 1),
    ));
  });
  bayWakes.name = 'Bay launch wakes';
  bayWakes.instanceMatrix.needsUpdate = true;
  bayWakes.computeBoundingSphere();
  bayWakes.renderOrder = 1;
  bayWakes.userData.noShadow = true;
  bayWakes.userData.noReceiveShadow = true;
  group.add(bayWakes);

  const alcatraz = new THREE.Group();
  alcatraz.name = 'Fog-softened Alcatraz silhouette';
  addBox(alcatraz, 26, 2.2, 10, skylineSilhouetteMaterial, 0, 1.1, 0);
  addBox(alcatraz, 11, 5.4, 6.4, skylineSilhouetteMaterial, 0, 4.8, 0);
  addBox(alcatraz, 2.2, 3.2, 2.2, skylineSilhouetteMaterial, 0, 9.0, 0);
  // Alcatraz is a remote island silhouette. Keeping it smaller, farther out,
  // and on a different horizontal bearing prevents the Ferry Building, Coit,
  // bridge and prison from collapsing into one impossible stage set.
  alcatraz.position.set(8, bayY - 0.2, 248);
  alcatraz.scale.setScalar(0.64);
  group.add(alcatraz);

  addBuilding({
    x: 838,
    z: 852,
    width: 17,
    depth: 24,
    height: 34,
    material: materials.glass,
    accent: materials.glassLight,
    style: 'glass',
  });
  addBuilding({
    x: 862,
    z: 864,
    width: 10,
    depth: 20,
    height: 29,
    material: materials.glassLight,
    accent: materials.metalDark,
    style: 'glass',
  });
  addBuilding({
    x: 850,
    z: 840,
    width: 28,
    depth: 9,
    height: 15,
    material: masonryMaterials[2],
    accent: materials.glassLight,
  });

  // Bounded deterministic infill for the three least-developed core parcels.
  // These are San Francisco-inspired block types, not GIS footprints. Each
  // lot adds one real public threshold while sharing box geometry, façade
  // window instances, materials and the existing six staged interior rooms.
  const generatedFabricLots = [
    // South Market: deeper brick/industrial floor plates on the east block.
    { x: 44.5, z: -44, width: 9, depth: 17, height: 18, heading: Math.PI,
      district: 'south-market', label: 'South Market Workshop', roomKind: 'market',
      materialIndex: 0, architecture: 'industrial', variant: 0 },
    { x: 55.5, z: -44, width: 10, depth: 17, height: 25, heading: Math.PI,
      district: 'south-market', label: 'Rincon Court Lobby', roomKind: 'civic',
      materialIndex: 2, architecture: 'industrial', variant: 1 },
    { x: 67, z: -44, width: 11, depth: 17, height: 21, heading: Math.PI,
      district: 'south-market', label: 'Second Street Studios', roomKind: 'rowhouse',
      materialIndex: 1, architecture: 'industrial', variant: 2 },
    { x: 45, z: -19, width: 10, depth: 15, height: 16, heading: 0,
      district: 'south-market', label: 'Howard Street Market', roomKind: 'market',
      materialIndex: 5, architecture: 'industrial', variant: 1 },
    { x: 57, z: -19, width: 11, depth: 15, height: 29, heading: 0,
      district: 'south-market', label: 'Brannan Cafe', roomKind: 'cafe',
      materialIndex: 0, architecture: 'industrial', variant: 2 },
    { x: 69, z: -19, width: 10, depth: 15, height: 23, heading: 0,
      district: 'south-market', label: 'South Market Exchange', roomKind: 'civic',
      materialIndex: 2, architecture: 'industrial', variant: 0 },
    // Jackson Square: compact mercantile fronts close the centre-north block.
    { x: 9, z: 17.5, width: 16, depth: 12, height: 22, heading: Math.PI,
      district: 'jackson-square', label: 'Jackson Square Mercantile', roomKind: 'market',
      materialIndex: 0, architecture: 'mercantile', variant: 1 },
    { x: -12, z: 30, width: 16, depth: 10, height: 18, heading: -Math.PI * 0.5,
      district: 'jackson-square', label: 'Brick Court Offices', roomKind: 'civic',
      materialIndex: 2, architecture: 'mercantile', variant: 2 },
    { x: 9, z: 30, width: 18, depth: 10, height: 25, heading: Math.PI * 0.5,
      district: 'jackson-square', label: 'Montgomery House', roomKind: 'rowhouse',
      materialIndex: 5, architecture: 'mercantile', variant: 0 },
    // North Beach / Embarcadero: lighter bays and maritime roof monitors.
    { x: 43.5, z: 20, width: 9, depth: 17, height: 19, heading: Math.PI,
      district: 'north-beach', label: 'North Beach Cafe', roomKind: 'cafe',
      materialIndex: 4, architecture: 'italianate', variant: 2 },
    { x: 54.5, z: 20, width: 11, depth: 17, height: 24, heading: Math.PI,
      district: 'north-beach', label: 'Columbus Court', roomKind: 'rowhouse',
      materialIndex: 3, architecture: 'italianate', variant: 0 },
    { x: 67, z: 20, width: 12, depth: 17, height: 21, heading: Math.PI,
      district: 'embarcadero', label: 'Embarcadero Trade Hall', roomKind: 'civic',
      materialIndex: 1, architecture: 'waterfront', variant: 1 },
  ];
  generatedFabricLots.forEach(addGeneratedFabricBuilding);

  // Hero avenue dressing: a few authored San Francisco cues make the street
  // readable at eye level instead of relying on the skyline alone.
  const bayGlass = new THREE.MeshStandardMaterial({
    color: 0x2a4a54,
    emissive: 0x0a1b21,
    emissiveIntensity: 0.1,
    roughness: 0.28,
    metalness: 0.24,
    envMap: scene.environment,
  });
  const awningMaterial = new THREE.MeshStandardMaterial({ color: 0xb34f42, roughness: 0.72 });
  const balconyMetal = new THREE.MeshStandardMaterial({ color: 0x786f68, roughness: 0.78, metalness: 0.24 });
  const balconyRail = new THREE.MeshStandardMaterial({ color: 0x30383a, roughness: 0.56, metalness: 0.72 });
  // Pass16: varnished mahogany + lacquered cream + brass trim for cable A/B.
  const cableCarRed = new THREE.MeshStandardMaterial({
    color: 0x9e2a28,
    roughness: 0.22,
    metalness: 0.16,
    envMapIntensity: 1.05,
    emissive: 0x2a0808,
    emissiveIntensity: 0.1,
  });
  const cableCarCream = new THREE.MeshStandardMaterial({
    color: 0xf2dfb4,
    roughness: 0.28,
    metalness: 0.1,
    envMapIntensity: 0.75,
  });
  const cableCarWood = new THREE.MeshStandardMaterial({
    color: 0x6b3a22,
    roughness: 0.32,
    metalness: 0.1,
    envMapIntensity: 0.7,
    emissive: 0x1a0c04,
    emissiveIntensity: 0.08,
  });
  const cableCarBrass = new THREE.MeshStandardMaterial({
    color: 0xd4b56a,
    roughness: 0.18,
    metalness: 0.96,
    envMapIntensity: 1.55,
    emissive: 0x3a2a10,
    emissiveIntensity: 0.14,
  });
  const cableRail = new THREE.LineBasicMaterial({ color: 0x8f8a80, transparent: true, opacity: 0.46 });
  const cableCarRoundedGeometry = new RoundedBoxGeometry(1, 1, 1, 0.08, 3);
  const addCableCarBox = (parent, width, height, depth, material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(cableCarRoundedGeometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(width, height, depth);
    parent.add(mesh);
    return mesh;
  };
  const storefrontGlass = new THREE.MeshStandardMaterial({
    color: 0x486675,
    roughness: 0.14,
    metalness: 0.36,
    envMap: scene.environment,
  });
  const storefrontInterior = new THREE.MeshStandardMaterial({
    color: 0x272a2b,
    emissive: 0x2a1710,
    emissiveIntensity: 0.24,
    roughness: 0.9,
  });
  const storefrontDoor = new THREE.MeshStandardMaterial({
    color: 0x1f3037,
    roughness: 0.19,
    metalness: 0.42,
    envMap: scene.environment,
  });
  // The hero blocks sit on a visible graded foundation. Street-level
  // dressing must start at that facade datum or it disappears inside the
  // retaining wall on the uphill side of the avenue.
  const heroFacadeBase = (x, z) => streetHeight(x, z) + 1.55;
  const heroFacadeGlass = new THREE.MeshStandardMaterial({
    color: 0x1a2e36,
    roughness: 0.16,
    metalness: 0.42,
    envMapIntensity: 1.8,
    envMap: scene.environment,
  });
  const heroFacadeFrame = new THREE.MeshStandardMaterial({
    color: 0xd2c3a8,
    roughness: 0.62,
    metalness: 0.08,
  });
  const heroFacadeSill = new THREE.MeshStandardMaterial({
    color: 0x8e7764,
    roughness: 0.78,
    metalness: 0.12,
  });
  const heroFacadeDarkTrim = new THREE.MeshStandardMaterial({
    color: 0x2b3232,
    roughness: 0.58,
    metalness: 0.46,
  });
  const storefrontGlow = new THREE.MeshStandardMaterial({
    color: 0x3e2c20,
    emissive: 0x7a3514,
    emissiveIntensity: 0.16,
    roughness: 0.62,
  });
  const heroPhotoTexture = new THREE.TextureLoader().load(publicAsset('assets/sf-edwardian-facade-2.png'));
  heroPhotoTexture.colorSpace = THREE.SRGBColorSpace;
  heroPhotoTexture.anisotropy = 8;
  heroPhotoTexture.wrapS = THREE.ClampToEdgeWrapping;
  heroPhotoTexture.wrapT = THREE.ClampToEdgeWrapping;
  const heroPhotoMaterial = new THREE.MeshStandardMaterial({
    map: heroPhotoTexture,
    bumpMap: heroPhotoTexture,
    bumpScale: 0.16,
    roughness: 0.82,
    metalness: 0.02,
  });
  const heroTallPhotoTexture = new THREE.TextureLoader().load(publicAsset('assets/sf-edwardian-facade.png'));
  heroTallPhotoTexture.colorSpace = THREE.SRGBColorSpace;
  heroTallPhotoTexture.anisotropy = 8;
  heroTallPhotoTexture.wrapS = THREE.ClampToEdgeWrapping;
  heroTallPhotoTexture.wrapT = THREE.ClampToEdgeWrapping;
  const heroTallPhotoMaterial = new THREE.MeshStandardMaterial({
    map: heroTallPhotoTexture,
    bumpMap: heroTallPhotoTexture,
    bumpScale: 0.2,
    roughness: 0.8,
    metalness: 0.02,
  });

  // A modular bay window is modeled as a small piece of architecture rather
  // than a flat emissive rectangle. The alternating frame, reveal, sill and
  // shadow gap are the details that survive at camera distance.
  const heroBayGeometry = new RoundedBoxGeometry(1, 1, 1, 0.08, 3);
  const addHeroBayWindow = (x, z, outward, y, windowWidth, frameMaterial) => {
    const bay = new THREE.Mesh(heroBayGeometry, frameMaterial);
    bay.position.set(x + outward * 0.26, y, z);
    bay.scale.set(0.46, 1.72, windowWidth + 0.26);
    bay.castShadow = true;
    bay.receiveShadow = true;
    group.add(bay);

    addBox(group, 0.12, 1.3, windowWidth, heroFacadeGlass,
      x + outward * 0.51, y, z);
    addBox(group, 0.08, 1.34, 0.075, heroFacadeDarkTrim,
      x + outward * 0.56, y, z - windowWidth * 0.24);
    addBox(group, 0.08, 1.34, 0.075, heroFacadeDarkTrim,
      x + outward * 0.56, y, z + windowWidth * 0.24);
    addBox(group, 0.08, 0.07, windowWidth + 0.05, heroFacadeDarkTrim,
      x + outward * 0.56, y, z);
    addBox(group, 0.11, 0.12, windowWidth + 0.4, heroFacadeSill,
      x + outward * 0.53, y - 0.92, z);
    addBox(group, 0.1, 0.08, windowWidth + 0.32, heroFacadeFrame,
      x + outward * 0.53, y + 0.91, z);
  };

  const addDetailedSideFacade = (x, z, outward, length, floors, paletteIndex) => {
    const detailStart = group.children.length;
    const baseY = heroFacadeBase(x, z);
    const facadeMaterial = masonryMaterials[paletteIndex % masonryMaterials.length];
    const facadeHeight = floors * 3.2 + 2.3;
    // Pilasters and a cap define a readable street-wall datum even where the
    // massing block behind it remains intentionally simple.
    addBox(group, 0.2, facadeHeight, length + 0.25, facadeMaterial,
      x + outward * 0.06, baseY + facadeHeight * 0.5, z);
    for (const edge of [-1, 1]) {
      addBox(group, 0.34, facadeHeight + 0.28, 0.22, heroFacadeFrame,
        x + outward * 0.22, baseY + facadeHeight * 0.5, z + edge * (length * 0.5 + 0.06));
    }

    const bayZ = [-0.31, 0, 0.31].map((fraction) => z + length * fraction);
    for (let floor = 0; floor < floors; floor += 1) {
      const y = baseY + 4.1 + floor * 3.2;
      for (const windowZ of bayZ) {
        addHeroBayWindow(
          x,
          windowZ,
          outward,
          y,
          1.55,
          floor % 2
            ? heroFacadeFrame
            : masonryMaterials[(paletteIndex + 1) % masonryMaterials.length],
        );
      }
      addBox(group, 0.12, 0.09, length + 0.16, heroFacadeSill,
        x + outward * 0.31, y - 1.02, z);
    }

    // Cornice, roof flashing and compact AC units keep the upper edge from
    // reading like a texture cutoff.
    addBox(group, 0.58, 0.18, length + 0.5, heroFacadeFrame,
      x + outward * 0.29, baseY + facadeHeight + 0.08, z);
    addBox(group, 0.32, 0.12, length + 0.34, heroFacadeDarkTrim,
      x + outward * 0.31, baseY + facadeHeight + 0.24, z);
    for (const unitZ of [z - length * 0.34, z + length * 0.34]) {
      addBox(group, 0.42, 0.42, 0.54, materials.paintedMetal,
        x + outward * 0.34, baseY + facadeHeight + 0.48, unitZ);
      addBox(group, 0.44, 0.035, 0.56, materials.metalDark,
        x + outward * 0.36, baseY + facadeHeight + 0.7, unitZ);
    }

    // Ground-floor entries are recessed behind the bay rhythm so the
    // sidewalk has a believable threshold instead of a wall meeting pavement.
    const doorZ = z - length * 0.28;
    addBox(group, 0.18, 2.35, 1.05, storefrontInterior,
      x + outward * 0.32, baseY + 1.2, doorZ);
    const sideEntryDoor = addBox(group, 0.08, 2.1, 0.82, storefrontDoor,
      x + outward * 0.48, baseY + 1.2, doorZ);
    addBox(group, 0.1, 0.12, 1.28, heroFacadeSill,
      x + outward * 0.5, baseY + 2.37, doorZ);
    addBox(group, 0.76, 0.11, 1.52, awningMaterial,
      x + outward * 0.62, baseY + 2.68, doorZ);
    addBox(group, 0.08, 0.1, 1.38, heroFacadeDarkTrim,
      x + outward * 0.66, baseY + 2.51, doorZ);
    // The side-façade entry is a real authored doorway, not just trim on the
    // building shell. Register it beside the retail doors so every visible
    // street threshold resolves to the same collision-safe staging interior.
    const sideDistrict = inferDistrict(x, z, 'rowhouse');
    const sideHeading = outward > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    const sideEntryPortal = registerPortal({
      x: x + outward * 0.88,
      z: doorZ,
      label: 'Edwardian apartment entry',
      variant: (paletteIndex + floors) % 3,
      roomKind: 'rowhouse',
      door: sideEntryDoor,
      radius: 4.4,
      heading: sideHeading,
      district: sideDistrict,
      source: 'authored-facade',
      wayfindingStyle: 'residential',
    });
    addPortalWayfindingSign(sideEntryPortal, 'Residents · Enter', {
      tone: 'residential',
      compact: true,
    });

    // These assemblies are close-range shading detail, not skyline occluders.
    // Keep them in the beauty pass while excluding their hundreds of tiny
    // pieces from the 2048px shadow atlas.
    group.children.slice(detailStart).forEach((child) => {
      child.traverse((object) => {
        if (!object.isMesh) return;
        object.userData.noShadow = true;
        object.userData.noReceiveShadow = true;
      });
    });
  };

  const addHeroPhotoWall = (
    x,
    z,
    outward,
    length,
    height,
    material = heroPhotoMaterial,
    { tint = 0xffffff, crop = 0 } = {},
  ) => {
    const wallMaterial = material.clone();
    wallMaterial.color.set(tint);
    if (material.map) {
      const map = material.map.clone();
      map.offset.x = crop;
      map.repeat.x = 1 - crop * 2;
      map.needsUpdate = true;
      wallMaterial.map = map;
      wallMaterial.bumpMap = map;
    }
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(length, height, 2, 2),
      wallMaterial,
    );
    wall.name = 'Authored Edwardian hero facade';
    wall.position.set(
      x + outward * 0.34,
      heroFacadeBase(x, z) + height * 0.5,
      z,
    );
    wall.rotation.y = outward > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    wall.userData.noShadow = true;
    wall.userData.noReceiveShadow = true;
    group.add(wall);
  };

  const addStorefrontSign = (x, z, outward, label, background) => {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 72;
    const context = canvas.getContext('2d');
    context.fillStyle = `#${background.color.getHexString()}`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#f4ead6';
    context.font = '600 31px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, canvas.width * 0.5, canvas.height * 0.52);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.54,
      metalness: 0.08,
    });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.1, 0.58), material);
    sign.position.set(x + outward * 0.54, heroFacadeBase(x, z) + 3.92, z);
    sign.rotation.y = outward > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    sign.castShadow = true;
    group.add(sign);
  };

  const addRoadsideStorefront = (x, z, outward, accent) => {
    const baseY = heroFacadeBase(x, z);
    const facadeX = x + outward * 0.1;
    addBox(group, 0.16, 2.86, 4.9, storefrontInterior, facadeX, baseY + 1.43, z);
    addBox(group, 0.18, 2.68, 4.7, storefrontGlass, x + outward * 0.17, baseY + 1.46, z);

    for (const postZ of [-2.35, -0.72, 0.72, 2.35]) {
      addBox(group, 0.11, 2.78, 0.09, materials.metalDark,
        x + outward * 0.3, baseY + 1.45, z + postZ);
    }
    addBox(group, 0.12, 0.1, 4.85, materials.metalDark,
      x + outward * 0.3, baseY + 0.18, z);
    addBox(group, 0.12, 0.1, 4.85, materials.metalDark,
      x + outward * 0.3, baseY + 2.79, z);

    const roadsideEntryDoor = addBox(group, 0.2, 2.45, 0.94, storefrontDoor,
      x + outward * 0.32, baseY + 1.32, z - 1.55);
    addBox(group, 0.06, 0.06, 0.06, materials.signLetter,
      x + outward * 0.46, baseY + 1.34, z - 1.08);
    addBox(group, 0.72, 0.12, 5.22, accent,
      x + outward * 0.46, baseY + 2.98, z);
    addBox(group, 0.11, 0.5, 4.5, materials.signGreen,
      x + outward * 0.34, baseY + 3.36, z);
    addBox(group, 0.12, 0.08, 3.65, materials.signLetter,
      x + outward * 0.42, baseY + 3.36, z);
    const roomKind = x > 28 ? 'cafe' : 'market';
    const roadsideDistrict = inferDistrict(x, z);
    const roadsideHeading = outward > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    const roadsidePortal = registerPortal({
      x: x + outward * 0.88,
      z: z - 1.55,
      label: x > 28 ? 'Pacific Cafe' : 'Mission Market',
      variant: outward < 0 ? 0 : 1,
      roomKind,
      radius: 5.8,
      door: roadsideEntryDoor,
      heading: roadsideHeading,
      district: roadsideDistrict,
      source: 'authored-facade',
      wayfindingStyle: roomKind === 'cafe' ? 'market' : 'industrial',
    });
    addPortalWayfindingSign(roadsidePortal, entranceTextFor(roomKind, 'masonry'), {
      tone: roadsidePortal.wayfindingStyle,
      compact: true,
    });
  };

  const addLitDisplayWindow = (x, z, outward) => {
    const baseY = heroFacadeBase(x, z);
    const interior = addBox(group, 0.16, 1.72, 3.34, storefrontInterior,
      x + outward * 0.34, baseY + 1.38, z);
    interior.userData.noShadow = true;
    interior.userData.noReceiveShadow = true;
    const pane = addBox(group, 0.08, 1.58, 3.22, storefrontGlass,
      x + outward * 0.5, baseY + 1.38, z);
    pane.userData.noShadow = true;
    pane.userData.noReceiveShadow = true;
    for (const displayZ of [z - 0.82, z + 0.82]) {
      const glow = addBox(group, 0.045, 0.72, 0.54, storefrontGlow,
        x + outward * 0.55, baseY + 1.3, displayZ);
      glow.userData.noShadow = true;
      glow.userData.noReceiveShadow = true;
    }
    [-1.52, 1.52].forEach((offset) => {
      const mullion = addBox(group, 0.09, 1.72, 0.08, heroFacadeDarkTrim,
        x + outward * 0.56, baseY + 1.38, z + offset);
      mullion.userData.noShadow = true;
      mullion.userData.noReceiveShadow = true;
    });
    const header = addBox(group, 0.1, 0.12, 3.34, heroFacadeFrame,
      x + outward * 0.56, baseY + 2.26, z);
    header.userData.noShadow = true;
    header.userData.noReceiveShadow = true;
  };

  const addBayWindow = (x, z, floors, outward, paletteIndex) => {
    const baseY = heroFacadeBase(x, z);
    for (let floor = 0; floor < floors; floor += 1) {
      const y = baseY + 3.5 + floor * 3.2;
      addBox(group, 0.68, 1.82, 2.16, bayGlass, x + outward * 0.36, y, z);
      addBox(group, 0.13, 2.02, 2.36, masonryMaterials[paletteIndex], x + outward * 0.73, y, z);
      addBox(group, 0.8, 0.1, 2.42, awningMaterial, x + outward * 0.42, y + 1.08, z);
    }
  };

  const addFrontBayWindow = (x, z, floors, paletteIndex) => {
    const baseY = heroFacadeBase(x, z);
    for (let floor = 0; floor < floors; floor += 1) {
      const y = baseY + 3.45 + floor * 3.2;
      addBox(group, 2.18, 1.8, 0.72, bayGlass, x, y, z - 0.38);
      addBox(group, 0.14, 2.02, 0.86, masonryMaterials[paletteIndex], x - 1.15, y, z - 0.42);
      addBox(group, 0.14, 2.02, 0.86, masonryMaterials[paletteIndex], x + 1.15, y, z - 0.42);
      addBox(group, 2.42, 0.1, 0.92, awningMaterial, x, y + 1.08, z - 0.4);
    }
  };

  addBayWindow(17.2, -34, 5, 1, 1);
  addBayWindow(17.2, -18, 4, 1, 3);
  // addBayWindow(38.8, 26, 6, -1, 4);
  // The upper east-side bay stack projects into the open bridge gap from the
  // hero camera. The authored photo facade and fire-escape rhythm already
  // carry this frontage; omit the detached end-on windows.
  // addBayWindow(38.8, 42, 5, -1, 0);
  addFrontBayWindow(10, -47.7, 8, 5);

  // The two canyon façades nearest the camera carry balconies, recessed
  // glazing and metal guardrails. These shallow assemblies create the kind
  // of layered shadow and material scale that a flat window grid cannot.
  const addSideBalconies = (x, z, outward, floors, accent) => {
    const baseY = heroFacadeBase(x, z);
    for (let floor = 0; floor < floors; floor += 1) {
      const y = baseY + 4.15 + floor * 4.05;
      addBox(group, 1.42, 0.1, 3.35, balconyMetal,
        x + outward * 0.72, y, z);
      for (const railZ of [-1.65, -0.82, 0, 0.82, 1.65]) {
        addBox(group, 0.08, 0.72, 0.08, balconyRail,
          x + outward * 1.38, y + 0.43, z + railZ);
      }
      addBox(group, 0.08, 0.08, 3.4, balconyRail,
        x + outward * 1.38, y + 0.8, z);
      for (const railZ of [-1.65, 1.65]) {
        addBox(group, 1.42, 0.72, 0.08, balconyRail,
          x + outward * 0.72, y + 0.43, z + railZ);
        addBox(group, 0.08, 0.72, 0.08, balconyRail,
          x + outward * 0.08, y + 0.43, z + railZ);
      }
      for (const supportZ of [-1.18, 1.18]) {
        addBox(group, 0.08, 0.58, 0.08, balconyRail,
          x + outward * 0.48, y - 0.29, z + supportZ);
      }
      addBox(group, 0.08, 1.95, 1.3, bayGlass,
        x + outward * 0.2, y + 0.72, z);
      addBox(group, 1.5, 0.08, 0.12, accent,
        x + outward * 0.22, y + 1.72, z);
    }
  };

  const addSideFireEscape = (x, z, outward, floors) => {
    const baseY = heroFacadeBase(x, z);
    for (let floor = 0; floor < floors; floor += 1) {
      const y = baseY + 4.0 + floor * 3.7;
      addBox(group, 1.62, 0.1, 3.25, materials.fireEscape,
        x + outward * 0.78, y, z);
      addBox(group, 0.08, 0.86, 0.08, materials.fireEscape,
        x + outward * 1.48, y + 0.43, z - 1.5);
      addBox(group, 0.08, 0.86, 0.08, materials.fireEscape,
        x + outward * 1.48, y + 0.43, z + 1.5);
      addBox(group, 0.08, 0.08, 3.2, materials.fireEscape,
        x + outward * 1.48, y + 0.84, z);
      if (floor < floors - 1) {
        const ladder = addBox(group, 0.08, 3.6, 0.08, materials.fireEscape,
          x + outward * 0.92, y + 1.8, z + 1.08);
        ladder.rotation.z = outward * 0.13;
      }
    }
  };

  addSideBalconies(16.62, -36.2, 1, 4, masonryMaterials[0]);
  addSideBalconies(37.72, -35.4, -1, 4, masonryMaterials[1]);
  // The camera sees the west face of the near left block; dress that face
  // explicitly so the hero composition has active frontage on both sides.
  addSideBalconies(3.42, -35.4, -1, 4, masonryMaterials[3]);
  addSideBalconies(-2.52, -35.4, 1, 4, masonryMaterials[0]);
  addSideFireEscape(38.04, -35.4, -1, 4);

  // The nearest blocks get a coherent Victorian/Edwardian bay rhythm. These
  // authored sections are intentionally limited to the hero corridor so the
  // scene gains believable scale without turning the entire district into a
  // dense, expensive wall of unique meshes.
  // The authored atlas is intentionally kept at its native ~2:1 proportion;
  // stretching it into a tower-height billboard was the single biggest cue
  // that the previous pass was a decal rather than a street facade.
  addHeroPhotoWall(16.68, -54.0, 1, 17.8, 17.8, heroTallPhotoMaterial, {
    tint: 0xf1dfd1,
    crop: 0.015,
  });
  addHeroPhotoWall(16.68, -35.4, 1, 17.8, 17.8, heroTallPhotoMaterial, {
    tint: 0xd6dfd8,
    crop: 0.055,
  });
  addHeroPhotoWall(16.68, -16.0, 1, 17.8, 17.8, heroTallPhotoMaterial, {
    tint: 0xd8d3df,
    crop: 0.035,
  });
  addHeroPhotoWall(38.04, -54.0, -1, 17.8, 8.8, heroPhotoMaterial, {
    tint: 0xe3d5cb,
    crop: 0.025,
  });
  addHeroPhotoWall(38.04, -35.4, -1, 17.8, 8.8, heroPhotoMaterial, {
    tint: 0xd1dde0,
    crop: 0.065,
  });
  addHeroPhotoWall(38.04, -16.0, -1, 17.8, 8.8, heroPhotoMaterial, {
    tint: 0xe2ddc9,
    crop: 0.045,
  });
  addDetailedSideFacade(16.68, -35.4, 1, 8.9, 5, 3);
  addDetailedSideFacade(38.04, -35.4, -1, 8.9, 5, 0);
  addDetailedSideFacade(16.68, -45.4, 1, 7.2, 4, 5);
  addDetailedSideFacade(38.04, -45.4, -1, 7.2, 4, 2);
  // A fifth bay closes the south end of the corridor so the far stop has a
  // signed residential threshold of its own instead of a blank party wall.
  addDetailedSideFacade(16.68, -25.4, 1, 7.2, 4, 1);

  // Ground-floor retail is the strongest street-scale cue in the hero view.
  // These are shallow facade assemblies, so they sit naturally on the
  // existing blocks while giving the canyon doors, glazing, awnings and
  // storefront rhythm instead of blank walls.
  addRoadsideStorefront(16.7, -44, 1, awningMaterial);
  addRoadsideStorefront(16.7, -36, 1, masonryMaterials[3]);
  addRoadsideStorefront(38.2, -43, -1, masonryMaterials[0]);
  addRoadsideStorefront(38.2, -35, -1, awningMaterial);
  addRoadsideStorefront(3.42, -43, -1, awningMaterial);
  addRoadsideStorefront(3.42, -35, -1, masonryMaterials[3]);
  addRoadsideStorefront(-2.52, -43, 1, awningMaterial);
  addRoadsideStorefront(-2.52, -35, 1, masonryMaterials[0]);
  addStorefrontSign(16.7, -44, 1, 'MISSION MARKET', awningMaterial);
  addStorefrontSign(38.2, -43, -1, 'PACIFIC CAFE', masonryMaterials[0]);
  addStorefrontSign(3.42, -43, -1, 'MISSION MARKET', awningMaterial);
  addStorefrontSign(-2.52, -43, 1, 'MISSION MARKET', awningMaterial);
  addLitDisplayWindow(16.7, -44, 1);
  addLitDisplayWindow(16.7, -36, 1);
  addLitDisplayWindow(38.2, -43, -1);
  addLitDisplayWindow(38.2, -35, -1);

  const addMuniShelter = (x, z) => {
    const baseY = streetHeight(x, z) + 0.34;
    addBox(group, 0.08, 2.45, 3.75, storefrontGlass, x + 0.72, baseY + 1.23, z);
    addBox(group, 0.08, 2.45, 3.75, storefrontGlass, x - 0.72, baseY + 1.23, z);
    addBox(group, 1.55, 0.08, 3.85, materials.metalDark, x, baseY + 2.46, z);
    addBox(group, 1.52, 0.14, 3.35, materials.wood, x, baseY + 0.78, z);
    addBox(group, 1.62, 0.1, 0.1, materials.metalDark, x, baseY + 1.7, z - 1.72);
    addCylinder(group, 0.055, 2.7, materials.metalDark, x + 0.94, baseY + 1.35, z + 1.9);
    addBox(group, 0.12, 0.74, 0.08, materials.signGreen, x + 0.94, baseY + 2.62, z + 1.9);
    addBox(group, 0.12, 0.12, 0.04, materials.signLetter, x + 0.94, baseY + 2.62, z + 1.84);
  };

  addMuniShelter(34.42, -27.8);

  const addStreetSign = (x, z, outward, color, label) => {
    const y = streetHeight(x, z) + 4.15;
    addCylinder(group, 0.07, 3.4, materials.metalDark, x, y - 1.7, z);
    addBox(group, 0.12, 0.68, 2.6, color, x + outward * 0.36, y, z);
    addBox(group, 0.12, 0.08, 2.05, materials.signLetter, x + outward * 0.44, y, z);
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 384;
      canvas.height = 64;
      const context = canvas.getContext('2d');
      context.fillStyle = `#${color.color.getHexString()}`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#f4ead6';
      context.font = '600 25px Arial, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, canvas.width * 0.5, canvas.height * 0.52);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const signFace = new THREE.Mesh(
        new THREE.PlaneGeometry(2.35, 0.39),
        new THREE.MeshStandardMaterial({ map: texture, roughness: 0.56, metalness: 0.08 }),
      );
      signFace.position.set(x + outward * 0.51, y, z);
      signFace.rotation.y = outward > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
      group.add(signFace);
    }
  };

  addStreetSign(20.2, -47, 1, materials.signGreen, 'MISSION ST');
  addStreetSign(35.7, 48, -1, materials.signGreen, 'CALIFORNIA ST');

  const addCableCar = (z) => {
    const baseY = streetHeight(28, z) + 0.28;
    const car = new THREE.Group();
    car.name = 'Static cable car on California Street';
    // Open-sided red/cream coach + wood benches + brass poles (pass16 A/B).
    addCableCarBox(car, 1.88, 0.24, 7.72, cableCarRed, 0, 0.28, 0);
    addCableCarBox(car, 1.84, 1.52, 7.34, cableCarRed, 0, 1.08, 0);
    addCableCarBox(car, 1.72, 0.18, 7.18, cableCarCream, 0, 1.92, 0);
    addCableCarBox(car, 1.34, 0.24, 6.72, cableCarCream, 0, 2.18, 0);
    addCableCarBox(car, 0.92, 0.16, 4.8, cableCarCream, 0, 2.34, 0);
    // Roof crown brass strip.
    addCableCarBox(car, 1.05, 0.04, 5.1, cableCarBrass, 0, 2.44, 0);
    for (const end of [-1, 1]) {
      addCableCarBox(car, 1.62, 0.16, 0.72, cableCarCream, 0, 0.42, end * 3.86);
      addCableCarBox(car, 0.96, 0.72, 0.08, bayGlass, 0, 1.46, end * 3.84);
      addCableCarBox(car, 0.12, 0.92, 0.11, cableCarWood, -0.68, 1.46, end * 3.93);
      addCableCarBox(car, 0.12, 0.92, 0.11, cableCarWood, 0.68, 1.46, end * 3.93);
      addCableCarBox(car, 0.16, 0.08, 0.16, cableCarBrass, 0, 1.88, end * 3.9);
    }
    for (const side of [-1, 1]) {
      addCableCarBox(car, 0.12, 0.18, 7.72, cableCarWood, side * 1.01, 0.76, 0);
      addCableCarBox(car, 0.12, 0.16, 7.72, cableCarCream, side * 1.01, 2.06, 0);
      for (const mullionZ of [-2.7, -1.35, 0, 1.35, 2.7]) {
        addCableCarBox(car, 0.12, 0.92, 0.1, cableCarWood, side * 1.02, 1.46, mullionZ);
        // Brass grab poles at open sides (running-board grips).
        addCylinder(car, 0.035, 1.55, cableCarBrass, side * 1.08, 1.55, mullionZ);
      }
      for (let window = -2; window <= 2; window += 1) {
        addBox(car, 0.05, 0.68, 0.82, bayGlass, side * 0.985, 1.47, window * 1.35);
        addBox(car, 0.04, 0.12, 0.72, cableCarWood, side * 0.72, 0.92, window * 1.35);
      }
    }
    addCableCarBox(car, 1.4, 0.12, 0.72, cableCarWood, 0, 0.38, -4.04);
    addBox(car, 0.72, 0.3, 0.08, materials.signGreen, 0, 2.48, -3.94);
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 128;
      const context = canvas.getContext('2d');
      context.fillStyle = '#f3d9a8';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#b52f31';
      context.fillRect(0, 0, canvas.width, 18);
      context.fillRect(0, canvas.height - 18, canvas.width, 18);
      context.fillStyle = '#1c1410';
      context.font = '800 52px Arial, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText('CALIFORNIA', canvas.width * 0.5, canvas.height * 0.52);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      const boardMat = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.55,
        metalness: 0.06,
        emissive: 0x22180c,
        emissiveIntensity: 0.18,
      });
      // South face toward hero cam at z≈14; side face for three-quarter read.
      const southBoard = new THREE.Mesh(new THREE.PlaneGeometry(1.85, 0.46), boardMat);
      southBoard.position.set(0, 2.58, 4.12);
      const sideBoard = new THREE.Mesh(new THREE.PlaneGeometry(1.85, 0.46), boardMat.clone());
      sideBoard.position.set(1.08, 2.42, 0.2);
      sideBoard.rotation.y = -Math.PI * 0.5;
      car.add(southBoard, sideBoard);
    }
    for (const wheelX of [-0.68, 0.68]) {
      for (const wheelZ of [-2.65, 2.65]) {
        const wheel = addCylinder(car, 0.18, 0.13, materials.metalDark, wheelX, 0.35, wheelZ);
        wheel.rotation.z = Math.PI * 0.5;
      }
    }
    addBox(car, 0.2, 0.18, 0.08, lampBulbMaterial, 0, 0.78, -3.88);
    addCylinder(car, 0.055, 2.2, materials.metalDark, 0.35, 3.35, 0.35);
    // Pass22: A/B clothing variety from Hyde/Powell refs (jeans, leather, quilt, hi-vis).
    const riderCoat = new THREE.MeshStandardMaterial({
      color: 0x2c333c,
      roughness: 0.82,
      emissive: 0x101418,
      emissiveIntensity: 0.2,
    });
    const riderCoatWarm = new THREE.MeshStandardMaterial({
      color: 0x6b3a28,
      roughness: 0.55,
      metalness: 0.08,
      emissive: 0x241208,
      emissiveIntensity: 0.18,
    });
    const riderQuilt = new THREE.MeshStandardMaterial({
      color: 0x1a222c,
      roughness: 0.92,
      emissive: 0x0c1016,
      emissiveIntensity: 0.16,
    });
    const riderJeans = new THREE.MeshStandardMaterial({
      color: 0x3a4f6e,
      roughness: 0.78,
      emissive: 0x0c1420,
      emissiveIntensity: 0.12,
    });
    const riderShirt = new THREE.MeshStandardMaterial({
      color: 0xe8e4d8,
      roughness: 0.7,
      emissive: 0x2a2820,
      emissiveIntensity: 0.1,
    });
    const riderHiVis = new THREE.MeshStandardMaterial({
      color: 0xd6c020,
      roughness: 0.55,
      emissive: 0x5a4808,
      emissiveIntensity: 0.45,
    });
    const riderSkin = new THREE.MeshStandardMaterial({
      color: 0xd4a07a,
      roughness: 0.85,
      emissive: 0x3a2010,
      emissiveIntensity: 0.18,
    });
    const riderHair = new THREE.MeshStandardMaterial({
      color: 0x1c1410,
      roughness: 0.95,
      emissive: 0x080604,
      emissiveIntensity: 0.1,
    });
    const makeRiderFaceMat = (skinHex, hairHex, seed = 0) => {
      if (typeof document === 'undefined') return riderSkin;
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      const grd = ctx.createLinearGradient(0, 0, 0, 128);
      grd.addColorStop(0, skinHex);
      grd.addColorStop(1, seed % 2 === 0 ? '#b88060' : '#a87050');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = 'rgba(140,70,45,0.2)';
      ctx.beginPath();
      ctx.ellipse(64, 78, 48, 36, 0, 0, Math.PI * 2);
      ctx.fill();
      // Eyes with sclera + iris
      const eyeY = 48;
      [[36, eyeY], [92, eyeY]].forEach(([ex, ey], i) => {
        ctx.fillStyle = '#f4efe8';
        ctx.beginPath();
        ctx.ellipse(ex, ey, 12, 9, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = seed % 2 === 0 ? '#3a5a4a' : '#2a3a5a';
        ctx.beginPath();
        ctx.ellipse(ex + (i === 0 ? 1 : -1), ey, 6, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0a0806';
        ctx.beginPath();
        ctx.ellipse(ex + (i === 0 ? 1 : -1), ey, 2.5, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = hairHex;
      ctx.fillRect(22, 34, 28, 5);
      ctx.fillRect(78, 34, 28, 5);
      ctx.fillStyle = 'rgba(100,55,40,0.4)';
      ctx.beginPath();
      ctx.moveTo(64, 52);
      ctx.lineTo(70, 72);
      ctx.lineTo(58, 72);
      ctx.fill();
      ctx.strokeStyle = '#7a3a48';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(64, 86, 14, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      // Hair fringe
      ctx.fillStyle = hairHex;
      ctx.fillRect(8, 0, 112, 28);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      return new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.72,
        emissive: 0x3a2014,
        emissiveIntensity: 0.32,
        side: THREE.DoubleSide,
      });
    };
    let riderFaceSeed = 0;
    const addRiderHead = (x, y, z, facing = 'south') => {
      // Pass24: textured face card + neck/hair for A/B person read.
      const faceMat = makeRiderFaceMat(
        riderFaceSeed % 2 === 0 ? '#d4a07a' : '#c48962',
        riderFaceSeed % 3 === 0 ? '#3a2818' : '#1c1410',
        riderFaceSeed,
      );
      riderFaceSeed += 1;
      addBox(car, 0.14, 0.12, 0.14, riderSkin, x, y - 0.14, z);
      addBox(car, 0.28, 0.28, 0.26, riderSkin, x, y, z);
      // Slightly oversized face card; bias toward downhill three-quarter hero cam.
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), faceMat);
      if (facing === 'east') {
        face.position.set(x + 0.15, y + 0.02, z - 0.04);
        face.rotation.y = Math.PI * 0.35;
      } else if (facing === 'west') {
        face.position.set(x - 0.15, y + 0.02, z - 0.04);
        face.rotation.y = -Math.PI * 0.35;
      } else {
        // South-east bias so downhill cam at +X/−Z reads eyes/mouth.
        face.position.set(x + 0.06, y + 0.02, z - 0.15);
        face.rotation.y = -Math.PI * 0.22;
      }
      car.add(face);
      addBox(car, 0.32, 0.16, 0.3, riderHair, x, y + 0.18, z);
      addBox(car, 0.3, 0.22, 0.1, riderHair, x, y + 0.02, z + 0.12);
    };
    const addBenchRider = (side, seatZ, coat = riderCoat, legs = riderJeans) => {
      const x = side * 0.95;
      addBox(car, 0.4, 0.52, 0.34, coat, x, 1.22, seatZ);
      addBox(car, 0.15, 0.5, 0.15, legs, x + side * 0.14, 0.7, seatZ - 0.08);
      addBox(car, 0.15, 0.5, 0.15, legs, x + side * 0.14, 0.7, seatZ + 0.1);
      addBox(car, 0.18, 0.08, 0.22, riderHair, x + side * 0.14, 0.42, seatZ - 0.08);
      addBox(car, 0.18, 0.08, 0.22, riderHair, x + side * 0.14, 0.42, seatZ + 0.1);
      addRiderHead(x, 1.64, seatZ, side > 0 ? 'east' : 'west');
    };
    const addStandingRider = (side, standZ, coat = riderCoatWarm, legs = riderJeans) => {
      const x = side * 1.18;
      addBox(car, 0.34, 0.62, 0.28, coat, x, 1.36, standZ);
      addBox(car, 0.15, 0.68, 0.15, legs, x - side * 0.08, 0.66, standZ);
      addBox(car, 0.15, 0.68, 0.15, legs, x + side * 0.08, 0.66, standZ + 0.05);
      addBox(car, 0.24, 0.12, 0.28, riderHair, x, 0.36, standZ);
      addRiderHead(x, 1.88, standZ, 'south');
      addBox(car, 0.58, 0.11, 0.11, coat, side * 0.9, 1.56, standZ);
      addBox(car, 0.42, 0.09, 0.09, coat, side * 0.95, 1.4, standZ + 0.08);
      // Hand gripping pole (palm + fingers cue).
      addBox(car, 0.14, 0.1, 0.12, riderSkin, side * 1.14, 1.56, standZ);
      addBox(car, 0.08, 0.06, 0.16, riderSkin, side * 1.16, 1.52, standZ + 0.06);
    };
    addBenchRider(1, -1.55, riderQuilt, riderJeans);
    addBenchRider(1, -0.35, riderCoatWarm, riderJeans);
    addBenchRider(1, 0.85, riderShirt, riderJeans);
    addBenchRider(1, 2.05, riderCoat, riderJeans);
    addBenchRider(-1, -0.95, riderCoatWarm, riderJeans);
    addBenchRider(-1, 0.45, riderQuilt, riderJeans);
    addBenchRider(-1, 1.65, riderShirt, riderJeans);
    addStandingRider(1, 3.35, riderShirt, riderJeans);
    addStandingRider(1, -3.25, riderCoatWarm, riderJeans);
    addStandingRider(-1, 2.85, riderQuilt, riderJeans);
    // Hi-vis gripman / conductor cue (ref yellow vest).
    addStandingRider(1, 3.9, riderHiVis, riderJeans);
    car.position.set(28, baseY, z);
    // Match street grade only — over-pitch shattered the open coach in hero lens.
    car.rotation.x = Math.atan(GRADE_Z);
    group.add(car);
  };

  const railPoints = (offset) => {
    const points = [];
    for (let z = -64; z <= 64; z += 16) {
      points.push(new THREE.Vector3(28 + offset, streetHeight(28, z) + 0.09, z));
    }
    return points;
  };
  // Twin steel rails + center cable slot — required for blind A/B vs real SF.
  const cableSlotMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a1c1e,
    roughness: 0.92,
    metalness: 0.35,
  });
  const cableSteelMaterial = new THREE.MeshStandardMaterial({
    color: 0x9a958c,
    roughness: 0.42,
    metalness: 0.78,
  });
  for (let z = -64; z < 64; z += 8) {
    const y0 = streetHeight(28, z) + 0.06;
    const y1 = streetHeight(28, z + 8) + 0.06;
    const midY = (y0 + y1) * 0.5;
    const midZ = z + 4;
    for (const offset of [-0.56, 0.56]) {
      const rail = new THREE.Mesh(unitBox, cableSteelMaterial);
      rail.position.set(28 + offset, midY, midZ);
      rail.scale.set(0.12, 0.07, 8.1);
      rail.userData.noShadow = true;
      group.add(rail);
    }
    const slot = new THREE.Mesh(unitBox, cableSlotMaterial);
    slot.position.set(28, midY - 0.01, midZ);
    slot.scale.set(0.22, 0.05, 8.1);
    slot.userData.noShadow = true;
    group.add(slot);
  }
  for (const offset of [-0.56, 0.56]) {
    const railGeometry = new THREE.BufferGeometry().setFromPoints(railPoints(offset));
    group.add(new THREE.Line(railGeometry, cableRail));
  }
  const wireCurve = new THREE.CatmullRomCurve3(
    railPoints(0).map((point) => point.clone().setY(point.y + 7.4)),
  );
  const heroWireMaterial = materials.wire.clone();
  heroWireMaterial.opacity = 0.78;
  heroWireMaterial.color.setHex(0x9aa8a4);
  heroWireMaterial.metalness = 0.22;
  const heroWireLine = new THREE.LineBasicMaterial({
    color: 0xb8c4c0,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(new THREE.TubeGeometry(wireCurve, 36, 0.011, 5, false), heroWireMaterial));
  // A second pair of trolley wires gives the avenue the dense overhead
  // infrastructure that is characteristic of San Francisco transit streets.
  const catenaryPoints = (offset) => {
    const points = [];
    for (let z = -64; z <= 64; z += 8) {
      points.push(new THREE.Vector3(
        28 + offset,
        streetHeight(28 + offset, z) + 7.05 - Math.sin(((z + 64) / 128) * Math.PI) * 0.34,
        z,
      ));
    }
    return points;
  };
  [-1.45, 1.45].forEach((offset) => {
    const catenary = new THREE.CatmullRomCurve3(catenaryPoints(offset));
    group.add(new THREE.Mesh(new THREE.TubeGeometry(catenary, 48, 0.009, 4, false), heroWireMaterial));
  });
  for (const offset of [-1.45, 0, 1.45]) {
    const spanPoints = [];
    for (let z = -8; z <= 24; z += 2) {
      spanPoints.push(new THREE.Vector3(
        28 + offset,
        streetHeight(28 + offset, z) + 7.12 - Math.sin(((z + 8) / 32) * Math.PI) * 0.22,
        z,
      ));
    }
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(spanPoints),
      heroWireLine,
    ));
  }
  // A short hero-band span between z=0 and z=16 keeps the overhead grid legible
  // in the cable-car capture without changing the authored coach pose.
  const heroSpanY = streetHeight(28, 8) + 7.02;
  addBox(group, 7.1, 0.09, 0.12, infrastructureMaterial, 28, heroSpanY, 8);
  addRod(group,
    new THREE.Vector3(26.55, heroSpanY, 8),
    new THREE.Vector3(26.55, heroSpanY + 0.18, 8),
    0.045,
    heroWireMaterial);
  addRod(group,
    new THREE.Vector3(29.45, heroSpanY, 8),
    new THREE.Vector3(29.45, heroSpanY + 0.18, 8),
    0.045,
    heroWireMaterial);
  [-48, 0, 48].forEach((z) => {
    const baseY = streetHeight(28, z);
    const supportY = baseY + 7.0;
    for (const x of [20.5, 35.5]) {
      addCylinder(group, 0.1, 7.0, infrastructureMaterial, x, baseY + 3.5, z);
      addCylinder(group, 0.2, 0.08, infrastructureHousingMaterial, x, baseY + 0.28, z);
      addRod(group,
        new THREE.Vector3(x, baseY + 5.7, z),
        new THREE.Vector3(x + (x < 28 ? 1.8 : -1.8), supportY - 0.08, z),
        0.038,
        infrastructureHousingMaterial);
    }
    // Two independent cross-spans match the paired trolley wires and leave a
    // visible insulator at each pickup point.
    addBox(group, 7.1, 0.085, 0.12, infrastructureMaterial, 24.0, supportY, z);
    addBox(group, 7.1, 0.085, 0.12, infrastructureMaterial, 32.0, supportY, z);
    for (const x of [26.55, 29.45]) {
      addCylinder(group, 0.055, 0.16, materials.limestone, x, supportY + 0.11, z);
      addCylinder(group, 0.025, 0.18, infrastructureHousingMaterial, x, supportY + 0.25, z);
    }
  });
  addCableCar(5);

  const installWindows = (matrices, material, name) => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    mesh.name = name;
    mesh.userData.noShadow = true;
    mesh.userData.noReceiveShadow = true;
    matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  };
  installWindows(windowFrame, windowFrameMaterial, 'Facade window frames');
  installWindows(windowCool, coolWindowMaterial, 'Cool facade window grid');
  installWindows(windowCoolDark, coolWindowDarkMaterial, 'Dark reflective windows');
  installWindows(windowCoolLight, coolWindowLightMaterial, 'Sunlit reflective windows');
  installWindows(windowWarm, warmWindowMaterial, 'Warm lit windows');

  const treePlacements = [];
  for (const bounds of blockBounds) {
    const z = bounds.z0 + 1.35 + random() * 0.72;
    const fractions = [
      0.15 + random() * 0.09,
      0.43 + random() * 0.12,
      0.75 + random() * 0.1,
    ];
    for (const fraction of fractions) {
      const x = THREE.MathUtils.lerp(bounds.x0 + 2.5, bounds.x1 - 2.5, fraction);
      const scale = 0.86 + random() * 0.32;
      treePlacements.push({ x, z, scale });
      addBox(
        group,
        1.55,
        0.48,
        1.55,
        materials.planter,
        x,
        streetHeight(x, z) + 0.47,
        z,
      );
    }
  }

  const trunks = new THREE.InstancedMesh(unitCylinder, materials.trunk, treePlacements.length);
  const branches = new THREE.InstancedMesh(unitBox, materials.trunk, treePlacements.length * 2);
  const canopies = new THREE.InstancedMesh(lowPolySphere, materials.foliage, treePlacements.length * 3);
  const sunCanopies = new THREE.InstancedMesh(lowPolySphere, materials.foliageSun, treePlacements.length);
  trunks.name = 'Street tree trunks';
  branches.name = 'Street tree branch structure';
  canopies.name = 'Street tree canopies';
  sunCanopies.name = 'Street tree sunlit foliage';
  let canopyIndex = 0;
  let sunCanopyIndex = 0;
  let branchIndex = 0;
  treePlacements.forEach(({ x, z, scale }, index) => {
    const groundY = streetHeight(x, z) + 0.68;
    const trunkHeight = 3.7 * scale;
    const trunkMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, groundY + trunkHeight * 0.5, z),
      new THREE.Quaternion(),
      new THREE.Vector3(0.42 * scale, trunkHeight, 0.42 * scale),
    );
    trunks.setMatrixAt(index, trunkMatrix);
    for (const rotation of [random() * Math.PI, random() * Math.PI]) {
      const branchMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(
          x,
          groundY + trunkHeight * 0.62 + (branchIndex % 2) * 0.34,
          z,
        ),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotation, 0)),
        new THREE.Vector3(1.2 * scale, 0.12 * scale, 0.12 * scale),
      );
      branches.setMatrixAt(branchIndex, branchMatrix);
      branchIndex += 1;
    }
    const clusters = [
      [-0.45, 0.02, 0.03, 1.18, 1.12, 0.96],
      [0.38, 0.07, -0.1, 1.02, 1.18, 0.9],
      [-0.04, 0.36, 0.2, 0.86, 0.98, 0.82],
      [0.08, -0.16, -0.08, 0.72, 0.7, 0.74],
    ];
    clusters.forEach(([offsetX, offsetY, offsetZ, sx, sy, sz], clusterIndex) => {
      const canopyMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(
          x + offsetX * scale,
          groundY + trunkHeight + (1.05 + offsetY) * scale,
          z + offsetZ * scale,
        ),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, random() * Math.PI, 0)),
        new THREE.Vector3(sx * scale, sy * scale, sz * scale),
      );
      if (clusterIndex === 1) {
        sunCanopies.setMatrixAt(sunCanopyIndex, canopyMatrix);
        sunCanopyIndex += 1;
      } else {
        canopies.setMatrixAt(canopyIndex, canopyMatrix);
        canopyIndex += 1;
      }
    });
  });
  trunks.instanceMatrix.needsUpdate = true;
  branches.instanceMatrix.needsUpdate = true;
  canopies.instanceMatrix.needsUpdate = true;
  sunCanopies.instanceMatrix.needsUpdate = true;
  group.add(trunks, branches, canopies, sunCanopies);

  const carColors = [0x9e4137, 0x3c6074, 0xd0c6ad, 0x384447, 0xc28b45, 0x68715f];
  const addParkedCar = (x, z, heading, colorIndex) => {
    const car = new THREE.Group();
    car.name = 'Parked car';
    const paint = new THREE.MeshStandardMaterial({
      color: carColors[colorIndex % carColors.length],
      roughness: 0.3,
      metalness: 0.48,
    });
    const body = new THREE.Mesh(roundedVehicleGeometry, paint);
    body.scale.set(1.72, 0.48, 3.75);
    body.position.set(0, 0.55, 0);
    car.add(body);
    const cabin = new THREE.Mesh(roundedVehicleGeometry, materials.carGlass);
    cabin.scale.set(1.48, 0.55, 1.9);
    cabin.position.set(0, 1.02, -0.15);
    car.add(cabin);
    addBox(car, 1.55, 0.08, 3.05, materials.metalDark, 0, 0.3, 0);
    addBox(car, 0.28, 0.12, 0.08, materials.glassLight, -0.5, 0.63, 1.88);
    addBox(car, 0.28, 0.12, 0.08, materials.glassLight, 0.5, 0.63, 1.88);
    addBox(car, 0.22, 0.1, 0.08, materials.hydrant, -0.48, 0.62, -1.88);
    addBox(car, 0.22, 0.1, 0.08, materials.hydrant, 0.48, 0.62, -1.88);
    for (const wheelX of [-0.88, 0.88]) {
      for (const wheelZ of [-1.18, 1.18]) {
        const wheel = new THREE.Mesh(wheelGeometry, materials.tire);
        wheel.position.set(wheelX, 0.34, wheelZ);
        wheel.rotation.z = Math.PI * 0.5;
        car.add(wheel);
      }
    }
    car.position.set(x, streetHeight(x, z) + 0.08, z);
    car.quaternion.copy(gradeQuaternion(heading));
    group.add(car);
  };

  [
    [-79.1, -45, 0, 0], [-79.1, -27, 0, 2], [-32.9, -43, 0, 4],
    [-23.1, -28, 0, 1],
    [79.1, 18, 0, 2], [32.9, 38, 0, 0], [-79.1, 35, 0, 1],
    [-62, -5.1, Math.PI * 0.5, 3], [-6, 5.1, Math.PI * 0.5, 4],
    [52, 58.9, Math.PI * 0.5, 5], [5, -58.9, Math.PI * 0.5, 0],
  ].forEach((car) => addParkedCar(...car));
  // Keep the immediate hero lens clear; the authored curb dressing farther
  // down the block supplies parked-car scale without a cropped foreground
  // silhouette competing with the traffic hero.

  const bikeFrameMaterial = new THREE.MeshStandardMaterial({ color: 0x303b3d, roughness: 0.48, metalness: 0.72 });
  const bikeWheelGeometry = new THREE.TorusGeometry(0.28, 0.035, 8, 18);
  const addBikeRack = (x, z) => {
    const rack = new THREE.Group();
    rack.name = 'Sidewalk bike rack';
    addBox(rack, 1.45, 0.06, 0.06, bikeFrameMaterial, 0, 0.48, 0);
    addBox(rack, 0.06, 0.58, 0.06, bikeFrameMaterial, -0.62, 0.26, 0);
    addBox(rack, 0.06, 0.58, 0.06, bikeFrameMaterial, 0.62, 0.26, 0);
    for (const wheelZ of [-0.52, 0.52]) {
      const wheel = new THREE.Mesh(bikeWheelGeometry, bikeFrameMaterial);
      wheel.rotation.x = Math.PI * 0.5;
      wheel.position.set(0, 0.36, wheelZ);
      rack.add(wheel);
    }
    addBox(rack, 0.06, 0.9, 0.06, bikeFrameMaterial, 0, 0.52, 0);
    rack.position.set(x, streetHeight(x, z) + 0.31, z);
    group.add(rack);
  };
  addBikeRack(37.05, -23.8);
  addBikeRack(12.5, 79.7);

  const newspaperMaterial = new THREE.MeshStandardMaterial({ color: 0x2d6870, roughness: 0.66, metalness: 0.16 });
  addBox(group, 0.56, 1.18, 0.42, newspaperMaterial, 37.15, streetHeight(37.15, -24) + 0.9, -24);
  addBox(group, 0.46, 0.08, 0.46, materials.signLetter, 37.15, streetHeight(37.15, -24) + 1.52, -24);

  const addBench = (x, z, heading = 0) => {
    const bench = new THREE.Group();
    bench.name = 'Sidewalk bench';
    addBox(bench, 2.25, 0.14, 0.48, materials.wood, 0, 0.72, 0);
    addBox(bench, 2.25, 0.75, 0.12, materials.wood, 0, 1.08, 0.26);
    addBox(bench, 0.13, 0.7, 0.13, materials.metalDark, -0.78, 0.35, 0);
    addBox(bench, 0.13, 0.7, 0.13, materials.metalDark, 0.78, 0.35, 0);
    bench.position.set(x, streetHeight(x, z) + 0.3, z);
    bench.quaternion.copy(gradeQuaternion(heading));
    group.add(bench);
  };
  addBench(-18, 11.2);
  addBench(-5, 11.2);
  addBench(14, 11.2, Math.PI);
  addBench(40, 11.2);
  addBench(-72, 52, Math.PI * 0.5);
  addBench(72, -12, Math.PI * 0.5);
  addBench(-52, 79.6, Math.PI);
  addBench(64, 79.6, Math.PI);

  for (const [x, z] of [[-35.5, -8.8], [20.5, -8.8], [35.5, 8.8], [-76, 8.8], [76, -8.8]]) {
    const baseY = streetHeight(x, z) + 0.3;
    addCylinder(group, 0.22, 0.9, materials.hydrant, x, baseY + 0.45, z);
    addCylinder(group, 0.34, 0.12, materials.hydrant, x, baseY + 0.89, z);
  }

  const addTrashCan = (x, z, heading = 0) => {
    const can = new THREE.Group();
    can.name = 'Sidewalk trash can';
    addCylinder(can, 0.28, 0.72, materials.metalDark, 0, 0.42, 0);
    addCylinder(can, 0.34, 0.08, materials.paintedMetal, 0, 0.82, 0);
    addBox(can, 0.08, 0.34, 0.08, materials.metalDark, 0, 0.99, -0.2);
    can.position.set(x, streetHeight(x, z) + 0.26, z);
    can.quaternion.copy(gradeQuaternion(heading));
    group.add(can);
  };

  const addParkingMeter = (x, z, heading = 0) => {
    const meter = new THREE.Group();
    meter.name = 'Parking meter';
    addCylinder(meter, 0.055, 1.48, materials.metalDark, 0, 0.74, 0);
    addBox(meter, 0.18, 0.24, 0.12, materials.paintedMetal, 0, 1.45, 0);
    addBox(meter, 0.1, 0.06, 0.04, materials.lampBulb ?? materials.signLetter, 0, 1.51, -0.07);
    meter.position.set(x, streetHeight(x, z) + 0.28, z);
    meter.quaternion.copy(gradeQuaternion(heading));
    group.add(meter);
  };

  // A few small objects give the sidewalks the lived-in density of an
  // actual downtown block without turning the hero view into clutter.
  addTrashCan(19.45, -34, 0);
  addTrashCan(19.58, -15, 0);
  addTrashCan(36.55, -29, Math.PI);
  addTrashCan(36.42, -11, Math.PI);
  addTrashCan(-28, 79.7, 0);
  addTrashCan(30, 79.7, Math.PI);
  addParkingMeter(19.82, -43, 0);
  addParkingMeter(36.18, -35, Math.PI);
  addParkingMeter(19.76, -24, 0);
  addParkingMeter(36.22, -17, Math.PI);
  addParkingMeter(19.84, 21, 0);
  addParkingMeter(36.16, 31, Math.PI);

  // Bounded hero-block continuity: the photo walls carry the upper story,
  // while these low, graded pieces carry the public realm from curb to door.
  // They deliberately do not register portals; the authored doorway order
  // above remains the source of truth for IDs and interaction coverage.
  const heroStreetFrontageMaterial = masonryMaterials[5];
  const heroStreetFrontageDark = masonryMaterials[2];
  const addGradedHeroBox = (
    width,
    height,
    depth,
    material,
    x,
    z,
    yOffset,
    heading = 0,
  ) => {
    const mesh = addBox(
      group,
      width,
      height,
      depth,
      material,
      x,
      streetHeight(x, z) + yOffset,
      z,
      heading,
    );
    mesh.quaternion.copy(gradeQuaternion(heading));
    mesh.userData.noShadow = true;
    mesh.userData.noReceiveShadow = true;
    return mesh;
  };

  const addHeroStreetWallSegment = (x, z, outward, length, material) => {
    addGradedHeroBox(
      0.72,
      1.3,
      length,
      material,
      x + outward * 0.18,
      z,
      0.74,
    );
    addGradedHeroBox(
      0.78,
      0.12,
      length + 0.18,
      heroFacadeSill,
      x + outward * 0.42,
      z,
      1.42,
    );
  };

  const addHeroFrontageModule = (x, z, outward, paletteIndex, label) => {
    const baseY = heroFacadeBase(x, z);
    const faceX = x + outward * 0.38;
    const frontageMaterial = masonryMaterials[paletteIndex % masonryMaterials.length];
    const moduleWidth = 5.2;
    const moduleLength = 5.8;
    addHeroStreetWallSegment(x, z, outward, moduleLength, frontageMaterial);
    addBox(group, 0.22, 2.72, moduleLength - 0.18, storefrontInterior,
      faceX, baseY + 1.36, z);
    addBox(group, 0.1, 2.52, moduleLength - 0.34, storefrontGlass,
      x + outward * 0.53, baseY + 1.4, z);
    for (const mullionZ of [-2.42, -1.2, 0, 1.2, 2.42]) {
      addBox(group, 0.08, 2.58, 0.08, heroFacadeDarkTrim,
        x + outward * 0.58, baseY + 1.4, z + mullionZ);
    }
    addBox(group, 0.72, 0.14, moduleLength + 0.18, awningMaterial,
      x + outward * 0.55, baseY + 2.96, z);
    addBox(group, 0.12, 0.1, moduleLength - 0.16, heroFacadeFrame,
      x + outward * 0.58, baseY + 2.72, z);

    const doorZ = z - moduleLength * 0.3;
    addBox(group, 0.12, 2.28, 0.98, storefrontDoor,
      x + outward * 0.61, baseY + 1.25, doorZ);
    addBox(group, 0.16, 0.1, 1.18, heroFacadeSill,
      x + outward * 0.64, baseY + 2.43, doorZ);
    addBox(group, 0.16, 0.08, 1.18, heroFacadeFrame,
      x + outward * 0.64, baseY + 0.08, doorZ);
    if (label) addStorefrontSign(x, z, outward, label, frontageMaterial);
  };

  // Close the three photographed bays into one street wall on each side;
  // short runs follow the grade instead of producing a floating long slab.
  for (const z of [-59.3, -51.1, -42.9, -34.7, -26.5, -18.3, -10.1]) {
    addHeroStreetWallSegment(16.68, z, 1, 7.55,
      z < -34 ? heroStreetFrontageMaterial : heroStreetFrontageDark);
    addHeroStreetWallSegment(38.04, z, -1, 7.55,
      z < -34 ? heroStreetFrontageDark : heroStreetFrontageMaterial);
  }
  addHeroFrontageModule(16.68, -53.8, 1, 3, 'MISSION MARKET');
  addHeroFrontageModule(38.04, -53.8, -1, 0, 'FERRY CAFE');
  addHeroFrontageModule(16.68, -27.0, 1, 1, 'EDWARDIAN GOODS');
  addHeroFrontageModule(38.04, -27.0, -1, 2, 'NORTH BEACH');

  // A segmented curb face and a few compact planters give the sidewalks a
  // continuous datum while keeping the central travel lane and hotspots open.
  const curbFinish = heroCurbMaterial || materials.curb;
  for (const x of [20.84, 35.16]) {
    for (const z of [-59.3, -51.1, -42.9, -34.7, -26.5, -18.3, -10.1]) {
      addGradedHeroBox(0.28, 0.3, 7.55, curbFinish, x, z, 0.17);
    }
  }
  const addHeroPlanter = (x, z, scale = 0.72) => {
    const groundY = streetHeight(x, z);
    addBox(group, 1.12 * scale, 0.34 * scale, 1.12 * scale,
      materials.planter, x, groundY + 0.5 * scale, z);
    addCylinder(group, 0.11 * scale, 1.12 * scale, materials.trunk,
      x, groundY + 1.12 * scale, z);
    const canopy = new THREE.Mesh(lowPolySphere, materials.foliageSun);
    canopy.position.set(x, groundY + 2.05 * scale, z);
    canopy.scale.setScalar(0.76 * scale);
    canopy.userData.noShadow = true;
    canopy.userData.noReceiveShadow = true;
    group.add(canopy);
  };
  addHeroPlanter(18.45, -55.2);
  addHeroPlanter(18.45, -22.4, 0.64);
  addHeroPlanter(36.72, -50.2, 0.68);
  addHeroPlanter(36.72, -19.4, 0.76);

  // The north end now hands the eye from the cable-car avenue toward the
  // actual waterfront set: Ferry Building, Embarcadero and Coit Tower.
  addStreetSign(20.2, 56, 1, materials.signGreen, 'EMBARCADERO');
  addStreetSign(35.7, 56, -1, materials.signGreen, 'FERRY BUILDING');
  addStreetSign(20.2, 48, 1, materials.signGreen, 'COIT TOWER');
  const ferryApproachMarker = new THREE.Group();
  ferryApproachMarker.name = 'Ferry Building approach marker';
  addBox(ferryApproachMarker, 0.62, 1.55, 0.62, ferryStone, 0, 0.82, 0);
  addBox(ferryApproachMarker, 0.76, 0.12, 0.76, ferryRoof, 0, 1.64, 0);
  addBox(ferryApproachMarker, 0.08, 0.72, 0.96, waterfrontMetal, 0, 1.2, -0.34);
  ferryApproachMarker.position.set(36.65, streetHeight(36.65, 58) + 0.3, 58);
  ferryApproachMarker.quaternion.copy(gradeQuaternion(0));
  ferryApproachMarker.traverse((object) => {
    if (!object.isMesh) return;
    object.userData.noShadow = true;
    object.userData.noReceiveShadow = true;
  });
  group.add(ferryApproachMarker);

  // The city remains a compact outdoor slice, but every registered doorway
  // resolves to a small authored room. Rooms live in a hidden staging wing so
  // entering a building never requires loading or rebuilding geometry.
  const interiorRoot = new THREE.Group();
  interiorRoot.name = 'Enterable interiors staging wing';
  interiorRoot.visible = false;
  scene.add(interiorRoot);

  const interiorFloor = new THREE.MeshStandardMaterial({ color: 0x4a3a32, roughness: 0.86 });
  const interiorWall = new THREE.MeshStandardMaterial({ color: 0xc6b8a2, roughness: 0.82 });
  const interiorTrim = new THREE.MeshStandardMaterial({ color: 0x56463d, roughness: 0.72 });
  const interiorMetal = new THREE.MeshStandardMaterial({ color: 0x242b2b, roughness: 0.42, metalness: 0.72 });
  const interiorWood = new THREE.MeshStandardMaterial({ color: 0x8b5f43, roughness: 0.78 });
  const interiorAccent = new THREE.MeshStandardMaterial({ color: 0xb14e3e, roughness: 0.7 });
  const interiorRug = new THREE.MeshStandardMaterial({ color: 0x6b4b4b, roughness: 0.96 });
  const interiorBlue = new THREE.MeshStandardMaterial({ color: 0x38566a, roughness: 0.84 });
  const interiorPaper = new THREE.MeshStandardMaterial({ color: 0xe3d8c2, roughness: 0.9 });
  const interiorSkin = new THREE.MeshStandardMaterial({ color: 0xb97858, roughness: 0.92 });
  const interiorGlass = new THREE.MeshStandardMaterial({
    color: 0x385b65,
    emissive: 0x132d34,
    emissiveIntensity: 0.48,
    roughness: 0.2,
    metalness: 0.34,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
    envMap: scene.environment,
  });
  const interiorGlow = new THREE.MeshStandardMaterial({
    color: 0x8f512e,
    emissive: 0xff8e4d,
    emissiveIntensity: 1.15,
    roughness: 0.48,
  });

  // The staged rooms share one generated atlas rather than requesting a
  // texture per room. It is cropped once into six reusable canvas textures so
  // every finish can tile cleanly without sampling a neighboring atlas cell.
  const interiorAtlasPath = interiorMaterialAtlasUrl;
  const interiorTextureMeters = new Map([
    [interiorFloor, 1.55],
    [interiorWall, 2.45],
    [interiorTrim, 1.7],
    [interiorMetal, 1.25],
    [interiorWood, 1.35],
    [interiorAccent, 1.1],
    [interiorRug, 1.45],
    [interiorBlue, 1.05],
    [interiorPaper, 1.25],
  ]);

  const addInteriorBox = (
    parent,
    width,
    height,
    depth,
    material,
    x = 0,
    y = 0,
    z = 0,
    rotationY = 0,
  ) => {
    const mesh = addBox(parent, width, height, depth, material, x, y, z, rotationY);
    const geometry = unitBox.clone();
    const uv = geometry.getAttribute('uv');
    const index = geometry.getIndex();
    const tileMeters = interiorTextureMeters.get(material) ?? 1.25;
    const faceDimensions = [
      [depth, height],
      [depth, height],
      [width, depth],
      [width, depth],
      [width, height],
      [width, height],
    ];

    geometry.groups.forEach((face, faceIndex) => {
      const [faceWidth, faceHeight] = faceDimensions[faceIndex];
      const uRepeat = Math.max(0.12, faceWidth / tileMeters);
      const vRepeat = Math.max(0.12, faceHeight / tileMeters);
      for (let cursor = face.start; cursor < face.start + face.count; cursor += 1) {
        const vertex = index ? index.getX(cursor) : cursor;
        uv.setXY(vertex, uv.getX(vertex) * uRepeat, uv.getY(vertex) * vRepeat);
      }
    });
    uv.needsUpdate = true;
    mesh.geometry = geometry;
    return mesh;
  };

  if (typeof document !== 'undefined') {
    const interiorAtlasLoader = new THREE.TextureLoader();
    interiorAtlasLoader.load(interiorAtlasPath, (atlas) => {
      const source = atlas.image;
      const sourceWidth = source?.naturalWidth ?? source?.videoWidth ?? source?.width ?? 0;
      const sourceHeight = source?.naturalHeight ?? source?.videoHeight ?? source?.height ?? 0;
      const tileWidth = Math.floor(sourceWidth / 3);
      const tileHeight = Math.floor(sourceHeight / 2);
      if (!tileWidth || !tileHeight) return;

      const makeAtlasTile = (column, row) => {
        const canvas = document.createElement('canvas');
        canvas.width = tileWidth;
        canvas.height = tileHeight;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.drawImage(
          source,
          column * tileWidth,
          row * tileHeight,
          tileWidth,
          tileHeight,
          0,
          0,
          tileWidth,
          tileHeight,
        );

        const map = new THREE.CanvasTexture(canvas);
        map.colorSpace = THREE.SRGBColorSpace;
        map.wrapS = THREE.RepeatWrapping;
        map.wrapT = THREE.RepeatWrapping;
        map.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);

        const detailMap = map.clone();
        detailMap.colorSpace = THREE.NoColorSpace;
        detailMap.wrapS = THREE.RepeatWrapping;
        detailMap.wrapT = THREE.RepeatWrapping;
        detailMap.anisotropy = map.anisotropy;
        return { map, detailMap };
      };

      const plaster = makeAtlasTile(0, 0);
      const walnut = makeAtlasTile(1, 0);
      const terrazzo = makeAtlasTile(2, 0);
      const wovenRug = makeAtlasTile(0, 1);
      const gunmetal = makeAtlasTile(1, 1);
      const blueLinen = makeAtlasTile(2, 1);
      const applyInteriorFinish = (material, finish, bumpScale) => {
        material.color.set(0xffffff);
        material.map = finish.map;
        material.roughnessMap = finish.detailMap;
        material.bumpMap = finish.detailMap;
        material.bumpScale = bumpScale;
        material.needsUpdate = true;
      };

      applyInteriorFinish(interiorFloor, terrazzo, 0.07);
      applyInteriorFinish(interiorWall, plaster, 0.045);
      applyInteriorFinish(interiorTrim, walnut, 0.035);
      applyInteriorFinish(interiorMetal, gunmetal, 0.025);
      applyInteriorFinish(interiorWood, walnut, 0.045);
      applyInteriorFinish(interiorAccent, wovenRug, 0.03);
      applyInteriorFinish(interiorRug, wovenRug, 0.025);
      applyInteriorFinish(interiorBlue, blueLinen, 0.02);
      applyInteriorFinish(interiorPaper, plaster, 0.012);
      atlas.dispose();
    });
  }

  const addInteriorLabel = (parent, text, accent = '#f2b56d') => {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 112;
    const context = canvas.getContext('2d');
    context.fillStyle = '#121719';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = accent;
    context.lineWidth = 5;
    context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
    context.fillStyle = '#f4ead6';
    context.font = '600 42px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text.toUpperCase(), canvas.width * 0.5, canvas.height * 0.52);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      // The room labels are architectural plaques, not HUD decals. Let the
      // wall and furniture occlude them so they retain a believable place in
      // the staged room instead of flattening the view.
      depthTest: true,
      depthWrite: false,
    }));
    sprite.position.set(0, 4.15, 4.52);
    sprite.scale.set(4.8, 0.7, 1);
    parent.add(sprite);
  };

  const addInteriorBayView = (parent, variant) => {
    if (typeof document === 'undefined') return;
    const themes = {
      cafe: ['#6987a4', '#e1b29b', '#376f77', '#a44835'],
      market: ['#6d8798', '#dfb997', '#386b70', '#b7583d'],
      loft: ['#5f7894', '#d5a88f', '#315f69', '#9f4636'],
      civic: ['#607d9c', '#e4b69c', '#326b76', '#a34232'],
      coit: ['#71879d', '#dcb59c', '#3e6870', '#a74b36'],
      ferry: ['#5f819e', '#e6b995', '#2e6975', '#a34531'],
    };
    const [skyTop, horizon, water, landmark] = themes[variant] || themes.civic;
    const canvas = document.createElement('canvas');
    canvas.width = 1536;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    const sky = context.createLinearGradient(0, 0, 0, canvas.height);
    sky.addColorStop(0, skyTop);
    sky.addColorStop(0.56, horizon);
    sky.addColorStop(0.57, water);
    sky.addColorStop(1, '#173f4c');
    context.fillStyle = sky;
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.fillStyle = 'rgba(50, 66, 69, 0.52)';
    context.beginPath();
    context.moveTo(0, 290);
    context.lineTo(0, 250);
    context.lineTo(130, 216);
    context.lineTo(285, 246);
    context.lineTo(430, 204);
    context.lineTo(610, 255);
    context.lineTo(760, 224);
    context.lineTo(910, 258);
    context.lineTo(1080, 214);
    context.lineTo(1250, 248);
    context.lineTo(1390, 220);
    context.lineTo(1536, 252);
    context.lineTo(1536, 290);
    context.closePath();
    context.fill();

    context.fillStyle = 'rgba(37, 51, 56, 0.8)';
    [
      [38, 249, 44, 42], [90, 238, 58, 53], [158, 260, 36, 31],
      [850, 245, 48, 46], [906, 225, 62, 66], [978, 252, 40, 39],
      [1320, 236, 52, 55], [1382, 248, 38, 43], [1430, 222, 66, 69],
    ].forEach(([x, y, width, height]) => context.fillRect(x, y, width, height));

    context.strokeStyle = landmark;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = 13;
    const deckY = 285;
    context.beginPath();
    context.moveTo(160, deckY);
    context.lineTo(760, deckY);
    context.stroke();
    for (const towerX of [300, 620]) {
      context.beginPath();
      context.moveTo(towerX - 22, deckY + 22);
      context.lineTo(towerX - 22, 128);
      context.moveTo(towerX + 22, deckY + 22);
      context.lineTo(towerX + 22, 128);
      context.moveTo(towerX - 28, 166);
      context.lineTo(towerX + 28, 166);
      context.moveTo(towerX - 28, 218);
      context.lineTo(towerX + 28, 218);
      context.stroke();
    }
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(120, 248);
    context.quadraticCurveTo(300, 72, 460, 220);
    context.quadraticCurveTo(620, 72, 800, 248);
    context.stroke();
    for (let x = 180; x <= 740; x += 32) {
      const nearestTower = x < 460 ? 300 : 620;
      const distance = Math.min(1, Math.abs(x - nearestTower) / 170);
      const cableY = 105 + distance * distance * 132;
      context.beginPath();
      context.moveTo(x, deckY);
      context.lineTo(x, cableY);
      context.stroke();
    }

    context.fillStyle = '#c9bea6';
    context.fillRect(1084, 217, 205, 72);
    context.fillRect(1153, 116, 66, 173);
    context.fillRect(1168, 84, 36, 42);
    context.fillStyle = '#5d5650';
    context.fillRect(1074, 207, 225, 13);
    context.fillRect(1144, 105, 84, 12);
    context.beginPath();
    context.moveTo(1166, 84);
    context.lineTo(1186, 58);
    context.lineTo(1206, 84);
    context.closePath();
    context.fill();
    context.fillStyle = '#efe4ca';
    context.beginPath();
    context.arc(1186, 156, 20, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#384346';
    context.lineWidth = 4;
    context.stroke();

    context.strokeStyle = 'rgba(215, 231, 226, 0.2)';
    context.lineWidth = 3;
    for (let y = 332; y < 500; y += 34) {
      const offset = (y / 34) % 2 ? 0 : 46;
      for (let x = -40 + offset; x < 1536; x += 150) {
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + 82, y - 5);
        context.stroke();
      }
    }

    const panoramaTexture = new THREE.CanvasTexture(canvas);
    panoramaTexture.colorSpace = THREE.SRGBColorSpace;
    panoramaTexture.anisotropy = Math.min(
      8,
      renderer?.capabilities?.getMaxAnisotropy?.() ?? 1,
    );
    [-3.4, 0, 3.4].forEach((x, paneIndex) => {
      const paneTexture = panoramaTexture.clone();
      paneTexture.repeat.set(1 / 3, 1);
      paneTexture.offset.set(paneIndex / 3, 0);
      paneTexture.needsUpdate = true;
      const view = new THREE.Mesh(
        new THREE.PlaneGeometry(2.2, 1.45),
        new THREE.MeshBasicMaterial({
          map: paneTexture,
          side: THREE.DoubleSide,
          toneMapped: true,
        }),
      );
      view.name = `${variant} interior Bay panorama pane`;
      // Sit just proud of the tinted pane but behind the mullions. This keeps
      // the low-poly view legible under interior exposure while the original
      // glass still supplies the reveal and edge reflections.
      view.position.set(x, 3.03, 4.625);
      view.userData.noShadow = true;
      view.userData.noReceiveShadow = true;
      parent.add(view);
    });
  };

  const addInteriorCityModel = (parent, x = 0, z = 2.48) => {
    const model = new THREE.Group();
    model.name = 'Welcome center tactile Golden Gate model';
    model.position.set(x, 0, z);
    parent.add(model);
    addBox(model, 2.45, 0.1, 0.52, interiorMetal, 0, 1.42, 0);
    for (const towerX of [-0.72, 0.72]) {
      for (const legX of [-0.1, 0.1]) {
        addBox(model, 0.08, 0.92, 0.12, interiorAccent,
          towerX + legX, 1.87, 0);
      }
      addBox(model, 0.3, 0.07, 0.14, interiorAccent, towerX, 1.72, 0);
      addBox(model, 0.3, 0.07, 0.14, interiorAccent, towerX, 2.04, 0);
    }
    const cablePoints = [
      new THREE.Vector3(-1.16, 1.55, -0.07),
      new THREE.Vector3(-0.72, 2.28, -0.07),
      new THREE.Vector3(0, 1.84, -0.07),
      new THREE.Vector3(0.72, 2.28, -0.07),
      new THREE.Vector3(1.16, 1.55, -0.07),
    ];
    for (let index = 0; index < cablePoints.length - 1; index += 1) {
      addRod(model, cablePoints[index], cablePoints[index + 1], 0.018, interiorAccent);
    }
  };

  const addInteriorTable = (parent, x, z, accentMaterial) => {
    addCylinder(parent, 0.68, 0.12, accentMaterial, x, 1.03, z);
    addCylinder(parent, 0.07, 0.88, interiorMetal, x, 0.5, z);
    for (const chairX of [-0.96, 0.96]) {
      addBox(parent, 0.58, 0.1, 0.52, interiorWood, x + chairX, 0.58, z - 0.12);
      addBox(parent, 0.07, 0.48, 0.07, interiorMetal, x + chairX, 0.31, z - 0.12);
      addBox(parent, 0.58, 0.56, 0.08, interiorWood, x + chairX, 0.88, z + 0.12);
    }
  };

  // The interiors use the shared unit box/cylinder geometry already used by
  // the city. These helpers deliberately bias bulk toward the walls, leaving
  // a clear orbit volume through the centre of every staged room.
  const addInteriorWindowBay = (parent, x) => {
    addBox(parent, 2.58, 1.88, 0.12, interiorMetal, x, 3.02, 4.8);
    addBox(parent, 2.22, 1.48, 0.08, interiorGlass, x, 3.03, 4.69);
    addBox(parent, 2.34, 0.16, 0.36, interiorTrim, x, 2.24, 4.52);
    addBox(parent, 2.5, 0.08, 0.13, interiorTrim, x, 3.84, 4.62);
    for (const mullionX of [-0.72, 0, 0.72]) {
      addBox(parent, 0.07, 1.52, 0.13, interiorMetal, x + mullionX, 3.04, 4.61);
    }
  };

  const addInteriorPilaster = (parent, x, z) => {
    addBox(parent, 0.36, 4.56, 0.38, interiorTrim, x, 2.55, z);
    addBox(parent, 0.66, 0.18, 0.64, interiorWood, x, 0.32, z);
    addBox(parent, 0.7, 0.16, 0.7, interiorWood, x, 4.86, z);
    addBox(parent, 0.5, 0.14, 0.5, interiorMetal, x, 4.62, z);
  };

  const addInteriorWallBay = (parent, x, z, width, height, accentMaterial = interiorPaper) => {
    addBox(parent, width, height, 0.07, interiorMetal, x, height * 0.5 + 0.58, z);
    addBox(parent, width - 0.34, height - 0.32, 0.05, accentMaterial,
      x, height * 0.5 + 0.58, z + 0.07);
    addBox(parent, 0.12, height + 0.12, 0.14, interiorTrim, x - width * 0.5, height * 0.5 + 0.58, z + 0.11);
    addBox(parent, 0.12, height + 0.12, 0.14, interiorTrim, x + width * 0.5, height * 0.5 + 0.58, z + 0.11);
    addBox(parent, width + 0.18, 0.12, 0.14, interiorTrim, x, height + 0.64, z + 0.11);
  };

  const addInteriorSettee = (parent, x, z, rotation = 0, upholstery = interiorAccent) => {
    const settee = new THREE.Group();
    settee.position.set(x, 0, z);
    settee.rotation.y = rotation;
    parent.add(settee);
    addBox(settee, 1.72, 0.24, 0.66, interiorWood, 0, 0.48, 0);
    addBox(settee, 1.56, 0.18, 0.55, upholstery, 0, 0.69, -0.04);
    addBox(settee, 1.58, 0.7, 0.14, upholstery, 0, 1.08, 0.24);
    addBox(settee, 0.14, 0.46, 0.64, interiorWood, -0.8, 0.77, 0);
    addBox(settee, 0.14, 0.46, 0.64, interiorWood, 0.8, 0.77, 0);
    for (const legX of [-0.63, 0.63]) {
      for (const legZ of [-0.22, 0.22]) {
        addBox(settee, 0.08, 0.38, 0.08, interiorMetal, legX, 0.24, legZ);
      }
    }
  };

  const addInteriorReceptionDesk = (parent, x, z) => {
    const desk = new THREE.Group();
    desk.position.set(x, 0, z);
    parent.add(desk);
    addBox(desk, 4.72, 1.02, 0.72, interiorWood, 0, 0.72, 0);
    addBox(desk, 4.4, 0.14, 0.92, interiorPaper, 0, 1.28, -0.04);
    addBox(desk, 4.08, 0.5, 0.09, interiorTrim, 0, 0.86, -0.4);
    for (const panelX of [-1.38, 0, 1.38]) {
      addBox(desk, 0.08, 0.52, 0.12, interiorMetal, panelX, 0.86, -0.47);
    }
    for (const lampX of [-1.48, 1.48]) {
      addCylinder(desk, 0.045, 0.34, interiorMetal, lampX, 1.61, 0.12);
      addCylinder(desk, 0.13, 0.08, interiorGlow, lampX, 1.76, 0.12);
    }
  };

  const addInteriorPlanter = (parent, x, z, scale = 1) => {
    addCylinder(parent, 0.28 * scale, 0.48 * scale, interiorWood, x, 0.3 * scale, z);
    const foliage = new THREE.Mesh(lowPolySphere, materials.foliageSun);
    foliage.position.set(x, 0.86 * scale, z);
    foliage.scale.set(0.48 * scale, 0.68 * scale, 0.48 * scale);
    parent.add(foliage);
  };

  const addInteriorSconce = (parent, x, z) => {
    addBox(parent, 0.22, 0.48, 0.12, interiorMetal, x, 2.86, z);
    addCylinder(parent, 0.13, 0.16, interiorGlow, x, 2.74, z - 0.1);
  };

  const addInteriorPlaque = (parent, text, x, y, z, scale = 1) => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    context.fillStyle = '#172023';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#e7aa62';
    context.lineWidth = 5;
    context.strokeRect(7, 7, canvas.width - 14, canvas.height - 14);
    context.fillStyle = '#f5ead5';
    context.font = '700 34px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width * 0.5, canvas.height * 0.53);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const plaque = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    }));
    plaque.position.set(x, y, z);
    plaque.scale.set(2.6 * scale, 0.49 * scale, 1);
    plaque.userData.noShadow = true;
    plaque.userData.noReceiveShadow = true;
    parent.add(plaque);
    return plaque;
  };

  const addInteriorPerson = (
    parent,
    {
      name,
      x,
      z,
      rotation = 0,
      seated = false,
      outfit = interiorBlue,
    },
  ) => {
    const person = new THREE.Group();
    person.name = name;
    person.position.set(x, 0, z);
    person.rotation.y = rotation;
    parent.add(person);

    const hipY = seated ? 0.78 : 1.0;
    addBox(person, 0.5, 0.72, 0.3, outfit, 0, hipY + 0.42, 0);
    addBox(person, 0.42, 0.26, 0.28, interiorTrim, 0, hipY + 0.02, 0);
    for (const side of [-1, 1]) {
      addBox(
        person,
        0.14,
        seated ? 0.5 : 0.78,
        0.14,
        interiorMetal,
        side * 0.14,
        seated ? 0.48 : 0.46,
        seated ? -0.2 : 0,
        seated ? Math.PI * 0.5 : 0,
      );
      addBox(person, 0.13, 0.64, 0.13, outfit, side * 0.34, hipY + 0.38, -0.02);
    }
    const head = new THREE.Mesh(lowPolySphere, interiorSkin);
    head.position.set(0, hipY + 1.05, 0);
    head.scale.set(0.25, 0.3, 0.24);
    person.add(head);
    const hair = new THREE.Mesh(lowPolySphere, interiorMetal);
    hair.position.set(0, hipY + 1.19, 0.015);
    hair.scale.set(0.255, 0.17, 0.245);
    person.add(hair);
    return person;
  };

  const interiorLabelByVariant = Object.freeze({
    cafe: 'Pacific Cafe',
    market: 'Mission Market',
    loft: 'Edwardian Loft',
    civic: 'Embarcadero Welcome Center',
    coit: 'Coit Tower Museum',
    ferry: 'Ferry Market Hall',
  });

  // Variant dressing is additive to the shared shell: every prop stays out
  // of the protected center orbit volume (see userData.cameraClearance), so
  // no interior gains collision work and the entry pose stays identical.
  const addInteriorBookStack = (parent, x, y, z, count = 3) => {
    const covers = [interiorAccent, interiorBlue, interiorPaper];
    for (let book = 0; book < count; book += 1) {
      addBox(
        parent,
        0.34 - book * 0.03,
        0.05,
        0.24,
        covers[book % covers.length],
        x,
        y + 0.03 + book * 0.055,
        z,
        (book % 2 ? -1 : 1) * 0.16,
      );
    }
  };
  const addInteriorShelfRow = (parent, x, z, width, goodsMaterial) => {
    addBox(parent, width, 1.7, 0.42, interiorWood, x, 1.15, z);
    for (const shelfY of [0.62, 1.18, 1.74]) {
      addBox(parent, width + 0.1, 0.06, 0.5, interiorTrim, x, shelfY, z);
      const tinCount = Math.max(2, Math.round(width / 0.5));
      for (let tin = 0; tin < tinCount; tin += 1) {
        const tinX = x - width * 0.5 + 0.3 + tin * ((width - 0.6) / Math.max(1, tinCount - 1));
        addBox(parent, 0.18, 0.26, 0.2,
          tin % 3 === 0 ? interiorAccent : goodsMaterial, tinX, shelfY + 0.17, z);
      }
    }
  };
  const addInteriorCoatRack = (parent, x, z) => {
    addCylinder(parent, 0.05, 1.72, interiorMetal, x, 0.92, z);
    addCylinder(parent, 0.24, 0.05, interiorMetal, x, 0.05, z);
    for (let peg = 0; peg < 4; peg += 1) {
      const angle = peg * Math.PI * 0.5;
      addBox(parent, 0.3, 0.045, 0.045, interiorWood,
        x + Math.cos(angle) * 0.16, 1.7, z + Math.sin(angle) * 0.16, -angle);
    }
    addBox(parent, 0.26, 0.52, 0.14, interiorAccent, x + 0.18, 1.38, z, 0.32);
  };
  const addInteriorInstrumentCase = (parent, x, z, rotationY = 0) => {
    addBox(parent, 0.42, 0.94, 0.2, interiorTrim, x, 0.55, z, rotationY);
    addBox(parent, 0.44, 0.08, 0.22, interiorMetal, x, 0.94, z, rotationY);
    addBox(parent, 0.44, 0.08, 0.22, interiorMetal, x, 0.2, z, rotationY);
    addBox(parent, 0.1, 0.06, 0.24, interiorAccent, x, 0.6, z, rotationY);
  };
  const addInteriorFramedPrint = (parent, x, y, z, width, height, artMaterial = interiorAccent) => {
    addBox(parent, width, height, 0.06, interiorTrim, x, y, z);
    addBox(parent, width - 0.14, height - 0.14, 0.04, interiorPaper, x, y, z + 0.02);
    addBox(parent, width * 0.42, height * 0.34, 0.03, artMaterial, x, y + height * 0.06, z + 0.045);
    addBox(parent, width * 0.2, height * 0.18, 0.03, interiorBlue,
      x - width * 0.18, y - height * 0.18, z + 0.05);
  };
  const addInteriorBed = (parent, x, z, rotationY = 0) => {
    addBox(parent, 1.5, 0.34, 2.1, interiorWood, x, 0.3, z, rotationY);
    addBox(parent, 1.38, 0.18, 1.9, interiorPaper, x, 0.55, z, rotationY);
    addBox(parent, 1.4, 0.1, 1.06, interiorBlue, x, 0.63, z - 0.42, rotationY);
    addBox(parent, 0.52, 0.12, 0.34, interiorPaper, x, 0.66, z + 0.74, rotationY);
    addBox(parent, 1.5, 0.82, 0.12, interiorWood, x, 0.72, z + 1.08, rotationY);
  };
  const addInteriorRadiator = (parent, x, z, rotationY = 0) => {
    for (let fin = 0; fin < 6; fin += 1) {
      addBox(parent, 0.09, 0.62, 0.3, interiorMetal, x - 0.4 + fin * 0.16, 0.42, z, rotationY);
    }
    addBox(parent, 1.04, 0.06, 0.34, interiorMetal, x, 0.76, z, rotationY);
  };
  const addInteriorRopeCoil = (parent, x, z, scale = 1) => {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.3 * scale, 0.09 * scale, 6, 14), interiorRug);
    coil.rotation.x = Math.PI * 0.5;
    coil.position.set(x, 0.1 * scale, z);
    parent.add(coil);
    addCylinder(parent, 0.05 * scale, 0.34 * scale, interiorRug,
      x + 0.3 * scale, 0.1 * scale, z + 0.24 * scale);
  };
  const addInteriorTicketKiosk = (parent, x, z) => {
    addBox(parent, 0.92, 1.9, 0.66, interiorWood, x, 1.06, z);
    addBox(parent, 0.66, 0.56, 0.05, interiorGlass, x, 1.52, z + 0.33);
    addBox(parent, 0.98, 0.1, 0.74, interiorTrim, x, 2.06, z);
    addBox(parent, 0.72, 0.16, 0.04, interiorGlow, x, 1.14, z + 0.34);
  };
  // A shallow service nook adds a second readable volume to the smaller
  // staged rooms without touching the flagship annex or expanding the orbit
  // envelope: it tucks against the south wall behind the -4.35 camera limit.
  const addInteriorServiceNook = (parent, kind, accent = interiorAccent) => {
    const centerX = 3.4;
    addInteriorBox(parent, 3.6, 0.14, 0.9, interiorFloor, centerX, 0.07, -4.4);
    addBox(parent, 0.14, 2.5, 0.9, interiorTrim, centerX - 1.86, 1.28, -4.4);
    addBox(parent, 0.14, 2.5, 0.9, interiorTrim, centerX + 1.86, 1.28, -4.4);
    addBox(parent, 3.86, 0.14, 0.9, interiorTrim, centerX, 2.58, -4.4);
    if (kind === 'kitchen') {
      addBox(parent, 2.4, 0.86, 0.62, interiorWood, centerX, 0.55, -4.55);
      addBox(parent, 2.56, 0.1, 0.68, interiorMetal, centerX, 1.03, -4.55);
      addBox(parent, 1.6, 0.5, 0.08, interiorMetal, centerX - 0.3, 1.9, -4.78);
      addCylinder(parent, 0.16, 0.24, interiorMetal, centerX + 0.7, 1.2, -4.5);
      addCylinder(parent, 0.1, 0.18, interiorAccent, centerX + 0.35, 1.17, -4.62);
      addBox(parent, 0.7, 0.42, 0.06, interiorGlow, centerX - 0.6, 1.62, -4.79);
    } else if (kind === 'stock') {
      addBox(parent, 1.9, 0.14, 0.66, interiorTrim, centerX, 0.5, -4.55);
      addBox(parent, 1.9, 0.14, 0.66, interiorTrim, centerX, 1.3, -4.55);
      for (const crateX of [centerX - 1.1, centerX - 0.35, centerX + 0.45, centerX + 1.2]) {
        addBox(parent, 0.6, 0.5, 0.6, interiorWood, crateX, 0.32, -4.5);
      }
      addBox(parent, 0.5, 0.34, 0.5, accent, centerX + 0.4, 1.6, -4.55);
      addBox(parent, 0.44, 0.3, 0.44, interiorBlue, centerX - 0.4, 1.58, -4.55);
    } else if (kind === 'gallery') {
      addBox(parent, 0.9, 0.82, 0.5, interiorPaper, centerX - 0.8, 0.45, -4.5);
      addBox(parent, 0.5, 0.4, 0.34, accent, centerX - 0.8, 1.08, -4.5);
      addBox(parent, 1.3, 0.08, 0.4, interiorWood, centerX + 0.7, 1.1, -4.6);
      addBox(parent, 0.9, 0.6, 0.05, interiorPaper, centerX + 0.7, 1.66, -4.79);
      addBox(parent, 0.5, 0.34, 0.04, interiorBlue, centerX + 0.7, 1.68, -4.76);
    } else if (kind === 'laundry') {
      addCylinder(parent, 0.34, 0.5, interiorPaper, centerX - 0.9, 0.32, -4.5);
      addCylinder(parent, 0.3, 0.42, interiorBlue, centerX - 0.2, 0.27, -4.58);
      addBox(parent, 1.1, 0.5, 0.5, interiorWood, centerX + 0.8, 0.3, -4.5);
      addInteriorBookStack(parent, centerX + 0.8, 0.56, -4.5, 2);
    } else if (kind === 'gear') {
      addBox(parent, 1.6, 0.9, 0.5, interiorWood, centerX - 0.6, 0.5, -4.55);
      addBox(parent, 1.7, 0.1, 0.56, interiorTrim, centerX - 0.6, 1.0, -4.55);
      addInteriorRopeCoil(parent, centerX + 1.0, -4.5, 0.9);
      addCylinder(parent, 0.14, 0.34, interiorMetal, centerX + 0.35, 0.22, -4.42);
      addBox(parent, 0.46, 0.3, 0.04, interiorGlow, centerX - 0.6, 1.3, -4.78);
    } else {
      // 'office'
      addBox(parent, 1.5, 0.76, 0.6, interiorWood, centerX, 0.46, -4.55);
      addBox(parent, 0.5, 0.34, 0.04, interiorGlow, centerX - 0.2, 1.06, -4.62);
      addInteriorBookStack(parent, centerX + 0.45, 0.84, -4.5, 3);
      addBox(parent, 0.8, 0.5, 0.05, interiorPaper, centerX + 0.9, 1.7, -4.79);
    }
  };

  const createInteriorRoom = (variant, index) => {
    const room = new THREE.Group();
    room.name = `Enterable interior / ${variant}`;
    room.position.set(300 + index * 16, 0, 12);
    room.userData.interiorVariant = variant;
    room.userData.interiorLabel = interiorLabelByVariant[variant];
    room.userData.cameraClearance = Object.freeze({
      x: 5.05,
      z: 4.35,
      notes: 'Furniture is kept outside the shared interior orbit volume.',
    });

    addInteriorBox(room, 12, 0.18, 10, interiorFloor, 0, 0, 0);
    addInteriorBox(room, 12, 5.5, 0.18, interiorWall, 0, 2.75, 5);
    addInteriorBox(room, 0.18, 5.5, 10, interiorWall, -6, 2.75, 0);
    if (variant === 'civic') {
      // The flagship room alone breaks the shared side wall into a real
      // doorway. Its compact annex remains outside the player orbit volume,
      // so opening it reads as a spatial reveal without expanding collision.
      addInteriorBox(room, 0.18, 5.5, 1.8, interiorWall, 6, 2.75, -4.1);
      addInteriorBox(room, 0.18, 5.5, 6.6, interiorWall, 6, 2.75, 1.7);
      addInteriorBox(room, 0.18, 2.85, 1.6, interiorWall, 6, 4.08, -2.4);
    } else {
      addInteriorBox(room, 0.18, 5.5, 10, interiorWall, 6, 2.75, 0);
    }
    addInteriorBox(room, 12, 0.16, 10, interiorTrim, 0, 5.35, 0);
    addInteriorBox(room, 12, 0.12, 0.22, interiorTrim, 0, 0.16, 4.86);

    // Shared architectural shell: deep window reveals, a low wainscot, and
    // a side-to-side ceiling rhythm make the six small staged rooms read as
    // real volumes before their variant props are added.
    for (const windowX of [-3.4, 0, 3.4]) {
      addInteriorWindowBay(room, windowX);
    }
    addInteriorBayView(room, variant);
    addBox(room, 11.1, 0.88, 0.12, interiorTrim, 0, 0.62, 4.8);
    addBox(room, 11.24, 0.12, 0.26, interiorWood, 0, 1.08, 4.66);
    addBox(room, 0.12, 0.88, 9.16, interiorTrim, -5.82, 0.62, 0);
    if (variant === 'civic') {
      addBox(room, 0.12, 0.88, 1.45, interiorTrim, 5.82, 0.62, -4.02);
      addBox(room, 0.12, 0.88, 6.05, interiorTrim, 5.82, 0.62, 1.68);
    } else {
      addBox(room, 0.12, 0.88, 9.16, interiorTrim, 5.82, 0.62, 0);
    }
    addBox(room, 10.94, 0.88, 0.12, interiorTrim, 0, 0.62, -4.8);
    addBox(room, 11.08, 0.12, 0.26, interiorWood, 0, 1.08, -4.66);
    for (const pilasterZ of [-3.35, 0, 3.35]) {
      addInteriorPilaster(room, -5.56, pilasterZ);
      addInteriorPilaster(room, 5.56, pilasterZ);
    }
    for (const beamZ of [-3.25, 0, 3.25]) {
      addBox(room, 10.72, 0.14, 0.16, interiorTrim, 0, 5.18, beamZ);
    }
    for (const beamX of [-3.45, 0, 3.45]) {
      addBox(room, 0.16, 0.14, 8.58, interiorTrim, beamX, 5.18, 0);
    }
    for (const bayX of [-3.75, 0, 3.75]) {
      addInteriorWallBay(room, bayX, -4.84, 2.62, 2.72, interiorPaper);
    }

    // A threshold runner and a small address plaque make the six staged
    // rooms read as different destinations before the larger prop clusters
    // come into view. The shared orbit clearance remains unchanged.
    const thresholdMaterials = {
      cafe: interiorAccent,
      market: interiorBlue,
      loft: interiorWood,
      civic: interiorBlue,
      coit: interiorAccent,
      ferry: interiorRug,
    };
    const thresholdLabels = {
      cafe: 'NORTH BEACH · COFFEE',
      market: 'MISSION · PROVISIONS',
      loft: 'WESTERN ADDITION · HOME',
      civic: 'EMBARCADERO · INFORMATION',
      coit: 'TELEGRAPH HILL · MUSEUM',
      ferry: 'PIER 1 · SAILINGS',
    };
    addInteriorBox(
      room,
      2.18,
      0.035,
      2.12,
      thresholdMaterials[variant] || interiorRug,
      0,
      0.15,
      3.05,
    );
    addInteriorPlaque(room, thresholdLabels[variant] || 'SAN FRANCISCO · PUBLIC ROOM',
      0, 1.42, 4.68, 0.58);

    const light = new THREE.PointLight(0xffad71, 19, 17, 2);
    light.position.set(0, 4.42, 0.25);
    room.add(light);
    const pendant = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 6), interiorGlow);
    pendant.position.set(0, 4.06, 0.25);
    room.add(pendant);
    const fillLight = new THREE.PointLight(0x5e89a0, 7, 13, 2);
    fillLight.position.set(-3.8, 2.85, 4.18);
    room.add(fillLight);
    for (const lampX of [-3.4, 3.4]) {
      addCylinder(room, 0.028, 0.56, interiorMetal, lampX, 4.42, 0.25);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 6), interiorGlow);
      lamp.position.set(lampX, 4.08, 0.25);
      room.add(lamp);
    }
    for (const sconceZ of [-2.05, 2.05]) {
      addInteriorSconce(room, -5.62, sconceZ);
      addInteriorSconce(room, 5.62, sconceZ);
    }
    addInteriorBox(room, 5.15, 0.035, 3.05, interiorRug, 0, 0.12, -0.42);

    if (variant === 'cafe') {
      addInteriorLabel(room, 'Pacific Cafe', '#f2b56d');
      addBox(room, 7.25, 1.04, 0.68, interiorWood, 0, 0.72, 3.0);
      addBox(room, 6.9, 0.14, 0.84, interiorPaper, 0, 1.3, 2.9);
      addBox(room, 6.58, 0.44, 0.1, interiorTrim, 0, 0.88, 2.6);
      for (const machineX of [-2.5, 0, 2.5]) {
        addBox(room, 0.62, 0.72, 0.5, interiorMetal, machineX, 1.82, 3.24);
        addCylinder(room, 0.12, 0.06, interiorGlow, machineX, 2.15, 3.0);
      }
      for (const stoolX of [-3.9, -2.6, 2.6, 3.9]) {
        addCylinder(room, 0.22, 0.42, interiorAccent, stoolX, 0.43, 2.25);
        addCylinder(room, 0.06, 0.22, interiorMetal, stoolX, 0.15, 2.25);
      }
      addInteriorTable(room, -2.35, -1.65, interiorAccent);
      addInteriorTable(room, 2.35, -1.65, interiorAccent);
      addInteriorSettee(room, -3.95, 0.45, Math.PI * 0.5, interiorBlue);
      addInteriorSettee(room, 3.95, 0.45, -Math.PI * 0.5, interiorBlue);
      addInteriorPlanter(room, -4.45, -3.2, 0.82);
      addInteriorPlanter(room, 4.45, -3.2, 0.82);
      // Back-wall service bay: an espresso work line and pastry case read as
      // the working secondary space behind the front counter.
      addBox(room, 3.7, 0.94, 0.52, interiorWood, 0, 0.56, -4.42);
      addBox(room, 3.44, 0.12, 0.62, interiorTrim, 0, 1.09, -4.42);
      addBox(room, 0.56, 0.62, 0.4, interiorMetal, -0.92, 1.45, -4.42);
      addCylinder(room, 0.09, 0.05, interiorGlow, -0.92, 1.79, -4.28);
      addBox(room, 1.14, 0.56, 0.46, interiorGlass, 1.05, 1.41, -4.4);
      addBox(room, 0.94, 0.09, 0.34, interiorGlow, 1.05, 1.68, -4.4);
      for (const mugX of [-1.62, -1.38, 1.82]) {
        addCylinder(room, 0.055, 0.11, interiorAccent, mugX, 1.19, -4.42);
      }
      addBox(room, 1.9, 1.08, 0.07, interiorPaper, -3.3, 2.35, -4.72);
      for (const menuY of [2.08, 2.35, 2.62]) {
        addBox(room, 1.5, 0.055, 0.05, interiorTrim, -3.3, menuY, -4.66);
      }
      addInteriorPlaque(room, 'SERVICE · ESPRESSO BAR', 0, 3.3, -4.58, 0.58);
      addInteriorPlaque(room, 'MENU', -3.3, 3.14, -4.62, 0.5);
      // North Beach cafe cues: a book shelf, coat rack and cased instrument
      // keep the front room lived-in between the service bay and tables.
      addInteriorShelfRow(room, 5.3, -1.35, 1.24, interiorPaper);
      addInteriorBookStack(room, -3.95, 1.0, 0.42, 3);
      addInteriorCoatRack(room, 5.25, 3.7);
      addInteriorInstrumentCase(room, -5.3, 3.4, 0.28);
    } else if (variant === 'market') {
      addInteriorLabel(room, 'Mission Market', '#6bd6c5');
      for (const shelfX of [-3.35, 3.35]) {
        addBox(room, 1.48, 2.7, 0.56, interiorWood, shelfX, 1.42, 0.74);
        for (const shelfY of [0.6, 1.45, 2.3]) {
          addBox(room, 1.68, 0.08, 0.68, interiorTrim, shelfX, shelfY, 0.4);
          addBox(room, 1.1, 0.22, 0.18, interiorGlow, shelfX, shelfY + 0.17, 0.31);
          addBox(room, 0.22, 0.3, 0.22, shelfX < 0 ? interiorAccent : interiorBlue,
            shelfX - 0.34, shelfY + 0.18, 0.31);
        }
      }
      addBox(room, 5.4, 0.92, 0.7, interiorWood, 0, 0.72, 2.95);
      addBox(room, 5.0, 0.14, 0.82, interiorPaper, 0, 1.24, 2.84);
      for (const crateX of [-4.1, -3.18, 3.18, 4.1]) {
        addBox(room, 0.64, 0.44, 0.64, interiorAccent, crateX, 0.32, -2.85);
        addBox(room, 0.38, 0.28, 0.38, interiorGlow, crateX, 0.68, -2.85);
      }
      addInteriorPlanter(room, -4.35, 3.15, 0.76);
      addInteriorPlanter(room, 4.35, 3.15, 0.76);
      // Back-wall stock bay: delivery crates, a hand truck and a stock door
      // give the storefront a believable working secondary space.
      addBox(room, 1.86, 2.42, 0.14, interiorMetal, -4.28, 1.36, -4.78);
      addBox(room, 1.62, 2.16, 0.1, interiorWood, -4.28, 1.24, -4.7);
      addBox(room, 0.07, 0.34, 0.09, interiorMetal, -3.62, 1.28, -4.62);
      for (const crateZ of [-3.62, -2.72]) {
        addBox(room, 0.78, 0.66, 0.78, interiorWood, -2.2, 0.45, crateZ);
        addBox(room, 0.58, 0.12, 0.58, interiorGlow, -2.2, 0.83, crateZ);
      }
      addBox(room, 0.72, 0.5, 0.72, interiorWood, -2.2, 1.02, -3.62);
      for (const wheelZ of [-3.3, -2.86]) {
        addCylinder(room, 0.14, 0.08, interiorMetal, -4.78, 0.16, wheelZ);
      }
      addBox(room, 0.1, 1.7, 0.1, interiorMetal, -4.62, 0.98, -3.08);
      addBox(room, 0.4, 0.08, 0.62, interiorMetal, -4.68, 0.32, -3.08);
      addBox(room, 1.52, 1.02, 0.07, interiorPaper, 2.55, 2.28, -4.72);
      for (const priceY of [2.02, 2.28, 2.54]) {
        addBox(room, 1.16, 0.055, 0.05, interiorAccent, 2.55, priceY, -4.66);
      }
      addInteriorPlaque(room, 'STOCK ROOM · DELIVERIES', -4.28, 3.28, -4.58, 0.56);
      addInteriorPlaque(room, 'TODAY · MARKET LIST', 2.55, 3.08, -4.62, 0.5);
    } else if (variant === 'civic') {
      addInteriorLabel(room, 'Embarcadero Welcome Center', '#b8c6d2');
      // Recessed elevators sit in the far wall while the desk is held well
      // inside the front window line, leaving a legible arrival axis and a
      // clear camera path around either side.
      for (const elevatorX of [-2.8, 0, 2.8]) {
        addInteriorWallBay(room, elevatorX, -4.84, 2.18, 2.98, interiorMetal);
        addBox(room, 1.32, 2.26, 0.06, interiorGlass, elevatorX, 1.74, -4.7);
        addBox(room, 0.07, 2.3, 0.12, interiorTrim, elevatorX, 1.74, -4.61);
        addBox(room, 1.58, 0.13, 0.22, interiorWood, elevatorX, 3.02, -4.59);
        addBox(room, 0.5, 0.08, 0.12, interiorGlow, elevatorX, 2.82, -4.55);
      }
      addInteriorReceptionDesk(room, 0, 2.55);
      const staff = addInteriorPerson(room, {
        name: 'Mara / welcome center staff',
        x: 0.72,
        z: 3.22,
        rotation: Math.PI,
        outfit: interiorBlue,
      });
      addBox(staff, 0.08, 0.4, 0.03, interiorGlow, 0, 1.5, -0.17);
      addBox(room, 0.72, 0.5, 0.12, interiorMetal, -0.72, 1.64, 2.72);
      addBox(room, 0.58, 0.36, 0.04, interiorGlass, -0.72, 1.65, 2.64);
      addCylinder(room, 0.1, 0.18, interiorAccent, 1.62, 1.48, 2.78);
      // Small desk clutter and a second standing visitor give the flagship
      // room a service rhythm without introducing another animated system.
      addBox(room, 0.36, 0.16, 0.24, interiorPaper, -1.5, 1.43, 2.46);
      addBox(room, 0.28, 0.22, 0.18, interiorAccent, -1.12, 1.47, 2.54);
      addInteriorPlaque(room, 'VISITOR INFO', -1.55, 1.78, 2.46, 0.48);
      const archiveVisitor = addInteriorPerson(room, {
        name: 'Ambient visitor / archive browse',
        x: 3.18,
        z: -1.72,
        rotation: -Math.PI * 0.5,
        outfit: interiorAccent,
      });
      addBox(archiveVisitor, 0.38, 0.46, 0.08, interiorPaper, 0, 1.34, -0.22);

      addInteriorCityModel(room, -3.6, -2.25);
      const routeMarker = addBox(
        room,
        0.58,
        0.055,
        0.14,
        interiorGlow,
        -3.6,
        2.18,
        -2.31,
      );
      routeMarker.visible = false;
      addInteriorBox(room, 4.15, 0.035, 1.12, interiorRug, 0, 0.14, 1.24);
      addInteriorSettee(room, -3.7, 0.2, Math.PI * 0.5, interiorBlue);
      addInteriorSettee(room, 3.7, 0.2, -Math.PI * 0.5, interiorBlue);
      const customer = addInteriorPerson(room, {
        name: 'Ambient visitor / reading',
        x: -3.7,
        z: 0.2,
        rotation: Math.PI * 0.5,
        seated: true,
        outfit: interiorAccent,
      });
      addBox(customer, 0.54, 0.025, 0.38, interiorPaper, 0, 1.23, -0.34, -0.18);
      for (const mailZ of [-1.9, -1.08, 1.08, 1.9]) {
        const side = mailZ < 0 ? -1 : 1;
        addBox(room, 0.13, 0.48, 0.62, interiorMetal, side * 5.57, 1.28, mailZ);
        addBox(room, 0.08, 0.08, 0.32, interiorAccent, side * 5.47, 1.34, mailZ);
      }
      addInteriorPlanter(room, -4.35, -3.28, 0.9);
      addInteriorPlanter(room, 4.35, -3.28, 0.9);

      // The middle glazed bay remains aligned with the exterior featured
      // doorway. The panorama behind it supplies immediate street continuity.
      addBox(room, 2.58, 0.12, 0.3, interiorTrim, 0, 1.11, 4.46);
      addBox(room, 0.11, 2.55, 0.18, interiorTrim, 0, 2.38, 4.48);
      for (const doorX of [-0.62, 0.62]) {
        addBox(room, 1.08, 2.48, 0.075, interiorGlass, doorX, 2.36, 4.46);
        addCylinder(room, 0.035, 0.42, interiorGlow, doorX * 0.32, 2.26, 4.36);
      }
      addInteriorBox(room, 2.5, 0.035, 1.28, interiorRug, 0, 0.13, 3.85);
      addInteriorPlaque(room, 'STREET / EMBARCADERO', 0, 3.82, 4.34, 0.82);

      // A narrow working map archive gives the flagship a second volume.
      // It is fully authored at load and revealed with visibility toggles,
      // avoiding runtime allocation or animated geometry.
      addInteriorBox(room, 3.2, 0.18, 4, interiorFloor, 7.55, 0, -2.4);
      addInteriorBox(room, 0.18, 4.6, 4, interiorWall, 9.15, 2.3, -2.4);
      addInteriorBox(room, 3.2, 4.6, 0.18, interiorWall, 7.55, 2.3, -4.4);
      addInteriorBox(room, 3.2, 4.6, 0.18, interiorWall, 7.55, 2.3, -0.4);
      addInteriorBox(room, 3.2, 0.14, 4, interiorTrim, 7.55, 4.52, -2.4);
      for (const shelfZ of [-3.55, -2.45, -1.35]) {
        addBox(room, 0.62, 2.6, 0.72, interiorWood, 8.68, 1.36, shelfZ);
        for (const shelfY of [0.55, 1.25, 1.95, 2.65]) {
          addBox(room, 0.72, 0.08, 0.82, interiorTrim, 8.66, shelfY, shelfZ);
        }
      }
      addBox(room, 1.46, 0.82, 0.64, interiorWood, 7.05, 0.52, -2.38);
      addBox(room, 1.22, 0.08, 0.5, interiorPaper, 7.05, 0.97, -2.38);
      const archiveLight = new THREE.PointLight(0xff9f5f, 8, 7, 2);
      archiveLight.position.set(7.35, 3.35, -2.35);
      archiveLight.castShadow = false;
      room.add(archiveLight);
      const archiveClosedDoor = addBox(
        room,
        0.12,
        2.65,
        1.48,
        interiorTrim,
        5.9,
        1.42,
        -2.4,
      );
      const archiveOpenDoor = addBox(
        room,
        1.46,
        2.65,
        0.12,
        interiorTrim,
        6.68,
        1.42,
        -3.08,
      );
      archiveOpenDoor.visible = false;
      addInteriorPlaque(room, 'INFO / E', 0, 1.0, 2.14, 0.62);
      addInteriorPlaque(room, 'BAY MODEL / E', -3.6, 1.14, -2.08, 0.62);
      addInteriorPlaque(room, 'MAP ARCHIVE / E', 5.78, 3.2, -2.4, 0.66);
      room.userData.flagshipVisuals = {
        archiveClosedDoor,
        archiveOpenDoor,
        routeMarker,
      };
      room.userData.entranceContinuity = 'Glazed doors retain the exterior Embarcadero panorama.';
    } else if (variant === 'coit') {
      addInteriorLabel(room, 'Coit Tower Museum', '#e6a46d');
      addCylinder(room, 2.72, 0.16, interiorTrim, 0, 0.22, 0.35);
      const viewingRing = new THREE.Mesh(
        new THREE.TorusGeometry(3.45, 0.055, 8, 40),
        interiorMetal,
      );
      viewingRing.rotation.x = Math.PI * 0.5;
      viewingRing.position.y = 2.1;
      room.add(viewingRing);
      for (let segment = 0; segment < 12; segment += 1) {
        const angle = (segment / 12) * Math.PI * 2;
        addCylinder(
          room,
          0.055,
          1.86,
          interiorMetal,
          Math.cos(angle) * 3.45,
          1.12,
          Math.sin(angle) * 3.45,
        );
      }
      addBox(room, 2.2, 0.82, 1.38, interiorWood, 0, 0.54, 0.35);
      addBox(room, 1.86, 0.1, 1.04, interiorPaper, 0, 1, 0.35);
      for (const displayX of [-3.95, 3.95]) {
        addBox(room, 0.76, 1.08, 0.76, interiorWood, displayX, 0.62, -2.45);
        addBox(room, 0.48, 0.12, 0.48, interiorGlow, displayX, 1.2, -2.45);
      }
      addInteriorSettee(room, -3.85, 1.75, Math.PI * 0.5, interiorBlue);
      addInteriorSettee(room, 3.85, 1.75, -Math.PI * 0.5, interiorBlue);
      // Mural gallery: WPA-style study panels and framed city views turn the
      // back wall into a second exhibit space behind the viewing ring.
      for (const muralX of [-3.4, 0, 3.4]) {
        addBox(room, 2.42, 1.74, 0.08, interiorTrim, muralX, 2.32, -4.72);
        addBox(room, 2.16, 1.48, 0.05, interiorPaper, muralX, 2.32, -4.66);
        addBox(room, 0.94, 1.02, 0.04, interiorAccent, muralX - 0.44, 2.22, -4.62);
        addBox(room, 0.62, 0.68, 0.04, interiorBlue, muralX + 0.58, 2.42, -4.62);
        addBox(room, 0.38, 0.05, 0.1, interiorGlow, muralX, 3.32, -4.6);
      }
      addInteriorPlaque(room, 'MURAL GALLERY · 1934 STUDIES', 0, 3.66, -4.58, 0.62);
      // Visitor-services corner: ticket kiosk, brochure rack and a queue
      // rail make the observatory read as a staffed public landmark.
      addInteriorTicketKiosk(room, -5.1, -3.4);
      addBox(room, 0.62, 1.06, 0.24, interiorWood, 5.3, 0.62, -3.4);
      for (const brochureY of [0.5, 0.78, 1.06]) {
        addBox(room, 0.5, 0.06, 0.2, interiorPaper, 5.3, brochureY, -3.32);
      }
      for (const postZ of [-1.1, -0.1]) {
        addCylinder(room, 0.05, 0.92, interiorMetal, -4.7, 0.46, postZ);
      }
      addRod(room,
        new THREE.Vector3(-4.7, 0.86, -1.1),
        new THREE.Vector3(-4.7, 0.86, -0.1),
        0.028,
        interiorAccent);
      addInteriorPlaque(room, 'TICKETS · OBSERVATION', -5.1, 2.4, -3.32, 0.5);
    } else if (variant === 'ferry') {
      addInteriorLabel(room, 'Ferry Market Hall', '#6bd6c5');
      addBox(room, 8.8, 0.9, 0.66, interiorWood, 0, 0.7, 2.9);
      addBox(room, 8.35, 0.13, 0.8, interiorTrim, 0, 1.2, 2.8);
      for (const stallX of [-3.7, -1.25, 1.25, 3.7]) {
        addBox(room, 1.36, 0.72, 0.86, interiorAccent, stallX, 1.65, 3.26);
        addBox(room, 1.52, 0.08, 1.02, interiorPaper, stallX, 2.04, 3.1);
        addCylinder(room, 0.13, 0.26, interiorGlow, stallX - 0.35, 2.26, 3.08);
        addCylinder(room, 0.13, 0.26, interiorGlow, stallX + 0.35, 2.26, 3.08);
      }
      for (const crateX of [-4.25, 4.25]) {
        addBox(room, 0.82, 0.72, 0.82, interiorWood, crateX, 0.48, -2.35);
        addBox(room, 0.62, 0.1, 0.62, interiorGlow, crateX, 0.88, -2.35);
      }
      for (const lampX of [-3.1, 0, 3.1]) {
        addCylinder(room, 0.035, 0.62, interiorMetal, lampX, 4.24, 0.1);
        addCylinder(room, 0.2, 0.08, interiorGlow, lampX, 3.9, 0.1);
      }
      addInteriorPlanter(room, -4.35, 0.2, 0.78);
      addInteriorPlanter(room, 4.35, 0.2, 0.78);
      // Freight-loading bay: stacked produce crates, a hand truck and a
      // roll-up door hint at the working pier behind the market hall.
      addBox(room, 2.2, 2.56, 0.12, interiorMetal, -2.1, 1.42, -4.76);
      for (const doorBandY of [0.62, 1.12, 1.62, 2.12, 2.62]) {
        addBox(room, 2.02, 0.06, 0.08, interiorTrim, -2.1, doorBandY, -4.68);
      }
      addBox(room, 0.42, 0.12, 0.1, interiorAccent, -2.1, 0.32, -4.66);
      for (const [crateX, crateZ, crateH] of [[2.2, -3.7, 0.62], [3.05, -3.7, 0.9], [2.62, -2.85, 0.62]]) {
        addBox(room, 0.78, crateH, 0.78, interiorWood, crateX, crateH * 0.5 + 0.14, crateZ);
        addBox(room, 0.56, 0.1, 0.56, interiorGlow, crateX, crateH + 0.2, crateZ);
      }
      for (const wheelX of [4.32, 4.68]) {
        addCylinder(room, 0.13, 0.08, interiorMetal, wheelX, 0.15, -3.95);
      }
      addBox(room, 0.09, 1.62, 0.09, interiorMetal, 4.5, 0.92, -3.72);
      addBox(room, 0.44, 0.08, 0.56, interiorMetal, 4.5, 0.3, -3.86);
      addBox(room, 0.66, 0.54, 0.6, interiorWood, 4.5, 0.62, -3.9);
      addInteriorPlaque(room, 'PIER FREIGHT · LOADING', -2.1, 3.3, -4.58, 0.56);
      // Working-waterfront cues: rope coils, a life ring and a chalked
      // sailing board tie the hall to the ferries outside.
      addInteriorRopeCoil(room, -4.5, -1.15, 1);
      addInteriorRopeCoil(room, -3.8, -1.5, 0.72);
      const lifeRing = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.075, 6, 14), interiorAccent);
      lifeRing.position.set(5.72, 2.2, -0.6);
      lifeRing.rotation.y = Math.PI * 0.5;
      room.add(lifeRing);
      addBox(room, 1.5, 0.96, 0.07, interiorMetal, 1.9, 2.5, -4.72);
      for (const boardY of [2.24, 2.5, 2.76]) {
        addBox(room, 1.14, 0.055, 0.05, interiorGlow, 1.9, boardY, -4.66);
      }
      addInteriorPlaque(room, 'SAILINGS · PIER GATE', 1.9, 3.24, -4.58, 0.5);
    } else {
      addInteriorLabel(room, 'Edwardian Loft', '#ee806f');
      addInteriorSettee(room, -2.3, 1.4, 0, interiorAccent);
      addBox(room, 3.3, 0.12, 1.12, interiorWood, 1.65, 0.98, -1.55);
      addBox(room, 0.1, 1.38, 0.1, interiorMetal, 0.42, 0.54, -1.55);
      addBox(room, 0.1, 1.38, 0.1, interiorMetal, 2.88, 0.54, -1.55);
      addBox(room, 1.36, 1.08, 0.12, interiorGlass, 1.65, 2.38, -1.35);
      addBox(room, 2.2, 0.16, 0.92, interiorPaper, 1.65, 2.96, -1.35);
      addInteriorPlanter(room, 4.25, -2.7, 0.96);
      addInteriorPlanter(room, -4.25, -2.7, 0.78);
      addBox(room, 2.18, 0.14, 0.68, interiorTrim, 0.2, 4.44, 1.05);
      addBox(room, 0.12, 1.42, 0.18, interiorMetal, -4.75, 2.65, 1.05);
      addBox(room, 0.12, 1.42, 0.18, interiorMetal, 4.75, 2.65, 1.05);
      // Sleeping alcove: bed, side table and reading lamp fill the far corner
      // as a lived-in secondary space beside the work table.
      addBox(room, 2.5, 0.4, 1.82, interiorWood, -3.1, 0.34, -3.3);
      addBox(room, 2.28, 0.24, 1.6, interiorPaper, -3.1, 0.64, -3.3);
      addBox(room, 0.92, 0.16, 1.44, interiorAccent, -3.58, 0.8, -3.3);
      addBox(room, 0.56, 0.14, 0.42, interiorBlue, -2.32, 0.79, -3.9);
      addBox(room, 0.58, 0.56, 0.58, interiorWood, -1.52, 0.42, -4.22);
      addCylinder(room, 0.05, 0.52, interiorMetal, -1.52, 0.98, -4.22);
      addCylinder(room, 0.14, 0.12, interiorGlow, -1.52, 1.28, -4.22);
      addInteriorBookStack(room, -1.52, 0.72, -4.02, 2);
      addBox(room, 1.66, 1.26, 0.07, interiorPaper, 3.25, 2.28, -4.72);
      addBox(room, 1.28, 0.9, 0.05, interiorAccent, 3.25, 2.28, -4.66);
      addInteriorPlaque(room, 'SLEEPING ALCOVE', -3.1, 2.62, -4.6, 0.5);
      // Lived-in traces: radiator, bookshelf and entry coat rack keep the
      // loft reading as a Western Addition apartment, not a staged set.
      addInteriorRadiator(room, 4.9, -1.95, 0);
      addInteriorShelfRow(room, 5.25, 0.6, 1.18, interiorAccent);
      addInteriorBookStack(room, -2.3, 0.74, 1.38, 4);
      addInteriorCoatRack(room, -5.25, 3.6);
    }

    // Address-dressing collision proxies: furniture clusters outside the
    // shared orbit clearance. Counts match the QA/verify contract.
    const collisionBudget = {
      cafe: 3,
      market: 3,
      loft: 3,
      civic: 3,
      coit: 2,
      ferry: 3,
    };
    room.userData.interiorCollisionMode = 'aabb-envelope+address-dressing';
    room.userData.interiorCollisionBoxes = collisionBudget[variant] ?? 2;

    room.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
    });
    interiorRoot.add(room);
    return room;
  };

  const interiorRooms = [
    createInteriorRoom('cafe', 0),
    createInteriorRoom('market', 1),
    createInteriorRoom('loft', 2),
    createInteriorRoom('civic', 3),
    createInteriorRoom('coit', 4),
    createInteriorRoom('ferry', 5),
  ];
  const roomByKind = new Map([
    ['storefront', interiorRooms[1]],
    ['cafe', interiorRooms[0]],
    ['market', interiorRooms[1]],
    ['loft', interiorRooms[2]],
    ['lobby', interiorRooms[3]],
    ['civic', interiorRooms[3]],
    ['rowhouse', interiorRooms[2]],
    ['coit', interiorRooms[4]],
    ['ferry', interiorRooms[5]],
  ]);
  const flagshipRoom = interiorRooms[3];
  const flagshipHotspots = [
    {
      id: 'welcome-desk',
      label: 'WELCOME DESK',
      position: new THREE.Vector3(0, 1.6, 1.45),
      radius: 1.75,
      state: 'ready',
      action: 'ASK MARA',
    },
    {
      id: 'bay-route-model',
      label: 'BAY ROUTE MODEL',
      position: new THREE.Vector3(-3.6, 1.6, -2.25),
      radius: 1.65,
      state: 'uninspected',
      action: 'INSPECT MODEL',
    },
    {
      id: 'map-archive',
      label: 'MAP ARCHIVE',
      position: new THREE.Vector3(4.95, 1.6, -2.4),
      radius: 1.7,
      state: 'closed',
      action: 'OPEN ARCHIVE',
    },
  ];
  let lastFlagshipAction = null;
  const getFlagshipHotspotSnapshot = (hotspot, distance = null) => ({
    id: hotspot.id,
    label: hotspot.label,
    action: hotspot.action,
    state: hotspot.state,
    radius: hotspot.radius,
    distance,
    enabled: distance === null ? null : distance <= hotspot.radius,
    position: {
      x: hotspot.position.x,
      y: hotspot.position.y,
      z: hotspot.position.z,
    },
  });
  const getInteriorInteraction = (position, discoveryRadius = 4.2) => {
    if (!position || activePortal?.room !== flagshipRoom || !interiorRoot.visible) return null;
    let nearest = null;
    let nearestDistance = discoveryRadius;
    flagshipHotspots.forEach((hotspot) => {
      const worldX = flagshipRoom.position.x + hotspot.position.x;
      const worldZ = flagshipRoom.position.z + hotspot.position.z;
      const distance = Math.hypot(position.x - worldX, position.z - worldZ);
      if (distance < nearestDistance) {
        nearest = hotspot;
        nearestDistance = distance;
      }
    });
    return nearest ? getFlagshipHotspotSnapshot(nearest, nearestDistance) : null;
  };
  const useInteriorInteraction = (id, position) => {
    const current = getInteriorInteraction(position);
    if (!current || current.id !== id || !current.enabled) return null;
    const hotspot = flagshipHotspots.find((candidate) => candidate.id === id);
    if (!hotspot) return null;
    const previousState = hotspot.state;
    let message = '';
    if (id === 'welcome-desk') {
      hotspot.state = 'directions-given';
      hotspot.action = 'REVIEW DIRECTIONS';
      message = 'Mara marks the waterfront loop: Ferry Building, Coit Tower, then the piers.';
    } else if (id === 'bay-route-model') {
      hotspot.state = 'route-marked';
      hotspot.action = 'REVIEW MODEL';
      flagshipRoom.userData.flagshipVisuals.routeMarker.visible = true;
      message = 'The tactile Bay model now marks the welcome center route in amber.';
    } else if (id === 'map-archive') {
      hotspot.state = 'open';
      hotspot.action = 'VIEW ARCHIVE';
      flagshipRoom.userData.flagshipVisuals.archiveClosedDoor.visible = false;
      flagshipRoom.userData.flagshipVisuals.archiveOpenDoor.visible = true;
      message = 'The map archive opens, revealing survey shelves and a working table.';
    }
    const result = {
      ...getFlagshipHotspotSnapshot(hotspot, current.distance),
      changed: previousState !== hotspot.state,
      message,
    };
    lastFlagshipAction = {
      id: result.id,
      label: result.label,
      state: result.state,
      changed: result.changed,
    };
    return result;
  };
  portals.forEach((portal) => {
    portal.room = roomByKind.get(portal.roomKind)
      ?? roomByKind.get('civic');
  });
  let activePortal = null;
  const enterInterior = (portal) => {
    if (!portal?.room) return null;
    interiorRooms.forEach((room) => { room.visible = room === portal.room; });
    interiorRoot.visible = true;
    activePortal = portal;
    return {
      target: portal.room.position.clone().add(new THREE.Vector3(0, 2.0, 0)),
      label: portal.label,
      portalId: portal.id,
      variant: portal.room.userData.interiorVariant,
      roomLabel: portal.room.userData.interiorLabel,
    };
  };
  const exitInterior = () => {
    interiorRoot.visible = false;
    activePortal = null;
  };
  const getPortalCoverage = () => {
    const functional = portals.filter((portal) => portal.room);
    const coreRegistered = portals.filter((portal) => (
      Math.abs(portal.position.x) <= CITY_HALF_X
      && Math.abs(portal.position.z) <= CITY_HALF_Z
    ));
    const coreFunctional = functional.filter((portal) => (
      Math.abs(portal.position.x) <= CITY_HALF_X
      && Math.abs(portal.position.z) <= CITY_HALF_Z
    ));
    const defaultStartReady = functional.filter((portal) => {
      const route = portal.approachRoute;
      if (!portal.featured || !portal.door || !portal.signposted || !route?.length) return false;
      const promptPoint = route[route.length - 1];
      return Math.hypot(
        promptPoint.x - portal.position.x,
        promptPoint.z - portal.position.z,
      ) <= portal.radius;
    });
    const bySource = functional.reduce((counts, portal) => {
      counts[portal.source] = (counts[portal.source] ?? 0) + 1;
      return counts;
    }, {});
    return {
      registered: portals.length,
      functional: functional.length,
      coreRegistered: coreRegistered.length,
      coreFunctional: coreFunctional.length,
      doorwayMeshLinked: functional.filter((portal) => portal.door).length,
      explicitlySignposted: functional.filter((portal) => portal.signposted).length,
      defaultStartReady: defaultStartReady.length,
      interiorVariants: new Set(
        functional.map((portal) => portal.room.userData.interiorVariant),
      ).size,
      generatedFunctional: bySource['generated-fabric'] ?? 0,
      authoredBuildingFunctional: bySource['authored-building'] ?? 0,
      authoredFacadeFunctional: bySource['authored-facade'] ?? 0,
      landmarkFunctional: bySource['authored-landmark'] ?? 0,
      districts: new Set(functional.map((portal) => portal.district)).size,
      scope: 'authored core buildings + deterministic core infill only; streamed sector portals and unmodeled addresses are not counted here',
    };
  };
  const getInteriorState = () => {
    const room = activePortal?.room;
    const flagshipActive = interiorRoot.visible && room === flagshipRoom;
    const collisionBoxes = Number(room?.userData?.interiorCollisionBoxes) || 0;
    return {
      active: interiorRoot.visible && Boolean(room),
      portalId: activePortal?.id ?? null,
      portalLabel: activePortal?.label ?? null,
      variant: room?.userData?.interiorVariant ?? null,
      roomLabel: room?.userData?.interiorLabel ?? null,
      interiorCollisionMode: room
        ? (room.userData.interiorCollisionMode || 'aabb-envelope+address-dressing')
        : null,
      interiorCollisionBoxes: room ? collisionBoxes : 0,
      flagship: flagshipActive
        ? {
          id: 'embarcadero-welcome-center',
          staff: 'Mara / welcome center staff',
          ambientCustomer: 'Visitor / reading',
          entranceContinuity: flagshipRoom.userData.entranceContinuity,
          backRoom: flagshipHotspots[2].state === 'open' ? 'revealed' : 'closed',
          hotspots: flagshipHotspots.map((hotspot) => getFlagshipHotspotSnapshot(hotspot)),
          lastAction: lastFlagshipAction,
        }
        : null,
    };
  };
  const cameraRaycaster = new THREE.Raycaster();
  const blockerRayDirection = new THREE.Vector3();
  const getNearestRayBlocker = (origin, direction, maxDistance = 160) => {
    if (!origin || !direction
      || !Number.isFinite(origin.x)
      || !Number.isFinite(origin.y)
      || !Number.isFinite(origin.z)
      || !Number.isFinite(direction.x)
      || !Number.isFinite(direction.y)
      || !Number.isFinite(direction.z)) return null;
    const distanceLimit = Number(maxDistance);
    if (!Number.isFinite(distanceLimit) || distanceLimit <= 0) return null;
    blockerRayDirection.set(direction.x, direction.y, direction.z);
    if (blockerRayDirection.lengthSq() < 1e-10) return null;
    blockerRayDirection.normalize();
    cameraRaycaster.set(origin, blockerRayDirection);
    cameraRaycaster.near = 0;
    cameraRaycaster.far = distanceLimit;
    const hit = cameraRaycaster.intersectObjects(collisionMeshes, false)[0];
    if (!hit || !Number.isFinite(hit.distance) || hit.distance < 0 || hit.distance > distanceLimit) {
      return null;
    }
    return {
      distance: hit.distance,
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      source: 'core',
      collisionKind: 'collision-mesh',
      objectName: hit.object?.name || null,
    };
  };
  const resolveCameraPosition = (target, desired) => {
    if (!target || !desired) return desired;
    if (interiorRoot.visible && activePortal?.room) {
      // Interior rooms are a shared staging wing rather than collision
      // meshes in the exterior raycaster. Keep the orbit camera inside the
      // room envelope so entering a portal cannot place it behind a wall or
      // outside the visible floor when the player rotates the view.
      const anchor = activePortal.room.position;
      const local = desired.clone().sub(anchor);
      local.x = THREE.MathUtils.clamp(local.x, -5.05, 5.05);
      local.z = THREE.MathUtils.clamp(local.z, -4.35, 4.35);
      local.y = THREE.MathUtils.clamp(local.y, 0.38, 5.02);
      return anchor.clone().add(local);
    }
    const direction = desired.clone().sub(target);
    const distance = direction.length();
    if (distance < 0.001) return desired;
    direction.normalize();
    cameraRaycaster.set(target, direction);
    cameraRaycaster.far = distance;
    const hit = cameraRaycaster.intersectObjects(collisionMeshes, false)[0];
    if (!hit) return desired;
    // Keep the orbit camera on the open side of the façade. The old 9 m
    // floor could be farther away than a nearby wall, which put the camera
    // inside the collision mesh when orbiting close to a building.
    const safeDistance = Math.max(0.18, hit.distance - 0.7);
    return target.clone().addScaledVector(direction, Math.min(distance, safeDistance));
  };

  const signalHeads = [];
  const createSignalMaterial = (color) => new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.2),
    emissive: color,
    emissiveIntensity: 0.12,
    roughness: 0.34,
    metalness: 0.18,
  });

  const addTrafficLight = (x, z) => {
    const cornerX = x + 8.75;
    const cornerZ = z + 8.75;
    const baseY = streetHeight(cornerX, cornerZ) + 0.26;
    addCylinder(group, 0.09, 5.45, infrastructureMaterial, cornerX, baseY + 2.73, cornerZ);
    addCylinder(group, 0.24, 0.1, infrastructureHousingMaterial, cornerX, baseY + 0.28, cornerZ);
    for (const boltX of [-0.13, 0.13]) {
      addCylinder(group, 0.025, 0.05, infrastructureMaterial,
        cornerX + boltX, baseY + 0.35, cornerZ);
    }
    // A shallow mast arm and cable drop make the signal read as a supported
    // city fixture, not a black box floating on a pole.
    addRod(group,
      new THREE.Vector3(cornerX, baseY + 5.18, cornerZ),
      new THREE.Vector3(cornerX - 3.9, baseY + 5.18, cornerZ),
      0.048,
      infrastructureMaterial);
    addRod(group,
      new THREE.Vector3(cornerX - 3.9, baseY + 5.18, cornerZ),
      new THREE.Vector3(cornerX - 3.72, baseY + 4.82, cornerZ),
      0.034,
      infrastructureHousingMaterial);
    const offset = signalOffsetForPosition(x, z);
    [0, 1].forEach((signalGroup) => {
      const headX = cornerX - 3.94 + (signalGroup === 0 ? -0.46 : 0.46);
      const housing = new THREE.Mesh(
        new RoundedBoxGeometry(0.72, 1.78, 0.64, 0.09, 2),
        infrastructureHousingMaterial,
      );
      housing.position.set(headX, baseY + 4.85, cornerZ - 0.02);
      housing.castShadow = true;
      group.add(housing);
      const red = createSignalMaterial(0xff342c);
      const amber = createSignalMaterial(0xffa72f);
      const green = createSignalMaterial(0x43d06c);
      [red, amber, green].forEach((material, index) => {
        const lens = new THREE.Mesh(signalLensGeometry, material);
        lens.position.set(headX, baseY + 5.37 - index * 0.52, cornerZ - 0.33);
        lens.rotation.x = Math.PI * 0.5;
        group.add(lens);
        addBox(group, 0.82, 0.07, 0.12, infrastructureHousingMaterial,
          headX, baseY + 5.61 - index * 0.52, cornerZ - 0.34);
      });
      const lenses = { red, amber, green };
      applyTrafficSignalLensPhase(lenses, signalPhaseAt(signalGroup, 0, offset));
      signalHeads.push({ ...lenses, group: signalGroup, offset });
    });

    // Two primitive green blades read clearly as intersecting street signs.
    addBox(group, 2.25, 0.48, 0.09, materials.signGreen, cornerX - 0.8, baseY + 4.18, cornerZ);
    addBox(group, 1.75, 0.42, 0.09, materials.signGreen, cornerX, baseY + 3.65, cornerZ, Math.PI * 0.5);
    addBox(group, 1.55, 0.065, 0.025, materials.signLetter, cornerX - 0.8, baseY + 4.18, cornerZ - 0.058);
  };

  roadNetwork.intersections.forEach((intersection, index) => {
    addTrafficLight(intersection.x, intersection.z, index * 0.9);
  });

  let streetLampCount = 0;
  const addStreetLamp = (x, z, heading = 0, realLight = false) => {
    const lamp = new THREE.Group();
    lamp.name = 'Street lamp';
    addCylinder(lamp, 0.08, 5.25, infrastructureMaterial, 0, 2.63, 0);
    addCylinder(lamp, 0.2, 0.1, infrastructureHousingMaterial, 0, 0.24, 0);
    addCylinder(lamp, 0.13, 0.08, infrastructureMaterial, 0, 0.31, 0);
    addRod(lamp,
      new THREE.Vector3(0, 4.96, 0),
      new THREE.Vector3(0.55, 5.28, 0),
      0.06,
      infrastructureMaterial);
    addRod(lamp,
      new THREE.Vector3(0.55, 5.28, 0),
      new THREE.Vector3(1.06, 5.18, 0),
      0.052,
      infrastructureMaterial);
    const luminaire = new THREE.Mesh(
      new RoundedBoxGeometry(0.62, 0.16, 0.34, 0.06, 2),
      infrastructureMaterial,
    );
    luminaire.position.set(1.12, 5.12, 0);
    luminaire.castShadow = true;
    lamp.add(luminaire);
    addBox(lamp, 0.36, 0.045, 0.23, infrastructureHousingMaterial, 1.12, 5.0, 0);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 5), lampBulbMaterial);
    bulb.position.set(1.12, 5.01, 0);
    lamp.add(bulb);
    if (realLight) {
      const light = new THREE.PointLight(0xffa563, 36, 17, 2);
      light.position.copy(bulb.position);
      lamp.add(light);
    }
    lamp.position.set(x, streetHeight(x, z) + 0.28, z);
    lamp.quaternion.copy(gradeQuaternion(heading));
    group.add(lamp);
    streetLampCount += 1;
  };
  [
    [-25.2, -50, 0, true], [-25.2, -18, Math.PI, false],
    [25.2, 18, Math.PI, true], [25.2, 48, 0, false],
    [-81, 16, 0, false], [81, -18, Math.PI, false],
    [-12, 61, Math.PI * 0.5, true], [49, 3, -Math.PI * 0.5, false],
    [19.1, -23.5, 0, false], [37.1, -8.5, Math.PI, false],
    [-70, 79.6, 0, false], [-22, 79.6, Math.PI, false],
    [26, 79.6, 0, true], [74, 79.6, Math.PI, false],
  ].forEach((lamp) => addStreetLamp(...lamp));

  const utilityPolePoints = [-58, -36, -14, 10, 34, 58].map((z) => {
    const x = -92;
    const baseY = streetHeight(x, z);
    addCylinder(group, 0.17, 8.7, materials.wood, x, baseY + 4.35, z);
    addBox(group, 3.1, 0.16, 0.18, materials.wood, x, baseY + 8.05, z);
    for (const offset of [-1.2, 0, 1.2]) {
      addCylinder(group, 0.11, 0.25, materials.concrete, x + offset, baseY + 8.27, z);
    }
    return new THREE.Vector3(x, baseY + 8.34, z);
  });

  for (let index = 0; index < utilityPolePoints.length - 1; index += 1) {
    const start = utilityPolePoints[index];
    const end = utilityPolePoints[index + 1];
    for (const xOffset of [-1.2, 0, 1.2]) {
      const a = start.clone().add(new THREE.Vector3(xOffset, 0, 0));
      const b = end.clone().add(new THREE.Vector3(xOffset, 0, 0));
      const middle = a.clone().lerp(b, 0.5);
      middle.y -= 0.85;
      const curve = new THREE.CatmullRomCurve3([a, middle, b]);
      const wire = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 10, 0.018, 4, false),
        materials.wire,
      );
      wire.name = 'Sagging utility wire';
      group.add(wire);
    }
  }

  const hemisphere = new THREE.HemisphereLight(0xa9c4d5, 0x5a4437, 1.35);
  hemisphere.name = 'Warm sky fill';
  if (!hasExternalLighting) group.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xffad72, 3.5);
  sun.name = 'Late afternoon sun';
  sun.position.set(-105, 118, -88);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -125;
  sun.shadow.camera.right = 125;
  sun.shadow.camera.top = 125;
  sun.shadow.camera.bottom = -125;
  sun.shadow.camera.near = 12;
  sun.shadow.camera.far = 330;
  sun.shadow.bias = -0.00025;
  sun.target.position.set(0, 8, 0);
  if (!hasExternalLighting) group.add(sun, sun.target);

  const rim = new THREE.DirectionalLight(0x7897bd, 0.62);
  rim.name = 'Cool fog rim';
  rim.position.set(85, 58, 110);
  if (!hasExternalLighting) group.add(rim);

  group.traverse((object) => {
    if (!object.isMesh) return;
    object.receiveShadow = !object.userData.noReceiveShadow;
    // Only authored hero masses and explicitly marked landmarks need to
    // enter the directional shadow atlas. Tiny props, facade sills, utility
    // wires, and thousands of window meshes still receive the shadow but do
    // not each submit a second shadow-pass draw.
    object.castShadow = !object.userData.noShadow && Boolean(object.castShadow || object.userData.castShadow);
  });
  trunks.castShadow = true;
  canopies.castShadow = true;
  sunCanopies.castShadow = true;

  scene.background = new THREE.Color(0xc9a692);
  scene.fog = new THREE.Fog(0x87999d, 84, 286);
  if (renderer) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  const createRainLayer = ({ count, zMin, zMax, sizeNear, sizeFar, alpha, color }) => {
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      positions[offset] = (random() - 0.5) * 220;
      positions[offset + 1] = random() * 82;
      // Keep every point in front of the opening camera. Using points rather
      // than clipped line endpoints prevents the old full-height scratches.
      positions[offset + 2] = zMin + random() * (zMax - zMin);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(color) },
        uSizeNear: { value: sizeNear },
        uSizeFar: { value: sizeFar },
        uAlpha: { value: alpha },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uSizeNear;
        uniform float uSizeFar;
        void main() {
          vec3 p = position;
          p.y = mod(position.y - uTime * 22.0 + 82.0, 82.0);
          p.x += p.y * 0.065;
          vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
          float depth = clamp((-viewPosition.z - 14.0) / 170.0, 0.0, 1.0);
          gl_PointSize = mix(uSizeNear, uSizeFar, depth);
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uAlpha;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          uv.x += uv.y * 0.28;
          float streak = smoothstep(0.18, 0.015, abs(uv.x));
          float taper = smoothstep(0.56, 0.20, abs(uv.y));
          float softEdge = smoothstep(0.52, 0.02, length(vec2(uv.x * 2.8, uv.y)));
          gl_FragColor = vec4(uColor, streak * taper * softEdge * uAlpha);
        }
      `,
    });
    const points = new THREE.Points(geometry, material);
    points.visible = false;
    points.frustumCulled = false;
    group.add(points);
    return { points, material };
  };
  const distantRain = createRainLayer({
    count: 420,
    zMin: 64,
    zMax: 190,
    sizeNear: 4.6,
    sizeFar: 1.15,
    alpha: 0.32,
    color: 0xa8c2cf,
  });
  distantRain.points.name = 'Pacific drizzle distant streaks';
  const nearRain = createRainLayer({
    count: 150,
    zMin: 28,
    zMax: 74,
    sizeNear: 9.0,
    sizeFar: 3.0,
    alpha: 0.4,
    color: 0x9dbdca,
  });
  nearRain.points.name = 'Pacific drizzle near streaks';

  // Street runoff and seawall spray are separate from the falling-rain
  // sprites: they provide the grounded secondary motion that makes drizzle
  // read as weather interacting with the waterfront rather than a screen
  // overlay. Both effects stay within two transparent draw calls.
  const runoffMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix
          * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime;
      uniform float uOpacity;
      void main() {
        float crossSection = 1.0 - smoothstep(0.18, 0.5, abs(vUv.x - 0.5));
        float pulse = sin(vUv.y * 43.0 - uTime * 5.4 + vUv.x * 8.0) * 0.5 + 0.5;
        float brokenFlow = smoothstep(0.34, 0.92, pulse);
        float ends = smoothstep(0.0, 0.09, vUv.y)
          * (1.0 - smoothstep(0.88, 1.0, vUv.y));
        vec3 color = mix(vec3(0.19, 0.27, 0.29), vec3(0.62, 0.74, 0.76), brokenFlow);
        gl_FragColor = vec4(color, uOpacity * crossSection * ends
          * (0.2 + brokenFlow * 0.8));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: true,
  });
  const runoffPlacements = [
    [20.82, -43, 0.28, 7.2], [35.18, -31, 0.26, 5.8],
    [20.82, -15, 0.24, 6.6], [35.18, -2, 0.3, 7.8],
    [20.82, 16, 0.27, 6.2], [35.18, 29, 0.24, 7.0],
    [20.82, 43, 0.3, 8.2], [35.18, 55, 0.28, 6.4],
  ];
  const runoffRibbons = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    runoffMaterial,
    runoffPlacements.length,
  );
  const runoffNormal = new THREE.Vector3(-GRADE_X, 1, -GRADE_Z).normalize();
  const runoffRotation = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    runoffNormal,
  );
  runoffPlacements.forEach(([x, z, width, depth], index) => {
    runoffRibbons.setMatrixAt(index, new THREE.Matrix4().compose(
      new THREE.Vector3(x, streetHeight(x, z) + 0.073, z),
      runoffRotation,
      new THREE.Vector3(width, depth, 1),
    ));
  });
  runoffRibbons.name = 'Drizzle gutter runoff ribbons';
  runoffRibbons.instanceMatrix.needsUpdate = true;
  runoffRibbons.computeBoundingSphere();
  runoffRibbons.visible = false;
  runoffRibbons.renderOrder = 2;
  runoffRibbons.userData.noShadow = true;
  runoffRibbons.userData.noReceiveShadow = true;
  group.add(runoffRibbons);

  const sprayCount = 96;
  const sprayPositions = new Float32Array(sprayCount * 3);
  for (let index = 0; index < sprayCount; index += 1) {
    const offset = index * 3;
    sprayPositions[offset] = -108 + random() * 216;
    sprayPositions[offset + 1] = bayWater.position.y + 0.12 + random() * 1.65;
    sprayPositions[offset + 2] = 84.5 + random() * 10.5;
  }
  const sprayGeometry = new THREE.BufferGeometry();
  sprayGeometry.setAttribute('position', new THREE.BufferAttribute(sprayPositions, 3));
  const sprayMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
    },
    vertexShader: `
      uniform float uTime;
      void main() {
        vec3 p = position;
        p.x += sin(position.z * 1.7 + uTime * 2.1) * 0.22;
        p.y += mod(uTime * 0.34 + position.x * 0.013, 0.54);
        vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(86.0 / max(-viewPosition.z, 1.0), 1.0, 3.2);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      void main() {
        float radius = length(gl_PointCoord - 0.5);
        float alpha = (1.0 - smoothstep(0.12, 0.5, radius)) * uOpacity;
        gl_FragColor = vec4(0.7, 0.82, 0.84, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: true,
  });
  const seawallSpray = new THREE.Points(sprayGeometry, sprayMaterial);
  seawallSpray.name = 'Drizzle seawall wind spray';
  seawallSpray.visible = false;
  seawallSpray.frustumCulled = false;
  seawallSpray.renderOrder = 2;
  group.add(seawallSpray);

  let weatherMode = 'clear';
  let nightLightingAmount = 0;
  const setNightLighting = (amount = 0) => {
    nightLightingAmount = THREE.MathUtils.clamp(Number(amount) || 0, 0, 1);
  };
  const setWeather = (mode = 'clear') => {
    weatherMode = ['clear', 'fog', 'drizzle'].includes(mode) ? mode : 'clear';
    distantRain.points.visible = weatherMode === 'drizzle';
    nearRain.points.visible = weatherMode === 'drizzle';
    const isWet = weatherMode === 'drizzle';
    runoffRibbons.visible = isWet;
    seawallSpray.visible = isWet;
    runoffMaterial.uniforms.uOpacity.value = isWet ? 0.42 : 0;
    sprayMaterial.uniforms.uOpacity.value = isWet ? 0.32 : 0;
    materials.asphalt.color.set(isWet ? 0x252d30 : 0x4d5152);
    // Keep the district-scale base surfaces broadly rough in drizzle. Their
    // darkened albedo still reads wet, while the authored clearcoat, puddles,
    // sheens and runoff carry the sharp reflections. Lowering roughness on
    // every full-screen road/marking surface forced high-detail environment
    // lookups across the whole frame and dominated the drizzle render path.
    materials.asphalt.roughness = 0.86;
    materials.asphalt.metalness = isWet ? 0.0 : 0.04;
    materials.concrete.color.set(isWet ? 0x7f8987 : 0xb6afa4);
    materials.concrete.roughness = 0.88;
    materials.curb.color.set(isWet ? 0x747d7b : 0xd2cbc0);
    materials.laneWhite.color.set(isWet ? 0xb8b8b0 : 0xd5d0c3);
    materials.laneWhite.roughness = 0.84;
    materials.laneYellow.color.set(isWet ? 0x9d813d : 0xc59e42);
    materials.laneYellow.roughness = 0.86;
    if (heroRoadMaterial) {
      // The puddle layer carries the sharp sky reflections. Keep the asphalt
      // itself dark and broadly reflective; a bright clearcoat across the
      // entire road turns the grazing-angle beauty view into a white mirror.
      heroRoadMaterial.color.set(isWet ? 0x687477 : 0xffffff);
      heroRoadMaterial.roughness = isWet ? 0.9 : 0.94;
      heroRoadMaterial.metalness = 0.0;
      heroRoadMaterial.clearcoat = isWet ? 0.1 : 0.02;
      heroRoadMaterial.clearcoatRoughness = isWet ? 0.38 : 0.46;
      heroRoadMaterial.envMapIntensity = isWet ? 0.26 : 0.42;
      heroRoadMaterial.normalScale.setScalar(isWet ? 0.14 : 0.18);
    }
    if (heroSidewalkMaterial) {
      heroSidewalkMaterial.color.set(isWet ? 0x707b79 : 0xffffff);
      heroSidewalkMaterial.roughness = 0.9;
      heroSidewalkMaterial.metalness = 0.0;
    }
    if (heroGutterMaterial) {
      heroGutterMaterial.color.set(isWet ? 0x293839 : 0x566466);
      heroGutterMaterial.roughness = 0.78;
      heroGutterMaterial.metalness = 0.0;
    }
    if (heroCurbMaterial) {
      heroCurbMaterial.color.set(isWet ? 0x66706f : 0xb9b2a8);
      heroCurbMaterial.roughness = 0.88;
    }
    if (heroSidewalkSeamMaterial) {
      heroSidewalkSeamMaterial.color.set(isWet ? 0x4f5553 : 0x625f5a);
      heroSidewalkSeamMaterial.opacity = isWet ? 0.52 : 0.36;
    }
    if (heroSidewalkWearMaterial) {
      heroSidewalkWearMaterial.color.set(isWet ? 0x4a5352 : 0x5f5d59);
      heroSidewalkWearMaterial.opacity = isWet ? 0.18 : 0.12;
    }
    if (heroPuddleMaterial) {
      heroPuddleMaterial.opacity = isWet ? 0.68 : 0.0;
      heroPuddleMaterial.color.set(isWet ? 0x5a7073 : 0x5f7377);
      heroPuddleMaterial.roughness = isWet ? 0.16 : 0.12;
      heroPuddleMaterial.metalness = 0.0;
      heroPuddleMaterial.clearcoat = isWet ? 0.56 : 0.22;
      heroPuddleMaterial.envMapIntensity = isWet ? 1.1 : 0.55;
      heroPuddleEdges.forEach((edge) => { edge.visible = isWet; });
      heroPuddles.forEach((puddle) => { puddle.visible = isWet; });
    }
    if (heroPuddleSheenMaterial) {
      heroPuddleSheenMaterial.uniforms.uOpacity.value = isWet ? 0.22 : 0.0;
      heroPuddleSheenMaterial.uniforms.uSkyColor.value.set(
        weatherMode === 'drizzle' ? 0x9eb9c1 : 0xb9c9c6,
      );
      heroPuddleSheenMaterial.uniforms.uWarmColor.value.set(
        weatherMode === 'drizzle' ? 0x6e7470 : 0xcaa17d,
      );
      heroPuddleSheens.forEach((sheen) => { sheen.visible = isWet; });
    }
    if (heroPuddleEdgeMaterial) {
      heroPuddleEdgeMaterial.opacity = isWet ? 0.24 : 0.0;
      heroPuddleEdgeMaterial.color.set(isWet ? 0x273638 : 0x303d3e);
    }
    masonryMaterials.forEach((material) => {
      material.color.set(isWet ? 0xa6acab : 0xffffff);
    });
    materials.glass.color.set(isWet ? 0x304a52 : 0x3e5c63);
    materials.glassLight.color.set(isWet ? 0x6d8283 : 0x8c9fa0);
    ferryStone.color.set(isWet ? 0x817e76 : weatherMode === 'fog' ? 0xb0aaa0 : 0xcdbfa6);
    ferryRoof.color.set(isWet ? 0x3e484a : weatherMode === 'fog' ? 0x555a59 : 0x5b5550);
    seawallStone.color.set(
      isWet ? 0x505959 : weatherMode === 'fog' ? 0x777b77 : 0x756f66,
    );
    shorelineFoam.material.opacity = isWet ? 0.3 : weatherMode === 'fog' ? 0.16 : 0.2;
    skylineSilhouetteMaterial.color.set(
      weatherMode === 'drizzle' ? 0x394a52 : weatherMode === 'fog' ? 0x657178 : 0x4d5d69,
    );
    if (weatherMode === 'fog') {
      scene.fog.color.set(0x93a2a2);
      scene.fog.near = 62;
      scene.fog.far = 248;
      skyMaterial.uniforms.topColor.value.set(0x64737f);
      skyMaterial.uniforms.horizonColor.value.set(0x8d9998);
      skyMaterial.uniforms.sunColor.value.set(0xa4acab);
    } else if (weatherMode === 'drizzle') {
      scene.fog.color.set(0x7f929b);
      scene.fog.near = 58;
      scene.fog.far = 222;
      skyMaterial.uniforms.topColor.value.set(0x536779);
      skyMaterial.uniforms.horizonColor.value.set(0x8c9b9f);
      skyMaterial.uniforms.sunColor.value.set(0xa7b4b4);
    } else {
      scene.fog.color.set(0x87999d);
      scene.fog.near = 84;
      scene.fog.far = 286;
      skyMaterial.uniforms.topColor.value.set(0x5b789e);
      skyMaterial.uniforms.horizonColor.value.set(0xe3b8a0);
      skyMaterial.uniforms.sunColor.value.set(0xffd0a0);
    }
    const hazeColor = weatherMode === 'drizzle'
      ? 0x81949d
      : weatherMode === 'fog' ? 0x9ca8a6 : 0x94a8ab;
    const hazeDensityFactor = weatherMode === 'fog'
      ? 1.78
      : weatherMode === 'drizzle' ? 1.52 : 1;
    marineHazeLayers.forEach((layer, index) => {
      layer.material.uniforms.uColor.value.set(hazeColor);
      // The most distant layer remains denser, while the waterfront layer
      // stays porous enough to preserve a readable water edge in every mode.
      layer.material.uniforms.uDensity.value = layer.userData.baseDensity
        * hazeDensityFactor
        * (1 + index * 0.04);
    });
    // Preserve roughly half of each landmark's authored chroma through the
    // marine layer. This is intentionally separate from the scene-wide fog:
    // nearby architecture still fades normally, while the bridge never
    // becomes a glowing gray-white wireframe against the Bay.
    if (weatherMode === 'drizzle') {
      bridgeOrange.color.set(0x744039);
      bridgeOrangeShadow.color.set(0x3f302f);
      bridgeCableMaterial.color.set(0x30383b);
      bridgeCableMaterial.opacity = 0.48;
      coitConcreteMaterial.color.set(0x85857c);
      coitBandMaterial.color.set(0x5d625f);
      coitWindowMaterial.color.set(0x273235);
    } else if (weatherMode === 'fog') {
      bridgeOrange.color.set(0x7c4d45);
      bridgeOrangeShadow.color.set(0x463735);
      bridgeCableMaterial.color.set(0x3b4244);
      bridgeCableMaterial.opacity = 0.5;
      coitConcreteMaterial.color.set(0x918e82);
      coitBandMaterial.color.set(0x66665e);
      coitWindowMaterial.color.set(0x2d3839);
    } else {
      bridgeOrange.color.set(0xa44732);
      bridgeOrangeShadow.color.set(0x512724);
      bridgeCableMaterial.color.set(0x3b3837);
      bridgeCableMaterial.opacity = 0.58;
      coitConcreteMaterial.color.set(0xa99d89);
      coitBandMaterial.color.set(0x756b5d);
      coitWindowMaterial.color.set(0x29383a);
    }
    if (bayWater.material.uniforms) {
      bayWater.material.uniforms.uFogColor.value.copy(scene.fog.color);
      bayWater.material.uniforms.uFogNear.value = scene.fog.near;
      bayWater.material.uniforms.uFogFar.value = scene.fog.far;
      bayWater.material.uniforms.uWeatherMix.value = weatherMode === 'clear' ? 0 : weatherMode === 'fog' ? 0.72 : 1;
      bayWater.material.uniforms.uShallowColor.value.set(
        weatherMode === 'drizzle' ? 0x38545a : weatherMode === 'fog' ? 0x526c70 : 0x376e79,
      );
      bayWater.material.uniforms.uDeepColor.value.set(
        weatherMode === 'drizzle' ? 0x1e3740 : weatherMode === 'fog' ? 0x354f54 : 0x183f4e,
      );
      bayWater.material.uniforms.uSkyHorizon.value.set(
        weatherMode === 'drizzle' ? 0x82949a : weatherMode === 'fog' ? 0xa9b0ad : 0xd6aa93,
      );
      bayWater.material.uniforms.uSkyZenith.value.set(
        weatherMode === 'drizzle' ? 0x4e6573 : weatherMode === 'fog' ? 0x69787f : 0x66849e,
      );
    }
    const weatherSunBase = weatherMode === 'drizzle' ? 1.05 : weatherMode === 'fog' ? 1.8 : 3.5;
    sun.intensity = weatherSunBase;
    hemisphere.intensity = weatherMode === 'drizzle' ? 1.08 : weatherMode === 'fog' ? 1.2 : 1.35;
    rim.intensity = weatherMode === 'drizzle' ? 0.74 : weatherMode === 'fog' ? 0.66 : 0.62;
  };

  scene.add(group);
  // Apply the initial clear preset so weather-only geometry starts hidden and
  // the authored pavement uses the same grading path as later transitions.
  setWeather('clear');

  let internalElapsed = 0;
  const update = (dt = 0, elapsed) => {
    internalElapsed = Number.isFinite(elapsed)
      ? elapsed
      : internalElapsed + (Number.isFinite(dt) ? dt : 0);

    signalHeads.forEach(({ red, amber, green, group: signalGroup, offset }) => {
      applyTrafficSignalLensPhase({ red, amber, green }, signalPhaseAt(signalGroup, internalElapsed, offset));
    });

    if (bayWater.material.uniforms) {
      bayWater.material.uniforms.uTime.value = internalElapsed;
    }
    marineHazeLayers.forEach((layer) => {
      layer.material.uniforms.uTime.value = internalElapsed;
    });
    skyMaterial.uniforms.time.value = internalElapsed;
    distantRain.material.uniforms.uTime.value = internalElapsed;
    nearRain.material.uniforms.uTime.value = internalElapsed;
    runoffMaterial.uniforms.uTime.value = internalElapsed;
    sprayMaterial.uniforms.uTime.value = internalElapsed;
    const duskPulse = 1 + Math.sin(internalElapsed * 0.72) * 0.055;
    // Day keeps a soft interior glow; night ramps windows and street lamps so
    // the core district matches streaming's night-window mix.
    const night = nightLightingAmount;
    const windowNight = THREE.MathUtils.lerp(0.55, 2.85, night);
    const lampNight = THREE.MathUtils.lerp(0.85, 4.6, night);
    warmWindowMaterial.emissiveIntensity = windowNight * duskPulse;
    lampBulbMaterial.emissiveIntensity = lampNight * duskPulse;
    beaconMaterial.emissiveIntensity = (2.2 + night * 2.4)
      + (Math.sin(internalElapsed * 2.4) * 0.5 + 0.5) * (1.6 + night * 1.8);
    const weatherSunBase = weatherMode === 'drizzle' ? 1.05 : weatherMode === 'fog' ? 1.8 : 3.5;
    sun.intensity = weatherSunBase + Math.sin(internalElapsed * 0.035) * (weatherMode === 'clear' ? 0.08 : 0.025);
  };

  update(0, 0);

  return {
    group,
    roadNetwork,
    sidewalkNetwork,
    portals,
    getNearestPortal(position, maxDistance = Infinity) {
      if (!position) return null;
      let nearest = null;
      let nearestDistance = maxDistance;
      portals.forEach((portal) => {
        const distance = Math.hypot(
          position.x - portal.position.x,
          position.z - portal.position.z,
        );
        if (distance < nearestDistance) {
          nearest = portal;
          nearestDistance = distance;
        }
      });
      return nearest ? { ...nearest, distance: nearestDistance } : null;
    },
    getFeaturedPortal(position) {
      if (!position) return null;
      let nearest = null;
      let nearestDistance = Infinity;
      portals.forEach((portal) => {
        if (!portal.featured || !portal.room) return;
        const distance = Math.hypot(
          position.x - portal.position.x,
          position.z - portal.position.z,
        );
        if (distance < nearestDistance) {
          nearest = portal;
          nearestDistance = distance;
        }
      });
      return nearest ? { ...nearest, distance: nearestDistance } : null;
    },
    getStreamedPortal(position, streaming, maxDistance = 22) {
      const descriptor = streaming?.getNearestEnterablePortal?.(position, maxDistance);
      if (!descriptor) return null;
      // Authored district archetypes map onto the staged room pool. Prefer the
      // expansion's declared roomKind so Civic Lobby does not silently become
      // Mission Market via variantSeed. Seeded rotation remains the fallback
      // for generic streamed fabric without an authored archetype.
      // Never bind streamed district doors to the Embarcadero flagship civic
      // room — that stage owns Mara / archive hotspots. Map civic-class
      // archetypes onto loft/cafe/market instead.
      const archetypeToRoom = {
        'civic-lobby': 'loft',
        'financial-office': 'loft',
        library: 'cafe',
        transit: 'market',
        cafe: 'cafe',
        market: 'market',
        rowhouse: 'rowhouse',
        'sunset-home': 'rowhouse',
        'outer-sunset-cafe': 'cafe',
        coit: 'coit',
        ferry: 'ferry',
        'mission-workshop': 'market',
        'wharf-chandlery': 'market',
        'presidio-barracks': 'loft',
      };
      const authoredKind = archetypeToRoom[descriptor.roomKind]
        || archetypeToRoom[descriptor.interiorArchetype]
        || null;
      const seededKinds = ['cafe', 'market', 'rowhouse', 'civic'];
      const seededKind = Number.isFinite(descriptor.variantSeed)
        ? seededKinds[descriptor.variantSeed % seededKinds.length]
        : null;
      const room = roomByKind.get(authoredKind)
        ?? roomByKind.get(descriptor.roomKind)
        ?? roomByKind.get(seededKind)
        ?? roomByKind.get('civic');
      if (!room) return null;
      return {
        ...descriptor,
        position: new THREE.Vector3(
          descriptor.position.x,
          descriptor.position.y,
          descriptor.position.z,
        ),
        room,
      };
    },
    getPortalCoverage,
    getInteriorState,
    getInteriorInteraction,
    useInteriorInteraction,
    enterInterior,
    exitInterior,
    setWeather,
    setNightLighting,
    get weather() {
      return weatherMode;
    },
    getNearestRayBlocker,
    resolveCameraPosition,
    update,
    stats: {
      blocks: blockBounds.length,
      buildings: buildingCount,
      generatedBuildings: generatedBuildingCount,
      enterable: portals.length,
      featuredInteriors: interiorRooms.length,
      portalCoverage: getPortalCoverage(),
      lights: windowWarm.length + signalHeads.length * 3 + streetLampCount + 1,
    },
  };
}
