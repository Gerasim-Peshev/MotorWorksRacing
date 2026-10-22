/* Realistic procedural 3D cars.
   The proportions of every body type come from the MotorWorks Tycoon side profiles (SHAPES: silhouette, glasshouse,
   pillars, door seams, lamp positions). The 3D body is lofted from real cross-sections (tumblehome, rounded shoulders,
   crowned hood and roof, superellipse corners in plan view) with wheel arches and dark wells, flush glass,
   clear-coated paint, and surface-hugging lamps, grilles, plates and trim. Wheels have lathed tyres, alloy or steel
   rims, brake discs and calipers. The model year sets the styling: chrome bumpers and round lamps on old cars,
   swept lamps with LED strips on new ones. */
import * as THREE from './vendor/three.module.min.js';
import { SHAPES, BODYDIM, VY } from './parts.js';

const GROUND = 108;          // SVG y of the ground line

/* --- tiny SVG path parser (M L Q Z, absolute) -> polygons --- */
export function pathPolys(d, qSeg = 8) {
  const tok = d.match(/[MLQZ]|-?\d*\.?\d+/gi); const polys = []; let cur = null, i = 0, last = [0, 0];
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    const c = tok[i++].toUpperCase();
    if (c === 'M') { cur = []; polys.push(cur); last = [num(), num()]; cur.push(last) }
    else if (c === 'L') { last = [num(), num()]; cur.push(last) }
    else if (c === 'Q') {
      const cx = num(), cy = num(), x = num(), y = num(), [x0, y0] = last;
      for (let k = 1; k <= qSeg; k++) { const t = k / qSeg, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, e = t * t; cur.push([a * x0 + b * cx + e * x, a * y0 + b * cy + e * y]) }
      last = [x, y];
    }
  }
  return polys;
}
function vExtent(poly, x) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < poly.length; k++) {
    const [x0, y0] = poly[k], [x1, y1] = poly[(k + 1) % poly.length];
    if (x >= Math.min(x0, x1) && x <= Math.max(x0, x1) && x0 !== x1) { const y = y0 + (y1 - y0) * (x - x0) / (x1 - x0); lo = Math.min(lo, y); hi = Math.max(hi, y) }
  }
  return lo === Infinity ? null : [lo, hi];
}
function inPoly(poly, x, y) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c } return c }
/* round the corners of a closed polygon with a bounded radius (long straight edges stay straight) */
function roundPoly(p, r, seg = 4) {
  const n = p.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], v = p[i], b = p[(i + 1) % n];
    const ax = a[0] - v[0], ay = a[1] - v[1], bx = b[0] - v[0], by = b[1] - v[1], la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const d1 = Math.min(r, la * .45), d2 = Math.min(r, lb * .45);
    if ((ax * bx + ay * by) / (la * lb) < -.985 || Math.min(d1, d2) < .5) { out.push(v); continue }
    const p0 = [v[0] + ax / la * d1, v[1] + ay / la * d1], p2 = [v[0] + bx / lb * d2, v[1] + by / lb * d2];
    for (let k = 0; k <= seg; k++) { const t = k / seg, u = 1 - t; out.push([u * u * p0[0] + 2 * u * t * v[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * v[1] + t * t * p2[1]]) }
  }
  return out;
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v, lerp = (a, b, t) => a + (b - a) * t, sstep = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t) };
const canvas = (w, h) => (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });

