// Vehicle fleet - materials, shared geometry and the instanced writer.
//
// Owner: Rendering / vehicle presentation.
//
// WHY A FLEET RATHER THAN MESHES
//
// A city carries hundreds of vehicles and the capture backend is software GL,
// so the cost that matters is draw calls, not vertices. This module keeps that
// flat:
//
//   * a vehicle's body costs THREE instanced meshes per (type, level of
//     detail) - paint, glass, trim - and nothing per vehicle;
//   * wheels, lamps and plates are NOT part of the body geometry. One shared
//     unit wheel, one shared unit lens and one shared unit plate serve the
//     whole city, scaled into place by the instance matrix. Four wheels on a
//     thousand vehicles is still three draw calls.
//
// That also buys behaviour for free. A wheel is a separate instance, so it can
// steer and spin; a lamp is a separate instance, so a brake light or an
// indicator is switched by collapsing its matrix to zero scale, which needs no
// per-vehicle material and no shader.
//
// MATERIALS. Automotive paint is a clear-coat over a coloured base, so `paint`
// is a physical material with a tight specular lobe and a clear coat, tinted
// per instance. Glass, chrome/dark trim, rubber and lamp housings are separate
// materials because they respond differently, and the night state moves all of
// them from one place: `applyVehicleEnvironment`.

import * as THREE from 'three';
import { VEHICLE_SPEC_BY_ID, TRIM } from './vehicle-catalogue.js';
import {
  buildVehicleGeometry,
  buildWheelGeometry,
  buildLampGeometry,
  buildPlateGeometry,
  VEHICLE_LOD_CONFIG,
} from './vehicle-geometry.js';

export const VEHICLE_FLEET_VERSION = 'vehicle-fleet-v1';

/** Lamp kinds that get their own emissive material. */
export const LAMP_KINDS = Object.freeze(['head', 'tail', 'brake', 'indicator']);

const LAMP_COLOUR = Object.freeze({
  head: { base: 0xd6dbe0, emissive: 0xfff2d2, night: 3.0, day: 0.0 },
  tail: { base: 0x7e1a14, emissive: 0xff2a16, night: 1.5, day: 0.0 },
  brake: { base: 0x8e1c16, emissive: 0xff2410, night: 3.6, day: 1.8 },
  indicator: { base: 0xa8641a, emissive: 0xff9a20, night: 3.2, day: 1.9 },
});

/**
 * Environment classes, from `MATERIAL_CLASSES` in src/render/environment-ibl.js.
 *
 * THIS IS THE CONTRACT THAT MAKES A VEHICLE VISIBLE. `CityRenderer`'s
 * `applyEnvironmentGrading` walks the city root once, buckets every material
 * that declares `userData.envClass`, and only those materials are given the
 * prefiltered environment texture. A material without a class gets NO envMap at
 * all - and the shipped light rig delivers most of its fill through the
 * environment (measured on the 11:00 card: sun 6.48, hemi 0.27, ambient 0.06,
 * environmentIntensity 0.8). Undeclared paint is therefore lit by almost
 * nothing in daylight and by literally nothing after dark, which is exactly
 * what the round-2 night card measured: rgb (0,0,0) across the whole vehicle.
 *
 * The class also hands the renderer's grader ownership of `roughness` and
 * `color` for wet weather, so this module must NOT write either of those per
 * frame; two writers on one field, with the grader caching `dryRoughness` on
 * first sight, is how a material ends up permanently wet.
 */
export const VEHICLE_ENV_CLASS = Object.freeze({
  paint: 'painted-metal',
  glass: 'facade-glass',
  trim: 'chrome',
  // Rubber has no class of its own. `asphalt` is the closest response in the
  // table: dark, rough (dry 0.93, which is exactly the tyre roughness) and with
  // a large wet gain, which is what a tyre does in the rain.
  tyre: 'asphalt',
  rim: 'chrome',
  plate: 'painted-metal',
  lampHead: 'facade-glass',
  lampTail: 'facade-glass',
  lampBrake: 'facade-glass',
  lampIndicator: 'facade-glass',
});

