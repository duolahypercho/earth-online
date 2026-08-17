import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  collectSourceToneAttributeBytes,
  normalizeTilePresentation,
  verifyParsedGlbMetricContract,
  verifyParsedGlbPresentation,
  verifyProductionPresentationAuthorization,
  verifyReceiptPresentation,
  verifyScenePresentation,
} from '../sf-map/building-presentation-contract.js';

const BASE_URL = import.meta.env.BASE_URL;
const MANIFEST_PATH = 'data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json';
const FERRY_TILE_ID = 'epsg26910-1441-10893';
const FERRY_LOCAL_FOCUS = Object.freeze([98.056, 336.015]);
// Only the Ferry tile is covered by the current production presentation and
// horizontal-geometry authorization. Keep the loader fail-closed by default;
// callers must not infer citywide authority from the wider byte-valid manifest.
const DEFAULT_TILE_COUNT = 1;

function publicPath(value) {
  return String(value || '').replace(/^\.?\/?public\//, '').replace(/^\//, '');
}

function artifact(value, tileId, label) {
  const path = publicPath(value?.path);
  const match = String(value?.sha256 || '').match(/^(?:sha256:)?([a-f0-9]{64})$/i);
  if (!path || !match) throw new Error(`${tileId} ${label} is not byte-locked`);
  return { path, sha256: match[1].toLowerCase() };
}

function descriptorFromManifest(raw) {
  const id = raw?.id;
  const origin = raw?.originEpsg26910VerticalMetres;
  if (!id || !Array.isArray(raw?.gridIndex) || !Array.isArray(origin) || origin.length !== 3) {
    throw new Error('Metric manifest contains an incomplete tile descriptor');
  }
  const glb = artifact(raw.lod0, id, 'LOD0');
  const receipt = artifact(raw.receipt, id, 'receipt');
  return {
    id,
    gridIndex: [...raw.gridIndex],
    origin: [...origin],
    size: 384,
    glb: glb.path,
    glbSha256: `sha256:${glb.sha256}`,
    glbSha256Hex: glb.sha256,
    receipt: receipt.path,
    receiptSha256: `sha256:${receipt.sha256}`,
    receiptSha256Hex: receipt.sha256,
    presentation: normalizeTilePresentation(raw.presentation, id),
  };
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is required for metric tile loading');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchVerifiedBytes(path, expectedSha256, label) {
  const response = await fetch(`${BASE_URL}${publicPath(path)}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${label} fetch failed (${response.status})`);
  const bytes = await response.arrayBuffer();
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  return { bytes, actualSha256 };
}

function verifyReceipt(receipt, descriptor) {
  const tile = receipt?.tile;
  if (receipt?.kind !== 'sf-metric-tile-build-receipt' || tile?.identity !== descriptor.id) {
    throw new Error(`${descriptor.id} receipt identity mismatch`);
  }
  const origin = tile.originEpsg26910VerticalMetres;
  const bounds = tile.boundsEpsg26910Metres;
  if (tile.scale !== 1 || !Array.isArray(origin) || origin.some((value, index) => value !== descriptor.origin[index])) {
    throw new Error(`${descriptor.id} receipt violates the 1 unit = 1 metre origin contract`);
  }
  if (!Array.isArray(bounds) || bounds.length !== 4
    || bounds[0] !== descriptor.origin[0] || bounds[1] !== descriptor.origin[1]
    || bounds[2] - bounds[0] !== descriptor.size || bounds[3] - bounds[1] !== descriptor.size) {
    throw new Error(`${descriptor.id} receipt bounds mismatch`);
  }
}

function resourceBase(path) {
  const url = new URL(`${BASE_URL}${publicPath(path)}`, window.location.href).href;
  return url.slice(0, url.lastIndexOf('/') + 1);
}

function applyWebGpuMetricMaterials(root) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      const name = material?.name || '';
      if (name === 'terrain-night') {
        material.color.setHex(0x315848);
        material.roughness = 1;
      } else if (name === 'roads-night') {
        material.color.setHex(0x4d5a59);
        material.roughness = 0.96;
        material.polygonOffset = true;
        material.polygonOffsetFactor = -2;
        material.polygonOffsetUnits = -2;
        node.renderOrder = 2;
      } else if (name === 'buildings-night') {
        // One shared, seam-stable material response is intentional here. The
        // source-tone WebGL shader remains separately validated by its receipt,
        // but is not silently approximated during this first WebGPU integration.
        material.color.setHex(0xb97958);
        material.roughness = 0.82;
        material.metalness = 0.02;
        node.castShadow = true;
      } else if (name === 'water-osm-coastline-night') {
        material.color.setHex(0x27718a);
        material.roughness = 0.38;
        material.metalness = 0.08;
      } else if (name === 'coastline-osm-night') {
        material.color.setHex(0x438896);
      }
    }
    node.receiveShadow = true;
  });
}

function selectFerryTiles(descriptors, anchor, count) {
  const focusEasting = anchor.origin[0] + FERRY_LOCAL_FOCUS[0];
  const focusNorthing = anchor.origin[1] + FERRY_LOCAL_FOCUS[1];
  return [...descriptors]
    .sort((left, right) => {
      const leftDistance = Math.hypot(left.origin[0] + left.size / 2 - focusEasting, left.origin[1] + left.size / 2 - focusNorthing);
      const rightDistance = Math.hypot(right.origin[0] + right.size / 2 - focusEasting, right.origin[1] + right.size / 2 - focusNorthing);
      return leftDistance - rightDistance || left.id.localeCompare(right.id);
    })
    .slice(0, count);
}

