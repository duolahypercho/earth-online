import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  buildSfMetricTile,
  assertVerifiedTerrainSourceUnchanged,
  loadSfMetricSharedInputs,
  loadSfMetricVerifiedTerrainSourceDigests,
} from './build-ferry-production-tile-v1.mjs';
import { assertDeterministicRebuildMatchesLandedTile } from './verify-sf-production-tile-seams-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FERRY_DIR = path.join(ROOT, 'public/data/world/production-artifacts/ferry-production-tile-v1');
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const ferryArtifactPaths = [
  path.join(FERRY_DIR, 'ferry-production-tile-v1.lod0.glb'),
  path.join(FERRY_DIR, 'ferry-production-tile-v1.receipt.json'),
  path.join(FERRY_DIR, 'ferry-production-tile-v1.package.json'),
];
let cachedInputs = null;

async function inputs() {
  cachedInputs ??= Promise.all([loadSfMetricSharedInputs(), loadSfMetricVerifiedTerrainSourceDigests()]);
  return cachedInputs;
}

test('verified terrain digest memo is immutable, hits a write-free build, and preserves landed artifacts', { timeout: 240_000 }, async () => {
  const [[sharedInputs, verifiedTerrainSourceDigests], before] = await Promise.all([
    inputs(),
    Promise.all(ferryArtifactPaths.map((artifactPath) => readFile(artifactPath))),
  ]);
  assert(Object.isFrozen(verifiedTerrainSourceDigests));
  assert(verifiedTerrainSourceDigests.every((entry) => Object.isFrozen(entry)));
  assert(verifiedTerrainSourceDigests.every(({ fileIdentity }) => Object.isFrozen(fileIdentity) && typeof fileIdentity.device === 'bigint' && typeof fileIdentity.inode === 'bigint' && typeof fileIdentity.size === 'bigint' && typeof fileIdentity.mtimeNs === 'bigint' && typeof fileIdentity.ctimeNs === 'bigint'));

  const rebuilt = await buildSfMetricTile({ sharedInputs, verifiedTerrainSourceDigests, write: false });
  assert.deepEqual(rebuilt.glbs[0].bytes, before[0], 'representative Ferry rebuild GLB drifted from landed artifact');
  const usedPaths = new Set(rebuilt.receipt.source.geoTiffs.map(({ path: rawPath }) => rawPath));
  assert(usedPaths.size > 0, 'representative ferry build selected no terrain TIFFs');
  for (const usedPath of usedPaths) assert(verifiedTerrainSourceDigests.some(({ path: rawPath }) => rawPath === usedPath), `selected TIFF ${usedPath} missed the verifier memo`);

  const after = await Promise.all(ferryArtifactPaths.map((artifactPath) => readFile(artifactPath)));
  assert.deepEqual(after, before, 'write:false changed a landed production artifact');
});

test('altered TIFF digest or lock path in the immutable verifier memo fails closed', { timeout: 120_000 }, async () => {
  const [sharedInputs, verifiedTerrainSourceDigests] = await inputs();
  const alteredTiffDigest = Object.freeze(verifiedTerrainSourceDigests.map((entry) => Object.freeze({ ...entry, sha256: '0'.repeat(64) })));
  await assert.rejects(
    buildSfMetricTile({ sharedInputs, verifiedTerrainSourceDigests: alteredTiffDigest, write: false }),
    /Verified terrain digest hash drifted from lock/,
  );
  const alteredLockPath = Object.freeze(verifiedTerrainSourceDigests.map((entry) => Object.freeze({ ...entry, path: `${entry.path}.altered` })));
  await assert.rejects(
    buildSfMetricTile({ sharedInputs, verifiedTerrainSourceDigests: alteredLockPath, write: false }),
    /must contain exactly one entry for locked GeoTIFF/,
  );
  const alteredLockBytes = Object.freeze(verifiedTerrainSourceDigests.map((entry) => Object.freeze({ ...entry, bytes: entry.bytes + 1 })));
  await assert.rejects(
    buildSfMetricTile({ sharedInputs, verifiedTerrainSourceDigests: alteredLockBytes, write: false }),
    /Verified terrain digest byte count drifted from lock/,
  );
  await assert.rejects(
    buildSfMetricTile({ sharedInputs, verifiedTerrainSourceDigests: [...verifiedTerrainSourceDigests], write: false }),
    /Verified terrain digest memo must be immutable/,
  );
});

