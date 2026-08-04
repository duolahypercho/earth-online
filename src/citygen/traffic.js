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
    const random = mulberry32(Number(city.meta.seedInt || 1) + 77);
    const paint = ['#d94f4a', '#e8b23a', '#4f86c8', '#3f9e8f', '#8f74c8', '#d47a3f', '#f2e9d8', '#6fbf73'];
    for (let i = 0; i < count; i += 1) {
      const edge = this.edges[Math.floor(random() * this.edges.length)];
      if (!edge) continue;
      const car = this.spawnCar(edge, paint[Math.floor(random() * paint.length)]);
      this.cars.push(car);
    }
    const pedestrianCount = 14;
    const sidewalkPoints = this.buildSidewalkWaypoints(city);
    for (let i = 0; i < pedestrianCount; i += 1) {
      const start = sidewalkPoints[Math.floor(random() * sidewalkPoints.length)];
      if (!start) continue;
      this.pedestrians.push(this.spawnPedestrian(start, random() < 0.4 ? 0x79a8c9 : 0xd09a6f));
    }
    this.renderer.scene.add(this.group);
  }

  dispose() {
    this.renderer.scene.remove(this.group);
  }

  spawnCar(edge, color) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.62, 3.6),
      new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.55, flatShading: true }),
    );
    body.position.y = 0.62;
    group.add(body);
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.5, 1.6),
      new THREE.MeshStandardMaterial({ color: 0xb9d3e0, roughness: 0.2, metalness: 0.2, flatShading: true }),
    );
    cab.position.set(0, 1.12, -0.4);
    group.add(cab);
    const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.24, 8);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
    wheelGeo.rotateZ(Math.PI / 2);
    for (const [wx, wz] of [[-0.85, 1.1], [0.85, 1.1], [-0.85, -1.1], [0.85, -1.1]]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(wx, 0.3, wz);
      group.add(wheel);
    }
    const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffe9a8, emissiveIntensity: 0.4 });
    for (const [wx] of [[-0.7], [0.7]]) {
      const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.08), headlightMat);
      headlight.position.set(wx, 0.55, 1.82);
      group.add(headlight);
    }
    this.group.add(group);
    return {
      group,
      edge,
      pathIndex: Math.floor(Math.random() * Math.max(1, edge.points.length - 1)),
      distance: Math.random() * 4,
      speed: 7.2 + Math.random() * 3.4,
      stopped: false,
    };
  }

  spawnPedestrian(point, color) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.24, 0.72, 4, 6),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true }),
    );
    body.position.y = 0.85;
    group.add(body);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.17, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xc99a74, roughness: 0.9 }),
    );
    head.position.y = 1.52;
    group.add(head);
    group.position.set(point.x, 0, point.z);
    this.group.add(group);
    return { group, points: [point], target: 0, speed: 1.2 + Math.random() * 0.8, time: Math.random() * 10 };
  }

  buildSidewalkWaypoints(city) {
    const points = [];
    for (const segment of city.segments) {
      const half = segment.width / 2 + segment.sidewalkW - 1;
      if (half <= 0.5) continue;
      const dx = segment.points[1].x - segment.points[0].x;
      const dz = segment.points[1].z - segment.points[0].z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      points.push({ x: segment.points[0].x + nx * half, z: segment.points[0].z + nz * half });
      points.push({ x: segment.points[1].x + nx * half, z: segment.points[1].z + nz * half });
      points.push({ x: segment.points[0].x - nx * half, z: segment.points[0].z - nz * half });
      points.push({ x: segment.points[1].x - nx * half, z: segment.points[1].z - nz * half });
    }
    return points;
  }

  update(delta) {
    this.phase += delta;
    for (const car of this.cars) {
      if (!car.edge) continue;
      const points = car.edge.points;
      const targetIndex = Math.min(points.length - 1, car.pathIndex + 1);
      const a = points[car.pathIndex];
      const b = points[targetIndex];
      const segmentLength = Math.hypot(b.x - a.x, b.z - a.z);
      const signalStop = this.signalBlocked(car);
      car.stopped = signalStop;
      if (car.stopped) {
        car.distance = Math.min(car.distance, Math.max(0, segmentLength - 4.6));
      } else {
        car.distance += car.speed * delta;
      }
      if (car.distance >= segmentLength) {
        if (car.pathIndex >= points.length - 2) {
          const outgoing = (car.edge.outgoing || []).filter((e) => e.streetId !== car.edge.streetId || Math.random() < 0.35);
          const next = outgoing.length ? outgoing[Math.floor(Math.random() * outgoing.length)] : null;
          if (next) {
            car.edge = next;
            car.pathIndex = 0;
            car.distance = 0;
            continue;
          }
          car.distance = 0;
        } else {
          car.pathIndex += 1;
          car.distance = 0;
          continue;
        }
      }
      const t = clamp(car.distance / segmentLength, 0, 1);
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = this.renderer.terrain?.heightAt ? this.renderer.terrain.heightAt(x, z) + 0.08 : 0.08;
      car.group.position.set(x, y, z);
      car.group.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    }
    for (const pedestrian of this.pedestrians) {
      const point = pedestrian.points[0];
      const y = this.renderer.terrain?.heightAt ? this.renderer.terrain.heightAt(point.x, point.z) + 0.08 : 0.08;
      pedestrian.group.position.x += Math.sin(this.phase * 0.7 + pedestrian.time) * pedestrian.speed * delta * 0.16;
      pedestrian.group.position.z += Math.cos(this.phase * 0.53 + pedestrian.time * 1.3) * pedestrian.speed * delta * 0.16;
      pedestrian.group.position.y = y + Math.abs(Math.sin(this.phase * 3 + pedestrian.time)) * 0.12;
      pedestrian.group.rotation.y = Math.atan2(Math.sin(this.phase * 0.7 + pedestrian.time) * 0.16, Math.cos(this.phase * 0.53 + pedestrian.time * 1.3) * 0.16);
    }
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
