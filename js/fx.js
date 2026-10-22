/* Tyre effects: skid marks laid where a tyre slides on hard ground, and smoke (or dust off the road) from sliding
   and spinning tyres. Both are single draw calls with fixed-size ring buffers, so they cost the same however long you drift. */
import * as THREE from './vendor/three.module.min.js';

const SMOKE_VS = `
attribute vec3 offset; attribute vec2 sa; attribute float rot; attribute float tint;
varying vec2 vUv; varying float vA; varying float vT;
void main() {
  vec4 mv = modelViewMatrix * vec4(offset, 1.0);
  float c = cos(rot), s = sin(rot);
  vec2 p = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
  mv.xy += p * sa.x;
  vUv = position.xy + .5; vA = sa.y; vT = tint;
  gl_Position = projectionMatrix * mv;
}`;
const SMOKE_FS = `
uniform vec3 color; uniform vec3 dust; varying vec2 vUv; varying float vA; varying float vT;
void main() {
  vec2 d = vUv - .5; float r = length(d) * 2.0;
  float a = smoothstep(1.0, .15, r) * vA;
  a *= .78 + .22 * sin(atan(d.y, d.x) * 5.0 + r * 6.0);    // a little billow
  if (a < .004) discard;
  gl_FragColor = vec4(mix(color, dust, vT), a);
}`;

