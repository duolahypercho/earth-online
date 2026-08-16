import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mulberry32, ringArea, pointInPolygon, polygonBounds, terrainHeight, clamp, hashString } from './core.js';

const PALETTES = Object.freeze({
  painted: ['#c96b66', '#5f93a2', '#d4ad61', '#7486a8', '#c88455', '#89a876', '#b87892'],
  plaster: ['#f7d3ae', '#eda987', '#ffe0bd', '#e9b28f', '#f6d2a1'],
  brick: ['#e0925f', '#d96f4c', '#efa373', '#c05a3f', '#e2845a'],
  concrete: ['#e2ded2', '#cfc9ba', '#f1ece0', '#d8d3c4', '#e7e2d5'],
  clapboard: ['#9fc8e8', '#e8b98a', '#b5dca5', '#efb6c8', '#a9c4e8'],
  glass: ['#7fa7bd', '#6d98ad', '#a7c4cf', '#8eb2bf', '#789eae', '#9dbbc5', '#88aab8', '#b89a70', '#a88762', '#7ca99c'],
  // Bronze and sea-glass tower variants break the single-hue blue wall on
  // real-map slices while staying inside the soft low-poly grade.
  stone: ['#ddd4be', '#ccc0a8', '#e8dfca', '#d4c8b0', '#e0d6c2'],
});

const FACADE_STYLES = ['edwardian', 'modern-grid', 'bay-window', 'shopfront', 'loft', 'art-deco'];

function landmarkKind(building) {
  const name = String(building.name || '').toLowerCase();
  const tags = `${name} ${String(building.tourism || '')} ${String(building.amenity || '')}`.toLowerCase();
  if (tags.includes('transamerica')) return 'transamerica';
  if (tags.includes('coit') || tags.includes('telegraph hill')) return 'coit';
  if (tags.includes('ferry building') || tags.includes('ferry terminal')) return 'ferry';
  if (tags.includes('salesforce')) return 'salesforce';
  if (tags.includes('city hall') || tags.includes('civic center')) return 'city-hall';
  if (tags.includes('palace of fine arts')) return 'palace';
  if (tags.includes('mission dolores') || tags.includes('dolores basilica')) return 'mission-dolores';
  if (tags.includes('grace cathedral')) return 'cathedral';
  if (tags.includes('sfmoma')) return 'sfmoma';
  if (tags.includes('warfield')) return 'warfield';
  if (tags.includes('yerba buena')) return 'yerba';
  return null;
}

const BUILDING_UV_METRES_X = 12;
const BUILDING_UV_METRES_Y = 4.6;
const BUILDING_FOOTPRINT_EPSILON = 1e-4;
const HERO_FACADE_ATLAS_URL = '/assets/sf-market-kearny-hero-atlas-v1.png';
const HERO_FACADE_ATLAS_RESOLUTION = 1254;
const HERO_FACADE_IDS = Object.freeze(new Map([
  ['sf-building-132127809', { cell: 0, pattern: 'hearst-stone' }],
  ['sf-building-151183777', { cell: 1, pattern: 'market-bronze-glass' }],
  ['sf-building-132127810', { cell: 2, pattern: 'central-art-deco' }],
  ['sf-building-149335987', { cell: 3, pattern: 'market-limestone-grid' }],
  ['sf-building-149335979', { cell: 4, pattern: 'kearny-brick-stone' }],
  ['sf-building-149335988', { cell: 5, pattern: 'market-industrial-loft' }],
]));

function heroFacadeMaterialGroup(building) {
  const facade = building.facade || 'modern-grid';
  if (facade === 'loft' && building.material === 'brick') return 'brick';
  if (facade === 'loft' && building.material === 'glass') return 'glass';
  if (facade === 'modern-grid' && building.material === 'concrete') return 'concrete';
  return null;
}

function heroFacadeCell(building, group) {
  const authored = HERO_FACADE_IDS.get(building.id);
  if (authored) return authored;
  if (group === 'glass') return { cell: 1, pattern: 'market-bronze-glass' };
  if (group === 'concrete') {
    return hashString(`${building.id}-hero-atlas`) % 2 === 0
      ? { cell: 2, pattern: 'central-art-deco' }
      : { cell: 3, pattern: 'market-limestone-grid' };
  }
  const brickCells = [
    { cell: 0, pattern: 'hearst-stone' },
    { cell: 4, pattern: 'kearny-brick-stone' },
    { cell: 5, pattern: 'market-industrial-loft' },
  ];
  return brickCells[hashString(`${building.id}-hero-atlas`) % brickCells.length];
}

function remapPolygonFacadeToAtlas(geometry, footprintPointCount, cellIndex) {
  const uv = geometry.attributes.uv;
  if (!uv || footprintPointCount < 3 || cellIndex < 0 || cellIndex > 5) return false;
  const insetU = 1 / HERO_FACADE_ATLAS_RESOLUTION;
  const insetV = 1 / HERO_FACADE_ATLAS_RESOLUTION;
  const column = cellIndex % 3;
  const visualRow = Math.floor(cellIndex / 3);
  const uMin = column / 3 + insetU;
  const uMax = (column + 1) / 3 - insetU;
  // Texture UVs use a bottom-left origin after the image loader's Y flip.
  const vMin = visualRow === 0 ? 0.5 + insetV : insetV;
  const vMax = visualRow === 0 ? 1 - insetV : 0.5 - insetV;
  const roofU = (uMin + uMax) / 2;
  const roofV = vMax - 0.012;
  for (let i = 0; i < footprintPointCount; i += 1) uv.setXY(i, roofU, roofV);
  for (let edge = 0; edge < footprintPointCount; edge += 1) {
    const start = footprintPointCount + edge * 4;
    uv.setXY(start, uMin, vMin);
    uv.setXY(start + 1, uMax, vMin);
    uv.setXY(start + 2, uMax, vMax);
    uv.setXY(start + 3, uMin, vMax);
  }
  uv.needsUpdate = true;
  return Array.from(uv.array).every(Number.isFinite);
}

async function loadHeroFacadeTextures() {
  const texture = await new THREE.TextureLoader().loadAsync(HERO_FACADE_ATLAS_URL);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;

  const image = texture.image;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const r = pixels.data[i];
    const g = pixels.data[i + 1];
    const b = pixels.data[i + 2];
    const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const windowLike = luminance < 126 && b >= r * 0.72 && b >= g * 0.72;
    const glow = windowLike ? Math.round(150 + (126 - luminance) * 0.7) : 0;
    pixels.data[i] = glow;
    pixels.data[i + 1] = Math.round(glow * 0.84);
    pixels.data[i + 2] = Math.round(glow * 0.52);
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const nightTexture = new THREE.CanvasTexture(canvas);
  nightTexture.wrapS = THREE.ClampToEdgeWrapping;
  nightTexture.wrapT = THREE.ClampToEdgeWrapping;
  nightTexture.minFilter = THREE.LinearMipmapLinearFilter;
  nightTexture.magFilter = THREE.LinearFilter;
  nightTexture.anisotropy = 4;
  return { texture, nightTexture };
}

function signedFootprintArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

function normalizeBuildingFootprint(sourcePoints) {
  if (!Array.isArray(sourcePoints)) return null;
  const points = [];
  for (const point of sourcePoints) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.z)) return null;
    const previous = points.at(-1);
    if (!previous || Math.hypot(point.x - previous.x, point.z - previous.z) > BUILDING_FOOTPRINT_EPSILON) {
      points.push({ x: point.x, z: point.z });
    }
  }
  if (points.length > 2) {
    const first = points[0];
    const last = points.at(-1);
    if (Math.hypot(first.x - last.x, first.z - last.z) <= BUILDING_FOOTPRINT_EPSILON) points.pop();
  }
  if (points.length < 3 || Math.abs(signedFootprintArea(points)) < BUILDING_FOOTPRINT_EPSILON) return null;
  return points;
}

function polygonExtrusionGeometry(points, height, baseY) {
  const signedArea = signedFootprintArea(points);
  const roofTriangles = THREE.ShapeUtils.triangulateShape(
    points.map((point) => new THREE.Vector2(point.x, point.z)),
    [],
  );
  if (roofTriangles.length !== points.length - 2) return null;

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const topY = baseY + height;
  // Roof vertices are separate from walls so the cap normal stays hard after
  // material-bucket merging. A stable facade-background texel keeps windows
  // and murals off horizontal roofs. The terrain-hidden bottom cap is omitted.
  for (const point of points) {
    positions.push(point.x, topY, point.z);
    normals.push(0, 1, 0);
    uvs.push(0.02, 0.2);
  }

  let renderedArea = 0;
  for (const triangle of roofTriangles) {
    const [a, b, c] = triangle;
    const pa = points[a];
    const pb = points[b];
    const pc = points[c];
    const triangleSignedArea = ((pb.x - pa.x) * (pc.z - pa.z) - (pc.x - pa.x) * (pb.z - pa.z)) / 2;
    renderedArea += Math.abs(triangleSignedArea);
    // In X/Y/Z space, positive X/Z winding points downward, hence the swap.
    if (triangleSignedArea > 0) {
      indices.push(a, c, b);
    } else {
      indices.push(a, b, c);
    }
  }

  let perimeter = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const edgeLength = Math.hypot(dx, dz);
    const wallStart = positions.length / 3;
    const outwardX = signedArea > 0 ? dz / edgeLength : -dz / edgeLength;
    const outwardZ = signedArea > 0 ? -dx / edgeLength : dx / edgeLength;
    const u0 = perimeter / BUILDING_UV_METRES_X;
    const u1 = (perimeter + edgeLength) / BUILDING_UV_METRES_X;
    positions.push(
      a.x, baseY, a.z,
      b.x, baseY, b.z,
      b.x, topY, b.z,
      a.x, topY, a.z,
    );
    for (let vertex = 0; vertex < 4; vertex += 1) normals.push(outwardX, 0, outwardZ);
    uvs.push(
      u0, 0,
      u1, 0,
      u1, height / BUILDING_UV_METRES_Y,
      u0, height / BUILDING_UV_METRES_Y,
    );
    if (signedArea > 0) {
      indices.push(wallStart, wallStart + 2, wallStart + 1, wallStart, wallStart + 3, wallStart + 2);
    } else {
      indices.push(wallStart, wallStart + 1, wallStart + 2, wallStart, wallStart + 2, wallStart + 3);
    }
    perimeter += edgeLength;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return {
    geometry,
    renderedArea,
    triangleCount: indices.length / 3,
  };
}

function seededTexture(seed, draw, width = 128, height = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  draw(context, width, height, mulberry32(seed));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function drawFacade(context, width, height, random, style, material, { day = true, vivid = false } = {}) {
  const base = PALETTES[material] || PALETTES.plaster;
  let baseFill = base[Math.floor(random() * base.length)];
  if (vivid) {
    // Real-map slices get a gentle saturation lift on painted materials so
    // facades carry more hue variety; glass stays soft so towers keep the
    // stylized low-poly look.
    if (material !== 'glass') {
      const c = new THREE.Color(baseFill);
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      c.setHSL(hsl.h, clamp(hsl.s * 1.12 + 0.04, 0, 0.68), clamp(hsl.l, 0.45, 0.85));
      baseFill = `#${c.getHexString()}`;
    }
  } else if (material !== 'glass' && material !== 'concrete' && material !== 'stone') {
    // Gentle chroma lift on painted facades keeps the soft look while giving
    // painted cities a touch more saturation headroom.
    const c = new THREE.Color(baseFill);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    c.setHSL(hsl.h, clamp(hsl.s * 1.1 + 0.03, 0, 0.8), clamp(hsl.l, 0.45, 0.85));
    baseFill = `#${c.getHexString()}`;
  }
  context.fillStyle = baseFill;
  context.fillRect(0, 0, width, height);
  const vertical = style === 'modern-grid' || style === 'loft';
  const columns = vertical ? 3 + Math.floor(random() * 3) : 2 + Math.floor(random() * 2);
  const rows = Math.max(3, Math.floor((height / 128) * (3 + Math.floor(random() * 4))));
  const margin = 10;
  const gapX = (width - margin * 2) / columns;
  const gapY = (height - margin * 2) / rows;
  const lit = material === 'glass'
    ? ['#d8ecf7', '#e5f3fb', '#c2e0f0']
    : ['#ffd98f', '#ffc96a', '#ffe9ae', '#f0b967'];
  const cool = material === 'glass';
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const x = margin + col * gapX + random() * 5;
      const y = margin + row * gapY + random() * 4;
      const w = gapX * 0.62;
      const h = gapY * 0.62;
      const litWindow = random() < (day ? 0.24 : 0.48);
      context.fillStyle = cool ? (litWindow ? '#bfe0f2' : '#6f9fc4') : (litWindow ? lit[Math.floor(random() * lit.length)] : '#39434c');
      context.fillRect(x, y, w, h);
      if (cool && !litWindow) {
        context.fillStyle = 'rgba(255,255,255,0.24)';
        context.fillRect(x + w * 0.08, y + h * 0.08, w * 0.3, h * 0.2);
      }
      if (random() < 0.4) {
        context.fillStyle = 'rgba(0,0,0,0.18)';
        context.fillRect(x + w / 2, y, 2, h);
      }
    }
  }
  if (cool) {
    // Spandrel bands and mullions give glass towers an architectural grid so
    // large facades carry edge detail without raising saturation.
    context.fillStyle = 'rgba(30,45,60,0.26)';
    for (let row = 0; row <= rows; row += 1) {
      context.fillRect(0, Math.max(0, margin + row * gapY - 3), width, 3);
    }
    for (let col = 0; col <= columns; col += 1) {
      context.fillRect(Math.max(0, margin + col * gapX - 1), 0, 1.5, height);
    }
  }
  // Cornice + parapet bands.
  context.fillStyle = 'rgba(255,255,255,0.22)';
  context.fillRect(0, 0, width, 7);
  context.fillRect(0, height - 7, width, 7);
  context.fillStyle = 'rgba(60,45,35,0.28)';
  context.fillRect(0, 7, width, 3);
  const muralChance = vivid ? 0.24 : 0.06;
  // Glass towers skip murals: repeated bands read as giant stripes at height.
  const muralFacade = style === 'shopfront'
    || ((style === 'loft' || style === 'art-deco') && random() < 0.3)
    || random() < muralChance;
  if (material !== 'glass' && muralFacade) {
    const murals = vivid
      ? ['rgba(224,52,79,0.72)', 'rgba(217,47,143,0.72)', 'rgba(143,63,214,0.72)', 'rgba(47,159,214,0.66)', 'rgba(242,160,31,0.72)', 'rgba(63,191,111,0.66)', 'rgba(255,107,53,0.72)', 'rgba(255,92,168,0.72)']
      : ['rgba(224,80,66,0.58)', 'rgba(41,150,171,0.62)', 'rgba(232,164,44,0.58)', 'rgba(89,158,74,0.62)', 'rgba(151,86,178,0.62)', 'rgba(41,178,158,0.58)', 'rgba(235,97,158,0.58)'];
    context.fillStyle = murals[Math.floor(random() * murals.length)];
    context.fillRect(0, Math.floor(height * 0.36), width, Math.floor(height * 0.2));
    if (vivid && random() < 0.5) {
      // A second offset band reads as layered street art from the sidewalk.
      context.fillStyle = murals[Math.floor(random() * murals.length)];
      context.fillRect(Math.floor(width * 0.16), Math.floor(height * 0.3), Math.floor(width * 0.68), Math.floor(height * 0.1));
    }
  }
  if (style === 'art-deco') {
    context.fillStyle = 'rgba(120,90,60,0.5)';
    for (let i = 0; i < width; i += 18) {
      context.fillRect(i, 12, 8, 22);
    }
  }
  if (style === 'shopfront') {
    context.fillStyle = '#241f1d';
    context.fillRect(0, height - 30, width, 30);
    context.fillStyle = '#8a5a3a';
    context.fillRect(0, height - 30, width, 5);
    const storefrontColors = vivid
      ? ['#ff4d5e', '#ff8a3d', '#ffd23f', '#3fc96f', '#2fb3c9', '#4f7fe0', '#a95fd6', '#ff5ca8', '#f2e05a', '#ff7043']
      : ['#f7dca2', '#7fc0e5', '#f2b76c', '#8fd0a0', '#e994a6', '#c9adea'];
    const leftColor = storefrontColors[Math.floor(random() * storefrontColors.length)];
    let rightColor = storefrontColors[Math.floor(random() * storefrontColors.length)];
    while (rightColor === leftColor) rightColor = storefrontColors[Math.floor(random() * storefrontColors.length)];
    context.fillStyle = leftColor;
    context.fillRect(8, height - 24, (width - 16) / 2 - 4, 18);
    context.fillStyle = rightColor;
    context.fillRect((width - 16) / 2 + 8, height - 24, (width - 16) / 2 - 4, 18);
    // Saturated striped awning above the shopfront.
    const awningColors = vivid
      ? ['#e02f3f', '#ff5ca8', '#8f3fd6', '#1f9fbf', '#f2a01f', '#3f9f4f', '#ff7043', '#d92f8f']
      : ['#e04945', '#128f9e', '#e5a021', '#3d8f52', '#8a5fc0'];
    const awning = awningColors[Math.floor(random() * awningColors.length)];
    context.fillStyle = awning;
    for (let i = 0; i < width; i += 12) {
      context.fillRect(i, height - 34, 6, 8);
    }
    context.fillStyle = 'rgba(255,255,255,0.22)';
    for (let i = 0; i < width; i += 24) {
      context.fillRect(i, height - 34, 3, 8);
    }
    if (!day) {
      const neonColors = ['#ff5fa2', '#35d7d7', '#ffc43d'];
      const neon = neonColors[Math.floor(random() * neonColors.length)];
      context.shadowColor = neon;
      context.shadowBlur = 10;
      context.fillStyle = neon;
      context.fillRect(6, height - 46, width - 12, 7);
      const second = neonColors[(neonColors.indexOf(neon) + 1 + Math.floor(random() * 2)) % neonColors.length];
      context.shadowColor = second;
      context.fillStyle = second;
      context.fillRect(14, height - 58, Math.floor((width - 28) * 0.62), 4);
    }
  }
  if (style === 'bay-window') {
    context.fillStyle = 'rgba(90,70,55,0.35)';
    for (let col = 0; col < columns; col += 1) {
      context.fillRect(margin + col * gapX - 4, 8, 14, height - 16);
    }
  }
}

function drawAsphalt(context, width, height, random) {
  context.fillStyle = '#5b5a58';
  context.fillRect(0, 0, width, height);
  for (let i = 0; i < 140; i += 1) {
    context.fillStyle = random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.1)';
    context.fillRect(random() * width, random() * height, 2 + random() * 3, 1 + random() * 2);
  }
  for (let i = 0; i < 10; i += 1) {
    context.fillStyle = 'rgba(255,255,255,0.08)';
    const x = random() * width;
    const y = random() * height;
    context.beginPath();
    context.ellipse(x, y, 8 + random() * 14, 5 + random() * 8, random() * 3, 0, Math.PI * 2);
    context.fill();
  }
}

function drawSidewalk(context, width, height, random) {
  context.fillStyle = '#e2c79a';
  context.fillRect(0, 0, width, height);
  for (let i = 0; i < 30; i += 1) {
    context.fillStyle = 'rgba(140,120,100,0.1)';
    context.fillRect(random() * width, random() * height, 6 + random() * 16, 1.4);
  }
  context.strokeStyle = 'rgba(130,100,70,0.3)';
  context.lineWidth = 1.4;
  for (let y = 16; y < height; y += 32) {
    context.beginPath();
    context.moveTo(0, y + random() * 4);
    context.lineTo(width, y + random() * 4);
    context.stroke();
  }
}

function drawGround(context, width, height, random) {
  context.fillStyle = '#9fc38a';
  context.fillRect(0, 0, width, height);
  for (let i = 0; i < 60; i += 1) {
    context.fillStyle = random() < 0.5 ? 'rgba(110,140,95,0.3)' : 'rgba(198,214,176,0.28)';
    context.beginPath();
    context.ellipse(random() * width, random() * height, 16 + random() * 30, 10 + random() * 20, random() * 3, 0, Math.PI * 2);
    context.fill();
  }
}

