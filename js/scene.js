/* 3D world for a track: real terrain, road, kerbs, run-off, barriers, forests, pits, grandstands, sky. */
import * as THREE from './vendor/three.module.min.js';
import { KERB_W, VERGE_W } from './track.js';

const smooth = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e7) / 1e7 } }
function vnoise(seed) {
  const h = (x, y) => { let n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453; return n - Math.floor(n) };
  return (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v) + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v };
}
function canvas(w, h) { const c = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }); return [c, c.getContext('2d')] }
function texFrom(c, rep = true, srgb = true) { const t = new THREE.CanvasTexture(c); if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.needsUpdate = true; return t }

function makeTextures() {
  const r = rng(7), T = {};
  { const [c, g] = canvas(512, 512); g.fillStyle = '#5a5d60'; g.fillRect(0, 0, 512, 512);
    const id = g.getImageData(0, 0, 512, 512), d = id.data;
    for (let i = 0; i < d.length; i += 4) { const v = 78 + r() * 34 + (r() < .02 ? -25 : 0); d[i] = v; d[i + 1] = v + 1; d[i + 2] = v + 3 }
    g.putImageData(id, 0, 0);
    for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(${r() < .5 ? '30,30,32' : '120,120,118'},${.04 + r() * .06})`; g.beginPath(); g.ellipse(r() * 512, r() * 512, 20 + r() * 70, 10 + r() * 40, r() * 3, 0, 7); g.fill() }
    T.asphalt = texFrom(c) }
  { const [c, g] = canvas(256, 256); const id = g.createImageData(256, 256), d = id.data, n = vnoise(3);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const i = (y * 256 + x) * 4, v = 200 + 40 * n(x / 9, y / 9) + r() * 30 - 15; d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, v)); d[i + 3] = 255 }
    g.putImageData(id, 0, 0); T.detail = texFrom(c, true, false) }
  { const [c, g] = canvas(4, 64); g.fillStyle = '#c62a20'; g.fillRect(0, 0, 4, 32); g.fillStyle = '#efefe9'; g.fillRect(0, 32, 4, 32); T.kerb = texFrom(c); T.kerb.magFilter = THREE.NearestFilter }
  { const [c, g] = canvas(64, 16); for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f0'; g.fillRect(x * 8, y * 8, 8, 8) } T.checker = texFrom(c); T.checker.magFilter = THREE.NearestFilter }
  { const [c, g] = canvas(8, 64); const gr = g.createLinearGradient(0, 0, 0, 64); gr.addColorStop(0, '#9aa1a5'); gr.addColorStop(.25, '#dfe4e6'); gr.addColorStop(.5, '#8f969a'); gr.addColorStop(.75, '#d5dadc'); gr.addColorStop(1, '#7f8589'); g.fillStyle = gr; g.fillRect(0, 0, 8, 64); T.armco = texFrom(c) }
  return T;
}

const BRANDS = [['MOTORWORKS', '#f2b705', '#18201b'], ['RHEINWERK', '#3a6ea5', '#fff'], ['HOSHINO', '#c2412d', '#fff'], ['CASTELLAN', '#8e3b8a', '#fff'], ['LIBERTY', '#2f8a7d', '#fff'], ['MOREAU', '#b0763a', '#fff'], ['NORDVIK', '#5a6f8a', '#fff'], ['HANBIT', '#6b8e23', '#fff']];
function boardTex(text, bg, fg) { const [c, g] = canvas(512, 96); g.fillStyle = bg; g.fillRect(0, 0, 512, 96); g.fillStyle = fg; g.font = 'bold 64px Oswald, Impact, Arial Narrow, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 52); return texFrom(c, false) }

export class World {
  constructor(track, opts = {}) {
    this.track = track; this.q = opts.quality || 'high'; this.group = new THREE.Group();
    this.th = track.theme; this.T = makeTextures();
    const d = track.data.terrain;
    this.dem = d;
    this.buildCorridorParams(); this.setupColors(); this.planBuildings();
    this.buildRoad(); this.buildKerbs(); this.buildCorridor(); this.buildBarriers();
    this.buildTerrain(); this.buildTrees(); this.buildPits(); this.buildBoards(); this.buildSky();
    if (track.bridge) this.buildBridge();
  }
  /* natural ground height from the DEM grid (metres above the track's lowest point) */
  natural(x, z) {
    const T = this.dem, u = (x - T.x0) / (T.x1 - T.x0) * (T.cols - 1), v = (T.n0 - (-z)) / (T.n0 - T.n1) * (T.rows - 1);
    const cu = Math.max(0, Math.min(T.cols - 1.001, u)), cv = Math.max(0, Math.min(T.rows - 1.001, v));
    const i = Math.floor(cu), j = Math.floor(cv), fu = cu - i, fv = cv - j, H = T.h, C = T.cols;
    return (H[j * C + i] * (1 - fu) + H[j * C + i + 1] * fu) * (1 - fv) + (H[(j + 1) * C + i] * (1 - fu) + H[(j + 1) * C + i + 1] * fu) * fv;
  }
  /* corridor column distances (from centre line) for index i, side (1 = left, -1 = right) */
  buildCorridorParams() {
    const t = this.track, n = t.n;
    this.bridgeZone = new Uint8Array(n);
    if (t.bridge) {
      const b = t.bridge, wz = Math.round(230 / t.ds), dz = Math.round(34 / t.ds);
      for (let k = -wz; k <= wz; k++) this.bridgeZone[t.wrap(b.upper + k)] = Math.abs(k) <= dz ? 2 : 1;
    }
  }
  cols(i, left) {
    const t = this.track, w = left ? t.wl[i] : t.wr[i], kerb = left ? t.kerbL[i] : t.kerbR[i], B = left ? t.bl[i] : t.br[i];
    const free = (left ? t.freeL[i] : t.freeR[i]) - 1;
    const e = w, v = e + (kerb ? KERB_W : 0) + VERGE_W;
    let c = [e, v, Math.max(v + .2, B - .6), B + 1.5, B + 8, B + 20, B + 34, B + 52];
    if (this.bridgeZone[i] === 1) c = [e, v, Math.max(v + .2, B - .6), B + 1.5, B + 2.5, B + 3.5, B + 4.5, B + 5.5];
    if (c[7] > free) { const s = Math.max(.05, (free - c[1]) / (c[7] - c[1])); for (let k = 2; k < 8; k++) c[k] = c[1] + (c[k] - c[1]) * s }
    return c;
  }
  /* height of the visible ground at (x,z) — used for trees, buildings and terrain */
  ground(x, z, hint) {
    const t = this.track, near = t.near(x, z, 120);
    if (!near.length) return { h: this.natural(x, z), inside: false, dist: 1e9 };
    let best = -1, bd = 1e18; for (const j of near) { const dd = (t.px[j] - x) ** 2 + (t.pz[j] - z) ** 2; if (dd < bd) { bd = dd; best = j } }
    const i = best, dx = x - t.px[i], dz = z - t.pz[i], d = dx * t.tz[i] + dz * (-t.tx[i]), left = d >= 0, ad = Math.abs(d);
    const c = this.cols(i, left), nat = this.natural(x, z), h0 = t.py[i];
    let h; if (ad <= c[4]) h = h0; else if (ad <= c[7]) h = h0 + (nat - h0) * smooth((ad - c[4]) / (c[7] - c[4])); else h = nat;
    return { h, inside: ad < c[7], dist: ad - (left ? t.bl[i] : t.br[i]), i, d, c, ad };
  }

  ribbon(samples, colsFn, mat, opts = {}) {
    // samples: indices; colsFn(i) -> array of [d, y, u?, color?]; builds a strip mesh
    const pos = [], uv = [], col = [], idx = []; let nc = 0;
    const t = this.track;
    samples.forEach((i, k) => {
      const cs = colsFn(i); nc = cs.length;
      const nx = t.tz[i], nz = -t.tx[i], s = i * t.ds;
      for (const c of cs) { pos.push(t.px[i] + nx * c[0], c[1], t.pz[i] + nz * c[0]); uv.push(c[2] ?? c[0], (opts.vScale ? s / opts.vScale : s)); if (c[3]) col.push(c[3][0], c[3][1], c[3][2]) }
      if (k > 0) for (let q = 0; q < nc - 1; q++) { const a = (k - 1) * nc + q, b = a + 1, cc = k * nc + q, dd = cc + 1; if (opts.flip) idx.push(a, b, cc, b, dd, cc); else idx.push(a, cc, b, b, cc, dd) }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; return m;
  }
  chunks(step, len) {
    // split the lap into overlapping index ranges for culling
    const t = this.track, out = [], per = Math.round(len / t.ds);
    for (let a = 0; a < t.n; a += per) { const s = []; for (let i = a; i <= Math.min(t.n, a + per); i += step) s.push(t.wrap(i)); out.push(s) }
    return out;
  }
  buildRoad() {
    const t = this.track, T = this.T;
    const mat = new THREE.MeshStandardMaterial({ map: T.asphalt, roughness: .92, metalness: 0, color: 0xffffff });
    T.asphalt.repeat.set(1, 1);
    const roadCols = i => [[t.wl[i], t.py[i], t.wl[i] / 7], [0, t.py[i] + .01, 0], [-t.wr[i], t.py[i], -t.wr[i] / 7]];
    for (const s of this.chunks(1, 400)) this.group.add(this.ribbon(s, roadCols, mat, { vScale: 7, flip: true }));
    // white edge lines
    const lm = new THREE.MeshStandardMaterial({ color: 0xe9ebe6, roughness: .6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const side of [1, -1]) for (const s of this.chunks(1, 400)) {
      this.group.add(this.ribbon(s, i => { const w = side > 0 ? t.wl[i] : t.wr[i], y = t.py[i] + .006; return side > 0 ? [[w - .18, y], [w - .45, y]] : [[-(w - .45), y], [-(w - .18), y]] }, lm, { flip: true }));
    }
    // rubbered-in racing line
    const rl = t.racingLine();
    const rm = new THREE.MeshBasicMaterial({ color: 0x0c0c0c, transparent: true, opacity: .16, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    for (const s of this.chunks(1, 400)) this.group.add(this.ribbon(s, i => { const o = rl.off[i], y = t.py[i] + .003; return [[o + 1.1, y], [o - 1.1, y]] }, rm, { flip: true }));
    // start / finish line and grid slots
    const ck = new THREE.MeshBasicMaterial({ map: T.checker, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    T.checker.repeat.set(1, 1);
    const sf = []; for (let i = 0; i <= 1; i++) sf.push(t.wrap(i));
    this.group.add(this.ribbon(sf, i => [[t.wl[i], t.py[i] + .012, 0], [-t.wr[i], t.py[i] + .012, (t.wl[i] + t.wr[i]) / 2]], ck, { vScale: 2, flip: true }));
    const gm = new THREE.MeshStandardMaterial({ color: 0xe9ebe6, roughness: .6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (let k = 1; k <= 10; k++) {
      const s0 = -k * 8 - 4, side = k % 2 ? 1 : -1, i0 = t.wrap(Math.round(s0 / t.ds)), i1 = t.wrap(i0 + 1);
      const o = side * 2.6, y = t.py[i0] + .008;
      this.group.add(this.ribbon([i0, i1], () => [[o + 1.3, y], [o - 1.3, y]], gm, { flip: true }));
    }
  }
  buildKerbs() {
    const t = this.track, mat = new THREE.MeshStandardMaterial({ map: this.T.kerb, roughness: .6 });
    for (const left of [true, false]) {
      const flag = left ? t.kerbL : t.kerbR, sg = left ? 1 : -1;
      let run = [];
      const flush = () => { if (run.length > 1) this.group.add(this.ribbon(run, i => { const w = left ? t.wl[i] : t.wr[i], y = t.py[i]; return [[sg * (w - .05), y + .006, 0], [sg * (w + KERB_W * .45), y + .055, .5], [sg * (w + KERB_W), y + .012, 1]] }, mat, { vScale: 3, flip: !left })); run = [] };
      for (let i = 0; i <= t.n; i++) { const ii = t.wrap(i); if (flag[ii] && i < t.n) run.push(ii); else flush() }
      flush();
    }
  }
  setupColors() {
    const th = this.th, n1 = vnoise(5), n2 = vnoise(9), n3 = vnoise(11);
    const grass = new THREE.Color(th.grass), grass2 = new THREE.Color(th.grass2), dirt = new THREE.Color(th.dirt), forest = new THREE.Color(th.grass2).multiplyScalar(.72);
    this.forestField = (x, z) => smooth((n1(x / 380, z / 380) * .7 + n2(x / 120, z / 120) * .3 - .38) / .3);
    this.groundColor = (x, z, out) => {
      const f = this.forestField(x, z) * th.trees;
      out.copy(grass).lerp(grass2, n3(x / 40, z / 40)).lerp(forest, Math.min(1, f * 1.2));
      const hx = this.natural(x + 8, z) - this.natural(x - 8, z), hz = this.natural(x, z + 8) - this.natural(x, z - 8), slope = Math.hypot(hx, hz) / 16;
      return out.lerp(dirt, smooth((slope - .35) / .4) * .7);
    };
  }
  buildCorridor() {
    const t = this.track, th = this.th;
    const grass = new THREE.Color(th.grass), verge = new THREE.Color(0x7c7e78);
    const gravel = new THREE.Color(0xc4ad7f), runoff = new THREE.Color(0x56595c), tmp = new THREE.Color(), tmp2 = new THREE.Color();
    const mat = new THREE.MeshLambertMaterial({ map: this.T.detail, vertexColors: true });
    this.T.detail.repeat.set(1, 1);
    for (const left of [true, false]) {
      const sg = left ? 1 : -1;
      for (const s of this.chunks(2, 400)) {
        const samples = s.filter(i => this.bridgeZone[i] !== 2);
        // break the strip where the bridge deck is
        const parts = []; let cur = [];
        for (const i of s) { if (this.bridgeZone[i] === 2) { if (cur.length > 1) parts.push(cur); cur = [] } else cur.push(i) }
        if (cur.length > 1) parts.push(cur);
        for (const part of parts) this.group.add(this.ribbon(part, i => {
          const c = this.cols(i, left), y = t.py[i], run = left ? t.runL[i] : t.runR[i];
          const nx = t.tz[i], nz = -t.tx[i];
          const rc = run === 5 ? gravel : run === 3 ? runoff : grass;
          const out = [];
          for (let k = 0; k < 8; k++) {
            const dd = c[k], x = t.px[i] + nx * dd * sg, z = t.pz[i] + nz * dd * sg;
            let h = y - .015;
            if (k >= 5) { const nat = this.natural(x, z); h = y + (nat - y) * smooth((dd - c[4]) / (c[7] - c[4])); if (k === 7) h -= .4 }
            let cl;
            if (k <= 1) cl = verge; else if (k === 2) cl = rc;
            else { this.groundColor(x, z, tmp); if (k <= 4) tmp.lerp(grass, .35); cl = tmp }
            if (k === 1 && run !== 4) cl = rc;
            out.push([sg * dd, h, sg * dd / 6, [cl.r, cl.g, cl.b]]);
          }
          return out;
        }, mat, { vScale: 6, flip: !left }));
      }
    }
  }
  buildBarriers() {
    const t = this.track;
    const mat = new THREE.MeshStandardMaterial({ map: this.T.armco, roughness: .4, metalness: .6, side: THREE.DoubleSide });
    this.T.armco.repeat.set(1, 1);
    const postGeo = new THREE.BoxGeometry(.12, .8, .12), postMat = new THREE.MeshStandardMaterial({ color: 0x8b9196, roughness: .5, metalness: .5 });
    const posts = [];
    for (const left of [true, false]) {
      const sg = left ? 1 : -1;
      for (const s of this.chunks(2, 400)) {
        const parts = []; let cur = [];
        for (const i of s) { if (this.bridgeZone[i] === 2) { if (cur.length > 1) parts.push(cur); cur = [] } else cur.push(i) }
        if (cur.length > 1) parts.push(cur);
        for (const part of parts) {
          const m = this.ribbon(part, i => { const B = (left ? t.bl[i] : t.br[i]) * sg, y = t.py[i]; return [[B, y + .88, 0], [B, y + .36, 1]] }, mat, { vScale: 4 });
          m.castShadow = true; this.group.add(m);
        }
      }
      const step = Math.max(1, Math.round(4 / t.ds));
      for (let i = 0; i < t.n; i += step) { if (this.bridgeZone[i] === 2) continue; const B = (left ? t.bl[i] : t.br[i]) * sg + sg * .1; posts.push([t.px[i] + t.tz[i] * B, t.py[i] + .4, t.pz[i] - t.tx[i] * B]) }
    }
    const im = new THREE.InstancedMesh(postGeo, postMat, posts.length), M = new THREE.Matrix4();
    posts.forEach((p, k) => { M.makeTranslation(p[0], p[1], p[2]); im.setMatrixAt(k, M) });
    im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.frustumCulled = false; this.group.add(im);
  }
  terrainBounds() {
    const t = this.track, D = this.dem, m0 = t.data.terrainMargin || 1300, m = this.q === 'low' ? Math.min(m0, 1600) * .55 : m0;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < t.n; i += 5) { x0 = Math.min(x0, t.px[i]); x1 = Math.max(x1, t.px[i]); z0 = Math.min(z0, t.pz[i]); z1 = Math.max(z1, t.pz[i]) }
    return [Math.max(x0 - m, D.x0), Math.min(x1 + m, D.x1), Math.max(z0 - m, -D.n0), Math.min(z1 + m, -D.n1)];
  }
  buildTerrain() {
    const t = this.track, th = this.th, [x0, x1, z0, z1] = this.tb = this.terrainBounds();
    const area = (x1 - x0) * (z1 - z0), target = this.q === 'high' ? 90000 : this.q === 'medium' ? 50000 : 25000;
    const cell = Math.max(10, Math.sqrt(area / target));
    const nx = Math.ceil((x1 - x0) / cell), nz = Math.ceil((z1 - z0) / cell);
    this.cell = cell;
    const tmp = new THREE.Color();
    const H = new Float32Array((nx + 1) * (nz + 1)), C = new Float32Array((nx + 1) * (nz + 1) * 3);
    for (let b = 0; b <= nz; b++) for (let a = 0; a <= nx; a++) {
      const x = x0 + a * cell, z = z0 + b * cell, k = b * (nx + 1) + a;
      const g = this.ground(x, z);
      let h = g.h;
      if (g.inside && g.ad < g.c[7] - cell * .8) h = Math.min(h, t.py[g.i]) - 4;
      H[k] = h;
      this.groundColor(x, z, tmp);
      C[k * 3] = tmp.r; C[k * 3 + 1] = tmp.g; C[k * 3 + 2] = tmp.b;
    }
    this.terrainH = { H, nx, nz, x0, z0, cell };
    const mat = new THREE.MeshLambertMaterial({ map: this.T.detail, vertexColors: true });
    const TILE = 48;
    for (let tb = 0; tb < nz; tb += TILE) for (let ta = 0; ta < nx; ta += TILE) {
      const ax = Math.min(nx, ta + TILE), bz = Math.min(nz, tb + TILE), w = ax - ta + 1, hgt = bz - tb + 1;
      const pos = new Float32Array(w * hgt * 3), col = new Float32Array(w * hgt * 3), uv = new Float32Array(w * hgt * 2), idx = [];
      for (let b = 0; b < hgt; b++) for (let a = 0; a < w; a++) {
        const gi = (tb + b) * (nx + 1) + ta + a, li = b * w + a;
        const x = x0 + (ta + a) * cell, z = z0 + (tb + b) * cell;
        pos[li * 3] = x; pos[li * 3 + 1] = H[gi]; pos[li * 3 + 2] = z;
        col[li * 3] = C[gi * 3]; col[li * 3 + 1] = C[gi * 3 + 1]; col[li * 3 + 2] = C[gi * 3 + 2];
        uv[li * 2] = x / 7; uv[li * 2 + 1] = z / 7;
        if (a < w - 1 && b < hgt - 1) { const p = li, q = li + 1, r2 = li + w, s2 = li + w + 1; idx.push(p, r2, q, q, r2, s2) }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat); m.receiveShadow = true; this.group.add(m);
    }
    // far ground to the horizon
    const far = new THREE.Mesh(new THREE.CircleGeometry(30000, 48), new THREE.MeshLambertMaterial({ color: new THREE.Color(th.grass2).multiplyScalar(.85) }));
    far.rotation.x = -Math.PI / 2; let lo = 1e9; for (let i = 0; i < H.length; i += 7) lo = Math.min(lo, H[i]);
    far.position.set((x0 + x1) / 2, lo - 3, (z0 + z1) / 2); this.group.add(far);
  }
  terrainAt(x, z) {
    const T = this.terrainH; if (!T) return this.natural(x, z);
    const a = (x - T.x0) / T.cell, b = (z - T.z0) / T.cell, i = Math.floor(a), j = Math.floor(b);
    if (i < 0 || j < 0 || i >= T.nx || j >= T.nz) return this.natural(x, z);
    const fa = a - i, fb = b - j, W = T.nx + 1, H = T.H;
    // triangle-correct interpolation (matches the mesh split p, r2, q / q, r2, s2)
    const h00 = H[j * W + i], h10 = H[j * W + i + 1], h01 = H[(j + 1) * W + i], h11 = H[(j + 1) * W + i + 1];
    return fa + fb <= 1 ? h00 + (h10 - h00) * fa + (h01 - h00) * fb : h11 + (h01 - h11) * (1 - fa) + (h10 - h11) * (1 - fb);
  }
  buildTrees() {
    const t = this.track, th = this.th, r = rng(1234 + t.n);
    const dens = th.trees * (this.q === 'high' ? 1 : this.q === 'medium' ? .55 : .28);
    if (dens <= 0) return;
    const con = [], dec = [];
    const place = (x, z) => {
      const g = this.ground(x, z);
      if (g.dist !== 1e9 && g.dist < 4.5) return;
      if (g.inside && g.ad < (g.c ? g.c[3] + 2 : 0)) return;
      if (g.i != null && this.keepOut(g.i, g.d >= 0, g.ad)) return;
      const h = g.inside ? g.h : this.terrainAt(x, z);
      const isCon = r() < th.conifer;
      (isCon ? con : dec).push([x, h, z, .75 + r() * .6, r()]);
    };
    // band of forest along the circuit
    const step = Math.max(1, Math.round(5 / t.ds));
    for (let i = 0; i < t.n; i += step) for (const sg of [1, -1]) {
      const B = sg > 0 ? t.bl[i] : t.br[i];
      for (let k = 0; k < 3; k++) {
        const dd = B + 6 + Math.pow(r(), 1.6) * 95;
        const x = t.px[i] + t.tz[i] * dd * sg + (r() - .5) * 8, z = t.pz[i] - t.tx[i] * dd * sg + (r() - .5) * 8;
        const f = this.forestField(x, z);
        if (r() < dens * (.12 + .88 * f) * (dd < B + 30 ? 1 : .7)) place(x, z);
      }
    }
    // scattered woodland over the whole terrain
    const [x0, x1, z0, z1] = this.tb, cnt = Math.round((x1 - x0) * (z1 - z0) / 900 * dens * .9);
    for (let k = 0; k < cnt; k++) { const x = x0 + r() * (x1 - x0), z = z0 + r() * (z1 - z0); if (r() < this.forestField(x, z) * .95) place(x, z) }
    // geometry
    const mk = (parts) => {
      const geos = parts.map(([geo, color]) => { const g = geo.toNonIndexed(); const n = g.attributes.position.count, c = new Float32Array(n * 3); const cc = new THREE.Color(color); for (let k = 0; k < n; k++) { c[k * 3] = cc.r; c[k * 3 + 1] = cc.g; c[k * 3 + 2] = cc.b } g.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.deleteAttribute('uv'); return g });
      let total = 0; for (const g of geos) total += g.attributes.position.count;
      const P = new Float32Array(total * 3), N = new Float32Array(total * 3), Cc = new Float32Array(total * 3); let o = 0;
      for (const g of geos) { g.computeVertexNormals(); P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); Cc.set(g.attributes.color.array, o * 3); o += g.attributes.position.count }
      const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(P, 3)); out.setAttribute('normal', new THREE.BufferAttribute(N, 3)); out.setAttribute('color', new THREE.BufferAttribute(Cc, 3)); return out;
    };
    const trunk = new THREE.CylinderGeometry(.18, .26, 4, 5).translate(0, 2, 0);
    const conGeo = mk([[trunk, 0x4a3a2a], [new THREE.ConeGeometry(2.6, 9, 7).translate(0, 7.2, 0), 0x2f4f2a], [new THREE.ConeGeometry(2.0, 6.5, 7).translate(0, 11.2, 0), 0x34572d]]);
    const decGeo = mk([[trunk.clone().scale(1.2, 1, 1.2), 0x54402d], [new THREE.IcosahedronGeometry(3.6, 0).scale(1, .85, 1).translate(0, 7, 0), 0x46692f], [new THREE.IcosahedronGeometry(2.6, 0).translate(1.5, 9, .6), 0x507436]]);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const TILE = 700, M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), Pv = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    for (const [list, geo, tall] of [[con, conGeo, 1.6], [dec, decGeo, 1.15]]) {
      const tiles = new Map();
      for (const tr of list) { const key = Math.floor(tr[0] / TILE) + ',' + Math.floor(tr[2] / TILE); if (!tiles.has(key)) tiles.set(key, []); tiles.get(key).push(tr) }
      for (const arr of tiles.values()) {
        const im = new THREE.InstancedMesh(geo, mat, arr.length);
        arr.forEach((tr, k) => { const s = tr[3] * tall; Q.setFromAxisAngle(Y, tr[4] * 6.283); S.set(s * (.85 + tr[4] * .3), s, s * (.85 + tr[4] * .3)); Pv.set(tr[0], tr[1] - .3, tr[2]); M.compose(Pv, Q, S); im.setMatrixAt(k, M); col.setHSL(.27 + tr[4] * .06, .35 + tr[4] * .2, .42 + tr[4] * .18); im.setColorAt(k, col) });
        im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere(); im.castShadow = this.q === 'high'; im.receiveShadow = false; this.group.add(im);
      }
    }
    this.treeCount = con.length + dec.length;
  }
  planBuildings() {
    const t = this.track;
    let l = 0, r = 0; for (let k = -60; k < 20; k++) { const i = t.wrap(k); l += Math.min(t.freeL[i], 120) ; r += Math.min(t.freeR[i], 120) }
    this.pitLeft = l >= r;
    // extend backwards/forwards from the line while the track is straight and there is room
    const ok = (sv, left) => { const i = t.wrap(Math.round(sv / t.ds)); const B = left ? t.bl[i] : t.br[i], free = left ? t.freeL[i] : t.freeR[i]; return Math.abs(t.ks[i]) < 1 / 700 && free > B + 30 };
    const span = left => { let a = 0, b = 0; while (a > -320 && ok(a - 15, left)) a -= 15; while (b < 80 && ok(b + 15, left)) b += 15; return [a, b] };
    this.pitSpan = span(this.pitLeft); this.standSpan = span(!this.pitLeft);
  }
  keepOut(i, left, ad) {
    const t = this.track, s = ((i * t.ds + t.length / 2) % t.length) - t.length / 2;
    for (const [span, side] of [[this.pitSpan, this.pitLeft], [this.standSpan, !this.pitLeft]]) {
      if (side === left && s > span[0] - 25 && s < span[1] + 25) { const B = left ? t.bl[i] : t.br[i]; if (ad < B + 45) return true }
    }
    return false;
  }
  /* pits, grandstands, start gantry */
  buildPits() {
    const t = this.track, g = this.group;
    const pitLeft = this.pitLeft, sg = pitLeft ? 1 : -1;
    const at = (s, d, y = 0) => { const i = t.wrap(Math.round(s / t.ds)); return new THREE.Vector3(t.px[i] + t.tz[i] * d, t.py[i] + y, t.pz[i] - t.tx[i] * d) };
    const heading = s => { const i = t.wrap(Math.round(s / t.ds)); return Math.atan2(-t.tx[i], -t.tz[i]) };
    const concrete = new THREE.MeshStandardMaterial({ color: 0xd9dbd6, roughness: .85 }), dark = new THREE.MeshStandardMaterial({ color: 0x2a3036, roughness: .4, metalness: .3 });
    const roof = new THREE.MeshStandardMaterial({ color: 0x9ea6ab, roughness: .6, metalness: .4 });
    // pit building segments following the straight
    for (let s = this.pitSpan[0] + 15; s <= this.pitSpan[1] - 15; s += 30) {
      const i = t.wrap(Math.round(s / t.ds)), B = (pitLeft ? t.bl[i] : t.br[i]) + 14;
      const p = at(s, sg * B, 0), box = new THREE.Mesh(new THREE.BoxGeometry(12, 9, 30.5), concrete); box.position.copy(p).add(new THREE.Vector3(0, 4.5, 0)); box.rotation.y = heading(s);
      box.castShadow = true; box.receiveShadow = true; g.add(box);
      const win = new THREE.Mesh(new THREE.BoxGeometry(12.1, 2.2, 30.6), dark); win.position.copy(p).add(new THREE.Vector3(0, 6.6, 0)); win.rotation.y = heading(s); g.add(win);
      const garage = new THREE.Mesh(new THREE.BoxGeometry(12.12, 3.6, 26), dark); garage.position.copy(p).add(new THREE.Vector3(0, 1.8, 0)); garage.rotation.y = heading(s); g.add(garage);
    }
    // pit wall
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: .8 });
    for (let s = this.pitSpan[0] + 5; s <= this.pitSpan[1] - 5; s += 10) {
      const i = t.wrap(Math.round(s / t.ds)), B = (pitLeft ? t.bl[i] : t.br[i]) - .2;
      const w = new THREE.Mesh(new THREE.BoxGeometry(.5, 1.1, 10.2), wallMat); w.position.copy(at(s, sg * B, .55)); w.rotation.y = heading(s); w.castShadow = true; g.add(w);
    }
    // grandstand opposite
    const seat = new THREE.MeshStandardMaterial({ color: 0x6d7a86, roughness: .8 }), crowd = new THREE.MeshStandardMaterial({ map: this.crowdTex(), roughness: 1 });
    for (let s = this.standSpan[0] + 20; s <= this.standSpan[1] - 20; s += 40) {
      const i = t.wrap(Math.round(s / t.ds)), B = (pitLeft ? t.br[i] : t.bl[i]) + 6;
      const grp = new THREE.Group(); grp.position.copy(at(s, -sg * B, 0)); grp.rotation.y = heading(s);
      for (let k = 0; k < 8; k++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(2, .9 + k * .9, 40.5), k % 2 ? seat : crowd);
        step.position.set(sg * (k * 1.6 + 1), (.9 + k * .9) / 2, 0); step.castShadow = true; grp.add(step);
      }
      const rf = new THREE.Mesh(new THREE.BoxGeometry(15, .3, 41), roof); rf.position.set(sg * 7, 11, 0); grp.add(rf);
      g.add(grp);
    }
    // start gantry with lights
    const gi = t.wrap(Math.round(-6 / t.ds)), wl = t.wl[gi] + 2.5, wr = t.wr[gi] + 2.5, hd = heading(-6);
    const steel = new THREE.MeshStandardMaterial({ color: 0x30363b, roughness: .5, metalness: .6 });
    for (const d of [wl, -wr]) { const pil = new THREE.Mesh(new THREE.BoxGeometry(.6, 8, .6), steel); pil.position.copy(at(-6, d, 4)); pil.castShadow = true; g.add(pil) }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(wl + wr, 1.4, .8), steel); beam.position.copy(at(-6, (wl - wr) / 2, 7.4)); beam.rotation.y = hd; beam.castShadow = true; g.add(beam);
    this.startLights = [];
    for (let k = 0; k < 5; k++) {
      const m = new THREE.MeshStandardMaterial({ color: 0x220806, emissive: 0xff1a0a, emissiveIntensity: 0 });
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(.32, 16), m);
      const off = (k - 2) * 1.1 + (wl - wr) / 2; lamp.position.copy(at(-6, off, 7.4)); lamp.rotation.y = hd; lamp.translateZ(.42); g.add(lamp);
      this.startLights.push(m);
    }
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(wl + wr - 1, 1.1), new THREE.MeshBasicMaterial({ map: boardTex(t.data.short.toUpperCase(), '#18201b', '#f2b705') }));
    banner.position.copy(at(-6, (wl - wr) / 2, 7.4)); banner.rotation.y = hd; banner.translateZ(.41); g.add(banner);
    banner.translateY(1.0);
  }
  crowdTex() {
    const [c, g] = canvas(128, 32), r = rng(5); g.fillStyle = '#555'; g.fillRect(0, 0, 128, 32);
    for (let k = 0; k < 500; k++) { g.fillStyle = `hsl(${r() * 360},${40 + r() * 40}%,${35 + r() * 35}%)`; g.fillRect(r() * 128, r() * 32, 2, 3) }
    return texFrom(c);
  }
  buildBoards() {
    // advertising boards from the game's fictional manufacturers, and braking-distance boards
    const t = this.track, r = rng(99), g = this.group;
    // printed on the front only; the back is a plain panel so boards seen from a parallel straight don't show mirrored text
    const back = new THREE.MeshLambertMaterial({ color: 0x3a3f3c }), backGeo = new THREE.PlaneGeometry(9, 1.7).rotateY(Math.PI), backNumGeo = new THREE.PlaneGeometry(1.4, .8).rotateY(Math.PI);
    const addBoard = (geo, bgeo, mat) => { const m = new THREE.Mesh(geo, mat); m.add(new THREE.Mesh(bgeo, back)); g.add(m); return m };
    const mats = BRANDS.map(([n, bg, fg]) => new THREE.MeshBasicMaterial({ map: boardTex(n, bg, fg) }));
    const geo = new THREE.PlaneGeometry(9, 1.7);
    const count = Math.round(t.length / 260);
    for (let k = 0; k < count; k++) {
      const i = Math.floor(r() * t.n), left = r() < .5, sg = left ? 1 : -1, B = (left ? t.bl[i] : t.br[i]) + 1.4;
      if (this.bridgeZone[i]) continue;
      const m = addBoard(geo, backGeo, mats[Math.floor(r() * mats.length)]);
      m.position.set(t.px[i] + t.tz[i] * B * sg, t.py[i] + 1.4, t.pz[i] - t.tx[i] * B * sg);
      m.rotation.y = Math.atan2(-t.tx[i], -t.tz[i]) + (left ? Math.PI / 2 : -Math.PI / 2);
    }
    // 300/200/100 boards before heavy braking zones (from the grip-limited speed profile)
    const rl = t.racingLine(), n = t.n, v = new Float32Array(n);
    for (let i = 0; i < n; i++) { const k = Math.abs(rl.k[i]); v[i] = k < 1e-4 ? 90 : Math.min(90, Math.sqrt(1.1 * 9.81 / k)) }
    for (let p = 0; p < 2; p++) for (let i = n - 1; i >= 0; i--) { const j = (i + 1) % n; v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * 9 * t.ds)) }
    const numMats = [100, 200, 300].map(d => new THREE.MeshBasicMaterial({ map: boardTex(String(d), '#f4f4f0', '#18201b') }));
    const bgeo = new THREE.PlaneGeometry(1.4, .8);
    let last = -1e9;
    for (let i = 0; i < n; i++) {
      const a = t.wrap(i - Math.round(220 / t.ds)), drop = v[a] - v[i];
      if (drop > 22 && v[t.wrap(i + 1)] >= v[i] - .01 && v[t.wrap(i - 1)] > v[i] && i * t.ds - last > 350) {
        // find where braking starts
        let st = i; while (v[t.wrap(st - 1)] > v[t.wrap(st)] + .001 && (i - st) * t.ds < 600) st--;
        const left = t.k[i] < 0, sg = left ? 1 : -1;   // boards on the outside of the corner entry
        [100, 200, 300].forEach((dist, q) => {
          const j = t.wrap(st - Math.round(dist / t.ds) + Math.round(40 / t.ds)), B = (left ? t.bl[j] : t.br[j]) - .3;
          const m = addBoard(bgeo, backNumGeo, numMats[q]); m.position.set(t.px[j] + t.tz[j] * B * sg, t.py[j] + 1.3, t.pz[j] - t.tx[j] * B * sg);
          m.rotation.y = Math.atan2(-t.tx[j], -t.tz[j]);
        });
        last = i * t.ds;
      }
    }
  }
  buildBridge() {
    const t = this.track, b = t.bridge, conc = new THREE.MeshStandardMaterial({ color: 0xb9bbb5, roughness: .85, side: THREE.DoubleSide });
    const s = []; for (let i = 0; i < t.n; i++) if (this.bridgeZone[i] === 2) s.push(i);
    s.sort((a, c) => ((a - b.upper + t.n * 1.5) % t.n) - ((c - b.upper + t.n * 1.5) % t.n));
    // deck underside & parapets
    this.group.add(this.ribbon(s, i => { const y = t.py[i]; return [[t.wl[i] + 1.2, y - .02], [t.wl[i] + 1.2, y - 1.3], [-t.wr[i] - 1.2, y - 1.3], [-t.wr[i] - 1.2, y - .02]] }, conc, { vScale: 4 }));
    const deckTop = this.ribbon(s, i => { const y = t.py[i] - .03; return [[t.wl[i] + 1.2, y], [t.wl[i], y], [-t.wr[i], y], [-t.wr[i] - 1.2, y]] }, conc, { flip: true });
    this.group.add(deckTop);
    for (const sg of [1, -1]) this.group.add(this.ribbon(s, i => { const y = t.py[i], d = sg > 0 ? t.wl[i] + 1.1 : -t.wr[i] - 1.1; return [[d, y + 1.0], [d, y - .02]] }, new THREE.MeshStandardMaterial({ color: 0xd0d2cc, roughness: .8, side: THREE.DoubleSide })));
    // piers beside the lower road
    const L = b.lower, dl = t.wl[L] + 3, dr = t.wr[L] + 3;
    for (const d of [dl, -dr]) {
      const x = t.px[L] + t.tz[L] * d, z = t.pz[L] - t.tx[L] * d, top = t.py[b.upper], bot = t.py[L];
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, top - bot, 10), conc); p.position.set(x, (top + bot) / 2 - .8, z); p.rotation.y = Math.atan2(-t.tx[L], -t.tz[L]); p.castShadow = true; this.group.add(p);
    }
  }
  buildSky() {
    const th = this.th, el = th.sun[0] * 1.1, az = th.sun[1] * Math.PI * 2;
    this.sunDir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    const top = new THREE.Color(th.sky).multiplyScalar(.82), hor = new THREE.Color(th.fog);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: top }, hor: { value: hor }, sun: { value: this.sunDir } },
      vertexShader: 'varying vec3 vd; void main(){ vd = normalize(position); vec4 p = modelViewMatrix*vec4(position,1.); gl_Position = projectionMatrix*p; gl_Position.z = gl_Position.w; }',
      fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 sun; varying vec3 vd;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        void main(){ vec3 d = normalize(vd); float y = max(d.y, 0.);
          vec3 c = mix(hor, top, pow(y, .55));
          vec2 uv = d.xz / max(d.y, .08) * 1.6;
          float cl = n(uv) * .55 + n(uv * 2.3 + 7.) * .3 + n(uv * 5.1) * .15;
          cl = smoothstep(.55, .85, cl) * smoothstep(0., .25, d.y);
          c = mix(c, vec3(.97), cl * .65);
          float s = max(dot(d, sun), 0.);
          c += vec3(1., .9, .7) * (pow(s, 900.) * 3. + pow(s, 12.) * .18);
          if (d.y < 0.) c = hor;
          gl_FragColor = vec4(c, 1.); }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 32, 16), mat); sky.frustumCulled = false; sky.renderOrder = -1;
    this.sky = sky; this.group.add(sky);
    this.fogColor = hor;
  }
  envScene() {
    const s = new THREE.Scene(); const m = this.sky.material.clone(); s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), m));
    const gm = new THREE.Mesh(new THREE.CircleGeometry(10, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(this.th.grass2).multiplyScalar(.6) })); gm.rotation.x = -Math.PI / 2; gm.position.y = -.5; s.add(gm);
    return s;
  }
}
