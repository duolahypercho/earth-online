#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SF_BUILDING_SOURCE_PALETTE_QA_PORT || 5199);
const OUTPUT_ROOT = process.env.SF_BUILDING_SOURCE_PALETTE_QA_DIR
  || path.join(ROOT, '.qa-sf-building-source-palette-v1');
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HOST_PAGE_PATH = path.join(ROOT, '.qa-sf-building-source-palette-host.html');

function sha256File(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function captureComparable(result) {
  const { screenshot, screenshotSha256, runIndex, ...comparable } = result;
  return comparable;
}

const CASES = Object.freeze([
  {
    role: 'ferry',
    tileId: 'epsg26910-1441-10893',
    productionPath: '/data/world/production-artifacts/ferry-production-tile-v1/ferry-production-tile-v1.lod0.glb',
    worldOffset: [0, 0, 0],
    cameraPosition: [430, 132, 292],
    cameraTarget: [119, 8, 292],
    fogDensity: 0.00145,
    fillIntensity: 0.72,
    expectedBuildings: 24,
    expectedToneCounts: [4, 8, 7, 5],
    expectedToneLedgerSha256: 'sha256:2c960dc01b5a7e12423fe5b8c00291d258ff441ed1ce3576c27c509f40ec44ea',
    expectedBaselineRender: { calls: 7, triangles: 299725 },
    expectedCandidateRender: { calls: 7, triangles: 299725 },
  },
  {
    role: 'district',
    tileId: 'epsg26910-1430-10882',
    productionPath: '/data/world/production-artifacts/sf-metric-tiles-v1/epsg26910-1430-10882/epsg26910-1430-10882.lod0.glb',
    worldOffset: [-4224, 0, -4224],
    cameraPosition: [530, 360, 530],
    cameraTarget: [192, 28, 192],
    fogDensity: 0.00055,
    fillIntensity: 0.46,
    expectedBuildings: 390,
    expectedToneCounts: [94, 102, 98, 96],
    expectedToneLedgerSha256: 'sha256:1bd403b718dbf02bd07a8baaf7f0711fec99b3b54e2feb1abd01cd202ffae248',
    expectedBaselineRender: { calls: 5, triangles: 307956 },
    expectedCandidateRender: { calls: 5, triangles: 307956 },
  },
]);

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

const vite = spawn(process.execPath, [
  path.join(ROOT, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: 'ignore' });

let browser;
try {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(HOST_PAGE_PATH, '<!doctype html><meta charset="utf-8"><title>SF building source palette QA</title>\n');
  await waitForPort();
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  const captures = [];
  for (const runIndex of [1, 2]) for (const spec of CASES) {
    await page.goto(`${BASE_URL}/${path.basename(HOST_PAGE_PATH)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.setContent(`<!doctype html><style>
      html,body{margin:0;overflow:hidden;background:#07100f}canvas{display:block}
      .label{position:fixed;z-index:2;top:20px;color:#d7ff48;background:#07100fdd;
        border:1px solid #55665e;padding:8px 12px;font:700 13px monospace}
      .baseline{left:20px}.candidate{left:740px}
    </style><div class="label baseline">BASELINE · EXACT PRODUCTION PALETTE</div>
    <div class="label candidate">CANDIDATE · SOURCE-ID PER BUILDING</div><canvas id="qa"></canvas>`);

    const result = await page.evaluate(async (input) => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
      const { applySourceToneBuildingPresentation } = await import('/src/sf-map/building-presentation-material.js');
      const renderer = new THREE.WebGLRenderer({
        canvas: document.querySelector('#qa'), antialias: true, preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(1);
      renderer.setSize(1440, 810, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.18;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setScissorTest(true);

      const proofPath = `/data/world/preview-artifacts/sf-building-source-tone-production-proof-v1/${input.tileId}/${input.tileId}.source-tone-production-proof.glb`;
      const receiptPath = `/data/world/preview-artifacts/sf-building-source-tone-production-proof-v1/${input.tileId}/${input.tileId}.source-tone-production-proof.receipt.json`;
      const sourceReceiptPath = `/data/world/preview-artifacts/sf-building-source-tone-proof-v1/${input.tileId}/${input.tileId}.building-source-tone-proof.receipt.json`;
      const loader = new GLTFLoader();
      async function sha256Hex(bytes) {
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((value) => value.toString(16).padStart(2, '0')).join('');
      }
      async function fetchBytes(url) {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
        return response.arrayBuffer();
      }
      const [receiptBytes, sourceReceiptBytes] = await Promise.all([fetchBytes(receiptPath), fetchBytes(sourceReceiptPath)]);
      const receiptSha256 = await sha256Hex(receiptBytes);
      const sourceReceiptSha256 = await sha256Hex(sourceReceiptBytes);
      const receipt = JSON.parse(new TextDecoder().decode(receiptBytes));
      const sourceReceipt = JSON.parse(new TextDecoder().decode(sourceReceiptBytes));
      if (receipt.kind !== 'sf-building-source-tone-production-proof-receipt'
        || receipt.status !== 'write-disabled-production-shaped-proof'
        || receipt.productionPromotionAuthorized !== false
        || !receipt.invariants.productionGeometryLedgerExact
        || receipt.invariants.sourceGeometryMoved !== false) {
        throw new Error(`${input.tileId} proof receipt is not source-geometry locked`);
      }
      const expectedProductionPath = `/${receipt.productionReference.path.replace(/^public\//, '')}`;
      const expectedProofPath = `/${receipt.artifact.path.replace(/^public\//, '')}`;
      if (expectedProductionPath !== input.productionPath || expectedProofPath !== proofPath) {
        throw new Error(`${input.tileId} QA paths differ from the proof receipt`);
      }
      const [productionBytes, proofBytes] = await Promise.all([
        fetchBytes(input.productionPath), fetchBytes(proofPath),
      ]);
      const productionSha256 = await sha256Hex(productionBytes);
      const proofSha256 = await sha256Hex(proofBytes);
      if (`sha256:${productionSha256}` !== receipt.productionReference.sha256
        || `sha256:${proofSha256}` !== receipt.artifact.sha256
        || sourceReceipt.ledgers.sourceToneAttributeSha256 !== receipt.ledgers.sourceToneAttributeSha256) {
        throw new Error(`${input.tileId} GLB bytes differ from the proof receipt`);
      }
      const resourcePath = (url) => url.slice(0, url.lastIndexOf('/') + 1);
      const [baselineGltf, candidateGltf, proofGltf] = await Promise.all([
        loader.parseAsync(productionBytes.slice(0), resourcePath(input.productionPath)),
        loader.parseAsync(productionBytes.slice(0), resourcePath(input.productionPath)),
        loader.parseAsync(proofBytes.slice(0), resourcePath(proofPath)),
      ]);

      const paletteHex = [0xc7ad8a, 0xaa765c, 0x77858c, 0x8b6456];
      const palette = paletteHex.map((hex) => new THREE.Color(hex));
      const toneCounts = [0, 0, 0, 0];
      const sourceToneLedger = sourceReceipt.sourceToneRecords.map((record, ordinal) => {
        const tone = record.sourceToneV1;
        if (tone !== Number(BigInt(record.sourceFeatureId.split('/')[1]) % 4n)) throw new Error(`${input.tileId} source-tone receipt derivation drifted`);
        toneCounts[tone] += 1;
        return `${ordinal}|${record.sourceFeatureId}|${tone}`;
      }).join('\n');
      const sourceToneLedgerSha256 = [...new Uint8Array(await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(sourceToneLedger),
      ))].map((value) => value.toString(16).padStart(2, '0')).join('');
      const glslPalette = palette.map((color) => `vec3(${color.toArray().map((value) => value.toFixed(6)).join(',')})`);
      const paletteExpression = `h<.25?${glslPalette[0]}:h<.5?${glslPalette[1]}:h<.75?${glslPalette[2]}:${glslPalette[3]}`;

      function applyBaselineMaterial(material) {
        material.color.setHex(0xffffff); material.roughness = 0.9; material.metalness = 0;
        material.onBeforeCompile = (shader) => {
          shader.vertexShader = `varying vec3 vQaWorld;\n${shader.vertexShader}`
            .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvec4 qaWorld=vec4(transformed,1.0);qaWorld=modelMatrix*qaWorld;vQaWorld=qaWorld.xyz;`);
          shader.fragmentShader = `varying vec3 vQaWorld;\n${shader.fragmentShader}`
            .replace('#include <color_fragment>', `#include <color_fragment>\nvec2 cell=floor(vQaWorld.xz/62.0);float h=fract(sin(dot(cell,vec2(127.1,311.7)))*43758.5453123);diffuseColor.rgb*=${paletteExpression};`)
            .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\nfloat roof=smoothstep(.16,.84,abs(normal.y));diffuseColor.rgb*=mix(.72,1.08,roof);`);
        };
        material.customProgramCacheKey = () => 'sf-map-building-palette-v1-qa';
        material.needsUpdate = true;
      }

      function tuneContext(root, hideBuildings) {
        root.position.fromArray(input.worldOffset);
        root.traverse((node) => {
          if (!node.isMesh) return;
          node.receiveShadow = true;
          if (node.material?.name === 'terrain-night') node.material.color.setHex(0x1d473a);
          if (node.material?.name === 'roads-night') {
            node.material.color.setHex(0x53615e); node.material.roughness = 0.96;
          }
          if (node.material?.name === 'water-osm-coastline-night') {
            node.material.color.setHex(0x0a5870); node.material.roughness = 0.22; node.material.metalness = 0.18;
          }
          if (node.material?.name === 'coastline-osm-night') node.material.color.setHex(0x2f7f8c);
          if (node.material?.name === 'buildings-night') {
            if (hideBuildings) node.visible = false;
            else { applyBaselineMaterial(node.material); node.castShadow = true; }
          }
        });
      }

      const baselineScene = new THREE.Scene(); const candidateScene = new THREE.Scene();
      for (const scene of [baselineScene, candidateScene]) {
        scene.background = new THREE.Color(0x07100f);
        scene.fog = new THREE.FogExp2(0x07100f, input.fogDensity);
      }
      tuneContext(baselineGltf.scene, false); tuneContext(candidateGltf.scene, true);
      baselineScene.add(baselineGltf.scene); candidateScene.add(candidateGltf.scene);

      proofGltf.scene.position.fromArray(input.worldOffset);
      let sourceTonePrimitiveVertices = 0;
      const parsedToneCounts = [0, 0, 0, 0];
      proofGltf.scene.traverse((node) => {
        if (!node.isMesh) return;
        if (node.material?.name !== 'buildings-night') { node.visible = false; return; }
        node.geometry.computeVertexNormals();
        const positions = node.geometry.getAttribute('position');
        const sourceTones = node.geometry.getAttribute('_sf_source_tone_v1');
        if (!positions || !sourceTones || sourceTones.normalized !== false || sourceTones.count !== positions.count) {
          throw new Error(`${input.tileId} Three.js did not expose the declared source-tone-v1 attribute`);
        }
        for (let index = 0; index < sourceTones.count; index += 1) {
          const tone = sourceTones.getX(index);
          if (!Number.isInteger(tone) || tone < 0 || tone > 3) throw new Error(`${input.tileId} parsed source-tone-v1 value drifted`);
          parsedToneCounts[tone] += 1;
        }
        node.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
        applySourceToneBuildingPresentation(node.material, {
          palette,
          policySha256: receipt.contract.derivation.policySha256,
        });
        node.castShadow = true; node.receiveShadow = true;
        sourceTonePrimitiveVertices += sourceTones.count;
      });
      if (parsedToneCounts.reduce((sum, count) => sum + count, 0) !== receipt.counts.sourceTonePayloadBytes) throw new Error(`${input.tileId} parsed source-tone payload count drifted`);
      candidateScene.add(proofGltf.scene);

      const offset = new THREE.Vector3(...input.worldOffset);
      const target = new THREE.Vector3(...input.cameraTarget).add(offset);
      const position = new THREE.Vector3(...input.cameraPosition).add(offset);
      function addLights(scene) {
        scene.add(new THREE.HemisphereLight(0xc8dfd1, 0x101715, 0.96));
        const sun = new THREE.DirectionalLight(0xffe6bd, 3.6);
        sun.position.copy(target).add(new THREE.Vector3(-280, 430, -210));
        sun.target.position.copy(target); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.camera.left = -460; sun.shadow.camera.right = 460;
        sun.shadow.camera.top = 460; sun.shadow.camera.bottom = -460; sun.shadow.camera.far = 1400;
        scene.add(sun, sun.target);
        const fill = new THREE.DirectionalLight(0xb9d7e4, input.fillIntensity);
        fill.position.copy(target).add(new THREE.Vector3(360, 220, 0)); fill.target.position.copy(target);
        scene.add(fill, fill.target);
      }
      addLights(baselineScene); addLights(candidateScene);
      const cameras = [0, 1].map(() => {
        const camera = new THREE.PerspectiveCamera(43, 720 / 810, 0.5, 2400);
        camera.position.copy(position); camera.lookAt(target); return camera;
      });

      renderer.setViewport(0, 0, 720, 810); renderer.setScissor(0, 0, 720, 810);
      renderer.render(baselineScene, cameras[0]);
      const baselineRender = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      renderer.info.reset();
      renderer.setViewport(720, 0, 720, 810); renderer.setScissor(720, 0, 720, 810);
      renderer.render(candidateScene, cameras[1]);
      const candidateRender = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };

      const pixels = new Uint8Array(1440 * 810 * 4);
      renderer.getContext().readPixels(0, 0, 1440, 810, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, pixels);
      const maskTarget = new THREE.WebGLRenderTarget(720, 810, { depthBuffer: true });
      const originalBackground = candidateScene.background;
      const originalFog = candidateScene.fog;
      const originalVisibility = candidateGltf.scene.visible;
      const originalMaterials = [];
      candidateGltf.scene.visible = false;
      candidateScene.background = new THREE.Color(0x000000);
      candidateScene.fog = null;
      proofGltf.scene.traverse((node) => {
        if (!node.isMesh || !node.visible) return;
        originalMaterials.push([node, node.material]);
        node.material = new THREE.ShaderMaterial({
          toneMapped: false,
          vertexShader: `varying vec3 vQaMaskWorldPosition;
            void main(){vQaMaskWorldPosition=(modelMatrix*vec4(position,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
          fragmentShader: `varying vec3 vQaMaskWorldPosition;
            void main(){vec3 n=normalize(cross(dFdx(vQaMaskWorldPosition),dFdy(vQaMaskWorldPosition)));float roof=smoothstep(.5,.9,abs(n.y));gl_FragColor=vec4(mix(vec3(1.,0.,0.),vec3(0.,0.,1.),roof),1.);}`,
        });
      });
      renderer.setRenderTarget(maskTarget);
      renderer.setViewport(0, 0, 720, 810); renderer.setScissor(0, 0, 720, 810);
      renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(candidateScene, cameras[1]);
      const buildingMaskPixels = new Uint8Array(720 * 810 * 4);
      renderer.readRenderTargetPixels(maskTarget, 0, 0, 720, 810, buildingMaskPixels);
      renderer.setRenderTarget(null); maskTarget.dispose();
      for (const [node, material] of originalMaterials) node.material = material;
      candidateGltf.scene.visible = originalVisibility;
      candidateScene.background = originalBackground;
      candidateScene.fog = originalFog;
      function quantile(values, fraction) {
        if (values.length === 0) return null;
        values.sort((a, b) => a - b);
        return values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))];
      }
      function pixelMetrics(left, facadeMaskPixels = null) {
        const x0 = left ? 0 : 720; const width = 720; const height = 810;
        const luma = new Float32Array(width * height); const facadeLuma = []; const roofLuma = [];
        const facadeMask = new Uint8Array(width * height);
        let sum = 0; let shadow = 0; let chroma = 0;
        for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
          const source = ((y * 1440) + x0 + x) * 4;
          const r = pixels[source] / 255; const g = pixels[source + 1] / 255; const b = pixels[source + 2] / 255;
          const value = 0.2126 * r + 0.7152 * g + 0.0722 * b; luma[y * width + x] = value;
          sum += value; if (value < 0.14) shadow += 1; chroma += Math.max(r, g, b) - Math.min(r, g, b);
          const maskSource = (y * width + x) * 4;
          if (facadeMaskPixels && facadeMaskPixels[maskSource] > 250
            && facadeMaskPixels[maskSource + 1] < 4 && facadeMaskPixels[maskSource + 2] < 4) {
            facadeMask[y * width + x] = 1;
            facadeLuma.push(value);
          } else if (facadeMaskPixels && facadeMaskPixels[maskSource] < 4
            && facadeMaskPixels[maskSource + 1] < 4 && facadeMaskPixels[maskSource + 2] > 250) roofLuma.push(value);
        }
        let edge = 0; let edges = 0; let facadeEdge = 0; let facadeEdges = 0;
        for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
          const at = y * width + x;
          if (x + 1 < width) {
            const delta = Math.abs(luma[at] - luma[at + 1]); edge += delta; edges += 1;
            if (facadeMask[at] && facadeMask[at + 1]) { facadeEdge += delta; facadeEdges += 1; }
          }
          if (y + 1 < height) {
            const delta = Math.abs(luma[at] - luma[at + width]); edge += delta; edges += 1;
            if (facadeMask[at] && facadeMask[at + width]) { facadeEdge += delta; facadeEdges += 1; }
          }
        }
        const count = width * height;
        const globalLuma = Array.from(luma);
        const globalP10 = quantile(globalLuma, 0.10);
        const globalP90 = quantile(globalLuma, 0.90);
        const facadeP10 = quantile(facadeLuma, 0.10);
        const facadeP90 = quantile(facadeLuma, 0.90);
        return {
          meanLuma: sum / count, shadowFractionUnder014: shadow / count, meanChroma: chroma / count, edgeEnergy: edge / edges,
          globalP10,
          globalP90,
          globalP90P10TonalSpan: globalP90 - globalP10,
          facadeRoiPixels: facadeLuma.length,
          facadeRoiP10: facadeP10,
          facadeRoiP90: facadeP90,
          facadeRoiP90P10TonalSpan: facadeP10 === null || facadeP90 === null ? null : facadeP90 - facadeP10,
          facadeRoiEdgeEnergy: facadeEdges === 0 ? null : facadeEdge / facadeEdges,
          facadeRoiMeanLuma: facadeLuma.length === 0 ? null : facadeLuma.reduce((total, value) => total + value, 0) / facadeLuma.length,
          roofRoiPixels: roofLuma.length,
          roofRoiMeanLuma: roofLuma.length === 0 ? null : roofLuma.reduce((total, value) => total + value, 0) / roofLuma.length,
        };
      }
      return {
        receipt: { buildings: sourceReceipt.sourceToneRecords.length, status: receipt.status, contract: receipt.contract, productionPromotionAuthorized: receipt.productionPromotionAuthorized },
        integrity: {
          receiptSha256: `sha256:${receiptSha256}`,
          sourceReceiptSha256: `sha256:${sourceReceiptSha256}`,
          productionGlbSha256: `sha256:${productionSha256}`,
          proofGlbSha256: `sha256:${proofSha256}`,
          verifiedBeforeParse: true,
        },
        sourceIdentityPalette: {
          rule: 'OSM way ID modulo four', toneCounts,
          ledgerSha256: `sha256:${sourceToneLedgerSha256}`,
          adjacencySameToneRatio: null,
          adjacencyDerivation: 'not derivable from receipt building records: they bind IDs and edge hash summaries but no endpoint topology',
        },
        sourceTonePrimitiveVertices,
        normals: 'fragment-derivative face normals from exact world-space positions at presentation time',
        candidateMaterialPass: 'exact runtime source-tone-v1 material module: byte attribute palette plus deterministic world-space facade orientation contrast and roof lift',
        baselineRender, candidateRender,
        baselinePixels: pixelMetrics(true, buildingMaskPixels), candidatePixels: pixelMetrics(false, buildingMaskPixels),
      };
    }, spec);

    assert.equal(result.receipt.buildings, spec.expectedBuildings, `${spec.role} building count drifted`);
    assert.equal(result.integrity.verifiedBeforeParse, true, `${spec.role} did not verify GLBs before parsing`);
    assert.deepEqual(result.baselineRender, spec.expectedBaselineRender, `${spec.role} baseline render budget drifted`);
    assert.deepEqual(result.candidateRender, spec.expectedCandidateRender, `${spec.role} candidate render budget drifted`);
    assert.deepEqual(result.sourceIdentityPalette.toneCounts, spec.expectedToneCounts, `${spec.role} source-ID tone counts drifted`);
    assert.equal(result.sourceIdentityPalette.ledgerSha256, spec.expectedToneLedgerSha256, `${spec.role} source-ID tone ledger drifted`);
    assert(result.candidatePixels.shadowFractionUnder014 <= result.baselinePixels.shadowFractionUnder014,
      `${spec.role} increased the dark-pixel fraction`);
    assert.equal(result.receipt.status, 'write-disabled-production-shaped-proof');
    const screenshot = path.join(OUTPUT_ROOT, `${spec.role}-exact-baseline-vs-source-id-face-normal-capture-${runIndex}.png`);
    await page.screenshot({ path: screenshot });
    captures.push({
      ...spec, runIndex, screenshot, screenshotSha256: sha256File(await readFile(screenshot)), ...result,
      strictAcceptance: {
        globalRelativeSpanFloor: result.baselinePixels.globalP90P10TonalSpan * 0.95,
        edgeEnergyFloor: result.baselinePixels.edgeEnergy * 0.95,
        facadeRoiRelativeSpanFloor: result.baselinePixels.facadeRoiP90P10TonalSpan * 1.05,
        facadeRoiRelativeEdgeFloor: result.baselinePixels.facadeRoiEdgeEnergy * 1.05,
        globalP90P10TonalSpanPass: result.candidatePixels.globalP90P10TonalSpan
          >= result.baselinePixels.globalP90P10TonalSpan * 0.95,
        facadeRoiP90P10TonalSpanPass: result.candidatePixels.facadeRoiP90P10TonalSpan
          >= result.baselinePixels.facadeRoiP90P10TonalSpan * 1.05,
        facadeRoiEdgeEnergyPass: result.candidatePixels.facadeRoiEdgeEnergy >= result.baselinePixels.facadeRoiEdgeEnergy * 1.05,
        edgeEnergyPass: result.candidatePixels.edgeEnergy >= result.baselinePixels.edgeEnergy * 0.95,
      },
    });
  }
  assert.equal(browserErrors.length, 0, `Browser errors: ${browserErrors.join(' | ')}`);
  const cases = CASES.map((spec) => {
    const pair = captures.filter((capture) => capture.role === spec.role).sort((a, b) => a.runIndex - b.runIndex);
    assert.equal(pair.length, 2, `${spec.role} did not produce two fresh captures`);
    assert.deepEqual(captureComparable(pair[0]), captureComparable(pair[1]), `${spec.role} rendered non-deterministic metrics`);
    assert.equal(pair[0].screenshotSha256, pair[1].screenshotSha256, `${spec.role} screenshots were not byte-identical`);
    return { ...pair[0], repeatedCapture: { screenshot: pair[1].screenshot, screenshotSha256: pair[1].screenshotSha256 } };
  });
  const strictAccepted = cases.every((entry) => entry.strictAcceptance.globalP90P10TonalSpanPass
    && entry.strictAcceptance.facadeRoiP90P10TonalSpanPass
    && entry.strictAcceptance.facadeRoiEdgeEnergyPass && entry.strictAcceptance.edgeEnergyPass);
  const report = {
    schemaVersion: 1,
    kind: 'sf-building-source-palette-visual-qa',
    status: strictAccepted ? 'preview-report-only-not-production-strict-accept' : 'preview-report-only-not-production-strict-reject',
    policy: {
      candidateToneKey: 'byte-locked OSM way ID modulo four',
      geometry: 'production-shaped source-tone proof positions and indices, verified exact against production geometry',
      normals: 'fragment-derivative face normals from exact world-space positions',
      productionPromotionAuthorized: false,
      gameplayChanged: false,
      runtimeMetricContractChanged: false,
    },
    capturesByteIdentical: true,
    cases,
    browserErrors,
  };
  await writeFile(path.join(OUTPUT_ROOT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!strictAccepted) process.exitCode = 1;
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
