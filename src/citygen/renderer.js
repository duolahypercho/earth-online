import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mulberry32, ringArea, pointInPolygon, terrainHeight, clamp } from './core.js';

const PALETTES = Object.freeze({
  painted: ['#d95f5f', '#3f8f9e', '#e0b14e', '#5f80b5', '#d88742', '#8fae68', '#c46f92'],
  plaster: ['#f3cfae', '#e8ae8c', '#f6ddc0', '#e2b294', '#eecba4'],
  brick: ['#d68b5f', '#cd6f4e', '#e39a70', '#b85a42', '#d9815c'],
  concrete: ['#ddd9cf', '#c9c4b8', '#ece7dd', '#d3cfc3', '#e0dbd2'],
  clapboard: ['#8fb9d8', '#e0b186', '#a6cf9b', '#e5aebd', '#9db8dc'],
  glass: ['#86b8d8', '#77a8cf', '#b0d4e6', '#9cc9dc', '#7fadd0'],
  stone: ['#d3cbb8', '#c4bba8', '#e0d8c8', '#ccc2ae', '#d8d0c0'],
});

const FACADE_STYLES = ['edwardian', 'modern-grid', 'bay-window', 'shopfront', 'loft', 'art-deco'];

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

function drawFacade(context, width, height, random, style, material, { day = true } = {}) {
  const base = PALETTES[material] || PALETTES.plaster;
  context.fillStyle = base[Math.floor(random() * base.length)];
  context.fillRect(0, 0, width, height);
  const vertical = style === 'modern-grid' || style === 'loft';
  const columns = vertical ? 3 + Math.floor(random() * 3) : 2 + Math.floor(random() * 2);
  const rows = Math.max(3, Math.floor((height / 128) * (3 + Math.floor(random() * 4))));
  const margin = 10;
  const gapX = (width - margin * 2) / columns;
  const gapY = (height - margin * 2) / rows;
  const lit = material === 'glass'
    ? ['#cfe4ef', '#d9e9f2', '#bcd6e6']
    : ['#ffd98f', '#ffc96a', '#ffe9ae', '#f0b967'];
  const cool = material === 'glass';
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const x = margin + col * gapX + random() * 5;
      const y = margin + row * gapY + random() * 4;
      const w = gapX * 0.62;
      const h = gapY * 0.62;
      const litWindow = random() < (day ? 0.24 : 0.86);
      context.fillStyle = cool ? (litWindow ? '#e7f3f8' : '#86a8bb') : (litWindow ? lit[Math.floor(random() * lit.length)] : '#39434c');
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
  // Cornice + parapet bands.
  context.fillStyle = 'rgba(255,255,255,0.22)';
  context.fillRect(0, 0, width, 7);
  context.fillRect(0, height - 7, width, 7);
  context.fillStyle = 'rgba(60,45,35,0.28)';
  context.fillRect(0, 7, width, 3);
  if (style === 'loft' || style === 'art-deco' || random() < 0.3) {
    const murals = ['rgba(194,75,63,0.42)', 'rgba(47,127,143,0.42)', 'rgba(201,143,58,0.42)', 'rgba(79,127,79,0.42)', 'rgba(127,79,143,0.42)'];
    context.fillStyle = murals[Math.floor(random() * murals.length)];
    context.fillRect(0, Math.floor(height * 0.38), width, Math.floor(height * 0.14));
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
    context.fillStyle = '#f3d9a4';
    context.fillRect(8, height - 24, (width - 16) / 2 - 4, 18);
    context.fillStyle = '#7fb5d8';
    context.fillRect((width - 16) / 2 + 8, height - 24, (width - 16) / 2 - 4, 18);
    // Saturated striped awning above the shopfront.
    const awningColors = ['#e04945', '#128f9e', '#e5a021', '#3d8f52', '#8a5fc0'];
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
  context.fillStyle = '#d1bc9d';
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
  context.fillStyle = '#a3bd8b';
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

function makeLine(points, color, width = 0.14, y = 0.035, dash = null) {
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const linePoints = [];
  if (dash) {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.floor(length / dash));
      for (let s = 0; s < steps; s += 1) {
        const t0 = s / steps;
        const t1 = (s + 0.5) / steps;
        linePoints.push(
          { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 },
          { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 },
        );
      }
    }
  } else {
    linePoints.push(...points);
  }
  for (const p of linePoints) {
    positions.push(p.x, y, p.z);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.92 });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 3;
  return line;
}

