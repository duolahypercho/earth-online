import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  ...(executablePath ? { executablePath } : {}),
});

const SOURCE = Object.freeze({
  segmentId: 'sf-seg-308',
  streetId: 'sf-street-228196396',
  side: 1,
  a: Object.freeze({ x: 1444.4, z: 1109.2 }),
  b: Object.freeze({ x: 1404.6, z: 1069.9 }),
  lengthMeters: 55.933263806075274,
  roadHalfWidthMeters: 3.2,
  sidewalkOuterOffsetMeters: 5.6,
});
const ACTOR_RADIUS_METERS = 0.455;
const EXPECTED_SITTER_SOURCE_T = 0.6339332587628481;
const EXPECTED_SITTER_LATERAL_OFFSET_METERS = 4.4;
const SEATED_MATRIX_POSITION_TOLERANCE_METERS = 1e-4;
const SEATED_MATRIX_CONTACT_TOLERANCE_METERS = 1e-5;
const SEATED_ENVELOPE_RADIUS_METERS = 0.8;
const EXPECTED_SEAT_ENVELOPE_LOCAL_METERS = Object.freeze({ minX: -0.8, maxX: 0.8, minZ: -0.31, maxZ: 0.31 });
const EXPECTED_TORSO_CONTACT_ENVELOPE_LOCAL_METERS = Object.freeze({
  minX: -0.1,
  maxX: 0.54,
  minZ: -0.12,
  maxZ: 0.16,
});
const EXPECTED_ACTORS = Object.freeze([
  Object.freeze({
    id: 'pedestrian:44',
    instanceIndex: 44,
    role: 'destination-walker',
    partnerId: null,
    poseKind: 'walking-destination',
    sourceTBounds: Object.freeze([0.36, 0.38]),
    lateralOffsetMeters: 5.05,
    speedMetersPerSecond: 0.72,
    behavior: 'shared-phase-destination-walk-loop',
  }),
  Object.freeze({
    id: 'pedestrian:25',
    instanceIndex: 25,
    role: 'destination-walker',
    partnerId: null,
    poseKind: 'walking-destination',
    sourceTBounds: Object.freeze([0.77, 0.79]),
    lateralOffsetMeters: 5.05,
    speedMetersPerSecond: 0.72,
    behavior: 'shared-phase-destination-walk-loop',
  }),
  Object.freeze({
    id: 'pedestrian:36',
    instanceIndex: 36,
    role: 'bench-sitter',
    partnerId: null,
    poseKind: 'bench-seated',
    sourceTBounds: Object.freeze([EXPECTED_SITTER_SOURCE_T, EXPECTED_SITTER_SOURCE_T]),
    lateralOffsetMeters: EXPECTED_SITTER_LATERAL_OFFSET_METERS,
    speedMetersPerSecond: 0,
    behavior: 'bench-seated-idle',
  }),
]);
const HERO_CAMERA_FOV_DEGREES = 48;
const HERO_RENDERED_SHOULDER_WIDTH_METERS = 0.78;
const HERO_MIN_TRIANGLE_AREA_PIXELS_SQUARED = 6;
const EXPECTED_WALK_PATH_LENGTH_METERS = Object.freeze(
  EXPECTED_ACTORS.slice(0, 2).map((actor) => (
    (actor.sourceTBounds[1] - actor.sourceTBounds[0]) * SOURCE.lengthMeters
  )),
);
const EXPECTED_PROPS = Object.freeze({
  t: Object.freeze([0.34, 0.39, 0.47, 0.63, 0.7, 0.75, 0.84]),
  kinds: Object.freeze(['planter', 'sign', 'cone', 'bench', 'hydrant', 'planter', 'cone']),
  presentationKinds: Object.freeze(['trash-can', 'sign', 'bike-rack', 'bench', 'hydrant', 'newspaper-box', 'cone']),
  lateralOffsets: Object.freeze([4.1, 3.96, 4.15, 4.38, 3.9, 4.1, 3.84]),
  scales: Object.freeze([1, 1.15, 1, 1, 1.15, 1, 1.1]),
  effectiveCollisionRadii: Object.freeze([0.46, 0.4025, 0.6, 0.86, 0.345, 0.42, 0.231]),
});
const EXPECTED_BATCH_PARTS = Object.freeze([
  'torso', 'head', 'hair', 'face', 'upperArms', 'forearms', 'hands', 'thighs', 'shins', 'shoes', 'shadow',
]);

