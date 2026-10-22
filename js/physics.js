/* Vehicle dynamics derived from a MotorWorks engine + car design.
   4 wheels, load transfer, combined-slip tyres, turbo lag, real gear ratios, diffs, ABS/ESC, aero, surfaces.
   Car frame: forward f = (-sin ψ, -cos ψ), left l = (-cos ψ, sin ψ) in world (x,z). ψ increases turning left. */
import { BODIES, SHAPES, LAYOUTS, BODYDIM, VY, GEARINFO, TYRES, BRAKES, SUSP, carStats, engStats, clamp } from './parts.js';

export const G = 9.81, RHO = 1.225, DT = 1 / 240;
const RPM2W = Math.PI / 30;

const SUSPK = { std: { roll: .55, tau: .085, grip: 1.0, h: 1.0 }, leaf: { roll: .52, tau: .11, grip: .95, h: 1.04 }, sport: { roll: .56, tau: .06, grip: 1.03, h: .97 },
  coil: { roll: .55, tau: .045, grip: 1.06, h: .95 }, air: { roll: .55, tau: .09, grip: 1.0, h: .98 } };
const SPREAD = { 1: 1, 3: 2.55, 4: 3.3, 5: 4.05, 6: 4.9, 7: 5.8, 8: 6.8, 9: 8.0 };

/* ---------- torque curve ---------- */
function buildCurve(e, es) {
  const red = es.rpm, ev = es.ev;
  const Pmax = es.hp * 745.7;
  if (ev) {
    const Tpk = es.tq;
    return { ev: true, red, idle: 0, Pmax, Tpk, rT: 0, rP: Pmax / Tpk / RPM2W,
      full: rpm => { const w = Math.max(rpm, 1) * RPM2W; let t = Math.min(Tpk, Pmax / w); if (rpm > red * .94) t *= Math.max(0, (red - rpm) / (red * .06)); return t } };
  }
  const diesel = e.fuel === 'diesel', rot = LAYOUTS[e.layout].rot, turbo = es.tb > 0, sc = e.sc && e.sc !== 'none';
  let rT = e.valve === 'dohc' ? .66 : e.valve === 'sohc' ? .6 : .5, rP = e.valve === 'ohv' ? .86 : .91;
  if (rot) { rT = .72; rP = .95 } if (diesel) { rT = .42; rP = .84 }
  const TP = Pmax / (rP * red * RPM2W);
  const Tpk = Math.max(es.tq, TP * 1.03);
  const TPn = TP / Tpk, TRn = .95 * TPn * rP;
  let knots;
  if (turbo) { const a = diesel ? .3 : .36, b = diesel ? .56 : .66; knots = [[0, .42], [.12, .5], [a, 1], [b, 1], [Math.max(rP, b + .05), TPn], [1, TRn], [1.12, TRn * .7]] }
  else if (diesel) knots = [[0, .55], [.18, .75], [rT, 1], [rP, TPn], [1, TRn], [1.12, TRn * .7]];
  else knots = [[0, sc ? .62 : .48], [.14, sc ? .74 : .6], [rT, 1], [rP, TPn], [1, TRn], [1.12, TRn * .7]];
  knots.sort((p, q) => p[0] - q[0]);
  for (let i = 1; i < knots.length; i++) if (knots[i][0] <= knots[i - 1][0]) knots[i][0] = knots[i - 1][0] + .01;
  const N = 96, tab = new Float32Array(N + 1), top = red * 1.12;
  for (let j = 0; j <= N; j++) {
    const x = j / N * 1.12; let k = 1; while (k < knots.length - 1 && knots[k][0] < x) k++;
    const [x0, y0] = knots[k - 1], [x1, y1] = knots[k]; const f = clamp((x - x0) / (x1 - x0), 0, 1);
    const u = f * f * (3 - 2 * f) * .5 + f * .5;
    tab[j] = (y0 + (y1 - y0) * u) * Tpk;
  }
  const full = rpm => { const x = clamp(rpm / top, 0, 1) * N, j = Math.min(N - 1, Math.floor(x)), f = x - j; return tab[j] * (1 - f) + tab[j + 1] * f };
  return { ev: false, red, idle: diesel ? 800 : rot ? 1000 : 900, Pmax, Tpk, rT: rT * red, rP: rP * red, full, diesel, rot };
}

