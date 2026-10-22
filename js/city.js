/* Free-roam city map: streamed 1 km region tiles, ground/surface/collision queries for the car physics,
   the road network for the minimap and navigation. Built offline by tools/city/build_city.py.
   World: x = east, z = south, y = up (metres above sea level). */
import { SURF } from './track.js';

export const CSURF = {
  road: { mu: 1.0, drag: 0, bump: 0, id: 0 },
  plaza: { mu: .95, drag: 0, bump: .04, id: 0 },
  side: { mu: .93, drag: 0, bump: .25, id: 1 },
  ground: { mu: .86, drag: .02, bump: .16, id: 3 },
  paved: { mu: .93, drag: 0, bump: .06, id: 3 },
  grass: SURF.grass,
  forest: { mu: .55, drag: .08, bump: .7, id: 4 },
  field: { mu: .62, drag: .06, bump: .5, id: 4 },
  gravel: SURF.gravel,
  water: { mu: .45, drag: .55, bump: .35, id: 5 },
};
// area kinds from the builder -> surface, and which one wins where areas overlap
const AREA_SURF = [null, 'grass', 'forest', 'water', 'paved', 'paved', 'gravel', 'grass', 'field', 'grass', 'ground', 'gravel', 'paved', 'grass', 'ground'];
const AREA_PRI = [0, 3, 4, 9, 7, 8, 5, 6, 2, 3, 1, 5, 8, 3, 1];
export const ROAD_NAMES = { 1: 'motorway', 2: 'trunk', 3: 'primary', 4: 'secondary', 5: 'tertiary', 6: 'unclassified', 7: 'residential', 8: 'living', 9: 'service', 10: 'pedestrian', 16: 'runway', 17: 'taxiway' };

const CELL = 24, NEAR = 70;
const ckey = (cx, cz) => ((cx + 4096) << 13) | (cz + 4096);

function parseRegion(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x3143574d) throw new Error('bad region file');
  const n = dv.getUint32(4, true), hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))), base = 8 + n, A = {};
  for (const [k, [ty, off, cnt]] of Object.entries(hdr.arr)) A[k] = new (ty === 'i16' ? Int16Array : ty === 'u16' ? Uint16Array : Uint8Array)(buf, base + off, cnt);
  return { hdr, A };
}
export function rngS(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e7) / 1e7 } }

