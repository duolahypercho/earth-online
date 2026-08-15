import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);
}

export const SF_BUILDING_SOURCE_TONE_POLICY_V1 = Object.freeze({
  id: 'osm-way-id-modulo-4-v1',
  formula: 'Number(BigInt(sourceOsmWayId) % 4n)',
  input: 'byte-locked OSM source way identity',
  outputDomain: [0, 3],
  presentationOnly: true,
  sourceColourClaim: false,
});

export const SF_BUILDING_SOURCE_TONE_POLICY_SHA256_V1 = `sha256:${createHash('sha256').update(canonicalJsonBytes(SF_BUILDING_SOURCE_TONE_POLICY_V1)).digest('hex')}`;

export const SF_BUILDING_SOURCE_TONE_CONTRACT_V1 = Object.freeze({
  schema: 'sf-building-source-tone-v1',
  status: 'preview-proof-only-not-production',
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

export function sourceToneV1ForOsmWayId(sourceOsmWayId) {
  assert(Number.isSafeInteger(sourceOsmWayId) && sourceOsmWayId >= 0, `OSM way identity ${sourceOsmWayId} is not a safe non-negative integer`);
  return Number(BigInt(sourceOsmWayId) % 4n);
}
