import * as THREE from 'three';
import { buildTrafficGraph, mulberry32 } from './core.js';

export class TrafficSim {
  constructor(renderer, city, { count = 26 } = {}) {
    this.renderer = renderer;
    this.city = city;
    this.edges = buildTrafficGraph(city);
    this.group = new THREE.Group();
    this.cars = [];
    this.pedestrians = [];
    this.phase = 0;
    this.signalLights = [];
    const random = mulberry32(Number(city.meta.seedInt || 1) + 77);
    const paint = ['#d94f4a', '#e8b23a', '#4f86c8', '#3f9e8f', '#8f74c8', '#d47a3f', '#f2e9d8', '#6fbf73'];
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const trafficCount = realMap ? 42 : count;
    for (let i = 0; i < trafficCount; i += 1) {
      const edge = this.edges[Math.floor(random() * this.edges.length)];
      if (!edge) continue;
      const car = this.spawnCar(edge, paint[Math.floor(random() * paint.length)], random);
      this.cars.push(car);
    }
    const pedestrianCount = realMap ? 48 : 26;
    const sidewalkPaths = this.buildSidewalkPaths(city);
    for (let i = 0; i < pedestrianCount; i += 1) {
      const path = sidewalkPaths[Math.floor(random() * sidewalkPaths.length)];
      if (!path?.length) continue;
      const outfit = random() < 0.45 ? 0x79a8c9 : random() < 0.6 ? 0xd09a6f : 0xc75d8e;
      const hair = random() < 0.5 ? 0x2e241f : random() < 0.8 ? 0x6b4a2f : 0xd9c9a0;
      this.pedestrians.push(this.spawnPedestrian(path, outfit, hair, random));
    }
    this.buildSignalLightMeshes();
    this.renderer.scene.add(this.group);
  }

  dispose() {
    this.renderer.scene.remove(this.group);
    this.signalLights = [];
  }

