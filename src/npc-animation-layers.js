/**
 * Composable procedural animation layers for SF NPC / player avatars.
 *
 * Expected `ud` (mesh.userData) bone handles — same contract as pedestrians.js:
 *   rig, body, headPivot,
 *   leftArm, rightArm, leftForearm, rightForearm,
 *   leftLeg, rightLeg, leftShin, rightShin,
 *   leftFoot, rightFoot
 *
 * Layers mutate rotations/positions additively on top of a reset or base pose.
 * They do not own navigation or behavior-tree intent.
 */

import * as THREE from 'three';

const ADULT_STEP_LENGTH = 0.68;
const GAIT_START_DAMP = 10.2;
const GAIT_STOP_DAMP = 5.4;

export function createAnimLayerState(seed = 0) {
  return {
    phase: seed * Math.PI * 2,
    gaitBlend: 0,
    gazePhase: seed * 4.1,
  };
}

export function updateLocomotionPhase({
  state,
  speed = 1.1,
  cadence = 1,
  gaitBlendTarget = 0,
  delta = 0.016,
  stride = 1,
} = {}) {
  const damp = gaitBlendTarget > state.gaitBlend ? GAIT_START_DAMP : GAIT_STOP_DAMP;
  state.gaitBlend = THREE.MathUtils.damp(state.gaitBlend, gaitBlendTarget, damp, delta);
  const gait = THREE.MathUtils.smoothstep(state.gaitBlend, 0, 1);
  const stepLength = Math.max(0.55, ADULT_STEP_LENGTH * stride);
  const phaseRate = gait > 0.001
    ? (Math.max(0, speed) / stepLength) * Math.PI * cadence
    : 0.9;
  state.phase += delta * phaseRate;
  return { gait, phase: state.phase, sin: Math.sin(state.phase), cos: Math.cos(state.phase) };
}

/** AAA-style in-place locomotion on shared hero/player bone handles. */
export function applyLocomotionLayer(ud, {
  gait = 0,
  phase = 0,
  speedRatio = 0,
  turnLean = 0,
  hurry = 1,
  stride = 1,
  armSwing = 1,
} = {}) {
  if (!ud?.rig) return;
  const sin = Math.sin(phase);
  const cos = Math.cos(phase);
  const forwardLeft = Math.max(0, -sin);
  const forwardRight = Math.max(0, sin);
  const stanceLeft = Math.max(0, sin);
  const stanceRight = Math.max(0, -sin);
  const leftSwing = Math.pow(forwardLeft, 0.82);
  const rightSwing = Math.pow(forwardRight, 0.82);
  const leftStance = Math.pow(stanceLeft, 2.4);
  const rightStance = Math.pow(stanceRight, 2.4);
  const leftHeel = Math.pow(Math.max(0, Math.cos(phase + 0.12)), 14) * gait;
  const rightHeel = Math.pow(Math.max(0, -Math.cos(phase + 0.12)), 14) * gait;
  const strideScale = gait * stride * hurry;
  const swing = sin * 0.46 * strideScale;
  const shoulderTwist = sin * 0.13 * gait;
  const bob = gait > 0.001
    ? (-Math.pow(Math.abs(cos), 4) * 0.016 * gait - Math.max(leftHeel, rightHeel) * 0.35)
    : 0;
  const hipDrop = 0.026 * gait;

  ud.rig.position.y = bob;
  ud.rig.position.x = -sin * 0.02 * gait;
  ud.rig.rotation.x = 0.018 * gait + speedRatio * 0.04 * gait + (hurry - 1) * 0.04 * gait;
  ud.rig.rotation.z = -sin * 0.024 * gait - turnLean;

  if (ud.leftLeg) {
    ud.leftLeg.position.y += (leftSwing * 0.026 - leftStance * hipDrop) * gait;
    ud.leftLeg.rotation.x = swing;
    ud.leftLeg.rotation.z = sin * 0.03 * gait;
  }
  if (ud.rightLeg) {
    ud.rightLeg.position.y += (rightSwing * 0.026 - rightStance * hipDrop) * gait;
    ud.rightLeg.rotation.x = -swing;
    ud.rightLeg.rotation.z = -sin * 0.03 * gait;
  }
  if (ud.leftShin) {
    ud.leftShin.rotation.x = (leftSwing * 0.82 - leftStance * 0.07 + leftHeel * 0.04) * gait;
  }
  if (ud.rightShin) {
    ud.rightShin.rotation.x = (rightSwing * 0.82 - rightStance * 0.07 + rightHeel * 0.04) * gait;
  }

  const footNeutralX = ud.footNeutralX ?? Math.PI * 0.5;
  const leftFootZ = leftSwing * 0.04 * gait * (1 - leftStance * 0.98);
  const rightFootZ = rightSwing * 0.04 * gait * (1 - rightStance * 0.98);
  if (ud.leftFoot) {
    ud.leftFoot.position.y += leftSwing * 0.052 * gait * (1 - leftStance * 0.92);
    ud.leftFoot.position.z += leftFootZ;
    ud.leftFoot.rotation.x = footNeutralX
      + (leftSwing * 0.3 - leftStance * 0.12 + leftHeel * 0.08) * gait;
  }
  if (ud.rightFoot) {
    ud.rightFoot.position.y += rightSwing * 0.052 * gait * (1 - rightStance * 0.92);
    ud.rightFoot.position.z += rightFootZ;
    ud.rightFoot.rotation.x = footNeutralX
      + (rightSwing * 0.3 - rightStance * 0.12 + rightHeel * 0.08) * gait;
  }

  if (ud.leftArm) {
    ud.leftArm.rotation.x = -swing * 0.74 * armSwing;
    ud.leftArm.rotation.y = -shoulderTwist * 0.42;
    ud.leftArm.rotation.z = -0.045 - forwardLeft * 0.018 * gait;
  }
  if (ud.rightArm) {
    ud.rightArm.rotation.x = swing * 0.74 * armSwing;
    ud.rightArm.rotation.y = shoulderTwist * 0.42;
    ud.rightArm.rotation.z = 0.045 + forwardRight * 0.018 * gait;
  }
  if (ud.leftForearm) {
    ud.leftForearm.rotation.x = (-0.13 - stanceLeft * 0.16) * gait;
    ud.leftForearm.rotation.z = -0.035;
  }
  if (ud.rightForearm) {
    ud.rightForearm.rotation.x = (-0.13 - stanceRight * 0.16) * gait;
    ud.rightForearm.rotation.z = 0.035;
  }
  if (ud.body) {
    ud.body.rotation.y = -shoulderTwist * 0.72 + turnLean * 0.32;
    ud.body.rotation.z = -sin * 0.022 * gait;
    ud.body.rotation.x += speedRatio * 0.03 * gait;
  }
  if (ud.headPivot) {
    ud.headPivot.rotation.y += turnLean * 0.8;
    ud.headPivot.rotation.x += -speedRatio * 0.04 * gait;
  }
}

