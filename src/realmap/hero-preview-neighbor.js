import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const FERRY_WEST_PREVIEW_NEIGHBOR_ID = 'sf-ferry-building-west-preview-v1';
export const FERRY_WEST_PREVIEW_NEIGHBOR_URL = '/data/world/preview/sf-ferry-building-west-preview-v1.json';

const EPSILON = 1e-6;

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid Ferry west preview neighbor: ${message}`);
}

function digestPayload(artifact) {
  const { contentSha256, ...payload } = artifact;
  return JSON.stringify(payload);
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}

function pairs(points) {
  return Array.from({ length: Math.floor((points?.length || 0) / 2) }, (_, index) => [points[index * 2], points[index * 2 + 1]]);
}

export async function loadFerryWestPreviewNeighbor(fetchImpl = fetch) {
  const response = await fetchImpl(FERRY_WEST_PREVIEW_NEIGHBOR_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`West preview neighbor fetch failed (${response.status}).`);
  const artifact = await response.json();
  assert(artifact?.kind === 'earth-walkable-preview-neighbor', 'kind must remain preview-only');
  assert(artifact?.status === 'preview' && artifact?.previewOnly === true, 'status must remain preview');
  assert(artifact?.id === FERRY_WEST_PREVIEW_NEIGHBOR_ID, 'id mismatch');
  assert(artifact?.relationship?.originTileId === 'sf-ferry-building-v1', 'origin tile mismatch');
  assert(artifact?.relationship?.direction === 'west', 'direction must be west');
  assert(JSON.stringify(artifact?.bounds?.coreMeters) === JSON.stringify([1760, 1728, 2144, 2112]), 'core bounds mismatch');
  assert(JSON.stringify(artifact?.bounds?.bufferedMeters) === JSON.stringify([1744, 1712, 2160, 2128]), 'buffered bounds mismatch');
  assert(artifact?.relationship?.sharedEdge?.ownerTileId === 'sf-ferry-building-v1', 'shared edge ownership mismatch');
  assert(artifact?.relationship?.sharedEdge?.quantizationMeters <= 0.01, 'edge quantization exceeds 1cm');
  assert(Array.isArray(artifact?.runtime?.terrain?.heightsMeters), 'terrain samples are required');
  assert(Array.isArray(artifact?.runtime?.roads) && Array.isArray(artifact?.runtime?.buildings), 'source-filtered layers are required');
  assert(Array.isArray(artifact?.productionBlockers) && artifact.productionBlockers.length >= 2, 'production blockers must remain explicit');
  const actualDigest = await sha256(digestPayload(artifact));
  assert(actualDigest === artifact.contentSha256, 'content digest mismatch');
  return artifact;
}

function terrainHeight(artifact, x, z) {
  const { gridSize, sampleBoundsMeters: [minX, minZ, maxX, maxZ], heightsMeters } = artifact.runtime.terrain;
  const gx = THREE.MathUtils.clamp((x - minX) / (maxX - minX) * (gridSize - 1), 0, gridSize - 1);
  const gz = THREE.MathUtils.clamp((z - minZ) / (maxZ - minZ) * (gridSize - 1), 0, gridSize - 1);
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(gridSize - 1, x0 + 1);
  const z1 = Math.min(gridSize - 1, z0 + 1);
  const tx = gx - x0;
  const tz = gz - z0;
  const at = (column, row) => heightsMeters[row * gridSize + column] || 0;
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(at(x0, z0), at(x1, z0), tx), THREE.MathUtils.lerp(at(x0, z1), at(x1, z1), tx), tz);
}

function createTerrainMesh(artifact) {
  const { gridSize, sampleBoundsMeters: [minX, minZ, maxX, maxZ] } = artifact.runtime.terrain;
  const geometry = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, gridSize - 1, gridSize - 1);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  const color = new THREE.Color();
  const colors = [];
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index) + (minX + maxX) / 2;
    const z = position.getZ(index) + (minZ + maxZ) / 2;
    const y = terrainHeight(artifact, x, z) - 0.035;
    position.setY(index, y);
    const grain = Math.sin(x * 0.043 + z * 0.031) * 0.015;
    color.setHSL(0.14, 0.11, 0.51 + grain);
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, metalness: 0 }));
  mesh.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  mesh.receiveShadow = true;
  mesh.name = 'Ferry west preview terrain (local source)';
  return mesh;
}

function roadWidthMeters(road) {
  const lanes = Math.max(1, Number(road.lanes) || 1);
  if (road.highway === 'footway') return road.surface === 'concrete' ? 2.4 : 2;
  if (road.highway === 'pedestrian') return road.surface === 'paving_stones' ? 4.2 : 3.4;
  if (road.highway === 'cycleway') return 2.2;
  if (road.highway === 'service') return Math.max(3.6, lanes * 3.2);
  if (road.highway === 'living_street') return Math.max(4.8, lanes * 3.4);
  return Math.max(5.8, lanes * 3.35);
}

function materialColorForRoad(road) {
  if (road.highway === 'footway' || road.highway === 'pedestrian') {
    if (road.surface?.includes('brick') || road.surface?.includes('paving')) return 0x746d61;
    return 0xaaa69b;
  }
  if (road.surface?.includes('cobblestone')) return 0x5e605d;
  if (road.surface?.includes('concrete')) return 0x7e817e;
  return 0x303436;
}

function appendRibbon(positions, colors, points, halfWidth, elevationOffset, color, artifact) {
  for (let index = 1; index < points.length; index += 1) {
    const [ax, az] = points[index - 1];
    const [bx, bz] = points[index];
    const dx = bx - ax;
    const dz = bz - az;
    const length = Math.hypot(dx, dz);
    if (length < EPSILON) continue;
    const nx = -dz / length * halfWidth;
    const nz = dx / length * halfWidth;
    const ay = terrainHeight(artifact, ax, az) + elevationOffset;
    const by = terrainHeight(artifact, bx, bz) + elevationOffset;
    positions.push(ax + nx, ay, az + nz, ax - nx, ay, az - nz, bx - nx, by, bz - nz, ax + nx, ay, az + nz, bx - nx, by, bz - nz, bx + nx, by, bz + nz);
    for (let vertex = 0; vertex < 6; vertex += 1) colors.push(color.r, color.g, color.b);
  }
}

function createColoredRibbonMesh(name, positions, colors, materialOptions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  // OSM ways may be stored in either direction; double-sided ribbons keep the
  // source geometry visible without rewriting or reordering the way points.
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, side: THREE.DoubleSide, ...materialOptions }));
  mesh.receiveShadow = true;
  mesh.name = name;
  return mesh;
}

function createRoadPresentation(artifact) {
  const roads = [];
  const sidewalks = [];
  const laneMarks = [];
  const roadColors = [];
  const sidewalkColors = [];
  const laneColors = [];
  const white = new THREE.Color(0xd8d4c7);
  for (const road of artifact.runtime.roads) {
    const points = pairs(road.points);
    if (points.length < 2) continue;
    const width = roadWidthMeters(road);
    const roadColor = new THREE.Color(materialColorForRoad(road));
    appendRibbon(roads, roadColors, points, width / 2, 0.022, roadColor, artifact);
    const supportsSidewalk = road.sidewalk === 'both' || road.sidewalk === 'left' || road.sidewalk === 'right';
    if (supportsSidewalk && !['footway', 'pedestrian', 'cycleway'].includes(road.highway)) {
      const sideOffset = width / 2 + 0.85;
      for (const sign of [road.sidewalk === 'right' ? -1 : 1, road.sidewalk === 'left' ? 1 : -1]) {
        if (road.sidewalk !== 'both' && ((road.sidewalk === 'left' && sign !== 1) || (road.sidewalk === 'right' && sign !== -1))) continue;
        const shifted = [];
        for (let index = 0; index < points.length; index += 1) {
          const [previousX, previousZ] = points[Math.max(0, index - 1)];
          const [nextX, nextZ] = points[Math.min(points.length - 1, index + 1)];
          const length = Math.hypot(nextX - previousX, nextZ - previousZ) || 1;
          shifted.push([points[index][0] - (nextZ - previousZ) / length * sideOffset * sign, points[index][1] + (nextX - previousX) / length * sideOffset * sign]);
        }
        appendRibbon(sidewalks, sidewalkColors, shifted, 0.82, 0.038, new THREE.Color(0x9b988e), artifact);
      }
    }
    if (Number(road.lanes) >= 2 && !['footway', 'pedestrian', 'cycleway'].includes(road.highway)) {
      appendRibbon(laneMarks, laneColors, points, 0.07, 0.048, white, artifact);
    }
  }
  const root = new THREE.Group();
  root.name = 'Ferry west preview source-aligned streets';
  root.add(createColoredRibbonMesh('Ferry west preview OSM road ribbons', roads, roadColors, { roughness: 0.9 }));
  if (sidewalks.length) root.add(createColoredRibbonMesh('Ferry west preview tagged sidewalk ribbons', sidewalks, sidewalkColors, { roughness: 0.94 }));
  if (laneMarks.length) root.add(createColoredRibbonMesh('Ferry west preview lane guidance from lane count', laneMarks, laneColors, { roughness: 0.72 }));
  return root;
}

function createBuildingMesh(artifact) {
  const geometries = [];
  const collisionBoxes = [];
  const footprints = [];
  for (const building of artifact.runtime.buildings) {
    const footprint = pairs(building.points);
    if (footprint.length < 3) continue;
    const shape = new THREE.Shape(footprint.map(([x, z]) => new THREE.Vector2(x, -z)));
    const height = Math.max(4, Number(building.height) || Number(building.levels) * 3.3 || 12);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    const base = Math.min(...footprint.map(([x, z]) => terrainHeight(artifact, x, z)));
    geometry.translate(0, base, 0);
    const seed = (Number(building.id) * 0.0000001) % 1;
    const color = new THREE.Color().setHSL(0.095 + seed * 0.035, 0.06 + seed * 0.035, 0.31 + seed * 0.11);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: geometry.attributes.position.count }, () => [color.r, color.g, color.b]).flat(), 3));
    geometries.push(geometry);
    const xs = footprint.map(([x]) => x);
    const zs = footprint.map(([, z]) => z);
    collisionBoxes.push(new THREE.Box3(new THREE.Vector3(Math.min(...xs), base, Math.min(...zs)), new THREE.Vector3(Math.max(...xs), base + height, Math.max(...zs))));
    footprints.push(footprint);
  }
  const geometry = geometries.length ? mergeGeometries(geometries, false) : new THREE.BufferGeometry();
  for (const item of geometries) item.dispose();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.75, metalness: 0.04, flatShading: false });
  const facadePresentation = { value: 1 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.previewFacadePresentation = facadePresentation;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vPreviewWorldPosition;\nvarying vec3 vPreviewWorldNormal;');
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPreviewWorldPosition = worldPosition.xyz;\nvPreviewWorldNormal = normalize(mat3(modelMatrix) * normal);');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vPreviewWorldPosition;\nvarying vec3 vPreviewWorldNormal;\nuniform float previewFacadePresentation;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      // Preview-only facade rhythm: world-space variation, not an assertion of surveyed window locations.
      float verticalFacade = 1.0 - smoothstep(0.18, 0.42, abs(normalize(vPreviewWorldNormal).y));
      vec2 facadeGrid = vec2(vPreviewWorldPosition.x * 0.34 + vPreviewWorldPosition.z * 0.09, vPreviewWorldPosition.y * 0.43);
      vec2 cell = fract(facadeGrid);
      float inset = step(0.18, cell.x) * step(cell.x, 0.79) * step(0.2, cell.y) * step(cell.y, 0.77);
      float alternating = step(0.44, fract(floor(facadeGrid.x) * 0.37 + floor(facadeGrid.y) * 0.19));
      float windowMask = verticalFacade * inset * alternating;
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.27, 0.36, 0.42), windowMask * 0.58 * previewFacadePresentation);`);
  };
  material.customProgramCacheKey = () => 'ferry-west-preview-procedural-facade-v1';
  material.userData.previewFacadePresentation = facadePresentation;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'Ferry west preview OSM footprint buildings';
  return { mesh, collisionBoxes, footprints };
}

