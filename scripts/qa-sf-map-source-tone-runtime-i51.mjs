#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1 } from '../src/sf-map/building-presentation-contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SF_MAP_SOURCE_TONE_RUNTIME_QA_PORT || 5207);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUTPUT_ROOT = process.env.SF_MAP_SOURCE_TONE_RUNTIME_QA_DIR
  || path.join(ROOT, '.qa-sf-map-source-tone-runtime-i51');
const TILE_ID = 'epsg26910-1441-10893';
const PRODUCTION_MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const MANIFEST_REQUEST = '**/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json';
const FALLBACK_MANIFEST_REQUESTS = [
  MANIFEST_REQUEST,
  '**/data/world/production-artifacts/sf-metric-tiles.manifest.json',
  '**/data/world/production-artifacts/metric-tiles.manifest.json',
];

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
assert.equal(productionTile.presentation?.mode, 'source-tone-v1', 'Production Ferry tile must use the authorized source-tone descriptor');
assert.equal(productionTile.presentation.productionWriteEnabled, true);
assert.equal(productionTile.presentation.productionPromotionAuthorized, true);
const metricReceipt = JSON.parse(await readFile(path.join(ROOT, productionTile.receipt.path)));
const legacyManifestTile = {
  id: TILE_ID,
  gridIndex: productionTile.gridIndex,
  originEpsg26910VerticalMetres: productionTile.originEpsg26910VerticalMetres,
  tileSizeMetres: productionManifest.tiling.tileSizeMetres,
  lod0: {
    path: 'public/data/world/production-artifacts/ferry-production-tile-v1/ferry-production-tile-v1.lod0.glb',
    sha256: 'sha256:ca6021f03d8335f80b0ebcaab9b50320f6f302b2ab8a1b886cd9995a45074310',
  },
  receipt: {
    path: 'public/data/world/production-artifacts/ferry-production-tile-v1/ferry-production-tile-v1.receipt.json',
    sha256: 'sha256:fdba34c57b6af539a5a2d53bc185f3dd091ede4323f836c7716c619bf07c15fd',
  },
};
const supportTileIds = ['epsg26910-1440-10893', 'epsg26910-1441-10892', 'epsg26910-1431-10882'];
const supportTiles = supportTileIds.map((id) => {
  const tile = productionManifest.tiles.find((candidate) => candidate.id === id);
  assert(tile, `${id} is absent from the production manifest`);
  assert.equal(tile.presentation, undefined, `${id} must remain legacy for the mixed-mode gate`);
  return tile;
});
const expectedFerryResidentIds = [TILE_ID, ...supportTileIds.slice(0, 2)].sort();