export function engineCurve(eng) {
  const es = engStats(eng), c = buildCurve(eng, es), pts = [];
  const top = c.red, lo = c.ev ? 0 : c.idle;
  for (let k = 0; k <= 40; k++) { const rpm = lo + (top - lo) * k / 40; const t = c.full(Math.max(rpm, 1)); pts.push([rpm, t, t * rpm * RPM2W / 745.7]) }
  return { pts, red: c.red, ev: c.ev, Tpk: c.Tpk, hp: es.hp };
}

/* ---------- spec from design ---------- */
export function buildSpec(car, eng) {
  const B = BODIES[car.body], D = BODYDIM[car.body], cs = carStats(car, eng), es = cs.es, sh = SHAPES[car.body];
  const wh = sh.wh || [[82, 16], [238, 16]];
  const xs = wh.map(w => w[0]), xf = Math.max(...xs), rearW = wh.filter(w => w[0] < xf), xr = rearW.reduce((a, w) => a + w[0], 0) / rearW.length;
  const L = (xf - xr) * D.s;
  const R = wh[wh.length - 1][1] * D.s * VY;
  const m = cs.w + 75;
  let fr = D.f;
  if (!['super', 'micro'].includes(car.body)) { if (car.dt === 'rwd') fr -= .025; if (car.dt === 'awd') fr -= .01; if (es.ev) fr = .5; if (es.w > 260) fr += .02 }
  const SU = SUSPK[car.susp || 'std'];
  const hcg = D.h * SU.h;
  const tw = D.W - .24;
  const Izz = m * (.24 * L * L + .1 * D.W * D.W) * 1.12;
  const TY = TYRES[car.tyre || 'road'], BR = BRAKES[car.brake || 'disc'];
  const era = .93 + .07 * clamp((car.year - 1970) / 40, 0, 1);
  const curve = buildCurve(eng, es);
  const gi = GEARINFO[car.gb] || GEARINFO.m5;
  const CdA = .82 / Math.pow(B.aero, 3);
  const spec = {
    car, eng, es, cs, m, L, a: L * (1 - fr), b: L * fr, fr, hcg, tw, W: D.W, Izz, R, Iw: 1.1 * (R / .3) ** 2,
    mu: TY.mu * SU.grip * era, peak: TY.peak, rr: .012 * TY.rr, CdA, ClA: D.cl, clF: car.body === 'super' ? .42 : .5,
    roll: SU.roll + (car.dt === 'fwd' ? .03 : car.dt === 'rwd' ? -.02 : 0), tau: SU.tau,
    curve, gb: gi, drive: car.dt === 'fwd' ? 1 : car.dt === 'rwd' ? 0 : .38, lsd: !!car.lsd,
    brakeF: m * G * 1.08 * BR.f, bias: 0,
    abs: (car.equip || []).includes('abs'), esc: (car.equip || []).includes('esc'),
    vmax: B.vmax ? B.vmax / 3.6 : 0, lock: ['ltruck', 'htruck', 'van'].includes(car.body) ? .55 : .62,
    Ie: es.ev ? .06 : .1 + .045 * (es.L || 1) + (es.tb || 0) * .006,
    boost: es.tb ? { M: es.boostM, tauUp: .22 + .12 * Math.pow(es.bar, .8) + .035 * es.tb, start: (eng.fuel === 'diesel' ? .22 : .3) + .025 * es.bar, span: .14 + .01 * es.bar } : null,
    sc: eng.sc && eng.sc !== 'none',
  };
  // brake balance matched to the dynamic front load at the limit, like a real chassis engineer would
  spec.bias = clamp(fr + .85 * spec.mu * hcg / L, .55, .8);
  gearRatios(spec);
  return spec;
}