export function applyIdleLayer(ud, t, intensity = 1) {
  if (!ud?.rig || intensity <= 0) return;
  const sway = Math.sin(t * 0.7) * 0.012 * intensity;
  const breath = Math.sin(t * 1.45) * 0.006 * intensity;
  ud.rig.position.x += sway;
  ud.rig.rotation.z += -sway * 1.2;
  ud.rig.scale?.set?.(1 + breath, 1 + breath * 1.3, 1 + breath);
  if (ud.body) {
    ud.body.rotation.x += Math.sin(t * 0.5) * 0.018 * intensity;
    ud.body.rotation.z += sway * 1.1;
  }
  if (ud.headPivot) {
    ud.headPivot.rotation.y += Math.sin(t * 0.65) * 0.16 * intensity;
  }
  if (ud.leftLeg) ud.leftLeg.position.y += Math.max(0, -sway) * 0.35;
  if (ud.rightLeg) ud.rightLeg.position.y += Math.max(0, sway) * 0.35;
}

export function applyWorkGesture(ud, jobId, t, intensity = 1) {
  if (!ud || intensity <= 0) return;
  const w = intensity;
  const beat = t * 2.2;
  if (ud.headPivot) ud.headPivot.rotation.x += (0.1 + Math.sin(beat * 0.55) * 0.08) * w;

  switch (jobId) {
    case 'cleaner':
      if (ud.body) ud.body.rotation.x += 0.16 * w;
      if (ud.rightArm) {
        ud.rightArm.rotation.x += (-0.52 + Math.sin(beat) * 0.3) * w;
        ud.rightArm.rotation.z += -0.26 * w;
      }
      if (ud.leftArm) {
        ud.leftArm.rotation.x += (-0.38 - Math.sin(beat) * 0.24) * w;
        ud.leftArm.rotation.z += 0.12 * w;
      }
      if (ud.rig) ud.rig.rotation.y += Math.sin(beat) * 0.12 * w;
      break;
    case 'tourist':
      if (ud.leftArm) {
        ud.leftArm.rotation.x += -1.08 * w;
        ud.leftArm.rotation.z += -0.18 * w;
      }
      if (ud.rightArm) {
        ud.rightArm.rotation.x += -1.18 * w;
        ud.rightArm.rotation.z += 0.14 * w;
      }
      if (ud.headPivot) ud.headPivot.rotation.x += -0.08 * w;
      break;
    case 'phone':
      if (ud.rightArm) {
        ud.rightArm.rotation.x += -0.88 * w;
        ud.rightArm.rotation.z += 0.09 * w;
      }
      if (ud.rightForearm) ud.rightForearm.rotation.x += -0.72 * w;
      if (ud.headPivot) {
        ud.headPivot.rotation.x += 0.28 * w;
        ud.headPivot.rotation.y += Math.sin(beat * 0.35) * 0.08 * w;
      }
      break;
    case 'barista':
      if (ud.rightArm) ud.rightArm.rotation.x += -0.64 * w;
      if (ud.rightForearm) ud.rightForearm.rotation.x += -0.82 * w;
      if (ud.leftArm) ud.leftArm.rotation.x += (-0.3 + Math.sin(beat * 0.75) * 0.08) * w;
      if (ud.body) ud.body.rotation.z += Math.sin(beat * 0.5) * 0.035 * w;
      break;
    case 'courier':
      if (ud.rightArm) {
        ud.rightArm.rotation.x += -0.36 * w;
        ud.rightArm.rotation.z += 0.11 * w;
      }
      if (ud.rightForearm) ud.rightForearm.rotation.x += -0.82 * w;
      if (ud.leftArm) ud.leftArm.rotation.x += -0.42 * w;
      if (ud.body) {
        ud.body.rotation.x += 0.05 * w;
        ud.body.rotation.z += -0.024 * w;
      }
      break;
    case 'worker':
      if (ud.body) ud.body.rotation.x += 0.09 * w;
      if (ud.rightArm) ud.rightArm.rotation.x += (-0.68 + Math.sin(beat) * 0.22) * w;
      if (ud.rightForearm) ud.rightForearm.rotation.x += -0.48 * w;
      if (ud.rig) ud.rig.rotation.y += Math.sin(beat * 0.42) * 0.06 * w;
      break;
    default:
      if (ud.rightArm) ud.rightArm.rotation.x += (-0.7 + Math.sin(beat) * 0.25) * w;
      if (ud.rightForearm) ud.rightForearm.rotation.x += -0.48 * w;
      break;
  }
}

