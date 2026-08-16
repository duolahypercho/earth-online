import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const BASELINE = Object.freeze({
  // The material pass is deliberately zero-cost: compare the complete
  // vehicle presentation to the ebc08de world rather than hiding a change
  // behind a broad triangle or draw-call cap.
  commit: 'ebc08de',
  vehicleTriangles: 13608,
  renderer: { drawCalls: 594, geometries: 402, textures: 259 },
});

const HERO_CURB_PRESENTATION_DELTA = Object.freeze({ geometries: 3, textures: 0 });

const finiteArray = (array) => Array.from(array || []).every(Number.isFinite);

const CLASS_CONTRACT = Object.freeze({
  kinds: { sedan: 28, taxi: 6, truck: 4, bus: 4 },
  presentation: {
    version: 'sf-vehicle-materials-v2',
    paletteVersion: 'sf-civilian-traffic-paint-v2',
    materialVersion: 'sf-vehicle-pbr-v2',
    civilianPaint: [0x7d4d4c, 0x9a7a3e, 0x46647a, 0x4f7168, 0x62586c, 0x805c45, 0xd7d3c8, 0x718164],
    tintedCabColor: 0x20343b,
    taxiCabColor: 0x263a38,
    taxiBodyColor: 0xf3bd2f,
    taxiTopperColor: 0x1c1c1c,
    truckCabPolicy: 'match-body-paint-v1',
  },
  taxi: {
    id: 'sf-yellow-taxi',
    bodyColor: 0xf3bd2f,
    cabColor: 0x263a38,
    topperColor: 0x1c1c1c,
    wheelScale: 1,
  },
  wheelScale: { sedan: 1, taxi: 1, truck: 1.18, bus: 1.34 },
  palette: [0x7d4d4c, 0x9a7a3e, 0x46647a, 0x4f7168, 0x62586c, 0x805c45, 0xd7d3c8, 0x718164],
  defaultCabColor: 0x20343b,
});

const EXPECTED_RNG_KINDS = Object.freeze([
  'sedan', 'taxi', 'sedan', 'taxi', 'sedan', 'sedan', 'sedan', 'taxi', 'sedan', 'sedan',
  'truck', 'sedan', 'sedan', 'sedan', 'sedan', 'sedan', 'sedan', 'sedan', 'sedan', 'sedan',
  'truck', 'sedan', 'sedan', 'sedan', 'sedan', 'bus', 'sedan', 'taxi', 'sedan', 'sedan',
  'taxi', 'bus', 'sedan', 'sedan', 'truck', 'bus', 'sedan', 'bus', 'sedan', 'taxi', 'sedan', 'truck',
]);

const EXPECTED_MUNI_IDENTITIES = Object.freeze([
  { id: 'muni-red-silver-coach', style: 'muni-coach', bodyColor: 0xd8dcda, cabColor: 0xb21f38, roofColor: 0xf2eee3, windowColor: 0x17343e },
  { id: 'muni-heritage-burgundy', style: 'cable-car-inspired', bodyColor: 0x7d1d2f, cabColor: 0xf0cf93, roofColor: 0x171513, windowColor: 0x24363a },
  { id: 'muni-red-silver-coach', style: 'muni-coach', bodyColor: 0xd8dcda, cabColor: 0xb21f38, roofColor: 0xf2eee3, windowColor: 0x17343e },
  { id: 'muni-heritage-burgundy', style: 'cable-car-inspired', bodyColor: 0x7d1d2f, cabColor: 0xf0cf93, roofColor: 0x171513, windowColor: 0x24363a },
]);

const EXPECTED_EVIDENCE_KINDS = Object.freeze(['taxi', 'taxi', 'truck', 'bus', 'sedan', 'sedan']);

const MATERIAL_CONTRACT = Object.freeze({
  body: { color: 0xffffff, roughness: 0.44, metalness: 0.28, emissive: 0x000000, emissiveIntensity: 1, flatShading: true },
  cab: { color: 0xffffff, roughness: 0.16, metalness: 0.1, emissive: 0x000000, emissiveIntensity: 1, flatShading: true },
  taxiTopper: { color: 0xffffff, roughness: 0.58, metalness: 0.08, emissive: 0x000000, emissiveIntensity: 1, flatShading: false },
  transitWindows: { color: 0xffffff, roughness: 0.16, metalness: 0.12, emissive: 0x000000, emissiveIntensity: 1, flatShading: true },
  headlights: { color: 0xfff7d8, roughness: 1, metalness: 0, emissive: 0xffe7a1, emissiveIntensity: 0.72, flatShading: false },
  tires: { color: 0x101112, roughness: 0.96, metalness: 0, emissive: 0x000000, emissiveIntensity: 1, flatShading: false },
  hubs: { color: 0xc7cdd2, roughness: 0.28, metalness: 0.78, emissive: 0x000000, emissiveIntensity: 1, flatShading: true },
});

const normalizeHex = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  if (typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value)) return parseInt(value.replace('#', ''), 16) >>> 0;
  return null;
};

const srgbToLinear = (channel) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const hexToLinear = (hex) => [
  srgbToLinear((hex >>> 16) & 0xff),
  srgbToLinear((hex >>> 8) & 0xff),
  srgbToLinear(hex & 0xff),
];

const colorArrayCloseToHex = (actual, hex, tolerance = 2e-5) => {
  const expected = hexToLinear(hex);
  return actual.length === 3 && actual.every((value, index) => Number.isFinite(value)
    && Math.abs(value - expected[index]) <= tolerance);
};

function hexToHsl(hex) {
  const red = ((hex >>> 16) & 0xff) / 255;
  const green = ((hex >>> 8) & 0xff) / 255;
  const blue = (hex & 0xff) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return { hue, saturation, lightness };
}

