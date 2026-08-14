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
assert(source.includes("tile.scale.setScalar(1);"), 'Runtime tile scale must remain one unit per metre.');
assert(source.includes('tile.origin[0] - anchorOrigin[0]'), 'Runtime origin translation must subtract the source anchor exactly once.');
assert(source.includes("originSubtractions: 1, sceneScale: 1, units: 'metres'"), 'Metric diagnostics must remain exposed.');
assert(source.includes('receipt grid index does not match the manifest tile'), 'Receipt grid indexes must be checked against the descriptor.');
assert(source.includes('receipt bounds do not match the metric tile size and origin'), 'Receipt bounds must be checked against the descriptor size and origin.');

assert(Array.isArray(manifest.tiles) && manifest.tiles.length > 0, 'Production tile manifest must contain tiles.');
for (const tile of manifest.tiles) {
  assert(declaredHash(tile.lod0?.sha256), `${tile.id} is missing a SHA-256 locked GLB.`);
  assert(declaredHash(tile.receipt?.sha256), `${tile.id} is missing a SHA-256 locked receipt.`);
}

const representative = manifest.tiles.find((tile) => existsSync(resolve(root, tile.lod0.path)) && existsSync(resolve(root, tile.receipt.path)));
assert(representative, 'No production manifest tile has both committed artifacts available for integrity verification.');
assert(fileHash(resolve(root, representative.lod0.path)) === declaredHash(representative.lod0.sha256), `${representative.id} GLB bytes do not match its manifest SHA-256.`);
assert(fileHash(resolve(root, representative.receipt.path)) === declaredHash(representative.receipt.sha256), `${representative.id} receipt bytes do not match its manifest SHA-256.`);

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
  verified: ['manifest hashes', 'GLB byte verification before parsing', 'receipt verification before diagnostics', 'single deterministic queue', 'one unit per metre'],
}, null, 2));
