import { access, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const outputDir = process.env.SF_CONTEXTUAL_HUD_DIR || '.qa-contextual-hud';
const viewport = { width: 1280, height: 720 };
const maximumOpaqueRatio = 0.12;

if (process.platform !== 'darwin') {
  throw new Error('verify-contextual-hud requires macOS so Apple Metal can be verified.');
}
if (angle !== 'metal') {
  throw new Error(`verify-contextual-hud requires SF_QA_ANGLE=metal, received ${angle}`);
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
const consoleErrors = [];
const httpErrors = [];
const requestErrors = [];
const captures = [];
const performanceByMode = {};

const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
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

async function launch() {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-hud="san-francisco"]');
    return root?.dataset?.readable === 'true' && root.dataset.contextMode === 'walk';
  }, null, { timeout: 10000, polling: 25 });
  await page.waitForTimeout(500);
  await page.locator('#scene-canvas').focus();
}

async function waitForContext(mode) {
  await page.waitForFunction((expected) => (
    document.querySelector('[data-hud="san-francisco"]')?.dataset?.contextMode === expected
  ), mode, { timeout: 5000, polling: 20 });
  await page.waitForTimeout(180);
}

async function readHudEvidence(mode) {
  return page.evaluate(({ expectedMode, maxOpaqueRatio }) => {
    const root = document.querySelector('[data-hud="san-francisco"]');
    const combatOverlay = document.querySelector('.combat-overlay');
    const width = window.innerWidth;
    const height = window.innerHeight;
    const viewportArea = width * height;
    const visible = (element) => {
      if (!element || element.hidden) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) > 0.02
        && rect.width > 0.5
        && rect.height > 0.5;
    };
    const colorAlpha = (color) => {
      const match = String(color || '').match(/rgba?\([^,]+,[^,]+,[^,]+(?:,\s*([\d.]+))?\)/i);
      if (!match) return color === 'transparent' ? 0 : 1;
      return match[1] === undefined ? 1 : Number(match[1]);
    };
    const clips = [];
    const surfaceDetails = [];
    const candidates = [
      ...root?.querySelectorAll('*') || [],
      ...combatOverlay?.querySelectorAll('*') || [],
    ];
    for (const element of candidates) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element);
      const surface = colorAlpha(style.backgroundColor) >= 0.08
        || style.backgroundImage !== 'none'
        || style.boxShadow !== 'none'
        || (style.backdropFilter && style.backdropFilter !== 'none');
      if (!surface) continue;
      const bounds = element.getBoundingClientRect();
      const rect = {
        left: Math.max(0, bounds.left),
        top: Math.max(0, bounds.top),
        right: Math.min(width, bounds.right),
        bottom: Math.min(height, bounds.bottom),
      };
      if (rect.right <= rect.left || rect.bottom <= rect.top) continue;
      clips.push(rect);
      surfaceDetails.push({
        selector: element.className
          ? `.${String(element.className).trim().replace(/\s+/g, '.')}`
          : element.tagName.toLowerCase(),
        rect,
        outOfBounds: bounds.left < -2
          || bounds.top < -2
          || bounds.right > width + 2
          || bounds.bottom > height + 2,
      });
    }
    const xs = [...new Set(clips.flatMap((rect) => [rect.left, rect.right]))]
      .sort((left, right) => left - right);
    let opaqueArea = 0;
    for (let index = 1; index < xs.length; index += 1) {
      const left = xs[index - 1];
      const right = xs[index];
      if (right <= left) continue;
      const intervals = clips
        .filter((rect) => rect.left < right && rect.right > left)
        .map((rect) => [rect.top, rect.bottom])
        .sort((a, b) => a[0] - b[0]);
      let coveredY = 0;
      let start = null;
      let end = null;
      for (const interval of intervals) {
        if (start === null) {
          [start, end] = interval;
        } else if (interval[0] <= end) {
          end = Math.max(end, interval[1]);
        } else {
          coveredY += end - start;
          [start, end] = interval;
        }
      }
      if (start !== null) coveredY += end - start;
      opaqueArea += (right - left) * coveredY;
    }
    const moduleSelectors = [
      '.hud__header',
      '.hud__mission',
      '.hud__telemetry',
      '.hud__state',
      '.hud__interaction',
      '.hud__life',
      '.hud__online',
      '.hud__drive',
      '.hud__message',
      '.hud__footer',
      '.combat-overlay',
      '.combat-reticle',
      '.combat-overlay > :nth-child(3)',
    ];
    const modules = Object.fromEntries(moduleSelectors.map((selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect?.();
      return [selector, {
        visible: visible(element),
        hidden: element?.hidden ?? null,
        text: element?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) || '',
        rect: rect ? {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        } : null,
      }];
    }));
    const centerBlockers = surfaceDetails.filter(({ rect }) => (
      rect.left <= width / 2 && rect.right >= width / 2
      && rect.top <= height / 2 && rect.bottom >= height / 2
    ));
    return {
      expectedMode,
      contextMode: root?.dataset?.contextMode ?? null,
      readable: root?.dataset?.readable ?? null,
      className: root?.className ?? null,
      cameraMode: root?.dataset?.cameraMode ?? null,
      messageState: root?.dataset?.message ?? null,
      opaqueArea,
      opaqueRatio: viewportArea > 0 ? opaqueArea / viewportArea : 1,
      maximumOpaqueRatio: maxOpaqueRatio,
      surfaceCount: surfaceDetails.length,
      outOfBounds: surfaceDetails.filter((surface) => surface.outOfBounds),
      centerBlockers,
      modules,
      scroll: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        viewportWidth: width,
        viewportHeight: height,
      },
    };
  }, { expectedMode: mode, maxOpaqueRatio: maximumOpaqueRatio });
}

