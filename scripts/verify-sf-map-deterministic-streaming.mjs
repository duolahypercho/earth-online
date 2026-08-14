import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, 'src/sf-map/main.js');
const manifestPath = resolve(root, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const source = readFileSync(sourcePath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function declaredHash(value) {
  const match = typeof value === 'string' && value.match(/^sha256:([a-f0-9]{64})$/i);
  return match?.[1].toLowerCase();
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

assert(source.includes('async function fetchVerifiedBytes('), 'The viewer must fetch bytes rather than delegate GLB loading.');
assert(source.includes("gltfLoader.parseAsync(glbArtifact.bytes"), 'The viewer must parse only verified GLB bytes.');
assert(!source.includes('gltfLoader.loadAsync('), 'Unverified GLTFLoader URL loading is forbidden.');
assert(source.includes('const receiptArtifact = await fetchVerifiedBytes('), 'Receipts must be byte-verified before diagnostics are updated.');
assert(source.includes('function pumpLoadQueue()'), 'A deterministic tile admission queue is required.');
assert(source.includes('if (activeLoad) return;'), 'The queue must allow exactly one active load.');
assert(source.includes('return [state.queueDistanceBucket, state.descriptor.id];'), 'Queue priority must use the frozen enqueue bucket.');
assert(source.includes('state.queueDistanceBucket = Math.floor(distance / STREAM_QUEUE_BUCKET_METRES);'), 'Queue bucket must be frozen when work is enqueued.');
assert(source.includes('distanceBucket: state.queueDistanceBucket,'), 'Queue diagnostics must report the frozen bucket.');
assert(source.includes('return leftBucket - rightBucket || leftId.localeCompare(rightId);'), 'Queue ties must use a stable tile-id order.');
assert(!source.includes("activeView === 'plan' ? Math.floor"), 'Queue priority must not recompute camera distance while comparing queued work.');
assert(source.includes('function focusDistanceToTile(tile)'), 'Tile streaming must have an explicit map-focus distance function.');
assert(source.includes('controls.target.x - centerX') && source.includes('controls.target.z - centerZ'), 'Tile distance must use controls.target horizontal coordinates.');
assert(!source.includes('camera.position.x - centerX') && !source.includes('camera.position.z - centerZ'), 'Overview camera position must not drive tile distance.');
assert(source.includes("distanceReference: 'controls.target horizontal coordinates'"), 'Streaming diagnostics must expose controls.target as the distance reference.');
assert(source.includes("tile.scale.setScalar(1);"), 'Runtime tile scale must remain one unit per metre.');
assert(source.includes('tile.position.copy(descriptor.offset);'), 'Runtime tile placement must use the source-derived offset exactly once.');
assert(source.includes('tile.origin[0] - anchorOrigin[0]'), 'Runtime origin translation must subtract the source anchor exactly once.');
assert(source.includes("originSubtractions: 1, sceneScale: 1, units: 'metres'"), 'Metric diagnostics must remain exposed.');
assert(source.includes('receipt grid index does not match the manifest tile'), 'Receipt grid indexes must be checked against the descriptor.');
assert(source.includes('receipt bounds do not match the metric tile size and origin'), 'Receipt bounds must be checked against the descriptor size and origin.');
assert(source.includes('const DISTRICT_FIT_TARGET_RESIDENTS = 4;'), 'District presentation must wait for the bounded four-tile verified batch.');
assert(source.includes('function fitDistrictCameraToVerifiedResidents()'), 'District presentation requires an explicit source-derived local camera fit.');
assert(source.includes('function selectDistrictFitDescriptors(descriptors)'), 'District fitting must select a source-derived footprint before tile arrivals.');
assert(source.includes("selection: 'nearest-complete-source-2x2-metric-block'"), 'District diagnostics must identify the deterministic compact-batch policy.');
assert(source.includes('const east = byGridIndex.get([gridX + 1, gridZ].join(\'/\'));'), 'District fitting must require the east source neighbour.');
assert(source.includes('const north = byGridIndex.get([gridX, gridZ + 1].join(\'/\'));'), 'District fitting must require the north source neighbour.');
assert(source.includes('const northEast = byGridIndex.get([gridX + 1, gridZ + 1].join(\'/\'));'), 'District fitting must require the north-east source neighbour.');
assert(source.includes('if (bounds.width !== descriptor.size * 2 || bounds.depth !== descriptor.size * 2) continue;'), 'District fitting must reject sparse or non-metric 2×2 candidates.');
assert(source.includes("districtFit.status = 'no-compact-source-batch';"), 'District fitting must fail closed without a compact source batch.');
assert(source.includes('if (!batch.every((state) => state?.scene && focusDistanceToTile(state.descriptor) <= STREAM_RADIUS_METRES)) return;'), 'District fitting must wait for every selected source tile to be verified and resident.');
assert(source.includes('candidateTileIds: districtFitDescriptors.map(({ id }) => id)'), 'District diagnostics must expose the preselected compact source batch.');
assert(source.includes('const bounds = residentDescriptorBounds(batch);'), 'District camera fitting must derive its extent from resident descriptors.');
assert(source.includes('controls.target.copy(target);'), 'District camera fitting must keep streaming focused on the fitted local target.');
assert(source.includes('DISTRICT_FIT_MIN_DISTANCE_METRES') && source.includes('DISTRICT_FIT_MAX_DISTANCE_METRES'), 'District camera fitting requires bounded metric distance clamps.');
assert(source.includes('const DISTRICT_FIT_FRAME_MARGIN = 2.15;'), 'District camera fitting must retain the reviewed local-footprint margin.');
assert(source.includes("oneTimeStatus: districtFit.status"), 'Streaming diagnostics must expose the one-time District fit status.');
assert(source.includes("residentBounds: districtFit.residentBounds"), 'Streaming diagnostics must expose District resident bounds.');
assert(source.includes("cameraDistance: districtFit.cameraDistance"), 'Streaming diagnostics must expose the fitted District camera distance.');
assert(source.includes('scene.fog.density = viewFogDensity.district;'), 'The first fitted District frame must apply the same fog density as repeat entries.');
assert(source.includes("if (name === 'district') resetDistrictFit();"), 'District re-entry must reset the local presentation fit deterministically.');
assert(source.includes('function settleExplicitViewResidency(name)'), 'Named preset transitions must have an explicit residency-settling rule.');
assert(source.includes("if (name !== activeView || name === 'plan') return;"), 'Plan must retain its all-resident semantic when named-view residency settles.');
assert(source.includes('focusDistanceToTile(state.descriptor) <= STREAM_RADIUS_METRES'), 'Named preset settling must prune only outside the strict load radius.');
assert(source.includes('refitLocalSunShadow(true);\n      settleExplicitViewResidency(name);'), 'Named-view light framing and cleanup must occur only once its camera transition settles.');
assert(source.includes("settleExplicitViewResidency('district');"), 'The District source-derived camera fit must settle cache residency at its final focus.');
assert(!source.includes("requestAnimationFrame(fitDistrictCameraToVerifiedResidents)"), 'District fitting must not inspect inherited cache before its named preset settles.');
assert(source.includes('RETAIN_RADIUS_METRES\n// remains the streaming hysteresis contract.'), 'Free orbit and pan must retain the wider hysteresis radius.');
assert(source.includes('explicitViewResidency:'), 'Streaming diagnostics must expose the named-view residency receipt.');
assert(source.includes("version: 'sf-map-render-depth-v1'"), 'Presentation diagnostics must expose the renderer-only depth policy.');
assert(source.includes("ferry: { position: [430, 132, 292], target: [119, 8, 292] }"), 'Ferry camera must retain its reviewed waterfront framing.');
assert(source.includes('position: camera.position.toArray()'), 'Streaming diagnostics must expose the live camera position.');
assert(source.includes('target: controls.target.toArray()'), 'Streaming diagnostics must expose the live camera target.');
assert(source.includes('function applyBuildingPresentation(material)'), 'Building depth must be a runtime material policy, not a source-geometry rewrite.');
assert(source.includes('vSfMapWorldPosition'), 'Building palette selection must use seam-stable world coordinates.');
assert(source.includes('vec4 sfMapWorldPosition = vec4( transformed, 1.0 );'), 'The palette must define its world position even when Three omits worldPosition.');
assert(source.includes('sfMapWorldPosition = batchingMatrix * sfMapWorldPosition;'), 'The palette world position must retain batched mesh placement.');
assert(source.includes('sfMapWorldPosition = instanceMatrix * sfMapWorldPosition;'), 'The palette world position must retain instanced mesh placement.');
assert(source.includes('sfMapWorldPosition = modelMatrix * sfMapWorldPosition;'), 'The palette world position must retain the source mesh model transform.');
assert(source.includes('vSfMapWorldPosition = sfMapWorldPosition.xyz;'), 'The palette varying must use the unconditional world position.');
assert(!source.includes('vSfMapWorldPosition = worldPosition.xyz;'), 'The palette must not depend on Three conditionally declaring worldPosition.');
assert(source.includes('floor(vSfMapWorldPosition.xz / ${PRESENTATION_POLICY.paletteWorldCellMetres.toFixed(1)})'), 'The four-tone palette must remain world-coordinate seam-stable at its reviewed metric cell size.');
assert(source.includes("material.customProgramCacheKey = () => 'sf-map-building-palette-v1'"), 'Building material programs must remain bounded and deterministic.');
assert(source.includes('sun.castShadow = false;'), 'Plan view must explicitly avoid claiming a city-wide local shadow frustum.');
assert(source.includes('sun.target.position.copy(controls.target);'), 'Ferry and District shadows must centre on the current stream focus.');
assert(source.includes('tile.scale.setScalar(1);') && source.includes('tile.position.copy(descriptor.offset);'), 'Presentation policy must not change tile scale or origin placement.');
assert(source.includes('const PLAN_LOADING_RENDER_INTERVAL_MS = 250;'), 'Plan loading needs a bounded render-budget policy.');
assert(source.includes("activeView === 'plan' && (activeLoad || streamDiagnostics.queuedCount > 0)"), 'Plan render throttling must be presentation-only while source-locked work remains queued.');

assert(Array.isArray(manifest.tiles) && manifest.tiles.length > 0, 'Production tile manifest must contain tiles.');
for (const tile of manifest.tiles) {
  assert(declaredHash(tile.lod0?.sha256), `${tile.id} is missing a SHA-256 locked GLB.`);
  assert(declaredHash(tile.receipt?.sha256), `${tile.id} is missing a SHA-256 locked receipt.`);
}

const representative = manifest.tiles.find((tile) => existsSync(resolve(root, tile.lod0.path)) && existsSync(resolve(root, tile.receipt.path)));
assert(representative, 'No production manifest tile has both committed artifacts available for integrity verification.');
assert(fileHash(resolve(root, representative.lod0.path)) === declaredHash(representative.lod0.sha256), `${representative.id} GLB bytes do not match its manifest SHA-256.`);
assert(fileHash(resolve(root, representative.receipt.path)) === declaredHash(representative.receipt.sha256), `${representative.id} receipt bytes do not match its manifest SHA-256.`);

const ferryManifestTile = manifest.tiles.find((tile) => tile.id === 'epsg26910-1441-10893');
assert(ferryManifestTile, 'The source-locked Ferry tile must remain in the production manifest.');
assert(JSON.stringify(ferryManifestTile.originEpsg26910VerticalMetres) === JSON.stringify([553344, 4182912, 0]), 'The Ferry metric source origin changed.');

const fallback = {
  glb: 'public/data/world/production-artifacts/ferry-production-tile-v1/ferry-production-tile-v1.lod0.glb',
  glbSha256: 'ca6021f03d8335f80b0ebcaab9b50320f6f302b2ab8a1b886cd9995a45074310',
  receipt: 'public/data/world/production-artifacts/ferry-production-tile-v1/ferry-production-tile-v1.receipt.json',
  receiptSha256: 'fdba34c57b6af539a5a2d53bc185f3dd091ede4323f836c7716c619bf07c15fd',
};
assert(source.includes(`glbSha256: 'sha256:${fallback.glbSha256}'`), 'Fallback GLB SHA-256 must remain hardcoded.');
assert(source.includes(`receiptSha256: 'sha256:${fallback.receiptSha256}'`), 'Fallback receipt SHA-256 must remain hardcoded.');
assert(fileHash(resolve(root, fallback.glb)) === fallback.glbSha256, 'Fallback GLB bytes do not match the hardcoded SHA-256.');
assert(fileHash(resolve(root, fallback.receipt)) === fallback.receiptSha256, 'Fallback receipt bytes do not match the hardcoded SHA-256.');

console.log(JSON.stringify({
  result: 'SF map deterministic streaming verified',
  manifestTiles: manifest.tiles.length,
  representativeTile: representative.id,
  verified: ['manifest hashes', 'GLB byte verification before parsing', 'receipt verification before diagnostics', 'single deterministic queue', 'controls.target horizontal distance reference', 'one unit per metre'],
}, null, 2));