  spawnCar(edge, color, random = Math.random) {
    const group = new THREE.Group();
    const kind = random() < 0.68 ? 'sedan' : random() < 0.86 ? 'taxi' : random() < 0.95 ? 'truck' : 'bus';
    const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.55, flatShading: true });
    const cabMaterial = new THREE.MeshStandardMaterial({ color: 0xb9d3e0, roughness: 0.2, metalness: 0.2, flatShading: true });
    const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.85 });
    const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.24, 8);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
    wheelGeo.rotateZ(Math.PI / 2);
    if (kind === 'bus') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.35, 1.7, 7.8), bodyMaterial);
      body.position.y = 1.05;
      group.add(body);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.38, 0.35, 7.82), cabMaterial);
      stripe.position.set(0, 1.02, 0);
      group.add(stripe);
      for (const [wx, wz] of [[-1.05, 2.45], [1.05, 2.45], [-1.05, -2.45], [1.05, -2.45]]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.position.set(wx, 0.3, wz);
        group.add(wheel);
      }
    } else if (kind === 'truck') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.35, 4.6), bodyMaterial);
      body.position.y = 0.92;
      group.add(body);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.8, 1.6), cabMaterial);
      cab.position.set(0, 1.18, 1.7);
      group.add(cab);
      for (const [wx, wz] of [[-0.98, 1.6], [0.98, 1.6], [-0.98, -1.7], [0.98, -1.7]]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.position.set(wx, 0.3, wz);
        group.add(wheel);
      }
    } else {
      const width = kind === 'taxi' ? 1.75 : 1.7;
      const body = new THREE.Mesh(new THREE.BoxGeometry(width, 0.62, 3.6), bodyMaterial);
      body.position.y = 0.62;
      group.add(body);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(width * 0.9, 0.5, 1.6), cabMaterial);
      cab.position.set(0, 1.12, -0.4);
      group.add(cab);
      for (const [wx, wz] of [[-width / 2, 1.1], [width / 2, 1.1], [-width / 2, -1.1], [width / 2, -1.1]]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.position.set(wx, 0.3, wz);
        group.add(wheel);
      }
      if (kind === 'taxi') {
        const roof = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.18, 0.34), darkMaterial);
        roof.position.set(0, 1.55, -0.4);
        group.add(roof);
      }
    }
    const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffe9a8, emissiveIntensity: 0.4 });
    const taillightMat = new THREE.MeshStandardMaterial({ color: 0xff4433, emissive: 0xff2a1a, emissiveIntensity: 0.25 });
    const halfW = kind === 'bus' ? 1.05 : kind === 'truck' ? 0.98 : 0.7;
    const rearZ = kind === 'bus' ? 3.9 : kind === 'truck' ? -2.3 : -1.8;
    for (const wx of [-halfW, halfW]) {
      const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.08), headlightMat);
      headlight.position.set(wx, kind === 'bus' ? 1.0 : kind === 'truck' ? 1.25 : 0.55, kind === 'bus' ? 3.91 : kind === 'truck' ? 2.4 : 1.82);
      group.add(headlight);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.08), taillightMat);
      tail.position.set(wx, kind === 'bus' ? 1.0 : kind === 'truck' ? 1.2 : 0.5, rearZ);
      group.add(tail);
    }
    this.group.add(group);
    return {
      group,
      edge,
      kind,
      pathIndex: Math.floor(Math.random() * Math.max(1, edge.points.length - 1)),
      distance: Math.random() * 4,
      speed: 7.2 + Math.random() * 3.4,
      maxSpeed: edge.highway === 'primary' || edge.highway === 'trunk' ? 12 : edge.highway === 'secondary' ? 10.5 : edge.highway === 'tertiary' ? 9 : 7.2,
      stopped: false,
      laneOffset: 0,
    };
  }

  spawnPedestrian(path, color, hair, random = Math.random) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.68, 4, 6), new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true }));
    body.position.y = 0.82;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshStandardMaterial({ color: 0xc99a74, roughness: 0.9 }));
    head.position.y = 1.42;
    const hairMesh = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), new THREE.MeshStandardMaterial({ color: hair, roughness: 0.9 }));
    hairMesh.position.y = 1.52;
    hairMesh.scale.y = 0.72;
    group.add(body, head, hairMesh);
    group.position.set(path[0].x, 0, path[0].z);
    this.group.add(group);
    return { group, points: path, target: 1, distance: 0, speed: 1.3 + random() * 0.9, time: random() * 10 };
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

  buildSignalLightMeshes() {
    this.signalLights = [];
    const geometry = new THREE.SphereGeometry(0.13, 8, 6);
    for (const signal of this.city.signals || []) {
      const group = new THREE.Group();
      const housing = new THREE.Mesh(
        new THREE.BoxGeometry(0.52, 1.3, 0.34),
        new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.45, metalness: 0.4 }),
      );
      housing.position.y = 0;
      group.add(housing);
      const bulbs = [];
      for (let i = 0; i < 3; i += 1) {
        const material = new THREE.MeshStandardMaterial({
          color: 0x222222,
          emissive: 0x000000,
          emissiveIntensity: 0,
        });
        const bulb = new THREE.Mesh(geometry, material);
        bulb.position.set(0, 0.38 - i * 0.38, 0.2);
        group.add(bulb);
        bulbs.push(material);
      }
      group.position.set(signal.position.x, 3.5, signal.position.z);
      group.userData = { kind: 'signal-light', id: signal.id, signal };
      this.group.add(group);
      this.signalLights.push({ signal, bulbs });
    }
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

  update(delta) {
    this.phase += delta;
    for (const { signal, bulbs } of this.signalLights) {
      const local = Math.floor((this.phase + (signal.phaseOffset || 0)) / (signal.period || 8)) % 4;
      const red = local === 0 || local === 1;
      const yellow = local === 2;
      const green = local === 3;
      bulbs[0].emissive.set(red ? 0xff2a1a : 0x000000);
      bulbs[1].emissive.set(yellow ? 0xffb61a : 0x000000);
      bulbs[2].emissive.set(green ? 0x27d857 : 0x000000);
      bulbs[0].emissiveIntensity = red ? 1.4 : 0.06;
      bulbs[1].emissiveIntensity = yellow ? 1.2 : 0.06;
      bulbs[2].emissiveIntensity = green ? 1.2 : 0.06;
      bulbs[0].color.set(red ? 0xff2a1a : 0x222222);
      bulbs[1].color.set(yellow ? 0xffb61a : 0x222222);
      bulbs[2].color.set(green ? 0x27d857 : 0x222222);
    }
    for (const car of this.cars) {
      if (car.controlled) continue;
      if (!car.edge) continue;
      const points = car.edge.points;
      const targetIndex = Math.min(points.length - 1, car.pathIndex + 1);
      const a = points[car.pathIndex];
      const b = points[targetIndex];
      const segmentLength = Math.hypot(b.x - a.x, b.z - a.z);
      const signalStop = this.signalBlocked(car);
      car.stopped = signalStop;
      if (car.stopped) {
        const stopLine = Math.max(0, segmentLength - 4.6);
        if (car.distance >= stopLine) car.distance = Math.min(car.distance, stopLine);
        else car.distance += car.speed * delta;
      } else {
        car.distance += Math.min(car.speed, car.maxSpeed || 9) * delta;
      }
      if (car.distance >= segmentLength) {
        if (car.pathIndex >= points.length - 2) {
          const next = this.chooseNextEdge(car, a, b);
          if (next) {
            car.corner = { from: b, to: next.points[0], t: 0 };
            car.edge = next;
            car.pathIndex = 0;
            car.distance = 0;
            continue;
          }
          // No legal onward edge: hold at the terminus instead of looping
          // back to the start of the same street.
          car.stopped = true;
          car.distance = Math.min(car.distance, Math.max(0, segmentLength - 4.6));
          car.speed = Math.min(car.speed, 0.8);
        } else {
          car.pathIndex += 1;
          car.distance = 0;
          continue;
        }
      }
      if (car.corner) {
        car.corner.t = Math.min(1, (car.corner.t || 0) + delta * 2.4);
        const p = this.cornerArc(car.corner.from, car.corner.to, car.corner.t);
        const y = this.renderer.terrain?.heightAt ? this.renderer.terrain.heightAt(p.x, p.z) + 0.08 : 0.08;
        car.group.position.set(p.x, y, p.z);
        car.group.rotation.y = Math.atan2(car.corner.to.x - car.corner.from.x, car.corner.to.z - car.corner.from.z);
        if (car.corner.t >= 1) car.corner = null;
        continue;
      }
      const t = clamp(car.distance / segmentLength, 0, 1);
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const nx = -(b.z - a.z) / segmentLength;
      const nz = (b.x - a.x) / segmentLength;
      const offset = this.laneOffsetFor(car.edge) * (car.distance > segmentLength / 2 ? 1 : 1);
      car.laneOffset = offset;
      const y = this.renderer.terrain?.heightAt ? this.renderer.terrain.heightAt(x, z) + 0.08 : 0.08;
      car.group.position.set(x + nx * offset, y, z + nz * offset);
      car.group.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    }
    for (const pedestrian of this.pedestrians) {
      const points = pedestrian.points;
      const a = points[pedestrian.target - 1] || points[0];
      const b = points[pedestrian.target] || points[points.length - 1];
      const segmentLength = Math.hypot(b.x - a.x, b.z - a.z) || 0.01;
      pedestrian.distance += pedestrian.speed * delta;
      if (pedestrian.distance >= segmentLength) {
        pedestrian.target += 1;
        pedestrian.distance = 0;
        if (pedestrian.target >= points.length) {
          pedestrian.target = 1;
          pedestrian.distance = 0;
        }
      }
      const updatedA = points[pedestrian.target - 1] || points[0];
      const updatedB = points[pedestrian.target] || points[points.length - 1];
      const t = clamp(pedestrian.distance / (Math.hypot(updatedB.x - updatedA.x, updatedB.z - updatedA.z) || 0.01), 0, 1);
      const x = updatedA.x + (updatedB.x - updatedA.x) * t;
      const z = updatedA.z + (updatedB.z - updatedA.z) * t;
      const y = this.renderer.terrain?.heightAt ? this.renderer.terrain.heightAt(x, z) + 0.08 : 0.08;
      pedestrian.group.position.set(x, y, z);
      pedestrian.group.position.y = y + Math.abs(Math.sin(this.phase * 3 + pedestrian.time)) * 0.12;
      pedestrian.group.rotation.y = Math.atan2(updatedB.x - updatedA.x, updatedB.z - updatedA.z);
    }
  }

  driveCar(car, speed, delta) {
    if (!car || !car.edge) return;
    const points = car.edge.points;
    const targetIndex = Math.min(points.length - 1, car.pathIndex + 1);
    const a = points[car.pathIndex];
    const b = points[targetIndex];
    const segmentLength = Math.hypot(b.x - a.x, b.z - a.z) || 0.01;
    if (this.signalBlocked(car)) {
      const stopLine = Math.max(0, segmentLength - 4.6);
      if (car.distance >= stopLine) car.distance = Math.min(car.distance, stopLine);
      else car.distance += speed * delta;
    } else {
      car.distance += speed * delta;
    }
    if (car.distance >= segmentLength) {
      if (car.pathIndex >= points.length - 2) {
        const next = this.chooseNextEdge(car, a, b);
        if (next) {
          car.edge = next;
          car.pathIndex = 0;
          car.distance = 0;
        } else {
          car.distance = Math.min(car.distance, Math.max(0, segmentLength - 4.6));
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
    const y = this.renderer.terrain?.heightAt ? this.renderer.terrain.heightAt(x, z) + 0.08 : 0.08;
    car.group.position.set(x + nx * offset, y, z + nz * offset);
    car.group.rotation.y = Math.atan2(next.x - updated.x, next.z - updated.z) + (car.steerYaw || 0);
  }

  chooseNextEdge(car, a, b) {
    const outgoing = (car.edge.outgoing || []).filter((e) => e.streetId !== car.edge.streetId || Math.random() < 0.35);
    if (!outgoing.length) return null;
    const inDx = b.x - a.x;
    const inDz = b.z - a.z;
    const inLen = Math.hypot(inDx, inDz) || 1;
    let totalWeight = 0;
    const weighted = outgoing.map((edge) => {
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

  signalBlocked(car) {
    if (!car.edge.signalId) return false;
    const signal = this.city.signals.find((s) => s.id === car.edge.signalId);
    if (!signal) return false;
    const local = Math.floor((this.phase + (signal.phaseOffset || 0)) / (signal.period || 8)) % 4;
    return local === 0 || local === 1;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