const manifests = {
  legacy: { ...productionManifest, tiles: [legacyManifestTile, ...supportTiles] },
  sourceTone: { ...productionManifest, tiles: [productionTile, ...supportTiles] },
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
      if (url.endsWith('.lock.json')) return 'authorization';
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
    await page.goto(`${BASE_URL}/sf-map.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.__SF_MAP_VIEWER__), undefined, { timeout: 30_000 });
    await page.waitForFunction(() => {
      const viewer = window.__SF_MAP_VIEWER__;
      const diagnostics = viewer?.streamingDiagnostics;
      return viewer?.residentTileIds.length === 3
        && diagnostics?.activeLoadCount === 0
        && diagnostics?.queuedCount === 0;
    }, undefined, { timeout: 60_000 });
    await page.evaluate(() => window.__SF_MAP_VIEWER__.setView('district'));
    await page.waitForFunction(() => window.__SF_MAP_VIEWER__.residentTileIds.length === 0, undefined, { timeout: 30_000 });
    await page.evaluate(() => window.__SF_MAP_VIEWER__.setView('ferry'));
    await page.waitForFunction(() => {
      const viewer = window.__SF_MAP_VIEWER__;
      return viewer.residentTileIds.length === 3
        && viewer.streamingDiagnostics.activeLoadCount === 0
        && viewer.streamingDiagnostics.queuedCount === 0;
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
    assert.equal(runtime.descriptors.length, 4);
    assert.equal(runtime.descriptors[0].id, TILE_ID);
    assert.deepEqual(runtime.descriptors[0].offset, [0, 0, 0]);
    assert.deepEqual([...runtime.residents].sort(), expectedFerryResidentIds);
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
      assert.equal(runtime.tile.integrity.authorization.status, 'production-authorized-bounded-ferry-mixed-mode');
    }
    const receiptFinished = requestEvents.find(({ event, kind }) => event === 'finished' && kind === 'receipt');
    const glbRequested = requestEvents.find(({ event, kind }) => event === 'requested' && kind === 'glb');
    assert(receiptFinished, `${mode} did not finish a receipt request`);
    assert(glbRequested, `${mode} did not request a GLB`);
    assert(receiptFinished.order < glbRequested.order, `${mode} requested its GLB before its receipt request finished`);
    const authorizationFinished = requestEvents.find(({ event, kind }) => event === 'finished' && kind === 'authorization');
    if (mode === 'sourceTone') {
      assert(authorizationFinished, 'sourceTone did not finish its production authorization request');
      assert(authorizationFinished.order < glbRequested.order, 'sourceTone requested its GLB before production authorization finished');
    }
    assert.equal(errors.length, 0, `${mode} browser errors: ${errors.join(' | ')}`);
    const screenshotPath = path.join(OUTPUT_ROOT, `${mode}-run-${runIndex}.png`);
    const screenshotBytes = await page.screenshot({ path: screenshotPath });
    captures.push({ mode, runIndex, screenshotPath, screenshotSha256: digest(screenshotBytes), runtime, errors, requestEvents, receiptFinishedBeforeGlbRequested: true, authorizationFinishedBeforeGlbRequested: mode === 'legacy' || authorizationFinished.order < glbRequested.order, unloadReloadPassed: true });
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

  const fallbackPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const fallbackErrors = [];
  fallbackPage.on('pageerror', (error) => fallbackErrors.push(error.message));
  fallbackPage.on('console', (message) => { if (message.type() === 'error') fallbackErrors.push(message.text()); });
  for (const request of FALLBACK_MANIFEST_REQUESTS) {
    await fallbackPage.route(request, (route) => route.fulfill({ status: 404, body: 'missing for fallback gate' }));
  }
  await fallbackPage.goto(`${BASE_URL}/sf-map.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await fallbackPage.waitForFunction(() => window.__SF_MAP_VIEWER__?.residentTileIds.length === 1, undefined, { timeout: 60_000 });
  const fallbackRuntime = await fallbackPage.evaluate(() => ({
    descriptors: window.__SF_MAP_VIEWER__.tileDescriptors,
    tile: window.__SF_MAP_VIEWER__.streamingDiagnostics.tiles[0],
  }));
  assert.equal(fallbackRuntime.tile.presentationMode, 'legacy');
  assert.equal(`sha256:${fallbackRuntime.tile.integrity.glb.actualSha256}`, legacyManifestTile.lod0.sha256);
  assert.equal(fallbackErrors.length, FALLBACK_MANIFEST_REQUESTS.length);
  assert(fallbackErrors.every((message) => message === 'Failed to load resource: the server responded with a status of 404 (Not Found)'), `Unexpected fallback errors: ${fallbackErrors.join(' | ')}`);
  await fallbackPage.close();
  await browser.close();
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  const comparisonPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const images = await Promise.all([legacy, sourceTone].map(async (capture) => `data:image/png;base64,${(await readFile(capture.screenshotPath)).toString('base64')}`));
  await comparisonPage.setContent(`<!doctype html><style>html,body{margin:0;background:#07100f;color:#d7ff48;font:700 13px monospace}.grid{display:grid;grid-template-columns:1fr 1fr}.frame{position:relative}.frame label{position:absolute;z-index:2;top:18px;left:18px;padding:8px 11px;border:1px solid #55665e;background:#07100fdd}.frame img{display:block;width:640px;height:720px;object-fit:cover}</style><div class="grid"><div class="frame"><label>LEGACY · FALLBACK BYTES</label><img src="${images[0]}"></div><div class="frame"><label>SOURCE-TONE · AUTHORIZED PRODUCTION</label><img src="${images[1]}"></div></div>`);
  const comparisonPath = path.join(OUTPUT_ROOT, 'legacy-vs-source-tone-runtime.png');
  await comparisonPage.screenshot({ path: comparisonPath });
  await comparisonPage.close();

  const report = {
    result: 'SF map source-tone actual runtime path passed',
    status: 'authorized-production-ferry-source-tone-v1',
    productionManifestTiles: productionManifest.tiles.length,
    productionPromotionAuthorized: true,
    tileId: TILE_ID,
    metric: { epsg: 26910, runtimeUnitsPerMetre: 1, vertical: 'source-declared-navd88-unrealized' },
    captures: captures.map(({ mode, runIndex, screenshotPath, screenshotSha256, runtime, requestEvents, receiptFinishedBeforeGlbRequested }) => ({ mode, runIndex, screenshotPath, screenshotSha256, residents: runtime.residents, camera: runtime.camera, performance: runtime.presentation.performance, tileIntegrity: runtime.tile.integrity, requestEvents, receiptFinishedBeforeGlbRequested })),
    comparisonPath,
    invariants: {
      receiptFinishedBeforeGlbRequested: captures.every((capture) => capture.receiptFinishedBeforeGlbRequested),
      authorizationFinishedBeforeGlbRequested: captures.every((capture) => capture.authorizationFinishedBeforeGlbRequested),
      sourceToneContractSha256: SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1,
      decodedToneHashBound: true,
      metricOriginScaleUnchanged: true,
      drawCallsUnchanged: true,
      trianglesUnchanged: true,
      repeatedFreshBootPngsExact: true,
      unloadReloadPassed: captures.every((capture) => capture.unloadReloadPassed),
      legacyManifestFailureFallbackPassed: true,
    },
  };
  await writeFile(path.join(OUTPUT_ROOT, 'report.json'), jsonBytes(report));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