export class TyreFX {
  constructor(scene, quality = 'high') {
    const lo = quality === 'low';
    this.scene = scene;
    // ---- skid marks
    const NS = this.NS = lo ? 700 : 2400;
    const pos = new Float32Array(NS * 4 * 3), col = new Float32Array(NS * 4 * 4), idx = new Uint32Array(NS * 6);
    for (let i = 0; i < NS; i++) { const v = i * 4, o = i * 6; idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], o) }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1)); g.setDrawRange(0, 0);
    this.skidMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide });
    this.skid = new THREE.Mesh(g, this.skidMat); this.skid.frustumCulled = false; this.skid.renderOrder = 1; scene.add(this.skid);
    this.si = 0; this.sn = 0; this.last = [null, null, null, null];
    // ---- smoke
    const NP = this.NP = lo ? 90 : 260;
    const q = new THREE.InstancedBufferGeometry(); q.instanceCount = NP;
    q.setAttribute('position', new THREE.Float32BufferAttribute([-.5, -.5, 0, .5, -.5, 0, -.5, .5, 0, .5, .5, 0], 3)); q.setIndex([0, 1, 2, 2, 1, 3]);
    this.pOff = new THREE.InstancedBufferAttribute(new Float32Array(NP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.pSA = new THREE.InstancedBufferAttribute(new Float32Array(NP * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.pRot = new THREE.InstancedBufferAttribute(new Float32Array(NP), 1);
    this.pTint = new THREE.InstancedBufferAttribute(new Float32Array(NP), 1).setUsage(THREE.DynamicDrawUsage);
    q.setAttribute('offset', this.pOff); q.setAttribute('sa', this.pSA); q.setAttribute('rot', this.pRot); q.setAttribute('tint', this.pTint);
    for (let i = 0; i < NP; i++) this.pRot.array[i] = Math.random() * 6.283;
    this.smokeMat = new THREE.ShaderMaterial({ vertexShader: SMOKE_VS, fragmentShader: SMOKE_FS, uniforms: { color: { value: new THREE.Color(0xf2f2ef) }, dust: { value: new THREE.Color(0x9c8664) } }, transparent: true, depthWrite: false });
    this.smoke = new THREE.Mesh(q, this.smokeMat); this.smoke.frustumCulled = false; this.smoke.renderOrder = 2; scene.add(this.smoke);
    this.parts = Array.from({ length: NP }, () => ({ age: 9, life: 1, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, s0: .5, s1: 2, a: 0 }));
    this.pi = 0; this.emitAcc = [0, 0, 0, 0];
  }
  /* sim: CarSim, spec: car spec, grade: slope along the heading (for wheel heights) */
  update(dt, sim, spec) {
    const sp = Math.sin(sim.psi), cp = Math.cos(sim.psi), fx = -sp, fz = -cp, lx = -cp, lz = sp;
    const pf = [spec.a, spec.a, -spec.b, -spec.b], pl = [spec.tw / 2, -spec.tw / 2, spec.tw / 2, -spec.tw / 2];
    const along = sim.loc.fx != null ? fx * sim.loc.fx + fz * sim.loc.fz : 1, grade = Number.isFinite(sim.loc.grade) ? sim.loc.grade * along : 0;
    const v = sim.speed, onGround = !sim.air;
    for (let k = 0; k < 4; k++) {
      const wx = sim.x + fx * pf[k] + lx * pl[k], wz = sim.z + fz * pf[k] + lz * pl[k], wy = sim.y + grade * pf[k] + .025;
      const sf = sim.surf[k], hard = sf && sf.id <= 3, slide = sim.slideK[k] || 0;
      const spinV = Math.max(0, (sim.wspd[k] || 0) - Math.abs(sim.u));        // burnout: tread faster than the car
      const burn = Math.min(1, spinV / 8);
      const mark = onGround && hard && (slide > .12 || burn > .25 || sim.lock[k]) && (v > 1 || burn > .25);
      // skid marks
      const L = this.last[k];
      if (mark) {
        const a = Math.min(.85, .25 + slide * .8 + burn * .5 + (sim.lock[k] ? .3 : 0));
        const d = L ? Math.hypot(wx - L.x, wz - L.z) : 0;
        if (L && d > .35 && d < 4) { this.segment(L, { x: wx, y: wy, z: wz, a }, spec.W > 2.2 ? .3 : .23); this.last[k] = { x: wx, y: wy, z: wz, a } }
        else if (!L || d >= 4) this.last[k] = { x: wx, y: wy, z: wz, a };     // new strip (or the car was moved)
      } else this.last[k] = null;
      // smoke: sliding or spinning tyres on hard ground, dust off it
      const heat = onGround ? Math.max(slide * Math.min(1, v / 10), burn) : 0;
      if (heat > .3) {
        this.emitAcc[k] += dt * (hard ? 38 : 16) * (heat - .2) * (k > 1 ? 1 : .5);
        while (this.emitAcc[k] >= 1) { this.emitAcc[k]--; this.emit(wx, wy, wz, sim, hard, heat) }
      } else this.emitAcc[k] = 0;
    }
    // particles
    const P = this.parts, off = this.pOff.array, sa = this.pSA.array;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (p.age < p.life) {
        p.age += dt; const t = Math.min(1, p.age / p.life), drag = Math.exp(-dt * 1.6);
        p.vx *= drag; p.vz *= drag; p.vy = p.vy * drag + dt * .35;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        off[i * 3] = p.x; off[i * 3 + 1] = p.y; off[i * 3 + 2] = p.z;
        sa[i * 2] = p.s0 + (p.s1 - p.s0) * Math.sqrt(t); sa[i * 2 + 1] = p.a * (1 - t) * Math.min(1, t * 8);
      } else { sa[i * 2] = 0; sa[i * 2 + 1] = 0 }
    }
    this.pOff.needsUpdate = true; this.pSA.needsUpdate = true;
  }
  emit(x, y, z, sim, hard, heat) {
    const p = this.parts[this.pi]; this.pi = (this.pi + 1) % this.parts.length;
    const r = () => Math.random() - .5;
    Object.assign(p, { age: 0, life: (hard ? 1.6 : 1.1) + Math.random() * 1.2, x: x + r() * .3, y: y + .15, z: z + r() * .3,
      vx: sim.vx * .35 + r() * 1.4, vy: .4 + Math.random() * .6, vz: sim.vz * .35 + r() * 1.4,
      s0: .45 + Math.random() * .3, s1: 2.2 + Math.random() * 1.6 + heat * 1.2, a: (hard ? .55 : .3) * Math.min(1, heat + .25), dust: !hard });
    this.pTint.array[(this.pi + this.parts.length - 1) % this.parts.length] = hard ? 0 : 1; this.pTint.needsUpdate = true;
  }
  segment(A, B, w) {
    const dx = B.x - A.x, dz = B.z - A.z, l = Math.hypot(dx, dz) || 1, nx = -dz / l * w / 2, nz = dx / l * w / 2;
    const i = this.si, v = i * 4, P = this.skid.geometry.attributes.position, C = this.skid.geometry.attributes.color;
    P.array.set([A.x + nx, A.y, A.z + nz, A.x - nx, A.y, A.z - nz, B.x + nx, B.y, B.z + nz, B.x - nx, B.y, B.z - nz], v * 3);
    const c = .07;
    C.array.set([c, c, c, A.a, c, c, c, A.a, c, c, c, B.a, c, c, c, B.a], v * 4);
    P.needsUpdate = true; C.needsUpdate = true;
    this.si = (i + 1) % this.NS; this.sn = Math.min(this.NS, this.sn + 1);
    this.skid.geometry.setDrawRange(0, this.sn * 6);
  }
  clearMarks() { this.sn = 0; this.si = 0; this.last = [null, null, null, null]; this.skid.geometry.setDrawRange(0, 0); for (const p of this.parts) p.age = 9 }
  dispose() {
    this.scene.remove(this.skid); this.scene.remove(this.smoke);
    this.skid.geometry.dispose(); this.smoke.geometry.dispose(); this.skidMat.dispose(); this.smokeMat.dispose();
  }
}
