/* Renders the streamed city around the car: ground by land use, roads, sidewalks, markings, bridges, buildings with
   procedural windows, trees, trams and rails, traffic lights, plus far terrain (Vitosha) and the skyline of tall buildings. */
import * as THREE from './vendor/three.module.min.js';
import { makeSky, makeTextures, treeGeometries, canvas, texFrom } from './scene.js';
import { rngS } from './city.js';

const PAL = ['#e3d6b6', '#d8b67c', '#d9ae9e', '#c9c7c1', '#ebe8e1', '#b3bdc3', '#cbc4b4', '#b9b7af', '#a8624b', '#7894a8', '#53687a', '#c6c4bd', '#8ea2a1', '#ede1c6', '#e3cf9e', '#d4ccba', '#d8ad44'].map(c => new THREE.Color(c));
const ROOF = [new THREE.Color('#8f8c86'), new THREE.Color('#7b7975'), new THREE.Color('#a24f36'), new THREE.Color('#66645f')];
const BAY = [3, 3.2, 3.6, 1.55, 6, 2.9, 4];
const GROUND_COL = ['#aaa594', '#76a050', '#4d7a39', '#5d90b2', '#cdc6b6', '#8e8f91', '#8b8270', '#62a04a', '#b9b072', '#6c8b58', '#aca79d', '#cdbf96', '#8b8d8f', '#86a05e', '#beb59f'];
const GROUND_ORDER = [8, 10, 14, 13, 1, 9, 2, 7, 6, 11, 5, 12, 4, 3];
const URBAN = new THREE.Color('#aaa594');

