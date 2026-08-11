import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import WebSocket from 'ws';

// This gate intentionally talks only to the public online-vehicle ownership
// seam.  It does not reach into private networking state or manufacture a
// vehicle: the product QA seam must stage a real traffic vehicle and expose a
// read-only snapshot plus a protocol injector for adversarial frames.
const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const relayPort = Number(process.env.SF_RELAY_PORT || 8799);
const chromePath = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const angle = process.env.SF_QA_ANGLE || 'metal';
const outputDir = process.env.SF_VEHICLE_OWNERSHIP_DIR || '.qa-online-vehicle-ownership';
const viewport = { width: 1280, height: 720 };
const captures = ['00-race', '01-occupied', '02-handoff'].map((name) => `${outputDir}/${name}.png`);

if (process.platform !== 'darwin' || angle !== 'metal') {
  throw new Error('verify-online-vehicle-ownership requires macOS System Chrome with SF_QA_ANGLE=metal.');
}
const executablePath = await access(chromePath).then(() => chromePath).catch(() => null);
if (!executablePath) throw new Error(`System Chrome is required for Apple Metal: ${chromePath}`);
await mkdir(outputDir, { recursive: true });

const relay = spawn(process.execPath, ['server/multiplayer-server.mjs'], {
  env: { ...process.env, PORT: String(relayPort) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let relayReady = false;
relay.stdout.on('data', (chunk) => {
  if (/listening/i.test(String(chunk))) relayReady = true;
});
relay.stderr.on('data', () => {});
await new Promise((resolve) => setTimeout(resolve, 800));

const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  executablePath,
  args: ['--disable-dev-shm-usage', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const requestErrors = [];
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail == null ? {} : { detail }) });
};
const firstFailure = () => failures[0] || consoleErrors[0] || httpErrors[0] || requestErrors[0] || null;

function waitForRawMessage(socket, predicate, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('raw lease protocol response timed out'));
    }, timeout);
    const onMessage = (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function openRawLeaseClient(name) {
  const socket = new WebSocket(`ws://localhost:${relayPort}`);
  const welcomePromise = waitForRawMessage(socket, (message) => message?.type === 'welcome');
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'join', name, color: 0 }));
  const welcome = await welcomePromise;
  return { socket, id: welcome.id };
}

