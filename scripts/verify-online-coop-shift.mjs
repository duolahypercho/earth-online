import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const relayPort = Number(process.env.SF_RELAY_PORT) || 8802;
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await access(systemChrome);
const angle = process.env.SF_QA_ANGLE || 'metal';
if (angle !== 'metal') throw new Error(`verify:online-coop-shift requires Metal, received ${angle}`);

const relay = spawn(process.execPath, ['server/multiplayer-server.mjs'], {
  env: { ...process.env, PORT: String(relayPort) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let relayReady = false;
relay.stdout.on('data', (chunk) => {
  if (String(chunk).includes('listening')) relayReady = true;
});
const relayErrors = [];
relay.stderr.on('data', (chunk) => relayErrors.push(String(chunk)));
await new Promise((resolve) => setTimeout(resolve, 500));

const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  executablePath: systemChrome,
  args: [
    '--disable-dev-shm-usage',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
  ],
});
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const requestErrors = [];
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};

async function launchPlayer(page, name, { clearStorage = true } = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('net', `ws://127.0.0.1:${relayPort}`);
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 30000 });
  if (clearStorage) {
    await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  }
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#player-name').fill(name);
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForFunction(() => window.__SF_SIM__.networking?.getState().connected === true,
    null, { timeout: 15000 });
  await page.waitForTimeout(350);
}

async function walkTo(page, position, tolerance = 0.72) {
  const axes = [
    { coordinate: 'x', positive: 'a', negative: 'd' },
    { coordinate: 'z', positive: 'w', negative: 's' },
  ];
  for (const axis of axes) {
    const start = await page.evaluate(() => window.__SF_SIM__.getRoamState().target);
    const delta = position[axis.coordinate] - start[axis.coordinate];
    if (Math.abs(delta) <= tolerance) continue;
    const key = delta > 0 ? axis.positive : axis.negative;
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down(key);
    const deadline = Date.now() + Math.max(5000, Math.abs(delta) / 9.5 * 2600);
    let reached = false;
    while (Date.now() < deadline) {
      const current = await page.evaluate(() => window.__SF_SIM__.getRoamState().target);
      const remaining = position[axis.coordinate] - current[axis.coordinate];
      if (Math.abs(remaining) <= tolerance || Math.sign(remaining) !== Math.sign(delta)) {
        reached = true;
        break;
      }
      await page.waitForTimeout(60);
    }
    await page.keyboard.up(key);
    await page.keyboard.up('ShiftLeft');
    if (!reached) {
      throw new Error(`Real movement could not reach ${axis.coordinate}=${position[axis.coordinate]}`);
    }
  }
  await page.waitForTimeout(180);
}

async function pressObjective(page, position, expectedSteps) {
  await walkTo(page, position);
  await page.keyboard.press('e');
  try {
    await page.waitForFunction((count) => (
      window.__SF_SIM__.networking.getCoopSession()?.completedSteps === count
      && window.__SF_SIM__.cityShift.getState().completedSteps === count
    ), expectedSteps, { timeout: 8000, polling: 25 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      coop: window.__SF_SIM__.networking.getCoopSession(),
      mission: window.__SF_SIM__.cityShift.getState(),
      roam: window.__SF_SIM__.getRoamState(),
      interior: window.__SF_SIM__.city.getInteriorState(),
      interaction: window.__SF_SIM__.city.getInteriorInteraction?.(
        window.__SF_SIM__.getRoamState()?.target,
      ) || null,
      message: document.querySelector('.hud__message')?.textContent || '',
    }));
    console.error('Objective diagnostic:', JSON.stringify(diagnostic, null, 2));
    throw error;
  }
}

async function snapshot(page) {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      peerId: sim.networking.getState().id,
      coop: sim.networking.getCoopSession(),
      mission: sim.cityShift.getState(),
      life: sim.lifeSim.getState(),
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      saved: sim.getSavedProgress(),
      performance: sim.getPerformanceSnapshot?.() || null,
      interior: sim.city.getInteriorState(),
      message: document.querySelector('.hud__message')?.textContent || '',
    };
  });
}