function topSpeed(spec) {
  const eff = spec.gb.eff * (spec.drive > 0 && spec.drive < 1 ? .97 : 1), P = spec.curve.Pmax * eff;
  let v = 5;
  for (; v < 160; v += .1) { const res = (.5 * RHO * spec.CdA * v * v + spec.rr * spec.m * G) * v; if (res >= P) break }
  return spec.vmax ? Math.min(v, spec.vmax) : v;
}
function gearRatios(spec) {
  const c = spec.curve, gi = spec.gb, vt = topSpeed(spec); spec.vtop = vt;
  const rpmTop = c.ev ? c.red * .97 : Math.min(c.red * .985, c.rP * 1.04);
  const top = rpmTop * RPM2W * spec.R / vt;           // overall ratio in top gear
  spec.final = c.ev ? top : 3.4;
  if (gi.type === 'ev') { spec.ratios = [top]; return }
  if (gi.type === 'cvt') { spec.ratios = [top * 5.8, top]; spec.cvt = { lo: top * 5.8, hi: top }; return }
  const n = gi.g, spread = SPREAD[n] * (c.diesel ? 1.08 : 1) * (c.red > 8000 ? .92 : 1), r = [];
  for (let i = 0; i < n; i++) { const x = (n - 1 - i) / (n - 1); r.push(top * Math.pow(spread, Math.pow(x, .88))) }
  spec.ratios = r;
}

/* magic-formula shape, normalised to peak 1 at alpha = peak */
function mf(alpha, peak) { const B = 2.3 / peak; return Math.sin(1.35 * Math.atan(B * alpha)) }

export class CarSim {
  constructor(spec) { this.spec = spec; this.reset({ x: 0, z: 0, y: 0, psi: 0 }) }
  reset(p) {
    const s = this.spec;
    Object.assign(this, { x: p.x, z: p.z, y: p.y || 0, psi: p.psi || 0, vx: 0, vz: 0, r: 0, vy: 0, air: false,
      gear: 1, rpm: s.curve.idle || 0, shiftT: 0, shiftTo: 0, boost: 0, steer: 0, axf: 0, ayf: 0, lastShift: 0, t: 0,
      spin: [0, 0, 0, 0], lock: [0, 0, 0, 0], slipA: [0, 0, 0, 0], slipL: [0, 0, 0, 0], Fz: [0, 0, 0, 0], surf: [null, null, null, null],
      wheelRot: [0, 0, 0, 0], wspd: [0, 0, 0, 0], limiter: 0, escOn: 0, absOn: 0, tcOn: 0, impact: 0, bump: 0, offTrack: 0, hint: p.hint ?? -1,
      cvtRatio: s.cvt ? s.cvt.lo : 0, throttleEff: 0, reverse: false, revHold: 0, landing: 0 });
    this.u = 0; this.w = 0; this.loc = {};
  }
  get speed() { return Math.hypot(this.vx, this.vz) }
  ratio() { const s = this.spec; if (this.reverse) return -s.ratios[0] * 1.05; if (s.cvt) return this.cvtRatio; return s.ratios[clamp(this.gear, 1, s.ratios.length) - 1] }