/* one 1 km tile in world coordinates with a 24 m spatial hash */
class Region {
  constructor(city, i, j, buf) { this.i = i; this.j = j; this.key = i + '_' + j; this.city = city; this.buf = buf; this.hash = new Map() }
  /* parsing in short phases so a new tile never stalls a frame for long */
  *init() {
    const { hdr, A } = parseRegion(this.buf), ox = hdr.x0, oz = hdr.z0, i = this.i, j = this.j, city = this.city; this.buf = null;
    this.x0 = ox; this.z0 = oz;
    // ---- roads
    const np = A.rp.length / 3, rx = this.rx = new Float32Array(np), rz = this.rz = new Float32Array(np), rh = this.rh = new Float32Array(np), rj = this.rj = new Float32Array(np);
    for (let k = 0; k < np; k++) { rx[k] = ox + A.rp[k * 3] / 10; rz[k] = oz + A.rp[k * 3 + 1] / 10; rh[k] = A.rp[k * 3 + 2] / 10; rj[k] = A.rj[k] / 2 }
    const nr = A.rn.length; this.nRoads = nr;
    const ps = this.ps = new Int32Array(nr + 1), pc = this.pc = new Uint8Array(nr), phw = this.phw = new Float32Array(nr), psw = this.psw = new Float32Array(nr), pf = this.pf = new Uint8Array(nr), pl = this.pl = new Uint8Array(nr), pn = this.pn = new Uint16Array(nr), pel = this.pel = new Float32Array(nr);
    for (let p = 0, k = 0; p < nr; p++) { ps[p] = k; k += A.rn[p]; pc[p] = A.ra[p * 6]; phw[p] = A.ra[p * 6 + 1] / 8; pf[p] = A.ra[p * 6 + 2]; psw[p] = A.ra[p * 6 + 3] / 4; pl[p] = A.ra[p * 6 + 4]; pn[p] = A.rnm[p] }
    ps[nr] = np;
    // segments: id = point index of the start (the next point is the end); pieces never share points
    this.segP = new Int32Array(np);
    for (let p = 0; p < nr; p++) {
      let mx = 0;
      for (let k = ps[p]; k < ps[p + 1]; k++) { this.segP[k] = p; mx = Math.max(mx, rh[k] - city.terrainH(rx[k], rz[k])) }
      pel[p] = mx;
      const R = phw[p] + psw[p] + 6;
      for (let k = ps[p]; k < ps[p + 1] - 1; k++) this.add('s', k, Math.min(rx[k], rx[k + 1]) - R, Math.min(rz[k], rz[k + 1]) - R, Math.max(rx[k], rx[k + 1]) + R, Math.max(rz[k], rz[k + 1]) + R);
      if (p % 300 === 299) yield;
    }
    yield;
    // ---- buildings
    const nb = A.bn.length, nbp = A.bp.length / 2; this.nB = nb;
    const bx = this.bx = new Float32Array(nbp), bz = this.bz = new Float32Array(nbp);
    for (let k = 0; k < nbp; k++) { bx[k] = ox + A.bp[k * 2] / 10; bz[k] = oz + A.bp[k * 2 + 1] / 10 }
    const bs = this.bs = new Int32Array(nb + 1), bTop = this.bTop = new Float32Array(nb), bMin = this.bMin = new Float32Array(nb), bBase = this.bBase = new Float32Array(nb), bSt = this.bSt = new Uint8Array(nb), bCol = this.bCol = new Uint8Array(nb), bFl = this.bFl = new Uint8Array(nb);
    const bRs = this.bRs = new Uint8Array(nb), bRh = this.bRh = new Float32Array(nb), bWc = this.bWc = new Uint8Array(nb * 3), bRc = this.bRc = new Uint8Array(nb * 3), BS = A.bs.length / Math.max(1, nb);
    for (let b = 0, k = 0; b < nb; b++) {
      bs[b] = k; const n = A.bn[b];
      const o8 = b * BS; bBase[b] = A.bb[b] / 10; bTop[b] = bBase[b] + A.bh[b] / 10; bMin[b] = bBase[b] + A.bm[b] / 10; bSt[b] = A.bs[o8]; bCol[b] = A.bs[o8 + 1]; bFl[b] = A.bs[o8 + 2];
      if (BS >= 12) { bRs[b] = A.bs[o8 + 3]; for (let q = 0; q < 3; q++) { bWc[b * 3 + q] = A.bs[o8 + 4 + q]; bRc[b * 3 + q] = A.bs[o8 + 7 + q] } bRh[b] = A.bs[o8 + 10] / 4 }
      // orient rings counter-clockwise in (x, -z) (outward normals = right of the edge direction in x/z)
      let ar = 0; for (let m = 0; m < n; m++) { const a = k + m, c = k + (m + 1) % n; ar += bx[a] * bz[c] - bx[c] * bz[a] }
      if (ar < 0) { for (let m = 0; m < n >> 1; m++) { const a = k + m, c = k + n - 1 - m; let t = bx[a]; bx[a] = bx[c]; bx[c] = t; t = bz[a]; bz[a] = bz[c]; bz[c] = t } }
      let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (let m = 0; m < n; m++) { x0 = Math.min(x0, bx[k + m]); x1 = Math.max(x1, bx[k + m]); z0 = Math.min(z0, bz[k + m]); z1 = Math.max(z1, bz[k + m]) }
      if (!(bFl[b] & 1) && bMin[b] - bBase[b] < 2.5) this.add('b', b, x0, z0, x1, z1);
      k += n;
      if (b % 600 === 599) yield;
    }
    yield;
    bs[nb] = nbp;
    // ---- ground areas (outer rings followed by their holes)
    const na = A.an.length, nap = A.ap.length / 2;
    const ax = this.ax = new Float32Array(nap), az = this.az = new Float32Array(nap);
    for (let k = 0; k < nap; k++) { ax[k] = ox + A.ap[k * 2] / 10; az[k] = oz + A.ap[k * 2 + 1] / 10 }
    const as = this.as = new Int32Array(na + 1), ak = this.ak = new Uint8Array(na), ahole = this.ahole = new Uint8Array(na), aOuter = this.aOuter = new Int32Array(na);
    let lastOuter = -1;
    for (let r = 0, k = 0; r < na; r++) {
      as[r] = k; ak[r] = A.ak[r] & 0x7f; ahole[r] = A.ak[r] & 0x80 ? 1 : 0; if (!ahole[r]) lastOuter = r; aOuter[r] = lastOuter;
      const n = A.an[r];
      if (!ahole[r]) { let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (let m = 0; m < n; m++) { x0 = Math.min(x0, ax[k + m]); x1 = Math.max(x1, ax[k + m]); z0 = Math.min(z0, az[k + m]); z1 = Math.max(z1, az[k + m]) } this.add('a', r, x0, z0, x1, z1) }
      k += n;
    }
    as[na] = nap; this.nA = na;
    yield;
    // ---- lines (rails k=1, trams k=2, rivers k=3 with width in the h slot), crossings, signals
    const nl = A.ln.length, nlp = A.lp.length / 3;
    this.lx = new Float32Array(nlp); this.lz = new Float32Array(nlp); this.lh = new Float32Array(nlp);
    for (let k = 0; k < nlp; k++) { this.lx[k] = ox + A.lp[k * 3] / 10; this.lz[k] = oz + A.lp[k * 3 + 1] / 10; this.lh[k] = A.lp[k * 3 + 2] / 10 }
    this.ls = new Int32Array(nl + 1); this.lk = A.ln.length ? new Uint8Array(A.lk) : new Uint8Array(0);
    for (let l = 0, k = 0; l < nl; l++) { this.ls[l] = k; k += A.ln[l] } this.ls[nl] = nlp; this.nL = nl;
    this.cross = []; for (let k = 0; k < A.cp.length; k += 6) this.cross.push([ox + A.cp[k] / 10, oz + A.cp[k + 1] / 10, A.cp[k + 2] / 10, A.cp[k + 3] / 1000, A.cp[k + 4] / 1000, A.cp[k + 5] / 10]);
    this.sig = []; for (let k = 0; k < A.sp.length; k += 7) this.sig.push([ox + A.sp[k] / 10, oz + A.sp[k + 1] / 10, A.sp[k + 2] / 10, A.sp[k + 3] / 1000, A.sp[k + 4] / 1000, A.sp[k + 5] / 10]);
    // ---- trees: mapped ones + park and forest planting (deterministic per tile)
    const tr = []; for (let k = 0; k < A.tp.length; k += 2) tr.push(ox + A.tp[k] / 10, oz + A.tp[k + 1] / 10, 0);
    const r = rngS(9973 + (i + 50) * 131 + (j + 50) * 7919);
    const DENS = { 1: 1 / 160, 2: 1 / 60, 13: 1 / 170, 9: 1 / 110 };
    for (let a = 0; a < na; a++) {
      if (ahole[a] || !DENS[ak[a]]) continue;
      let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (let k = as[a]; k < as[a + 1]; k++) { x0 = Math.min(x0, ax[k]); x1 = Math.max(x1, ax[k]); z0 = Math.min(z0, az[k]); z1 = Math.max(z1, az[k]) }
      const cnt = Math.min(1500, Math.round((x1 - x0) * (z1 - z0) * DENS[ak[a]]));
      for (let m = 0; m < cnt; m++) {
        const x = x0 + r() * (x1 - x0), z = z0 + r() * (z1 - z0);
        if (!this.inArea(a, x, z)) continue;
        tr.push(x, z, ak[a] === 2 ? 1 : 0);
      }
      if (a % 40 === 39) yield;
    }
    yield;
    // keep trees off roads and out of buildings
    const T = []; for (let k = 0; k < tr.length; k += 3) { const x = tr[k], z = tr[k + 1]; if (k % 3000 === 2997) yield; if (this.city.onRoad(x, z, 1.4, this) || this.inBuilding(x, z) >= 0) continue; T.push(x, z, tr[k + 2]) }
    this.trees = new Float32Array(T); this.nT = T.length / 3;
    for (let t = 0; t < this.nT; t++) { const x = this.trees[t * 3], z = this.trees[t * 3 + 1]; this.add('t', t, x - .5, z - .5, x + .5, z + .5) }
  }
  add(type, id, x0, z0, x1, z1) {
    const c0 = Math.floor(x0 / CELL), c1 = Math.floor(x1 / CELL), d0 = Math.floor(z0 / CELL), d1 = Math.floor(z1 / CELL);
    for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) {
      const k = ckey(cx, cz); let e = this.hash.get(k); if (!e) this.hash.set(k, e = { s: [], b: [], a: [], t: [] });
      e[type].push(id);
    }
  }
  cellAt(x, z) { return this.hash.get(ckey(Math.floor(x / CELL), Math.floor(z / CELL))) }
  ringContains(s0, s1, X, Z, x, z) {
    let ins = false;
    for (let k = s0, m = s1 - 1; k < s1; m = k++) { if ((Z[k] > z) !== (Z[m] > z) && x < (X[m] - X[k]) * (z - Z[k]) / (Z[m] - Z[k]) + X[k]) ins = !ins }
    return ins;
  }
  inArea(r, x, z) {
    if (!this.ringContains(this.as[r], this.as[r + 1], this.ax, this.az, x, z)) return false;
    for (let h = r + 1; h < this.nA && this.ahole[h] && this.aOuter[h] === r; h++) if (this.ringContains(this.as[h], this.as[h + 1], this.ax, this.az, x, z)) return false;
    return true;
  }
  inBuilding(x, z) {
    const c = this.cellAt(x, z); if (!c) return -1;
    for (const b of c.b) if (this.ringContains(this.bs[b], this.bs[b + 1], this.bx, this.bz, x, z)) return b;
    return -1;
  }
}