function assertApprox(actual, expected, label, tolerance = 1e-6) {
  assert.ok(Number.isFinite(actual), `${label} is finite`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, received ${actual}`);
}

function assertFiniteObject(value, label) {
  assert.ok(value && typeof value === 'object', `${label} is present`);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number') assert.ok(Number.isFinite(entry), `${label}.${key} is finite`);
  }
}

function sourceCoordinates(position) {
  const dx = SOURCE.b.x - SOURCE.a.x;
  const dz = SOURCE.b.z - SOURCE.a.z;
  const tx = dx / SOURCE.lengthMeters;
  const tz = dz / SOURCE.lengthMeters;
  const nx = -tz * SOURCE.side;
  const nz = tx * SOURCE.side;
  const px = position.x - SOURCE.a.x;
  const pz = position.z - SOURCE.a.z;
  return {
    sourceT: (px * tx + pz * tz) / SOURCE.lengthMeters,
    lateralOffsetMeters: px * nx + pz * nz,
  };
}

function expectedPoint(sourceT, lateralOffsetMeters) {
  const dx = SOURCE.b.x - SOURCE.a.x;
  const dz = SOURCE.b.z - SOURCE.a.z;
  const tx = dx / SOURCE.lengthMeters;
  const tz = dz / SOURCE.lengthMeters;
  const nx = -tz * SOURCE.side;
  const nz = tx * SOURCE.side;
  return {
    x: SOURCE.a.x + dx * sourceT + nx * lateralOffsetMeters,
    z: SOURCE.a.z + dz * sourceT + nz * lateralOffsetMeters,
  };
}

function staticDiagnostics(diagnostics) {
  return {
    pass: diagnostics.pass,
    schemaVersion: diagnostics.schemaVersion,
    enabled: diagnostics.enabled,
    source: diagnostics.source,
    logicalPedestriansBefore: diagnostics.logicalPedestriansBefore,
    logicalPedestriansAfter: diagnostics.logicalPedestriansAfter,
    relocated: diagnostics.relocated,
    roles: diagnostics.roles,
    donorSelection: diagnostics.donorSelection,
    composition: diagnostics.composition,
    actors: diagnostics.actors.map(({ currentPose: _currentPose, ...actor }) => actor),
    resources: diagnostics.resources,
    failure: diagnostics.failure,
    finite: diagnostics.finite,
  };
}

async function openCanonicalPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu
      && window.__CITYGEN__?.getState().pedestrians === 48
      && window.__CITYGEN__?.getTraffic()?.getHeroCurbLifeDiagnostics().enabled === true,
    { timeout: 30000 },
  );
  return { page, errors };
}

const firstDocument = await openCanonicalPage();
const { page, errors } = firstDocument;

try {
  const first = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const city = api.getCity();
    const renderer = api.getRenderer();
    const traffic = api.getTraffic();
    const parts = traffic.pedestrianBatch.parts;
    const pedestrianMeshes = [];
    traffic.group.traverse((object) => {
      if (object.isMesh && object.name.startsWith('pedestrian-')) pedestrianMeshes.push(object);
    });
    const sceneGeometries = new Set();
    const sceneMaterials = new Set();
    let sceneMeshes = 0;
    renderer.scene.traverse((object) => {
      if (!object.isMesh) return;
      sceneMeshes += 1;
      if (object.geometry) sceneGeometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material) sceneMaterials.add(material);
      }
    });
    return {
      state: api.getState(),
      diagnostics: traffic.getHeroCurbLifeDiagnostics(),
      sourceSegment: structuredClone(city.segments.find((segment) => segment.id === 'sf-seg-308')),
      sourceSnapshot: JSON.stringify(city.segments.find((segment) => segment.id === 'sf-seg-308')),
      corridor: structuredClone(renderer.sidewalkPropDiagnostics?.heroFrontages?.corridor),
      population: traffic.pedestrians.length,
      uniqueIdentities: new Set(traffic.pedestrians.map((pedestrian) => pedestrian.instanceIndex)).size,
      logicalSceneAttachments: traffic.pedestrians.filter((pedestrian) => pedestrian.group.parent).length,
      batch: {
        partNames: Object.keys(parts),
        counts: Object.values(parts).map((mesh) => mesh.count),
        meshes: pedestrianMeshes.length,
        matricesFinite: Object.values(parts).every((mesh) => [...mesh.instanceMatrix.array].every(Number.isFinite)),
      },
      rendererCanvasCount: document.querySelectorAll('#scene-canvas').length,
      rendererCanvasIdentity: renderer.renderer.domElement === document.querySelector('#scene-canvas'),
      minimapCanvasCount: document.querySelectorAll('#minimap-canvas').length,
      resources: {
        sceneMeshes,
        sceneGeometries: sceneGeometries.size,
        sceneMaterials: sceneMaterials.size,
        rendererGeometries: renderer.renderer.info.memory.geometries,
        rendererTextures: renderer.renderer.info.memory.textures,
      },
    };
  });

  assert.equal(first.state.rendererBackend, 'webgpu', 'canonical renderer uses WebGPU');
  assert.equal(first.rendererCanvasCount, 1, 'canonical world owns one Three renderer canvas');
  assert.equal(first.rendererCanvasIdentity, true, 'WebGPU renderer owns the canonical scene canvas');
  assert.equal(first.minimapCanvasCount, 1, 'the separate UI minimap canvas remains singular');
  assert.equal(first.population, 48, 'logical pedestrian population remains 48');
  assert.equal(first.uniqueIdentities, 48, 'all logical pedestrian identities remain unique');
  assert.equal(first.logicalSceneAttachments, 0, 'logical actors do not add scene nodes');
  assert.deepEqual(first.batch.partNames, EXPECTED_BATCH_PARTS, 'existing eleven pedestrian batches are reused');
  assert.deepEqual(first.batch.counts, [48, 48, 48, 48, 96, 96, 96, 96, 96, 96, 48]);
  assert.equal(first.batch.meshes, 11, 'exactly eleven pedestrian presentation meshes');
  assert.equal(first.batch.matricesFinite, true, 'all pedestrian instance matrices are finite');

  const segment = first.sourceSegment;
  assert.equal(segment.id, SOURCE.segmentId);
  assert.equal(segment.streetId, SOURCE.streetId);
  assert.equal(segment.streetName, 'Market Street');
  assert.equal(segment.points.length, 2, 'source corridor remains one exact segment');
  assert.deepEqual(segment.points, [SOURCE.a, SOURCE.b]);
  assertApprox(Math.hypot(
    segment.points[1].x - segment.points[0].x,
    segment.points[1].z - segment.points[0].z,
  ), SOURCE.lengthMeters, 'source segment length', 1e-9);
  assertApprox(segment.width / 2, SOURCE.roadHalfWidthMeters, 'source road half-width');
  assertApprox(segment.sidewalkLeft, 2.4, 'source left sidewalk width');

  const diagnostics = first.diagnostics;
  assert.equal(diagnostics.pass, 'market-pedestrian-life-v3');
  assert.equal(diagnostics.schemaVersion, 3);
  assert.equal(diagnostics.enabled, true);
  assert.equal(diagnostics.failure, null);
  assert.equal(diagnostics.finite, true);
  assert.deepEqual(diagnostics.source.segmentId, SOURCE.segmentId);
  assert.deepEqual(diagnostics.source.streetId, SOURCE.streetId);
  assert.equal(diagnostics.source.side, SOURCE.side);
  assertApprox(diagnostics.source.lengthMeters, SOURCE.lengthMeters, 'diagnostic source length', 1e-9);
  assertApprox(diagnostics.source.roadHalfWidthMeters, SOURCE.roadHalfWidthMeters, 'diagnostic road half-width');
  assertApprox(diagnostics.source.sidewalkOuterOffsetMeters, SOURCE.sidewalkOuterOffsetMeters,
    'diagnostic sidewalk outer edge');
  assert.equal(diagnostics.composition.contract, 'camera-independent-source-triangle-v1');
  assert.equal(diagnostics.composition.projectionVerification, 'external-matched-camera-48deg');
  assertApprox(diagnostics.composition.renderedShoulderWidthMeters, HERO_RENDERED_SHOULDER_WIDTH_METERS,
    'rendered shoulder width contract', 1e-12);
  assert.deepEqual(diagnostics.composition.longitudinalOrder,
    ['pedestrian:44', 'pedestrian:36', 'pedestrian:25'],
    'hero curb longitudinal order keeps the sitter between the walkers');
  assert.deepEqual({
    segmentId: diagnostics.composition.lamp.segmentId,
    streetId: diagnostics.composition.lamp.streetId,
    side: diagnostics.composition.lamp.side,
    sourceT: diagnostics.composition.lamp.sourceT,
    lateralOffsetMeters: diagnostics.composition.lamp.lateralOffsetMeters,
    poleRadiusMeters: diagnostics.composition.lamp.poleRadiusMeters,
  }, {
    segmentId: SOURCE.segmentId,
    streetId: SOURCE.streetId,
    side: SOURCE.side,
    sourceT: 0.5,
    lateralOffsetMeters: 4.544,
    poleRadiusMeters: 0.1,
  }, 'hero lamp is source-owned and fixed to the exact corridor');
  assert.ok(diagnostics.composition.walkerRangeMeters.every((range) => range >= 1.1186),
    'both destination walkers expose a non-trivial source path range');
  assert.ok(diagnostics.composition.walkerRangeToSitterShoulderClearanceMeters.every((clearance) => clearance > 0),
    'source path stays one shoulder width clear of the seated silhouette');
  assert.ok(diagnostics.composition.walkerRangeToLampSilhouetteClearanceMeters.every((clearance) => clearance > 0),
    'source path stays clear of the lamp pole silhouette');
  assert.ok(diagnostics.composition.minimumWalkerPairShoulderClearanceMeters > 0,
    'source walker envelopes retain a full shoulder-width pair clearance');
  assert.ok(diagnostics.composition.triangleAreaSquareMeters >= 2.5,
    `source composition triangle area ${diagnostics.composition.triangleAreaSquareMeters}`);
  assert.equal(diagnostics.source.snapshotUnchanged, true);
  assert.equal(diagnostics.logicalPedestriansBefore, 48);
  assert.equal(diagnostics.logicalPedestriansAfter, 48);
  assert.equal(diagnostics.relocated, 3);
  assert.deepEqual(diagnostics.roles, { destinationWalker: 2, benchSitter: 1 });
  assert.equal(diagnostics.donorSelection.policy, 'farthest-from-corridor-midpoint-v1');
  assert.equal(diagnostics.donorSelection.eligibility, 'preserve-eastern-quarter-v1');
  assert.deepEqual(diagnostics.donorSelection.indices, [44, 25, 36]);
  assert.equal(diagnostics.donorSelection.unique, true);
  assert.equal(diagnostics.donorSelection.origins.length, 3);
  assert.deepEqual(diagnostics.resources, {
    newSceneObjects: 0,
    newMeshes: 0,
    newGeometries: 0,
    newMaterials: 0,
    newTextures: 0,
  });
  assert.equal(diagnostics.actors.length, EXPECTED_ACTORS.length);
  diagnostics.actors.forEach((actor, index) => {
    const expected = EXPECTED_ACTORS[index];
    assert.equal(actor.id, expected.id);
    assert.equal(actor.instanceIndex, expected.instanceIndex);
    assert.equal(actor.role, expected.role);
    assert.equal(actor.partnerId, expected.partnerId);
    assert.equal(actor.poseKind, expected.poseKind, `${actor.id} presentation pose kind`);
    assert.equal(actor.behavior, expected.behavior);
    assertApprox(actor.sourceTBounds[0], expected.sourceTBounds[0], `${actor.id} source t start`, 1e-12);
    assertApprox(actor.sourceTBounds[1], expected.sourceTBounds[1], `${actor.id} source t end`, 1e-12);
    if (expected.role === 'destination-walker') {
      assertApprox(
        (actor.sourceTBounds[1] - actor.sourceTBounds[0]) * SOURCE.lengthMeters,
        EXPECTED_WALK_PATH_LENGTH_METERS[index],
        `${actor.id} source path length`,
        1e-9,
      );
    }
    assertApprox(actor.lateralOffsetMeters, expected.lateralOffsetMeters, `${actor.id} lateral offset`, 1e-12);
    assertApprox(actor.speedMetersPerSecond, expected.speedMetersPerSecond, `${actor.id} speed`, 1e-12);
    assertFiniteObject(actor.donorOrigin, `${actor.id}.donorOrigin`);
    assertFiniteObject(actor.currentPose.position, `${actor.id}.currentPose.position`);
    assert.equal(actor.currentPose.poseKind, expected.poseKind, `${actor.id} current pose kind`);
    assertFiniteObject(actor.currentPose.presentationPosition, `${actor.id}.currentPose.presentationPosition`);
    assertFiniteObject({ presentationYawRadians: actor.currentPose.presentationYawRadians },
      `${actor.id}.currentPose.presentationYawRadians`);
    const coordinates = sourceCoordinates(actor.currentPose.position);
    assert.ok(coordinates.sourceT >= actor.sourceTBounds[0] - 1e-9
      && coordinates.sourceT <= actor.sourceTBounds[1] + 1e-9, `${actor.id} stays inside source t bounds`);
    assertApprox(coordinates.sourceT, actor.currentPose.sourceT, `${actor.id} current source t`, 1e-9);
    assertApprox(coordinates.lateralOffsetMeters, actor.lateralOffsetMeters,
      `${actor.id} current lateral offset`, 1e-9);
    const groundY = diagnostics.source.sidewalkGroundStartYMeters
      + (diagnostics.source.sidewalkGroundEndYMeters - diagnostics.source.sidewalkGroundStartYMeters)
        * actor.currentPose.sourceT;
    assertApprox(actor.currentPose.sidewalkGroundY, groundY, `${actor.id} source-interpolated grounding`, 1e-9);
    assert.ok(actor.lateralOffsetMeters - ACTOR_RADIUS_METERS >= SOURCE.roadHalfWidthMeters,
      `${actor.id} rendered body clears owner asphalt`);
    assert.ok(actor.lateralOffsetMeters + ACTOR_RADIUS_METERS <= SOURCE.sidewalkOuterOffsetMeters + 1e-9,
      `${actor.id} rendered body remains inside sidewalk outer edge`);
    if (expected.role === 'bench-sitter') {
      assert.equal(actor.currentPose.state, 'seated-at-bench', `${actor.id} remains seated at the authored bench`);
      assert.equal(actor.currentPose.direction, 0, `${actor.id} seated pose has no walking direction`);
      assertApprox(actor.currentPose.sourceT, expected.sourceTBounds[0], `${actor.id} static source t`, 1e-12);
      assertApprox(actor.seatedAnchor.sourceT, EXPECTED_SITTER_SOURCE_T,
        `${actor.id} source t independently projected from the exact entity`, 1e-12);
      assertApprox(actor.seatedAnchor.lateralOffsetMeters, EXPECTED_SITTER_LATERAL_OFFSET_METERS,
        `${actor.id} lateral independently projected from the exact entity`, 1e-9);
      assertApprox(actor.currentPose.presentationYawRadians, actor.seatedAnchor.entityRootYawRadians,
        `${actor.id} rendered seated root yaw follows the logical entity`, 1e-9);
      assertApprox(actor.currentPose.presentationPosition.x, actor.seatedAnchor.entityRootPosition.x,
        `${actor.id} rendered seated root x follows the logical entity`, 1e-9);
      assertApprox(actor.currentPose.presentationPosition.y, actor.seatedAnchor.entityRootPosition.y,
        `${actor.id} rendered seated root y follows the logical entity`, 1e-9);
      assertApprox(actor.currentPose.presentationPosition.z, actor.seatedAnchor.entityRootPosition.z,
        `${actor.id} rendered seated root z follows the logical entity`, 1e-9);
      assert.ok(actor.entityPresentationAlignment.positionErrorMeters <= 1e-6,
        `${actor.id} logical/rendered position alignment ${actor.entityPresentationAlignment.positionErrorMeters}`);
      assert.ok(actor.entityPresentationAlignment.yawErrorRadians <= 1e-6,
        `${actor.id} logical/rendered yaw alignment ${actor.entityPresentationAlignment.yawErrorRadians}`);
    }
  });

  const benchPlacement = first.corridor?.placements?.find((placement) => placement.kind === 'bench'
    && Math.abs(placement.sourceT - 0.63) <= 1e-12);
  const sitter = diagnostics.actors.find((actor) => actor.role === 'bench-sitter');
  assert.ok(benchPlacement, 'authored bench placement is present for the sitter contract');
  assert.ok(sitter?.seatedAnchor, 'bench sitter exposes the authored seat anchor');
  assert.equal(sitter.seatedAnchor.sourceSegmentId, SOURCE.segmentId);
  assert.equal(sitter.seatedAnchor.sourceStreetId, SOURCE.streetId);
  assertApprox(sitter.seatedAnchor.sourceT, EXPECTED_SITTER_SOURCE_T,
    'bench sitter exact entity source t', 1e-12);
  assertApprox(sitter.seatedAnchor.lateralOffsetMeters, EXPECTED_SITTER_LATERAL_OFFSET_METERS,
    'bench sitter exact entity lateral offset', 1e-9);
  assertApprox(sitter.seatedAnchor.benchPosition.x, benchPlacement.position.x,
    'bench sitter seat x matches the logical bench', 1e-9);
  assertApprox(sitter.seatedAnchor.benchPosition.y, benchPlacement.position.y,
    'bench sitter seat y matches the logical bench', 1e-9);
  assertApprox(sitter.seatedAnchor.benchPosition.z, benchPlacement.position.z,
    'bench sitter seat z matches the logical bench', 1e-9);
  assertApprox(sitter.seatedAnchor.benchRotationRadians, benchPlacement.rotation,
    'bench sitter seat rotation matches the logical bench', 1e-9);
  assertApprox(sitter.seatedAnchor.seatSurfaceYMeters, benchPlacement.position.y + 0.5,
    'bench sitter seat surface is grounded above the authored bench', 1e-9);
  assert.equal(sitter.benchContact.mode, 'authored-seat-support-contact-v1');
  assert.equal(sitter.benchContact.collisionSemantics,
    'single-entity-anchor-authored-bench-support-contact-only-v1');
  assert.equal(sitter.benchContact.entitySeatContactAuthored, true);
  assert.equal(sitter.benchContact.otherPropContactAllowed, false);
  assert.equal(sitter.benchContact.torsoWithinSeatEnvelope, true);
  assertApprox(sitter.benchContact.verticalContactGapMeters, 0.013520146994803639,
    'bench sitter torso/seat contact gap remains authored', 1e-6);
  assert.deepEqual(sitter.benchContact.seatEnvelopeLocalMeters, EXPECTED_SEAT_ENVELOPE_LOCAL_METERS);
  assertApprox(sitter.benchContact.torsoContactEnvelopeLocalMeters.minX,
    EXPECTED_TORSO_CONTACT_ENVELOPE_LOCAL_METERS.minX, 'torso envelope minX', 1e-12);
  assertApprox(sitter.benchContact.torsoContactEnvelopeLocalMeters.maxX,
    EXPECTED_TORSO_CONTACT_ENVELOPE_LOCAL_METERS.maxX, 'torso envelope maxX', 1e-12);
  assertApprox(sitter.benchContact.torsoContactEnvelopeLocalMeters.minZ,
    EXPECTED_TORSO_CONTACT_ENVELOPE_LOCAL_METERS.minZ, 'torso envelope minZ', 1e-12);
  assertApprox(sitter.benchContact.torsoContactEnvelopeLocalMeters.maxZ,
    EXPECTED_TORSO_CONTACT_ENVELOPE_LOCAL_METERS.maxZ, 'torso envelope maxZ', 1e-12);
  assert.deepEqual(sitter.seatedPoseMatrices, {
    postTransformedExistingInstances: true,
    partBatches: 11,
    matrixInstances: 17,
    finite: true,
  }, 'bench sitter rewrites only the existing pedestrian batches');

  const corridor = first.corridor;
  assert.ok(corridor?.finite, 'v5 curb corridor diagnostics are finite');
  assert.equal(corridor.segmentId, SOURCE.segmentId);
  assert.equal(corridor.streetId, SOURCE.streetId);
  assert.equal(corridor.side, SOURCE.side);
  assert.equal(corridor.placements.length, EXPECTED_PROPS.t.length);
  corridor.placements.forEach((placement, index) => {
    assert.equal(placement.kind, EXPECTED_PROPS.kinds[index], `prop ${index} kind`);
    assert.equal(placement.logicalKind, EXPECTED_PROPS.kinds[index], `prop ${index} logical kind`);
    assert.equal(placement.presentationKind, EXPECTED_PROPS.presentationKinds[index], `prop ${index} presentation kind`);
    assertApprox(placement.sourceT, EXPECTED_PROPS.t[index], `prop ${index} source t`, 1e-12);
    assertApprox(placement.lateralOffsetMeters, EXPECTED_PROPS.lateralOffsets[index],
      `prop ${index} lateral offset`, 1e-12);
    assertApprox(placement.presentationScale, EXPECTED_PROPS.scales[index],
      `prop ${index} presentation scale`, 1e-12);
    const point = expectedPoint(EXPECTED_PROPS.t[index], EXPECTED_PROPS.lateralOffsets[index]);
    assertApprox(placement.position.x, point.x, `prop ${index} source-derived x`, 1e-9);
    assertApprox(placement.position.z, point.z, `prop ${index} source-derived z`, 1e-9);
    assertApprox(placement.effectiveCollisionRadiusMeters, EXPECTED_PROPS.effectiveCollisionRadii[index],
      `prop ${index} effective collision radius`, 1e-12);
  });

  const cameraReport = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const traffic = api.getTraffic();
    const placements = renderer.sidewalkPropDiagnostics.heroFrontages.corridor.placements;
    const firstProp = placements[0].position;
    const lastProp = placements.at(-1).position;
    const dx = lastProp.x - firstProp.x;
    const dz = lastProp.z - firstProp.z;
    const length = Math.hypot(dx, dz) || 1;
    const tx = dx / length;
    const tz = dz / length;
    const nx = -tz;
    const nz = tx;
    const midpoint = { x: (firstProp.x + lastProp.x) * 0.5, z: (firstProp.z + lastProp.z) * 0.5 };
    const terrainY = renderer.terrain.heightAt(midpoint.x, midpoint.z);
    const eye = {
      x: midpoint.x - tx * 34 + nx * 8,
      y: terrainY + 6.2,
      z: midpoint.z - tz * 34 + nz * 8,
    };
    const target = {
      x: midpoint.x + tx * 2,
      y: terrainY + 1.05,
      z: midpoint.z + tz * 2,
    };
    renderer.camera.fov = 48;
    renderer.camera.updateProjectionMatrix();
    renderer.camera.position.set(eye.x, eye.y, eye.z);
    renderer.camera.lookAt(target.x, target.y, target.z);
    renderer.controls.target.set(target.x, target.y, target.z);
    renderer.controls.update();
    renderer.controls.enabled = false;
    renderer.camera.updateMatrixWorld(true);
    document.querySelectorAll('#app > :not(#scene-canvas)').forEach((element) => {
      element.style.display = 'none';
    });
    const diagnostics = traffic.getHeroCurbLifeDiagnostics();
    const sitter = diagnostics.actors.find((actor) => actor.role === 'bench-sitter');
    const seatRoot = sitter?.currentPose?.presentationPosition;
    const seatYaw = sitter?.seatedAnchor?.entityRootYawRadians;
    const lampCandidates = (renderer.streetLampRecords || [])
      .filter((record) => record?.segmentId === 'sf-seg-308' && record?.streetId === 'sf-street-228196396')
      .sort((left, right) => {
        const leftDistance = seatRoot ? Math.hypot(left.x - seatRoot.x, left.z - seatRoot.z) : Infinity;
        const rightDistance = seatRoot ? Math.hypot(right.x - seatRoot.x, right.z - seatRoot.z) : Infinity;
        return leftDistance - rightDistance;
      });
    const nearestLamp = lampCandidates[0] || (renderer.streetLampRecords || [])
      .filter((record) => Number.isFinite(record?.x) && Number.isFinite(record?.z))
      .sort((left, right) => {
        const leftDistance = seatRoot ? Math.hypot(left.x - seatRoot.x, left.z - seatRoot.z) : Infinity;
        const rightDistance = seatRoot ? Math.hypot(right.x - seatRoot.x, right.z - seatRoot.z) : Infinity;
        return leftDistance - rightDistance;
      })[0] || null;
    const project = (actor, index) => {
      const presentation = diagnostics.actors[index]?.currentPose?.presentationPosition;
      const position = actor.group.position.clone();
      if (presentation) position.set(presentation.x, presentation.y, presentation.z);
      const point = position.project(renderer.camera);
      return {
        x: (point.x * 0.5 + 0.5) * innerWidth,
        y: (-point.y * 0.5 + 0.5) * innerHeight,
        depth: point.z,
        visible: Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1,
      };
    };
    return {
      fov: renderer.camera.fov,
      eye,
      target,
      phase: traffic.phase,
      positions: traffic.heroCurbActors.map((actor) => actor.group.position.toArray()),
      projections: traffic.heroCurbActors.map(project),
      composition: {
        seatRoot,
        seatYaw,
        lampCandidates: lampCandidates.length,
        lamp: nearestLamp,
      },
    };
  });
  assertApprox(cameraReport.fov, HERO_CAMERA_FOV_DEGREES, 'matched curb camera FOV', 1e-12);
  assert.equal(cameraReport.projections.length, 3);
  assert.ok(cameraReport.composition?.seatRoot, 'matched camera exposes the fixed seated silhouette root');
  assert.ok(Number.isFinite(cameraReport.composition.seatYaw), 'fixed seated silhouette yaw is finite');
  assert.ok(cameraReport.composition.lamp, 'matched camera resolves a fixed street-lamp pole');
  assert.ok(cameraReport.composition.lampCandidates >= 1,
    'matched camera resolves a source-owned lamp on the hero corridor');
  const expectedLamp = expectedPoint(0.5, 4.544);
  assertApprox(cameraReport.composition.lamp.x, expectedLamp.x,
    'matched camera lamp source-derived x', 1e-9);
  assertApprox(cameraReport.composition.lamp.z, expectedLamp.z,
    'matched camera lamp source-derived z', 1e-9);
  assert.equal(cameraReport.composition.lamp.side, SOURCE.side, 'matched camera lamp keeps the authored curb side');
  assert.equal(cameraReport.composition.lamp.source, 'segment-polyline',
    'matched camera lamp remains source-polyline-owned');
  assert.equal(cameraReport.composition.lamp.overlapsAsphalt, false,
    'matched camera lamp does not overlap owner asphalt');
  cameraReport.projections.forEach((projection, index) => {
    assert.equal(projection.visible, true, `actor ${index} is visible in matched camera`);
    assert.ok(projection.x >= 20 && projection.x <= 1260, `actor ${index} has horizontal screen margin`);
    assert.ok(projection.y >= 20 && projection.y <= 700, `actor ${index} has vertical screen margin`);
    assert.ok(projection.depth >= -1 && projection.depth <= 1, `actor ${index} has finite clip depth`);
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: '.qa-citygen-hero-curb-life.png' });
  await page.waitForTimeout(750);
  const motionReport = await page.evaluate(() => {
    const traffic = window.__CITYGEN__.getTraffic();
    const renderer = window.__CITYGEN__.getRenderer();
    const diagnostics = traffic.getHeroCurbLifeDiagnostics();
    const project = (actor, index) => {
      const presentation = diagnostics.actors[index]?.currentPose?.presentationPosition;
      const position = actor.group.position.clone();
      if (presentation) position.set(presentation.x, presentation.y, presentation.z);
      const point = position.project(renderer.camera);
      return {
        x: (point.x * 0.5 + 0.5) * innerWidth,
        y: (-point.y * 0.5 + 0.5) * innerHeight,
        depth: point.z,
        visible: Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1,
      };
    };
    return {
      phase: traffic.phase,
      positions: traffic.heroCurbActors.map((actor) => actor.group.position.toArray()),
      projections: traffic.heroCurbActors.map(project),
    };
  });
  motionReport.projections.forEach((projection, index) => {
    assert.equal(projection.visible, true, `actor ${index} remains visible in motion frame`);
  });
  const motionDistances = motionReport.positions.map((position, index) => {
    const before = cameraReport.positions[index];
    return Math.hypot(position[0] - before[0], position[1] - before[1], position[2] - before[2]);
  });
  assert.ok(motionDistances[0] >= 0.3, 'first destination walker visibly advances');
  assert.ok(motionDistances[1] >= 0.3, 'second destination walker visibly advances');
  assert.ok(motionReport.phase > cameraReport.phase, 'motion frame advances the shared TrafficSim phase');
  await page.screenshot({ path: '.qa-citygen-hero-curb-life-motion.png' });

  const cycle = await page.evaluate(({
    actorRadius,
    expectedActors,
    expectedProps,
    cameraComposition,
    seatedEnvelopeRadius,
    torsoContactEnvelope,
  }) => {
    const api = window.__CITYGEN__;
    const city = api.getCity();
    const renderer = api.getRenderer();
    const traffic = api.getTraffic();
    const source = city.segments.find((segment) => segment.id === 'sf-seg-308');
    const sourceBefore = JSON.stringify(source);
    const props = renderer.sidewalkPropDiagnostics.heroFrontages.corridor.placements;
    const reservedIds = new Set(['pedestrian:44', 'pedestrian:25', 'pedestrian:36']);
    const dx = source.points[1].x - source.points[0].x;
    const dz = source.points[1].z - source.points[0].z;
    const length = Math.hypot(dx, dz);
    const tx = dx / length;
    const tz = dz / length;
    const nx = -tz;
    const nz = tx;
    const sourceRoadHalfWidth = Number(source.width) * 0.5;
    const sourceSidewalkOuterOffset = sourceRoadHalfWidth + Number(source.sidewalkLeft);
    const pointAt = (sourceT, lateral) => ({
      x: source.points[0].x + (source.points[1].x - source.points[0].x) * sourceT + nx * lateral,
      z: source.points[0].z + (source.points[1].z - source.points[0].z) * sourceT + nz * lateral,
    });
    const pointSegmentDistance = (point, start, end) => {
      const sx = end.x - start.x;
      const sz = end.z - start.z;
      const lengthSquared = sx * sx + sz * sz;
      const t = lengthSquared > 0
        ? Math.max(0, Math.min(1, ((point.x - start.x) * sx + (point.z - start.z) * sz) / lengthSquared))
        : 0;
      return Math.hypot(point.x - (start.x + sx * t), point.z - (start.z + sz * t));
    };
    const segmentSegmentDistance = (leftStart, leftEnd, rightStart, rightEnd) => {
      const orient = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      const between = (value, start, end) => value >= Math.min(start, end) - 1e-9
        && value <= Math.max(start, end) + 1e-9;
      const intersects = (a, b, c, d) => {
        const oa = orient(a, b, c);
        const ob = orient(a, b, d);
        const oc = orient(c, d, a);
        const od = orient(c, d, b);
        const proper = ((oa > 1e-9 && ob < -1e-9) || (oa < -1e-9 && ob > 1e-9))
          && ((oc > 1e-9 && od < -1e-9) || (oc < -1e-9 && od > 1e-9));
        if (proper) return true;
        return (Math.abs(oa) <= 1e-9 && between(c.x, a.x, b.x) && between(c.z, a.z, b.z))
          || (Math.abs(ob) <= 1e-9 && between(d.x, a.x, b.x) && between(d.z, a.z, b.z))
          || (Math.abs(oc) <= 1e-9 && between(a.x, c.x, d.x) && between(a.z, c.z, d.z))
          || (Math.abs(od) <= 1e-9 && between(b.x, c.x, d.x) && between(b.z, c.z, d.z));
      };
      if (intersects(leftStart, leftEnd, rightStart, rightEnd)) return 0;
      return Math.min(
        pointSegmentDistance(leftStart, rightStart, rightEnd),
        pointSegmentDistance(leftEnd, rightStart, rightEnd),
        pointSegmentDistance(rightStart, leftStart, leftEnd),
        pointSegmentDistance(rightEnd, leftStart, leftEnd),
      );
    };
    const walkerContracts = expectedActors.filter((actor) => actor.role === 'destination-walker');
    if (walkerContracts.length !== 2) {
      throw new Error(`independent endpoint proof has ${walkerContracts.length} destination walkers`);
    }
    const walkerPaths = walkerContracts.map((actor) => actor.sourceTBounds.map((sourceT) => (
      pointAt(sourceT, actor.lateralOffsetMeters)
    )));
    const endpointSafety = walkerContracts.map((actor, actorIndex) => {
      const endpointReports = actor.sourceTBounds.map((sourceT, endpointIndex) => {
        const position = pointAt(sourceT, actor.lateralOffsetMeters);
        const roadClearance = position
          ? actor.lateralOffsetMeters - sourceRoadHalfWidth - actorRadius
          : -Infinity;
        const sidewalkClearance = sourceSidewalkOuterOffset - actor.lateralOffsetMeters - actorRadius;
        const propClearance = Math.min(...expectedProps.effectiveCollisionRadii.map((radius, propIndex) => (
          Math.hypot(
            position.x - pointAt(expectedProps.t[propIndex], expectedProps.lateralOffsets[propIndex]).x,
            position.z - pointAt(expectedProps.t[propIndex], expectedProps.lateralOffsets[propIndex]).z,
          ) - actorRadius - radius
        )));
        return {
          endpointIndex,
          sourceT,
          position,
          roadClearance,
          sidewalkClearance,
          propClearance,
        };
      });
      return {
        id: actor.id,
        endpointReports,
        minRoadClearance: Math.min(...endpointReports.map((report) => report.roadClearance)),
        minSidewalkClearance: Math.min(...endpointReports.map((report) => report.sidewalkClearance)),
        minPropClearance: Math.min(...endpointReports.map((report) => report.propClearance)),
        pathLengthMeters: Math.hypot(
          walkerPaths[actorIndex][1].x - walkerPaths[actorIndex][0].x,
          walkerPaths[actorIndex][1].z - walkerPaths[actorIndex][0].z,
        ),
      };
    });
    const independentPathPropClearance = Math.min(...walkerPaths.flatMap((path) => expectedProps.effectiveCollisionRadii.map((radius, propIndex) => (
      pointSegmentDistance(pointAt(expectedProps.t[propIndex], expectedProps.lateralOffsets[propIndex]), path[0], path[1])
        - actorRadius - radius
    ))));
    const independentPathPairClearance = segmentSegmentDistance(
      walkerPaths[0][0], walkerPaths[0][1], walkerPaths[1][0], walkerPaths[1][1],
    ) - actorRadius * 2;
    const independentPathRoadClearance = Math.min(...walkerContracts.map((actor) => (
      actor.lateralOffsetMeters - sourceRoadHalfWidth - actorRadius
    )));
    const independentPathSidewalkClearance = Math.min(...walkerContracts.map((actor) => (
      sourceSidewalkOuterOffset - actor.lateralOffsetMeters - actorRadius
    )));
    const independentEndpointPairClearance = Math.min(...walkerPaths[0].flatMap((left) => walkerPaths[1].map((right) => (
      Math.hypot(left.x - right.x, left.z - right.z) - actorRadius * 2
    ))));
    const independentSourceEnvelope = {
      endpointSafety,
      pathLengthMeters: endpointSafety.map((report) => report.pathLengthMeters),
      minRoadClearanceMeters: independentPathRoadClearance,
      minSidewalkClearanceMeters: independentPathSidewalkClearance,
      minPropClearanceMeters: independentPathPropClearance,
      minPathPairClearanceMeters: independentPathPairClearance,
      minEndpointPairClearanceMeters: independentEndpointPairClearance,
    };
    const resourceSignature = () => {
      const geometries = new Set();
      const materials = new Set();
      let meshes = 0;
      renderer.scene.traverse((object) => {
        if (!object.isMesh) return;
        meshes += 1;
        if (object.geometry) geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (material) materials.add(material);
        }
      });
      return {
        meshes,
        geometries: geometries.size,
        materials: materials.size,
        rendererGeometries: renderer.renderer.info.memory.geometries,
        rendererTextures: renderer.renderer.info.memory.textures,
      };
    };
    const coordinates = (position) => {
      const px = position.x - source.points[0].x;
      const pz = position.z - source.points[0].z;
      return {
        sourceT: (px * tx + pz * tz) / length,
        lateral: px * nx + pz * nz,
      };
    };
    const supportBench = props.find((prop) => prop.kind === 'bench'
      && Math.abs(prop.sourceT - 0.63) <= 1e-12);
    if (!supportBench) throw new Error('independent seated proof cannot resolve the designated support bench');
    const worldToBenchLocal = (position) => {
      const cos = Math.cos(supportBench.rotation);
      const sin = Math.sin(supportBench.rotation);
      const dx = position.x - supportBench.position.x;
      const dz = position.z - supportBench.position.z;
      return {
        x: dx * cos - dz * sin,
        z: dx * sin + dz * cos,
      };
    };
    const normalizeAngle = (value) => Math.atan2(Math.sin(value), Math.cos(value));
    const multiply4 = (left, right) => {
      const result = Array(16).fill(0);
      for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
          let value = 0;
          for (let term = 0; term < 4; term += 1) {
            value += left[term * 4 + row] * right[column * 4 + term];
          }
          result[column * 4 + row] = value;
        }
      }
      return result;
    };
    // writeHeroCurbSeatedPose authors this exact local torso transform before
    // writing the existing instanced batch. Keeping the inverse here makes the
    // QA proof independent of copied diagnostics.presentationPosition/yaw.
    const authoredTorsoLocal = [
      1, 0, 0, 0,
      0, Math.cos(0.08), Math.sin(0.08), 0,
      0, -Math.sin(0.08), Math.cos(0.08), 0,
      0, 0.78, -0.015, 1,
    ];
    const authoredTorsoInverse = [
      1, 0, 0, 0,
      0, Math.cos(0.08), -Math.sin(0.08), 0,
      0, Math.sin(0.08), Math.cos(0.08), 0,
      0, -Math.cos(0.08) * 0.78 + Math.sin(0.08) * 0.015,
      Math.sin(0.08) * 0.78 + Math.cos(0.08) * 0.015, 1,
    ];
    const seatedMatrixReport = () => {
      const batch = traffic.pedestrianBatch;
      const sitterIndex = 36;
      const matrices = [];
      let finite = true;
      let matrixInstances = 0;
      for (const [partName, mesh] of Object.entries(batch.parts)) {
        const instancesPerPedestrian = mesh.userData.instancesPerPedestrian || 1;
        for (let partIndex = 0; partIndex < instancesPerPedestrian; partIndex += 1) {
          const instanceIndex = sitterIndex * instancesPerPedestrian + partIndex;
          const values = Array.from(mesh.instanceMatrix.array.slice(instanceIndex * 16, instanceIndex * 16 + 16));
          finite = finite && values.length === 16 && values.every(Number.isFinite);
          matrices.push({ partName, instanceIndex, values });
          matrixInstances += 1;
        }
      }
      const torso = matrices.find(({ partName }) => partName === 'torso');
      const torsoCenter = torso ? { x: torso.values[12], y: torso.values[13], z: torso.values[14] } : null;
      const torsoCenterLocal = torsoCenter ? worldToBenchLocal(torsoCenter) : null;
      const torsoGeometry = batch.parts.torso.geometry?.attributes?.position?.array;
      let torsoBottomY = Infinity;
      if (torso && torsoGeometry) {
        for (let vertex = 0; vertex < torsoGeometry.length; vertex += 3) {
          const x = torso.values[0] * torsoGeometry[vertex]
            + torso.values[4] * torsoGeometry[vertex + 1]
            + torso.values[8] * torsoGeometry[vertex + 2]
            + torso.values[12];
          const y = torso.values[1] * torsoGeometry[vertex]
            + torso.values[5] * torsoGeometry[vertex + 1]
            + torso.values[9] * torsoGeometry[vertex + 2]
            + torso.values[13];
          const z = torso.values[2] * torsoGeometry[vertex]
            + torso.values[6] * torsoGeometry[vertex + 1]
            + torso.values[10] * torsoGeometry[vertex + 2]
            + torso.values[14];
          finite = finite && [x, y, z].every(Number.isFinite);
          torsoBottomY = Math.min(torsoBottomY, y);
        }
      }
      const sitter = traffic.pedestrians[sitterIndex];
      const logical = sitter?.group?.position;
      const logicalYaw = sitter?.group?.rotation?.y;
      const expectedRootMatrix = logical && Number.isFinite(logicalYaw) ? [
        Math.cos(logicalYaw), 0, -Math.sin(logicalYaw), 0,
        0, 1, 0, 0,
        Math.sin(logicalYaw), 0, Math.cos(logicalYaw), 0,
        logical.x, logical.y, logical.z, 1,
      ] : null;
      const expectedTorsoMatrix = expectedRootMatrix
        ? multiply4(expectedRootMatrix, authoredTorsoLocal)
        : null;
      const expectedTorsoStorageMatrix = expectedTorsoMatrix?.map((value) => Math.fround(value)) || null;
      const torsoMatrixError = torso && expectedTorsoStorageMatrix
        ? Math.max(...torso.values.map((value, index) => Math.abs(value - expectedTorsoStorageMatrix[index])))
        : Infinity;
      const reconstructedRootMatrix = torso ? multiply4(torso.values, authoredTorsoInverse) : null;
      const expectedStoredRootMatrix = expectedTorsoStorageMatrix
        ? multiply4(expectedTorsoStorageMatrix, authoredTorsoInverse)
        : null;
      const reconstructedRootPosition = reconstructedRootMatrix ? {
        x: reconstructedRootMatrix[12],
        y: reconstructedRootMatrix[13],
        z: reconstructedRootMatrix[14],
      } : null;
      const canonicalVisibleRoot = reconstructedRootPosition ? {
        x: Math.fround(reconstructedRootPosition.x),
        y: Math.fround(reconstructedRootPosition.y),
        z: Math.fround(reconstructedRootPosition.z),
      } : null;
      const canonicalLogicalRoot = expectedStoredRootMatrix ? {
        x: Math.fround(expectedStoredRootMatrix[12]),
        y: Math.fround(expectedStoredRootMatrix[13]),
        z: Math.fround(expectedStoredRootMatrix[14]),
      } : null;
      // InstancedMesh stores world translations as Float32. Compare the
      // reconstructed visible root in that exact storage domain, while also
      // reporting the raw inverse residual for precision diagnostics.
      const rootPositionError = canonicalVisibleRoot && canonicalLogicalRoot
        ? Math.hypot(
          canonicalVisibleRoot.x - canonicalLogicalRoot.x,
          canonicalVisibleRoot.y - canonicalLogicalRoot.y,
          canonicalVisibleRoot.z - canonicalLogicalRoot.z,
        )
        : Infinity;
      const rawRootPositionError = reconstructedRootPosition && logical
        ? Math.hypot(
          reconstructedRootPosition.x - logical.x,
          reconstructedRootPosition.y - logical.y,
          reconstructedRootPosition.z - logical.z,
        )
        : Infinity;
      const reconstructedYaw = reconstructedRootMatrix
        ? normalizeAngle(Math.atan2(reconstructedRootMatrix[8], reconstructedRootMatrix[0]))
        : NaN;
      const expectedStoredYaw = expectedStoredRootMatrix
        ? normalizeAngle(Math.atan2(expectedStoredRootMatrix[8], expectedStoredRootMatrix[0]))
        : NaN;
      const rootYawError = Number.isFinite(expectedStoredYaw) && Number.isFinite(reconstructedYaw)
        ? Math.abs(normalizeAngle(expectedStoredYaw - reconstructedYaw))
        : Infinity;
      const supportSeatSurfaceY = supportBench.position.y + 0.5;
      return {
        finite,
        matrixInstances,
        torsoCenter,
        torsoCenterLocal,
        torsoBottomY,
        supportSeatSurfaceY,
        torsoContactGapMeters: torsoBottomY - supportSeatSurfaceY,
        rootPositionError,
        rawRootPositionError,
        rootYawError,
        torsoMatrixError,
        reconstructedRootPosition,
        logicalPosition: logical ? logical.toArray() : null,
        logicalYaw,
        reconstructedYaw,
      };
    };
    const resourcesBefore = resourceSignature();
    renderer.renderer.setAnimationLoop(null);
    const rotateLocal = (root, yaw, local) => ({
      x: root.x + local.x * Math.cos(yaw) + local.z * Math.sin(yaw),
      y: root.y + local.y,
      z: root.z - local.x * Math.sin(yaw) + local.z * Math.cos(yaw),
    });
    const projectWorld = (point) => {
      const vector = traffic.heroCurbActors[0].group.position.clone();
      vector.set(point.x, point.y, point.z).project(renderer.camera);
      return {
        x: (vector.x * 0.5 + 0.5) * innerWidth,
        y: (-vector.y * 0.5 + 0.5) * innerHeight,
        depth: vector.z,
        visible: Math.abs(vector.x) <= 1 && Math.abs(vector.y) <= 1 && Math.abs(vector.z) <= 1,
      };
    };
    const screenDistance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);
    const screenPointSegmentDistance = (point, start, end) => {
      const sx = end.x - start.x;
      const sy = end.y - start.y;
      const lengthSquared = sx * sx + sy * sy;
      const t = lengthSquared > 0
        ? Math.max(0, Math.min(1, ((point.x - start.x) * sx + (point.y - start.y) * sy) / lengthSquared))
        : 0;
      return Math.hypot(point.x - (start.x + sx * t), point.y - (start.y + sy * t));
    };
    const screenTriangleArea = (a, b, c) => Math.abs(
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    ) * 0.5;
    const seatRoot = cameraComposition?.seatRoot;
    const seatYaw = Number(cameraComposition?.seatYaw);
    const seatSilhouetteWorld = [
      rotateLocal(seatRoot, seatYaw, { x: -0.14, y: 0.06, z: 0.59 }),
      rotateLocal(seatRoot, seatYaw, { x: -0.39, y: 0.97, z: 0 }),
      rotateLocal(seatRoot, seatYaw, { x: 0, y: 1.2, z: 0.015 }),
      rotateLocal(seatRoot, seatYaw, { x: 0.39, y: 0.97, z: 0 }),
      rotateLocal(seatRoot, seatYaw, { x: 0.14, y: 0.06, z: 0.59 }),
    ];
    const seatCenterWorld = rotateLocal(seatRoot, seatYaw, { x: 0, y: 0.86, z: 0.08 });
    const seatSilhouetteScreen = seatSilhouetteWorld.map(projectWorld);
    const seatCenterScreen = projectWorld(seatCenterWorld);
    const seatRadiusPx = Math.max(...seatSilhouetteScreen.map((point) => screenDistance(point, seatCenterScreen)));
    const seatShoulderWidthPx = screenDistance(seatSilhouetteScreen[1], seatSilhouetteScreen[3]);
    const lampRecord = cameraComposition?.lamp;
    const lampRoadLift = Number(city.meta?.streetDesign?.roadLift ?? 0.5);
    const lampGroundY = renderer.terrain.heightAt(lampRecord.x, lampRecord.z) + lampRoadLift + 0.04;
    const lampBaseScreen = projectWorld({ x: lampRecord.x, y: lampGroundY, z: lampRecord.z });
    const lampTopScreen = projectWorld({ x: lampRecord.x, y: lampGroundY + 5.4, z: lampRecord.z });
    const actorScreenMetrics = (actor, index) => {
      const root = actor.group.position;
      const centerWorld = { x: root.x, y: root.y + 0.86, z: root.z };
      const centerScreen = projectWorld(centerWorld);
      const yaw = actor.group.rotation.y;
      const shoulderLeft = projectWorld(rotateLocal(root, yaw, { x: -0.39, y: 0.97, z: 0 }));
      const shoulderRight = projectWorld(rotateLocal(root, yaw, { x: 0.39, y: 0.97, z: 0 }));
      const shoulderWidthPx = screenDistance(shoulderLeft, shoulderRight);
      const requiredShoulderWidthPx = Math.max(shoulderWidthPx, seatShoulderWidthPx);
      const seatClearancePx = Math.min(...seatSilhouetteScreen.map((point, silhouetteIndex) => (
        screenPointSegmentDistance(
          centerScreen,
          point,
          seatSilhouetteScreen[(silhouetteIndex + 1) % seatSilhouetteScreen.length],
        )
      )));
      const lampClearancePx = screenPointSegmentDistance(centerScreen, lampBaseScreen, lampTopScreen);
      return {
        index,
        centerWorld,
        centerScreen,
        shoulderWidthPx,
        requiredShoulderWidthPx,
        seatClearancePx,
        lampClearancePx,
        seatMarginPx: seatClearancePx - requiredShoulderWidthPx,
        lampMarginPx: lampClearancePx - requiredShoulderWidthPx,
      };
    };
    let minPairDistanceMeters = Infinity;
    let minSidewalkBandClearanceMeters = Infinity;
    let minPropClearanceMeters = Infinity;
    let minSitterNonSupportPropClearanceMeters = Infinity;
    let minSitterRoadClearanceMeters = Infinity;
    let minSitterSidewalkClearanceMeters = Infinity;
    let minBenchDistanceMeters = Infinity;
    let maxBenchDistanceMeters = 0;
    let minPresentationSeatDistanceMeters = Infinity;
    let maxPresentationSeatDistanceMeters = 0;
    let maxSeatContactGapMeters = 0;
    let minSeatedMatrixContactGapMeters = Infinity;
    let maxSeatedRootPositionErrorMeters = 0;
    let maxSeatedRootRawQuantizationErrorMeters = 0;
    let maxSeatedRootYawErrorRadians = 0;
    let maxSeatedTorsoMatrixError = 0;
    let minSeatedTorsoContactLocalClearanceMeters = Infinity;
    let seatedMatrixSamples = 0;
    let maxGroundingErrorMeters = 0;
    let maxSourceBoundViolationMeters = 0;
    let maxSitterSourceTError = 0;
    let maxSitterLateralErrorMeters = 0;
    let maxAcceleratedStepMeters = 0;
    const minObservedSourceT = [Infinity, Infinity];
    const maxObservedSourceT = [-Infinity, -Infinity];
    let minCameraSeatClearancePx = Infinity;
    let minCameraLampClearancePx = Infinity;
    let minCameraSeatMarginPx = Infinity;
    let minCameraLampMarginPx = Infinity;
    let minTriangleAreaPixelsSquared = Infinity;
    let minRepresentativeTriangleAreaPixelsSquared = Infinity;
    let cameraSamples = 0;
    const representativeCameraSamples = [];
    const states = traffic.heroCurbActors.map(() => new Set());
    let previousPositions = traffic.heroCurbActors.map((actor) => actor.group.position.clone());
    for (let frame = 0; frame < 1680; frame += 1) {
      traffic.update(1 / 60);
      const diagnostics = traffic.getHeroCurbLifeDiagnostics();
      const actors = traffic.heroCurbActors;
      minPairDistanceMeters = Math.min(
        minPairDistanceMeters,
        actors[0].group.position.distanceTo(actors[1].group.position),
      );
      diagnostics.actors.forEach((actor, index) => {
        const pose = actor.currentPose;
        maxAcceleratedStepMeters = Math.max(
          maxAcceleratedStepMeters,
          traffic.heroCurbActors[index].group.position.distanceTo(previousPositions[index]),
        );
        const sourcePose = coordinates(traffic.heroCurbActors[index].group.position);
        if (index < 2) {
          minObservedSourceT[index] = Math.min(minObservedSourceT[index], sourcePose.sourceT);
          maxObservedSourceT[index] = Math.max(maxObservedSourceT[index], sourcePose.sourceT);
        }
        if (index === 2) {
          maxSitterSourceTError = Math.max(
            maxSitterSourceTError,
            Math.abs(sourcePose.sourceT - expectedActors[2].sourceTBounds[0]),
          );
          maxSitterLateralErrorMeters = Math.max(
            maxSitterLateralErrorMeters,
            Math.abs(sourcePose.lateral - expectedActors[2].lateralOffsetMeters),
          );
        }
        const minimumT = actor.sourceTBounds[0];
        const maximumT = actor.sourceTBounds[1];
        const sourceViolation = Math.max(0, minimumT - sourcePose.sourceT, sourcePose.sourceT - maximumT) * length;
        maxSourceBoundViolationMeters = Math.max(maxSourceBoundViolationMeters, sourceViolation);
        minSidewalkBandClearanceMeters = Math.min(
          minSidewalkBandClearanceMeters,
          sourcePose.lateral - source.width / 2 - actorRadius,
          source.width / 2 + source.sidewalkLeft - sourcePose.lateral - actorRadius,
        );
        const expectedGround = diagnostics.source.sidewalkGroundStartYMeters
          + (diagnostics.source.sidewalkGroundEndYMeters - diagnostics.source.sidewalkGroundStartYMeters)
            * sourcePose.sourceT;
        maxGroundingErrorMeters = Math.max(
          maxGroundingErrorMeters,
          Math.abs(pose.sidewalkGroundY - expectedGround),
        );
        for (const prop of props) {
          const isSitterSupport = index === 2 && prop === supportBench;
          if (isSitterSupport) continue;
          const clearance = Math.hypot(
            pose.position.x - prop.position.x,
            pose.position.z - prop.position.z,
          ) - actorRadius - prop.effectiveCollisionRadiusMeters;
          minPropClearanceMeters = Math.min(minPropClearanceMeters, clearance);
          if (index === 2) minSitterNonSupportPropClearanceMeters = Math.min(
            minSitterNonSupportPropClearanceMeters,
            Math.hypot(pose.position.x - prop.position.x, pose.position.z - prop.position.z)
              - seatedEnvelopeRadius - prop.effectiveCollisionRadiusMeters,
          );
        }
        if (index === 2) {
          minSitterRoadClearanceMeters = Math.min(
            minSitterRoadClearanceMeters,
            sourcePose.lateral - sourceRoadHalfWidth - seatedEnvelopeRadius,
          );
          minSitterSidewalkClearanceMeters = Math.min(
            minSitterSidewalkClearanceMeters,
            sourceSidewalkOuterOffset - sourcePose.lateral - seatedEnvelopeRadius,
          );
        }
        states[index].add(pose.state);
      });
      const seatedMatrix = seatedMatrixReport();
      seatedMatrixSamples += 1;
      maxSeatedRootPositionErrorMeters = Math.max(maxSeatedRootPositionErrorMeters, seatedMatrix.rootPositionError);
      maxSeatedRootRawQuantizationErrorMeters = Math.max(
        maxSeatedRootRawQuantizationErrorMeters,
        seatedMatrix.rawRootPositionError,
      );
      maxSeatedRootYawErrorRadians = Math.max(maxSeatedRootYawErrorRadians, seatedMatrix.rootYawError);
      maxSeatedTorsoMatrixError = Math.max(maxSeatedTorsoMatrixError, seatedMatrix.torsoMatrixError);
      minSeatedMatrixContactGapMeters = Math.min(minSeatedMatrixContactGapMeters, seatedMatrix.torsoContactGapMeters);
      if (seatedMatrix.torsoCenterLocal) {
        minSeatedTorsoContactLocalClearanceMeters = Math.min(
          minSeatedTorsoContactLocalClearanceMeters,
          seatedMatrix.torsoCenterLocal.x - torsoContactEnvelope.minX,
          torsoContactEnvelope.maxX - seatedMatrix.torsoCenterLocal.x,
          seatedMatrix.torsoCenterLocal.z - torsoContactEnvelope.minZ,
          torsoContactEnvelope.maxZ - seatedMatrix.torsoCenterLocal.z,
        );
      }
      if (!seatedMatrix.finite || seatedMatrix.matrixInstances !== 17) {
        throw new Error(`seated matrix contract drift at frame ${frame}`);
      }
      const screenMetrics = actors.slice(0, 2).map((actor, index) => actorScreenMetrics(actor, index));
      screenMetrics.forEach((metrics) => {
        minCameraSeatClearancePx = Math.min(minCameraSeatClearancePx, metrics.seatClearancePx);
        minCameraLampClearancePx = Math.min(minCameraLampClearancePx, metrics.lampClearancePx);
        minCameraSeatMarginPx = Math.min(minCameraSeatMarginPx, metrics.seatMarginPx);
        minCameraLampMarginPx = Math.min(minCameraLampMarginPx, metrics.lampMarginPx);
        cameraSamples += 1;
      });
      const triangleAreaPixelsSquared = screenTriangleArea(
        screenMetrics[0].centerScreen,
        screenMetrics[1].centerScreen,
        seatCenterScreen,
      );
      minTriangleAreaPixelsSquared = Math.min(minTriangleAreaPixelsSquared, triangleAreaPixelsSquared);
      if (frame % 120 === 0) {
        minRepresentativeTriangleAreaPixelsSquared = Math.min(
          minRepresentativeTriangleAreaPixelsSquared,
          triangleAreaPixelsSquared,
        );
        representativeCameraSamples.push({
          frame,
          phase: traffic.phase,
          triangleAreaPixelsSquared,
          seatMarginsPx: screenMetrics.map((metrics) => metrics.seatMarginPx),
          lampMarginsPx: screenMetrics.map((metrics) => metrics.lampMarginPx),
        });
      }
      previousPositions = traffic.heroCurbActors.map((actor) => actor.group.position.clone());
      const waiter = diagnostics.actors[2].currentPose.position;
      const bench = props.find((prop) => prop.kind === 'bench');
      const benchDistance = Math.hypot(waiter.x - bench.position.x, waiter.z - bench.position.z);
      minBenchDistanceMeters = Math.min(minBenchDistanceMeters, benchDistance);
      maxBenchDistanceMeters = Math.max(maxBenchDistanceMeters, benchDistance);
      const sitterPose = diagnostics.actors[2].currentPose.presentationPosition;
      const presentationSeatDistance = Math.hypot(
        sitterPose.x - bench.position.x,
        sitterPose.z - bench.position.z,
      );
      minPresentationSeatDistanceMeters = Math.min(minPresentationSeatDistanceMeters, presentationSeatDistance);
      maxPresentationSeatDistanceMeters = Math.max(maxPresentationSeatDistanceMeters, presentationSeatDistance);
      maxSeatContactGapMeters = Math.max(
        maxSeatContactGapMeters,
        Math.abs(diagnostics.actors[2].benchContact.verticalContactGapMeters),
      );
    }
    const diagnostics = traffic.getHeroCurbLifeDiagnostics();
    return {
      diagnostics,
      resourcesBefore,
      resourcesAfter: resourceSignature(),
      sourceUnchanged: JSON.stringify(source) === sourceBefore,
      minPairDistanceMeters,
      minSidewalkBandClearanceMeters,
      minPropClearanceMeters,
      minSitterNonSupportPropClearanceMeters,
      minSitterRoadClearanceMeters,
      minSitterSidewalkClearanceMeters,
      minBenchDistanceMeters,
      maxBenchDistanceMeters,
      minPresentationSeatDistanceMeters,
      maxPresentationSeatDistanceMeters,
      maxSeatContactGapMeters,
      minSeatedMatrixContactGapMeters,
      maxSeatedRootPositionErrorMeters,
      maxSeatedRootRawQuantizationErrorMeters,
      maxSeatedRootYawErrorRadians,
      maxSeatedTorsoMatrixError,
      minSeatedTorsoContactLocalClearanceMeters,
      seatedMatrixSamples,
      maxGroundingErrorMeters,
      maxSourceBoundViolationMeters,
      maxSitterSourceTError,
      maxSitterLateralErrorMeters,
      maxAcceleratedStepMeters,
      independentSourceEnvelope,
      observedSourceTBounds: minObservedSourceT.map((minimum, index) => [minimum, maxObservedSourceT[index]]),
      camera: {
        lamp: lampRecord,
        seatShoulderWidthPx,
        seatSilhouetteRadiusPx: seatRadiusPx,
        minSeatClearancePx: minCameraSeatClearancePx,
        minLampClearancePx: minCameraLampClearancePx,
        minSeatMarginPx: minCameraSeatMarginPx,
        minLampMarginPx: minCameraLampMarginPx,
        minTriangleAreaPixelsSquared,
        minRepresentativeTriangleAreaPixelsSquared,
        samples: cameraSamples,
        representativeSamples: representativeCameraSamples,
      },
      states: states.map((set) => [...set].sort()),
      reservedRecycleEvents: traffic.getLocalLifeDiagnostics().events.filter((event) => reservedIds.has(event.id)),
      population: traffic.pedestrians.length,
      batchCounts: Object.values(traffic.pedestrianBatch.parts).map((mesh) => mesh.count),
    };
  }, {
    actorRadius: ACTOR_RADIUS_METERS,
    expectedActors: EXPECTED_ACTORS,
    expectedProps: EXPECTED_PROPS,
    cameraComposition: cameraReport.composition,
    seatedEnvelopeRadius: SEATED_ENVELOPE_RADIUS_METERS,
    torsoContactEnvelope: EXPECTED_TORSO_CONTACT_ENVELOPE_LOCAL_METERS,
  });

  assert.equal(cycle.sourceUnchanged, true, 'accelerated cycle never mutates source segment');
  assert.equal(cycle.population, 48, 'accelerated cycle preserves all 48 actors');
  assert.deepEqual(cycle.batchCounts, [48, 48, 48, 48, 96, 96, 96, 96, 96, 96, 48]);
  assert.deepEqual(cycle.resourcesAfter, cycle.resourcesBefore, 'full behavior cycle allocates zero render resources');
  assert.equal(cycle.reservedRecycleEvents.length, 0, 'reserved behavior actors never enter recycle events');
  const independentEnvelope = cycle.independentSourceEnvelope;
  assert.equal(independentEnvelope.endpointSafety.length, 2,
    'independent source envelope covers both moving actors');
  independentEnvelope.endpointSafety.forEach((actorEnvelope, index) => {
    assert.equal(actorEnvelope.endpointReports.length, 2,
      `walker ${index} has two independently checked source endpoints`);
    assert.ok(actorEnvelope.minRoadClearance >= 0.094,
      `walker ${index} endpoints clear owner asphalt by ${actorEnvelope.minRoadClearance}m`);
    assert.ok(actorEnvelope.minSidewalkClearance >= 0.094,
      `walker ${index} endpoints remain inside sidewalk by ${actorEnvelope.minSidewalkClearance}m`);
    assert.ok(actorEnvelope.minPropClearance >= 0.2,
      `walker ${index} endpoints clear prop envelopes by ${actorEnvelope.minPropClearance}m`);
  });
  independentEnvelope.pathLengthMeters.forEach((pathLengthMeters, index) => {
    assertApprox(pathLengthMeters, EXPECTED_WALK_PATH_LENGTH_METERS[index],
      `walker ${index} independent source path length`, 1e-9);
  });
  assert.ok(independentEnvelope.minRoadClearanceMeters >= 0.094,
    `independent path road clearance ${independentEnvelope.minRoadClearanceMeters}`);
  assert.ok(independentEnvelope.minSidewalkClearanceMeters >= 0.094,
    `independent path sidewalk clearance ${independentEnvelope.minSidewalkClearanceMeters}`);
  assert.ok(independentEnvelope.minPropClearanceMeters >= 0.2,
    `independent path prop clearance ${independentEnvelope.minPropClearanceMeters}`);
  assert.ok(independentEnvelope.minPathPairClearanceMeters >= 2.2,
    `independent full-path pair clearance ${independentEnvelope.minPathPairClearanceMeters}`);
  assert.ok(independentEnvelope.minEndpointPairClearanceMeters >= 2.2,
    `independent endpoint pair clearance ${independentEnvelope.minEndpointPairClearanceMeters}`);
  assert.ok(cycle.minPairDistanceMeters >= 2.2, `pair separation ${cycle.minPairDistanceMeters}`);
  assert.ok(cycle.minSidewalkBandClearanceMeters >= 0.094,
    `rendered bodies stay inside sidewalk with ${cycle.minSidewalkBandClearanceMeters}m clearance`);
  assert.ok(cycle.minPropClearanceMeters >= 0.2,
    `actors clear conservative prop collision envelopes by ${cycle.minPropClearanceMeters}m`);
  assert.ok(cycle.minSitterNonSupportPropClearanceMeters >= 0.2,
    `sitter clears every non-support prop by ${cycle.minSitterNonSupportPropClearanceMeters}m`);
  assert.ok(cycle.minSitterRoadClearanceMeters >= 0.3,
    `sitter seated envelope clears owner asphalt by ${cycle.minSitterRoadClearanceMeters}m`);
  assert.ok(cycle.minSitterSidewalkClearanceMeters >= 0.3,
    `sitter seated envelope remains inside sidewalk by ${cycle.minSitterSidewalkClearanceMeters}m`);
  assert.ok(cycle.minBenchDistanceMeters >= 0.2, `sitter logical root reaches only the designated bench support ${cycle.minBenchDistanceMeters}m`);
  assert.ok(cycle.maxBenchDistanceMeters <= 0.25, `sitter logical root remains at the designated bench support ${cycle.maxBenchDistanceMeters}m`);
  assert.ok(cycle.minPresentationSeatDistanceMeters <= 0.25,
    `sitter presentation root reaches the authored bench seat (${cycle.minPresentationSeatDistanceMeters}m)`);
  assert.ok(cycle.maxPresentationSeatDistanceMeters <= 0.25,
    `sitter presentation root remains on the authored bench seat (${cycle.maxPresentationSeatDistanceMeters}m)`);
  assert.ok(cycle.maxSeatContactGapMeters <= 0.02,
    `sitter authored torso-seat contact gap ${cycle.maxSeatContactGapMeters}m`);
  assert.ok(cycle.minSeatedMatrixContactGapMeters >= 0,
    `seated torso matrix does not penetrate the designated bench ${cycle.minSeatedMatrixContactGapMeters}m`);
  assert.ok(cycle.minSeatedMatrixContactGapMeters <= 0.02,
    `seated torso matrix remains in the authored contact envelope ${cycle.minSeatedMatrixContactGapMeters}m`);
  assert.ok(cycle.maxSeatedRootPositionErrorMeters <= 1e-6,
    `matrix-reconstructed logical/rendered seated root position alignment ${cycle.maxSeatedRootPositionErrorMeters}m`);
  assert.ok(cycle.maxSeatedRootRawQuantizationErrorMeters <= SEATED_MATRIX_POSITION_TOLERANCE_METERS,
    `raw seated root inverse quantization residual ${cycle.maxSeatedRootRawQuantizationErrorMeters}m`);
  assert.ok(cycle.maxSeatedRootYawErrorRadians <= 1e-6,
    `matrix-reconstructed logical/rendered seated root yaw alignment ${cycle.maxSeatedRootYawErrorRadians}rad`);
  assert.ok(cycle.maxSeatedTorsoMatrixError <= 1e-6,
    `actual torso instance matrix matches the exact logical-root torso matrix ${cycle.maxSeatedTorsoMatrixError}`);
  assert.ok(cycle.minSeatedTorsoContactLocalClearanceMeters >= -SEATED_MATRIX_CONTACT_TOLERANCE_METERS,
    `seated torso matrix remains inside the authored contact envelope ${cycle.minSeatedTorsoContactLocalClearanceMeters}m`);
  assert.equal(cycle.seatedMatrixSamples, 1680, 'seated matrix/contact envelope sampled for the full cycle');
  assert.ok(cycle.maxGroundingErrorMeters <= 1e-6, `maximum grounding error ${cycle.maxGroundingErrorMeters}`);
  assert.ok(cycle.maxSourceBoundViolationMeters <= 1e-6,
    `maximum source path bound violation ${cycle.maxSourceBoundViolationMeters}`);
  assert.ok(cycle.maxSitterSourceTError <= 1e-12,
    `sitter source t remains independently derived at ${cycle.maxSitterSourceTError}`);
  assert.ok(cycle.maxSitterLateralErrorMeters <= 1e-9,
    `sitter lateral remains independently derived at ${cycle.maxSitterLateralErrorMeters}m`);
  cycle.observedSourceTBounds.forEach(([minimum, maximum], index) => {
    const expectedBounds = EXPECTED_ACTORS[index].sourceTBounds;
    assert.ok(minimum <= expectedBounds[0] + 0.012,
      `walker ${index} samples the source envelope start (${minimum} vs ${expectedBounds[0]})`);
    assert.ok(maximum >= expectedBounds[1] - 0.012,
      `walker ${index} samples the source envelope end (${maximum} vs ${expectedBounds[1]})`);
  });
  assert.equal(cycle.camera.lamp.segmentId, SOURCE.segmentId, 'camera occlusion proof uses the authored lamp segment');
  assert.equal(cycle.camera.lamp.streetId, SOURCE.streetId, 'camera occlusion proof uses the authored lamp street');
  assert.ok(cycle.camera.samples >= 3000, `matched camera samples ${cycle.camera.samples}`);
  assert.ok(cycle.camera.minSeatMarginPx >= 0,
    `all sampled walkers clear the seated silhouette by one shoulder width (${cycle.camera.minSeatMarginPx}px)`);
  assert.ok(cycle.camera.minLampMarginPx >= 0,
    `all sampled walkers clear the lamp pole by one shoulder width (${cycle.camera.minLampMarginPx}px)`);
  assert.ok(cycle.camera.minRepresentativeTriangleAreaPixelsSquared >= HERO_MIN_TRIANGLE_AREA_PIXELS_SQUARED,
    `representative screen-space triangle area ${cycle.camera.minRepresentativeTriangleAreaPixelsSquared}px²`);
  assert.ok(cycle.camera.representativeSamples.length >= 14,
    `representative camera samples ${cycle.camera.representativeSamples.length}`);
  const walkerStates = ['turning-forward', 'turning-reverse', 'walking-forward', 'walking-reverse'];
  assert.deepEqual(cycle.states[0], walkerStates, 'first destination walker completes the full loop');
  assert.deepEqual(cycle.states[1], walkerStates, 'second destination walker completes the full loop');
  assert.deepEqual(cycle.states[2], ['seated-at-bench'], 'sitter remains in the authored seated behavior');
  assert.equal(cycle.diagnostics.continuity.teleportViolations, 0);
  assert.equal(cycle.diagnostics.continuity.yawPopViolations, 0);
  assert.ok(cycle.diagnostics.continuity.samples >= 5000,
    `continuity coverage ${cycle.diagnostics.continuity.samples} samples`);
  assert.ok(cycle.maxAcceleratedStepMeters <= 0.05,
    `maximum 1/60s position step ${cycle.maxAcceleratedStepMeters}`);
  assert.ok(cycle.diagnostics.continuity.maxYawStepRadians <= 0.13,
    `maximum continuous yaw step ${cycle.diagnostics.continuity.maxYawStepRadians}`);

  const secondDocument = await openCanonicalPage();
  const second = await secondDocument.page.evaluate(() => ({
    diagnostics: window.__CITYGEN__.getTraffic().getHeroCurbLifeDiagnostics(),
    sourceSnapshot: JSON.stringify(window.__CITYGEN__.getCity().segments.find((segment) => segment.id === 'sf-seg-308')),
  }));
  assert.deepEqual(staticDiagnostics(second.diagnostics), staticDiagnostics(first.diagnostics),
    'two fresh documents produce identical static behavior diagnostics');
  assert.equal(second.sourceSnapshot, first.sourceSnapshot, 'two fresh documents preserve identical source geometry');
  assert.deepEqual(secondDocument.errors, [], 'second fresh document has no page errors');
  await secondDocument.page.close();

  assert.deepEqual(errors, [], 'canonical behavior document has no page errors');
  console.log(JSON.stringify({
    result: 'PASS',
    url,
    source: diagnostics.source,
    actors: diagnostics.actors.map((actor) => ({
      id: actor.id,
      role: actor.role,
      poseKind: actor.poseKind,
      partnerId: actor.partnerId,
      sourceTBounds: actor.sourceTBounds,
      lateralOffsetMeters: actor.lateralOffsetMeters,
      speedMetersPerSecond: actor.speedMetersPerSecond,
    })),
    camera: {
      fov: cameraReport.fov,
      projections: cameraReport.projections,
      motionDistancesMeters: motionDistances,
    },
    cycle: {
      minPairDistanceMeters: cycle.minPairDistanceMeters,
      minSidewalkBandClearanceMeters: cycle.minSidewalkBandClearanceMeters,
      minPropClearanceMeters: cycle.minPropClearanceMeters,
      minSitterNonSupportPropClearanceMeters: cycle.minSitterNonSupportPropClearanceMeters,
      minSitterRoadClearanceMeters: cycle.minSitterRoadClearanceMeters,
      minSitterSidewalkClearanceMeters: cycle.minSitterSidewalkClearanceMeters,
      benchDistanceRangeMeters: [cycle.minBenchDistanceMeters, cycle.maxBenchDistanceMeters],
      presentationSeatDistanceRangeMeters: [
        cycle.minPresentationSeatDistanceMeters,
        cycle.maxPresentationSeatDistanceMeters,
      ],
      maxSeatContactGapMeters: cycle.maxSeatContactGapMeters,
      minSeatedMatrixContactGapMeters: cycle.minSeatedMatrixContactGapMeters,
      maxSeatedRootPositionErrorMeters: cycle.maxSeatedRootPositionErrorMeters,
      maxSeatedRootRawQuantizationErrorMeters: cycle.maxSeatedRootRawQuantizationErrorMeters,
      maxSeatedRootYawErrorRadians: cycle.maxSeatedRootYawErrorRadians,
      maxSeatedTorsoMatrixError: cycle.maxSeatedTorsoMatrixError,
      minSeatedTorsoContactLocalClearanceMeters: cycle.minSeatedTorsoContactLocalClearanceMeters,
      seatedMatrixSamples: cycle.seatedMatrixSamples,
      maxGroundingErrorMeters: cycle.maxGroundingErrorMeters,
      maxSourceBoundViolationMeters: cycle.maxSourceBoundViolationMeters,
      maxSitterSourceTError: cycle.maxSitterSourceTError,
      maxSitterLateralErrorMeters: cycle.maxSitterLateralErrorMeters,
      maxAcceleratedStepMeters: cycle.maxAcceleratedStepMeters,
      independentSourceEnvelope: cycle.independentSourceEnvelope,
      observedSourceTBounds: cycle.observedSourceTBounds,
      camera: cycle.camera,
      states: cycle.states,
      continuity: cycle.diagnostics.continuity,
    },
    screenshots: ['.qa-citygen-hero-curb-life.png', '.qa-citygen-hero-curb-life-motion.png'],
    errors,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await page.close();
  await browser.close();
}