export class CityRenderer {
  constructor(container, { pixelRatioCap = 1.5 } = {}) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xcfe3ea, 380, 1500);
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 4200);
    this.camera.position.set(180, 150, 260);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    container.appendChild(this.renderer.domElement);

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
    this.skyMesh = null;
    this.signalPhaseClock = 0;
    this.phaseClock = 0;
    this.terrain = null;
    this.city = null;
    this.nightEmissive = [];
    this.neonGlowMaterials = [];
    this.lampBulbs = [];
    this.lampLights = [];
    this.neonLights = [];

    this.sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
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

    this.hemi = new THREE.HemisphereLight(0xe8f4ff, 0x9aa86f, 1.25);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xfff3e0, 0.3);
    this.scene.add(this.ambient);
    this.rim = new THREE.DirectionalLight(0xbcd7e8, 0.55);
    this.rim.position.set(320, 240, -260);
    this.scene.add(this.rim);

    this.onResize = this.resize.bind(this);
    window.addEventListener('resize', this.onResize);
    this.resize();
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
    if (city?.terrain?.heightAt) {
      this.terrain = city.terrain;
    } else {
      this.terrain = { heightAt: (x, z) => terrainHeight(x, z, Number(city?.meta?.seedInt || 1)) };
    }
  }

  async buildCity(city, { focus = null, day = true } = {}) {
    this.setCity(city);
    this.day = day;
    // Dispose old dynamic geometry only; static materials persist for rebuilds.
    for (const geometry of this.geometryCache) geometry.dispose();
    this.geometryCache = [];
    this.pickables = [];
    this.neonGlowMaterials = [];
    this.neonLights = [];
    const root = new THREE.Group();
    root.name = 'city-root';

    // Sky dome.
    root.add(this.makeSky());
    // Terrain base + park ground.
    root.add(this.makeGround(city));
    // Waterfront for the east edge.
    root.add(this.makeWater(city));

    // Buildings with per-facade canvas textures.
    await this.buildBuildings(root, city);
    // Soft contact shadows ground the buildings.
    this.buildContactShadows(root, city);
    // Roads, sidewalks, curbs, markings, crosswalks.
    this.buildRoadNetwork(root, city);
    // Night neon trim along major avenues.
    this.buildStreetNeonTrim(root, city);
    // Festival bunting adds street-level color in daylight too.
    this.buildStreetBunting(root, city);
    // Signals with metadata.
    this.buildSignals(root, city);
    // Trees.
    this.buildTrees(root, city);
    // Curbside cars: saturated paint anchors the street-level color story.
    this.buildParkedCars(root, city);
    this.buildShopAwnings(root, city);

    this.root = root;
    this.scene.add(root);
    this.camera.near = 0.5;
    this.camera.far = 4200;
    this.camera.updateProjectionMatrix();
    this.signalPhaseClock = 0;
    return root;
  }

  clearCity() {
    if (this.root) {
      this.scene.remove(this.root);
      this.root.traverse((object) => {
        if (object.geometry) this.geometryCache.push(object.geometry);
        if (object.material && object.material.map) {
          object.material.map.dispose();
          object.material.dispose();
        } else if (Array.isArray(object.material)) {
          for (const material of object.material) {
            if (material.map) material.map.dispose();
            material.dispose();
          }
        }
      });
      for (const entry of this.nightEmissive) {
        if (entry.nightTexture) entry.nightTexture.dispose();
      }
      if (this.contactShadowMaterial) this.contactShadowMaterial.dispose();
      this.nightEmissive = [];
      this.lampBulbs = [];
      this.lampLights = [];
      this.neonLights = [];
      this.signalMeshes = [];
      this.root = null;
    }
  }

  makeSky() {
    const geometry = new THREE.SphereGeometry(1900, 32, 16);
    const colors = [];
    const positions = geometry.attributes.position.array;
    const top = new THREE.Color('#5f9fd1');
    const mid = new THREE.Color('#aed5e4');
    const bottom = new THREE.Color('#f6e7c9');
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
    sky.renderOrder = -10;
    this.geometryCache.push(geometry);
    this.skyMesh = sky;
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
    const park = new THREE.Color('#a4be8e');
    const field = new THREE.Color('#839a68');
    const waterEdge = new THREE.Color('#b2cb9c');
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] + (bounds.minX + bounds.maxX) / 2;
      const z = positions[i + 2] + (bounds.minZ + bounds.maxZ) / 2;
      const y = this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0;
      positions[i + 1] = y - 0.22;
      const n = Math.sin(x * 0.011 + z * 0.017 + Number(city.meta.seedInt) * 0.1) * 0.5 + 0.5;
      const nearWater = smoothstep(bounds.maxX - 160, bounds.maxX - 30, x);
      const c = park.clone().lerp(field, n * 0.35).lerp(waterEdge, nearWater * 0.35);
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

  makeWater(city) {
    const bounds = city.meta.bounds;
    const geometry = new THREE.PlaneGeometry(680, bounds.maxZ - bounds.minZ + 520);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0x3f8aa8,
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
    this.buildBayProps(water.parent || this.scene, city, bounds);
    return water;
  }

  buildBayProps(scene, city, bounds) {
    const y = 0.52;
    const towerX = bounds.maxX - 150;
    const towerZ = (bounds.minZ + bounds.maxZ) / 2 + 40;
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
    const towerGeometry = new THREE.BoxGeometry(5, 74, 5);
    const left = new THREE.Mesh(towerGeometry, towerMaterial);
    left.position.set(towerX - 88, y + 37, towerZ);
    const right = new THREE.Mesh(towerGeometry, towerMaterial);
    right.position.set(towerX + 88, y + 37, towerZ);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(230, 5, 9), deckMaterial);
    deck.position.set(towerX, y + 4.2, towerZ);
    scene.add(left, right, deck);
    const cableMaterial = new THREE.LineBasicMaterial({ color: 0xdfe6ea, transparent: true, opacity: 0.85 });
    for (let i = 0; i <= 10; i += 1) {
      const t = i / 10;
      const points = [];
      const sag = 14;
      for (let s = 0; s <= 10; s += 1) {
        const st = s / 10;
        points.push(new THREE.Vector3(
          towerX - 88 + 176 * st,
          y + 74 + (Math.sin(st * Math.PI) * -sag) + (t - 0.5) * 2,
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
    const facadeSeed = Number(city.meta.seedInt || 1);
    const random = mulberry32(facadeSeed);

    for (const building of city.buildings) {
      const points = building.polygon;
      if (points.length < 4) continue;
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
      const isFlat = building.type === 'rowhouse' || building.type === 'warehouse' || building.type === 'civic' || building.type === 'park';
      const useTexture = !isFlat && random() < 0.88;
      const materialKey = building.material;

      if (useTexture) {
        const facadeStyle = building.facade;
        const textureSeed = facadeSeed + Number(building.id.replace(/\D/g, '') || 0) * 13 + (building.facade || '').length;
        const dayRnd = mulberry32(textureSeed);
        const texture = seededTexture(textureSeed, (context, w, h) => {
          drawFacade(context, w, h, dayRnd, facadeStyle, building.material, { day: true });
        }, 128, 192);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(1, Math.max(1, Math.round(height / 4.6)));
        const material = new THREE.MeshStandardMaterial({
          map: texture,
          emissive: 0xfff0b8,
          emissiveMap: texture,
          emissiveIntensity: 0,
          roughness: 0.68,
          metalness: 0.06,
          flatShading: true,
        });
        const nightRnd = mulberry32(textureSeed);
        const nightTexture = seededTexture(textureSeed + 31, (context, w, h) => {
          drawFacade(context, w, h, nightRnd, facadeStyle, building.material, { day: false });
        }, 128, 192);
        nightTexture.wrapS = THREE.RepeatWrapping;
        nightTexture.wrapT = THREE.RepeatWrapping;
        nightTexture.repeat.copy(texture.repeat);
        material.emissiveMap = nightTexture;
        this.nightEmissive.push({ material, texture, nightTexture });
        const geometry = new THREE.BoxGeometry(width, height, depth);
        geometry.translate(center.x, baseY, center.z);
        geometry.translate(0, height / 2, 0);
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { kind: 'building', id: building.id, buildingId: building.id };
        root.add(mesh);
        this.pickables.push(mesh);
        this.geometryCache.push(geometry);
        this.addRoofDetails(root, building, width, depth, height, baseY, minX, minZ, building.material, random);
        continue;
      }

      // Flat-shaded vertex-color building, merged by material.
      let group = flatGroups.get(materialKey);
      if (!group) {
        group = {
          geoms: [],
          colors: PALETTES[materialKey] || PALETTES.plaster,
          buildingIds: [],
        };
        flatGroups.set(materialKey, group);
      }
      const box = new THREE.BoxGeometry(width, height, depth);
      box.translate(center.x, baseY + height / 2, center.z);
      // Per-face jitter + roof tone.
      const positions = box.attributes.position.array;
      const faceColors = [];
      const colorList = group.colors;
      for (let i = 0; i < positions.length / 9; i += 1) {
        const r = mulberry32(facadeSeed + building.id.length + i);
        const baseColor = colorList[Math.floor(r() * colorList.length)];
        const isTop = Math.abs(positions[i * 9 + 1] - (baseY + height)) < 0.01;
        const c = isTop ? shade(colorFromHex(baseColor), -0.34) : shade(colorFromHex(baseColor), (r() - 0.5) * 0.14);
        for (let j = 0; j < 9; j += 1) faceColors.push(c.r, c.g, c.b);
      }
      box.setAttribute('color', new THREE.Float32BufferAttribute(faceColors, 3));
      group.geoms.push(box);
      group.buildingIds.push(building.id);
      this.geometryCache.push(box);
      this.addRoofDetails(root, building, width, depth, height, baseY, minX, minZ, building.material, random);
    }

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
      mesh.userData = { kind: 'buildings-flat', material: key };
      root.add(mesh);
      this.pickables.push(mesh);
      // Per-building pick metadata via spatial map in main.
    }
  }

  buildContactShadows(root, city) {
    const shadows = [];
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
    for (const building of city.buildings) {
      const points = building.polygon;
      if (points.length < 4) continue;
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minZ = Math.min(...points.map((p) => p.z));
      const maxZ = Math.max(...points.map((p) => p.z));
      if (maxX - minX < 2 || maxZ - minZ < 2) continue;
      const y = this.terrain?.heightAt ? this.terrain.heightAt((minX + maxX) / 2, (minZ + maxZ) / 2) : 0;
      const geometry = new THREE.PlaneGeometry(1, 1);
      geometry.rotateX(-Math.PI / 2);
      const position = geometry.attributes.position.array;
      const uv = geometry.attributes.uv.array;
      const width = maxX - minX + 2.2;
      const depth = maxZ - minZ + 2.2;
      for (let i = 0; i < position.length; i += 3) {
        position[i] = minX - 1.1 + (position[i] + 0.5) * width;
        position[i + 1] = y + 0.052;
        position[i + 2] = minZ - 1.1 + (position[i + 2] + 0.5) * depth;
      }
      for (let i = 0; i < uv.length; i += 2) {
        uv[i] = 0.5 + (uv[i] - 0.5) * 0.92;
        uv[i + 1] = 0.5 + (uv[i + 1] - 0.5) * 0.92;
      }
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 1;
      shadows.push(mesh);
      this.geometryCache.push(geometry);
    }
    this.geometryCache.push(alphaTexture);
    const group = new THREE.Group();
    group.name = 'contact-shadows';
    for (const mesh of shadows) group.add(mesh);
    root.add(group);
  }

  addRoofDetails(root, building, width, depth, height, baseY, minX, minZ, material, random) {
    const topY = baseY + height;
    const cx = minX + width / 2;
    const cz = minZ + depth / 2;
    const parapet = new THREE.BoxGeometry(width + 0.5, 0.42, depth + 0.5);
    parapet.translate(cx, topY + 0.14, cz);
    const parapetColor = PALETTES[material]?.[0] || '#cfc9bb';
    const parapetMesh = new THREE.Mesh(parapet, new THREE.MeshStandardMaterial({
      color: shade(colorFromHex(parapetColor), -0.2),
      roughness: 0.8,
      flatShading: true,
    }));
    parapetMesh.castShadow = true;
    root.add(parapetMesh);
    this.geometryCache.push(parapet);
    if ((building.type === 'rowhouse' || building.type === 'midrise') && random() < 0.42) {
      const tankR = 0.9 + random() * 0.5;
      const tankH = 1.4 + random() * 0.9;
      const tank = new THREE.CylinderGeometry(tankR * 0.82, tankR, tankH, 8);
      tank.translate(cx + width * (random() - 0.5) * 0.36, topY + 0.28 + tankH / 2, cz + depth * (random() - 0.5) * 0.36);
      const tankMesh = new THREE.Mesh(tank, new THREE.MeshStandardMaterial({
        color: '#b5725a',
        roughness: 0.55,
        metalness: 0.25,
        flatShading: true,
      }));
      tankMesh.castShadow = true;
      root.add(tankMesh);
      this.geometryCache.push(tank);
    } else if (building.type === 'tower' && random() < 0.6) {
      const cellR = 0.55;
      const cellH = 2.6 + random() * 2;
      const cell = new THREE.CylinderGeometry(cellR * 0.9, cellR, cellH, 6);
      cell.translate(cx + width * 0.22, topY + cellH / 2 + 0.3, cz + depth * 0.18);
      const cellMesh = new THREE.Mesh(cell, new THREE.MeshStandardMaterial({
        color: '#c4beb4',
        roughness: 0.5,
        metalness: 0.5,
        flatShading: true,
      }));
      cellMesh.castShadow = true;
      root.add(cellMesh);
      this.geometryCache.push(cell);
    }
  }

  buildRoadNetwork(root, city) {
    // Pre-count vertices: 4 per quad, 6 indices per quad.
    const quads = { asphalt: 0, sidewalk: 0, curb: 0, crosswalk: 0 };
    for (const segment of city.segments) {
      for (let i = 0; i < segment.points.length - 1; i += 1) {
        quads.asphalt += 1;
        if (segment.sidewalkW > 0) {
          quads.sidewalk += 2;
          quads.curb += 2;
        }
      }
    }
    quads.asphalt += city.intersections.length;
    for (const intersection of city.intersections) {
      if (intersection.signal) quads.crosswalk += 4 * 4;
    }
    const asphaltAttrs = lineQuadAttrs(quads.asphalt);
    const sidewalkAttrs = lineQuadAttrs(quads.sidewalk);
    const curbAttrs = lineQuadAttrs(quads.curb);
    const crosswalkAttrs = lineQuadAttrs(quads.crosswalk);
    const asphaltColors = {
      motorway: new THREE.Color('#555e68'),
      trunk: new THREE.Color('#5a636d'),
      primary: new THREE.Color('#626a73'),
      secondary: new THREE.Color('#6b737b'),
      tertiary: new THREE.Color('#737b83'),
      residential: new THREE.Color('#7b8287'),
      service: new THREE.Color('#848a8c'),
    };
    const sidewalkColor = new THREE.Color('#d8bd92');
    const curbColor = new THREE.Color('#b98a68');
    const crosswalkColor = new THREE.Color('#f2ead8');
    let asphaltVertex = 0;
    let sidewalkVertex = 0;
    let curbVertex = 0;
    let crosswalkVertex = 0;
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.5);
    const curbHeight = Number(city.meta.streetDesign?.curbHeight ?? 0.16);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xf2ead8, transparent: true, opacity: 0.9 });
    const centerLineMaterial = new THREE.LineBasicMaterial({ color: 0xe0b64b, transparent: true, opacity: 0.9 });

    for (const segment of city.segments) {
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
          if (segment.lanes >= 3) {
            root.add(makeLine([a, b], 0xe8dfcb, 0.12, ya + 0.075, dash));
          } else {
            root.add(makeLine([a, b], 0xe0b64b, 0.13, ya + 0.075, dash));
          }
        }
        if (segment.highway === 'primary' || segment.highway === 'secondary') {
          root.add(makeLine(
            [{ x: a.x + nx * (half - 0.35), z: a.z + nz * (half - 0.35) }, { x: b.x + nx * (half - 0.35), z: b.z + nz * (half - 0.35) }],
            0xf2ead8, 0.1, ya + 0.075, 3,
          ));
          root.add(makeLine(
            [{ x: a.x - nx * (half - 0.35), z: a.z - nz * (half - 0.35) }, { x: b.x - nx * (half - 0.35), z: b.z - nz * (half - 0.35) }],
            0xf2ead8, 0.1, ya + 0.075, 3,
          ));
        }
      }
    }

    // Asphalt patches close the gaps where streets cross.
    for (const intersection of city.intersections) {
      const p = intersection.position;
      const crossing = city.segments.filter((segment) => {
        for (const point of [segment.points[0], segment.points[segment.points.length - 1]]) {
          if (Math.hypot(point.x - p.x, point.z - p.z) < 0.5) return true;
        }
        return false;
      });
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

    // Crosswalks at signalled intersections.
    for (const intersection of city.intersections) {
      if (!intersection.signal) continue;
      const p = intersection.position;
      const size = 2.6;
      for (let s = -1; s <= 1; s += 2) {
        for (let e = -1; e <= 1; e += 2) {
          const x = p.x + s * size;
          const z = p.z + e * size;
          const y = roadLift + 0.08;
          for (let i = 0; i < 4; i += 1) {
            const offset = i * 0.55 - 0.85;
            pushQuad(crosswalkAttrs, crosswalkVertex,
              { x: x + offset, y, z: z - 0.4 },
              { x: x + offset, y, z: z + 0.4 },
              { x: x + offset + 0.26, y, z: z + 0.4 },
              { x: x + offset + 0.26, y, z: z - 0.4 },
              crosswalkColor,
            );
            crosswalkVertex += 4;
          }
        }
      }
    }

    finalizeAttrs(asphaltAttrs, asphaltVertex);
    finalizeAttrs(sidewalkAttrs, sidewalkVertex);
    finalizeAttrs(curbAttrs, curbVertex);
    finalizeAttrs(crosswalkAttrs, crosswalkVertex);

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
    const crosswalkMesh = new THREE.Mesh(buildAttrGeometry(crosswalkAttrs), crosswalkMaterial);
    crosswalkMesh.renderOrder = 2;
    root.add(crosswalkMesh);

    // Keep pickable geometry references for click metadata.
    this.roadMeshes = { asphalt: asphaltMesh, sidewalk: sidewalkMesh, curbs: curbMesh, crosswalks: crosswalkMesh };
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
      const lampMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2f33, emissive: 0x000000 });
      const positions = [3.18, 3.62, 4.06];
      for (let i = 0; i < 3; i += 1) {
        const lamp = new THREE.Mesh(lampGeometry, lampMaterial);
        lamp.position.set(0, positions[i], 0.24);
        group.add(lamp);
      }
      group.position.set(signal.position.x, 0, signal.position.z);
      group.userData = { kind: 'signal', id: signal.id, signalId: signal.id };
      root.add(group);
      this.pickables.push(group);
      this.signalMeshes.push({ group, signal, lampMaterial });
      this.geometryCache.push(pole.geometry, housing.geometry);
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
    const positions = new Set();
    for (const signal of city.signals) {
      positions.add(`${signal.position.x.toFixed(0)}-${signal.position.z.toFixed(0)}`);
    }
    const bounds = city.meta.bounds;
    const maxLamps = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap' ? 240 : 900;
    for (const street of city.streets) {
      if (positions.size >= maxLamps) break;
      if (street.highway !== 'primary' && street.highway !== 'secondary') continue;
      const axis = street.axis;
      const position = street.position;
      const count = 6;
      for (let i = 1; i < count; i += 1) {
        const t = i / count;
        const x = axis === 'x' ? position : bounds.minX + (bounds.maxX - bounds.minX) * t;
        const z = axis === 'z' ? position : bounds.minZ + (bounds.maxZ - bounds.minZ) * t;
        const side = (i % 2 === 0 ? 1 : -1) * (street.sidewalkW + street.asphaltWidth / 2 + 0.9);
        const lampX = axis === 'x' ? position + side : x;
        const lampZ = axis === 'z' ? position + side : z;
        positions.add(`${lampX.toFixed(0)}-${lampZ.toFixed(0)}`);
      }
    }
    const group = new THREE.Group();
    const lightPositions = [];
    for (const key of positions) {
      const [x, z] = key.split('-').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const pole = new THREE.Mesh(poleGeometry, poleMaterial);
      pole.position.y = 2.7;
      const bulb = new THREE.Mesh(bulbGeometry, bulbMaterial);
      bulb.position.y = 5.5;
      const lamp = new THREE.Group();
      lamp.add(pole, bulb);
      const y = this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0;
      lamp.position.set(x, y, z);
      group.add(lamp);
      this.lampBulbs.push(bulb);
    }
    for (const signal of city.signals.slice(0, 16)) {
      lightPositions.push({ x: signal.position.x, z: signal.position.z });
    }
    for (const lp of lightPositions) {
      const light = new THREE.PointLight(0xffc46a, 0, 46, 1.8);
      light.position.set(lp.x, 5.4, lp.z);
      group.add(light);
      this.lampLights.push(light);
    }
    root.add(group);
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
    const bounds = city.meta.bounds;
    const colors = ['#e5484d', '#12a594', '#ffb224', '#30a46c', '#8e4ec6', '#ff5c8a', '#f2c14e'];
    const flags = [];
    const random = mulberry32(Number(city.meta.seedInt || 1) + 3301);
    const classes = new Set(['primary', 'secondary']);
    if (city.meta.generator === 'procedural') {
      for (const street of city.streets) {
        if (!classes.has(street.highway)) continue;
        if (flags.length >= 700) break;
        const axis = street.axis;
        const position = street.position;
        const start = bounds[axis === 'x' ? 'minZ' : 'minX'] + 26;
        const end = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 26;
        for (let v = start; v < end; v += 3.6 + random() * 2.4) {
          if (flags.length >= 700) break;
          if (random() < 0.18) continue;
          const side = random() < 0.5 ? -1 : 1;
          const x = axis === 'x' ? position + side * (street.asphaltWidth / 2 + street.sidewalkW + 1.1) : v;
          const z = axis === 'z' ? position + side * (street.asphaltWidth / 2 + street.sidewalkW + 1.1) : v;
          if (Math.abs(x) > bounds.maxX - 4 || Math.abs(z) > bounds.maxZ - 4) continue;
          flags.push({
            x,
            z,
            axis,
            color: colors[Math.floor(random() * colors.length)],
          });
        }
      }
    } else {
      for (const segment of city.segments || []) {
        if (flags.length >= 2600) break;
        if (segment.highway === 'pedestrian' || segment.highway === 'footway' || segment.highway === 'cycleway' || segment.highway === 'motorway') continue;
        const a = segment.points[0];
        const b = segment.points[segment.points.length - 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 36 || length > 420) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const count = Math.min(16, Math.max(6, Math.round(length / 8)));
        for (let i = 0; i < count; i += 1) {
          if (flags.length >= 2600) break;
          if (random() < 0.1) continue;
          const t = (i + 0.5) / count;
          const side = (i % 2 === 0 ? 1 : -1);
          const offset = segment.sidewalkW + 0.9;
          const x = a.x + dx * t + nx * offset * side;
          const z = a.z + dz * t + nz * offset * side;
          flags.push({
            x,
            z,
            axis: Math.abs(dx) > Math.abs(dz) ? 'x' : 'z',
            color: colors[Math.floor(random() * colors.length)],
          });
        }
      }
    }
    if (!flags.length) return;
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

  buildTrees(root, city) {
    const random = mulberry32(Number(city.meta.seedInt) + 991);
    const treeData = [];
    const bounds = city.meta.bounds;
    if (city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap') {
      // Real map roads are arbitrary polylines; sample trees sparsely inside
      // the district instead of walking street-by-street.
      const width = bounds.maxX - bounds.minX;
      const depth = bounds.maxZ - bounds.minZ;
      const count = Math.min(420, Math.round((width * depth) / 2400));
      for (let i = 0; i < count; i += 1) {
        const x = bounds.minX + random() * width;
        const z = bounds.minZ + random() * depth;
        if (random() < 0.35) continue;
        treeData.push({ x, z, scale: 0.85 + random() * 0.75 });
      }
    } else {
      for (const street of city.streets) {
        const perpendicular = street.axis === 'x' ? 'z' : 'x';
        const position = street.position;
        const spacing = street.highway === 'primary' || street.highway === 'secondary' ? 58 : 44;
        const start = bounds[perpendicular === 'z' ? 'minZ' : 'minX'] + 18;
        const end = bounds[perpendicular === 'z' ? 'maxZ' : 'maxX'] - 18;
        for (let v = start; v < end; v += spacing + random() * 18) {
          if (random() < 0.12) continue;
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
    const topMaterial = new THREE.MeshStandardMaterial({ color: 0x8faf72, roughness: 0.85, flatShading: true });
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
    const props = [];
    const bounds = city.meta.bounds;
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const maxProps = realMap ? 800 : 900;
    const pushProp = (x, z) => {
      if (props.length >= maxProps) return;
      const y = this.terrain?.heightAt ? this.terrain.heightAt(x, z) + 0.05 : 0.05;
      const roll = random();
      const group = new THREE.Group();
      if (roll < 0.55) {
        const planter = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.55, 0.8), planterColor);
        planter.position.y = 0.28;
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.55, 6, 5), leafColor);
        leaf.position.y = 1.05;
        group.add(planter, leaf);
        const flowerColors = ['#e84393', '#ff4f6d', '#ffd23f', '#7a5cff'];
        const flowerMaterial = new THREE.MeshBasicMaterial({ color: flowerColors[Math.floor(random() * flowerColors.length)], fog: false });
        for (let f = 0; f < 3; f += 1) {
          const flower = new THREE.Mesh(new THREE.SphereGeometry(0.09, 5, 4), flowerMaterial);
          flower.position.set((random() - 0.5) * 0.7, 1.32, (random() - 0.5) * 0.7);
          group.add(flower);
        }
        this.geometryCache.push(flowerMaterial);
        this.geometryCache.push(planter.geometry, leaf.geometry);
      } else if (roll < 0.72) {
        const bench = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.62), benchColor);
        bench.position.y = 0.45;
        const back = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 0.08), benchColor);
        back.position.set(0, 0.8, -0.28);
        group.add(bench, back);
        this.geometryCache.push(bench.geometry, back.geometry);
      } else {
        const hydrant = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.75, 6), hydrantColor);
        hydrant.position.y = 0.4;
        group.add(hydrant);
        this.geometryCache.push(hydrant.geometry);
      }
      group.position.set(x, y, z);
      group.rotation.y = random() * Math.PI;
      group.userData = { kind: 'street-prop' };
      props.push(group);
    };
    if (realMap) {
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
          const offset = segment.sidewalkW + 0.8;
          pushProp(a.x + dx * t + nx * offset * side, a.z + dz * t + nz * offset * side);
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
        for (let v = start; v < end; v += 34 + random() * 22) {
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
    for (const prop of props) group.add(prop);
    root.add(group);
  }

  buildParkedCars(root, city) {
    const random = mulberry32(Number(city.meta.seedInt || 1) + 711);
    const spots = [];
    const bounds = city.meta.bounds;
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const maxCars = realMap ? 360 : 640;
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
        if (length < 30 || length > 420) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const heading = Math.atan2(dx, dz);
        const count = Math.min(6, Math.max(1, Math.round(length / 34)));
        for (let i = 0; i < count; i += 1) {
          if (spots.length >= maxCars) break;
          if (random() < 0.2) continue;
          const t = (i + 0.5) / count;
          const side = i % 2 === 0 ? 1 : -1;
          const offset = segment.width / 2 + 1.05;
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
        for (let v = start; v < end; v += 20 + random() * 12) {
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
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(spot.x, spot.z) : 0) + 0.34;
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
        const light = new THREE.PointLight(sign.color, 0, 20, 1.7);
        light.position.set(sign.x, sign.y - 0.5, sign.z);
        group.add(light);
        this.neonLights.push(light);
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
    const nightFactor = clamp((hour - 6) / 4, 0, 1) * clamp((20 - hour) / 4, 0, 1);
    const night = hour >= 19.5 || hour <= 6;
    const golden = Math.max(0, 1 - Math.abs(hour - 8.2) / 3.5) * 0.7;
    if (this.skyMesh) {
      const positions = this.skyMesh.geometry.attributes.position.array;
      const colors = this.skyMesh.geometry.attributes.color.array;
      const top = night ? new THREE.Color('#1e2450') : new THREE.Color('#5f9fd1');
      const mid = night ? new THREE.Color('#33396b') : new THREE.Color('#aed5e4');
      const bottom = night ? new THREE.Color('#5b4a7d') : new THREE.Color('#f6e7c9');
      const c = new THREE.Color();
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
    const sunColor = new THREE.Color().setHSL(0.09 + (1 - nightFactor) * 0.02, 0.55, 0.82);
    this.sun.color.copy(sunColor);
    this.hemi.color.copy(new THREE.Color('#e8f4ff').lerp(new THREE.Color('#7c8cf2'), 1 - nightFactor));
    this.hemi.intensity = 0.55 + nightFactor * 0.8;
    this.ambient.intensity = 0.08 + nightFactor * 0.26;
    this.rim.intensity = 0.1 + nightFactor * 0.55;
    for (const entry of this.nightEmissive) {
      entry.material.emissiveIntensity = night ? (entry.texture || entry.nightTexture ? 1.35 : 2.1) : 0;
    }
    for (const material of this.neonGlowMaterials) {
      material.opacity = night ? material.userData.nightOpacity : (material.userData.dayOpacity ?? 0.18);
    }
    for (const bulb of this.lampBulbs) {
      bulb.material.emissiveIntensity = night ? 1.2 : 0.12;
    }
    for (const light of this.lampLights) {
      light.intensity = night ? 2.2 : 0;
    }
    for (const light of this.neonLights) {
      light.intensity = night ? 7 : 0;
    }
    const fogColor = nightFactor < 0.28
      ? new THREE.Color('#2a2e58')
      : new THREE.Color('#cfe3ea').lerp(new THREE.Color('#8a9fb8'), 1 - nightFactor);
    this.scene.fog.color.copy(fogColor);
    if (this.scene.background) this.scene.background.copy(fogColor);
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
    if (this.signalMeshes) {
      const phase = Math.floor(this.signalPhaseClock / 8);
      for (const entry of this.signalMeshes) {
        const offset = entry.signal.phaseOffset || 0;
        const local = Math.floor((this.signalPhaseClock + offset) / 8) % 4;
        const state = local === 0 ? 'green' : local === 2 ? 'red' : 'yellow';
        const colors = { red: 0xe0443a, yellow: 0xe8b23a, green: 0x5bbf6a };
        entry.lampMaterial.emissive.set(colors[state]);
        entry.lampMaterial.emissiveIntensity = 0.9;
      }
    }
    if (traffic) traffic.update(delta);
    if (players) players.update(delta);
    if (this.water && this.water.material) {
      const wave = Math.sin(this.phaseClock * 0.6) * 0.05;
      this.water.position.y = 0.45 + wave;
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

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}
