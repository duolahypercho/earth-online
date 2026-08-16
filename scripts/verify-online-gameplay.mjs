import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import WebSocket from 'ws';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const relayPort = Number(process.env.SF_RELAY_PORT) || 8801;
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE
  || (process.platform === 'darwin' ? 'metal' : 'swiftshader');

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
  await page.waitForFunction(
    () => document.querySelector('#launch-button')
      && !document.querySelector('#launch-button').disabled,
    null,
    { timeout: 60000 },
  );
  await page.locator('#player-name').fill(name);
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(350);
}

async function localSnapshot(page) {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const saved = JSON.parse(localStorage.getItem('earth-online-player-progress-v1') || 'null');
    return {
      cash: sim.lifeSim.getState().cash,
      legalDebt: sim.lifeSim.getState().legalDebt,
      lastTransaction: sim.lifeSim.getState().lastTransaction,
      health: sim.combat.getState().health,
      combatStatus: sim.combat.getState().status,
      heat: sim.getStreetHeatState().heat,
      pursuitActive: sim.getStreetHeatState().pursuitActive,
      driving: sim.isDriving(),
      vehicle: sim.traffic.getPlayerVehicleState(),
      saved: saved ? {
        cash: saved.life?.cash,
        legalDebt: saved.life?.legalDebt,
        health: saved.combat?.health,
        heat: saved.streetHeat?.heat,
        pursuitActive: saved.streetHeat?.pursuitActive,
        vehicle: saved.vehicle ?? null,
      } : null,
    };
  });
}

