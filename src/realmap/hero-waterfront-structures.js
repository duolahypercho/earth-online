import * as THREE from 'three';

/**
 * Exact horizontal outline of OSM way/661723975 (`man_made=pier`) from the
 * byte-locked local SanFrancisco.osm.pbf snapshot.  The card04 camera faces
 * this outline, but the generic ground mesh otherwise obscures it.
 */
export const FERRY_CARD04_PIER_SOURCE = Object.freeze({
  source: 'OpenStreetMap contributors',
  sourceWayId: 661723975,
  tags: Object.freeze({ area: 'yes', man_made: 'pier' }),
  rawPbfSha256: 'dda3821dd92f8d8bf34abe503ac81f20a439ee02a210a9d68d2c7c5d66fb0cae',
  // OSM PBF coordinates have a 1e-7-degree granularity. This digest is of
  // the way ID, sorted tags, node sequence, and coordinates quantized to that
  // native precision, avoiding JavaScript binary-float display noise.
  geometrySha256: 'e4233d2191bf0aa9922422f618e751ba86ea5603a81b8f078744fd60eccd137c',
  atlasProjection: Object.freeze({
    originLon: -122.4194,
    originLat: 37.778,
    metresPerDegreeLon: 87986.24747640654,
    metresPerDegreeLat: 110574,
  }),
  coordinatesLonLat: Object.freeze([
    [-122.3922524, 37.7947783], [-122.3923541, 37.7948927], [-122.3912155, 37.7957882],
    [-122.3916145, 37.7962153], [-122.3919532, 37.7960598], [-122.3919601, 37.79607],
    [-122.3919763, 37.796064], [-122.3920058, 37.7960498], [-122.3920756, 37.7960082],
    [-122.3925344, 37.7958043], [-122.3925814, 37.7957835], [-122.3926321, 37.7957596],
    [-122.3928783, 37.79565], [-122.3930076, 37.7955923], [-122.3934493, 37.7960697],
    [-122.3933799, 37.7961111], [-122.3933912, 37.7961229], [-122.3933499, 37.7961476],
    [-122.3933874, 37.7961868], [-122.3934283, 37.7961624], [-122.3934436, 37.7961784],
    [-122.3935121, 37.7961375], [-122.3938093, 37.7964584], [-122.3937391, 37.7964997],
    [-122.3937961, 37.7965602], [-122.3943687, 37.7962246], [-122.394397, 37.7962082],
    [-122.3929774, 37.7946754], [-122.3924978, 37.7942863], [-122.3921191, 37.7945032],
    [-122.3918736, 37.7942409], [-122.3916384, 37.7939896], [-122.391936, 37.7938168],
    [-122.3919229, 37.7938028], [-122.3919079, 37.7937867], [-122.3916119, 37.7939586],
    [-122.3915678, 37.7939112], [-122.3915542, 37.7939], [-122.3915359, 37.7938941],
    [-122.3915162, 37.7938944], [-122.3914983, 37.7939008], [-122.3914851, 37.7939124],
    [-122.3914788, 37.7939272], [-122.3914805, 37.7939427], [-122.3914898, 37.7939565],
    [-122.3915221, 37.7939914], [-122.3914085, 37.7940573], [-122.391435, 37.794086],
    [-122.3914597, 37.7941123], [-122.3915732, 37.7940464], [-122.3915865, 37.7940606],
    [-122.3918444, 37.7943387], [-122.3918603, 37.7943558], [-122.3917445, 37.794423],
    [-122.39177, 37.7944511], [-122.3917955, 37.7944778], [-122.3919113, 37.7944107],
    [-122.3919259, 37.7944258], [-122.392184, 37.794705], [-122.3921976, 37.7947193],
    [-122.3920764, 37.7947894], [-122.392101, 37.7948169], [-122.392131, 37.7948484],
    [-122.3922524, 37.7947783],
  ].map((point) => Object.freeze(point))),
});

export const FERRY_CARD04_PIER_PRESENTATION = Object.freeze({
  deckLiftM: 0.08,
  deckThicknessM: 0.16,
  collision: false,
  verticalStatus: 'presentation-only; vertically uncertified',
  exclusions: Object.freeze(['not bathymetry', 'not a seawall', 'not a boat', 'no railings', 'no piles']),
  renderBudget: Object.freeze({ meshes: 1, maxTriangles: 256, shadowCasters: 0 }),
});

function localPoint([lon, lat]) {
  const frame = FERRY_CARD04_PIER_SOURCE.atlasProjection;
  return {
    x: (lon - frame.originLon) * frame.metresPerDegreeLon,
    z: (lat - frame.originLat) * frame.metresPerDegreeLat,
  };
}

/**
 * Builds one exact-outline deck with only a shallow visual thickness.  Source
 * data supplies no height, so neither lift nor thickness is factual geometry.
 */
export function createFerryCard04PierDeck({ elevationAt } = {}) {
  if (typeof elevationAt !== 'function') return null;
  const outline = FERRY_CARD04_PIER_SOURCE.coordinatesLonLat.slice(0, -1).map(localPoint);
  const triangles = THREE.ShapeUtils.triangulateShape(outline.map(({ x, z }) => new THREE.Vector2(x, z)), []);
  if (!triangles.length) return null;

  const { deckLiftM, deckThicknessM, renderBudget } = FERRY_CARD04_PIER_PRESENTATION;
  const top = outline.map(({ x, z }) => ({ x, y: elevationAt(x, z) + deckLiftM, z }));
  const positions = [];
  const indices = [];
  for (const point of top) positions.push(point.x, point.y, point.z);
  for (const point of top) positions.push(point.x, point.y - deckThicknessM, point.z);
  for (const triangle of triangles) indices.push(...triangle);
  const count = top.length;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    indices.push(index, next, count + index, next, count + next, count + index);
  }
  const triangleCount = indices.length / 3;
  if (triangleCount > renderBudget.maxTriangles) throw new Error('Card04 pier deck exceeded its render budget');

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0x5b615c,
    roughness: 0.91,
    metalness: 0.02,
    side: THREE.DoubleSide,
  }));
  mesh.name = 'Ferry Card04 OSM pier deck 661723975';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.userData = {
    type: 'waterfront-osm-pier-deck',
    sourceAligned: true,
    source: FERRY_CARD04_PIER_SOURCE.source,
    sourceWayId: FERRY_CARD04_PIER_SOURCE.sourceWayId,
    rawPbfSha256: FERRY_CARD04_PIER_SOURCE.rawPbfSha256,
    geometrySha256: FERRY_CARD04_PIER_SOURCE.geometrySha256,
    horizontalCoordinates: 'exact locked OSM way longitude/latitude projected with sf-atlas-linear-v1',
    presentationOnly: true,
    verticalStatus: FERRY_CARD04_PIER_PRESENTATION.verticalStatus,
    deckLiftM,
    deckThicknessM,
    affectsCollision: false,
    exclusions: [...FERRY_CARD04_PIER_PRESENTATION.exclusions],
    renderBudget: { ...renderBudget },
    vertices: top.length * 2,
    triangles: triangleCount,
  };
  return mesh;
}

export function disposeFerryCard04PierDeck(mesh) {
  if (mesh?.userData?.type !== 'waterfront-osm-pier-deck') return;
  mesh.geometry?.dispose();
  mesh.material?.dispose();
}
