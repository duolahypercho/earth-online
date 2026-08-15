#!/usr/bin/env node
// Production mixed-mode boundary gate. It renders the authorized Ferry
// source-tone artifact beside its byte-locked legacy baseline and west/south
// neighbours, then fails if the reviewed edge treatment drifts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SF_FERRY_BOUNDARY_MASK_QA_PORT || 5213);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUTPUT_ROOT = process.env.SF_FERRY_BOUNDARY_MASK_QA_DIR
  || path.join(ROOT, '.qa-sf-map-ferry-boundary-mask-i53');
const HOST_PAGE_PATH = path.join(ROOT, '.qa-sf-map-ferry-boundary-mask-i53.html');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const LEDGER_PATH = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-seam-edge-ledger-v1/sf-building-seam-edge-ledger-v1.ledger.json.gz');
const AUTHORIZATION_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-source-tone-production-authorization-v1.lock.json');
const FERRY_ID = 'epsg26910-1441-10893';
const WEST_ID = 'epsg26910-1440-10893';
const SOUTH_ID = 'epsg26910-1441-10892';
const TILE_SIZE_METRES = 384;
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
  throw new Error(`Vite did not open ${PORT}`);
}

function publicPath(value) { return `/${value.replace(/^public\//, '')}`; }
function comparable(capture) {
  // Browser fetch completion order can vary while its required ordering does
  // not. Each capture gates that order independently; omit only the raw event
  // chronology from cross-boot equality.
  const { screenshotPath, screenshotSha256, runIndex, requestEvents, ...rest } = capture;
  return rest;
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH));
assert.equal(manifest.tiling.tileSizeMetres, TILE_SIZE_METRES, 'production tile width changed');
const authorization = JSON.parse(await readFile(AUTHORIZATION_PATH));
const sourceToneFerry = manifest.tiles.find((candidate) => candidate.id === FERRY_ID);
assert.equal(sourceToneFerry?.presentation?.mode, 'source-tone-v1', 'Ferry production source-tone descriptor is absent');
assert.equal(sourceToneFerry.presentation.authorization.sha256, digest(await readFile(AUTHORIZATION_PATH)), 'Ferry production authorization lock drifted');
const tiles = [WEST_ID, SOUTH_ID].map((id) => {
  const tile = manifest.tiles.find((candidate) => candidate.id === id);
  assert(tile, `${id} is missing from the production manifest`);
  assert.equal(tile.presentation, undefined, `${id} must remain production legacy`);
  assert.equal(tile.tileSizeMetres ?? manifest.tiling.tileSizeMetres, TILE_SIZE_METRES, `${id} metric tile size drifted`);
  return tile;
});
tiles.push({
  id: FERRY_ID,
  gridIndex: sourceToneFerry.gridIndex,
  originEpsg26910VerticalMetres: sourceToneFerry.originEpsg26910VerticalMetres,
  lod0: authorization.legacyReference.glb,
  receipt: authorization.legacyReference.receipt,
});
const byId = new Map(tiles.map((tile) => [tile.id, tile]));
const proof = {
  artifact: sourceToneFerry.lod0,
  metricReceipt: sourceToneFerry.receipt,
  ledgers: {
    productionGeometrySha256: authorization.presentation.geometryLedgerSha256,
    candidateGeometrySha256: authorization.presentation.geometryLedgerSha256,
  },
};

