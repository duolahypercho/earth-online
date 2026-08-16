#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-building-height-preview-v1');
const MATCH_PATH = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-osm-building-match-proof-v1/sf-datasf-osm-building-match-proof-v1.receipt.json');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a); const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binHeader = 20 + jsonLength; assert.equal(bytes.readUInt32LE(binHeader + 4), 0x004e4942); const binLength = bytes.readUInt32LE(binHeader); const bin = Buffer.from(bytes.subarray(binHeader + 8, binHeader + 8 + binLength));
  return { json, bin };
}

function encodeGlb(json, bin) {
  let jsonChunk = Buffer.from(JSON.stringify(json)); const jsonPadding = (4 - jsonChunk.length % 4) % 4; if (jsonPadding) jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc(jsonPadding, 0x20)]);
  const binPadding = (4 - bin.length % 4) % 4; const binChunk = binPadding ? Buffer.concat([bin, Buffer.alloc(binPadding)]) : bin;
  const output = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binChunk.length); output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8); output.writeUInt32LE(jsonChunk.length, 12); output.writeUInt32LE(0x4e4f534a, 16); jsonChunk.copy(output, 20);
  const binAt = 20 + jsonChunk.length; output.writeUInt32LE(binChunk.length, binAt); output.writeUInt32LE(0x004e4942, binAt + 4); binChunk.copy(output, binAt + 8); return output;
}

function positionLayout(glb) {
  const accessorIndex = glb.json.meshes[0].primitives[0].attributes.POSITION; const accessor = glb.json.accessors[accessorIndex]; const view = glb.json.bufferViews[accessor.bufferView];
  assert.equal(accessor.componentType, 5126); assert.equal(accessor.type, 'VEC3');
  return { accessor, accessorIndex, stride: view.byteStride ?? 12, start: (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) };
}

function positionAt(glb, layout, vertex) { const offset = layout.start + vertex * layout.stride; return [glb.bin.readFloatLE(offset), glb.bin.readFloatLE(offset + 4), glb.bin.readFloatLE(offset + 8)]; }
function setPositionY(glb, layout, vertex, value) { glb.bin.writeFloatLE(value, layout.start + vertex * layout.stride + 4); }

function updatePositionBounds(glb, layout) {
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < layout.accessor.count; vertex += 1) {
    const position = positionAt(glb, layout, vertex); for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], position[axis]); max[axis] = Math.max(max[axis], position[axis]); }
  }
  layout.accessor.min = min; layout.accessor.max = max;
}

