const SOURCE_TONE_POLICY_SHA256 = 'sha256:2972f0a33f4a32ff9e62f60b8cc7d4a5e575c337cc46e4dd559a12bb4722ef68';
const SOURCE_TONE_CONTRACT_SHA256 = 'sha256:bb73511cba751485555f40f69e19bf6bea5d7ba104fb97d80db1fe17c7f7b13e';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function exactObject(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function fail(tileId, message) {
  throw new Error(`${tileId} ${message}`);
}

function sha256(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function normalizeAuthorizationReference(value, tileId) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.length
    || typeof value.path !== 'string' || !/^public\/data\/world\/source-locks\/[a-z0-9._-]+\.json$/i.test(value.path)
    || !sha256(value.sha256)) fail(tileId, 'source-tone production authorization reference is invalid');
  return deepFreeze({ id: value.id, path: value.path, sha256: value.sha256.toLowerCase() });
}

function normalizeBoundaryMask(value, tileId) {
  if (!value || typeof value !== 'object'
    || value.id !== 'source-tone-legacy-grid-boundary-mask-v1'
    || value.adjacencyPolicy !== 'static-manifest-cardinal-neighbours-v1'
    || value.residencyInput !== false
    || value.tileSizeMetres !== 384 || value.exactMatchBandMetres !== 4
    || value.blendBandMetres !== 16 || value.legacyGridCellMetres !== 62) {
    fail(tileId, 'source-tone boundary mask does not match the reviewed static v1 policy');
  }
  const sides = [...new Set(value.legacyNeighbourSides ?? [])].sort();
  const neighbours = [...new Set(value.legacyNeighbourTileIds ?? [])].sort();
  const closure = [...new Set(value.directClosureTileIds ?? [])].sort();
  const sharedWays = [...new Set(value.directSharedBuildingWayIds ?? [])].sort((a, b) => a - b);
  if (!sides.length || !sides.every((side) => ['east', 'north', 'south', 'west'].includes(side))) fail(tileId, 'source-tone boundary mask has invalid cardinal sides');
  if (neighbours.length !== sides.length || !neighbours.every((id) => typeof id === 'string' && id.startsWith('epsg26910-'))) fail(tileId, 'source-tone boundary mask neighbour inventory is invalid');
  if (!closure.length || !closure.every((id) => typeof id === 'string' && id.startsWith('epsg26910-'))) fail(tileId, 'source-tone boundary mask closure inventory is invalid');
  if (!sharedWays.length || !sharedWays.every((id) => Number.isSafeInteger(id) && id >= 0)) fail(tileId, 'source-tone boundary mask shared source-way inventory is invalid');
  if (!value.seamLedger || typeof value.seamLedger.path !== 'string'
    || !/^public\/data\/world\/preview-artifacts\/[a-z0-9._/-]+$/i.test(value.seamLedger.path)
    || value.seamLedger.path.includes('..') || !sha256(value.seamLedger.sha256)) fail(tileId, 'source-tone boundary mask seam ledger is not byte-locked');
  return deepFreeze({
    id: value.id,
    adjacencyPolicy: value.adjacencyPolicy,
    residencyInput: false,
    tileSizeMetres: 384,
    exactMatchBandMetres: 4,
    blendBandMetres: 16,
    legacyGridCellMetres: 62,
    legacyNeighbourSides: sides,
    legacyNeighbourTileIds: neighbours,
    directClosureTileIds: closure,
    directSharedBuildingWayIds: sharedWays,
    seamLedger: { path: value.seamLedger.path, sha256: value.seamLedger.sha256.toLowerCase() },
  });
}

export const SF_BUILDING_SOURCE_TONE_POLICY_V1 = deepFreeze({
  id: 'osm-way-id-modulo-4-v1',
  formula: 'Number(BigInt(sourceOsmWayId) % 4n)',
  input: 'byte-locked OSM source way identity',
  outputDomain: [0, 3],
  presentationOnly: true,
  sourceColourClaim: false,
});

