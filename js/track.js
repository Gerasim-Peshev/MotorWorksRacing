/* Track geometry & queries (no rendering). Works in the browser and in Node for tests.
   World: x = east, z = south, y = up (metres). Track direction = racing direction.
   Left normal of a forward vector (fx,fz) is (fz,-fx). */
export const THEMES = {
  forest:  { barrier: 'close', runoff: 'grass',  trees: 1.0, conifer: .85, grass: '#4f7a33', grass2: '#3d6428', dirt: '#6b5a3c', sky: '#a9c4d8', fog: '#b9cdd8', sun: [0.55, 0.62], gravel: 0 },
  ardennes:{ barrier: 'wide',  runoff: 'mixed',  trees: .95, conifer: .8, grass: '#55803a', grass2: '#46702f', dirt: '#6f5d40', sky: '#9fbfda', fog: '#bfd0dc', sun: [0.75, 0.55], gravel: .6 },
  eifel:   { barrier: 'wide',  runoff: 'mixed',  trees: .55, conifer: .8, grass: '#5a8640', grass2: '#4a7434', dirt: '#6f5d40', sky: '#a5c2da', fog: '#c2d3de', sun: [0.6, 0.6], gravel: .7 },
  japan:   { barrier: 'wide',  runoff: 'mixed',  trees: .45, conifer: .5, grass: '#5d8a3c', grass2: '#4b7a30', dirt: '#7a6a4a', sky: '#9cc0e0', fog: '#c6d6e2', sun: [0.7, 0.75], gravel: .8 },
  dry:     { barrier: 'wide',  runoff: 'asphalt',trees: .22, conifer: .4, grass: '#8b8c4e', grass2: '#7b7a44', dirt: '#a68a5c', sky: '#a7c9e6', fog: '#d7dfe2', sun: [0.85, 0.7], gravel: .55 },
  alpine:  { barrier: 'wide',  runoff: 'asphalt',trees: .4,  conifer: .95, grass: '#5f8c3a', grass2: '#4f7c30', dirt: '#6f6248', sky: '#98bfe0', fog: '#c8d8e4', sun: [0.65, 0.5], gravel: .35 },
  balkan:  { barrier: 'wide',  runoff: 'asphalt',trees: .35, conifer: .7, fogScale: 1.9, grass: '#62873e', grass2: '#527633', dirt: '#7a6648', sky: '#9fc3e2', fog: '#c9d8e2', sun: [0.7, 0.6], gravel: .5 },
};

export const SURF = {
  asphalt: { mu: 1.0, drag: 0, bump: 0, id: 0 },
  kerb:    { mu: .93, drag: 0, bump: 1, id: 1 },
  verge:   { mu: .95, drag: 0, bump: .15, id: 2 },
  runoff:  { mu: .92, drag: 0, bump: .05, id: 3 },   // asphalt run-off
  grass:   { mu: .58, drag: .05, bump: .45, id: 4 },
  gravel:  { mu: .52, drag: .32, bump: .85, id: 5 },
};
export const KERB_W = 1.15, VERGE_W = 0.7;

function gauss(arr, sigma, wrap = true) {
  const n = arr.length, r = Math.ceil(sigma * 3), k = [];
  let ks = 0; for (let j = -r; j <= r; j++) { const v = Math.exp(-j * j / (2 * sigma * sigma)); k.push(v); ks += v }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = -r; j <= r; j++) { let ii = i + j; ii = ((ii % n) + n) % n; s += arr[ii] * k[j + r] } out[i] = s / ks }
  return out;
}
function hash(i) { let x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }
function smoothNoise(n, scale, seed) {
  const out = new Float32Array(n), m = Math.ceil(n / scale) + 2, pts = [];
  for (let j = 0; j < m; j++) pts.push(hash(j + seed * 97) * 2 - 1);
  for (let i = 0; i < n; i++) { const t = i / scale, j = Math.floor(t), f = t - j, u = f * f * (3 - 2 * f); out[i] = pts[j % m] * (1 - u) + pts[(j + 1) % m] * u }
  return out;
}

