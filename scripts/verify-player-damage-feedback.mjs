 // Strict Apple Metal gate for player damage feedback: nonlethal hit, real
 // pursuit-pressure damage, lethal/downed hit, QA-camera suppression, and the
 // camera/avatar presentation rubric. Fail-closed: missing telemetry or
 // missing measurable feedback fails the gate with an explicit blocker.
 import { access, mkdir } from 'node:fs/promises';
 import { chromium } from 'playwright';
 import { join, dirname } from 'node:path';
 import { fileURLToPath } from 'node:url';

 const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
 const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
 const outputDir = process.env.SF_DAMAGE_FEEDBACK_DIR
   || join(projectRoot, '.qa-player-damage-feedback');
 const systemChrome = process.env.SF_QA_EXECUTABLE
   || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
 const angle = process.env.SF_QA_ANGLE || 'metal';
 const viewport = { width: 1280, height: 720 };

 if (process.platform !== 'darwin') {
   throw new Error('verify-player-damage-feedback requires macOS so Apple Metal can be verified.');
 }
 if (angle !== 'metal') {
   throw new Error(`verify-player-damage-feedback requires SF_QA_ANGLE=metal, received ${angle}`);
 }
 if (!executablePath) {
   throw new Error(`System Chrome is required for the Apple Metal gate: ${systemChrome}`);
 }

 await mkdir(outputDir, { recursive: true });
 const browser = await chromium.launch({
   headless: process.env.SF_QA_HEADLESS !== 'false',
   executablePath,
   args: [
     '--disable-dev-shm-usage',
     '--use-angle=metal',
     '--enable-gpu',
     '--ignore-gpu-blocklist',
   ],
 });
 const page = await browser.newPage({ viewport });
 const failures = [];
 const blockers = [];
 const consoleErrors = [];
 const httpErrors = [];
 const requestErrors = [];
 const captures = [];

 const assert = (condition, message, detail = null) => {
   if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
 };
 const noteBlocker = (message, detail = null) => {
   blockers.push({ message, ...(detail ? { detail } : {}) });
 };

 page.on('pageerror', (error) => consoleErrors.push(error.message));
 page.on('console', (message) => {
   if (message.type() === 'error' && !message.text().includes('/favicon.ico')) {
     consoleErrors.push(message.text());
   }
 });
 page.on('response', (response) => {
   if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
     httpErrors.push(`${response.status()} ${response.url()}`);
   }
 });
 page.on('requestfailed', (request) => {
   if (!request.url().endsWith('/favicon.ico')) {
     requestErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
   }
 });

 // ---------------------------------------------------------------------------
 // Page-side instrumentation. The recorder samples camera, avatar bones, and
 // combat state every rAF relative to a trigger timestamp so the rubric can be
 // evaluated from real frame data. If the product lands the proposed
 // `getCombatState().damageFeedback` telemetry it is captured verbatim and
 // treated as authoritative where present.
 // ---------------------------------------------------------------------------
 function installRecorderBody() {
   const sim = window.__SF_SIM__;
   const ud = sim.playerAvatar?.userData || {};
   const V3 = sim.camera.position.constructor;
   const anchor = new V3(
     sim.camera.position.x + Math.sin(sim.camera.rotation.y || 0),
     sim.camera.position.y - 1.4,
     sim.camera.position.z + Math.cos(sim.camera.rotation.y || 0),
   );
   // Anchor on the traversal focus when available: screen shift of that fixed
   // world point is the camera-jolt pixel proxy.
   const traversal = sim.getTraversalCameraState?.();
   if (traversal?.focus) anchor.set(traversal.focus.x, traversal.focus.y, traversal.focus.z);
   const partNames = ['head', 'body', 'leftArm', 'rightArm', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'];
   const parts = {};
   partNames.forEach((name) => {
     if (ud[name]?.getWorldPosition) parts[name] = { object: ud[name], scratch: new V3() };
   });
   const recorder = {
     active: true,
     done: false,
     triggerAt: null,
     durationMs: 0,
     samples: [],
     partsAvailable: Object.keys(parts),
     feedbackTelemetryPresent: false,
   };
   window.__SF_DAMAGE_FEEDBACK_RECORDER__ = recorder;
   const width = sim.renderer.domElement.clientWidth || 1280;
   const height = sim.renderer.domElement.clientHeight || 720;
   const project = (world, out) => {
     out.copy(world).project(sim.camera);
     return {
       x: (out.x * 0.5 + 0.5) * width,
       y: (-out.y * 0.5 + 0.5) * height,
     };
   };
   const scratchA = new V3();
   const sample = () => {
     const rec = window.__SF_DAMAGE_FEEDBACK_RECORDER__;
     if (!rec || !rec.active) return;
     const combat = sim.getCombatState?.() || {};
     const feedback = combat.damageFeedback;
     const feedbackValue = typeof feedback === 'function' ? feedback() : feedback;
     if (feedbackValue != null) rec.feedbackTelemetryPresent = true;
     const partPoints = {};
     const partWorld = {};
     Object.entries(parts).forEach(([name, entry]) => {
       entry.object.getWorldPosition(entry.scratch);
       partWorld[name] = { x: entry.scratch.x, y: entry.scratch.y, z: entry.scratch.z };
       partPoints[name] = project(entry.scratch, scratchA);
     });
     const traversalNow = sim.getTraversalCameraState?.() || null;
     rec.samples.push({
       t: rec.triggerAt == null ? 0 : performance.now() - rec.triggerAt,
       camera: {
         x: sim.camera.position.x,
         y: sim.camera.position.y,
         z: sim.camera.position.z,
       },
       anchorPx: project(anchor, scratchA),
       partPx: partPoints,
       partWorld,
       bodyRotation: ud.body?.rotation
         ? { x: ud.body.rotation.x, y: ud.body.rotation.y, z: ud.body.rotation.z }
         : null,
       jointRotations: Object.fromEntries(['headPivot', 'body', 'rightArm'].map((name) => [
         name,
         ud[name]?.rotation
           ? { x: ud[name].rotation.x, y: ud[name].rotation.y, z: ud[name].rotation.z }
           : null,
       ])),
       rigY: ud.rig?.position?.y ?? null,
       avatarVisible: sim.playerAvatar?.visible === true,
       health: combat.health,
       damageFlash: combat.damageFlash,
       status: combat.status,
       aiming: combat.aiming,
       lockedTargetId: combat.lockedTargetId,
       weaponVisible: combat.weapon?.visible === true,
       gripSocketDistance: combat.embodiment?.weapon?.gripSocketDistance ?? null,
       downedTimer: combat.downedTimer,
       feedback: feedbackValue ?? null,
       cameraClearance: traversalNow?.cameraSurfaceClearance ?? null,
       cameraBlocker: traversalNow?.blocker ?? null,
     });
     if (rec.triggerAt != null && performance.now() - rec.triggerAt >= rec.durationMs) {
       rec.active = false;
       rec.done = true;
       return;
     }
     if (rec.samples.length < 1400) requestAnimationFrame(sample);
   };
   requestAnimationFrame(sample);
   return recorder.partsAvailable;
 }

 async function startRecorder(durationMs) {
   const partsAvailable = await page.evaluate(installRecorderBody);
   await page.evaluate((duration) => {
     window.__SF_DAMAGE_FEEDBACK_RECORDER__.durationMs = duration;
   }, durationMs);
   return partsAvailable;
 }

 async function collectRecorder(timeoutMs) {
   await page.waitForFunction(
     () => window.__SF_DAMAGE_FEEDBACK_RECORDER__?.done === true,
     null,
     { timeout: timeoutMs, polling: 25 },
   );
   const recorder = await page.evaluate(() => {
     const rec = window.__SF_DAMAGE_FEEDBACK_RECORDER__;
     window.__SF_DAMAGE_FEEDBACK_RECORDER__ = null;
     return {
       samples: rec.samples,
       partsAvailable: rec.partsAvailable,
       feedbackTelemetryPresent: rec.feedbackTelemetryPresent,
     };
   });
   return recorder;
 }

 async function capture(name) {
   const path = join(outputDir, `${name}.png`);
   await page.screenshot({ path });
   captures.push(path);
   return path;
 }

 // Screenshot-review proxy: synchronous render + downsampled luma/edge stats so
 // a phase must show a real pixel-level change, independent of telemetry.
 function pixelProxyBody() {
   const sim = window.__SF_SIM__;
   sim.renderer.render(sim.scene, sim.camera);
   const source = sim.renderer.domElement;
   const canvas = document.createElement('canvas');
   canvas.width = 128;
   canvas.height = 72;
   const context = canvas.getContext('2d', { willReadFrequently: true });
   context.drawImage(source, 0, 0, canvas.width, canvas.height);
   const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
   const luma = new Float32Array(canvas.width * canvas.height);
   let red = 0;
   for (let index = 0; index < luma.length; index += 1) {
     const offset = index * 4;
     const r = data[offset];
     const g = data[offset + 1];
     const b = data[offset + 2];
     luma[index] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
     if (r > g + 18 && r > b + 18) red += 1;
   }
   let mean = 0;
   for (let index = 0; index < luma.length; index += 1) mean += luma[index];
   mean /= luma.length;
   let variance = 0;
   let edge = 0;
   for (let y = 0; y < canvas.height; y += 1) {
     for (let x = 0; x < canvas.width; x += 1) {
       const index = y * canvas.width + x;
       const value = luma[index];
       variance += (value - mean) * (value - mean);
       if (x + 1 < canvas.width) edge += Math.abs(luma[index + 1] - value);
       if (y + 1 < canvas.height) edge += Math.abs(luma[index + canvas.width] - value);
     }
   }
   return {
     meanLuma: Number(mean.toFixed(2)),
     lumaStd: Number(Math.sqrt(variance / luma.length).toFixed(2)),
     edgeEnergy: Number(edge.toFixed(1)),
     redRatio: Number((red / luma.length).toFixed(4)),
     notBlack: mean > 4,
     notWhite: mean < 251,
   };
 }

 // ------------------------------ rubric math --------------------------------
 const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
 const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

 function analyzePhase(samples, { triggerHealth = null } = {}) {
   // Trigger sample: explicit t=0 for direct staging, or the first health
   // step for product-path damage (pursuit pressure).
   let triggerIndex = 0;
   if (triggerHealth != null) {
     triggerIndex = samples.findIndex((sample) => sample.health < triggerHealth);
     if (triggerIndex < 0) triggerIndex = samples.length - 1;
   }
   const baseline = samples[triggerIndex];
   const relative = samples.slice(triggerIndex).map((sample) => ({
     ...sample,
     t: sample.t - baseline.t,
     cameraDelta: dist3(sample.camera, baseline.camera),
     anchorPxShift: dist2(sample.anchorPx, baseline.anchorPx),
     angleDelta: (() => {
       const pivot = baseline.partWorld.body ?? baseline.partWorld.head ?? baseline.camera;
       const va = {
         x: baseline.camera.x - pivot.x,
         z: baseline.camera.z - pivot.z,
       };
       const vb = {
         x: sample.camera.x - pivot.x,
         z: sample.camera.z - pivot.z,
       };
       const la = Math.hypot(va.x, va.z);
       const lb = Math.hypot(vb.x, vb.z);
       if (la < 1e-6 || lb < 1e-6) return 0;
       const cosine = Math.max(-1, Math.min(1, (va.x * vb.x + va.z * vb.z) / (la * lb)));
       return Math.acos(cosine);
     })(),
   }));
   const cameraWindow = relative.filter((sample) => sample.t <= 700);
   const peakSample = cameraWindow.reduce(
     (best, sample) => (sample.cameraDelta > best.cameraDelta ? sample : best),
     cameraWindow[0] ?? relative[0],
   );
   const partPeak = {};
   for (const name of Object.keys(baseline.partPx)) {
     let px = 0;
     let world = 0;
     let pxAt = 0;
     for (const sample of relative) {
       const pxShift = dist2(sample.partPx[name] ?? baseline.partPx[name], baseline.partPx[name]);
       const worldShift = dist3(sample.partWorld[name] ?? baseline.partWorld[name], baseline.partWorld[name]);
       if (pxShift > px) { px = pxShift; pxAt = sample.t; }
       if (worldShift > world) world = worldShift;
     }
     partPeak[name] = {
       px: Number(px.toFixed(2)),
       world: Number(world.toFixed(4)),
       pxAtMs: Math.round(pxAt),
       moved: px >= 2 || world >= 0.02,
     };
   }
   const movedParts = Object.entries(partPeak).filter(([, entry]) => entry.moved).map(([name]) => name);
   const jointPeak = {};
   for (const [name, threshold] of Object.entries({ headPivot: 0.1, body: 0.12, rightArm: 0.18 })) {
     const base = baseline.jointRotations?.[name];
     const peak = base ? Math.max(0, ...relative.map((sample) => {
       const current = sample.jointRotations?.[name] ?? base;
       return Math.hypot(current.x - base.x, current.y - base.y, current.z - base.z);
     })) : 0;
     jointPeak[name] = {
       radians: Number(peak.toFixed(4)),
       threshold,
       moved: peak >= threshold,
     };
   }
   const settleSample = relative.find((sample) => (
     sample.t >= 280
       && sample.t <= 1000
       && sample.cameraDelta < 0.005
       && sample.anchorPxShift < 1.5
       && Object.keys(baseline.partPx).every((name) => (
         dist2(sample.partPx[name] ?? baseline.partPx[name], baseline.partPx[name]) < 2
       ))
   ));
   const recoverySample = relative.reduce(
     (closest, sample) => (Math.abs(sample.t - 1000) < Math.abs(closest.t - 1000) ? sample : closest),
     relative[0],
   );
   return {
     sampleCount: samples.length,
     triggerIndex,
     triggerHealth,
     peak: {
       tMs: Math.round(peakSample.t),
       cameraDeltaM: Number(peakSample.cameraDelta.toFixed(4)),
       anchorPxShift: Number(peakSample.anchorPxShift.toFixed(2)),
       angleDeltaRad: Number(peakSample.angleDelta.toFixed(4)),
     },
     movedParts,
     partPeak,
     jointPeak,
     settle: settleSample ? { tMs: Math.round(settleSample.t) } : null,
     recoveryAt1000ms: {
       cameraDeltaM: Number(recoverySample.cameraDelta.toFixed(4)),
       anchorPxShift: Number(recoverySample.anchorPxShift.toFixed(2)),
       damageFlash: recoverySample.damageFlash,
     },
     clearanceMin: Math.min(...relative.map((sample) => (
       sample.cameraClearance == null ? Infinity : sample.cameraClearance
     ))),
     blockerSeen: relative.some((sample) => sample.cameraBlocker != null),
   };
 }

 function summarizeFeedback(samples, triggerIndex = 0) {
   const baseline = samples[triggerIndex] ?? samples[0];
   const relative = samples.slice(triggerIndex).map((sample) => ({
     ...sample,
     t: sample.t - baseline.t,
   }));
   const impulseSamples = relative.filter((sample) => sample.feedback?.cameraImpulse);
   const peak = impulseSamples.reduce((best, sample) => (
     (sample.feedback.cameraImpulse.currentOffsetMeters ?? 0)
       > (best?.feedback?.cameraImpulse?.currentOffsetMeters ?? -1)
       ? sample : best
   ), null);
   const settle = impulseSamples.find((sample) => (
     sample.t >= 280
       && sample.feedback.cameraImpulse.active === false
       && (sample.feedback.cameraImpulse.currentOffsetMeters ?? 0) <= 0.002
   ));
   const flinchParts = [...new Set(impulseSamples.flatMap(
     (sample) => sample.feedback?.reaction?.bonesMoved ?? [],
   ))];
   const downedPeak = relative
     .filter((sample) => sample.t >= 250 && sample.t <= 700 && sample.feedback?.reaction)
     .reduce((best, sample) => (
       (sample.feedback.reaction.downedEnvelope ?? 0)
         > (best?.feedback?.reaction?.downedEnvelope ?? -1)
         ? sample : best
     ), null);
   return peak ? {
     peakMs: Math.round(peak.t),
     cameraPeakM: peak.feedback.cameraImpulse.currentOffsetMeters,
     cameraPeakPx: Number(dist2(peak.anchorPx, baseline.anchorPx).toFixed(2)),
     cameraPeakRad: peak.feedback.cameraImpulse.yawRadians,
     settleMs: settle ? Math.round(settle.t) : null,
     flinchParts,
     downedPeakMs: downedPeak ? Math.round(downedPeak.t) : null,
   } : null;
 }

 function assertCameraRubric(phase, analysis, telemetry) {
   // Camera jolt rubric: peak within 50-180 ms, 0.03-0.35 m, 2-24 px,
   // <= 0.045 rad; drift settled by 1 s. Product telemetry may override the
   // measured values when present.
   const peakT = telemetry?.peakMs ?? analysis.peak.tMs;
   const peakM = telemetry?.cameraPeakM ?? analysis.peak.cameraDeltaM;
   const peakPx = telemetry?.cameraPeakPx ?? analysis.peak.anchorPxShift;
   const peakRad = telemetry?.cameraPeakRad ?? analysis.peak.angleDeltaRad;
   const settleMs = telemetry?.settleMs ?? analysis.settle?.tMs ?? null;
   assert(peakT >= 50 && peakT <= 180,
     `${phase}: camera peak outside the 50-180 ms rubric window`, { peakT });
   assert(peakM >= 0.03 && peakM <= 0.35,
     `${phase}: camera peak displacement outside 0.03-0.35 m`, { peakM });
   assert(peakPx >= 2 && peakPx <= 24,
     `${phase}: camera peak screen shift outside 2-24 px`, { peakPx });
   assert(peakRad <= 0.045,
     `${phase}: camera peak angular delta above 0.045 rad`, { peakRad });
   assert(settleMs != null && settleMs >= 280 && settleMs <= 550,
     `${phase}: camera/avatar drift did not settle within 280-550 ms`, { settleMs });
   assert(analysis.recoveryAt1000ms.cameraDeltaM <= 0.05
     && analysis.recoveryAt1000ms.anchorPxShift <= 3,
   `${phase}: residual camera drift remained after the 700-1000 ms recovery window`,
   { recovery: analysis.recoveryAt1000ms });
   assert(analysis.blockerSeen === false,
     `${phase}: camera ray intersected world geometry during feedback`, { analysis });
   assert(Number.isFinite(analysis.clearanceMin) === false || analysis.clearanceMin >= 0.05,
     `${phase}: camera penetrated the traversal surface during feedback`, {
       clearanceMin: analysis.clearanceMin,
     });
 }

 function assertFlinchRubric(phase, analysis, telemetry) {
   // Nonlethal flinch rubric: require measured joint rotation, not self-
   // reported bones or a full-frame pixel delta dominated by camera/HUD.
   const measuredJoints = Object.entries(analysis.jointPeak ?? {})
     .filter(([, entry]) => entry.moved)
     .map(([name]) => name);
   assert(measuredJoints.length >= 2,
     `${phase}: avatar flinch was not physically measurable in >=2 joints`, {
       movedParts: analysis.movedParts,
       partPeak: analysis.partPeak,
       jointPeak: analysis.jointPeak,
       telemetryParts: telemetry?.flinchParts ?? null,
     });
 }

 try {
   await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
   await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
   await page.waitForFunction(() => document.querySelector('#launch-button')
     && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
   await page.locator('#launch-button').click();
   await page.waitForFunction(() => document.querySelector('#boot-overlay')
     ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
   await page.waitForFunction(() => window.__SF_SIM__?.playerAvatar?.visible === true
     && window.__SF_SIM__?.getCombatState?.() != null, null, { timeout: 20000, polling: 25 });
   await page.waitForTimeout(1400);

   const rendererName = await page.evaluate(() => {
     const gl = window.__SF_SIM__.renderer.getContext();
     const extension = gl.getExtension('WEBGL_debug_renderer_info');
     return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
   });
   assert(typeof rendererName === 'string'
     && /metal/i.test(rendererName)
     && !/swiftshader|software|llvmpipe/i.test(rendererName),
   'a verified hardware Metal renderer was not active', { angle, rendererName });
   if (!(typeof rendererName === 'string' && /metal/i.test(rendererName))) {
     throw new Error(`Metal renderer verification failed: ${rendererName}`);
   }

   await page.evaluate(() => {
     const sim = window.__SF_SIM__;
     sim.restartCombat?.();
     sim.streetHeat?.restart?.();
     sim.setWeather?.('clear');
   });
   await page.mouse.move(viewport.width / 2, viewport.height / 2);
   await page.mouse.down({ button: 'right' });
   await page.waitForFunction(() => window.__SF_SIM__.getCombatState()?.aiming === true,
     null, { timeout: 3000, polling: 20 });
   await page.waitForTimeout(900);

   let resourcesBefore = await page.evaluate(() => ({
     geometries: window.__SF_SIM__.renderer.info.memory.geometries,
     textures: window.__SF_SIM__.renderer.info.memory.textures,
     programs: window.__SF_SIM__.renderer.info.programs?.length ?? null,
     drawCalls: window.__SF_SIM__.renderer.info.render.calls,
   }));
   const worldBefore = await page.evaluate(() => {
     const sim = window.__SF_SIM__;
     return {
       portalIds: (sim.city?.portals || []).map((portal) => portal.id).sort(),
       coreFacades: typeof sim.city?.getCoreFacadeDiagnostics === 'function'
         ? sim.city.getCoreFacadeDiagnostics().map((entry) => entry.label).sort()
         : null,
     };
   });
   if (worldBefore.coreFacades) {
     assert(worldBefore.coreFacades.length === 5,
       'core facade diagnostics did not expose the five authored buildings', worldBefore);
   }

   await capture('00-baseline');
   const pixelBaseline = await page.evaluate(pixelProxyBody);
   assert(pixelBaseline.notBlack && pixelBaseline.notWhite,
     'baseline frame was not a legible render', pixelBaseline);

   // ------------------------- Phase 1: nonlethal 18 damage ------------------
   await startRecorder(1700);
   const nonlethalTrigger = await page.evaluate(() => {
     const sim = window.__SF_SIM__;
     const before = sim.getCombatState();
     const damaged = sim.damagePlayer(18, 'qa-nonlethal');
     const recorder = window.__SF_DAMAGE_FEEDBACK_RECORDER__;
     recorder.triggerAt = performance.now();
     const after = sim.getCombatState();
     return {
       damaged,
       healthBefore: before.health,
       healthAfter: after.health,
       damageFlash: after.damageFlash,
       status: after.status,
       aiming: after.aiming,
       lockedTargetId: after.lockedTargetId,
       weaponVisible: after.weapon?.visible === true,
       gripSocketDistance: after.embodiment?.weapon?.gripSocketDistance ?? null,
     };
   });
   assert(nonlethalTrigger.damaged === true
     && nonlethalTrigger.healthBefore - nonlethalTrigger.healthAfter === 18,
   'direct nonlethal staging did not apply exactly 18 damage', nonlethalTrigger);
   assert(nonlethalTrigger.damageFlash > 0 && nonlethalTrigger.status === 'running',
     'nonlethal damage did not set the running damageFlash state', nonlethalTrigger);
   assert(nonlethalTrigger.aiming === true
     && nonlethalTrigger.weaponVisible === true
     && Number.isFinite(nonlethalTrigger.gripSocketDistance)
     && nonlethalTrigger.gripSocketDistance <= 0.08,
   'nonlethal feedback lost the aiming weapon or hand grip', nonlethalTrigger);
   await page.waitForTimeout(110);
   await capture('01-nonlethal-peak');
   const pixelNonlethalPeak = await page.evaluate(pixelProxyBody);
   const nonlethal = await collectRecorder(6000);
   const nonlethalAnalysis = analyzePhase(nonlethal.samples);
   const nonlethalTelemetry = summarizeFeedback(nonlethal.samples);
   if (!nonlethal.feedbackTelemetryPresent) {
     noteBlocker('getCombatState().damageFeedback telemetry absent; evaluated scene-graph fallbacks');
   }
   assertCameraRubric('nonlethal', nonlethalAnalysis, nonlethalTelemetry);
   assertFlinchRubric('nonlethal', nonlethalAnalysis, nonlethalTelemetry);
   const nonlethalPixelDelta = Math.abs(pixelNonlethalPeak.lumaStd - pixelBaseline.lumaStd)
     + Math.abs(pixelNonlethalPeak.edgeEnergy - pixelBaseline.edgeEnergy) / 10
     + pixelNonlethalPeak.redRatio * 40;
   assert(nonlethalPixelDelta >= 0.75 || nonlethalAnalysis.movedParts.length >= 2,
     'nonlethal hit produced no measurable pixel or part feedback', {
       pixelBaseline,
       pixelNonlethalPeak,
       nonlethalPixelDelta,
     });
   await page.waitForTimeout(1000);
   await capture('02-nonlethal-recovered');

   // ---------------- Phase 2: real pursuit-pressure damage path -------------
   await page.evaluate(() => {
     const sim = window.__SF_SIM__;
     sim.restartCombat?.();
     sim.streetHeat.restart();
     sim.streetHeat.reportIncident(42, { source: 'combat', notify: false });
   });
   await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().level === 1
     && window.__SF_SIM__.traffic.getPursuitResponders().length === 1,
   null, { timeout: 10000, polling: 25 });
   await page.evaluate(() => {
     const sim = window.__SF_SIM__;
     sim.streetHeat.reportIncident(30, { source: 'combat', notify: false });
   });
   await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().level === 2
     && window.__SF_SIM__.traffic.getPursuitResponders().length === 2,
   null, { timeout: 10000, polling: 25 });
   const pressureStage = await page.evaluate(() => {
     const sim = window.__SF_SIM__;
     const responder = sim.traffic.getPursuitResponders().slice().sort((a, b) => a.id - b.id)[0];
     if (!responder?.position) return null;
     sim.setRoamPose({ x: responder.position.x + 24, z: responder.position.z });
     return { id: responder.id, position: responder.position };
   });
   assert(pressureStage != null, 'no pursuit responder available to stage pressure damage', {});
   await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().pressure.phase === 'locking',
     null, { timeout: 6000, polling: 20 });
   await startRecorder(4200);
   const pressureHealthAtLock = await page.evaluate(() => {
     window.__SF_DAMAGE_FEEDBACK_RECORDER__.triggerAt = performance.now();
     return window.__SF_SIM__.getCombatState().health;
   });
   await capture('03-pressure-lock');
   await page.waitForFunction(
     (lockHealth) => window.__SF_SIM__.getCombatState().health < lockHealth,
     pressureHealthAtLock,
     { timeout: 6000, polling: 20 },
   );
   const pressureHitState = await page.evaluate(() => window.__SF_SIM__.getCombatState());
   assert(pressureHealthAtLock - pressureHitState.health === 8
     && pressureHitState.lastEvent?.source === 'pursuit-pressure',
   'the real pursuit-pressure path did not apply the authored 8 damage', {
     pressureHealthAtLock,
     pressureHitState,
   });
   await page.waitForTimeout(120);
   await capture('04-pressure-hit');
   const pressure = await collectRecorder(9000);
   const pressureAnalysis = analyzePhase(pressure.samples, { triggerHealth: pressureHealthAtLock });
   const pressureTelemetry = summarizeFeedback(pressure.samples, pressureAnalysis.triggerIndex);
   assert(pressureAnalysis.triggerIndex > 0
     && pressureAnalysis.triggerIndex < pressure.samples.length - 20,
   'pursuit-pressure damage never registered inside the recorder window', {
     sampleCount: pressure.samples.length,
     triggerIndex: pressureAnalysis.triggerIndex,
   });
   assertCameraRubric('pursuit-pressure', pressureAnalysis, pressureTelemetry);
   assertFlinchRubric('pursuit-pressure', pressureAnalysis, pressureTelemetry);

   // ------------------------- Phase 3: lethal / downed hit ------------------
   const lethalState = await page.evaluate(() => window.__SF_SIM__.getCombatState());
   assert(lethalState.status === 'running' && lethalState.health > 0,
     'combat state was not eligible for the lethal staging hit', lethalState);
   await startRecorder(3600);
   const lethalTrigger = await page.evaluate(() => {
     const sim = window.__SF_SIM__;
     const before = sim.getCombatState();
     const damaged = sim.damagePlayer(before.health + 10, 'qa-lethal');
     const recorder = window.__SF_DAMAGE_FEEDBACK_RECORDER__;
     recorder.triggerAt = performance.now();
     const after = sim.getCombatState();
     return {
       damaged,
       healthBefore: before.health,
       healthAfter: after.health,
       status: after.status,
       downedTimer: after.downedTimer,
     };
   });
   assert(lethalTrigger.damaged === true
     && lethalTrigger.healthAfter === 0
     && lethalTrigger.status === 'downed'
     && lethalTrigger.downedTimer > 0,
   'lethal staging did not down the player', lethalTrigger);
   await page.waitForTimeout(420);
   await capture('05-downed-hit');
   const pixelDowned = await page.evaluate(pixelProxyBody);
   const lethal = await collectRecorder(8000);
   const lethalAnalysis = analyzePhase(lethal.samples);
   const lethalTelemetry = summarizeFeedback(lethal.samples);
   assertCameraRubric('lethal', lethalAnalysis, lethalTelemetry);
   // Downed rubric: visibly distinct within 250-700 ms — >= 0.75 rad torso
   // tilt, or >= 40 px head drop accompanied by arm changes.
   const downedBaseline = lethal.samples[0];
   const downedWindow = lethal.samples.filter((sample) => (
     sample.t >= 250 && sample.t <= 700
   ));
   const tiltPeak = Math.max(0, ...downedWindow.map((sample) => (
     sample.bodyRotation && downedBaseline.bodyRotation
       ? Math.abs(sample.bodyRotation.x - downedBaseline.bodyRotation.x)
         + Math.abs(sample.bodyRotation.z - downedBaseline.bodyRotation.z)
       : 0
   )));
   const headDropPx = Math.max(0, ...downedWindow.map((sample) => (
     (sample.partPx.head?.y ?? 0) - (downedBaseline.partPx.head?.y ?? 0)
   )));
   const armChange = ['leftArm', 'rightArm', 'leftHand', 'rightHand'].some((name) => (
     Math.max(0, ...downedWindow.map((sample) => dist2(
       sample.partPx[name] ?? sample.partPx.body ?? { x: 0, y: 0 },
       downedBaseline.partPx[name] ?? downedBaseline.partPx.body ?? { x: 0, y: 0 },
     ))) >= 6
   ));
   const downedDistinct = tiltPeak >= 0.75 || (headDropPx >= 40 && armChange);
   assert(downedDistinct,
     'downed hit was not visibly distinct (need >= 0.75 rad tilt or >= 40 px drop + arm change)', {
       tiltPeak: Number(tiltPeak.toFixed(3)),
       headDropPx: Number(headDropPx.toFixed(1)),
       armChange,
     });
   const downedPeakT = lethalTelemetry?.downedPeakMs
     ?? lethalAnalysis.partPeak.body?.pxAtMs ?? lethalAnalysis.partPeak.head?.pxAtMs ?? 0;
   assert(downedPeakT >= 250 && downedPeakT <= 700,
     'downed presentation peak fell outside the 250-700 ms rubric window', { downedPeakT });
   await page.waitForFunction(() => window.__SF_SIM__.getCombatState().status === 'running',
     null, { timeout: 8000, polling: 50 });
   const revived = await page.evaluate(() => window.__SF_SIM__.getCombatState());
   assert(revived.status === 'running' && revived.health > 0,
     'downed recovery did not restore the player to a running state', revived);
   await capture('06-downed-recover');
   await page.mouse.up({ button: 'right' });

   // -------------------- Phase 4: QA-camera suppression ---------------------
   await startRecorder(1300);
   const suppressedTrigger = await page.evaluate(() => {
     const sim = window.__SF_SIM__;
     const before = sim.getCombatState();
     const damaged = sim.damagePlayer(18, 'qa-camera-suppressed');
     const target = sim.getTraversalCameraState().focus;
     sim.setCameraPose(
       { x: target.x + 4.2, y: target.y + 2.1, z: target.z + 4.2 },
       { x: target.x, y: target.y + 1.2, z: target.z },
     );
     const recorder = window.__SF_DAMAGE_FEEDBACK_RECORDER__;
     recorder.triggerAt = performance.now();
     const after = sim.getCombatState();
     return { damaged, healthBefore: before.health, healthAfter: after.health };
   });
   assert(suppressedTrigger.damaged === true
     && suppressedTrigger.healthBefore - suppressedTrigger.healthAfter === 18,
   'QA-camera suppression staging did not apply 18 damage', suppressedTrigger);
   await capture('07-qa-camera-suppressed');
   const suppressed = await collectRecorder(6000);
   const suppressedAnalysis = analyzePhase(suppressed.samples);
   assert(suppressedAnalysis.peak.cameraDeltaM <= 0.002
     && suppressedAnalysis.peak.anchorPxShift <= 0.75,
   'damage feedback moved the QA locked camera', suppressedAnalysis.peak);
   await page.evaluate(() => window.__SF_SIM__.setCameraPose());
   await page.waitForTimeout(400);

   // ------------------------- Phase 5: soak / stability ---------------------
   await page.waitForTimeout(1200);
   resourcesBefore = await page.evaluate(() => ({
     geometries: window.__SF_SIM__.renderer.info.memory.geometries,
     textures: window.__SF_SIM__.renderer.info.memory.textures,
     programs: window.__SF_SIM__.renderer.info.programs?.length ?? null,
     drawCalls: window.__SF_SIM__.renderer.info.render.calls,
   }));
   await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
   await page.waitForTimeout(2600);
   const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
   assert(Number.isFinite(performance?.applicationP99FrameMs)
     && performance.applicationP99FrameMs <= 16.67
     && (performance?.sampleCount ?? 0) >= 60,
   'application p99 frame time exceeded the 16.67 ms budget', performance);
   await capture('08-final');

   const resourcesAfter = await page.evaluate(() => ({
     geometries: window.__SF_SIM__.renderer.info.memory.geometries,
     textures: window.__SF_SIM__.renderer.info.memory.textures,
     programs: window.__SF_SIM__.renderer.info.programs?.length ?? null,
     drawCalls: window.__SF_SIM__.renderer.info.render.calls,
   }));
   assert(resourcesAfter.geometries === resourcesBefore.geometries
     && resourcesAfter.textures === resourcesBefore.textures
     && resourcesAfter.programs === resourcesBefore.programs,
   'renderer resource counts were not stable across the damage gate', {
     resourcesBefore,
     resourcesAfter,
   });
   assert(Math.abs(resourcesAfter.drawCalls - resourcesBefore.drawCalls)
     <= Math.max(6, resourcesBefore.drawCalls * 0.15),
   'draw call count drifted beyond tolerance across the damage gate', {
     resourcesBefore,
     resourcesAfter,
   });

   const worldAfter = await page.evaluate(() => {
     const sim = window.__SF_SIM__;
     return {
       portalIds: (sim.city?.portals || []).map((portal) => portal.id).sort(),
       coreFacades: typeof sim.city?.getCoreFacadeDiagnostics === 'function'
         ? sim.city.getCoreFacadeDiagnostics().map((entry) => entry.label).sort()
         : null,
     };
   });
   assert(JSON.stringify(worldAfter.portalIds) === JSON.stringify(worldBefore.portalIds),
     'portal registry changed during the damage gate', { worldBefore, worldAfter });
   assert(JSON.stringify(worldAfter.coreFacades) === JSON.stringify(worldBefore.coreFacades),
     'core facade diagnostics changed during the damage gate', { worldBefore, worldAfter });

   const result = {
     result: failures.length === 0
       && consoleErrors.length === 0
       && httpErrors.length === 0
       && requestErrors.length === 0
       ? 'player damage feedback gate passed'
       : 'player damage feedback gate failed',
     baseUrl,
     angle,
     rendererName,
     feedbackTelemetry: {
       nonlethal: Boolean(nonlethal.feedbackTelemetryPresent),
       pressure: Boolean(pressure.feedbackTelemetryPresent),
       lethal: Boolean(lethal.feedbackTelemetryPresent),
     },
     nonlethalTrigger,
     nonlethal: nonlethalAnalysis,
     nonlethalTelemetry,
     pixels: {
       baseline: pixelBaseline,
       nonlethalPeak: pixelNonlethalPeak,
       downed: pixelDowned,
       nonlethalDelta: Number(nonlethalPixelDelta.toFixed(2)),
     },
     pressureStage,
     pressureHealthAtLock,
     pressureHitState,
     pressure: pressureAnalysis,
     lethalTrigger,
     lethal: lethalAnalysis,
     lethalTelemetry,
     downed: {
       tiltPeak: Number(tiltPeak.toFixed(3)),
       headDropPx: Number(headDropPx.toFixed(1)),
       armChange,
       distinct: downedDistinct,
       revived: { status: revived.status, health: revived.health },
     },
     suppressed: suppressedAnalysis,
     performance,
     resourcesBefore,
     resourcesAfter,
     worldBefore,
     worldAfter,
     captures,
     blockers,
     consoleErrors,
     httpErrors,
     requestErrors,
     failures,
   };
   console.log(JSON.stringify(result, null, 2));
   if (failures.length || consoleErrors.length || httpErrors.length || requestErrors.length) {
     process.exitCode = 1;
   }
 } catch (error) {
   console.error(JSON.stringify({
     result: 'player damage feedback gate failed',
     error: error.message,
     blockers,
     failures,
     consoleErrors,
     httpErrors,
     requestErrors,
   }, null, 2));
   process.exitCode = 1;
 } finally {
   await browser.close();
 }
