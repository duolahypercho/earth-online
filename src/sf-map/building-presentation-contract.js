const SOURCE_TONE_POLICY_SHA256 = 'sha256:2972f0a33f4a32ff9e62f60b8cc7d4a5e575c337cc46e4dd559a12bb4722ef68';

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
  derivation: {
    ...SF_BUILDING_SOURCE_TONE_POLICY_V1,
    policySha256: SF_BUILDING_SOURCE_TONE_POLICY_SHA256_V1,
  },
});

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
    if (rawPresentation.contract != null) fail(tileId, 'legacy presentation must not declare a source-tone contract');
    return deepFreeze({ mode: 'legacy', status: rawPresentation.status || 'legacy-explicit' });
  }
  if (rawPresentation.mode !== 'source-tone-v1') fail(tileId, `presentation mode ${rawPresentation.mode ?? 'missing'} is unsupported`);
  if (rawPresentation.productionWriteEnabled !== true || rawPresentation.productionPromotionAuthorized !== true) fail(tileId, 'source-tone presentation is not production-authorized');
  if (!exactObject(rawPresentation.contract, SF_BUILDING_SOURCE_TONE_CONTRACT_V1)) fail(tileId, 'source-tone manifest contract does not match the reviewed schema');
  return deepFreeze({
    mode: 'source-tone-v1',
    status: 'production-authorized',
    productionWriteEnabled: true,
    productionPromotionAuthorized: true,
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
  const chunks = [];
  let byteLength = 0;
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    if (!materials.some((material) => material?.name === 'buildings-night')) return;
    const array = node.geometry?.getAttribute?.(attributeName)?.array;
    if (!(array instanceof Uint8Array)) return;
    const primitiveIndex = associations.get(node)?.primitives;
    if (!Number.isInteger(primitiveIndex) || primitiveIndex < 0) {
      fail(tileId, 'source-tone building mesh is missing its GLTFLoader primitive index');
    }
    chunks.push({ primitiveIndex, array });
    byteLength += array.byteLength;
  });
  chunks.sort((left, right) => left.primitiveIndex - right.primitiveIndex);
  for (let index = 1; index < chunks.length; index += 1) {
    if (chunks[index - 1].primitiveIndex === chunks[index].primitiveIndex) {
      fail(tileId, `source-tone primitive index ${chunks[index].primitiveIndex} is duplicated`);
    }
  }
  const payload = new Uint8Array(byteLength);
  let offset = 0;
  for (const { array } of chunks) {
    payload.set(array, offset);
    offset += array.byteLength;
  }
  return payload;
}
