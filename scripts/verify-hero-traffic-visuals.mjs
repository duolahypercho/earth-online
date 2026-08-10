import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHeroTrafficVisuals } from '../src/realmap/hero-traffic-visuals.js';

const scene = new THREE.Scene();
const source = new THREE.Group();
source.position.set(12, 0, -4);
scene.add(source);

const visuals = createHeroTrafficVisuals({ scene, maxVehicles: 2, cameraExclusionRadius: 4, cameraFadeDistance: 6 });
visuals.attach([{ mesh: source, variant: 'taxi', color: 0xffc324 }]);
assert.equal(source.visible, false, 'adapter must replace the primitive source render');

let stats = visuals.update({ camera: new THREE.Vector3(100, 4, 100), hero: new THREE.Vector3(12, 0, -4) });
assert.equal(stats.active, 1, 'a distant camera should leave the traffic shell active');
assert.equal(stats.drawCalls, 8, 'the presentation draw budget must be fixed');
assert.equal(stats.materials, 7, 'the material budget must remain shared');

stats = visuals.update({ camera: new THREE.Vector3(12, 1.6, -4), hero: new THREE.Vector3(12, 0, -4) });
assert.equal(stats.excluded, 1, 'a vehicle on the hero/camera should be excluded instead of obstructing the frame');

visuals.dispose();
assert.equal(source.visible, true, 'disposal must restore source rendering');
console.log('hero traffic visuals verified');