/* --- shared materials (never disposed) --- */
const S = {};
function shared() {
  if (S.glass) return S;
  const decal = m => Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  S.glass = new THREE.MeshStandardMaterial({ color: 0x0a0f13, roughness: .04, metalness: .6, envMapIntensity: 1.6 });
  S.trim = new THREE.MeshStandardMaterial({ color: 0x141618, roughness: .7, metalness: .1 });
  S.black = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: .18, metalness: .35, envMapIntensity: 1.3 });
  S.blackD = decal(S.black.clone());
  S.glassD = decal(S.glass.clone());
  S.trimD = decal(S.trim.clone());
  S.well = new THREE.MeshStandardMaterial({ color: 0x08090a, roughness: .95, side: THREE.DoubleSide });
  S.bed = new THREE.MeshStandardMaterial({ color: 0x1d1f21, roughness: .92 });
  S.interior = new THREE.MeshStandardMaterial({ color: 0x1e1f21, roughness: .85 });
  S.seat = new THREE.MeshStandardMaterial({ color: 0x2e2724, roughness: .62 });
  S.chrome = new THREE.MeshStandardMaterial({ color: 0xeef2f4, roughness: .06, metalness: 1, envMapIntensity: 1.6 });
  S.chromeD = decal(S.chrome.clone());
  S.tyre = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: .88, metalness: 0 });
  S.alloy = new THREE.MeshStandardMaterial({ color: 0xcfd4d8, roughness: .24, metalness: .95, envMapIntensity: 1.3 });
  S.darkAlloy = new THREE.MeshStandardMaterial({ color: 0x34383c, roughness: .3, metalness: .85, envMapIntensity: 1.2 });
  S.steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a5, roughness: .4, metalness: .7 });
  S.disc = new THREE.MeshStandardMaterial({ color: 0x6f7275, roughness: .42, metalness: .85 });
  S.hub = new THREE.MeshStandardMaterial({ color: 0x3d4145, roughness: .45, metalness: .75 });
  S.lens = decal(new THREE.MeshStandardMaterial({ color: 0x9aa3aa, emissive: 0xfff4dc, emissiveIntensity: .12, roughness: .06, metalness: .9, envMapIntensity: 1.8 }));
  S.proj = decal(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6e6, emissiveIntensity: .9, roughness: .1, metalness: .3 }));
  S.drl = decal(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeef6ff, emissiveIntensity: 2.2, roughness: .3 }));
  S.amber = decal(new THREE.MeshStandardMaterial({ color: 0xe0901e, emissive: 0x7a3c00, emissiveIntensity: .35, roughness: .15 }));
  S.reverse = decal(new THREE.MeshStandardMaterial({ color: 0xd8dde0, roughness: .06, metalness: .5 }));
  S.boxSide = new THREE.MeshStandardMaterial({ color: 0xeceeee, roughness: .5, metalness: .08 });
  const cv = canvas(256, 56), g = cv.getContext('2d');
  g.fillStyle = '#f4f4ef'; g.fillRect(0, 0, 256, 56); g.fillStyle = '#1f4ea8'; g.fillRect(0, 0, 26, 56);
  g.fillStyle = '#ffd700'; for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; g.beginPath(); g.arc(13 + Math.cos(a) * 7, 17 + Math.sin(a) * 7, 1.4, 0, 7); g.fill() }
  g.fillStyle = '#fff'; g.font = 'bold 13px Arial, sans-serif'; g.textAlign = 'center'; g.fillText('BG', 13, 46);
  g.strokeStyle = '#222'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 253, 53); g.fillStyle = '#16181a'; g.font = 'bold 36px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('CB 2026 MW', 142, 30);
  const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = 4;
  S.plate = decal(new THREE.MeshStandardMaterial({ map: tx, roughness: .45 }));
  return S;
}
function numberTexture(n) {
  const cv = canvas(128, 128), g = cv.getContext('2d'); g.fillStyle = '#f6f7f2'; g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#18201b'; g.font = 'bold 76px Oswald, Arial Narrow, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), 64, 68);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* --- wheel parts, cached per radius / width / style (shared, never disposed) --- */
const WCACHE = new Map();
function wheelGeos(R, tw, style) {
  const key = R.toFixed(3) + '|' + tw.toFixed(3) + '|' + style;
  if (WCACHE.has(key)) return WCACHE.get(key);
  const rr = R * (style === 'steel' ? .62 : style === 'center' ? .76 : .7), h = tw / 2, side = R - rr;
  const prof = [[rr * .985, -h * .84], [rr + side * .3, -h * .97], [rr + side * .62, -h * 1.0], [R - side * .12, -h * .95], [R - .006, -h * .8], [R, -h * .58], [R, 0], [R, h * .58], [R - .006, h * .8], [R - side * .12, h * .95], [rr + side * .62, h], [rr + side * .3, h * .97], [rr * .985, h * .84]];
  const tyre = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 44).rotateZ(Math.PI / 2);
  const barrel = new THREE.CylinderGeometry(rr * .985, rr * .985, tw * .84, 36, 1, true).rotateZ(Math.PI / 2);
  const lip = new THREE.TorusGeometry(rr * .985, .008, 6, 40).rotateY(Math.PI / 2);
  // rim face: a disc with windows cut between the spokes, extruded and bevelled
  const face = new THREE.Shape(); face.absarc(0, 0, rr * .97, 0, Math.PI * 2, false);
  const spokes = style === 'multi' ? 10 : style === 'six' ? 6 : style === 'steel' ? 6 : 5;
  const hubR = rr * (style === 'steel' ? .5 : .26), outR = rr * (style === 'steel' ? .72 : .86);
  for (let k = 0; k < spokes; k++) {
    const hole = new THREE.Path(), a0 = (k / spokes) * Math.PI * 2, span = Math.PI * 2 / spokes;
    if (style === 'steel') { const a = a0 + span / 2; hole.absarc(Math.cos(a) * rr * .62, Math.sin(a) * rr * .62, rr * .085, 0, Math.PI * 2, true) }
    else {
      const sw = (style === 'multi' ? .17 : style === 'center' ? .2 : .23) * span, i0 = a0 + sw, i1 = a0 + span - sw, j0 = a0 + sw * 2.1, j1 = a0 + span - sw * 2.1;
      hole.moveTo(Math.cos(j0) * hubR * 1.3, Math.sin(j0) * hubR * 1.3);
      hole.absarc(0, 0, outR, i0, i1, false);
      hole.lineTo(Math.cos(j1) * hubR * 1.3, Math.sin(j1) * hubR * 1.3);
      hole.closePath();
    }
    face.holes.push(hole);
  }
  const faceGeo = new THREE.ExtrudeGeometry(face, { depth: style === 'steel' ? .01 : .028, bevelEnabled: true, bevelThickness: .01, bevelSize: .007, bevelSegments: 2, curveSegments: 24 }).rotateY(Math.PI / 2);
  const nuts = [], nr = style === 'center' ? 0 : 5;
  for (let k = 0; k < nr; k++) { const a = k / nr * Math.PI * 2, g = new THREE.CylinderGeometry(.009, .009, .02, 6).rotateZ(Math.PI / 2); g.translate(0, Math.cos(a) * hubR * .62, Math.sin(a) * hubR * .62); nuts.push(g) }
  const cap = style === 'center' ? new THREE.CylinderGeometry(hubR * .42, hubR * .5, .05, 6).rotateZ(Math.PI / 2) : new THREE.CylinderGeometry(hubR * .35, hubR * .42, .022, 18).rotateZ(Math.PI / 2);
  const hubcap = style === 'steel' ? new THREE.SphereGeometry(rr * .5, 24, 8, 0, Math.PI * 2, 0, Math.PI * .28).rotateZ(-Math.PI / 2) : null;
  const disc = new THREE.CylinderGeometry(rr * .84, rr * .84, .026, 30).rotateZ(Math.PI / 2);
  const discHat = new THREE.CylinderGeometry(rr * .36, rr * .36, .03, 20).rotateZ(Math.PI / 2);
  const caliper = new THREE.CylinderGeometry(rr * .8, rr * .8, .055, 12, 1, false, -.55, 1.1).rotateZ(Math.PI / 2);
  const out = { tyre, barrel, lip, faceGeo, nuts, cap, hubcap, disc, discHat, caliper, rr, hubR };
  for (const v of Object.values(out)) if (v && v.isBufferGeometry) v.userData.cached = true;
  for (const n of nuts) n.userData.cached = true;
  WCACHE.set(key, out); return out;
}

/* Build a car. Returns { group, wheels, wheelsByPos:[fl,fr,rl,rr], lights:{tail, head}, dims }.
   opts: number (race number on the doors), cyl (cylinder count, sets the exhaust tips), ev (no exhaust) */
