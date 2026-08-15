#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const OUTPUT_ROOT = path.resolve(process.env.SF_DATASF_HEIGHT_QA_DIR ?? '.qa-sf-datasf-building-height-preview');
const THREE_PATH = path.join(ROOT, 'node_modules/three/build/three.module.js');
const THREE_CORE_PATH = path.join(ROOT, 'node_modules/three/build/three.core.js');
const LOADER_PATH = path.join(ROOT, 'node_modules/three/examples/jsm/loaders/GLTFLoader.js');
const BUFFER_GEOMETRY_UTILS_PATH = path.join(ROOT, 'node_modules/three/examples/jsm/utils/BufferGeometryUtils.js');
const FILES = Object.freeze({
  'ferry-baseline.glb': path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-presentation-proof-v1/epsg26910-1441-10893/epsg26910-1441-10893.building-presentation-proof.glb'),
  'ferry-candidate.glb': path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-building-height-preview-v1/epsg26910-1441-10893.datasf-height-preview.glb'),
  'district-baseline.glb': path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-presentation-proof-v1/epsg26910-1430-10882/epsg26910-1430-10882.building-presentation-proof.glb'),
  'district-candidate.glb': path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-building-height-preview-v1/epsg26910-1430-10882.datasf-height-preview.glb'),
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#101417;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#eff4f7}canvas{display:block}.label{position:fixed;top:20px;padding:8px 12px;background:rgba(8,12,15,.78);border:1px solid rgba(255,255,255,.24);font-weight:700;letter-spacing:.04em}.left{left:20px}.right{left:calc(50% + 20px)}.footer{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);padding:7px 12px;background:rgba(8,12,15,.82);white-space:nowrap;font-size:12px}.divider{position:fixed;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,.42)}</style>
<script type="importmap">{"imports":{"three":"/three.js"}}</script></head><body><div class="label left">BASELINE OSM EXTRUSION</div><div class="label right">DATASF hgt_median_m PREVIEW</div><div class="divider"></div><div class="footer">PREVIEW ONLY · locked camera/light · X/Z, bottoms, unmatched geometry, and indices unchanged</div><script type="module">
import * as THREE from 'three'; import { GLTFLoader } from '/GLTFLoader.js';
const role=new URLSearchParams(location.search).get('role'); if(!['ferry','district'].includes(role)) throw new Error('invalid role');
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true}); renderer.setSize(innerWidth,innerHeight); renderer.setPixelRatio(1); renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap; renderer.outputColorSpace=THREE.SRGBColorSpace; renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.08; document.body.prepend(renderer.domElement);
const loader=new GLTFLoader(); const load=(url)=>new Promise((resolve,reject)=>loader.load(url,resolve,undefined,reject)); const [baseline,candidate]=await Promise.all([load('/'+role+'-baseline.glb'),load('/'+role+'-candidate.glb')]);
const baselineBounds=new THREE.Box3().setFromObject(baseline.scene); const candidateBounds=new THREE.Box3().setFromObject(candidate.scene); const centre=baselineBounds.getCenter(new THREE.Vector3()); const size=baselineBounds.getSize(new THREE.Vector3()); const panelAspect=(innerWidth/2)/innerHeight; const fov=34; const camera=new THREE.PerspectiveCamera(fov,panelAspect,.1,5000); const direction=new THREE.Vector3(1.15,.78,1.25).normalize(); const fit=Math.max(size.x/panelAspect,size.y,size.z); camera.position.copy(centre).addScaledVector(direction,fit*2.05+35); camera.lookAt(centre); camera.updateProjectionMatrix();
function sceneFor(root){const scene=new THREE.Scene();scene.background=new THREE.Color(0xb7c0c5);scene.add(root);root.traverse((object)=>{if(object.isMesh){object.castShadow=true;object.receiveShadow=true;}});const hemi=new THREE.HemisphereLight(0xeaf3ff,0x52606a,1.55);scene.add(hemi);const sun=new THREE.DirectionalLight(0xfff0d3,3.1);sun.position.copy(centre).add(new THREE.Vector3(180,260,120));sun.target.position.copy(centre);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-300;sun.shadow.camera.right=300;sun.shadow.camera.top=300;sun.shadow.camera.bottom=-300;sun.shadow.camera.near=1;sun.shadow.camera.far=900;scene.add(sun,sun.target);const planeSize=Math.max(520,size.x*1.35,size.z*1.35);const plane=new THREE.Mesh(new THREE.PlaneGeometry(planeSize,planeSize),new THREE.MeshStandardMaterial({color:0x7e898d,roughness:.96,metalness:0}));plane.rotation.x=-Math.PI/2;plane.position.set(centre.x,baselineBounds.min.y-.04,centre.z);plane.receiveShadow=true;scene.add(plane);return scene;}
const scenes=[sceneFor(baseline.scene),sceneFor(candidate.scene)]; renderer.setScissorTest(true); for(let i=0;i<2;i++){renderer.setViewport(i*innerWidth/2,0,innerWidth/2,innerHeight);renderer.setScissor(i*innerWidth/2,0,innerWidth/2,innerHeight);renderer.render(scenes[i],camera);} renderer.setScissorTest(false);
const compact=(box)=>({min:box.min.toArray(),max:box.max.toArray(),size:box.getSize(new THREE.Vector3()).toArray()}); window.__QA_RESULT__={role,baselineBounds:compact(baselineBounds),candidateBounds:compact(candidateBounds),camera:{position:camera.position.toArray(),target:centre.toArray(),fov,aspect:panelAspect},renderer:{calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,programs:renderer.info.programs?.length??null},errors:[]}; window.__QA_READY__=true;
</script></body></html>`;

function serveFile(response, filePath, contentType) { response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }); createReadStream(filePath).pipe(response); }
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(pageHtml); return; }
  if (pathname === '/three.js') { serveFile(response, THREE_PATH, 'text/javascript'); return; }
  if (pathname === '/three.core.js') { serveFile(response, THREE_CORE_PATH, 'text/javascript'); return; }
  if (pathname === '/GLTFLoader.js') { serveFile(response, LOADER_PATH, 'text/javascript'); return; }
  if (pathname === '/utils/BufferGeometryUtils.js') { serveFile(response, BUFFER_GEOMETRY_UTILS_PATH, 'text/javascript'); return; }
  const filePath = FILES[pathname.slice(1)]; if (filePath) { serveFile(response, filePath, 'model/gltf-binary'); return; }
  response.writeHead(404); response.end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object');
await mkdir(OUTPUT_ROOT, { recursive: true }); const browser = await chromium.launch({ headless: true }); const report = { schemaVersion: 1, kind: 'sf-datasf-building-height-preview-qa', status: 'matched-side-by-side-captured', viewport: [1440, 810], captures: [] };
try {
  for (const role of ['ferry', 'district']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 }); const errors = []; page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); }); page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto(`http://127.0.0.1:${address.port}/?role=${role}`, { waitUntil: 'load' }); await page.waitForFunction(() => window.__QA_READY__ === true, null, { timeout: 10000 }).catch((error) => { throw new Error(`${role} renderer did not become ready: ${error.message}; browser errors: ${JSON.stringify(errors)}`); }); const diagnostics = await page.evaluate(() => window.__QA_RESULT__); assert.deepEqual(errors, []); assert.deepEqual(diagnostics.errors, []);
    const screenshotPath = path.join(OUTPUT_ROOT, `${role}-baseline-vs-datasf-height.png`); const screenshotBytes = await page.screenshot({ path: screenshotPath }); assert(screenshotBytes.length > 50000); const baselineHorizontal = diagnostics.baselineBounds.size.filter((_, axis) => axis !== 1); const candidateHorizontal = diagnostics.candidateBounds.size.filter((_, axis) => axis !== 1); assert(baselineHorizontal.every((value, index) => Math.abs(value - candidateHorizontal[index]) <= 1e-5));
    report.captures.push({ role, screenshot: screenshotPath, bytes: screenshotBytes.length, sha256: `sha256:${sha256(screenshotBytes)}`, diagnostics }); await page.close();
  }
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
await writeFile(path.join(OUTPUT_ROOT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