async function waitForRawMessage(messages, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = [...messages].reverse().find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function moveRawPeer(peer, from, to, mode = 'walk') {
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  const direction = distance > 0
    ? { x: (to.x - from.x) / distance, z: (to.z - from.z) / distance }
    : { x: 0, z: 0 };
  const segments = Math.max(1, Math.ceil(distance / (9.5 * 0.055)));
  for (let index = 1; index <= segments; index += 1) {
    const progress = index / segments;
    peer.send(JSON.stringify({
      type: 'state',
      x: from.x + (to.x - from.x) * progress,
      y: 0,
      z: from.z + (to.z - from.z) * progress,
      mode,
      coopMotion: { ...direction, sprint: true },
    }));
    await new Promise((resolve) => setTimeout(resolve, 55));
  }
  peer.send(JSON.stringify({
    type: 'state', x: to.x, y: 0, z: to.z, mode, coopMotion: { x: 0, z: 0, sprint: false },
  }));
  await new Promise((resolve) => setTimeout(resolve, 60));
}

function observe(page, label) {
  page.on('pageerror', (error) => consoleErrors.push(`${label}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('/favicon.ico')) {
      consoleErrors.push(`${label}: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => requestErrors.push(
    `${label}: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`,
  ));
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      httpErrors.push(`${label}: ${response.status()} ${response.url()}`);
    }
  });
}