function assertPresentationContract(report, label) {
  const presentation = report.presentation;
  assert.ok(presentation && typeof presentation === 'object', `${label}: vehicle presentation diagnostics`);
  assert.equal(presentation.version, CLASS_CONTRACT.presentation.version, `${label}: presentation version`);
  assert.equal(presentation.paletteVersion, CLASS_CONTRACT.presentation.paletteVersion, `${label}: palette version`);
  assert.equal(presentation.materialVersion, CLASS_CONTRACT.presentation.materialVersion, `${label}: material version`);
  assert.deepEqual(
    presentation.civilianPaint.map(normalizeHex),
    CLASS_CONTRACT.presentation.civilianPaint,
    `${label}: exact civilian palette`,
  );
  assert.equal(new Set(presentation.civilianPaint.map(normalizeHex)).size, 8,
    `${label}: civilian palette colors are unique`);
  for (const color of CLASS_CONTRACT.presentation.civilianPaint) {
    const { saturation, lightness } = hexToHsl(color);
    assert.ok(saturation >= 0.1 && saturation <= 0.45,
      `${label}: civilian #${color.toString(16).padStart(6, '0')} saturation is bounded`);
    assert.ok(lightness >= 0.35 && lightness <= 0.84,
      `${label}: civilian #${color.toString(16).padStart(6, '0')} lightness is bounded`);
  }
  assert.equal(normalizeHex(presentation.tintedCabColor), CLASS_CONTRACT.presentation.tintedCabColor,
    `${label}: dark civilian cab tint`);
  assert.equal(normalizeHex(presentation.taxiCabColor), CLASS_CONTRACT.presentation.taxiCabColor,
    `${label}: dark taxi cab tint`);
  assert.equal(presentation.truckCabPolicy, CLASS_CONTRACT.presentation.truckCabPolicy,
    `${label}: painted truck cab policy`);

  const materials = presentation.materials;
  assert.ok(materials && typeof materials === 'object', `${label}: material diagnostics`);
  assert.deepEqual(Object.keys(materials).sort(), Object.keys(MATERIAL_CONTRACT).sort(),
    `${label}: exactly seven vehicle material identities`);
  for (const [part, expected] of Object.entries(MATERIAL_CONTRACT)) {
    const actual = materials[part];
    assert.ok(actual, `${label}: ${part} material diagnostics`);
    assert.equal(actual.name, `sf-vehicle-${part}-${CLASS_CONTRACT.presentation.materialVersion}`,
      `${label}: ${part} material identity`);
    assert.equal(normalizeHex(actual.color), expected.color, `${label}: ${part} material color`);
    assert.equal(actual.roughness, expected.roughness, `${label}: ${part} roughness`);
    assert.equal(actual.metalness, expected.metalness, `${label}: ${part} metalness`);
    // Three's black default is represented as either a null effective
    // emission or #000000 by the diagnostics serializer; the direct material
    // snapshot below still fail-closes the raw PBR field at exact black.
    const expectedDiagnosticEmissive = expected.emissive === 0 ? null : expected.emissive;
    const actualDiagnosticEmissive = normalizeHex(actual.emissive);
    assert.ok(actualDiagnosticEmissive === expectedDiagnosticEmissive
      || (expectedDiagnosticEmissive === null && actualDiagnosticEmissive === 0),
    `${label}: ${part} emissive`);
    assert.equal(actual.emissiveIntensity, expected.emissiveIntensity,
      `${label}: ${part} emissive intensity`);
    assert.equal(actual.flatShading, expected.flatShading, `${label}: ${part} flat shading`);
    assert.deepEqual(actual.metadata, {
      version: CLASS_CONTRACT.presentation.version,
      part,
    }, `${label}: ${part} presentation metadata`);
  }
  for (const [part, actual] of Object.entries(report.materialSurface)) {
    assert.equal(actual.type, 'MeshStandardMaterial', `${label}: ${part} is standard PBR material`);
    assert.equal(actual.map, false, `${label}: ${part} has no map`);
    assert.equal(actual.name, materials[part].name, `${label}: ${part} direct/diagnostic name`);
    assert.equal(actual.color, normalizeHex(materials[part].color), `${label}: ${part} direct/diagnostic color`);
    assert.equal(actual.roughness, materials[part].roughness, `${label}: ${part} direct/diagnostic roughness`);
    assert.equal(actual.metalness, materials[part].metalness, `${label}: ${part} direct/diagnostic metalness`);
    assert.deepEqual(actual.metadata, materials[part].metadata, `${label}: ${part} direct metadata`);
  }
}

const matrixTranslation = (matrix) => [matrix[12], matrix[13], matrix[14]];
const matrixScale = (matrix) => [
  Math.hypot(matrix[0], matrix[1], matrix[2]),
  Math.hypot(matrix[4], matrix[5], matrix[6]),
  Math.hypot(matrix[8], matrix[9], matrix[10]),
];

const closeEnough = (actual, expected, tolerance = 1e-5) => Math.abs(actual - expected) <= tolerance;
const vectorsClose = (actual, expected, tolerance = 1e-5) => actual.length === expected.length
  && actual.every((value, index) => closeEnough(value, expected[index], tolerance));

