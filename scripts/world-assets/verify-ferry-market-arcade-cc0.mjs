#!/usr/bin/env node
/** Verify legal locks and measure every claim directly from emitted GLBs. */
import assert from 'node:assert/strict';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFerryMarketGlb } from './inspect-ferry-market-arcade-glb.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pack = join(root, 'public/assets/hero/ferry-market-arcade-cc0');
const qa = join(root, '.qa-ferry-market-arcade-cc0');
const verifyQa = process.argv.includes('--verify-qa');
const manifest = JSON.parse(await readFile(join(pack, 'ferry-market-arcade-cc0.manifest.json'), 'utf8'));

assert.equal(manifest.schemaVersion, 'ferry-market-arcade-cc0-foundation-v2');
assert.equal(manifest.status, 'foundation-approved');
assert.equal(manifest.scope.description, 'Cafe plus generic-fixtures foundation only.');
assert.equal(manifest.scope.completeFiveProgramArcade, false);
assert.deepEqual(manifest.scope.approved.cafe, ['cafe-seating.glb', 'cafe-counter.glb', 'cafe-tableware.glb']);
assert.deepEqual(manifest.scope.approved.genericFixtures, ['grocer-shelves.glb', 'newsstand-rack.glb']);
assert.equal(manifest.license.id, 'CC0-1.0');
assert.equal(manifest.license.sourceUrl, 'https://polyhaven.com/license');
assert.deepEqual(manifest.toolchain, {
  blender: { version: '4.5.3 LTS', platform: 'macOS arm64', portableDmgUrl: 'https://download.blender.org/release/Blender4.5/blender-4.5.3-macos-arm64.dmg', portableDmgSha256: '73ea841053b55404bb3a71a9a22366f1f8821787fe5c899f8b55a7fff929d01b' },
  python: { version: '3.9.6' },
  pillow: { version: '11.3.0' },
});
assert.equal(manifest.coordinateSystem.groundingToleranceMeters, 0.0005);
assert.equal(manifest.assets.length, 5);

const expectedShippingFiles = new Set(['ferry-market-arcade-cc0.manifest.json', ...manifest.assets.map((asset) => asset.file)]);
const shippingEntries = await readdir(pack, { withFileTypes: true });
assert.ok(shippingEntries.every((entry) => entry.isFile()), 'shipping pack must contain files only; QA directories are forbidden');
assert.deepEqual(new Set(shippingEntries.map((entry) => entry.name)), expectedShippingFiles, 'shipping pack contains an unexpected or missing file');

const totals = { sourceCompressedBytes: 0, exportedBytes: 0, lod0Triangles: 0, materialsAfterConsolidation: 0 };
const measuredAssets = [];
for (const asset of manifest.assets) {
  assert.ok(['cafe', 'generic-fixture'].includes(asset.classification));
  assert.ok(asset.source.metadataUrl.startsWith('https://api.polyhaven.com/info/'));
  assert.ok(asset.source.filesUrl.startsWith('https://api.polyhaven.com/files/'));
  assert.ok(asset.source.assetPage.startsWith('https://polyhaven.com/a/'));
  assert.ok(Object.keys(asset.source.metadata.authors).length > 0);
  assert.ok(asset.source.files.length > 1);
  for (const source of asset.source.files) {
    assert.match(source.md5, /^[a-f0-9]{32}$/);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.ok(source.url.startsWith('https://dl.polyhaven.org/file/ph-assets/Models/'));
    assert.ok(source.bytes > 0);
  }
  const glb = await readFile(join(pack, asset.file));
  const measured = inspectFerryMarketGlb(glb);
  assert.deepEqual(measured, {
    bytes: asset.export.bytes,
    sha256: asset.export.sha256,
    triangles: asset.export.triangles,
    materials: asset.export.materials,
    meshInstances: asset.export.meshInstances,
    externalUris: asset.export.externalUris,
    cameras: asset.export.cameras,
    lights: asset.export.lights,
    emissiveMaterials: asset.export.emissiveMaterials,
    boundsMeters: asset.export.boundsMeters,
    minYMeters: asset.export.minYMeters,
  });
  assert.equal(measured.externalUris.length, 0, `${asset.file} must be self-contained`);
  assert.equal(measured.cameras, 0, `${asset.file} must not contain cameras`);
  assert.equal(measured.lights, 0, `${asset.file} must not contain lights`);
  assert.equal(measured.emissiveMaterials, 0, `${asset.file} must not contain emissive materials`);
  assert.ok(Math.abs(measured.minYMeters) <= manifest.coordinateSystem.groundingToleranceMeters, `${asset.file} grounding exceeds 0.5mm`);
  assert.ok(measured.triangles <= asset.targetTriangles, `${asset.file} exceeds its triangle target`);
  assert.equal(measured.materials, 1, `${asset.file} must have exactly one consolidated material`);
  totals.sourceCompressedBytes += asset.source.compressedBytes;
  totals.exportedBytes += measured.bytes;
  totals.lod0Triangles += measured.triangles;
  totals.materialsAfterConsolidation += measured.materials;
  measuredAssets.push({ file: asset.file, bytes: measured.bytes, triangles: measured.triangles, materials: measured.materials, minYMeters: measured.minYMeters });
  assert.equal(asset.qa.shipping, false);
  if (verifyQa) assert.ok((await stat(join(qa, 'cards', `${asset.id}.png`))).size > 0);
}
assert.deepEqual(totals, {
  sourceCompressedBytes: manifest.budgets.sourceCompressedBytes,
  exportedBytes: manifest.budgets.exportedBytes,
  lod0Triangles: manifest.budgets.lod0Triangles,
  materialsAfterConsolidation: manifest.budgets.materialsAfterConsolidation,
});
assert.ok(totals.sourceCompressedBytes <= manifest.budgets.maxSourceCompressedBytes);
assert.ok(totals.lod0Triangles <= manifest.budgets.maxLod0Triangles);
assert.ok(totals.materialsAfterConsolidation <= manifest.budgets.maxMaterialsAfterConsolidation);
if (verifyQa) await access(join(qa, 'contact-sheet.png'));
console.log(JSON.stringify({ verified: true, qaVerified: verifyQa, scope: manifest.scope.description, assets: measuredAssets, totals, review: manifest.review }, null, 2));