export const SF_BUILDING_SOURCE_TONE_POLICY_SHA256_V1 = SOURCE_TONE_POLICY_SHA256;

export const SF_BUILDING_SOURCE_TONE_CONTRACT_V1 = deepFreeze({
  schema: 'sf-building-source-tone-v1',
  status: 'presentation-schema-only',
  attribute: {
    gltfSemantic: '_SF_SOURCE_TONE_V1',
    threeAttributeName: '_sf_source_tone_v1',
    componentType: 5121,
    type: 'SCALAR',
    normalized: false,
    domain: [0, 3],
  },
  payloadOrder: {
    id: 'gltf-mesh-index-then-primitive-index-v1',
    association: 'GLTFLoader parser.associations {meshes,primitives}',
    reusedMeshPolicy: 'deduplicate-only-when-attribute-bytes-match',
  },
  derivation: {
    ...SF_BUILDING_SOURCE_TONE_POLICY_V1,
    policySha256: SF_BUILDING_SOURCE_TONE_POLICY_SHA256_V1,
  },
});

export const SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1 = SOURCE_TONE_CONTRACT_SHA256;

export const SF_MAP_LEGACY_BUILDING_PRESENTATION = deepFreeze({
  mode: 'legacy',
  status: 'legacy-implicit',
});

export function sourceToneV1ForOsmWayId(sourceOsmWayId) {
  if (!Number.isSafeInteger(sourceOsmWayId) || sourceOsmWayId < 0) {
    throw new Error(`OSM way identity ${sourceOsmWayId} is not a safe non-negative integer`);
  }
  return Number(BigInt(sourceOsmWayId) % 4n);
}

export function normalizeTilePresentation(rawPresentation, tileId = 'metric tile') {
  if (rawPresentation == null) return SF_MAP_LEGACY_BUILDING_PRESENTATION;
  if (!rawPresentation || typeof rawPresentation !== 'object') fail(tileId, 'presentation descriptor is not an object');
  if (rawPresentation.mode === 'legacy') {
    if (rawPresentation.contract != null || rawPresentation.contractSha256 != null) fail(tileId, 'legacy presentation must not declare a source-tone contract');
    return deepFreeze({ mode: 'legacy', status: rawPresentation.status || 'legacy-explicit' });
  }
  if (rawPresentation.mode !== 'source-tone-v1') fail(tileId, `presentation mode ${rawPresentation.mode ?? 'missing'} is unsupported`);
  if (rawPresentation.productionWriteEnabled !== true || rawPresentation.productionPromotionAuthorized !== true) fail(tileId, 'source-tone presentation is not production-authorized');
  if (rawPresentation.contractSha256 !== SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1) fail(tileId, 'source-tone manifest contract SHA-256 does not match the reviewed schema');
  if (!exactObject(rawPresentation.contract, SF_BUILDING_SOURCE_TONE_CONTRACT_V1)) fail(tileId, 'source-tone manifest contract does not match the reviewed schema');
  const authorization = normalizeAuthorizationReference(rawPresentation.authorization, tileId);
  const boundaryMask = normalizeBoundaryMask(rawPresentation.boundaryMask, tileId);
  return deepFreeze({
    mode: 'source-tone-v1',
    status: 'production-authorized',
    productionWriteEnabled: true,
    productionPromotionAuthorized: true,
    contractSha256: SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1,
    contract: SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
    authorization,
    boundaryMask,
  });
}

