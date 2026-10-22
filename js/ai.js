/* Autopilot: follows the shipped minimum-curvature line with a friction-circle speed profile.
   Used for the "Self-driving L3" demo lap, ghost demos and automated physics tests. */
import { G, RHO } from './physics.js';

export class AutoPilot {
  constructor(track, spec, pace = .97) {
    this.track = track; this.spec = spec; this.stuckT = 0; this.recoverT = 0; this.lift = 0;
    const rl = track.racingLine();
    const n = track.n, ds = track.ds, v = new Float32Array(n);
    const mu = spec.mu * .93 * pace, c = .5 * RHO * spec.ClA / spec.m, dr = .5 * RHO * spec.CdA / spec.m;
    const gf = i => 1 + Math.max(-.4, Math.min(.12, track.kv[i] * 22));   // crests lighten the car, dips press it down
    const amax = (vv, i) => mu * (G * gf(i) + c * vv * vv);
    const K = new Float32Array(n);
    for (let i = 0; i < n; i++) { let k = 0; for (let j = -2; j <= 2; j++) k = Math.max(k, Math.abs(rl.k[track.wrap(i + j)])); K[i] = k }
    for (let i = 0; i < n; i++) {
      const den = K[i] - mu * c * gf(i);
      v[i] = den <= 0 ? 110 : Math.min(110, Math.sqrt(mu * G * gf(i) / den));
    }
    // braking: friction circle shared with cornering
    const bmax = spec.brakeF / spec.m * .92;
    for (let pass = 0; pass < 3; pass++)
      for (let q = n * 2 - 1; q >= 0; q--) {
        const i = q % n, j = (i + 1) % n, vj = v[j];
        const am = amax(vj, j), alat = vj * vj * K[j];
        const along = Math.min(bmax, Math.sqrt(Math.max(0, am * am - alat * alat)) * .95) + dr * vj * vj;
        const lim = Math.sqrt(vj * vj + 2 * along * ds);
        if (v[i] > lim) v[i] = lim;
      }
    this.v = v; this.rl = rl; this.K = K; this.mu = mu; this.c = c;
  }
  control(sim, dt = 1 / 240) {
    const t = this.track, s = this.spec, loc = sim.loc;
    const i = loc.i ?? 0, spd = sim.u;
    const sp = Math.sin(sim.psi), cp = Math.cos(sim.psi);
    if (this.recoverT > 0) {
      this.recoverT -= dt;
      const tgx = t.px[t.wrap(i + 15)] - sim.x, tgz = t.pz[t.wrap(i + 15)] - sim.z, left = tgx * -cp + tgz * sp;
      return { throttle: 0, brake: .8, steer: left > 0 ? 1 : -1, handbrake: false };
    }
    if (Math.abs(spd) < 1.5) { this.stuckT += dt; if (this.stuckT > 2.5) { this.stuckT = 0; this.recoverT = 1.8 } } else this.stuckT = 0;
    const au = Math.abs(spd);
    const Ld = Math.max(8, Math.min(46, 6 + .4 * au));
    const j = t.wrap(i + Math.round(Ld / t.ds));
    const dx = this.rl.x[j] - sim.x, dz = this.rl.z[j] - sim.z;
    const fwd = dx * -sp + dz * -cp, left = dx * -cp + dz * sp;
    const alpha = Math.atan2(left, Math.max(fwd, .1));
    // feed-forward on path curvature + pure pursuit
    let delta = Math.atan(2 * s.L * Math.sin(alpha) / Ld);
    // counter-steer: point the front wheels along the front axle's direction of travel
    if (au > 3) {
      const beta = Math.atan2(sim.w, au), wb = Math.max(0, Math.min(1, (Math.abs(beta) - .035) / .05));
      delta += wb * Math.max(-.5, Math.min(.5, Math.atan2(sim.w + sim.r * s.a, au)));
    }
    const steer = Math.max(-1, Math.min(1, -delta / s.lock));   // used with opts.rawSteer
    // distance off the line, toward the outside of the corner -> lift
    const err = loc.d - this.rl.off[i], k = this.rl.k[i];
    const wide = k > 0 ? -err : err;   // left turn: outside is right (negative d)
    this.lift = Math.max(0, Math.min(1, this.lift + dt * (wide > 1.2 ? 2.5 : -3)));
    const look = t.wrap(i + Math.round((au * .22 + 3) / t.ds));
    let vt = Math.min(this.v[look], this.v[i] + 3) * (1 - .12 * this.lift);
    let throttle = 0, brake = 0;
    if (spd > vt + .4) brake = Math.min(1, (spd - vt) * .35 + .25);
    else throttle = Math.max(0, Math.min(1, (vt - spd) * .6 + .3));
    // traction budget: lateral load leaves less for the throttle
    const alat = au * au * Math.abs(this.K[i]), am = this.mu * (G + this.c * au * au);
    const room = Math.sqrt(Math.max(0, 1 - Math.min(1, alat / am) ** 2));
    throttle = Math.min(throttle, .25 + room);
    const slip = Math.abs(Math.atan2(sim.w, Math.max(au, 1)));
    if (slip > .09) throttle *= .5;
    // a driver's feel for grip: threshold braking without ABS, and easing off when the driven wheels spin
    const locked = sim.lock.some(Boolean), spinning = Math.max(...sim.spin) > .12;
    this.bk = Math.max(.35, Math.min(1, (this.bk ?? 1) + dt * (locked ? -7 : 2.5)));
    this.tk = Math.max(.25, Math.min(1, (this.tk ?? 1) + dt * (spinning ? -5 : 2)));
    if (!s.abs) brake *= this.bk;
    throttle *= this.tk;
    return { throttle, brake, steer, handbrake: false };
  }
}
