import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const DOOR_COLORS = Object.freeze({
  civic: '#355d72',
  hospitality: '#6f4a30',
  industrial: '#44515a',
  office: '#36556a',
  residential: '#654333',
  retail: '#7a3f34',
});

const HERO_PORTAL_STYLES = Object.freeze([
  { panel: '#45636d', frame: '#e2cda7' },
  { panel: '#385d69', frame: '#d8b879' },
  { panel: '#4b646c', frame: '#e0d2b5' },
  { panel: '#48636b', frame: '#d8cbb1' },
  { panel: '#485d65', frame: '#d3ac78' },
  { panel: '#3e5963', frame: '#aebbc0' },
]);

const HERO_STOREFRONT_PROFILES = Object.freeze([
  { key: 'hearst-gallery', glass: '#315865', trim: '#dbb75f', displayWidth: 1.08, canopyWidth: 4.16, canopyDepth: 0.42 },
  { key: 'bronze-market-bay', glass: '#285568', trim: '#ce8e43', displayWidth: 0.96, canopyWidth: 3.94, canopyDepth: 0.5 },
  { key: 'central-deco-lobby', glass: '#3c5e68', trim: '#e2c77f', displayWidth: 1.12, canopyWidth: 4.22, canopyDepth: 0.38 },
  { key: 'market-limestone-bay', glass: '#385d67', trim: '#91afbd', displayWidth: 1.04, canopyWidth: 4.04, canopyDepth: 0.44 },
  { key: 'kearny-brick-shop', glass: '#36545d', trim: '#d89652', displayWidth: 0.92, canopyWidth: 3.9, canopyDepth: 0.4 },
  { key: 'market-loft-display', glass: '#2f515d', trim: '#a7bbc2', displayWidth: 0.88, canopyWidth: 3.82, canopyDepth: 0.46 },
]);

const HERO_SIGNAGE_PROFILES = Object.freeze(new Map([
  ['sf-building-132127809', { label: 'HEARST BUILDING', atlasCell: 0 }],
  ['sf-building-151183777', { label: 'MARKET STREET', atlasCell: 1 }],
  ['sf-building-132127810', { label: 'CENTRAL TOWER', atlasCell: 2 }],
  ['sf-building-149335987', { label: '700 MARKET', atlasCell: 3 }],
  ['sf-building-149335979', { label: '1 KEARNY', atlasCell: 4 }],
  ['sf-building-149335988', { label: 'MARKET LOFTS', atlasCell: 5 }],
]));
const HERO_SIGNAGE_ATLAS_WIDTH = 2304;
const HERO_SIGNAGE_ATLAS_HEIGHT = 64;
const HERO_SIGNAGE_ATLAS_COLUMNS = 6;

const STOREFRONT_ROAD_CLASSES = new Set([
  'primary', 'secondary', 'tertiary', 'residential', 'living_street', 'service', 'unclassified',
]);

const ROOM_PALETTES = Object.freeze({
  civic: { wall: '#d8d2c4', accent: '#3d6170', floor: '#827568' },
  hospitality: { wall: '#e1d1bd', accent: '#7f4b35', floor: '#715b4e' },
  industrial: { wall: '#b9b8b1', accent: '#4c5558', floor: '#666865' },
  office: { wall: '#d6d8d4', accent: '#466476', floor: '#6d7478' },
  residential: { wall: '#ddd0bb', accent: '#73513d', floor: '#786354' },
  retail: { wall: '#e2d4c3', accent: '#8b4438', floor: '#78675a' },
});

const INTERIOR_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
const INTERIOR_PANEL_GEOMETRY = new THREE.BoxGeometry(1.6, 0.06, 0.5);
const INTERIOR_ROUNDED_GEOMETRY = new RoundedBoxGeometry(1, 1, 1, 3, 0.08);
const INTERIOR_CYLINDER_GEOMETRY = new THREE.CylinderGeometry(0.5, 0.42, 1, 12);
const INTERIOR_SPHERE_GEOMETRY = new THREE.SphereGeometry(0.5, 12, 8);
const INTERIOR_PLANE_GEOMETRY = new THREE.PlaneGeometry(1, 1);
const INTERIOR_SHADOW_GEOMETRY = new THREE.CircleGeometry(0.5, 24);

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.04, ...options });
}

function addBox(group, {
  name,
  category,
  size,
  position,
  surface,
  rounded = false,
  rotation = null,
}) {
  const mesh = new THREE.Mesh(rounded ? INTERIOR_ROUNDED_GEOMETRY : INTERIOR_BOX_GEOMETRY, surface);
  mesh.name = name;
  mesh.userData.category = category;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.scale.set(size[0], size[1], size[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  group.add(mesh);
  return mesh;
}

function seededUnit(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function portalLocalPoint(portal, offsetX, offsetZ) {
  const cos = Math.cos(portal.heading);
  const sin = Math.sin(portal.heading);
  return {
    x: portal.position.x + offsetX * cos + offsetZ * sin,
    z: portal.position.z - offsetX * sin + offsetZ * cos,
  };
}

function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq <= 1e-9) return Math.hypot(point.x - a.x, point.z - a.z);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq));
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function roadClearance(point, city) {
  let minimum = Infinity;
  for (const segment of city?.segments || []) {
    if (!STOREFRONT_ROAD_CLASSES.has(segment.highway) || !Array.isArray(segment.points)) continue;
    const halfWidth = Math.max(0, Number(segment.width || 0) / 2);
    for (let index = 1; index < segment.points.length; index += 1) {
      minimum = Math.min(
        minimum,
        pointSegmentDistance(point, segment.points[index - 1], segment.points[index]) - halfWidth,
      );
    }
  }
  return minimum;
}

function createHeroSignageAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = HERO_SIGNAGE_ATLAS_WIDTH;
  canvas.height = HERO_SIGNAGE_ATLAS_HEIGHT;
  const context = canvas.getContext('2d');
  const cellWidth = canvas.width / HERO_SIGNAGE_ATLAS_COLUMNS;
  const palettes = [
    { field: '#17252d', border: '#c7a86a', text: '#f3ead7' },
    { field: '#17313a', border: '#b7844f', text: '#f2e5cd' },
    { field: '#243039', border: '#d2b972', text: '#f5ecd9' },
    { field: '#25333a', border: '#9db5bd', text: '#f0e8d8' },
    { field: '#2d2524', border: '#c58b52', text: '#f5e7cf' },
    { field: '#263138', border: '#9eb3bb', text: '#f1e8d8' },
  ];
  const profiles = [...HERO_SIGNAGE_PROFILES.values()].sort((a, b) => a.atlasCell - b.atlasCell);
  for (const profile of profiles) {
    const left = profile.atlasCell * cellWidth;
    const palette = palettes[profile.atlasCell];
    context.fillStyle = palette.field;
    context.fillRect(left, 0, cellWidth, canvas.height);
    context.fillStyle = palette.border;
    context.fillRect(left, 0, cellWidth, 3);
    context.fillRect(left, canvas.height - 3, cellWidth, 3);
    context.fillRect(left + 8, 8, 2, canvas.height - 16);
    context.fillRect(left + cellWidth - 10, 8, 2, canvas.height - 16);
    context.fillStyle = palette.text;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '700 28px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
    context.fillText(profile.label, left + cellWidth / 2, canvas.height / 2 + 1, cellWidth - 34);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'hero-storefront-signage-atlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.userData = {
    kind: 'runtime-canvas-atlas',
    width: canvas.width,
    height: canvas.height,
    columns: HERO_SIGNAGE_ATLAS_COLUMNS,
    rows: 1,
    cells: profiles.length,
  };
  return texture;
}