async function verifyRawLeaseAuthority() {
  const vehicleId = 99999;
  const owner = await openRawLeaseClient('Lease owner probe');
  const attacker = await openRawLeaseClient('Lease attacker probe');
  try {
    const grantPromise = waitForRawMessage(owner.socket, (message) => (
      message?.type === 'vehicle:lease'
      && message.status === 'granted'
      && message.requestId === 'qa-claim-1'
      && typeof message.token === 'string'
    ));
    owner.socket.send(JSON.stringify({ type: 'vehicle:claim', requestId: 'qa-claim-1', vehicleId }));
    const grant = await grantPromise;

    const forgedPromise = waitForRawMessage(attacker.socket, (message) => (
      message?.type === 'vehicle:lease'
      && message.status === 'denied'
      && message.requestId === 'qa-forged-release'
    ));
    attacker.socket.send(JSON.stringify({
      type: 'vehicle:release',
      requestId: 'qa-forged-release',
      vehicleId,
      revision: grant.revision,
      token: 'forged',
    }));
    const forged = await forgedPromise;

    const occupiedPromise = waitForRawMessage(attacker.socket, (message) => (
      message?.type === 'vehicle:lease'
      && message.status === 'denied'
      && message.requestId === 'qa-occupied-claim'
    ));
    attacker.socket.send(JSON.stringify({ type: 'vehicle:claim', requestId: 'qa-occupied-claim', vehicleId }));
    const occupied = await occupiedPromise;

    const stalePromise = waitForRawMessage(owner.socket, (message) => (
      message?.type === 'vehicle:lease'
      && message.status === 'denied'
      && message.requestId === 'qa-stale-release'
    ));
    owner.socket.send(JSON.stringify({
      type: 'vehicle:release',
      requestId: 'qa-stale-release',
      vehicleId,
      revision: grant.revision - 1,
      token: grant.token,
    }));
    const stale = await stalePromise;

    const releasePromise = waitForRawMessage(owner.socket, (message) => (
      message?.type === 'vehicle:lease'
      && message.status === 'released'
      && message.vehicleId === vehicleId
      && message.previousRevision === grant.revision
    ));
    owner.socket.send(JSON.stringify({
      type: 'vehicle:release',
      requestId: 'qa-valid-release',
      vehicleId,
      revision: grant.revision,
      token: grant.token,
    }));
    const released = await releasePromise;

    const duplicatePromise = waitForRawMessage(owner.socket, (message) => (
      message?.type === 'vehicle:lease'
      && message.status === 'denied'
      && message.requestId === 'qa-duplicate-release'
    ));
    owner.socket.send(JSON.stringify({
      type: 'vehicle:release',
      requestId: 'qa-duplicate-release',
      vehicleId,
      revision: grant.revision,
      token: grant.token,
    }));
    const duplicate = await duplicatePromise;

    const regrantPromise = waitForRawMessage(owner.socket, (message) => (
      message?.type === 'vehicle:lease'
      && message.status === 'granted'
      && message.requestId === 'qa-claim-2'
      && typeof message.token === 'string'
    ));
    owner.socket.send(JSON.stringify({ type: 'vehicle:claim', requestId: 'qa-claim-2', vehicleId }));
    const regrant = await regrantPromise;

    owner.socket.send(JSON.stringify({
      type: 'state',
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      mode: 'drive',
      moving: false,
      vehicleId,
      vehicleLeaseRevision: regrant.revision,
      vehicleLeaseToken: regrant.token,
    }));
    await new Promise((resolve) => setTimeout(resolve, 3400));
    const timeoutGrantPromise = waitForRawMessage(attacker.socket, (message) => (
      message?.type === 'vehicle:lease'
      && message.status === 'granted'
      && message.requestId === 'qa-timeout-claim'
      && typeof message.token === 'string'
    ));
    attacker.socket.send(JSON.stringify({ type: 'vehicle:claim', requestId: 'qa-timeout-claim', vehicleId }));
    const timeoutGrant = await timeoutGrantPromise;

    return {
      vehicleId,
      ownerId: owner.id,
      grant,
      forged,
      occupied,
      stale,
      released,
      duplicate,
      regrant,
      timeoutGrant,
    };
  } finally {
    owner.socket.close();
    attacker.socket.close();
  }
}

function qaExpression() {
  return `(() => {
    const sim = window.__SF_SIM__;
    const candidates = [
      sim?.getOnlineVehicleOwnershipQa?.(),
      sim?.getVehicleOwnershipQa?.(),
      sim?.getOnlineVehicleQa?.(),
    ].filter(Boolean);
    return candidates[0] || null;
  })()`;
}

async function launch(context, name) {
  const page = await context.newPage();
  page.on('pageerror', (error) => consoleErrors.push(`${name}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('/favicon.ico')) {
      consoleErrors.push(`${name}: ${message.text()}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      httpErrors.push(`${name}: ${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (!request.url().endsWith('/favicon.ico')) {
      requestErrors.push(`${name}: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
    }
  });
  const url = new URL(baseUrl);
  url.searchParams.set('net', `ws://localhost:${relayPort}`);
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  const nameInput = page.locator('#player-name');
  if (await nameInput.count()) await nameInput.fill(name);
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'), null, { timeout: 20000 });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.(), null, { timeout: 30000 });
  await page.waitForTimeout(700);
  return page;
}

async function qa(page) {
  return page.evaluate((expression) => {
    // eslint-disable-next-line no-eval
    const seam = eval(expression);
    return seam ? {
      present: true,
      stage: typeof seam.stage === 'function',
      snapshot: typeof seam.snapshot === 'function',
      protocol: typeof seam.protocol?.inject === 'function',
    } : null;
  }, qaExpression());
}

async function snapshot(page) {
  return page.evaluate((expression) => {
    // eslint-disable-next-line no-eval
    const seam = eval(expression);
    return seam?.snapshot?.() ?? seam?.getSnapshot?.() ?? null;
  }, qaExpression());
}

