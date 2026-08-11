import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const relayPort = Number(process.env.SF_RELAY_PORT) || 8799;
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'metal';

const relay = spawn(process.execPath, ['server/multiplayer-server.mjs'], {
  env: { ...process.env, PORT: String(relayPort) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let relayReady = false;
relay.stdout.on('data', (chunk) => {
  if (String(chunk).includes('listening')) relayReady = true;
});

await new Promise((resolve) => setTimeout(resolve, 600));

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${angle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
  ],
  ...(executablePath ? { executablePath } : {}),
});

const checks = [];
const errors = [];
function check(name, pass, detail = null) {
  checks.push({ name, pass, detail });
  if (!pass) console.error(`FAIL: ${name}`, detail ?? '');
}

async function launchPlayer(page, name) {
  const url = new URL(baseUrl);
  url.searchParams.set('net', `ws://localhost:${relayPort}`);
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    { timeout: 30000 },
  );
  await page.locator('#player-name').fill(name);
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    { timeout: 15000 },
  );
  await page.waitForTimeout(1200);
}

async function waitForOnline(page, expectedPeers, label) {
  await page.waitForFunction(
    (count) => {
      const status = document.querySelector('.hud__online-status')?.textContent || '';
      const players = document.querySelectorAll('.hud__player').length;
      return status.includes('ONLINE') && players >= count;
    },
    expectedPeers,
    { timeout: 15000 },
  ).catch(() => {});
  const online = await page.evaluate(() => ({
    status: document.querySelector('.hud__online-status')?.textContent || '',
    players: document.querySelectorAll('.hud__player').length,
  }));
  check(`${label} sees online lobby`, online.status.includes('ONLINE') && online.players >= expectedPeers, online);
}

async function findParkedCars(page) {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.getVehicleLifeSnapshot();
    return snapshot.vehicles
      .filter((vehicle) => vehicle.action.key === 'parked' || Number(vehicle.speed) < 0.9)
      .slice(0, 4)
      .map((vehicle) => vehicle.position);
  });
}

let result = 'failed';
let page1 = null;
let page2 = null;