function drawShadowAlpha(context, width, height) {
  const gradient = context.createRadialGradient(width / 2, height / 2, 4, width / 2, height / 2, width / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(0.62, 'rgba(0,0,0,0.72)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function quad(a, b, c, d, normals = true) {
  const n = new THREE.Vector3();
  const ab = new THREE.Vector3().subVectors(b, a);
  const ad = new THREE.Vector3().subVectors(d, a);
  n.crossVectors(ab, ad).normalize();
  const positions = [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z];
  const indices = [0, 1, 2, 0, 2, 3];
  const normalsArr = normals
    ? [n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z]
    : [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  return { positions, indices, normalsArr, count: 4 };
}

function pushQuad(attr, index, a, b, c, d, color = null) {
  const q = quad(a, b, c, d);
  for (let i = 0; i < q.count; i += 1) {
    attr.position.setXYZ(index + i, q.positions[i * 3], q.positions[i * 3 + 1], q.positions[i * 3 + 2]);
    attr.normal.setXYZ(index + i, q.normalsArr[i * 3], q.normalsArr[i * 3 + 1], q.normalsArr[i * 3 + 2]);
    if (color) attr.color.setXYZ(index + i, color.r, color.g, color.b);
  }
  for (const qi of q.indices) attr.index.push(index + qi);
}

function lineQuadAttrs(capacity = 0) {
  // Capacity is a quad count; every quad needs four vertices.
  const vertexCount = capacity * 4;
  return {
    position: new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3),
    normal: new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3),
    color: new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3),
    index: [],
  };
}

 function dynQuadAttrs() {
   // Dynamic quad buffers for counts that depend on segment lengths; avoids a
   // second pre-count pass and any overflow risk.
   return { position: [], normal: [], color: [], index: [] };
 }

 function pushQuadDyn(attrs, a, b, c, d, color = null) {
   const base = attrs.position.length / 3;
   const q = quad(a, b, c, d);
   for (let i = 0; i < q.count; i += 1) {
     attrs.position.push(q.positions[i * 3], q.positions[i * 3 + 1], q.positions[i * 3 + 2]);
     attrs.normal.push(q.normalsArr[i * 3], q.normalsArr[i * 3 + 1], q.normalsArr[i * 3 + 2]);
     if (color) attrs.color.push(color.r, color.g, color.b);
   }
   for (const qi of q.indices) attrs.index.push(base + qi);
 }

 function buildDynGeometry(attrs) {
   const geometry = new THREE.BufferGeometry();
   geometry.setAttribute('position', new THREE.Float32BufferAttribute(attrs.position, 3));
   geometry.setAttribute('normal', new THREE.Float32BufferAttribute(attrs.normal, 3));
   geometry.setAttribute('color', new THREE.Float32BufferAttribute(attrs.color, 3));
   geometry.setIndex(attrs.index);
   return geometry;
 }

 function pushStripDyn(attrs, p, q, width, yAt, color) {
   // Flat ribbon along p->q, `width` wide, following terrain via yAt.
   const dx = q.x - p.x;
   const dz = q.z - p.z;
   const length = Math.hypot(dx, dz);
   if (length < 0.01) return;
   const mx = (-dz / length) * (width / 2);
   const mz = (dx / length) * (width / 2);
   pushQuadDyn(attrs,
     { x: p.x + mx, y: yAt(p.x, p.z), z: p.z + mz },
     { x: q.x + mx, y: yAt(q.x, q.z), z: q.z + mz },
     { x: q.x - mx, y: yAt(q.x, q.z), z: q.z - mz },
     { x: p.x - mx, y: yAt(p.x, p.z), z: p.z - mz },
     color,
   );
 }

function buildAttrGeometry(attrs) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', attrs.position);
  geometry.setAttribute('normal', attrs.normal);
  geometry.setAttribute('color', attrs.color);
  geometry.setIndex(attrs.index);
  return geometry;
}

function finalizeAttrs(attr, count) {
  attr.position.count = count;
  attr.normal.count = count;
  attr.color.count = count;
  attr.position.needsUpdate = true;
  attr.normal.needsUpdate = true;
  attr.color.needsUpdate = true;
}

function colorFromHex(hex) {
  return new THREE.Color(hex);
}

function shade(color, amount) {
  const c = color.clone();
  if (amount >= 0) c.lerp(new THREE.Color('#ffffff'), amount);
  else c.lerp(new THREE.Color('#1a1a1a'), -amount);
  return c;
}

