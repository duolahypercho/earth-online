#!/usr/bin/env node
// QA-only mixed-mode proof. This does not authorize a production presentation
// change: it renders the byte-locked Ferry source-tone proof beside its legacy
// west/south neighbours and fails if the reviewed edge treatment drifts.
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
const PROOF_MANIFEST_PATH = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-source-tone-production-proof-v1/sf-building-source-tone-production-proof-v1.manifest.json');
const LEDGER_PATH = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-seam-edge-ledger-v1/sf-building-seam-edge-ledger-v1.ledger.json.gz');
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
const tiles = [WEST_ID, SOUTH_ID, FERRY_ID].map((id) => {
  const tile = manifest.tiles.find((candidate) => candidate.id === id);
  assert(tile, `${id} is missing from the production manifest`);
  assert.equal(tile.presentation, undefined, `${id} must remain production legacy`);
  assert.equal(tile.tileSizeMetres ?? manifest.tiling.tileSizeMetres, TILE_SIZE_METRES, `${id} metric tile size drifted`);
  return tile;
});
const byId = new Map(tiles.map((tile) => [tile.id, tile]));
const proofManifest = JSON.parse(await readFile(PROOF_MANIFEST_PATH));
assert.equal(proofManifest.productionPromotionAuthorized, false, 'proof manifest is not write-disabled');
const proof = proofManifest.tiles.find((tile) => tile.tile === FERRY_ID);
assert(proof, 'Ferry production-shaped source-tone proof is absent');

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
      const { applyLegacyGridBuildingPresentation, applySourceToneBuildingPresentation, SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1 } = await import('/src/sf-map/building-presentation-material.js');
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
      if (proofReceipt.presentation?.productionWriteEnabled !== false || proofReceipt.presentation?.productionPromotionAuthorized !== undefined
        || proofReceipt.presentation?.status !== 'write-disabled-production-shaped-proof') throw new Error('Ferry proof is not a write-disabled QA artifact');
      if (proofReceipt.tile?.identity !== input.ferry.id || proofReceipt.tile?.scale !== 1
        || JSON.stringify(proofReceipt.tile?.originEpsg26910VerticalMetres) !== JSON.stringify(input.ferry.originEpsg26910VerticalMetres)) throw new Error('Ferry proof metric identity drifted');
      const glbBuffers = await Promise.all(production.map((tile) => bytes(tile.lod0.path)));
      const proofGlbBuffer = await bytes(input.proof.artifact.path);
      for (let index = 0; index < production.length; index += 1) if (await sha(glbBuffers[index]) !== production[index].lod0.sha256) throw new Error(`${production[index].id} GLB hash drifted`);
      if (await sha(proofGlbBuffer) !== input.proof.artifact.sha256) throw new Error('Ferry source-tone proof GLB hash drifted');
      if (input.proof.ledgers?.productionGeometrySha256 !== input.proof.ledgers?.candidateGeometrySha256) throw new Error('Ferry proof geometry is not exact production geometry');
      const loader = new GLTFLoader();
      const baselineGltfs = await Promise.all(production.map((tile, index) => loader.parseAsync(glbBuffers[index].slice(0), resource(tile.lod0.path))));
      const candidateWest = await loader.parseAsync(glbBuffers[0].slice(0), resource(production[0].lod0.path));
      const candidateSouth = await loader.parseAsync(glbBuffers[1].slice(0), resource(production[1].lod0.path));
      const candidateFerryBase = await loader.parseAsync(glbBuffers[2].slice(0), resource(production[2].lod0.path));
      const candidateFerry = await loader.parseAsync(proofGlbBuffer.slice(0), resource(input.proof.artifact.path));
      const palette = [0xc7ad8a, 0xaa765c, 0x77858c, 0x8b6456].map((hex) => new THREE.Color(hex));
      function legacy(material) {
        applyLegacyGridBuildingPresentation(material, { palette, legacyGridCellMetres: SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1.legacyGridCellMetres });
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
            } });
          }
        });
      }
      const scene = (roots) => { const value = new THREE.Scene(); value.background = new THREE.Color(0x07100f); value.fog = new THREE.FogExp2(0x07100f, 0.00055); roots.forEach((root) => value.add(root)); const hemi = new THREE.HemisphereLight(0xc8dfd1, 0x101715, .96); value.add(hemi); const sun = new THREE.DirectionalLight(0xffe6bd, 3.6); sun.position.set(420, 650, 180); sun.target.position.set(384, 0, 384); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -540; sun.shadow.camera.right = 540; sun.shadow.camera.top = 540; sun.shadow.camera.bottom = -540; sun.shadow.camera.far = 1600; value.add(sun, sun.target); const fill = new THREE.DirectionalLight(0xb9d7e4, .46); fill.position.set(740, 280, 384); fill.target.position.set(384, 0, 384); value.add(fill, fill.target); return value; };
      baselineGltfs.forEach((gltf, index) => prepare(gltf.scene, production[index], 'legacy'));
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
      // The proof view is deliberately top-down: both clipped roof halves are
      // visible, so the edge metric cannot silently sample an occluded facade.
      const camera = new THREE.OrthographicCamera(-420, 420, 472.5, -472.5, .5, 2400); camera.position.set(384, 1000, 384); camera.up.set(0, 0, -1); camera.lookAt(384, 0, 384); const candidateCamera = camera.clone();
      renderer.setViewport(0, 0, 720, 810); renderer.setScissor(0, 0, 720, 810); renderer.render(baseline, camera); const baselineRender = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }; renderer.info.reset();
      renderer.setViewport(720, 0, 720, 810); renderer.setScissor(720, 0, 720, 810); renderer.render(candidate, candidateCamera); const candidateRender = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      const materialDebug = [];
      candidateFerry.scene.traverse((node) => {
        if (!node.isMesh) return;
        materialDebug.push({ name: node.material?.name, type: node.material?.type, color: node.material?.color?.getHexString(), emissive: node.material?.emissive?.getHexString(), hasMap: Boolean(node.material?.map), receivesShadow: node.receiveShadow, castsShadow: node.castShadow, visible: node.visible });
      });
      const shaderDiagnostics = renderer.info.programs.map((program) => ({
        cacheKey: program.cacheKey,
        runnable: program.diagnostics?.runnable,
        programLog: program.diagnostics?.programLog || '',
        vertexShaderLog: program.diagnostics?.vertexShader?.log || '',
        fragmentShaderLog: program.diagnostics?.fragmentShader?.log || '',
      })).filter((diagnostic) => diagnostic.cacheKey.includes('sf-map-building-world-surface-v1'));
      const pixels = new Uint8Array(1440 * 810 * 4); renderer.getContext().readPixels(0, 0, 1440, 810, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, pixels);
      const maskTarget = new THREE.WebGLRenderTarget(720, 810, { depthBuffer: true });
      const originals = []; const originalBackground = candidate.background; const originalFog = candidate.fog;
      candidateWest.scene.visible = false; candidateSouth.scene.visible = false; candidateFerryBase.scene.visible = false; candidate.background = new THREE.Color(0x000000); candidate.fog = null;
      candidateFerry.scene.traverse((node) => {
        if (!node.isMesh || node.userData.sfQaBuilding !== true) return;
        originals.push([node, node.material]); node.material = new THREE.MeshBasicMaterial({ color: 0xff0000, toneMapped: false });
      });
      renderer.setRenderTarget(maskTarget); renderer.setViewport(0, 0, 720, 810); renderer.setScissor(0, 0, 720, 810); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(candidate, candidateCamera);
      const buildingMask = new Uint8Array(720 * 810 * 4); renderer.readRenderTargetPixels(maskTarget, 0, 0, 720, 810, buildingMask); renderer.setRenderTarget(null); maskTarget.dispose();
      for (const [node, material] of originals) node.material = material;
      candidateWest.scene.visible = true; candidateSouth.scene.visible = true; candidateFerryBase.scene.visible = true; candidate.background = originalBackground; candidate.fog = originalFog;
      // Project the locked world seam intervals and compare only a 4m exact-match
      // band. This measures actual rendered pixels, not a material-only surrogate.
      const project = (x, y, z, xOffset) => { const v = new THREE.Vector3(x, y, z).project(camera); return [Math.round((v.x * .5 + .5) * 720 + xOffset), Math.round((-v.y * .5 + .5) * 810)]; };
      const sampleSeam = (edge) => {
        const values = [];
        for (const entry of edge.entries) {
          const [start, end] = entry.worldEndpointsEpsg26910Metres;
          // Probe 0..3m inside Ferry. The material's first 4m is an exact
          // legacy response, so every accepted pixel is inside that policy
          // band even after raster rounding.
          for (let inset = 0; inset <= 3; inset += 1) {
            const a = edge.side === 'west' ? [384 + inset, 1, start[1] - input.anchor[1]] : [start[0] - input.anchor[0], 1, 384 + inset];
            const b = edge.side === 'west' ? [384 + inset, 1, end[1] - input.anchor[1]] : [end[0] - input.anchor[0], 1, 384 + inset];
            const pa = project(...a, 0); const pb = project(...b, 0); const dx = pb[0] - pa[0]; const dy = pb[1] - pa[1]; const length = Math.max(1, Math.round(Math.hypot(dx, dy)));
            for (let step = 0; step <= length; step += 1) {
              const ratio = step / length; const x = Math.round(pa[0] + dx * ratio); const yy = Math.round(pa[1] + dy * ratio);
            if (x < 0 || x >= 720 || yy < 0 || yy >= 810) continue;
            const readY = 809 - yy;
            const maskIndex = (readY * 720 + x) * 4;
            if (buildingMask[maskIndex] < 250 || buildingMask[maskIndex + 1] > 4 || buildingMask[maskIndex + 2] > 4) continue;
            const left = (readY * 1440 + x) * 4; const right = (readY * 1440 + 720 + x) * 4;
            values.push(Math.abs(pixels[left] - pixels[right]) + Math.abs(pixels[left + 1] - pixels[right + 1]) + Math.abs(pixels[left + 2] - pixels[right + 2]));
            }
          }
        }
        if (!values.length) {
          let redPixels = 0; let minX = 720; let maxX = -1; let minY = 810; let maxY = -1;
          for (let index = 0; index < buildingMask.length; index += 4) if (buildingMask[index] > 250 && buildingMask[index + 1] < 4 && buildingMask[index + 2] < 4) { redPixels += 1; const pixel = index / 4; const x = pixel % 720; const y = Math.floor(pixel / 720); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
          throw new Error(`${edge.side} seam did not project to screen building pixels (Ferry building mask red ${redPixels}; read bounds ${minX},${minY}..${maxX},${maxY})`);
        }
        return { side: edge.side, sharedBuildingWayIds: edge.wayIds, sampledPixels: values.length, maxRgbDelta: Math.max(...values), meanRgbDelta: values.reduce((sum, value) => sum + value, 0) / values.length, exactMatchBandMetres: 4 };
      };
      const seams = [sampleSeam(input.edges.west), sampleSeam(input.edges.south)];
      return { baselineRender, candidateRender, seams, materialDebug, shaderDiagnostics, camera: { kind: 'orthographic-top-down-exact-seam', position: camera.position.toArray(), target: [384, 0, 384] }, metric: { epsg: 26910, runtimeUnitsPerMetre: 1, sceneScale: 1, anchorOriginEpsg26910: input.anchor, tileSizeMetres: 384, originSubtractions: 1 }, sourceTonePayloadBytes: proofReceipt.presentation.ledgers.sourceToneAttributeSha256, proofGeometryExact: true };
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
    if (JSON.stringify(result.baselineRender) !== JSON.stringify(result.candidateRender)) rejectionReasons.push('boundary mask changed draw calls or triangle count');
    if (result.metric.runtimeUnitsPerMetre !== 1 || result.metric.sceneScale !== 1 || result.metric.originSubtractions !== 1 || result.metric.tileSizeMetres !== TILE_SIZE_METRES) rejectionReasons.push('metric origin/scale/tile-size invariant drifted');
    for (const seam of result.seams) {
      if (seam.sampledPixels <= 20) rejectionReasons.push(`${seam.side} shared-building seam sampling was too sparse`);
      if (seam.maxRgbDelta > 1) rejectionReasons.push(`${seam.side} legacy/source-tone exact boundary max RGB delta ${seam.maxRgbDelta} exceeds 1`);
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
  const report = { schemaVersion: 1, kind: 'sf-map-ferry-mixed-mode-boundary-mask-qa', status: strictAccepted ? 'qa-only-boundary-strategy-passed-not-production' : 'qa-only-boundary-strategy-rejected-not-production', nonPromotion: 'No production manifest, GLB, source geometry, tile origin, or gameplay input was changed.', source: { manifestSha256: digest(await readFile(MANIFEST_PATH)), seamLedgerPath: path.relative(ROOT, LEDGER_PATH), seamLedgerSha256: digest(await readFile(LEDGER_PATH)) }, strategy: { ...mask, maskSha256: digest(jsonBytes(mask)), deterministic: true, baselineResponse: 'canonical-world-space-fragment-derivative-v1' }, captures, invariants: { matchedScreenshots: true, freshBootPngsExact, receiptsFinishedBeforeGlbs: captures.every((capture) => capture.requestEvents.filter((event) => event.kind === 'receipt' && event.event === 'finished').length === 4), exactMetricOriginScale: captures.every((capture) => capture.metric.runtimeUnitsPerMetre === 1 && capture.metric.sceneScale === 1 && capture.metric.originSubtractions === 1), drawCallsAndTrianglesUnchanged: captures.every((capture) => JSON.stringify(capture.baselineRender) === JSON.stringify(capture.candidateRender)), sharedBuildingBoundaryPixelsMaxRgbDeltaAtMostOne: captures.every((capture) => capture.seams.every((seam) => seam.maxRgbDelta <= 1)), productionPromotionAuthorized: false } };
  await writeFile(path.join(OUTPUT_ROOT, 'report.json'), jsonBytes(report));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!strictAccepted) process.exitCode = 1;
} finally {
  await browser?.close(); vite.kill('SIGTERM');
}
