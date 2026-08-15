#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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

  const cases = [];
  for (const spec of CASES) {
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

      const proofPath = `/data/world/preview-artifacts/sf-building-presentation-proof-v1/${input.tileId}/${input.tileId}.building-presentation-proof.glb`;
      const receiptPath = `/data/world/preview-artifacts/sf-building-presentation-proof-v1/${input.tileId}/${input.tileId}.building-presentation-proof.receipt.json`;
      const loader = new GLTFLoader();
      const [baselineGltf, candidateGltf, proofGltf, receipt] = await Promise.all([
        loader.loadAsync(input.productionPath), loader.loadAsync(input.productionPath),
        loader.loadAsync(proofPath), fetch(receiptPath).then((response) => response.json()),
      ]);
      if (receipt.kind !== 'sf-building-presentation-proof-receipt'
        || receipt.status !== 'preview-proof-only-not-production'
        || !receipt.invariants.productionTrianglePositionMultisetExact
        || receipt.invariants.sourceGeometryMoved !== false) {
        throw new Error(`${input.tileId} proof receipt is not source-geometry locked`);
      }

      const paletteHex = [0xc7ad8a, 0xaa765c, 0x77858c, 0x8b6456];
      const palette = paletteHex.map((hex) => new THREE.Color(hex));
      const toneCounts = [0, 0, 0, 0];
      const sourceToneLedger = receipt.buildingRecords.map((record, ordinal) => {
        const tone = Number(BigInt(record.sourceFeatureId.split('/')[1]) % 4n);
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
      let coloredPrimitiveVertices = 0;
      proofGltf.scene.traverse((node) => {
        if (!node.isMesh) return;
        node.geometry.computeVertexNormals();
        const ordinals = node.geometry.getAttribute('_sf_building_ordinal');
        const colors = []; const roof = node.material.name.includes('-roof-');
        for (let index = 0; index < ordinals.count; index += 1) {
          const ordinal = Math.round(ordinals.getX(index));
          const record = receipt.buildingRecords[ordinal];
          const wayId = BigInt(record.sourceFeatureId.split('/')[1]);
          const color = palette[Number(wayId % 4n)].clone();
          if (roof) color.multiplyScalar(1.08);
          colors.push(color.r, color.g, color.b);
        }
        node.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        node.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: roof ? 0.94 : 0.9, metalness: 0 });
        node.castShadow = true; node.receiveShadow = true;
        coloredPrimitiveVertices += ordinals.count;
      });
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
      function pixelMetrics(left) {
        const x0 = left ? 0 : 720; const width = 720; const height = 810;
        const luma = new Float32Array(width * height); let sum = 0; let shadow = 0; let chroma = 0;
        for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
          const source = ((y * 1440) + x0 + x) * 4;
          const r = pixels[source] / 255; const g = pixels[source + 1] / 255; const b = pixels[source + 2] / 255;
          const value = 0.2126 * r + 0.7152 * g + 0.0722 * b; luma[y * width + x] = value;
          sum += value; if (value < 0.14) shadow += 1; chroma += Math.max(r, g, b) - Math.min(r, g, b);
        }
        let edge = 0; let edges = 0;
        for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
          const at = y * width + x;
          if (x + 1 < width) { edge += Math.abs(luma[at] - luma[at + 1]); edges += 1; }
          if (y + 1 < height) { edge += Math.abs(luma[at] - luma[at + width]); edges += 1; }
        }
        const count = width * height;
        return { meanLuma: sum / count, shadowFractionUnder014: shadow / count, meanChroma: chroma / count, edgeEnergy: edge / edges };
      }
      return {
        receipt: { buildings: receipt.buildingRecords.length, status: receipt.status, claims: receipt.claims },
        sourceIdentityPalette: {
          rule: 'OSM way ID modulo four', toneCounts,
          ledgerSha256: `sha256:${sourceToneLedgerSha256}`,
        },
        coloredPrimitiveVertices, normals: 'derived from exact proof triangles at presentation time',
        baselineRender, candidateRender, baselinePixels: pixelMetrics(true), candidatePixels: pixelMetrics(false),
      };
    }, spec);

    assert.equal(result.receipt.buildings, spec.expectedBuildings, `${spec.role} building count drifted`);
    assert.equal(result.baselineRender.triangles, result.candidateRender.triangles, `${spec.role} triangle count changed`);
    assert(result.candidateRender.calls <= result.baselineRender.calls + 1, `${spec.role} added more than one draw call`);
    assert(result.sourceIdentityPalette.toneCounts.every((count) => count > 0), `${spec.role} did not exercise all source-ID tones`);
    assert(result.candidatePixels.shadowFractionUnder014 <= result.baselinePixels.shadowFractionUnder014,
      `${spec.role} increased the dark-pixel fraction`);
    assert(result.candidatePixels.edgeEnergy >= result.baselinePixels.edgeEnergy * 0.9,
      `${spec.role} lost more than ten percent of baseline edge energy`);
    assert.equal(result.receipt.status, 'preview-proof-only-not-production');
    const screenshot = path.join(OUTPUT_ROOT, `${spec.role}-exact-baseline-vs-source-id.png`);
    await page.screenshot({ path: screenshot });
    cases.push({ ...spec, screenshot, ...result });
  }
  assert.equal(browserErrors.length, 0, `Browser errors: ${browserErrors.join(' | ')}`);
  const report = {
    schemaVersion: 1,
    kind: 'sf-building-source-palette-visual-qa',
    status: 'preview-report-only-not-production',
    policy: {
      candidateToneKey: 'byte-locked OSM way ID modulo four',
      geometry: 'exact building-presentation proof positions and indices',
      normals: 'presentation-time derivation from exact proof triangles',
      productionPromotionAuthorized: false,
      gameplayChanged: false,
      runtimeMetricContractChanged: false,
    },
    cases,
    browserErrors,
  };
  await writeFile(path.join(OUTPUT_ROOT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
