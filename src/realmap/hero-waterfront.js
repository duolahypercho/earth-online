import * as THREE from 'three';

/**
 * Ferry waterfront depth is an explicit visualization of the embedded DataSF
 * shoreline edge. It is not a survey claim about a seawall, pier, or rail:
 * every centre line comes from `mask.shorelineSegments`, and the dimensions
 * below only give that classified boundary a readable depth in the hero view.
 */
export const FERRY_WATERFRONT_PRESENTATION = Object.freeze({
  landSideCapDepthM: 0.72,
  waterSideBandDepthM: 1.6,
  faceDepthM: 0.9,
  topLiftM: 0.2,
  minSegmentLengthM: 0.08,
  collision: false,
  source: 'DataSF shoreline segment centre lines',
});

function landNormal(mask, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < FERRY_WATERFRONT_PRESENTATION.minSegmentLengthM) return null;
  const x = -dz / length;
  const z = dx / length;
  const midpoint = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
  const probe = FERRY_WATERFRONT_PRESENTATION.landSideCapDepthM + 0.12;
  if (mask.isLand(midpoint.x + x * probe, midpoint.z + z * probe)) return { x, z };
  if (mask.isLand(midpoint.x - x * probe, midpoint.z - z * probe)) return { x: -x, z: -z };
  return null;
}

/**
 * Returns a single low-cost edge mesh. Its line centre is exact source data;
 * only its shallow land-side cap and vertical face are presentation geometry.
 */
export function createFerryWaterfrontEdge({ mask, elevationAt, seaLevelY }) {
  if (!mask?.shorelineSegments?.length || typeof elevationAt !== 'function' || !Number.isFinite(seaLevelY)) {
    return null;
  }

  const {
    landSideCapDepthM,
    waterSideBandDepthM,
    faceDepthM,
    topLiftM,
  } = FERRY_WATERFRONT_PRESENTATION;
  const positions = [];
  const colors = [];
  const indices = [];
  const capColor = new THREE.Color(0x5f625d);
  const faceColor = new THREE.Color(0x384346);
  const waterlineColor = new THREE.Color(0x2f626b);
  const add = (point, y, color) => {
    const index = positions.length / 3;
    positions.push(point.x, y, point.z);
    colors.push(color.r, color.g, color.b);
    return index;
  };
  let segments = 0;

  for (const { a, b } of mask.shorelineSegments) {
    const normal = landNormal(mask, a, b);
    if (!normal) continue;
    const landA = { x: a.x + normal.x * landSideCapDepthM, z: a.z + normal.z * landSideCapDepthM };
    const landB = { x: b.x + normal.x * landSideCapDepthM, z: b.z + normal.z * landSideCapDepthM };
    const waterA = { x: a.x - normal.x * waterSideBandDepthM, z: a.z - normal.z * waterSideBandDepthM };
    const waterB = { x: b.x - normal.x * waterSideBandDepthM, z: b.z - normal.z * waterSideBandDepthM };
    const edgeAY = Math.max(seaLevelY + topLiftM, elevationAt(a.x, a.z) + topLiftM);
    const edgeBY = Math.max(seaLevelY + topLiftM, elevationAt(b.x, b.z) + topLiftM);
    const landAY = Math.max(seaLevelY + topLiftM, elevationAt(landA.x, landA.z) + topLiftM);
    const landBY = Math.max(seaLevelY + topLiftM, elevationAt(landB.x, landB.z) + topLiftM);
    const faceAY = seaLevelY - faceDepthM;
    const faceBY = seaLevelY - faceDepthM;
    const base = positions.length / 3;
    add(landA, landAY, capColor);
    add(landB, landBY, capColor);
    add(a, edgeAY, capColor);
    add(b, edgeBY, capColor);
    add(a, faceAY, faceColor);
    add(b, faceBY, faceColor);
    add(waterA, seaLevelY + 0.025, waterlineColor);
    add(waterB, seaLevelY + 0.025, waterlineColor);
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    indices.push(base + 2, base + 3, base + 4, base + 3, base + 5, base + 4);
    // A flat styling band on the classified water side makes the exact source
    // boundary legible from the locked hero camera. It is not bathymetry,
    // foam, or surveyed construction; its bounded width is presentation-only.
    indices.push(base + 2, base + 6, base + 3, base + 3, base + 6, base + 7);
    segments += 1;
  }
  if (!positions.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.04,
    side: THREE.DoubleSide,
  }));
  mesh.name = 'Ferry DataSF shoreline edge visualization';
  mesh.receiveShadow = true;
  mesh.userData = {
    type: 'waterfront-source-edge',
    sourceAligned: true,
    source: FERRY_WATERFRONT_PRESENTATION.source,
    presentationOnly: true,
    affectsCollision: false,
    segments,
    vertices: positions.length / 3,
    ...FERRY_WATERFRONT_PRESENTATION,
  };
  return mesh;
}
