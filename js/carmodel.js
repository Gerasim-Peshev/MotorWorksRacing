/* 3D cars built from the MotorWorks Tycoon side-profile artwork (SHAPES).
   The silhouette is lofted into a body with a tapered glasshouse; the original SVG drawing
   (windows, pillars, door lines, lights, intakes) is painted onto the sides as a texture. */
import * as THREE from './vendor/three.module.min.js';
import { SHAPES, BODYDIM, VY } from './parts.js';

const GROUND = 108;          // SVG y of the ground line
const TEX_K = 3.2;           // texture pixels per SVG unit

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
    } else if (c === 'Z') { /* closed */ }
  }
  return polys;
}
function vExtent(poly, x) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < poly.length; k++) {
    const [x0, y0] = poly[k], [x1, y1] = poly[(k + 1) % poly.length];
    if ((x >= Math.min(x0, x1)) && (x <= Math.max(x0, x1)) && x0 !== x1) { const y = y0 + (y1 - y0) * (x - x0) / (x1 - x0); lo = Math.min(lo, y); hi = Math.max(hi, y) }
    else if (x0 === x1 && Math.abs(x - x0) < 1e-6) { lo = Math.min(lo, y0, y1); hi = Math.max(hi, y0, y1) }
  }
  return lo === Infinity ? null : [lo, hi];
}
function inPoly(poly, x, y) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c } return c }

/* --- side texture from the original drawing --- */
function hexMix(a, b, t) { const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16); const ch = s => [(s >> 16) & 255, (s >> 8) & 255, s & 255]; const A = ch(pa), B = ch(pb); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('') }
function sideTexture(body, color, opts = {}) {
  const s = SHAPES[body], W = Math.round(320 * TEX_K), H = Math.round(116 * TEX_K);
  const cv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = cv.getContext('2d');
  g.scale(TEX_K, TEX_K);
  g.fillStyle = color; g.fillRect(0, 0, 320, 116);
  const sh = g.createLinearGradient(0, 20, 0, 100); sh.addColorStop(0, 'rgba(255,255,255,.10)'); sh.addColorStop(.55, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(0,0,0,.22)');
  g.fillStyle = sh; g.fillRect(0, 0, 320, 116);
  g.fillStyle = 'rgba(0,0,0,.14)'; g.fillRect(0, 84, 320, 9);
  const wh = s.wh || [[82, 16], [238, 16]];
  for (const [x, r] of wh) { g.fillStyle = '#121513'; g.beginPath(); g.arc(x, GROUND - r, r + 5, 0, Math.PI * 2); g.fill() }
  const P = d => new Path2D(d);
  if (s.g) { g.fillStyle = '#26333b'; g.fill(P(s.g)); const gl = g.createLinearGradient(0, 30, 0, 60); gl.addColorStop(0, 'rgba(190,215,235,.35)'); gl.addColorStop(1, 'rgba(190,215,235,.05)'); g.fillStyle = gl; g.fill(P(s.g)) }
  for (const [x, y1, y2] of s.pil || []) { g.strokeStyle = color; g.lineWidth = 5; g.beginPath(); g.moveTo(x, y1 - 1); g.lineTo(x, y2 + 1); g.stroke() }
  if (s.x2) { g.fillStyle = 'rgba(28,31,34,.85)'; g.fill(P(s.x2)) }
  g.strokeStyle = 'rgba(20,24,22,.45)'; g.lineWidth = 1.1; g.stroke(P(s.d));
  if (s.m) { g.fillStyle = color; g.strokeStyle = 'rgba(20,24,22,.5)'; g.lineWidth = .8; const m = new Path2D(`M${s.m[0]} ${s.m[1]} l7 -3 l2 5 l-8 2 z`); g.fill(m); g.stroke(m) }
  if (opts.number) {
    const dx = (s.x[0] + s.x[1]) / 2, dy = 74;
    g.fillStyle = '#f6f7f2'; g.beginPath(); g.arc(dx, dy, 7.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#18201b'; g.font = 'bold 10px Oswald, Arial Narrow, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(opts.number), dx, dy + .5);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.needsUpdate = true;
  return tex;
}

const shared = {};
function sharedMats() {
  if (shared.glass) return shared;
  shared.glass = new THREE.MeshStandardMaterial({ color: 0x1b252c, roughness: .06, metalness: .2, envMapIntensity: 1.4 });
  shared.trim = new THREE.MeshStandardMaterial({ color: 0x15181a, roughness: .85, metalness: .1 });
  shared.tyre = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: .92, metalness: 0 });
  shared.rim = new THREE.MeshStandardMaterial({ color: 0xb5bcbf, roughness: .3, metalness: .85 });
  shared.hub = new THREE.MeshStandardMaterial({ color: 0x2a2e31, roughness: .6, metalness: .5 });
  shared.head = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff1c4, emissiveIntensity: .6, roughness: .2 });
  shared.grille = new THREE.MeshStandardMaterial({ color: 0x101214, roughness: .7, metalness: .3 });
  return shared;
}