function expectedWheelCenters(car) {
  const wheelLayouts = {
    sedan: [[-0.7, 0.3, 1.1], [0.7, 0.3, 1.1], [-0.7, 0.3, -1.1], [0.7, 0.3, -1.1]],
    taxi: [[-0.7, 0.3, 1.1], [0.7, 0.3, 1.1], [-0.7, 0.3, -1.1], [0.7, 0.3, -1.1]],
    truck: [[-0.98, 0.3, 1.6], [0.98, 0.3, 1.6], [-0.98, 0.3, -1.7], [0.98, 0.3, -1.7]],
    bus: [[-1.05, 0.3, 2.45], [1.05, 0.3, 2.45], [-1.05, 0.3, -2.45], [1.05, 0.3, -2.45]],
  }[car.kind];
  const yaw = car.rotationY;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return wheelLayouts.map(([x, y, z]) => [
    car.position[0] + x * cos + z * sin,
    car.position[1] + y,
    car.position[2] - x * sin + z * cos,
  ]);
}

function hullGeometryReport(geometry) {
  const position = geometry?.attributes?.position;
  const normal = geometry?.attributes?.normal;
  const index = geometry?.index;
  const positions = position?.array || [];
  const normals = normal?.array || [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      bounds.min[axis] = Math.min(bounds.min[axis], positions[i + axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], positions[i + axis]);
    }
  }
  let minArea = Infinity;
  let normalLengthError = 0;
  const normalFacets = new Set();
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i]; const ay = positions[i + 1]; const az = positions[i + 2];
    const bx = positions[i + 3]; const by = positions[i + 4]; const bz = positions[i + 5];
    const cx = positions[i + 6]; const cy = positions[i + 7]; const cz = positions[i + 8];
    const abx = bx - ax; const aby = by - ay; const abz = bz - az;
    const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    minArea = Math.min(minArea, Math.hypot(nx, ny, nz) * 0.5);
    const dominant = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
    if (dominant > 1e-7) {
      if (Math.abs(nx) === dominant) normalFacets.add(nx > 0 ? 'side+' : 'side-');
      if (Math.abs(ny) === dominant) normalFacets.add(ny > 0 ? 'top' : 'bottom');
      if (Math.abs(nz) === dominant) normalFacets.add(nz > 0 ? 'front' : 'rear');
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    normalLengthError = Math.max(normalLengthError, Math.abs(Math.hypot(
      normals[i], normals[i + 1], normals[i + 2],
    ) - 1));
  }
  const metadata = geometry?.userData?.vehicleHull || null;
  return {
    name: geometry?.name || '',
    metadata,
    indexed: Boolean(index),
    vertexCount: position?.count || 0,
    triangleCount: index ? index.count / 3 : (position?.count || 0) / 3,
    positionFinite: finiteArray(positions),
    normalFinite: finiteArray(normals),
    bounds,
    minTriangleArea: minArea,
    normalLengthError,
    normalFacets: [...normalFacets].sort(),
  };
}