let pageA;
let pageB;
let rawPeer;
let attackerPeer;
let expiryPeer;
let expiryRelay;
try {
  if (!relayReady) await new Promise((resolve) => setTimeout(resolve, 700));
  assert(relayReady && relayErrors.length === 0, 'relay did not start cleanly', relayErrors);
  const contextA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const contextB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
  observe(pageA, 'A');
  observe(pageB, 'B');
  await launchPlayer(pageA, 'Shift A');
  await launchPlayer(pageB, 'Shift B');
  await pageA.waitForFunction(() => window.__SF_SIM__.networking.getState().peerCount === 1,
    null, { timeout: 10000 });

  const renderer = await pageA.evaluate(() => {
    const gl = window.__SF_SIM__.renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      hasDebugRenderer: Boolean(extension),
      value: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : '',
    };
  });
  assert(renderer.hasDebugRenderer
    && /metal/i.test(renderer.value)
    && !/(swiftshader|software|llvmpipe)/i.test(renderer.value),
  'Apple Metal renderer was not fail-closed', renderer);

  const cashBeforeA = (await snapshot(pageA)).life.cash;
  const cashBeforeB = (await snapshot(pageB)).life.cash;
  const firstPortal = await pageA.evaluate(() => {
    const portal = window.__SF_SIM__.cityShift.steps[0].portal;
    return { x: portal.position.x, z: portal.position.z };
  });
  await pressObjective(pageA, firstPortal, 1);
  await pressObjective(pageB, firstPortal, 1);
  await pageA.waitForFunction(() => window.__SF_SIM__.networking
    .getCoopSession()?.members.length === 2, null, { timeout: 8000 });
  const joinedA = await snapshot(pageA);
  const joinedB = await snapshot(pageB);
  assert(joinedA.coop?.sessionId === joinedB.coop?.sessionId
    && joinedA.coop?.leaderId === joinedA.peerId
    && joinedA.coop?.completedSteps === 1
    && joinedB.coop?.completedSteps === 1,
  'two clients did not join the same canonical 1/6 session', { joinedA, joinedB });

  rawPeer = new WebSocket(`ws://127.0.0.1:${relayPort}`);
  const rawMessages = [];
  rawPeer.on('message', (data) => rawMessages.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => {
    rawPeer.once('open', resolve);
    rawPeer.once('error', reject);
  });
  rawPeer.send(JSON.stringify({ type: 'join', name: 'Authority Probe', color: 2 }));
  rawPeer.send(JSON.stringify({ type: 'state', x: 348, y: 0, z: 13.45, mode: 'walk' }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  rawPeer.send(JSON.stringify({
    type: 'coop:advance',
    requestId: 'third-party-step',
    stepIndex: 1,
    stepId: 'welcome-desk',
    context: { kind: 'hotspot', id: 'welcome-desk', enabled: true },
  }));
  rawPeer.send(JSON.stringify({
    type: 'coop:state',
    session: { sessionId: joinedA.coop.sessionId, revision: 999, status: 'complete' },
  }));
  await pageA.evaluate(() => {
    const net = window.__SF_SIM__.networking;
    net.submitCoopStep({
      stepIndex: 5,
      stepId: 'coit-tower',
      context: { kind: 'portal', id: 'fake', label: 'Coit Tower observation deck' },
    });
    net.submitCoopStep({
      stepIndex: 0,
      stepId: 'welcome-center',
      context: { kind: 'portal', id: 'duplicate', label: 'Embarcadero Welcome Center' },
    });
  });
  await pageA.waitForTimeout(300);
  const rejected = await snapshot(pageA);
  assert(rejected.coop?.revision === joinedA.coop?.revision
    && rejected.coop?.completedSteps === 1
    && rejected.life.cash === cashBeforeA,
  'third-party, out-of-order, duplicate, or forged state advanced/payed the session', {
    joined: joinedA.coop,
    rejected,
    rawMessages,
  });

  await pressObjective(pageA, { x: 348, z: 13.45 }, 2);
  await pressObjective(pageB, { x: 344.4, z: 9.75 }, 3);
  await pressObjective(pageA, { x: 352.95, z: 9.6 }, 4);

  await pageB.keyboard.press('Escape');
  await pageB.waitForFunction(() => window.__SF_SIM__.city.getInteriorState().active === false,
    null, { timeout: 5000 });
  await pageB.waitForTimeout(240);
  const ferryPortal = await pageB.evaluate(() => {
    const portal = window.__SF_SIM__.cityShift.steps[4].portal;
    return { x: portal.position.x, z: portal.position.z };
  });
  await pressObjective(pageB, ferryPortal, 5);

  await pageB.keyboard.press('Escape');
  await pageB.waitForFunction(() => window.__SF_SIM__.city.getInteriorState().active === false,
    null, { timeout: 5000 });
  await pageB.waitForTimeout(240);
  const coitPortal = await pageB.evaluate(() => {
    const portal = window.__SF_SIM__.cityShift.steps[5].portal;
    return { x: portal.position.x, z: portal.position.z };
  });
  await pressObjective(pageB, coitPortal, 6);
  await pageA.waitForFunction(() => window.__SF_SIM__.cityShift.getState().status === 'complete',
    null, { timeout: 8000 });
  const completeA = await snapshot(pageA);
  const completeB = await snapshot(pageB);
  assert(completeA.coop?.status === 'complete'
    && completeB.coop?.status === 'complete'
    && completeA.coop?.completionRevision === completeB.coop?.completionRevision
    && completeA.coop?.cashReward === 260
    && completeA.life.cash === cashBeforeA + 260
    && completeB.life.cash === cashBeforeB + 260
    && completeA.life.lastTransaction?.kind === 'mission-reward'
    && completeB.life.lastTransaction?.kind === 'mission-reward'
    && completeA.life.lastTransaction?.amount === 260
    && completeB.life.lastTransaction?.amount === 260,
  'canonical completion did not issue one identical local reward per participant', {
    completeA,
    completeB,
  });

  const receiptAtA = completeA.life.lastTransaction?.at;
  const receiptAtB = completeB.life.lastTransaction?.at;
  await pageA.keyboard.press('e');
  await pageA.evaluate(() => window.__SF_SIM__.networking.submitCoopStep({
    stepIndex: 5,
    stepId: 'coit-tower',
    context: { kind: 'portal', id: 'duplicate-final', label: 'Coit Tower observation deck' },
  }));
  await pageA.waitForTimeout(250);
  const duplicateFinal = await snapshot(pageA);
  assert(duplicateFinal.life.cash === completeA.life.cash
    && duplicateFinal.life.lastTransaction?.at === receiptAtA,
  'duplicate final interaction replayed the reward', duplicateFinal);

  await pageB.reload({ waitUntil: 'load', timeout: 30000 });
  await launchPlayer(pageB, 'Shift B', { clearStorage: false });
  const reloadedB = await snapshot(pageB);
  assert(reloadedB.coop == null
    && reloadedB.mission.status === 'complete'
    && reloadedB.life.cash === completeB.life.cash
    && reloadedB.life.lastTransaction?.at === receiptAtB,
  'reload replayed reward or restored transient co-op authority', reloadedB);
  await pageA.waitForFunction(() => window.__SF_SIM__.networking.getCoopSession() == null,
    null, { timeout: 8000 });
  const endedA = await snapshot(pageA);
  assert(endedA.mission.status === 'complete' && endedA.life.cash === completeA.life.cash,
    'participant disconnect altered a completed local mission or reward', endedA);

  attackerPeer = new WebSocket(`ws://127.0.0.1:${relayPort}`);
  const attackerMessages = [];
  attackerPeer.on('message', (data) => attackerMessages.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => {
    attackerPeer.once('open', resolve);
    attackerPeer.once('error', reject);
  });
  attackerPeer.send(JSON.stringify({ type: 'join', name: 'Member Spoof Probe', color: 3 }));
  await moveRawPeer(attackerPeer, { x: 28, z: 38 }, firstPortal);
  attackerPeer.send(JSON.stringify({
    type: 'coop:advance',
    requestId: 'attacker-legitimate-step-0',
    stepIndex: 0,
    stepId: 'welcome-center',
    context: { kind: 'portal', id: 'welcome', label: 'Embarcadero Welcome Center' },
  }));
  const attackerJoined = await waitForRawMessage(attackerMessages,
    (message) => message.type === 'coop:state' && message.session?.completedSteps === 1);
  assert(attackerJoined?.session?.cashReward === 0,
    'raw member could not establish the legitimate first step fixture', attackerMessages);
  await new Promise((resolve) => setTimeout(resolve, 80));
  attackerPeer.send(JSON.stringify({
    type: 'state', x: 348, y: 0, z: 13.45, mode: 'interior',
    coopMotion: { x: 0, z: 1, sprint: true },
  }));
  await new Promise((resolve) => setTimeout(resolve, 170));
  attackerPeer.send(JSON.stringify({
    type: 'coop:advance',
    requestId: 'attacker-legitimate-step-1',
    stepIndex: 1,
    stepId: 'welcome-desk',
    context: { kind: 'hotspot', id: 'welcome-desk', enabled: true },
  }));
  const attackerAtTwo = await waitForRawMessage(attackerMessages,
    (message) => message.type === 'coop:state' && message.session?.completedSteps === 2);
  assert(attackerAtTwo?.session?.cashReward === 0,
    'raw member could not establish the canonical 2/6 attack baseline', attackerMessages);
  const forgedObjectives = [
    { stepIndex: 2, stepId: 'bay-route-model', x: 344.4, z: 9.75, mode: 'interior', context: { kind: 'hotspot', id: 'bay-route-model', enabled: true } },
    { stepIndex: 3, stepId: 'map-archive', x: 352.95, z: 9.6, mode: 'interior', context: { kind: 'hotspot', id: 'map-archive', enabled: true } },
    { stepIndex: 4, stepId: 'ferry-building', x: -8, z: 99.2, mode: 'walk', context: { kind: 'portal', id: 'ferry', label: 'Ferry Building market hall' } },
    { stepIndex: 5, stepId: 'coit-tower', x: 82, z: 122.8, mode: 'walk', context: { kind: 'portal', id: 'coit', label: 'Coit Tower observation deck' } },
  ];
  for (const objective of forgedObjectives) {
    attackerPeer.send(JSON.stringify({
      type: 'state', x: objective.x, y: 0, z: objective.z, mode: objective.mode,
      coopMotion: { x: 0, z: 0, sprint: false },
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    attackerPeer.send(JSON.stringify({
      type: 'coop:advance',
      requestId: `attacker-forged-step-${objective.stepIndex}`,
      stepIndex: objective.stepIndex,
      stepId: objective.stepId,
      context: objective.context,
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  attackerPeer.send(JSON.stringify({
    type: 'state', x: 344.4, y: 0, z: 9.75, mode: 'drive',
    coopMotion: { x: 0, z: 0, sprint: false },
  }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  attackerPeer.send(JSON.stringify({
    type: 'coop:advance',
    requestId: 'attacker-driving-step-2',
    stepIndex: 2,
    stepId: 'bay-route-model',
    context: { kind: 'hotspot', id: 'bay-route-model', enabled: true },
  }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const attackerLatest = [...attackerMessages].reverse().find(
    (message) => message.type === 'coop:state' && message.session,
  )?.session || null;
  assert(attackerLatest?.completedSteps === 2
    && attackerLatest?.status === 'running'
    && attackerLatest?.cashReward === 0,
  'a raw session member forged target poses to advance or receive a payout', {
    attackerLatest,
    attackerMessages,
  });
  attackerPeer.send(JSON.stringify({
    type: 'state', x: 999, y: 0, z: 999, mode: 'walk',
    coopMotion: { x: 0, z: 0, sprint: false },
  }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  attackerPeer.send(JSON.stringify({
    type: 'state', x: 999, y: 0, z: 999, mode: 'interior',
    coopMotion: { x: 0, z: 0, sprint: false },
  }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  await moveRawPeer(attackerPeer, { x: 348, z: 12 }, { x: 344.4, z: 9.75 }, 'interior');
  attackerPeer.send(JSON.stringify({
    type: 'coop:advance',
    requestId: 'attacker-drive-exit-recovery-step-2',
    stepIndex: 2,
    stepId: 'bay-route-model',
    context: { kind: 'hotspot', id: 'bay-route-model', enabled: true },
  }));
  const driveRecovery = await waitForRawMessage(attackerMessages,
    (message) => message.type === 'coop:state' && message.session?.completedSteps === 3);
  assert(driveRecovery?.session?.cashReward === 0,
    'drive exit did not recover through the relay-owned walk/interior transition', attackerMessages);
  attackerPeer.close();

  const expiryPort = relayPort + 1;
  const expiryRelayErrors = [];
  let expiryRelayReady = false;
  expiryRelay = spawn(process.execPath, ['server/multiplayer-server.mjs'], {
    env: { ...process.env, PORT: String(expiryPort), SF_COOP_SESSION_TTL_MS: '450' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expiryRelay.stdout.on('data', (chunk) => {
    if (String(chunk).includes('listening')) expiryRelayReady = true;
  });
  expiryRelay.stderr.on('data', (chunk) => expiryRelayErrors.push(String(chunk)));
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert(expiryRelayReady && expiryRelayErrors.length === 0,
    'accelerated expiry relay did not start cleanly', expiryRelayErrors);
  expiryPeer = new WebSocket(`ws://127.0.0.1:${expiryPort}`);
  const expiryMessages = [];
  expiryPeer.on('message', (data) => expiryMessages.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => {
    expiryPeer.once('open', resolve);
    expiryPeer.once('error', reject);
  });
  expiryPeer.send(JSON.stringify({ type: 'join', name: 'Expiry Probe', color: 4 }));
  await moveRawPeer(expiryPeer, { x: 28, z: 38 }, firstPortal);
  expiryPeer.send(JSON.stringify({
    type: 'coop:advance',
    requestId: 'expiry-step-0',
    stepIndex: 0,
    stepId: 'welcome-center',
    context: { kind: 'portal', id: 'welcome', label: 'Embarcadero Welcome Center' },
  }));
  const expiryStarted = await waitForRawMessage(expiryMessages,
    (message) => message.type === 'coop:state' && message.session?.completedSteps === 1);
  const expiryTombstone = await waitForRawMessage(expiryMessages,
    (message) => message.type === 'coop:state'
      && message.session == null
      && message.reason === 'expired', 2500);
  assert(expiryStarted?.session?.cashReward === 0
    && expiryTombstone
    && !expiryMessages.some((message) => message.session?.cashReward > 0),
  'idle canonical session did not expire with a no-payout tombstone', expiryMessages);
  expiryPeer.close();
  expiryRelay.kill('SIGTERM');

  await pageA.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await pageA.waitForTimeout(3000);
  const performance = (await snapshot(pageA)).performance;
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'co-op session exceeded the application frame budget', performance);

  const result = {
    result: failures.length === 0
      && consoleErrors.length === 0
      && httpErrors.length === 0
      && requestErrors.length === 0
      ? 'authoritative online co-op Shift passed'
      : 'authoritative online co-op Shift failed',
    baseUrl,
    angle,
    joinPolicy: 'welcome-only',
    renderer,
    joined: { a: joinedA.coop, b: joinedB.coop },
    rejected: rejected.coop,
    complete: {
      a: { coop: completeA.coop, cash: completeA.life.cash, transaction: completeA.life.lastTransaction },
      b: { coop: completeB.coop, cash: completeB.life.cash, transaction: completeB.life.lastTransaction },
    },
    duplicateFinal: duplicateFinal.life,
    reloadedB: { coop: reloadedB.coop, mission: reloadedB.mission, life: reloadedB.life },
    endedA: { coop: endedA.coop, mission: endedA.mission, life: endedA.life },
    memberSpoof: attackerLatest,
    driveRecovery: driveRecovery?.session || null,
    idleExpiry: {
      started: expiryStarted?.session || null,
      tombstone: expiryTombstone || null,
    },
    performance,
    failures,
    consoleErrors,
    httpErrors,
    requestErrors,
    relayErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length || requestErrors.length) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rawPeer?.close();
  attackerPeer?.close();
  expiryPeer?.close();
  expiryRelay?.kill('SIGTERM');
  await browser.close();
  relay.kill('SIGTERM');
}
