import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// I60 is a render-only, fail-closed regression gate. Production is captured
// unchanged; the matched legacy baseline route-disables only the reviewed
// applyWaterPresentation call. GLBs, receipts, origins, and streaming artifacts
// are never modified.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SF_MAP_WATER_NORMAL_QA_PORT || 5206);
const baseUrl = `http://127.0.0.1:${port}/sf-map.html`;
const outputDir = process.env.SF_MAP_WATER_NORMAL_QA_DIR || join(root, '.qa-sf-map-water-normal-i60');
const settleTimeoutMs = Number(process.env.SF_MAP_WATER_NORMAL_QA_TIMEOUT_MS || 300000);
const planSafetyWaitMs = Number(process.env.SF_MAP_WATER_NORMAL_QA_PLAN_WAIT_MS || 12000);
const expectedDescriptorCount = 803;
const anchorId = 'epsg26910-1441-10893';
const manifestPath = join(root, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameSha256(actual, expected) {
  const normalize = (value) => String(value || '').replace(/^sha256:/i, '').toLowerCase();
  return normalize(actual) === normalize(expected);
}

async function waitForPort(host, targetPort, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const available = await new Promise((resolve) => {
      const socket = createServer();
      socket.once('error', () => resolve(true));
      socket.once('listening', () => socket.close(() => resolve(false)));
      socket.listen(targetPort, host);
    });
    if (available) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not open ${host}:${targetPort}`);
}

function glbJson(bytes) {
  assert(bytes.toString('ascii', 0, 4) === 'glTF', 'Ferry GLB magic drifted');
  assert(bytes.readUInt32LE(4) === 2, 'Ferry GLB version drifted');
  const jsonLength = bytes.readUInt32LE(12);
  assert(bytes.readUInt32LE(16) === 0x4e4f534a, 'Ferry GLB JSON chunk is not first');
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
}

function readAccessorYBounds(json, bytes, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  const view = json.bufferViews[accessor.bufferView];
  const jsonLength = bytes.readUInt32LE(12);
  const binStart = 20 + jsonLength + 8;
  const stride = view.byteStride || 12;
  const offset = binStart + (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const values = [];
  for (let index = 0; index < accessor.count; index += 1) values.push(bytes.readFloatLE(offset + index * stride + 4));
  return { count: accessor.count, min: Math.min(...values), max: Math.max(...values) };
}

async function verifyLockedFerryGeometry() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(manifest.tiles.length === expectedDescriptorCount, `Expected ${expectedDescriptorCount} production descriptors, got ${manifest.tiles.length}`);
  const descriptor = manifest.tiles.find((tile) => tile.id === anchorId);
  assert(descriptor, `Anchor descriptor ${anchorId} is absent`);
  const glbPath = join(root, descriptor.lod0.path);
  const receiptPath = join(root, descriptor.receipt.path);
  assert(existsSync(glbPath) && existsSync(receiptPath), 'Anchor Ferry production artifacts are absent');
  const [glbBytes, receiptBytes] = await Promise.all([readFile(glbPath), readFile(receiptPath)]);
  assert(`sha256:${sha256Hex(glbBytes)}` === descriptor.lod0.sha256, 'Anchor Ferry GLB hash does not match manifest');
  assert(`sha256:${sha256Hex(receiptBytes)}` === descriptor.receipt.sha256, 'Anchor Ferry receipt hash does not match manifest');
  const json = glbJson(glbBytes);
  const primitives = json.meshes.flatMap((mesh) => mesh.primitives || []);
  const water = primitives.filter((primitive) => primitive.extras?.category === 'water');
  const coastline = primitives.filter((primitive) => primitive.extras?.category === 'coastline');
  assert(water.length === 2, `Expected two Ferry water primitives, got ${water.length}`);
  assert(coastline.length === 1, `Expected one Ferry coastline primitive, got ${coastline.length}`);
  assert(water.every((primitive) => primitive.attributes.NORMAL === undefined), 'Ferry water unexpectedly gained a NORMAL attribute');
  const waterY = water.map((primitive) => readAccessorYBounds(json, glbBytes, primitive.attributes.POSITION));
  const coastY = readAccessorYBounds(json, glbBytes, coastline[0].attributes.POSITION);
  assert(Math.abs(Math.min(...waterY.map((range) => range.min)) - (-1.07)) < 1e-4, 'Ferry water Y minimum drifted');
  assert(Math.abs(Math.max(...waterY.map((range) => range.max)) - 5.071836) < 1e-4, 'Ferry water Y maximum drifted');
  assert(coastY.count === 48, `Expected 48 coastline vertices, got ${coastY.count}`);
  return {
    manifestSha256: `sha256:${sha256Hex(await readFile(manifestPath))}`,
    descriptorCount: manifest.tiles.length,
    anchor: { id: anchorId, glbSha256: descriptor.lod0.sha256, receiptSha256: descriptor.receipt.sha256 },
    water: { primitiveCount: water.length, noNormalAttribute: true, yRanges: waterY },
    coastline: { primitiveCount: coastline.length, vertexCount: coastY.count, yRange: coastY },
  };
}

function qaTrackingSource() {
  return `
      if (node.material?.name === 'water-osm-coastline-night' || node.material?.name === 'coastline-osm-night') {
        const qa = window.__SF_WATER_QA_RUNTIME__;
        if (qa) {
          const key = node.material.name === 'water-osm-coastline-night' ? 'water' : 'coastline';
          qa.meshes[key] += 1;
          qa.geometry[key].push({
            positionCount: node.geometry?.attributes?.position?.count ?? null,
            hasNormal: Boolean(node.geometry?.attributes?.normal),
            materialName: node.material.name,
          });
        }
      }
`;
}

function viewerExposureSource() {
  return `
  if (window.__SF_WATER_QA_RUNTIME__) {
    window.__SF_WATER_QA_RUNTIME__.getTileStates = () => [...tileStates.values()].map((state) => ({
      id: state.descriptor.id,
      resident: Boolean(state.scene),
      integrity: JSON.parse(JSON.stringify(state.integrity)),
    }));
    window.__SF_WATER_QA_RUNTIME__.captureMask = (kind) => {
      const names = kind === 'water'
        ? new Set(['water-osm-coastline-night'])
        : kind === 'coastline'
          ? new Set(['coastline-osm-night'])
          : new Set(['water-osm-coastline-night', 'coastline-osm-night']);
      const saved = [];
      scene.traverse((node) => {
        if (!node.isMesh) return;
        saved.push({ node, visible: node.visible, material: node.material, temporary: null });
        const target = names.has(node.material?.name);
        node.visible = target;
        if (target) {
          saved.at(-1).temporary = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
          node.material = saved.at(-1).temporary;
        }
      });
      const previousColor = renderer.getClearColor(new THREE.Color()).getHex();
      const previousAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 1);
      renderer.render(scene, camera);
      const result = renderer.domElement.toDataURL('image/png');
      for (const entry of saved) {
        entry.node.visible = entry.visible;
        entry.node.material = entry.material;
        entry.temporary?.dispose();
      }
      renderer.setClearColor(previousColor, previousAlpha);
      renderer.render(scene, camera);
      return result;
    };
  }
`;
}

async function interceptProductionModule(page, mode) {
  await page.route('**/src/sf-map/main.js*', async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const waterMarker = `      if (node.material?.name === 'water-osm-coastline-night') {\n        node.material.color.setHex(0x0a5870);\n        node.material.roughness = 0.22;\n        node.material.metalness = 0.18;`;
    assert(body.includes(waterMarker), 'QA route could not find the production water material marker');
    if (mode === 'legacy-water') {
      const productionWaterCall = '        applyWaterPresentation(node.material);';
      assert(body.includes(productionWaterCall), 'QA route could not disable the production water response');
      body = body.replace(productionWaterCall, '        // QA baseline: production water response disabled.');
    }
    body = body.replace(waterMarker, `${waterMarker}\n${qaTrackingSource()}`);
    const viewerMarker = '  window.__SF_MAP_VIEWER__ = Object.freeze({';
    assert(body.includes(viewerMarker), 'QA route could not find the viewer exposure marker');
    body = body.replace(viewerMarker, `${viewerExposureSource()}${viewerMarker}`);
    const headers = { ...response.headers() };
    delete headers['content-length'];
    await route.fulfill({ status: response.status(), headers, body });
  });
}

function tupleWithin(actual, expected, tolerance = 1e-4) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

async function runBoot({ mode, bootIndex, includePlan }) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  await page.addInitScript((initialMode) => {
    window.__SF_WATER_QA_MODE__ = initialMode;
    window.__SF_WATER_QA_RUNTIME__ = {
      mode: initialMode,
      meshes: { water: 0, coastline: 0 },
      geometry: { water: [], coastline: [] },
    };
  }, mode);
  await interceptProductionModule(page, mode);
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => Boolean(window.__SF_MAP_VIEWER__), { timeout: 30000 });
    const descriptors = await page.evaluate(() => window.__SF_MAP_VIEWER__.tileDescriptors);
    assert(descriptors.length === expectedDescriptorCount, `${mode} boot ${bootIndex}: descriptor count drifted to ${descriptors.length}`);

    async function settle(view) {
      await page.evaluate((name) => window.__SF_MAP_VIEWER__.setView(name), view);
      await page.waitForFunction((name) => {
        const viewer = window.__SF_MAP_VIEWER__;
        const diagnostics = viewer?.streamingDiagnostics;
        if (!viewer || !diagnostics || diagnostics.activeView !== name || diagnostics.activeLoadCount || diagnostics.queuedCount) return false;
        if (name === 'district' && diagnostics.districtFit.oneTimeStatus !== 'fitted') return false;
        return diagnostics.explicitViewResidency.lastPrune?.view === name;
      }, view, { timeout: settleTimeoutMs });
      await page.waitForTimeout(180);
      const diagnostics = await page.evaluate(() => window.__SF_MAP_VIEWER__.streamingDiagnostics);
      const tileStates = await page.evaluate(() => window.__SF_WATER_QA_RUNTIME__.getTileStates());
      const telemetry = await page.evaluate(() => ({ ...window.__SF_WATER_QA_RUNTIME__, geometry: { ...window.__SF_WATER_QA_RUNTIME__.geometry } }));
      const residents = [...diagnostics.completed.filter((entry) => entry.result === 'verified-and-resident').map((entry) => entry.id)];
      const residentIds = await page.evaluate(() => window.__SF_MAP_VIEWER__.residentTileIds);
      const hashes = tileStates.filter((state) => residentIds.includes(state.id));
      assert(hashes.length === residentIds.length, `${view}: not all residents exposed to QA hash ledger`);
      for (const state of hashes) {
        assert(state.integrity.glb?.status === 'verified', `${view}: ${state.id} GLB hash did not verify`);
        assert(state.integrity.receipt?.status === 'verified', `${view}: ${state.id} receipt hash did not verify`);
        assert(sameSha256(state.integrity.glb.actualSha256, state.integrity.glb.expectedSha256), `${view}: ${state.id} GLB hash changed`);
        assert(sameSha256(state.integrity.receipt.actualSha256, state.integrity.receipt.expectedSha256), `${view}: ${state.id} receipt hash changed`);
        if (state.integrity.authorization) assert(sameSha256(state.integrity.authorization.actualSha256, state.integrity.authorization.sha256), `${view}: ${state.id} authorization hash changed`);
      }
      assert(diagnostics.completed.every((entry) => entry.result !== 'rejected'), `${view}: rejected tile(s) ${JSON.stringify(diagnostics.completed.filter((entry) => entry.result === 'rejected'))}`);
      assert(diagnostics.metricContract?.runtimeUnitsPerMetre === 1 && diagnostics.metricContract.sceneScale === 1 && diagnostics.metricContract.originSubtractions === 1, `${view}: metric placement drifted`);
      assert(diagnostics.metricContract.sourceLockedDescriptors === true, `${view}: source lock contract drifted`);
      assert(Number.isFinite(diagnostics.presentation.performance.drawCalls) && Number.isFinite(diagnostics.presentation.performance.triangles) && Number.isFinite(diagnostics.presentation.performance.programCount), `${view}: missing render-cost telemetry`);
      const filePath = join(outputDir, `boot-${bootIndex}-${mode}-${view}.png`);
      await page.screenshot({ path: filePath });
      const maskData = await page.evaluate(() => Object.fromEntries(
        ['water', 'coastline', 'waterfront'].map((kind) => [kind, window.__SF_WATER_QA_RUNTIME__.captureMask(kind)]),
      ));
      const masks = {};
      for (const [kind, dataUrl] of Object.entries(maskData)) {
        const maskPath = join(outputDir, `boot-${bootIndex}-${mode}-${view}-${kind}-mask.png`);
        await writeFile(maskPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
        masks[kind] = maskPath;
      }
      return {
        view,
        residents: residentIds,
        completedResidentIds: residents,
        camera: diagnostics.camera,
        presentation: diagnostics.presentation,
        metricContract: diagnostics.metricContract,
        rejected: diagnostics.completed.filter((entry) => entry.result === 'rejected'),
        hashes,
        telemetry,
        screenshot: filePath,
        masks,
      };
    }

    const ferry = await settle('ferry');
    assert(ferry.residents.length === 10, `${mode} boot ${bootIndex}: Ferry resident count drifted to ${ferry.residents.length}`);
    assert(tupleWithin(ferry.camera.position, [430, 132, 292]), `${mode} Ferry camera position drifted`);
    assert(tupleWithin(ferry.camera.target, [119, 8, 292]), `${mode} Ferry camera target drifted`);
    assert(ferry.camera.fovDegrees === 43 && ferry.camera.nearMetres === 0.5, `${mode} Ferry projection drifted`);

    const district = await settle('district');
    assert(district.residents.length === 16, `${mode} boot ${bootIndex}: District resident count drifted to ${district.residents.length}`);
    const plan = { view: 'plan', screenshot: null, diagnostics: null };
    if (includePlan) {
      await page.evaluate(() => window.__SF_MAP_VIEWER__.setView('plan'));
      await page.waitForTimeout(planSafetyWaitMs);
      plan.diagnostics = await page.evaluate(() => window.__SF_MAP_VIEWER__.streamingDiagnostics);
      plan.screenshot = join(outputDir, `boot-${bootIndex}-${mode}-plan.png`);
      await page.screenshot({ path: plan.screenshot });
      const planMaskData = await page.evaluate(() => Object.fromEntries(
        ['water', 'coastline', 'waterfront'].map((kind) => [kind, window.__SF_WATER_QA_RUNTIME__.captureMask(kind)]),
      ));
      plan.masks = {};
      for (const [kind, dataUrl] of Object.entries(planMaskData)) {
        const maskPath = join(outputDir, `boot-${bootIndex}-${mode}-plan-${kind}-mask.png`);
        await writeFile(maskPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
        plan.masks[kind] = maskPath;
      }
      assert(plan.diagnostics.metricContract?.runtimeUnitsPerMetre === 1 && plan.diagnostics.metricContract.sceneScale === 1 && plan.diagnostics.metricContract.originSubtractions === 1, `${mode} Plan metric placement drifted`);
      assert(plan.diagnostics.metricContract.sourceLockedDescriptors === true, `${mode} Plan source lock contract drifted`);
      assert(plan.diagnostics.completed.every((entry) => entry.result !== 'rejected'), `${mode} Plan rejected tile(s)`);
    }
    assert(errors.length === 0, `${mode} boot ${bootIndex}: browser errors ${errors.join(' | ')}`);
    const descriptorSnapshot = await page.evaluate(() => window.__SF_MAP_VIEWER__.tileDescriptors);
    assert(JSON.stringify(descriptorSnapshot) === JSON.stringify(descriptors), `${mode} boot ${bootIndex}: descriptor snapshot changed during run`);
    const runtime = await page.evaluate(() => ({ ...window.__SF_WATER_QA_RUNTIME__, geometry: { ...window.__SF_WATER_QA_RUNTIME__.geometry } }));
    return { mode, bootIndex, descriptorCount: descriptors.length, ferry, district, plan, runtime, errors };
  } finally {
    await page.close();
    await browser.close();
  }
}

function imageDecodeMetricsSource() {
  return async ({ before, after, beforeMask, afterMask }) => {
    const decode = async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const a = await decode(before);
    const b = await decode(after);
    const aMask = await decode(beforeMask);
    const bMask = await decode(afterMask);
    if (a.width !== b.width || a.height !== b.height || a.width !== aMask.width || a.height !== aMask.height || a.width !== bMask.width || a.height !== bMask.height) throw new Error('A/B/mask dimensions drifted');
    const width = a.width;
    const height = a.height;
    const index = (x, y) => (y * width + x) * 4;
    const lum = (pixels, offset) => pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
    const baselineMask = new Uint8Array(width * height);
    const candidateMask = new Uint8Array(width * height);
    const expandedMask = new Uint8Array(width * height);
    let waterPixels = 0;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const offset = index(x, y);
      if (aMask.pixels[offset] > 127 && aMask.pixels[offset + 3] > 0) {
        baselineMask[y * width + x] = 1;
        waterPixels += 1;
      }
      if (bMask.pixels[offset] > 127 && bMask.pixels[offset + 3] > 0) candidateMask[y * width + x] = 1;
    }
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      if (!baselineMask[y * width + x]) continue;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) expandedMask[ny * width + nx] = 1;
      }
    }
    const edgeStats = (pixels) => {
      const deltas = [];
      let triangleSamples = 0;
      let triangleHits = 0;
      for (let y = 0; y < height - 1; y += 1) for (let x = 0; x < width - 1; x += 1) {
        const p = y * width + x;
        if (baselineMask[p] && baselineMask[p + 1]) deltas.push(lum(pixels, index(x, y)) - lum(pixels, index(x + 1, y)));
        if (baselineMask[p] && baselineMask[p + width]) deltas.push(lum(pixels, index(x, y)) - lum(pixels, index(x, y + 1)));
        if (baselineMask[p] && baselineMask[p + 1] && baselineMask[p + width] && baselineMask[p + width + 1]) {
          const diag = Math.abs(
            lum(pixels, index(x, y)) + lum(pixels, index(x + 1, y + 1))
            - lum(pixels, index(x + 1, y)) - lum(pixels, index(x, y + 1)),
          ) * 0.5;
          triangleSamples += 1;
          if (diag > 4) triangleHits += 1;
        }
      }
      const mean = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
      const variance = deltas.length ? deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / deltas.length : 0;
      return {
        samples: deltas.length,
        edgeMeanAbsolute: deltas.length ? deltas.reduce((sum, value) => sum + Math.abs(value), 0) / deltas.length : 0,
        edgeVariance: variance,
        triangleSamples,
        triangleFrequency: triangleSamples ? triangleHits / triangleSamples : 0,
      };
    };
    let outsideDifferent = 0;
    let outsideAbs = 0;
    let maskDifferent = 0;
    let total = width * height;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const offset = index(x, y);
      const diff = Math.abs(a.pixels[offset] - b.pixels[offset]) + Math.abs(a.pixels[offset + 1] - b.pixels[offset + 1]) + Math.abs(a.pixels[offset + 2] - b.pixels[offset + 2]);
      if (!expandedMask[p]) { if (diff) outsideDifferent += 1; outsideAbs += diff / 3; }
      if (Boolean(baselineMask[p]) !== Boolean(candidateMask[p])) maskDifferent += 1;
    }
    const beforeStats = edgeStats(a.pixels);
    const candidateStats = edgeStats(b.pixels);
    const expandedCount = expandedMask.reduce((sum, value) => sum + value, 0);
    return {
      width,
      height,
      roi: { materialMask: 'QA-only white target-material visibility render; threshold excludes MSAA edge pixels', maskPixels: waterPixels },
      waterPixels,
      baseline: beforeStats,
      candidate: candidateStats,
      waterEdgeVarianceReduction: beforeStats.edgeVariance > 1e-9 ? (beforeStats.edgeVariance - candidateStats.edgeVariance) / beforeStats.edgeVariance : 0,
      waterTriangleFrequencyReduction: beforeStats.triangleFrequency > 1e-9 ? (beforeStats.triangleFrequency - candidateStats.triangleFrequency) / beforeStats.triangleFrequency : 0,
      nonWater: { pixels: total - expandedCount, differingPixels: outsideDifferent, meanAbsoluteRgb: outsideAbs / Math.max(1, total - expandedCount) },
      shorelineMaskDifferentPixels: maskDifferent,
    };
  };
}

async function imageMetrics(beforePath, afterPath, beforeMaskPath, afterMaskPath, browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    const before = (await readFile(beforePath)).toString('base64');
    const after = (await readFile(afterPath)).toString('base64');
    const beforeMask = (await readFile(beforeMaskPath)).toString('base64');
    const afterMask = (await readFile(afterMaskPath)).toString('base64');
    return await page.evaluate(imageDecodeMetricsSource(), { before, after, beforeMask, afterMask });
  } finally {
    await page.close();
  }
}

async function buildContactSheet(paths, outputPath, browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    const pairs = [
      ['FERRY · LEGACY / PRODUCTION WATER', paths.ferryBaseline, paths.ferryWater],
      ['DISTRICT · LEGACY / PRODUCTION WATER', paths.districtBaseline, paths.districtWater],
    ].filter((pair) => pair.length === 3 && pair[1] && pair[2]);
    const frames = await Promise.all(pairs.map(async ([label, before, after]) => ({
      label,
      before: `data:image/png;base64,${(await readFile(before)).toString('base64')}`,
      after: `data:image/png;base64,${(await readFile(after)).toString('base64')}`,
    })));
    await page.setContent(`<!doctype html><style>body{margin:0;background:#07100f;color:#d7ff48;font:600 13px system-ui}.grid{display:grid;grid-template-columns:repeat(${frames.length},1fr);height:720px}.pair{min-width:0;border-right:1px solid #314239}.label{height:30px;box-sizing:border-box;padding:8px 12px;background:#0b1713;white-space:nowrap;overflow:hidden}.row{position:relative;height:330px}.row span{position:absolute;z-index:1;left:10px;top:9px;background:#07100fcc;padding:4px 6px}.row img{display:block;width:100%;height:330px;object-fit:cover}</style><div class="grid">${frames.map(({ label, before, after }) => `<section class="pair"><header class="label">${label}</header><div class="row"><span>BEFORE</span><img src="${before}"></div><div class="row"><span>AFTER</span><img src="${after}"></div></section>`).join('')}</div>`);
    await page.screenshot({ path: outputPath });
  } finally {
    await page.close();
  }
}

const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
let analysisBrowser;
try {
  await mkdir(outputDir, { recursive: true });
  const geometry = await verifyLockedFerryGeometry();
  await waitForPort('127.0.0.1', port);
  const runs = {};
  // Include Plan only on boot 1 of each mode: this is a bounded safety frame,
  // while Ferry and District receive the exact two-fresh-boot determinism gate.
  for (const mode of ['legacy-water', 'production-water']) {
    runs[mode] = [];
    for (const bootIndex of [1, 2]) {
      const includePlan = bootIndex === 1;
      runs[mode].push(await runBoot({ mode, bootIndex, includePlan }));
    }
  }
  analysisBrowser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  const baseline = runs['legacy-water'][0];
  const water = runs['production-water'][0];
  const metrics = {
    waterOnlyFerry: await imageMetrics(baseline.ferry.screenshot, water.ferry.screenshot, baseline.ferry.masks.water, water.ferry.masks.water, analysisBrowser),
    waterOnlyDistrict: await imageMetrics(baseline.district.screenshot, water.district.screenshot, baseline.district.masks.water, water.district.masks.water, analysisBrowser),
    waterOnlyPlan: await imageMetrics(baseline.plan.screenshot, water.plan.screenshot, baseline.plan.masks.water, water.plan.masks.water, analysisBrowser),
  };
  // Fresh-boot determinism: the same mode/camera must reproduce the same
  // raster exactly. A non-zero value is a hard rejection, not a warning.
  for (const mode of ['legacy-water', 'production-water']) for (const view of ['ferry', 'district']) {
    const a = await readFile(runs[mode][0][view].screenshot);
    const b = await readFile(runs[mode][1][view].screenshot);
    assert(sha256Hex(a) === sha256Hex(b), `${mode} ${view} changed between fresh boots`);
  }
  assert(metrics.waterOnlyFerry.nonWater.meanAbsoluteRgb <= 0.01, 'Production water response materially changed pixels outside its two-pixel material-mask halo');
  assert(metrics.waterOnlyDistrict.nonWater.differingPixels === 0, 'Production water response changed the water-free District frame');
  // A candidate must reduce high-frequency water response materially while
  // leaving the raster silhouette/coast boundary unchanged. This deliberately
  // fails if a water normal response cannot affect the observed teeth.
  const waterOnlyMaterial = metrics.waterOnlyFerry.waterEdgeVarianceReduction >= 0.18
    || metrics.waterOnlyFerry.waterTriangleFrequencyReduction >= 0.18;
  const waterSilhouetteStable = metrics.waterOnlyFerry.shorelineMaskDifferentPixels === 0;
  const report = {
    result: waterOnlyMaterial && waterSilhouetteStable ? 'PRODUCTION-WATER-SHADING-PASS' : 'REJECTED: PRODUCTION WATER RESPONSE DID NOT MATERIALLY REDUCE TRIANGULAR SHADING',
    policy: {
      source: 'byte-locked production SF-map runtime; QA route disables only applyWaterPresentation for the legacy baseline',
      candidate: 'production world-up-view-space-v1 water material response; no color/roughness/metalness/emissive or geometry change',
      claim: 'reduces lighting-driven triangular faceting; source water and coastline geometry remain unchanged',
      variants: ['legacy-water', 'production-water'],
      twoFreshBoots: true,
      descriptorCount: expectedDescriptorCount,
      exactResidency: { ferry: 10, district: 16 },
      plan: 'bounded metric/error safety snapshot only on boot 1; not a matched raster gate',
      failClosed: true,
    },
    geometry,
    metrics,
    runs,
    visual: {},
  };
  const contactSheet = join(outputDir, 'water-normal-before-after-contact-sheet.png');
  await buildContactSheet({
    ferryBaseline: baseline.ferry.screenshot,
    ferryWater: water.ferry.screenshot,
    districtBaseline: baseline.district.screenshot,
    districtWater: water.district.screenshot,
  }, contactSheet, analysisBrowser);
  report.visual.contactSheet = contactSheet;
  await writeFile(join(outputDir, 'water-normal-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await analysisBrowser?.close();
  vite.kill('SIGTERM');
}