try {
  if (!relayReady) {
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    permissions: ['microphone'],
  });
  page1 = await context.newPage();
  page2 = await context.newPage();
  for (const [page, label] of [[page1, 'page1'], [page2, 'page2']]) {
    page.on('pageerror', (error) => errors.push(`${label} pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
        errors.push(`${label} console: ${message.text()}`);
      }
    });
  }

  await launchPlayer(page1, 'Critic A');
  await waitForOnline(page1, 1, 'Critic A');

  await page1.keyboard.down('w');
  await page1.waitForTimeout(900);
  await page1.keyboard.up('w');
  const walkState = await page1.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      avatarVisible: sim.playerAvatar?.visible === true,
      avatarHeroRig: sim.playerAvatar?.userData?.heroDetail === true,
      position: sim.playerAvatar ? { x: sim.playerAvatar.position.x, z: sim.playerAvatar.position.z } : null,
    };
  });
  check(
    'player avatar walks in the city',
    walkState.avatarVisible === true && walkState.avatarHeroRig === true,
    walkState,
  );
  await page1.screenshot({ path: '.qa-online-walking.png' });

  const parkedCars = await findParkedCars(page1);
  check('parked cars available to enter', parkedCars.length > 0, parkedCars.length);
  let entered = false;
  for (const parked of parkedCars) {
    if (entered) break;
    await page1.evaluate((position) => window.__SF_SIM__.setRoamPose({ x: position.x - 2.6, z: position.z + 1.2 }), parked);
    await page1.waitForTimeout(500);
    entered = await page1.evaluate(() => window.__SF_SIM__.enterCar());
  }
  check('player entered a parked car', entered === true, entered);
  if (entered) {
    await page1.waitForFunction(() => {
      const embodiment = window.__SF_SIM__.getPlayerVehicleEmbodimentState?.();
      return window.__SF_SIM__.isDriving()
        && (embodiment?.phase === 'seated' || embodiment?.phase === 'drive-by');
    }, null, { timeout: 5000 });
    await page1.keyboard.down('w');
    await page1.waitForTimeout(1400);
    await page1.keyboard.up('w');
    const driving = await page1.evaluate(() => ({
      driving: window.__SF_SIM__.isDriving(),
      state: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    }));
    check('player drives the car', driving.driving === true && driving.state?.speed > 1, driving);
    await page1.screenshot({ path: '.qa-online-driving.png' });
  }

  const food = await page1.evaluate(() => {
    const sim = window.__SF_SIM__;
    const ferry = sim.city.portals.find((portal) => (
      String(portal.label || '').toLowerCase().includes('ferry')
      || String(portal.label || '').toLowerCase().includes('market')
      || String(portal.label || '').toLowerCase().includes('cafe')
    ));
    if (!ferry?.position) return { found: false };
    sim.setRoamPose({ x: ferry.position.x - 2, z: ferry.position.z + 1.6 });
    return {
      found: true,
      position: { x: ferry.position.x, y: ferry.position.y, z: ferry.position.z },
    };
  });
  check('market portal available for life action', food.found === true, food);
  if (food.found) {
    await page1.waitForTimeout(600);
    const before = await page1.evaluate(() => window.__SF_SIM__.lifeSim.getState());
    const lifeResult = await page1.evaluate((position) => {
      const sim = window.__SF_SIM__;
      const canEat = sim.lifeSim.canEat(position);
      const ate = sim.lifeSim.eatAtMarket(position);
      return { canEat, ate };
    }, food.position);
    const after = await page1.evaluate(() => window.__SF_SIM__.lifeSim.getState());
    check(
      'life-sim eating rejects a context-free driving bypass',
      lifeResult.canEat === false
        && lifeResult.ate === false
        && after.cash === before.cash
        && after.needs.hunger <= before.needs.hunger + 0.08,
      {
        lifeResult,
        before: { cash: before.cash, hunger: before.needs.hunger },
        after: { cash: after.cash, hunger: after.needs.hunger },
      },
    );
    const worked = await page1.evaluate((position) => {
      const sim = window.__SF_SIM__;
      const before = sim.lifeSim.getState();
      const canWork = sim.lifeSim.canWork(position);
      const started = sim.lifeSim.workShift();
      const after = sim.lifeSim.getState();
      return { before, canWork, started, after };
    }, food.position);
    const beforeWork = worked.before;
    const afterWork = worked.after;
    check(
      'life-sim work rejects a context-free driving bypass',
      worked.canWork === true
        && worked.started === false
        && afterWork.cash === beforeWork.cash
        && afterWork.lastTransaction?.at === beforeWork.lastTransaction?.at,
      {
        worked,
        before: { cash: beforeWork.cash, needs: beforeWork.needs },
        after: { cash: afterWork.cash, needs: afterWork.needs },
      },
    );
    const restAttempt = await page1.evaluate(() => {
      const before = window.__SF_SIM__.lifeSim.getState();
      const rested = window.__SF_SIM__.lifeSim.rest();
      const after = window.__SF_SIM__.lifeSim.getState();
      return { before, rested, after };
    });
    const { before: beforeRest, rested, after: afterRest } = restAttempt;
    check(
      'life-sim rest rejects a context-free driving bypass',
      rested === false
        && afterRest.needs.energy === beforeRest.needs.energy
        && afterRest.clock === beforeRest.clock,
      {
        rested,
        before: { energy: beforeRest.needs.energy, clock: beforeRest.clock },
        after: { energy: afterRest.needs.energy, clock: afterRest.clock },
      },
    );
  }

  await launchPlayer(page2, 'Critic B');
  await waitForOnline(page1, 2, 'Critic A');
  await waitForOnline(page2, 2, 'Critic B');
  const peerState = await page1.evaluate(() => window.__SF_SIM__.networking.getPeers());
  check('relay exchanged peer roster', peerState.some((peer) => peer.name === 'Critic B'), peerState);
  await page1.waitForTimeout(700);
  const remoteMarkers = await page1.evaluate(() => document.querySelectorAll('.hud__map-remote').length);
  check('remote player marker appears on district map', remoteMarkers >= 1, remoteMarkers);
  const drivingNow = await page1.evaluate(() => window.__SF_SIM__.isDriving());
  if (drivingNow) {
    await page1.waitForTimeout(900);
    await page2.screenshot({ path: '.qa-online-remote-driver.png' });
    const remoteView = await page2.evaluate(() => window.__SF_SIM__.networking.getPeers());
    check('remote client sees the driver', remoteView.some((peer) => peer.name === 'Critic A' && peer.driving), remoteView);
    const exited = await page1.evaluate(() => window.__SF_SIM__.exitCar());
    check('player exits the car', exited === true, exited);
  }

  await page1.evaluate(() => window.__SF_SIM__.networking.sendChat('hello from the critic'));
  await page1.waitForTimeout(700);
  const chat1 = await page1.evaluate(() => document.querySelector('.hud__chat-log')?.textContent || '');
  const chat2 = await page2.evaluate(() => document.querySelector('.hud__chat-log')?.textContent || '');
  check('chat relay reaches both clients', chat1.includes('hello from the critic') && chat2.includes('hello from the critic'), { chat1, chat2 });

  const voiceOn = await page1.evaluate(async () => {
    const ok = await window.__SF_SIM__.networking.enableVoice();
    return ok;
  });
  await page1.waitForTimeout(2500);
  const voiceOnB = await page2.evaluate(async () => {
    const ok = await window.__SF_SIM__.networking.enableVoice();
    return ok;
  });
  await page1.waitForTimeout(4000);
  const voiceState = await page1.evaluate(() => window.__SF_SIM__.networking.getState());
  const voiceDebug = await page1.evaluate(() => window.__SF_SIM__.networking.getVoiceDebug());
  const voiceDebugB = await page2.evaluate(() => window.__SF_SIM__.networking.getVoiceDebug());
  check(
    'voice mode activates with mic',
    voiceOn === true && voiceOnB === true && voiceState.voiceOn === true,
    { voiceState, voiceOnB },
  );
  check(
    'voice audio is bidirectional',
    voiceDebug.every((peer) => peer.hasRemoteAudio === true)
      && voiceDebugB.every((peer) => peer.hasRemoteAudio === true),
    { voiceDebug, voiceDebugB },
  );
  await page1.screenshot({ path: '.qa-online-chat-voice.png' });

  const nightSet = await page1.evaluate(() => {
    const ok = window.__SF_SIM__.setTimeOfDay(22);
    return { ok, clock: window.__SF_SIM__.timeOfDay };
  });
  await page1.waitForTimeout(700);
  const nightProbe = await page1.evaluate(() => ({
    clock: window.__SF_SIM__.timeOfDay,
    phase: window.__SF_SIM__.lifeSim.getState().phase,
    skyTop: window.__SF_SIM__.scene.getObjectByName('Procedural Pacific sky')?.material?.uniforms?.topColor?.value?.getHexString(),
    crowdHour: window.__SF_SIM__.pedestrians.getStats().dayHour,
  }));
  check(
    'time-of-day lighting responds to life clock',
    nightSet.ok === true
      && nightProbe.clock >= 21.9
      && nightProbe.phase === 'NIGHT'
      && nightProbe.skyTop === '111a2a'
      && nightProbe.crowdHour >= 21.9,
    { nightSet, nightProbe },
  );
  await page1.evaluate(() => window.__SF_SIM__.setTimeOfDay(7));

  check('no browser or console errors', errors.length === 0, errors.slice(0, 5));
  result = 'passed';
} catch (error) {
  errors.push(`runner: ${error.message}`);
} finally {
  await browser.close();
  relay.kill('SIGTERM');
}

console.log(JSON.stringify({ result, checks, errors }, null, 2));
process.exitCode = result === 'passed' ? 0 : 1;