export class CityRenderer {
  constructor(container, { pixelRatioCap = 1.5 } = {}) {
    this.container = container;
    this.scene = new THREE.Scene();
    // Soft warm haze: closer fog start wraps distant blocks gently.
    this.scene.fog = new THREE.Fog(0xe2e8e2, 330, 1380);
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 4200);
    this.camera.position.set(180, 150, 260);
    const sceneCanvas = container.querySelector('#scene-canvas');
    this.renderer = new WebGPURenderer({
      antialias: true,
      powerPreference: 'high-performance',
      ...(sceneCanvas ? { canvas: sceneCanvas } : {}),
    });
    this.rendererBackend = 'initializing';
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.86;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    if (!sceneCanvas) container.appendChild(this.renderer.domElement);
    // A restrained filmic grade keeps the pastel material palette intact and
    // avoids turning large real-map facades into neon color fields.
    this.renderer.domElement.style.filter = 'saturate(1.16) contrast(1.04) brightness(1.01)';

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 620;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 4, 0);
    this.controls.enablePan = true;
    this.controls.panSpeed = 1.1;

    this.clock = new THREE.Clock();
    this.pickables = [];
    this.geometryCache = [];
    this.timeOfDay = 15;
    this.appliedTimeOfDay = null;
    this.appliedNightState = null;
    this.lightingPipelinesRendered = false;
    this.timeColors = {
      skyTopDay: new THREE.Color('#5f9fd1'),
      skyMidDay: new THREE.Color('#93c8e0'),
      skyBottomDay: new THREE.Color('#f6e7c9'),
      skyTopNight: new THREE.Color('#1e2450'),
      skyMidNight: new THREE.Color('#33396b'),
      skyBottomNight: new THREE.Color('#5b4a7d'),
      hemiDay: new THREE.Color('#e8f4ff'),
      hemiNight: new THREE.Color('#7c8cf2'),
      fogNight: new THREE.Color('#2a2e58'),
      fogDay: new THREE.Color('#cfe3ea'),
      fogDistant: new THREE.Color('#8a9fb8'),
      fogWarm: new THREE.Color('#ead9bd'),
      work: new THREE.Color(),
      sun: new THREE.Color(),
    };
    this.skyMesh = null;
    this.signalPhaseClock = 0;
    this.phaseClock = 0;
    this.terrain = null;
    this.city = null;
    this.streetFurniture = { props: 0, cars: 0, awnings: 0, bunting: 0 };
    this.sidewalkPropRecords = [];
    this.sidewalkPropDiagnostics = { bandViolations: 0, asphaltOverlaps: 0 };
    this.buildingFootprintDiagnostics = {
      sourceCount: 0,
      polygonShells: 0,
      fallbacks: 0,
      finite: true,
      sourceArea: 0,
      renderedArea: 0,
      maxAreaRelativeError: 0,
      triangleCount: 0,
      triangleDelta: 0,
    };
    this.heroFacadeDiagnostics = {
      asset: HERO_FACADE_ATLAS_URL,
      heroes: [],
      drawGroups: 0,
      triangleDelta: 0,
      atlasLoaded: false,
    };
    this.nightEmissive = [];
    this.neonGlowMaterials = [];
    this.lampBulbs = [];
    this.lampLights = [];
    this.lightPools = [];
    this.neonLights = [];
    this.localLightCandidates = [];
    this.localLightPool = [];
    this.localLightUpdateClock = 0;
    this.localLightsNight = false;
    this.streetLampRecords = [];
    this.streetLampDiagnostics = {
      source: null,
      fixtureCount: 0,
      candidateCount: 0,
      maxLamps: 0,
      sourceOwnedCount: 0,
      bandViolations: 0,
      asphaltOverlaps: 0,
      pointLightPoolSize: 0,
    };
    this.terrainVisualScale = 1;

    this.sun = new THREE.DirectionalLight(0xffe0b0, 2.75);
    this.sun.position.set(-260, 380, 120);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 1000;
    this.sun.shadow.camera.left = -420;
    this.sun.shadow.camera.right = 420;
    this.sun.shadow.camera.top = 420;
    this.sun.shadow.camera.bottom = -420;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun);

    this.hemi = new THREE.HemisphereLight(0xe9f6ff, 0x9fb47a, 1.38);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xfff2dc, 0.3);
    this.scene.add(this.ambient);
    this.rim = new THREE.DirectionalLight(0xcfe3f0, 0.6);
    this.rim.position.set(320, 240, -260);
    this.scene.add(this.rim);

    this.onResize = this.resize.bind(this);
    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  async initialize() {
    await this.renderer.init();
    this.rendererBackend = this.renderer.backend?.isWebGPUBackend === true
      ? 'webgpu'
      : this.renderer.backend?.isWebGLBackend === true
        ? 'webgl2-fallback'
        : 'unknown';
    return this.rendererBackend;
  }

  resize() {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  dispose() {
    window.removeEventListener('resize', this.onResize);
    this.controls.dispose();
    for (const geometry of this.geometryCache) geometry.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  setCity(city) {
    this.city = city;
    const isSf = isSanFranciscoCity(city);
    const bounds = city?.meta?.bounds;
    const mapSpan = bounds
      ? Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ)
      : 0;
    // The procedural sandbox is only a few blocks wide, while the built-in
    // OSM slice spans roughly two kilometres. Scale atmospheric depth with the
    // loaded map so aerial views retain road and skyline contrast instead of
    // fading almost the entire city into the horizon colour.
    if (this.scene.fog) {
      this.scene.fog.near = Math.max(330, mapSpan * 0.55);
      this.scene.fog.far = Math.max(1380, mapSpan * 1.5);
    }
    // The baked SF grid is intentionally a little compressed for data use.
    // A restrained render-only lift restores the stepped hill silhouette while
    // keeping every road/building query on the same height function.
    this.terrainVisualScale = isSf ? 1.12 : 1;
    const sourceHeightAt = city?.terrain?.heightAt;
    if (sourceHeightAt) {
      this.terrain = {
        ...city.terrain,
        heightAt: (x, z) => {
          const value = Number(sourceHeightAt(x, z));
          return Number.isFinite(value) ? value * this.terrainVisualScale : 0;
        },
      };
    } else {
      this.terrain = {
        heightAt: (x, z) => terrainHeight(x, z, Number(city?.meta?.seedInt || 1)) * this.terrainVisualScale,
      };
    }
  }

  async buildCity(city, { focus = null, day = true } = {}) {
    this.setCity(city);
    this.day = day;
    this.appliedTimeOfDay = null;
    this.appliedNightState = null;
    // Dispose old dynamic geometry only; static materials persist for rebuilds.
    for (const geometry of this.geometryCache) geometry.dispose();
    this.geometryCache = [];
    this.pickables = [];
    this.neonGlowMaterials = [];
    this.lampBulbs = [];
    this.lampLights = [];
    this.neonLights = [];
    this.lightPools = [];
    this.localLightCandidates = [];
    this.localLightPool = [];
    this.localLightUpdateClock = 0;
    this.localLightsNight = false;
    this.streetLampRecords = [];
    this.streetLampDiagnostics = {
      source: city?.meta?.generator || null,
      fixtureCount: 0,
      candidateCount: 0,
      maxLamps: 0,
      sourceOwnedCount: 0,
      bandViolations: 0,
      asphaltOverlaps: 0,
      pointLightPoolSize: 0,
    };
    this.streetFurniture = { props: 0, cars: 0, awnings: 0, bunting: 0 };
    this.sidewalkPropRecords = [];
    this.sidewalkPropDiagnostics = { bandViolations: 0, asphaltOverlaps: 0 };
    this.buildingFootprintDiagnostics = {
      sourceCount: 0,
      polygonShells: 0,
      fallbacks: 0,
      finite: true,
      sourceArea: 0,
      renderedArea: 0,
      maxAreaRelativeError: 0,
      triangleCount: 0,
      triangleDelta: 0,
    };
    const root = new THREE.Group();
    root.name = 'city-root';

    // Sky dome.
    root.add(this.makeSky(city));
    if (this.cloudMesh) {
      root.add(this.cloudMesh);
      this.cloudMesh = null;
    }
    // Terrain base + park ground.
    root.add(this.makeGround(city));
    this.buildTerrainContours(root, city);
    // OSM parks and water polygons on real maps.
    this.buildOsmParks(root, city);
    this.buildOsmWater(root, city);
    // Waterfront for the east edge.
    const water = this.makeWater(city);
    root.add(water);
    // Keep authored bay props under city-root so rebuilds dispose them with
    // the rest of the dynamic scene instead of leaking into the global scene.
    this.buildBayProps(root, city, city.meta.bounds);
    this.buildWaterfrontIdentity(root, city);

    // Buildings with per-facade canvas textures.
    this.roofBatch = { parapets: [], tanks: [], cells: [] };
    await this.buildBuildings(root, city);
    this.flushRoofDetails(root);
    // Soft contact shadows ground the buildings.
    this.buildContactShadows(root, city);
    // Roads, sidewalks, curbs, markings, crosswalks.
    this.buildRoadNetwork(root, city);
    // Night neon trim along major avenues.
    this.buildStreetNeonTrim(root, city);
    // Festival bunting adds street-level color in daylight too.
    this.buildStreetBunting(root, city);
    // Utility poles and sagging wires along major avenues.
    this.buildUtilityLines(root, city);
    // Real SF transit routes get paired rails and restrained overhead wires;
    // generic/procedural maps do not inherit this city-specific clutter.
    this.buildTransitCues(root, city);
    // Signals with metadata.
    this.buildSignals(root, city);
    // Trees.
    this.buildTrees(root, city);
    // Curbside cars: saturated paint anchors the street-level color story.
    this.buildParkedCars(root, city);
    this.buildShopAwnings(root, city);
    this.installLocalLightPool(root);

    this.root = root;
    this.scene.add(root);
    this.camera.near = 0.5;
    this.camera.far = 4200;
    this.camera.updateProjectionMatrix();
    this.signalPhaseClock = 0;
    await this.prewarmLightingPipelines();
    return root;
  }

  async prewarmLightingPipelines() {
    if (typeof this.renderer.compileAsync !== 'function') return;
    const renderWarmup = !this.lightingPipelinesRendered
      && typeof this.renderer.renderAsync === 'function';
    const restoreHour = this.timeOfDay;
    this.appliedTimeOfDay = null;
    this.appliedNightState = null;
    this.setTimeOfDay(14);
    await this.renderer.compileAsync(this.scene, this.camera);
    if (renderWarmup) await this.renderer.renderAsync(this.scene, this.camera);
    this.setTimeOfDay(22);
    await this.renderer.compileAsync(this.scene, this.camera);
    if (renderWarmup) await this.renderer.renderAsync(this.scene, this.camera);
    this.setTimeOfDay(restoreHour);
    await this.renderer.compileAsync(this.scene, this.camera);
    if (renderWarmup) {
      await this.renderer.renderAsync(this.scene, this.camera);
      this.lightingPipelinesRendered = true;
    }
  }

  installMetricTileRoot(root, bounds) {
    for (const geometry of this.geometryCache) geometry.dispose();
    this.geometryCache = [];
    this.city = null;
    this.root = root;
    this.scene.add(root);
    this.terrainVisualScale = 1;
    this.terrain = { heightAt: () => 0 };
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    if (this.scene.fog) {
      this.scene.fog.near = Math.max(330, span * 0.55);
      this.scene.fog.far = Math.max(1380, span * 1.5);
    }
    this.camera.near = 0.5;
    this.camera.far = Math.max(2400, span * 2.2);
    this.camera.updateProjectionMatrix();
    return root;
  }

  clearCity() {
    if (this.root) {
      this.scene.remove(this.root);
      this.root.traverse((object) => {
        if (object.geometry) this.geometryCache.push(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
        for (const material of materials) {
          material.map?.dispose();
          material.dispose();
        }
      });
      for (const entry of this.nightEmissive) {
        if (entry.nightTexture) entry.nightTexture.dispose();
      }
      if (this.contactShadowMaterial) this.contactShadowMaterial.dispose();
      this.nightEmissive = [];
      this.lampBulbs = [];
      this.lampLights = [];
      this.lightPools = [];
      this.neonLights = [];
      this.localLightCandidates = [];
      this.localLightPool = [];
      this.localLightUpdateClock = 0;
      this.localLightsNight = false;
      this.streetLampRecords = [];
      this.streetLampDiagnostics = {
        source: null,
        fixtureCount: 0,
        candidateCount: 0,
        maxLamps: 0,
        sourceOwnedCount: 0,
        bandViolations: 0,
        asphaltOverlaps: 0,
        pointLightPoolSize: 0,
      };
      this.sidewalkPropRecords = [];
      this.sidewalkPropDiagnostics = { bandViolations: 0, asphaltOverlaps: 0 };
      this.buildingFootprintDiagnostics = {
        sourceCount: 0,
        polygonShells: 0,
        fallbacks: 0,
        finite: true,
        sourceArea: 0,
        renderedArea: 0,
        maxAreaRelativeError: 0,
        triangleCount: 0,
        triangleDelta: 0,
      };
      this.heroFacadeDiagnostics = {
        asset: HERO_FACADE_ATLAS_URL,
        heroes: [],
        drawGroups: 0,
        triangleDelta: 0,
        atlasLoaded: false,
      };
      this.signalMeshes = [];
      this.root = null;
    }
  }

  makeSky(city) {
    const bounds = city.meta.bounds;
    const skyCenterX = (bounds.minX + bounds.maxX) / 2;
    const skyCenterZ = (bounds.minZ + bounds.maxZ) / 2;
    const geometry = new THREE.SphereGeometry(1900, 32, 16);
    const colors = [];
    const positions = geometry.attributes.position.array;
    const top = new THREE.Color('#4f9fd6');
    const mid = new THREE.Color('#8cc8e2');
    const bottom = new THREE.Color('#ffe2b8');
    for (let i = 0; i < positions.length; i += 3) {
      const y = positions[i + 1] / 1900;
      const c = y > 0.08 ? top.clone().lerp(mid, clamp(y, 0, 1)) : bottom.clone().lerp(mid, 1 - clamp(-y, 0, 1) * 4);
      colors.push(c.r, c.g, c.b);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(geometry, material);
    sky.position.set(skyCenterX, 0, skyCenterZ);
    sky.renderOrder = -10;
    this.geometryCache.push(geometry);
    this.skyMesh = sky;
    // Soft stylized cloud layer adds gentle structure to the sky dome.
    const cloudTexture = seededTexture(505, (context, width, height, random) => {
      context.clearRect(0, 0, width, height);
      for (let i = 0; i < 14; i += 1) {
        const cx = random() * width;
        const cy = height * (0.18 + random() * 0.4);
        const blobs = 3 + Math.floor(random() * 4);
        // Warm-tinted clouds keep the sky saturation high under the soft
        // warm key light.
        context.fillStyle = `rgba(255,222,186,${0.28 + random() * 0.24})`;
        for (let bIdx = 0; bIdx < blobs; bIdx += 1) {
          context.beginPath();
          context.ellipse(
            cx + (random() - 0.5) * 90,
            cy + (random() - 0.5) * 18,
            26 + random() * 46,
            7 + random() * 10,
            0, 0, Math.PI * 2,
          );
          context.fill();
        }
      }
    }, 512, 256);
    cloudTexture.wrapS = THREE.RepeatWrapping;
    const cloudGeometry = new THREE.SphereGeometry(1840, 32, 16);
    const cloudMaterial = new THREE.MeshBasicMaterial({
      map: cloudTexture,
      transparent: true,
      opacity: city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap' ? 0.05 : 0.28,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    });
    const clouds = new THREE.Mesh(cloudGeometry, cloudMaterial);
    clouds.position.set(skyCenterX, 0, skyCenterZ);
    clouds.renderOrder = -9;
    this.geometryCache.push(cloudGeometry);
    this.cloudMesh = clouds;
    return sky;
  }

  makeGround(city) {
    const bounds = city.meta.bounds;
    const width = bounds.maxX - bounds.minX + 520;
    const depth = bounds.maxZ - bounds.minZ + 520;
    const geometry = new THREE.PlaneGeometry(width, depth, 96, 96);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position.array;
    const colors = [];
    const park = new THREE.Color('#9fc38a');
    const field = new THREE.Color('#7f9a66');
    const waterEdge = new THREE.Color('#a9c99b');
    const slopeWarm = new THREE.Color('#c8a879');
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] + (bounds.minX + bounds.maxX) / 2;
      const z = positions[i + 2] + (bounds.minZ + bounds.maxZ) / 2;
      const y = this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0;
      positions[i + 1] = y - 0.22;
      const n = Math.sin(x * 0.011 + z * 0.017 + Number(city.meta.seedInt) * 0.1) * 0.5 + 0.5;
      const nearWater = smoothstep(bounds.maxX - 160, bounds.maxX - 30, x);
      // Elevation-aware color grading gives the baked USGS grid a readable
      // directional hillshade instead of a uniformly green carpet. The
      // geometry normals still carry the true grade; this only adds a gentle
      // low-poly material cue for aerial views.
      const sampleStep = 8;
      const slopeX = ((this.terrain?.heightAt ? this.terrain.heightAt(x + sampleStep, z) : 0)
        - (this.terrain?.heightAt ? this.terrain.heightAt(x - sampleStep, z) : 0)) / (sampleStep * 2);
      const slopeZ = ((this.terrain?.heightAt ? this.terrain.heightAt(x, z + sampleStep) : 0)
        - (this.terrain?.heightAt ? this.terrain.heightAt(x, z - sampleStep) : 0)) / (sampleStep * 2);
      const slope = Math.hypot(slopeX, slopeZ);
      const light = clamp(0.88 - slopeX * 0.62 + slopeZ * 0.34, 0.66, 1.08);
      const c = park.clone().lerp(field, n * 0.35).lerp(waterEdge, nearWater * 0.35);
      c.multiplyScalar(light);
      if (slope > 0.045) c.lerp(slopeWarm, clamp((slope - 0.045) * 0.9, 0, 0.16));
      colors.push(c.r, c.g, c.b);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    this.geometryCache.push(geometry);
    return mesh;
  }

  buildTerrainContours(root, city) {
    const terrainType = String(city?.terrain?.type || city?.meta?.terrain?.type || '');
    const sfCity = isSanFranciscoCity(city);
    if (!sfCity && terrainType !== 'soft-hills') return;
    const bounds = city.meta.bounds;
    const columns = sfCity ? 30 : 22;
    const rows = sfCity ? 30 : 22;
    const heights = new Array((columns + 1) * (rows + 1));
    let min = Infinity;
    let max = -Infinity;
    const heightAt = (x, z) => this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0;
    for (let row = 0; row <= rows; row += 1) {
      const z = bounds.minZ + (bounds.maxZ - bounds.minZ) * (row / rows);
      for (let col = 0; col <= columns; col += 1) {
        const x = bounds.minX + (bounds.maxX - bounds.minX) * (col / columns);
        const y = heightAt(x, z);
        heights[row * (columns + 1) + col] = y;
        min = Math.min(min, y);
        max = Math.max(max, y);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 7) return;
    const contourCount = sfCity ? 8 : 6;
    const step = (max - min) / (contourCount + 1);
    const positions = [];
    const waterPolygons = (city.water || []).map((water) => water.polygon).filter(Boolean);
    const pointIsWater = (x, z) => waterPolygons.some((polygon) => pointInPolygon({ x, z }, polygon));
    const addEdge = (level, a, ay, b, by, hits) => {
      if ((ay < level && by >= level) || (by < level && ay >= level)) {
        const span = by - ay;
        const t = Math.abs(span) < 0.0001 ? 0.5 : clamp((level - ay) / span, 0, 1);
        hits.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: level + 0.09 });
      }
    };
    for (let contourIndex = 1; contourIndex <= contourCount; contourIndex += 1) {
      const level = min + step * contourIndex;
      for (let row = 0; row < rows; row += 1) {
        const z0 = bounds.minZ + (bounds.maxZ - bounds.minZ) * (row / rows);
        const z1 = bounds.minZ + (bounds.maxZ - bounds.minZ) * ((row + 1) / rows);
        for (let col = 0; col < columns; col += 1) {
          const x0 = bounds.minX + (bounds.maxX - bounds.minX) * (col / columns);
          const x1 = bounds.minX + (bounds.maxX - bounds.minX) * ((col + 1) / columns);
          if (pointIsWater((x0 + x1) * 0.5, (z0 + z1) * 0.5)) continue;
          const i00 = row * (columns + 1) + col;
          const i10 = i00 + 1;
          const i11 = i10 + columns + 1;
          const i01 = i00 + columns + 1;
          const hits = [];
          addEdge(level, { x: x0, z: z0 }, heights[i00], { x: x1, z: z0 }, heights[i10], hits);
          addEdge(level, { x: x1, z: z0 }, heights[i10], { x: x1, z: z1 }, heights[i11], hits);
          addEdge(level, { x: x1, z: z1 }, heights[i11], { x: x0, z: z1 }, heights[i01], hits);
          addEdge(level, { x: x0, z: z1 }, heights[i01], { x: x0, z: z0 }, heights[i00], hits);
          if (hits.length >= 2) {
            const a = hits[0];
            const b = hits[1];
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
          }
        }
      }
    }
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: sfCity ? 0x8b755d : 0x647151,
      transparent: true,
      opacity: sfCity ? 0.18 : 0.13,
      depthWrite: false,
    });
    const contours = new THREE.LineSegments(geometry, material);
    contours.name = 'elevation-contours';
    contours.renderOrder = 1;
    root.add(contours);
    this.geometryCache.push(geometry, material);
  }

  makeWater(city) {
    const bounds = city.meta.bounds;
    const geometry = new THREE.PlaneGeometry(680, bounds.maxZ - bounds.minZ + 520);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0x2f8fae,
      roughness: 0.24,
      metalness: 0.3,
      transparent: true,
      opacity: 0.96,
    });
    const water = new THREE.Mesh(geometry, material);
    water.position.set(bounds.maxX - 70, 0.5, (bounds.minZ + bounds.maxZ) / 2);
    water.receiveShadow = true;
    this.geometryCache.push(geometry);
    this.water = water;
    return water;
  }

  buildWaterfrontIdentity(root, city) {
    if (!isSanFranciscoCity(city) && !(city.water || []).length) return;
    const bounds = city.meta.bounds;
    const random = mulberry32(Number(city.meta.seedInt || 1) + 6011);
    const attrs = dynQuadAttrs();
    const waterX = bounds.maxX - 70;
    const spanZ = Math.max(40, bounds.maxZ - bounds.minZ - 20);
    // Short, sparse low-poly ripples make the bay legible without a heavy
    // normal-map or thousands of individual meshes.
    for (let i = 0; i < 96; i += 1) {
      const x = waterX - 270 + random() * 540;
      const z = bounds.minZ + 10 + random() * spanZ;
      const length = 3.5 + random() * 14;
      const width = 0.055 + random() * 0.055;
      const color = i % 3 === 0 ? new THREE.Color('#8bc4cb') : new THREE.Color('#5ea9ba');
      pushQuadDyn(attrs,
        { x: x - length / 2, y: 0.72 + random() * 0.02, z: z - width },
        { x: x + length / 2, y: 0.72 + random() * 0.02, z: z - width },
        { x: x + length / 2, y: 0.72 + random() * 0.02, z: z + width },
        { x: x - length / 2, y: 0.72 + random() * 0.02, z: z + width },
        color,
      );
    }
    const geometry = buildDynGeometry(attrs);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.48,
      roughness: 0.28,
      metalness: 0.18,
      depthWrite: false,
    });
    const ripples = new THREE.Mesh(geometry, material);
    ripples.name = 'bay-ripple-cards';
    ripples.renderOrder = 2;
    root.add(ripples);
    this.geometryCache.push(geometry, material);
  }

  buildOsmParks(root, city) {
    const parks = city.parks || [];
    if (!parks.length) return;
    const parkMaterial = new THREE.MeshStandardMaterial({ color: 0x9fc38a, roughness: 1, flatShading: true });
    const pathMaterial = new THREE.MeshStandardMaterial({ color: 0xdfc69c, roughness: 0.95, flatShading: true });
    const treeMaterial = new THREE.MeshStandardMaterial({ color: 0x4f7f4a, roughness: 0.9, flatShading: true });
    const random = mulberry32(Number(city.meta.seedInt || 1) + 7711);
    for (const park of parks) {
      const points = park.polygon;
      if (!points || points.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(points[0].x, points[0].z);
      for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i].x, points[i].z);
      shape.closePath();
      const geometry = new THREE.ShapeGeometry(shape);
      const mesh = new THREE.Mesh(geometry, parkMaterial);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.03;
      mesh.receiveShadow = true;
      root.add(mesh);
      this.geometryCache.push(geometry);
      const pathGeo = new THREE.ShapeGeometry(shape);
      const path = new THREE.Mesh(pathGeo, pathMaterial);
      path.rotation.x = -Math.PI / 2;
      path.position.y = 0.045;
      path.receiveShadow = true;
      root.add(path);
      this.geometryCache.push(pathGeo);
      const bounds = polygonBounds(points);
      const count = Math.min(80, Math.max(6, Math.round((bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ) / 900)));
      for (let i = 0; i < count; i += 1) {
        const x = bounds.minX + random() * (bounds.maxX - bounds.minX);
        const z = bounds.minZ + random() * (bounds.maxZ - bounds.minZ);
        if (!pointInPolygon({ x, z }, points)) continue;
        const tree = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.4, 6), treeMaterial);
        tree.position.set(x, 1.2, z);
        tree.castShadow = true;
        root.add(tree);
        this.geometryCache.push(tree.geometry);
      }
    }
  }

  buildOsmWater(root, city) {
    const waters = city.water || [];
    if (!waters.length) return;
    const waterMaterial = new THREE.MeshStandardMaterial({
      color: 0x2f8fae,
      roughness: 0.24,
      metalness: 0.3,
      transparent: true,
      opacity: 0.94,
    });
    for (const water of waters) {
      const points = water.polygon;
      if (!points || points.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(points[0].x, points[0].z);
      for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i].x, points[i].z);
      shape.closePath();
      const geometry = new THREE.ShapeGeometry(shape);
      const mesh = new THREE.Mesh(geometry, waterMaterial);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.16;
      mesh.receiveShadow = true;
      root.add(mesh);
      this.geometryCache.push(geometry);
    }
  }

  buildBayProps(scene, city, bounds) {
    // The bay bridge silhouette belongs to the SF waterfront slice. Keeping
    // it out of procedural maps removes the old center-frame pole/arm that
    // read as an accidental obstruction in aerial and street captures.
    if (!isSanFranciscoCity(city) && !(city.water || []).length) return;
    const y = 0.52;
    const towerX = bounds.maxX - 220;
    const towerZ = (bounds.minZ + bounds.maxZ) / 2 + 40;
    const towerHeight = clamp((bounds.maxZ - bounds.minZ) * 0.09, 28, 52);
    const towerMaterial = new THREE.MeshStandardMaterial({
      color: 0x8a9399,
      roughness: 0.6,
      metalness: 0.55,
      flatShading: true,
    });
    const deckMaterial = new THREE.MeshStandardMaterial({
      color: 0xb25f4a,
      roughness: 0.8,
      flatShading: true,
    });
    const towerGeometry = new THREE.BoxGeometry(3.8, towerHeight, 3.8);
    const left = new THREE.Mesh(towerGeometry, towerMaterial);
    left.position.set(towerX - 74, y + towerHeight / 2, towerZ);
    const right = new THREE.Mesh(towerGeometry, towerMaterial);
    right.position.set(towerX + 74, y + towerHeight / 2, towerZ);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(184, 3.4, 7), deckMaterial);
    deck.position.set(towerX, y + 4.0, towerZ);
    scene.add(left, right, deck);
    const cableMaterial = new THREE.LineBasicMaterial({ color: 0xdfe6ea, transparent: true, opacity: 0.85 });
    for (let i = 0; i <= 10; i += 1) {
      const t = i / 10;
      const points = [];
      const sag = 14;
      for (let s = 0; s <= 10; s += 1) {
        const st = s / 10;
        points.push(new THREE.Vector3(
          towerX - 74 + 148 * st,
          y + towerHeight + (Math.sin(st * Math.PI) * -sag * 0.75) + (t - 0.5) * 2,
          towerZ - 4.2 + t * 8.4,
        ));
      }
      const cable = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), cableMaterial);
      scene.add(cable);
      this.geometryCache.push(cable.geometry);
    }
    this.geometryCache.push(towerGeometry, deck.geometry);
    const boatMaterial = new THREE.MeshStandardMaterial({
      color: 0xcfd6d8,
      roughness: 0.6,
      flatShading: true,
    });
    const boatRandom = mulberry32(Number(city.meta.seedInt || 1) + 44);
    for (let i = 0; i < 5; i += 1) {
      const boat = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.BoxGeometry(7, 1.6, 2.6), boatMaterial);
      hull.position.y = 0.8;
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 1.8, 1.8), deckMaterial);
      cabin.position.set(-0.4, 2.3, 0);
      boat.add(hull, cabin);
      boat.position.set(
        towerX - 140 + boatRandom() * 260,
        y,
        bounds.minZ + 40 + boatRandom() * (bounds.maxZ - bounds.minZ - 80),
      );
      boat.rotation.y = boatRandom() * Math.PI;
      scene.add(boat);
      this.geometryCache.push(hull.geometry, cabin.geometry);
    }
  }

  async buildBuildings(root, city) {
    const flatGroups = new Map();
    // Textured facades are bucketed by (facade, material, vivid, variety) so
    // hundreds of real-map buildings share ~90 cached day/night texture pairs
    // and merge into one mesh per bucket instead of one mesh per building.
    const textureGroups = new Map();
    const heroTextureGroups = new Map();
    const facadeSeed = Number(city.meta.seedInt || 1);
    const random = mulberry32(facadeSeed);
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    let heroTextures = null;
    if (realMap) {
      try {
        heroTextures = await loadHeroFacadeTextures();
      } catch (error) {
        console.warn(`Hero facade atlas unavailable: ${error.message}`);
      }
    }
    this.heroFacadeDiagnostics = {
      asset: HERO_FACADE_ATLAS_URL,
      heroes: [],
      drawGroups: 0,
      triangleDelta: 0,
      atlasLoaded: Boolean(heroTextures),
    };
    const footprintDiagnostics = {
      sourceCount: realMap ? city.buildings.length : 0,
      polygonShells: 0,
      fallbacks: 0,
      finite: true,
      sourceArea: 0,
      renderedArea: 0,
      maxAreaRelativeError: 0,
      triangleCount: 0,
      triangleDelta: 0,
    };

    for (const building of city.buildings) {
      const sourcePoints = Array.isArray(building.polygon) ? building.polygon : [];
      const footprint = realMap ? normalizeBuildingFootprint(sourcePoints) : null;
      const points = footprint || sourcePoints;
      if (points.length < 3) {
        if (realMap) {
          footprintDiagnostics.fallbacks += 1;
          footprintDiagnostics.finite = false;
        }
        continue;
      }
      const landmarkKey = landmarkKind(building);
      if (landmarkKey && !realMap) {
        const minX = Math.min(...points.map((p) => p.x));
        const maxX = Math.max(...points.map((p) => p.x));
        const minZ = Math.min(...points.map((p) => p.z));
        const maxZ = Math.max(...points.map((p) => p.z));
        const width = maxX - minX;
        const depth = maxZ - minZ;
        const height = building.height;
        const baseY = this.terrain?.heightAt ? this.terrain.heightAt((minX + maxX) / 2, (minZ + maxZ) / 2) : 0;
        this.buildLandmark(root, landmarkKey, building, width, depth, height, baseY, minX, minZ);
        continue;
      }
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minZ = Math.min(...points.map((p) => p.z));
      const maxZ = Math.max(...points.map((p) => p.z));
      const width = maxX - minX;
      const depth = maxZ - minZ;
      if (width < 2 || depth < 2) continue;
      const height = building.height;
      const baseY = this.terrain?.heightAt ? this.terrain.heightAt((minX + maxX) / 2, (minZ + maxZ) / 2) : 0;
      const center = new THREE.Vector3((minX + maxX) / 2, baseY + height / 2, (minZ + maxZ) / 2);
      const isFlat = building.type === 'warehouse' || building.type === 'civic' || building.type === 'park';
      const textureRoll = random();
      const useTexture = HERO_FACADE_IDS.has(building.id) || (!isFlat && textureRoll < 0.88);
      const materialKey = building.material;
      const sourceArea = footprint ? Math.abs(signedFootprintArea(footprint)) : ringArea(points);
      let shell = footprint ? polygonExtrusionGeometry(footprint, height, baseY) : null;
      const shellAreaError = shell && sourceArea > BUILDING_FOOTPRINT_EPSILON
        ? Math.abs(shell.renderedArea - sourceArea) / sourceArea
        : Infinity;
      if (shell && (!Number.isFinite(shellAreaError) || shellAreaError > 0.001)) {
        shell.geometry.dispose();
        shell = null;
      }
      const footprintMode = realMap && shell ? 'polygon-footprint' : 'legacy-aabb';
      let geometry;
      let renderedArea;
      let triangleCount;
      if (shell) {
        geometry = shell.geometry;
        renderedArea = shell.renderedArea;
        triangleCount = shell.triangleCount;
        footprintDiagnostics.polygonShells += 1;
      } else {
        geometry = new THREE.BoxGeometry(width, height, depth);
        geometry.translate(center.x, baseY + height / 2, center.z);
        renderedArea = width * depth;
        triangleCount = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
        if (realMap) footprintDiagnostics.fallbacks += 1;
      }
      if (realMap) {
        const relativeError = sourceArea > BUILDING_FOOTPRINT_EPSILON
          ? Math.abs(renderedArea - sourceArea) / sourceArea
          : renderedArea > BUILDING_FOOTPRINT_EPSILON ? 1 : 0;
        footprintDiagnostics.sourceArea += sourceArea;
        footprintDiagnostics.renderedArea += renderedArea;
        footprintDiagnostics.maxAreaRelativeError = Math.max(footprintDiagnostics.maxAreaRelativeError, relativeError);
        footprintDiagnostics.triangleCount += triangleCount;
        footprintDiagnostics.triangleDelta += triangleCount - 12;
        footprintDiagnostics.finite = footprintDiagnostics.finite
          && Number.isFinite(sourceArea)
          && Number.isFinite(renderedArea)
          && Number.isFinite(relativeError)
          && Array.from(geometry.attributes.position.array).every(Number.isFinite);
      }

      if (useTexture) {
        const facadeStyle = building.facade || 'modern-grid';
        const atlasGroupKey = realMap && footprintMode === 'polygon-footprint' && heroTextures
          ? heroFacadeMaterialGroup(building)
          : null;
        if (atlasGroupKey) {
          const atlasCell = heroFacadeCell(building, atlasGroupKey);
          const finite = remapPolygonFacadeToAtlas(geometry, footprint.length, atlasCell.cell);
          let atlasGroup = heroTextureGroups.get(atlasGroupKey);
          if (!atlasGroup) {
            atlasGroup = { geoms: [], material: atlasGroupKey, buildingIds: [], patternKeys: new Set() };
            heroTextureGroups.set(atlasGroupKey, atlasGroup);
          }
          atlasGroup.geoms.push(geometry);
          atlasGroup.buildingIds.push(building.id);
          atlasGroup.patternKeys.add(atlasCell.pattern);
          this.geometryCache.push(geometry);
          if (HERO_FACADE_IDS.has(building.id)) {
            this.heroFacadeDiagnostics.heroes.push({
              id: building.id,
              footprintMode,
              finite,
              roofline: true,
              cornice: true,
              parapet: true,
              patternKeys: [atlasCell.pattern],
              presentation: 'atlas-baked',
              cell: atlasCell.cell,
            });
          }
          continue;
        }
        const varietyCount = realMap ? 6 : 2;
        const variety = Math.floor(hashString(`${facadeStyle}-${building.material}-${building.id}`) % varietyCount);
        const vividFacade = building.type === 'shop' || facadeStyle === 'shopfront';
        const key = `${facadeStyle}|${building.material}|${vividFacade ? 1 : 0}|${variety}`;
        const bucketKey = `${key}|${footprintMode}`;
        let group = textureGroups.get(bucketKey);
        if (!group) {
          group = {
            geoms: [],
            facadeStyle,
            material: building.material,
            vivid: vividFacade,
            variety,
            textureKey: key,
            footprintMode,
          };
          textureGroups.set(bucketKey, group);
        }
        if (footprintMode === 'legacy-aabb') {
          const repeatY = Math.max(1, Math.round(height / BUILDING_UV_METRES_Y));
          const repeatX = Math.max(1, Math.round(width / BUILDING_UV_METRES_X));
          // Preserve the legacy per-face repeat for procedural and malformed
          // source fallbacks; polygon shells already carry metric wall UVs.
          const uv = geometry.attributes.uv;
          for (let i = 0; i < uv.count; i += 1) {
            uv.setX(i, uv.getX(i) * repeatX);
            uv.setY(i, uv.getY(i) * repeatY);
          }
        }
        group.geoms.push(geometry);
        this.geometryCache.push(geometry);
        // Legacy rooftop props are placed from the AABB and can float outside
        // a corrected polygon shell. Keep them only on the box fallback until
        // roof details consume the source polygon contract directly.
        if (footprintMode === 'legacy-aabb') {
          this.addRoofDetails(root, building, width, depth, height, baseY, minX, minZ, building.material, random);
        }
        continue;
      }

      // Flat-shaded vertex-color building, merged by material.
      const bucketKey = `${materialKey}|${footprintMode}`;
      let group = flatGroups.get(bucketKey);
      if (!group) {
        group = {
          geoms: [],
          colors: PALETTES[materialKey] || PALETTES.plaster,
          buildingIds: [],
          material: materialKey,
          footprintMode,
        };
        flatGroups.set(bucketKey, group);
      }
      // Per-face jitter + roof tone.
      const positions = geometry.attributes.position.array;
      const normals = geometry.attributes.normal.array;
      const faceColors = [];
      const colorList = group.colors;
      for (let i = 0; i < geometry.attributes.position.count; i += 1) {
        const r = mulberry32(facadeSeed + building.id.length + i);
        const baseColor = colorList[Math.floor(r() * colorList.length)];
        const isTop = normals[i * 3 + 1] > 0.5
          || Math.abs(positions[i * 3 + 1] - (baseY + height)) < 0.01;
        const c = isTop ? shade(colorFromHex(baseColor), -0.34) : shade(colorFromHex(baseColor), (r() - 0.5) * 0.14);
        faceColors.push(c.r, c.g, c.b);
      }
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(faceColors, 3));
      group.geoms.push(geometry);
      group.buildingIds.push(building.id);
      this.geometryCache.push(geometry);
      if (footprintMode === 'legacy-aabb') {
        this.addRoofDetails(root, building, width, depth, height, baseY, minX, minZ, building.material, random);
      }
    }

    this.buildingFootprintDiagnostics = footprintDiagnostics;

    for (const [key, group] of heroTextureGroups) {
      const merged = mergeGeometries(group.geoms, false);
      if (!merged) continue;
      merged.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        map: heroTextures.texture,
        emissive: 0xffd29a,
        emissiveMap: heroTextures.nightTexture,
        emissiveIntensity: 0,
        roughness: key === 'glass' ? 0.32 : key === 'concrete' ? 0.64 : 0.72,
        metalness: key === 'glass' ? 0.22 : 0.04,
        flatShading: true,
      });
      this.nightEmissive.push({
        material,
        texture: heroTextures.texture,
        nightTexture: heroTextures.nightTexture,
        nightIntensity: key === 'glass' ? 0.2 : 0.28,
      });
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = {
        kind: 'buildings-hero-textured',
        material: key,
        footprintMode: 'polygon-footprint',
        buildingIds: group.buildingIds,
        patternKeys: [...group.patternKeys],
      };
      root.add(mesh);
      this.pickables.push(mesh);
      this.geometryCache.push(merged);
      this.heroFacadeDiagnostics.drawGroups += 1;
    }
    this.heroFacadeDiagnostics.heroes.sort((a, b) => a.id.localeCompare(b.id));

    for (const [key, group] of flatGroups) {
      const merged = mergeGeometries(group.geoms, false);
      if (!merged) continue;
      merged.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.72,
        metalness: 0.04,
        flatShading: true,
      });
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = {
        kind: 'buildings-flat',
        material: group.material,
        footprintMode: group.footprintMode,
      };
      root.add(mesh);
      this.pickables.push(mesh);
      // Per-building pick metadata via spatial map in main.
    }

    for (const [key, group] of textureGroups) {
      const merged = mergeGeometries(group.geoms, false);
      if (!merged) continue;
      merged.computeVertexNormals();
      const textureSeed = facadeSeed + hashString(group.textureKey) * 17;
      const dayRnd = mulberry32(textureSeed);
      const texture = seededTexture(textureSeed, (context, w, h) => {
        drawFacade(context, w, h, dayRnd, group.facadeStyle, group.material, { day: true, vivid: group.vivid });
      }, 128, 192);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      const nightRnd = mulberry32(textureSeed);
      const nightTexture = seededTexture(textureSeed + 31, (context, w, h) => {
        drawFacade(context, w, h, nightRnd, group.facadeStyle, group.material, { day: false, vivid: group.vivid });
      }, 128, 192);
      nightTexture.wrapS = THREE.RepeatWrapping;
      nightTexture.wrapT = THREE.RepeatWrapping;
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        emissive: 0xfff0b8,
        emissiveMap: nightTexture,
        emissiveIntensity: 0,
        roughness: 0.68,
        metalness: 0.06,
        flatShading: true,
      });
      const nightIntensity = (group.material === 'glass' ? 0.26 : 0.34)
        + (hashString(`${group.textureKey}-night`) % 18) / 100;
      this.nightEmissive.push({ material, texture, nightTexture, nightIntensity });
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = {
        kind: 'buildings-textured',
        facade: group.textureKey,
        footprintMode: group.footprintMode,
      };
      root.add(mesh);
      this.pickables.push(mesh);
      this.geometryCache.push(merged);
    }
  }

  buildLandmark(root, kind, building, width, depth, height, baseY, minX, minZ) {
    const cx = minX + width / 2;
    const cz = minZ + depth / 2;
    const base = new THREE.MeshStandardMaterial({ color: 0xdfe4e6, roughness: 0.55, metalness: 0.12, flatShading: true });
    const glass = new THREE.MeshStandardMaterial({ color: 0x8fb7d8, roughness: 0.28, metalness: 0.45, flatShading: true });
    const warm = new THREE.MeshStandardMaterial({ color: 0xe7cfa8, roughness: 0.6, metalness: 0.05, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x4a5a6a, roughness: 0.5, metalness: 0.25, flatShading: true });
    const terracotta = new THREE.MeshStandardMaterial({ color: 0xb66f5a, roughness: 0.72, flatShading: true });
    const slate = new THREE.MeshStandardMaterial({ color: 0x65717c, roughness: 0.62, metalness: 0.18, flatShading: true });
    const group = new THREE.Group();
    if (kind === 'transamerica') {
      const span = Math.max(width, depth);
      const pyramid = new THREE.ConeGeometry(span * 0.62, height * 0.94, 4);
      pyramid.rotateY(Math.PI / 4);
      const mesh = new THREE.Mesh(pyramid, warm);
      mesh.position.set(cx, baseY + height * 0.47, cz);
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(span * 0.72, height * 0.08, span * 0.72), dark);
      plinth.position.set(cx, baseY + height * 0.045, cz);
      const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.18, Math.max(3.5, height * 0.13), 5), dark);
      antenna.position.set(cx, baseY + height + Math.max(1.6, height * 0.065), cz);
      group.add(mesh, plinth, antenna);
      this.geometryCache.push(pyramid, plinth.geometry, antenna.geometry, warm, dark);
    } else if (kind === 'coit') {
      const span = Math.max(width, depth);
      const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(span * 0.52, span * 0.68, height * 0.12, 10), terracotta);
      shoulder.position.set(cx, baseY + height * 0.06, cz);
      const shaft = new THREE.CylinderGeometry(span * 0.2, span * 0.3, height * 0.72, 12);
      const shaftMesh = new THREE.Mesh(shaft, base);
      shaftMesh.position.set(cx, baseY + height * 0.48, cz);
      const cap = new THREE.CylinderGeometry(span * 0.08, span * 0.2, height * 0.18, 12);
      const capMesh = new THREE.Mesh(cap, dark);
      capMesh.position.set(cx, baseY + height * 0.9, cz);
      group.add(shoulder, shaftMesh, capMesh);
      this.geometryCache.push(shoulder.geometry, shaft, cap, base, dark, terracotta);
    } else if (kind === 'ferry') {
      const hall = new THREE.BoxGeometry(width, height * 0.72, depth);
      hall.translate(cx, baseY + height * 0.36, cz);
      const hallMesh = new THREE.Mesh(hall, warm);
      const towerWidth = Math.min(width * 0.2, 10);
      const towerDepth = Math.min(depth * 0.2, 10);
      const tower = new THREE.BoxGeometry(towerWidth, height, towerDepth);
      tower.translate(cx, baseY + height / 2, cz);
      const towerMesh = new THREE.Mesh(tower, base);
      const roof = new THREE.ConeGeometry(Math.max(towerWidth, towerDepth) * 0.82, Math.max(5.2, height * 0.12), 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(cx, baseY + height + Math.max(2.3, height * 0.055), cz);
      const roofMesh = new THREE.Mesh(roof, dark);
      const clock = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(2.8, towerWidth * 0.42), Math.min(2.8, towerWidth * 0.42), 0.16, 16), slate);
      clock.rotation.x = Math.PI / 2;
      clock.position.set(cx, baseY + height * 0.66, cz - towerDepth * 0.52);
      group.add(hallMesh, towerMesh, roofMesh, clock);
      this.geometryCache.push(hall, tower, roof, clock.geometry, warm, base, dark, slate);
    } else if (kind === 'salesforce') {
      const taper = new THREE.CylinderGeometry(Math.max(width, depth) * 0.3, Math.max(width, depth) * 0.55, height, 4);
      taper.rotateY(Math.PI / 4);
      const mesh = new THREE.Mesh(taper, glass);
      mesh.position.set(cx, baseY + height / 2, cz);
      const crown = new THREE.BoxGeometry(Math.max(width, depth) * 0.34, height * 0.03, Math.max(width, depth) * 0.34);
      crown.translate(cx, baseY + height * 0.99, cz);
      const crownMesh = new THREE.Mesh(crown, dark);
      group.add(mesh, crownMesh);
      this.geometryCache.push(taper, crown, glass, dark);
    } else if (kind === 'city-hall') {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.55, depth), warm);
      wing.position.set(cx, baseY + height * 0.275, cz);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(Math.max(width, depth) * 0.28, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), slate);
      dome.position.set(cx, baseY + height * 0.72, cz);
      const lantern = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(width, depth) * 0.08, Math.max(width, depth) * 0.11, height * 0.2, 8), dark);
      lantern.position.set(cx, baseY + height * 0.9, cz);
      group.add(wing, dome, lantern);
      this.geometryCache.push(wing.geometry, dome.geometry, lantern.geometry, warm, slate, dark);
    } else if (kind === 'palace') {
      const hall = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.32, depth), warm);
      hall.position.set(cx, baseY + height * 0.16, cz);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(Math.max(width, depth) * 0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), base);
      dome.position.set(cx, baseY + height * 0.37, cz);
      const colCount = Math.min(8, Math.max(4, Math.round(width / 4)));
      const colGeometry = new THREE.CylinderGeometry(0.22, 0.28, height * 0.42, 6);
      for (let i = 0; i < colCount; i += 1) {
        const x = minX + (width * (i + 0.5)) / colCount;
        const col = new THREE.Mesh(colGeometry, base);
        col.position.set(x, baseY + height * 0.21, minZ - depth * 0.18);
        group.add(col);
      }
      group.add(hall, dome);
      this.geometryCache.push(hall.geometry, dome.geometry, colGeometry, warm, base);
    } else if (kind === 'mission-dolores') {
      const nave = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.62, depth), warm);
      nave.position.set(cx, baseY + height * 0.31, cz);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(width, depth) * 0.5, height * 0.22, 4), terracotta);
      roof.rotation.y = Math.PI / 4;
      roof.position.set(cx, baseY + height * 0.73, cz);
      const bellGeometry = new THREE.CylinderGeometry(Math.max(width, depth) * 0.13, Math.max(width, depth) * 0.17, height * 0.7, 6);
      const leftBell = new THREE.Mesh(bellGeometry, base);
      const rightBell = new THREE.Mesh(bellGeometry, base);
      leftBell.position.set(cx - width * 0.31, baseY + height * 0.35, cz);
      rightBell.position.set(cx + width * 0.31, baseY + height * 0.35, cz);
      group.add(nave, roof, leftBell, rightBell);
      this.geometryCache.push(nave.geometry, roof.geometry, bellGeometry, warm, terracotta, base);
    } else if (kind === 'cathedral') {
      const nave = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.56, depth), slate);
      nave.position.set(cx, baseY + height * 0.28, cz);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(width, depth) * 0.56, height * 0.24, 4), dark);
      roof.rotation.y = Math.PI / 4;
      roof.position.set(cx, baseY + height * 0.68, cz);
      const spireGeometry = new THREE.ConeGeometry(Math.max(width, depth) * 0.1, height * 0.5, 4);
      const leftSpire = new THREE.Mesh(spireGeometry, slate);
      const rightSpire = new THREE.Mesh(spireGeometry, slate);
      leftSpire.position.set(cx - width * 0.28, baseY + height * 0.56, cz);
      rightSpire.position.set(cx + width * 0.28, baseY + height * 0.56, cz);
      group.add(nave, roof, leftSpire, rightSpire);
      this.geometryCache.push(nave.geometry, roof.geometry, spireGeometry, slate, dark);
    } else if (kind === 'sfmoma' || kind === 'warfield' || kind === 'yerba') {
      const hall = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.72, depth), kind === 'warfield' ? terracotta : warm);
      hall.position.set(cx, baseY + height * 0.36, cz);
      const crown = new THREE.Mesh(new THREE.BoxGeometry(width * 0.74, height * 0.22, depth * 0.74), kind === 'sfmoma' ? glass : slate);
      crown.position.set(cx, baseY + height * 0.83, cz);
      group.add(hall, crown);
      this.geometryCache.push(hall.geometry, crown.geometry, warm, terracotta, glass, slate);
    } else {
      const box = new THREE.BoxGeometry(width, height, depth);
      box.translate(cx, baseY + height / 2, cz);
      const mesh = new THREE.Mesh(box, base);
      group.add(mesh);
      this.geometryCache.push(box, base);
    }
    group.userData = { kind: 'building', id: building.id, buildingId: building.id };
    group.position.y = 0;
    root.add(group);
    this.pickables.push(group);
  }

  buildContactShadows(root, city) {
    const alphaTexture = seededTexture(2048, (context, width, height) => {
      drawShadowAlpha(context, width, height);
    }, 64, 64);
    alphaTexture.wrapS = THREE.ClampToEdgeWrapping;
    alphaTexture.wrapT = THREE.ClampToEdgeWrapping;
    const material = new THREE.MeshBasicMaterial({
      color: 0x0d1711,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      alphaMap: alphaTexture,
    });
    this.contactShadowMaterial = material;
    // One merged plane-set replaces one mesh per building (700+ draw calls -> 1).
    const positions = [];
    const uvs = [];
    const normals = [];
    const indices = [];
    for (const building of city.buildings) {
      const points = building.polygon;
      if (points.length < 4) continue;
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minZ = Math.min(...points.map((p) => p.z));
      const maxZ = Math.max(...points.map((p) => p.z));
      if (maxX - minX < 2 || maxZ - minZ < 2) continue;
      const y = this.terrain?.heightAt ? this.terrain.heightAt((minX + maxX) / 2, (minZ + maxZ) / 2) : 0;
      const width = maxX - minX + 2.2;
      const depth = maxZ - minZ + 2.2;
      const baseIndex = positions.length / 3;
      positions.push(
        minX - 1.1, y + 0.052, minZ - 1.1,
        minX - 1.1 + width, y + 0.052, minZ - 1.1,
        minX - 1.1 + width, y + 0.052, minZ - 1.1 + depth,
        minX - 1.1, y + 0.052, minZ - 1.1 + depth,
      );
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      uvs.push(0.04, 0.04, 0.96, 0.04, 0.96, 0.96, 0.04, 0.96);
      indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
    }
    this.geometryCache.push(alphaTexture);
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1;
    mesh.name = 'contact-shadows';
    root.add(mesh);
    this.geometryCache.push(geometry);
  }

  addRoofDetails(root, building, width, depth, height, baseY, minX, minZ, material, random) {
    // Roof props are accumulated into this.roofBatch and flushed once per
    // build so parapets/tanks/cells cost three draw calls total, not one each.
    const batch = this.roofBatch;
    const topY = baseY + height;
    const cx = minX + width / 2;
    const cz = minZ + depth / 2;
    const parapet = new THREE.BoxGeometry(width + 0.5, 0.42, depth + 0.5);
    parapet.translate(cx, topY + 0.14, cz);
    const parapetColor = shade(colorFromHex(PALETTES[material]?.[0] || '#cfc9bb'), -0.2);
    const positionCount = parapet.attributes.position.count;
    const colors = new Float32Array(positionCount * 3);
    for (let i = 0; i < positionCount; i += 1) {
      colors[i * 3] = parapetColor.r;
      colors[i * 3 + 1] = parapetColor.g;
      colors[i * 3 + 2] = parapetColor.b;
    }
    parapet.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    batch.parapets.push(parapet);
    if ((building.type === 'rowhouse' || building.type === 'midrise') && random() < 0.42) {
      const tankR = 0.9 + random() * 0.5;
      const tankH = 1.4 + random() * 0.9;
      const tank = new THREE.CylinderGeometry(tankR * 0.82, tankR, tankH, 8);
      tank.translate(cx + width * (random() - 0.5) * 0.36, topY + 0.28 + tankH / 2, cz + depth * (random() - 0.5) * 0.36);
      batch.tanks.push(tank);
    } else if (building.type === 'tower' && random() < 0.6) {
      const cellH = 2.6 + random() * 2;
      const cell = new THREE.CylinderGeometry(0.5, 0.55, cellH, 6);
      cell.translate(cx + width * 0.22, topY + cellH / 2 + 0.3, cz + depth * 0.18);
      batch.cells.push(cell);
    }
  }

  flushRoofDetails(root) {
    const batch = this.roofBatch;
    this.roofBatch = null;
    if (!batch) return;
    if (batch.parapets.length) {
      const merged = mergeGeometries(batch.parapets, false);
      batch.parapets.length = 0;
      if (merged) {
        merged.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true });
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = true;
        root.add(mesh);
        this.geometryCache.push(merged, material);
      }
    }
    if (batch.tanks.length) {
      const merged = mergeGeometries(batch.tanks, false);
      batch.tanks.length = 0;
      if (merged) {
        merged.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: '#b5725a', roughness: 0.55, metalness: 0.25, flatShading: true });
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = true;
        root.add(mesh);
        this.geometryCache.push(merged, material);
      }
    }
    if (batch.cells.length) {
      const merged = mergeGeometries(batch.cells, false);
      batch.cells.length = 0;
      if (merged) {
        merged.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: '#c4beb4', roughness: 0.5, metalness: 0.5, flatShading: true });
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = true;
        root.add(mesh);
        this.geometryCache.push(merged, material);
      }
    }
  }

  buildRoadNetwork(root, city) {
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const hiddenPathClasses = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'corridor', 'platform']);
    const renderSegments = realMap
      ? city.segments.filter((segment) => !hiddenPathClasses.has(segment.highway))
      : city.segments;
    const crossingAt = (position) => renderSegments.filter((segment) => {
      for (const point of [segment.points[0], segment.points[segment.points.length - 1]]) {
        if (Math.hypot(point.x - position.x, point.z - position.z) < 0.5) return true;
      }
      return false;
    });
    const renderIntersections = city.intersections
      .map((intersection) => ({ intersection, crossing: crossingAt(intersection.position) }))
      .filter((entry) => entry.crossing.length >= 2);
    // Pre-count vertices: 4 per quad, 6 indices per quad.
    const quads = { asphalt: 0, sidewalk: 0, curb: 0, crosswalk: 0 };
    for (const segment of renderSegments) {
      for (let i = 0; i < segment.points.length - 1; i += 1) {
        quads.asphalt += 1;
        if (segment.sidewalkW > 0) {
          quads.sidewalk += 2;
          quads.curb += 2;
        }
      }
    }
    quads.asphalt += renderIntersections.length;
    const asphaltAttrs = lineQuadAttrs(quads.asphalt);
    const sidewalkAttrs = lineQuadAttrs(quads.sidewalk);
    const curbAttrs = lineQuadAttrs(quads.curb);
    // Crosswalk stripe count depends on approach widths, so use a dynamic buffer.
    const crosswalkAttrs = dynQuadAttrs();
    // Merged marking ribbons replace thousands of THREE.Line objects:
    // one draw call for lane dashes, one for edge lines, one for stop bars,
    // and one for sidewalk expansion joints.
    const laneAttrs = dynQuadAttrs();
    const edgeAttrs = dynQuadAttrs();
    const stopAttrs = dynQuadAttrs();
    const jointAttrs = dynQuadAttrs();
    const patchAttrs = dynQuadAttrs();
    const asphaltColors = {
      motorway: new THREE.Color('#5d6570'),
      trunk: new THREE.Color('#626a74'),
      primary: new THREE.Color('#6b737d'),
      secondary: new THREE.Color('#747c84'),
      tertiary: new THREE.Color('#7d848b'),
      residential: new THREE.Color('#858b90'),
      service: new THREE.Color('#8d9294'),
    };
    const sidewalkColor = new THREE.Color('#e2c79a');
    const curbColor = new THREE.Color('#c0936b');
    const crosswalkColor = new THREE.Color('#fff4dc');
    const laneWhite = new THREE.Color('#efe8d4');
    const laneYellow = new THREE.Color('#e6b93f');
    const edgeWhite = new THREE.Color('#f2ead8');
    const jointColor = new THREE.Color('#8d7a5e');
    const patchDark = new THREE.Color('#4c4b48');
    const patchMid = new THREE.Color('#9c8f7d');
    const manholeColor = new THREE.Color('#3a3a38');
    let asphaltVertex = 0;
    let sidewalkVertex = 0;
    let curbVertex = 0;
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.5);
    const curbHeight = Number(city.meta.streetDesign?.curbHeight ?? 0.16);
    const yAt = (x, z, lift = 0.075) => roadLift + lift + (this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0);

    for (const segment of renderSegments) {
      const pts = segment.points;
      for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!Number.isFinite(a.x) || !Number.isFinite(a.z) || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.01) continue;
        const nx = -dz / len;
        const nz = dx / len;
        const half = segment.width / 2;
        const sidewalkHalf = half + segment.sidewalkW;
        const ya = roadLift + (this.terrain?.heightAt ? this.terrain.heightAt(a.x, a.z) : 0);
        const yb = roadLift + (this.terrain?.heightAt ? this.terrain.heightAt(b.x, b.z) : 0);
        const color = asphaltColors[segment.highway] || asphaltColors.residential;
        const c = shade(color, 0);
        const c2 = shade(color, 0.04);
        pushQuad(asphaltAttrs, asphaltVertex,
          { x: a.x + nx * half, y: ya, z: a.z + nz * half },
          { x: b.x + nx * half, y: yb, z: b.z + nz * half },
          { x: b.x - nx * half, y: yb, z: b.z - nz * half },
          { x: a.x - nx * half, y: ya, z: a.z - nz * half },
          c,
        );
        asphaltVertex += 4;
        if (segment.sidewalkW > 0) {
          pushQuad(sidewalkAttrs, sidewalkVertex,
            { x: a.x + nx * sidewalkHalf, y: ya + 0.045, z: a.z + nz * sidewalkHalf },
            { x: b.x + nx * sidewalkHalf, y: yb + 0.045, z: b.z + nz * sidewalkHalf },
            { x: b.x + nx * half, y: yb + 0.045, z: b.z + nz * half },
            { x: a.x + nx * half, y: ya + 0.045, z: a.z + nz * half },
            sidewalkColor,
          );
          sidewalkVertex += 4;
          pushQuad(sidewalkAttrs, sidewalkVertex,
            { x: a.x - nx * half, y: ya + 0.045, z: a.z - nz * half },
            { x: b.x - nx * half, y: yb + 0.045, z: b.z - nz * half },
            { x: b.x - nx * sidewalkHalf, y: yb + 0.045, z: b.z - nz * sidewalkHalf },
            { x: a.x - nx * sidewalkHalf, y: ya + 0.045, z: a.z - nz * sidewalkHalf },
            sidewalkColor,
          );
          sidewalkVertex += 4;
          // Expansion joints: tight dark seams every ~2.8m give sidewalks a
          // paved, walkable texture at street level.
          if (!realMap) {
            const jointStep = 2.8;
            const joints = Math.floor(len / jointStep);
            for (let j = 1; j <= joints; j += 1) {
              const t = j * jointStep / len;
              const jx = a.x + dx * t;
              const jz = a.z + dz * t;
              const jy = yAt(jx, jz, 0.05);
              for (const side of [1, -1]) {
                const inner = { x: jx + nx * half * side, z: jz + nz * half * side };
                const outer = { x: jx + nx * (sidewalkHalf - 0.12) * side, z: jz + nz * (sidewalkHalf - 0.12) * side };
                pushStripDyn(jointAttrs, inner, outer, 0.13, () => jy, jointColor);
              }
            }
          }
          // Curb lips.
          pushQuad(curbAttrs, curbVertex,
            { x: a.x + nx * (half + 0.08), y: ya + 0.045, z: a.z + nz * (half + 0.08) },
            { x: b.x + nx * (half + 0.08), y: yb + 0.045, z: b.z + nz * (half + 0.08) },
            { x: b.x + nx * (half + 0.08), y: yb + curbHeight, z: b.z + nz * (half + 0.08) },
            { x: a.x + nx * (half + 0.08), y: ya + curbHeight, z: a.z + nz * (half + 0.08) },
            curbColor,
          );
          curbVertex += 4;
          pushQuad(curbAttrs, curbVertex,
            { x: a.x - nx * (half + 0.08), y: ya + 0.045, z: a.z - nz * (half + 0.08) },
            { x: b.x - nx * (half + 0.08), y: yb + 0.045, z: b.z - nz * (half + 0.08) },
            { x: b.x - nx * (half + 0.08), y: yb + curbHeight, z: b.z - nz * (half + 0.08) },
            { x: a.x - nx * (half + 0.08), y: ya + curbHeight, z: a.z - nz * (half + 0.08) },
            curbColor,
          );
          curbVertex += 4;
        }
        // Markings.
        if (segment.lanes >= 2 && segment.highway !== 'service') {
          const dash = segment.highway === 'primary' || segment.highway === 'secondary' ? 5.5 : 3.6;
          const dashLen = dash * 0.52;
          const major = segment.highway === 'primary' || segment.highway === 'secondary';
          const laneColor = segment.lanes >= 3 ? laneWhite : laneYellow;
          // Solid double-yellow spine on major avenues.
          if (major && segment.lanes >= 3) {
            const midY = (x, z) => yAt(x, z, 0.075);
            pushStripDyn(laneAttrs, a, b, 0.11, midY, laneYellow);
            pushStripDyn(laneAttrs,
              { x: a.x + nx * 0.28, z: a.z + nz * 0.28 },
              { x: b.x + nx * 0.28, z: b.z + nz * 0.28 },
              0.11, midY, laneYellow);
            // Dashed white lane separators.
            const lanes = Math.max(2, segment.lanes - 2);
            for (let li = 1; li <= lanes; li += 1) {
              const off = (li - (lanes + 1) / 2) * (segment.width / (lanes + 1)) * 0.5;
              const pa = { x: a.x + nx * off, z: a.z + nz * off };
              const pb = { x: b.x + nx * off, z: b.z + nz * off };
              const steps = Math.max(1, Math.floor(len / (dash * 2)));
              for (let s = 0; s < steps; s += 1) {
                const t0 = (s * dash * 2) / len;
                const t1 = Math.min(1, (s * dash * 2 + dashLen) / len);
                pushStripDyn(laneAttrs,
                  { x: pa.x + (pb.x - pa.x) * t0, z: pa.z + (pb.z - pa.z) * t0 },
                  { x: pa.x + (pb.x - pa.x) * t1, z: pa.z + (pb.z - pa.z) * t1 },
                  0.12, (x, z) => yAt(x, z, 0.075), laneWhite);
              }
            }
          } else {
            const steps = Math.max(1, Math.floor(len / dash));
            for (let s = 0; s < steps; s += 1) {
              const t0 = (s * dash) / len;
              const t1 = Math.min(1, (s * dash + dashLen) / len);
              pushStripDyn(laneAttrs,
                { x: a.x + dx * t0, z: a.z + dz * t0 },
                { x: a.x + dx * t1, z: a.z + dz * t1 },
                0.14, (x, z) => yAt(x, z, 0.075), laneColor);
            }
          }
        }
        const edgeWidth = segment.highway === 'primary' || segment.highway === 'secondary' ? 0.14 : 0.1;
        pushStripDyn(edgeAttrs,
          { x: a.x + nx * (half - 0.35), z: a.z + nz * (half - 0.35) },
          { x: b.x + nx * (half - 0.35), z: b.z + nz * (half - 0.35) },
          edgeWidth, (x, z) => yAt(x, z, 0.075), edgeWhite);
        pushStripDyn(edgeAttrs,
          { x: a.x - nx * (half - 0.35), z: a.z - nz * (half - 0.35) },
          { x: b.x - nx * (half - 0.35), z: b.z - nz * (half - 0.35) },
          edgeWidth, (x, z) => yAt(x, z, 0.075), edgeWhite);
        // Parking stall stripes along curbs: short white ticks that break up
        // large asphalt planes at street level.
        if (!realMap && segment.sidewalkW > 0 && segment.highway !== 'motorway') {
          const stallStep = 5.2;
          const stalls = Math.floor(len / stallStep);
          for (let sIdx = 1; sIdx < stalls; sIdx += 1) {
            const t = (sIdx * stallStep) / len;
            const sx = a.x + dx * t;
            const sz = a.z + dz * t;
            const sy = yAt(sx, sz, 0.06);
            for (const side of [1, -1]) {
              const inner = { x: sx + nx * (half - 0.18) * side, z: sz + nz * (half - 0.18) * side };
              const outer = { x: sx + nx * (half - 2.3) * side, z: sz + nz * (half - 2.3) * side };
              pushStripDyn(laneAttrs, inner, outer, 0.14, () => sy, edgeWhite);
            }
          }
        }
        // Tar patches and manholes: dark quads on the asphalt plane give the
        // road surface a worn, detailed read at street level.
        const patchStep = 8;
        const patches = realMap ? 0 : Math.floor(len / patchStep);
        for (let pi = 0; pi < patches; pi += 1) {
          const t = ((pi + 0.5) * patchStep) / len;
          const px = a.x + dx * t;
          const pz = a.z + dz * t;
          const lateral = (((pi * 37) % 7) - 3) * 0.14 * half;
          const cxp = px + nx * lateral;
          const czp = pz + nz * lateral;
          const py = yAt(cxp, czp, 0.045);
          const pw = 1.3 + ((pi * 13) % 5) * 0.34;
          const pd = 0.9 + ((pi * 7) % 4) * 0.26;
          pushQuadDyn(patchAttrs,
            { x: cxp - nx * pw - (dx / len) * pd, y: py, z: czp - nz * pw - (dz / len) * pd },
            { x: cxp + nx * pw - (dx / len) * pd, y: py, z: czp + nz * pw - (dz / len) * pd },
            { x: cxp + nx * pw + (dx / len) * pd, y: py, z: czp + nz * pw + (dz / len) * pd },
            { x: cxp - nx * pw + (dx / len) * pd, y: py, z: czp - nz * pw + (dz / len) * pd },
            pi % 2 === 0 ? patchMid : patchDark,
          );
          if (pi % 4 === 2) {
            const mx = px - nx * lateral * 0.5;
            const mz = pz - nz * lateral * 0.5;
            const my = yAt(mx, mz, 0.05);
            pushQuadDyn(patchAttrs,
              { x: mx - 0.45, y: my, z: mz - 0.45 },
              { x: mx + 0.45, y: my, z: mz - 0.45 },
              { x: mx + 0.45, y: my, z: mz + 0.45 },
              { x: mx - 0.45, y: my, z: mz + 0.45 },
              manholeColor,
            );
          }
        }
      }
    }

    // Asphalt patches close the gaps where streets cross.
    for (const { intersection, crossing } of renderIntersections) {
      const p = intersection.position;
      const half = Math.max(1.2, ...crossing.map((s) => s.width / 2 + Math.min(0.5, s.sidewalkW)));
      if (!Number.isFinite(half)) continue;
      const y = roadLift + (this.terrain?.heightAt ? this.terrain.heightAt(p.x, p.z) : 0);
      pushQuad(asphaltAttrs, asphaltVertex,
        { x: p.x - half, y, z: p.z - half },
        { x: p.x + half, y, z: p.z - half },
        { x: p.x + half, y, z: p.z + half },
        { x: p.x - half, y, z: p.z + half },
        new THREE.Color('#5d5c5a'),
      );
      asphaltVertex += 4;
    }

    // Crosswalks at intersections.
    for (const { intersection, crossing } of renderIntersections) {
      const p = intersection.position;
      const half = Math.max(1.2, ...crossing.map((s) => s.width / 2 + Math.min(0.5, s.sidewalkW)));
      // Zebra crosswalks: one striped band per approach, stripes parallel to
      // the road axis so they read as paint from street level.
      const approaches = [];
      for (const segment of crossing) {
        const other = segment.points.find((pt) => Math.hypot(pt.x - p.x, pt.z - p.z) >= 0.5) || segment.points[0];
        const adx = other.x - p.x;
        const adz = other.z - p.z;
        const alen = Math.hypot(adx, adz) || 1;
        approaches.push({
          ux: adx / alen,
          uz: adz / alen,
          roadHalf: segment.width / 2,
        });
      }
      const bands = approaches.length ? approaches : [
        { ux: 1, uz: 0, roadHalf: half },
        { ux: -1, uz: 0, roadHalf: half },
        { ux: 0, uz: 1, roadHalf: half },
        { ux: 0, uz: -1, roadHalf: half },
      ];
      for (const approach of bands) {
        const bandCenter = 3.1;
        const stripePitch = 0.78;
        const stripes = Math.max(2, Math.floor((approach.roadHalf * 2) / stripePitch));
        const px = -approach.uz;
        const pz = approach.ux;
        for (let i = 0; i < stripes; i += 1) {
          const off = (i - (stripes - 1) / 2) * stripePitch;
          const cx = p.x + approach.ux * bandCenter + px * off;
          const cz = p.z + approach.uz * bandCenter + pz * off;
          const stripeHalf = stripePitch * 0.3;
          const alongHalf = 0.95;
          pushQuadDyn(crosswalkAttrs,
            { x: cx - px * stripeHalf - approach.ux * alongHalf, y: yAt(cx, cz, 0.03), z: cz - pz * stripeHalf - approach.uz * alongHalf },
            { x: cx - px * stripeHalf + approach.ux * alongHalf, y: yAt(cx, cz, 0.03), z: cz - pz * stripeHalf + approach.uz * alongHalf },
            { x: cx + px * stripeHalf + approach.ux * alongHalf, y: yAt(cx, cz, 0.03), z: cz + pz * stripeHalf + approach.uz * alongHalf },
            { x: cx + px * stripeHalf - approach.ux * alongHalf, y: yAt(cx, cz, 0.03), z: cz + pz * stripeHalf - approach.uz * alongHalf },
            crosswalkColor,
          );
        }
        // Stop bar just behind the band.
        const barCenter = bandCenter + 1.5;
        const bx = p.x + approach.ux * barCenter;
        const bz = p.z + approach.uz * barCenter;
        pushQuadDyn(stopAttrs,
          { x: bx - px * approach.roadHalf - approach.ux * 0.2, y: yAt(bx, bz, 0.02), z: bz - pz * approach.roadHalf - approach.uz * 0.2 },
          { x: bx + px * approach.roadHalf - approach.ux * 0.2, y: yAt(bx, bz, 0.02), z: bz + pz * approach.roadHalf - approach.uz * 0.2 },
          { x: bx + px * approach.roadHalf + approach.ux * 0.2, y: yAt(bx, bz, 0.02), z: bz + pz * approach.roadHalf + approach.uz * 0.2 },
          { x: bx - px * approach.roadHalf + approach.ux * 0.2, y: yAt(bx, bz, 0.02), z: bz - pz * approach.roadHalf + approach.uz * 0.2 },
          new THREE.Color('#f4f0e2'),
        );
      }
    }

    finalizeAttrs(asphaltAttrs, asphaltVertex);
    finalizeAttrs(sidewalkAttrs, sidewalkVertex);
    finalizeAttrs(curbAttrs, curbVertex);

    const asphaltMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      flatShading: true,
    });
    const asphaltMesh = new THREE.Mesh(buildAttrGeometry(asphaltAttrs), asphaltMaterial);
    asphaltMesh.receiveShadow = true;
    asphaltMesh.userData = { kind: 'roads', roads: 'all' };
    root.add(asphaltMesh);
    this.pickables.push(asphaltMesh);

    const sidewalkMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0,
      flatShading: true,
    });
    const sidewalkMesh = new THREE.Mesh(buildAttrGeometry(sidewalkAttrs), sidewalkMaterial);
    sidewalkMesh.receiveShadow = true;
    sidewalkMesh.userData = { kind: 'sidewalks' };
    root.add(sidewalkMesh);
    this.pickables.push(sidewalkMesh);

    const curbMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.8,
      flatShading: true,
    });
    const curbMesh = new THREE.Mesh(buildAttrGeometry(curbAttrs), curbMaterial);
    curbMesh.receiveShadow = true;
    root.add(curbMesh);

    const crosswalkMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      flatShading: true,
    });
    const crosswalkMesh = new THREE.Mesh(buildDynGeometry(crosswalkAttrs), crosswalkMaterial);
    crosswalkMesh.renderOrder = 2;
    root.add(crosswalkMesh);

    // Merged marking ribbons: lane dashes, edge lines, stop bars, joints.
    const markingMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0,
      flatShading: true,
    });
    const jointMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    });
    const laneMesh = new THREE.Mesh(buildDynGeometry(laneAttrs), markingMaterial);
    const edgeMesh = new THREE.Mesh(buildDynGeometry(edgeAttrs), markingMaterial);
    const stopMesh = new THREE.Mesh(buildDynGeometry(stopAttrs), markingMaterial);
    const jointMesh = new THREE.Mesh(buildDynGeometry(jointAttrs), jointMaterial);
    const patchMesh = new THREE.Mesh(buildDynGeometry(patchAttrs), jointMaterial);
    for (const mesh of [laneMesh, edgeMesh, stopMesh, jointMesh, patchMesh]) {
      mesh.renderOrder = 2;
      mesh.receiveShadow = true;
      root.add(mesh);
      this.geometryCache.push(mesh.geometry);
    }
    this.geometryCache.push(laneMesh.material, jointMesh.material, crosswalkMaterial, markingMaterial);

    // Keep pickable geometry references for click metadata.
    this.roadMeshes = { asphalt: asphaltMesh, sidewalk: sidewalkMesh, curbs: curbMesh, crosswalks: crosswalkMesh, markings: laneMesh };
  }

  buildSignals(root, city) {
    this.signalMeshes = [];
    const lampGeometry = new THREE.SphereGeometry(0.16, 8, 6);
    this.geometryCache.push(lampGeometry);
    this.buildStreetLamps(root, city);
    for (const signal of city.signals) {
      const group = new THREE.Group();
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.12, 4.1, 6),
        new THREE.MeshStandardMaterial({ color: 0x3c454b, roughness: 0.55, metalness: 0.45 }),
      );
      pole.position.y = 2.05;
      group.add(pole);
      const housing = new THREE.Mesh(
        new THREE.BoxGeometry(0.62, 1.5, 0.42),
        new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.45, metalness: 0.4 }),
      );
      housing.position.y = 3.7;
      group.add(housing);
      const lampMaterials = [
        new THREE.MeshStandardMaterial({ color: 0x2b2f33, emissive: 0x000000, emissiveIntensity: 0 }),
        new THREE.MeshStandardMaterial({ color: 0x2b2f33, emissive: 0x000000, emissiveIntensity: 0 }),
        new THREE.MeshStandardMaterial({ color: 0x2b2f33, emissive: 0x000000, emissiveIntensity: 0 }),
      ];
      const positions = [3.18, 3.62, 4.06];
      for (let i = 0; i < 3; i += 1) {
        const lamp = new THREE.Mesh(lampGeometry, lampMaterials[i]);
        lamp.position.set(0, positions[i], 0.24);
        group.add(lamp);
      }
      group.position.set(signal.position.x, 0, signal.position.z);
      group.userData = { kind: 'signal', id: signal.id, signalId: signal.id };
      root.add(group);
      this.pickables.push(group);
      this.signalMeshes.push({ group, signal, lampMaterials });
      this.geometryCache.push(pole.geometry, housing.geometry);
      for (const material of lampMaterials) this.geometryCache.push(material);
    }
  }

  buildStreetLamps(root, city) {
    const poleGeometry = new THREE.CylinderGeometry(0.07, 0.1, 5.4, 6);
    const bulbGeometry = new THREE.SphereGeometry(0.22, 8, 6);
    const poleMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a434a,
      roughness: 0.55,
      metalness: 0.5,
    });
    const bulbMaterial = new THREE.MeshStandardMaterial({
      color: 0xffe9b8,
      emissive: 0xffcf7a,
      emissiveIntensity: 0.16,
      roughness: 0.4,
    });
    this.geometryCache.push(poleGeometry, bulbGeometry);
    const maxLamps = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap' ? 240 : 900;
    const placement = collectStreetLampRecords(city, { maxLamps });
    this.streetLampRecords = placement.records;
    this.streetLampDiagnostics = {
      source: city.meta.generator || null,
      maxLamps,
      ...placement.diagnostics,
      pointLightPoolSize: 0,
    };
    const group = new THREE.Group();
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.5);
    for (const record of this.streetLampRecords) {
      const { x, z } = record;
      const pole = new THREE.Mesh(poleGeometry, poleMaterial);
      pole.position.y = 2.7;
      const bulb = new THREE.Mesh(bulbGeometry, bulbMaterial);
      bulb.position.y = 5.5;
      const lamp = new THREE.Group();
      lamp.add(pole, bulb);
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0) + roadLift + 0.04;
      lamp.position.set(x, y, z);
      lamp.rotation.y = record.rotation;
      lamp.userData = {
        kind: 'street-lamp',
        source: 'segment-polyline',
        segmentId: record.segmentId,
        streetId: record.streetId,
        side: record.side,
      };
      group.add(lamp);
      this.lampBulbs.push(bulb);
      this.localLightCandidates.push({
        x,
        y: y + 4.8,
        z,
        color: 0xffc46a,
        intensity: 0.72,
        distance: 28,
        decay: 2.1,
      });
    }
    group.name = 'street-lamps';
    root.add(group);
  }

  installLocalLightPool(root) {
    // WebGPU currently evaluates every PointLight against the scene. Keep all
    // authored emissive fixtures, but reserve real illumination for a small
    // camera-local pool so city density does not multiply frame cost.
    const poolSize = Math.min(3, this.localLightCandidates.length);
    const group = new THREE.Group();
    group.name = 'local-light-pool';
    for (let i = 0; i < poolSize; i += 1) {
      const light = new THREE.PointLight(0xffffff, 0, 28, 2);
      light.name = `local-night-light-${i + 1}`;
      // Keep the three-light layout resident across day/night transitions so
      // WebGPU does not rebuild the lighting pipeline when dusk begins.
      light.visible = true;
      group.add(light);
      this.localLightPool.push(light);
    }
    root.add(group);
    // Preserve the public diagnostics aliases while all local sources share
    // one bounded pool.
    this.lampLights = this.localLightPool;
    this.lightPools = this.localLightPool;
    if (this.streetLampDiagnostics) {
      this.streetLampDiagnostics.pointLightPoolSize = this.localLightPool.length;
    }
  }

  updateLocalLightPool(delta, force = false) {
    if (!this.localLightPool.length) return;
    if (!this.localLightsNight) {
      for (const light of this.localLightPool) {
        light.intensity = 0;
        light.visible = true;
      }
      return;
    }
    this.localLightUpdateClock += delta;
    if (!force && this.localLightUpdateClock < 0.25) return;
    this.localLightUpdateClock = 0;
    const camera = this.camera.position;
    const nearest = this.localLightCandidates
      .map((candidate) => ({
        candidate,
        distanceSq: (candidate.x - camera.x) ** 2 + (candidate.z - camera.z) ** 2,
      }))
      .sort((a, b) => a.distanceSq - b.distanceSq)
      .slice(0, this.localLightPool.length);
    for (let i = 0; i < this.localLightPool.length; i += 1) {
      const light = this.localLightPool[i];
      const candidate = nearest[i]?.candidate;
      if (!candidate) {
        light.intensity = 0;
        light.visible = true;
        continue;
      }
      light.position.set(candidate.x, candidate.y, candidate.z);
      light.color.set(candidate.color);
      light.distance = candidate.distance;
      light.decay = candidate.decay;
      light.intensity = candidate.intensity;
      light.visible = true;
    }
  }

  buildStreetNeonTrim(root, city) {
    if (city.meta.generator !== 'procedural') return;
    const bounds = city.meta.bounds;
    const colors = ['#ff5fa2', '#35d7d7', '#ffc43d', '#8dff5f', '#c08fff', '#ff7a45'];
    const trim = [];
    const random = mulberry32(Number(city.meta.seedInt || 1) + 2201);
    for (const street of city.streets) {
      if (street.highway !== 'primary' && street.highway !== 'secondary') continue;
      if (trim.length >= 120) break;
      const axis = street.axis;
      const position = street.position;
      const rangeStart = bounds[axis === 'x' ? 'minZ' : 'minX'] + 24;
      const rangeEnd = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 24;
      const length = rangeEnd - rangeStart;
      if (length < 40) continue;
      for (const side of [-1, 1]) {
        const offset = position + side * (street.asphaltWidth / 2 + street.sidewalkW + 0.5);
        const x = axis === 'x' ? offset : rangeStart + length / 2;
        const z = axis === 'z' ? offset : rangeStart + length / 2;
        trim.push({
          x,
          z,
          axis,
          length,
          color: colors[Math.floor(random() * colors.length)],
        });
        if (trim.length >= 120) break;
      }
    }
    if (!trim.length) return;
    const geometry = new THREE.BoxGeometry(1, 0.14, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
      fog: false,
      depthWrite: false,
    });
    material.userData = { dayOpacity: 0.16, nightOpacity: 0.92 };
    this.neonGlowMaterials.push(material);
    const strips = new THREE.InstancedMesh(geometry, material, trim.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let i = 0; i < trim.length; i += 1) {
      const entry = trim[i];
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(entry.x, entry.z) : 0) + 0.12;
      dummy.position.set(entry.x, y, entry.z);
      dummy.rotation.set(0, entry.axis === 'x' ? 0 : 0, 0);
      dummy.scale.set(entry.axis === 'x' ? 0.16 : entry.length, 1, entry.axis === 'x' ? entry.length : 0.16);
      dummy.updateMatrix();
      strips.setMatrixAt(i, dummy.matrix);
      color.set(entry.color);
      strips.setColorAt(i, color);
    }
    strips.instanceMatrix.needsUpdate = true;
    if (strips.instanceColor) strips.instanceColor.needsUpdate = true;
    root.add(strips);
    this.geometryCache.push(geometry);
  }

  buildStreetBunting(root, city) {
    // Authored festival flags suit the procedural showcase but look like
    // floating signs when projected onto arbitrary OSM curb geometry.
    if (city.meta.generator !== 'procedural') return;
    const bounds = city.meta.bounds;
    const colors = ['#e5484d', '#12a594', '#ffb224', '#30a46c', '#8e4ec6', '#ff5c8a', '#f2c14e'];
    const flags = [];
    const random = mulberry32(Number(city.meta.seedInt || 1) + 3301);
    const classes = new Set(['primary', 'secondary']);
    if (city.meta.generator === 'procedural') {
      for (const street of city.streets) {
        if (!classes.has(street.highway)) continue;
        if (flags.length >= 320) break;
        const axis = street.axis;
        const position = street.position;
        const start = bounds[axis === 'x' ? 'minZ' : 'minX'] + 26;
        const end = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 26;
        for (let v = start; v < end; v += 3.6 + random() * 2.4) {
          if (flags.length >= 320) break;
          if (random() < 0.18) continue;
          const side = random() < 0.5 ? -1 : 1;
          const x = axis === 'x' ? position + side * (street.asphaltWidth / 2 + street.sidewalkW + 1.1) : v;
          const z = axis === 'z' ? position + side * (street.asphaltWidth / 2 + street.sidewalkW + 1.1) : v;
          if (Math.abs(x) > bounds.maxX - 4 || Math.abs(z) > bounds.maxZ - 4) continue;
          flags.push({
            x,
            z,
            axis,
            runId: street.id,
            color: colors[Math.floor(random() * colors.length)],
          });
        }
      }
    } else {
      for (const segment of city.segments || []) {
        if (flags.length >= 480) break;
        if (!['primary', 'secondary', 'tertiary'].includes(segment.highway)) continue;
        const a = segment.points[0];
        const b = segment.points[segment.points.length - 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 36 || length > 420) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const count = Math.min(10, Math.max(4, Math.round(length / 14)));
        for (let i = 0; i < count; i += 1) {
          if (flags.length >= 480) break;
          if (random() < 0.1) continue;
          const t = (i + 0.5) / count;
          const side = (i % 2 === 0 ? 1 : -1);
          const offset = segment.width / 2 + segment.sidewalkW * 0.5;
          const x = a.x + dx * t + nx * offset * side;
          const z = a.z + dz * t + nz * offset * side;
          flags.push({
            x,
            z,
            axis: Math.abs(dx) > Math.abs(dz) ? 'x' : 'z',
            runId: segment.streetId,
            color: colors[Math.floor(random() * colors.length)],
          });
        }
      }
    }
    if (!flags.length) return;
    this.streetFurniture.bunting = flags.length;
    // Sagging festival wires connect flags into continuous street decor.
    const wirePoints = [];
    const sortedFlags = [...flags].sort((a, b) => {
      if (a.runId !== b.runId) return String(a.runId).localeCompare(String(b.runId));
      if (a.axis !== b.axis) return a.axis === 'x' ? -1 : 1;
      return a.axis === 'x' ? a.z - b.z : a.x - b.x;
    });
    for (let i = 1; i < sortedFlags.length; i += 1) {
      const a = sortedFlags[i - 1];
      const b = sortedFlags[i];
      if (a.runId !== b.runId || a.axis !== b.axis) continue;
      const dist = a.axis === 'x' ? Math.abs(b.z - a.z) : Math.abs(b.x - a.x);
      if (dist < 1.2 || dist > 7) continue;
      const midX = (a.x + b.x) / 2;
      const midZ = (a.z + b.z) / 2;
      const y1 = (this.terrain?.heightAt ? this.terrain.heightAt(a.x, a.z) : 0) + 3.45;
      const y2 = (this.terrain?.heightAt ? this.terrain.heightAt(b.x, b.z) : 0) + 3.45;
      const sagY = (y1 + y2) / 2 - 0.55;
      wirePoints.push(a.x, y1, a.z, midX, sagY, midZ);
      wirePoints.push(midX, sagY, midZ, b.x, y2, b.z);
    }
    if (wirePoints.length && city.meta.generator === 'openstreetmap') {
      const wireGeometry = new THREE.BufferGeometry();
      wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wirePoints, 3));
      const wireMaterial = new THREE.LineBasicMaterial({ color: 0x6b4a3a, transparent: true, opacity: 0.55 });
      root.add(new THREE.LineSegments(wireGeometry, wireMaterial));
      this.geometryCache.push(wireGeometry, wireMaterial);
    }
    const geometry = new THREE.BoxGeometry(0.72, 0.5, 0.05);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.7,
      flatShading: true,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, flags.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let i = 0; i < flags.length; i += 1) {
      const flag = flags[i];
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(flag.x, flag.z) : 0) + 3.35;
      dummy.position.set(flag.x, y, flag.z);
      dummy.rotation.set(0, flag.axis === 'x' ? Math.PI / 2 : 0, 0);
      dummy.scale.set(1.7, 1.7, 1.7);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.set(flag.color);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    root.add(mesh);
    this.geometryCache.push(geometry);
  }

  buildUtilityLines(root, city) {
    // Utility poles are a generic-city cue. SF streets receive purpose-built
    // transit wire runs below; skipping the old utility arm forest keeps a
    // single foreground pole from owning the hero composition.
    if (city.meta.generator === 'procedural' || isSanFranciscoCity(city)) return;
    const bounds = city.meta.bounds;
    const random = mulberry32(Number(city.meta.seedInt || 1) + 881);
    const poles = [];
    const wirePoints = [];
    const connectWire = (prev, cur) => {
      const dist = Math.hypot(cur.x - prev.x, cur.z - prev.z);
      if (dist > 95) return;
      const y1 = (this.terrain?.heightAt ? this.terrain.heightAt(prev.x, prev.z) : 0) + 5.6;
      const y2 = (this.terrain?.heightAt ? this.terrain.heightAt(cur.x, cur.z) : 0) + 5.6;
      const midX = (prev.x + cur.x) / 2;
      const midZ = (prev.z + cur.z) / 2;
      const sagY = (y1 + y2) / 2 - 0.8;
      wirePoints.push(prev.x, y1, prev.z, midX, sagY, midZ);
      wirePoints.push(midX, sagY, midZ, cur.x, y2, cur.z);
    };
    if (city.meta.generator === 'procedural') {
      for (const street of city.streets) {
        if (street.highway !== 'primary' && street.highway !== 'secondary') continue;
        if (poles.length >= 36) break;
        const axis = street.axis;
        const position = street.position;
        const start = bounds[axis === 'x' ? 'minZ' : 'minX'] + 20;
        const end = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 20;
        let prev = null;
        for (let v = start; v < end; v += 70 + random() * 40) {
          if (poles.length >= 36) break;
          const side = random() < 0.5 ? -1 : 1;
          const x = axis === 'x' ? position + side * (street.asphaltWidth / 2 + street.sidewalkW + 0.8) : v;
          const z = axis === 'z' ? position + side * (street.asphaltWidth / 2 + street.sidewalkW + 0.8) : v;
          if (Math.abs(x) > bounds.maxX - 3 || Math.abs(z) > bounds.maxZ - 3) continue;
          poles.push({ x, z });
          if (prev) connectWire(prev, { x, z });
          prev = { x, z };
        }
      }
    } else {
      // Real maps: follow road polylines and drop poles along the curbside.
      const eligible = new Set(['primary', 'secondary', 'tertiary']);
      const maxPoles = 32;
      const seenStreets = new Set();
      for (const segment of city.segments || []) {
        if (poles.length >= maxPoles) break;
        if (!eligible.has(segment.highway)) continue;
        const length = polylineLength(segment.points);
        if (length < 46 || length > 520) continue;
        // One pole run per named street keeps the pattern legible.
        if (seenStreets.has(segment.streetId)) continue;
        seenStreets.add(segment.streetId);
        const side = random() < 0.5 ? -1 : 1;
        const spacing = 46 + random() * 22;
        const steps = Math.max(2, Math.floor(length / spacing));
        let prev = null;
        for (let s = 0; s <= steps; s += 1) {
          if (poles.length >= maxPoles) break;
          const t = s / steps;
          const point = pointAlongPolyline(segment.points, t * length);
          const offset = segment.width / 2 + segment.sidewalkW + 0.9;
          const x = point.x + point.nx * offset * side;
          const z = point.z + point.nz * offset * side;
          if (x < bounds.minX + 2 || x > bounds.maxX - 2 || z < bounds.minZ + 2 || z > bounds.maxZ - 2) continue;
          poles.push({ x, z, heading: Math.atan2(point.tx, point.tz) });
          if (prev) connectWire(prev, { x, z });
          prev = { x, z };
        }
      }
    }
    if (!poles.length && !wirePoints.length) return;
    if (poles.length) {
      const poleGeometry = new THREE.CylinderGeometry(0.07, 0.1, 6.6, 5);
      const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x6b513c, roughness: 0.8, flatShading: true });
      const armGeometry = new THREE.BoxGeometry(0.72, 0.06, 0.09);
      const armMaterial = new THREE.MeshStandardMaterial({ color: 0x5a4434, roughness: 0.85, flatShading: true });
      const instanced = new THREE.InstancedMesh(poleGeometry, poleMaterial, poles.length);
      const arms = new THREE.InstancedMesh(armGeometry, armMaterial, poles.length);
      const dummy = new THREE.Object3D();
      for (let i = 0; i < poles.length; i += 1) {
        const pole = poles[i];
        dummy.position.set(pole.x, (this.terrain?.heightAt ? this.terrain.heightAt(pole.x, pole.z) : 0) + 3.3, pole.z);
        dummy.rotation.set(0, pole.heading || 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        instanced.setMatrixAt(i, dummy.matrix);
        dummy.position.y = (this.terrain?.heightAt ? this.terrain.heightAt(pole.x, pole.z) : 0) + 5.45;
        dummy.updateMatrix();
        arms.setMatrixAt(i, dummy.matrix);
      }
      instanced.instanceMatrix.needsUpdate = true;
      arms.instanceMatrix.needsUpdate = true;
      instanced.castShadow = true;
      root.add(instanced, arms);
      this.geometryCache.push(poleGeometry, poleMaterial, armGeometry, armMaterial);
    }
    if (wirePoints.length && city.meta.generator === 'openstreetmap') {
      const wireGeometry = new THREE.BufferGeometry();
      wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wirePoints, 3));
      const wireMaterial = new THREE.LineBasicMaterial({ color: 0x3d3028, transparent: true, opacity: 0.32 });
      root.add(new THREE.LineSegments(wireGeometry, wireMaterial));
      this.geometryCache.push(wireGeometry, wireMaterial);
    }
  }

  buildTransitCues(root, city) {
    if (!isSanFranciscoCity(city)) return;
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.45);
    const cablePattern = /california|powell|hyde|mason|cable\s*car/i;
    const trolleyPattern = /market|geary|church|judah|van\s*ness|king|third|3rd|mission|embarcadero|stockton/i;
    const routes = [];
    const seen = new Set();
    for (const segment of city.segments || []) {
      if (!segment.points || segment.points.length < 2) continue;
      if (['motorway', 'trunk', 'footway', 'cycleway', 'pedestrian', 'steps'].includes(segment.highway)) continue;
      const name = String(segment.streetName || segment.name || '');
      const cable = cablePattern.test(name);
      const trolley = cable || trolleyPattern.test(name);
      if (!trolley) continue;
      const key = `${segment.streetId || segment.id}-${segment.points[0].x.toFixed(1)}-${segment.points[0].z.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ segment, cable });
      if (routes.length >= 40) break;
    }
    if (!routes.length) return;

    const railAttrs = dynQuadAttrs();
    const tieAttrs = dynQuadAttrs();
    const railColor = new THREE.Color('#747b7b');
    const tieColor = new THREE.Color('#a49782');
    let tieCount = 0;
    const wirePoints = [];
    const supportPositions = new Map();
    const heightAt = (x, z) => this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0;
    const yAtRail = (x, z) => heightAt(x, z) + roadLift + 0.105;
    const addTrackSegment = (segment, cable) => {
      const points = segment.points;
      const offset = cable
        ? clamp(segment.width * 0.24, 1.05, 1.42)
        : clamp(segment.width * 0.2, 1.05, 1.62);
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 5) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const leftA = { x: a.x + nx * offset, z: a.z + nz * offset };
        const leftB = { x: b.x + nx * offset, z: b.z + nz * offset };
        const rightA = { x: a.x - nx * offset, z: a.z - nz * offset };
        const rightB = { x: b.x - nx * offset, z: b.z - nz * offset };
        pushStripDyn(railAttrs, leftA, leftB, 0.055, yAtRail, railColor);
        pushStripDyn(railAttrs, rightA, rightB, 0.055, yAtRail, railColor);
        const ties = Math.min(14, Math.max(2, Math.floor(length / 6.5)));
        for (let tieIndex = 1; tieIndex < ties; tieIndex += 1) {
          if (tieCount >= 360) break;
          const t = tieIndex / ties;
          const cx = a.x + dx * t;
          const cz = a.z + dz * t;
          const near = { x: cx + nx * (offset + 0.2), z: cz + nz * (offset + 0.2) };
          const far = { x: cx - nx * (offset + 0.2), z: cz - nz * (offset + 0.2) };
          pushStripDyn(tieAttrs, near, far, 0.045, yAtRail, tieColor);
          tieCount += 1;
          if (tieIndex % 5 === 0) {
            const key = `${Math.round(cx / 12)}:${Math.round(cz / 12)}`;
            if (!supportPositions.has(key) && supportPositions.size < 20) {
              supportPositions.set(key, { x: cx + nx * (offset + 2.1), z: cz + nz * (offset + 2.1) });
            }
          }
        }
        const wireOffsets = [0];
        for (const wireOffset of wireOffsets) {
          const wa = { x: a.x + nx * wireOffset, z: a.z + nz * wireOffset };
          const wb = { x: b.x + nx * wireOffset, z: b.z + nz * wireOffset };
          const y1 = heightAt(wa.x, wa.z) + roadLift + 7.0;
          const y2 = heightAt(wb.x, wb.z) + roadLift + 7.0;
          const midX = (wa.x + wb.x) * 0.5;
          const midZ = (wa.z + wb.z) * 0.5;
          const sag = Math.min(1.0, 0.22 + length * 0.006);
          const midY = (y1 + y2) * 0.5 - sag;
          wirePoints.push(wa.x, y1, wa.z, midX, midY, midZ, midX, midY, midZ, wb.x, y2, wb.z);
        }
      }
    };
    for (const route of routes) addTrackSegment(route.segment, route.cable);

    const railGeometry = buildDynGeometry(railAttrs);
    const railMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.52,
      metalness: 0.62,
      flatShading: true,
    });
    const rails = new THREE.Mesh(railGeometry, railMaterial);
    rails.name = 'sf-transit-rails';
    rails.renderOrder = 2;
    rails.receiveShadow = true;
    root.add(rails);
    this.geometryCache.push(railGeometry, railMaterial);
    if (tieAttrs.position.length) {
      const tieGeometry = buildDynGeometry(tieAttrs);
      const tieMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.86,
        flatShading: true,
      });
      const ties = new THREE.Mesh(tieGeometry, tieMaterial);
      ties.name = 'sf-transit-ties';
      ties.renderOrder = 2;
      root.add(ties);
      this.geometryCache.push(tieGeometry, tieMaterial);
    }
    if (wirePoints.length) {
      const wireGeometry = new THREE.BufferGeometry();
      wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wirePoints, 3));
      const wireMaterial = new THREE.LineBasicMaterial({
        color: 0x3d3735,
        transparent: true,
        opacity: 0.22,
      });
      const wires = new THREE.LineSegments(wireGeometry, wireMaterial);
      wires.name = 'sf-transit-overhead';
      root.add(wires);
      this.geometryCache.push(wireGeometry, wireMaterial);
    }
    if (supportPositions.size) {
      const supportGeometry = new THREE.CylinderGeometry(0.045, 0.065, 7.15, 5);
      const supportMaterial = new THREE.MeshStandardMaterial({
        color: 0x554d49,
        roughness: 0.74,
        metalness: 0.28,
        flatShading: true,
      });
      const supports = new THREE.InstancedMesh(supportGeometry, supportMaterial, supportPositions.size);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      let index = 0;
      for (const support of supportPositions.values()) {
        position.set(support.x, heightAt(support.x, support.z) + roadLift + 3.55, support.z);
        matrix.compose(position, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
        supports.setMatrixAt(index, matrix);
        index += 1;
      }
      supports.instanceMatrix.needsUpdate = true;
      supports.castShadow = true;
      supports.name = 'sf-transit-supports';
      root.add(supports);
      this.geometryCache.push(supportGeometry, supportMaterial);
    }
  }

  buildTrees(root, city) {
    const random = mulberry32(Number(city.meta.seedInt) + 991);
    const treeData = [];
    const bounds = city.meta.bounds;
    if (city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap') {
      // Dense sidewalk trees along real polylines, like a real SF street.
      for (const segment of city.segments || []) {
        if (treeData.length >= 700) break;
        if (!['primary', 'secondary', 'tertiary', 'residential'].includes(segment.highway)) continue;
        const a = segment.points[0];
        const b = segment.points[segment.points.length - 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 18 || length > 360) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const spacing = segment.highway === 'primary' || segment.highway === 'secondary' ? 17 : 14;
        const count = Math.min(20, Math.max(2, Math.round(length / spacing)));
        for (let i = 0; i < count; i += 1) {
          if (treeData.length >= 700) break;
          if (random() < 0.08) continue;
          const t = (i + 0.5) / count;
          const side = i % 2 === 0 ? 1 : -1;
          const offset = segment.width / 2 + segment.sidewalkW * 0.55;
          treeData.push({
            x: a.x + dx * t + nx * offset * side,
            z: a.z + dz * t + nz * offset * side,
            scale: 0.8 + random() * 0.6,
          });
        }
      }
    } else {
      for (const street of city.streets) {
        const perpendicular = street.axis === 'x' ? 'z' : 'x';
        const position = street.position;
        const spacing = street.highway === 'primary' || street.highway === 'secondary' ? 36 : 27;
        const start = bounds[perpendicular === 'z' ? 'minZ' : 'minX'] + 18;
        const end = bounds[perpendicular === 'z' ? 'maxZ' : 'maxX'] - 18;
        for (let v = start; v < end; v += spacing + random() * 18) {
          if (random() < 0.04) continue;
          const side = random() < 0.5 ? -1 : 1;
          const sidewalkHalf = street.sidewalkW + street.asphaltWidth / 2 + 1.6;
          const x = street.axis === 'x' ? position + side * sidewalkHalf : v;
          const z = street.axis === 'z' ? position + side * sidewalkHalf : v;
          if (Math.abs(x) > bounds.maxX - 8 || Math.abs(z) > bounds.maxZ - 8) continue;
          treeData.push({ x, z, scale: 0.8 + random() * 0.6 });
        }
      }
    }
    for (const block of city.blocks) {
      if (block.landUse !== 'park') continue;
      const area = ringArea(block.polygon);
      const count = Math.max(6, Math.min(18, Math.round(area / 380)));
      for (let i = 0; i < count; i += 1) {
        const x = block.polygon[0].x + random() * (block.polygon[1].x - block.polygon[0].x);
        const z = block.polygon[0].z + random() * (block.polygon[3].z - block.polygon[0].z);
        if (pointInPolygon({ x, z }, block.polygon)) treeData.push({ x, z, scale: 1.0 + random() * 0.9, park: true });
      }
    }
    // Trees are instanced: hundreds of low-poly trees cost three draw calls.
    const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.24, 1.5, 5);
    const canopyGeometry = new THREE.ConeGeometry(1.25, 2.6, 7);
    const topGeometry = new THREE.SphereGeometry(0.55, 6, 5);
    const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x7a5a44, roughness: 0.9, flatShading: true });
    const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0x7ba265, roughness: 0.85, flatShading: true });
    const topMaterial = new THREE.MeshStandardMaterial({ color: 0x93b56f, roughness: 0.85, flatShading: true });
    const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, treeData.length);
    const canopyMesh = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, treeData.length);
    const topMesh = new THREE.InstancedMesh(topGeometry, topMaterial, treeData.length);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    for (let i = 0; i < treeData.length; i += 1) {
      const tree = treeData[i];
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(tree.x, tree.z) : 0) + 0.05;
      position.set(tree.x, y + 0.75 * tree.scale, tree.z);
      scale.set(tree.scale, tree.scale, tree.scale);
      matrix.compose(position, quaternion, scale);
      trunkMesh.setMatrixAt(i, matrix);
      position.y = y + 2.5 * tree.scale;
      matrix.compose(position, quaternion, scale);
      canopyMesh.setMatrixAt(i, matrix);
      position.y = y + 3.1 * tree.scale;
      matrix.compose(position, quaternion, scale);
      topMesh.setMatrixAt(i, matrix);
    }
    trunkMesh.castShadow = true;
    canopyMesh.castShadow = true;
    topMesh.castShadow = true;
    root.add(trunkMesh, canopyMesh, topMesh);
    this.geometryCache.push(trunkGeometry, canopyGeometry, topGeometry);
    this.buildSidewalkProps(root, city, random);
  }

  buildSidewalkProps(root, city, random) {
    const planterColor = new THREE.MeshStandardMaterial({ color: 0x8a5f46, roughness: 0.85, flatShading: true });
    const leafColor = new THREE.MeshStandardMaterial({ color: 0x4f7f4a, roughness: 0.85, flatShading: true });
    const benchColor = new THREE.MeshStandardMaterial({ color: 0x6f5c48, roughness: 0.8, flatShading: true });
    const hydrantColor = new THREE.MeshStandardMaterial({ color: 0xc9483a, roughness: 0.55, metalness: 0.3, flatShading: true });
    const coneColor = new THREE.MeshStandardMaterial({ color: 0xff7a1f, roughness: 0.6, flatShading: true });
    const signPoleColor = new THREE.MeshStandardMaterial({ color: 0x4b4f54, roughness: 0.6, metalness: 0.4, flatShading: true });
    const signBoardColors = ['#e85d4a', '#2f9fb0', '#e5a72f', '#4f9e58', '#8a5fc0'];
    const signBoardMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, flatShading: true });
    const props = [];
    const bounds = city.meta.bounds;
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const maxProps = realMap ? 900 : 1000;
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.5);
    const pushProp = (x, z, placement = null) => {
      if (props.length >= maxProps) return;
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0) + roadLift + 0.04;
      const roll = random();
      const rotation = placement?.rotation ?? random() * Math.PI;
      const base = { x, y, z, rotation, placement };
      if (roll < 0.45) {
        const flowerColors = ['#e84393', '#ff4f6d', '#ffd23f', '#7a5cff'];
        const flowers = [];
        for (let f = 0; f < 3; f += 1) {
          flowers.push({
            x: (random() - 0.5) * 0.7,
            z: (random() - 0.5) * 0.7,
            color: flowerColors[Math.floor(random() * flowerColors.length)],
          });
        }
        props.push({ kind: 'planter', ...base, flowers });
      } else if (roll < 0.62) {
        props.push({ kind: 'bench', ...base });
      } else if (roll < 0.78) {
        props.push({ kind: 'hydrant', ...base });
      } else if (roll < 0.9) {
        props.push({ kind: 'cone', ...base });
      } else {
        props.push({
          kind: 'sign',
          ...base,
          color: signBoardColors[Math.floor(random() * signBoardColors.length)],
        });
      }
    };
    if (realMap) {
      const roadCellSize = 64;
      const roadCells = new Map();
      const cellKey = (x, z) => `${x}:${z}`;
      for (const segment of city.segments || []) {
        const points = segment.points || [];
        if (points.length < 2) continue;
        const halfWidth = Number(segment.width || 0) / 2 + 0.3;
        const minX = Math.min(...points.map((point) => point.x)) - halfWidth;
        const maxX = Math.max(...points.map((point) => point.x)) + halfWidth;
        const minZ = Math.min(...points.map((point) => point.z)) - halfWidth;
        const maxZ = Math.max(...points.map((point) => point.z)) + halfWidth;
        for (let gx = Math.floor(minX / roadCellSize); gx <= Math.floor(maxX / roadCellSize); gx += 1) {
          for (let gz = Math.floor(minZ / roadCellSize); gz <= Math.floor(maxZ / roadCellSize); gz += 1) {
            const key = cellKey(gx, gz);
            if (!roadCells.has(key)) roadCells.set(key, []);
            roadCells.get(key).push(segment);
          }
        }
      }
      const distanceToSegmentPolyline = (point, segment) => {
        let distance = Infinity;
        for (let index = 1; index < segment.points.length; index += 1) {
          distance = Math.min(distance, pointToSegmentDistance(point, segment.points[index - 1], segment.points[index]));
        }
        return distance;
      };
      const overlapsOtherAsphalt = (x, z, owner) => {
        const nearby = roadCells.get(cellKey(Math.floor(x / roadCellSize), Math.floor(z / roadCellSize))) || [];
        return nearby.some((segment) => segment !== owner
          && segment.streetId !== owner.streetId
          && !['pedestrian', 'footway', 'cycleway'].includes(segment.highway)
          && distanceToSegmentPolyline({ x, z }, segment) < Number(segment.width || 0) / 2 + 0.3);
      };
      for (const segment of city.segments || []) {
        if (props.length >= maxProps) break;
        if (segment.highway === 'pedestrian' || segment.highway === 'footway' || segment.highway === 'cycleway' || segment.highway === 'motorway') continue;
        const a = segment.points[0];
        const b = segment.points[segment.points.length - 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 24 || length > 460) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const count = Math.min(8, Math.max(2, Math.round(length / 36)));
        for (let i = 0; i < count; i += 1) {
          if (props.length >= maxProps) break;
          if (random() < 0.25) continue;
          const t = (i + 0.5) / count;
          const side = i % 2 === 0 ? 1 : -1;
          const sidewalkWidth = Number(side > 0
            ? segment.sidewalkLeft ?? segment.sidewalkW
            : segment.sidewalkRight ?? segment.sidewalkW) || 0;
          if (sidewalkWidth < 0.8) continue;
          const minOffset = Number(segment.width || 0) / 2 + 0.3;
          const maxOffset = Number(segment.width || 0) / 2 + sidewalkWidth - 0.3;
          if (maxOffset < minOffset) continue;
          const offset = minOffset + (maxOffset - minOffset) * 0.58;
          const x = a.x + dx * t + nx * offset * side;
          const z = a.z + dz * t + nz * offset * side;
          if (overlapsOtherAsphalt(x, z, segment)) continue;
          pushProp(x, z, {
            segmentId: segment.id,
            streetId: segment.streetId,
            side,
            lateralOffset: offset,
            minOffset,
            maxOffset,
            rotation: Math.atan2(dx, dz),
            overlapsAsphalt: false,
          });
        }
      }
    } else {
      for (const street of city.streets) {
        if (props.length >= maxProps) break;
        if (street.highway === 'pedestrian' || street.highway === 'footway' || street.highway === 'cycleway') continue;
        const axis = street.axis;
        const position = street.position;
        const sidewalk = street.sidewalkW + street.asphaltWidth / 2 + 1.5;
        const start = bounds[axis === 'x' ? 'minZ' : 'minX'] + 22;
        const end = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 22;
        for (let v = start; v < end; v += 26 + random() * 14) {
          if (props.length >= maxProps) break;
          if (random() < 0.22) continue;
          const side = random() < 0.5 ? -1 : 1;
          const x = axis === 'x' ? position + side * sidewalk : v;
          const z = axis === 'z' ? position + side * sidewalk : v;
          if (Math.abs(x) > bounds.maxX - 6 || Math.abs(z) > bounds.maxZ - 6) continue;
          pushProp(x, z);
        }
      }
    }
    const group = new THREE.Group();
    group.name = 'sidewalk-props';
    const geometries = {
      planter: new THREE.BoxGeometry(0.8, 0.55, 0.8),
      leaf: new THREE.SphereGeometry(0.55, 6, 5),
      flower: new THREE.SphereGeometry(0.09, 5, 4),
      bench: new THREE.BoxGeometry(1.6, 0.1, 0.62),
      benchBack: new THREE.BoxGeometry(1.6, 0.55, 0.08),
      hydrant: new THREE.CylinderGeometry(0.18, 0.22, 0.75, 6),
      cone: new THREE.CylinderGeometry(0.02, 0.2, 0.55, 6),
      coneBand: new THREE.CylinderGeometry(0.13, 0.16, 0.1, 6),
      signPole: new THREE.BoxGeometry(0.08, 1.5, 0.08),
      signBoard: new THREE.BoxGeometry(0.62, 0.42, 0.06),
    };
    const flowerMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const color = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    const matrixFor = (prop, yOffset, xOffset = 0, zOffset = 0) => {
      const sin = Math.sin(prop.rotation);
      const cos = Math.cos(prop.rotation);
      position.set(
        prop.x + xOffset * cos + zOffset * sin,
        prop.y + yOffset,
        prop.z - xOffset * sin + zOffset * cos,
      );
      quaternion.setFromAxisAngle(up, prop.rotation);
      return matrix.compose(position, quaternion, scale);
    };
    const addBatch = ({ name, geometry, material, records, y, x = 0, z = 0, colorFor = null, castShadow = true }) => {
      if (!records.length) return;
      const mesh = new THREE.InstancedMesh(geometry, material, records.length);
      mesh.name = name;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = castShadow;
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        mesh.setMatrixAt(i, matrixFor(record, y, x, z));
        if (colorFor) mesh.setColorAt(i, color.set(colorFor(record)));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
    };
    const planters = props.filter((prop) => prop.kind === 'planter');
    const benches = props.filter((prop) => prop.kind === 'bench');
    const hydrants = props.filter((prop) => prop.kind === 'hydrant');
    const cones = props.filter((prop) => prop.kind === 'cone');
    const signs = props.filter((prop) => prop.kind === 'sign');
    const flowers = planters.flatMap((prop) => prop.flowers.map((flower) => ({
      ...prop,
      flowerX: flower.x,
      flowerZ: flower.z,
      color: flower.color,
    })));
    addBatch({ name: 'planter-pots', geometry: geometries.planter, material: planterColor, records: planters, y: 0.28 });
    addBatch({ name: 'planter-leaves', geometry: geometries.leaf, material: leafColor, records: planters, y: 1.05 });
    addBatch({ name: 'planter-flowers', geometry: geometries.flower, material: flowerMaterial, records: flowers, y: 1.32, x: 0, z: 0, colorFor: (prop) => prop.color, castShadow: false });
    if (flowers.length) {
      const flowerMesh = group.getObjectByName('planter-flowers');
      for (let i = 0; i < flowers.length; i += 1) {
        flowerMesh.setMatrixAt(i, matrixFor(flowers[i], 1.32, flowers[i].flowerX, flowers[i].flowerZ));
      }
      flowerMesh.instanceMatrix.needsUpdate = true;
    }
    addBatch({ name: 'bench-seats', geometry: geometries.bench, material: benchColor, records: benches, y: 0.45 });
    addBatch({ name: 'bench-backs', geometry: geometries.benchBack, material: benchColor, records: benches, y: 0.8, z: -0.28 });
    addBatch({ name: 'hydrants', geometry: geometries.hydrant, material: hydrantColor, records: hydrants, y: 0.4 });
    addBatch({ name: 'traffic-cones', geometry: geometries.cone, material: coneColor, records: cones, y: 0.28 });
    addBatch({ name: 'traffic-cone-bands', geometry: geometries.coneBand, material: signPoleColor, records: cones, y: 0.24 });
    addBatch({ name: 'street-sign-poles', geometry: geometries.signPole, material: signPoleColor, records: signs, y: 0.75 });
    addBatch({ name: 'street-sign-boards', geometry: geometries.signBoard, material: signBoardMaterial, records: signs, y: 1.55, colorFor: (prop) => prop.color });
    this.geometryCache.push(...Object.values(geometries));
    this.streetFurniture.props = props.length;
    this.sidewalkPropRecords = props.map((prop) => ({
      kind: prop.kind,
      x: prop.x,
      z: prop.z,
      ...(prop.placement || {}),
    }));
    this.sidewalkPropDiagnostics = {
      bandViolations: this.sidewalkPropRecords.filter((record) => record.segmentId
        && (record.lateralOffset < record.minOffset - 1e-6 || record.lateralOffset > record.maxOffset + 1e-6)).length,
      asphaltOverlaps: this.sidewalkPropRecords.filter((record) => record.overlapsAsphalt).length,
    };
    root.add(group);
  }

  buildParkedCars(root, city) {
    const random = mulberry32(Number(city.meta.seedInt || 1) + 711);
    const spots = [];
    const bounds = city.meta.bounds;
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const maxCars = realMap ? 520 : 800;
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.5);
    const classes = new Set(['primary', 'secondary', 'tertiary', 'residential']);
    if (realMap) {
      for (const segment of city.segments || []) {
        if (spots.length >= maxCars) break;
        if (!classes.has(segment.highway)) continue;
        const a = segment.points[0];
        const b = segment.points[segment.points.length - 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 24 || length > 420) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const heading = Math.atan2(dx, dz);
        const count = Math.min(12, Math.max(3, Math.round(length / 18)));
        for (let i = 0; i < count; i += 1) {
          if (spots.length >= maxCars) break;
          if (random() < 0.06) continue;
          const t = (i + 0.5) / count;
          const side = i % 2 === 0 ? 1 : -1;
          // Park inside the striped stall lane, not on the sidewalk.
          const offset = segment.width / 2 - 1.3;
          spots.push({
            x: a.x + dx * t + nx * offset * side,
            z: a.z + dz * t + nz * offset * side,
            heading,
          });
        }
      }
    } else {
      for (const street of city.streets) {
        if (spots.length >= maxCars) break;
        if (!classes.has(street.highway)) continue;
        const axis = street.axis;
        const position = street.position;
        const sidewalk = street.sidewalkW + street.asphaltWidth / 2 + 1.4;
        const start = bounds[axis === 'x' ? 'minZ' : 'minX'] + 24;
        const end = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 24;
        for (let v = start; v < end; v += 15 + random() * 9) {
          if (spots.length >= maxCars) break;
          if (random() < 0.18) continue;
          const side = random() < 0.5 ? -1 : 1;
          const x = axis === 'x' ? position + side * sidewalk : v;
          const z = axis === 'z' ? position + side * sidewalk : v;
          if (Math.abs(x) > bounds.maxX - 6 || Math.abs(z) > bounds.maxZ - 6) continue;
          spots.push({ x, z, heading: axis === 'x' ? (side > 0 ? 0 : Math.PI) : (side > 0 ? Math.PI / 2 : -Math.PI / 2) });
          if (spots.length >= maxCars) break;
        }
        if (spots.length >= maxCars) break;
      }
    }
    if (!spots.length) return;
    this.streetFurniture.cars = spots.length;
    const bodyGeometry = new THREE.BoxGeometry(1.8, 0.58, 3.9);
    const cabGeometry = new THREE.BoxGeometry(1.5, 0.5, 1.7);
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.38,
      metalness: 0.5,
      flatShading: true,
    });
    const cabMaterial = new THREE.MeshStandardMaterial({
      color: 0xb9d3e0,
      roughness: 0.22,
      metalness: 0.2,
      flatShading: true,
    });
    const bodies = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, spots.length);
    const cabs = new THREE.InstancedMesh(cabGeometry, cabMaterial, spots.length);
    const paints = [0xd94f4a, 0xe8b23a, 0x4f86c8, 0x3f9e8f, 0x8f74c8, 0xd47a3f, 0xf2e9d8, 0x6fbf73];
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const position = new THREE.Vector3();
    const color = new THREE.Color();
    for (let i = 0; i < spots.length; i += 1) {
      const spot = spots[i];
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(spot.x, spot.z) : 0) + roadLift + 0.3;
      position.set(spot.x, y, spot.z);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spot.heading);
      matrix.compose(position, quaternion, scale);
      bodies.setMatrixAt(i, matrix);
      cabs.setMatrixAt(i, matrix);
      color.set(paints[Math.floor(random() * paints.length)]);
      bodies.setColorAt(i, color);
    }
    bodies.instanceMatrix.needsUpdate = true;
    cabs.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    bodies.castShadow = true;
    bodies.receiveShadow = true;
    cabs.castShadow = true;
    root.add(bodies, cabs);
    this.geometryCache.push(bodyGeometry, cabGeometry);
  }

  buildShopAwnings(root, city) {
    const random = mulberry32(Number(city.meta.seedInt || 1) + 401);
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const awningColors = ['#e04945', '#128f9e', '#e5a021', '#3d8f52', '#8a5fc0', '#d95f5f', '#3f8f9e'];
    const materials = [];
    const neonSigns = [];
    const neonPanels = [];
    const bistroLights = [];
    const group = new THREE.Group();
    group.name = 'shopfront-awnings';
    let count = 0;
    const maxAwnings = realMap ? 320 : 140;
    let lastAwning = null;
    for (const building of city.buildings) {
      if (building.type !== 'shop' && building.facade !== 'shopfront') continue;
      const points = building.polygon;
      if (!points || points.length < 4) continue;
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minZ = Math.min(...points.map((p) => p.z));
      const maxZ = Math.max(...points.map((p) => p.z));
      if (maxX - minX < 6 || maxZ - minZ < 6) continue;
      let face = 'z';
      let side = 1;
      if (realMap && !building.facingStreet) {
        const near = this.nearestRoadSegment(city, { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 });
        if (near) {
          const a = near.points[0];
          const b = near.points[near.points.length - 1];
          const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
          if (horizontal) {
            face = 'z';
            side = a.z > (minZ + maxZ) / 2 ? 1 : -1;
          } else {
            face = 'x';
            side = a.x > (minX + maxX) / 2 ? 1 : -1;
          }
        }
      } else if (building.facingStreet) {
        const street = city.streets.find((s) => s.name === building.facingStreet);
        if (street?.axis === 'x') {
          face = 'x';
          side = Math.abs(minX - street.position) < Math.abs(maxX - street.position) ? -1 : 1;
        } else if (street?.axis === 'z') {
          face = 'z';
          side = Math.abs(minZ - street.position) < Math.abs(maxZ - street.position) ? -1 : 1;
        }
      }
      const colorHex = awningColors[Math.floor(random() * awningColors.length)];
      const material = new THREE.MeshStandardMaterial({
        color: colorHex,
        roughness: 0.7,
        metalness: 0.05,
        flatShading: true,
        emissive: colorHex,
        emissiveIntensity: 0,
      });
      materials.push(material);
      const length = Math.min(12, Math.max(4, face === 'x' ? maxZ - minZ : maxX - minX));
      const awning = new THREE.Mesh(new THREE.BoxGeometry(length, 0.14, 1.25), material);
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const baseY = (this.terrain?.heightAt ? this.terrain.heightAt(cx, cz) : 0) + 2.7;
      if (face === 'x') {
        awning.rotation.y = Math.PI / 2;
        awning.position.set(side > 0 ? maxX + 1.15 : minX - 1.15, baseY, cz);
      } else {
        awning.position.set(cx, baseY, side > 0 ? maxZ + 1.15 : minZ - 1.15);
      }
      awning.castShadow = true;
      group.add(awning);
      lastAwning = awning;
      count += 1;
      if (neonSigns.length < 400) {
        const neonColors = ['#ff5fa2', '#35d7d7', '#ffc43d', '#8dff5f', '#c08fff', '#ff7a45'];
        const signLength = Math.min(9, Math.max(3, face === 'x' ? maxZ - minZ : maxX - minX) * 0.56);
        const signX = face === 'x'
          ? (side > 0 ? maxX + 0.42 : minX - 0.42)
          : cx;
        const signZ = face === 'x'
          ? cz
          : (side > 0 ? maxZ + 0.42 : minZ - 0.42);
        const rotationY = face === 'x' ? Math.PI / 2 : 0;
        neonSigns.push({
          x: signX,
          y: baseY + 1.05,
          z: signZ,
          rotationY,
          scaleX: signLength,
          color: neonColors[Math.floor(random() * neonColors.length)],
        });
      }
      if (neonPanels.length < 260) {
        const panelColors = ['#e5484d', '#12a594', '#ffb224', '#30a46c', '#8e4ec6', '#ff5c8a'];
        const panelLength = Math.min(14, Math.max(5, face === 'x' ? maxZ - minZ : maxX - minX) * 0.82);
        const panelX = face === 'x'
          ? (side > 0 ? maxX + 0.34 : minX - 0.34)
          : cx;
        const panelZ = face === 'x'
          ? cz
          : (side > 0 ? maxZ + 0.34 : minZ - 0.34);
        neonPanels.push({
          x: panelX,
          y: baseY - 0.9,
          z: panelZ,
          rotationY: face === 'x' ? Math.PI / 2 : 0,
          length: panelLength,
          color: panelColors[Math.floor(random() * panelColors.length)],
        });
      }
      if (bistroLights.length < 1500) {
        const lightColors = ['#ffd166', '#ff8fab', '#7bdff2', '#b8f2e6', '#ffa69e', '#fcf6bd'];
        const span = face === 'x' ? maxZ - minZ : maxX - minX;
        const lightCount = Math.min(18, Math.max(3, Math.round(span / 1.5)));
        const start = -Math.min(6, span / 2);
        for (let l = 0; l < lightCount; l += 1) {
          const offset = start + (span / Math.max(1, lightCount - 1)) * l;
          const x = face === 'x'
            ? (side > 0 ? maxX + 0.85 : minX - 0.85)
            : cx + offset;
          const z = face === 'x'
            ? cz + offset
            : (side > 0 ? maxZ + 0.85 : minZ - 0.85);
          bistroLights.push({
            x,
            y: baseY + 0.55,
            z,
            color: lightColors[Math.floor(random() * lightColors.length)],
          });
        }
      }
      if (count >= maxAwnings) break;
    }
    if (count) {
      root.add(group);
      this.streetFurniture.awnings = count;
      this.geometryCache.push(lastAwning.geometry);
      for (const material of materials) {
        this.nightEmissive.push({ material, texture: null, nightTexture: null });
      }
    }
    if (neonSigns.length) {
      const signGeometry = new THREE.BoxGeometry(1, 0.92, 0.14);
      const signMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
      const signs = new THREE.InstancedMesh(signGeometry, signMaterial, neonSigns.length);
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      for (let i = 0; i < neonSigns.length; i += 1) {
        const sign = neonSigns[i];
        dummy.position.set(sign.x, sign.y, sign.z);
        dummy.rotation.set(0, sign.rotationY, 0);
        dummy.scale.set(sign.scaleX, 1, 1);
        dummy.updateMatrix();
        signs.setMatrixAt(i, dummy.matrix);
        color.set(sign.color);
        signs.setColorAt(i, color);
      }
      signs.instanceMatrix.needsUpdate = true;
      if (signs.instanceColor) signs.instanceColor.needsUpdate = true;
      root.add(signs);
      this.geometryCache.push(signGeometry);
      const lightCount = Math.min(96, neonSigns.length);
      for (let i = 0; i < lightCount; i += 1) {
        const sign = neonSigns[i];
        this.localLightCandidates.push({
          x: sign.x,
          y: sign.y - 0.5,
          z: sign.z,
          color: sign.color,
          intensity: 2.8,
          distance: 20,
          decay: 1.7,
        });
      }
    }
    if (neonPanels.length) {
      const panelGeometry = new THREE.BoxGeometry(1, 2.8, 0.12);
      const panelMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.16,
        fog: false,
        depthWrite: false,
      });
      panelMaterial.userData = { dayOpacity: 0.16, nightOpacity: 1 };
      this.neonGlowMaterials.push(panelMaterial);
      const panels = new THREE.InstancedMesh(panelGeometry, panelMaterial, neonPanels.length);
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      for (let i = 0; i < neonPanels.length; i += 1) {
        const panel = neonPanels[i];
        dummy.position.set(panel.x, panel.y, panel.z);
        dummy.rotation.set(0, panel.rotationY, 0);
        dummy.scale.set(panel.length, 1, 1);
        dummy.updateMatrix();
        panels.setMatrixAt(i, dummy.matrix);
        color.set(panel.color);
        panels.setColorAt(i, color);
      }
      panels.instanceMatrix.needsUpdate = true;
      if (panels.instanceColor) panels.instanceColor.needsUpdate = true;
      root.add(panels);
      this.geometryCache.push(panelGeometry);
    }
    if (bistroLights.length) {
      const bistroGeometry = new THREE.SphereGeometry(0.06, 6, 5);
      const bistroMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.55,
        fog: false,
      });
      bistroMaterial.userData = { dayOpacity: 0.55, nightOpacity: 1 };
      this.neonGlowMaterials.push(bistroMaterial);
      const lights = new THREE.InstancedMesh(bistroGeometry, bistroMaterial, bistroLights.length);
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      for (let i = 0; i < bistroLights.length; i += 1) {
        const light = bistroLights[i];
        dummy.position.set(light.x, light.y, light.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        lights.setMatrixAt(i, dummy.matrix);
        color.set(light.color);
        lights.setColorAt(i, color);
      }
      lights.instanceMatrix.needsUpdate = true;
      if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
      root.add(lights);
      this.geometryCache.push(bistroGeometry);
    }
  }

  nearestRoadSegment(city, point) {
    let best = null;
    let bestDistance = Infinity;
    for (const segment of city.segments || []) {
      if (segment.highway === 'pedestrian' || segment.highway === 'footway' || segment.highway === 'cycleway') continue;
      const a = segment.points[0];
      const b = segment.points[segment.points.length - 1];
      const d = pointToSegmentDistance(point, a, b);
      if (d < bestDistance) {
        bestDistance = d;
        best = segment;
      }
    }
    return bestDistance < 46 ? best : null;
  }

  setTimeOfDay(hour) {
    this.timeOfDay = hour;
    const night = hour >= 19.5 || hour <= 6;
    const previousHour = this.appliedTimeOfDay;
    const previousNight = this.appliedNightState;
    const wrappedDelta = previousHour == null
      ? Infinity
      : Math.min(Math.abs(hour - previousHour), 24 - Math.abs(hour - previousHour));
    if (previousNight === night && wrappedDelta < 0.02) return;
    this.appliedTimeOfDay = hour;
    this.appliedNightState = night;

    const nightFactor = clamp((hour - 6) / 4, 0, 1) * clamp((20 - hour) / 4, 0, 1);
    const golden = Math.max(0, 1 - Math.abs(hour - 8.2) / 3.5) * 0.7;
    if (this.skyMesh && previousNight !== night) {
      const positions = this.skyMesh.geometry.attributes.position.array;
      const colors = this.skyMesh.geometry.attributes.color.array;
      const top = night ? this.timeColors.skyTopNight : this.timeColors.skyTopDay;
      const mid = night ? this.timeColors.skyMidNight : this.timeColors.skyMidDay;
      const bottom = night ? this.timeColors.skyBottomNight : this.timeColors.skyBottomDay;
      const c = this.timeColors.work;
      for (let i = 0; i < positions.length; i += 3) {
        const y = positions[i + 1] / 1900;
        if (y > 0.08) c.copy(top).lerp(mid, clamp(y, 0, 1));
        else c.copy(bottom).lerp(mid, 1 - clamp(-y, 0, 1) * 4);
        colors[i] = c.r;
        colors[i + 1] = c.g;
        colors[i + 2] = c.b;
      }
      this.skyMesh.geometry.attributes.color.needsUpdate = true;
    }
    this.sun.intensity = 0.3 + nightFactor * 2.7 + golden * 0.7;
    this.sun.position.set(-180 - nightFactor * 80, 260 + nightFactor * 120, 110);
    this.sun.color.copy(this.timeColors.sun.setHSL(0.09 + (1 - nightFactor) * 0.02, 0.55, 0.82));
    this.hemi.color.copy(this.timeColors.hemiDay).lerp(this.timeColors.hemiNight, 1 - nightFactor);
    this.hemi.intensity = 0.55 + nightFactor * 0.8;
    this.ambient.intensity = 0.08 + nightFactor * 0.26;
    this.rim.intensity = 0.1 + nightFactor * 0.55;
    if (previousNight !== night) {
      for (const entry of this.nightEmissive) {
        entry.material.emissiveIntensity = night
          ? (entry.nightIntensity ?? (entry.texture || entry.nightTexture ? 0.5 : 0.9))
          : 0;
      }
      for (const material of this.neonGlowMaterials) {
        material.opacity = night ? material.userData.nightOpacity : (material.userData.dayOpacity ?? 0.18);
      }
      for (const bulb of this.lampBulbs) {
        bulb.material.emissiveIntensity = night ? 1.2 : 0.12;
      }
      this.localLightsNight = night;
      this.updateLocalLightPool(0, true);
    }
    if (this.water?.material) {
      this.water.material.color.set(night ? 0x1d5270 : 0x2f8fae);
      this.water.material.emissive.set(night ? 0x07192d : 0x062b35);
      this.water.material.emissiveIntensity = night ? 0.42 : 0.08;
    }
    const fogColor = this.timeColors.work;
    if (nightFactor < 0.28) fogColor.copy(this.timeColors.fogNight);
    else fogColor.copy(this.timeColors.fogDay).lerp(this.timeColors.fogDistant, 1 - nightFactor);
    // Daylight haze leans warm to match the key light.
    if (nightFactor >= 0.28) {
      fogColor.copy(this.timeColors.fogWarm).lerp(this.timeColors.fogDay, nightFactor * 0.4);
    }
    this.scene.fog.color.copy(fogColor);
    if (this.scene.background) this.scene.background.copy(fogColor);
    if (night && previousNight !== night) {
      this.nightBoost = { remaining: 1.2 };
      this.renderer.toneMappingExposure = 0.88;
    } else if (!night) {
      this.nightBoost = null;
      this.renderer.toneMappingExposure = 0.82;
    }
  }

  pick(pointer) {
    this.raycaster = this.raycaster || new THREE.Raycaster();
    this.raycaster.setFromCamera(pointer, this.camera);
    const objects = this.pickables;
    const hits = this.raycaster.intersectObjects(objects, true);
    return hits.length ? hits[0] : null;
  }

  update(delta, { time = null, traffic = null, players = null } = {}) {
    this.phaseClock += delta;
    this.signalPhaseClock += delta;
    this.controls.update();
    if (time != null) this.setTimeOfDay(time);
    this.updateLocalLightPool(delta);
    if (this.signalMeshes) {
      for (const entry of this.signalMeshes) {
        const offset = entry.signal.phaseOffset || 0;
        const local = Math.floor((this.signalPhaseClock + offset) / 8) % 4;
        const red = local === 0 || local === 1;
        const yellow = local === 2;
        const green = local === 3;
        const colors = [0xe0443a, 0xe8b23a, 0x5bbf6a];
        for (let i = 0; i < 3; i += 1) {
          const on = i === 0 ? red : i === 1 ? yellow : green;
          entry.lampMaterials[i].emissive.set(on ? colors[i] : 0x000000);
          entry.lampMaterials[i].emissiveIntensity = on ? 1.0 : 0.05;
          entry.lampMaterials[i].color.set(on ? colors[i] : 0x2b2f33);
        }
      }
    }
    if (traffic) traffic.update(delta);
    if (players) players.update(delta);
    if (this.water && this.water.material) {
      const wave = Math.sin(this.phaseClock * 0.6) * 0.05;
      this.water.position.y = 0.45 + wave;
    }
    if (this.nightBoost && this.nightBoost.remaining > 0) {
      this.nightBoost.remaining -= delta;
      const boost = Math.min(1, this.nightBoost.remaining / 0.8);
      this.renderer.toneMappingExposure = 0.82 + boost * 0.14;
    }
  }

  renderFrame() {
    this.renderer.render(this.scene, this.camera);
  }

  setWalkMode(enabled) {
    this.controls.enabled = !enabled;
    if (enabled) this.controls.enableRotate = false;
    else this.controls.enableRotate = true;
  }
}

const STREET_LAMP_CLASSES = Object.freeze(['primary', 'secondary', 'tertiary', 'residential']);
const STREET_LAMP_SPACING = Object.freeze({
  primary: 32,
  secondary: 34,
  tertiary: 42,
  residential: 50,
});

/**
 * Derive authored lamp fixtures from the active street contract. Real maps
 * must follow source polylines; the old axis/position shortcut silently
 * collapsed OSM roads onto z=0 because OSM streets intentionally have no
 * grid axis. Records carry their source segment and measured sidewalk band
 * so QA can reject presentation-only or asphalt placements.
 */
function collectStreetLampRecords(city, { maxLamps = 240 } = {}) {
  const generator = city?.meta?.generator || 'unknown';
  const realMap = generator === 'sf-builtin' || generator === 'openstreetmap';
  if (!realMap) return collectProceduralLampRecords(city, maxLamps);

  const segments = Array.isArray(city?.segments) ? city.segments : [];
  const eligible = segments.filter((segment) => STREET_LAMP_CLASSES.includes(segment.highway)
    && Array.isArray(segment.points) && segment.points.length >= 2);
  const byClass = new Map(STREET_LAMP_CLASSES.map((highway) => [highway, []]));
  const seen = new Set();
  let generatedCount = 0;
  let culledAsphaltOverlaps = 0;
  let polylineSegments = 0;

  const distanceToPolyline = (point, points) => {
    let distance = Infinity;
    for (let index = 1; index < points.length; index += 1) {
      distance = Math.min(distance, pointToSegmentDistance(point, points[index - 1], points[index]));
    }
    return distance;
  };
  const overlapsOtherAsphalt = (point, owner) => eligible.some((segment) => {
    if (segment === owner || segment.streetId === owner.streetId) return false;
    const width = Number(segment.width || 0);
    return width > 0 && distanceToPolyline(point, segment.points) < width / 2 + 0.3;
  });

  for (const segment of eligible) {
    const points = segment.points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.z));
    if (points.length < 2) continue;
    if (points.length > 2) polylineSegments += 1;
    const length = polylineLength(points);
    if (!Number.isFinite(length) || length < 18) continue;
    const leftWidth = Math.max(0, Number(segment.sidewalkLeft ?? segment.sidewalkW ?? 0));
    const rightWidth = Math.max(0, Number(segment.sidewalkRight ?? segment.sidewalkW ?? 0));
    const sides = [];
    if (leftWidth >= 0.8) sides.push({ side: 1, width: leftWidth });
    if (rightWidth >= 0.8) sides.push({ side: -1, width: rightWidth });
    if (!sides.length) continue;
    const spacingMeters = STREET_LAMP_SPACING[segment.highway] || 42;
    const count = Math.max(1, Math.round(length / spacingMeters));
    const queue = byClass.get(segment.highway);
    for (let index = 0; index < count; index += 1) {
      const along = ((index + 0.5) / count) * length;
      const point = pointAlongPolyline(points, along);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
      const placement = sides[index % sides.length];
      const minOffset = Number(segment.width || 0) / 2 + 0.3;
      const maxOffset = Number(segment.width || 0) / 2 + placement.width - 0.3;
      if (maxOffset < minOffset) continue;
      const lateralOffset = minOffset + (maxOffset - minOffset) * 0.58;
      const x = point.x + point.nx * lateralOffset * placement.side;
      const z = point.z + point.nz * lateralOffset * placement.side;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      generatedCount += 1;
      const key = `${Math.round(x * 10)}:${Math.round(z * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (overlapsOtherAsphalt({ x, z }, segment)) {
        culledAsphaltOverlaps += 1;
        continue;
      }
      queue.push({
        x,
        z,
        rotation: Math.atan2(point.tx, point.tz),
        segmentId: segment.id,
        streetId: segment.streetId,
        streetName: segment.streetName || '',
        highway: segment.highway,
        side: placement.side,
        sidewalkWidth: placement.width,
        lateralOffset,
        minOffset,
        maxOffset,
        distanceAlong: Number(along.toFixed(3)),
        spacingMeters,
        source: 'segment-polyline',
        overlapsAsphalt: false,
      });
    }
  }

  // Interleave classes before applying the global cap. This keeps the
  // bounded population representative of primary through residential roads,
  // independent of source element ordering.
  const cursors = new Map(STREET_LAMP_CLASSES.map((highway) => [highway, 0]));
  const records = [];
  let added = true;
  while (records.length < maxLamps && added) {
    added = false;
    for (const highway of STREET_LAMP_CLASSES) {
      if (records.length >= maxLamps) break;
      const queue = byClass.get(highway);
      const cursor = cursors.get(highway);
      if (cursor >= queue.length) continue;
      records.push(queue[cursor]);
      cursors.set(highway, cursor + 1);
      added = true;
    }
  }

  const classCounts = Object.fromEntries(STREET_LAMP_CLASSES.map((highway) => [
    highway,
    records.filter((record) => record.highway === highway).length,
  ]));
  const sideCounts = {
    left: records.filter((record) => record.side === 1).length,
    right: records.filter((record) => record.side === -1).length,
  };
  return {
    records,
    diagnostics: {
      fixtureCount: records.length,
      candidateCount: records.length,
      generatedCount,
      culledAsphaltOverlaps,
      polylineSegments,
      sourceOwnedCount: records.filter((record) => record.segmentId && record.streetId).length,
      bandViolations: records.filter((record) => (
        record.lateralOffset < record.minOffset - 1e-6
        || record.lateralOffset > record.maxOffset + 1e-6
      )).length,
      asphaltOverlaps: records.filter((record) => record.overlapsAsphalt).length,
      classCounts,
      sideCounts,
    },
  };
}