export function applyWeatherLayer(ud, weather, intensity = 1) {
  if (!ud || intensity <= 0 || !weather || weather === 'clear') return;
  if (weather === 'drizzle') {
    const hunch = 0.1 * intensity;
    if (ud.body) ud.body.rotation.x += hunch;
    if (ud.headPivot) ud.headPivot.rotation.x += 0.08 * intensity;
  } else if (weather === 'fog') {
    if (ud.body) ud.body.rotation.x += 0.04 * intensity;
    if (ud.headPivot) {
      ud.headPivot.rotation.x += 0.04 * intensity;
      ud.headPivot.rotation.y *= 0.85;
    }
  }
}

export function applySocialFacing(ud, localYaw = 0) {
  if (!ud?.headPivot) return;
  const yaw = THREE.MathUtils.clamp(localYaw, -0.92, 0.92);
  ud.headPivot.rotation.y = yaw;
  if (ud.body) ud.body.rotation.y = THREE.MathUtils.clamp(localYaw * 0.22, -0.2, 0.2);
}

export function applyCrossWaitGlance(ud, t) {
  if (!ud?.headPivot) return;
  const glance = Math.sin(t * 1.8);
  ud.headPivot.rotation.y = glance > 0 ? 0.62 : -0.62;
  if (ud.body) ud.body.rotation.y = ud.headPivot.rotation.y * 0.12;
}

export function resetAdditivePose(ud) {
  if (!ud?.rig) return;
  ud.rig.position.set(0, 0, 0);
  ud.rig.rotation.set(0, 0, 0);
  if (ud.rig.scale) ud.rig.scale.set(1, 1, 1);
  for (const key of [
    'body', 'headPivot',
    'leftArm', 'rightArm', 'leftForearm', 'rightForearm',
    'leftLeg', 'rightLeg', 'leftShin', 'rightShin',
  ]) {
    const bone = ud[key];
    if (bone?.rotation) bone.rotation.set(0, 0, 0);
  }
  const footNeutralX = ud.footNeutralX ?? Math.PI * 0.5;
  if (ud.leftFoot?.rotation) ud.leftFoot.rotation.set(footNeutralX, 0, 0);
  if (ud.rightFoot?.rotation) ud.rightFoot.rotation.set(footNeutralX, 0, 0);
  if (ud.leftFoot?.position) ud.leftFoot.position.set(ud.leftFoot.position.x, ud.leftFootY ?? 0, ud.leftFootZ ?? 0);
  if (ud.rightFoot?.position) ud.rightFoot.position.set(ud.rightFoot.position.x, ud.rightFootY ?? 0, ud.rightFootZ ?? 0);
}
