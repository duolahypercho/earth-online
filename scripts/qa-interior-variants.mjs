import { chromium } from 'playwright';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const outputDir = process.env.SF_QA_INTERIOR_DIR || '/tmp/sf-interior-visual';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'metal';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${angle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
  ],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (text.startsWith('Failed to load resource')) return;
  // Multiplayer is optional in preview/QA; the interior sweep only needs sim boot.
  if (/WebSocket connection to 'ws:\/\/127\.0\.0\.1:8787\//.test(text)) return;
  errors.push(text);
});

const stops = [
  {
    id: 'civic',
    key: '1:0',
    district: 'Civic Center',
    x: 288,
    z: -64,
    expectedArchetypes: ['civic-lobby'],
    forbiddenSignage: ['FINANCIAL DISTRICT', 'Financial District Office'],
  },
  {
    id: 'financial',
    key: '4:0',
    district: 'Financial District',
    x: 1600,
    z: 0,
    expectedArchetypes: ['financial-office', 'civic-lobby', 'library'],
  },
  {
    id: 'north-beach',
    key: '4:4',
    district: 'North Beach',
    x: 1600,
    z: 1536,
    expectedArchetypes: ['cafe', 'rowhouse', 'coit'],
  },
  {
    id: 'pacific-heights',
    key: '0:4',
    district: 'Pacific Heights',
    x: 0,
    z: 1536,
    expectedArchetypes: ['library', 'rowhouse', 'sunset-home'],
    forbiddenSignage: ['NOE VALLEY', 'Noe Valley'],
  },
  {
    id: 'presidio',
    key: '-4:1',
    district: 'Presidio',
    x: -1600,
    z: 384,
    expectedArchetypes: ['presidio-barracks', 'sunset-home', 'library'],
  },
  {
    id: 'mission',
    key: '-3:-2',
    district: 'Mission',
    x: -1152,
    z: -768,
    expectedArchetypes: ['mission-workshop', 'market', 'cafe'],
  },
  {
    id: 'mission-bay',
    key: '4:-4',
    district: 'Mission Bay',
    x: 1600,
    z: -1536,
    expectedArchetypes: ['wharf-chandlery', 'market', 'transit'],
  },
  {
    id: 'outer-sunset',
    key: '-5:-4',
    district: 'Outer Sunset',
    x: -1920,
    z: -1536,
    expectedArchetypes: ['sunset-home', 'outer-sunset-cafe'],
    forbiddenArchetypes: ['mission-workshop'],
    forbiddenSignage: ['24TH STREET', 'Mission Maker', 'Mission Workshop'],
  },
];

try {
  await mkdir(outputDir, { recursive: true });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () => typeof window.__SF_SIM__?.launch === 'function',
    { timeout: 10000 },
  );
  await page.evaluate(() => {
    window.__SF_SIM__.launch();
    const overlay = document.querySelector('#boot-overlay');
    if (!overlay?.classList.contains('is-dismissed')) {
      overlay?.classList.add('is-dismissed');
      document.querySelector('#app')?.classList.add('is-live');
      document.querySelector('#scene-canvas')?.removeAttribute('inert');
      document.querySelector('#hud-root')?.removeAttribute('inert');
    }
  });
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    { timeout: 5000 },
  );
  await page.waitForTimeout(1200);

  const evidence = [];
  const archetypes = new Set();
  for (const stop of stops) {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), stop);
    await page.waitForFunction(
      (key) => window.__SF_SIM__?.streaming?.stats?.focusSector === key,
      stop.key,
      { timeout: 15000 },
    );
    await page.waitForFunction(
      (key) => {
        const stats = window.__SF_SIM__?.streaming?.stats;
        return stats?.focusSector === key
          && stats.populationPendingDetailed === 0
          && stats.enterableBuildings > 0;
      },
      stop.key,
      { timeout: 60000 },
    );
    await page.waitForTimeout(500);
    const portal = await page.evaluate(() => {
      const sim = window.__SF_SIM__;
      const focus = sim.getRoamState().focus;
      const nearest = sim.streaming.getNearestEnterablePortal(focus, 260);
      return nearest ? {
        id: nearest.id,
        label: nearest.label,
        roomKind: nearest.roomKind,
        position: nearest.position,
        distance: nearest.distance,
      } : null;
    });
    if (!portal) {
      errors.push(`${stop.id}: no streamed portal was discoverable at the district stop`);
      continue;
    }
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), portal.position);
    await page.waitForTimeout(1000);
    await page.keyboard.press('e');
    await page.waitForTimeout(2600);
    const interior = await page.evaluate(() => window.__SF_SIM__.city.getInteriorState());
    const file = join(outputDir, `${stop.id}-${portal.roomKind}.png`);
    await page.keyboard.press('h');
    await page.waitForTimeout(180);
    await page.screenshot({ path: file });
    await page.keyboard.press('h');
    if (!interior.active) errors.push(`${stop.id}: portal did not enter an interior`);
    const baseVariant = interior.variant?.split(' · ')[0] || null;
    if (baseVariant) archetypes.add(baseVariant);
    if (stop.expectedArchetypes?.length && !stop.expectedArchetypes.includes(baseVariant)) {
      errors.push(
        `${stop.id}: expected one of [${stop.expectedArchetypes.join(', ')}] but got ${baseVariant}`,
      );
    }
    if (stop.forbiddenArchetypes?.includes(baseVariant)) {
      errors.push(`${stop.id}: forbidden archetype ${baseVariant} for ${stop.district}`);
    }
    const signageHaystack = [
      interior.variant,
      interior.roomLabel,
      portal.roomKind,
      portal.label,
    ].filter(Boolean).join(' ').toUpperCase();
    for (const forbidden of stop.forbiddenSignage || []) {
      if (signageHaystack.includes(String(forbidden).toUpperCase())) {
        errors.push(`${stop.id}: forbidden signage "${forbidden}" for ${stop.district}`);
      }
    }
    if (interior.interiorCollisionBoxes < 1) {
      errors.push(`${stop.id}: interior has no address collision dressing`);
    }
    evidence.push({
      key: stop.key,
      district: stop.district,
      portal,
      interior: {
        active: interior.active,
        variant: interior.variant,
        roomLabel: interior.roomLabel,
        collisionMode: interior.interiorCollisionMode,
        collisionBoxes: interior.interiorCollisionBoxes,
      },
      file,
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(650);
  }

  if (archetypes.size < 4) errors.push(`Interior visual sweep saw only ${archetypes.size} archetypes`);
  console.log(JSON.stringify({
    result: errors.length ? 'interior visual capture failed' : 'interior visual capture passed',
    angle,
    outputDir,
    archetypes: [...archetypes].sort(),
    evidence,
    errors,
  }, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'interior visual capture failed',
    error: error.message,
    errors,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