export class City {
  constructor(base, meta, terrainBuf, netBuf) {
    this.base = base; this.meta = meta; this.id = meta.id; this.name = meta.name; this.free = true;
    const T = this.T = meta.terrain; this.H = new Int16Array(terrainBuf);
    this.REG = meta.reg; this.regions = new Map(); this.loading = new Map();
    this.avail = new Set(meta.regions.map(([i, j]) => i + '_' + j)); this.regIndex = new Map(meta.regions.map(([i, j], n) => [i + '_' + j, n]));
    this.area = meta.area; this.names = meta.names;
    this.parseNet(netBuf);
    this.g = { h: 0, p: -1, R: null, side: false, d: 0, hw: 0, s: -1, t: 0 };   // scratch result of ground()
    this.lastY = null;
  }
  /* ---------- terrain ---------- */
  terrainH(x, z) {
    const T = this.T, fx = (x - T.x0) / T.s, fz = (z - T.z0) / T.s;
    const i = Math.min(Math.max(Math.floor(fx), 0), T.nx - 2), j = Math.min(Math.max(Math.floor(fz), 0), T.nz - 2);
    const u = Math.min(Math.max(fx - i, 0), 1), v = Math.min(Math.max(fz - j, 0), 1), H = this.H, n = T.nx;
    return ((H[j * n + i] * (1 - u) + H[j * n + i + 1] * u) * (1 - v) + (H[(j + 1) * n + i] * (1 - u) + H[(j + 1) * n + i + 1] * u) * v) / 10;
  }
  /* ---------- regions ---------- */
  regionAt(x, z) { return this.regions.get(Math.floor(x / this.REG) + '_' + Math.floor(z / this.REG)) }
  hasRegion(i, j) { return this.avail.has(i + '_' + j) }
  async loadRegion(i, j) {
    const key = i + '_' + j;
    if (this.regions.has(key)) return this.regions.get(key);
    if (this.loading.has(key)) return this.loading.get(key);
    const p = (async () => {
      const R = new Region(this, i, j, await this.tileBuffer(i, j));
      // run the parsing phases, yielding to the frame loop when one takes more than ~4 ms
      const it = R.init(); let t0 = performance.now();
      while (!it.next().done) if (performance.now() - t0 > 4) { await new Promise(r => setTimeout(r, 0)); t0 = performance.now() }
      this.regions.set(key, R); this.loading.delete(key); return R;
    })();
    p.catch(() => this.loading.delete(key));
    this.loading.set(key, p); return p;
  }
  unloadRegion(key) { this.regions.delete(key) }
  /* tiles come bundled in packs of meta.pack x meta.pack km; the last few packs stay in memory */
  async tileBuffer(i, j) {
    const P = this.meta.pack || 1, pk = Math.floor(i / P) + '_' + Math.floor(j / P);
    this.packs = this.packs || new Map();
    let pp = this.packs.get(pk);
    if (!pp) {
      pp = fetchBin(`${this.base}p_${pk}.bin`).then(buf => {
        const dv = new DataView(buf), n = dv.getUint32(4, true), idx = new Map();
        for (let k = 0; k < n; k++) { const o = 8 + 12 * k; idx.set(dv.getInt16(o, true) + '_' + dv.getInt16(o + 2, true), [dv.getUint32(o + 4, true), dv.getUint32(o + 8, true)]) }
        return { buf, idx };
      });
      pp.catch(() => this.packs.delete(pk));
      this.packs.set(pk, pp);
      while (this.packs.size > 6) this.packs.delete(this.packs.keys().next().value);
    } else { this.packs.delete(pk); this.packs.set(pk, pp) }
    const { buf, idx } = await pp, e = idx.get(i + '_' + j);
    if (!e) throw new Error('tile ' + i + '_' + j + ' missing');
    return buf.slice(e[0], e[0] + e[1]);
  }
  /* the region of (x,z) and neighbours when close to their border */
  near(x, z) {
    const out = this._near || (this._near = []); out.length = 0;
    const G = this.REG, i = Math.floor(x / G), j = Math.floor(z / G), fx = x - i * G, fz = z - j * G;
    const di = fx < NEAR ? -1 : fx > G - NEAR ? 1 : 0, dj = fz < NEAR ? -1 : fz > G - NEAR ? 1 : 0;
    const add = (a, b) => { const R = this.regions.get(a + '_' + b); if (R) out.push(R) };
    add(i, j); if (di) add(i + di, j); if (dj) add(i, j + dj); if (di && dj) add(i + di, j + dj);
    return out;
  }
  onRoad(x, z, extra, R0) {
    const list = R0 ? [R0] : this.near(x, z);
    for (const R of list) {
      const c = R.cellAt(x, z); if (!c) continue;
      for (const s of c.s) { const p = R.segP[s], d = this.segDist(R, s, x, z); if (d < R.phw[p] + extra) return true }
    }
    return false;
  }
  segDist(R, s, x, z) {
    const ax = R.rx[s], az = R.rz[s], dx = R.rx[s + 1] - ax, dz = R.rz[s + 1] - az, L2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t; this._t = t;
    return Math.hypot(x - ax - dx * t, z - az - dz * t);
  }
  /* ground under (x,z) for a car at height yRef: the highest road surface it can be on, else terrain blended toward nearby roads */
  ground(x, z, yRef, out = this.g) {
    let best = -1e9, bp = -1, bR = null, bside = false, bd = 0, bs = -1, bt = 0, nearH = 0, nearW = 0, nearD = 1e9;
    const lim = yRef == null ? 1e9 : yRef + 1.3;
    for (const R of this.near(x, z)) {
      const c = R.cellAt(x, z); if (!c) continue;
      for (const s of c.s) {
        const p = R.segP[s], d = this.segDist(R, s, x, z), t = this._t, hw = R.phw[p], edge = hw + R.psw[p];
        const h = R.rh[s] + (R.rh[s + 1] - R.rh[s]) * t;
        if (d <= edge) {
          if (h > lim) continue;
          const side = d > hw;
          if (h > best + .25 || (Math.abs(h - best) <= .25 && bside && !side)) { best = h; bp = p; bR = R; bside = side; bd = d; bs = s; bt = t }
        } else if (d - edge < nearD && Math.abs(h - (yRef ?? h)) < 2.5) { nearD = d - edge; nearH = h; nearW = 1 }
      }
    }
    out.p = bp; out.R = bR; out.side = bside; out.d = bd; out.s = bs; out.t = bt;
    if (bp >= 0) { out.h = best; out.hw = bR.phw[bp]; return out }
    let h = this.terrainH(x, z);
    // ease the ground into nearby road levels so leaving the road is not a step
    if (nearW && nearD < 6 && Math.abs(nearH - h) < 1.6) { const f = nearD / 6, k = f * f * (3 - 2 * f); h = nearH + (h - nearH) * k }
    out.h = h; out.hw = 0;
    return out;
  }
  /* ---------- physics interface (same shape as Track) ---------- */
  locate(x, z, hint, out = {}, vx = 0, vz = 0, y = null) {
    const v = Math.hypot(vx, vz);
    let fx = out.fx ?? 0, fz = out.fz ?? -1;
    if (v > .3) { fx = vx / v; fz = vz / v }
    const yy = y ?? this.lastY;
    const g = this.ground(x, z, yy), h = g.h;
    out.road = g.p >= 0 ? g.R.pc[g.p] : 0; out.side = g.side; out.name = g.p >= 0 ? g.R.pn[g.p] : 65535; out.elev = g.p >= 0 ? g.R.pel[g.p] : 0;
    out.segR = g.R; out.segS = g.s; out.segP = g.p; out.hw = g.hw; out.dRoad = g.d;
    const yr = h + .2;
    const h1 = this.ground(x + fx * 2, z + fz * 2, yr, this.g2 || (this.g2 = {})).h, h0 = this.ground(x - fx * 2, z - fz * 2, yr, this.g2).h;
    let kv = (h1 - 2 * h + h0) / 4;
    out.i = 0; out.t = 0; out.d = 0; out.s = 0; out.h = h; out.grade = Math.max(-.35, Math.min(.35, (h1 - h0) / 4));
    out.kv = Math.max(-.012, Math.min(.012, kv)); out.fx = fx; out.fz = fz; out.wl = out.wr = 50;
    this.lastY = h;
    return out;
  }
  surface() { return CSURF.road }
  barrier() { return 1e9 }
  surfaceAt(x, z, y) {
    const g = this.ground(x, z, y ?? this.lastY, this.g3 || (this.g3 = {}));
    if (g.p >= 0) { const c = g.R.pc[g.p]; return g.side ? CSURF.side : c === 10 ? CSURF.plaza : CSURF.road }
    let best = null, pri = -1;
    for (const R of this.near(x, z)) {
      const c = R.cellAt(x, z); if (!c) continue;
      for (const a of c.a) { const k = R.ak[a]; if (AREA_PRI[k] > pri && R.inArea(a, x, z)) { pri = AREA_PRI[k]; best = AREA_SURF[k] } }
    }
    return CSURF[best || 'ground'];
  }
  /* walls: buildings, trees, the edges of raised roads and bridges, the map boundary */
  collide(sim) {
    const s = sim.spec, hl = (s.a + s.b) / 2 + .8, hw = s.W / 2 + .05;
    const sp = Math.sin(sim.psi), cp = Math.cos(sim.psi), fx = -sp, fz = -cp, lx = -cp, lz = sp;
    const cx = sim.x + fx * (s.a - s.b) / 2, cz = sim.z + fz * (s.a - s.b) / 2;
    const P = this._pts || (this._pts = Array.from({ length: 10 }, () => [0, 0]));
    const OFF = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [.45, 1], [.45, -1], [-.45, 1], [-.45, -1]];
    for (let k = 0; k < 10; k++) { const [a, b] = OFF[k]; P[k][0] = cx + fx * hl * a + lx * hw * b; P[k][1] = cz + fz * hl * a + lz * hw * b }
    const y = sim.y;
    // buildings: deepest point inside a footprint
    let bestPen = 0, bnx = 0, bnz = 0, btx = 0, btz = 0;
    for (const [x, z] of P) {
      for (const R of this.near(x, z)) {
        const c = R.cellAt(x, z); if (!c) continue;
        for (const b of c.b) {
          if (R.bTop[b] < y + .4 || R.bMin[b] > y + 1.6) continue;
          const s0 = R.bs[b], s1 = R.bs[b + 1];
          if (!R.ringContains(s0, s1, R.bx, R.bz, x, z)) continue;
          // nearest edge
          let dmin = 1e9, ex = 0, ez = 0, etx = 0, etz = 0;
          for (let k = s0; k < s1; k++) {
            const k2 = k + 1 < s1 ? k + 1 : s0, ax = R.bx[k], az = R.bz[k], dx = R.bx[k2] - ax, dz = R.bz[k2] - az, L2 = dx * dx + dz * dz || 1;
            let t = ((x - ax) * dx + (z - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = ax + dx * t, qz = az + dz * t, d = Math.hypot(x - qx, z - qz);
            if (d < dmin) { dmin = d; const L = Math.sqrt(L2); etx = dx / L; etz = dz / L; ex = etz; ez = -etx }   // (ex,ez): outward normal of a CCW ring in (x,-z)
          }
          if (dmin > bestPen) { bestPen = dmin; bnx = -ex; bnz = -ez; btx = etx; btz = etz }
        }
      }
    }
    if (bestPen > 0) sim.hitWall(bnx, bnz, Math.min(bestPen, 1.5) + .01, btx, btz);
    // trees (trunks as 0.35 m circles against the car box)
    for (const R of this.near(sim.x, sim.z)) {
      const c = R.cellAt(sim.x, sim.z); if (!c) continue;
      for (const t of c.t) {
        const tx = R.trees[t * 3], tz = R.trees[t * 3 + 1], dx = tx - cx, dz = tz - cz;
        const u = dx * fx + dz * fz, w = dx * lx + dz * lz;
        if (Math.abs(u) > hl + .4 || Math.abs(w) > hw + .4) continue;
        const qu = Math.max(-hl, Math.min(hl, u)), qw = Math.max(-hw, Math.min(hw, w));
        let nx, nz, pen;
        if (qu === u && qw === w) { const eu = hl - Math.abs(u), ew = hw - Math.abs(w); if (eu < ew) { nx = fx * Math.sign(u); nz = fz * Math.sign(u); pen = eu + .35 } else { nx = lx * Math.sign(w); nz = lz * Math.sign(w); pen = ew + .35 } }
        else { const ddx = (u - qu) * fx + (w - qw) * lx, ddz = (u - qu) * fz + (w - qw) * lz, dd = Math.hypot(ddx, ddz); if (dd > .35) continue; nx = ddx / (dd || 1); nz = ddz / (dd || 1); pen = .35 - dd }
        sim.hitWall(nx, nz, pen, -nz, nx);
      }
    }
    // raised roads: guard rails on the deck, embankment sides from below
    const g = this.ground(sim.x, sim.z, y, this.g4 || (this.g4 = {}));
    for (let k = 0; k < 4; k++) {
      const [x, z] = P[k];
      if (g.p >= 0 && g.R.pel[g.p] > 1.4) {
        const q = this.ground(x, z, y, this.g5 || (this.g5 = {}));
        if (q.p < 0 && this.terrainH(x, z) < y - 1.4) {
          // corner hangs over the edge: push back across the supporting segment
          const R = g.R, sg = g.s, ax = R.rx[sg], az = R.rz[sg], dx = R.rx[sg + 1] - ax, dz = R.rz[sg + 1] - az, L = Math.hypot(dx, dz) || 1;
          const tx = dx / L, tz = dz / L, side = (x - ax) * tz - (z - az) * tx, edge = R.phw[g.p] + R.psw[g.p];
          const pen = Math.abs(side) - edge; if (pen > 0) sim.hitWall(tz * Math.sign(side), -tx * Math.sign(side), Math.min(pen, 1) + .01, tx, tz);
        }
      } else {
        const q = this.ground(x, z, null, this.g5 || (this.g5 = {}));
        if (q.p >= 0 && q.h > y + 1.3 && q.h - this.terrainH(x, z) < 4.6 && q.R.pel[q.p] > 1.4) {
          const R = q.R, sg = q.s, ax = R.rx[sg], az = R.rz[sg], dx = R.rx[sg + 1] - ax, dz = R.rz[sg + 1] - az, L = Math.hypot(dx, dz) || 1;
          const tx = dx / L, tz = dz / L, side = (x - ax) * tz - (z - az) * tx, edge = R.phw[q.p] + R.psw[q.p];
          const pen = edge - Math.abs(side); if (pen > 0) sim.hitWall(-tz * Math.sign(side), tx * Math.sign(side), Math.min(pen, 1) + .01, tx, tz);
        }
      }
    }
    // map boundary
    if (!this.inArea(sim.x, sim.z)) {
      const e = this.nearestAreaEdge(sim.x, sim.z);
      sim.hitWall(-e.nx, -e.nz, e.d + .05, e.tx, e.tz);
      sim.outside = true;
    } else sim.outside = false;
  }
  inArea(x, z) {
    const A = this.area; let ins = false;
    for (let k = 0, m = A.length - 1; k < A.length; m = k++) { if ((A[k][1] > z) !== (A[m][1] > z) && x < (A[m][0] - A[k][0]) * (z - A[k][1]) / (A[m][1] - A[k][1]) + A[k][0]) ins = !ins }
    return ins;
  }
  nearestAreaEdge(x, z) {
    const A = this.area; let best = { d: 1e9 };
    for (let k = 0; k < A.length; k++) {
      const a = A[k], b = A[(k + 1) % A.length], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
      let t = ((x - a[0]) * dx + (z - a[1]) * dz) / L2; t = Math.max(0, Math.min(1, t));
      const qx = a[0] + dx * t, qz = a[1] + dz * t, d = Math.hypot(x - qx, z - qz);
      if (d < best.d) { const L = Math.sqrt(L2); best = { d, nx: (qx - x) / (d || 1), nz: (qz - z) / (d || 1), tx: dx / L, tz: dz / L } }
    }
    // normal pointing from the car back inside
    best.nx = -best.nx; best.nz = -best.nz; return best;
  }
  /* nearest drivable road point in the loaded tiles (for resets) */
  nearestRoad(x, z, maxD = 400, minClass = 9) {
    let best = null, bd = 1e9;
    for (const R of this.regions.values()) {
      if (x < R.x0 - maxD || x > R.x0 + this.REG + maxD || z < R.z0 - maxD || z > R.z0 + this.REG + maxD) continue;
      for (let p = 0; p < R.nRoads; p++) {
        if (R.pc[p] > minClass && R.pc[p] < 16) continue;
        for (let k = R.ps[p]; k < R.ps[p + 1] - 1; k++) {
          const d = this.segDist(R, k, x, z) + (R.pel[p] > 3 ? 25 : 0);
          if (d < bd) { bd = d; const t = this._t, dx = R.rx[k + 1] - R.rx[k], dz = R.rz[k + 1] - R.rz[k], L = Math.hypot(dx, dz) || 1; best = { x: R.rx[k] + dx * t, z: R.rz[k] + dz * t, y: R.rh[k] + (R.rh[k + 1] - R.rh[k]) * t, dx: dx / L, dz: dz / L, hw: R.phw[p], ow: R.pf[p] & 1 } }
        }
      }
    }
    return best;
  }
  roadName(i) { return i == null || i === 65535 ? '' : this.names[i] || '' }
  /* ---------- road network (minimap & navigation) ---------- */
  parseNet(buf) {
    const dv = new DataView(buf), nN = dv.getUint32(4, true), nE = dv.getUint32(8, true); let o = 12;
    this.nodeXY = new Float32Array(buf, o, nN * 2); o += nN * 8;
    const E = new Uint32Array(buf, o, nE * 5); o += nE * 20;
    const EL = new Float32Array(buf, o, nE); o += nE * 4;
    const PC = new Uint16Array(buf, o, nE); o += nE * 2; while (o % 4) o++;
    const nP = dv.getUint32(o, true); o += 4;
    this.netPts = new Float32Array(buf, o, nP * 2);
    this.eA = new Uint32Array(nE); this.eB = new Uint32Array(nE); this.eC = new Uint8Array(nE); this.eOW = new Uint8Array(nE); this.eP = new Uint32Array(nE); this.eN = new Uint16Array(nE); this.eL = EL; this.eNm = new Uint16Array(nE);
    for (let e = 0; e < nE; e++) { this.eA[e] = E[e * 5]; this.eB[e] = E[e * 5 + 1]; this.eC[e] = E[e * 5 + 2] & 255; this.eOW[e] = (E[e * 5 + 2] >> 8) & 1; this.eP[e] = E[e * 5 + 3]; this.eN[e] = PC[e]; this.eNm[e] = E[e * 5 + 4] }
    this.nE = nE; this.nN = nN;
    // adjacency
    const deg = new Uint32Array(nN + 1); for (let e = 0; e < nE; e++) { deg[this.eA[e]]++; deg[this.eB[e]]++ }
    this.adjS = new Uint32Array(nN + 1); for (let n = 0; n < nN; n++) this.adjS[n + 1] = this.adjS[n] + deg[n];
    this.adjE = new Uint32Array(this.adjS[nN]); const fill = this.adjS.slice(0, nN);
    for (let e = 0; e < nE; e++) { this.adjE[fill[this.eA[e]]++] = e; this.adjE[fill[this.eB[e]]++] = e }
    // connected components: navigation snaps to the main network
    const comp = this.comp = new Int32Array(nN).fill(-1); let nc = 0, bestC = 0, bestN = 0;
    for (let n0 = 0; n0 < nN; n0++) {
      if (comp[n0] >= 0) continue; const stack = [n0]; comp[n0] = nc; let cnt = 0;
      while (stack.length) { const n = stack.pop(); cnt++; for (let k = this.adjS[n]; k < this.adjS[n + 1]; k++) { const e = this.adjE[k], m = this.eA[e] === n ? this.eB[e] : this.eA[e]; if (comp[m] < 0) { comp[m] = nc; stack.push(m) } } }
      if (cnt > bestN) { bestN = cnt; bestC = nc } nc++;
    }
    this.mainComp = bestC;
    // edge grid for the minimap (250 m cells)
    this.netCell = 250; this.netGrid = new Map();
    for (let e = 0; e < nE; e++) {
      const s = this.eP[e], n = this.eN[e]; let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
      for (let k = 0; k < n; k++) { const x = this.netPts[(s + k) * 2], z = this.netPts[(s + k) * 2 + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z) }
      for (let cx = Math.floor(x0 / 250); cx <= Math.floor(x1 / 250); cx++) for (let cz = Math.floor(z0 / 250); cz <= Math.floor(z1 / 250); cz++) { const k = cx + ',' + cz; let a = this.netGrid.get(k); if (!a) this.netGrid.set(k, a = []); a.push(e) }
    }
  }
  edgesNear(x, z, r) {
    const out = new Set(), C = this.netCell;
    for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) for (let cz = Math.floor((z - r) / C); cz <= Math.floor((z + r) / C); cz++) { const a = this.netGrid.get(cx + ',' + cz); if (a) for (const e of a) out.add(e) }
    return out;
  }
  nearestNode(x, z) {
    let best = -1, bd = 1e18;
    for (const e of this.edgesNear(x, z, 300)) for (const n of [this.eA[e], this.eB[e]]) { if (this.comp[n] !== this.mainComp) continue; const d = (this.nodeXY[n * 2] - x) ** 2 + (this.nodeXY[n * 2 + 1] - z) ** 2; if (d < bd) { bd = d; best = n } }
    if (best < 0) for (let n = 0; n < this.nN; n++) { if (this.comp[n] !== this.mainComp) continue; const d = (this.nodeXY[n * 2] - x) ** 2 + (this.nodeXY[n * 2 + 1] - z) ** 2; if (d < bd) { bd = d; best = n } }
    return best;
  }
  /* A* over the road network (one-way streets ignored: the city is empty). Returns a polyline [x,z,...] */
  route(x0, z0, x1, z1) {
    const a = this.nearestNode(x0, z0), b = this.nearestNode(x1, z1); if (a < 0 || b < 0) return null;
    const N = this.nN, g = this._g || (this._g = new Float32Array(N)), from = this._from || (this._from = new Int32Array(N)), seen = this._seen || (this._seen = new Uint8Array(N));
    g.fill(Infinity); from.fill(-1); seen.fill(0);
    const bx = this.nodeXY[b * 2], bz = this.nodeXY[b * 2 + 1], hx = n => Math.hypot(this.nodeXY[n * 2] - bx, this.nodeXY[n * 2 + 1] - bz);
    const heap = [[hx(a), a]]; g[a] = 0; let it = 0;
    const push = v => { heap.push(v); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m } } return top };
    // prefer bigger roads a little (time, not distance)
    const SPEED = [1, .55, .62, .72, .8, .85, .95, 1, 1.2, 1.3, 1.6, .6, .65, .75, .85, .9];
    while (heap.length && it++ < 200000) {
      const [, n] = pop(); if (seen[n]) continue; seen[n] = 1; if (n === b) break;
      for (let k = this.adjS[n]; k < this.adjS[n + 1]; k++) {
        const e = this.adjE[k], m = this.eA[e] === n ? this.eB[e] : this.eA[e];
        const c = g[n] + this.eL[e] * (SPEED[this.eC[e]] || 1);
        if (c < g[m]) { g[m] = c; from[m] = e; push([c + hx(m) * .55, m]) }
      }
    }
    if (from[b] < 0 && a !== b) return null;
    const out = []; let n = b;
    while (n !== a) {
      const e = from[n], s = this.eP[e], cnt = this.eN[e], fwd = this.eB[e] === n;
      for (let k = 0; k < cnt; k++) { const q = fwd ? cnt - 1 - k : k; out.push(this.netPts[(s + q) * 2], this.netPts[(s + q) * 2 + 1]) }
      n = fwd ? this.eA[e] : this.eB[e];
    }
    const pts = []; for (let k = out.length - 2; k >= 0; k -= 2) pts.push(out[k], out[k + 1]);
    return pts;
  }
}

/* binary map files; hosts that only serve text get them as base64 (<name>.txt) when window.MW_B64 is set */
function b64ToBuf(t) { const s = atob(t.trim()), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer }
export function fetchBin(path) {
  if (globalThis.MW_B64) return fetch(path + '.txt').then(r => { if (!r.ok) throw new Error(path + ': ' + r.status); return r.text() }).then(b64ToBuf);
  return fetch(path).then(r => { if (!r.ok) throw new Error(path + ': ' + r.status); return r.arrayBuffer() });
}
let CITY_CACHE = {};
export async function loadCity(id = 'sofia') {
  if (CITY_CACHE[id]) return CITY_CACHE[id];
  const base = `city/${id}/`;
  const meta = await (await fetch(base + 'meta.json')).json();
  const [tb, nb, sb] = await Promise.all(['terrain.bin', 'net.bin', 'skyline.bin'].map(f => fetchBin(base + f)));
  const c = new City(base, meta, tb, nb); c.skyBuf = sb; return CITY_CACHE[id] = c;
}