  /* inp: {throttle, brake, steer(-1 right..+1 left? no: +1 = right), handbrake, shiftUp, shiftDown}, opts: {auto, abs, esc, tc, assist} */
  step(dt, inp, track, opts) {
    const s = this.spec, c = s.curve; this.t += dt;
    const sp = Math.sin(this.psi), cp = Math.cos(this.psi);
    const fx = -sp, fz = -cp, lx = -cp, lz = sp;
    let u = this.vx * fx + this.vz * fz, w = this.vx * lx + this.vz * lz;
    // ---- locate on track
    const loc = track.locate(this.x, this.z, this.hint, this.loc, this.vx, this.vz, this.y); this.hint = loc.i;
    // ---- inputs
    let thr = clamp(inp.throttle || 0, 0, 1), brk = clamp(inp.brake || 0, 0, 1);
    const steerIn = clamp(inp.steer || 0, -1, 1);            // +1 = right
    // reverse: automatic = keep holding the brake at a standstill, then the brake pedal drives backwards
    if (opts.auto) {
      if (!this.reverse) {
        if (Math.abs(u) < .5 && brk > .4 && thr < .05) { this.revHold += dt; if (this.revHold > .9) { this.reverse = true; this.revHold = 0 } } else this.revHold = 0;
      } else if (thr > .1 && u > -1) { this.reverse = false; this.gear = 1 }
      if (this.reverse) { const t2 = thr; thr = brk; brk = t2 }
    }
    // ---- manual shifting
    if (!s.cvt && s.ratios.length > 1) {
      if (inp.shiftUp) { if (this.reverse) { this.reverse = false; this.gear = 1 } else if (this.gear < s.ratios.length) this.beginShift(this.gear + 1) }
      if (inp.shiftDown) { if (this.gear > 1) { const r2 = s.ratios[this.gear - 2], wr = Math.abs(u) / s.R * r2 / RPM2W; if (wr < c.red * 1.02 || !opts.auto) this.beginShift(this.gear - 1) } else if (Math.abs(u) < 2) this.reverse = true }
    } else if (inp.shiftDown && Math.abs(u) < 2) this.reverse = !this.reverse;
    // ---- steering (speed sensitive, optional slip assist)
    const au = Math.abs(u);
    const assist = opts.assist ?? .8;
    let dmax = opts.rawSteer ? s.lock : s.lock / (1 + (au / (opts.steerSpeed || 19)) ** 2);
    if (assist > 0 && !opts.rawSteer) dmax = Math.max(dmax, .085 + .03 * (1 - assist));
    let target = -steerIn * dmax;                            // + = left
    this.deltaDriver = target;
    if (assist > 0 && au > 3) {
      const bf = Math.atan2(w + this.r * s.a, au);           // front axle travel direction
      target += assist * clamp(bf, -.5, .5) * (u > 0 ? 1 : 0);
    }
    target = clamp(target, -s.lock, s.lock);
    const rate = opts.rawSteer ? 6 : 3.2 + 2 * (opts.fastSteer || 0);
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);
    const delta = this.steer;
    // ---- vertical / loads
    const vxG = loc.grade, ground = loc.h;
    const along = u * (loc.fx * fx + loc.fz * fz) + w * (loc.fx * lx + loc.fz * lz); // velocity along track tangent
    const groundVy = along * vxG;
    let gn = G / Math.sqrt(1 + vxG * vxG) + along * along * loc.kv;
    if (!this.air) {
      if (gn < 0 && au > 12) { this.air = true; this.vy = groundVy }
      else { this.y = ground; this.vy = groundVy }
    }
    if (this.air) {
      this.vy -= G * dt; this.y += this.vy * dt;
      if (this.y <= ground) { this.landing = Math.max(this.landing, groundVy - this.vy); this.air = false; this.y = ground; this.vy = groundVy }
      gn = this.air ? 0 : G;
    }
    gn = Math.max(0, gn);
    // aero
    const V2 = u * u + w * w, DF = .5 * RHO * s.ClA * V2;
    const Fzf = s.m * gn * s.b / s.L - s.m * this.axf * s.hcg / s.L + DF * s.clF;
    const Fzr = s.m * gn * s.a / s.L + s.m * this.axf * s.hcg / s.L + DF * (1 - s.clF);
    const dLat = s.m * this.ayf * s.hcg / s.tw;              // ayf + = accelerating left -> right wheels gain load
    const Fz = this.Fz;
    Fz[0] = Math.max(0, Fzf / 2 - dLat * s.roll); Fz[1] = Math.max(0, Fzf / 2 + dLat * s.roll);
    Fz[2] = Math.max(0, Fzr / 2 - dLat * (1 - s.roll)); Fz[3] = Math.max(0, Fzr / 2 + dLat * (1 - s.roll));
    if (this.air) Fz[0] = Fz[1] = Fz[2] = Fz[3] = 0;
    // ---- wheel positions & surfaces (0 FL, 1 FR, 2 RL, 3 RR)
    const pf = [s.a, s.a, -s.b, -s.b], pl = [s.tw / 2, -s.tw / 2, s.tw / 2, -s.tw / 2];
    const nX = loc.fz, nZ = -loc.fx;  // track left normal
    let dragK = 0, bump = 0, off = 0;
    for (let k = 0; k < 4; k++) {
      const wx = fx * pf[k] + lx * pl[k], wz = fz * pf[k] + lz * pl[k];
      const d = loc.d + wx * nX + wz * nZ;
      const sf = track.surfaceAt ? track.surfaceAt(this.x + wx, this.z + wz, this.y) : track.surface(loc.i, d); this.surf[k] = sf;
      dragK += sf.drag / 4; bump = Math.max(bump, sf.bump); if (sf.id >= 4) off++;
    }
    this.bump = bump; this.offTrack = off;
    // ---- engine & drivetrain
    const ratio = this.ratio();
    const drivenW = s.drive === 1 ? [0, 1] : s.drive === 0 ? [2, 3] : [0, 1, 2, 3];
    let spinAvg = 0; for (const k of drivenW) spinAvg += this.spin[k]; spinAvg /= drivenW.length;
    const wheelRpm = Math.abs(u) / s.R * Math.abs(ratio) / RPM2W;
    const shifting = this.shiftT > 0;
    if (shifting) { this.shiftT -= dt; if (this.shiftT <= 0) { this.gear = this.shiftTo; this.shiftT = 0 } }
    // auto gearbox
    if (opts.auto && !s.cvt && s.ratios.length > 1 && !shifting && !this.reverse && this.t - this.lastShift > .45) {
      const up = c.red * (thr > .65 ? .975 : .5 + .45 * thr), r = Math.min(this.rpm, Math.max(wheelRpm, c.idle * .8));
      const atLimit = this.rpm > c.red * .985;
      if (this.gear < s.ratios.length && ((r > up && spinAvg < .25) || (atLimit && thr > .5)) && !this.air) this.beginShift(this.gear + 1);
      else if (this.gear > 1) {
        const rLow = Math.abs(u) / s.R * s.ratios[this.gear - 2] / RPM2W;
        const pw = q => c.full(q) * q;
        let go = false;
        if (rLow < c.red * .94) {
          if (thr > .85) go = pw(rLow) > pw(Math.max(r, c.idle)) * 1.04;
          else if (brk > .2) go = rLow < c.red * .78;
          else go = r < Math.max(c.idle * 1.5, c.red * .32);
        }
        if (go) this.beginShift(this.gear - 1);
      }
    }
    // CVT keeps the engine near the power band
    if (s.cvt) {
      const tgt = c.idle + (c.rP * 1.0 - c.idle) * Math.pow(thr, .8);
      const want = au < .5 ? s.cvt.lo : clamp(tgt * RPM2W * s.R / au, s.cvt.hi, s.cvt.lo);
      this.cvtRatio += (want - this.cvtRatio) * Math.min(1, dt * 4);
    }
    // engine speed
    const launchRpm = c.ev ? 0 : s.gb.type === 'auto' ? c.red * .38 : Math.min(c.rT * .9 + c.idle, c.red * .7);
    let rpmTarget = wheelRpm * (1 + spinAvg);
    let clutchSlip = false;
    const slipGear = this.reverse || this.gear <= (s.gb.type === 'auto' ? 2 : 1) || s.cvt;
    if (!c.ev && !shifting) {
      const lt = c.idle + thr * (launchRpm - c.idle);
      if (slipGear && rpmTarget < lt) { rpmTarget = lt; clutchSlip = true }
      else if (rpmTarget < c.idle) { rpmTarget = c.idle; clutchSlip = true }   // clutch in below idle
    }
    if (shifting) {
      const nr = Math.abs(u) / s.R * s.ratios[this.shiftTo - 1] / RPM2W;
      rpmTarget = this.rpm + (Math.max(nr, c.idle) - this.rpm) * Math.min(1, dt * 14);
    }
    if (c.ev) rpmTarget = wheelRpm * (1 + spinAvg);
    this.rpm += (rpmTarget - this.rpm) * Math.min(1, dt * (clutchSlip ? 12 : 40));
    this.rpm = clamp(this.rpm, c.ev ? 0 : c.idle * .7, c.red * 1.06);
    // turbo
    if (s.boost) {
      const x = this.rpm / c.red, ramp = clamp((x - s.boost.start) / s.boost.span, 0, 1);
      const tgt = thr * ramp;
      this.boost += (tgt - this.boost) * Math.min(1, dt / (tgt > this.boost ? s.boost.tauUp : .16));
    }
    // rev limiter
    if (this.rpm >= c.red * .995 && !c.ev) this.limiter = .06;
    if (this.limiter > 0) this.limiter -= dt;
    let throttleEff = this.limiter > 0 ? 0 : thr;
    if (s.vmax && Math.abs(u) > s.vmax) throttleEff = 0;
    if (this.reverse && u < -8.5) throttleEff = 0;          // reverse is limited to ~30 km/h
    // ESC throttle intervention
    if (this.escOn > 0) throttleEff *= .35;
    let Teng;
    const full = c.full(Math.max(this.rpm, c.ev ? 1 : c.idle));
    const bfac = s.boost ? (1 / s.boost.M + (1 - 1 / s.boost.M) * this.boost) : 1;
    const fric = c.ev ? .18 * c.Tpk * (au > 1 ? 1 : 0) : (.06 + .12 * this.rpm / c.red) * c.Tpk;
    Teng = throttleEff * full * bfac - (1 - throttleEff) * fric;
    if (!c.ev && this.rpm <= c.idle * 1.02 && Teng < 0) Teng = 0;
    this.throttleEff = throttleEff;
    let shiftFac = 1;
    if (shifting) shiftFac = s.gb.type === 'dct' ? .85 : s.gb.type === 'auto' ? .45 : 0;
    // total drive force at the contact patches (+ forward, - when engine braking)
    let Fdrive = Teng * ratio * s.gb.eff * shiftFac / s.R;
    if (Teng < 0 && Math.abs(u) < 1) Fdrive = 0;           // no engine braking at a standstill
    // ---- per wheel forces
    let Ffwd = 0, Fleft = 0, M = 0, absAct = 0, tcAct = 0, sq = 0;
    const share = [s.drive / 2, s.drive / 2, (1 - s.drive) / 2, (1 - s.drive) / 2];
    // open diff: an axle can only push as hard as its weaker wheel allows
    const axleCap = k => { const o = k ^ 1; return Math.min(Fz[k] * this.surf[k].mu, Fz[o] * this.surf[o].mu) * s.mu };
    const loadSens = Fz0 => 1 - .07 * (Fz0 / (s.m * G / 4) - 1);
    for (let k = 0; k < 4; k++) {
      const front = k < 2, dl = front ? delta : 0;
      const vxw = u - this.r * pl[k], vyw = w + this.r * pf[k];
      const cd = Math.cos(dl), sd = Math.sin(dl);
      const vl = vxw * cd + vyw * sd, vt = -vxw * sd + vyw * cd;  // wheel frame: long, lateral(left)
      const mu = s.mu * this.surf[k].mu * clamp(loadSens(Fz[k]), .8, 1.12);
      const cap = mu * Fz[k];
      const vref = Math.max(Math.abs(vl), 4);
      const alpha = Math.atan2(vt, vref);
      this.slipA[k] = alpha;
      let Fy = -Math.sign(alpha) * cap * mf(Math.abs(alpha), s.peak);
      // longitudinal demand
      let Fx = Fdrive * share[k];
      if (!s.lsd && share[k] > 0 && Fdrive > 0) { const ac = axleCap(k) * 1.0; Fx = Math.min(Fx, ac) }
      // brakes
      const hb = inp.handbrake && !front ? 1 : 0;
      const bshare = front ? s.bias / 2 : (1 - s.bias) / 2;
      const Fb = brk * s.brakeF * bshare;
      const dir = Math.abs(vl) > .05 ? Math.sign(vl) : 0;
      // rolling resistance & surface drag
      let Fbrake = Fb;
      let locked = false, spinning = false;
      if (hb && Math.abs(vl) > .5) locked = true;
      const useAbs = opts.abs && s.abs;
      if (Fbrake > 0 && Math.abs(vl) > .8) {
        const avail = Math.sqrt(Math.max(0, cap * cap - Fy * Fy * .25));
        if (Fbrake > avail * 1.02) {
          if (useAbs) { Fbrake = avail * (front ? .93 : .8); absAct = 1; Fy *= front ? .75 : .85 }
          else locked = true;
        }
      }
      // traction: wheelspin
      if (!locked && Fx > 0) {
        const avail = Math.sqrt(Math.max(0, cap * cap - Fy * Fy * .3));
        if (Fx > avail) {
          if (opts.tc && s.esc) { Fx = avail * .97; tcAct = 1; this.spin[k] = Math.max(0, this.spin[k] - dt * 4) }
          else { this.spin[k] = Math.min(2.5, this.spin[k] + dt * (Fx / Math.max(avail, 1) - 1) * 7) }
        } else this.spin[k] = Math.max(0, this.spin[k] - dt * 5);
      } else this.spin[k] = Math.max(0, this.spin[k] - dt * (this.limiter > 0 ? 2 : 6));
      spinning = this.spin[k] > .08;
      let fxW, fyW;
      if (locked) {
        const vm = Math.hypot(vl, vt) || 1, F = cap * .8;
        fxW = -F * vl / vm; fyW = -F * vt / vm; this.lock[k] = 1;
      } else if (spinning) {
        this.lock[k] = 0;
        // a wheel turning faster than the road pushes forward (or backward in reverse) with sliding friction
        const dirW = this.reverse ? -1 : 1;
        const sx = this.spin[k] * Math.max(Math.abs(vl), 3), vm = Math.hypot(sx, vt) || 1, F = cap * .86;
        fxW = F * sx / vm * dirW; fyW = -F * vt / vm;
      } else {
        this.lock[k] = 0;
        fxW = Fx - (dir ? dir * Fbrake : 0);
        fyW = Fy;
        const tot = Math.hypot(fxW, fyW);
        if (tot > cap) { const sc = cap / tot; fxW *= sc; fyW *= sc }
      }
      // rolling resistance
      fxW -= Math.sign(vl) * Fz[k] * (s.rr + dragK * .0) * Math.min(1, Math.abs(vl) * 2);
      // body frame
      const bf = fxW * cd - fyW * sd, bl = fxW * sd + fyW * cd;
      Ffwd += bf; Fleft += bl; M += pf[k] * bl - pl[k] * bf;
      this.slipL[k] = locked ? 1 : spinning ? this.spin[k] : 0;
      const slide = Math.max(Math.abs(alpha) / (s.peak * 1.4), locked ? 1 : 0, spinning ? Math.min(1, this.spin[k]) : 0);
      sq = Math.max(sq, (this.surf[k].id <= 3 && Fz[k] > 50) ? slide : 0);
      // wheel spin speed (visual/audio)
      const ws = locked ? 0 : vl * (1 + (spinning ? this.spin[k] : 0));
      this.wspd[k] = ws; this.wheelRot[k] += ws / s.R * dt;
    }
    this.absOn = absAct; this.tcOn = tcAct; this.squeal = sq;
    // ---- ESC (yaw control)
    this.escOn = Math.max(0, this.escOn - dt);
    if (opts.esc && s.esc && au > 8 && !this.air) {
      // intervene only on oversteer: rear sliding (body slip) or yawing faster than a neutral car would
      const rns = u * this.deltaDriver / s.L, rmax = s.mu * G / au * 1.05;
      const beta = Math.atan2(w, au), rr = this.r;
      const over = (Math.abs(rr) > Math.min(Math.abs(rns) * 1.2 + .06, rmax) && Math.sign(rr) === Math.sign(beta) * -1 * Math.sign(u)) || Math.abs(beta) > .11;
      if (over && Math.abs(beta) > .045) {
        const err = rr - clamp(rns, -rmax, rmax);
        const Mc = clamp(-err * s.Izz * 3.2, -2400 * s.m / 1300, 2400 * s.m / 1300);
        M += Mc; Ffwd -= Math.abs(Mc) / (s.tw / 2) * .35 * Math.sign(u); this.escOn = .2;
      }
    }
    // ---- aero drag, surface drag, slope
    const Vw = Math.hypot(u, w);
    if (Vw > .01) {
      const Fd = .5 * RHO * s.CdA * Vw * Vw + (this.air ? 0 : dragK * s.m * G * Math.min(1, Vw / 3));
      Ffwd -= Fd * u / Vw; Fleft -= Fd * w / Vw;
    }
    // to world
    let FX = Ffwd * fx + Fleft * lx, FZ = Ffwd * fz + Fleft * lz;
    if (!this.air) { const sl = -s.m * G * vxG / (1 + vxG * vxG); FX += sl * loc.fx; FZ += sl * loc.fz }
    const ax = FX / s.m, az = FZ / s.m;
    this.vx += ax * dt; this.vz += az * dt;
    this.r += M / s.Izz * dt;
    // low-speed stabilisation
    if (au < 1.2 && thr < .02) { const k = brk > .05 || inp.handbrake ? .9 : .993; this.vx *= k; this.vz *= k; this.r *= .95 }
    if (this.air) this.r *= .995;
    this.psi += this.r * dt;
    this.x += this.vx * dt; this.z += this.vz * dt;
    // filtered body accelerations for load transfer
    const ab = ax * fx + az * fz, al = ax * lx + az * lz;
    const kf = Math.min(1, dt / s.tau);
    this.axf += (clamp(ab, -25, 25) - this.axf) * kf; this.ayf += (clamp(al, -30, 30) - this.ayf) * kf;
    this.u = u; this.w = w;
    // ---- barriers (a city map handles its own walls, buildings and trees)
    this.impact = 0;
    if (track.collide) { track.collide(this); return }
    const l2 = track.locate(this.x, this.z, this.hint, this.loc2 || (this.loc2 = {}));
    const side = l2.d >= 0, bd = track.barrier(l2.i, side) - s.W / 2 - .15;
    if (Math.abs(l2.d) > bd) this.hitWall(l2.fz * (side ? 1 : -1), -l2.fx * (side ? 1 : -1), Math.abs(l2.d) - bd, l2.fx, l2.fz);
  }
  /* push the car out of a wall. (nx,nz): unit normal pointing from the car into the wall, pen: penetration (m), (tx,tz): wall direction */
  hitWall(nx, nz, pen, tx, tz) {
    this.x -= nx * pen; this.z -= nz * pen;
    const vn = this.vx * nx + this.vz * nz;
    if (vn > 0) {
      const e = .22;
      this.vx -= (1 + e) * vn * nx; this.vz -= (1 + e) * vn * nz;
      const fr2 = clamp(1 - vn * .035, .55, .985);
      this.vx *= fr2; this.vz *= fr2;
      this.r *= .55;
      // turn the car parallel to the wall a little
      const fx = -Math.sin(this.psi), fz = -Math.cos(this.psi);
      if (tx * fx + tz * fz < 0) { tx = -tx; tz = -tz }
      const head = Math.atan2(-tx, -tz);
      let dpsi = head - this.psi; dpsi = Math.atan2(Math.sin(dpsi), Math.cos(dpsi));
      if (Math.abs(dpsi) < Math.PI / 2) this.r += clamp(dpsi, -1, 1) * Math.min(vn, 10) * .25;
      this.impact = Math.max(this.impact, vn);
    } else {
      const fr2 = .995; this.vx *= fr2; this.vz *= fr2;
    }
  }
  beginShift(g) {
    const s = this.spec; if (g < 1 || g > s.ratios.length || g === this.gear || this.shiftT > 0) return;
    this.shiftTo = g; this.shiftT = s.gb.shift; this.lastShift = this.t;
    if (s.gb.shift === 0) { this.gear = g; this.shiftT = 0 }
  }
}

