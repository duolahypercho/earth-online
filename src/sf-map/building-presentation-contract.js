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
  return deepFreeze({
    mode: 'source-tone-v1',
    status: 'production-authorized',
    productionWriteEnabled: true,
    productionPromotionAuthorized: true,
    contractSha256: SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1,
    contract: SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
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
  if (!/^sha256:[a-f0-9]{64}$/i.test(presentation.ledgers?.sourceToneAttributeSha256 || '')) fail(tileId, 'source-tone receipt does not bind the attribute payload with SHA-256');
  return { mode: 'source-tone-v1', status: 'verified-production-authorization', sourceToneAttributeSha256: presentation.ledgers.sourceToneAttributeSha256 };
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