function assertVehicleClassIdentity(report, label) {
  const identities = report.vehicleIdentities;
  assert.equal(identities.length, 42, `${label}: identity rows`);
  assert.deepEqual(identities.map((vehicle) => vehicle.kind), EXPECTED_RNG_KINDS,
    `${label}: seeded kind/assignment order remains stable`);
  assert.deepEqual(identities.map((vehicle) => vehicle.instanceIndex),
    Array.from({ length: EXPECTED_RNG_KINDS.length }, (_, index) => index),
  `${label}: seeded instance assignment order remains stable`);
  const kinds = identities.reduce((counts, vehicle) => ({
    ...counts,
    [vehicle.kind]: (counts[vehicle.kind] || 0) + 1,
  }), {});
  assert.deepEqual(kinds, CLASS_CONTRACT.kinds, `${label}: exact vehicle class counts`);

  const expectedLocalWheels = {
    sedan: [[-0.7, 0.3, 1.1], [0.7, 0.3, 1.1], [-0.7, 0.3, -1.1], [0.7, 0.3, -1.1]],
    taxi: [[-0.7, 0.3, 1.1], [0.7, 0.3, 1.1], [-0.7, 0.3, -1.1], [0.7, 0.3, -1.1]],
    truck: [[-0.98, 0.3, 1.6], [0.98, 0.3, 1.6], [-0.98, 0.3, -1.7], [0.98, 0.3, -1.7]],
    bus: [[-1.05, 0.3, 2.45], [1.05, 0.3, 2.45], [-1.05, 0.3, -2.45], [1.05, 0.3, -2.45]],
  };

  for (const vehicle of identities) {
    const identity = vehicle.classIdentity;
    assert.ok(identity && typeof identity === 'object', `${label}: ${vehicle.index} has class identity`);
    assert.equal(identity.kind, vehicle.kind, `${label}: ${vehicle.index} identity kind`);
    assert.equal(vehicle.instanceIndex, vehicle.index, `${label}: ${vehicle.index} stable instance index`);
    assert.ok(vehicle.edgeId, `${label}: ${vehicle.index} remains assigned to a street edge`);
    assert.ok(Number.isInteger(vehicle.pathIndex) && Number.isFinite(vehicle.distance),
      `${label}: ${vehicle.index} path/entry state finite`);
    assert.equal(vehicle.controlled, false, `${label}: ${vehicle.index} is not hijacked by presentation`);
    assert.equal(identity.wheelScalePolicy, 'uniform-pivot-scale-v1', `${label}: ${vehicle.index} wheel policy`);

    const expectedScale = CLASS_CONTRACT.wheelScale[vehicle.kind];
    assert.ok(Number.isFinite(identity.wheelScale), `${label}: ${vehicle.index} wheel scale finite`);
    assert.equal(identity.wheelScale, expectedScale, `${label}: ${vehicle.index} exact wheel scale`);
    if (vehicle.kind === 'truck') {
      assert.ok(identity.wheelScale >= 1.15 && identity.wheelScale <= 1.2,
        `${label}: truck wheel scale in authored range`);
    }
    if (vehicle.kind === 'bus') {
      assert.ok(identity.wheelScale >= 1.3 && identity.wheelScale <= 1.35,
        `${label}: bus wheel scale in authored range`);
    }

    const bodyHex = normalizeHex(identity.bodyColor);
    const cabHex = normalizeHex(identity.cabColor);
    assert.notEqual(bodyHex, null, `${label}: ${vehicle.index} body identity is a color`);
    assert.notEqual(cabHex, null, `${label}: ${vehicle.index} cab identity is a color`);
    assert.equal(normalizeHex(vehicle.color), bodyHex, `${label}: ${vehicle.index} logical paint matches identity`);
    assert.ok(colorArrayCloseToHex(vehicle.bodyColor, bodyHex), `${label}: ${vehicle.index} batch body color`);
    assert.ok(colorArrayCloseToHex(vehicle.cabColor, cabHex), `${label}: ${vehicle.index} batch cab color`);

    if (vehicle.kind === 'taxi') {
      assert.equal(identity.id, CLASS_CONTRACT.taxi.id, `${label}: taxi identity id`);
      assert.equal(bodyHex, CLASS_CONTRACT.taxi.bodyColor, `${label}: authored SF taxi yellow body`);
      assert.equal(cabHex, CLASS_CONTRACT.taxi.cabColor, `${label}: coherent SF taxi cab tint`);
      assert.equal(normalizeHex(identity.topperColor), CLASS_CONTRACT.taxi.topperColor,
        `${label}: taxi topper identity is black`);
      assert.ok(colorArrayCloseToHex(vehicle.topperColor, CLASS_CONTRACT.taxi.topperColor),
        `${label}: taxi topper batch color is black`);
    } else {
      assert.equal(identity.id, `sf-${vehicle.kind}`, `${label}: ${vehicle.index} stable class id`);
      if (vehicle.kind === 'bus') {
        assert.equal(cabHex, normalizeHex(vehicle.sfTransit?.cabColor), `${label}: transit cab identity`);
        assert.equal(bodyHex, normalizeHex(vehicle.sfTransit?.bodyColor), `${label}: transit body identity`);
        assert.equal(identity.transitId, vehicle.sfTransit?.id, `${label}: transit id mirrored once`);
        assert.equal(identity.transitStyle, vehicle.sfTransit?.style, `${label}: transit style mirrored once`);
        assert.ok(colorArrayCloseToHex(vehicle.topperColor, normalizeHex(vehicle.sfTransit?.roofColor)),
          `${label}: transit roof identity remains unchanged`);
        const expectedTransit = EXPECTED_MUNI_IDENTITIES[vehicle.sfTransit?.ordinal];
        assert.ok(expectedTransit, `${label}: transit ordinal remains in authored Muni set`);
        for (const field of ['id', 'style']) {
          assert.equal(vehicle.sfTransit[field], expectedTransit[field],
            `${label}: bus ${vehicle.index} exact Muni ${field}`);
        }
        for (const field of ['bodyColor', 'cabColor', 'roofColor', 'windowColor']) {
          assert.equal(normalizeHex(vehicle.sfTransit[field]), expectedTransit[field],
            `${label}: bus ${vehicle.index} exact Muni ${field} color`);
        }
      } else {
        assert.ok(CLASS_CONTRACT.palette.includes(bodyHex), `${label}: ${vehicle.index} preserves source paint palette`);
        if (vehicle.kind === 'truck') {
          assert.equal(cabHex, bodyHex, `${label}: ${vehicle.index} truck cab matches body paint`);
        } else {
          assert.equal(cabHex, CLASS_CONTRACT.defaultCabColor, `${label}: default cab tint remains dark`);
        }
        assert.equal(identity.topperColor, null, `${label}: ${vehicle.kind} has no topper identity`);
        assert.equal(vehicle.topperColor, null, `${label}: ${vehicle.kind} has no topper instance`);
      }
    }

    const localLayout = expectedLocalWheels[vehicle.kind];
    assert.equal(vehicle.wheelMatrices.length, 4, `${label}: ${vehicle.index} four logical wheels`);
    const expectedCenters = expectedWheelCenters(vehicle);
    for (const [wheelIndex, wheel] of vehicle.wheelMatrices.entries()) {
      assert.ok(vectorsClose(wheel.localPosition, localLayout[wheelIndex]),
        `${label}: ${vehicle.index} wheel ${wheelIndex} center unchanged`);
      assert.ok(vectorsClose(wheel.localScale, [expectedScale, expectedScale, expectedScale]),
        `${label}: ${vehicle.index} wheel ${wheelIndex} pivot scale uniform`);
      assert.ok(closeEnough(wheel.localRotation[0], vehicle.spin, 1e-5)
        && closeEnough(wheel.localRotation[1], 0, 1e-5)
        && closeEnough(wheel.localRotation[2], 0, 1e-5),
      `${label}: ${vehicle.index} wheel ${wheelIndex} spin contract`);

      const tireCenter = matrixTranslation(wheel.tire);
      const hubCenter = matrixTranslation(wheel.hub);
      assert.ok(vectorsClose(tireCenter, hubCenter, 2e-4),
        `${label}: ${vehicle.index} wheel ${wheelIndex} tire/hub centers coincide`);
      assert.ok(vectorsClose(tireCenter, expectedCenters[wheelIndex], 2e-4),
        `${label}: ${vehicle.index} wheel ${wheelIndex} center follows control transform`);
      assert.ok(vectorsClose(matrixScale(wheel.tire), [expectedScale, expectedScale, expectedScale], 2e-4),
        `${label}: ${vehicle.index} tire matrix scale`);
      assert.ok(vectorsClose(matrixScale(wheel.hub), [expectedScale, expectedScale, expectedScale], 2e-4),
        `${label}: ${vehicle.index} hub matrix scale`);
      assert.ok([...wheel.tire, ...wheel.hub].every(Number.isFinite),
        `${label}: ${vehicle.index} wheel ${wheelIndex} matrices finite`);
    }
  }
}