/* Build a car. Returns { group, wheels[4] {steer, spin}, lights:{tail, head}, dims } */
export function buildCar(car, opts = {}) {
  const body = car.body, s = SHAPES[body], D = BODYDIM[body], sc = D.s;
  const poly = pathPolys(s.p)[0];
  const glass = s.g ? pathPolys(s.g)[0] : null;
  const wh = s.wh || [[82, 16], [238, 16]];
  const [x0, x1] = [Math.min(...poly.map(p => p[0])), Math.max(...poly.map(p => p[0]))];
  const xc = (Math.max(...wh.map(w => w[0])) + Math.min(...wh.map(w => w[0]))) / 2;   // centre between axles
  const hw = D.W / 2 / sc;                       // half width in SVG units
  const beltY = glass ? Math.max(...glass.map(p => p[1])) : 60;
  const hBelt = GROUND - beltY;
  const mats = sharedMats();
  const color = car.color || '#c0392b';
  const tex = sideTexture(body, color, opts);
  const bodyMat = new THREE.MeshStandardMaterial({ map: tex, roughness: .32, metalness: .45, envMapIntensity: 1.1 });
  // slices
  const N = 90, xs = [];
  for (let j = 0; j <= N; j++) xs.push(x0 + .35 + (x1 - x0 - .7) * j / N);
  const R = 9; // ring points per half incl. centre
  const verts = [], uvs = [], slices = [];
  const tg = D.tg;
  const archH = x => { let h = -1; for (const [wx, r] of wh) { const ra = r + 3.5, dx = Math.abs(x - wx); if (dx < ra) h = Math.max(h, r + Math.sqrt(ra * ra - dx * dx)) } return h };
  const tops = xs.map(x => { const e = vExtent(poly, x); return e ? GROUND - e[0] : 0 });
  for (let j = 0; j <= N; j++) {
    const x = xs[j], e = vExtent(poly, x) || [90, 93];
    let ht = GROUND - e[0], hb = GROUND - e[1];
    const ah = archH(x); if (ah > 0) hb = Math.max(hb, Math.min(ah, ht - 2));
    const hs = Math.min(ht, hBelt), gh = Math.max(0, ht - hs);
    const k = Math.min(1, gh / 12), tgw = .95 + (tg - .95) * k;
    const crown = .6 + .4 * (1 - k);
    // the very ends taper in plan view a little
    const endF = Math.min(1, Math.min(x - x0, x1 - x) / 10), hwj = hw * (.9 + .1 * Math.sqrt(endF));
    const ring = [
      [0, hb], [hwj * .84, hb], [hwj * .97, hb + Math.min(2.5, (hs - hb) * .25)], [hwj, hb + (hs - hb) * .55],
      [hwj * .985, hs - Math.min(1.2, (hs - hb) * .1)], [hwj * .935, hs + .1 * gh + .25],
      [hwj * tgw, ht - .16 * gh - .25], [hwj * tgw * .9, ht - .02 * gh], [0, ht + crown * (gh > 2 ? .5 : 1)],
    ];
    slices.push({ x, ht, hb, hs, gh, ring });
  }
  // vertex layout: per slice 16 ring vertices (right half 0..8, left half 7..1)
  const ringIdx = [0, 1, 2, 3, 4, 5, 6, 7, 8, -7, -6, -5, -4, -3, -2, -1];
  const RN = ringIdx.length;
  const toM = (lat, h, x) => [lat * sc, h * sc * VY, -(x - xc) * sc];
  for (const sl of slices) {
    for (const ri of ringIdx) {
      const p = sl.ring[Math.abs(ri)], lat = ri < 0 ? -p[0] : p[0];
      verts.push(...toM(lat, p[1], sl.x));
      uvs.push(sl.x / 320, 1 - (GROUND - p[1]) / 116);
    }
  }
  const idx = [], groups = { body: [], glass: [], trim: [] };
  const slope = j => { const a = Math.max(0, j - 1), b = Math.min(N, j + 1); return (tops[b] - tops[a]) / (xs[b] - xs[a]) };
  for (let j = 0; j < N; j++) {
    const isCabin = slices[j].gh > 3 && slices[j + 1].gh > 3;
    const steep = Math.abs(slope(j)) > .33 || Math.abs(slope(j + 1)) > .33;
    for (let q = 0; q < RN; q++) {
      const a = j * RN + q, b = j * RN + (q + 1) % RN, c = (j + 1) * RN + q, d = (j + 1) * RN + (q + 1) % RN;
      const ra = Math.abs(ringIdx[q]), rb = Math.abs(ringIdx[(q + 1) % RN]);
      const top = (ra >= 6 && rb >= 6);
      const under = (ra <= 1 && rb <= 1);
      const g = under ? groups.trim : (top && isCabin && steep && glass) ? groups.glass : groups.body;
      g.push(a, c, b, b, c, d);
    }
  }
  // end caps (fan)
  const capStart = verts.length / 3;
  for (const [j, flip] of [[0, true], [N, false]]) {
    const sl = slices[j], cx = 0, cy = (sl.hb + sl.ht) / 2;
    const ci = verts.length / 3; verts.push(...toM(cx, cy, sl.x)); uvs.push(sl.x / 320, 1 - (GROUND - cy) / 116);
    for (let q = 0; q < RN; q++) {
      const a = j * RN + q, b = j * RN + (q + 1) % RN;
      if (flip) groups.body.push(ci, a, b); else groups.body.push(ci, b, a);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  let start = 0; const all = [];
  for (const [k, mi] of [['body', 0], ['glass', 1], ['trim', 2]]) { all.push(...groups[k]); geo.addGroup(start, groups[k].length, mi); start += groups[k].length }
  geo.setIndex(all);
  geo.computeVertexNormals();
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geo, [bodyMat, mats.glass, mats.trim]);
  mesh.castShadow = true; mesh.receiveShadow = false;
  group.add(mesh);
  // cargo box (trucks)
  if (s.box) {
    const bp = pathPolys(s.box)[0], bx0 = Math.min(...bp.map(p => p[0])), bx1 = Math.max(...bp.map(p => p[0])), by0 = Math.min(...bp.map(p => p[1])), by1 = Math.max(...bp.map(p => p[1]));
    const bw = D.W * 1.03, bl = (bx1 - bx0) * sc, bh = (by1 - by0) * sc * VY;
    const box = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bl), new THREE.MeshStandardMaterial({ color: new THREE.Color(hexMix(color, '#ffffff', .4)), roughness: .55, metalness: .1 }));
    box.position.set(0, (GROUND - by1) * sc * VY + bh / 2, -(((bx0 + bx1) / 2) - xc) * sc); box.castShadow = true; group.add(box);
  }
  // wing (supercar) from its x2 sub-paths
  if (body === 'super') {
    const ww = D.W * .86, wing = new THREE.Mesh(new THREE.BoxGeometry(ww, .045, (46 - 12) * sc), mats.trim);
    wing.position.set(0, (GROUND - 64) * sc * VY, -((29) - xc) * sc); wing.castShadow = true; group.add(wing);
    for (const sx of [-1, 1]) { const st = new THREE.Mesh(new THREE.BoxGeometry(.04, (72 - 66) * sc * VY + .06, .08), mats.trim); st.position.set(sx * ww * .3, (GROUND - 69) * sc * VY, -(32 - xc) * sc); group.add(st) }
  }
  if (body === 'cabrio' && s.x2) {
    for (const p of pathPolys(s.x2)) { const xa = Math.min(...p.map(q => q[0])), xb = Math.max(...p.map(q => q[0])), yt = Math.min(...p.map(q => q[1]));
      for (const sx of [-1, 1]) { const hr = new THREE.Mesh(new THREE.BoxGeometry(.3, (62 - yt) * sc * VY, (xb - xa) * sc * .45), mats.trim); hr.position.set(sx * D.W * .22, (GROUND - (62 + yt) / 2) * sc * VY, -((xa + xb) / 2 - xc) * sc); group.add(hr) } }
  }
  // mirrors
  if (s.m) for (const sx of [-1, 1]) { const mm = new THREE.Mesh(new THREE.BoxGeometry(.11, .07, .09), bodyMat); mm.position.set(sx * (D.W / 2 + .05), (GROUND - s.m[1] - 1) * sc * VY, -(s.m[0] + 4 - xc) * sc); group.add(mm) }
  // lights
  const frontZ = -(x1 - xc) * sc, rearZ = -(x0 - xc) * sc;
  const headY = (GROUND - s.hl[1] - 2.5) * sc * VY, tailY = (GROUND - s.tl[1] - (s.tlh || 6) / 2) * sc * VY;
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x8a1a12, emissive: 0xff2a14, emissiveIntensity: .35, roughness: .3 });
  const lights = { tail: tailMat, head: mats.head };
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(D.W * .2, .09, .05), mats.head); hl.position.set(sx * D.W * .32, headY, frontZ + .01); group.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(D.W * .2, (s.tlh || 6) * sc * VY * .9, .05), tailMat); tl.position.set(sx * D.W * .33, tailY, rearZ - .01); group.add(tl);
  }
  const gr = new THREE.Mesh(new THREE.BoxGeometry(D.W * .36, .12, .04), mats.grille); gr.position.set(0, headY - .08, frontZ + .015); group.add(gr);
  // wheels
  const wheels = [];
  const front = Math.max(...wh.map(w => w[0]));
  const tyreW = Math.min(.34, .19 + D.W * .03 + (body === 'super' ? .06 : 0));
  const wheelList = [];
  for (const [wx, r] of wh) for (const side of [1, -1]) wheelList.push({ wx, r, side, isFront: wx === front });
  for (const w of wheelList) {
    const Rm = w.r * sc * VY;
    const steer = new THREE.Group(); const spin = new THREE.Group(); steer.add(spin);
    steer.position.set(w.side * (D.W / 2 - tyreW / 2 + .015), Rm, -(w.wx - xc) * sc);
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(Rm, Rm, tyreW, 28, 1), mats.tyre); tyre.rotation.z = Math.PI / 2; tyre.castShadow = true; spin.add(tyre);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(Rm * .64, Rm * .64, tyreW * 1.02, 24, 1), mats.rim); rim.rotation.z = Math.PI / 2; spin.add(rim);
    const face = new THREE.Group(); face.position.x = w.side * tyreW * .52; spin.add(face);
    for (let k = 0; k < 5; k++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(.02, Rm * 1.08, Rm * .14), mats.hub); sp.rotation.x = k * Math.PI * 2 / 5; face.add(sp) }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(Rm * .15, Rm * .15, .03, 12), mats.hub); hub.rotation.z = Math.PI / 2; face.add(hub);
    group.add(steer);
    wheels.push({ steer, spin, front: w.isFront, side: w.side, R: Rm, z: steer.position.z });
  }
  // order FL, FR, RL, RR for the physics (left = -x side? our car's left is -X)
  const fl = wheels.filter(w => w.front && w.side < 0), fr = wheels.filter(w => w.front && w.side > 0), rl = wheels.filter(w => !w.front && w.side < 0), rr = wheels.filter(w => !w.front && w.side > 0);
  const dims = { length: (x1 - x0) * sc, width: D.W, height: Math.max(...tops) * sc * VY, frontZ, rearZ, eyeY: (GROUND - (beltY - 8)) * sc * VY, eyeZ: -(((glass ? Math.max(...glass.map(p => p[0])) : x1 * .7) - 20) - xc) * sc, hoodY: (Math.max(...tops) * .72) * sc * VY };
  group.userData = { tex, bodyMat };
  return { group, wheels, wheelsByPos: [fl, fr, rl, rr], lights, dims };
}

export function disposeCar(c) {
  c.group.traverse(o => { if (o.geometry) o.geometry.dispose() });
  c.group.userData.tex?.dispose(); c.group.userData.bodyMat?.dispose();
}
