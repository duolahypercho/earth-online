import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createHeroPlayerAvatar } from './pedestrians.js';
import {
  applyIdleLayer,
  applyLocomotionLayer,
  createAnimLayerState,
  resetAdditivePose,
  updateLocomotionPhase,
} from './npc-animation-layers.js';

const PLAYER_PALETTES = Object.freeze([
  Object.freeze({ skin: 0xd9a37e, hair: 0x2b2623, top: 0x3f6f8f, bottom: 0x2f3a44, accent: 0xe2a54f }),
  Object.freeze({ skin: 0x8d5f43, hair: 0x15120f, top: 0x9d4f46, bottom: 0x27313a, accent: 0xd9b37a }),
  Object.freeze({ skin: 0xf0c8a0, hair: 0x4a3020, top: 0x5b7a63, bottom: 0x333c45, accent: 0xe07856 }),
  Object.freeze({ skin: 0x7d4a33, hair: 0x1c1714, top: 0x6b4e7a, bottom: 0x242d35, accent: 0xd9c58b }),
  Object.freeze({ skin: 0xe8b48f, hair: 0x30241d, top: 0x8a5a2b, bottom: 0x2d2f31, accent: 0x6ba3a8 }),
]);

function addMesh(parent, geometry, material, position, scale = null, rotation = null) {
  const mesh = new THREE.Mesh(geometry, material);
  if (position) mesh.position.set(position.x ?? 0, position.y ?? 0, position.z ?? 0);
  if (scale) mesh.scale.set(scale.x ?? 1, scale.y ?? 1, scale.z ?? 1);
  if (rotation) mesh.rotation.set(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function createSoftShadowTexture() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const gradient = context.createRadialGradient(32, 32, 4, 32, 32, 30);
  gradient.addColorStop(0, 'rgba(6,12,14,0.62)');
  gradient.addColorStop(0.55, 'rgba(6,12,14,0.28)');
  gradient.addColorStop(1, 'rgba(6,12,14,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

export function createPlayerAvatar({ name = 'Traveler', paletteIndex = 0, scale = 1 } = {}) {
  const root = createHeroPlayerAvatar({
    name,
    jobId: 'commuter',
    variantSeed: paletteIndex,
    scale,
  });
  root.name = `Player avatar / ${name}`;

  const shadowTexture = createSoftShadowTexture();
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.58, 20),
    new THREE.MeshBasicMaterial({
      color: 0x0a1214,
      alphaMap: shadowTexture,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  shadow.rotation.x = -Math.PI * 0.5;
  shadow.position.y = -0.12;
  shadow.renderOrder = -1;
  root.add(shadow);

  const nameTag = createNameTagSprite(name);
  nameTag.position.set(0, 2.12, 0);
  root.add(nameTag);

  root.userData.shadow = shadow;
  root.userData.nameTag = nameTag;
  root.userData.phase = 0;
  root.userData.gaitBlend = 0;
  root.userData.smoothedSpeedRatio = 0;
  return root;
}

function createLegacyPlayerAvatar({ name = 'Traveler', paletteIndex = 0, scale = 1 } = {}) {
  const palette = PLAYER_PALETTES[((paletteIndex % PLAYER_PALETTES.length) + PLAYER_PALETTES.length)
    % PLAYER_PALETTES.length] || PLAYER_PALETTES[0];

  const group = new THREE.Group();
  group.name = `Player avatar / ${name}`;
  group.scale.setScalar(scale);

  const bodyMat = new THREE.MeshStandardMaterial({ color: palette.top, roughness: 0.72, metalness: 0.02 });
  const bottomMat = new THREE.MeshStandardMaterial({ color: palette.bottom, roughness: 0.8, metalness: 0.02 });
  const skinMat = new THREE.MeshStandardMaterial({ color: palette.skin, roughness: 0.62 });
  const hairMat = new THREE.MeshStandardMaterial({ color: palette.hair, roughness: 0.78 });
  const accentMat = new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.6, metalness: 0.05 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c2024, roughness: 0.5, metalness: 0.15 });
  const shoeAccentMat = new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.48, metalness: 0.08 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x9aa2a6, roughness: 0.3, metalness: 0.8 });
  const bagMat = new THREE.MeshStandardMaterial({ color: 0x5b4637, roughness: 0.86 });

  const rig = new THREE.Group();
  rig.name = 'Player rig';
  group.add(rig);

  const legGeo = new RoundedBoxGeometry(0.17, 0.52, 0.19, 3, 0.07);
  const shinGeo = new RoundedBoxGeometry(0.14, 0.42, 0.16, 3, 0.06);
  const footGeo = new RoundedBoxGeometry(0.15, 0.1, 0.28, 3, 0.045);
  const leftLeg = new THREE.Group();
  leftLeg.position.set(-0.115, 0.72, 0);
  const rightLeg = new THREE.Group();
  rightLeg.position.set(0.115, 0.72, 0);
  addMesh(leftLeg, legGeo, bottomMat, new THREE.Vector3(0, -0.26, 0));
  addMesh(rightLeg, legGeo, bottomMat, new THREE.Vector3(0, -0.26, 0));
  const leftShin = new THREE.Group();
  leftShin.position.y = -0.52;
  const rightShin = new THREE.Group();
  rightShin.position.y = -0.52;
  addMesh(leftShin, shinGeo, bottomMat, new THREE.Vector3(0, -0.21, 0));
  addMesh(rightShin, shinGeo, bottomMat, new THREE.Vector3(0, -0.21, 0));
  const leftFoot = addMesh(leftShin, footGeo, darkMat, new THREE.Vector3(0, -0.32, 0.055));
  const rightFoot = addMesh(rightShin, footGeo, darkMat, new THREE.Vector3(0, -0.32, 0.055));
  const leftSole = addMesh(leftFoot, new THREE.BoxGeometry(0.16, 0.035, 0.3), shoeAccentMat, new THREE.Vector3(0, -0.045, 0.01));
  const rightSole = addMesh(rightFoot, new THREE.BoxGeometry(0.16, 0.035, 0.3), shoeAccentMat, new THREE.Vector3(0, -0.045, 0.01));
  leftLeg.add(leftShin);
  rightLeg.add(rightShin);
  rig.add(leftLeg, rightLeg);

  const torso = addMesh(
    rig,
    new RoundedBoxGeometry(0.5, 0.62, 0.3, 4, 0.09),
    bodyMat,
    new THREE.Vector3(0, 1.2, 0),
  );
  const collar = addMesh(
    rig,
    new RoundedBoxGeometry(0.34, 0.14, 0.26, 3, 0.05),
    accentMat,
    new THREE.Vector3(0, 1.5, 0.035),
  );
  const belt = addMesh(
    rig,
    new RoundedBoxGeometry(0.52, 0.09, 0.33, 3, 0.035),
    darkMat,
    new THREE.Vector3(0, 0.94, 0),
  );
  const shoulderYoke = addMesh(
    rig,
    new RoundedBoxGeometry(0.54, 0.18, 0.34, 4, 0.08),
    bodyMat,
    new THREE.Vector3(0, 1.54, 0.01),
  );
  const chestZipper = addMesh(
    rig,
    new RoundedBoxGeometry(0.05, 0.5, 0.02, 2, 0.008),
    metalMat,
    new THREE.Vector3(0, 1.22, 0.155),
  );
  const backpack = addMesh(
    rig,
    new THREE.CapsuleGeometry(0.13, 0.2, 4, 8),
    bagMat,
    new THREE.Vector3(0, 1.28, -0.19),
    new THREE.Vector3(0.88, 1, 0.58),
  );
  const bagStrap = addMesh(
    rig,
    new RoundedBoxGeometry(0.035, 0.42, 0.03, 2, 0.01),
    bagMat,
    new THREE.Vector3(0.08, 1.34, 0.16),
    null,
    new THREE.Vector3(0, 0, 0.5),
  );

  const armGeo = new RoundedBoxGeometry(0.15, 0.46, 0.16, 3, 0.06);
  const forearmGeo = new RoundedBoxGeometry(0.12, 0.38, 0.13, 3, 0.05);
  const handGeo = new THREE.SphereGeometry(0.07, 10, 8);
  const leftArm = new THREE.Group();
  leftArm.position.set(-0.34, 1.46, 0);
  const rightArm = new THREE.Group();
  rightArm.position.set(0.34, 1.46, 0);
  addMesh(leftArm, armGeo, bodyMat, new THREE.Vector3(0, -0.23, 0));
  addMesh(rightArm, armGeo, bodyMat, new THREE.Vector3(0, -0.23, 0));
  const leftForearm = new THREE.Group();
  leftForearm.position.y = -0.46;
  const rightForearm = new THREE.Group();
  rightForearm.position.y = -0.46;
  addMesh(leftForearm, forearmGeo, skinMat, new THREE.Vector3(0, -0.19, 0));
  addMesh(rightForearm, forearmGeo, skinMat, new THREE.Vector3(0, -0.19, 0));
  addMesh(leftForearm, handGeo, skinMat, new THREE.Vector3(0, -0.39, 0), new THREE.Vector3(0.92, 1, 0.92));
  addMesh(rightForearm, handGeo, skinMat, new THREE.Vector3(0, -0.39, 0), new THREE.Vector3(0.92, 1, 0.92));
  const watch = addMesh(
    leftForearm,
    new RoundedBoxGeometry(0.035, 0.05, 0.045, 2, 0.008),
    metalMat,
    new THREE.Vector3(0.01, -0.27, 0.06),
  );
  leftArm.add(leftForearm);
  rightArm.add(rightForearm);
  rig.add(leftArm, rightArm);

  const neck = addMesh(rig, new THREE.CylinderGeometry(0.07, 0.075, 0.12, 10), skinMat, new THREE.Vector3(0, 1.68, 0));
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 1.84, 0);
  const head = addMesh(headPivot, new THREE.SphereGeometry(0.165, 16, 12), skinMat, new THREE.Vector3(0, 0, 0.01));
  head.scale.set(1, 0.94, 0.92);
  const hair = addMesh(
    headPivot,
    new THREE.SphereGeometry(0.172, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    hairMat,
    new THREE.Vector3(0, 0.045, -0.01),
  );
  hair.scale.set(1.04, 1, 1);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x181b1e, roughness: 0.5 });
  addMesh(headPivot, new THREE.SphereGeometry(0.016, 8, 6), eyeMat, new THREE.Vector3(-0.06, 0.035, 0.148));
  addMesh(headPivot, new THREE.SphereGeometry(0.016, 8, 6), eyeMat, new THREE.Vector3(0.06, 0.035, 0.148));
  addMesh(headPivot, new THREE.SphereGeometry(0.032, 7, 5), hairMat, new THREE.Vector3(0, -0.012, 0.156), new THREE.Vector3(0.55, 0.22, 0.4));
  addMesh(headPivot, new THREE.CapsuleGeometry(0.024, 0.045, 3, 7), skinMat, new THREE.Vector3(0, 0.015, 0.164), new THREE.Vector3(1, 1, 0.62));
  if (paletteIndex % 2 === 0) {
    const glassesMat = new THREE.MeshStandardMaterial({ color: 0x1b2024, roughness: 0.3, metalness: 0.5 });
    for (const x of [-0.062, 0.062]) {
      addMesh(headPivot, new THREE.TorusGeometry(0.043, 0.008, 5, 10), glassesMat, new THREE.Vector3(x, 0.045, 0.158));
    }
    addMesh(headPivot, new RoundedBoxGeometry(0.14, 0.018, 0.015, 2, 0.006), glassesMat, new THREE.Vector3(0, 0.045, 0.16));
  }
  if (paletteIndex % 3 === 1) {
    const bun = addMesh(headPivot, new THREE.SphereGeometry(0.07, 10, 8), hairMat, new THREE.Vector3(0, 0.17, -0.1));
    bun.scale.set(1, 0.92, 0.92);
  }
  rig.add(headPivot);

  const shadowTexture = createSoftShadowTexture();
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.52, 20),
    new THREE.MeshBasicMaterial({
      color: 0x0a1214,
      alphaMap: shadowTexture,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  shadow.rotation.x = -Math.PI * 0.5;
  shadow.position.y = -0.16;
  shadow.renderOrder = -1;
  group.add(shadow);

  const nameTag = createNameTagSprite(name);
  nameTag.position.set(0, 2.18, 0);
  group.add(nameTag);

  group.userData = {
    rig,
    headPivot,
    head,
    body: torso,
    leftArm,
    rightArm,
    leftForearm,
    rightForearm,
    leftLeg,
    rightLeg,
    leftShin,
    rightShin,
    leftFoot,
    rightFoot,
    leftSole,
    rightSole,
    shadow,
    nameTag,
    palette,
    phase: 0,
    gaitBlend: 0,
  };
  void collar;
  void belt;
  void neck;
  void shoulderYoke;
  void chestZipper;
  void backpack;
  void bagStrap;
  void watch;
  return group;
}

export function animatePlayerAvatar(avatar, { moving = false, speedRatio = 0, elapsed = 0, delta = 0.016, turnLean = 0 } = {}) {
  if (!avatar) return;
  const ud = avatar.userData;
  if (!ud) return;
  if (!ud.animLayerState) {
    ud.animLayerState = createAnimLayerState(ud.phase || 0);
    ud.animLayerState.phase = ud.phase || 0;
    ud.animLayerState.gaitBlend = ud.gaitBlend || 0;
  }
  const layer = ud.animLayerState;
  // Store neutral hip Y once so repeated += in locomotion does not drift.
  if (ud.leftHipY == null && ud.leftLeg) ud.leftHipY = ud.leftLeg.position.y;
  if (ud.rightHipY == null && ud.rightLeg) ud.rightHipY = ud.rightLeg.position.y;
  if (ud.leftLeg && ud.leftHipY != null) ud.leftLeg.position.y = ud.leftHipY;
  if (ud.rightLeg && ud.rightHipY != null) ud.rightLeg.position.y = ud.rightHipY;

  // ── AAA on-foot acceleration/deceleration feel ──────────────────────
  // The raw speedRatio (0.58 walk, 1.0 sprint) snaps instantly, which makes
  // the avatar lean, rig tilt, and head tilt pop rather than ramp.  Damp it
  // internally with separate attack (responsive) and decay (weighted) rates
  // so the locomotion layer reads a physically-grounded blend every frame.
  const TARGET_SPEED_RATIO = moving ? speedRatio : 0;
  const ATTACK_DAMP = 10.5;
  const DECAY_DAMP  = 3.8;
  const dampRate = TARGET_SPEED_RATIO > (ud.smoothedSpeedRatio ?? 0)
    ? ATTACK_DAMP
    : DECAY_DAMP;
  ud.smoothedSpeedRatio = THREE.MathUtils.damp(
    ud.smoothedSpeedRatio ?? 0,
    TARGET_SPEED_RATIO,
    dampRate,
    delta,
  );
  const internalSpeedRatio = ud.smoothedSpeedRatio;

  // Keep the locomotion phase advancing while gaitBlend decays so the walk
  // cycle does not freeze mid-step when the player releases WASD.
  const movingEffective = moving || internalSpeedRatio > 0.015;

  resetAdditivePose(ud);
  const { gait, phase } = updateLocomotionPhase({
    state: layer,
    speed: movingEffective ? 1.05 + internalSpeedRatio * 0.55 : 0,
    cadence: 1,
    gaitBlendTarget: movingEffective ? 1 : 0,
    delta,
    stride: 1,
  });
  ud.gaitBlend = layer.gaitBlend;
  ud.phase = phase;
  applyLocomotionLayer(ud, {
    gait,
    phase,
    speedRatio: internalSpeedRatio,
    turnLean,
    hurry: 1,
    stride: 1,
    armSwing: 1,
  });
  if (gait < 0.22) {
    applyIdleLayer(ud, elapsed + phase, 1 - gait);
  }
  const shadowScale = 1 + gait * Math.abs(Math.sin(phase)) * 0.05;
  if (ud.shadow) ud.shadow.scale.set(shadowScale, 1, shadowScale);
}

export function setAvatarLook(avatar, yaw, pitch = 0) {
  if (!avatar) return;
  const ud = avatar.userData;
  if (!ud) return;
  ud.rig.rotation.y = yaw;
  ud.headPivot.rotation.y += pitch * 0.4;
}

export function createNameTagSprite(name = 'Traveler') {
  if (typeof document === 'undefined') return new THREE.Sprite();
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context) {
    context.clearRect(0, 0, 256, 64);
    const radius = 16;
    context.beginPath();
    context.roundRect(8, 8, 240, 48, radius);
    context.fillStyle = 'rgba(10, 18, 22, 0.74)';
    context.fill();
    context.strokeStyle = 'rgba(207, 230, 235, 0.4)';
    context.lineWidth = 2;
    context.stroke();
    context.font = '600 24px ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#eaf4f3';
    context.fillText(String(name || 'Traveler').slice(0, 18), 128, 33);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = 'Player name tag';
  sprite.scale.set(1.7, 0.42, 1);
  sprite.renderOrder = 20;
  return sprite;
}

export function createRemoteCar({ className = 'sedan', color = 0x3f6f8f, taxi = false } = {}) {
  const group = new THREE.Group();
  group.name = `Remote ${className} driver car`;
  const bodyMat = new THREE.MeshStandardMaterial({ color: taxi ? 0xe2b93b : color, roughness: 0.34, metalness: 0.42 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x152a33,
    roughness: 0.16,
    metalness: 0.7,
    transparent: true,
    opacity: 0.74,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x15191c, roughness: 0.5, metalness: 0.4 });
  const bodyScale = className === 'suv' ? 1.12 : className === 'bus' ? 1.9 : className === 'truck' ? 1.4 : 1;
  const body = addMesh(group, new RoundedBoxGeometry(1.9 * bodyScale, 0.62, 4.4, 4, 0.16), bodyMat, new THREE.Vector3(0, 0.52, 0));
  const cabin = addMesh(group, new RoundedBoxGeometry(1.55 * Math.min(1.12, bodyScale), 0.5, 2.1, 4, 0.14), glassMat, new THREE.Vector3(0, 0.94, -0.28));
  addMesh(group, new RoundedBoxGeometry(1.8 * bodyScale, 0.12, 4.2, 3, 0.05), darkMat, new THREE.Vector3(0, 0.2, 0));
  const wheels = [];
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 14);
  wheelGeo.rotateZ(Math.PI * 0.5);
  const wheelPositions = [[-0.86, 0.34, 1.3], [0.86, 0.34, 1.3], [-0.86, 0.34, -1.3], [0.86, 0.34, -1.3]];
  for (const [x, y, z] of wheelPositions) {
    const wheel = addMesh(group, wheelGeo, darkMat, new THREE.Vector3(x, y, z));
    wheels.push(wheel);
  }
  const headMat = new THREE.MeshStandardMaterial({ color: 0xf2e4bd, emissive: 0xdfc47a, emissiveIntensity: 1.4, roughness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x9c2f2f, emissive: 0x8f1f1f, emissiveIntensity: 1.8, roughness: 0.4 });
  addMesh(group, new THREE.SphereGeometry(0.09, 8, 6), headMat, new THREE.Vector3(-0.72, 0.5, 2.2));
  addMesh(group, new THREE.SphereGeometry(0.09, 8, 6), headMat, new THREE.Vector3(0.72, 0.5, 2.2));
  addMesh(group, new THREE.SphereGeometry(0.08, 8, 6), tailMat, new THREE.Vector3(-0.72, 0.52, -2.2));
  addMesh(group, new THREE.SphereGeometry(0.08, 8, 6), tailMat, new THREE.Vector3(0.72, 0.52, -2.2));
  group.userData = { wheels, className };
  void body;
  void cabin;
  return group;
}

export function updateRemoteCar(car, { speed = 0, delta = 0.016 } = {}) {
  if (!car) return;
  const wheels = car.userData?.wheels;
  if (!wheels) return;
  const spin = speed / 0.34 * delta;
  for (const wheel of wheels) wheel.rotation.x += spin;
}

export function disposePlayerAvatar(avatar) {
  if (!avatar) return;
  // Hero rigs share geometry and materials with the pedestrian pool. Never
  // dispose shared resources when a player or remote peer leaves.
  if (avatar.userData?.playerRig === true) return;
  avatar.traverse((object) => {
    if (object.isMesh) {
      object.geometry?.dispose?.();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material?.dispose?.());
    }
  });
}