function verifyCommon(mode, evidence) {
  assert(evidence.contextMode === mode,
    `${mode} HUD did not expose its canonical data-context-mode`, evidence);
  assert(evidence.readable === 'true'
    && evidence.className.includes('hud--readable')
    && evidence.className.includes(`hud--context-${mode}`),
  `${mode} HUD did not retain its readable context class contract`, evidence);
  assert(evidence.surfaceCount > 0 && evidence.opaqueRatio <= maximumOpaqueRatio,
    `${mode} persistent opaque HUD area exceeded 12% of the viewport`, evidence);
  assert(evidence.outOfBounds.length === 0
    && evidence.scroll.width <= evidence.scroll.viewportWidth + 2
    && evidence.scroll.height <= evidence.scroll.viewportHeight + 2,
  `${mode} HUD overflowed the viewport`, evidence);
  assert(evidence.modules['.hud__message'].visible === false
    && evidence.messageState === 'hidden',
  `${mode} transient HUD message remained visible after 1.5 seconds`, evidence.modules['.hud__message']);
}

async function captureMode(mode) {
  await waitForContext(mode);
  const evidence = await readHudEvidence(mode);
  verifyCommon(mode, evidence);
  const path = `${outputDir}/${mode}.png`;
  await page.screenshot({ path });
  captures.push(path);
  return evidence;
}

async function samplePerformance(mode) {
  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1300);
  const snapshot = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  performanceByMode[mode] = snapshot;
  assert(Number.isFinite(snapshot?.applicationP99FrameMs)
    && snapshot.applicationP99FrameMs <= 16.67,
  `${mode} HUD exceeded the 16.67ms application p99 frame budget`, snapshot);
}

async function waitForMessageToClear(label) {
  const immediate = await page.evaluate(() => {
    const root = document.querySelector('[data-hud="san-francisco"]');
    const message = document.querySelector('.hud__message');
    return {
      state: root?.dataset?.message ?? null,
      visible: Boolean(message && !message.hidden && getComputedStyle(message).display !== 'none'),
      text: message?.textContent?.replace(/\s+/g, ' ').trim() || '',
    };
  });
  assert(immediate.visible && immediate.text.length > 0,
    `${label} did not expose immediate contextual feedback`, immediate);
  await page.waitForTimeout(1650);
  const cleared = await page.evaluate(() => {
    const root = document.querySelector('[data-hud="san-francisco"]');
    const message = document.querySelector('.hud__message');
    return {
      state: root?.dataset?.message ?? null,
      visible: Boolean(message && !message.hidden && getComputedStyle(message).display !== 'none'),
      text: message?.textContent?.replace(/\s+/g, ' ').trim() || '',
    };
  });
  assert(cleared.visible === false && cleared.state === 'hidden',
    `${label} contextual feedback did not clear within 1.5 seconds`, { immediate, cleared });
  return { immediate, cleared };
}