test('memo-backed terrain source rejects post-memo file identity mutation without touching real TIFFs', async () => {
  const pathname = '/safe-fixture/terrain.tif';
  const identity = Object.freeze({ pathname, device: 1n, inode: 17n, size: 4096n, mtimeNs: 1000n, ctimeNs: 1000n });
  const verifiedTerrainDigest = Object.freeze({ path: 'safe-fixture/terrain.tif', bytes: 4096, sha256: 'a'.repeat(64), fileIdentity: identity });
  await assert.rejects(
    assertVerifiedTerrainSourceUnchanged(verifiedTerrainDigest, {
      pathname,
      statFile: async (_fixturePath, options) => {
        assert.deepEqual(options, { bigint: true });
        return { dev: 1n, ino: 17n, size: 4097n, mtimeNs: 1001n, ctimeNs: 1001n };
      },
      phase: 'after fixture mutation',
    }),
    /Verified terrain source identity changed after fixture mutation/,
  );
});

test('memo identity failure prevents output creation before the write boundary', { timeout: 120_000 }, async () => {
  const [sharedInputs, verifiedTerrainSourceDigests] = await inputs();
  const mutatedMemo = Object.freeze(verifiedTerrainSourceDigests.map((entry) => Object.freeze({
    ...entry,
    fileIdentity: Object.freeze({ ...entry.fileIdentity, mtimeNs: entry.fileIdentity.mtimeNs + 1n }),
  })));
  const outputDir = path.join(tmpdir(), `sf-metric-tile-no-write-${randomUUID()}`);
  await assert.rejects(access(outputDir), /ENOENT/);
  await assert.rejects(
    buildSfMetricTile({ sharedInputs, verifiedTerrainSourceDigests: mutatedMemo, outputDir, write: true }),
    /Verified terrain source identity changed before opening/,
  );
  await assert.rejects(access(outputDir), /ENOENT/);
});

test('concurrent metric builds are serialized around tile state and retain published identities', { timeout: 240_000 }, async () => {
  const [sharedInputs, verifiedTerrainSourceDigests] = await inputs();
  const tileIds = ['epsg26910-1416-10872', 'epsg26910-1433-10885'];
  const published = await Promise.all(tileIds.map(async (tileId) => JSON.parse(await readFile(path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1', tileId, `${tileId}.receipt.json`)))));
  const rebuilt = await Promise.all(published.map(({ tile }) => buildSfMetricTile({
    tile: { gridEasting: tile.gridIndex[0], gridNorthing: tile.gridIndex[1] },
    sharedInputs,
    verifiedTerrainSourceDigests,
    write: false,
  })));
  assert.deepEqual(rebuilt.map(({ receipt }) => receipt.tile.identity), published.map(({ tile }) => tile.identity));
  assert.deepEqual(rebuilt.map(({ receipt }) => receipt.lods[0].artifactHash), published.map(({ lods }) => lods[0].artifactHash));
});

test('deterministic rebuild comparison still rejects altered builder output', () => {
  const bytes = Buffer.from([1, 2, 3]);
  const tile = { identity: 'test-tile', lodDigest: digest(bytes), expected: { origin: [1, 2, 3] } };
  const rebuilt = {
    glbs: [{ bytes }],
    receipt: { lods: [{ artifactHash: digest(bytes) }], tile: { originEpsg26910VerticalMetres: [1, 2, 3] }, status: 'provisional-vertical-unrealized' },
    packageDescriptor: { status: 'provisional-vertical-unrealized' },
  };
  assert.doesNotThrow(() => assertDeterministicRebuildMatchesLandedTile(tile, rebuilt));
  assert.throws(() => assertDeterministicRebuildMatchesLandedTile(tile, { ...rebuilt, glbs: [{ bytes: Buffer.from([4, 5, 6]) }] }), /deterministic rebuild hash drifted/);
});