async function buildRegion(region, matchBytes) {
  const sourceGlbPath = path.join(ROOT, region.inputs.osmBuildingProof.path); const sourceReceiptPath = path.join(ROOT, region.inputs.osmBuildingProofReceipt.path);
  const [sourceGlbBytes, sourceReceiptBytes] = await Promise.all([readFile(sourceGlbPath), readFile(sourceReceiptPath)]); const sourceReceipt = JSON.parse(sourceReceiptBytes);
  assert.equal(`sha256:${sha256(sourceGlbBytes)}`, region.inputs.osmBuildingProof.sha256); assert.equal(`sha256:${sha256(sourceReceiptBytes)}`, region.inputs.osmBuildingProofReceipt.sha256);
  const glb = parseGlb(sourceGlbBytes); const layout = positionLayout(glb); const records = new Map(sourceReceipt.buildingRecords.map((record) => [record.sourceFeatureId, record])); const changedVertices = new Set(); const changes = [];
  for (const match of region.matches) {
    const record = records.get(match.osmSourceFeatureId); assert(record, `${region.id} missing ${match.osmSourceFeatureId}`); assert.equal(record.vertexCount % 2, 0);
    const ringLength = record.vertexCount / 2; const uniformHeightDelta = match.dataSfMedianHeightMetres - record.heightMetres; let minimumDelta = Infinity; let maximumDelta = -Infinity;
    for (let ringIndex = 0; ringIndex < ringLength; ringIndex += 1) {
      const topVertex = record.vertexStart + ringIndex * 2 + 1; const previousTop = positionAt(glb, layout, topVertex); const nextTopY = previousTop[1] + uniformHeightDelta; setPositionY(glb, layout, topVertex, nextTopY); changedVertices.add(topVertex);
      minimumDelta = Math.min(minimumDelta, nextTopY - previousTop[1]); maximumDelta = Math.max(maximumDelta, nextTopY - previousTop[1]);
    }
    changes.push({ osmSourceFeatureId: match.osmSourceFeatureId, dataSfBuildingId: match.dataSfBuildingId, topVerticesChanged: ringLength, previousHeightMetres: record.heightMetres, dataSfMedianHeightMetres: match.dataSfMedianHeightMetres, heightDeltaMetres: Number((match.dataSfMedianHeightMetres - record.heightMetres).toFixed(6)), emittedTopYDeltaRangeMetres: [Number(minimumDelta.toFixed(6)), Number(maximumDelta.toFixed(6))] });
  }
  updatePositionBounds(glb, layout); glb.json.asset.generator = 'build-sf-datasf-building-height-preview-v1'; glb.json.nodes[0].name = `${region.tileId}-datasf-height-preview`; glb.json.meshes[0].name = `${region.tileId}-datasf-height-preview`;
  glb.json.extras = { ...glb.json.extras, status: 'preview-source-height-comparison-only-not-production', dataSfHeightField: 'hgt_median_m', dataSfMatchedBuildings: changes.length, horizontalGeometryChanged: false, bottomVerticesChanged: false, unmatchedBuildingsChanged: false, verticalReconciliationComplete: false };
  const outputBytes = encodeGlb(glb.json, glb.bin); const fileName = `${region.tileId}.datasf-height-preview.glb`; const outputPath = path.join(OUTPUT_ROOT, fileName);
  const receipt = {
    schemaVersion: 1,
    kind: 'sf-datasf-building-height-preview-receipt',
    status: 'preview-source-height-comparison-only-not-production',
    tile: { id: region.tileId, role: region.id, horizontalCrs: 'EPSG:26910', unitsPerMetre: 1, verticalCertification: 'source-declared-navd88-unrealized' },
    source: { buildingPresentationProof: { path: path.relative(ROOT, sourceGlbPath), bytes: sourceGlbBytes.length, sha256: `sha256:${sha256(sourceGlbBytes)}` }, buildingPresentationProofReceipt: { path: path.relative(ROOT, sourceReceiptPath), bytes: sourceReceiptBytes.length, sha256: `sha256:${sha256(sourceReceiptBytes)}` }, matchProof: { path: path.relative(ROOT, MATCH_PATH), bytes: matchBytes.length, sha256: `sha256:${sha256(matchBytes)}` } },
    artifact: { path: path.relative(ROOT, outputPath), bytes: outputBytes.length, sha256: `sha256:${sha256(outputBytes)}` },
    policy: { matchedBuildingsOnly: true, heightField: 'hgt_median_m', topVertexRule: 'uniformly translate every existing top vertex by DataSF hgt_median_m minus the existing extrusion height; preserves the exact source roof shape', horizontalGeometry: 'exact source proof X/Z retained', bottomVertices: 'exact source proof retained', unmatchedBuildings: 'exact source proof retained', facadeSemantics: 'not supplied', absoluteVerticalPlacement: 'not claimed', runtimePromotion: false },
    counts: { sourceBuildings: sourceReceipt.counts.buildings, matchedBuildings: changes.length, changedTopVertices: changedVertices.size },
    changes,
  };
  return { outputBytes, outputPath, receipt, receiptBytes: jsonBytes(receipt) };
}

export async function buildDataSfBuildingHeightPreview({ write = true } = {}) {
  const matchBytes = await readFile(MATCH_PATH); const matchProof = JSON.parse(matchBytes); assert.equal(matchProof.status, 'preview-comparison-only-not-production'); const regions = [];
  for (const region of matchProof.regions) {
    const first = await buildRegion(region, matchBytes); const second = await buildRegion(region, matchBytes); assert(first.outputBytes.equals(second.outputBytes), `${region.id} preview GLB is not deterministic`); assert(first.receiptBytes.equals(second.receiptBytes), `${region.id} preview receipt is not deterministic`);
    const receiptPath = path.join(OUTPUT_ROOT, `${region.tileId}.datasf-height-preview.receipt.json`); if (write) { await mkdir(OUTPUT_ROOT, { recursive: true }); await writeFile(first.outputPath, first.outputBytes); await writeFile(receiptPath, first.receiptBytes); }
    regions.push({ id: region.id, tileId: region.tileId, artifact: first.receipt.artifact, receipt: path.relative(ROOT, receiptPath), counts: first.receipt.counts, changesSha256: `sha256:${sha256(jsonBytes(first.receipt.changes))}` });
  }
  const manifest = { schemaVersion: 1, kind: 'sf-datasf-building-height-preview-manifest', status: 'preview-source-height-comparison-only-not-production', claims: { productionGeometryChanged: false, runtimeChanged: false, gameplayChanged: false, facadeSemanticsSupplied: false, verticalReconciliationComplete: false }, regions };
  const manifestBytes = jsonBytes(manifest); if (write) await writeFile(path.join(OUTPUT_ROOT, 'sf-datasf-building-height-preview-v1.manifest.json'), manifestBytes); return { manifest, manifestBytes };
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) { const result = await buildDataSfBuildingHeightPreview(); process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`); }