const snapshot = () => page.evaluate(() => {
  const api = window.__CITYGEN__;
  const traffic = api.getTraffic();
  const renderer = api.getRenderer();
  const batch = traffic.vehicleBatch;
  const matrixArray = (mesh, index) => Array.from(mesh.instanceMatrix.array.slice(index * 16, index * 16 + 16));
  const colorArray = (mesh, index) => mesh.instanceColor
    ? Array.from(mesh.instanceColor.array.slice(index * 3, index * 3 + 3))
    : null;
  const allMatricesFinite = Object.values(batch.parts)
    .every((mesh) => [...mesh.instanceMatrix.array].every(Number.isFinite));
  const bodyColorsFinite = batch.parts.body.instanceColor
    && [...batch.parts.body.instanceColor.array].every(Number.isFinite);
  const perPartColorsFinite = ['body', 'cab', 'taxiTopper', 'transitWindows']
    .every((part) => batch.parts[part].instanceColor
      && [...batch.parts[part].instanceColor.array].every(Number.isFinite));
  const movingCarIndex = traffic.cars.reduce(
    (best, car, index, cars) => (car.speed > cars[best].speed ? index : best), 0,
  );
  batch.parts.body.getMatrixAt(movingCarIndex, batch.partMatrix);
  const car = traffic.cars[movingCarIndex];
  const vehicleTriangles = Object.values(batch.parts).reduce((total, mesh) => total
    + (mesh.geometry.index ? mesh.geometry.index.count / 3 : mesh.geometry.attributes.position.count / 3) * mesh.count, 0);
  const geometrySet = [...new Set(Object.values(batch.parts).map((mesh) => mesh.geometry))];
  const geometries = Object.fromEntries(Object.entries(batch.parts).map(([name, mesh]) => [name, mesh.geometry]));
  const materials = Object.fromEntries(Object.entries(batch.parts).map(([name, mesh]) => [name, mesh.material]));
  const materialSurface = Object.fromEntries(Object.entries(materials).map(([part, material]) => [part, {
    type: material.type,
    name: material.name,
    color: material.color?.getHex?.() ?? null,
    roughness: material.roughness,
    metalness: material.metalness,
    emissive: material.emissive?.getHex?.() ?? null,
    emissiveIntensity: material.emissiveIntensity,
    flatShading: Boolean(material.flatShading),
    map: Boolean(material.map),
    metadata: material.userData?.sfVehiclePresentation
      ? { ...material.userData.sfVehiclePresentation }
      : null,
  }]));
  const instanceMatrixFinite = Object.fromEntries(Object.entries(batch.parts)
    .map(([name, mesh]) => [name, [...mesh.instanceMatrix.array].every(Number.isFinite)]));
  const instanceColorsFinite = Object.fromEntries(Object.entries(batch.parts)
    .map(([name, mesh]) => [name, !mesh.instanceColor || [...mesh.instanceColor.array].every(Number.isFinite)]));
  const vehicleIdentities = traffic.cars.map((car, index) => {
    const rig = car.group.userData.rig;
    const identity = rig.classIdentity || null;
    const wheelMatrices = rig.wheels.map((wheel, wheelIndex) => ({
      localPosition: wheel.position.toArray(),
      localScale: wheel.scale.toArray(),
      localRotation: wheel.rotation.toArray(),
      tire: matrixArray(batch.parts.tires, index * 4 + wheelIndex),
      hub: matrixArray(batch.parts.hubs, index * 4 + wheelIndex),
    }));
    return {
      index,
      kind: car.kind,
      color: car.color,
      instanceIndex: car.instanceIndex,
      position: car.group.position.toArray(),
      rotationY: car.group.rotation.y,
      edgeId: car.edge?.id || null,
      pathIndex: car.pathIndex,
      distance: car.distance,
      turnSide: car.turnSide,
      controlled: Boolean(car.controlled),
      parentName: car.group.parent?.name || null,
      spin: rig.spin,
      classIdentity: identity ? { ...identity } : null,
      sfTransit: rig.sfTransit ? { ...rig.sfTransit } : null,
      bodyColor: colorArray(batch.parts.body, index),
      cabColor: colorArray(batch.parts.cab, index),
      topperColor: rig.topperInstanceIndex >= 0
        ? colorArray(batch.parts.taxiTopper, rig.topperInstanceIndex)
        : null,
      wheelMatrices,
    };
  });
  return {
    backend: renderer.rendererBackend,
    diagnostics: traffic.getVehicleBatchDiagnostics(),
    allMatricesFinite,
    bodyColorsFinite,
    perPartColorsFinite,
    bodyColorCount: batch.parts.body.instanceColor?.count || 0,
    stableIndices: traffic.cars.map((entry) => entry.instanceIndex),
    busIndices: traffic.cars.flatMap((entry, index) => entry.kind === 'bus' ? [index] : []),
    topperIndices: traffic.cars
      .flatMap((entry) => entry.group.userData.rig.topperInstanceIndex >= 0
        ? [entry.group.userData.rig.topperInstanceIndex]
        : []),
    movingCarIndex,
    movingCarPosition: car.group.position.toArray(),
    movingBodyMatrix: batch.partMatrix.toArray(),
    drawCalls: renderer.renderer.info.render.drawCalls,
    rendererGeometries: renderer.renderer.info.memory.geometries,
    vehicleTriangles,
    baselineVehicleTriangles: 13608,
    uniqueGeometryCount: geometrySet.length,
    geometryIdentity: {
      bodyCabShared: geometries.body === geometries.cab,
      boxPartsShared: geometries.taxiTopper === geometries.transitWindows
        && geometries.transitWindows === geometries.headlights,
      wheelHubDistinct: geometries.tires !== geometries.hubs,
    },
    geometryReports: Object.fromEntries(Object.entries(batch.parts).map(([name, mesh]) => [name, {
      name: mesh.geometry.name,
      vertexCount: mesh.geometry.attributes.position?.count || 0,
      indexed: Boolean(mesh.geometry.index),
      userData: mesh.geometry.userData?.vehicleHull || null,
    }])),
    hullAttributes: {
      positions: Array.from(batch.parts.body.geometry.attributes.position?.array || []),
      normals: Array.from(batch.parts.body.geometry.attributes.normal?.array || []),
    },
    uniqueBatchMaterialCount: new Set(Object.values(materials)).size,
    batchMaterialsHaveNoMaps: Object.values(materials).every((material) => !material.map),
    materialSurface,
    presentation: traffic.getVehicleBatchDiagnostics().presentation,
    rendererTriangles: renderer.renderer.info.render.triangles,
    rendererTextures: renderer.renderer.info.memory.textures,
    instanceMatrixFinite,
    instanceColorsFinite,
    vehicleIdentities,
  };
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu
      && window.__CITYGEN__?.getState().generator === 'sf-builtin'
      && window.__CITYGEN__?.getTraffic()?.cars?.length === 42,
    { timeout: 30000 },
  );
  await page.evaluate(() => window.__CITYGEN__.setCameraPose('sf'));
  await page.waitForTimeout(1400);

  const before = await snapshot();
  const expectedIndices = Array.from({ length: 42 }, (_, index) => index);
  assert.equal(before.backend, 'webgpu');
  assertPresentationContract(before, 'before-motion');
  assert.equal(before.diagnostics.logicalCars, 42);
  assert.deepEqual(before.diagnostics.kinds, CLASS_CONTRACT.kinds);
  assert.equal(before.diagnostics.meshes, 259);
  assert.equal(before.diagnostics.instancedMeshes, 7);
  assert.equal(before.diagnostics.geometries, 4);
  assert.equal(before.diagnostics.materials, 133);
  assert.deepEqual(before.diagnostics.instances, {
    body: 42,
    cab: 42,
    taxiTopper: 10,
    transitWindows: 4,
    headlights: 84,
    tires: 168,
    hubs: 168,
  });
  assert.equal(before.diagnostics.sfTransit.logicalInstances, 4);
  assert.deepEqual(before.diagnostics.sfTransit.styles, {
    'muni-coach': 2,
    'cable-car-inspired': 2,
  });
  assert.deepEqual(before.diagnostics.sfTransit.identities.map((entry) => entry.carIndex), before.busIndices);
  assert.deepEqual(before.diagnostics.sfTransit.identities.map((entry) => entry.ordinal), [0, 1, 2, 3]);
  assert.deepEqual(before.diagnostics.sfTransit.identities.map((entry) => entry.windowInstanceIndex), [0, 1, 2, 3]);
  assert.deepEqual(before.diagnostics.sfTransit.identities.map((entry) => entry.id), [
    'muni-red-silver-coach',
    'muni-heritage-burgundy',
    'muni-red-silver-coach',
    'muni-heritage-burgundy',
  ]);
  assert.deepEqual(before.topperIndices.toSorted((a, b) => a - b), Array.from({ length: 10 }, (_, index) => index));
  assert.equal(new Set(before.diagnostics.sfTransit.identities.map((entry) => entry.topperInstanceIndex)).size, 4);
  assert.equal(before.diagnostics.frustumSafe, true);
  assert.equal(before.allMatricesFinite, true);
  assert.equal(before.bodyColorsFinite, true);
  assert.equal(before.perPartColorsFinite, true);
  assert.equal(before.bodyColorCount, 42);
  assert.deepEqual(before.stableIndices, expectedIndices);
  assert.equal(before.uniqueGeometryCount, 4);
  assert.deepEqual(before.geometryIdentity, {
    bodyCabShared: true,
    boxPartsShared: true,
    wheelHubDistinct: true,
  });
  assert.equal(before.uniqueBatchMaterialCount, 7);
  assert.equal(before.batchMaterialsHaveNoMaps, true);
  assert.equal(before.vehicleTriangles, BASELINE.vehicleTriangles);
  assert.equal(before.vehicleTriangles - BASELINE.vehicleTriangles, 0);
  assert.deepEqual(before.instanceMatrixFinite, {
    body: true, cab: true, taxiTopper: true, transitWindows: true,
    headlights: true, tires: true, hubs: true,
  });
  assert.deepEqual(before.instanceColorsFinite, {
    body: true, cab: true, taxiTopper: true, transitWindows: true,
    headlights: true, tires: true, hubs: true,
  });
  assert.equal(before.rendererGeometries,
    BASELINE.renderer.geometries + HERO_CURB_PRESENTATION_DELTA.geometries,
    'vehicle baseline plus the exact hero curb geometry delta remains exact');
  assert.equal(before.rendererTextures,
    BASELINE.renderer.textures + HERO_CURB_PRESENTATION_DELTA.textures,
    'vehicle baseline plus the exact hero curb texture delta remains exact');
  assertVehicleClassIdentity(before, 'before-motion');

  const hull = hullGeometryReport({
    name: before.geometryReports.body.name,
    userData: { vehicleHull: before.geometryReports.body.userData },
    attributes: {
      position: { array: before.hullAttributes.positions, count: before.hullAttributes.positions.length / 3 },
      normal: { array: before.hullAttributes.normals, count: before.hullAttributes.normals.length / 3 },
    },
    index: before.geometryReports.body.indexed ? {} : null,
  });
  assert.equal(hull.name, 'sf-low-poly-vehicle-hull-v1');
  assert.equal(hull.metadata.id, 'sf-low-poly-vehicle-hull-v1');
  assert.equal(hull.metadata.version, 1);
  assert.equal(hull.metadata.triangleCount, 20);
  assert.equal(hull.metadata.vertexCount, 60);
  assert.equal(hull.metadata.profilePointCount, 6);
  assert.equal(hull.metadata.indexed, false);
  assert.equal(hull.metadata.hardEdged, true);
  assert.equal(hull.metadata.frontAxis, '+z');
  assert.deepEqual(hull.metadata.normalizedBounds.min, [-0.5, -0.5, -0.5]);
  assert.ok(Math.abs(hull.metadata.normalizedBounds.max[0] - 0.5) <= 1e-6);
  assert.ok(Math.abs(hull.metadata.normalizedBounds.max[1] - 0.48) <= 1e-5);
  assert.ok(Math.abs(hull.metadata.normalizedBounds.max[2] - 0.5) <= 1e-6);
  assert.deepEqual(hull.metadata.features, ['sloped-nose', 'roof-shoulder', 'rear-rake']);
  assert.equal(hull.indexed, false);
  assert.equal(hull.vertexCount, 60);
  assert.equal(hull.triangleCount, 20);
  assert.equal(hull.positionFinite, true);
  assert.equal(hull.normalFinite, true);
  assert.ok(hull.minTriangleArea > 1e-4, `hull min triangle area ${hull.minTriangleArea}`);
  assert.ok(hull.normalLengthError <= 1e-4, `hull normal length error ${hull.normalLengthError}`);
  assert.deepEqual(hull.normalFacets, ['bottom', 'front', 'rear', 'side+', 'side-', 'top']);
  assert.ok(Math.abs(hull.bounds.min[0] + 0.5) <= 1e-6);
  assert.ok(Math.abs(hull.bounds.max[0] - 0.5) <= 1e-6);
  assert.ok(Math.abs(hull.bounds.min[1] + 0.5) <= 1e-6);
  assert.ok(Math.abs(hull.bounds.max[1] - 0.48) <= 1e-5);
  assert.ok(Math.abs(hull.bounds.min[2] + 0.5) <= 1e-6);
  assert.ok(Math.abs(hull.bounds.max[2] - 0.5) <= 1e-6);

  await page.waitForTimeout(750);
  const after = await snapshot();
  const movedDistance = Math.hypot(...after.movingCarPosition.map((value, index) => value - before.movingCarPosition[index]));
  const matrixDelta = Math.max(...after.movingBodyMatrix.map((value, index) => Math.abs(value - before.movingBodyMatrix[index])));
  assert.ok(movedDistance >= 0.2, `sampled logical car moved ${movedDistance.toFixed(3)}m`);
  assert.ok(matrixDelta >= 0.01, `batched body matrix changed by ${matrixDelta.toFixed(4)}`);
  assert.deepEqual(after.stableIndices, expectedIndices);
  assertVehicleClassIdentity(after, 'after-motion');
  assert.deepEqual(after.vehicleIdentities.map((vehicle) => ({
    kind: vehicle.kind,
    instanceIndex: vehicle.instanceIndex,
    classIdentity: vehicle.classIdentity,
    wheels: vehicle.wheelMatrices.map((wheel) => ({
      localPosition: wheel.localPosition,
      localScale: wheel.localScale,
    })),
  })), before.vehicleIdentities.map((vehicle) => ({
    kind: vehicle.kind,
    instanceIndex: vehicle.instanceIndex,
    classIdentity: vehicle.classIdentity,
    wheels: vehicle.wheelMatrices.map((wheel) => ({
      localPosition: wheel.localPosition,
      localScale: wheel.localScale,
    })),
  })), 'identity, wheel centers, and control slots remain stable while moving');

  const animation = await page.evaluate(() => {
    const traffic = window.__CITYGEN__.getTraffic();
    const car = traffic.cars[0];
    const rig = car.group.userData.rig;
    const saved = {
      speed: car.speed,
      braking: car.braking,
      corner: car.corner,
      turnSide: car.turnSide,
      nextEdge: car.nextEdge,
      phase: traffic.phase,
      spin: rig.spin,
      bobTime: rig.bobTime,
      bodyY: rig.body.position.y,
      bodyLean: rig.body.rotation.z,
    };
    rig.spin = 0;
    rig.bobTime = 0;
    rig.body.rotation.z = 0;
    car.speed = 6;
    car.braking = true;
    car.corner = {};
    car.turnSide = 1;
    car.nextEdge = car.edge;
    traffic.phase = 0;
    traffic.animateCar(car, 0.25);
    const left = {
      spin: rig.spin,
      bob: rig.body.position.y,
      lean: rig.body.rotation.z,
      tail: rig.taillightMat.emissiveIntensity,
      active: rig.turnSignals.left[0].emissiveIntensity,
      inactive: rig.turnSignals.right[0].emissiveIntensity,
    };
    car.braking = false;
    car.speed = 0;
    car.turnSide = -1;
    rig.body.rotation.z = 0;
    traffic.phase = 0;
    traffic.animateCar(car, 0.25);
    const right = {
      lean: rig.body.rotation.z,
      tail: rig.taillightMat.emissiveIntensity,
      active: rig.turnSignals.right[0].emissiveIntensity,
      inactive: rig.turnSignals.left[0].emissiveIntensity,
    };
    Object.assign(car, {
      speed: saved.speed,
      braking: saved.braking,
      corner: saved.corner,
      turnSide: saved.turnSide,
      nextEdge: saved.nextEdge,
    });
    traffic.phase = saved.phase;
    rig.spin = saved.spin;
    rig.bobTime = saved.bobTime;
    rig.body.position.y = saved.bodyY;
    rig.body.rotation.z = saved.bodyLean;
    return { left, right };
  });
  assert.ok(Math.abs(animation.left.spin - 5) <= 1e-6);
  assert.notEqual(animation.left.bob, 0);
  assert.ok(Math.abs(animation.left.lean + 0.035) <= 1e-6);
  assert.equal(animation.left.tail, 1.6);
  assert.equal(animation.left.active, 1.5);
  assert.equal(animation.left.inactive, 0);
  assert.ok(Math.abs(animation.right.lean - 0.035) <= 1e-6);
  assert.equal(animation.right.tail, 0.85);
  assert.equal(animation.right.active, 1.5);
  assert.equal(animation.right.inactive, 0);

  assert.ok(after.drawCalls <= 1200, `full SF draw calls ${after.drawCalls}`);
  assert.ok(after.rendererGeometries <= 450, `renderer geometries ${after.rendererGeometries}`);
  // Draw visibility can change while the live camera/traffic sample advances;
  // the exact 82bdccf draw contract is asserted at stable daylight/night
  // poses by verify-citygen-local-life.mjs. This snapshot still fail-closes
  // geometry and texture allocations, which cannot vary with visibility.
  assert.equal(after.rendererGeometries, before.rendererGeometries, 'vehicle identity adds zero geometries');
  assert.equal(after.rendererTextures, before.rendererTextures, 'vehicle identity adds zero textures');
  assert.equal(after.vehicleTriangles - BASELINE.vehicleTriangles, 0);
  assert.ok(after.vehicleTriangles - BASELINE.vehicleTriangles <= 0,
    `vehicle triangle delta ${after.vehicleTriangles - BASELINE.vehicleTriangles}`);
  assertPresentationContract(after, 'after-motion');
  assert.deepEqual(errors, []);
  const screenshotState = await page.evaluate(async (wantedKinds) => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const traffic = api.getTraffic();
    const target = renderer.controls.target;
    const camera = renderer.camera;
    // Freeze only the final evidence composition. The motion, signal, and
    // matrix assertions above run against the live simulation first.
    traffic.update = () => {};
    const dx = target.x - camera.position.x;
    const dz = target.z - camera.position.z;
    const length = Math.hypot(dx, dz) || 1;
    const forward = { x: dx / length, z: dz / length };
    const right = { x: -forward.z, z: forward.x };
    const used = new Set();
    const staged = wantedKinds.map((kind) => {
      const index = traffic.cars.findIndex((car, carIndex) => car.kind === kind && !used.has(carIndex));
      if (index < 0) return null;
      used.add(index);
      return traffic.cars[index];
    }).filter(Boolean);
    if (staged.length !== wantedKinds.length) {
      throw new Error(`identity evidence staging expected ${wantedKinds.length} vehicles, got ${staged.length}`);
    }
    const offsets = [[-7, 8], [7, 8], [-7, 19], [7, 19], [-7, 31], [7, 31]];
    staged.forEach((car, index) => {
      const [lateral, distance] = offsets[index];
      const x = target.x + forward.x * distance + right.x * lateral;
      const z = target.z + forward.z * distance + right.z * lateral;
      const y = renderer.terrain?.heightAt ? renderer.terrain.heightAt(x, z) : 0;
      car.group.position.set(x, y, z);
      car.group.rotation.y = Math.atan2(forward.x, forward.z);
    });
    const { writeVehicleInstance, commitVehicleBatch } = await import('/src/citygen/actors.js');
    staged.forEach((car) => writeVehicleInstance(traffic.vehicleBatch, car));
    commitVehicleBatch(traffic.vehicleBatch, traffic.cars.length);
    renderer.camera.lookAt(target.x, target.y, target.z);
    renderer.controls.update();
    document.querySelectorAll('.brand, .toolbar, .readout, .hint, .inspector, .minimap, .place-chip, .status-pill, .field-guide, .loading-hud, #osm-overlay')
      .forEach((element) => { element.style.display = 'none'; });
    return {
      stagedTraffic: staged.length,
      stagedKinds: staged.map((car) => car.kind),
      camera: camera.position.toArray(),
      target: target.toArray(),
    };
  }, EXPECTED_EVIDENCE_KINDS);
  await page.waitForTimeout(300);
  assert.deepEqual(screenshotState.stagedKinds, EXPECTED_EVIDENCE_KINDS,
    'material evidence stages the exact matched vehicle kind set');
  await page.screenshot({ path: '.qa-citygen-vehicle-materials.png' });
  console.log(JSON.stringify({
    result: 'PASS',
    url,
    structure: before.diagnostics,
    synchronization: {
      movedDistance: Number(movedDistance.toFixed(3)),
      matrixDelta: Number(matrixDelta.toFixed(4)),
      stableIndices: true,
    },
    animation,
    render: {
      drawCalls: after.drawCalls,
      triangles: after.rendererTriangles,
      geometries: after.rendererGeometries,
      textures: after.rendererTextures,
      vehicleTriangles: after.vehicleTriangles,
      baselineCommit: BASELINE.commit,
      vehicleTriangleDelta: after.vehicleTriangles - BASELINE.vehicleTriangles,
    },
    screenshot: { path: '.qa-citygen-vehicle-materials.png', ...screenshotState },
    errors,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