export function buildCar(car, opts = {}) {
  const body = car.body in SHAPES ? car.body : 'sedan', s = SHAPES[body], D = BODYDIM[body], sc = D.s, M = shared();
  const year = car.year || 2012, era = clamp((year - 1955) / 65, 0, 1), modern = era > .55;
  const truck = !!s.box, open = body === 'cabrio', util = truck || body === 'van';
  const sporty = body === 'super' || body === 'coupe' || body === 'ssedan' || body === 'cabrio', clad = body === 'suv' || body === 'cross' || body === 'pickup';
  const lux = car.int === 'luxury' || car.int === 'premium';
  const color = new THREE.Color(car.color || '#c0392b');
  const solid = era < .3 || util;
  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: solid ? .05 : .55, roughness: solid ? .36 : .3, clearcoat: 1, clearcoatRoughness: .04, envMapIntensity: 1.1 });
  const raw = pathPolys(s.p)[0], poly = roundPoly(raw, truck ? 3 : 5);
  const gRaw = s.g ? pathPolys(s.g)[0] : null, gPoly = gRaw ? roundPoly(gRaw, 2.2) : null;
  const x2 = s.x2 ? pathPolys(s.x2).map(p => roundPoly(p, 1)) : [];
  const x2trim = body === 'super' || open ? [] : x2;
  const wh = s.wh || [[82, 16], [238, 16]];
  let x0 = Infinity, x1 = -Infinity; for (const [x] of raw) { x0 = Math.min(x0, x); x1 = Math.max(x1, x) }
  const front = Math.max(...wh.map(w => w[0])), rearW = Math.min(...wh.map(w => w[0])), xc = (front + rearW) / 2;
  const hw = D.W / 2 / sc;
  const P3 = (lat, h, x) => [lat * sc, h * sc * VY, -(x - xc) * sc];          // SVG (lateral, height, x) -> metres
  const mz = x => -(x - xc) * sc, my = h => h * sc * VY, ux = m => m / sc;
  // glasshouse
  let gx0 = Infinity, gx1 = -Infinity, gyLow = -Infinity;
  if (gPoly) for (const [x, y] of gPoly) { gx0 = Math.min(gx0, x); gx1 = Math.max(gx1, x); gyLow = Math.max(gyLow, y) }
  const gBot = gPoly ? GROUND - gyLow : 0;
  const beltAt = x => { const e = vExtent(gRaw, clamp(x, gx0 + .5, gx1 - .5)); return e ? GROUND - e[1] : gBot };   // unrounded, so the shoulder stays straight
  // open load bed / cockpit
  const bedEnd = gx0 - 8, cockA = x2.length ? Math.min(...x2.flat().map(p => p[0])) - 6 : 110, cockB = gx0 - 2;
  const tubAt = x => body === 'pickup' ? (x > x0 + 3.2 && x < bedEnd - 3 ? 15 : 0) : open ? (x > cockA && x < cockB ? 12 : 0) : 0;
  // wheel arches
  const archR = r => r + (truck ? 4 : 3.4);
  const archTop = x => { let h = -1; for (const [wx, r] of wh) { const ra = archR(r), dx = Math.abs(x - wx); if (dx < ra) h = Math.max(h, r + Math.sqrt(ra * ra - dx * dx)) } return h };
  // plan view: superellipse corners at nose and tail
  const boxy = truck || body === 'van';
  const rcF = (truck ? 9 : lerp(16, 30, era)) * (body === 'super' ? 1.3 : 1), rcR = boxy ? 6 : lerp(12, 22, era) * (body === 'suv' || body === 'wagon' ? .7 : 1), nF = truck ? 5 : lerp(4.2, 3, era), nR = boxy ? 5 : 3.6;
  const se = (d, L, n) => d >= L ? 1 : Math.pow(Math.max(0, 1 - Math.pow(1 - d / L, n)), 1 / n);
  const planW = x => hw * (.985 + .015 * Math.sin(Math.PI * (x - x0) / (x1 - x0))) * Math.min(se(x1 - x, rcF, nF), se(x - x0, rcR, nR));
  // stations along the car
  const xr = [];
  for (let j = 0; j <= 150; j++) xr.push(x0 + (x1 - x0) * j / 150);
  for (const [x] of poly) xr.push(x);
  for (const [wx, r] of wh) { const ra = archR(r); for (let k = -16; k <= 16; k++) xr.push(wx + ra * Math.sin(k / 16 * Math.PI / 2)) }
  for (let k = 1; k <= 16; k++) { const t = (k / 16) ** 2; xr.push(x1 - rcF * t, x0 + rcR * t) }
  if (body === 'pickup') xr.push(x0 + 3.1, x0 + 3.3, bedEnd - 3.1, bedEnd - 2.9);
  if (open) xr.push(cockA - .1, cockA + .1, cockB - .1, cockB + .1);
  const X = []; for (const x of xr.filter(x => x >= x0 && x <= x1).sort((a, b) => a - b)) if (!X.length || x - X[X.length - 1] > .18) X.push(x);
  if (X[X.length - 1] < x1) X.push(x1);
  const tg = D.tg, rings = [];
  for (const x of X) {
    const e = vExtent(poly, x) || [GROUND - 20, GROUND - 15];
    const ht = GROUND - e[0], hb = GROUND - e[1];
    const at = archTop(x), hbA = at > 0 ? Math.min(at, ht - 4) : -1;
    const tb = tubAt(x);
    let belt = gPoly && !tb && x > gx0 - 30 && x < gx1 + 40 ? beltAt(x) : ht - 2.6;
    belt = Math.min(belt, ht - 2.6);
    const hs = Math.max(Math.max(hb, hbA) + 2, belt), gh = Math.max(0, ht - hs), k = sstep((gh - 3) / 10), w = planW(x), L = hs - hb;
    const tgB = lerp(.95, tg + .13, k), tgM = lerp(.9, tg + .07, k), tgT = lerp(.8, tg, k);
    const ring = [[0, hb], [w * .82, hb], [w * .95, hb + .08 * L], [w * .99, hb + .25 * L], [w, hb + .55 * L], [w * .995, hb + .8 * L], [w * .975, Math.max(hs - .5, hb + .86 * L)]];
    let cq = -1;                                      // wheel arch: the lower ring points fold up into the arch lip, the side above stays put
    if (hbA > hb) for (let q = 0; q < ring.length; q++) { if (ring[q][1] < hbA + .02 * q) { ring[q][1] = hbA + .02 * q; cq = q } if (q) ring[q][1] = Math.max(ring[q][1], ring[q - 1][1] + .01) }
    if (tb) ring.push([w * .97, ht - 1.1], [w * .95, ht], [w * .915, ht - .25], [w * .9, ht - 2], [w * .9, ht - tb], [w * .45, ht - tb], [0, ht - tb]);
    else ring.push([w * (.955 - .02 * k), hs + .3], [w * tgB, hs + .3 + lerp(.6, .12 * gh, k)], [w * tgM, lerp(hs + 1.6, hs + .55 * gh, k)],
      [w * tgT, lerp(hs + 2.1, ht - .12 * gh, k)], [w * tgT * .93, lerp(hs + 2.3, ht - .04 * gh, k)], [w * tgT * .6, lerp(hs + 2.5, ht - .008 * gh, k)], [0, ht]);
    rings.push({ x, ht, hb: Math.max(hb, hbA), hs, gh, k, w, tb, ring, cq });
  }
  const K = rings[0].ring.length, ORDER = []; for (let q = 0; q < K; q++) ORDER.push(q); for (let q = K - 2; q >= 1; q--) ORDER.push(-q);
  const RN = ORDER.length, pos = [];
  for (const r of rings) for (const q of ORDER) { const p = r.ring[Math.abs(q)]; pos.push(...P3(q < 0 ? -p[0] : p[0], p[1], r.x)) }
  const latAt = (ring, h) => { let m = -1; for (let q = 0; q < ring.length - 1; q++) { const [la, ya] = ring[q], [lb, yb] = ring[q + 1]; if (ya === yb) { if (Math.abs(h - ya) < 1e-6) m = Math.max(m, la, lb); continue } if ((h - ya) * (h - yb) <= 0) m = Math.max(m, la + (lb - la) * (h - ya) / (yb - ya)) } return m };
  const ringAt = x => { let j = 0; while (j < rings.length - 2 && rings[j + 1].x < x) j++; const A = rings[j], B = rings[j + 1], t = clamp((x - A.x) / (B.x - A.x || 1), 0, 1); return A.ring.map((p, q) => [lerp(p[0], B.ring[q][0], t), lerp(p[1], B.ring[q][1], t)]) };
  // faces by material
  const G = { paint: [], glass: [], trim: [], well: [], black: [], interior: [], bed: [] };
  const pil = s.pil || [];
  const endGlass = {}, winTop = {};
  const slopeAt = j => { const a = Math.max(0, j - 2), b = Math.min(rings.length - 1, j + 2); return (rings[b].ht - rings[a].ht) / (rings[b].x - rings[a].x || 1) };
  for (let j = 0; j < rings.length - 1; j++) {
    const A = rings[j], B = rings[j + 1], xm = (A.x + B.x) / 2, steep = Math.max(Math.abs(slopeAt(j)), Math.abs(slopeAt(j + 1))) > .2;
    const cabin = A.gh > 3.5 && B.gh > 3.5, tubAny = A.tb || B.tb; let wlJ = null;
    for (let qi = 0; qi < RN; qi++) {
      const qa = ORDER[qi], qb = ORDER[(qi + 1) % RN], lo = Math.min(Math.abs(qa), Math.abs(qb));
      const a = j * RN + qi, b = j * RN + (qi + 1) % RN, c = (j + 1) * RN + qi, d = (j + 1) * RN + (qi + 1) % RN;
      const ym = (A.ring[Math.abs(qa)][1] + A.ring[Math.abs(qb)][1] + B.ring[Math.abs(qa)][1] + B.ring[Math.abs(qb)][1]) / 4, sy = GROUND - ym;
      let g = 'paint';
      if (lo === 0) g = 'trim';
      else if (lo < Math.min(A.cq, B.cq)) g = 'well';
      else if (tubAny && lo >= 9) g = open ? 'interior' : 'bed';
      else if (lo === 1 && (clad || modern && (xm > x1 - 16 || xm < x0 + 12))) g = 'trim';
      else if (cabin && gPoly && lo >= 7) {
        let lm = 0; for (const q of [qa, qb]) lm += Math.abs(A.ring[Math.abs(q)][0]) + Math.abs(B.ring[Math.abs(q)][0]); lm /= 4;
        const wl = wlJ ?? (wlJ = ringAt(clamp(xm, x0 + rcR + 2, x1 - rcF - 2))[7][0]);
        if (steep && sy < gyLow + .5 && lm < .86 * wl) {                                        // windscreen and rear window
          const ez = xm < x0 + rcR * .9 ? -1 : xm > x1 - rcF * .9 ? 1 : 0;
          const half = xm < (x0 + x1) / 2 ? -1 : 1; winTop[half] = Math.max(winTop[half] || 0, ym);
          if (!ez) g = 'glass'; else endGlass[ez] = Math.max(endGlass[ez] || 0, ym);             // on the rounded ends a smooth panel is laid on top instead
        }
        else if (lo <= 9 && inPoly(gPoly, xm, sy)) {                                            // side windows and pillars
          g = 'glass'; for (const [px, y1, y2] of pil) if (Math.abs(xm - px) < 2.8 && sy >= y1 - 2 && sy <= y2 + 2) g = modern ? 'black' : 'paint';
        }
        else if (lo <= 9 && modern && steep && sy < gyLow - .5 && xm > gx0 - 30 && xm < gx1 + 30) g = 'black';   // window surround at the A and C pillars
      }
      if (g === 'paint' && lo >= 1) for (const p of x2trim) if (inPoly(p, xm, sy)) g = 'trim';
      if (truck && lo <= 2) g = 'trim';
      G[g].push(a, c, b, b, c, d);
    }
  }
  for (const [j, flip] of [[0, true], [rings.length - 1, false]]) {        // seal the end rings
    const r = rings[j], ci = pos.length / 3; pos.push(...P3(0, (r.hb + r.ht) / 2, r.x));
    for (let qi = 0; qi < RN; qi++) { const a = j * RN + qi, b = j * RN + (qi + 1) % RN; if (flip) G.paint.push(ci, a, b); else G.paint.push(ci, b, a) }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mats = { paint, glass: M.glass, trim: M.trim, well: M.well, black: M.black, interior: M.interior, bed: M.bed }, mlist = [], all = [];
  for (const k of Object.keys(G)) { if (!G[k].length) continue; geo.addGroup(all.length, G[k].length, mlist.length); mlist.push(mats[k]); for (const v of G[k]) all.push(v) }
  geo.setIndex(all); geo.computeVertexNormals();
  {   // loft normals from the surface tangents: smooth even where the stations are unevenly spaced
    const nrm = geo.attributes.normal, n = rings.length, A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), Dv = new THREE.Vector3(), Nn = new THREE.Vector3(), O = new THREE.Vector3();
    const at = (v, j, qi) => v.set(pos[(j * RN + qi) * 3], pos[(j * RN + qi) * 3 + 1], pos[(j * RN + qi) * 3 + 2]);
    for (let j = 0; j < n; j++) for (let qi = 0; qi < RN; qi++) {
      at(A, j, (qi + RN - 1) % RN); at(B, j, (qi + 1) % RN); B.sub(A);
      at(C, Math.min(j + 1, n - 1), qi); at(Dv, Math.max(j - 1, 0), qi); C.sub(Dv);
      Nn.crossVectors(C, B); const len = Nn.length(); if (len < 1e-10) continue;
      Nn.divideScalar(len); const i = j * RN + qi; O.fromBufferAttribute(nrm, i); if (Nn.dot(O) < 0) Nn.negate();
      nrm.setXYZ(i, Nn.x, Nn.y, Nn.z);
    }
  }
  const group = new THREE.Group(), bodyMesh = new THREE.Mesh(geo, mlist); bodyMesh.castShadow = true; group.add(bodyMesh);
  const geos = [geo], ownMats = [paint];
  const add = (g2, m, x, y, z, rx = 0, ry = 0, rz = 0, shadow = false) => { const o = new THREE.Mesh(g2, m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); o.castShadow = shadow; group.add(o); if (!g2.userData.cached) geos.push(g2); return o };

  /* ---------- surface helpers: lamps, grilles and plates hug the body ---------- */
  const surfX = (lat, h, dir) => {
    const n = rings.length; let prev = null;
    for (let k = 0; k < n; k++) {
      const j = dir > 0 ? n - 1 - k : k, w = latAt(rings[j].ring, h);
      if (w >= lat) { if (!prev) return rings[j].x; return lerp(prev.x, rings[j].x, clamp((lat - prev.w) / (w - prev.w || 1), 0, 1)) }
      prev = { w: Math.max(w, 0), x: rings[j].x };
    }
    return dir > 0 ? x1 : x0;
  };
  const OC = new Map();
  const outline = (h, dir) => {                 // plan-view outline at height h, from the centre line round the corner and along the side
    h = Math.round(h * 8) / 8; const key = dir * 1e4 + h; if (OC.has(key)) return OC.get(key);
    const n = rings.length, tip = surfX(0, h, dir), pts = [[0, tip]];
    for (let k = 0; k < n; k++) {
      const j = dir > 0 ? n - 1 - k : k, r = rings[j];
      if (dir > 0 ? r.x >= tip - 1e-6 : r.x <= tip + 1e-6) continue; if (Math.abs(r.x - tip) > 80) break;
      const w = latAt(r.ring, h); if (w > 0) pts.push([w, r.x]);
    }
    const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    let wmax = 0; for (const p of pts) wmax = Math.max(wmax, p[0]);
    let corner = L[L.length - 1]; for (let i = 0; i < pts.length; i++) if (pts[i][0] >= wmax * .97) { corner = L[i]; break }
    const o = { pts, L, corner, wmax }; OC.set(key, o); return o;
  };
  const atS = (o, s) => {
    const { pts, L } = o; if (pts.length < 2) return { lat: 0, x: pts[0][1], tl: 1, tx: 0 };
    let i = 1; while (i < L.length - 1 && L[i] < s) i++;
    const a = pts[i - 1], b = pts[i], t = clamp((s - L[i - 1]) / (L[i] - L[i - 1] || 1), 0, 1), tl = b[0] - a[0], tx = b[1] - a[1], tn = Math.hypot(tl, tx) || 1;
    return { lat: lerp(a[0], b[0], t), x: lerp(a[1], b[1], t), tl: tl / tn, tx: tx / tn };
  };
  const surfPt = (dir, s, h, off, side) => { const p = atS(outline(h, dir), s), nl = dir > 0 ? -p.tx : p.tx, nx = dir > 0 ? p.tl : -p.tl; return P3(side * (p.lat + nl * ux(off)), h, p.x + nx * ux(off)) };
  const cornerAt = (h, dir) => outline(h, dir).corner;
  /* a panel conforming to the nose (dir 1) or tail (dir -1): s0..s1 along the outline, lo(u)..hi(u) in height,
     prof = [[height fraction, offset in m], ...] across the strip; mirrored to both sides */
  const ribbon = (dir, s0, s1, lo, hi, mat, prof = [[0, .003], [.5, .005], [1, .003]], ns = 14, mirror = true) => {
    const p = [], idx = [], R = prof.length;
    for (const side of mirror ? [1, -1] : [1]) {
      const base = p.length / 3;
      for (let i = 0; i <= ns; i++) { const u = i / ns, sv = lerp(s0, s1, u), a = lo(u), b = hi(u); for (const [f, off] of prof) p.push(...surfPt(dir, sv, lerp(a, b, f), off, side)) }
      const flip = (dir > 0) !== (side > 0);
      for (let i = 0; i < ns; i++) for (let k = 0; k < R - 1; k++) { const a = base + i * R + k, b = a + R; if (!flip) idx.push(a, a + 1, b, b, a + 1, b + 1); else idx.push(a, b, a + 1, b, b + 1, a + 1) }
    }
    const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g2.setIndex(idx); g2.computeVertexNormals();
    const o = new THREE.Mesh(g2, mat); group.add(o); geos.push(g2); return o;
  };
  const cst = v => () => v;
  // local frame on the surface (for round lamps and plates)
  const frameAt = (dir, s, h, side = 1) => {
    const V = (ss, hh, off = 0) => new THREE.Vector3(...surfPt(dir, ss, hh, off, side));
    const p = V(s, h), T = V(s + 1, h).sub(V(Math.max(0, s - 1), h)).normalize(), U0 = V(s, h + 1).sub(V(s, h - 1));
    if (side < 0) T.negate(); if (dir > 0) T.negate();                 // text reads left to right from outside
    const N = new THREE.Vector3().crossVectors(T, U0).normalize(); if (N.dot(V(s, h, .1).sub(p)) < 0) N.negate();
    const U = new THREE.Vector3().crossVectors(N, T).normalize(), T2 = new THREE.Vector3().crossVectors(U, N);
    return { p, N, q: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(T2, U, N)) };
  };
  const place = (g2, m, f, off, shadow = false) => { const o = new THREE.Mesh(g2, m); o.position.copy(f.p).addScaledVector(f.N, off); o.quaternion.copy(f.q); o.castShadow = shadow; group.add(o); if (!g2.userData.cached) geos.push(g2); return o };

  // glass panels on rounded ends (tailgates, upright windscreens): rows follow the body, width follows the corner
  for (const dir of [1, -1]) {
    if (!endGlass[dir]) continue;
    const hLo = gBot + .6, hHi = winTop[dir] > endGlass[dir] + 1 ? winTop[dir] - .3 : endGlass[dir] - 1.2, nh = 12, ns = 12, p = [], idx = [];
    if (hHi < hLo + 2) continue;
    for (const side of [1, -1]) {
      const base = p.length / 3, flip = (dir > 0) !== (side > 0);
      for (let k = 0; k <= nh; k++) { const h = lerp(hLo, hHi, k / nh), sm = outline(h, dir).corner * .86; for (let i = 0; i <= ns; i++) p.push(...surfPt(dir, sm * i / ns, h, .003, side)) }
      for (let k = 0; k < nh; k++) for (let i = 0; i < ns; i++) { const a = base + k * (ns + 1) + i, b = a + 1, c = a + ns + 1, d = c + 1; if (!flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c) }
    }
    const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g2.setIndex(idx); g2.computeVertexNormals();
    group.add(new THREE.Mesh(g2, M.glassD)); geos.push(g2);
  }

  /* ---------- side details ---------- */
  const seams = [], lines = [];
  for (const pth of pathPolys(s.d || '')) { if (pth.length < 2) continue; const [[ax, ay], [bx, by]] = pth; if (Math.abs(ax - bx) < 4 && Math.abs(ay - by) > 20) seams.push((ax + bx) / 2); else if (Math.abs(ay - by) < 4 && Math.abs(ax - bx) > 20) lines.push([Math.min(ax, bx), Math.max(ax, bx), (ay + by) / 2]) }
  {
    const sp = [], si = [];
    for (const sx of seams) {
      if (sx < x0 + 6 || sx > x1 - 6 || tubAt(sx)) continue;
      const r = ringAt(sx);
      for (const side of [1, -1]) for (let q = 2; q <= 6; q++) {
        const [la, ya] = r[q], [lb, yb] = r[q + 1], base = sp.length / 3;
        for (const [lat, yy] of [[la, ya], [lb, yb]]) for (const dz of [-.35, .35]) sp.push(...P3(side * (lat + .12), yy, sx + dz));
        if (side < 0) si.push(base, base + 2, base + 1, base + 1, base + 2, base + 3); else si.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
    if (sp.length) { const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sg.setIndex(si); sg.computeVertexNormals(); group.add(new THREE.Mesh(sg, M.trimD)); geos.push(sg) }
    const doors = seams.filter(x => gPoly && x > gx0 - 12 && x < gx1 + 12).sort((a, b) => a - b);
    for (let k = 0; k < doors.length; k++) {
      const hx = (k + 1 < doors.length ? doors[k + 1] : doors[k]) - 10; if (hx < x0 + 20 || hx > x1 - 20) continue;
      const r = ringAt(hx), hy = r[6][1] - 2.6, lat = r[6][0];
      for (const side of [1, -1]) add(new THREE.BoxGeometry(.022, .026, .16), era < .4 || lux && !modern ? M.chrome : (sporty || clad ? M.black : paint), side * (lat * sc + .006), my(hy), mz(hx));
    }
  }
  // belt-line trim under the side windows
  if (gPoly) {
    const bp = [], bi = [], xs = X.filter(x => x > gx0 + 1.5 && x < gx1 - 1.5 && !tubAt(x));
    for (const side of [1, -1]) {
      const base = bp.length / 3;
      for (const x of xs) { const [lat, h] = ringAt(x)[7]; bp.push(...P3(side * (lat + .2), h - .55, x), ...P3(side * (lat + .2), h + .25, x)) }
      for (let i = 0; i < xs.length - 1; i++) { const a = base + i * 2; if (side > 0) bi.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); else bi.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
    }
    if (xs.length > 1) { const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3)); bg.setIndex(bi); bg.computeVertexNormals(); group.add(new THREE.Mesh(bg, era < .45 || lux ? M.chromeD : M.blackD)); geos.push(bg) }
  }
  // roof rails (horizontal profile lines running over the roof)
  for (const [la, lb, ly] of lines) {
    const e = vExtent(poly, (la + lb) / 2); if (!e || ly > e[0] + 2) continue;
    for (const side of [1, -1]) {
      const pts = []; for (let k = 0; k <= 12; k++) { const x = lerp(la + 4, lb - 4, k / 12), r = ringAt(x); pts.push(new THREE.Vector3(...P3(side * r[11][0] * .97, r[11][1] + 2.2, x))) }
      add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, .016, 6), M.black, 0, 0, 0, 0, 0, 0, true);
      for (const t of [0, 1]) { const x = lerp(la + 5, lb - 5, t), r = ringAt(x); add(new THREE.BoxGeometry(.04, my(2.4), .1), M.black, side * r[11][0] * .97 * sc, my(r[11][1] + 1), mz(x)) }
    }
  }
  // side decals (the supercar's side intakes): the profile polygon projected onto the body side
  if (body === 'super' && x2[0]) {
    const pts = x2[0].map(([x, y]) => new THREE.Vector2(x, y)), tris = THREE.ShapeUtils.triangulateShape(pts, []);
    let V = pts.map(p => [p.x, p.y]), T = tris.map(t => [...t]);
    for (let it = 0; it < 3; it++) {                       // subdivide so the decal follows the curved side
      const NV = V.slice(), mid = new Map(), NT = [];
      const m = (a, b) => { const k = a < b ? a + ',' + b : b + ',' + a; if (!mid.has(k)) { mid.set(k, NV.length); NV.push([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2]) } return mid.get(k) };
      for (const [a, b, c] of T) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); NT.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]) }
      V = NV; T = NT;
    }
    const p = [], idx = [];
    for (const side of [1, -1]) {
      const base = p.length / 3;
      for (const [x, y] of V) { const h = GROUND - y, lat = latAt(ringAt(x), h); p.push(...P3(side * (lat + ux(.003)), h, x)) }
      for (const [a, b, c] of T) side > 0 ? idx.push(base + a, base + c, base + b) : idx.push(base + a, base + b, base + c);
    }
    const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g2.setIndex(idx); g2.computeVertexNormals();
    group.add(new THREE.Mesh(g2, M.blackD)); geos.push(g2);
  }
  // wheel wells
  for (const [wx, r] of wh) {
    const ra = archR(r) * sc, cy = my(r), wellW = D.W * .4;
    for (const side of [1, -1]) {
      const wl = new THREE.CylinderGeometry(ra * .97, ra * .97, wellW, 22, 1, true, 0, Math.PI).rotateZ(Math.PI / 2).scale(1, VY, 1);
      add(wl, M.well, side * (D.W / 2 - wellW / 2 - .012), cy, mz(wx));
      if (clad) { const tor = new THREE.TorusGeometry(ra, .03, 6, 26, Math.PI).rotateY(Math.PI / 2).scale(1, VY, 1); add(tor, M.trim, side * (planW(wx) * sc - .01), cy, mz(wx)) }
    }
  }

  /* ---------- lamps, grille, bumpers, plates ---------- */
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x8a0d08, emissive: 0xff2410, emissiveIntensity: .35, roughness: .08, metalness: .25, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  ownMats.push(tailMat);
  const lights = { tail: tailMat, head: M.proj };
  const hbAt = x => { const e = vExtent(poly, x); return e ? GROUND - e[1] : 15 };
  const hbF = hbAt(x1 - 3), hbR = hbAt(x0 + 3);
  const hH = GROUND - s.hl[1] - 1.2, tH = GROUND - s.tl[1], tlh = s.tlh || 6;
  const cF = cornerAt(hH, 1), cR = cornerAt(tH, -1);
  const PROF_FRAME = [[0, .0015], [.5, .002], [1, .0015]], PROF_LENS = [[0, .003], [.5, .0055], [1, .003]];
  // headlamps
  if (era < .32 && !truck) {
    const rad = clamp(D.W * .052, .07, .095);
    for (const side of [1, -1]) {
      const ff = frameAt(1, cF * .72, hH, side);
      place(new THREE.CylinderGeometry(rad * 1.18, rad * 1.22, .05, 28).rotateX(Math.PI / 2), M.chrome, ff, .005);
      place(new THREE.SphereGeometry(rad, 24, 10, 0, Math.PI * 2, 0, Math.PI * .32).rotateX(Math.PI / 2), M.lens, ff, -.012);
      place(new THREE.CircleGeometry(rad * .35, 18), M.proj, ff, .022);
    }
  } else {
    const lh = truck ? 9 : lerp(9, 5.5, era) * (sporty ? .85 : 1), wrap = modern && !truck ? 6 : 0, s0 = cF * (truck ? .6 : modern ? .44 : .5), s1 = cF * (truck ? .97 : modern ? 1 : .95) + wrap;
    const lo = modern ? (u => hH - lh * .55 + lh * .45 * u * u) : cst(hH - lh / 2), hi = modern ? (u => hH + lh * .5 - lh * .12 * u) : cst(hH + lh / 2);
    ribbon(1, s0 - .9, s1 + .9, u => lo(u) - .8, u => hi(u) + .8, era < .45 ? M.chromeD : M.blackD, PROF_FRAME);
    ribbon(1, s0, s1, lo, hi, M.lens, PROF_LENS);
    const sp = lerp(s0, s1, .3), pr = lh * .3;
    ribbon(1, sp - pr, sp + pr, cst(hH - pr * .9), cst(hH + pr * .9), M.proj, [[0, .006], [1, .006]], 4);
    if (modern) { const sp2 = lerp(s0, s1, .62); ribbon(1, sp2 - pr * .8, sp2 + pr * .8, cst(hH - pr * .7), cst(hH + pr * .7), M.proj, [[0, .006], [1, .006]], 4) }
    if (car.hl === 'led' || era > .8) ribbon(1, s0 + .6, s1 - .4, u => lo(u) + .5, u => lo(u) + 1.3, M.drl, [[0, .0065], [1, .0065]]);
    else if (era < .5) ribbon(1, s1 + .6, s1 + 3.4, cst(hH - lh / 2), cst(hH - lh / 2 + 2.4), M.amber, PROF_LENS, 3);
  }
  // grille and air intakes
  {
    const tall = truck || body === 'suv' || body === 'pickup' || body === 'van';
    const gTop = tall ? hH + 3 : hH + (modern ? 1.5 : 2.5), gBotY = tall ? hH - 8 : hH - (modern ? 4.5 : 5);
    const gw = cF * (tall ? .5 : era < .4 ? .5 : .36);
    if (body !== 'super') {
      ribbon(1, 0, gw + 1.4, cst(gBotY - 1), cst(gTop + 1), era < .45 || tall || lux ? M.chromeD : M.blackD, [[0, .002], [1, .002]], 6);
      ribbon(1, 0, gw, cst(gBotY), cst(gTop), M.trimD, [[0, .0035], [1, .0035]], 6);
      const n = tall ? 4 : 3;
      for (let k = 1; k <= n; k++) { const y = lerp(gBotY, gTop, k / (n + 1)); ribbon(1, 0, gw - .5, cst(y - .35), cst(y + .35), era < .45 || tall ? M.chromeD : M.blackD, [[0, .006], [1, .006]], 6) }
    }
    if (!truck) {
      const iy0 = hbF + 2.2, iy1 = Math.min(hbF + (body === 'super' ? 8 : modern ? 7.5 : 5.5), body === 'super' ? hH - 4 : gBotY - 2.5);
      if (iy1 > iy0 + 1.5) ribbon(1, 0, cF * (modern ? .78 : .5), cst(iy0), cst(iy1), M.trimD, [[0, .003], [1, .003]], 10);
    }
  }
  // tail lamps
  if (truck) {
    const bp = pathPolys(s.box)[0]; let bx0 = Infinity; for (const [x] of bp) bx0 = Math.min(bx0, x);
    for (const side of [1, -1]) {
      add(new THREE.BoxGeometry(.32, my(tlh) * .8, .05), tailMat, side * (D.W / 2 - .3), my(tH), mz(bx0) + .03);
      add(new THREE.BoxGeometry(.12, my(tlh) * .8, .052), M.reverse, side * (D.W / 2 - .52), my(tH), mz(bx0) + .03);
    }
  } else {
    const wrapT = modern ? 9 : body === 'van' ? 3 : 1.5, s0 = cR * (body === 'van' ? .82 : modern ? .5 : .62), s1 = cR * (body === 'van' ? 1 : .97) + wrapT;
    const lo = cst(tH - tlh / 2), hi = modern ? (u => tH + tlh / 2 - tlh * .25 * u) : cst(tH + tlh / 2);
    ribbon(-1, s0 - .8, s1 + .8, u => lo(u) - .7, u => hi(u) + .7, era < .45 ? M.chromeD : M.blackD, PROF_FRAME);
    ribbon(-1, s0, s1, lo, hi, tailMat, PROF_LENS);
    ribbon(-1, s0 + .3, lerp(s0, s1, .12), cst(tH - tlh * .35), cst(tH + tlh * .05), M.reverse, [[0, .0062], [1, .0062]], 3);
    if (era > .72 && !util) { const by = tH + tlh / 2 - 1.6; ribbon(-1, 0, s0 - 1, cst(by), cst(by + .9), tailMat, [[0, .004], [1, .004]], 8) }
  }
  // bumpers: chrome bars on old cars, a black lower section on new ones
  if (!truck) {
    if (era < .4) for (const dir of [1, -1]) {
      const hb2 = dir > 0 ? hbF : hbR, c = cornerAt(hb2 + 5, dir);
      ribbon(dir, 0, c + 10, cst(hb2 + 3), cst(hb2 + 7.5), M.chrome, [[0, 0], [0, .02], [.2, .034], [.5, .04], [.8, .034], [1, .02], [1, 0]], 18);
    } else if (modern || clad) {
      const c = cornerAt(hbR + 3, -1);
      ribbon(-1, 0, c + 4, cst(hbR + .3), cst(hbR + (sporty ? 4 : 3.2)), M.blackD, [[0, .002], [1, .002]], 14);
    }
  }
  // number plates
  if (!truck) {
    const pg = new THREE.PlaneGeometry(.52, .113);
    place(pg, M.plate, frameAt(1, 0, lerp(hbF, hH, body === 'super' ? .25 : .42), 1), .006);
    place(pg.clone(), M.plate, frameAt(-1, 0, lerp(hbR, tH, .45), 1), .006);
  }
  // mirrors
  if (s.m) for (const side of [1, -1]) {
    const mx = s.m[0] + 3, r = ringAt(mx), lat = r[7][0] * sc, my2 = my(GROUND - s.m[1]) + .03, big = truck ? 1.8 : 1;
    if (era < .35 && !truck) { add(new THREE.CylinderGeometry(.008, .01, .1, 6), M.chrome, side * (lat + .05), my2 - .03, mz(mx + 6)); add(new THREE.SphereGeometry(.05, 14, 8).scale(1, 1, .5), M.chrome, side * (lat + .05), my2 + .03, mz(mx + 6)); continue }
    add(new THREE.BoxGeometry(.08 * big, .03 * big, .06), M.black, side * (lat + .04 * big), my2 - .025, mz(mx));
    add(new THREE.SphereGeometry(.1, 16, 10).scale(1.15 * big, .62 * big, .55), truck || clad ? M.black : paint, side * (lat + .13 * big), my2, mz(mx) + .02, 0, 0, 0, true);
    add(new THREE.CircleGeometry(.1, 18).scale(1.05 * big, .55 * big, 1), M.chrome, side * (lat + .13 * big), my2, mz(mx) + .056);
  }
  // exhaust tips
  if (!opts.ev) {
    const cyl = opts.cyl || 4, n = body === 'super' ? 4 : cyl >= 6 || sporty ? 2 : 1, hE = hbR + 1.6;
    for (let k = 0; k < n; k++) {
      const side = n === 1 ? -1 : (k % 2 ? 1 : -1), lat = (n === 4 ? (k < 2 ? .3 : .21) : .33) * D.W;
      const z = mz(surfX(ux(lat), Math.max(hE, hbR + .5), -1)) + .02, rad = sporty ? .045 : .035;
      add(new THREE.CylinderGeometry(rad, rad * .92, .16, 16, 1, true).rotateX(Math.PI / 2), M.chrome, side * lat, my(hE), z);
      add(new THREE.CircleGeometry(rad * .85, 16), M.well, side * lat, my(hE), z + .05);
    }
  }
  // wings and spoilers
  if (body === 'super') {
    const ww = D.W * .9, wb = x2[1] || [[12, 62], [46, 66]]; let wa = Infinity, wb2 = -Infinity, wy = Infinity; for (const [x, y] of wb) { wa = Math.min(wa, x); wb2 = Math.max(wb2, x); wy = Math.min(wy, y) }
    const ch = (wb2 - wa) * sc, foil = new THREE.Shape();
    foil.moveTo(ch / 2, 0); foil.quadraticCurveTo(ch * .3, .05, -ch / 2, .012); foil.lineTo(-ch / 2, -.004); foil.quadraticCurveTo(ch * .2, -.012, ch / 2, 0);
    const fg = new THREE.ExtrudeGeometry(foil, { depth: ww, bevelEnabled: false, curveSegments: 10 }).translate(0, 0, -ww / 2).rotateY(Math.PI / 2);
    const wz = mz((wa + wb2) / 2), wyM = my(GROUND - wy) - .02;
    add(fg, M.black, 0, wyM, wz, 0, 0, 0, true);
    for (const side of [1, -1]) {
      add(new THREE.BoxGeometry(.012, .16, ch * 1.05), M.black, side * ww / 2, wyM - .03, wz);
      const tx = surfX(ux(D.W * .28), GROUND - 74, -1), ty = vExtent(poly, tx + 4), base = ty ? my(GROUND - ty[0]) : wyM - .2;
      add(new THREE.BoxGeometry(.018, wyM - base + .02, .08), M.black, side * D.W * .28, (wyM + base) / 2, wz + .02, -.15);
    }
    for (let k = -3; k <= 3; k++) add(new THREE.BoxGeometry(.012, my(4), .3), M.trim, k * D.W * .1, my(hbR + 2), mz(x0) - .1);
  } else if (body === 'ssedan' || (body === 'coupe' && era > .5)) {
    const e = vExtent(poly, x0 + 7); if (e) add(new THREE.BoxGeometry(D.W * .8, .02, .13), M.black, 0, my(GROUND - e[0]) + .018, mz(x0 + 7), .14, 0, 0, true);
  }
  // convertible cockpit: seats, headrests, dashboard and steering wheel
  if (open) {
    const mid = ringAt((cockA + cockB) / 2), floor = mid[K - 1][1], beltH = mid[8][1];
    const rows = x2.map(p => { let a = Infinity, b = -Infinity, t = Infinity; for (const [x, y] of p) { a = Math.min(a, x); b = Math.max(b, x); t = Math.min(t, y) } return { cx: (a + b) / 2, top: GROUND - t } });
    for (const { cx, top } of rows) for (const sx of [1, -1]) {
      const lat = sx * D.W * .21, zc = mz(cx);
      add(new THREE.BoxGeometry(.46, my(2.4), .5), M.seat, lat, my(floor + 3), zc - .3, 0, 0, 0, true);
      add(new THREE.BoxGeometry(.46, my(top - floor - 6), .12), M.seat, lat, my((floor + top - 6) / 2 + 1.5), zc + .03, .16);
      add(new THREE.CapsuleGeometry(.09, .1, 4, 10).rotateZ(Math.PI / 2), M.seat, lat, my(top - 3), zc + .08);
    }
    const dz = mz(cockB - 5);
    add(new THREE.BoxGeometry(D.W * .86, my(5), .35), M.interior, 0, my(beltH - 3), dz - .02);
    add(new THREE.TorusGeometry(.17, .018, 8, 28), M.interior, -D.W * .21, my(beltH + 1.5), dz + .3, -.35);
    add(new THREE.CylinderGeometry(.02, .02, .3, 8).rotateX(Math.PI / 2 - .35), M.interior, -D.W * .21, my(beltH + .5), dz + .18);
  }
  // cargo box, chassis and fenders (trucks)
  let boxRear = null, boxTop = 0;
  if (truck) {
    const bp = pathPolys(s.box)[0]; let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity; for (const [x, y] of bp) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y) }
    const rearR = Math.max(...wh.filter(w => w[0] < front).map(w => w[1]));
    const topH = GROUND - by0, botH = Math.max(GROUND - by1, rearR * 2 + 4), bw = D.W * 1.02, bl = (bx1 - bx0) * sc, bh = my(topH - botH), bz = mz((bx0 + bx1) / 2), byc = my(botH) + bh / 2;
    add(new THREE.BoxGeometry(bw, bh, bl), M.boxSide, 0, byc, bz, 0, 0, 0, true);
    for (const [y, h2] of [[byc + bh / 2, .05], [byc - bh / 2, .06]]) add(new THREE.BoxGeometry(bw + .03, h2, bl + .03), M.trim, 0, y, bz);
    for (const side of [1, -1]) for (const z of [bz - bl / 2, bz + bl / 2]) add(new THREE.BoxGeometry(.05, bh, .05), M.trim, side * bw / 2, byc, z);
    for (const sx of seams.filter(x => x > bx0 + 4 && x < bx1 - 4)) for (const side of [1, -1]) add(new THREE.BoxGeometry(.012, bh * .96, .03), M.trim, side * (bw / 2 + .004), byc, mz(sx));
    add(new THREE.BoxGeometry(.015, bh * .94, .01), M.trim, 0, byc, bz + bl / 2 + .006);
    for (const side of [1, -1]) add(new THREE.BoxGeometry(.03, bh * .7, .03), M.chrome, side * .12, byc, bz + bl / 2 + .02);
    add(new THREE.BoxGeometry(D.W * .5, .14, bl + (x1 - bx1) * sc * .5), M.trim, 0, my(rearR) + .08, bz - (x1 - bx1) * sc * .25);
    add(new THREE.BoxGeometry(bw * .92, .1, .1), M.trim, 0, .5, mz(bx0) - .06);
    add(new THREE.PlaneGeometry(.52, .113), M.plate, 0, .62, mz(bx0) + .004);
    for (const [wx, r] of wh.filter(w => w[0] < front)) for (const side of [1, -1]) {
      const fr = archR(r) * sc; add(new THREE.CylinderGeometry(fr, fr, D.W * .32, 20, 1, true, 0, Math.PI).rotateZ(Math.PI / 2), M.well, side * (D.W / 2 - D.W * .16), my(r), mz(wx));
    }
    for (const side of [1, -1]) add(new THREE.CylinderGeometry(.24, .24, .7, 16).rotateX(Math.PI / 2), M.steel, side * (D.W / 2 - .3), .55, mz(bx1) - .6);
    boxRear = mz(bx0); boxTop = topH;
  }
  // race number on the doors
  if (opts.number) {
    const dx = clamp(xc - 2, x0 + 30, x1 - 30), r = ringAt(dx), t = numberTexture(opts.number);
    const m = new THREE.MeshBasicMaterial({ map: t, transparent: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    ownMats.push(m);
    for (const side of [1, -1]) add(new THREE.CircleGeometry(.2, 28), m, side * (r[4][0] * sc + .006), my(r[4][1]) + .02, mz(dx), 0, side * Math.PI / 2);
  }

  /* ---------- wheels ---------- */
  const tyreW = Math.min(.36, .19 + D.W * .03 + (body === 'super' ? .07 : sporty ? .03 : 0)) * (truck ? 1.12 : 1);
  const wstyle = util ? 'steel' : body === 'super' ? 'center' : era < .3 ? 'steel' : lux ? 'multi' : sporty ? 'five' : era < .55 ? 'six' : 'five';
  const rimMat = wstyle === 'steel' ? M.steel : body === 'super' || (sporty && era > .85) ? M.darkAlloy : M.alloy;
  const caliperMat = new THREE.MeshStandardMaterial({ color: car.brake === 'ceramic' ? 0xe0b114 : (sporty && car.brake !== 'drum') || car.brake === 'vent' && era > .6 ? 0xb3261e : 0x55595d, roughness: .35, metalness: .3 });
  ownMats.push(caliperMat);
  const wheels = [];
  for (const [wx, r] of wh) for (const side of [1, -1]) {
    const R = r * sc * VY, W2 = wheelGeos(R, tyreW, wstyle), isFront = wx === front;
    const steer = new THREE.Group(), spin = new THREE.Group(); steer.add(spin);
    steer.position.set(side * (D.W / 2 - tyreW / 2 - .035), R, mz(wx));
    const m = (g2, mat, x, rotY = 0, parent = spin) => { const o = new THREE.Mesh(g2, mat); o.position.x = x; o.rotation.y = rotY; parent.add(o); return o };
    m(W2.tyre, M.tyre, 0).castShadow = true;
    m(W2.barrel, M.darkAlloy, 0);
    m(W2.lip, rimMat, side * tyreW * .42);
    m(W2.faceGeo, rimMat, side * tyreW * .26, side < 0 ? Math.PI : 0);
    for (const n of W2.nuts) m(n, M.chrome, side * (tyreW * .26 + .04));
    m(W2.cap, wstyle === 'center' ? M.chrome : M.hub, side * (tyreW * .26 + .035));
    if (W2.hubcap) m(W2.hubcap, M.chrome, side * (tyreW * .22), side < 0 ? Math.PI : 0);
    m(W2.disc, M.disc, side * tyreW * .02); m(W2.discHat, M.hub, side * tyreW * .06);
    if (car.brake !== 'drum' && wstyle !== 'steel') { const cal = m(W2.caliper, caliperMat, side * tyreW * .08, 0, steer); cal.rotation.x = isFront ? -.5 : .5 }
    mergeStatic(spin, geos, false);
    group.add(steer);
    wheels.push({ steer, spin, front: isFront, side, R, z: steer.position.z });
  }
  const fl = wheels.filter(w => w.front && w.side < 0), frw = wheels.filter(w => w.front && w.side > 0), rl = wheels.filter(w => !w.front && w.side < 0), rrw = wheels.filter(w => !w.front && w.side > 0);
  let topH = boxTop; for (const r of rings) topH = Math.max(topH, r.ht);
  const frontZ = mz(x1), rearZ = Math.max(mz(x0), boxRear ?? -Infinity);
  const dims = { length: rearZ - frontZ, width: D.W, height: my(topH), frontZ, rearZ, eyeY: my(gPoly ? gBot + 8 : topH * .8), eyeZ: mz((gPoly ? gx1 : x1 * .7) - 20), hoodY: my(topH * .72) };
  mergeStatic(group, geos);
  group.userData = { geos, ownMats, bodyMat: paint };
  return { group, wheels, wheelsByPos: [fl, frw, rl, rrw], lights, dims };
}

/* fewer draw calls: bake the static child meshes into one mesh per material (wheels, textured decals and the body stay separate) */
function mergeStatic(group, geos, keepFirst = true) {
  const byMat = new Map(), body = keepFirst ? group.children[0] : null;
  for (const o of [...group.children]) {
    if (!o.isMesh || o === body || o.material.map || Array.isArray(o.material)) continue;
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(o);
  }
  for (const [mat, list] of byMat) {
    if (list.length < 2) continue;
    const P = [], N = [], I = []; let shadow = false;
    for (const o of list) {
      o.updateMatrix(); const g = o.geometry, pa = g.attributes.position, na = g.attributes.normal, base = P.length / 3;
      const m = o.matrix, nm = new THREE.Matrix3().getNormalMatrix(m), v = new THREE.Vector3();
      for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(m); P.push(v.x, v.y, v.z); v.fromBufferAttribute(na, i).applyMatrix3(nm).normalize(); N.push(v.x, v.y, v.z) }
      if (g.index) for (let i = 0; i < g.index.count; i++) I.push(base + g.index.getX(i)); else for (let i = 0; i < pa.count; i++) I.push(base + i);
      shadow ||= o.castShadow; group.remove(o);
      if (!g.userData.cached) { const k = geos.indexOf(g); if (k >= 0) geos.splice(k, 1); g.dispose() }
    }
    const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); mg.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); mg.setIndex(I);
    const mesh = new THREE.Mesh(mg, mat); mesh.castShadow = shadow; group.add(mesh); geos.push(mg);
  }
}

export function disposeCar(c) {
  const u = c.group.userData || {};
  for (const g of u.geos || []) g.dispose();
  for (const m of u.ownMats || []) { m.map?.dispose(); m.dispose() }
}
