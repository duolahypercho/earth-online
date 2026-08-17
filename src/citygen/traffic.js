import * as THREE from 'three';
import { buildTrafficGraph, mulberry32 } from './core.js';
import {
  buildVehicle,
  buildVehicleBatch,
  registerVehicleInstance,
  writeVehicleInstance,
  commitVehicleBatch,
  buildPedestrian,
  buildPedestrianBatch,
  writePedestrianInstance,
  commitPedestrianBatch,
  SF_VEHICLE_PRESENTATION,
} from './actors.js';

// Driving model constants (meters, seconds).
const ACCEL = 2.6;          // gentle throttle
const DECEL = 5.2;          // comfortable braking toward a stop point
const FOLLOW_DECEL = 4.2;   // braking while trailing a leader
const MIN_BUMPER_GAP = 1.8; // required free space behind the leader bumper
const STOP_LINE = 4.6;      // stop line distance before the node
const SIGNAL_LOOKAHEAD = 42; // start reacting to a red below this distance
const TURN_SIGNAL_DIST = 16; // blink before the intersection
const LOCAL_LIFE_RADIUS = 120;
const LOCAL_RECYCLE_RADIUS = 240;
const LOCAL_FOCUS_SHIFT = 70;
const LOCAL_CAR_TARGET = 16;
const LOCAL_PEDESTRIAN_TARGET = 26;
const HERO_CURB_LIFE_PASS = 'market-pedestrian-life-v3';
const HERO_CURB_SOURCE = Object.freeze({
  segmentId: 'sf-seg-308',
  streetId: 'sf-street-228196396',
  side: 1,
  benchSourceT: 0.63,
  benchLateralOffsetMeters: 4.38,
  lampSourceT: 0.5,
  lampLateralOffsetMeters: 4.544,
});
const HERO_CURB_WALKERS = Object.freeze([
  Object.freeze({
    role: 'destination-walker',
    poseKind: 'walking-destination',
    sourceTBounds: Object.freeze([0.36, 0.38]),
    lateralOffsetMeters: 5.05,
    inwardAttentionYawSign: 1,
  }),
  Object.freeze({
    role: 'destination-walker',
    poseKind: 'walking-destination',
    sourceTBounds: Object.freeze([0.77, 0.79]),
    lateralOffsetMeters: 5.05,
    inwardAttentionYawSign: -1,
  }),
]);
const HERO_CURB_WALK_SPEED = 0.72;
const HERO_CURB_TURN_SECONDS = 0.85;
const HERO_CURB_ATTENTION_YAW = 0.32;
const HERO_CURB_RENDERED_SHOULDER_WIDTH_METERS = 0.78;
const HERO_CURB_LAMP_POLE_RADIUS_METERS = 0.1;
const HERO_CURB_EXPECTED_DONORS = Object.freeze([44, 25, 36]);
const HERO_CURB_SEAT = Object.freeze({
  role: 'bench-sitter',
  poseKind: 'bench-seated',
  benchLocalXMeters: 0.22,
  benchLocalZMeters: 0.02,
  seatSurfaceAbovePropMeters: 0.5,
});

export class TrafficSim {
  constructor(renderer, city, { count = 26 } = {}) {
    this.renderer = renderer;
    this.city = city;
    this.edges = buildTrafficGraph(city);
    this.group = new THREE.Group();
    this.vehicleGroup = new THREE.Group();
    this.vehicleGroup.name = 'logical-vehicles-and-batched-presentation';
    this.group.add(this.vehicleGroup);
    this.cars = [];
    this.pedestrians = [];
    this.heroCurbActors = [];
    this.heroCurbGround = null;
    this.heroCurbLifeDiagnostics = createHeroCurbLifeDiagnostics();
    this.phase = 0;
    // Cumulative arc lengths let spacing and stop logic work in meters
    // instead of segment-progress units.
    for (const edge of this.edges) {
      const cum = [0];
      for (let i = 1; i < edge.points.length; i += 1) {
        cum.push(cum[i - 1] + Math.hypot(edge.points[i].x - edge.points[i - 1].x, edge.points[i].z - edge.points[i - 1].z));
      }
      edge.cum = cum;
      edge.totalLength = cum[cum.length - 1];
    }
    this.signalById = new Map((city.signals || []).map((signal) => [signal.id, signal]));
    const random = mulberry32(Number(city.meta.seedInt || 1) + 77);
    this.random = random;
    // Keep this array lookup in the existing seeded call site so vehicle
    // class selection and placement consume precisely the same RNG sequence.
    const paint = SF_VEHICLE_PRESENTATION.civilianPaint.map((color) => `#${color.toString(16).padStart(6, '0')}`);
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    this.localLifeEnabled = realMap;
    this.localLifeTimer = 0;
    this.localLifeFocus = null;
    this.localLifeAllowVisibleRefresh = false;
    this.localLifeDiagnostics = {
      enabled: realMap,
      radius: LOCAL_LIFE_RADIUS,
      recycleRadius: LOCAL_RECYCLE_RADIUS,
      carTarget: LOCAL_CAR_TARGET,
      pedestrianTarget: LOCAL_PEDESTRIAN_TARGET,
      carRecycles: 0,
      pedestrianRecycles: 0,
      focusUpdates: 0,
      localCars: 0,
      localPedestrians: 0,
      events: [],
    };
    const trafficCount = realMap ? 42 : count;
    this.vehicleBatch = trafficCount > 0 ? buildVehicleBatch(trafficCount) : null;
    if (this.vehicleBatch) this.vehicleGroup.add(this.vehicleBatch.group);
    for (let i = 0; i < trafficCount; i += 1) {
      if (!this.edges.length) break;
      const car = this.spawnCar(this.edges[Math.floor(random() * this.edges.length)], paint[Math.floor(random() * paint.length)], random);
      if (car) this.cars.push(car);
    }
    if (this.vehicleBatch) {
      for (const car of this.cars) writeVehicleInstance(this.vehicleBatch, car);
      commitVehicleBatch(this.vehicleBatch, this.cars.length);
    }
    const pedestrianCount = realMap ? 48 : 26;
    const sidewalkPaths = this.buildSidewalkPaths(city);
    this.sidewalkPaths = sidewalkPaths;
    this.pedestrianBatch = sidewalkPaths.length ? buildPedestrianBatch(pedestrianCount) : null;
    if (this.pedestrianBatch) this.group.add(this.pedestrianBatch.group);
    for (let i = 0; i < pedestrianCount; i += 1) {
      const path = sidewalkPaths[Math.floor(random() * sidewalkPaths.length)];
      if (!path?.length) continue;
      this.pedestrians.push(this.spawnPedestrian(path, random, this.pedestrians.length));
    }
    this.stageHeroCurbLife();
    if (this.pedestrianBatch) commitPedestrianBatch(this.pedestrianBatch, this.pedestrians.length);
    this.renderer.scene.add(this.group);
  }