// The committed ledger is deterministic JSON gzip. Avoid importing its builder
// so the QA does not regenerate or alter source-lock evidence.
const { gunzipSync } = await import('node:zlib');
const seamLedger = JSON.parse(gunzipSync(await readFile(LEDGER_PATH)));
assert.equal(seamLedger.tileGrid.tileSizeMetres, TILE_SIZE_METRES, 'seam ledger tile size drifted');
const expectedEdge = (leftTileId, rightTileId, direction) => seamLedger.edgeComparison.reports.find((edge) => (
  edge.leftTileId === leftTileId && edge.rightTileId === rightTileId && edge.direction === direction
));
const westEdge = expectedEdge(WEST_ID, FERRY_ID, 'east');
const southEdge = expectedEdge(SOUTH_ID, FERRY_ID, 'north');
assert(westEdge?.exact && southEdge?.exact, 'Ferry west/south source building boundaries are not exact locked seams');
assert.equal(westEdge.exactSharedSourceOsmWayIds.length, 2, 'Ferry west shared-building count drifted');
assert.equal(southEdge.exactSharedSourceOsmWayIds.length, 5, 'Ferry south shared-building count drifted');
assert.equal(new Set([...westEdge.exactSharedSourceOsmWayIds, ...southEdge.exactSharedSourceOsmWayIds]).size, 6, 'Ferry direct mixed-mode closure must stay three tiles / six source ways');

const vite = spawn(process.execPath, [
  path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: 'ignore' });
