import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHeroCharacter } from '../src/realmap/hero-character.js';

const character = createHeroCharacter({
  name: 'QA Traveler',
  paletteIndex: 3,
  showNameTag: false,
});

assert.equal(character.root.userData.heroCharacter, true, 'uses the hero adapter marker');
assert.equal(character.root.userData.playerRig, true, 'uses the shared player-grade rig');
assert.equal(character.root.userData.heroDetail, true, 'uses the close-range hero detail path');
assert.equal(character.root.userData.nameTag.visible, false, 'beauty capture hides name tags by default');
assert.equal(character.root.userData.shadow.material.opacity, 0.58, 'contact shadow is strengthened');
assert.equal(character.root.userData.shadow.castShadow, true, 'character meshes remain shadow-ready');

const cameraFocus = character.getCameraFocus(new THREE.Vector3());
assert.ok(cameraFocus.y > 1, 'camera focus is above the character origin');

character.update({ time: 0, delta: 1 / 60 });
const initialGait = character.root.userData.gaitBlend;
for (let frame = 1; frame <= 30; frame += 1) {
  character.update({ moving: true, speedRatio: 1, time: frame / 60, delta: 1 / 60 });
}
assert.ok(character.root.userData.gaitBlend > initialGait, 'walk state blends in progressively');
assert.ok(
  Math.abs(character.root.userData.leftLeg.rotation.x) > 0.001
    || Math.abs(character.root.userData.rightLeg.rotation.x) > 0.001,
  'walk state animates the grounded leg rig',
);

character.setNameTagVisible(true);
assert.equal(character.root.userData.nameTag.visible, true, 'name tag can be enabled outside beauty capture');

const host = new THREE.Group();
host.add(character.root);
character.dispose();
assert.equal(character.disposed, true, 'adapter records cleanup');
assert.equal(character.root.parent, null, 'cleanup detaches the root');
character.update({ moving: true, delta: 1 / 60 });

console.log('hero character verification passed');