function declareEnvClass(material, key) {
  material.userData = material.userData || {};
  material.userData.envClass = VEHICLE_ENV_CLASS[key];
  material.userData.vehiclePart = key;
  return material;
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------

/**
 * One material set for the whole city. Kept in one object so the night and
 * weather state is applied in one place and never drifts between fleets.
 */
export function createVehicleMaterials() {
  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.34,
    metalness: 0.18,
    clearcoat: 0.85,
    clearcoatRoughness: 0.10,
    envMapIntensity: 1.15,
  });
  paint.name = 'vehicle-paint';
  declareEnvClass(paint, 'paint');

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0b1015,
    vertexColors: true,
    roughness: 0.055,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    transparent: true,
    opacity: 0.86,
    envMapIntensity: 1.9,
    depthWrite: true,
  });
  glass.name = 'vehicle-glass';
  declareEnvClass(glass, 'glass');

  const trim = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.38,
    metalness: 0.62,
    envMapIntensity: 1.0,
  });
  trim.name = 'vehicle-trim';
  declareEnvClass(trim, 'trim');

  const tyre = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.93,
    metalness: 0.0,
    envMapIntensity: 0.35,
  });
  tyre.name = 'vehicle-tyre';
  declareEnvClass(tyre, 'tyre');

  const rim = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.26,
    metalness: 0.88,
    envMapIntensity: 1.25,
  });
  rim.name = 'vehicle-rim';
  declareEnvClass(rim, 'rim');

  const plate = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.42,
    metalness: 0.04,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    envMapIntensity: 1.6,
  });
  plate.name = 'vehicle-plate';
  declareEnvClass(plate, 'plate');

  const contactTexture = buildContactTexture();
  const contact = new THREE.MeshBasicMaterial({
    map: contactTexture,
    color: 0x07090c,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  contact.name = 'vehicle-contact-shadow';

  const lamps = {};
  for (const kind of LAMP_KINDS) {
    const spec = LAMP_COLOUR[kind];
    const material = new THREE.MeshStandardMaterial({
      color: spec.base,
      roughness: 0.16,
      metalness: 0.04,
      emissive: spec.emissive,
      emissiveIntensity: spec.day,
      envMapIntensity: 1.3,
    });
    material.name = `vehicle-lamp-${kind}`;
    declareEnvClass(material, `lamp${kind[0].toUpperCase()}${kind.slice(1)}`);
    lamps[kind] = material;
  }

  const materials = { paint, glass, trim, tyre, rim, plate, contact, lamps };
  materials.all = [paint, glass, trim, tyre, rim, plate, contact, ...LAMP_KINDS.map((k) => lamps[k])];
  materials.state = { nightness: 0, wetness: 0 };
  applyVehicleEnvironment(materials, { hour: 12, weather: 'clear' });
  return materials;
}

/** 0 in full daylight, 1 in full night. Civil twilight either side. */
export function nightnessFor(hour) {
  const h = Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 12;
  if (h >= 7.0 && h <= 17.5) return 0;
  if (h > 17.5 && h < 19.5) return (h - 17.5) / 2;
  if (h >= 19.5 || h < 5.0) return 1;
  if (h >= 5.0 && h < 7.0) return 1 - (h - 5.0) / 2;
  return 0;
}

/** 0 dry, 1 soaked. Rain and fog both wet the paint; drizzle less so. */
export function wetnessFor(weather) {
  const w = String(weather || 'clear').toLowerCase();
  if (w.includes('rain') || w.includes('storm')) return 1;
  if (w.includes('drizzle') || w.includes('wet')) return 0.7;
  if (w.includes('fog') || w.includes('mist')) return 0.35;
  return 0;
}

/**
 * Move every vehicle material to the hour and weather the pass context reports.
 * This pass owns no clock: `hour` and `weather` are read from the one runtime
 * clock and mirrored here.
 */
export function applyVehicleEnvironment(materials, { hour, weather } = {}) {
  const nightness = nightnessFor(hour);
  const wetness = wetnessFor(weather);
  const state = materials.state;
  if (Math.abs(state.nightness - nightness) < 1e-3 && Math.abs(state.wetness - wetness) < 1e-3) {
    return false;
  }
  state.nightness = nightness;
  state.wetness = wetness;

  // NOTE: roughness, colour and envMapIntensity are deliberately NOT written
  // here. Every vehicle material declares `userData.envClass`, so the
  // renderer's `applyEnvironmentGrading` owns those three fields and drives
  // them from one sky model for the whole city. Writing them here as well
  // would fight it, and would poison the `dryRoughness` it caches on first
  // sight. What this pass owns is the part no grader can know: which lamps are
  // lit.
  for (const kind of LAMP_KINDS) {
    const spec = LAMP_COLOUR[kind];
    materials.lamps[kind].emissiveIntensity = spec.day + (spec.night - spec.day) * nightness;
  }
  // A retro-reflective plate reads as a bright patch under a headlamp.
  materials.plate.emissiveIntensity = 0.18 * nightness;
  // Wet asphalt at night throws light back up under a car; a dry night does
  // not. The contact patch is unlit geometry, so this is the only place its
  // strength can follow the weather.
  materials.contact.opacity = 0.42 - 0.10 * wetness;
  return true;
}

/**
 * A single invisible mesh that carries every vehicle material.
 *
 * `applyEnvironmentGrading` caches its material buckets from ONE traverse of
 * the city root. The parked fleet is built during that traverse, but the
 * mirrored-traffic fleet is created lazily when the simulation is first found,
 * and a city with no kerb parking would have no mesh carrying these materials
 * at all. The anchor guarantees every vehicle material is reachable from the
 * root at build time, whatever the fleets end up being.
 */
export function createMaterialAnchor(materials) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  const list = [
    materials.paint, materials.glass, materials.trim, materials.tyre,
    materials.rim, materials.plate, ...LAMP_KINDS.map((k) => materials.lamps[k]),
  ];
  const mesh = new THREE.Mesh(geometry, list);
  mesh.name = 'vehicle-material-anchor';
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData = { pass: 'vehicle-presentation', group: 'material-anchor' };
  return mesh;
}