try {
  await launch();

  const renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string'
    && /apple.*metal|metal/i.test(renderer)
    && !/(swiftshader|software|llvmpipe)/i.test(renderer),
  'a verified Apple Metal hardware renderer was required; software rendering is rejected', {
    angle,
    renderer,
  });

  const walkStart = await page.evaluate(() => window.__SF_SIM__.getRoamState().target);
  await page.keyboard.down('w');
  await page.waitForTimeout(520);
  await page.keyboard.up('w');
  const walkEnd = await page.evaluate(() => window.__SF_SIM__.getRoamState().target);
  const walkDistance = Math.hypot(walkEnd.x - walkStart.x, walkEnd.z - walkStart.z);
  assert(walkDistance >= 1.4,
    'real W input did not produce a normal traversal state', { walkStart, walkEnd, walkDistance });
  await page.waitForTimeout(1650);
  const walk = await captureMode('walk');
  assert(walk.modules['.hud__mission'].visible
    && walk.modules['.hud__life'].visible
    && !walk.modules['.hud__drive'].visible
    && !walk.modules['.combat-overlay'].visible,
  'walk context did not retain mission/life while suppressing drive/combat chrome', walk.modules);
  await samplePerformance('walk');

  const parked = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles.find((candidate) => (
      candidate.class !== 'bike'
      && candidate.identity?.category === 'private'
      && candidate.action?.key === 'parked'
      && candidate.damage?.disabled !== true
    ));
    if (!vehicle?.position) return null;
    sim.setRoamPose(vehicle.position);
    return vehicle;
  });
  assert(parked?.id >= 0, 'no parked private vehicle was available for real E/W input', parked);
  if (!parked?.position) throw new Error('contextual HUD vehicle staging failed');
  await page.waitForTimeout(900);
  await page.locator('#scene-canvas').focus();
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === true,
    null, { timeout: 4000, polling: 20 });
  const driveMessage = await waitForMessageToClear('vehicle entry');
  const publicRoadStage = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.exportPlayerVehicleState?.();
    if (!snapshot || snapshot.mode !== 'driving') return false;
    snapshot.position = { x: 28, z: 38 };
    snapshot.heading = 0;
    return sim.traffic.importPlayerVehicleState?.(snapshot) === true;
  });
  assert(publicRoadStage, 'player vehicle could not be staged on the public road after real entry');
  await page.keyboard.down('w');
  try {
    await page.waitForFunction(() => (
      (window.__SF_SIM__?.traffic?.getPlayerVehicleState?.()?.speed ?? 0) >= 1.2
    ), null, { timeout: 8000, polling: 20 });
  } finally {
    await page.keyboard.up('w').catch(() => {});
  }
  const drive = await captureMode('drive');
  assert(drive.modules['.hud__drive'].visible
    && /DRIVE|VEHICLE/.test(drive.modules['.hud__drive'].text)
    && !drive.modules['.hud__life'].visible
    && !drive.modules['.hud__mission'].visible
    && !drive.modules['.combat-overlay'].visible,
  'drive context did not isolate the live vehicle readout', drive.modules);
  await samplePerformance('drive');

  await page.keyboard.down('s');
  try {
    await page.waitForFunction(() => (
      (window.__SF_SIM__?.traffic?.getPlayerVehicleState?.()?.speed ?? 1) <= 0.35
    ), null, { timeout: 6000, polling: 20 });
  } finally {
    await page.keyboard.up('s').catch(() => {});
  }
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === false,
    null, { timeout: 4000, polling: 20 });
  await page.waitForTimeout(1700);

  const canvas = await page.locator('#scene-canvas').boundingBox();
  if (!canvas) throw new Error('scene canvas bounds unavailable for real combat input');
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  const combatBefore = await page.evaluate(() => window.__SF_SIM__.getCombatState());
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.().aiming === true,
    null, { timeout: 3000, polling: 20 });
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.waitForFunction((shots) => window.__SF_SIM__?.getCombatState?.().shots === shots + 1,
    combatBefore.shots, { timeout: 3000, polling: 20 });
  const combatAfterInput = await page.evaluate(() => window.__SF_SIM__.getCombatState());
  assert(combatAfterInput.shots === combatBefore.shots + 1
    && combatAfterInput.ammo === combatBefore.ammo - 1,
  'real combat input did not update the contextual ammo/readout state exactly once', {
    before: combatBefore,
    after: combatAfterInput,
  });
  // A clear shot uses the dedicated reticle/ammo overlay and intentionally
  // does not create a generic toast. Hold aim long enough to prove that no
  // stale drive/exit message leaks into the persistent combat context.
  await page.waitForTimeout(1650);
  const combat = await captureMode('combat');
  const reticle = combat.modules['.combat-reticle'];
  const combatReadout = combat.modules['.combat-overlay > :nth-child(3)'];
  assert(combat.modules['.combat-overlay'].visible
    && combatReadout.visible
    && combatReadout.text.includes(`AMMO / ${combatAfterInput.ammo}`)
    && reticle.visible
    && Math.abs((reticle.rect.left + reticle.rect.right) / 2 - viewport.width / 2) <= 2
    && Math.abs((reticle.rect.top + reticle.rect.bottom) / 2 - viewport.height / 2) <= 2
    && !combat.modules['.hud__drive'].visible
    && !combat.modules['.hud__mission'].visible
    && !combat.modules['.hud__life'].visible
    && !combat.modules['.hud__interaction'].visible,
  'combat context did not isolate the centered reticle/action readout', combat.modules);
  await samplePerformance('combat');
  await page.mouse.up({ button: 'right' });
  await waitForContext('walk');

  const portal = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const candidate = sim.city.portals.find((entry) => (
      entry?.position && /welcome center/i.test(String(entry.label || ''))
    )) || sim.city.portals.find((entry) => entry?.position && entry?.room);
    if (!candidate?.position) return null;
    sim.setRoamPose(candidate.position);
    return { id: candidate.id, label: candidate.label, position: candidate.position };
  });
  assert(portal?.position, 'no featured interior portal was available for real E input', portal);
  if (!portal?.position) throw new Error('contextual HUD interior staging failed');
  await page.waitForTimeout(160);
  await page.locator('#scene-canvas').focus();
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__?.getInteractionState?.().mode === 'interior',
    null, { timeout: 5000, polling: 20 });
  await page.waitForTimeout(1650);
  const interior = await captureMode('interior');
  assert(interior.cameraMode === 'interior'
    && interior.modules['.hud__header'].visible
    && interior.modules['.hud__interaction'].visible
    && !interior.modules['.hud__drive'].visible
    && !interior.modules['.combat-overlay'].visible
    && !interior.modules['.hud__online'].visible,
  'interior context did not retain only room/interaction chrome', interior.modules);
  await samplePerformance('interior');

  assert(consoleErrors.length === 0, 'page/console errors occurred', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors occurred', httpErrors);
  assert(requestErrors.length === 0, 'request failures occurred', requestErrors);

  const report = {
    pass: failures.length === 0
      && consoleErrors.length === 0
      && httpErrors.length === 0
      && requestErrors.length === 0,
    baseUrl,
    angle,
    renderer,
    walk: { distance: walkDistance, evidence: walk },
    drive: { message: driveMessage, evidence: drive },
    combat: { before: combatBefore, after: combatAfterInput, evidence: combat },
    interior: { portal, evidence: interior },
    performanceByMode,
    captures,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'contextual HUD gate failed',
    error: error.message,
    stack: error.stack,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await page.keyboard.up('w').catch(() => {});
  await page.keyboard.up('s').catch(() => {});
  await page.mouse.up({ button: 'left' }).catch(() => {});
  await page.mouse.up({ button: 'right' }).catch(() => {});
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
