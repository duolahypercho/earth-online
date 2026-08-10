import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  args: ['--disable-dev-shm-usage', `--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const failures = [];
const consoleErrors = [];
const httpErrors = [];
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
    httpErrors.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
  }
});

async function launch() {
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(350);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();

  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  if (angle === 'metal') {
    assert(Boolean(renderer)
      && /metal/i.test(renderer)
      && !/(swiftshader|software)/i.test(renderer),
    'Metal hardware renderer was required but not reported', { angle, renderer });
  }

  const geometryBefore = await page.evaluate(() => {
    const info = window.__SF_SIM__.renderer.info;
    return { geometries: info.memory.geometries, textures: info.memory.textures };
  });

  const result = await page.evaluate(async () => {
    const { createStreetHeat } = await import('/src/gameplay.js');
    const sim = window.__SF_SIM__;
    const events = [];
    const responder = {
      active: true,
      id: 77,
      distance: 4.8,
      position: { x: 4.8, z: 0 },
    };
    const backupResponder = {
      active: true,
      id: 78,
      distance: 12,
      position: { x: 12, z: 0 },
    };
    const options = {
      scene: sim.scene,
      getTrafficSnapshot: () => ({ vehicles: [] }),
      getPursuitResponder: () => responder,
      getPursuitResponders: () => [responder, backupResponder],
      onEvent: (event) => events.push({
        kind: event.kind,
        contactNumber: event.contactNumber ?? null,
      }),
    };
    const driving = {
      driving: true,
      speed: 0,
      position: { x: 0, y: 0, z: 0 },
      playerVehicleId: 1,
    };
    const heat = createStreetHeat(options);
    heat.start();
    heat.reportIncident(36, {
      kind: 'vehicle-theft',
      source: 'vehicle-theft',
      notify: false,
    });
    heat.update(0.016, driving);
    const first = heat.getState();
    heat.update(0.1, driving);
    heat.update(0.1, driving);
    const heldNear = heat.getState();
    const persisted = heat.exportState();
    heat.dispose();

    const restoredEvents = [];
    const restored = createStreetHeat({
      ...options,
      onEvent: (event) => restoredEvents.push({
        kind: event.kind,
        contactNumber: event.contactNumber ?? null,
      }),
    });
    const imported = restored.importState(persisted);
    restored.update(0.016, driving);
    const restoredNear = restored.getState();
    const restoredEventsAfterNear = restoredEvents.length;

    responder.distance = 8.6;
    responder.position.x = 8.6;
    backupResponder.distance = 8.4;
    backupResponder.position.x = 8.4;
    restored.update(0.016, driving);
    const partialSeparation = restored.getState();
    responder.distance = 4.8;
    responder.position.x = 4.8;
    restored.update(0.016, driving);
    const returnedBeforeFullSeparation = restored.getState();
    responder.distance = 8.6;
    responder.position.x = 8.6;
    backupResponder.distance = 9;
    backupResponder.position.x = 9;
    restored.update(0.016, driving);
    const fullSeparation = restored.getState();
    const separatedPersisted = restored.exportState();
    restored.dispose();

    const separatedReloadEvents = [];
    const separatedReload = createStreetHeat({
      ...options,
      onEvent: (event) => separatedReloadEvents.push({
        kind: event.kind,
        contactNumber: event.contactNumber ?? null,
      }),
    });
    const separatedImported = separatedReload.importState(separatedPersisted);
    responder.distance = 4.8;
    responder.position.x = 4.8;
    backupResponder.distance = 12;
    backupResponder.position.x = 12;
    separatedReload.update(0.016, driving);
    const second = separatedReload.getState();
    separatedReload.update(0.1, driving);
    separatedReload.update(0.1, driving);
    const heldAfterSecond = separatedReload.getState();
    separatedReload.dispose();

    const malformed = createStreetHeat(options);
    const malformedAccepted = malformed.importState({
      ...separatedPersisted,
      responderContacts: 0.1,
      responderContactLatched: true,
    });
    const malformedState = malformed.getState();
    malformed.dispose();

    return {
      imported,
      first,
      heldNear,
      persisted,
      restoredNear,
      restoredEventsAfterNear,
      partialSeparation,
      returnedBeforeFullSeparation,
      fullSeparation,
      separatedPersisted,
      separatedImported,
      malformedAccepted,
      malformedState,
      second,
      heldAfterSecond,
      firstContactEvents: events.filter((event) => event.kind === 'responder-contact'),
      restoredContactEvents: restoredEvents.filter((event) => event.kind === 'responder-contact'),
      separatedReloadContactEvents: separatedReloadEvents.filter(
        (event) => event.kind === 'responder-contact',
      ),
    };
  });

  assert(result.first.responderContacts === 1
    && result.firstContactEvents.length === 1
    && result.firstContactEvents[0].contactNumber === 1,
  'first driving contact did not emit exactly once', result);
  assert(result.heldNear.responderContacts === 1
    && result.firstContactEvents.length === 1,
  'remaining inside the contact radius repeated the first hit', result);
  assert(result.imported === true
    && result.persisted.pursuitActive === true
    && result.persisted.responderContacts === 1
    && result.persisted.responderContactLatched === true
    && result.restoredNear.responderContacts === 1
    && result.restoredEventsAfterNear === 0,
  'persisted driving contact latch replayed or failed to restore', result);
  assert(result.partialSeparation.responderContacts === 1
    && result.returnedBeforeFullSeparation.responderContacts === 1
    && result.restoredContactEvents.length === 0,
  'one responder below 8.5 m incorrectly re-armed the contact latch', result);
  assert(result.fullSeparation.responderContacts === 1
    && result.separatedPersisted.responderContactLatched === false
    && result.separatedImported === true
    && result.second.responderContacts === 2
    && result.separatedReloadContactEvents.length === 1
    && result.separatedReloadContactEvents[0].contactNumber === 2,
  'full separation state did not persist and re-arm exactly one driving recontact', result);
  assert(result.heldAfterSecond.responderContacts === 2
    && result.separatedReloadContactEvents.length === 1,
  'remaining near after the second contact caused frame-repeat damage', result);
  assert(result.malformedAccepted === false
    && result.malformedState.status === 'ready'
    && result.malformedState.responderContacts === 0,
  'fractional zero-contact latched snapshot did not reject atomically', result);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1200);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  const geometryAfter = await page.evaluate(() => {
    const info = window.__SF_SIM__.renderer.info;
    return { geometries: info.memory.geometries, textures: info.memory.textures };
  });
  assert(performance.applicationP99FrameMs <= 16.67,
    'application p99 exceeded 16.67 ms', performance);
  assert(geometryAfter.geometries <= geometryBefore.geometries
    && geometryAfter.textures <= geometryBefore.textures,
  'focused pursuit recontact check leaked render resources', { geometryBefore, geometryAfter });

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0,
    angle,
    renderer,
    result,
    geometryBefore,
    geometryAfter,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