export function disposeVehicleMaterials(materials) {
  materials.contact?.map?.dispose?.();
  for (const material of materials.all) material.dispose?.();
}

/**
 * A soft elliptical blob. Same recipe the crowd uses for its contact shadow, so
 * a parked car and a standing figure sit on the same street the same way.
 */
function buildContactTexture(size = 48) {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const r = Math.min(1, Math.hypot(dx * 1.06, dy));
      const a = Math.round(255 * (1 - r) * (1 - r) * (1 - r * 0.3));
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = a;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// geometry library
// ---------------------------------------------------------------------------

/**
 * Lazily built, reference-counted geometry for the whole catalogue. One library
 * serves every fleet in the pass, so the parked population and the mirrored
 * traffic share the same buffers.
 */
export function createVehicleAssets(palette = TRIM) {
  const bodies = new Map();
  const wheels = new Map();
  let lampGeometry = null;
  let plateGeometry = null;
  return {
    body(typeId, lod) {
      const key = `${typeId}:${lod}`;
      let built = bodies.get(key);
      if (!built) {
        const spec = VEHICLE_SPEC_BY_ID[typeId];
        if (!spec) return null;
        built = buildVehicleGeometry(spec, lod, palette);
        bodies.set(key, built);
      }
      return built;
    },
    wheel(lod) {
      const key = Math.min(lod, 1);
      let built = wheels.get(key);
      if (!built) {
        built = buildWheelGeometry(key, palette);
        wheels.set(key, built);
      }
      return built;
    },
    lamp() {
      if (!lampGeometry) lampGeometry = buildLampGeometry(0xffffff);
      return lampGeometry;
    },
    plate() {
      if (!plateGeometry) plateGeometry = buildPlateGeometry();
      return plateGeometry;
    },
    stats() {
      return { bodies: bodies.size, wheelSets: wheels.size };
    },
    dispose() {
      for (const built of bodies.values()) {
        built.paint?.dispose?.();
        built.glass?.dispose?.();
        built.trim?.dispose?.();
      }
      bodies.clear();
      for (const set of wheels.values()) {
        set.tyre?.dispose?.();
        set.rimLeft?.dispose?.();
        set.rimRight?.dispose?.();
      }
      wheels.clear();
      lampGeometry?.dispose?.();
      plateGeometry?.dispose?.();
      lampGeometry = null;
      plateGeometry = null;
    },
  };
}

// ---------------------------------------------------------------------------
// the fleet
// ---------------------------------------------------------------------------

const ZERO_SCALE = 1e-6;
const UP = new THREE.Vector3(0, 1, 0);

function triangleCount(geometry) {
  if (!geometry) return 0;
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  return Math.floor((index ? index.count : position ? position.count : 0) / 3);
}

/**
 * An instanced fleet.
 *
 * `capacity` is a map of `"<typeId>:<lod>" -> instances`. Shared capacity for
 * wheels, lamps and plates is derived from the same map using the catalogue, so
 * a fleet can never overrun a buffer.
 *
 * A static fleet is written once at build. A dynamic fleet is rewritten every
 * frame with `begin()` / `push()` / `commit()` and allocates nothing per frame.
 */
export function createVehicleFleet({ name, assets, materials, capacity, castShadowLods = [0] }) {
  const group = new THREE.Group();
  group.name = name;

  const bodyMeshes = new Map();
  let wheelTotal = 0;
  let lampTotal = { head: 0, tail: 0, brake: 0, indicator: 0 };
  let plateTotal = 0;
  let contactTotal = 0;
  const wheelLods = new Set();

  for (const [key, count] of capacity) {
    if (!(count > 0)) continue;
    const [typeId, lodText] = key.split(':');
    const lod = Number(lodText);
    const built = assets.body(typeId, lod);
    if (!built) continue;
    const shadow = castShadowLods.includes(lod)
      || (lod === 1 && ['van', 'truck', 'bus', 'pickup'].includes(built.spec.bodyClass));
    const entry = { typeId, lod, built, meshes: {}, count: 0, capacity: count };
    for (const [groupName, geometry, material] of [
      ['paint', built.paint, materials.paint],
      ['glass', built.glass, materials.glass],
      ['trim', built.trim, materials.trim],
    ]) {
      if (!geometry) continue;
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.name = `vehicle-${typeId}-${groupName}-lod${lod}`;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = groupName === 'paint' && shadow;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData = { pass: 'vehicle-presentation', vehicleType: typeId, lod, group: groupName };
      if (groupName === 'paint') {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      group.add(mesh);
      entry.meshes[groupName] = mesh;
    }
    bodyMeshes.set(key, entry);
    wheelLods.add(Math.min(lod, 1));
    if (built.config.instancedWheels) wheelTotal += count * built.allWheels.length;
    if (built.config.instancedLamps) {
      for (const lamp of built.allLamps) lampTotal[lamp.kind] += count;
    }
    if (built.config.plates) plateTotal += count * built.plates.length;
    // A ground contact patch is worth one quad only where the vehicle is close
    // enough for the gap under it to read at all.
    if (lod < 2) contactTotal += count;
  }

  // Shared instanced content: one mesh each, for the whole fleet.
  const shared = { tyre: null, rimLeft: null, rimRight: null, lamps: {}, plate: null, contact: null };
  const wheelLod = wheelLods.has(0) ? 0 : 1;
  if (wheelTotal > 0) {
    const wheelSet = assets.wheel(wheelLod);
    const make = (geometry, material, label, count, colorised) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.name = `vehicle-${label}-instances`;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData = { pass: 'vehicle-presentation', group: label };
      if (colorised) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      group.add(mesh);
      return mesh;
    };
    shared.tyre = make(wheelSet.tyre, materials.tyre, 'tyre', wheelTotal, false);
    shared.rimRight = make(wheelSet.rimRight, materials.rim, 'rim-right', Math.ceil(wheelTotal / 2) + 2, true);
    shared.rimLeft = make(wheelSet.rimLeft, materials.rim, 'rim-left', Math.ceil(wheelTotal / 2) + 2, true);
    for (const kind of LAMP_KINDS) {
      if (!(lampTotal[kind] > 0)) continue;
      shared.lamps[kind] = make(assets.lamp(), materials.lamps[kind], `lamp-${kind}`, lampTotal[kind], false);
    }
    if (plateTotal > 0) shared.plate = make(assets.plate(), materials.plate, 'plate', plateTotal, false);
  }
  if (contactTotal > 0) {
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(plane, materials.contact, contactTotal);
    mesh.name = 'vehicle-contact-shadow-instances';
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData = { pass: 'vehicle-presentation', group: 'contact' };
    group.add(mesh);
    shared.contact = mesh;
  }

  // Scratch. Allocated once so `push` never allocates.
  const scratch = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    euler: new THREE.Euler(0, 0, 0, 'YXZ'),
    scale: new THREE.Vector3(1, 1, 1),
    base: new THREE.Matrix4(),
    local: new THREE.Matrix4(),
    world: new THREE.Matrix4(),
    colour: new THREE.Color(),
    wheelQuat: new THREE.Quaternion(),
    wheelEuler: new THREE.Euler(0, 0, 0, 'YXZ'),
    plateQuat: new THREE.Quaternion(),
    identity: new THREE.Quaternion(),
  };

  const cursors = { wheel: 0, rimLeft: 0, rimRight: 0, plate: 0, contact: 0, head: 0, tail: 0, brake: 0, indicator: 0 };

  function begin() {
    for (const entry of bodyMeshes.values()) entry.count = 0;
    cursors.wheel = 0; cursors.rimLeft = 0; cursors.rimRight = 0; cursors.plate = 0; cursors.contact = 0;
    cursors.head = 0; cursors.tail = 0; cursors.brake = 0; cursors.indicator = 0;
  }

  /**
   * Write one vehicle.
   *
   * @param {object} v
   *   `{ typeId, lod, x, y, z, yaw, pitch, roll, paint, rim, steer, spin,
   *      brake, indicator, hazard }`
   * @returns {boolean} false when the fleet has no room for it.
   */
  function push(v) {
    const key = `${v.typeId}:${v.lod}`;
    const entry = bodyMeshes.get(key);
    if (!entry || entry.count >= entry.capacity) return false;
    const index = entry.count;
    const built = entry.built;

    scratch.position.set(v.x, v.y, v.z);
    scratch.euler.set(v.pitch || 0, v.yaw || 0, v.roll || 0, 'YXZ');
    scratch.quaternion.setFromEuler(scratch.euler);
    scratch.scale.set(1, 1, 1);
    scratch.base.compose(scratch.position, scratch.quaternion, scratch.scale);

    for (const groupName of ['paint', 'glass', 'trim']) {
      const mesh = entry.meshes[groupName];
      if (!mesh) continue;
      mesh.setMatrixAt(index, scratch.base);
    }
    const paintMesh = entry.meshes.paint;
    if (paintMesh?.instanceColor && v.paint) {
      paintMesh.instanceColor.setXYZ(index, v.paint[0], v.paint[1], v.paint[2]);
    }

    if (built.config.instancedWheels && shared.tyre) {
      const spin = v.spin || 0;
      const steer = v.steer || 0;
      for (const wheel of built.wheels) {
        if (cursors.wheel >= shared.tyre.instanceMatrix.count) break;
        scratch.wheelEuler.set(spin, wheel.steer ? steer : 0, 0, 'YXZ');
        scratch.wheelQuat.setFromEuler(scratch.wheelEuler);
        scratch.position.set(wheel.x, wheel.y, wheel.z);
        scratch.scale.set(wheel.width, wheel.radius, wheel.radius);
        scratch.local.compose(scratch.position, scratch.wheelQuat, scratch.scale);
        scratch.world.multiplyMatrices(scratch.base, scratch.local);
        if (cursors.wheel < shared.tyre.instanceMatrix.count) {
          shared.tyre.setMatrixAt(cursors.wheel, scratch.world);
          cursors.wheel += 1;
        }
        const rimMesh = wheel.side > 0 ? shared.rimLeft : shared.rimRight;
        const rimCursor = wheel.side > 0 ? 'rimLeft' : 'rimRight';
        if (rimMesh && !wheel.inner && cursors[rimCursor] < rimMesh.instanceMatrix.count) {
          rimMesh.setMatrixAt(cursors[rimCursor], scratch.world);
          if (rimMesh.instanceColor && v.rim) {
            rimMesh.instanceColor.setXYZ(cursors[rimCursor], v.rim[0], v.rim[1], v.rim[2]);
          }
          cursors[rimCursor] += 1;
        }
      }
    }

    if (built.config.instancedLamps) {
      for (const lamp of built.lamps) {
        const mesh = shared.lamps[lamp.kind];
        if (!mesh) continue;
        const cursor = cursors[lamp.kind];
        if (cursor >= mesh.instanceMatrix.count) continue;
        let on = true;
        if (lamp.kind === 'brake') on = !!v.brake;
        if (lamp.kind === 'indicator') {
          on = v.hazard ? !!v.blink : (v.indicator === lamp.side && !!v.blink);
        }
        scratch.position.set(lamp.x, lamp.y, lamp.z);
        const s = on ? 1 : ZERO_SCALE;
        scratch.scale.set(lamp.w * s, lamp.h * s, lamp.d * s);
        scratch.local.compose(scratch.position, scratch.identity, scratch.scale);
        scratch.world.multiplyMatrices(scratch.base, scratch.local);
        mesh.setMatrixAt(cursor, scratch.world);
        cursors[lamp.kind] = cursor + 1;
      }
    }

    if (built.config.plates && shared.plate) {
      for (const plate of built.plates) {
        if (cursors.plate >= shared.plate.instanceMatrix.count) break;
        scratch.position.set(plate.x, plate.y, plate.z);
        scratch.plateQuat.setFromAxisAngle(UP, plate.facing > 0 ? 0 : Math.PI);
        scratch.scale.set(plate.w, plate.h, 1);
        scratch.local.compose(scratch.position, scratch.plateQuat, scratch.scale);
        scratch.world.multiplyMatrices(scratch.base, scratch.local);
        shared.plate.setMatrixAt(cursors.plate, scratch.world);
        cursors.plate += 1;
      }
    }

    if (shared.contact && built.config.lod < 2 && cursors.contact < shared.contact.instanceMatrix.count) {
      const spec = built.spec;
      scratch.position.set(0, 0.02, 0);
      scratch.scale.set(spec.width * 1.42, 1, spec.length * 1.10);
      scratch.local.compose(scratch.position, scratch.identity, scratch.scale);
      scratch.world.multiplyMatrices(scratch.base, scratch.local);
      shared.contact.setMatrixAt(cursors.contact, scratch.world);
      cursors.contact += 1;
    }

    entry.count = index + 1;
    return true;
  }

  function commit() {
    for (const entry of bodyMeshes.values()) {
      for (const groupName of ['paint', 'glass', 'trim']) {
        const mesh = entry.meshes[groupName];
        if (!mesh) continue;
        mesh.count = entry.count;
        mesh.visible = entry.count > 0;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    const setShared = (mesh, count) => {
      if (!mesh) return;
      mesh.count = count;
      mesh.visible = count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    setShared(shared.tyre, cursors.wheel);
    setShared(shared.rimLeft, cursors.rimLeft);
    setShared(shared.rimRight, cursors.rimRight);
    for (const kind of LAMP_KINDS) setShared(shared.lamps[kind], cursors[kind]);
    setShared(shared.plate, cursors.plate);
    setShared(shared.contact, cursors.contact);
  }

  function stats() {
    const meshes = [];
    let triangles = 0;
    let drawCalls = 0;
    group.traverse((node) => {
      if (!node.isInstancedMesh) return;
      const each = triangleCount(node.geometry);
      const count = node.count || 0;
      if (count > 0) drawCalls += 1;
      triangles += each * count;
      if (count > 0) {
        meshes.push({
          name: node.name, instances: count, trianglesEach: each, triangles: each * count,
        });
      }
    });
    return { triangles, drawCalls, meshes };
  }

  function dispose() {
    // Body, wheel, lamp and plate geometry belongs to the shared asset library
    // and is released there. The contact quad is the only geometry this fleet
    // owns outright.
    shared.contact?.geometry?.dispose?.();
    group.traverse((node) => {
      if (node.isInstancedMesh) node.dispose?.();
    });
    group.parent?.remove(group);
    bodyMeshes.clear();
  }

  return {
    group, begin, push, commit, stats, dispose,
    get counts() {
      const out = {};
      for (const [key, entry] of bodyMeshes) out[key] = entry.count;
      return out;
    },
    capacityOf(typeId, lod) { return bodyMeshes.get(`${typeId}:${lod}`)?.capacity ?? 0; },
  };
}

/** Worst-case shared-instance counts for a fleet plan, for budget reporting. */
export function fleetGeometryCost(assets, capacity) {
  let triangles = 0;
  for (const [key, count] of capacity) {
    if (!(count > 0)) continue;
    const [typeId, lodText] = key.split(':');
    const built = assets.body(typeId, Number(lodText));
    if (!built) continue;
    const config = VEHICLE_LOD_CONFIG[Number(lodText)];
    let each = built.triangles;
    if (config.instancedWheels) {
      const wheelSet = assets.wheel(Number(lodText));
      each += built.allWheels.length * triangleCount(wheelSet.tyre)
        + built.allWheels.filter((w) => !w.inner).length * triangleCount(wheelSet.rimRight);
    }
    if (config.instancedLamps) each += built.lamps.length * triangleCount(assets.lamp());
    if (config.plates) each += built.plates.length * triangleCount(assets.plate());
    triangles += each * count;
  }
  return triangles;
}

export default createVehicleFleet;