function createHeroSignageMesh(quads, texture) {
  if (!quads.length || !texture) return null;
  const positions = [];
  const uvs = [];
  const indices = [];
  for (const quad of quads) {
    const firstVertex = positions.length / 3;
    for (const corner of quad.corners) positions.push(corner.x, corner.y, corner.z);
    uvs.push(
      quad.uv.u0, quad.uv.v0,
      quad.uv.u1, quad.uv.v0,
      quad.uv.u1, quad.uv.v1,
      quad.uv.u0, quad.uv.v1,
    );
    indices.push(
      firstVertex, firstVertex + 1, firstVertex + 2,
      firstVertex, firstVertex + 2, firstVertex + 3,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.name = 'hero-storefront-signage-geometry';
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const surface = new THREE.MeshBasicMaterial({
    map: texture,
    color: '#ffffff',
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  surface.name = 'hero-storefront-signage-material';
  const mesh = new THREE.Mesh(geometry, surface);
  mesh.name = 'hero-storefront-signage';
  mesh.userData = {
    kind: 'hero-storefront-signage',
    signCount: quads.length,
    atlasCells: HERO_SIGNAGE_ATLAS_COLUMNS,
  };
  return mesh;
}

export function installBuildingPortals(renderer, portals, city = null, sourceSnapshot = null) {
  if (!renderer?.root || !portals.length) return null;
  const portalSourceSnapshot = sourceSnapshot || JSON.stringify(portals);
  const group = new THREE.Group();
  group.name = 'building-portals';
  group.userData = { kind: 'building-portals', portalCount: portals.length };

  const panelGeometry = new THREE.BoxGeometry(1, 2.05, 0.12);
  const panelMaterial = material('#ffffff', { roughness: 0.38, metalness: 0.16 });
  const panels = new THREE.InstancedMesh(panelGeometry, panelMaterial, portals.length);
  panels.name = 'building-portal-panels';
  panels.castShadow = true;
  panels.receiveShadow = true;

  const frameGeometry = new THREE.BoxGeometry(1, 1, 1);
  const frameMaterial = material('#c3b59c', { roughness: 0.48, metalness: 0.16 });
  const frames = new THREE.InstancedMesh(frameGeometry, frameMaterial, portals.length * 3);
  frames.name = 'building-portal-frames';
  frames.castShadow = true;

  const lightGeometry = new THREE.BoxGeometry(0.42, 0.11, 0.08);
  const lightMaterial = new THREE.MeshStandardMaterial({
    color: '#ffd9a1',
    emissive: '#ffb65d',
    emissiveIntensity: 0.42,
    roughness: 0.34,
    metalness: 0.08,
  });
  const lights = new THREE.InstancedMesh(lightGeometry, lightMaterial, portals.length);
  lights.name = 'building-portal-lights';

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const frameColor = new THREE.Color();
  const streetwall = renderer.heroFacadeDiagnostics?.streetwall || null;
  const heroById = new Map((renderer.heroFacadeDiagnostics?.heroes || []).map((entry) => [entry.id, entry]));
  const heroPortalCount = portals.filter((portal) => heroById.has(portal.buildingId)).length;
  const storefrontGlassGeometry = heroPortalCount ? new THREE.BoxGeometry(1, 1, 1) : null;
  const storefrontGlassMaterial = heroPortalCount ? material('#ffffff', { roughness: 0.24, metalness: 0.2 }) : null;
  const storefrontGlass = heroPortalCount
    ? new THREE.InstancedMesh(storefrontGlassGeometry, storefrontGlassMaterial, heroPortalCount * 2)
    : null;
  if (storefrontGlass) {
    storefrontGlass.name = 'hero-storefront-glazing';
    storefrontGlass.castShadow = true;
    storefrontGlass.receiveShadow = true;
  }
  const storefrontTrimGeometry = heroPortalCount ? new THREE.BoxGeometry(1, 1, 1) : null;
  const storefrontTrimMaterial = heroPortalCount ? material('#ffffff', { roughness: 0.52, metalness: 0.12 }) : null;
  const storefrontTrim = heroPortalCount
    ? new THREE.InstancedMesh(storefrontTrimGeometry, storefrontTrimMaterial, heroPortalCount * 5)
    : null;
  if (storefrontTrim) {
    storefrontTrim.name = 'hero-storefront-trim';
    storefrontTrim.castShadow = true;
    storefrontTrim.receiveShadow = true;
  }
  const buildingById = new Map((city?.buildings || []).map((building) => [building.id, building]));
  const portalStyledIds = [];
  const storefrontEntries = [];
  const storefrontBuiltIds = [];
  const signageAtlas = heroPortalCount ? createHeroSignageAtlas() : null;
  const signageQuads = [];
  const signageEntries = [];
  const signageBuiltIds = [];
  let storefrontAbsoluteRoadOverlaps = 0;
  let storefrontAdditionalRoadIntrusions = 0;
  let signageAbsoluteRoadOverlaps = 0;
  let signageAdditionalRoadIntrusions = 0;
  let minimumPortalClearance = Infinity;
  let minimumEdgeClearance = Infinity;
  let minimumSignageCanopyGap = Infinity;
  let minimumSignageEdgeClearance = Infinity;
  let portalPositionsUnchanged = true;
  let portalHeadingsUnchanged = true;
  let frameIndex = 0;
  let storefrontGlassIndex = 0;
  let storefrontTrimIndex = 0;
  const partitionRecords = [];
  portals.forEach((portal, index) => {
    const sourcePosition = [portal.position.x, portal.position.y, portal.position.z];
    const sourceHeading = portal.heading;
    const hero = heroById.get(portal.buildingId) || null;
    const heroStyle = hero?.streetwall
      ? HERO_PORTAL_STYLES[hero.streetwall.atlasCell]
      : null;
    const y = portal.position.y + (heroStyle ? 1.24 : 1.04);
    dummy.position.set(portal.position.x, y, portal.position.z);
    dummy.rotation.set(0, portal.heading, 0);
    if (heroStyle) dummy.translateZ(-0.31);
    dummy.scale.set(heroStyle ? 1.42 : 1, heroStyle ? 1.1 : 1, heroStyle ? 0.7 : 1);
    dummy.updateMatrix();
    panels.setMatrixAt(index, dummy.matrix);
    color.set(heroStyle?.panel || DOOR_COLORS[portal.interior.archetype] || DOOR_COLORS.residential);
    panels.setColorAt(index, color);
    const partitionRecord = {
      index,
      portalId: portal.id,
      buildingId: portal.buildingId,
      x: portal.position.x,
      z: portal.position.z,
      pinned: Boolean(heroStyle),
      panelMatrix: new Float32Array(dummy.matrix.elements),
      panelColor: new Float32Array([color.r, color.g, color.b]),
      frameMatrices: [],
      frameColors: [],
      lightMatrix: null,
    };

    for (const [offsetX, offsetY, scaleX, scaleY, roleColor] of (heroStyle ? [
      [-0.79, -0.07, 0.18, 2.42, heroStyle.frame],
      [0.79, -0.07, 0.18, 2.42, heroStyle.frame],
      [0, 1.12, 1.76, 0.14, heroStyle.frame],
    ] : [
      [-0.59, 0, 0.12, 2.24],
      [0.59, 0, 0.12, 2.24],
      [0, 1.075, 1.3, 0.11],
    ])) {
      dummy.position.set(portal.position.x, y, portal.position.z);
      dummy.rotation.set(0, portal.heading, 0);
      dummy.translateX(offsetX);
      dummy.translateY(offsetY);
      dummy.translateZ(heroStyle ? -0.27 : -0.025);
      dummy.scale.set(scaleX, scaleY, 0.18);
      dummy.updateMatrix();
      frames.setMatrixAt(frameIndex, dummy.matrix);
      frameColor.set(roleColor || '#ffffff');
      frames.setColorAt(frameIndex, frameColor);
      partitionRecord.frameMatrices.push(new Float32Array(dummy.matrix.elements));
      partitionRecord.frameColors.push(new Float32Array([frameColor.r, frameColor.g, frameColor.b]));
      frameIndex += 1;
    }

    dummy.position.set(
      portal.position.x,
      heroStyle ? portal.position.y + 2.12 : y + 1.38,
      portal.position.z,
    );
    dummy.rotation.set(0, portal.heading, 0);
    dummy.translateZ(heroStyle ? -0.255 : -0.1);
    dummy.scale.set(heroStyle ? 3.15 : 1, heroStyle ? 2.2 : 1, heroStyle ? 1.15 : 1);
    dummy.updateMatrix();
    lights.setMatrixAt(index, dummy.matrix);
    partitionRecord.lightMatrix = new Float32Array(dummy.matrix.elements);
    partitionRecords.push(partitionRecord);

    if (heroStyle) {
      const storefront = HERO_STOREFRONT_PROFILES[hero.streetwall.atlasCell];
      const displayOffset = 1.52;
      const displayHeight = 2.08;
      const displayDepth = 0.09;
      const doorHalfWidth = 0.88;
      for (const offsetX of [-displayOffset, displayOffset]) {
        dummy.position.set(portal.position.x, portal.position.y + 1.18, portal.position.z);
        dummy.rotation.set(0, portal.heading, 0);
        dummy.translateX(offsetX);
        dummy.translateZ(-0.34);
        dummy.scale.set(storefront.displayWidth, displayHeight, displayDepth);
        dummy.updateMatrix();
        storefrontGlass.setMatrixAt(storefrontGlassIndex, dummy.matrix);
        storefrontGlass.setColorAt(storefrontGlassIndex, color.set(storefront.glass));
        storefrontGlassIndex += 1;
        const componentClearance = roadClearance(
          portalLocalPoint(portal, offsetX, -0.34 + displayDepth / 2),
          city,
        );
        const portalPlaneClearance = roadClearance(portalLocalPoint(portal, offsetX, 0), city);
        if (componentClearance < 0) storefrontAbsoluteRoadOverlaps += 1;
        if (componentClearance < portalPlaneClearance - 0.02) storefrontAdditionalRoadIntrusions += 1;
      }
      const outerOffset = displayOffset + storefront.displayWidth / 2 + 0.1;
      const trimParts = [
        [-outerOffset, 1.18, 0.12, 2.32, 0.14],
        [-0.82, 1.18, 0.12, 2.32, 0.14],
        [0.82, 1.18, 0.12, 2.32, 0.14],
        [outerOffset, 1.18, 0.12, 2.32, 0.14],
        [0, 2.42, storefront.canopyWidth, 0.28, storefront.canopyDepth],
      ];
      for (const [offsetX, offsetY, scaleX, scaleY, scaleZ] of trimParts) {
        dummy.position.set(portal.position.x, portal.position.y, portal.position.z);
        dummy.rotation.set(0, portal.heading, 0);
        dummy.translateX(offsetX);
        dummy.translateY(offsetY);
        dummy.translateZ(offsetY > 2 ? -0.3 : -0.29);
        dummy.scale.set(scaleX, scaleY, scaleZ);
        dummy.updateMatrix();
        storefrontTrim.setMatrixAt(storefrontTrimIndex, dummy.matrix);
        storefrontTrim.setColorAt(storefrontTrimIndex, frameColor.set(storefront.trim));
        storefrontTrimIndex += 1;
        const offsetZ = offsetY > 2 ? -0.3 : -0.29;
        const componentClearance = roadClearance(
          portalLocalPoint(portal, offsetX, offsetZ + scaleZ / 2),
          city,
        );
        const portalPlaneClearance = roadClearance(portalLocalPoint(portal, offsetX, 0), city);
        if (componentClearance < 0) storefrontAbsoluteRoadOverlaps += 1;
        if (componentClearance < portalPlaneClearance - 0.02) storefrontAdditionalRoadIntrusions += 1;
      }
      const portalClearance = displayOffset - storefront.displayWidth / 2 - doorHalfWidth;
      const building = buildingById.get(portal.buildingId);
      const edgeIndex = Number(portal.sourceMetadata?.edgeIndex);
      const edgeA = building?.polygon?.[edgeIndex];
      const edgeB = building?.polygon?.[(edgeIndex + 1) % building?.polygon?.length];
      const edgeLength = edgeA && edgeB ? Math.hypot(edgeB.x - edgeA.x, edgeB.z - edgeA.z) : NaN;
      const edgeClearance = edgeLength / 2 - Math.max(outerOffset + 0.06, storefront.canopyWidth / 2);
      const signageProfile = HERO_SIGNAGE_PROFILES.get(portal.buildingId);
      const signageWidth = storefront.canopyWidth - 0.34;
      const signageHeight = 0.52;
      const signageCanopyGap = 0.1;
      const signageOffsetZ = -0.46;
      const signageCenterY = portal.position.y + 2.56 + signageCanopyGap + signageHeight / 2;
      const signageEdgeClearance = edgeLength / 2 - signageWidth / 2;
      const signageUvInsetX = 2 / HERO_SIGNAGE_ATLAS_WIDTH;
      const signageUvInsetY = 2 / HERO_SIGNAGE_ATLAS_HEIGHT;
      const signageUv = {
        u0: signageProfile.atlasCell / HERO_SIGNAGE_ATLAS_COLUMNS + signageUvInsetX,
        u1: (signageProfile.atlasCell + 1) / HERO_SIGNAGE_ATLAS_COLUMNS - signageUvInsetX,
        v0: signageUvInsetY,
        v1: 1 - signageUvInsetY,
      };
      const signageCenter = portalLocalPoint(portal, 0, signageOffsetZ);
      const signageLeft = portalLocalPoint(portal, -signageWidth / 2, signageOffsetZ);
      const signageRight = portalLocalPoint(portal, signageWidth / 2, signageOffsetZ);
      let entryAbsoluteRoadOverlaps = 0;
      let entryAdditionalRoadIntrusions = 0;
      for (const offsetX of [-signageWidth / 2, 0, signageWidth / 2]) {
        const componentClearance = roadClearance(portalLocalPoint(portal, offsetX, signageOffsetZ), city);
        const portalPlaneClearance = roadClearance(portalLocalPoint(portal, offsetX, 0), city);
        if (componentClearance < 0) entryAbsoluteRoadOverlaps += 1;
        if (componentClearance < portalPlaneClearance - 0.02) entryAdditionalRoadIntrusions += 1;
      }
      signageAbsoluteRoadOverlaps += entryAbsoluteRoadOverlaps;
      signageAdditionalRoadIntrusions += entryAdditionalRoadIntrusions;
      minimumSignageCanopyGap = Math.min(minimumSignageCanopyGap, signageCanopyGap);
      minimumSignageEdgeClearance = Math.min(minimumSignageEdgeClearance, signageEdgeClearance);
      signageBuiltIds.push(portal.buildingId);
      signageEntries.push({
        id: portal.buildingId,
        label: signageProfile.label,
        atlasCell: signageProfile.atlasCell,
        sourceEdgeIndex: edgeIndex,
        sourceEdgeLength: edgeLength,
        widthMeters: signageWidth,
        heightMeters: signageHeight,
        canopyGapMeters: signageCanopyGap,
        edgeClearanceMeters: signageEdgeClearance,
        portalPlaneOffsetMeters: signageOffsetZ,
        position: { x: signageCenter.x, y: signageCenterY, z: signageCenter.z },
        heading: portal.heading,
        uv: signageUv,
        absoluteRoadOverlaps: entryAbsoluteRoadOverlaps,
        additionalRoadIntrusions: entryAdditionalRoadIntrusions,
        finite: [
          signageProfile.atlasCell,
          edgeIndex,
          edgeLength,
          signageWidth,
          signageHeight,
          signageCanopyGap,
          signageEdgeClearance,
          signageOffsetZ,
          signageCenter.x,
          signageCenterY,
          signageCenter.z,
          portal.heading,
          signageUv.u0,
          signageUv.u1,
          signageUv.v0,
          signageUv.v1,
        ].every(Number.isFinite),
      });
      signageQuads.push({
        uv: signageUv,
        corners: [
          { x: signageLeft.x, y: signageCenterY - signageHeight / 2, z: signageLeft.z },
          { x: signageRight.x, y: signageCenterY - signageHeight / 2, z: signageRight.z },
          { x: signageRight.x, y: signageCenterY + signageHeight / 2, z: signageRight.z },
          { x: signageLeft.x, y: signageCenterY + signageHeight / 2, z: signageLeft.z },
        ],
      });
      minimumPortalClearance = Math.min(minimumPortalClearance, portalClearance);
      minimumEdgeClearance = Math.min(minimumEdgeClearance, edgeClearance);
      storefrontBuiltIds.push(portal.buildingId);
      storefrontEntries.push({
        id: portal.buildingId,
        profile: storefront.key,
        sourceEdgeIndex: edgeIndex,
        sourceEdgeLength: edgeLength,
        displayInstances: 2,
        trimInstances: 5,
        portalClearanceMeters: portalClearance,
        edgeClearanceMeters: edgeClearance,
        finite: [edgeIndex, edgeLength, portalClearance, edgeClearance].every(Number.isFinite),
      });
      portalStyledIds.push(portal.buildingId);
      portalPositionsUnchanged = portalPositionsUnchanged
        && sourcePosition[0] === portal.position.x
        && sourcePosition[1] === portal.position.y
        && sourcePosition[2] === portal.position.z;
      portalHeadingsUnchanged = portalHeadingsUnchanged && sourceHeading === portal.heading;
      hero.entrance = {
        portalId: portal.id,
        portalIndex: index,
        panelInstances: 1,
        frameInstances: 3,
        cueInstances: 1,
        recessedMeters: 0.31,
        revealDepthMeters: 0.04,
        thresholdGapMeters: 0.1,
        transomCue: true,
        positionUnchanged: portalPositionsUnchanged,
        headingUnchanged: portalHeadingsUnchanged,
        finite: [...sourcePosition, sourceHeading, index].every(Number.isFinite),
      };
    }
  });
  const signage = createHeroSignageMesh(signageQuads, signageAtlas);
  for (const mesh of [panels, frames, lights]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }
  for (const mesh of [panels, frames, lights, storefrontGlass, storefrontTrim, signage].filter(Boolean)) {
    if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere?.();
    group.add(mesh);
  }
  if (streetwall) {
    portalStyledIds.sort();
    const exactPortalSet = portalStyledIds.length === streetwall.expectedIds.length
      && portalStyledIds.every((id, index) => id === streetwall.expectedIds[index]);
    streetwall.portalStyledIds = portalStyledIds;
    streetwall.portalPanelInstances = portalStyledIds.length;
    streetwall.portalFrameInstances = portalStyledIds.length * 3;
    streetwall.portalCueInstances = portalStyledIds.length;
    streetwall.portalPositionsUnchanged = exactPortalSet && portalPositionsUnchanged;
    streetwall.portalHeadingsUnchanged = exactPortalSet && portalHeadingsUnchanged;
    streetwall.sourcePortalsUnchanged = streetwall.portalPositionsUnchanged
      && streetwall.portalHeadingsUnchanged;
    storefrontBuiltIds.sort();
    storefrontEntries.sort((a, b) => a.id.localeCompare(b.id));
    streetwall.storefront = {
      pass: 'hero-storefronts-v1',
      expectedIds: [...streetwall.expectedIds],
      builtIds: storefrontBuiltIds,
      skippedIds: streetwall.expectedIds.filter((id) => !storefrontBuiltIds.includes(id)),
      entries: storefrontEntries,
      displayInstances: storefrontGlassIndex,
      trimInstances: storefrontTrimIndex,
      drawGroups: heroPortalCount ? 2 : 0,
      triangles: storefrontGlassIndex * 12 + storefrontTrimIndex * 12,
      geometries: heroPortalCount ? 2 : 0,
      textures: 0,
      materialProfiles: new Set(storefrontEntries.map((entry) => entry.profile)).size,
      minimumPortalClearanceMeters: minimumPortalClearance,
      minimumEdgeClearanceMeters: minimumEdgeClearance,
      absoluteRoadOverlaps: storefrontAbsoluteRoadOverlaps,
      additionalRoadIntrusions: storefrontAdditionalRoadIntrusions,
      sourcePortalsUnchanged: streetwall.sourcePortalsUnchanged,
      finite: storefrontEntries.length === streetwall.expectedIds.length
        && storefrontEntries.every((entry) => entry.finite),
    };
    signageBuiltIds.sort();
    signageEntries.sort((a, b) => a.id.localeCompare(b.id));
    streetwall.signage = {
      schemaVersion: 1,
      pass: 'hero-signage-v1',
      expectedIds: [...streetwall.expectedIds],
      builtIds: signageBuiltIds,
      skippedIds: streetwall.expectedIds.filter((id) => !signageBuiltIds.includes(id)),
      expectedLabels: [...HERO_SIGNAGE_PROFILES.entries()]
        .map(([id, profile]) => ({ id, label: profile.label, atlasCell: profile.atlasCell }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      entries: signageEntries,
      signInstances: signageEntries.length,
      meshCount: signage ? 1 : 0,
      drawGroups: signage ? 1 : 0,
      triangles: signageEntries.length * 2,
      geometries: signage ? 1 : 0,
      textures: signageAtlas ? 1 : 0,
      minimumCanopyGapMeters: minimumSignageCanopyGap,
      minimumEdgeClearanceMeters: minimumSignageEdgeClearance,
      absoluteRoadOverlaps: signageAbsoluteRoadOverlaps,
      additionalRoadIntrusions: signageAdditionalRoadIntrusions,
      sourcePortalsUnchanged: streetwall.sourcePortalsUnchanged,
      portalPositionsUnchanged: streetwall.portalPositionsUnchanged,
      portalHeadingsUnchanged: streetwall.portalHeadingsUnchanged,
      atlas: {
        kind: signageAtlas?.userData.kind || null,
        width: signageAtlas?.userData.width || 0,
        height: signageAtlas?.userData.height || 0,
        columns: signageAtlas?.userData.columns || 0,
        rows: signageAtlas?.userData.rows || 0,
        cells: signageAtlas?.userData.cells || 0,
        colorSpace: signageAtlas?.colorSpace || null,
        sharedTexture: Boolean(signage && signage.material.map === signageAtlas),
      },
      incremental: {
        drawGroups: signage ? 1 : 0,
        triangles: signageEntries.length * 2,
        geometries: signage ? 1 : 0,
        textures: signageAtlas ? 1 : 0,
        instances: signageEntries.length,
      },
      finite: signageEntries.length === streetwall.expectedIds.length
        && signageEntries.every((entry) => entry.finite),
    };
  }
  renderer.root.add(group);
  renderer.registerPortalPartition?.({
    group,
    panels,
    frames,
    lights,
    storefrontGlass,
    storefrontTrim,
    records: partitionRecords,
    sourceSnapshotBefore: portalSourceSnapshot,
    sourceSnapshotAfter: JSON.stringify(portals),
  });
  return group;
}

function createSurfaceTexture(seedText, kind) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const seed = Math.floor(seededUnit(`${seedText}:${kind}`) * 0xffffffff) >>> 0;
  let value = seed || 1;
  const random = () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0xffffffff;
  };
  if (kind === 'marble') {
    context.fillStyle = '#c2b8a8';
    context.fillRect(0, 0, 128, 128);
    for (let index = 0; index < 20; index += 1) {
      context.strokeStyle = `rgba(231,220,201,${0.08 + random() * 0.14})`;
      context.lineWidth = 0.5 + random() * 1.2;
      context.beginPath();
      const startY = random() * 128;
      context.moveTo(-8, startY);
      context.bezierCurveTo(36, startY - 18 + random() * 36, 78, startY - 16 + random() * 32, 136, startY + (random() - 0.5) * 28);
      context.stroke();
    }
    context.strokeStyle = 'rgba(69,61,53,0.12)';
    context.lineWidth = 1;
    for (let line = 0; line <= 128; line += 32) {
      context.beginPath();
      context.moveTo(line, 0);
      context.lineTo(line, 128);
      context.stroke();
      context.beginPath();
      context.moveTo(0, line);
      context.lineTo(128, line);
      context.stroke();
    }
  } else if (kind === 'wood') {
    context.fillStyle = '#70402d';
    context.fillRect(0, 0, 128, 128);
    for (let index = 0; index < 32; index += 1) {
      const y = index * 4 + random() * 2;
      context.strokeStyle = `rgba(239,179,118,${0.035 + random() * 0.08})`;
      context.beginPath();
      context.moveTo(0, y);
      context.bezierCurveTo(36, y - 2 + random() * 4, 84, y - 2 + random() * 4, 128, y);
      context.stroke();
    }
  } else if (kind === 'fabric') {
    context.fillStyle = '#31525e';
    context.fillRect(0, 0, 128, 128);
    for (let index = 0; index < 64; index += 2) {
      context.strokeStyle = 'rgba(210,229,226,0.045)';
      context.beginPath();
      context.moveTo(index, 0);
      context.lineTo(index, 128);
      context.stroke();
      context.beginPath();
      context.moveTo(0, index);
      context.lineTo(128, index);
      context.stroke();
    }
  } else if (kind === 'stone') {
    context.fillStyle = '#a8a19a';
    context.fillRect(0, 0, 128, 128);
    for (let index = 0; index < 850; index += 1) {
      const shade = 136 + Math.floor(random() * 46);
      context.fillStyle = `rgba(${shade},${shade - 2},${shade - 5},0.2)`;
      context.fillRect(random() * 128, random() * 128, 1.2, 1.2);
    }
  } else if (kind === 'rug') {
    context.fillStyle = '#6e342f';
    context.fillRect(0, 0, 128, 128);
    context.strokeStyle = 'rgba(224,177,132,0.16)';
    context.lineWidth = 2;
    context.strokeRect(8, 8, 112, 112);
    context.strokeRect(14, 14, 100, 100);
    for (let index = 0; index < 420; index += 1) {
      context.fillStyle = `rgba(236,205,177,${0.025 + random() * 0.04})`;
      context.fillRect(random() * 128, random() * 128, 1, 1);
    }
  } else {
    context.fillStyle = '#d8d0c2';
    context.fillRect(0, 0, 128, 128);
    for (let index = 0; index < 1800; index += 1) {
      const shade = Math.floor(178 + random() * 36);
      context.fillStyle = `rgba(${shade},${shade - 5},${shade - 12},0.08)`;
      context.fillRect(random() * 128, random() * 128, 1, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  const repeat = kind === 'marble' ? [4, 6] : kind === 'wood' ? [3, 3] : kind === 'fabric' ? [5, 5] : [3, 3];
  texture.repeat.set(repeat[0], repeat[1]);
  texture.anisotropy = 4;
  return texture;
}

function createSignTexture(portal) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const context = canvas.getContext('2d');
  context.fillStyle = '#172129';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#bd9760';
  context.lineWidth = 5;
  context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  context.fillStyle = '#f3e5ca';
  context.textAlign = 'center';
  context.font = '600 24px system-ui, sans-serif';
  context.fillText('SAN FRANCISCO', 256, 56);
  context.fillStyle = '#bd9760';
  context.font = '700 34px system-ui, sans-serif';
  const label = String(portal.label || portal.street?.name || 'CITY LOBBY').toUpperCase().slice(0, 27);
  context.fillText(label, 256, 112, 454);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function createSfArtTexture(seedText, exteriorContext) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 300;
  const context = canvas.getContext('2d');
  const warm = seededUnit(seedText) > 0.5;
  context.fillStyle = warm ? '#b44a35' : '#315d70';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#b9c7c9';
  context.fillRect(0, 0, canvas.width, 116);
  context.fillStyle = '#53636a';
  context.beginPath();
  context.moveTo(0, 116);
  context.lineTo(215, 62);
  context.lineTo(310, 84);
  context.lineTo(512, 40);
  context.lineTo(512, 150);
  context.lineTo(0, 150);
  context.fill();
  context.fillStyle = '#f0d4a1';
  context.fillRect(0, 224, canvas.width, 76);
  context.fillStyle = '#4a4e50';
  context.fillRect(0, 164, canvas.width, 62);
  context.strokeStyle = '#ded1b9';
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(0, 202);
  context.lineTo(512, 202);
  context.stroke();
  context.strokeStyle = '#f5e3bd';
  context.lineWidth = 7;
  context.beginPath();
  context.moveTo(84, 182);
  context.lineTo(84, 60);
  context.moveTo(428, 182);
  context.lineTo(428, 60);
  context.moveTo(58, 98);
  context.bezierCurveTo(168, 152, 344, 152, 454, 98);
  context.stroke();
  context.lineWidth = 3;
  for (let x = 104; x < 428; x += 40) {
    context.beginPath();
    context.moveTo(x, 124 + Math.abs(266 - x) * 0.18);
    context.lineTo(x, 182);
    context.stroke();
  }
  context.fillStyle = '#172129';
  context.font = '700 26px system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText('THE CITY BY THE BAY', 256, 274);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const image = new Image();
  let acceptsImage = true;
  image.decoding = 'async';
  image.onload = () => {
    if (!acceptsImage) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight * 0.76;
    context.drawImage(
      image,
      0,
      0,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    texture.needsUpdate = true;
    exteriorContext.ready = true;
  };
  image.onerror = () => {
    if (!acceptsImage) return;
    exteriorContext.error = 'load-failed';
  };
  image.src = '/assets/sf-lobby-exterior-backdrop-generated-v1.png';
  texture.userData.cancelPendingLoad = () => {
    acceptsImage = false;
    image.onload = null;
    image.onerror = null;
  };
  return texture;
}

function createContactShadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 62);
  gradient.addColorStop(0, 'rgba(255,255,255,0.94)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.68)');
  gradient.addColorStop(0.78, 'rgba(255,255,255,0.2)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

export function createStreamedInterior(renderer, portal, cityBounds) {
  const descriptor = portal.interior.rooms[0];
  const width = THREE.MathUtils.clamp(Number(descriptor.width) || 13, 11, 16);
  const depth = THREE.MathUtils.clamp(Number(descriptor.depth) || 17, 14, 22);
  const height = 4.15;
  const anchor = {
    x: Number(cityBounds?.maxX || 0) + 260,
    y: 18,
    z: Number(cityBounds?.maxZ || 0) + 260,
  };
  const group = new THREE.Group();
  group.name = 'active-building-interior';
  const materials = new Set();
  const exteriorContext = {
    source: 'generated-sf-soma-v1',
    texture: '/assets/sf-lobby-exterior-backdrop-generated-v1.png',
    ready: false,
  };
  const textures = [
    createSurfaceTexture(portal.id, 'marble'),
    createSurfaceTexture(portal.id, 'plaster'),
    createSurfaceTexture(portal.id, 'wood'),
    createSurfaceTexture(portal.id, 'fabric'),
    createSurfaceTexture(portal.id, 'stone'),
    createSurfaceTexture(portal.id, 'rug'),
    createSignTexture(portal),
    createSfArtTexture(portal.id, exteriorContext),
    createContactShadowTexture(),
  ];
  const makeMaterial = (color, options = {}) => {
    const surface = material(color, options);
    materials.add(surface);
    return surface;
  };
  const palette = ROOM_PALETTES[portal.interior.archetype] || ROOM_PALETTES.residential;
  const surfaces = {
    floor: makeMaterial('#b5a28c', { map: textures[0], roughness: 0.3, metalness: 0.04 }),
    wall: makeMaterial(palette.wall, { map: textures[1], roughness: 0.84, metalness: 0 }),
    ceiling: makeMaterial('#f4efe6', { emissive: '#ffffff', emissiveIntensity: 0.3, roughness: 0.9, metalness: 0 }),
    trim: makeMaterial('#30383c', { roughness: 0.42, metalness: 0.38 }),
    wood: makeMaterial('#f4dfc9', { map: textures[2], bumpMap: textures[2], bumpScale: 0.025, roughness: 0.38, metalness: 0.04 }),
    stone: makeMaterial('#d8d3cb', { map: textures[4], bumpMap: textures[4], bumpScale: 0.018, roughness: 0.24, metalness: 0.08 }),
    glass: makeMaterial('#f6fbfa', {
      transparent: true,
      opacity: 0.075,
      depthWrite: false,
      roughness: 0.025,
      metalness: 0.04,
    }),
    brass: makeMaterial('#b68a49', { roughness: 0.26, metalness: 0.72 }),
    fabric: makeMaterial('#e0edf0', { map: textures[3], bumpMap: textures[3], bumpScale: 0.035, roughness: 0.92, metalness: 0 }),
    rug: makeMaterial('#f0d5d0', { map: textures[5], bumpMap: textures[5], bumpScale: 0.025, roughness: 0.96, metalness: 0 }),
    foliage: makeMaterial('#355c43', { roughness: 0.82, metalness: 0 }),
    terracotta: makeMaterial('#8b5441', { roughness: 0.78, metalness: 0 }),
    safety: makeMaterial('#a63a32', { roughness: 0.48, metalness: 0.1 }),
    light: makeMaterial('#fff1c9', { emissive: '#ffd08a', emissiveIntensity: 1.2, roughness: 0.32, metalness: 0 }),
    sign: makeMaterial('#ffffff', { map: textures[6], emissive: '#6a5333', emissiveIntensity: 0.18, roughness: 0.38, metalness: 0.06 }),
    art: makeMaterial('#ffffff', { map: textures[7], roughness: 0.5, metalness: 0.02 }),
    screen: makeMaterial('#182a32', { emissive: '#68a4b5', emissiveIntensity: 0.34, roughness: 0.18, metalness: 0.12 }),
    indicator: makeMaterial('#ffcf8a', { emissive: '#ff9d3d', emissiveIntensity: 0.85, roughness: 0.3, metalness: 0.1 }),
    body: makeMaterial('#ffffff', { roughness: 0.86, metalness: 0 }),
    head: makeMaterial('#ffffff', { roughness: 0.7, metalness: 0 }),
    luggage: makeMaterial('#ffffff', { roughness: 0.6, metalness: 0.08 }),
  };
  const add = (options) => addBox(group, options);
  const addInstances = (name, category, surface, records, geometry = INTERIOR_BOX_GEOMETRY) => {
    const mesh = new THREE.InstancedMesh(geometry, surface, records.length);
    mesh.name = name;
    mesh.userData.category = category;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const instance = new THREE.Object3D();
    const tint = new THREE.Color();
    records.forEach((record, index) => {
      instance.position.set(record.position[0], record.position[1], record.position[2]);
      instance.rotation.set(...(record.rotation || [0, 0, 0]));
      instance.scale.set(record.size[0], record.size[1], record.size[2]);
      instance.updateMatrix();
      mesh.setMatrixAt(index, instance.matrix);
      if (record.color) {
        tint.set(record.color);
        mesh.setColorAt(index, tint);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere?.();
    group.add(mesh);
    return mesh;
  };

  const backZ = anchor.z - depth / 2;
  const frontZ = anchor.z + depth / 2;
  const leftX = anchor.x - width / 2;
  const rightX = anchor.x + width / 2;
  const corridorDepth = 3.8;
  const corridorHalf = 1.1;
  const corridorHeight = 2.7;
  const openingZ = anchor.z + depth * 0.16;
  const segALength = depth * 0.66 - corridorHalf;
  const segBLength = depth * 0.34 - corridorHalf;
  const streetGrade = (seededUnit(`${portal.id}:street-grade`) > 0.5 ? 1 : -1)
    * (0.035 + seededUnit(`${portal.id}:street-grade-strength`) * 0.025);
  const exteriorBackdropZ = frontZ + 7.1;

  addInstances('lobby-floor-marble', 'floor', surfaces.floor, [
    { position: [anchor.x, anchor.y - 0.09, anchor.z], size: [width, 0.18, depth] },
    { position: [rightX + corridorDepth / 2, anchor.y - 0.09, openingZ], size: [corridorDepth, 0.18, corridorHalf * 2] },
    {
      position: [anchor.x, anchor.y - 0.07, frontZ + 0.72],
      size: [width + 7, 0.14, 1.45],
      rotation: [0, 0, streetGrade],
      color: '#aaa59b',
    },
    {
      position: [anchor.x, anchor.y - 0.13, frontZ + 3.45],
      size: [width + 10, 0.12, 4.0],
      rotation: [0, 0, streetGrade],
      color: '#343a3c',
    },
    {
      position: [anchor.x, anchor.y - 0.07, frontZ + 5.85],
      size: [width + 10, 0.14, 0.82],
      rotation: [0, 0, streetGrade],
      color: '#9a968d',
    },
    {
      position: [anchor.x, anchor.y - 0.04, frontZ + 3.48],
      size: [width + 9, 0.03, 0.07],
      rotation: [0, 0, streetGrade],
      color: '#d8c9a6',
    },
  ]);
  add({ name: 'lobby-coffered-ceiling', category: 'ceiling', size: [width, 0.14, depth], position: [anchor.x, anchor.y + height, anchor.z], surface: surfaces.ceiling });
  const frontSection = Math.max(1.2, (width - 6.2) / 2);
  addInstances('lobby-wall-shell', 'wall', surfaces.wall, [
    { position: [anchor.x, anchor.y + height / 2, backZ], size: [width, height, 0.18] },
    { position: [leftX, anchor.y + height / 2, anchor.z], size: [0.18, height, depth] },
    { position: [anchor.x - (width + 6.2) / 4, anchor.y + height / 2, frontZ], size: [frontSection, height, 0.18] },
    { position: [anchor.x + (width + 6.2) / 4, anchor.y + height / 2, frontZ], size: [frontSection, height, 0.18] },
    { position: [rightX, anchor.y + height / 2, anchor.z - depth / 2 + segALength / 2], size: [0.18, height, segALength] },
    { position: [rightX, anchor.y + height / 2, openingZ + corridorHalf + segBLength / 2], size: [0.18, height, segBLength] },
    { position: [rightX, anchor.y + corridorHeight + (height - corridorHeight) / 2, openingZ], size: [0.18, height - corridorHeight, corridorHalf * 2] },
    { position: [rightX + corridorDepth / 2, anchor.y + corridorHeight / 2, openingZ - corridorHalf], size: [corridorDepth, corridorHeight, 0.18] },
    { position: [rightX + corridorDepth / 2, anchor.y + corridorHeight / 2, openingZ + corridorHalf], size: [corridorDepth, corridorHeight, 0.18] },
    { position: [rightX + corridorDepth, anchor.y + corridorHeight / 2, openingZ], size: [0.18, corridorHeight, corridorHalf * 2] },
    { position: [rightX + corridorDepth / 2, anchor.y + corridorHeight + 0.07, openingZ], size: [corridorDepth, 0.14, corridorHalf * 2] },
    { position: [anchor.x - 3.11, anchor.y + 2.0, frontZ - 0.48], size: [0.28, 4.0, 0.94], color: '#c6bcae' },
    { position: [anchor.x + 3.11, anchor.y + 2.0, frontZ - 0.48], size: [0.28, 4.0, 0.94], color: '#c6bcae' },
    { position: [anchor.x, anchor.y + 4.02, frontZ - 0.48], size: [6.5, 0.24, 0.94], color: '#c6bcae' },
  ]);
  addInstances('lobby-trim-baseboards', 'trim', surfaces.trim, [
    { position: [anchor.x, anchor.y + 0.09, backZ + 0.13], size: [width - 0.2, 0.18, 0.1] },
    { position: [leftX + 0.13, anchor.y + 0.09, anchor.z], size: [0.1, 0.18, depth - 0.2] },
    { position: [rightX - 0.13, anchor.y + 0.09, anchor.z - depth / 2 + segALength / 2], size: [0.1, 0.18, Math.max(0.2, segALength - 0.1)] },
    { position: [rightX - 0.13, anchor.y + 0.09, openingZ + corridorHalf + segBLength / 2], size: [0.1, 0.18, Math.max(0.2, segBLength - 0.1)] },
    { position: [anchor.x, anchor.y + height - 0.12, backZ + 0.16], size: [width - 0.24, 0.24, 0.2] },
    { position: [leftX + 0.16, anchor.y + height - 0.12, anchor.z], size: [0.2, 0.24, depth - 0.24] },
    { position: [rightX - 0.16, anchor.y + height - 0.12, anchor.z - depth / 2 + segALength / 2], size: [0.2, 0.24, Math.max(0.2, segALength - 0.14)] },
    { position: [rightX - 0.16, anchor.y + height - 0.12, openingZ + corridorHalf + segBLength / 2], size: [0.2, 0.24, Math.max(0.2, segBLength - 0.14)] },
    { position: [anchor.x - (width + 6.2) / 4, anchor.y + height - 0.12, frontZ - 0.16], size: [frontSection, 0.24, 0.2] },
    { position: [anchor.x + (width + 6.2) / 4, anchor.y + height - 0.12, frontZ - 0.16], size: [frontSection, 0.24, 0.2] },
    {
      position: [anchor.x, anchor.y + 0.035, frontZ + 1.45],
      size: [width + 8, 0.07, 0.1],
      rotation: [0, 0, streetGrade],
      color: '#66625b',
    },
    {
      position: [anchor.x, anchor.y - 0.045, frontZ + 2.8],
      size: [width + 9, 0.035, 0.045],
      rotation: [0, 0, streetGrade],
      color: '#857259',
    },
    {
      position: [anchor.x, anchor.y - 0.045, frontZ + 4.05],
      size: [width + 9, 0.035, 0.045],
      rotation: [0, 0, streetGrade],
      color: '#857259',
    },
  ]);
  addInstances('lobby-back-wall-pilasters', 'architecture', surfaces.brass, [
    { position: [anchor.x - width * 0.46, anchor.y + height / 2, backZ + 0.18], size: [0.18, height - 0.22, 0.18] },
    { position: [anchor.x + width * 0.08, anchor.y + height / 2, backZ + 0.18], size: [0.18, height - 0.22, 0.18] },
    { position: [anchor.x - width * 0.19, anchor.y + 3.48, backZ + 0.18], size: [width * 0.54, 0.16, 0.18] },
    { position: [anchor.x - width * 0.43, anchor.y + 2.65, frontZ + 3.25], size: [0.08, 5.3, 0.08], color: '#293236' },
    { position: [anchor.x + width * 0.43, anchor.y + 2.65, frontZ + 3.25], size: [0.08, 5.3, 0.08], color: '#293236' },
    { position: [anchor.x, anchor.y + 5.05, frontZ + 3.25], size: [width + 5.5, 0.045, 0.045], rotation: [0, 0, streetGrade], color: '#293236' },
  ], INTERIOR_ROUNDED_GEOMETRY);
  const cofferHalfWidth = width * 0.38;
  const cofferHalfDepth = depth * 0.38;
  addInstances('lobby-ceiling-coffers', 'ceiling', surfaces.wood, [
    ...[-1, 0, 1].map((column) => ({
      position: [anchor.x + column * cofferHalfWidth, anchor.y + height - 0.14, anchor.z],
      size: [0.22, 0.28, cofferHalfDepth * 2],
    })),
    ...[-1, 0, 1].map((row) => ({
      position: [anchor.x, anchor.y + height - 0.14, anchor.z + row * cofferHalfDepth],
      size: [cofferHalfWidth * 2, 0.28, 0.22],
    })),
  ], INTERIOR_ROUNDED_GEOMETRY);

  const doorZ = frontZ - 0.08;
  const doorPivotOffset = 1.4;
  const doorLeafWidth = 1.35;
  const doorLeafHalfWidth = doorLeafWidth / 2;
  const doorMaxAngle = THREE.MathUtils.degToRad(86);
  const interiorBounds = {
    minX: anchor.x - width / 2 + 0.45,
    maxX: anchor.x + width / 2 - 0.45,
    minZ: anchor.z - depth / 2 + 0.45,
    maxZ: frontZ - 0.45,
  };
  const glassLeafSpecs = [-1, 1].map((side) => ({
    side,
    localX: -side * doorLeafHalfWidth,
    y: anchor.y + 1.34,
    size: [doorLeafWidth, 2.65, 0.08],
  }));
  const closedDoorRecord = (spec) => ({
    position: [anchor.x + spec.side * doorPivotOffset + spec.localX, spec.y, doorZ],
    size: spec.size,
    color: spec.color,
  });
  const glazing = addInstances('lobby-glazing', 'glass', surfaces.glass, [
    { position: [anchor.x - 2.25, anchor.y + 1.48, doorZ], size: [1.45, 2.9, 0.06] },
    { position: [anchor.x + 2.25, anchor.y + 1.48, doorZ], size: [1.45, 2.9, 0.06] },
    ...glassLeafSpecs.map(closedDoorRecord),
    { position: [anchor.x, anchor.y + 3.55, doorZ], size: [6.02, 0.86, 0.06] },
  ]);
  const fixedDoorFrameRecords = [
    { position: [anchor.x, anchor.y + 3.02, doorZ - 0.015], size: [6.2, 0.18, 0.18] },
    { position: [anchor.x, anchor.y + 4.0, doorZ - 0.015], size: [6.2, 0.18, 0.18] },
    { position: [anchor.x - 3.02, anchor.y + 1.52, doorZ - 0.015], size: [0.18, 3.16, 0.18] },
    { position: [anchor.x + 3.02, anchor.y + 1.52, doorZ - 0.015], size: [0.18, 3.16, 0.18] },
    { position: [anchor.x - 1.42, anchor.y + 1.45, doorZ - 0.015], size: [0.1, 2.96, 0.16] },
    { position: [anchor.x + 1.42, anchor.y + 1.45, doorZ - 0.015], size: [0.1, 2.96, 0.16] },
    { position: [anchor.x, anchor.y + 0.06, doorZ - 0.015], size: [6.2, 0.12, 0.2] },
    { position: [anchor.x, anchor.y + 0.09, doorZ - 0.4], size: [6.0, 0.1, 0.72], color: '#8c714b' },
    { position: [anchor.x - 3.0, anchor.y + 1.95, doorZ - 0.42], size: [0.12, 3.86, 0.74], color: '#95774e' },
    { position: [anchor.x + 3.0, anchor.y + 1.95, doorZ - 0.42], size: [0.12, 3.86, 0.74], color: '#95774e' },
    { position: [anchor.x, anchor.y + 3.92, doorZ - 0.42], size: [6.12, 0.12, 0.74], color: '#95774e' },
  ];
  const leafFrameSpecs = [-1, 1].flatMap((side) => [
    {
      side,
      localX: -side * (doorLeafWidth - 0.04),
      y: anchor.y + 1.34,
      size: [0.07, 2.66, 0.12],
      color: '#b28e59',
    },
    {
      side,
      localX: -side * doorLeafHalfWidth,
      y: anchor.y + 2.64,
      size: [doorLeafWidth, 0.07, 0.12],
      color: '#b28e59',
    },
    {
      side,
      localX: -side * doorLeafHalfWidth,
      y: anchor.y + 0.055,
      size: [doorLeafWidth, 0.07, 0.12],
      color: '#b28e59',
    },
    {
      side,
      localX: -side * (doorLeafWidth - 0.3),
      y: anchor.y + 1.36,
      size: [0.045, 0.72, 0.12],
      color: '#d6c08e',
    },
  ]);
  const doorFraming = addInstances('lobby-door-framing', 'door', surfaces.brass, [
    ...fixedDoorFrameRecords,
    ...leafFrameSpecs.map(closedDoorRecord),
  ], INTERIOR_ROUNDED_GEOMETRY);
  const doorState = {
    kind: 'paired-swing-glass',
    leafCount: 2,
    pivot: 'side',
    direction: 'outward',
    progress: 0,
    angleDegrees: 0,
    clearOpeningMeters: 0.1,
    thresholdZ: doorZ,
    insideMaxZ: frontZ - 0.45,
    outsideMaxZ: frontZ + 1.15,
    isOpen: false,
    isClosed: true,
    operable: true,
    disposed: false,
  };
  const doorMatrix = new THREE.Object3D();
  const writeDoorInstance = (mesh, index, spec, angle) => {
    doorMatrix.position.set(anchor.x + spec.side * doorPivotOffset, spec.y, doorZ);
    doorMatrix.rotation.set(0, spec.side * angle, 0);
    doorMatrix.scale.set(1, 1, 1);
    doorMatrix.translateX(spec.localX);
    doorMatrix.scale.set(spec.size[0], spec.size[1], spec.size[2]);
    doorMatrix.updateMatrix();
    mesh.setMatrixAt(index, doorMatrix.matrix);
  };
  let doorDisposed = false;
  const setDoorOpen = (value = 1) => {
    if (doorDisposed) return false;
    const numeric = Number(value);
    const progress = THREE.MathUtils.clamp(Number.isFinite(numeric) ? numeric : 0, 0, 1);
    const angle = doorMaxAngle * progress;
    glassLeafSpecs.forEach((spec, index) => writeDoorInstance(glazing, index + 2, spec, angle));
    leafFrameSpecs.forEach((spec, index) => {
      writeDoorInstance(doorFraming, fixedDoorFrameRecords.length + index, spec, angle);
    });
    glazing.instanceMatrix.needsUpdate = true;
    doorFraming.instanceMatrix.needsUpdate = true;
    glazing.computeBoundingSphere?.();
    doorFraming.computeBoundingSphere?.();
    doorState.progress = progress;
    doorState.angleDegrees = THREE.MathUtils.radToDeg(angle);
    doorState.clearOpeningMeters = Math.max(
      0,
      2 * (doorPivotOffset - doorLeafWidth * Math.cos(angle)),
    );
    doorState.isOpen = progress >= 0.999;
    doorState.isClosed = progress <= 0.001;
    interiorBounds.maxZ = progress >= 0.75 ? doorState.outsideMaxZ : doorState.insideMaxZ;
    doorState.operable = true;
    doorState.disposed = false;
    return doorState;
  };
  setDoorOpen(0);

  const deskX = anchor.x - width * 0.17;
  const deskZ = anchor.z - depth * 0.25;
  add({ name: 'lobby-reception-desk', category: 'reception', size: [5.2, 1.02, 0.86], position: [deskX, anchor.y + 0.51, deskZ], surface: surfaces.wood, rounded: true });
  add({ name: 'lobby-reception-counter', category: 'reception', size: [5.5, 0.11, 1.05], position: [deskX, anchor.y + 1.08, deskZ], surface: surfaces.stone, rounded: true });
  add({ name: 'lobby-reception-plinth', category: 'reception', size: [3.0, 0.18, 0.98], position: [deskX, anchor.y + 0.09, deskZ], surface: surfaces.brass, rounded: true });
  addInstances('lobby-reception-terminals', 'equipment', surfaces.screen, [
    { position: [deskX - 1.2, anchor.y + 1.38, deskZ - 0.24], size: [0.62, 0.46, 0.12] },
    { position: [deskX + 1.2, anchor.y + 1.38, deskZ - 0.24], size: [0.62, 0.46, 0.12] },
  ], INTERIOR_ROUNDED_GEOMETRY);

  const sign = new THREE.Mesh(INTERIOR_PLANE_GEOMETRY, surfaces.sign);
  sign.name = 'lobby-san-francisco-sign';
  sign.userData.category = 'signage';
  sign.position.set(deskX, anchor.y + 2.55, backZ + 0.11);
  sign.scale.set(4.6, 1.35, 1);
  group.add(sign);

  const liftLeftX = anchor.x + width * 0.23;
  const liftRightX = anchor.x + width * 0.38;
  const liftCenterX = (liftLeftX + liftRightX) / 2;
  const liftBankWidth = liftRightX - liftLeftX + 2.0;
  const liftFaceZ = backZ + 0.44;
  addInstances('lobby-elevator-doors', 'elevator', surfaces.trim, [
    { position: [liftLeftX, anchor.y + 1.28, liftFaceZ], size: [1.5, 2.55, 0.1] },
    { position: [liftRightX, anchor.y + 1.28, liftFaceZ], size: [1.5, 2.55, 0.1] },
  ], INTERIOR_ROUNDED_GEOMETRY);
  addInstances('lobby-elevator-surround', 'elevator', surfaces.stone, [
    { position: [liftLeftX - 1.0, anchor.y + 1.65, backZ + 0.25], size: [0.24, 3.3, 0.5] },
    { position: [liftRightX + 1.0, anchor.y + 1.65, backZ + 0.25], size: [0.24, 3.3, 0.5] },
    { position: [liftCenterX, anchor.y + 1.65, backZ + 0.25], size: [0.24, 3.3, 0.5] },
    { position: [liftCenterX, anchor.y + 3.12, backZ + 0.25], size: [liftBankWidth - 0.24, 0.44, 0.5] },
    { position: [liftCenterX, anchor.y + 0.08, backZ + 0.28], size: [liftBankWidth, 0.16, 0.56] },
    { position: [liftLeftX, anchor.y + 3.22, backZ + 0.26], size: [1.82, 0.18, 0.54] },
    { position: [liftRightX, anchor.y + 3.22, backZ + 0.26], size: [1.82, 0.18, 0.54] },
  ], INTERIOR_ROUNDED_GEOMETRY);
  addInstances('lobby-elevator-indicators', 'elevator', surfaces.indicator, [
    { position: [liftLeftX, anchor.y + 2.86, backZ + 0.52], size: [0.44, 0.18, 0.06] },
    { position: [liftRightX, anchor.y + 2.86, backZ + 0.52], size: [0.44, 0.18, 0.06] },
    { position: [liftCenterX, anchor.y + 1.32, backZ + 0.52], size: [0.12, 0.22, 0.06] },
  ]);

  addInstances('lobby-corridor-frames', 'trim', surfaces.trim, [
    ...[0.12, corridorDepth * 0.36, corridorDepth * 0.7].flatMap((offset) => [
      { position: [rightX + offset, anchor.y + corridorHeight / 2, openingZ - corridorHalf + 0.09], size: [0.14, corridorHeight, 0.14] },
      { position: [rightX + offset, anchor.y + corridorHeight / 2, openingZ + corridorHalf - 0.09], size: [0.14, corridorHeight, 0.14] },
      { position: [rightX + offset, anchor.y + corridorHeight - 0.07, openingZ], size: [0.14, 0.16, corridorHalf * 2 - 0.04] },
    ]),
    { position: [rightX + corridorDepth - 0.1, anchor.y + 1.17, openingZ], size: [0.1, 2.34, 1.5] },
    { position: [rightX + corridorDepth - 0.16, anchor.y + 1.17, openingZ], size: [0.14, 0.08, 1.62] },
  ], INTERIOR_ROUNDED_GEOMETRY);

  add({ name: 'lobby-vestibule-soffit', category: 'vestibule', size: [6.2, 0.34, 2.0], position: [anchor.x, anchor.y + height - 0.17, frontZ - 1.09], surface: surfaces.wood, rounded: true });
  addInstances('lobby-vestibule-columns', 'vestibule', surfaces.stone, [-1, 1].map((side) => ({
    position: [anchor.x + side * 2.7, anchor.y + (height - 0.34) / 2, frontZ - 1.6],
    size: [0.55, height - 0.34, 0.55],
  })), INTERIOR_CYLINDER_GEOMETRY);
  const queueNearZ = anchor.z + depth * 0.12;
  const queueFarZ = anchor.z + depth * 0.3;
  addInstances('lobby-queue-stanchions', 'vestibule', surfaces.brass, [
    ...[-1.7, 1.7].flatMap((offsetX) => [queueNearZ, queueFarZ].flatMap((z) => [
      { position: [anchor.x + offsetX, anchor.y + 0.48, z], size: [0.07, 0.96, 0.07] },
      { position: [anchor.x + offsetX, anchor.y + 0.05, z], size: [0.34, 0.1, 0.34] },
    ])),
    ...[-1.7, 1.7].map((offsetX) => ({
      position: [anchor.x + offsetX, anchor.y + 0.82, (queueNearZ + queueFarZ) / 2],
      size: [0.08, 0.08, queueFarZ - queueNearZ],
      color: '#8f2637',
    })),
  ], INTERIOR_ROUNDED_GEOMETRY);

  const sofaZ = anchor.z + depth * 0.06;
  const sofaCenters = [-1, 1].map((side) => anchor.x + side * width * 0.29);
  addInstances('lobby-sofa-frames', 'seating', surfaces.fabric, sofaCenters.flatMap((x) => [
    { position: [x, anchor.y + 0.34, sofaZ], size: [2.65, 0.38, 0.94] },
    { position: [x, anchor.y + 0.88, sofaZ + 0.35], size: [2.65, 0.78, 0.24] },
  ]), INTERIOR_ROUNDED_GEOMETRY);
  addInstances('lobby-sofa-arms', 'seating', surfaces.fabric, sofaCenters.flatMap((x) => [-1, 1].map((side) => ({
    position: [x + side * 1.24, anchor.y + 0.62, sofaZ], size: [0.2, 0.62, 0.94],
  }))), INTERIOR_ROUNDED_GEOMETRY);
  addInstances('lobby-sofa-cushions', 'seating', surfaces.fabric, sofaCenters.flatMap((x) => [-1, 1].map((side) => ({
    position: [x + side * 0.62, anchor.y + 0.57, sofaZ - 0.03], size: [1.14, 0.2, 0.78],
  }))), INTERIOR_ROUNDED_GEOMETRY);
  addInstances('lobby-sofa-legs', 'seating', surfaces.brass, sofaCenters.flatMap((x) => [-1, 1].flatMap((sideX) => [-1, 1].map((sideZ) => ({
    position: [x + sideX * 1.12, anchor.y + 0.12, sofaZ + sideZ * 0.32], size: [0.08, 0.24, 0.08],
  })))), INTERIOR_ROUNDED_GEOMETRY);
  const tableCenters = [-1, 1].map((side) => anchor.x + side * width * 0.13);
  addInstances('lobby-table-tops', 'table', surfaces.stone, tableCenters.map((x) => ({
    position: [x, anchor.y + 0.42, sofaZ - 0.1], size: [1.25, 0.12, 0.72],
  })), INTERIOR_ROUNDED_GEOMETRY);
  addInstances('lobby-table-pedestals', 'table', surfaces.brass, tableCenters.map((x) => ({
    position: [x, anchor.y + 0.21, sofaZ - 0.1], size: [0.16, 0.42, 0.16],
  })), INTERIOR_ROUNDED_GEOMETRY);
  addInstances('lobby-runner-rug', 'rug', surfaces.rug, [
    { position: [anchor.x - width * 0.04, anchor.y + 0.02, anchor.z + depth * 0.17], size: [2.25, 0.035, Math.min(3.8, depth * 0.23)] },
    { position: [rightX + corridorDepth / 2, anchor.y + 0.02, openingZ], size: [corridorDepth - 0.2, 0.03, corridorHalf * 2 - 1.0] },
  ], INTERIOR_ROUNDED_GEOMETRY);

  const planterSpots = [-1, 1].map((side) => [anchor.x + side * width * 0.4, anchor.z - depth * 0.34]);
  addInstances('lobby-planters', 'greenery', surfaces.terracotta, planterSpots.map(([x, z]) => ({
    position: [x, anchor.y + 0.46, z], size: [0.76, 0.9, 0.76],
  })), INTERIOR_CYLINDER_GEOMETRY);
  addInstances('lobby-foliage', 'greenery', surfaces.foliage, planterSpots.map(([x, z]) => ({
    position: [x, anchor.y + 1.35, z], size: [1.05, 1.6, 1.05],
  })), INTERIOR_SPHERE_GEOMETRY);

  const artOffset = (seededUnit(portal.id) - 0.5) * 0.6;
  const art = new THREE.InstancedMesh(INTERIOR_PLANE_GEOMETRY, surfaces.art, 3);
  art.name = 'lobby-sf-exterior-context';
  art.userData.category = 'exterior-context';
  const artDummy = new THREE.Object3D();
  [-1, 1].forEach((side, index) => {
    artDummy.position.set(anchor.x + side * (width / 2 - 0.11), anchor.y + 2.15, anchor.z - depth * (0.1 + artOffset * 0.02));
    artDummy.rotation.set(0, side < 0 ? Math.PI / 2 : -Math.PI / 2, 0);
    artDummy.scale.set(1.7, 1.28, 1);
    artDummy.updateMatrix();
    art.setMatrixAt(index, artDummy.matrix);
  });
  artDummy.position.set(anchor.x, anchor.y + 3.56, exteriorBackdropZ);
  artDummy.rotation.set(0, Math.PI, 0);
  artDummy.scale.set(width + 7.8, 7.12, 1);
  artDummy.updateMatrix();
  art.setMatrixAt(2, artDummy.matrix);
  art.instanceMatrix.needsUpdate = true;
  art.computeBoundingSphere?.();
  group.add(art);
  add({ name: 'lobby-fire-safety', category: 'safety', size: [0.24, 0.7, 0.2], position: [leftX + 0.28, anchor.y + 0.65, anchor.z - depth * 0.05], surface: surfaces.safety, rounded: true });

  const suitColors = ['#33404c', '#54392c', '#5c3038', '#2f4d56', '#6a6052'];
  const skinColors = ['#e6b28a', '#c88f66', '#8d5f41', '#efc9a1'];
  const pick = (list, salt) => list[Math.floor(seededUnit(`${portal.id}:${salt}`) * list.length) % list.length];
  const liftGuestX = anchor.x + width * 0.3;
  const liftGuestZ = anchor.z - depth * 0.4;
  const arrivalX = anchor.x - width * 0.05;
  const arrivalZ = anchor.z + depth * 0.1;
  const standingPerson = (x, z, color, pose = 0) => [
    { position: [x, anchor.y + 1.12, z], size: [0.72, 0.82, 0.5], color },
    { position: [x - 0.12, anchor.y + 0.47, z], size: [0.22, 0.94, 0.22], color },
    { position: [x + 0.12, anchor.y + 0.47, z], size: [0.22, 0.94, 0.22], color },
    { position: [x - 0.27, anchor.y + 1.08, z], size: [0.18, 0.72, 0.18], rotation: [0, 0, 0.12 + pose], color },
    { position: [x + 0.27, anchor.y + 1.08, z], size: [0.18, 0.72, 0.18], rotation: [0, 0, -0.12 + pose], color },
  ];
  const staffX = deskX + 0.45;
  const staffZ = deskZ - 0.8;
  const seatedX = sofaCenters[0] + 0.55;
  const seatedZ = sofaZ - 0.02;
  const staffColor = '#2c3a46';
  const seatedColor = pick(suitColors, 'seated-coat');
  const liftColor = pick(suitColors, 'lift-coat');
  const arrivalColor = pick(suitColors, 'arrival-coat');
  addInstances('lobby-occupant-bodies', 'occupants', surfaces.body, [
    ...standingPerson(staffX, staffZ, staffColor, -0.05),
    { position: [seatedX, anchor.y + 1.08, seatedZ], size: [0.7, 0.72, 0.48], color: seatedColor },
    { position: [seatedX - 0.13, anchor.y + 0.34, seatedZ - 0.3], size: [0.2, 0.64, 0.2], color: seatedColor },
    { position: [seatedX + 0.13, anchor.y + 0.34, seatedZ - 0.3], size: [0.2, 0.64, 0.2], color: seatedColor },
    { position: [seatedX - 0.26, anchor.y + 1.05, seatedZ], size: [0.17, 0.64, 0.17], rotation: [0, 0, 0.2], color: seatedColor },
    { position: [seatedX + 0.26, anchor.y + 1.05, seatedZ], size: [0.17, 0.64, 0.17], rotation: [0, 0, -0.2], color: seatedColor },
    ...standingPerson(liftGuestX, liftGuestZ, liftColor, 0.04),
    ...standingPerson(arrivalX, arrivalZ, arrivalColor, -0.03),
  ], INTERIOR_CYLINDER_GEOMETRY);
  addInstances('lobby-occupant-heads', 'occupants', surfaces.head, [
    { position: [staffX, anchor.y + 1.72, staffZ], size: [0.46, 0.5, 0.46], color: pick(skinColors, 'staff-skin') },
    { position: [seatedX, anchor.y + 1.58, seatedZ], size: [0.44, 0.48, 0.44], color: pick(skinColors, 'seated-skin') },
    { position: [liftGuestX, anchor.y + 1.72, liftGuestZ], size: [0.46, 0.5, 0.46], color: pick(skinColors, 'lift-skin') },
    { position: [arrivalX, anchor.y + 1.72, arrivalZ], size: [0.46, 0.5, 0.46], color: pick(skinColors, 'arrival-skin') },
  ], INTERIOR_SPHERE_GEOMETRY);
  addInstances('lobby-luggage', 'luggage', surfaces.luggage, [
    { position: [liftGuestX + 0.5, anchor.y + 0.31, liftGuestZ + 0.08], size: [0.44, 0.62, 0.26], color: '#74462f' },
    { position: [liftGuestX + 0.86, anchor.y + 0.22, liftGuestZ + 0.2], size: [0.34, 0.44, 0.22], color: '#3d4a54' },
    { position: [liftGuestX + 0.5, anchor.y + 0.72, liftGuestZ + 0.08], size: [0.06, 0.25, 0.06], color: '#74462f' },
    { position: [liftGuestX + 0.5, anchor.y + 0.84, liftGuestZ + 0.08], size: [0.24, 0.05, 0.06], color: '#74462f' },
    { position: [liftGuestX + 0.86, anchor.y + 0.52, liftGuestZ + 0.2], size: [0.05, 0.18, 0.05], color: '#3d4a54' },
    { position: [liftGuestX + 0.86, anchor.y + 0.61, liftGuestZ + 0.2], size: [0.2, 0.04, 0.05], color: '#3d4a54' },
  ], INTERIOR_ROUNDED_GEOMETRY);

  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: '#21160f',
    alphaMap: textures[8],
    transparent: true,
    opacity: 0.56,
    depthWrite: false,
  });
  materials.add(shadowMaterial);
  const shadowSpots = [
    [anchor.x - width * 0.29, sofaZ, 3.2, 1.35],
    [anchor.x + width * 0.29, sofaZ, 3.2, 1.35],
    [anchor.x - width * 0.4, anchor.z - depth * 0.34, 1.45, 1.45],
    [anchor.x + width * 0.4, anchor.z - depth * 0.34, 1.45, 1.45],
    [deskX, deskZ, 5.4, 1.2],
    [deskX + 0.45, deskZ - 0.8, 0.62, 0.62],
    [sofaCenters[0] + 0.55, sofaZ - 0.02, 0.6, 0.6],
    [liftGuestX, liftGuestZ, 0.62, 0.62],
    [liftGuestX + 0.66, liftGuestZ + 0.14, 1.1, 0.6],
    [arrivalX, arrivalZ, 0.62, 0.62],
    [anchor.x - 2.7, frontZ - 1.6, 1.0, 1.0],
    [anchor.x + 2.7, frontZ - 1.6, 1.0, 1.0],
    [anchor.x, frontZ - 0.34, 5.8, 0.82],
    [anchor.x, frontZ + 0.48, 5.6, 0.72],
  ];
  const contactShadows = new THREE.InstancedMesh(INTERIOR_SHADOW_GEOMETRY, shadowMaterial, shadowSpots.length);
  contactShadows.name = 'lobby-contact-shadows';
  contactShadows.userData.category = 'grounding';
  const shadowDummy = new THREE.Object3D();
  shadowSpots.forEach(([x, z, scaleX, scaleZ], index) => {
    shadowDummy.position.set(x, anchor.y + 0.012, z);
    shadowDummy.rotation.set(-Math.PI / 2, 0, 0);
    shadowDummy.scale.set(scaleX, scaleZ, 1);
    shadowDummy.updateMatrix();
    contactShadows.setMatrixAt(index, shadowDummy.matrix);
  });
  contactShadows.instanceMatrix.needsUpdate = true;
  contactShadows.computeBoundingSphere?.();
  group.add(contactShadows);

  const fixtureRecords = [
    ...Array.from({ length: 4 }, (_, index) => ({
      position: [anchor.x + (index % 2 ? cofferHalfWidth / 2 : -cofferHalfWidth / 2), anchor.y + height - 0.3, anchor.z + (index < 2 ? cofferHalfDepth / 2 : -cofferHalfDepth / 2)],
      size: [1.82, 0.08, 0.68],
    })),
    { position: [rightX + corridorDepth / 2, anchor.y + corridorHeight - 0.09, openingZ], size: [0.62, 0.08, 1.5] },
  ];
  addInstances('lobby-fixture-bezels', 'lighting', surfaces.trim, fixtureRecords, INTERIOR_ROUNDED_GEOMETRY);
  const panelRecords = [
    ...Array.from({ length: 4 }, (_, index) => ({
      position: [anchor.x + (index % 2 ? cofferHalfWidth / 2 : -cofferHalfWidth / 2), anchor.y + height - 0.32, anchor.z + (index < 2 ? cofferHalfDepth / 2 : -cofferHalfDepth / 2)],
      size: [1, 1, 1],
    })),
    { position: [rightX + corridorDepth / 2, anchor.y + corridorHeight - 0.11, openingZ], size: [0.42, 1, 1.55] },
  ];
  addInstances('lobby-ceiling-fixtures', 'lighting', surfaces.light, panelRecords, INTERIOR_PANEL_GEOMETRY);
  for (let index = 0; index < 4; index += 1) {
    const light = new THREE.PointLight(0xffd7a2, 2.4, 10, 2);
    light.name = 'lobby-fixture-light';
    light.userData.category = 'lighting';
    light.position.set(anchor.x + (index % 2 ? cofferHalfWidth / 2 : -cofferHalfWidth / 2), anchor.y + height - 0.48, anchor.z + (index < 2 ? cofferHalfDepth / 2 : -cofferHalfDepth / 2));
    group.add(light);
  }
  const interiorFill = new THREE.HemisphereLight(0xfff4e7, 0x685a4b, 0.72);
  interiorFill.name = 'lobby-neutral-fill';
  interiorFill.userData.category = 'lighting';
  group.add(interiorFill);

  const propCategories = [...new Set(group.children.map((child) => child.userData.category).filter(Boolean))].sort();
  group.userData = {
    kind: 'streamed-building-interior',
    buildingId: portal.buildingId,
    portalId: portal.id,
    roomId: descriptor.id,
    archetype: portal.interior.archetype,
    propCategories,
    exteriorContext,
    doorState,
    dispose: () => {
      doorDisposed = true;
      doorState.operable = false;
      doorState.disposed = true;
      for (const surface of materials) surface.dispose();
      for (const texture of textures) {
        texture.userData.cancelPendingLoad?.();
        texture.dispose();
      }
    },
  };
  renderer.root.add(group);
  const lobbyView = {
    x: anchor.x - width * 0.18,
    z: anchor.z + depth / 2 - 5.35,
    yaw: Math.atan2(deskX - (anchor.x - width * 0.18), deskZ - (anchor.z + depth / 2 - 5.35)),
    pitch: -0.04,
  };
  const entranceView = {
    x: anchor.x + width * 0.15,
    z: anchor.z - depth / 2 + 4.8,
    yaw: Math.atan2(anchor.x - (anchor.x + width * 0.15), doorZ - (anchor.z - depth / 2 + 4.8)),
    pitch: -0.03,
  };
  return {
    group,
    floorY: anchor.y,
    setDoorOpen,
    doorState,
    spawn: lobbyView,
    views: { lobby: lobbyView, entrance: entranceView },
    bounds: interiorBounds,
    meshes: group.children.filter((child) => child.isMesh).length,
  };
}

export function disposeStreamedInterior(renderer, active) {
  if (!active?.group) return;
  active.group.parent?.remove(active.group);
  active.group.userData.dispose?.();
}