export function verifyReceiptPresentation(receipt, descriptorPresentation, tileId = 'metric tile') {
  if (descriptorPresentation.mode === 'legacy') {
    if (receipt?.presentation != null) fail(tileId, 'legacy descriptor is paired with an undeclared presentation receipt');
    return { mode: 'legacy', status: descriptorPresentation.status };
  }
  const presentation = receipt?.presentation;
  if (!presentation || presentation.mode !== 'source-tone-v1') fail(tileId, 'source-tone receipt declaration is missing');
  if (presentation.productionWriteEnabled !== true || presentation.productionPromotionAuthorized !== true) {
    fail(tileId, 'source-tone receipt is not authorized for production');
  }
  if (presentation.contractSha256 !== descriptorPresentation.contractSha256) fail(tileId, 'source-tone receipt contract SHA-256 does not match the manifest');
  if (!exactObject(presentation.contract, descriptorPresentation.contract)) fail(tileId, 'source-tone receipt contract does not match the manifest');
  if (!exactObject(presentation.authorization, descriptorPresentation.authorization)) fail(tileId, 'source-tone receipt authorization does not match the manifest');
  if (!exactObject(presentation.boundaryMask, descriptorPresentation.boundaryMask)) fail(tileId, 'source-tone receipt boundary mask does not match the manifest');
  if (!/^sha256:[a-f0-9]{64}$/i.test(presentation.ledgers?.sourceToneAttributeSha256 || '')) fail(tileId, 'source-tone receipt does not bind the attribute payload with SHA-256');
  return { mode: 'source-tone-v1', status: 'verified-production-authorization', sourceToneAttributeSha256: presentation.ledgers.sourceToneAttributeSha256 };
}

export function verifyProductionPresentationAuthorization(authorization, descriptor, presentationIntegrity, tileId = descriptor?.id || 'metric tile') {
  const expected = descriptor?.presentation?.authorization;
  if (!expected || authorization?.kind !== 'sf-building-source-tone-production-authorization'
    || authorization.id !== expected.id || authorization.status !== 'production-authorized-bounded-ferry-mixed-mode'
    || authorization.productionWriteEnabled !== true || authorization.productionPromotionAuthorized !== true) {
    fail(tileId, 'source-tone production authorization document is invalid');
  }
  if (authorization.tile?.id !== tileId || !exactObject(authorization.tile.gridIndex, descriptor.gridIndex)
    || !exactObject(authorization.tile.originEpsg26910VerticalMetres, descriptor.origin)
    || authorization.tile.horizontalCrs !== 'EPSG:26910' || authorization.tile.unitsPerMetre !== 1) {
    fail(tileId, 'source-tone authorization metric tile identity drifted');
  }
  if (authorization.presentation?.contractSha256 !== descriptor.presentation.contractSha256
    || authorization.presentation?.policySha256 !== descriptor.presentation.contract.derivation.policySha256
    || authorization.presentation?.sourceToneAttributeSha256 !== presentationIntegrity.sourceToneAttributeSha256
    || authorization.candidateProof?.glb?.sha256 !== descriptor.glbSha256) {
    fail(tileId, 'source-tone authorization artifact or presentation ledger drifted');
  }
  if (!exactObject(normalizeBoundaryMask(authorization.boundaryMask, tileId), descriptor.presentation.boundaryMask)) {
    fail(tileId, 'source-tone authorization boundary mask drifted');
  }
  return { id: authorization.id, status: authorization.status, sha256: expected.sha256 };
}

export function verifyParsedGlbPresentation(gltf, descriptorPresentation, tileId = 'metric tile') {
  const glbPresentation = gltf?.parser?.json?.extras?.presentation;
  if (descriptorPresentation.mode === 'legacy') {
    if (glbPresentation != null) fail(tileId, 'legacy descriptor parsed a GLB with undeclared presentation metadata');
    return;
  }
  if (!exactObject(glbPresentation, descriptorPresentation.contract)) fail(tileId, 'GLB presentation contract does not match the manifest');
}

export function verifyParsedGlbMetricContract(gltf, descriptor, tileId = descriptor?.id || 'metric tile') {
  const extras = gltf?.parser?.json?.extras;
  if (!extras || extras.tileId !== descriptor.id || extras.horizontalCrs !== 'EPSG:26910' || extras.unitsPerMetre !== 1) {
    fail(tileId, 'GLB root metric identity/CRS/scale does not match the descriptor');
  }
  const origin = extras.tileOriginEpsg26910VerticalMetres;
  if (!Array.isArray(origin) || origin.length !== 3 || origin.some((value, index) => value !== descriptor.origin[index])) {
    fail(tileId, 'GLB root metric origin does not match the descriptor');
  }
}