async function stage(page, options) {
  return page.evaluate(({ expression, options: requested }) => {
    // eslint-disable-next-line no-eval
    const seam = eval(expression);
    if (!seam || typeof seam.stage !== 'function' || typeof seam.snapshot !== 'function') {
      return { contractError: 'getOnlineVehicleOwnershipQa() must expose stage() and snapshot().' };
    }
    return seam.stage(requested);
  }, { expression: qaExpression(), options });
}

async function protocol(page, frame) {
  return page.evaluate(({ expression, frame: payload }) => {
    // eslint-disable-next-line no-eval
    const seam = eval(expression);
    const candidates = [
      seam?.protocol,
      seam?.transport,
      window.__SF_SIM__?.getOnlineVehicleOwnershipProtocol?.(),
      window.__SF_SIM__?.networking?.getVehicleOwnershipProtocol?.(),
    ].filter(Boolean);
    for (const candidate of candidates) {
      for (const method of ['inject', 'injectFrame', 'receive', 'handleMessage', 'sendRaw']) {
        if (typeof candidate[method] === 'function') return { method, result: candidate[method](payload) };
      }
    }
    return { sent: false, contractError: 'public ownership protocol injector is required' };
  }, { expression: qaExpression(), frame });
}

async function renderer(page) {
  return page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  });
}

async function performance(page) {
  return page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.() || null);
}

async function resources(page) {
  return page.evaluate(() => {
    const info = window.__SF_SIM__?.renderer?.info;
    return info ? {
      geometries: info.memory?.geometries ?? null,
      textures: info.memory?.textures ?? null,
      programs: info.programs?.length ?? null,
      calls: info.render?.calls ?? null,
    } : null;
  });
}

