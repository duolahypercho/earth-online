#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1,
  SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
} from '../src/sf-map/building-presentation-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SF_MAP_SOURCE_TONE_RUNTIME_QA_PORT || 5207);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUTPUT_ROOT = process.env.SF_MAP_SOURCE_TONE_RUNTIME_QA_DIR
  || path.join(ROOT, '.qa-sf-map-source-tone-runtime-i51');
const TILE_ID = 'epsg26910-1441-10893';
const PRODUCTION_MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const PROOF_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-source-tone-production-proof-v1');
const PROOF_MANIFEST_PATH = path.join(PROOF_ROOT, 'sf-building-source-tone-production-proof-v1.manifest.json');
const MANIFEST_REQUEST = '**/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json';
const TEST_RECEIPT_URL = 'data/world/preview-artifacts/sf-building-source-tone-production-proof-v1/qa-authorized-ferry.metric-receipt.json';

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function waitForPort(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const unavailable = await new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(true));
      server.once('listening', () => server.close(() => resolve(false)));
      server.listen(PORT, '127.0.0.1');
    });
    if (unavailable) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not open port ${PORT}`);
}

const productionManifest = JSON.parse(await readFile(PRODUCTION_MANIFEST_PATH));
const productionTile = productionManifest.tiles.find(({ id }) => id === TILE_ID);
assert(productionTile, `${TILE_ID} is absent from the production manifest`);
assert.equal(productionTile.presentation, undefined, 'Production Ferry tile must remain legacy');

const proofManifest = JSON.parse(await readFile(PROOF_MANIFEST_PATH));
const proofTile = proofManifest.tiles.find(({ tile }) => tile === TILE_ID);
assert(proofTile, `${TILE_ID} source-tone production-shaped proof is absent`);
assert.equal(proofManifest.productionPromotionAuthorized, false);
const metricReceipt = JSON.parse(await readFile(path.join(ROOT, proofTile.metricReceipt.path)));
assert.equal(metricReceipt.presentation.productionWriteEnabled, false);
assert.equal(metricReceipt.presentation.productionPromotionAuthorized, undefined);
const authorizedReceipt = structuredClone(metricReceipt);
authorizedReceipt.presentation.productionWriteEnabled = true;
authorizedReceipt.presentation.productionPromotionAuthorized = true;
authorizedReceipt.presentation.status = 'qa-only-authorized-clone-not-production';
const authorizedReceiptBytes = jsonBytes(authorizedReceipt);
const authorizedReceiptSha256 = digest(authorizedReceiptBytes);
const candidateManifestTile = {
  id: TILE_ID,
  gridIndex: productionTile.gridIndex,
  originEpsg26910VerticalMetres: productionTile.originEpsg26910VerticalMetres,
  tileSizeMetres: productionManifest.tiling.tileSizeMetres,
  lod0: { path: proofTile.artifact.path, sha256: proofTile.artifact.sha256 },
  receipt: { path: TEST_RECEIPT_URL, sha256: authorizedReceiptSha256 },
  presentation: {
    mode: 'source-tone-v1',
    productionWriteEnabled: true,
    productionPromotionAuthorized: true,
    contractSha256: SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1,
    contract: SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
  },
};

const manifests = {
  legacy: { ...productionManifest, tiles: [productionTile] },
  sourceTone: { ...productionManifest, tiles: [candidateManifestTile] },
};

const vite = spawn(process.execPath, [
  path.join(ROOT, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: 'ignore' });

let browser;
try {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await waitForPort();
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const captures = [];
  for (const runIndex of [1, 2]) for (const mode of ['legacy', 'sourceTone']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    const requestEvents = [];
    let requestEventOrder = 0;
    const artifactKind = (url) => {
      if (url.endsWith('.glb')) return 'glb';
      if (url.includes('.receipt.json') || url.includes('metric-receipt.json')) return 'receipt';
      return null;
    };
    page.on('request', (request) => {
      const kind = artifactKind(request.url());
      if (kind) requestEvents.push({ order: requestEventOrder++, event: 'requested', kind, url: request.url() });
    });
    page.on('requestfinished', (request) => {
      const kind = artifactKind(request.url());
      if (kind) requestEvents.push({ order: requestEventOrder++, event: 'finished', kind, url: request.url() });
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route(MANIFEST_REQUEST, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(manifests[mode]),
    }));
    if (mode === 'sourceTone') await page.route(`**/${TEST_RECEIPT_URL}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: authorizedReceiptBytes,
    }));
    await page.goto(`${BASE_URL}/sf-map.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.__SF_MAP_VIEWER__), undefined, { timeout: 30_000 });
    await page.waitForFunction(() => {
      const viewer = window.__SF_MAP_VIEWER__;
      const diagnostics = viewer?.streamingDiagnostics;
      return viewer?.residentTileIds.length === 1
        && diagnostics?.activeLoadCount === 0
        && diagnostics?.queuedCount === 0;
    }, undefined, { timeout: 60_000 });
    await page.addStyleTag({ content: `
      *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
      .landmark, #loading { display: none !important; }
    ` });
    await page.waitForTimeout(500);
    const runtime = await page.evaluate((tileId) => {
      const viewer = window.__SF_MAP_VIEWER__;
      const diagnostics = viewer.streamingDiagnostics;
      const tile = diagnostics.tiles.find(({ id }) => id === tileId);
      return {
        anchor: viewer.anchorOriginEpsg26910,
        descriptors: viewer.tileDescriptors,
        residents: viewer.residentTileIds,
        camera: diagnostics.camera,
        metric: diagnostics.metricContract,
        presentation: diagnostics.presentation,
        tile,
        rejected: diagnostics.completed.filter(({ result }) => result === 'rejected'),
      };
    }, TILE_ID);
    assert.deepEqual(runtime.anchor, productionTile.originEpsg26910VerticalMetres);
    assert.equal(runtime.descriptors.length, 1);
    assert.equal(runtime.descriptors[0].id, TILE_ID);
    assert.deepEqual(runtime.descriptors[0].offset, [0, 0, 0]);
    assert.equal(runtime.metric.runtimeUnitsPerMetre, 1);
    assert.equal(runtime.metric.sceneScale, 1);
    assert.equal(runtime.metric.originSubtractions, 1);
    assert.equal(runtime.metric.sourceLockedDescriptors, true);
    assert.deepEqual(runtime.rejected, []);
    assert.equal(runtime.tile.presentationMode, mode === 'legacy' ? 'legacy' : 'source-tone-v1');
    assert.equal(runtime.tile.integrity.glb.status, 'verified');
    assert.equal(runtime.tile.integrity.receipt.status, 'verified');
    if (mode === 'sourceTone') {
      assert.equal(runtime.tile.integrity.presentation.status, 'verified-production-authorization');
      assert.equal(runtime.tile.integrity.presentation.actualSourceToneAttributeSha256, metricReceipt.presentation.ledgers.sourceToneAttributeSha256);
    }
    const receiptFinished = requestEvents.find(({ event, kind }) => event === 'finished' && kind === 'receipt');
    const glbRequested = requestEvents.find(({ event, kind }) => event === 'requested' && kind === 'glb');
    assert(receiptFinished, `${mode} did not finish a receipt request`);
    assert(glbRequested, `${mode} did not request a GLB`);
    assert(receiptFinished.order < glbRequested.order, `${mode} requested its GLB before its receipt request finished`);
    assert.equal(errors.length, 0, `${mode} browser errors: ${errors.join(' | ')}`);
    const screenshotPath = path.join(OUTPUT_ROOT, `${mode}-run-${runIndex}.png`);
    const screenshotBytes = await page.screenshot({ path: screenshotPath });
    captures.push({ mode, runIndex, screenshotPath, screenshotSha256: digest(screenshotBytes), runtime, errors, requestEvents, receiptFinishedBeforeGlbRequested: true });
    await page.close();
  }

  for (const mode of ['legacy', 'sourceTone']) {
    const matches = captures.filter((capture) => capture.mode === mode);
    assert.equal(matches.length, 2);
    assert.equal(matches[0].screenshotSha256, matches[1].screenshotSha256, `${mode} fresh-boot screenshots are not byte-identical`);
    assert.deepEqual(matches[0].runtime.residents, matches[1].runtime.residents, `${mode} resident IDs changed across boots`);
  }
  const legacy = captures.find(({ mode, runIndex }) => mode === 'legacy' && runIndex === 1);
  const sourceTone = captures.find(({ mode, runIndex }) => mode === 'sourceTone' && runIndex === 1);
  assert.notEqual(legacy.screenshotSha256, sourceTone.screenshotSha256, 'Source-tone runtime render is pixel-identical to legacy');
  assert.deepEqual(legacy.runtime.camera, sourceTone.runtime.camera, 'Runtime camera changed between matched modes');
  assert.equal(legacy.runtime.presentation.performance.drawCalls, sourceTone.runtime.presentation.performance.drawCalls, 'Source-tone changed runtime draw calls');
  assert.equal(legacy.runtime.presentation.performance.triangles, sourceTone.runtime.presentation.performance.triangles, 'Source-tone changed runtime triangles');

  await browser.close();
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  const comparisonPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const images = await Promise.all([legacy, sourceTone].map(async (capture) => `data:image/png;base64,${(await readFile(capture.screenshotPath)).toString('base64')}`));
  await comparisonPage.setContent(`<!doctype html><style>html,body{margin:0;background:#07100f;color:#d7ff48;font:700 13px monospace}.grid{display:grid;grid-template-columns:1fr 1fr}.frame{position:relative}.frame label{position:absolute;z-index:2;top:18px;left:18px;padding:8px 11px;border:1px solid #55665e;background:#07100fdd}.frame img{display:block;width:640px;height:720px;object-fit:cover}</style><div class="grid"><div class="frame"><label>LEGACY · PRODUCTION BYTES</label><img src="${images[0]}"></div><div class="frame"><label>SOURCE-TONE · QA-ONLY AUTHORIZED CLONE</label><img src="${images[1]}"></div></div>`);
  const comparisonPath = path.join(OUTPUT_ROOT, 'legacy-vs-source-tone-runtime.png');
  await comparisonPage.screenshot({ path: comparisonPath });
  await comparisonPage.close();

  const report = {
    result: 'SF map source-tone actual runtime path passed',
    status: 'qa-only-authorized-clone-not-production',
    productionManifestTiles: productionManifest.tiles.length,
    productionPromotionAuthorized: false,
    tileId: TILE_ID,
    metric: { epsg: 26910, runtimeUnitsPerMetre: 1, vertical: 'source-declared-navd88-unrealized' },
    captures: captures.map(({ mode, runIndex, screenshotPath, screenshotSha256, runtime, requestEvents, receiptFinishedBeforeGlbRequested }) => ({ mode, runIndex, screenshotPath, screenshotSha256, residents: runtime.residents, camera: runtime.camera, performance: runtime.presentation.performance, tileIntegrity: runtime.tile.integrity, requestEvents, receiptFinishedBeforeGlbRequested })),
    comparisonPath,
    invariants: {
      receiptFinishedBeforeGlbRequested: captures.every((capture) => capture.receiptFinishedBeforeGlbRequested),
      sourceToneContractSha256: SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1,
      decodedToneHashBound: true,
      metricOriginScaleUnchanged: true,
      drawCallsUnchanged: true,
      trianglesUnchanged: true,
      repeatedFreshBootPngsExact: true,
      productionFilesMutated: false,
    },
  };
  await writeFile(path.join(OUTPUT_ROOT, 'report.json'), jsonBytes(report));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
