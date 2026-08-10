#!/usr/bin/env node
/** Reproducibly build the approved CC0 cafe + generic-fixture foundation subset. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectFerryMarketGlb } from './inspect-ferry-market-arcade-glb.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = join(root, 'public/assets/hero/ferry-market-arcade-cc0');
const qaDir = join(root, '.qa-ferry-market-arcade-cc0');
const sourceCache = join(tmpdir(), 'ferry-market-arcade-cc0-source');
const reviewedAt = '2026-08-10';
const groundingToleranceMeters = 0.0005;
const promote = process.argv.includes('--promote');
const toolchain = {
  blender: { version: '4.5.3 LTS', platform: 'macOS arm64', portableDmgUrl: 'https://download.blender.org/release/Blender4.5/blender-4.5.3-macos-arm64.dmg', portableDmgSha256: '73ea841053b55404bb3a71a9a22366f1f8821787fe5c899f8b55a7fff929d01b' },
  python: { version: '3.9.6' },
  pillow: { version: '11.3.0' },
};
const license = { id: 'CC0-1.0', name: 'Creative Commons Zero v1.0 Universal', sourceUrl: 'https://polyhaven.com/license', statement: 'Poly Haven states that all site assets, including 3D models, are licensed CC0.' };
const candidates = [
  { id: 'outdoor_table_chair_set_01', file: 'cafe-seating.glb', classification: 'cafe', role: 'cafe seating', targetTriangles: 5000, closeCard: 'Cafe seating' },
  { id: 'CoffeeCart_01', file: 'cafe-counter.glb', classification: 'cafe', role: 'cafe counter', targetTriangles: 5500, closeCard: 'Cafe counter' },
  { id: 'tea_set_01', file: 'cafe-tableware.glb', classification: 'cafe', role: 'cafe tableware', targetTriangles: 2000, closeCard: 'Cafe tableware' },
  { id: 'steel_frame_shelves_01', file: 'grocer-shelves.glb', classification: 'generic-fixture', role: 'generic steel display shelves', targetTriangles: 2300, closeCard: 'Generic steel shelves' },
  { id: 'wooden_display_shelves_01', file: 'newsstand-rack.glb', classification: 'generic-fixture', role: 'generic wooden display rack', targetTriangles: 2200, closeCard: 'Generic wooden rack' },
];
const forbiddenTags = new Set(['collection: project_lighthouse']);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');
const fail = (message) => { throw new Error(`Ferry Market Arcade CC0 build rejected: ${message}`); };

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'FerryMarketArcadeAssetPack/2.0 (CC0 provenance build)' } });
  if (!response.ok) fail(`${url} returned ${response.status}`);
  return response.json();
}

async function download(url, destination, expectedMd5) {
  const response = await fetch(url, { headers: { 'user-agent': 'FerryMarketArcadeAssetPack/2.0 (CC0 provenance build)' } });
  if (!response.ok) fail(`download ${url} returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (expectedMd5 && md5(bytes) !== expectedMd5) fail(`MD5 mismatch for ${url}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return { path: destination, bytes: bytes.length, md5: md5(bytes), sha256: sha256(bytes), url };
}

function checkToolchain() {
  const blender = process.env.FERRY_MARKET_BLENDER;
  if (!blender || !existsSync(blender)) fail('set FERRY_MARKET_BLENDER to the pinned portable Blender executable in OS temp');
  const resolved = resolve(blender);
  if (![`${resolve(tmpdir())}/`, '/tmp/', '/private/tmp/'].some((prefix) => resolved.startsWith(prefix))) fail('Blender must remain portable under OS temp');
  const blenderVersion = spawnSync(blender, ['--version'], { encoding: 'utf8' });
  if (blenderVersion.status !== 0 || !blenderVersion.stdout.startsWith(`Blender ${toolchain.blender.version}\n`)) fail(`requires Blender ${toolchain.blender.version}`);
  if (process.arch !== 'arm64') fail(`requires ${toolchain.blender.platform}`);
  const python = spawnSync('python3', ['-c', 'import sys; from PIL import __version__; print(".".join(map(str, sys.version_info[:3]))); print(__version__)'], { encoding: 'utf8' });
  const [pythonVersion, pillowVersion] = python.stdout.trim().split('\n');
  if (python.status !== 0 || pythonVersion !== toolchain.python.version || pillowVersion !== toolchain.pillow.version) fail(`requires Python ${toolchain.python.version} and Pillow ${toolchain.pillow.version}`);
  return blender;
}

async function flatFiles(directory) {
  if (!existsSync(directory)) return new Map();
  const entries = await readdir(directory, { withFileTypes: true });
  const files = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) fail(`shipping pack may not contain directory or special entry: ${entry.name}`);
    files.set(entry.name, await readFile(join(directory, entry.name)));
  }
  return files;
}

async function compareDirectories(actualDir, expectedDir) {
  const [actual, expected] = await Promise.all([flatFiles(actualDir), flatFiles(expectedDir)]);
  const names = [...new Set([...actual.keys(), ...expected.keys()])].sort();
  const differences = names.filter((name) => !actual.has(name) || !expected.has(name) || !actual.get(name).equals(expected.get(name)));
  return { equal: differences.length === 0, differences };
}

async function promoteFlatDirectory(stagingDir, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  const staged = await flatFiles(stagingDir);
  const current = await flatFiles(destinationDir);
  for (const [name, bytes] of staged) {
    const incoming = join(destinationDir, `.${name}.incoming`);
    await writeFile(incoming, bytes);
    await rename(incoming, join(destinationDir, name));
  }
  for (const name of current.keys()) if (!staged.has(name)) await unlink(join(destinationDir, name));
}

async function syncQa(stagingQaDir) {
  await mkdir(join(qaDir, 'cards'), { recursive: true });
  await copyFile(join(stagingQaDir, 'contact-sheet.png'), join(qaDir, 'contact-sheet.png'));
  const expected = new Set(candidates.map((candidate) => `${candidate.id}.png`));
  const current = await readdir(join(qaDir, 'cards'), { withFileTypes: true });
  for (const candidate of candidates) await copyFile(join(stagingQaDir, 'cards', `${candidate.id}.png`), join(qaDir, 'cards', `${candidate.id}.png`));
  for (const entry of current) if (entry.isFile() && !expected.has(entry.name)) await unlink(join(qaDir, 'cards', entry.name));
}

async function main() {
  const blender = checkToolchain();
  const buildRoot = await mkdtemp(join(tmpdir(), 'ferry-market-arcade-cc0-build-'));
  const stagingDir = join(buildRoot, 'shipping');
  const stagingQaDir = join(buildRoot, 'qa');
  await Promise.all([mkdir(stagingDir), mkdir(join(stagingQaDir, 'cards'), { recursive: true }), mkdir(sourceCache, { recursive: true })]);
  const assets = [];
  for (const candidate of candidates) {
    const metadataUrl = `https://api.polyhaven.com/info/${candidate.id}`;
    const filesUrl = `https://api.polyhaven.com/files/${candidate.id}`;
    const [metadata, files] = await Promise.all([fetchJson(metadataUrl), fetchJson(filesUrl)]);
    if (metadata.type !== 2 || !metadata.name || !metadata.authors || !metadata.files_hash) fail(`${candidate.id} lacks model metadata`);
    if ([...(metadata.tags ?? []), ...(metadata.categories ?? [])].some((tag) => forbiddenTags.has(tag))) fail(`${candidate.id} is a stylized Project Lighthouse asset`);
    const source = files.gltf?.['1k']?.gltf;
    if (!source?.url || !source?.include) fail(`${candidate.id} has no complete official 1k glTF variant`);
    const sourceRoot = join(sourceCache, candidate.id);
    await mkdir(sourceRoot, { recursive: true });
    const sourceItems = [source, ...Object.entries(source.include).map(([path, value]) => ({ path, ...value }))];
    const sourceFiles = [];
    for (const item of sourceItems) {
      const sourcePath = item.path ?? basename(new URL(item.url).pathname);
      const destination = resolve(sourceRoot, sourcePath);
      if (!destination.startsWith(`${resolve(sourceRoot)}/`)) fail(`${candidate.id} source include escapes its cache directory`);
      sourceFiles.push(await download(item.url, destination, item.md5));
    }
    const outputGlb = join(stagingDir, candidate.file);
    const receiptPath = join(sourceRoot, 'export-receipt-v2.json');
    const configPath = join(sourceRoot, 'export-config-v2.json');
    await writeFile(configPath, `${JSON.stringify({ candidate, sourceGltf: join(sourceRoot, basename(new URL(source.url).pathname)), outputGlb, cardPng: join(stagingQaDir, 'cards', `${candidate.id}.png`), expectedDimensionsMeters: metadata.dimensions.map((value) => value / 1000), receiptPath }, null, 2)}\n`);
    const processor = join(root, 'scripts/world-assets/process-ferry-market-arcade-cc0.py');
    const run = spawnSync(blender, ['--background', '--factory-startup', '--python', processor, '--', configPath], { encoding: 'utf8' });
    if (run.status !== 0) fail(`Blender export failed for ${candidate.id}: ${run.stderr || run.stdout}`);
    const [receipt, glb] = await Promise.all([readFile(receiptPath, 'utf8').then(JSON.parse), readFile(outputGlb)]);
    const measured = inspectFerryMarketGlb(glb);
    if (measured.externalUris.length) fail(`${candidate.id} exported external URIs`);
    if (measured.cameras || measured.lights || measured.emissiveMaterials) fail(`${candidate.id} exported camera/light/emissive content`);
    if (Math.abs(measured.minYMeters) > groundingToleranceMeters) fail(`${candidate.id} minY ${measured.minYMeters}m exceeds grounding tolerance`);
    if (measured.triangles > candidate.targetTriangles) fail(`${candidate.id} has ${measured.triangles} triangles, target ${candidate.targetTriangles}`);
    assets.push({
      ...candidate,
      source: {
        assetPage: `https://polyhaven.com/a/${candidate.id}`, metadataUrl, filesUrl, resolution: '1k',
        metadata: { name: metadata.name, authors: metadata.authors, datePublishedUnix: metadata.date_published, filesHash: metadata.files_hash, dimensionsMillimeters: metadata.dimensions, sourcePolycount: metadata.polycount, tags: metadata.tags, categories: metadata.categories },
        files: sourceFiles.map(({ path, ...file }) => ({ relativePath: relative(sourceRoot, path), ...file })),
        compressedBytes: sourceFiles.reduce((total, file) => total + file.bytes, 0),
      },
      processing: { trianglesBeforeDecimation: receipt.trianglesBeforeDecimation, decimationRatio: receipt.decimationRatio, sourceScaleCorrection: receipt.sourceScaleCorrection, representativeSourceMaterial: receipt.sourceMaterial },
      export: { path: `public/assets/hero/ferry-market-arcade-cc0/${candidate.file}`, ...measured, groundingToleranceMeters },
      qa: { shipping: false, cardPath: `.qa-ferry-market-arcade-cc0/cards/${candidate.id}.png` },
    });
  }
  const budgets = {
    maxSourceCompressedBytes: 20_000_000, maxLod0Triangles: 40_000, maxMaterialsAfterConsolidation: 12,
    sourceCompressedBytes: assets.reduce((sum, asset) => sum + asset.source.compressedBytes, 0),
    exportedBytes: assets.reduce((sum, asset) => sum + asset.export.bytes, 0),
    lod0Triangles: assets.reduce((sum, asset) => sum + asset.export.triangles, 0),
    materialsAfterConsolidation: assets.reduce((sum, asset) => sum + asset.export.materials, 0),
  };
  if (budgets.sourceCompressedBytes > budgets.maxSourceCompressedBytes || budgets.lod0Triangles > budgets.maxLod0Triangles || budgets.materialsAfterConsolidation > budgets.maxMaterialsAfterConsolidation) fail('pack budget exceeded');
  const manifest = {
    schemaVersion: 'ferry-market-arcade-cc0-foundation-v2', reviewedAt, status: 'foundation-approved',
    scope: { description: 'Cafe plus generic-fixtures foundation only.', completeFiveProgramArcade: false, approved: { cafe: ['cafe-seating.glb', 'cafe-counter.glb', 'cafe-tableware.glb'], genericFixtures: ['grocer-shelves.glb', 'newsstand-rack.glb'] }, exclusions: ['No grocer-specific produce/crates', 'No visitor or ticket-program assets', 'No florist-program assets', 'No publication stock', 'No humans'] },
    license, toolchain,
    sourcePolicy: { authority: 'Poly Haven public API and official download CDN only', rejected: ['Project Lighthouse tagged assets', 'human assets', 'cameras, lights, emissive/baked-light exports', 'external GLB URIs'], noGeospatialAuthority: true },
    coordinateSystem: { upAxis: '+Y', forwardAxis: '-Z', unit: 'meters', groundingToleranceMeters, grounding: 'Verifier measures transformed POSITION vertices in each emitted GLB; absolute local minY must be <= 0.5 mm.' },
    budgets, assets,
    qa: { shipping: false, directory: '.qa-ferry-market-arcade-cc0/', contactSheet: '.qa-ferry-market-arcade-cc0/contact-sheet.png' },
    review: { legal: 'passed independent provenance/license review', visual: 'passed independent review for the cafe plus generic-fixtures foundation subset only', code: 'passed independent review of GLB verifier/tooling and clean-checkout behavior', integration: 'not integrated; runtime scene untouched', claimBoundary: 'No five-program completeness or AAA parity claim.' },
  };
  await writeFile(join(stagingDir, 'ferry-market-arcade-cc0.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const sheet = spawnSync('python3', [join(root, 'scripts/world-assets/make-ferry-market-arcade-contact-sheet.py'), stagingDir, stagingQaDir], { encoding: 'utf8' });
  if (sheet.status !== 0) fail(`contact-sheet build failed: ${sheet.stderr || sheet.stdout}`);
  const comparison = await compareDirectories(outputDir, stagingDir);
  if (!comparison.equal && !promote) fail(`rebuild differs at ${comparison.differences.join(', ')}; rerun with --promote after review. Staging: ${buildRoot}`);
  if (!comparison.equal) await promoteFlatDirectory(stagingDir, outputDir);
  await syncQa(stagingQaDir);
  const finalComparison = await compareDirectories(outputDir, stagingDir);
  if (!finalComparison.equal) fail(`post-promotion byte comparison failed: ${finalComparison.differences.join(', ')}`);
  console.log(JSON.stringify({ outputDir, qaDir, reproducibleByteMatch: comparison.equal, promoted: !comparison.equal, staging: buildRoot, assets: assets.length, budgets }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