async function loadDescriptor(descriptor, anchorOrigin, loader) {
  const receiptArtifact = await fetchVerifiedBytes(descriptor.receipt, descriptor.receiptSha256Hex, `${descriptor.id} receipt`);
  const receipt = JSON.parse(new TextDecoder().decode(receiptArtifact.bytes));
  verifyReceipt(receipt, descriptor);
  const presentationIntegrity = verifyReceiptPresentation(receipt, descriptor.presentation, descriptor.id);

  let authorizationIntegrity = null;
  if (descriptor.presentation.mode === 'source-tone-v1') {
    const authorizationReference = descriptor.presentation.authorization;
    const authorizationArtifact = await fetchVerifiedBytes(
      authorizationReference.path,
      authorizationReference.sha256.slice('sha256:'.length),
      `${descriptor.id} presentation authorization`,
    );
    authorizationIntegrity = verifyProductionPresentationAuthorization(
      JSON.parse(new TextDecoder().decode(authorizationArtifact.bytes)),
      descriptor,
      presentationIntegrity,
      descriptor.id,
    );
  }

  const glbArtifact = await fetchVerifiedBytes(descriptor.glb, descriptor.glbSha256Hex, `${descriptor.id} GLB`);
  const gltf = await loader.parseAsync(glbArtifact.bytes, resourceBase(descriptor.glb));
  verifyParsedGlbMetricContract(gltf, descriptor, descriptor.id);
  verifyParsedGlbPresentation(gltf, descriptor.presentation, descriptor.id);
  verifyScenePresentation(gltf.scene, descriptor.presentation, descriptor.id);
  if (descriptor.presentation.mode === 'source-tone-v1') {
    const attributeSha256 = `sha256:${await sha256Hex(collectSourceToneAttributeBytes(gltf, descriptor.presentation, descriptor.id))}`;
    if (attributeSha256 !== presentationIntegrity.sourceToneAttributeSha256) {
      throw new Error(`${descriptor.id} source-tone attribute SHA-256 mismatch`);
    }
  }

  const tile = gltf.scene;
  tile.name = `${descriptor.id} authoritative metric tile`;
  tile.position.set(
    descriptor.origin[0] - anchorOrigin[0],
    descriptor.origin[2] - anchorOrigin[2],
    descriptor.origin[1] - anchorOrigin[1],
  );
  tile.scale.setScalar(1);
  applyWebGpuMetricMaterials(tile);
  return {
    tile,
    receipt,
    integrity: {
      glbSha256: `sha256:${glbArtifact.actualSha256}`,
      receiptSha256: `sha256:${receiptArtifact.actualSha256}`,
      presentationMode: descriptor.presentation.mode,
      authorization: authorizationIntegrity?.status || null,
      originSubtractions: 1,
      sceneScale: 1,
    },
  };
}

export async function loadAuthoritativeFerryTiles({ count = DEFAULT_TILE_COUNT, onProgress = () => {} } = {}) {
  const response = await fetch(`${BASE_URL}${MANIFEST_PATH}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Metric manifest fetch failed (${response.status})`);
  const manifest = await response.json();
  if (manifest?.kind !== 'sf-metric-tile-set' || !Array.isArray(manifest.tiles) || manifest.tiles.length < 1) {
    throw new Error('Metric manifest schema is not supported');
  }
  const descriptors = manifest.tiles.map(descriptorFromManifest);
  const anchor = descriptors.find(({ id }) => id === FERRY_TILE_ID);
  if (!anchor) throw new Error(`Metric manifest is missing ${FERRY_TILE_ID}`);
  const selected = selectFerryTiles(descriptors, anchor, Math.max(1, Math.min(count, descriptors.length)));
  if (!selected.some(({ id }) => id === FERRY_TILE_ID)) throw new Error('Ferry anchor was not selected');

  const root = new THREE.Group();
  root.name = 'authoritative-sf-metric-root';
  const loader = new GLTFLoader();
  const records = [];
  for (let index = 0; index < selected.length; index += 1) {
    const descriptor = selected[index];
    onProgress({ loaded: index, total: selected.length, id: descriptor.id });
    const record = await loadDescriptor(descriptor, anchor.origin, loader);
    root.add(record.tile);
    records.push({ descriptor, receipt: record.receipt, integrity: record.integrity });
  }
  onProgress({ loaded: selected.length, total: selected.length, id: null });

  const bounds = {
    minX: Math.min(...selected.map(({ origin }) => origin[0] - anchor.origin[0])),
    maxX: Math.max(...selected.map(({ origin, size }) => origin[0] - anchor.origin[0] + size)),
    minZ: Math.min(...selected.map(({ origin }) => origin[1] - anchor.origin[1])),
    maxZ: Math.max(...selected.map(({ origin, size }) => origin[1] - anchor.origin[1] + size)),
  };
  const counts = records.reduce((totals, { receipt }) => ({
    buildings: totals.buildings + Number(receipt.counts?.emittedBuildingWays || 0),
    streets: totals.streets + Number(receipt.counts?.emittedRoadWays || 0),
  }), { buildings: 0, streets: 0 });

  return {
    root,
    bounds,
    counts,
    anchorOriginEpsg26910: [...anchor.origin],
    manifestTileCount: descriptors.length,
    tileIds: selected.map(({ id }) => id),
    records,
  };
}