let pageA;
let pageB;
try {
  if (!relayReady) await new Promise((resolve) => setTimeout(resolve, 700));
  // Separate browser contexts are deliberate: sharing one localStorage would
  // let client A's autosave overwrite client B's persistence evidence.
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

  await launchPlayer(pageA, 'Gameplay A');
  await launchPlayer(pageB, 'Gameplay B');
  await pageB.waitForFunction(() => window.__SF_SIM__.networking
    ?.getPeers().some((peer) => peer.name === 'Gameplay A'), null, { timeout: 15000 });

  const renderer = await pageB.evaluate(() => {
    const gl = window.__SF_SIM__.renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  if (angle === 'metal') {
    assert(/metal/i.test(renderer), 'Metal renderer was not active', renderer);
  }

  await pageB.evaluate(() => window.__SF_SIM__.saveProgress());
  const receiverBefore = await localSnapshot(pageB);

  const theftCandidate = await pageA.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.eligible === true
      && vehicle.theft?.reported === false
    )) || null);
  assert(theftCandidate?.id >= 0, 'no real parked private theft candidate was available', theftCandidate);
  if (theftCandidate) {
    await pageA.evaluate((position) => window.__SF_SIM__.setRoamPose(position), theftCandidate.position);
    await pageA.keyboard.press('e');
    await pageA.waitForFunction(() => {
      const sim = window.__SF_SIM__;
      return sim.isDriving()
        && sim.getStreetHeatState()?.lastEvent?.kind === 'vehicle-theft'
        && sim.getStreetHeatState()?.heat === 18;
    }, null, { timeout: 8000 });
    await pageA.keyboard.down('w');
    await pageA.waitForFunction(
      () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 0.5,
      null,
      { timeout: 8000 },
    );
    await pageA.keyboard.up('w');
  }

  await pageB.waitForFunction(() => {
    const peer = window.__SF_SIM__.networking.getPeers()
      .find((entry) => entry.name === 'Gameplay A');
    return peer?.gameplayEventCount === 1
      && peer?.lastGameplayEvent?.kind === 'vehicle-theft'
      && peer?.gameplay?.heat > 0;
  }, null, { timeout: 8000 });

  const received = await pageB.evaluate(() => {
    const peer = window.__SF_SIM__.networking.getPeers()
      .find((entry) => entry.name === 'Gameplay A');
    const roster = [...document.querySelectorAll('.hud__player')]
      .find((node) => node.textContent.includes('Gameplay A'))?.textContent || '';
    const mapNode = [...document.querySelectorAll('.hud__map-remote')]
      .find((node) => node.dataset.wanted === 'true');
    return {
      peer,
      roster,
      mapText: mapNode?.textContent || '',
      chat: document.querySelector('.hud__chat-log')?.textContent || '',
    };
  });
  assert(received.peer?.lastGameplayEvent?.kind === 'vehicle-theft'
    && received.peer?.lastGameplayEvent?.heat === 18
    && received.peer?.gameplayEventCount === 1,
  'receiver did not get exactly one sanitized vehicle-theft incident', received);
  assert(received.roster.includes('HEAT') || received.roster.includes('PURSUIT'),
    'remote wanted state was not visible in the online roster', received);
  assert(received.mapText.startsWith('!'), 'remote wanted state was not visible on the map', received);
  assert(received.chat.includes('Vehicle theft'), 'remote incident did not appear in the HUD event feed', received);

  await pageB.waitForTimeout(900);
  const deduped = await pageB.evaluate(() => window.__SF_SIM__.networking.getPeers()
    .find((entry) => entry.name === 'Gameplay A'));
  assert(deduped?.gameplayEventCount === 1,
    'repeated state packets duplicated the gameplay incident', deduped);

  const receiverAfter = await localSnapshot(pageB);
  assert(receiverAfter.cash === receiverBefore.cash
    && receiverAfter.legalDebt === receiverBefore.legalDebt
    && receiverAfter.health === receiverBefore.health
    && receiverAfter.combatStatus === receiverBefore.combatStatus
    && receiverAfter.heat === receiverBefore.heat
    && receiverAfter.pursuitActive === receiverBefore.pursuitActive
    && receiverAfter.driving === receiverBefore.driving
    && receiverAfter.lastTransaction?.at === receiverBefore.lastTransaction?.at
    && receiverAfter.saved?.cash === receiverBefore.saved?.cash
    && receiverAfter.saved?.legalDebt === receiverBefore.saved?.legalDebt
    && receiverAfter.saved?.health === receiverBefore.saved?.health
    && receiverAfter.saved?.heat === receiverBefore.saved?.heat
    && receiverAfter.saved?.pursuitActive === receiverBefore.saved?.pursuitActive,
  'remote gameplay status mutated receiver gameplay or persistence', { receiverBefore, receiverAfter });

  const rawPeer = new WebSocket(`ws://localhost:${relayPort}`);
  await new Promise((resolve, reject) => {
    rawPeer.once('open', resolve);
    rawPeer.once('error', reject);
  });
  rawPeer.send('null');
  rawPeer.send('[]');
  rawPeer.send('"primitive"');
  rawPeer.send(JSON.stringify({ type: 'join', name: 'Untrusted Peer', color: 99 }));
  const oversizedEvent = {
    id: 'event-id-that-is-deliberately-longer-than-forty-eight-characters',
    kind: 'vehicle-theft',
    message: 'untrusted '.repeat(30),
    heat: 999,
    wantedLevel: 99,
  };
  rawPeer.send(JSON.stringify({
    type: 'state',
    x: 999999,
    y: 999999,
    z: -999999,
    yaw: 99,
    mode: 'invalid',
    gameplay: {
      heat: 999,
      wantedLevel: 99,
      pursuitActive: true,
      healthBand: 'invincible',
      activity: 'admin',
      event: oversizedEvent,
    },
  }));
  await pageB.waitForFunction(() => window.__SF_SIM__.networking.getPeers()
    .some((entry) => entry.name === 'Untrusted Peer'), null, { timeout: 8000 });
  await pageB.waitForFunction(() => {
    const peer = window.__SF_SIM__.networking.getPeers()
      .find((entry) => entry.name === 'Untrusted Peer');
    return peer?.gameplayEventCount === 1;
  }, null, { timeout: 8000 });
  const sanitized = await pageB.evaluate(() => window.__SF_SIM__.networking.getPeers()
    .find((entry) => entry.name === 'Untrusted Peer'));
  assert(sanitized?.x === 10000
    && sanitized?.z === -10000
    && sanitized?.gameplay?.heat === 100
    && sanitized?.gameplay?.wantedLevel === 3
    && sanitized?.gameplay?.healthBand === 'healthy'
    && sanitized?.gameplay?.activity === 'idle'
    && sanitized?.lastGameplayEvent?.id.length === 48
    && sanitized?.lastGameplayEvent?.message.length === 96,
  'relay did not clamp untrusted peer gameplay payloads', sanitized);
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    rawPeer.send(JSON.stringify({
      type: 'state',
      gameplay: {
        heat: 100,
        wantedLevel: 3,
        pursuitActive: true,
        event: { ...oversizedEvent, id: `spam-${index}` },
      },
    }));
  }
  await pageB.waitForTimeout(250);
  const rateLimited = await pageB.evaluate(() => window.__SF_SIM__.networking.getPeers()
    .find((entry) => entry.name === 'Untrusted Peer'));
  assert(rateLimited?.gameplayEventCount === 1,
    'relay did not rate-limit unique incident spam', rateLimited);
  await pageB.waitForFunction(() => !window.__SF_SIM__.networking.getPeers()
    .some((entry) => entry.name === 'Untrusted Peer'), null, { timeout: 8000 });
  const silentTimeout = await pageB.evaluate(() => ({
    peers: window.__SF_SIM__.networking.getPeers().map((entry) => entry.name),
    rawMarker: [...document.querySelectorAll('.hud__map-remote')]
      .some((node) => node.textContent.includes('U')),
    rawIncident: (document.querySelector('.hud__chat-log')?.textContent || '')
      .includes('untrusted'),
  }));
  assert(!silentTimeout.peers.includes('Untrusted Peer')
    && silentTimeout.rawMarker === false
    && silentTimeout.rawIncident === false,
  'silent peer timeout left stale roster, map, or incident state', silentTimeout);
  rawPeer.close();

  await pageA.evaluate(() => window.__SF_SIM__.streetHeat.restart());
  await pageB.waitForFunction(() => {
    const peer = window.__SF_SIM__.networking.getPeers()
      .find((entry) => entry.name === 'Gameplay A');
    return peer?.gameplay?.heat === 0 && peer?.gameplay?.pursuitActive === false;
  }, null, { timeout: 8000 });
  const cleared = await pageB.evaluate(() => window.__SF_SIM__.networking.getPeers()
    .find((entry) => entry.name === 'Gameplay A'));
  const clearedChat = await pageB.evaluate(
    () => document.querySelector('.hud__chat-log')?.textContent || '',
  );
  assert(cleared?.gameplay?.heat === 0 && cleared?.gameplay?.pursuitActive === false,
    'remote restart did not clear stale wanted status', cleared);
  assert(cleared?.lastGameplayEvent == null
    && cleared?.gameplayEventCount === 0
    && !clearedChat.includes('Vehicle theft'),
  'remote restart did not tombstone the stale incident or HUD event', { cleared, clearedChat });

  await pageB.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await pageB.waitForTimeout(3000);
  const performance = await pageB.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'online gameplay status exceeded the application frame budget', performance);

  await pageA.close();
  await pageB.waitForFunction(() => window.__SF_SIM__.networking.getPeers().length === 0,
    null, { timeout: 8000 });
  const disconnected = await pageB.evaluate(() => ({
    peers: window.__SF_SIM__.networking.getPeers(),
    markers: document.querySelectorAll('.hud__map-remote').length,
  }));
  assert(disconnected.peers.length === 0 && disconnected.markers === 0,
    'disconnect left stale peer gameplay status or map markers', disconnected);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'online gameplay awareness smoke passed'
      : 'online gameplay awareness smoke failed',
    angle,
    renderer,
    theftCandidate: theftCandidate ? { id: theftCandidate.id, class: theftCandidate.class } : null,
    received,
    deduped,
    receiverBefore,
    receiverAfter,
    sanitized,
    rateLimited,
    silentTimeout,
    cleared,
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
