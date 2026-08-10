import { createHash } from 'node:crypto';

const COMPONENT_BYTES = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
const TYPE_COMPONENTS = new Map([['SCALAR', 1], ['VEC2', 2], ['VEC3', 3], ['VEC4', 4], ['MAT2', 4], ['MAT3', 9], ['MAT4', 16]]);

function fail(message) {
  throw new Error(`Invalid Ferry Market Arcade GLB: ${message}`);
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let index = 0; index < 4; index += 1) out[column * 4 + row] += a[index * 4 + row] * b[column * 4 + index];
    }
  }
  return out;
}

function localMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * y * y - 2 * z * z) * sx, (2 * x * y + 2 * z * w) * sx, (2 * x * z - 2 * y * w) * sx, 0,
    (2 * x * y - 2 * z * w) * sy, (1 - 2 * x * x - 2 * z * z) * sy, (2 * y * z + 2 * x * w) * sy, 0,
    (2 * x * z + 2 * y * w) * sz, (2 * y * z - 2 * x * w) * sz, (1 - 2 * x * x - 2 * y * y) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function transform(matrix, position) {
  const [x, y, z] = position;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function componentReader(view, componentType, offset) {
  if (componentType === 5120) return view.getInt8(offset);
  if (componentType === 5121) return view.getUint8(offset);
  if (componentType === 5122) return view.getInt16(offset, true);
  if (componentType === 5123) return view.getUint16(offset, true);
  if (componentType === 5125) return view.getUint32(offset, true);
  if (componentType === 5126) return view.getFloat32(offset, true);
  fail(`unsupported component type ${componentType}`);
}

function accessorValues(json, bin, accessorIndex) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) fail(`missing accessor ${accessorIndex}`);
  if (accessor.sparse) fail(`sparse accessor ${accessorIndex} is unsupported`);
  const bufferView = json.bufferViews?.[accessor.bufferView];
  if (!bufferView || bufferView.buffer !== 0) fail(`accessor ${accessorIndex} must reference embedded buffer 0`);
  const componentBytes = COMPONENT_BYTES.get(accessor.componentType);
  const components = TYPE_COMPONENTS.get(accessor.type);
  if (!componentBytes || !components) fail(`accessor ${accessorIndex} has unsupported layout`);
  const elementBytes = componentBytes * components;
  const stride = bufferView.byteStride ?? elementBytes;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (start + Math.max(0, accessor.count - 1) * stride + elementBytes > bin.length) fail(`accessor ${accessorIndex} exceeds BIN chunk`);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  return Array.from({ length: accessor.count }, (_, element) => Array.from({ length: components }, (__, component) => componentReader(view, accessor.componentType, start + element * stride + component * componentBytes)));
}

function primitiveTriangles(primitive, json) {
  const accessor = json.accessors?.[primitive.indices ?? primitive.attributes?.POSITION];
  if (!accessor) fail('primitive has no indices or POSITION accessor');
  const count = accessor.count;
  const mode = primitive.mode ?? 4;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function parseGlb(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) fail('invalid GLB 2.0 header');
  let offset = 12;
  const chunks = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 || offset + length > bytes.length) fail('invalid chunk alignment or length');
    chunks.push({ type, data: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  if (chunks.length !== 2 || chunks[0].type !== 0x4e4f534a || chunks[1].type !== 0x004e4942) fail('expected one JSON and one BIN chunk');
  const json = JSON.parse(chunks[0].data.toString('utf8').replace(/\0+$/u, '').trim());
  if (json.asset?.version !== '2.0') fail('asset.version must be 2.0');
  return { json, bin: chunks[1].data };
}

function collectUris(value, found = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectUris(child, found);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri' && typeof child === 'string') found.push(child);
      collectUris(child, found);
    }
  }
  return found;
}

export function inspectFerryMarketGlb(bytes) {
  const { json, bin } = parseGlb(bytes);
  const externalUris = collectUris(json);
  const cameras = (json.cameras ?? []).length + (json.nodes ?? []).filter((node) => node.camera !== undefined).length;
  const lights = json.extensions?.KHR_lights_punctual?.lights?.length ?? 0;
  const nodeLights = (json.nodes ?? []).filter((node) => node.extensions?.KHR_lights_punctual?.light !== undefined).length;
  const emissiveMaterials = (json.materials ?? []).filter((material) => material.emissiveTexture || (material.emissiveFactor ?? [0, 0, 0]).some((value) => value !== 0) || material.extensions?.KHR_materials_emissive_strength).length;
  const roots = json.scenes?.[json.scene ?? 0]?.nodes;
  if (!Array.isArray(roots) || roots.length === 0) fail('default scene has no root nodes');
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let triangles = 0;
  let meshInstances = 0;
  const walk = (nodeIndex, parentMatrix, ancestors) => {
    if (ancestors.has(nodeIndex)) fail(`node cycle at ${nodeIndex}`);
    const node = json.nodes?.[nodeIndex];
    if (!node) fail(`missing node ${nodeIndex}`);
    const matrix = multiply(parentMatrix, localMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh];
      if (!mesh) fail(`missing mesh ${node.mesh}`);
      meshInstances += 1;
      for (const primitive of mesh.primitives ?? []) {
        triangles += primitiveTriangles(primitive, json);
        const positions = accessorValues(json, bin, primitive.attributes?.POSITION);
        if (positions[0]?.length !== 3) fail('POSITION accessor must be VEC3');
        for (const position of positions) {
          const point = transform(matrix, position);
          for (let axis = 0; axis < 3; axis += 1) {
            bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
            bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
          }
        }
      }
    }
    const nextAncestors = new Set(ancestors).add(nodeIndex);
    for (const child of node.children ?? []) walk(child, matrix, nextAncestors);
  };
  for (const root of roots) walk(root, identity, new Set());
  if (!meshInstances || !Number.isFinite(bounds.min[1])) fail('default scene has no measurable mesh instances');
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    triangles,
    materials: (json.materials ?? []).length,
    meshInstances,
    externalUris,
    cameras,
    lights: lights + nodeLights,
    emissiveMaterials,
    boundsMeters: bounds,
    minYMeters: bounds.min[1],
  };
}
