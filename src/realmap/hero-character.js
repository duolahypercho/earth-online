import * as THREE from 'three';
import {
  animatePlayerAvatar,
  createPlayerAvatar,
} from '../player.js';

const DEFAULT_FOCUS_HEIGHT = 1.08;
const MAX_DELTA_SECONDS = 0.05;

/**
 * Player-grade presentation adapter for the real-map hero tile.
 *
 * It deliberately wraps the shared close-range player rig instead of creating
 * another local avatar.  `root` can be positioned/rotated directly by the
 * map controller; use `update()` once per rendered frame for the grounded
 * locomotion and `getCameraFocus()` for a stable third-person look target.
 */
export function createHeroCharacter({
  name = 'Traveler',
  paletteIndex = 0,
  scale = 1,
  showNameTag = false,
  cameraFocusHeight = DEFAULT_FOCUS_HEIGHT,
} = {}) {
  const root = createPlayerAvatar({ name, paletteIndex, scale });
  root.name = `Ferry Building hero character / ${name}`;

  // The shared hero meshes were authored for close crowd shots. Making this
  // single controlled player an explicit caster gives Ferry Plaza pavement a
  // crisp near-field anchor when the renderer's shadow map is enabled.
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });

  const shadow = root.userData.shadow;
  if (shadow) {
    shadow.name = 'Hero contact shadow';
    shadow.position.y = -0.105;
    shadow.material.opacity = 0.58;
    shadow.scale.set(1.08, 1, 0.86);
    shadow.userData.heroCharacterOwned = true;
  }

  let elapsed = 0;
  let disposed = false;
  const focusHeight = Number.isFinite(cameraFocusHeight)
    ? Math.max(0.2, cameraFocusHeight)
    : DEFAULT_FOCUS_HEIGHT;

  function setNameTagVisible(visible = false) {
    const nameTag = root.userData.nameTag;
    if (nameTag) nameTag.visible = Boolean(visible);
  }

  function update({
    moving = false,
    speedRatio = 0,
    delta = 1 / 60,
    turnLean = 0,
    time,
  } = {}) {
    if (disposed) return;
    const safeDelta = THREE.MathUtils.clamp(Number(delta) || 0, 0, MAX_DELTA_SECONDS);
    elapsed = Number.isFinite(time) ? time : elapsed + safeDelta;
    animatePlayerAvatar(root, {
      moving: Boolean(moving),
      speedRatio: THREE.MathUtils.clamp(Number(speedRatio) || 0, 0, 1.25),
      elapsed,
      delta: safeDelta,
      turnLean: THREE.MathUtils.clamp(Number(turnLean) || 0, -0.22, 0.22),
    });
  }

  function getCameraFocus(target = new THREE.Vector3()) {
    return root.localToWorld(target.set(0, focusHeight, 0));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();

    // The skinned hero's wardrobe geometry/materials are shared with the
    // pedestrian system and must remain alive. Only this adapter's canvas
    // textures, materials, and circle geometry are private allocations.
    const nameTag = root.userData.nameTag;
    const nameMaterial = nameTag?.material;
    nameMaterial?.map?.dispose?.();
    nameMaterial?.dispose?.();
    if (nameTag) root.remove(nameTag);

    if (shadow) {
      const shadowMaterial = shadow.material;
      shadowMaterial?.alphaMap?.dispose?.();
      shadowMaterial?.dispose?.();
      shadow.geometry?.dispose?.();
      root.remove(shadow);
    }
  }

  setNameTagVisible(showNameTag);
  root.userData.heroCharacter = true;

  return Object.freeze({
    root,
    update,
    setNameTagVisible,
    getCameraFocus,
    dispose,
    get disposed() {
      return disposed;
    },
  });
}