/* ---------- quick straight-line test for the designer (flat road) ---------- */
const FLAT = {
  locate(x, z, h, o = {}) { o.i = 0; o.t = 0; o.d = x; o.s = -z; o.h = 0; o.grade = 0; o.kv = 0; o.fx = 0; o.fz = -1; o.wl = 50; o.wr = 50; return o },
  surface() { return { mu: 1, drag: 0, bump: 0, id: 0 } }, barrier() { return 1e9 },
};
export function perfTest(spec) {
  const sim = new CarSim(spec), res = { t100: null, t200: null, vmax: 0, brake100: null, q400: null };
  const o = { auto: true, abs: true, esc: true, tc: true, assist: 0 };
  let t = 0;
  let thr = 1;
  for (; t < 70; t += DT) {
    const sp = Math.max(...sim.spin);
    thr = sp > .12 ? Math.max(.25, thr - DT * 3) : Math.min(1, thr + DT * 1.5);
    sim.step(DT, { throttle: thr, brake: 0, steer: 0 }, FLAT, o);
    const v = -sim.vz * 3.6;
    if (res.t100 == null && v >= 100) res.t100 = t;
    if (res.t200 == null && v >= 200) res.t200 = t;
    if (res.q400 == null && -sim.z >= 402) res.q400 = t;
    res.vmax = Math.max(res.vmax, v);
    if (t > 12 && v < res.vmax + .05 && t > 25 && Math.abs(sim.axf) < .02) break;
  }
  // braking from 100
  const b = new CarSim(spec); b.vz = -100 / 3.6; b.gear = Math.max(1, Math.min(spec.ratios.length, 3)); b.rpm = spec.curve.red * .5;
  const z0 = b.z;
  for (let k = 0; k < 4000; k++) { b.step(DT, { throttle: 0, brake: 1, steer: 0 }, FLAT, o); if (-b.vz < .3) break }
  res.brake100 = Math.abs(b.z - z0);
  // steady cornering grip estimate at 120 km/h (incl. downforce)
  const v = 120 / 3.6, df = .5 * RHO * spec.ClA * v * v;
  res.latG = spec.mu * .98 * (spec.m * G + df) / (spec.m * G);
  return res;
}