function pointInFootprint(point, footprint) {
  let inside = false;
  for (let index = 0, previous = footprint.length - 1; index < footprint.length; previous = index, index += 1) {
    const [ax, az] = footprint[index];
    const [bx, bz] = footprint[previous];
    if ((az > point.z) !== (bz > point.z) && point.x < (bx - ax) * (point.z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

function nearestFootprintEdge(point, footprint) {
  let nearest = null;
  for (let index = 0; index < footprint.length; index += 1) {
    const [ax, az] = footprint[index];
    const [bx, bz] = footprint[(index + 1) % footprint.length];
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 0 ? THREE.MathUtils.clamp(((point.x - ax) * dx + (point.z - az) * dz) / lengthSquared, 0, 1) : 0;
    const x = ax + dx * t;
    const z = az + dz * t;
    const distanceSquared = (point.x - x) ** 2 + (point.z - z) ** 2;
    if (!nearest || distanceSquared < nearest.distanceSquared) nearest = { x, z, distanceSquared };
  }
  return nearest;
}

export function createFerryWestPreviewNeighbor(artifact) {
  const root = new THREE.Group();
  root.name = 'Ferry west preview neighbor (non-canonical)';
  root.userData.previewOnly = true;
  root.add(createTerrainMesh(artifact));
  const roadPresentation = createRoadPresentation(artifact);
  root.add(roadPresentation);
  const buildings = createBuildingMesh(artifact);
  root.add(buildings.mesh);
  root.userData.setPresentationEnabled = (enabled) => {
    roadPresentation.visible = Boolean(enabled);
    buildings.mesh.material.userData.previewFacadePresentation.value = enabled ? 1 : 0;
  };
  const setPresentationEnabled = (enabled) => root.userData.setPresentationEnabled(enabled);
  if (typeof window !== 'undefined') {
    // Narrow browser-QA hook. It affects only preview presentation, never OSM
    // source geometry, elevation, collision boxes, or the preview-only label.
    window.__SF_FERRY_WEST_PREVIEW_QA__ = { id: artifact.id, setPresentationEnabled };
  }
  let disposed = false;
  return Object.freeze({
    id: artifact.id,
    artifact,
    root,
    collisionBoxes: buildings.collisionBoxes,
    raycastCandidates: [buildings.mesh],
    getElevationAt: (x, z) => terrainHeight(artifact, x, z),
    containsBuilding: (x, z) => buildings.footprints.some((footprint) => pointInFootprint({ x, z }, footprint)),
    resolvePlayerCollision: ({ x, z, radius = 0.5 }) => {
      let resolved = { x, z };
      for (const footprint of buildings.footprints) {
        if (!pointInFootprint(resolved, footprint)) continue;
        const edge = nearestFootprintEdge(resolved, footprint);
        const dx = resolved.x - edge.x;
        const dz = resolved.z - edge.z;
        const length = Math.hypot(dx, dz) || 1;
        resolved = { x: edge.x + dx / length * radius, z: edge.z + dz / length * radius };
      }
      return resolved;
    },
    getDiagnostics: () => ({ id: artifact.id, status: artifact.status, previewOnly: true, mounted: !disposed, roads: artifact.runtime.roads.length, buildings: artifact.runtime.buildings.length, collisionBoxes: buildings.collisionBoxes.length, productionBlockers: [...artifact.productionBlockers] }),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof window !== 'undefined' && window.__SF_FERRY_WEST_PREVIEW_QA__?.id === artifact.id) delete window.__SF_FERRY_WEST_PREVIEW_QA__;
      root.traverse((object) => {
        object.geometry?.dispose?.();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material?.dispose?.();
      });
    },
  });
}

export function previewWestBounds(artifact) {
  const [minX, minZ, maxX, maxZ] = artifact.bounds.bufferedMeters;
  return { minX, minZ, maxX, maxZ };
}

export function sharedWestEdgeAgreement(artifact, elevationAt) {
  const samples = artifact.relationship.sharedEdge.samples;
  const differences = samples.map(([x, z, expected]) => Math.abs(Number(elevationAt(x, z)) - expected));
  return { maxDifferenceMeters: Math.max(...differences, 0), withinOneCentimeter: Math.max(...differences, 0) <= 0.01 + EPSILON };
}