export function verifyScenePresentation(root, descriptorPresentation, tileId = 'metric tile') {
  const attributeName = SF_BUILDING_SOURCE_TONE_CONTRACT_V1.attribute.threeAttributeName;
  let buildingMeshes = 0;
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const isBuilding = materials.some((material) => material?.name === 'buildings-night');
    const position = node.geometry?.getAttribute?.('position');
    const tone = node.geometry?.getAttribute?.(attributeName);
    if (descriptorPresentation.mode === 'legacy') {
      if (tone != null) fail(tileId, 'legacy mesh carries an undeclared source-tone attribute');
      return;
    }
    if (!isBuilding) {
      if (tone != null) fail(tileId, 'source-tone attribute leaked onto a non-building mesh');
      return;
    }
    buildingMeshes += 1;
    if (!position || !tone) fail(tileId, 'source-tone building mesh is missing position or tone attributes');
    if (!(tone.array instanceof Uint8Array) || tone.itemSize !== 1 || tone.normalized !== false || tone.count !== position.count) {
      fail(tileId, 'source-tone building attribute is not UINT8 SCALAR non-normalized with POSITION count');
    }
    for (const value of tone.array) if (value < 0 || value > 3) fail(tileId, `source-tone attribute value ${value} is outside 0..3`);
  });
  if (descriptorPresentation.mode === 'source-tone-v1' && buildingMeshes === 0) fail(tileId, 'source-tone tile contains no building mesh to validate');
}

export function collectSourceToneAttributeBytes(gltf, descriptorPresentation, tileId = 'metric tile') {
  if (descriptorPresentation.mode !== 'source-tone-v1') return new Uint8Array();
  const root = gltf?.scene;
  const associations = gltf?.parser?.associations;
  if (!root?.traverse || typeof associations?.get !== 'function') {
    fail(tileId, 'source-tone payload ordering requires GLTFLoader primitive associations');
  }
  const attributeName = SF_BUILDING_SOURCE_TONE_CONTRACT_V1.attribute.threeAttributeName;
  const chunksByKey = new Map();
  let byteLength = 0;
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    if (!materials.some((material) => material?.name === 'buildings-night')) return;
    const array = node.geometry?.getAttribute?.(attributeName)?.array;
    if (!(array instanceof Uint8Array)) return;
    const association = associations.get(node);
    const meshIndex = association?.meshes;
    const primitiveIndex = association?.primitives;
    if (!Number.isInteger(meshIndex) || meshIndex < 0 || !Number.isInteger(primitiveIndex) || primitiveIndex < 0) {
      fail(tileId, 'source-tone building mesh is missing its GLTFLoader mesh/primitive indices');
    }
    const primitive = gltf.parser.json?.meshes?.[meshIndex]?.primitives?.[primitiveIndex];
    if (primitive?.extras?.category !== 'buildings' || primitive.attributes?._SF_SOURCE_TONE_V1 == null) {
      fail(tileId, `source-tone association ${meshIndex}/${primitiveIndex} does not identify a building primitive`);
    }
    const key = `${meshIndex}/${primitiveIndex}`;
    const existing = chunksByKey.get(key);
    if (existing) {
      if (existing.array.byteLength !== array.byteLength
        || existing.array.some((value, index) => value !== array[index])) {
        fail(tileId, `reused source-tone primitive ${key} has different attribute bytes`);
      }
      return;
    }
    chunksByKey.set(key, { meshIndex, primitiveIndex, array });
    byteLength += array.byteLength;
  });
  const chunks = [...chunksByKey.values()].sort((left, right) => left.meshIndex - right.meshIndex || left.primitiveIndex - right.primitiveIndex);
  const payload = new Uint8Array(byteLength);
  let offset = 0;
  for (const { array } of chunks) {
    payload.set(array, offset);
    offset += array.byteLength;
  }
  return payload;
}
