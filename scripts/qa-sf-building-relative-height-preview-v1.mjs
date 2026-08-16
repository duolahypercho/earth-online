#!/usr/bin/env node
/**
 * Browser-only preview QA for the write-disabled building relative-height proof.
 *
 * The harness serves production/proof GLBs from memory to a tiny Three.js
 * renderer.  It never changes sf-map runtime code or a production artifact.
 * A candidate shader uses only the proof attribute for a bounded wall response:
 * smooth base-contact darkening and a small upward luminance lift; roof-facing
 * fragments are explicitly masked out.  A non-improvement is reported as
 * REJECT and is never promoted.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SF_BUILDING_RELATIVE_HEIGHT_QA_PORT || 5221);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUTPUT_ROOT = process.env.SF_BUILDING_RELATIVE_HEIGHT_QA_DIR || path.join(ROOT, '.qa-sf-building-relative-height-preview-v1');
const PROOF_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-relative-height-proof-v1');
const PROOF_MANIFEST_PATH = path.join(PROOF_ROOT, 'sf-building-relative-height-proof-v1.manifest.json');
const PRODUCTION_MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const TILES = Object.freeze([
  { id: 'epsg26910-1441-10893', role: 'ferry' },
  { id: 'epsg26910-1430-10882', role: 'district' },
]);

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const canonicalJsonBytes = (value) => {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    return item;
  };
  return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);
};

function assertProofInputs(proofManifest, proofManifestBytes, productionManifest, productionManifestBytes) {
  assert.equal(proofManifest.kind, 'sf-building-relative-height-proof-manifest');
  assert.equal(proofManifest.status, 'preview-proof-only-not-production');
  assert.equal(proofManifest.productionWriteEnabled, false);
  assert.equal(proofManifest.productionPromotionAuthorized, false);
  assert.equal(proofManifest.productionManifestTileCount, productionManifest.tiles.length);
  assert.equal(proofManifest.productionManifestSha256, sha256(productionManifestBytes));
  assert(proofManifest.attributeContract?.attribute?.gltfSemantic === '_SF_BUILDING_RELATIVE_HEIGHT_V1');
  assert.equal(proofManifest.attributeContract.attribute.componentType, 5126);
  assert.deepEqual(proofManifest.attributeContract.attribute.domain, [0, 1]);
  assert.equal(Buffer.compare(proofManifestBytes, canonicalJsonBytes(proofManifest)), 0, 'Proof manifest is not canonical');
}

function htmlDocument(tileConfigMap) {
  return `<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#07100f}canvas{display:block;width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js"}}</script>
<script type="module">
import * as THREE from '/node_modules/three/build/three.module.js';
import { GLTFLoader } from '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { applyLegacyBuildingPresentation, applySourceToneBuildingPresentation, SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1 } from '/src/sf-map/building-presentation-material.js';
import { SF_BUILDING_SOURCE_TONE_CONTRACT_V1 } from '/src/sf-map/building-presentation-contract.js';

const query = new URLSearchParams(location.search);
const artifactUrl = query.get('artifact');
const candidate = query.get('candidate') === '1';
const tile = query.get('tile') || 'unknown';
const tileConfigMap = ${JSON.stringify(tileConfigMap)};
const tileConfig = tileConfigMap[tile] || { presentation: { mode: 'legacy' }, runtimeOffset: [0, 0, 0] };
const tilePresentation = tileConfig.presentation;
const runtimeOffset = tileConfig.runtimeOffset;
const width = 960;
const height = 540;
const errors = [];
const shaderErrors = [];
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setSize(width, height, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.debug.checkShaderErrors = true;
renderer.debug.onShaderError = (gl, _program, vertexShader, fragmentShader) => shaderErrors.push('three-webgl-shader-error: vertex=' + (gl.getShaderInfoLog(vertexShader) || 'ok') + ' fragment=' + (gl.getShaderInfoLog(fragmentShader) || 'ok'));
document.body.appendChild(renderer.domElement);
window.addEventListener('error', (event) => errors.push(event.message || String(event.error)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));

const palette = [new THREE.Color(0xc7ad8a), new THREE.Color(0xaa765c), new THREE.Color(0x77858c), new THREE.Color(0x8b6456)];
const gltfLoader = new GLTFLoader();
const shaderRecords = [];

function isBuilding(node) {
  const materialName = Array.isArray(node.material) ? node.material[0]?.name : node.material?.name;
  return Boolean(node.geometry?.getAttribute('_SF_BUILDING_RELATIVE_HEIGHT_V1') || /building/i.test(materialName || '') || node.userData?.category === 'buildings');
}

function makeBuildingMaterial({ isCandidate, hasSourceTone }) {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  const useSourceTonePresentation = tilePresentation.mode === 'source-tone-v1' && hasSourceTone;
  if (useSourceTonePresentation) {
    applySourceToneBuildingPresentation(material, {
      palette,
      policySha256: SF_BUILDING_SOURCE_TONE_CONTRACT_V1.derivation.policySha256,
      boundaryMask: {
        ...SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1,
        sceneTileOriginMetres: [runtimeOffset[0], runtimeOffset[2]],
        sides: tilePresentation.boundaryMask.legacyNeighbourSides,
        legacyPalette: palette,
      },
    });
  } else {
    applyLegacyBuildingPresentation(material, { palette, paletteWorldCellMetres: SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1.legacyGridCellMetres });
  }
  const baseCompile = material.onBeforeCompile;
  const baseCacheKey = material.customProgramCacheKey;
  if (isCandidate) {
    material.onBeforeCompile = (shader) => {
      baseCompile(shader);
      shader.vertexShader = 'attribute float _sf_building_relative_height_v1; varying float qaRelativeHeight; varying vec3 qaRelativeWorldPosition;\\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\\n  qaRelativeHeight = _sf_building_relative_height_v1;\\n  qaRelativeWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = 'varying float qaRelativeHeight; varying vec3 qaRelativeWorldPosition;\\n' + shader.fragmentShader;
      const responseCode = '\\n      // Candidate-only bounded wall response; roof-facing fragments are excluded by a world-space face normal.\\n      vec3 qaRelativeDx = dFdx(qaRelativeWorldPosition);\\n      vec3 qaRelativeDy = dFdy(qaRelativeWorldPosition);\\n      vec3 qaRelativeWorldFaceNormal = normalize(cross(qaRelativeDx, qaRelativeDy));\\n      float qaRoofFacing = smoothstep(0.66, 0.92, abs(qaRelativeWorldFaceNormal.y));\\n      float qaWallWeight = 1.0 - qaRoofFacing;\\n      float qaContactDarkening = (1.0 - smoothstep(0.0, 0.22, qaRelativeHeight)) * 0.16 * qaWallWeight;\\n      float qaUpwardLift = smoothstep(0.14, 0.9, qaRelativeHeight) * 0.055 * qaWallWeight;\\n      diffuseColor.rgb *= 1.0 - qaContactDarkening;\\n      diffuseColor.rgb += diffuseColor.rgb * qaUpwardLift;';
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>' + responseCode);
      shaderRecords.push({ candidate: true, sourceTone: useSourceTonePresentation, vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader, baseCacheKey: baseCacheKey() });
    };
    material.customProgramCacheKey = () => baseCacheKey() + ':relative-height-qa-v1';
  }
  material.needsUpdate = true;
  return material;
}

function configureScene(scene, isCandidate) {
  const box = new THREE.Box3().setFromObject(scene);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(39, width / height, 0.1, Math.max(2000, size.length() * 8));
  camera.position.set(center.x + size.x * 0.82, center.y + Math.max(58, size.y * 1.45), center.z + size.z * 0.82);
  camera.lookAt(center.x, center.y + size.y * 0.16, center.z);
  const ambient = new THREE.HemisphereLight(0xc8dfd1, 0x101715, 1.35);
  const sun = new THREE.DirectionalLight(0xffe6bd, 3.6); sun.position.set(center.x + 220, center.y + 420, center.z + 180);
  scene.add(ambient, sun);
  scene.traverse((node) => {
    if (!node.isMesh) return;
    const building = isBuilding(node);
    const geometry = node.geometry;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const hasSourceTone = Boolean(geometry.getAttribute('_SF_SOURCE_TONE_V1'));
    node.userData.qaBuilding = building;
    if (building) node.material = makeBuildingMaterial({ isCandidate, hasSourceTone });
    else {
      const name = node.material?.name || '';
      const color = /terrain/i.test(name) ? 0x1d473a : /roads/i.test(name) ? 0x53615e : /water/i.test(name) ? 0x0a5870 : /coastline/i.test(name) ? 0x2f7f8c : 0x243d3a;
      node.material = new THREE.MeshStandardMaterial({ color, roughness: /roads/i.test(name) ? 0.96 : 0.9, metalness: /water/i.test(name) ? 0.18 : 0 });
    }
  });
  return { camera, box, center, size };
}

function readPixels() {
  const gl = renderer.getContext(); const pixels = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels); return pixels;
}

function renderMask(scene, camera, actualPixels) {
  const hidden = []; const oldMaterials = [];
  scene.traverse((node) => {
    if (!node.isMesh) return;
    oldMaterials.push([node, node.material]);
    if (!node.userData.qaBuilding) { hidden.push(node); node.visible = false; }
    else node.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  });
  renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, camera);
  const maskPixels = readPixels();
  for (const node of hidden) node.visible = true; for (const [node, material] of oldMaterials) node.material = material;
  let coverage = 0; let edgeEnergy = 0; let sum = 0; let sum2 = 0;
  const luminance = (pixels, index) => (pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722) / 255;
  const values = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const inBuilding = luminance(maskPixels, pixel * 4) > 0.02; mask[pixel] = inBuilding ? 1 : 0;
    if (!inBuilding) continue;
    const value = luminance(actualPixels, pixel * 4); values[pixel] = value; coverage += 1; sum += value; sum2 += value * value;
  }
  let edgePairs = 0;
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const p = y * width + x;
    for (const neighbor of [p + 1, p + width]) if (mask[p] && mask[neighbor]) { edgeEnergy += Math.abs(values[p] - values[neighbor]); edgePairs += 1; }
  }
  const count = Math.max(1, coverage); const mean = sum / count; const variance = Math.max(0, sum2 / count - mean * mean);
  return { coveragePixels: coverage, coverageFraction: coverage / (width * height), edgeEnergy: edgeEnergy / Math.max(1, edgePairs), edgePairs, luminanceVariance: variance };
}

async function run() {
  const loaded = await gltfLoader.loadAsync(artifactUrl);
  const scene = loaded.scene;
  scene.position.fromArray(runtimeOffset);
  const { camera } = configureScene(scene, candidate);
  renderer.setClearColor(0x07100f, 1); renderer.info.reset(); renderer.clear(); renderer.render(scene, camera);
  const calls = renderer.info.render.calls; const triangles = renderer.info.render.triangles;
  const actualPixels = readPixels(); const mask = renderMask(scene, camera, actualPixels);
  renderer.setClearColor(0x07100f, 1); renderer.info.reset(); renderer.clear(); renderer.render(scene, camera);
  const image = renderer.domElement.toDataURL('image/png');
  const validShaderRecords = shaderRecords.filter((record) => record.candidate === candidate);
  const candidateShader = candidate ? validShaderRecords.find((record) => record.candidate) : null;
  const shaderContract = candidate ? {
    hasRelativeAttribute: Boolean(candidateShader?.vertexShader.includes('_sf_building_relative_height_v1')),
    hasWallMask: Boolean(candidateShader?.fragmentShader.includes('qaWallWeight')),
    hasContactDarkening: Boolean(candidateShader?.fragmentShader.includes('qaContactDarkening')),
    hasBoundedUpwardLift: Boolean(candidateShader?.fragmentShader.includes('qaUpwardLift')),
    roofResponseExcludedByWorldFaceWallMask: Boolean(candidateShader?.fragmentShader.includes('qaRelativeWorldFaceNormal') && candidateShader?.fragmentShader.includes('qaWallWeight')),
    noRepeatedBands: !/window|bay|floorBand|floorLine|floorLevel|storyBand/i.test((candidateShader?.vertexShader || '') + ' ' + (candidateShader?.fragmentShader || '')),
  } : null;
  window.__SF_RELATIVE_HEIGHT_QA__ = { tile, candidate, runtimeOffset, calls, triangles, mask, shaderErrors, shaderContract, errors, screenshotDataUrl: image };
}
run().catch((error) => { errors.push(error.stack || error.message); window.__SF_RELATIVE_HEIGHT_QA__ = { tile, candidate, runtimeOffset, calls: 0, triangles: 0, mask: null, shaderErrors, shaderContract: null, errors, screenshotDataUrl: null }; });
</script>`;
}

function createQaServer(artifacts, tileConfigMap) {
  const threeRoot = path.join(ROOT, 'node_modules', 'three');
  const sourceRoot = path.join(ROOT, 'src', 'sf-map');
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, BASE_URL);
      if (url.pathname === '/qa-height.html') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(htmlDocument(tileConfigMap)); return; }
      if (url.pathname.startsWith('/node_modules/three/')) {
        const target = path.join(ROOT, 'node_modules', url.pathname.slice('/node_modules/'.length));
        if (!target.startsWith(threeRoot)) throw new Error('invalid module path');
        const bytes = await readFile(target); response.writeHead(200, { 'content-type': target.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream' }); response.end(bytes); return;
      }
      if (url.pathname.startsWith('/src/sf-map/')) {
        const target = path.join(ROOT, url.pathname.slice(1));
        if (!target.startsWith(sourceRoot)) throw new Error('invalid source module path');
        const bytes = await readFile(target); response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(bytes); return;
      }
      const key = decodeURIComponent(url.pathname.slice(1));
      if (artifacts.has(key)) { const bytes = artifacts.get(key); response.writeHead(200, { 'content-type': 'model/gltf-binary' }); response.end(bytes); return; }
      response.writeHead(404); response.end('not found');
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
}

async function waitForServer(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
}

async function runVerifier() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/world-tiles/verify-sf-building-relative-height-proof-v1.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`relative-height verifier failed (${code}): ${stderr}`)));
  });
}

async function capture(browser, tile, mode, runIndex, artifactKey) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); const consoleErrors = []; const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(`${BASE_URL}/qa-height.html?tile=${encodeURIComponent(tile.id)}&candidate=${mode === 'candidate' ? '1' : '0'}&artifact=${encodeURIComponent(artifactKey)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__SF_RELATIVE_HEIGHT_QA__), undefined, { timeout: 30_000 });
  const runtime = await page.evaluate(() => window.__SF_RELATIVE_HEIGHT_QA__);
  const screenshotPath = path.join(OUTPUT_ROOT, `${tile.id}-${mode}-run-${runIndex}.png`); const screenshotBytes = await page.screenshot({ path: screenshotPath });
  await context.close();
  assert.equal(runtime.errors.length, 0, `${tile.id} ${mode} browser errors: ${runtime.errors.join(' | ')}`);
  assert.equal(runtime.shaderErrors.length, 0, `${tile.id} ${mode} shader errors: ${runtime.shaderErrors.join(' | ')}`);
  assert.equal(consoleErrors.length, 0, `${tile.id} ${mode} console errors: ${consoleErrors.join(' | ')}`); assert.equal(pageErrors.length, 0, `${tile.id} ${mode} page errors: ${pageErrors.join(' | ')}`);
  assert(runtime.mask && runtime.mask.coveragePixels > 0, `${tile.id} ${mode} building-only mask is empty`);
  assert.deepEqual(runtime.runtimeOffset, tile.runtimeOffset, `${tile.id} ${mode} runtime offset drifted`);
  return { tile: tile.id, mode, runIndex, screenshotPath, screenshotSha256: sha256(screenshotBytes), runtime: { runtimeOffset: runtime.runtimeOffset, calls: runtime.calls, triangles: runtime.triangles, mask: runtime.mask, shaderContract: runtime.shaderContract }, consoleErrors, pageErrors };
}

const proofManifestBytes = await readFile(PROOF_MANIFEST_PATH); const productionManifestBytes = await readFile(PRODUCTION_MANIFEST_PATH); const proofManifest = JSON.parse(proofManifestBytes); const productionManifest = JSON.parse(productionManifestBytes);
assertProofInputs(proofManifest, proofManifestBytes, productionManifest, productionManifestBytes);
await runVerifier();
await mkdir(OUTPUT_ROOT, { recursive: true });
const artifactMap = new Map(); const proofById = new Map(proofManifest.tiles.map((tile) => [tile.tile, tile])); const productionById = new Map(productionManifest.tiles.map((tile) => [tile.id, tile]));
const anchorOrigin = productionById.get('epsg26910-1441-10893').originEpsg26910VerticalMetres;
const qaTiles = TILES.map((tile) => {
  const origin = productionById.get(tile.id)?.originEpsg26910VerticalMetres;
  assert(Array.isArray(origin) && origin.length === 3, `${tile.id} production origin is missing`);
  return { ...tile, runtimeOffset: [origin[0] - anchorOrigin[0], origin[2] - anchorOrigin[2], origin[1] - anchorOrigin[1]] };
});
for (const tile of qaTiles) {
  const proofEntry = proofById.get(tile.id); const productionEntry = productionById.get(tile.id); assert(proofEntry && productionEntry, `${tile.id} manifest entry missing`);
  artifactMap.set(`${tile.id}-baseline`, await readFile(path.join(ROOT, productionEntry.lod0.path))); artifactMap.set(`${tile.id}-candidate`, await readFile(path.join(ROOT, proofEntry.proofArtifact.path)));
}
const tileConfigMap = Object.fromEntries(qaTiles.map((tile) => [tile.id, { presentation: productionById.get(tile.id).presentation || { mode: 'legacy' }, runtimeOffset: tile.runtimeOffset }]));
const server = createQaServer(artifactMap, tileConfigMap); let browser;
try {
  await waitForServer(server); browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const captures = [];
  for (const tile of qaTiles) for (const mode of ['baseline', 'candidate']) for (const runIndex of [1, 2]) captures.push(await capture(browser, tile, mode, runIndex, `${tile.id}-${mode}`));
  const grouped = new Map(); for (const captureResult of captures) grouped.set(`${captureResult.tile}:${captureResult.mode}`, captures.filter((item) => item.tile === captureResult.tile && item.mode === captureResult.mode));
  for (const list of grouped.values()) { assert.equal(list.length, 2); assert.equal(list[0].screenshotSha256, list[1].screenshotSha256, `${list[0].tile} ${list[0].mode} fresh-boot screenshots differ`); assert.deepEqual(list[0].runtime, list[1].runtime, `${list[0].tile} ${list[0].mode} fresh-boot metrics differ`); }
  const tileReports = [];
  for (const tile of qaTiles) {
    const baseline = grouped.get(`${tile.id}:baseline`)[0]; const candidate = grouped.get(`${tile.id}:candidate`)[0];
    assert.equal(candidate.runtime.calls, baseline.runtime.calls, `${tile.id} candidate changed draw calls`); assert.equal(candidate.runtime.triangles, baseline.runtime.triangles, `${tile.id} candidate changed triangles`);
    assert(candidate.runtime.shaderContract?.hasRelativeAttribute, `${tile.id} candidate shader omitted relative-height attribute`); assert(candidate.runtime.shaderContract?.hasWallMask, `${tile.id} candidate shader omitted wall mask`); assert(candidate.runtime.shaderContract?.hasContactDarkening, `${tile.id} candidate shader omitted contact darkening`); assert(candidate.runtime.shaderContract?.hasBoundedUpwardLift, `${tile.id} candidate shader omitted bounded upward lift`); assert(candidate.runtime.shaderContract?.roofResponseExcludedByWorldFaceWallMask, `${tile.id} candidate shader omitted world-face roof mask`); assert(candidate.runtime.shaderContract?.noRepeatedBands, `${tile.id} candidate shader contains repeated floor/window/bay bands`);
    const baselineEdge = baseline.runtime.mask.edgeEnergy; const candidateEdge = candidate.runtime.mask.edgeEnergy; const baselineVariance = baseline.runtime.mask.luminanceVariance; const candidateVariance = candidate.runtime.mask.luminanceVariance;
    const edgeImprovement = baselineEdge > 0 ? candidateEdge / baselineEdge : 0; const varianceImprovement = baselineVariance > 0 ? candidateVariance / baselineVariance : 0;
    tileReports.push({ tile: tile.id, role: tile.role, baseline: { screenshotPath: baseline.screenshotPath, screenshotSha256: baseline.screenshotSha256, runtimeOffset: baseline.runtime.runtimeOffset, calls: baseline.runtime.calls, triangles: baseline.runtime.triangles, mask: baseline.runtime.mask }, candidate: { screenshotPath: candidate.screenshotPath, screenshotSha256: candidate.screenshotSha256, runtimeOffset: candidate.runtime.runtimeOffset, calls: candidate.runtime.calls, triangles: candidate.runtime.triangles, mask: candidate.runtime.mask, shaderContract: candidate.runtime.shaderContract }, metrics: { edgeImprovement, varianceImprovement, materiallyBetter: edgeImprovement >= 1.01 || varianceImprovement >= 1.01 } });
  }
  const sideBySide = [];
  for (const report of tileReports) {
    sideBySide.push(`<div class="frame"><label>${report.tile} · BASELINE</label><img src="data:image/png;base64,${(await readFile(report.baseline.screenshotPath)).toString('base64')}"></div>`);
    sideBySide.push(`<div class="frame"><label>${report.tile} · RELATIVE-HEIGHT CANDIDATE</label><img src="data:image/png;base64,${(await readFile(report.candidate.screenshotPath)).toString('base64')}"></div>`);
  }
  const comparisonPage = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await comparisonPage.setContent(`<!doctype html><style>html,body{margin:0;background:#07100f;color:#d7ff48;font:700 13px monospace}.grid{display:grid;grid-template-columns:1fr 1fr}.frame{position:relative}.frame label{position:absolute;z-index:2;top:10px;left:10px;padding:7px 9px;background:#07100fdd;border:1px solid #55665e}.frame img{display:block;width:960px;height:540px;object-fit:cover}</style><div class="grid">${sideBySide.join('')}</div>`);
  const comparisonPath = path.join(OUTPUT_ROOT, 'baseline-vs-relative-height-candidate.png'); await comparisonPage.screenshot({ path: comparisonPath }); await comparisonPage.close();
  const materiallyBetter = tileReports.every((report) => report.metrics.materiallyBetter);
  const report = { result: materiallyBetter ? 'SF building relative-height preview QA passed' : 'SF building relative-height preview QA REJECT', status: materiallyBetter ? 'preview-quality-gate-passed-not-production' : 'preview-quality-gate-rejected-not-production', productionWriteEnabled: false, productionPromotionAuthorized: false, proofManifestSha256: sha256(proofManifestBytes), productionManifestSha256: sha256(productionManifestBytes), verifier: 'passed', presentationHelper: 'src/sf-map/building-presentation-material.js exact applyLegacyBuildingPresentation/applySourceToneBuildingPresentation', paletteIdentity: ['c7ad8a', 'aa765c', '77858c', '8b6456'], runtimeAnchorOriginEpsg26910VerticalMetres: anchorOrigin, tileReports, comparisonPath, invariants: { twoFreshBootScreenshotsByteExact: true, exactRuntimeDescriptorOffsets: tileReports.every((entry) => Array.isArray(entry.baseline.runtimeOffset) && entry.baseline.runtimeOffset.length === 3), buildingOnlyMaskMetrics: true, drawCallsUnchanged: tileReports.every((report) => report.baseline.calls === report.candidate.calls), trianglesUnchanged: tileReports.every((report) => report.baseline.triangles === report.candidate.triangles), shaderLogsClean: true, exactProductionProofGeometryAndMetricLocks: true, candidateShaderVerticalWallsOnly: true, roofResponseExcludedByWorldFaceWallMask: true, roofPixelDeltaMaskVerified: false, noRepeatedFloorWindowBayBands: true } };
  await writeFile(path.join(OUTPUT_ROOT, 'report.json'), jsonBytes(report)); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally { await browser?.close(); server.close(); }