function collectProceduralLampRecords(city, maxLamps) {
  const positions = new Map();
  const bounds = city?.meta?.bounds || {};
  for (const signal of city?.signals || []) {
    const x = Number(signal.position?.x);
    const z = Number(signal.position?.z);
    if (Number.isFinite(x) && Number.isFinite(z)) positions.set(`${x.toFixed(1)},${z.toFixed(1)}`, {
      x,
      z,
      rotation: 0,
      source: 'signal',
    });
  }
  for (const street of city?.streets || []) {
    if (positions.size >= maxLamps) break;
    if (street.highway !== 'primary' && street.highway !== 'secondary') continue;
    const axis = street.axis;
    if (axis !== 'x' && axis !== 'z') continue;
    const position = Number(street.position);
    const count = 6;
    for (let index = 1; index < count; index += 1) {
      if (positions.size >= maxLamps) break;
      const t = index / count;
      const x = axis === 'x' ? position : bounds.minX + (bounds.maxX - bounds.minX) * t;
      const z = axis === 'z' ? position : bounds.minZ + (bounds.maxZ - bounds.minZ) * t;
      const lateral = street.sidewalkW + street.asphaltWidth / 2 + 0.9;
      const side = index % 2 === 0 ? 1 : -1;
      const lampX = axis === 'x' ? position + side * lateral : x;
      const lampZ = axis === 'z' ? position + side * lateral : z;
      if (!Number.isFinite(lampX) || !Number.isFinite(lampZ)) continue;
      positions.set(`${lampX.toFixed(1)},${lampZ.toFixed(1)}`, {
        x: lampX,
        z: lampZ,
        rotation: axis === 'x' ? Math.PI / 2 : 0,
        source: 'procedural-grid',
      });
    }
  }
  const records = [...positions.values()].slice(0, maxLamps);
  return {
    records,
    diagnostics: {
      fixtureCount: records.length,
      candidateCount: records.length,
      generatedCount: records.length,
      culledAsphaltOverlaps: 0,
      polylineSegments: 0,
      sourceOwnedCount: 0,
      bandViolations: 0,
      asphaltOverlaps: 0,
      classCounts: {},
      sideCounts: {},
    },
  };
}

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function isSanFranciscoCity(city) {
  const name = String(city?.meta?.name || '');
  const seed = String(city?.meta?.seed || '');
  return city?.meta?.generator === 'sf-builtin'
    || (city?.meta?.generator === 'openstreetmap' && /san\s*francisco/i.test(name))
    || /^sf(?:[-_ ]|$)/i.test(seed);
}

function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

function polylineLength(points) {
  let length = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return length;
}

function pointAlongPolyline(points, distance) {
  let remaining = distance;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const segLength = Math.hypot(dx, dz);
    if (segLength <= 0) continue;
    if (remaining <= segLength) {
      const t = remaining / segLength;
      return {
        x: a.x + dx * t,
        z: a.z + dz * t,
        tx: dx / segLength,
        tz: dz / segLength,
        nx: -dz / segLength,
        nz: dx / segLength,
      };
    }
    remaining -= segLength;
  }
  const last = points[points.length - 2] || points[0];
  const end = points[points.length - 1];
  const dx = end.x - last.x;
  const dz = end.z - last.z;
  const length = Math.hypot(dx, dz) || 1;
  return { x: end.x, z: end.z, tx: dx / length, tz: dz / length, nx: -dz / length, nz: dx / length };
}
