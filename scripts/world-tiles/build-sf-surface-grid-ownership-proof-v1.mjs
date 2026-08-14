/**
 * Offline-only proof for a narrowly bounded LOD0 coastline-grid ownership
 * rule. It never writes production-shaped artifacts or touches a manifest.
 *
 * The source builder normally preserves near-grid Clipper ticks internally.
 * This proof keeps every source XY coordinate and instead evaluates each
 * fractional terrain/water vertex from a fixed-diagonal 1 m source lattice.
 * It is deliberately a proposal, not a production repair.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSfMetricTile, loadSfMetricSharedInputs, loadSfMetricVerifiedTerrainSourceDigests } from './build-ferry-production-tile-v1.mjs';
import { auditSurfaceContinuity, measureHorizontalMovement } from './surface-grid-ownership-proof-utils-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-surface-grid-ownership-proof-v1');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const TILES = Object.freeze([
  [1439, 10892], [1440, 10892], [1441, 10892],
  [1439, 10893], [1440, 10893], [1441, 10893],
  [1439, 10894], [1440, 10894],
]);
const idFor = ([gridEasting, gridNorthing]) => `epsg26910-${gridEasting}-${gridNorthing}`;
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const sourceById = new Map(manifest.tiles.map((entry) => [entry.id, entry]));
const requested = TILES.map((gridIndex) => {
  const id = idFor(gridIndex); const source = sourceById.get(id);
  assert(source, `Required committed Ferry-neighborhood tile is absent: ${id}`);
  return { id, gridIndex, source };
});
assert.equal(requested.length, 8, 'Proof must remain the exact eight committed Ferry-neighborhood tiles');

const [sharedInputs, terrainDigests] = await Promise.all([loadSfMetricSharedInputs(), loadSfMetricVerifiedTerrainSourceDigests()]);
const tiles = [];
for (const { id, gridIndex, source } of requested) {
  const sourcePath = path.join(ROOT, source.lod0.path);
  const sourceBytes = await readFile(sourcePath);
  assert.equal(sha256(sourceBytes), source.lod0.sha256, `${id} source LOD0 hash drifted`);
  const first = await buildSfMetricTile({ tile: { gridEasting: gridIndex[0], gridNorthing: gridIndex[1] }, write: false, sharedInputs, verifiedTerrainSourceDigests: terrainDigests, surfaceHeightOwnership: 'canonical-1m-lattice-height-v1' });
  const second = await buildSfMetricTile({ tile: { gridEasting: gridIndex[0], gridNorthing: gridIndex[1] }, write: false, sharedInputs, verifiedTerrainSourceDigests: terrainDigests, surfaceHeightOwnership: 'canonical-1m-lattice-height-v1' });
  const previewBytes = first.glbs[0].bytes;
  assert.deepEqual(previewBytes, second.glbs[0].bytes, `${id} ownership preview rebuild is not deterministic`);
  const sourceAudit = auditSurfaceContinuity(sourceBytes, id);
  const previewAudit = auditSurfaceContinuity(previewBytes, id);
  assert.equal(previewAudit.horizontalSurfaceTopologySha256, sourceAudit.horizontalSurfaceTopologySha256, `${id} preview changed horizontal surface topology`);
  const movement = measureHorizontalMovement(sourceAudit.vertices, previewAudit.vertices);
  const outputPath = path.join(OUTPUT_DIR, `${id}.lod0.grid-ownership-preview.glb`);
  tiles.push({ id, gridIndex, source, sourceBytes, previewBytes, outputPath, sourceAudit, previewAudit, movement });
}

const baselineFindings = tiles.reduce((sum, tile) => sum + tile.sourceAudit.violations, 0);
const repairedFindings = tiles.reduce((sum, tile) => sum + tile.previewAudit.violations, 0);
assert.equal(baselineFindings, 6, 'The proof baseline must reproduce exactly six committed Ferry-neighborhood findings');
const maxHorizontalDisplacementMetres = Math.max(...tiles.map(({ movement }) => movement.maxHorizontalDisplacementMetres));
assert.equal(maxHorizontalDisplacementMetres, 0, 'Height-only preview changed a source surface XY coordinate');
const status = repairedFindings === 0 ? 'proof-passed-bounded-continuity-not-promoted' : 'proof-rejected-residual-topology-or-near-grid-continuity';

const receipt = {
  schemaVersion: 1,
  kind: 'sf-surface-grid-ownership-proof',
  id: 'sf-surface-grid-ownership-proof-v1',
  status,
  nonPromotion: 'preview/proof only; not a production package, runtime asset, manifest entry, streaming input, or realized vertical datum claim',
  scope: {
    committedTileCount: 8,
    missingNortheastCell: 'epsg26910-1441-10894 is intentionally excluded because it is not committed production-ready',
    tiles: tiles.map(({ id }) => id),
    baselineFindingsExpected: 6,
  },
  coordinateFrame: { horizontalCrs: 'EPSG:26910', unitsPerMetre: 1, scale: [1, 1, 1], verticalStatus: 'provisional-source-declared-navd88-unrealized' },
  sourceSemantics: {
    sourceTerrain: 'byte-locked 3DEP GeoTIFF direct native pixel float32 samples provide the canonical 1 m lattice corners; no datum conversion, smoothing, or hydroflattening',
    sourceHorizontal: 'byte-locked OSM coastline plan geometry in EPSG:26910, represented internally at one-thousandth metre ticks',
    proposedRule: 'at integer 1 m lattice corners use direct locked PixelIsArea samples; at every fractional terrain/water vertex evaluate the same fixed southwest-to-northeast diagonal 1 m lattice triangle by barycentric interpolation',
    exactnessQualification: 'The proof preserves encoded OSM-plan XY exactly and changes only fractional-vertex height evaluation. A rejection means this height rule alone cannot remove residual topology or near-grid continuity findings without a fixed-diagonal polygon split.',
  },
  validation: {
    method: 'decode source and preview terrain/water GLBs; fail on exact shared-vertex disagreement or distinct vertices within 1.1 mm across a whole-metre grid line with vertical delta above 1e-6 m',
    baselineFindings,
    repairedFindings,
    maxHorizontalDisplacementMetres,
    maxCanonicalTickDisplacementMetres: 0,
    horizontalSurfaceTopologyIdentical: true,
    maxPreviewVerticalDiscontinuityMetres: Math.max(...tiles.map(({ previewAudit }) => previewAudit.maxVerticalDeltaMetres)),
    deterministicRebuild: true,
    productionManifestUntouched: true,
  },
  tiles: tiles.map(({ id, gridIndex, source, sourceBytes, previewBytes, outputPath, sourceAudit, previewAudit, movement }) => ({
    id, gridIndex,
    sourceLod0: { path: source.lod0.path, sha256: sha256(sourceBytes) },
    previewLod0: { path: relative(outputPath), sha256: sha256(previewBytes), bytes: previewBytes.length },
    sourceContinuity: { violations: sourceAudit.violations, maxVerticalDiscontinuityMetres: sourceAudit.maxVerticalDeltaMetres, findings: sourceAudit.findings },
    previewContinuity: { violations: previewAudit.violations, maxVerticalDiscontinuityMetres: previewAudit.maxVerticalDeltaMetres, findings: previewAudit.findings },
    horizontalSurfaceTopologySha256: sourceAudit.horizontalSurfaceTopologySha256,
    horizontalMovement: movement,
  })),
};

await mkdir(OUTPUT_DIR, { recursive: true });
await Promise.all([...tiles.map(({ outputPath, previewBytes }) => writeFile(outputPath, previewBytes)), writeFile(path.join(OUTPUT_DIR, 'sf-surface-grid-ownership-proof-v1.receipt.json'), jsonBytes(receipt))]);
console.log(JSON.stringify({ result: receipt.status, outputDir: relative(OUTPUT_DIR), baselineFindings, repairedFindings, maxHorizontalDisplacementMetres }, null, 2));
