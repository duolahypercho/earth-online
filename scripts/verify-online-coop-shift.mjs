import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const relayPort = Number(process.env.SF_RELAY_PORT) || 8802;
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const relay = spawn(process.execPath, ['server/multiplayer-server.mjs'], {
  env: { ...process.env, PORT: String(relayPort) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let relayReady = false;
relay.stdout.on('data', (chunk) => {
  if (String(chunk).includes('listening')) relayReady = true;
});
await new Promise((resolve) => setTimeout(resolve, 500));

const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${angle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
  ],
  ...(executablePath ? { executablePath } : {}),
});
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};

async function launchPlayer(page, name) {
  const url = new URL(baseUrl);
  url.searchParams.set('net', `ws://localhost:${relayPort}`);
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#player-name').fill(name);
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(350);
}

async function receiverSnapshot(page) {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      life: sim.lifeSim.getState(),
      mission: sim.cityShift.getState(),
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      driving: sim.isDriving(),
      vehicle: sim.traffic.getPlayerVehicleState(),
      saved: sim.getSavedProgress(),
      peers: sim.networking.getPeers(),
      coopRows: [...document.querySelectorAll('.hud__player[data-coop-shift="true"]')]
        .map((node) => node.textContent),
    };
  });
}

let pageA;
let pageB;
try {
  if (!relayReady) await new Promise((resolve) => setTimeout(resolve, 700));
  const contextA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const contextB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    page.on('pageerror', (error) => consoleErrors.push(`${label}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('/favicon.ico')) {
        consoleErrors.push(`${label}: ${message.text()}`);
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
        httpErrors.push(`${label}: ${response.status()} ${response.url()}`);
      }
    });
  }

  await launchPlayer(pageA, 'Shift A');
  await launchPlayer(pageB, 'Shift B');
  await pageB.waitForFunction(() => window.__SF_SIM__.networking
    ?.getPeers().some((peer) => peer.name === 'Shift A'), null, { timeout: 15000 });
  const renderer = await pageB.evaluate(() => {
    const gl = window.__SF_SIM__.renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  if (angle === 'metal') {
    assert(/metal/i.test(renderer), 'Metal renderer was not active', renderer);
  }
  await pageB.evaluate(() => window.__SF_SIM__.saveProgress());
  const receiverBefore = await receiverSnapshot(pageB);

  const firstPortal = await pageA.evaluate(() => {
    const portal = window.__SF_SIM__.cityShift.steps[0].portal;
    return { x: portal.position.x, z: portal.position.z };
  });
  await pageA.evaluate((position) => window.__SF_SIM__.setRoamPose(position), firstPortal);
  await pageA.keyboard.press('e');
  await pageA.waitForFunction(() => window.__SF_SIM__.cityShift.getState().completedSteps === 1,
    null, { timeout: 5000, polling: 25 });
  await pageB.waitForFunction(() => window.__SF_SIM__.networking.getPeers()
    .find((peer) => peer.name === 'Shift A')?.mission?.completedSteps === 1,
  null, { timeout: 5000, polling: 25 });
  const firstReceived = await receiverSnapshot(pageB);
  assert(firstReceived.peers.find((peer) => peer.name === 'Shift A')?.mission?.status === 'running'
    && firstReceived.coopRows.some((row) => row.includes('CO-OP SHIFT · 1/6')),
  'first real E objective did not produce the co-op Shift readout', firstReceived);
  await pageA.waitForTimeout(900);

  const ferryPortal = await pageA.evaluate(() => {
    const sim = window.__SF_SIM__;
    for (const step of sim.cityShift.steps.slice(1, 4)) {
      sim.cityShift.onHotspotUsed({ id: step.hotspotId });
    }
    const portal = sim.cityShift.steps[4].portal;
    return {
      completedSteps: sim.cityShift.getState().completedSteps,
      position: { x: portal.position.x, z: portal.position.z },
    };
  });
  assert(ferryPortal.completedSteps === 4,
    'production mission handlers did not stage the second real portal objective', ferryPortal);
  await pageA.evaluate((position) => window.__SF_SIM__.setRoamPose(position), ferryPortal.position);
  await pageA.keyboard.press('e');
  await pageA.waitForFunction(() => window.__SF_SIM__.cityShift.getState().completedSteps === 5,
    null, { timeout: 5000, polling: 25 });
  await pageB.waitForFunction(() => window.__SF_SIM__.networking.getPeers()
    .find((peer) => peer.name === 'Shift A')?.mission?.completedSteps === 5,
  null, { timeout: 5000, polling: 25 });
  const secondReceived = await receiverSnapshot(pageB);
  const remoteMission = secondReceived.peers.find((peer) => peer.name === 'Shift A')?.mission;
  assert(remoteMission?.completedSteps === 5
    && remoteMission.totalSteps === 6
    && remoteMission.revision > firstReceived.peers.find((peer) => peer.name === 'Shift A')?.mission?.revision
    && secondReceived.coopRows.some((row) => row.includes('CO-OP SHIFT · 5/6')),
  'second real E objective did not advance the monotonic co-op Shift readout', {
    firstReceived,
    secondReceived,
  });

  const receiverAfter = await receiverSnapshot(pageB);
  assert(receiverAfter.life.cash === receiverBefore.life.cash
    && receiverAfter.life.legalDebt === receiverBefore.life.legalDebt
    && receiverAfter.life.lastTransaction?.at === receiverBefore.life.lastTransaction?.at
    && receiverAfter.mission.status === receiverBefore.mission.status
    && receiverAfter.mission.completedSteps === receiverBefore.mission.completedSteps
    && receiverAfter.combat.health === receiverBefore.combat.health
    && receiverAfter.combat.ammo === receiverBefore.combat.ammo
    && receiverAfter.heat.heat === receiverBefore.heat.heat
    && receiverAfter.heat.pursuitActive === receiverBefore.heat.pursuitActive
    && receiverAfter.driving === receiverBefore.driving
    && receiverAfter.vehicle === receiverBefore.vehicle
    && receiverAfter.saved.snapshot?.life?.cash === receiverBefore.saved.snapshot?.life?.cash
    && receiverAfter.saved.snapshot?.cityShift?.stepIndex === receiverBefore.saved.snapshot?.cityShift?.stepIndex,
  'remote mission presence mutated receiver gameplay, payout, or persistence', {
    receiverBefore,
    receiverAfter,
  });

  const rawPeer = new WebSocket(`ws://localhost:${relayPort}`);
  await new Promise((resolve, reject) => {
    rawPeer.once('open', resolve);
    rawPeer.once('error', reject);
  });
  rawPeer.send(JSON.stringify({ type: 'join', name: 'Mission Probe', color: 2 }));
  rawPeer.send(JSON.stringify({
    type: 'state',
    x: 0,
    y: 0,
    z: 0,
    mission: {
      revision: 12,
      status: 'running',
      completedSteps: 3,
      totalSteps: 6,
      objective: 'Validated objective',
    },
  }));
  await pageB.waitForFunction(() => window.__SF_SIM__.networking.getPeers()
    .find((peer) => peer.name === 'Mission Probe')?.mission?.revision === 12,
  null, { timeout: 5000, polling: 25 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  rawPeer.send(JSON.stringify({
    type: 'state',
    mission: {
      revision: 12,
      status: 'failed',
      completedSteps: 0,
      totalSteps: 6,
      objective: 'Duplicate revision mutation',
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  rawPeer.send(JSON.stringify({
    type: 'state',
    mission: {
      revision: 11,
      status: 'running',
      completedSteps: 1,
      totalSteps: 6,
      objective: 'Stale objective',
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  rawPeer.send(JSON.stringify({
    type: 'state',
    mission: {
      revision: 13,
      status: 'admin',
      completedSteps: 99,
      totalSteps: 6,
      objective: 'Invalid objective',
    },
  }));
  await pageB.waitForTimeout(180);
  const sanitized = await pageB.evaluate(() => window.__SF_SIM__.networking.getPeers()
    .find((peer) => peer.name === 'Mission Probe'));
  assert(sanitized?.mission?.revision === 12
    && sanitized?.mission?.completedSteps === 3
    && sanitized?.mission?.objective === 'Validated objective',
  'relay/client accepted stale or malformed remote mission authority', sanitized);
  await new Promise((resolve) => setTimeout(resolve, 60));
  rawPeer.send(JSON.stringify({ type: 'state', mission: null }));
  await pageB.waitForFunction(() => window.__SF_SIM__.networking.getPeers()
    .find((peer) => peer.name === 'Mission Probe')?.mission == null,
  null, { timeout: 5000, polling: 25 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  rawPeer.send(JSON.stringify({
    type: 'state',
    mission: {
      revision: 11,
      status: 'running',
      completedSteps: 1,
      totalSteps: 6,
      objective: 'Stale post-tombstone objective',
    },
  }));
  await pageB.waitForTimeout(180);
  const tombstoneHeld = await pageB.evaluate(() => window.__SF_SIM__.networking.getPeers()
    .find((peer) => peer.name === 'Mission Probe'));
  assert(tombstoneHeld?.mission == null,
    'post-tombstone stale revision resurrected remote mission presence', tombstoneHeld);
  rawPeer.close();
  await pageB.waitForFunction(() => !window.__SF_SIM__.networking.getPeers()
    .some((peer) => peer.name === 'Mission Probe'), null, { timeout: 5000 });

  await pageA.evaluate(() => {
    const sim = window.__SF_SIM__;
    const last = sim.cityShift.steps.at(-1);
    sim.cityShift.onPortalEntered(last.portal);
  });
  await pageB.waitForFunction(() => window.__SF_SIM__.networking.getPeers()
    .find((peer) => peer.name === 'Shift A')?.mission?.status === 'complete',
  null, { timeout: 5000, polling: 25 });
  await pageA.locator('.hud__mission-restart').click();
  await pageB.waitForFunction(() => window.__SF_SIM__.networking.getPeers()
    .find((peer) => peer.name === 'Shift A')?.mission == null,
  null, { timeout: 5000, polling: 25 });
  const resetCleared = await receiverSnapshot(pageB);
  assert(!resetCleared.coopRows.some((row) => row.includes('Shift A')),
    'remote Replay did not clear the stale co-op Shift readout', resetCleared);

  await pageA.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.cityShift.onPortalEntered(sim.cityShift.steps[0].portal);
  });
  await pageB.waitForFunction(() => window.__SF_SIM__.networking.getPeers()
    .find((peer) => peer.name === 'Shift A')?.mission?.completedSteps === 1,
  null, { timeout: 5000, polling: 25 });
  await pageB.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await pageB.waitForTimeout(3000);
  const performance = await pageB.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'co-op Shift presence exceeded the application frame budget', performance);

  await pageA.close();
  await pageB.waitForFunction(() => !window.__SF_SIM__.networking.getPeers()
    .some((peer) => peer.name === 'Shift A'), null, { timeout: 8000 });
  const disconnected = await receiverSnapshot(pageB);
  assert(!disconnected.coopRows.some((row) => row.includes('Shift A')),
    'disconnect left stale co-op Shift presence in the HUD', disconnected);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'online co-op Shift presence passed'
      : 'online co-op Shift presence failed',
    baseUrl,
    angle,
    renderer,
    firstReceived,
    secondReceived,
    receiverBefore,
    receiverAfter,
    sanitized,
    tombstoneHeld,
    resetCleared,
    disconnected,
    performance,
    failures,
    consoleErrors,
    httpErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  relay.kill('SIGTERM');
}
