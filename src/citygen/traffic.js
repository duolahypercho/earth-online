import * as THREE from 'three';
import { buildTrafficGraph, mulberry32 } from './core.js';
import { buildVehicle, buildPedestrian } from './actors.js';

// Driving model constants (meters, seconds).
const ACCEL = 2.6;          // gentle throttle
const DECEL = 5.2;          // comfortable braking toward a stop point
const FOLLOW_DECEL = 4.2;   // braking while trailing a leader
const MIN_BUMPER_GAP = 1.8; // required free space behind the leader bumper
const STOP_LINE = 4.6;      // stop line distance before the node
const SIGNAL_LOOKAHEAD = 42; // start reacting to a red below this distance
const TURN_SIGNAL_DIST = 16; // blink before the intersection

export class TrafficSim {
  constructor(renderer, city, { count = 26 } = {}) {
    this.renderer = renderer;
    this.city = city;
    this.edges = buildTrafficGraph(city);
    this.group = new THREE.Group();
    this.cars = [];
    this.pedestrians = [];
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
    const paint = ['#d94f4a', '#e8b23a', '#4f86c8', '#3f9e8f', '#8f74c8', '#d47a3f', '#f2e9d8', '#6fbf73'];
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const trafficCount = realMap ? 42 : count;
    for (let i = 0; i < trafficCount; i += 1) {
      if (!this.edges.length) break;
      const car = this.spawnCar(this.edges[Math.floor(random() * this.edges.length)], paint[Math.floor(random() * paint.length)], random);
      if (car) this.cars.push(car);
    }
    const pedestrianCount = realMap ? 48 : 26;
    const sidewalkPaths = this.buildSidewalkPaths(city);
    for (let i = 0; i < pedestrianCount; i += 1) {
      const path = sidewalkPaths[Math.floor(random() * sidewalkPaths.length)];
      if (!path?.length) continue;
      this.pedestrians.push(this.spawnPedestrian(path, random));
    }
    this.renderer.scene.add(this.group);
  }

  dispose() {
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
    this.group.add(group);
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

  spawnPedestrian(path, random = Math.random) {
    const group = buildPedestrian(random);
    const cum = [0];
    for (let i = 1; i < path.length; i += 1) {
      cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
    }
    const total = cum[cum.length - 1] || 0.01;
    group.position.set(path[0].x, 0, path[0].z);
    this.group.add(group);
    return {
      group,
      points: path,
      cum,
      total,
      s: random() * total,
      seg: 0,
      dir: random() < 0.5 ? 1 : -1,
      speed: 1.3 + random() * 0.9,
    };
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
    this.phase += delta;
    this.updateCarSpacing();
    for (const car of this.cars) {
      if (car.controlled || !car.edge) continue;
      this.updateAiCar(car, delta);
      this.animateCar(car, delta);
    }
    for (const pedestrian of this.pedestrians) {
      this.updatePedestrian(pedestrian, delta);
    }
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
    pedestrian.group.position.set(x, y + Math.abs(Math.sin(this.phase * walk.cadence + walk.time)) * walk.bob, z);
    const fx = pedestrian.dir > 0 ? b.x - a.x : a.x - b.x;
    const fz = pedestrian.dir > 0 ? b.z - a.z : a.z - b.z;
    pedestrian.group.rotation.y = Math.atan2(fx, fz);
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
    const outgoing = raw.filter((e) => e.streetId !== car.edge.streetId || Math.random() < 0.35);
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
    let pick = Math.random() * totalWeight;
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