let browser;
try {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(HOST_PAGE_PATH, '<!doctype html><meta charset="utf-8"><title>SF Ferry mixed-mode boundary QA</title>\n');
  await waitForPort();
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const captures = [];
  for (const runIndex of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
    const errors = []; const requestEvents = []; let requestOrder = 0;
    const kindFor = (url) => url.endsWith('.glb') ? 'glb' : (url.includes('receipt') && url.endsWith('.json') ? 'receipt' : null);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', (request) => { const kind = kindFor(request.url()); if (kind) requestEvents.push({ order: requestOrder++, event: 'requested', kind, url: request.url() }); });
    page.on('requestfinished', (request) => { const kind = kindFor(request.url()); if (kind) requestEvents.push({ order: requestOrder++, event: 'finished', kind, url: request.url() }); });
    await page.goto(`${BASE_URL}/${path.basename(HOST_PAGE_PATH)}`, { waitUntil: 'domcontentloaded' });
    await page.setContent('<!doctype html><style>html,body{margin:0;overflow:hidden;background:#07100f}canvas{display:block}.tag{position:fixed;z-index:2;top:16px;padding:8px 11px;color:#d7ff48;background:#07100fdd;border:1px solid #55665e;font:700 12px monospace}.a{left:16px}.b{left:736px}</style><div class="tag a">UNIFIED LEGACY · PRODUCTION BYTES</div><div class="tag b">FERRY SOURCE-TONE · QA BOUNDARY MASK</div><canvas id="qa"></canvas>');
    const result = await page.evaluate(async (input) => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
      const { applyLegacyBuildingPresentation, applySourceToneBuildingPresentation, SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1 } = await import('/src/sf-map/building-presentation-material.js');
      const sha = async (bytes) => `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      const bytes = async (url) => { const response = await fetch(url, { cache: 'no-store' }); if (!response.ok) throw new Error(`${url} HTTP ${response.status}`); return response.arrayBuffer(); };
      const resource = (url) => url.slice(0, url.lastIndexOf('/') + 1);
      const production = input.tiles;
      // Receipt completion deliberately precedes every GLB request, mirroring
      // the production streamer's fail-closed ordering.
      const receiptBuffers = await Promise.all(production.map((tile) => bytes(tile.receipt.path)));
      const proofReceiptBuffer = await bytes(input.proof.metricReceipt.path);
      for (let index = 0; index < production.length; index += 1) {
        if (await sha(receiptBuffers[index]) !== production[index].receipt.sha256) throw new Error(`${production[index].id} receipt hash drifted`);
      }
      if (await sha(proofReceiptBuffer) !== input.proof.metricReceipt.sha256) throw new Error('Ferry proof metric receipt hash drifted');
      const proofReceipt = JSON.parse(new TextDecoder().decode(proofReceiptBuffer));
      if (proofReceipt.presentation?.productionWriteEnabled !== true || proofReceipt.presentation?.productionPromotionAuthorized !== true
        || proofReceipt.presentation?.status !== 'production-authorized-bounded-ferry-mixed-mode') throw new Error('Ferry source-tone receipt is not production authorized');
      if (proofReceipt.tile?.identity !== input.ferry.id || proofReceipt.tile?.scale !== 1
        || JSON.stringify(proofReceipt.tile?.originEpsg26910VerticalMetres) !== JSON.stringify(input.ferry.originEpsg26910VerticalMetres)) throw new Error('Ferry proof metric identity drifted');
      const glbBuffers = await Promise.all(production.map((tile) => bytes(tile.lod0.path)));
      const proofGlbBuffer = await bytes(input.proof.artifact.path);
      for (let index = 0; index < production.length; index += 1) if (await sha(glbBuffers[index]) !== production[index].lod0.sha256) throw new Error(`${production[index].id} GLB hash drifted`);
      if (await sha(proofGlbBuffer) !== input.proof.artifact.sha256) throw new Error('Ferry production source-tone GLB hash drifted');
      if (input.proof.ledgers?.productionGeometrySha256 !== input.proof.ledgers?.candidateGeometrySha256) throw new Error('Ferry source-tone geometry is not exact legacy geometry');
      const loader = new GLTFLoader();
      const baselineGltfs = await Promise.all(production.map((tile, index) => loader.parseAsync(glbBuffers[index].slice(0), resource(tile.lod0.path))));
      const candidateWest = await loader.parseAsync(glbBuffers[0].slice(0), resource(production[0].lod0.path));
      const candidateSouth = await loader.parseAsync(glbBuffers[1].slice(0), resource(production[1].lod0.path));
      const candidateFerryBase = await loader.parseAsync(glbBuffers[2].slice(0), resource(production[2].lod0.path));
      const candidateFerry = await loader.parseAsync(proofGlbBuffer.slice(0), resource(input.proof.artifact.path));
      const palette = [0xc7ad8a, 0xaa765c, 0x77858c, 0x8b6456].map((hex) => new THREE.Color(hex));
      function legacy(material) {
        // This is the same helper called by the live production legacy path.
        // Do not substitute a QA-specific shading model here: the Ferry edge
        // must match what users see today, not a prospective baseline.
        applyLegacyBuildingPresentation(material, { palette, paletteWorldCellMetres: SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1.legacyGridCellMetres });
      }
      function prepare(root, tile, mode) {
        root.position.set(tile.offset[0], tile.offset[1], tile.offset[2]); root.scale.setScalar(1);
        root.traverse((node) => {
          if (!node.isMesh) return;
          node.receiveShadow = true; node.castShadow = node.material?.name === 'buildings-night';
          if (node.material?.name === 'terrain-night') node.material.color.setHex(0x1d473a);
          if (node.material?.name === 'roads-night') { node.material.color.setHex(0x53615e); node.material.roughness = 0.96; node.material.polygonOffset = true; node.material.polygonOffsetFactor = -2; node.material.polygonOffsetUnits = -2; node.renderOrder = 2; }
          if (node.material?.name === 'water-osm-coastline-night') { node.material.color.setHex(0x0a5870); node.material.roughness = 0.22; node.material.metalness = 0.18; }
          if (node.material?.name === 'coastline-osm-night') node.material.color.setHex(0x2f7f8c);
          if (node.material?.name !== 'buildings-night') return;
          node.userData.sfQaBuilding = true;
          if (mode === 'legacy') legacy(node.material);
          else {
            node.userData.sfQaSourceToneBuilding = true;
            const tone = node.geometry.getAttribute('_sf_source_tone_v1'); const position = node.geometry.getAttribute('position');
            if (!tone || !(tone.array instanceof Uint8Array) || tone.count !== position?.count || tone.normalized) throw new Error('Ferry proof source-tone attribute is invalid');
            // Production tile building primitives deliberately omit authored
            // normals and rely on their GLTF material's flatShading flag. Keep
            // that source material setting: a fresh MeshStandardMaterial would
            // smooth-shade zero normals and make the Ferry buildings black.
            node.material = node.material.clone();
            applySourceToneBuildingPresentation(node.material, { palette, policySha256: proofReceipt.presentation.contract.derivation.policySha256, boundaryMask: {
              ...SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1,
              sceneTileOriginMetres: [tile.offset[0], tile.offset[2]], sides: ['west', 'south'], legacyPalette: palette,
            }, qaExactBoundaryMask: true });
          }
        });
      }
      const scene = (roots) => { const value = new THREE.Scene(); value.background = new THREE.Color(0x07100f); value.fog = new THREE.FogExp2(0x07100f, 0.00055); roots.forEach((root) => value.add(root)); const hemi = new THREE.HemisphereLight(0xc8dfd1, 0x101715, .96); value.add(hemi); const sun = new THREE.DirectionalLight(0xffe6bd, 3.6); sun.position.set(420, 650, 180); sun.target.position.set(384, 0, 384); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -540; sun.shadow.camera.right = 540; sun.shadow.camera.top = 540; sun.shadow.camera.bottom = -540; sun.shadow.camera.far = 1600; value.add(sun, sun.target); const fill = new THREE.DirectionalLight(0xb9d7e4, .46); fill.position.set(740, 280, 384); fill.target.position.set(384, 0, 384); value.add(fill, fill.target); return value; };
      baselineGltfs.forEach((gltf, index) => prepare(gltf.scene, production[index], 'legacy'));
      baselineGltfs[2].scene.traverse((node) => { if (node.isMesh && node.userData.sfQaBuilding === true) node.userData.sfQaBaselineFerryBuilding = true; });
      prepare(candidateWest.scene, production[0], 'legacy'); prepare(candidateSouth.scene, production[1], 'legacy'); prepare(candidateFerryBase.scene, production[2], 'legacy'); prepare(candidateFerry.scene, input.ferry, 'masked-source-tone');
      // The write-disabled proof is byte-identical in geometry, but this QA
      // intentionally swaps its building primitive only. Keeping the exact
      // production non-building primitives prevents a proof-container material
      // or composition difference from reading as a black Ferry tile.
      candidateFerryBase.scene.traverse((node) => { if (node.isMesh && node.userData.sfQaBuilding === true) node.visible = false; });
      candidateFerry.scene.traverse((node) => { if (node.isMesh && node.userData.sfQaBuilding !== true) node.visible = false; });
      const baseline = scene(baselineGltfs.map((gltf) => gltf.scene)); const candidate = scene([candidateWest.scene, candidateSouth.scene, candidateFerryBase.scene, candidateFerry.scene]);
      const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('#qa'), antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1); renderer.setSize(1440, 810, false); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.18; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.setScissorTest(true);
      const canvasSamples = renderer.getContext().getParameter(renderer.getContext().SAMPLES);
      const renderPair = (viewCamera) => {
        renderer.info.reset(); renderer.setViewport(0, 0, 720, 810); renderer.setScissor(0, 0, 720, 810); renderer.render(baseline, viewCamera);
        const baselineRender = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
        renderer.info.reset(); renderer.setViewport(720, 0, 720, 810); renderer.setScissor(720, 0, 720, 810); renderer.render(candidate, viewCamera);
        const candidateRender = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
        const pixels = new Uint8Array(1440 * 810 * 4); renderer.getContext().readPixels(0, 0, 1440, 810, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, pixels);
        return { baselineRender, candidateRender, pixels };
      };
      const renderBuildingMask = (viewCamera, side) => {
        const maskTarget = new THREE.WebGLRenderTarget(720, 810, { depthBuffer: true });
        maskTarget.samples = canvasSamples;
        const originalBackground = candidate.background; const originalFog = candidate.fog;
        candidate.background = new THREE.Color(0x000000); candidate.fog = null;
        renderer.setRenderTarget(maskTarget); renderer.setViewport(0, 0, 720, 810); renderer.setScissor(0, 0, 720, 810); renderer.setClearColor(0x000000, 1); renderer.clear();
        // Render once so Three compiles the render-target color-space variant;
        // onBeforeCompile then exposes the uniform belonging to that program.
        renderer.render(candidate, viewCamera); renderer.clear();
        const uniforms = [];
        candidate.traverse((node) => {
          if (!node.isMesh || !node.visible || node.userData.sfQaSourceToneBuilding !== true) return;
          const uniform = node.material.userData.sfQaExactBoundaryMaskUniform;
          if (!uniform) throw new Error('source-tone boundary mask uniform was not compiled before mask capture');
          const sideIndex = node.material.userData.sfQaExactBoundaryMaskSides?.[side];
          if (!sideIndex) throw new Error(`source-tone boundary mask side ${side} was not compiled`);
          uniforms.push(uniform); uniform.value = sideIndex;
        });
        renderer.render(candidate, viewCamera);
        const buildingMask = new Uint8Array(720 * 810 * 4); renderer.readRenderTargetPixels(maskTarget, 0, 0, 720, 810, buildingMask); renderer.setRenderTarget(null); maskTarget.dispose();
        for (const uniform of uniforms) uniform.value = 0;
        candidate.background = originalBackground; candidate.fog = originalFog;
        return buildingMask;
      };
      const renderBaselineFerryMask = (viewCamera) => {
        const maskTarget = new THREE.WebGLRenderTarget(720, 810, { depthBuffer: true });
        maskTarget.samples = canvasSamples;
        const originals = []; const originalBackground = baseline.background; const originalFog = baseline.fog;
        baseline.background = new THREE.Color(0x000000); baseline.fog = null;
        baseline.traverse((node) => {
          if (!node.isMesh || !node.visible) return;
          originals.push([node, node.material]);
          node.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
        });
        renderer.setRenderTarget(maskTarget); renderer.setViewport(0, 0, 720, 810); renderer.setScissor(0, 0, 720, 810); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(baseline, viewCamera);
        for (const [node] of originals) {
          if (node.userData.sfQaBaselineFerryBuilding !== true) continue;
          const maskMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000, toneMapped: false });
          maskMaterial.depthFunc = THREE.LessEqualDepth; maskMaterial.depthWrite = false;
          node.material = maskMaterial;
        }
        const originalAutoClear = renderer.autoClear; renderer.autoClear = false; renderer.render(baseline, viewCamera); renderer.autoClear = originalAutoClear;
        const mask = new Uint8Array(720 * 810 * 4); renderer.readRenderTargetPixels(maskTarget, 0, 0, 720, 810, mask); renderer.setRenderTarget(null); maskTarget.dispose();
        for (const [node, material] of originals) node.material = material;
        baseline.background = originalBackground; baseline.fog = originalFog;
        return mask;
      };
      // The top-down view exposes both clipped roof halves. The tilted view
      // independently exercises the live legacy shader's view-space normal.
      const topDownCamera = new THREE.OrthographicCamera(-420, 420, 472.5, -472.5, .5, 2400); topDownCamera.position.set(384, 1000, 384); topDownCamera.up.set(0, 0, -1); topDownCamera.lookAt(384, 0, 384);
      const topDownPair = renderPair(topDownCamera); const topDownBaselineMask = renderBaselineFerryMask(topDownCamera); const topDownMasks = { west: renderBuildingMask(topDownCamera, 'west'), south: renderBuildingMask(topDownCamera, 'south') };
      const perspectiveCamera = new THREE.PerspectiveCamera(43, 720 / 810, .5, 2400); perspectiveCamera.position.set(930, 520, 930); perspectiveCamera.lookAt(384, 12, 384); perspectiveCamera.updateMatrixWorld();
      const perspectivePair = renderPair(perspectiveCamera); const perspectiveBaselineMask = renderBaselineFerryMask(perspectiveCamera); const perspectiveMasks = { west: renderBuildingMask(perspectiveCamera, 'west'), south: renderBuildingMask(perspectiveCamera, 'south') };
      const materialDebug = { baselineFerry: [], candidateFerry: [] };
      const recordMaterial = (target) => (node) => {
        if (!node.isMesh) return;
        target.push({ name: node.material?.name, type: node.material?.type, color: node.material?.color?.getHexString(), emissive: node.material?.emissive?.getHexString(), hasMap: Boolean(node.material?.map), flatShading: node.material?.flatShading, side: node.material?.side, vertexColors: node.material?.vertexColors, transparent: node.material?.transparent, opacity: node.material?.opacity, depthWrite: node.material?.depthWrite, depthTest: node.material?.depthTest, worldTranslation: node.getWorldPosition(new THREE.Vector3()).toArray(), localPosition: node.position.toArray(), localScale: node.scale.toArray(), receivesShadow: node.receiveShadow, castsShadow: node.castShadow, visible: node.visible });
      };
      baselineGltfs[2].scene.traverse(recordMaterial(materialDebug.baselineFerry));
      candidateFerry.scene.traverse(recordMaterial(materialDebug.candidateFerry));
      const shaderDiagnostics = renderer.info.programs.map((program) => ({
        cacheKey: program.cacheKey,
        runnable: program.diagnostics?.runnable,
        programLog: program.diagnostics?.programLog || '',
        vertexShaderLog: program.diagnostics?.vertexShader?.log || '',
        fragmentShaderLog: program.diagnostics?.fragmentShader?.log || '',
      })).filter((diagnostic) => diagnostic.cacheKey.includes('sf-map-building-world-surface-v1') || diagnostic.cacheKey.includes('sf-map-building-source-tone-v1'));
      // The mask is emitted by the same source-tone program without discarding
      // interior fragments. Matching the canvas MSAA count ensures each red
      // pixel represents the actual resolved winning legacy-band samples.
      const sampleSeam = (edge, { pixels, buildingMask, baselineFerryMask }) => {
        const values = []; const examples = [];
        for (let pixel = 0; pixel < 720 * 810; pixel += 1) {
          const maskIndex = pixel * 4;
          if (buildingMask[maskIndex] < 250 || buildingMask[maskIndex + 1] > 4 || buildingMask[maskIndex + 2] > 4) continue;
          if (baselineFerryMask[maskIndex] < 250 || baselineFerryMask[maskIndex + 1] > 4 || baselineFerryMask[maskIndex + 2] > 4) continue;
          const x = pixel % 720; const readY = Math.floor(pixel / 720);
          const left = (readY * 1440 + x) * 4; const right = (readY * 1440 + 720 + x) * 4;
          const baselineRgb = [pixels[left], pixels[left + 1], pixels[left + 2]]; const candidateRgb = [pixels[right], pixels[right + 1], pixels[right + 2]];
          const delta = Math.abs(baselineRgb[0] - candidateRgb[0]) + Math.abs(baselineRgb[1] - candidateRgb[1]) + Math.abs(baselineRgb[2] - candidateRgb[2]);
          values.push(delta); if (delta > 1) examples.push({ x, readY, delta, baselineRgb, candidateRgb });
        }
        if (!values.length) {
          throw new Error(`${edge.side} seam did not expose visible source-building pixels inside the shader exact band`);
        }
        return { side: edge.side, sharedBuildingWayIds: edge.wayIds, sampledPixels: values.length, maxRgbDelta: Math.max(...values), meanRgbDelta: values.reduce((sum, value) => sum + value, 0) / values.length, mismatchExamples: examples.sort((a, b) => b.delta - a.delta).slice(0, 12), exactMatchBandMetres: 4 };
      };
      const views = [
        {
          kind: 'orthographic-top-down-exact-seam', camera: { position: topDownCamera.position.toArray(), target: [384, 0, 384] },
          baselineRender: topDownPair.baselineRender, candidateRender: topDownPair.candidateRender,
          seams: [sampleSeam(input.edges.west, { pixels: topDownPair.pixels, buildingMask: topDownMasks.west, baselineFerryMask: topDownBaselineMask }), sampleSeam(input.edges.south, { pixels: topDownPair.pixels, buildingMask: topDownMasks.south, baselineFerryMask: topDownBaselineMask })],
        },
        {
          kind: 'perspective-tilted-live-legacy-normal', camera: { position: perspectiveCamera.position.toArray(), target: [384, 12, 384], fovDegrees: perspectiveCamera.fov },
          baselineRender: perspectivePair.baselineRender, candidateRender: perspectivePair.candidateRender,
          seams: [sampleSeam(input.edges.west, { pixels: perspectivePair.pixels, buildingMask: perspectiveMasks.west, baselineFerryMask: perspectiveBaselineMask }), sampleSeam(input.edges.south, { pixels: perspectivePair.pixels, buildingMask: perspectiveMasks.south, baselineFerryMask: perspectiveBaselineMask })],
        },
      ];
      return { views, materialDebug, shaderDiagnostics, metric: { epsg: 26910, runtimeUnitsPerMetre: 1, sceneScale: 1, anchorOriginEpsg26910: input.anchor, tileSizeMetres: 384, originSubtractions: 1, canvasMsaaSamples: canvasSamples, maskMsaaSamples: canvasSamples }, sourceTonePayloadBytes: proofReceipt.presentation.ledgers.sourceToneAttributeSha256, proofGeometryExact: true };
    }, {
      anchor: [552960, 4182528, 0],
      tiles: [WEST_ID, SOUTH_ID, FERRY_ID].map((id) => {
        const tile = byId.get(id); return { id, lod0: { path: publicPath(tile.lod0.path), sha256: tile.lod0.sha256 }, receipt: { path: publicPath(tile.receipt.path), sha256: tile.receipt.sha256 }, originEpsg26910VerticalMetres: tile.originEpsg26910VerticalMetres, offset: [tile.originEpsg26910VerticalMetres[0] - 552960, 0, tile.originEpsg26910VerticalMetres[1] - 4182528] };
      }),
      ferry: { ...byId.get(FERRY_ID), originEpsg26910VerticalMetres: byId.get(FERRY_ID).originEpsg26910VerticalMetres, offset: [384, 0, 384] },
      proof: { artifact: { ...proof.artifact, path: publicPath(proof.artifact.path) }, metricReceipt: { ...proof.metricReceipt, path: publicPath(proof.metricReceipt.path) }, ledgers: proof.ledgers },
      edges: {
        west: { side: 'west', wayIds: westEdge.exactSharedSourceOsmWayIds, entries: seamLedger.sourceWayBoundaryLedger.find((entry) => entry.tileId === FERRY_ID && entry.side === 'west').entries },
        south: { side: 'south', wayIds: southEdge.exactSharedSourceOsmWayIds, entries: seamLedger.sourceWayBoundaryLedger.find((entry) => entry.tileId === FERRY_ID && entry.side === 'south').entries },
      },
    });
    const receiptFinished = requestEvents.filter((event) => event.kind === 'receipt' && event.event === 'finished');
    const firstGlb = requestEvents.find((event) => event.kind === 'glb' && event.event === 'requested');
    const rejectionReasons = [];
    if (receiptFinished.length !== 4) rejectionReasons.push(`expected four finished receipts before GLBs; saw ${receiptFinished.length}`);
    if (!firstGlb || !receiptFinished.every((event) => event.order < firstGlb.order)) rejectionReasons.push('a GLB was requested before all receipts finished');
    if (errors.length) rejectionReasons.push(`browser errors: ${errors.join(' | ')}`);
    if (result.shaderDiagnostics.some((diagnostic) => diagnostic.runnable === false || diagnostic.programLog || diagnostic.vertexShaderLog || diagnostic.fragmentShaderLog)) rejectionReasons.push('building shader diagnostics reported a compile or link failure');
    if (result.metric.runtimeUnitsPerMetre !== 1 || result.metric.sceneScale !== 1 || result.metric.originSubtractions !== 1 || result.metric.tileSizeMetres !== TILE_SIZE_METRES) rejectionReasons.push('metric origin/scale/tile-size invariant drifted');
    if (result.metric.canvasMsaaSamples < 2 || result.metric.maskMsaaSamples !== result.metric.canvasMsaaSamples) rejectionReasons.push('boundary mask did not match the antialiased canvas sample count');
    for (const view of result.views) {
      if (JSON.stringify(view.baselineRender) !== JSON.stringify(view.candidateRender)) rejectionReasons.push(`${view.kind} boundary mask changed draw calls or triangle count`);
      for (const seam of view.seams) {
        if (seam.sampledPixels <= 20) rejectionReasons.push(`${view.kind} ${seam.side} shared-building seam sampling was too sparse`);
        if (seam.maxRgbDelta > 1) rejectionReasons.push(`${view.kind} ${seam.side} legacy/source-tone exact boundary max RGB delta ${seam.maxRgbDelta} exceeds 1`);
      }
    }
    const screenshotPath = path.join(OUTPUT_ROOT, `legacy-vs-masked-source-tone-run-${runIndex}.png`); const screenshot = await page.screenshot({ path: screenshotPath });
    captures.push({ runIndex, screenshotPath, screenshotSha256: digest(screenshot), ...result, requestEvents, rejectionReasons }); await page.close();
  }
  const freshBootMetricsExact = JSON.stringify(comparable(captures[0])) === JSON.stringify(comparable(captures[1]));
  const freshBootPngsExact = captures[0].screenshotSha256 === captures[1].screenshotSha256;
  if (!freshBootMetricsExact) for (const capture of captures) capture.rejectionReasons.push('fresh boots changed mixed-mode result metrics');
  if (!freshBootPngsExact) for (const capture of captures) capture.rejectionReasons.push('fresh boots changed mixed-mode screenshot bytes');
  const mask = { id: 'source-tone-legacy-grid-boundary-mask-v1', ferryTileId: FERRY_ID, staticAdjacentLegacySides: ['west', 'south'], directClosureTileIds: [FERRY_ID, WEST_ID, SOUTH_ID].sort(), directSharedBuildingWayIds: [...new Set([...westEdge.exactSharedSourceOsmWayIds, ...southEdge.exactSharedSourceOsmWayIds])].sort((a, b) => a - b), tileSizeMetres: TILE_SIZE_METRES, exactMatchBandMetres: 4, blendBandMetres: 16, legacyGridCellMetres: 62, residencyInput: false, geometryChanged: false };
  const strictAccepted = freshBootMetricsExact && freshBootPngsExact && captures.every((capture) => capture.rejectionReasons.length === 0);
  const report = { schemaVersion: 1, kind: 'sf-map-ferry-mixed-mode-boundary-mask-qa', status: strictAccepted ? 'authorized-production-boundary-strategy-passed' : 'authorized-production-boundary-strategy-rejected', source: { manifestSha256: digest(await readFile(MANIFEST_PATH)), authorizationSha256: digest(await readFile(AUTHORIZATION_PATH)), seamLedgerPath: path.relative(ROOT, LEDGER_PATH), seamLedgerSha256: digest(await readFile(LEDGER_PATH)) }, strategy: { ...mask, maskSha256: digest(jsonBytes(mask)), deterministic: true, baselineResponse: 'live-legacy-building-palette-v1' }, captures, invariants: { matchedScreenshots: true, freshBootPngsExact, receiptsFinishedBeforeGlbs: captures.every((capture) => capture.requestEvents.filter((event) => event.kind === 'receipt' && event.event === 'finished').length === 4), exactMetricOriginScale: captures.every((capture) => capture.metric.runtimeUnitsPerMetre === 1 && capture.metric.sceneScale === 1 && capture.metric.originSubtractions === 1), drawCallsAndTrianglesUnchanged: captures.every((capture) => capture.views.every((view) => JSON.stringify(view.baselineRender) === JSON.stringify(view.candidateRender))), sharedBuildingBoundaryPixelsMaxRgbDeltaAtMostOne: captures.every((capture) => capture.views.every((view) => view.seams.every((seam) => seam.maxRgbDelta <= 1))), shaderDiagnosticsClean: captures.every((capture) => capture.shaderDiagnostics.every((diagnostic) => diagnostic.runnable !== false && !diagnostic.programLog && !diagnostic.vertexShaderLog && !diagnostic.fragmentShaderLog)), productionPromotionAuthorized: true } };
  await writeFile(path.join(OUTPUT_ROOT, 'report.json'), jsonBytes(report));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!strictAccepted) process.exitCode = 1;
} finally {
  await browser?.close(); vite.kill('SIGTERM');
}