/* growable vertex buffer -> indexed BufferGeometry */
class Buf {
  constructor() { this.p = []; this.n = []; this.c = []; this.uv = []; this.w = []; this.i = []; this.nv = 0 }
  v(x, y, z, nx, ny, nz, col, u = 0, v = 0, w = 0) { this.p.push(x, y, z); this.n.push(nx * 127 | 0, ny * 127 | 0, nz * 127 | 0); this.c.push(col.r * 255 | 0, col.g * 255 | 0, col.b * 255 | 0); this.uv.push(u, v); this.w.push(w); return this.nv++ }
  t(a, b, c) { this.i.push(a, b, c) }
  /* triangle facing up (+y) whatever the vertex order */
  up(a, b, c) { const P = this.p, ax = P[a * 3], az = P[a * 3 + 2], ny = (P[b * 3 + 2] - az) * (P[c * 3] - ax) - (P[b * 3] - ax) * (P[c * 3 + 2] - az); if (ny >= 0) this.i.push(a, b, c); else this.i.push(a, c, b) }
  quadUp(a, b, c, d) { this.up(a, b, c); this.up(a, c, d) }
  /* quad a-b-c-d (in order around it) facing (nx,ny,nz) */
  face(a, b, c, d, nx, ny, nz) {
    const P = this.p, ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz >= 0) this.i.push(a, b, c, a, c, d); else this.i.push(a, c, b, a, d, c);
  }
  get empty() { return !this.i.length }
  geometry(withUv = false, withW = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(this.n), 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.c), 3, true));
    if (withUv) g.setAttribute(withW ? 'wuv' : 'uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    if (withW) g.setAttribute('wst', new THREE.BufferAttribute(new Uint8Array(this.w), 1));
    g.setIndex(this.nv > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.i), 1) : new THREE.BufferAttribute(new Uint16Array(this.i), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/* fog that reaches much further (for far terrain and the skyline) */
const HAZE = (a0, a1, cap, n2, f2, cap2) => `#ifdef USE_FOG
 float fogFactor = max(smoothstep(${a0.toFixed(1)}, ${a1.toFixed(1)}, vFogDepth) * ${cap.toFixed(3)}, smoothstep(${n2.toFixed(1)}, ${f2.toFixed(1)}, vFogDepth) * ${cap2.toFixed(3)});
 gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
#endif`;
function farFog(mat, ...h) {
  mat.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', HAZE(...h)) };
  mat.customProgramCacheKey = () => 'haze' + h.join('_');
  return mat;
}
/* walls with procedural windows: uv = (bays along the wall, floors), wst = window style */
function windowMaterial(far, hideTex) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = sh => {
    sh.vertexShader = 'attribute float wst; attribute vec2 wuv; varying float vW; varying vec2 vU;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vW = wst; vU = wuv;');
    if (hideTex) {
      // far-city boxes vanish where the detailed tile is built
      sh.uniforms.builtTex = { value: hideTex };
      sh.vertexShader = 'uniform sampler2D builtTex; attribute float rid;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n if (texture2D(builtTex, vec2((rid + .5) / 512., .5)).r > .5) transformed = vec3(0., -1e5, 0.);');
    }
    sh.fragmentShader = 'varying float vW; varying vec2 vU;\nfloat hsh(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      if (vW > .5 && vU.y > 0.) {
        vec2 f = fract(vU); float fl = floor(vU.y); float st = floor(vW + .5); float win = 0.; float h = hsh(floor(vU));
        if (st == 1.) { win = step(.3, f.x) * step(f.x, .7) * step(.3, f.y) * step(f.y, .78); if (fl < .5) win = step(.08, f.x) * step(f.x, .92) * step(.08, f.y) * step(f.y, .82); }
        else if (st == 2.) { win = step(.16, f.x) * step(f.x, .64) * step(.32, f.y) * step(f.y, .74); if (f.x < .025 || f.y < .025) diffuseColor.rgb *= .82; }
        else if (st == 3.) { win = step(.06, f.x) * step(.1, f.y); }
        else if (st == 4.) { win = step(.08, f.x) * step(f.x, .92) * step(.68, f.y) * step(f.y, .84); }
        else if (st == 5.) { win = step(.34, f.x) * step(f.x, .66) * step(.34, f.y) * step(f.y, .74); }
        vec3 glass = st == 3. ? diffuseColor.rgb * .75 + vec3(.06, .09, .13) * (.6 + h) : mix(vec3(.14, .19, .25), vec3(.42, .5, .58), h * h);
        diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
      }`);
    if (far) sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', HAZE(...far));
  };
  m.customProgramCacheKey = () => 'windows' + (far ? far.join('_') : '') + (hideTex ? 'hide' : '');
  return m;
}

/* low-poly city trees (about 26 triangles), vertex coloured for instancing */
let CTREES = null;
function cityTrees() {
  if (CTREES) return CTREES;
  const mk = parts => {
    let P = [], N = [], C = [];
    for (const [geo, color] of parts) {
      const g = geo.toNonIndexed(); g.computeVertexNormals(); const cc = new THREE.Color(color), pa = g.attributes.position.array, na = g.attributes.normal.array;
      for (let k = 0; k < pa.length; k++) { P.push(pa[k]); N.push(na[k]) } for (let k = 0; k < pa.length / 3; k++) C.push(cc.r, cc.g, cc.b); g.dispose();
    }
    const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); out.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); return out;
  };
  const trunk = new THREE.CylinderGeometry(.14, .22, 3.2, 4, 1, true).translate(0, 1.6, 0);
  const decGeo = mk([[trunk, 0x5a4530], [new THREE.IcosahedronGeometry(2.7, 0).scale(1, .9, 1).translate(0, 5.3, 0), 0x4b6e32]]);
  const conGeo = mk([[trunk.clone(), 0x4a3a2a], [new THREE.ConeGeometry(2.3, 7.5, 6, 1, true).translate(0, 6.2, 0), 0x2f4f2a]]);
  return CTREES = { decGeo, conGeo };
}

export class CityWorld {
  constructor(city, opts = {}) {
    this.city = city; this.q = opts.quality || 'medium'; this.group = new THREE.Group();
    this.th = { sun: [.72, .58], sky: '#8fb6dc', fog: '#c9d5de' };
    this.R_LOAD = this.q === 'high' ? 1350 : this.q === 'medium' ? 1050 : 760;
    this.R_DROP = this.R_LOAD + 450;
    this.budget = this.q === 'low' ? 5 : 7;
    this.built = new Map(); this.queue = []; this.jobs = null; this.startLights = [];
    this.terrainAt = true;
    const T = makeTextures(); this.tex = T;
    this.mat = {
      bld: windowMaterial(null),
      road: new THREE.MeshLambertMaterial({ map: T.asphalt, color: new THREE.Color('#a4a6a8'), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
      side: new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 }),
      mark: new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
      flat: new THREE.MeshLambertMaterial({ vertexColors: true }),
      dome: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: .55, roughness: .38 }),
      tree: new THREE.MeshLambertMaterial({ vertexColors: true }),
    };
    this.buildSky();
    this.buildFar();
    this.buildSkyline();
    this.trees = cityTrees();
    this.treeR = this.q === 'high' ? 900 : this.q === 'medium' ? 650 : 420;
    this.sigGeo = this.signalGeometry();
  }
  buildSky() { const k = makeSky(this.th); this.sunDir = k.sunDir; this.sky = k.sky; this.fogColor = k.fogColor; this.group.add(k.sky) }
  envScene() {
    const s = new THREE.Scene(); s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.sky.material.clone()));
    const gm = new THREE.Mesh(new THREE.CircleGeometry(10, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color('#8a8678') })); gm.rotation.x = -Math.PI / 2; gm.position.y = -.5; s.add(gm);
    return s;
  }
  ground(x, z) { return { h: this.city.terrainH(x, z) } }
  /* ---------- far terrain: the whole elevation grid, sunk under the streamed tiles inside the city ---------- */
  buildFar() {
    const c = this.city, T = c.T, st = this.q === 'low' ? 6 : this.q === 'medium' ? 5 : 4, nx = Math.floor((T.nx - 1) / st) + 1, nz = Math.floor((T.nz - 1) / st) + 1;
    const b = new Buf(), col = new THREE.Color(), fields = new THREE.Color('#87a05a'), forest = new THREE.Color('#3d6634'), pine = new THREE.Color('#33552e'), alp = new THREE.Color('#8f9b6c'), rock = new THREE.Color('#9b968a');
    const idx = [];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = T.x0 + i * st * T.s, z = T.z0 + j * st * T.s; let h = c.terrainH(x, z);
      const inside = c.inArea(x, z), d = inside ? 0 : this.distOut(x, z);
      const sink = d < 400 ? 7 * (1 - d / 400) : 0;
      const hx = c.terrainH(x + 60, z) - c.terrainH(x - 60, z), hz = c.terrainH(x, z + 60) - c.terrainH(x, z - 60), nl = Math.hypot(hx / 120, hz / 120, 1);
      if (inside || d < 250) col.copy(URBAN).multiplyScalar(.86);
      else if (h > 1950) col.copy(rock).lerp(alp, .4);
      else if (h > 1700) col.copy(alp);
      else if (h > 1150) col.copy(pine);
      else if (h > 760) col.copy(forest).lerp(fields, Math.max(0, (900 - h) / 300));
      else col.copy(fields);
      col.multiplyScalar(.92 + .08 * Math.sin(x * .0021 + z * .0017));
      idx.push(b.v(x, h - sink, z, -hx / 120 / nl, 1 / nl, -hz / 120 / nl, col));
    }
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i; b.quadUp(a, a + 1, a + nx + 1, a + nx) }
    const m = farFog(new THREE.MeshLambertMaterial({ vertexColors: true }), 250, this.R_LOAD, .82, 5000, 34000, .9);
    const mesh = new THREE.Mesh(b.geometry(), m); mesh.frustumCulled = false; mesh.renderOrder = -.5;
    this.far = mesh; this.group.add(mesh);
  }
  distOut(x, z) { const e = this.city.nearestAreaEdge(x, z); return e.d }
  /* ---------- skyline: tall buildings always visible, hidden where the detailed tile is built ---------- */
  buildSkyline() {
    const c = this.city, buf = c.skyBuf; this.builtData = new Uint8Array(512 * 4);
    this.builtTex = new THREE.DataTexture(this.builtData, 512, 1); this.builtTex.needsUpdate = true;
    if (!buf) return;
    const n = new DataView(buf).getUint32(4, true); let o = 8;
    const P = new Int16Array(buf, o, n * 8); o += n * 16; const B = new Int16Array(buf, o, n); o += n * 2; const Hh = new Uint16Array(buf, o, n); o += n * 2;
    const RID = new Uint16Array(buf, o, n); o += n * 2; const COL = new Uint8Array(buf, o, n); o += n; const ST = new Uint8Array(buf, o, n);
    const minH = this.q === 'low' ? 24 : 0, b = new Buf(), rid = [], X = new Float32Array(4), Z = new Float32Array(4);
    for (let k = 0; k < n; k++) {
      if (Hh[k] / 10 < minH) continue;
      for (let m = 0; m < 4; m++) { X[m] = P[k * 8 + m * 2] / 2; Z[m] = P[k * 8 + m * 2 + 1] / 2 }
      let ar = 0; for (let m = 0; m < 4; m++) ar += X[m] * Z[(m + 1) % 4] - X[(m + 1) % 4] * Z[m];
      if (ar < 0) { let t = X[1]; X[1] = X[3]; X[3] = t; t = Z[1]; Z[1] = Z[3]; Z[3] = t }
      const v0 = b.nv, base = B[k] / 10;
      this.addBuilding(b, X, Z, 0, 4, base, base + Hh[k] / 10, base - 12, ST[k] === 5 ? 1 : ST[k], PAL[COL[k]] || PAL[3], 0, 1);
      for (let v = v0; v < b.nv; v++) rid.push(RID[k]);
    }
    const geo = b.geometry(true, true); geo.setAttribute('rid', new THREE.BufferAttribute(new Uint16Array(rid), 1));
    const mesh = new THREE.Mesh(geo, windowMaterial([250, this.R_LOAD * 1.35, .9, 3000, 16000, 1], this.builtTex)); mesh.frustumCulled = false; mesh.name = 'farcity';
    this.farCity = mesh; this.group.add(mesh);
  }
  markBuilt(key, on) { const i = this.city.regIndex.get(key); if (i == null || !this.builtData) return; this.builtData[i * 4] = on ? 255 : 0; this.builtTex.needsUpdate = true }
  /* ---------- streaming ---------- */
  update(x, z, dt) {
    const c = this.city, G = c.REG, R = this.R_LOAD;
    this.cx = x; this.cz = z;
    // what should be loaded, nearest first
    const want = [];
    for (let i = Math.floor((x - R) / G); i <= Math.floor((x + R) / G); i++) for (let j = Math.floor((z - R) / G); j <= Math.floor((z + R) / G); j++) {
      if (!c.hasRegion(i, j)) continue;
      const dx = Math.max(i * G - x, 0, x - (i + 1) * G), dz = Math.max(j * G - z, 0, z - (j + 1) * G), d = Math.hypot(dx, dz);
      if (d <= R) want.push([d, i, j]);
    }
    want.sort((a, b) => a[0] - b[0]);
    let inflight = c.loading.size;
    for (const [d, i, j] of want) {
      const key = i + '_' + j;
      if (!c.regions.has(key) && !c.loading.has(key) && inflight < 3) { inflight++; c.loadRegion(i, j).catch(e => console.warn(e)) }
      else if (c.regions.has(key) && !this.built.has(key) && !this.queue.includes(key) && this.jobs?.key !== key) this.queue.push(key);
    }
    this.queue.sort((a, b) => this.regionDist(a) - this.regionDist(b));
    // trees only near the car; drop far tiles
    for (const [key, g] of this.built) { const vis = this.regionDist(key) < this.treeR; for (const t of g.userData.trees) t.visible = vis }
    for (const [key, g] of this.built) if (this.regionDist(key) > this.R_DROP) this.dispose(key);
    for (const key of [...c.regions.keys()]) if (!this.built.has(key) && this.regionDist(key) > this.R_DROP + 200) c.unloadRegion(key);
    // build within a time budget
    const t0 = performance.now();
    while (performance.now() - t0 < this.budget) {
      if (!this.jobs) { const key = this.queue.shift(); if (!key) break; const Rg = c.regions.get(key); if (!Rg) continue; this.jobs = { key, it: this.buildRegion(Rg) } }
      const r = this.jobs.it.next(); if (r.done) this.jobs = null;
    }
  }
  regionDist(key) { const [i, j] = key.split('_').map(Number), G = this.city.REG; return Math.hypot(Math.max(i * G - this.cx, 0, this.cx - (i + 1) * G), Math.max(j * G - this.cz, 0, this.cz - (j + 1) * G)) }
  /* load and build everything within r metres right away (behind the loading screen) */
  async preload(x, z, r, onProgress) {
    const c = this.city, G = c.REG, keys = [];
    for (let i = Math.floor((x - r) / G); i <= Math.floor((x + r) / G); i++) for (let j = Math.floor((z - r) / G); j <= Math.floor((z + r) / G); j++) if (c.hasRegion(i, j)) keys.push([i, j]);
    await Promise.all(keys.map(([i, j]) => c.loadRegion(i, j)));
    this.cx = x; this.cz = z; let n = 0;
    for (const [i, j] of keys) { const key = i + '_' + j; if (!this.built.has(key)) { const it = this.buildRegion(c.regions.get(key)); while (!it.next().done); } onProgress?.(++n / keys.length) }
  }
  isReady(x, z) { const k = Math.floor(x / this.city.REG) + '_' + Math.floor(z / this.city.REG); return this.built.has(k) || !this.city.hasRegion(...k.split('_').map(Number)) }
  dispose(key) {
    const g = this.built.get(key); if (!g) return;
    g.traverse(o => { if (o.isInstancedMesh) o.dispose(); else if (o.geometry && !o.userData.shared) o.geometry.dispose(); if (o.material?.userData?.own) { o.material.map?.dispose(); o.material.dispose() } });
    this.group.remove(g); this.built.delete(key);
    this.markBuilt(key, false);
  }
  disposeAll() { for (const k of [...this.built.keys()]) this.dispose(k) }
  /* ---------- one tile ---------- */
  *buildRegion(R) {
    const c = this.city, grp = new THREE.Group(), q = this.q;
    grp.userData.key = R.key; grp.userData.trees = [];
    // ground
    const gm = {}; yield* this.groundGen(R, gm); gm.mesh.name = 'ground'; grp.add(gm.mesh); yield;
    // roads, sidewalks, markings, bridges
    const road = new Buf(), side = new Buf(), mark = new Buf(), brg = new Buf();
    for (let p = 0; p < R.nRoads; p++) { this.addRoad(R, p, road, side, mark, brg); if (p % 90 === 89) yield }
    yield; for (const cr of R.cross) this.addCrossing(mark, cr);
    for (const [b, m, nm] of [[road, this.mat.road, 'road'], [side, this.mat.side, 'side'], [mark, this.mat.mark, 'mark'], [brg, this.mat.flat, 'bridge']]) if (!b.empty) { const mesh = new THREE.Mesh(b.geometry(b === road), m); mesh.name = nm; mesh.receiveShadow = q !== 'low'; grp.add(mesh) }
    yield;
    // rails & trams
    const rl = new Buf(); for (let l = 0; l < R.nL; l++) { this.addLine(R, l, rl); if (l % 40 === 39) yield }
    if (!rl.empty) { const m = new THREE.Mesh(rl.geometry(), this.mat.mark); m.name = 'rail'; m.receiveShadow = q !== 'low'; grp.add(m) }
    yield;
    // buildings
    const bb = new Buf(), dome = new Buf();
    for (let b = 0; b < R.nB; b++) {
      const s0 = R.bs[b], n = R.bs[b + 1] - s0, roofOnly = R.bFl[b] & 1;
      const base = roofOnly ? R.bTop[b] - .6 : R.bMin[b] - R.bBase[b] > 2.5 ? R.bMin[b] : R.bBase[b] - 1.6;
      const jitter = .93 + ((b * 2654435761) >>> 0) % 1000 / 1000 * .12;
      const col = PAL[R.bCol[b]] || PAL[3]; const cc = this._cc || (this._cc = new THREE.Color()); cc.copy(col).multiplyScalar(jitter);
      if (R.bFl[b] & 16) cc.setRGB(R.bWc[b * 3] / 255, R.bWc[b * 3 + 1] / 255, R.bWc[b * 3 + 2] / 255, THREE.SRGBColorSpace).lerp(col, .2);
      let rc = null; if (R.bFl[b] & 32) { rc = this._rcc || (this._rcc = new THREE.Color()); rc.setRGB(R.bRc[b * 3] / 255, R.bRc[b * 3 + 1] / 255, R.bRc[b * 3 + 2] / 255, THREE.SRGBColorSpace) }
      this.addBuilding(bb, R.bx, R.bz, s0, n, R.bBase[b], R.bTop[b], base, R.bSt[b], cc, R.bFl[b], 0, R.bRs[b], rc, R.bRh[b], dome);
      if (roofOnly) { // canopies (platforms, petrol stations): posts at the corners
        const pc = this._post || (this._post = new THREE.Color('#6f7375')), step = Math.max(1, Math.floor(n / 10));
        for (let m = 0; m < n; m += step) { const x = R.bx[s0 + m], z = R.bz[s0 + m], cx2 = R.bx[s0 + (m + 1) % n] - x, cz2 = R.bz[s0 + (m + 1) % n] - z, L = Math.hypot(cx2, cz2) || 1; this.box(bb, x + cx2 / L * .5, z + cz2 / L * .5, c.terrainH(x, z) - .4, R.bTop[b] - .5, .14, .14, 1, 0, pc) }
      }
      if (R.bFl[b] & 4) this.addDome(dome, R, b);
      if (b % 80 === 79) yield;
    }
    if (!bb.empty) { const m = new THREE.Mesh(bb.geometry(true, true), this.mat.bld); m.name = 'bld'; m.castShadow = q === 'high'; m.receiveShadow = q !== 'low'; grp.add(m) }
    if (!dome.empty) grp.add(new THREE.Mesh(dome.geometry(), this.mat.dome));
    yield;
    // trees and traffic lights
    const cap = q === 'high' ? 1800 : q === 'medium' ? 1000 : 380, nT = Math.min(R.nT, cap), stepT = R.nT / Math.max(1, nT);
    if (nT) {
      const con = [], dec = [];
      for (let k = 0; k < nT; k++) { const t = Math.floor(k * stepT); (R.trees[t * 3 + 2] && (t % 3) ? con : dec).push(t) }
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
      for (const [list, geo, tall] of [[con, this.trees.conGeo, 1.35], [dec, this.trees.decGeo, .95]]) {
        if (!list.length) continue;
        const im = new THREE.InstancedMesh(geo, this.mat.tree, list.length); im.userData.shared = true; im.name = 'trees';
        list.forEach((t, k) => { const x = R.trees[t * 3], z = R.trees[t * 3 + 1], h = ((t * 2246822519) >>> 0) % 1000 / 1000, s = tall * (.62 + h * .5); Q.setFromAxisAngle(Y, h * 6.283); S.set(s, s * (.9 + h * .25), s); P.set(x, c.terrainH(x, z) - .35, z); M.compose(P, Q, S); im.setMatrixAt(k, M); col.setHSL(.24 + h * .07, .32 + h * .18, .4 + h * .14); im.setColorAt(k, col) });
        im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.castShadow = q === 'high'; grp.add(im); grp.userData.trees.push(im);
      }
    }
    if (R.sig.length) {
      const im = new THREE.InstancedMesh(this.sigGeo, this.mat.flat, R.sig.length); im.userData.shared = true;
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), P = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
      R.sig.forEach(([x, z, h, dx, dz, hw], k) => { const lx = dz, lz = -dx, off = hw + 1.1; P.set(x - lx * off, h, z - lz * off); Q.setFromAxisAngle(Y, Math.atan2(-dx, -dz)); M.compose(P, Q, S); im.setMatrixAt(k, M) });
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); grp.add(im);
    }
    this.group.add(grp); this.built.set(R.key, grp); this.markBuilt(R.key, true);
  }
  *groundGen(R, out) {
    const c = this.city, G = c.REG, N = 40, step = G / N, size = this.q === 'low' ? 256 : 512;
    const [cv, g] = canvas(size, size), k = size / G;
    g.fillStyle = GROUND_COL[0]; g.fillRect(0, 0, size, size);
    // speckle for texture
    const r = rngS(R.i * 7 + R.j * 131 + 3);
    for (let n = 0; n < 1400; n++) { g.fillStyle = r() < .5 ? 'rgba(90,85,70,.08)' : 'rgba(255,250,235,.07)'; g.fillRect(r() * size, r() * size, 2 + r() * 10, 2 + r() * 10) }
    const draw = kind => {
      g.fillStyle = GROUND_COL[kind]; g.beginPath(); let any = false;
      for (let a = 0; a < R.nA; a++) {
        if (R.ak[a] !== kind) continue;
        const s0 = R.as[a], s1 = R.as[a + 1]; any = true;
        g.moveTo((R.ax[s0] - R.x0) * k, (R.az[s0] - R.z0) * k);
        for (let m = s0 + 1; m < s1; m++) g.lineTo((R.ax[m] - R.x0) * k, (R.az[m] - R.z0) * k);
        g.closePath();
      }
      if (any) g.fill('evenodd');
    };
    for (const kind of GROUND_ORDER) draw(kind);
    // pitches get white lines, rivers are painted as water
    g.strokeStyle = GROUND_COL[3]; g.lineCap = 'round'; g.lineJoin = 'round';
    for (let l = 0; l < R.nL; l++) if ((R.lk[l] & 15) === 3) { const s0 = R.ls[l], s1 = R.ls[l + 1]; g.lineWidth = Math.max(1.5, R.lh[s0] * k); g.beginPath(); g.moveTo((R.lx[s0] - R.x0) * k, (R.lz[s0] - R.z0) * k); for (let m = s0 + 1; m < s1; m++) g.lineTo((R.lx[m] - R.x0) * k, (R.lz[m] - R.z0) * k); g.stroke() }
    const tex = texFrom(cv, false); tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.anisotropy = 4;
    yield;
    const b = new Buf(), white = new THREE.Color(1, 1, 1);
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const x = R.x0 + i * step, z = R.z0 + j * step;
        let h = c.terrainH(x, z) - .3;
        // never above a nearby road (the grid is coarser than the streets)
        const lo = this.roadFloor(R, x, z); if (lo < h) h = lo;
        const gx = c.terrainH(x + 20, z) - c.terrainH(x - 20, z), gz = c.terrainH(x, z + 20) - c.terrainH(x, z - 20), nl = Math.hypot(gx / 40, gz / 40, 1);
        b.v(x, h, z, -gx / 40 / nl, 1 / nl, -gz / 40 / nl, white, i / N, 1 - j / N);
      }
      if (j % 3 === 2) yield;
    }
    const W = N + 1;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * W + i; b.quadUp(a, a + 1, a + W + 1, a + W) }
    const geo = b.geometry(true);
    const mat = new THREE.MeshLambertMaterial({ map: tex }); mat.userData.own = true;
    const m = new THREE.Mesh(geo, mat); m.receiveShadow = this.q !== 'low';
    out.mesh = m;
  }
  /* lowest road surface (minus a margin) within reach of a ground vertex */
  roadFloor(R, x, z) {
    const c = this.city; let lo = 1e9;
    for (const Rr of c.near(x, z)) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const cell = Rr.cellAt(x + dx * 24, z + dz * 24); if (!cell) continue;
      for (const s of cell.s) {
        const p = Rr.segP[s]; if (Rr.pel[p] > 1.2) continue;
        const d = c.segDist(Rr, s, x, z); if (d > Rr.phw[p] + Rr.psw[p] + 30) continue;
        const h = Rr.rh[s] + (Rr.rh[s + 1] - Rr.rh[s]) * c._t - .3; if (h < lo) lo = h;
      }
    }
    return lo;
  }
  addRoad(R, p, road, side, mark, brg) {
    const c = this.city, s0 = R.ps[p], s1 = R.ps[p + 1], n = s1 - s0; if (n < 2) return;
    const hw = R.phw[p], sw = R.psw[p], cls = R.pc[p], flags = R.pf[p], lanes = R.pl[p];
    const X = R.rx, Z = R.rz, H = R.rh, J = R.rj;
    // tangents and arc length
    const tx = new Float32Array(n), tz = new Float32Array(n), S = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const a = s0 + Math.max(0, k - 1), b = s0 + Math.min(n - 1, k + 1); let dx = X[b] - X[a], dz = Z[b] - Z[a]; const l = Math.hypot(dx, dz) || 1; tx[k] = dx / l; tz[k] = dz / l;
      if (k) S[k] = S[k - 1] + Math.hypot(X[s0 + k] - X[s0 + k - 1], Z[s0 + k] - Z[s0 + k - 1]);
    }
    // asphalt (world-space uv so overlapping streets match at junctions)
    const white = this._w || (this._w = new THREE.Color(1, 1, 1)); const ids = [];
    for (let k = 0; k < n; k++) { const i = s0 + k, nx = tz[k], nz = -tx[k], y = H[i] + .02; ids.push(road.v(X[i] + nx * hw, y, Z[i] + nz * hw, 0, 1, 0, white, (X[i] + nx * hw) / 7, (Z[i] + nz * hw) / 7), road.v(X[i] - nx * hw, y, Z[i] - nz * hw, 0, 1, 0, white, (X[i] - nx * hw) / 7, (Z[i] - nz * hw) / 7)) }
    for (let k = 0; k < n - 1; k++) road.quadUp(ids[k * 2], ids[k * 2 + 1], ids[k * 2 + 3], ids[k * 2 + 2]);
    // junction zones along this piece (no sidewalks/markings there)
    const jz = []; for (let k = 0; k < n; k++) if (J[s0 + k] > 0) jz.push([S[k], J[s0 + k]]);
    const inJ = (s, extra) => { for (const [js, jw] of jz) if (Math.abs(s - js) < jw + extra) return true; return false };
    // sidewalks with a kerb face
    if (sw > 0) {
      const sc = this._sc || (this._sc = new THREE.Color('#bdb9b0')), kc = this._kc || (this._kc = new THREE.Color('#d6d3cb'));
      for (const sg of [1, -1]) {
        for (let k = 0; k < n - 1; k++) {
          const sm = (S[k] + S[k + 1]) / 2; if (inJ(sm, sw + 1.5)) continue;
          const i = s0 + k, i2 = i + 1, nx0 = tz[k] * sg, nz0 = -tx[k] * sg, nx1 = tz[k + 1] * sg, nz1 = -tx[k + 1] * sg, y0 = H[i] + .15, y1 = H[i2] + .15;
          const a = side.v(X[i] + nx0 * hw, y0, Z[i] + nz0 * hw, 0, 1, 0, sc), b = side.v(X[i] + nx0 * (hw + sw), y0, Z[i] + nz0 * (hw + sw), 0, 1, 0, sc);
          const cc = side.v(X[i2] + nx1 * (hw + sw), y1, Z[i2] + nz1 * (hw + sw), 0, 1, 0, sc), d = side.v(X[i2] + nx1 * hw, y1, Z[i2] + nz1 * hw, 0, 1, 0, sc);
          side.quadUp(a, b, cc, d);
          // kerb face (vertical, facing the road)
          if (this.q !== 'high') continue;
          const e = side.v(X[i] + nx0 * hw, H[i] - .05, Z[i] + nz0 * hw, -nx0, 0, -nz0, kc), f = side.v(X[i2] + nx1 * hw, H[i2] - .05, Z[i2] + nz1 * hw, -nx1, 0, -nz1, kc);
          const e2 = side.v(X[i] + nx0 * hw, y0, Z[i] + nz0 * hw, -nx0, 0, -nz0, kc), f2 = side.v(X[i2] + nx1 * hw, y1, Z[i2] + nz1 * hw, -nx1, 0, -nz1, kc);
          side.face(e, f, f2, e2, -nx0, 0, -nz0);
        }
      }
    }
    // markings
    const wc = this._mw || (this._mw = new THREE.Color('#eeeeea'));
    const line = (off, dash, gap, width, extraJ = 2) => {
      const period = dash + gap;
      for (let k = 0; k < n - 1; k++) {
        const L = S[k + 1] - S[k]; if (L < .05) continue;
        let s = gap ? Math.ceil(S[k] / period) * period : S[k];
        while (s < S[k + 1]) {
          const e = gap ? Math.min(s + dash, S[k + 1]) : S[k + 1];
          if (!inJ((s + e) / 2, extraJ)) {
            const f0 = (s - S[k]) / L, f1 = (e - S[k]) / L, i = s0 + k;
            const px = t => X[i] + (X[i + 1] - X[i]) * t, pz = t => Z[i] + (Z[i + 1] - Z[i]) * t, py = t => H[i] + (H[i + 1] - H[i]) * t + .05;
            const nx = tz[k], nz = -tx[k];
            const a = mark.v(px(f0) + nx * (off - width / 2), py(f0), pz(f0) + nz * (off - width / 2), 0, 1, 0, wc), b = mark.v(px(f0) + nx * (off + width / 2), py(f0), pz(f0) + nz * (off + width / 2), 0, 1, 0, wc);
            const cc = mark.v(px(f1) + nx * (off + width / 2), py(f1), pz(f1) + nz * (off + width / 2), 0, 1, 0, wc), d = mark.v(px(f1) + nx * (off - width / 2), py(f1), pz(f1) + nz * (off - width / 2), 0, 1, 0, wc);
            mark.quadUp(a, b, cc, d);
          }
          if (!gap) break; s += period;
        }
      }
    };
    const ow = flags & 1;
    if (cls === 16) { line(0, 30, 20, .9, 0); line(hw - 1.5, 0, 0, .9, 0); line(-hw + 1.5, 0, 0, .9, 0) }
    else if (cls === 17) line(0, 0, 0, .25, 0);
    else if (cls <= 5 || (cls >= 11 && cls <= 15) || (cls <= 7 && hw >= 3.4)) {
      const nl = lanes || (ow ? Math.max(1, Math.round(hw * 2 / 3.4)) : Math.max(2, Math.round(hw * 2 / 3.3)));
      if (!ow && nl >= 2) { if (cls <= 3) { line(-.12, 0, 0, .14); line(.12, 0, 0, .14) } else line(0, 3, 5, .14) }
      if (nl >= 2) { const lw = hw * 2 / nl; for (let m = 1; m < nl; m++) { const off = -hw + m * lw; if (!ow && Math.abs(off) < .3) continue; line(off, 3, 6, .13) } }
      if (cls <= 3 || cls === 11 || cls === 12) { line(hw - .35, 0, 0, .15); line(-hw + .35, 0, 0, .15) }
    }
    // bridges and ramps: deck edges, parapets, piers
    if (R.pel[p] > .6) {
      const conc = this._cn || (this._cn = new THREE.Color('#aaa69d')), dark = this._dk || (this._dk = new THREE.Color('#7d7a73'));
      const edge = hw + sw;
      for (let k = 0; k < n - 1; k++) {
        const i = s0 + k, i2 = i + 1;
        const g0 = c.terrainH(X[i], Z[i]), g1 = c.terrainH(X[i2], Z[i2]), e0 = H[i] - g0, e1 = H[i2] - g1;
        if (e0 < .5 && e1 < .5) continue;
        const span = e0 > 4.5 && e1 > 4.5;
        for (const sg of [1, -1]) {
          const nx0 = tz[k] * sg, nz0 = -tx[k] * sg, nx1 = tz[k + 1] * sg, nz1 = -tx[k + 1] * sg;
          const bot0 = span ? H[i] - 1.3 : g0 - .8, bot1 = span ? H[i2] - 1.3 : g1 - .8, top0 = H[i] + (e0 > 1.5 ? 1.0 : .2), top1 = H[i2] + (e1 > 1.5 ? 1.0 : .2);
          const ax = X[i] + nx0 * edge, az = Z[i] + nz0 * edge, bx = X[i2] + nx1 * edge, bz = Z[i2] + nz1 * edge;
          const a = brg.v(ax, bot0, az, nx0, 0, nz0, dark), b = brg.v(bx, bot1, bz, nx1, 0, nz1, dark), cc = brg.v(bx, top1, bz, nx1, 0, nz1, conc), d = brg.v(ax, top0, az, nx0, 0, nz0, conc);
          brg.face(a, b, cc, d, nx0, 0, nz0);
          // inner face of the parapet
          if (e0 > 1.5 || e1 > 1.5) { const ix = ax - nx0 * .3, iz = az - nz0 * .3, jx = bx - nx1 * .3, jz = bz - nz1 * .3; const p1 = brg.v(ix, H[i], iz, -nx0, 0, -nz0, conc), p2 = brg.v(jx, H[i2], jz, -nx1, 0, -nz1, conc), p3 = brg.v(jx, top1, jz, -nx1, 0, -nz1, conc), p4 = brg.v(ix, top0, iz, -nx0, 0, -nz0, conc); brg.face(p1, p2, p3, p4, -nx0, 0, -nz0); const t1 = brg.v(ax, top0, az, 0, 1, 0, conc), t2 = brg.v(bx, top1, bz, 0, 1, 0, conc); brg.quadUp(t1, t2, p3, p4) }
        }
        if (span) {
          // underside
          const nx0 = tz[k], nz0 = -tx[k], nx1 = tz[k + 1], nz1 = -tx[k + 1];
          const a = brg.v(X[i] + nx0 * edge, H[i] - 1.3, Z[i] + nz0 * edge, 0, -1, 0, dark), b = brg.v(X[i] - nx0 * edge, H[i] - 1.3, Z[i] - nz0 * edge, 0, -1, 0, dark), cc = brg.v(X[i2] - nx1 * edge, H[i2] - 1.3, Z[i2] - nz1 * edge, 0, -1, 0, dark), d = brg.v(X[i2] + nx1 * edge, H[i2] - 1.3, Z[i2] + nz1 * edge, 0, -1, 0, dark);
          brg.face(a, b, cc, d, 0, -1, 0);
          // a pier every ~28 m, off the roads below
          if (Math.floor(S[k] / 28) !== Math.floor(S[k + 1] / 28)) {
            const px = X[i], pz = Z[i]; if (!c.onRoad(px, pz, 1.2) || true) {
              const under = c.ground(px, pz, H[i] - 3, this._gq || (this._gq = {}));
              if (under.p < 0 || under.d > under.hw + 1.5) this.box(brg, px, pz, g0 - .5, H[i] - 1.3, .7, Math.min(edge * .8, 5), tx[k], tz[k], dark);
            }
          }
        }
      }
    }
  }
  addCrossing(mark, [x, z, h, dx, dz, hw]) {
    const wc = this._mw, nx = dz, nz = -dx;
    for (let o = -hw + .5; o < hw - .4; o += 1.1) {
      const a = mark.v(x + nx * o - dx * 1.6, h + .055, z + nz * o - dz * 1.6, 0, 1, 0, wc), b = mark.v(x + nx * (o + .55) - dx * 1.6, h + .055, z + nz * (o + .55) - dz * 1.6, 0, 1, 0, wc);
      const c = mark.v(x + nx * (o + .55) + dx * 1.6, h + .055, z + nz * (o + .55) + dz * 1.6, 0, 1, 0, wc), d = mark.v(x + nx * o + dx * 1.6, h + .055, z + nz * o + dz * 1.6, 0, 1, 0, wc);
      mark.quadUp(a, b, c, d);
    }
  }
  /* rails (k=1, gravel bed) and trams (k=2) */
  addLine(R, l, b) {
    const k = R.lk[l] & 15; if (k !== 1 && k !== 2) return;
    const s0 = R.ls[l], s1 = R.ls[l + 1], n = s1 - s0; if (n < 2) return;
    const c = this.city, bedC = k === 1 ? (this._bc1 || (this._bc1 = new THREE.Color('#857a68'))) : (this._bc2 || (this._bc2 = new THREE.Color('#6e6d68'))), railC = this._rc || (this._rc = new THREE.Color('#c3c6c8'));
    const bw = k === 1 ? 2.2 : 1.35, X = R.lx, Z = R.lz, H = R.lh, gq = this._gl || (this._gl = {});
    const ys = new Float32Array(n);
    for (let m = 0; m < n; m++) { const i = s0 + m, g = c.ground(X[i], Z[i], H[i] + 1.5, gq); ys[m] = (g.p >= 0 && Math.abs(g.h - H[i]) < 2) ? g.h + .04 : Math.max(H[i], c.terrainH(X[i], Z[i])) + (k === 1 ? .25 : .06) }
    const strip = (off0, off1, dy, col) => {
      for (let m = 0; m < n - 1; m++) {
        const i = s0 + m; let dx = X[i + 1] - X[i], dz = Z[i + 1] - Z[i]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L; const nx = dz, nz = -dx;
        const a = b.v(X[i] + nx * off0, ys[m] + dy, Z[i] + nz * off0, 0, 1, 0, col), bb = b.v(X[i] + nx * off1, ys[m] + dy, Z[i] + nz * off1, 0, 1, 0, col);
        const cc = b.v(X[i + 1] + nx * off1, ys[m + 1] + dy, Z[i + 1] + nz * off1, 0, 1, 0, col), d = b.v(X[i + 1] + nx * off0, ys[m + 1] + dy, Z[i + 1] + nz * off0, 0, 1, 0, col);
        b.quadUp(a, bb, cc, d);
      }
    };
    strip(-bw, bw, 0, bedC); strip(-.77, -.69, .07, railC); strip(.69, .77, .07, railC);
    // raised sections: embankment or deck sides, underside and piers
    const conc = this._cn || (this._cn = new THREE.Color('#aaa69d')), dark = this._dk || (this._dk = new THREE.Color('#7d7a73'));
    let run = 0;
    for (let m = 0; m < n - 1; m++) {
      const i = s0 + m, g0 = c.terrainH(X[i], Z[i]), g1 = c.terrainH(X[i + 1], Z[i + 1]), e0 = ys[m] - g0, e1 = ys[m + 1] - g1;
      if (e0 < 1.2 && e1 < 1.2) continue;
      let dx = X[i + 1] - X[i], dz = Z[i + 1] - Z[i]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L; const nx = dz, nz = -dx, span = e0 > 4.5 && e1 > 4.5;
      for (const sg of [1, -1]) {
        const ax = X[i] + nx * bw * sg, az = Z[i] + nz * bw * sg, cx = X[i + 1] + nx * bw * sg, cz = Z[i + 1] + nz * bw * sg;
        const v1 = b.v(ax, span ? ys[m] - 1.3 : g0 - .6, az, nx * sg, 0, nz * sg, dark), v2 = b.v(cx, span ? ys[m + 1] - 1.3 : g1 - .6, cz, nx * sg, 0, nz * sg, dark);
        const v3 = b.v(cx, ys[m + 1] + .45, cz, nx * sg, 0, nz * sg, conc), v4 = b.v(ax, ys[m] + .45, az, nx * sg, 0, nz * sg, conc);
        b.face(v1, v2, v3, v4, nx * sg, 0, nz * sg);
      }
      if (span) {
        const v1 = b.v(X[i] + nx * bw, ys[m] - 1.3, Z[i] + nz * bw, 0, -1, 0, dark), v2 = b.v(X[i] - nx * bw, ys[m] - 1.3, Z[i] - nz * bw, 0, -1, 0, dark), v3 = b.v(X[i + 1] - nx * bw, ys[m + 1] - 1.3, Z[i + 1] - nz * bw, 0, -1, 0, dark), v4 = b.v(X[i + 1] + nx * bw, ys[m + 1] - 1.3, Z[i + 1] + nz * bw, 0, -1, 0, dark);
        b.face(v1, v2, v3, v4, 0, -1, 0);
        run += L; if (run > 26) { run = 0; const g = c.ground(X[i], Z[i], ys[m] - 3, this._gq || (this._gq = {})); if (g.p < 0 || g.d > g.hw + 1.5) this.box(b, X[i], Z[i], g0 - .5, ys[m] - 1.3, .8, bw * .7, dx, dz, dark) }
      }
    }
  }
  box(b, x, z, y0, y1, hx, hz, fx, fz, col) {
    const lx = fz, lz = -fx, P = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, w]) => [x + fx * hx * u + lx * hz * w, z + fz * hx * u + lz * hz * w]);
    for (let k = 0; k < 4; k++) {
      const [ax, az] = P[k], [cx, cz] = P[(k + 1) % 4], dx = cx - ax, dz = cz - az, L = Math.hypot(dx, dz) || 1, nx = dz / L, nz = -dx / L;
      const a = b.v(ax, y0, az, nx, 0, nz, col), bb = b.v(cx, y0, cz, nx, 0, nz, col), c = b.v(cx, y1, cz, nx, 0, nz, col), d = b.v(ax, y1, az, nx, 0, nz, col);
      b.face(a, bb, c, d, nx, 0, nz);
    }
  }
  /* walls (CCW rings in x/z: outward normal = (dz, -dx)), flat or pyramid roof */
  addBuilding(b, X, Z, s0, n, ground, top0, bottom, st, col, flags, far, rs = 0, rcol = null, rh = 0, domes = null) {
    const top = rs ? top0 - rh : top0;
    const bay = BAY[st] || 3.2, nF = Math.max(1, Math.round((top - ground) / 3.05)), fh = Math.max(.5, (top - ground) / nF), w = st === 6 ? 0 : st;
    let u = 0;
    for (let m = 0; m < n; m++) {
      const a = s0 + m, c = s0 + (m + 1) % n, ax = X[a], az = Z[a], cx = X[c], cz = Z[c], dx = cx - ax, dz = cz - az, L = Math.hypot(dx, dz); if (L < .05) continue;
      const nx = dz / L, nz = -dx / L, u1 = u + L / bay;
      const i0 = b.v(ax, bottom, az, nx, 0, nz, col, u, (bottom - ground) / fh, w), i1 = b.v(cx, bottom, cz, nx, 0, nz, col, u1, (bottom - ground) / fh, w);
      const i2 = b.v(cx, top, cz, nx, 0, nz, col, u1, nF, w), i3 = b.v(ax, top, az, nx, 0, nz, col, u, nF, w);
      b.t(i0, i2, i1); b.t(i0, i3, i2);
      u = u1;
    }
    // roof
    let area = 0, cx = 0, cz = 0; for (let m = 0; m < n; m++) { const a = s0 + m, c = s0 + (m + 1) % n, cr = X[a] * Z[c] - X[c] * Z[a]; area += cr; cx += (X[a] + X[c]) * cr; cz += (Z[a] + Z[c]) * cr }
    area /= 2; cx /= 6 * area || 1; cz /= 6 * area || 1;
    const hsh = ((Math.round(X[s0] * 10) * 73856093) ^ (Math.round(Z[s0] * 10) * 19349663)) >>> 0;
    if ((rs === 1 || rs === 2 || rs === 4) && domes) {
      const r = Math.sqrt(Math.abs(area) / Math.PI), dc = rcol || (this._dg || (this._dg = new THREE.Color('#7f9d8a'))), sg = rs === 4 ? new THREE.ConeGeometry(r, 1, 12, 1, true).translate(0, .5, 0) : new THREE.SphereGeometry(r, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
      const P = sg.attributes.position, N = sg.attributes.normal, base = domes.nv, ys = rs === 4 ? rh : rh / r * (rs === 2 ? 1.15 : 1);
      for (let k = 0; k < P.count; k++) domes.v(cx + P.getX(k) * (rs === 2 ? 1.08 : 1), top + P.getY(k) * ys, cz + P.getZ(k) * (rs === 2 ? 1.08 : 1), N.getX(k), N.getY(k), N.getZ(k), dc);
      const I = sg.index.array; for (let k = 0; k < I.length; k += 3) domes.t(base + I[k], base + I[k + 1], base + I[k + 2]); sg.dispose();
      // flat cap under the dome
      const fb = b.nv, pts2 = []; for (let m = 0; m < n; m++) { b.v(X[s0 + m], top, Z[s0 + m], 0, 1, 0, ROOF[0]); pts2.push(new THREE.Vector2(X[s0 + m], Z[s0 + m])) }
      try { for (const [p, q, r2] of THREE.ShapeUtils.triangulateShape(pts2, [])) b.up(fb + p, fb + q, fb + r2) } catch (e) { }
      return;
    }
    if ((rs === 3 || (st === 5 && !rs)) && n <= 10 && area < 1500 && !far) {
      const rc = rcol || ROOF[2], apex = top + (rs === 3 && rh ? rh : Math.min(3.2, Math.sqrt(area) * .35));
      for (let m = 0; m < n; m++) {
        const a = s0 + m, c = s0 + (m + 1) % n, ex = X[c] - X[a], ez = Z[c] - Z[a], tx = cx - X[a], tz = cz - Z[a], ty = apex - top;
        let nx = ez * ty, ny = -(ex * tz - ez * tx), nz = -ex * ty; const nl = Math.hypot(nx, ny, nz) || 1; if (ny < 0) { nx = -nx; ny = -ny; nz = -nz }
        const i0 = b.v(X[a], top, Z[a], nx / nl, ny / nl, nz / nl, rc), i1 = b.v(X[c], top, Z[c], nx / nl, ny / nl, nz / nl, rc), i2 = b.v(cx, apex, cz, nx / nl, ny / nl, nz / nl, rc);
        b.up(i0, i1, i2);
      }
      return;
    }
    const rc = st === 2 ? ROOF[3] : ROOF[hsh % 2], pts = [];
    for (let m = 0; m < n; m++) pts.push(new THREE.Vector2(X[s0 + m], Z[s0 + m]));
    let tris; try { tris = THREE.ShapeUtils.triangulateShape(pts, []) } catch (e) { tris = [] }
    const base = b.nv; for (let m = 0; m < n; m++) b.v(X[s0 + m], top, Z[s0 + m], 0, 1, 0, rc);
    for (const [p, q, r] of tris) b.up(base + p, base + q, base + r);
  }
  addDome(b, R, bi) {
    const s0 = R.bs[bi], n = R.bs[bi + 1] - s0; let area = 0, cx = 0, cz = 0;
    for (let m = 0; m < n; m++) { const a = s0 + m, c = s0 + (m + 1) % n, cr = R.bx[a] * R.bz[c] - R.bx[c] * R.bz[a]; area += cr; cx += (R.bx[a] + R.bx[c]) * cr; cz += (R.bz[a] + R.bz[c]) * cr }
    area /= 2; cx /= 6 * area; cz /= 6 * area;
    const gold = R.bFl[bi] & 8, col = gold ? new THREE.Color('#d9b148') : new THREE.Color('#7f9d8a'), rad = Math.min(gold ? 11 : 8, Math.sqrt(Math.abs(area)) * .2);
    const add = (x, z, y, r, h) => {
      const sg = new THREE.SphereGeometry(r, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2), P = sg.attributes.position, N = sg.attributes.normal, base = b.nv;
      for (let k = 0; k < P.count; k++) b.v(x + P.getX(k), y + P.getY(k) * h, z + P.getZ(k), N.getX(k), N.getY(k), N.getZ(k), col);
      const I = sg.index.array; for (let k = 0; k < I.length; k += 3) b.t(base + I[k], base + I[k + 1], base + I[k + 2]);
      // drum
      this.box(b, x, z, y - r * .6, y + .1, r * .72, r * .72, 1, 0, new THREE.Color('#e4d6b4'));
      sg.dispose();
    };
    const top = R.bTop[bi];
    add(cx, cz, top + rad * .6, rad, 1.25);
    if (gold) for (const [ox, oz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) add(cx + ox * rad * 1.5, cz + oz * rad * 1.5, top + rad * .2, rad * .45, 1.3);
  }
  signalGeometry() {
    const b = new Buf(), pole = new THREE.Color('#4c5052'), head = new THREE.Color('#202325'), lamp = new THREE.Color('#d8452f');
    this.box(b, 0, 0, 0, 4.2, .08, .08, 1, 0, pole);
    this.box(b, 0, 0, 3.2, 4.3, .18, .2, 1, 0, head);
    this.box(b, -.19, 0, 3.95, 4.15, .02, .1, 1, 0, lamp);
    return b.geometry();
  }
}