async function waitForStableResources(page, timeoutMs = 9000) {
  const started = Date.now();
  let previous = await resources(page);
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(500);
    const current = await resources(page);
    if (current && JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  return previous;
}

async function waitForSnapshot(page, predicate, message, timeout = 10000) {
  try {
    await page.waitForFunction(({ expression, source }) => {
      // eslint-disable-next-line no-eval
      const seam = eval(expression);
      const value = seam?.snapshot?.() ?? null;
      // eslint-disable-next-line no-new-func
      return Function('value', `return (${source})`)(value) === true;
    }, { expression: qaExpression(), source: predicate.toString() }, { timeout, polling: 30 });
    return true;
  } catch {
    assert(false, message, await snapshot(page));
    return false;
  }
}

async function capture(page, index, label) {
  // Captures are evidence only; no fixed pose or hidden DOM is used during
  // staging or input. The seam may provide a capture-only pose; otherwise the
  // live camera is retained so the verifier never invents a scene.
  await page.evaluate((expression) => {
    // eslint-disable-next-line no-eval
    const seam = eval(expression);
    seam?.beginCapture?.();
    const sim = window.__SF_SIM__;
    const root = sim?.renderer?.domElement?.parentElement;
    if (!root) return;
    for (const child of [...root.children]) {
      if (child !== sim.renderer.domElement) {
        child.dataset.qaOwnershipVisibility = child.style.visibility;
        child.style.visibility = 'hidden';
      }
    }
    if (sim.playerAvatar?.userData?.nameTag) {
      sim.playerAvatar.userData.nameTag.userData.qaOwnershipWasVisible = sim.playerAvatar.userData.nameTag.visible === true;
      sim.playerAvatar.userData.nameTag.visible = false;
    }
    const hidden = [];
    sim.scene?.traverse?.((node) => {
      if (!node.isSprite || !/name.?tag/i.test(String(node.name || ''))) return;
      hidden.push({ node, visible: node.visible === true });
      node.visible = false;
    });
    window.__SF_OWNERSHIP_CAPTURE_HIDDEN_TAGS__ = hidden;
  }, qaExpression());
  await page.screenshot({ path: captures[index] });
  await page.evaluate((expression) => {
    // eslint-disable-next-line no-eval
    const seam = eval(expression);
    seam?.endCapture?.();
    const sim = window.__SF_SIM__;
    const root = sim?.renderer?.domElement?.parentElement;
    if (sim.playerAvatar?.userData?.nameTag?.userData?.qaOwnershipWasVisible != null) {
      sim.playerAvatar.userData.nameTag.visible = sim.playerAvatar.userData.nameTag.userData.qaOwnershipWasVisible;
      delete sim.playerAvatar.userData.nameTag.userData.qaOwnershipWasVisible;
    }
    for (const entry of window.__SF_OWNERSHIP_CAPTURE_HIDDEN_TAGS__ || []) {
      if (entry.node) entry.node.visible = entry.visible;
    }
    window.__SF_OWNERSHIP_CAPTURE_HIDDEN_TAGS__ = null;
    for (const child of [...(root?.children || [])]) {
      if (child === sim.renderer.domElement || !('qaOwnershipVisibility' in child.dataset)) continue;
      child.style.visibility = child.dataset.qaOwnershipVisibility;
      delete child.dataset.qaOwnershipVisibility;
    }
  }, qaExpression());
  assert(await page.evaluate(() => document.querySelectorAll('[data-qa-ownership-visibility]').length === 0), `${label} capture leaked HUD state`);
}

function ownership(s) {
  return s?.ownership || s?.vehicleOwnership || s?.vehicle?.ownership || s?.vehicle || null;
}
function player(s) { return s?.player || s?.localPlayer || s?.driver || null; }
function vehicle(s) { return s?.vehicle || s?.ownedVehicle || ownership(s)?.vehicle || null; }
function vehicleIdOf(s) { return s?.vehicleId ?? vehicle(s)?.id ?? ownership(s)?.vehicleId ?? null; }
function ownerId(s) {
  const o = ownership(s);
  return o?.ownerId ?? o?.owner ?? o?.holderId ?? vehicle(s)?.ownerId ?? null;
}
function revision(s) {
  const o = ownership(s);
  return Number(o?.revision ?? o?.ownershipRevision ?? s?.revision);
}
function representationCount(s) {
  const o = ownership(s);
  return Number(o?.representationCount ?? o?.representations ?? s?.representations?.length);
}
function fallbackCount(s) {
  const o = ownership(s);
  return Number(o?.fallbackCount ?? o?.fallbackRepresentations ?? s?.fallbacks?.length);
}
function isDriving(s) { return player(s)?.driving === true || player(s)?.mode === 'drive' || s?.driving === true; }
function onFoot(s) { return player(s)?.onFoot === true || player(s)?.driving === false || !isDriving(s); }

let contextA;
let contextB;
let pageA;
let pageB;
let contextC;
let pageC;
let rawAuthority = null;
try {
  assert(relayReady, 'multiplayer relay did not announce readiness');
  if (!relayReady) throw new Error('multiplayer relay did not announce readiness');
  rawAuthority = await verifyRawLeaseAuthority();
  assert(rawAuthority.forged?.reason === 'not-owner', 'server did not reject a forged non-owner release', rawAuthority);
  assert(rawAuthority.occupied?.reason === 'occupied', 'forged release changed the canonical owner', rawAuthority);
  assert(rawAuthority.stale?.reason === 'stale-release', 'server did not reject a stale owner release', rawAuthority);
  assert(rawAuthority.duplicate?.reason === 'not-owner', 'server accepted a duplicate release', rawAuthority);
  assert(Number(rawAuthority.regrant?.revision) > Number(rawAuthority.grant?.revision), 'fresh claim did not advance the server revision', rawAuthority);
  assert(Number(rawAuthority.timeoutGrant?.revision) > Number(rawAuthority.regrant?.revision)
    && rawAuthority.timeoutGrant?.ownerId !== rawAuthority.ownerId,
  'expired active lease did not release to a waiting peer', rawAuthority);
  contextA = await browser.newContext({ viewport });
  contextB = await browser.newContext({ viewport });
  pageA = await launch(contextA, 'Ownership A');
  pageB = await launch(contextB, 'Ownership B');
  for (const page of [pageA, pageB]) {
    const name = await renderer(page);
    assert(typeof name === 'string' && /metal/i.test(name) && !/swiftshader|software|llvmpipe/i.test(name), 'Apple Metal renderer was not active', name);
  }

  const seamA = await qa(pageA);
  const seamB = await qa(pageB);
  assert(seamA?.present === true && seamA.stage === true && seamA.snapshot === true, 'public online vehicle ownership QA seam is missing', seamA);
  assert(seamB?.present === true && seamB.stage === true && seamB.snapshot === true, 'second context lacks online vehicle ownership QA seam', seamB);
  if (!seamA?.present || !seamB?.present) throw new Error('public online vehicle ownership QA seam is missing');

  const stagedA = await stage(pageA, { kind: 'race', role: 'owner' });
  assert(stagedA?.ready === true && stagedA?.syntheticEvents === 0 && stagedA?.vehicleId != null, 'owner race staging did not expose a real traffic vehicle', stagedA);
  const stagedB = await stage(pageB, { kind: 'race', role: 'challenger', vehicleId: stagedA?.vehicleId });
  assert(stagedB?.ready === true && stagedB?.syntheticEvents === 0 && stagedB?.vehicleId === stagedA?.vehicleId, 'challenger was not staged on the same real traffic vehicle', stagedB);
  const vehicleId = stagedA?.vehicleId;
  const beforeA = await snapshot(pageA);
  const beforeB = await snapshot(pageB);
  assert(vehicleId != null && vehicleIdOf(beforeA) === vehicleId && vehicleIdOf(beforeB) === vehicleId, 'race snapshots did not agree on staged vehicle identity', { beforeA, beforeB });

  await Promise.all([pageA.keyboard.press('e'), pageB.keyboard.press('e')]);
  await pageA.waitForTimeout(900);
  await pageB.waitForTimeout(900);
  const raceA = await snapshot(pageA);
  const raceB = await snapshot(pageB);
  const winnerA = isDriving(raceA);
  const winnerB = isDriving(raceB);
  assert(winnerA !== winnerB, 'simultaneous E did not produce exactly one driver', { raceA, raceB });
  const winnerPage = winnerA ? pageA : pageB;
  const loserPage = winnerA ? pageB : pageA;
  const winner = winnerA ? raceA : raceB;
  const loser = winnerA ? raceB : raceA;
  assert(onFoot(loser) && (loser?.result?.reason === 'occupied' || loser?.occupied?.reason === 'occupied' || loser?.occupied === true), 'loser did not remain on foot with an occupied result', loser);
  assert(ownerId(raceA) != null && ownerId(raceA) === ownerId(raceB), 'both contexts did not agree on one owner id', { raceA, raceB });
  assert(Number.isInteger(revision(raceA)) && revision(raceA) === revision(raceB), 'contexts disagreed on ownership revision', { raceA, raceB });
  assert(representationCount(raceA) === 1 && representationCount(raceB) === 1 && fallbackCount(raceA) === 0 && fallbackCount(raceB) === 0, 'ownership created duplicate or fallback vehicle representations', { raceA, raceB });
  await capture(loserPage, 0, 'race');

  await winnerPage.locator('canvas').focus();
  await winnerPage.keyboard.down('w');
  await winnerPage.waitForTimeout(650);
  await winnerPage.keyboard.up('w');
  const syncedA = await snapshot(pageA);
  const syncedB = await snapshot(pageB);
  const syncedWinner = winnerA ? syncedA : syncedB;
  const syncedLoser = winnerA ? syncedB : syncedA;
  assert(isDriving(syncedWinner) && !isDriving(syncedLoser), 'winner real W input did not synchronize owner/loser views', { syncedA, syncedB });
  assert(Number(vehicle(syncedWinner)?.speed ?? syncedWinner?.vehicle?.speed ?? 0) > 0 || syncedWinner?.player?.moving === true, 'winner real W did not move the owned vehicle', syncedWinner);

  const afterAuthorityProbe = await snapshot(winnerPage);
  assert(ownerId(afterAuthorityProbe) === ownerId(raceA) && isDriving(afterAuthorityProbe), 'raw authority probe changed browser ownership', afterAuthorityProbe);
  await capture(loserPage, 1, 'occupied');

  await winnerPage.keyboard.press('e');
  await winnerPage.waitForTimeout(500);
  const released = await snapshot(winnerPage);
  assert(!isDriving(released), 'real E release did not leave the owner vehicle', released);
  await loserPage.waitForTimeout(500);
  const handoffBefore = await snapshot(loserPage);
  await loserPage.keyboard.press('e');
  await loserPage.waitForTimeout(320);
  await capture(loserPage, 2, 'handoff');
  await loserPage.waitForTimeout(480);
  const handoff = await snapshot(loserPage);
  const loserClientId = stagedB?.clientId ?? stagedB?.peerId ?? handoffBefore?.clientId ?? handoffBefore?.player?.id ?? null;
  assert(isDriving(handoff) && ownerId(handoff) != null
    && (loserClientId == null ? ownerId(handoff) !== ownerId(raceA) : ownerId(handoff) === loserClientId),
  'real E release did not allow loser handoff', { handoffBefore, handoff, loserClientId });
  assert(revision(handoff) > revision(raceA), 'handoff did not advance ownership revision', { race: revision(raceA), handoff: revision(handoff) });
  assert(representationCount(handoff) === 1 && fallbackCount(handoff) === 0, 'handoff created a duplicate or fallback representation', handoff);
  // The former loser is now the authoritative owner. Disconnect that owner
  // context, leaving the released former winner as the observer of the
  // server-side release.
  const disconnectedOwnerPage = loserPage;
  const observerPage = winnerPage;
  await disconnectedOwnerPage.context().close();
  await observerPage.waitForTimeout(900);
  const afterDisconnect = await snapshot(observerPage);
  assert(!isDriving(afterDisconnect) && (ownerId(afterDisconnect) == null || ownerId(afterDisconnect) !== ownerId(handoff)), 'owner disconnect left a stale driver lock', afterDisconnect);
  contextC = await browser.newContext({ viewport });
  pageC = await launch(contextC, 'Ownership Reconnect');
  const stagedC = await stage(pageC, { kind: 'reconnect', role: 'reconnect', vehicleId });
  assert(stagedC?.ready === true && stagedC?.syntheticEvents === 0, 'reconnect staging did not use the real traffic vehicle', stagedC);
  const reconnectBefore = await snapshot(pageC);
  await pageC.keyboard.press('e');
  await pageC.waitForTimeout(700);
  const reconnect = await snapshot(pageC);
  assert(isDriving(reconnect) && revision(reconnect) > revision(handoff), 'reconnect did not require and receive a fresh grant', { reconnectBefore, reconnect });
  assert(ownerId(reconnect) !== ownerId(handoff) || ownerId(handoff) == null, 'reconnect reused stale owner identity', reconnect);

  await pageC.bringToFront();
  const resourcesBefore = await waitForStableResources(pageC);
  await pageC.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await pageC.waitForTimeout(4000);
  const perf = await performance(pageC);
  const resourcesAfter = await resources(pageC);
  assert(Number(perf?.applicationFrameCount) >= 180 && Number(perf?.applicationP99FrameMs) <= 16.67, 'application frame p99 exceeded 16.67ms or had fewer than 180 frames', perf);
  assert(resourcesBefore?.geometries === resourcesAfter?.geometries && resourcesBefore?.textures === resourcesAfter?.textures && resourcesBefore?.programs === resourcesAfter?.programs, 'renderer resource counts were not stable', { resourcesBefore, resourcesAfter });

  const result = {
    result: failures.length || consoleErrors.length || httpErrors.length || requestErrors.length ? 'online vehicle ownership gate failed' : 'online vehicle ownership gate passed',
    relayPort,
    angle,
    vehicleId,
    race: { stagedA, stagedB, a: raceA, b: raceB },
    handoff,
    reconnect,
    rawAuthority,
    performance: perf,
    resourcesBefore,
    resourcesAfter,
    captures,
    firstFailure: firstFailure(),
    failures,
    consoleErrors,
    httpErrors,
    requestErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result.endsWith('failed')) process.exitCode = 1;
} catch (error) {
  const result = { result: 'online vehicle ownership gate failed', error: error.message, firstFailure: firstFailure(), failures, consoleErrors, httpErrors, requestErrors, captures };
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  await contextA?.close().catch(() => {});
  await contextB?.close().catch(() => {});
  await contextC?.close().catch(() => {});
  await browser.close().catch(() => {});
  relay.kill('SIGTERM');
}