  dispose() {
    for (const car of this.cars) {
      car.group.traverse((object) => {
        if (!object.isMesh) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          material?.dispose?.();
        }
      });
    }
    this.renderer.scene.remove(this.group);
  }

  spawnCar(edge, color, random = Math.random) {
    const roll = random();
    const kind = roll < 0.68 ? 'sedan' : roll < 0.86 ? 'taxi' : roll < 0.95 ? 'truck' : 'bus';
    const group = buildVehicle(kind, color);
    // Try a few placements; reject ones that overlap cars already on the
    // street so traffic never starts life in a pile-up.
    let placement = null;
    for (let attempt = 0; attempt < 10 && !placement; attempt += 1) {
      const candidateEdge = attempt === 0 ? edge : this.edges[Math.floor(random() * this.edges.length)];
      const pathIndex = Math.floor(random() * Math.max(1, candidateEdge.points.length - 1));
      const segLen = candidateEdge.cum[pathIndex + 1] - candidateEdge.cum[pathIndex] || 1;
      const distance = random() * segLen;
      const arc = candidateEdge.cum[pathIndex] + distance;
      const clear = !this.cars.some((other) => {
        if (other.edge !== candidateEdge) return false;
        return Math.abs(this.edgeArc(other) - arc) < 7;
      });
      if (clear) placement = { edge: candidateEdge, pathIndex, distance };
    }
    if (!placement) return null;
    const car = {
      group,
      kind,
      color,
      dims: group.userData.rig.dims,
      edge: null,
      signal: null,
      pathIndex: 0,
      distance: 0,
      speed: 1.5 + random() * 2.5,
      maxSpeed: placement.edge.highway === 'primary' || placement.edge.highway === 'trunk' ? 12 : placement.edge.highway === 'secondary' ? 10.5 : placement.edge.highway === 'tertiary' ? 9 : 7.2,
      stopped: false,
      braking: false,
      laneOffset: 0,
      corner: null,
      nextEdge: null,
      turnSide: 0,
      leaderGap: null,
      leaderLength: 4,
      terminalTimer: 0,
    };
    this.assignEdge(car, placement.edge, placement.pathIndex, placement.distance);
    if (this.vehicleBatch) registerVehicleInstance(this.vehicleBatch, car, this.cars.length);
    this.vehicleGroup.add(group);
    return car;
  }

  assignEdge(car, edge, pathIndex = 0, distance = 0) {
    car.edge = edge;
    car.pathIndex = clamp(pathIndex, 0, Math.max(0, edge.points.length - 2));
    car.distance = distance;
    car.signal = edge.signalId ? this.signalById.get(edge.signalId) || null : null;
    car.nextEdge = null;
    car.turnSide = 0;
    car.corner = null;
    car.terminalTimer = 0;
  }

  respawnCar(car) {
    // Recycle a car stuck on a dead-end street: find a clear spot elsewhere.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const edge = this.edges[Math.floor(this.random() * this.edges.length)];
      if (!edge) return;
      const pathIndex = Math.floor(this.random() * Math.max(1, edge.points.length - 1));
      const segLen = edge.cum[pathIndex + 1] - edge.cum[pathIndex] || 1;
      const distance = this.random() * segLen;
      const arc = edge.cum[pathIndex] + distance;
      const clear = !this.cars.some((other) => other !== car && other.edge === edge
        && Math.abs(this.edgeArc(other) - arc) < 7);
      if (clear) {
        this.assignEdge(car, edge, pathIndex, distance);
        car.speed = 1 + this.random() * 2;
        car.stopped = false;
        car.braking = false;
        return;
      }
    }
  }

  spawnPedestrian(path, random = Math.random, instanceIndex = this.pedestrians.length) {
    const group = buildPedestrian(random);
    const cum = [0];
    for (let i = 1; i < path.length; i += 1) {
      cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
    }
    const total = cum[cum.length - 1] || 0.01;
    group.position.set(path[0].x, 0, path[0].z);
    const pedestrian = {
      group,
      instanceIndex,
      points: path,
      cum,
      total,
      s: random() * total,
      seg: 0,
      dir: random() < 0.5 ? 1 : -1,
      speed: 1.3 + random() * 0.9,
    };
    if (this.pedestrianBatch) writePedestrianInstance(this.pedestrianBatch, instanceIndex, pedestrian);
    return pedestrian;
  }

  buildSidewalkPaths(city) {
    const paths = [];
    for (const segment of city.segments) {
      const half = segment.width / 2 + segment.sidewalkW - 1;
      if (half <= 0.5) continue;
      const dx = segment.points[1].x - segment.points[0].x;
      const dz = segment.points[1].z - segment.points[0].z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      for (const side of [1, -1]) {
        const a = { x: segment.points[0].x + nx * half * side, z: segment.points[0].z + nz * half * side };
        const b = { x: segment.points[1].x + nx * half * side, z: segment.points[1].z + nz * half * side };
        if (Math.hypot(b.x - a.x, b.z - a.z) < 4) continue;
        paths.push([a, b]);
      }
    }
    return paths;
  }

  stageHeroCurbLife() {
    const diagnostics = createHeroCurbLifeDiagnostics();
    this.heroCurbLifeDiagnostics = diagnostics;
    const generator = this.city?.meta?.generator;
    if (!['sf-builtin', 'openstreetmap'].includes(generator)) {
      diagnostics.failure = { stage: 'source', details: 'unsupported-source' };
      return false;
    }

    const segment = (this.city.segments || []).find((candidate) => candidate.id === HERO_CURB_SOURCE.segmentId);
    const corridor = this.renderer?.sidewalkPropDiagnostics?.heroFrontages?.corridor;
    const bench = corridor?.placements?.find((placement) => placement.kind === 'bench'
      && Math.abs(placement.sourceT - HERO_CURB_SOURCE.benchSourceT) <= 1e-9);
    const lamp = this.renderer?.streetLampRecords?.find((record) => (
      record.segmentId === HERO_CURB_SOURCE.segmentId
      && record.streetId === HERO_CURB_SOURCE.streetId
      && record.side === HERO_CURB_SOURCE.side
    ));
    const sourcePoints = segment?.points;
    const sourceFinite = sourcePoints?.length === 2
      && sourcePoints.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
    if (!sourceFinite
      || segment.streetId !== HERO_CURB_SOURCE.streetId
      || !bench?.position
      || ![
        bench.position.x,
        bench.position.y,
        bench.position.z,
        bench.rotation,
        lamp?.x,
        lamp?.z,
        lamp?.lateralOffset,
      ].every(Number.isFinite)) {
      diagnostics.failure = { stage: 'source', details: 'exact-market-corridor-unavailable' };
      return false;
    }

    const sourceSnapshot = JSON.stringify(segment);
    const [a, b] = sourcePoints;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const width = Number(segment.width);
    const sidewalkWidth = Number(HERO_CURB_SOURCE.side > 0
      ? segment.sidewalkLeft ?? segment.sidewalkW
      : segment.sidewalkRight ?? segment.sidewalkW);
    if (!Number.isFinite(length) || length <= 0
      || !Number.isFinite(width) || width <= 0
      || !Number.isFinite(sidewalkWidth) || sidewalkWidth <= 0
      || this.pedestrians.length !== 48) {
      diagnostics.failure = { stage: 'contract', details: 'invalid-source-metrics-or-population' };
      return false;
    }
    const tx = dx / length;
    const tz = dz / length;
    const nx = -tz * HERO_CURB_SOURCE.side;
    const nz = tx * HERO_CURB_SOURCE.side;
    const midpoint = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
    const roadHalfWidthMeters = width * 0.5;
    const sidewalkOuterOffsetMeters = roadHalfWidthMeters + sidewalkWidth;
    const roadLiftMeters = Number(this.city.meta?.streetDesign?.roadLift ?? 0.5);
    const terrainHeightAt = (point) => (this.renderer.terrain?.heightAt
      ? this.renderer.terrain.heightAt(point.x, point.z)
      : 0);
    this.heroCurbGround = {
      startY: terrainHeightAt(a) + roadLiftMeters + 0.045,
      endY: terrainHeightAt(b) + roadLiftMeters + 0.045,
    };
    const pointAt = (sourceT, lateralOffsetMeters) => ({
      x: a.x + dx * sourceT + nx * lateralOffsetMeters,
      z: a.z + dz * sourceT + nz * lateralOffsetMeters,
    });
    const expectedBench = pointAt(HERO_CURB_SOURCE.benchSourceT, HERO_CURB_SOURCE.benchLateralOffsetMeters);
    const expectedLamp = pointAt(HERO_CURB_SOURCE.lampSourceT, HERO_CURB_SOURCE.lampLateralOffsetMeters);
    if (Math.hypot(bench.position.x - expectedBench.x, bench.position.z - expectedBench.z) > 1e-6
      || Math.hypot(lamp.x - expectedLamp.x, lamp.z - expectedLamp.z) > 1e-6
      || Math.abs(lamp.lateralOffset - HERO_CURB_SOURCE.lampLateralOffsetMeters) > 1e-9) {
      diagnostics.failure = { stage: 'contract', details: 'hero-curb-anchor-placement-drift' };
      return false;
    }

    const bounds = this.city.meta?.bounds;
    const donorLandwardMaximumX = Number(bounds?.minX) + (Number(bounds?.maxX) - Number(bounds?.minX)) * 0.75;
    if (!Number.isFinite(donorLandwardMaximumX)) {
      diagnostics.failure = { stage: 'donor-selection', details: 'invalid-source-bounds' };
      return false;
    }
    const donorCandidates = this.pedestrians.map((pedestrian) => {
      const pose = pathPositionAtArc(pedestrian.points, pedestrian.cum, pedestrian.s);
      return {
        pedestrian,
        distance: Math.max(...pedestrian.points.map((point) => (
          Math.hypot(point.x - midpoint.x, point.z - midpoint.z)
        ))),
        origin: {
          x: pose.x,
          y: this.groundY(pose.x, pose.z),
          z: pose.z,
          pathArcMeters: pedestrian.s,
          pathLengthMeters: pedestrian.total,
        },
      };
    }).filter((candidate) => candidate.origin.x <= donorLandwardMaximumX)
      .sort((left, right) => right.distance - left.distance
      || left.pedestrian.instanceIndex - right.pedestrian.instanceIndex);
    const donors = donorCandidates.slice(0, 3);
    const donorIndices = donors.map(({ pedestrian }) => pedestrian.instanceIndex);
    if (donors.length !== 3
      || donorIndices.some((index, donorIndex) => index !== HERO_CURB_EXPECTED_DONORS[donorIndex])) {
      diagnostics.failure = {
        stage: 'donor-selection',
        details: 'deterministic-donor-policy-drift',
        actualIndices: donorIndices,
      };
      return false;
    }

    for (let index = 0; index < HERO_CURB_WALKERS.length; index += 1) {
      const donor = donors[index];
      const spec = HERO_CURB_WALKERS[index];
      const path = spec.sourceTBounds.map((sourceT) => pointAt(sourceT, spec.lateralOffsetMeters));
      const total = Math.hypot(path[1].x - path[0].x, path[1].z - path[0].z);
      const travelSeconds = total / HERO_CURB_WALK_SPEED;
      this.assignHeroCurbBehavior(donor.pedestrian, donor.origin, {
        kind: 'hero-curb-life',
        role: spec.role,
        poseKind: spec.poseKind,
        partnerId: null,
        sourceTBounds: [...spec.sourceTBounds],
        lateralOffsetMeters: spec.lateralOffsetMeters,
        path,
        total,
        speedMetersPerSecond: HERO_CURB_WALK_SPEED,
        travelSeconds,
        turnSeconds: HERO_CURB_TURN_SECONDS,
        phaseOffsetSeconds: travelSeconds * (5 / 12),
        inwardAttentionYawSign: spec.inwardAttentionYawSign,
      });
    }

    const sitterDonor = donors[2];
    const benchRotationRadians = Number(bench.rotation);
    const seatCos = Math.cos(benchRotationRadians);
    const seatSin = Math.sin(benchRotationRadians);
    const seatedRoot = {
      x: bench.position.x
        + HERO_CURB_SEAT.benchLocalXMeters * seatCos
        + HERO_CURB_SEAT.benchLocalZMeters * seatSin,
      y: 0,
      z: bench.position.z
        - HERO_CURB_SEAT.benchLocalXMeters * seatSin
        + HERO_CURB_SEAT.benchLocalZMeters * seatCos,
    };
    const seatedRootFromSource = {
      sourceT: (
        (seatedRoot.x - a.x) * tx
        + (seatedRoot.z - a.z) * tz
      ) / length,
      lateralOffsetMeters: (seatedRoot.x - a.x) * nx + (seatedRoot.z - a.z) * nz,
    };
    seatedRoot.y = this.heroCurbGroundY(seatedRootFromSource.sourceT);
    const reconstructedSeatedRoot = pointAt(
      seatedRootFromSource.sourceT,
      seatedRootFromSource.lateralOffsetMeters,
    );
    const sourceProjectionErrorMeters = Math.hypot(
      reconstructedSeatedRoot.x - seatedRoot.x,
      reconstructedSeatedRoot.z - seatedRoot.z,
    );
    if (![seatedRootFromSource.sourceT, seatedRootFromSource.lateralOffsetMeters,
      seatedRoot.y, sourceProjectionErrorMeters].every(Number.isFinite)
      || seatedRootFromSource.sourceT < 0
      || seatedRootFromSource.sourceT > 1
      || seatedRootFromSource.lateralOffsetMeters < roadHalfWidthMeters
      || seatedRootFromSource.lateralOffsetMeters > sidewalkOuterOffsetMeters
      || sourceProjectionErrorMeters > 1e-9) {
      diagnostics.failure = { stage: 'seated-pose', details: 'entity-root-source-projection-invalid' };
      return false;
    }
    const seatSurfaceYMeters = bench.position.y + HERO_CURB_SEAT.seatSurfaceAbovePropMeters;
    const torsoContactEnvelopeLocalMeters = {
      minX: HERO_CURB_SEAT.benchLocalXMeters - 0.32,
      maxX: HERO_CURB_SEAT.benchLocalXMeters + 0.32,
      minZ: HERO_CURB_SEAT.benchLocalZMeters - 0.14,
      maxZ: HERO_CURB_SEAT.benchLocalZMeters + 0.14,
    };
    const seatEnvelopeLocalMeters = { minX: -0.8, maxX: 0.8, minZ: -0.31, maxZ: 0.31 };
    const torsoWithinSeatEnvelope = torsoContactEnvelopeLocalMeters.minX >= seatEnvelopeLocalMeters.minX
      && torsoContactEnvelopeLocalMeters.maxX <= seatEnvelopeLocalMeters.maxX
      && torsoContactEnvelopeLocalMeters.minZ >= seatEnvelopeLocalMeters.minZ
      && torsoContactEnvelopeLocalMeters.maxZ <= seatEnvelopeLocalMeters.maxZ;
    if (!torsoWithinSeatEnvelope) {
      diagnostics.failure = { stage: 'seated-pose', details: 'torso-outside-bench-seat-envelope' };
      return false;
    }
    const seatedAnchor = {
      sourceSegmentId: segment.id,
      sourceStreetId: segment.streetId,
      sourceT: seatedRootFromSource.sourceT,
      lateralOffsetMeters: seatedRootFromSource.lateralOffsetMeters,
      sourceProjectionErrorMeters,
      benchPosition: { x: bench.position.x, y: bench.position.y, z: bench.position.z },
      benchRotationRadians,
      localOffsetMeters: {
        x: HERO_CURB_SEAT.benchLocalXMeters,
        y: 0,
        z: HERO_CURB_SEAT.benchLocalZMeters,
      },
      entityRootPosition: seatedRoot,
      entityRootYawRadians: benchRotationRadians,
      seatSurfaceYMeters,
    };
    const benchContact = {
      mode: 'authored-seat-support-contact-v1',
      collisionSemantics: 'single-entity-anchor-authored-bench-support-contact-only-v1',
      entitySeatContactAuthored: true,
      otherPropContactAllowed: false,
      supportProp: {
        kind: bench.kind,
        ownerSegmentId: bench.ownerSegmentId,
        ownerStreetId: bench.ownerStreetId,
        sourceT: bench.sourceT,
        lateralOffsetMeters: bench.lateralOffsetMeters,
        position: { x: bench.position.x, y: bench.position.y, z: bench.position.z },
      },
      seatEnvelopeLocalMeters,
      torsoContactEnvelopeLocalMeters,
      torsoWithinSeatEnvelope,
      torsoBottomYMeters: seatedRoot.y + 0.52,
      verticalContactGapMeters: seatedRoot.y + 0.52 - seatSurfaceYMeters,
    };
    this.assignHeroCurbBehavior(sitterDonor.pedestrian, sitterDonor.origin, {
      kind: 'hero-curb-life',
      role: HERO_CURB_SEAT.role,
      poseKind: HERO_CURB_SEAT.poseKind,
      sourceTBounds: [seatedRootFromSource.sourceT, seatedRootFromSource.sourceT],
      lateralOffsetMeters: seatedRootFromSource.lateralOffsetMeters,
      path: [{ ...seatedRoot }, { ...seatedRoot }],
      total: 0,
      speedMetersPerSecond: 0,
      phaseOffsetSeconds: 0,
      benchPosition: { x: bench.position.x, y: bench.position.y, z: bench.position.z },
      seatedAnchor,
      benchContact,
    });

    const walkerMidpoints = this.heroCurbActors.slice(0, 2).map((pedestrian) => ({
      x: (pedestrian.points[0].x + pedestrian.points[1].x) * 0.5,
      z: (pedestrian.points[0].z + pedestrian.points[1].z) * 0.5,
    }));
    const walkerRangeToSitterCenterMeters = this.heroCurbActors.slice(0, 2).map((pedestrian) => (
      pointToSegmentDistance2D(seatedRoot, pedestrian.points[0], pedestrian.points[1])
    ));
    const walkerRangeToLampCenterMeters = this.heroCurbActors.slice(0, 2).map((pedestrian) => (
      pointToSegmentDistance2D(lamp, pedestrian.points[0], pedestrian.points[1])
    ));
    const minimumWalkerPairCenterDistanceMeters = Math.min(
      ...this.heroCurbActors[0].points.flatMap((left) => (
        this.heroCurbActors[1].points.map((right) => Math.hypot(left.x - right.x, left.z - right.z))
      )),
    );
    const triangleAreaSquareMeters = Math.abs(
      (walkerMidpoints[1].x - walkerMidpoints[0].x) * (seatedRoot.z - walkerMidpoints[0].z)
      - (seatedRoot.x - walkerMidpoints[0].x) * (walkerMidpoints[1].z - walkerMidpoints[0].z),
    ) * 0.5;
    diagnostics.composition = {
      contract: 'camera-independent-source-triangle-v1',
      projectionVerification: 'external-matched-camera-48deg',
      renderedShoulderWidthMeters: HERO_CURB_RENDERED_SHOULDER_WIDTH_METERS,
      longitudinalOrder: [
        `pedestrian:${donorIndices[0]}`,
        `pedestrian:${sitterDonor.pedestrian.instanceIndex}`,
        `pedestrian:${donorIndices[1]}`,
      ],
      lamp: {
        segmentId: lamp.segmentId,
        streetId: lamp.streetId,
        side: lamp.side,
        sourceT: HERO_CURB_SOURCE.lampSourceT,
        lateralOffsetMeters: HERO_CURB_SOURCE.lampLateralOffsetMeters,
        poleRadiusMeters: HERO_CURB_LAMP_POLE_RADIUS_METERS,
        position: { x: lamp.x, z: lamp.z },
      },
      walkerRangeMeters: this.heroCurbActors.slice(0, 2).map((pedestrian) => pedestrian.total),
      walkerRangeToSitterCenterMeters,
      walkerRangeToLampCenterMeters,
      walkerRangeToSitterShoulderClearanceMeters: walkerRangeToSitterCenterMeters.map((distance) => (
        distance - HERO_CURB_RENDERED_SHOULDER_WIDTH_METERS
      )),
      walkerRangeToLampSilhouetteClearanceMeters: walkerRangeToLampCenterMeters.map((distance) => (
        distance - HERO_CURB_RENDERED_SHOULDER_WIDTH_METERS * 0.5 - HERO_CURB_LAMP_POLE_RADIUS_METERS
      )),
      minimumWalkerPairCenterDistanceMeters,
      minimumWalkerPairShoulderClearanceMeters: minimumWalkerPairCenterDistanceMeters
        - HERO_CURB_RENDERED_SHOULDER_WIDTH_METERS,
      triangleAreaSquareMeters,
    };

    const sourceSnapshotUnchanged = JSON.stringify(segment) === sourceSnapshot;
    const actorRecords = this.heroCurbActors.map((pedestrian) => ({
      id: `pedestrian:${pedestrian.instanceIndex}`,
      instanceIndex: pedestrian.instanceIndex,
      role: pedestrian.heroCurbBehavior.role,
      partnerId: pedestrian.heroCurbBehavior.partnerId ?? null,
      poseKind: pedestrian.heroCurbBehavior.poseKind,
      sourceTBounds: [...pedestrian.heroCurbBehavior.sourceTBounds],
      lateralOffsetMeters: pedestrian.heroCurbBehavior.lateralOffsetMeters,
      speedMetersPerSecond: pedestrian.heroCurbBehavior.speedMetersPerSecond,
      behavior: pedestrian.heroCurbBehavior.role === 'destination-walker'
        ? 'shared-phase-destination-walk-loop'
        : 'bench-seated-idle',
      donorOrigin: { ...pedestrian.heroCurbBehavior.donorOrigin },
      ...(pedestrian.heroCurbBehavior.seatedAnchor ? {
        seatedAnchor: cloneSeatedAnchor(pedestrian.heroCurbBehavior.seatedAnchor),
        benchContact: cloneBenchContact(pedestrian.heroCurbBehavior.benchContact),
        seatedPoseMatrices: { ...pedestrian.heroCurbBehavior.seatedPoseMatrices },
        entityPresentationAlignment: { ...pedestrian.heroCurbBehavior.entityPresentationAlignment },
      } : {}),
    }));
    diagnostics.enabled = true;
    diagnostics.source = {
      segmentId: segment.id,
      streetId: segment.streetId,
      side: HERO_CURB_SOURCE.side,
      lengthMeters: length,
      roadHalfWidthMeters,
      sidewalkOuterOffsetMeters,
      sidewalkGroundStartYMeters: this.heroCurbGround.startY,
      sidewalkGroundEndYMeters: this.heroCurbGround.endY,
      benchRotationRadians,
      snapshotUnchanged: sourceSnapshotUnchanged,
    };
    diagnostics.logicalPedestriansBefore = this.pedestrians.length;
    diagnostics.logicalPedestriansAfter = this.pedestrians.length;
    diagnostics.relocated = this.heroCurbActors.length;
    diagnostics.roles = { destinationWalker: 2, benchSitter: 1 };
    diagnostics.donorSelection = {
      policy: 'farthest-from-corridor-midpoint-v1',
      eligibility: 'preserve-eastern-quarter-v1',
      landwardMaximumXMeters: donorLandwardMaximumX,
      indices: donorIndices,
      unique: new Set(donorIndices).size === donorIndices.length,
      origins: donors.map(({ pedestrian, origin, distance }) => ({
        id: `pedestrian:${pedestrian.instanceIndex}`,
        instanceIndex: pedestrian.instanceIndex,
        distanceFromCorridorMidpointMeters: distance,
        position: { ...origin },
      })),
    };
    diagnostics.actors = actorRecords;
    diagnostics.finite = sourceSnapshotUnchanged
      && diagnostics.donorSelection.unique
      && [
        diagnostics.composition.renderedShoulderWidthMeters,
        diagnostics.composition.lamp.sourceT,
        diagnostics.composition.lamp.lateralOffsetMeters,
        diagnostics.composition.lamp.poleRadiusMeters,
        ...Object.values(diagnostics.composition.lamp.position),
        ...diagnostics.composition.walkerRangeMeters,
        ...diagnostics.composition.walkerRangeToSitterCenterMeters,
        ...diagnostics.composition.walkerRangeToLampCenterMeters,
        ...diagnostics.composition.walkerRangeToSitterShoulderClearanceMeters,
        ...diagnostics.composition.walkerRangeToLampSilhouetteClearanceMeters,
        diagnostics.composition.minimumWalkerPairCenterDistanceMeters,
        diagnostics.composition.minimumWalkerPairShoulderClearanceMeters,
        diagnostics.composition.triangleAreaSquareMeters,
      ].every(Number.isFinite)
      && actorRecords.every((actor) => [
        actor.instanceIndex,
        ...actor.sourceTBounds,
        actor.lateralOffsetMeters,
        actor.speedMetersPerSecond,
        actor.donorOrigin.x,
        actor.donorOrigin.y,
        actor.donorOrigin.z,
      ].every(Number.isFinite)
        && (!actor.seatedAnchor || (
          actor.seatedPoseMatrices?.finite === true
          && actor.entityPresentationAlignment?.finite === true
          && actor.benchContact?.torsoWithinSeatEnvelope === true
          && [
            actor.seatedAnchor.sourceT,
            actor.seatedAnchor.lateralOffsetMeters,
            actor.seatedAnchor.sourceProjectionErrorMeters,
            actor.seatedAnchor.benchRotationRadians,
            actor.seatedAnchor.entityRootYawRadians,
            actor.seatedAnchor.seatSurfaceYMeters,
            ...Object.values(actor.seatedAnchor.entityRootPosition),
            actor.benchContact.verticalContactGapMeters,
            actor.entityPresentationAlignment.positionErrorMeters,
            actor.entityPresentationAlignment.yawErrorRadians,
          ].every(Number.isFinite)
        )));
    return diagnostics.finite;
  }

  assignHeroCurbBehavior(pedestrian, donorOrigin, behavior) {
    pedestrian.points = behavior.path.map((point) => ({ ...point }));
    pedestrian.cum = cumulativeLengths(pedestrian.points);
    pedestrian.total = behavior.total;
    pedestrian.s = 0;
    pedestrian.seg = 0;
    pedestrian.dir = 1;
    pedestrian.speed = behavior.speedMetersPerSecond;
    pedestrian.heroCurbBehavior = {
      ...behavior,
      path: pedestrian.points,
      donorOrigin: { ...donorOrigin },
      lastPosition: null,
      lastYaw: null,
    };
    pedestrian.group.userData.life = {
      pass: HERO_CURB_LIFE_PASS,
      role: behavior.role,
      poseKind: behavior.poseKind,
      sourceSegmentId: HERO_CURB_SOURCE.segmentId,
      sourceStreetId: HERO_CURB_SOURCE.streetId,
      reservedFromLocalLifeRecycling: true,
    };
    this.heroCurbActors.push(pedestrian);
    this.updateHeroCurbPedestrian(pedestrian, 0);
  }

  heroCurbGroundY(sourceT) {
    return this.heroCurbGround.startY
      + (this.heroCurbGround.endY - this.heroCurbGround.startY) * sourceT;
  }

  laneOffsetFor(edge) {
    if (edge.oneway === 'increasing' || edge.oneway === 'decreasing') return 0;
    if (edge.lanes <= 1) return 0;
    return edge.laneOffset || 0;
  }

  cornerArc(from, to, t) {
    if (t <= 0) return from;
    if (t >= 1) return to;
    const a = { x: from.x, z: from.z };
    const b = { x: to.x, z: to.z };
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const bulge = Math.sin(t * Math.PI) * Math.min(2.4, len * 0.12);
    return { x: mx + nx * bulge, z: mz + nz * bulge };
  }

  groundY(x, z) {
    return this.renderer.terrain?.heightAt ? this.renderer.terrain.heightAt(x, z) + 0.08 : 0.08;
  }

  edgeArc(car) {
    const points = car.edge.points;
    const index = clamp(car.pathIndex, 0, points.length - 2);
    const segLen = car.edge.cum[index + 1] - car.edge.cum[index] || 1;
    return car.edge.cum[index] + clamp(car.distance, 0, segLen);
  }

  update(delta) {
    delta = Math.max(0, delta);
    this.phase += delta;
    this.updateLocalLife(delta);
    this.updateCarSpacing();
    for (const car of this.cars) {
      if (car.controlled || !car.edge) continue;
      this.updateAiCar(car, delta);
      this.animateCar(car, delta);
    }
    for (const pedestrian of this.pedestrians) {
      this.updatePedestrian(pedestrian, delta);
    }
    if (this.vehicleBatch) {
      for (const car of this.cars) writeVehicleInstance(this.vehicleBatch, car);
      commitVehicleBatch(this.vehicleBatch, this.cars.length);
    }
    if (this.pedestrianBatch) commitPedestrianBatch(this.pedestrianBatch, this.pedestrians.length);
    if (this.localLifeFocus) this.updateLocalLifeCounts(this.localLifeFocus);
  }

  updateLocalLife(delta) {
    if (!this.localLifeEnabled || !this.renderer?.camera) return;
    this.localLifeTimer -= delta;
    const anchor = this.renderer.controls?.target || this.renderer.camera.position;
    const focus = { x: anchor.x, z: anchor.z };
    const focusMoved = !this.localLifeFocus
      || Math.hypot(focus.x - this.localLifeFocus.x, focus.z - this.localLifeFocus.z) >= LOCAL_FOCUS_SHIFT;
    if (!focusMoved && this.localLifeTimer > 0) return;
    this.localLifeTimer = 1;
    this.localLifeFocus = focus;
    this.localLifeDiagnostics.focusUpdates += 1;
    const allowVisibleDestination = this.localLifeDiagnostics.focusUpdates === 1
      || this.localLifeAllowVisibleRefresh;

    const localCars = this.cars.filter((car) => this.actorDistance(car.group, focus) <= LOCAL_LIFE_RADIUS);
    const localPedestrians = this.pedestrians
      .filter((pedestrian) => this.actorDistance(pedestrian.group, focus) <= LOCAL_LIFE_RADIUS);
    this.recycleCarsNearFocus(focus, Math.max(0, LOCAL_CAR_TARGET - localCars.length), allowVisibleDestination);
    this.recyclePedestriansNearFocus(
      focus, Math.max(0, LOCAL_PEDESTRIAN_TARGET - localPedestrians.length), allowVisibleDestination,
    );
    this.localLifeAllowVisibleRefresh = false;
    this.updateLocalLifeCounts(focus);
  }

  requestLocalLifeRefresh({ allowVisible = false } = {}) {
    if (!this.localLifeEnabled) return;
    this.localLifeFocus = null;
    this.localLifeTimer = 0;
    this.localLifeAllowVisibleRefresh = Boolean(allowVisible);
  }

  actorDistance(group, focus) {
    return Math.hypot(group.position.x - focus.x, group.position.z - focus.z);
  }

  actorIsVisible(group) {
    return this.worldPointIsVisible(group.position.x, group.position.z, group.position.y + 1);
  }

  worldPointIsVisible(x, z, y = null) {
    const camera = this.renderer?.camera;
    if (!camera) return false;
    const worldY = y ?? (this.renderer.terrain?.heightAt ? this.renderer.terrain.heightAt(x, z) + 1 : 1);
    const projected = new THREE.Vector3(x, worldY, z).project(camera);
    return projected.z >= -1 && projected.z <= 1
      && Math.abs(projected.x) <= 1.08 && Math.abs(projected.y) <= 1.08;
  }

  nearbyPlacements(paths, focus, maxDistance = LOCAL_LIFE_RADIUS - 8) {
    return paths.map((path) => {
      const points = path.points || path;
      const cum = path.cum || cumulativeLengths(points);
      const placement = nearestPointOnPath(points, cum, focus);
      return { path, points, cum, ...placement };
    }).filter((entry) => entry.distanceToFocus <= maxDistance)
      .sort((a, b) => a.distanceToFocus - b.distanceToFocus || String(a.path.id || '').localeCompare(String(b.path.id || '')));
  }

  recycleCarsNearFocus(focus, needed, allowVisibleDestination = false) {
    if (needed <= 0) return;
    const placements = this.nearbyPlacements(
      this.edges.filter((edge) => ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service'].includes(edge.highway)),
      focus,
    );
    if (!placements.length) return;
    const donors = this.cars.filter((car) => !car.controlled
      && this.actorDistance(car.group, focus) >= LOCAL_RECYCLE_RADIUS
      && !this.actorIsVisible(car.group))
      .sort((a, b) => this.actorDistance(b.group, focus) - this.actorDistance(a.group, focus));
    let placed = 0;
    for (const car of donors) {
      if (placed >= needed) break;
      let selected = null;
      for (let attempt = 0; attempt < placements.length; attempt += 1) {
        const candidate = placements[(placed * 7 + attempt) % placements.length];
        const jitter = ((placed % 5) - 2) * 5.5;
        const arc = clamp(candidate.arc + jitter, 2, Math.max(2, candidate.cum.at(-1) - 2));
        const clear = !this.cars.some((other) => other !== car && other.edge === candidate.path
          && Math.abs(this.edgeArc(other) - arc) < 8);
        const edgePosition = pathPositionAtArc(candidate.points, candidate.cum, arc);
        const visibleAfter = this.worldPointIsVisible(edgePosition.x, edgePosition.z);
        if (clear && (allowVisibleDestination || !visibleAfter)) {
          selected = { ...candidate, arc, edgePosition, visibleAfter };
          break;
        }
      }
      if (!selected) continue;
      const fromDistance = this.actorDistance(car.group, focus);
      const visibleBefore = this.actorIsVisible(car.group);
      this.assignEdge(car, selected.path, selected.edgePosition.index, selected.edgePosition.distance);
      car.speed = 2 + this.random() * 2.5;
      car.stopped = false;
      car.braking = false;
      this.localLifeDiagnostics.carRecycles += 1;
      const toDistance = Math.hypot(selected.edgePosition.x - focus.x, selected.edgePosition.z - focus.z);
      this.recordLocalLifeEvent(
        'car', this.cars.indexOf(car), fromDistance, toDistance, visibleBefore, selected.visibleAfter,
        allowVisibleDestination,
      );
      placed += 1;
    }
  }

  recyclePedestriansNearFocus(focus, needed, allowVisibleDestination = false) {
    if (needed <= 0 || !this.sidewalkPaths?.length) return;
    const placements = this.nearbyPlacements(this.sidewalkPaths, focus);
    if (!placements.length) return;
    const donors = this.pedestrians.filter((pedestrian) => !pedestrian.heroCurbBehavior
      && this.actorDistance(pedestrian.group, focus) >= LOCAL_RECYCLE_RADIUS
      && !this.actorIsVisible(pedestrian.group))
      .sort((a, b) => this.actorDistance(b.group, focus) - this.actorDistance(a.group, focus));
    let placed = 0;
    for (const pedestrian of donors) {
      if (placed >= needed) break;
      let selected = null;
      for (let attempt = 0; attempt < placements.length; attempt += 1) {
        const candidate = placements[(placed * 11 + attempt) % placements.length];
        const total = candidate.cum.at(-1) || 0.01;
        const jitter = ((placed % 7) - 3) * 2.4;
        const arc = clamp(candidate.arc + jitter, 0.5, Math.max(0.5, total - 0.5));
        const pathPosition = pathPositionAtArc(candidate.points, candidate.cum, arc);
        const visibleAfter = this.worldPointIsVisible(pathPosition.x, pathPosition.z);
        if (allowVisibleDestination || !visibleAfter) {
          selected = { ...candidate, total, arc, pathPosition, visibleAfter };
          break;
        }
      }
      if (!selected) continue;
      const fromDistance = this.actorDistance(pedestrian.group, focus);
      const visibleBefore = this.actorIsVisible(pedestrian.group);
      pedestrian.points = selected.points;
      pedestrian.cum = selected.cum;
      pedestrian.total = selected.total;
      pedestrian.s = selected.arc;
      pedestrian.seg = selected.pathPosition.index;
      this.localLifeDiagnostics.pedestrianRecycles += 1;
      const toDistance = Math.hypot(selected.pathPosition.x - focus.x, selected.pathPosition.z - focus.z);
      this.recordLocalLifeEvent(
        'pedestrian', pedestrian.instanceIndex, fromDistance, toDistance, visibleBefore, selected.visibleAfter,
        allowVisibleDestination,
      );
      placed += 1;
    }
  }

  recordLocalLifeEvent(type, index, fromDistance, toDistance, visibleBefore, visibleAfter, intentionalRefresh) {
    this.localLifeDiagnostics.events.push({
      id: `${type}:${index}`,
      fromDistance: Number(fromDistance.toFixed(2)),
      toDistance: Number(toDistance.toFixed(2)),
      visibleBefore,
      visibleAfter,
      intentionalRefresh,
      phase: Number(this.phase.toFixed(3)),
    });
    if (this.localLifeDiagnostics.events.length > 128) this.localLifeDiagnostics.events.shift();
  }

  updateLocalLifeCounts(focus) {
    this.localLifeDiagnostics.localCars = this.cars
      .filter((car) => this.actorDistance(car.group, focus) <= LOCAL_LIFE_RADIUS).length;
    this.localLifeDiagnostics.localPedestrians = this.pedestrians
      .filter((pedestrian) => this.actorDistance(pedestrian.group, focus) <= LOCAL_LIFE_RADIUS).length;
  }

  getLocalLifeDiagnostics() {
    return {
      ...this.localLifeDiagnostics,
      focus: this.localLifeFocus ? { ...this.localLifeFocus } : null,
      events: this.localLifeDiagnostics.events.map((event) => ({ ...event })),
    };
  }

  getHeroCurbLifeDiagnostics() {
    const diagnostics = this.heroCurbLifeDiagnostics;
    const actors = diagnostics.actors.map((record) => {
      const pedestrian = this.pedestrians[record.instanceIndex];
      const behavior = pedestrian?.heroCurbBehavior;
      const walk = pedestrian?.group.userData.walk;
      return {
        ...record,
        sourceTBounds: [...record.sourceTBounds],
        donorOrigin: { ...record.donorOrigin },
        ...(record.seatedAnchor ? {
          seatedAnchor: cloneSeatedAnchor(record.seatedAnchor),
          benchContact: cloneBenchContact(record.benchContact),
          seatedPoseMatrices: { ...behavior.seatedPoseMatrices },
          entityPresentationAlignment: { ...behavior.entityPresentationAlignment },
        } : {}),
        currentPose: pedestrian && behavior ? {
          poseKind: behavior.poseKind,
          position: {
            x: pedestrian.group.position.x,
            y: pedestrian.group.position.y,
            z: pedestrian.group.position.z,
          },
          presentationPosition: {
            x: pedestrian.group.position.x,
            y: pedestrian.group.position.y,
            z: pedestrian.group.position.z,
          },
          sidewalkGroundY: pedestrian.group.position.y - (walk.bobOffset || 0),
          yawRadians: pedestrian.group.rotation.y,
          presentationYawRadians: pedestrian.group.rotation.y,
          entityPresentationPositionErrorMeters:
            behavior.entityPresentationAlignment?.positionErrorMeters ?? 0,
          entityPresentationYawErrorRadians:
            behavior.entityPresentationAlignment?.yawErrorRadians ?? 0,
          sourceT: behavior.currentSourceT,
          direction: behavior.currentDirection,
          state: behavior.currentState,
          gait: walk.gait,
          posePhase: behavior.poseKind === 'bench-seated'
            ? positiveModulo(this.phase + behavior.phaseOffsetSeconds, Math.PI * 2)
            : null,
        } : null,
      };
    });
    const finite = diagnostics.finite && actors.every((actor) => actor.currentPose
      && [
        actor.currentPose.position.x,
        actor.currentPose.position.y,
        actor.currentPose.position.z,
        actor.currentPose.presentationPosition.x,
        actor.currentPose.presentationPosition.y,
        actor.currentPose.presentationPosition.z,
        actor.currentPose.sidewalkGroundY,
        actor.currentPose.yawRadians,
        actor.currentPose.presentationYawRadians,
        actor.currentPose.sourceT,
        actor.currentPose.direction,
        actor.currentPose.gait,
      ].every(Number.isFinite)
      && (actor.poseKind !== 'bench-seated' || actor.seatedPoseMatrices?.finite === true));
    return {
      ...diagnostics,
      source: diagnostics.source ? { ...diagnostics.source } : null,
      roles: { ...diagnostics.roles },
      donorSelection: {
        ...diagnostics.donorSelection,
        indices: [...diagnostics.donorSelection.indices],
        origins: diagnostics.donorSelection.origins.map((origin) => ({
          ...origin,
          position: { ...origin.position },
        })),
      },
      composition: diagnostics.composition ? {
        ...diagnostics.composition,
        longitudinalOrder: [...diagnostics.composition.longitudinalOrder],
        lamp: {
          ...diagnostics.composition.lamp,
          position: { ...diagnostics.composition.lamp.position },
        },
        walkerRangeMeters: [...diagnostics.composition.walkerRangeMeters],
        walkerRangeToSitterCenterMeters: [...diagnostics.composition.walkerRangeToSitterCenterMeters],
        walkerRangeToLampCenterMeters: [...diagnostics.composition.walkerRangeToLampCenterMeters],
        walkerRangeToSitterShoulderClearanceMeters: [
          ...diagnostics.composition.walkerRangeToSitterShoulderClearanceMeters,
        ],
        walkerRangeToLampSilhouetteClearanceMeters: [
          ...diagnostics.composition.walkerRangeToLampSilhouetteClearanceMeters,
        ],
      } : null,
      actors,
      continuity: { ...diagnostics.continuity },
      resources: { ...diagnostics.resources },
      phaseSeconds: this.phase,
      finite,
    };
  }

  getVehicleBatchDiagnostics() {
    const meshes = [];
    this.vehicleGroup.traverse((object) => {
      if (object.isMesh) meshes.push(object);
    });
    const geometries = new Set(meshes.map((mesh) => mesh.geometry));
    const materials = new Set();
    for (const mesh of meshes) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    }
    const instances = this.vehicleBatch
      ? Object.fromEntries(Object.entries(this.vehicleBatch.parts).map(([name, mesh]) => [name, mesh.count]))
      : {};
    const sfTransit = this.cars.filter((car) => car.group.userData.rig?.sfTransit).map((car) => {
      const identity = car.group.userData.rig.sfTransit;
      return {
        carIndex: this.cars.indexOf(car),
        ordinal: identity.ordinal,
        id: identity.id,
        style: identity.style,
        bodyColor: `#${identity.bodyColor.toString(16).padStart(6, '0')}`,
        cabColor: `#${identity.cabColor.toString(16).padStart(6, '0')}`,
        roofColor: `#${identity.roofColor.toString(16).padStart(6, '0')}`,
        windowColor: `#${identity.windowColor.toString(16).padStart(6, '0')}`,
        topperInstanceIndex: car.group.userData.rig.topperInstanceIndex,
        windowInstanceIndex: car.group.userData.rig.transitInstanceIndex,
      };
    });
    return {
      logicalCars: this.cars.length,
      kinds: this.cars.reduce((counts, car) => ({ ...counts, [car.kind]: (counts[car.kind] || 0) + 1 }), {}),
      meshes: meshes.length,
      instancedMeshes: meshes.filter((mesh) => mesh.isInstancedMesh).length,
      geometries: geometries.size,
      materials: materials.size,
      instances,
      sfTransit: {
        logicalInstances: sfTransit.length,
        styles: sfTransit.reduce((counts, entry) => ({
          ...counts,
          [entry.style]: (counts[entry.style] || 0) + 1,
        }), {}),
        sharedBatchParts: ['body', 'cab', 'taxiTopper', 'transitWindows'],
        identities: sfTransit,
      },
      presentation: {
        version: this.vehicleBatch?.presentation?.version ?? null,
        paletteVersion: this.vehicleBatch?.presentation?.paletteVersion ?? null,
        materialVersion: this.vehicleBatch?.presentation?.materialVersion ?? null,
        civilianPaint: this.vehicleBatch?.presentation?.civilianPaint?.map((color) => `#${color.toString(16).padStart(6, '0')}`) ?? [],
        tintedCabColor: this.vehicleBatch?.presentation?.tintedCabColor != null
          ? `#${this.vehicleBatch.presentation.tintedCabColor.toString(16).padStart(6, '0')}`
          : null,
        taxiCabColor: this.vehicleBatch?.presentation?.taxiCabColor != null
          ? `#${this.vehicleBatch.presentation.taxiCabColor.toString(16).padStart(6, '0')}`
          : null,
        truckCabPolicy: this.vehicleBatch?.presentation?.truckCabPolicy ?? null,
        materials: this.vehicleBatch
          ? Object.fromEntries(Object.entries(this.vehicleBatch.parts).map(([part, mesh]) => {
            const material = mesh.material;
            return [part, {
              name: material.name,
              color: `#${material.color.getHexString()}`,
              roughness: material.roughness,
              metalness: material.metalness,
              emissive: material.emissive ? `#${material.emissive.getHexString()}` : null,
              emissiveIntensity: material.emissiveIntensity ?? 0,
              flatShading: Boolean(material.flatShading),
              metadata: { ...material.userData.sfVehiclePresentation },
            }];
          }))
          : {},
      },
      legacyMeshEstimate: this.cars.reduce((total, car) => total + (car.kind === 'taxi' ? 19 : 18), 0),
      frustumSafe: this.vehicleBatch
        ? Object.values(this.vehicleBatch.parts).every((mesh) => mesh.frustumCulled === false)
        : true,
    };
  }

  updateAiCar(car, delta) {
    if (car.corner) {
      this.updateCorner(car, delta);
      return;
    }
    const points = car.edge.points;
    const a = points[car.pathIndex];
    const b = points[Math.min(points.length - 1, car.pathIndex + 1)];
    const segmentLength = Math.hypot(b.x - a.x, b.z - a.z) || 0.01;
    const remaining = car.edge.totalLength - this.edgeArc(car);

    // Choose the onward edge early so braking, turn speed, and blinkers all
    // know about the maneuver before the car reaches the node.
    if (!car.nextEdge && remaining < TURN_SIGNAL_DIST + 2) {
      const lastA = points[points.length - 2];
      const lastB = points[points.length - 1];
      car.nextEdge = this.chooseNextEdge(car, lastA, lastB);
      car.turnSide = car.nextEdge ? this.turnDirection(car.edge, car.nextEdge) : 0;
    }

    let target = car.maxSpeed;
    const terminus = !(car.edge.outgoing || []).length;

    if (car.nextEdge && remaining < 14) {
      const angle = this.turnAngle(car.edge, car.nextEdge);
      const turnSpeed = angle > 1.05 ? 4.0 : angle > 0.55 ? 5.6 : 7.5;
      target = Math.min(target, Math.max(turnSpeed, 2.2));
    }

    const sig = this.signalState(car);
    car.signalState = sig;
    const holdAtLine = (sig === 'red' || sig === 'yellow') && remaining <= SIGNAL_LOOKAHEAD;
    if (holdAtLine) {
      const distToStop = remaining - STOP_LINE;
      if (distToStop >= 0) {
        // Speed that lets the car brake to zero exactly at the stop line.
        const stopSpeed = Math.sqrt(Math.max(0, 2 * DECEL * Math.max(0, distToStop)));
        target = Math.min(target, distToStop < 1.4 ? Math.min(stopSpeed, 0.9) : stopSpeed);
        if (distToStop <= 0.35) target = 0;
      }
      // Already past the line: keep moving so the intersection clears.
    }
    if (terminus && remaining < 9) {
      target = Math.min(target, Math.sqrt(Math.max(0, 2 * DECEL * Math.max(0, remaining - 2.6))));
      if (remaining <= 2.9) target = 0;
    }
    if (car.leaderGap != null) {
      const clearance = car.leaderGap - (car.dims.length + car.leaderLength) / 2;
      if (clearance <= MIN_BUMPER_GAP) target = 0;
      else target = Math.min(target, Math.sqrt(2 * FOLLOW_DECEL * Math.max(0, clearance - MIN_BUMPER_GAP)) + 0.4);
    }
    // Never roll into a node whose next edge is still occupied near the
    // entry; this keeps corner entries from stacking onto each other.
    if (car.nextEdge && remaining < 16 && !this.entryClear(car.nextEdge, car)) {
      const stopSpeed = Math.sqrt(Math.max(0, 2 * DECEL * Math.max(0, remaining - 1.2)));
      target = Math.min(target, remaining < 2.2 ? 0 : stopSpeed);
    }

    const rate = target < car.speed ? DECEL : ACCEL;
    car.speed += clamp(target - car.speed, -rate * delta, rate * delta);
    if (target <= 0.02 && car.speed < 0.06) car.speed = 0;
    car.braking = target < car.speed - 0.08 || (target <= 0.02 && car.speed > 0.02);
    car.stopped = car.speed <= 0.02;

    // Dead-end streets: stop cleanly, then recycle the car elsewhere so
    // termini do not pile up into permanent queues.
    if (terminus && car.speed === 0) {
      car.terminalTimer += delta;
      if (car.terminalTimer > 4) {
        this.respawnCar(car);
        return;
      }
    } else {
      car.terminalTimer = 0;
    }

    car.distance += car.speed * delta;
    if (car.distance >= segmentLength) {
      if (car.pathIndex >= points.length - 2) {
        const next = car.nextEdge || this.chooseNextEdge(car, a, b);
        if (next && this.entryClear(next, car)) {
          const angle = this.turnAngle(car.edge, next);
          const corner = {
            from: points[points.length - 1],
            to: next.points[0],
            t: 0,
            duration: clamp(0.45 + angle * 0.5, 0.4, 1.4),
          };
          const turnSide = car.turnSide || this.turnDirection(car.edge, next);
          this.assignEdge(car, next, 0, 0);
          car.corner = corner; // assignEdge clears corner/turnSide, restore for the arc
          car.turnSide = turnSide;
        } else {
          car.distance = Math.min(car.distance, Math.max(0, segmentLength - 0.6));
          car.speed = Math.min(car.speed, 0.4);
        }
      } else {
        car.distance -= segmentLength;
        car.pathIndex += 1;
      }
    }

    if (car.corner) {
      this.updateCorner(car, delta);
      return;
    }
    const segA = points[car.pathIndex];
    const segB = points[Math.min(points.length - 1, car.pathIndex + 1)];
    const segLen = Math.hypot(segB.x - segA.x, segB.z - segA.z) || 0.01;
    const t = clamp(car.distance / segLen, 0, 1);
    const x = segA.x + (segB.x - segA.x) * t;
    const z = segA.z + (segB.z - segA.z) * t;
    const nx = -(segB.z - segA.z) / segLen;
    const nz = (segB.x - segA.x) / segLen;
    const offset = this.laneOffsetFor(car.edge);
    car.laneOffset = offset;
    car.group.position.set(x + nx * offset, this.groundY(x, z), z + nz * offset);
    car.group.rotation.y = Math.atan2(segB.x - segA.x, segB.z - segA.z);
  }

  updateCorner(car, delta) {
    const corner = car.corner;
    corner.t = Math.min(1, corner.t + delta / corner.duration);
    const p = this.cornerArc(corner.from, corner.to, corner.t);
    // Heading follows the arc tangent; when the two intersection endpoints
    // nearly coincide (edges meet on the centerline) fall back to the
    // outgoing edge's first segment so the car still rotates through the
    // turn instead of snapping.
    const ahead = this.cornerArc(corner.from, corner.to, Math.min(1, corner.t + 0.08));
    let heading;
    if (Math.hypot(ahead.x - p.x, ahead.z - p.z) > 0.05) {
      heading = Math.atan2(ahead.x - p.x, ahead.z - p.z);
    } else {
      const pts = car.edge.points;
      const q = pts[Math.min(1, pts.length - 1)];
      heading = Math.atan2(q.x - corner.to.x, q.z - corner.to.z);
    }
    let dyaw = heading - car.group.rotation.y;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    car.group.rotation.y += dyaw * clamp(delta * 8, 0, 1);
    car.group.position.set(p.x, this.groundY(p.x, p.z), p.z);
    if (corner.t >= 1) {
      car.corner = null;
      car.turnSide = 0; // maneuver finished; stop the blinker
    }
  }

  animateCar(car, delta) {
    const rig = car.group.userData.rig;
    if (!rig) return;
    const speed = car.speed || 0;
    rig.spin += (speed * delta) / 0.3;
    for (const wheel of rig.wheels) wheel.rotation.x = rig.spin;
    rig.bobTime += delta * (2.2 + speed * 0.55);
    const bobAmp = 0.01 + 0.018 * clamp(speed / 9, 0, 1);
    rig.body.position.y = Math.sin(rig.bobTime) * bobAmp;
    const leanTarget = car.corner && car.turnSide ? -car.turnSide * 0.035 : 0;
    rig.body.rotation.z += (leanTarget - rig.body.rotation.z) * clamp(delta * 6, 0, 1);
    rig.taillightMat.emissiveIntensity = car.braking ? 1.6 : speed < 0.25 ? 0.85 : 0.25;
    // Blinkers run while approaching and traversing a chosen turn.
    const nearNode = car.corner
      || (car.nextEdge && car.edge && car.edge.totalLength - this.edgeArc(car) < TURN_SIGNAL_DIST);
    const blinkOn = (this.phase * 1.9) % 1 < 0.55;
    const intensity = car.turnSide !== 0 && nearNode && blinkOn ? 1.5 : 0;
    const signals = rig.turnSignals;
    if (!signals) return;
    const active = car.turnSide > 0 ? signals.left : signals.right;
    const idle = car.turnSide > 0 ? signals.right : signals.left;
    for (const mat of active || []) mat.emissiveIntensity = intensity;
    for (const mat of idle || []) mat.emissiveIntensity = 0;
  }

  updatePedestrian(pedestrian, delta) {
    if (pedestrian.heroCurbBehavior) {
      this.updateHeroCurbPedestrian(pedestrian, delta);
      return;
    }
    const walk = pedestrian.group.userData.walk;
    pedestrian.s += pedestrian.dir * pedestrian.speed * delta;
    if (pedestrian.s >= pedestrian.total) {
      pedestrian.s = pedestrian.total;
      pedestrian.dir = -1;
    } else if (pedestrian.s <= 0) {
      pedestrian.s = 0;
      pedestrian.dir = 1;
    }
    const points = pedestrian.points;
    while (pedestrian.seg < points.length - 2 && pedestrian.s > pedestrian.cum[pedestrian.seg + 1]) pedestrian.seg += 1;
    while (pedestrian.seg > 0 && pedestrian.s < pedestrian.cum[pedestrian.seg]) pedestrian.seg -= 1;
    const a = points[pedestrian.seg];
    const b = points[Math.min(points.length - 1, pedestrian.seg + 1)];
    const segLen = pedestrian.cum[pedestrian.seg + 1] - pedestrian.cum[pedestrian.seg] || 0.01;
    const t = clamp((pedestrian.s - pedestrian.cum[pedestrian.seg]) / segLen, 0, 1);
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const y = this.groundY(x, z);
    walk.gait = Math.sin(this.phase * walk.cadence + walk.time);
    walk.bobOffset = Math.abs(walk.gait) * walk.bob;
    pedestrian.group.position.set(x, y + walk.bobOffset, z);
    const fx = pedestrian.dir > 0 ? b.x - a.x : a.x - b.x;
    const fz = pedestrian.dir > 0 ? b.z - a.z : a.z - b.z;
    pedestrian.group.rotation.y = Math.atan2(fx, fz);
    if (this.pedestrianBatch) {
      writePedestrianInstance(this.pedestrianBatch, pedestrian.instanceIndex, pedestrian);
    }
  }

  updateHeroCurbPedestrian(pedestrian, delta) {
    const behavior = pedestrian.heroCurbBehavior;
    const walk = pedestrian.group.userData.walk;
    let x;
    let y;
    let z;
    let yaw;
    let sourceT;
    let direction;
    let state;

    if (behavior.role === 'destination-walker') {
      const travel = behavior.travelSeconds;
      const turn = behavior.turnSeconds;
      const cycle = travel * 2 + turn * 2;
      const local = positiveModulo(this.phase + behavior.phaseOffsetSeconds, cycle);
      const forwardYaw = Math.atan2(
        behavior.path[1].x - behavior.path[0].x,
        behavior.path[1].z - behavior.path[0].z,
      );
      const reverseYaw = normalizeAngle(forwardYaw + Math.PI);
      const forwardAttentionYaw = normalizeAngle(
        forwardYaw + behavior.inwardAttentionYawSign * HERO_CURB_ATTENTION_YAW,
      );
      const reverseAttentionYaw = normalizeAngle(
        reverseYaw - behavior.inwardAttentionYawSign * HERO_CURB_ATTENTION_YAW,
      );
      let progress;
      if (local < travel) {
        progress = local / travel;
        yaw = forwardAttentionYaw;
        direction = 1;
        state = 'walking-forward';
      } else if (local < travel + turn) {
        progress = 1;
        const turnProgress = smoothstep01((local - travel) / turn);
        yaw = lerpAngle(forwardAttentionYaw, reverseAttentionYaw, turnProgress);
        direction = 0;
        state = 'turning-reverse';
      } else if (local < travel * 2 + turn) {
        progress = 1 - (local - travel - turn) / travel;
        yaw = reverseAttentionYaw;
        direction = -1;
        state = 'walking-reverse';
      } else {
        progress = 0;
        const turnProgress = smoothstep01((local - travel * 2 - turn) / turn);
        yaw = lerpAngle(reverseAttentionYaw, forwardAttentionYaw, turnProgress);
        direction = 0;
        state = 'turning-forward';
      }
      progress = clamp(progress, 0, 1);
      x = behavior.path[0].x + (behavior.path[1].x - behavior.path[0].x) * progress;
      z = behavior.path[0].z + (behavior.path[1].z - behavior.path[0].z) * progress;
      sourceT = behavior.sourceTBounds[0]
        + (behavior.sourceTBounds[1] - behavior.sourceTBounds[0]) * progress;
      pedestrian.s = behavior.total * progress;
      pedestrian.dir = direction || pedestrian.dir;
      walk.gait = Math.sin(this.phase * walk.cadence + walk.time);
      walk.bobOffset = Math.abs(walk.gait) * walk.bob;
      y = this.heroCurbGroundY(sourceT) + walk.bobOffset;
    } else {
      x = behavior.seatedAnchor.entityRootPosition.x;
      y = behavior.seatedAnchor.entityRootPosition.y;
      z = behavior.seatedAnchor.entityRootPosition.z;
      sourceT = behavior.sourceTBounds[0];
      pedestrian.s = 0;
      direction = 0;
      pedestrian.dir = 1;
      state = 'seated-at-bench';
      yaw = behavior.seatedAnchor.entityRootYawRadians;
      walk.gait = Math.sin(this.phase * 1.1 + walk.time) * 0.04;
      walk.bobOffset = 0;
    }

    pedestrian.group.position.set(x, y, z);
    pedestrian.group.rotation.y = yaw;
    behavior.currentSourceT = sourceT;
    behavior.currentDirection = direction;
    behavior.currentState = state;
    this.recordHeroCurbContinuity(pedestrian, delta);
    if (this.pedestrianBatch) {
      writePedestrianInstance(this.pedestrianBatch, pedestrian.instanceIndex, pedestrian);
      if (behavior.poseKind === 'bench-seated') this.writeHeroCurbSeatedPose(pedestrian);
    }
  }

  writeHeroCurbSeatedPose(pedestrian) {
    const batch = this.pedestrianBatch;
    const behavior = pedestrian.heroCurbBehavior;
    const anchor = behavior?.seatedAnchor;
    if (!batch || !anchor) return false;

    const { appearance, walk } = pedestrian.group.userData;
    const helper = batch.matrixHelper;
    const root = batch.rootHelper;
    root.position.copy(pedestrian.group.position);
    root.rotation.set(0, pedestrian.group.rotation.y, 0);
    root.scale.set(1, 1, 1);
    root.updateMatrix();
    batch.rootMatrix.copy(root.matrix);
    const positionErrorMeters = root.position.distanceTo(pedestrian.group.position);
    const yawErrorRadians = Math.abs(normalizeAngle(root.rotation.y - pedestrian.group.rotation.y));

    const writePart = (part, instanceIndex, position, scale = [1, 1, 1], rotation = [0, 0, 0]) => {
      helper.position.fromArray(position);
      helper.rotation.set(rotation[0], rotation[1], rotation[2]);
      helper.scale.fromArray(scale);
      helper.updateMatrix();
      batch.partMatrix.multiplyMatrices(batch.rootMatrix, helper.matrix);
      batch.parts[part].setMatrixAt(instanceIndex, batch.partMatrix);
    };
    const writeSegment = (part, instanceIndex, start, end) => {
      batch.start.fromArray(start);
      batch.end.fromArray(end);
      batch.direction.subVectors(batch.end, batch.start);
      const segmentLength = Math.max(0.01, batch.direction.length());
      batch.direction.multiplyScalar(1 / segmentLength);
      helper.position.copy(batch.start).add(batch.end).multiplyScalar(0.5);
      helper.quaternion.setFromUnitVectors(batch.up, batch.direction);
      helper.scale.set(1, segmentLength, 1);
      helper.updateMatrix();
      batch.partMatrix.multiplyMatrices(batch.rootMatrix, helper.matrix);
      batch.parts[part].setMatrixAt(instanceIndex, batch.partMatrix);
    };

    const index = pedestrian.instanceIndex;
    const headTurn = Math.sin(this.phase * 0.7 + walk.time) * 0.05;
    writePart('torso', index, [0, 0.78, -0.015], [1, 1, 1], [0.08, 0, 0]);
    writePart('head', index, [headTurn, 1.2, 0.015]);
    writePart('hair', index, [headTurn, 1.2, 0.015], [1, appearance.hairScale, 1]);
    writePart('face', index, [headTurn, 1.19, 0.152], [1, 1, 1], [0, headTurn * 0.8, 0]);
    writePart('shadow', index, [0, 0.008, 0.08], [1.2, 1, 0.95]);

    for (const side of [-1, 1]) {
      const pairIndex = index * 2 + (side > 0 ? 1 : 0);
      const shoulder = [side * 0.31, 0.97, 0];
      const elbow = [side * 0.34, 0.8, 0.18];
      const hand = [side * 0.22, 0.67 + (side > 0 ? headTurn * 0.35 : 0), 0.38];
      writeSegment('upperArms', pairIndex, shoulder, elbow);
      writeSegment('forearms', pairIndex, elbow, hand);
      writePart('hands', pairIndex, hand);

      const hip = [side * 0.12, 0.62, 0.02];
      const knee = [side * 0.14, 0.52, 0.44];
      const ankle = [side * 0.14, 0.12, 0.48];
      writeSegment('thighs', pairIndex, hip, knee);
      writeSegment('shins', pairIndex, knee, ankle);
      writePart('shoes', pairIndex, [side * 0.14, 0.06, 0.59]);
    }

    let finiteMatrices = true;
    let matrixInstances = 0;
    for (const mesh of Object.values(batch.parts)) {
      const instancesPerPedestrian = mesh.userData.instancesPerPedestrian || 1;
      for (let partIndex = 0; partIndex < instancesPerPedestrian; partIndex += 1) {
        const instanceIndex = index * instancesPerPedestrian + partIndex;
        mesh.getMatrixAt(instanceIndex, batch.partMatrix);
        matrixInstances += 1;
        finiteMatrices = finiteMatrices && batch.partMatrix.elements.every(Number.isFinite);
      }
    }
    behavior.seatedPoseMatrices = {
      postTransformedExistingInstances: true,
      partBatches: Object.keys(batch.parts).length,
      matrixInstances,
      finite: finiteMatrices,
    };
    behavior.entityPresentationAlignment = {
      positionErrorMeters,
      yawErrorRadians,
      finite: [positionErrorMeters, yawErrorRadians].every(Number.isFinite),
    };
    return finiteMatrices && behavior.entityPresentationAlignment.finite;
  }

  recordHeroCurbContinuity(pedestrian, delta) {
    const behavior = pedestrian.heroCurbBehavior;
    const continuity = this.heroCurbLifeDiagnostics.continuity;
    const position = pedestrian.group.position;
    const yaw = pedestrian.group.rotation.y;
    if (behavior.lastPosition && behavior.lastYaw != null && delta > 0) {
      const step = Math.hypot(
        position.x - behavior.lastPosition.x,
        position.y - behavior.lastPosition.y,
        position.z - behavior.lastPosition.z,
      );
      const yawStep = Math.abs(shortestAngle(yaw - behavior.lastYaw));
      continuity.maxStepMeters = Math.max(continuity.maxStepMeters, step);
      continuity.maxYawStepRadians = Math.max(continuity.maxYawStepRadians, yawStep);
      const linearLimit = (behavior.role === 'destination-walker' ? 1.5 : 0.4) * delta + 0.004;
      const yawLimit = 4.2 * delta + 0.01;
      if (step > linearLimit) continuity.teleportViolations += 1;
      if (yawStep > yawLimit) continuity.yawPopViolations += 1;
      continuity.samples += 1;
    }
    behavior.lastPosition = { x: position.x, y: position.y, z: position.z };
    behavior.lastYaw = yaw;
  }

  updateCarSpacing() {
    const byEdge = new Map();
    for (const car of this.cars) {
      if (car.controlled || !car.edge) continue;
      // Cars traversing the corner arc already belong to the next edge;
      // count them at its entry so followers braking into the node see them.
      const arc = car.corner ? 0 : this.edgeArc(car);
      if (!byEdge.has(car.edge)) byEdge.set(car.edge, []);
      byEdge.get(car.edge).push({ car, arc });
    }
    for (const entries of byEdge.values()) {
      entries.sort((a, b) => a.arc - b.arc);
      for (let i = 0; i < entries.length; i += 1) {
        const current = entries[i].car;
        const ahead = entries[i + 1];
        current.leaderGap = ahead ? ahead.arc - entries[i].arc : null;
        current.leaderLength = ahead ? ahead.car.dims.length : 4;
      }
    }
  }

  entryClear(edge, car) {
    const halfFollower = (car.dims.length || 4) / 2;
    for (const other of this.cars) {
      if (other === car || other.controlled || other.edge !== edge) continue;
      const otherArc = other.corner ? 0 : this.edgeArc(other);
      const otherHalf = (other.dims.length || 4) / 2;
      if (otherArc - otherHalf < halfFollower + 3.5) return false;
    }
    return true;
  }

  driveCar(car, speed, delta) {
    if (!car || !car.edge) return;
    car.braking = speed < (car.lastDriveSpeed ?? speed) - 0.08 || (this.signalBlocked(car) && speed < 1.5);
    car.lastDriveSpeed = speed;
    car.speed = speed;
    const points = car.edge.points;
    const targetIndex = Math.min(points.length - 1, car.pathIndex + 1);
    const a = points[car.pathIndex];
    const b = points[targetIndex];
    const segmentLength = Math.hypot(b.x - a.x, b.z - a.z) || 0.01;
    if (this.signalBlocked(car)) {
      const stopLine = Math.max(0, segmentLength - STOP_LINE);
      if (car.distance >= stopLine) car.distance = Math.min(car.distance, stopLine);
      else car.distance += speed * delta;
    } else {
      car.distance += speed * delta;
    }
    if (car.distance >= segmentLength) {
      if (car.pathIndex >= points.length - 2) {
        const next = this.chooseNextEdge(car, a, b);
        if (next) {
          this.assignEdge(car, next, 0, 0);
        } else {
          car.distance = Math.min(car.distance, Math.max(0, segmentLength - STOP_LINE));
        }
      } else {
        car.pathIndex += 1;
        car.distance = 0;
      }
    }
    const updated = car.edge.points[car.pathIndex];
    const next = car.edge.points[Math.min(car.edge.points.length - 1, car.pathIndex + 1)];
    const t = clamp(car.distance / (Math.hypot(next.x - updated.x, next.z - updated.z) || 0.01), 0, 1);
    const x = updated.x + (next.x - updated.x) * t;
    const z = updated.z + (next.z - updated.z) * t;
    const dx = next.x - updated.x;
    const dz = next.z - updated.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const offset = this.laneOffsetFor(car.edge);
    car.group.position.set(x + nx * offset, this.groundY(x, z), z + nz * offset);
    car.group.rotation.y = Math.atan2(next.x - updated.x, next.z - updated.z) + (car.steerYaw || 0);
    this.animateCar(car, delta);
  }

  chooseNextEdge(car, a, b) {
    const raw = car.edge.outgoing || [];
    const outgoing = raw.filter((e) => e.streetId !== car.edge.streetId || this.random() < 0.35);
    const pool = outgoing.length ? outgoing : raw;
    if (!pool.length) return null;
    const inDx = b.x - a.x;
    const inDz = b.z - a.z;
    const inLen = Math.hypot(inDx, inDz) || 1;
    let totalWeight = 0;
    const weighted = pool.map((edge) => {
      const out = edge.points[0];
      const nextP = edge.points[Math.min(1, edge.points.length - 1)];
      const outDx = nextP.x - out.x;
      const outDz = nextP.z - out.z;
      const outLen = Math.hypot(outDx, outDz) || 1;
      const dot = (inDx * outDx + inDz * outDz) / (inLen * outLen);
      let weight = 0.3;
      if (dot > 0.82) weight = 4;
      else if (dot > -0.35) weight = 1.6;
      const nextStart = edge.points[0];
      if (Math.hypot(nextStart.x - a.x, nextStart.z - a.z) < 0.5) weight *= 0.15;
      totalWeight += weight;
      return { edge, weight };
    });
    let pick = this.random() * totalWeight;
    for (const candidate of weighted) {
      pick -= candidate.weight;
      if (pick <= 0) return candidate.edge;
    }
    return weighted[weighted.length - 1].edge;
  }

  turnAngle(edge, next) {
    const pts = edge.points;
    const a = pts[pts.length - 2] || pts[0];
    const b = pts[pts.length - 1];
    const c = next.points[Math.min(1, next.points.length - 1)];
    const inDx = b.x - a.x;
    const inDz = b.z - a.z;
    const outDx = c.x - b.x;
    const outDz = c.z - b.z;
    const inLen = Math.hypot(inDx, inDz) || 1;
    const outLen = Math.hypot(outDx, outDz) || 1;
    return Math.acos(clamp((inDx * outDx + inDz * outDz) / (inLen * outLen), -1, 1));
  }

  turnDirection(edge, next) {
    const pts = edge.points;
    const a = pts[pts.length - 2] || pts[0];
    const b = pts[pts.length - 1];
    const c = next.points[Math.min(1, next.points.length - 1)];
    const inDx = b.x - a.x;
    const inDz = b.z - a.z;
    const outDx = c.x - b.x;
    const outDz = c.z - b.z;
    const inLen = Math.hypot(inDx, inDz) || 1;
    const outLen = Math.hypot(outDx, outDz) || 1;
    const sin = (inDz * outDx - inDx * outDz) / (inLen * outLen);
    if (Math.abs(sin) < 0.35) return 0;
    // +y cross product means the heading rotates from +z toward +x, which is
    // the vehicle's left side in three.js coordinates.
    return sin > 0 ? 1 : -1;
  }

  /**
   * Phase state for the car's signal, mirroring the renderer bulb math:
   * local = floor((clock + phaseOffset) / period) % 4 with red on 0-1,
   * yellow on 2, green on 3. Returns null when the edge has no signal.
   */
  signalState(car) {
    if (!car.edge?.signalId) return null;
    const signal = car.signal ?? this.city.signals.find((s) => s.id === car.edge.signalId);
    if (!signal) return null;
    const local = Math.floor((this.phase + (signal.phaseOffset || 0)) / (signal.period || 8)) % 4;
    if (local === 0 || local === 1) return 'red';
    if (local === 2) return 'yellow';
    return 'green';
  }

  signalBlocked(car) {
    return this.signalState(car) === 'red';
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function normalizeAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function shortestAngle(value) {
  return normalizeAngle(value);
}

function lerpAngle(from, to, progress) {
  return normalizeAngle(from + shortestAngle(to - from) * progress);
}

function smoothstep01(value) {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function pointToSegmentDistance2D(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const progress = lengthSquared > 0
    ? clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared, 0, 1)
    : 0;
  return Math.hypot(
    point.x - (start.x + dx * progress),
    point.z - (start.z + dz * progress),
  );
}

function cloneSeatedAnchor(anchor) {
  return {
    ...anchor,
    benchPosition: { ...anchor.benchPosition },
    localOffsetMeters: { ...anchor.localOffsetMeters },
    entityRootPosition: { ...anchor.entityRootPosition },
  };
}

function cloneBenchContact(contact) {
  return {
    ...contact,
    supportProp: {
      ...contact.supportProp,
      position: { ...contact.supportProp.position },
    },
    seatEnvelopeLocalMeters: { ...contact.seatEnvelopeLocalMeters },
    torsoContactEnvelopeLocalMeters: { ...contact.torsoContactEnvelopeLocalMeters },
  };
}

function createHeroCurbLifeDiagnostics() {
  return {
    pass: HERO_CURB_LIFE_PASS,
    schemaVersion: 3,
    enabled: false,
    source: null,
    logicalPedestriansBefore: 0,
    logicalPedestriansAfter: 0,
    relocated: 0,
    roles: { destinationWalker: 0, benchSitter: 0 },
    donorSelection: {
      policy: 'farthest-from-corridor-midpoint-v1',
      indices: [],
      unique: true,
      origins: [],
    },
    actors: [],
    composition: null,
    continuity: {
      teleportViolations: 0,
      yawPopViolations: 0,
      maxStepMeters: 0,
      maxYawStepRadians: 0,
      samples: 0,
    },
    resources: {
      newSceneObjects: 0,
      newMeshes: 0,
      newGeometries: 0,
      newMaterials: 0,
      newTextures: 0,
    },
    failure: null,
    finite: false,
  };
}

function cumulativeLengths(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  return cum;
}

function nearestPointOnPath(points, cum, focus) {
  let best = { arc: 0, distanceToFocus: Infinity };
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz || 1;
    const t = clamp(((focus.x - a.x) * dx + (focus.z - a.z) * dz) / lengthSq, 0, 1);
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const distanceToFocus = Math.hypot(x - focus.x, z - focus.z);
    if (distanceToFocus < best.distanceToFocus) {
      const segmentLength = cum[i + 1] - cum[i] || Math.sqrt(lengthSq);
      best = { arc: cum[i] + segmentLength * t, distanceToFocus };
    }
  }
  return best;
}

function pathPositionAtArc(points, cum, arc) {
  let index = 0;
  while (index < points.length - 2 && arc > cum[index + 1]) index += 1;
  const distance = clamp(arc - cum[index], 0, (cum[index + 1] - cum[index]) || 0);
  const a = points[index];
  const b = points[index + 1];
  const segmentLength = (cum[index + 1] - cum[index]) || 0.01;
  const t = clamp(distance / segmentLength, 0, 1);
  return { index, distance, x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}