export class Track {
  constructor(data, opts = {}) {
    this.data = data; this.id = data.id; this.name = data.name;
    this.theme = THEMES[data.theme] || THEMES.eifel;
    const DS = opts.ds || 2.0;
    const raw = data.pts, m = raw.length / 5;
    // ---- densify with Catmull-Rom (uniform spacing in source data)
    const L = data.lengthM, n = Math.round(L / DS);
    this.n = n; this.ds = L / n; this.length = L;
    const px = this.px = new Float32Array(n), py = this.py = new Float32Array(n), pz = this.pz = new Float32Array(n);
    const wl = this.wl = new Float32Array(n), wr = this.wr = new Float32Array(n);
    const g = (k, c) => raw[(((k % m) + m) % m) * 5 + c];
    const cr = (p0, p1, p2, p3, t) => { const t2 = t * t, t3 = t2 * t; return .5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3) };
    for (let i = 0; i < n; i++) {
      const u = i / n * m, k = Math.floor(u), t = u - k;
      px[i] = cr(g(k - 1, 0), g(k, 0), g(k + 1, 0), g(k + 2, 0), t);
      pz[i] = cr(g(k - 1, 1), g(k, 1), g(k + 1, 1), g(k + 2, 1), t);
      py[i] = cr(g(k - 1, 2), g(k, 2), g(k + 1, 2), g(k + 2, 2), t);
      wl[i] = g(k, 3) * (1 - t) + g(k + 1, 3) * t;
      wr[i] = g(k, 4) * (1 - t) + g(k + 1, 4) * t;
    }
    // ---- frames
    const tx = this.tx = new Float32Array(n), tz = this.tz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      let dx = px[b] - px[a], dz = pz[b] - pz[a]; const l = Math.hypot(dx, dz) || 1; tx[i] = dx / l; tz[i] = dz / l;
    }
    // curvature (+ = left turn): d(t)/ds · left normal
    const kap = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const dtx = (tx[b] - tx[a]) / (2 * this.ds), dtz = (tz[b] - tz[a]) / (2 * this.ds);
      kap[i] = dtx * tz[i] + dtz * (-tx[i]);
    }
    this.k = gauss(kap, 2);
    this.ks = gauss(kap, 6);                    // ~±12 m smoothing for kerbs/AI
    const grade = this.grade = new Float32Array(n), kv = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = (i - 1 + n) % n, b = (i + 1) % n; grade[i] = (py[b] - py[a]) / (2 * this.ds); kv[i] = (py[b] - 2 * py[i] + py[a]) / (this.ds * this.ds) }
    this.kv = gauss(kv, 5);
    this.bridge = data.bridge ? { upper: Math.round(data.bridge.upper * data.ds / this.ds), lower: Math.round(data.bridge.lower * data.ds / this.ds) } : null;
    this._buildHash();
    this._buildSides();
    this.altMin = 0; let mx = -1e9; for (let i = 0; i < n; i++) mx = Math.max(mx, py[i]); this.altMax = mx;
  }
  nx(i) { return this.tz[i] } nz(i) { return -this.tx[i] }
  wrap(i) { const n = this.n; return ((i % n) + n) % n }

  _buildHash() {
    const C = this.cell = 40; this.hash = new Map();
    for (let i = 0; i < this.n; i++) {
      const key = Math.floor(this.px[i] / C) + ',' + Math.floor(this.pz[i] / C);
      let a = this.hash.get(key); if (!a) this.hash.set(key, a = []); a.push(i);
    }
  }
  /* indices near (x,z) within radius r */
  near(x, z, r) {
    const C = this.cell, out = [], x0 = Math.floor((x - r) / C), x1 = Math.floor((x + r) / C), z0 = Math.floor((z - r) / C), z1 = Math.floor((z + r) / C);
    for (let a = x0; a <= x1; a++) for (let b = z0; b <= z1; b++) { const l = this.hash.get(a + ',' + b); if (l) for (const i of l) out.push(i) }
    return out;
  }
  /* nearest centre-line index, globally (optionally preferring height y) */
  nearestGlobal(x, z, y) {
    let best = -1, bd = 1e18;
    for (let r = 60; r <= 2000 && best < 0; r *= 2) {
      for (const i of this.near(x, z, r)) {
        const dx = this.px[i] - x, dz = this.pz[i] - z, dy = y == null ? 0 : (this.py[i] - y) * 3;
        const d = dx * dx + dz * dz + dy * dy; if (d < bd) { bd = d; best = i }
      }
    }
    if (best < 0) { for (let i = 0; i < this.n; i++) { const d = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2; if (d < bd) { bd = d; best = i } } }
    return best;
  }
  /* project point onto the track near hint index. Returns segment index i, fraction t, lateral d (+left), s, height, grade, kv */
  locate(x, z, hint, out = {}) {
    const n = this.n;
    let i = hint == null || hint < 0 ? this.nearestGlobal(x, z) : hint;
    // walk to the local minimum of distance
    const dist2 = j => { j = this.wrap(j); const dx = this.px[j] - x, dz = this.pz[j] - z; return dx * dx + dz * dz };
    let d0 = dist2(i), guard = 0;
    while (guard++ < 400) {
      const dn = dist2(i + 1), dp = dist2(i - 1);
      if (dn < d0 && dn <= dp) { i = this.wrap(i + 1); d0 = dn } else if (dp < d0) { i = this.wrap(i - 1); d0 = dp } else break;
    }
    if (d0 > 120 * 120) { i = this.nearestGlobal(x, z); }
    // choose segment [i, i+1] or [i-1, i]
    const a = this.wrap(i), b = this.wrap(i + 1), c = this.wrap(i - 1);
    let s0 = a, s1 = b;
    {
      const vx = x - this.px[a], vz = z - this.pz[a];
      const ax = this.px[b] - this.px[a], az = this.pz[b] - this.pz[a];
      if (vx * ax + vz * az < 0) { s0 = c; s1 = a }
    }
    const ax = this.px[s1] - this.px[s0], az = this.pz[s1] - this.pz[s0], len2 = ax * ax + az * az || 1;
    let t = ((x - this.px[s0]) * ax + (z - this.pz[s0]) * az) / len2; t = Math.max(0, Math.min(1, t));
    const cx = this.px[s0] + ax * t, cz = this.pz[s0] + az * t;
    const tl = Math.sqrt(len2), fx = ax / tl, fz = az / tl;
    const d = (x - cx) * fz + (z - cz) * (-fx);       // + = left
    out.i = s0; out.t = t; out.d = d;
    out.s = (s0 + t) * this.ds;
    out.h = this.py[s0] * (1 - t) + this.py[s1] * t;
    out.grade = this.grade[s0] * (1 - t) + this.grade[s1] * t;
    out.kv = this.kv[s0] * (1 - t) + this.kv[s1] * t;
    out.fx = fx; out.fz = fz;
    out.wl = this.wl[s0] * (1 - t) + this.wl[s1] * t; out.wr = this.wr[s0] * (1 - t) + this.wr[s1] * t;
    return out;
  }
  /* surface under lateral offset d at index i */
  surface(i, d) {
    const left = d >= 0, ad = Math.abs(d), w = left ? this.wl[i] : this.wr[i];
    if (ad <= w) return SURF.asphalt;
    const kerb = left ? this.kerbL[i] : this.kerbR[i];
    let e = w;
    if (kerb) { if (ad <= w + KERB_W) return SURF.kerb; e += KERB_W }
    if (ad <= e + VERGE_W) return SURF.verge;
    const t = left ? this.runL[i] : this.runR[i];
    return t === 5 ? SURF.gravel : t === 3 ? SURF.runoff : SURF.grass;
  }
  barrier(i, left) { return left ? this.bl[i] : this.br[i] }

  _buildSides() {
    const n = this.n, th = this.theme, ks = this.ks;
    const kerbL = this.kerbL = new Uint8Array(n), kerbR = this.kerbR = new Uint8Array(n);
    const inK = 1 / 230, outK = 1 / 150;
    for (let i = 0; i < n; i++) {
      const k = ks[i];
      if (Math.abs(k) > inK) { if (k > 0) kerbL[i] = 1; else kerbR[i] = 1 }
      if (Math.abs(k) > outK) { if (k > 0) kerbR[i] = 1; else kerbL[i] = 1 }
    }
    const dil = (a, r) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) if (a[i]) for (let j = -r; j <= r; j++) o[this.wrap(i + j)] = 1; return o };
    const ext = Math.round(10 / this.ds);
    this.kerbL = dil(kerbL, ext); this.kerbR = dil(kerbR, ext);
    // start/finish straight: no kerbs right at the line
    // ---- barrier distance & run-off surface
    const corner = gauss(Float32Array.from(ks, k => Math.min(1, Math.abs(k) * 260)), 18);
    const nz1 = smoothNoise(n, 60 / this.ds, 3), nz2 = smoothNoise(n, 55 / this.ds, 9);
    const bl = this.bl = new Float32Array(n), br = this.br = new Float32Array(n);
    const runL = this.runL = new Uint8Array(n), runR = this.runR = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const k = ks[i], c = corner[i];
      let inL, inR;
      if (th.barrier === 'close') {
        inL = 3.2 + 1.2 * nz1[i] + 2.5 * c * (k < 0 ? 1 : 0.2);
        inR = 3.2 + 1.2 * nz2[i] + 2.5 * c * (k > 0 ? 1 : 0.2);
      } else {
        const outside = 9 + 24 * c, inside = 7 + 5 * c;
        inL = (k < 0 ? outside : inside) + 2.5 * nz1[i];
        inR = (k > 0 ? outside : inside) + 2.5 * nz2[i];
      }
      bl[i] = this.wl[i] + Math.max(2.2, inL); br[i] = this.wr[i] + Math.max(2.2, inR);
      // run-off type: 3 asphalt, 4 grass, 5 gravel
      const pick = (outsideCorner, nzv) => {
        if (th.runoff === 'grass') return 4;
        if (outsideCorner && c > .35) { if (th.gravel > (nzv * .5 + .5)) return 5; return 3 }
        if (th.runoff === 'asphalt' && c > .5) return 3;
        return 4;
      };
      runL[i] = pick(k < 0, nz2[i]); runR[i] = pick(k > 0, nz1[i]);
    }
    // smooth barrier lines
    const sbl = gauss(bl, 10), sbr = gauss(br, 10);
    // keep barriers & scenery corridors away from other parts of the track (free = midline distance from our centre)
    const freeL = this.freeL = new Float32Array(n).fill(1e9), freeR = this.freeR = new Float32Array(n).fill(1e9);
    for (let i = 0; i < n; i++) {
      const x = this.px[i], z = this.pz[i], y = this.py[i], nxv = this.tz[i], nzv = -this.tx[i];
      for (const j of this.near(x, z, 170)) {
        let dj = Math.abs(j - i); dj = Math.min(dj, n - dj); if (dj * this.ds < 200) continue;
        if (Math.abs(this.py[j] - y) > 4.5) continue;
        const dx = this.px[j] - x, dz = this.pz[j] - z, side = dx * nxv + dz * nzv, dist = Math.hypot(dx, dz);
        if (Math.abs(side) < dist * .5) continue;   // mostly ahead/behind, not beside
        const other = dist - Math.max(this.wl[j], this.wr[j]);
        if (side > 0) freeL[i] = Math.min(freeL[i], (this.wl[i] + other) / 2); else freeR[i] = Math.min(freeR[i], (this.wr[i] + other) / 2);
      }
      sbl[i] = Math.max(this.wl[i] + KERB_W + .8, Math.min(sbl[i], freeL[i] - .5));
      sbr[i] = Math.max(this.wr[i] + KERB_W + .8, Math.min(sbr[i], freeR[i] - .5));
    }
    this.freeL = gauss(freeL.map(v => Math.min(v, 400)), 4); this.freeR = gauss(freeR.map(v => Math.min(v, 400)), 4);
    for (let i = 0; i < n; i++) { this.freeL[i] = Math.min(this.freeL[i], freeL[i] < 1e8 ? freeL[i] : 400); this.freeR[i] = Math.min(this.freeR[i], freeR[i] < 1e8 ? freeR[i] : 400) }
    this.bl = gauss(sbl, 3); this.br = gauss(sbr, 3);
    for (let i = 0; i < n; i++) { this.bl[i] = Math.max(this.bl[i], this.wl[i] + KERB_W + .8); this.br[i] = Math.max(this.br[i], this.wr[i] + KERB_W + .8) }
    // no kerbs around the start line & pit straight
    for (let j = -Math.round(60 / this.ds); j < Math.round(60 / this.ds); j++) { const i = this.wrap(j); this.kerbL[i] = this.kerbR[i] = 0 }
  }

  /* minimum-curvature-ish racing line as lateral offsets (+left), for the autopilot & ghosts */
  racingLine(margin = 1.4) {
    if (this._rl) return this._rl;
    const n = this.n;
    const lo = new Float32Array(n), hi = new Float32Array(n);
    for (let i = 0; i < n; i++) { hi[i] = this.wl[i] - margin; lo[i] = -(this.wr[i] - margin) }
    // minimum curvature: projected gradient descent on sum |P[i-1]-2P[i]+P[i+1]|^2, coarse-to-fine
    const minCurv = (step, iters, off) => {
      const m = Math.floor(n / step), idx = new Int32Array(m), o = new Float32Array(m);
      const X = new Float32Array(m), Z = new Float32Array(m), DX = new Float32Array(m), DZ = new Float32Array(m);
      for (let j = 0; j < m; j++) { idx[j] = Math.round(j * n / m) % n; o[j] = off[idx[j]] }
      const eta = .11;
      for (let it = 0; it < iters; it++) {
        for (let j = 0; j < m; j++) { const i = idx[j]; X[j] = this.px[i] + this.tz[i] * o[j]; Z[j] = this.pz[i] - this.tx[i] * o[j] }
        for (let j = 0; j < m; j++) { const a = (j - 1 + m) % m, b = (j + 1) % m; DX[j] = X[a] - 2 * X[j] + X[b]; DZ[j] = Z[a] - 2 * Z[j] + Z[b] }
        for (let j = 0; j < m; j++) {
          const i = idx[j], a = (j - 1 + m) % m, b = (j + 1) % m;
          const gx = DX[a] - 2 * DX[j] + DX[b], gz = DZ[a] - 2 * DZ[j] + DZ[b];
          const gn = gx * this.tz[i] + gz * (-this.tx[i]);
          let v = o[j] - eta * gn; o[j] = v < lo[i] ? lo[i] : v > hi[i] ? hi[i] : v;
        }
      }
      const out = new Float32Array(n);
      for (let j = 0; j < m; j++) {
        const i0 = idx[j], i1 = idx[(j + 1) % m], span = ((i1 - i0) + n) % n || 1;
        for (let q = 0; q < span; q++) out[(i0 + q) % n] = o[j] + (o[(j + 1) % m] - o[j]) * q / span;
      }
      return out;
    };
    const st = Math.max(1, Math.round(4 / this.ds));       // ~4 m base spacing
    let off = new Float32Array(n);
    if (this.data.rl && this.data.rl.length * 5 === this.data.pts.length) {
      // shipped with the track: exact minimum-curvature solution (scipy), interpolate to dense spacing
      const rl = this.data.rl, m = rl.length;
      for (let i = 0; i < n; i++) { const u = i / n * m, k = Math.floor(u), f = u - k; off[i] = rl[k % m] * (1 - f) + rl[(k + 1) % m] * f }
    } else {
      off = minCurv(st * 8, 1500, off);
      off = minCurv(st * 4, 1200, off);
      off = minCurv(st * 2, 900, off);
      off = minCurv(st, 700, off);
    }
    let sm = gauss(off, 2);
    for (let i = 0; i < n; i++) sm[i] = Math.max(lo[i], Math.min(hi[i], sm[i]));
    const lx = new Float32Array(n), lz = new Float32Array(n);
    for (let i = 0; i < n; i++) { lx[i] = this.px[i] + this.tz[i] * sm[i]; lz[i] = this.pz[i] - this.tx[i] * sm[i] }
    // curvature of the line over a ±8 m stencil
    const kk = new Float32Array(n), q = Math.max(2, Math.round(8 / this.ds));
    for (let i = 0; i < n; i++) {
      const a = (i - q + n) % n, b = (i + q) % n;
      const ax = lx[i] - lx[a], az = lz[i] - lz[a], bx = lx[b] - lx[i], bz = lz[b] - lz[i];
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      const cross = ax * bz - az * bx, dot = ax * bx + az * bz;
      kk[i] = -Math.atan2(cross, dot) / ((la + lb) / 2 || 1);
    }
    this._rl = { off: sm, x: lx, z: lz, k: gauss(kk, 2) };
    return this._rl;
  }
}
