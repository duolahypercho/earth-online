import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const PERMITTED_ROLES = new Set([
  'facade-detail',
  'facade-material-proxy',
  'street-furniture',
  'vegetation-proxy',
  'non-authoritative-prop',
]);
const PROHIBITED_ROLE_TERMS = [
  'road', 'sidewalk', 'building-footprint', 'elevation', 'terrain', 'shoreline',
  'navigation', 'collision', 'traffic', 'npc', 'water', 'public-runtime',
];
const SHA256 = /^[a-f0-9]{64}$/i;

function fail(message) {
  throw new Error(`Hunyuan candidate rejected: ${message}`);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} is required`);
  return value.trim();
}

function requiredSha256(value, name) {
  const digest = requiredString(value, name);
  if (!SHA256.test(digest)) fail(`${name} must be a SHA-256 hex digest`);
  return digest.toLowerCase();
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readU32(buffer, offset) {
  if (offset + 4 > buffer.length) fail('GLB ends inside a uint32 field');
  return buffer.readUInt32LE(offset);
}

function findUri(value, path = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUri(value[index], `${path}[${index}]`);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri') return path;
      const found = findUri(child, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

function accessorComponentBytes(componentType) {
  const sizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  if (!sizes[componentType]) fail(`unsupported accessor componentType ${componentType}`);
  return sizes[componentType];
}

function accessorComponents(type) {
  const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  if (!sizes[type]) fail(`unsupported accessor type ${type}`);
  return sizes[type];
}

function primitiveTriangles(primitive, accessors) {
  const mode = primitive.mode ?? 4;
  const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
  if (!Number.isInteger(accessorIndex) || accessorIndex < 0 || accessorIndex >= accessors.length) {
    fail('mesh primitive must have a valid POSITION or indices accessor');
  }
  const count = accessors[accessorIndex].count;
  if (![4, 5, 6].includes(mode)) return 0;
  return mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2);
}

function imageDimensions(image, data, index) {
  if (image.mimeType === 'image/png') {
    if (data.length < 24 || data.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0) {
      fail(`images[${index}] is not a valid PNG payload`);
    }
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (image.mimeType === 'image/jpeg') {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) fail(`images[${index}] is not a valid JPEG payload`);
    let offset = 2;
    while (offset + 9 <= data.length) {
      while (data[offset] === 0xff) offset += 1;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > data.length) break;
      const segmentLength = data.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
      }
      offset += segmentLength;
    }
    fail(`images[${index}] has no JPEG frame header`);
  }
  fail(`images[${index}] uses unsupported embedded mimeType ${image.mimeType ?? '(missing)'}; only image/png and image/jpeg are budgeted`);
}

export function parseGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) fail('GLB is too short');
  if (readU32(buffer, 0) !== GLB_MAGIC) fail('wrong GLB magic');
  if (readU32(buffer, 4) !== GLB_VERSION) fail('GLB must declare container version 2');
  if (readU32(buffer, 8) !== buffer.length) fail('GLB declared length does not match file length');

  let offset = 12;
  const chunks = [];
  while (offset < buffer.length) {
    const length = readU32(buffer, offset);
    const type = readU32(buffer, offset + 4);
    offset += 8;
    if (length % 4 !== 0 || offset + length > buffer.length) fail('GLB chunk has invalid alignment or length');
    chunks.push({ type, data: buffer.subarray(offset, offset + length) });
    offset += length;
  }
  if (offset !== buffer.length || chunks.length < 2) fail('GLB must have complete JSON and BIN chunks');
  if (chunks[0].type !== CHUNK_JSON || chunks.filter((chunk) => chunk.type === CHUNK_JSON).length !== 1) {
    fail('GLB must have exactly one first JSON chunk');
  }
  if (chunks.filter((chunk) => chunk.type === CHUNK_BIN).length !== 1 || chunks.some((chunk) => ![CHUNK_JSON, CHUNK_BIN].includes(chunk.type))) {
    fail('GLB must have exactly one BIN chunk and no unsupported chunks');
  }

  let json;
  try {
    json = JSON.parse(chunks[0].data.toString('utf8').replace(/\0+$/u, '').trim());
  } catch (error) {
    fail(`GLB JSON chunk is invalid: ${error.message}`);
  }
  if (json?.asset?.version !== '2.0') fail('glTF asset.version must be exactly 2.0');
  const uriPath = findUri(json);
  if (uriPath) fail(`GLB must be self-contained; uri is forbidden at ${uriPath}`);
  const binary = chunks.find((chunk) => chunk.type === CHUNK_BIN).data;
  if (!Array.isArray(json.buffers) || json.buffers.length !== 1) fail('GLB must declare exactly one embedded buffer');
  if (positiveInteger(json.buffers[0].byteLength, 'buffers[0].byteLength') > binary.length) {
    fail('declared buffer length exceeds BIN chunk length');
  }
  return { json, binary };
}

export function inspectGlb(buffer, budgets) {
  const { json, binary } = parseGlb(buffer);
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  for (const [index, view] of bufferViews.entries()) {
    if (view.buffer !== 0) fail(`bufferViews[${index}] must reference embedded buffer 0`);
    const byteOffset = view.byteOffset ?? 0;
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength < 0) {
      fail(`bufferViews[${index}] has invalid byte bounds`);
    }
    if (byteOffset + view.byteLength > binary.length) fail(`bufferViews[${index}] exceeds BIN chunk`);
  }
  for (const [index, accessor] of accessors.entries()) {
    const count = positiveInteger(accessor.count, `accessors[${index}].count`);
    const bytes = accessorComponentBytes(accessor.componentType) * accessorComponents(accessor.type);
    if (accessor.bufferView !== undefined) {
      const view = bufferViews[accessor.bufferView];
      if (!view) fail(`accessors[${index}] references a missing bufferView`);
      const stride = view.byteStride ?? bytes;
      const byteOffset = accessor.byteOffset ?? 0;
      if (!Number.isSafeInteger(stride) || stride < bytes || !Number.isSafeInteger(byteOffset) || byteOffset < 0) {
        fail(`accessors[${index}] has invalid stride or byte offset`);
      }
      if (byteOffset + ((count - 1) * stride) + bytes > view.byteLength) fail(`accessors[${index}] exceeds its bufferView`);
    }
  }

  let vertices = 0;
  let triangles = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const positionAccessor = primitive.attributes?.POSITION;
      if (!Number.isInteger(positionAccessor) || !accessors[positionAccessor]) fail('mesh primitive needs a POSITION accessor');
      vertices += accessors[positionAccessor].count;
      triangles += primitiveTriangles(primitive, accessors);
    }
  }
  const images = Array.isArray(json.images) ? json.images.length : 0;
  const textureDimensions = (json.images ?? []).map((image, index) => {
    if (!Number.isInteger(image.bufferView) || !bufferViews[image.bufferView]) fail(`images[${index}] must use an embedded bufferView`);
    const view = bufferViews[image.bufferView];
    const payload = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const { width, height } = imageDimensions(image, payload, index);
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) fail(`images[${index}] has invalid dimensions`);
    return Math.max(width, height);
  });
  if (buffer.length > budgets.maxBytes) fail(`GLB byte size ${buffer.length} exceeds maxBytes ${budgets.maxBytes}`);
  if (vertices > budgets.maxVertices) fail(`vertex count ${vertices} exceeds maxVertices ${budgets.maxVertices}`);
  if (triangles > budgets.maxTriangles) fail(`triangle count ${triangles} exceeds maxTriangles ${budgets.maxTriangles}`);
  if (images > budgets.maxImages) fail(`image count ${images} exceeds maxImages ${budgets.maxImages}`);
  if (textureDimensions.some((dimension) => dimension > budgets.maxTextureDimension)) fail('declared texture dimension exceeds maxTextureDimension');
  return { bytes: buffer.length, vertices, triangles, images, maxTextureDimension: Math.max(0, ...textureDimensions) };
}

export function validateProvenance(provenance, contentDigest) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) fail('provenance must be a JSON object');
  if (provenance.schemaVersion !== 'hunyuan3d-candidate-v1') fail('schemaVersion must be hunyuan3d-candidate-v1');
  requiredString(provenance.candidateId, 'candidateId');
  const role = requiredString(provenance.assetRole, 'assetRole');
  if (!PERMITTED_ROLES.has(role) || PROHIBITED_ROLE_TERMS.some((term) => role.includes(term))) {
    fail(`assetRole ${role} is not permitted for a candidate`);
  }
  if (provenance.geospatialAuthority !== false) fail('geospatialAuthority must be false');
  if (requiredSha256(provenance.content?.sha256, 'content.sha256') !== contentDigest) fail('content.sha256 does not match GLB bytes');
  if (provenance.model?.family !== 'Hunyuan3D-2.1') fail('model.family must be Hunyuan3D-2.1');
  requiredString(provenance.model?.name, 'model.name');
  requiredString(provenance.model?.checkpoint, 'model.checkpoint');
  requiredString(provenance.model?.sourceRepository, 'model.sourceRepository');
  requiredString(provenance.license?.id, 'license.id');
  requiredString(provenance.license?.sourceUrl, 'license.sourceUrl');
  requiredString(provenance.license?.reviewedAt, 'license.reviewedAt');
  requiredString(provenance.rights?.inputRights, 'rights.inputRights');
  requiredString(provenance.rights?.outputRights, 'rights.outputRights');
  if (provenance.rights?.distributionAllowed !== false) fail('rights.distributionAllowed must be false during quarantine');
  requiredSha256(provenance.input?.digestSha256, 'input.digestSha256');
  requiredString(provenance.prompt, 'prompt');
  if (!(Number.isSafeInteger(provenance.seed) || (typeof provenance.seed === 'string' && provenance.seed.trim()))) fail('seed is required');
  for (const key of ['generatorVersion', 'runtime', 'operatingSystem', 'gpu', 'cuda', 'generatedAt']) {
    requiredString(provenance.environment?.[key], `environment.${key}`);
  }
  const coordinate = provenance.coordinate;
  if (coordinate?.upAxis !== '+Y' || coordinate?.unit !== 'meters' || coordinate?.forwardAxis !== '-Z') {
    fail('coordinate must declare +Y up, meters, and -Z forward');
  }
  const budgets = provenance.budgets;
  for (const key of ['maxBytes', 'maxVertices', 'maxTriangles', 'maxImages', 'maxTextureDimension']) positiveInteger(budgets?.[key], `budgets.${key}`);
  if (provenance.review?.status !== 'quarantined' || provenance.review?.promotionApproved !== false) {
    fail('review must remain quarantined with promotionApproved false');
  }
  return budgets;
}

function assertQuarantineDir(directory) {
  const publicDir = resolve(process.cwd(), 'public');
  const target = resolve(directory);
  if (target === publicDir || relative(publicDir, target) === '' || !relative(publicDir, target).startsWith('..')) {
    fail('quarantine destination may not be inside public');
  }
  return target;
}

export async function importCandidate({ glbPath, provenancePath, quarantineDir = 'private/quarantine/hunyuan3d' }) {
  if (!isAbsolute(glbPath) || !isAbsolute(provenancePath)) fail('use absolute --glb and --provenance paths');
  const [glb, provenanceText] = await Promise.all([readFile(glbPath), readFile(provenancePath, 'utf8')]);
  let provenance;
  try {
    provenance = JSON.parse(provenanceText);
  } catch (error) {
    fail(`provenance JSON is invalid: ${error.message}`);
  }
  const digest = sha256(glb);
  const budgets = validateProvenance(provenance, digest);
  const glbStats = inspectGlb(glb, budgets);
  const root = assertQuarantineDir(quarantineDir);
  await mkdir(root, { recursive: true });
  const glbTarget = resolve(root, `${digest}.glb`);
  const provenanceTarget = resolve(root, `${digest}.provenance.json`);
  const receiptTarget = resolve(root, `${digest}.receipt.json`);
  for (const target of [glbTarget, provenanceTarget, receiptTarget]) {
    if (dirname(target) !== root) fail('candidate destination escaped quarantine root');
  }
  let imported = false;
  try {
    const existing = await readFile(glbTarget);
    if (sha256(existing) !== digest) fail('quarantine hash collision');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const incoming = `${glbTarget}.incoming`;
    await copyFile(glbPath, incoming);
    await rename(incoming, glbTarget);
    imported = true;
  }
  const normalized = {
    ...provenance,
    content: { ...provenance.content, sha256: digest },
    review: { status: 'quarantined', promotionApproved: false },
  };
  await writeFile(provenanceTarget, `${JSON.stringify(normalized, null, 2)}\n`);
  const receipt = {
    schemaVersion: 'hunyuan3d-quarantine-receipt-v1',
    candidateId: normalized.candidateId,
    contentSha256: digest,
    role: normalized.assetRole,
    geospatialAuthority: false,
    review: normalized.review,
    glbStats,
    imported,
    quarantineDir: root,
    createdAt: new Date().toISOString(),
  };
  await writeFile(receiptTarget, `${JSON.stringify(receipt, null, 2)}\n`);
  return { glbTarget, provenanceTarget, receiptTarget, receipt };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--glb', '--provenance', '--quarantine-dir'].includes(arg)) fail(`unknown argument ${arg}`);
    options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  if (!options.glb || !options.provenance) fail('usage: --glb /absolute/file.glb --provenance /absolute/file.json [--quarantine-dir path]');
  return options;
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  try {
    const result = await importCandidate(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result.receipt, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
