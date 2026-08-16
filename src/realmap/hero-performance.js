/**
 * Opt-in runtime controls for a small, high-fidelity hero tile.
 *
 * Nothing in this module mutates a scene unless its caller explicitly invokes
 * one of the exported functions.  In particular, culling and LOD changes only
 * apply to objects marked with `userData.heroPerformance`.
 */

export const HERO_PERFORMANCE_DEFAULTS = Object.freeze({
  pixelRatioCap: 1.35,
  shadowRefreshMs: 180,
  reflectionRefreshMs: 250,
  cullDistance: 540,
});

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function resolveHeroPerformanceOptions(options = {}) {
  return {
    pixelRatioCap: finitePositive(options.pixelRatioCap, HERO_PERFORMANCE_DEFAULTS.pixelRatioCap),
    shadowRefreshMs: finitePositive(options.shadowRefreshMs, HERO_PERFORMANCE_DEFAULTS.shadowRefreshMs),
    reflectionRefreshMs: finitePositive(options.reflectionRefreshMs, HERO_PERFORMANCE_DEFAULTS.reflectionRefreshMs),
    cullDistance: finitePositive(options.cullDistance, HERO_PERFORMANCE_DEFAULTS.cullDistance),
  };
}

/**
 * Schedules expensive off-screen passes at a fixed cadence. Use one for a
 * planar/cube reflection, and one for shadow invalidation. `force` is useful
 * after a teleport, time-of-day change, or a major scene edit.
 */
export function createCadencedUpdater(update, { intervalMs = 250 } = {}) {
  if (typeof update !== 'function') throw new TypeError('A cadence update callback is required.');
  const interval = finitePositive(intervalMs, 250);
  let lastUpdateAt = -Infinity;

  return {
    tick(now, { force = false } = {}) {
      if (!Number.isFinite(now)) return false;
      if (!force && now - lastUpdateAt < interval) return false;
      lastUpdateAt = now;
      update();
      return true;
    },
    invalidate() {
      lastUpdateAt = -Infinity;
    },
  };
}

/**
 * Applies a conservative DPR cap and converts real-time shadows to an
 * on-demand pass. This keeps shadow quality; callers advance it with tick().
 * The return value restores the prior renderer/sun state when leaving hero
 * mode, so it is safe to share a renderer with the normal map experience.
 */
export function enableHeroPerformanceMode({ renderer, sun, options } = {}) {
  if (!renderer) throw new TypeError('A WebGL renderer is required.');
  const profile = resolveHeroPerformanceOptions(options);
  const devicePixelRatio = typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1);
  const prior = {
    pixelRatio: renderer.getPixelRatio?.(),
    shadowAutoUpdate: renderer.shadowMap?.autoUpdate,
    shadowNeedsUpdate: renderer.shadowMap?.needsUpdate,
    sunCastShadow: sun?.castShadow,
  };

  renderer.setPixelRatio?.(Math.min(devicePixelRatio, profile.pixelRatioCap));
  if (renderer.shadowMap) {
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
  }
  if (sun?.castShadow != null) sun.castShadow = true;

  const shadowCadence = createCadencedUpdater(() => {
    if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true;
  }, { intervalMs: profile.shadowRefreshMs });

  return {
    profile,
    tick(now, { forceShadows = false } = {}) {
      return shadowCadence.tick(now, { force: forceShadows });
    },
    invalidateShadows: () => shadowCadence.invalidate(),
    dispose() {
      if (prior.pixelRatio != null) renderer.setPixelRatio?.(prior.pixelRatio);
      if (renderer.shadowMap) {
        renderer.shadowMap.autoUpdate = prior.shadowAutoUpdate;
        renderer.shadowMap.needsUpdate = prior.shadowNeedsUpdate;
      }
      if (sun?.castShadow != null) sun.castShadow = prior.sunCastShadow;
    },
  };
}

/**
 * Applies visibility/LOD only to explicitly marked objects:
 *
 *   mesh.userData.heroPerformance = { cullDistance: 380, near: nearMesh, far: farMesh }
 *
 * This deliberately does not infer bounds or hide unmarked city geometry;
 * preserving OSM-derived landmark correctness is more important than an
 * aggressive automatic culler.
 */
export function updateHeroLodAndCulling(root, cameraPosition, options = {}) {
  if (!root?.traverse || !cameraPosition) return { tested: 0, culled: 0, lodSwaps: 0 };
  const profile = resolveHeroPerformanceOptions(options);
  const cameraX = Number(cameraPosition.x) || 0;
  const cameraY = Number(cameraPosition.y) || 0;
  const cameraZ = Number(cameraPosition.z) || 0;
  const result = { tested: 0, culled: 0, lodSwaps: 0 };

  root.traverse((object) => {
    const settings = object.userData?.heroPerformance;
    if (!settings) return;
    result.tested += 1;
    const position = object.getWorldPosition ? object.getWorldPosition(object.position.clone()) : object.position;
    if (!position) return;
    const distance = Math.hypot(position.x - cameraX, position.y - cameraY, position.z - cameraZ);
    const cullDistance = finitePositive(settings.cullDistance, profile.cullDistance);
    const visible = distance <= cullDistance;
    if (object.visible !== visible) {
      object.visible = visible;
      if (!visible) result.culled += 1;
    }
    if (!visible || !settings.near || !settings.far) return;
    const useNear = distance <= finitePositive(settings.lodDistance, cullDistance * 0.48);
    if (settings.near.visible !== useNear) {
      settings.near.visible = useNear;
      settings.far.visible = !useNear;
      result.lodSwaps += 1;
    }
  });
  return result;
}

/**
 * Scene/render accounting that works without relying on private application
 * state. Triangle count is geometric capacity; rendered counts stay available
 * from renderer.info after a render pass.
 */
export function collectHeroRenderStats(root, renderer) {
  const stats = {
    objects: 0,
    meshes: 0,
    visibleMeshes: 0,
    instancedMeshes: 0,
    lights: 0,
    trianglesInScene: 0,
    drawCalls: renderer?.info?.render?.calls ?? 0,
    renderedTriangles: renderer?.info?.render?.triangles ?? 0,
  };
  root?.traverse?.((object) => {
    stats.objects += 1;
    if (object.isLight) stats.lights += 1;
    if (!object.isMesh || !object.geometry) return;
    stats.meshes += 1;
    if (object.visible) stats.visibleMeshes += 1;
    if (object.isInstancedMesh) stats.instancedMeshes += 1;
    const position = object.geometry.attributes?.position;
    if (!position) return;
    const triangleCount = (object.geometry.index?.count ?? position.count) / 3;
    stats.trianglesInScene += triangleCount * (object.count ?? 1);
  });
  stats.trianglesInScene = Math.round(stats.trianglesInScene);
  return stats;
}
