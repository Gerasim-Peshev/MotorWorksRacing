/* Engine voice (AudioWorklet). Every cylinder fires an exhaust pulse at its real crank angle in the firing order,
   into the exhaust bank it belongs to. Each bank has its own header (a damped pipe resonance); the banks feed the
   tailpipes, which go through a muffler (low-pass + resonant chamber). Cycle-to-cycle variation, per-cylinder
   differences, uneven bank spacing (cross-plane V8), unequal-length headers (flat-4), rotor ports, diesel knock,
   intake roar, overrun pops and the fuel cut on the rev limiter all come from that model rather than from samples.
   Parameters: rpm, load (0..1), cut (limiter), boost (bar). Options come from engineConfig() in audio.js. */
const TAU = Math.PI * 2;
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0 }
  set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; return this }
  lp(f, q, sr) { const w = TAU * Math.min(f, sr * .45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al) }
  hp(f, q, sr) { const w = TAU * Math.min(f, sr * .45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al) }
  bp(f, q, sr) { const w = TAU * Math.min(f, sr * .45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this.set(al, 0, -al, 1 + al, -2 * c, 1 - al) }
  run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y }
}
/* a pipe: delay line with a damped (low-passed) reflection, i.e. a feedback comb */
class Pipe {
  constructor(n) { this.buf = new Float32Array(n); this.n = n; this.i = 0; this.lp = 0 }
  run(x, D, g, damp) {
    let r = this.i - D; if (r < 0) { r += this.n; if (r >= this.n) r = 0 }
    const i0 = r | 0, fr = r - i0, a = this.buf[i0], b = this.buf[i0 + 1 === this.n ? 0 : i0 + 1];
    this.lp += (a + (b - a) * fr - this.lp) * damp;
    const y = x + g * this.lp; this.buf[this.i] = y; if (++this.i === this.n) this.i = 0; return y;
  }
}
const softclip = v => { if (v > 3) return 1; if (v < -3) return -1; const v2 = v * v; return v * (27 + v2) / (27 + 9 * v2) };

class EngineVoice extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 800, minValue: 0, maxValue: 30000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'boost', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ];
  }
  constructor(o) {
    super();
    const c = this.c = o.processorOptions, sr = this.sr = sampleRate;
    this.ev = c.events;                         // [{ ph: 0..1 of the cycle, bank, delay (s), amp, i }] sorted by ph
    this.banks = c.banks.map(b => ({ s1: 0, s2: 0, pend: [], pipe: new Pipe(Math.ceil(sr * .02) + 4), D: b.header * sr, g: b.refl, damp: b.damp, gl: b.gl, gr: b.gr }));
    this.stereo = c.banks.length > 1 && c.split !== false;
    this.tail = [0, 1].map(() => ({ pipe: new Pipe(Math.ceil(sr * .05) + 4), m1: new Biquad(), m2: new Biquad(), ch: new Biquad().bp(c.chamber, 1.3, sr), dc: new Biquad().hp(24, .7, sr) }));
    this.knockF = new Biquad().bp(c.knockF || 3200, 6, sr); this.knockIn = 0;
    this.knockF2 = new Biquad().bp((c.knockF || 3200) * 1.62, 8, sr);
    this.inF = new Biquad(); this.mechF = new Biquad().hp(2500, .7, sr);
    this.pos = 0; this.cyc = 0; this.next = 0; this.t = 0; this.rpm = 0; this.load = -1; this.fc = 0; this.env = 0;
    this.seed = 0x2545F491 ^ ((Math.random() * 0x7fffffff) | 0);
    this.cylVar = this.ev.map(() => 1 + (Math.random() * 2 - 1) * c.cylVar);
    const r = c.rise; this.pf = (Math.pow(r, r / (1 - r)) - Math.pow(r, 1 / (1 - r))) / (1 - r);
    this.popQ = 0; this.alive = true;
    this.port.onmessage = e => { const d = e.data || {}; if (d.pop) this.popQ += d.pop; if (d.stop) this.alive = false };
  }
  rnd() { let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x; return (x >>> 0) / 2147483648 - 1 }
  fire(e, load, cut, x) {
    const c = this.c;
    if (cut > .5 && this.rnd() > -.55) return;                                 // limiter: most firings cut
    const lf = c.idleAmp + (1 - c.idleAmp) * Math.pow(load, .75);            // cylinder pressure follows the throttle
    let a = e.amp * this.cylVar[e.i] * lf * (1 + this.rnd() * c.jit * (1.3 - x));
    if (load < .05 && x > .42 && this.rnd() > 1 - 2 * c.pop * x / this.fps) a += (1 + this.rnd() * .5) * e.amp;   // overrun pops (c.pop per second at the redline)
    this.banks[e.bank].pend.push(this.t + e.delay * this.sr, a);
    if (c.knock) this.knockIn += c.knock * (1 - .45 * load) * (.85 + .3 * this.rnd());
    this.env = 1;
  }
  process(_, outputs, P) {
    const out = outputs[0]; if (!out || !out[0]) return this.alive;
    const L = out[0], R = out[1], N = L.length, c = this.c, sr = this.sr;
    const rpm1 = P.rpm[0], load1 = P.load[0], cut = P.cut[0], boost = P.boost[0];
    const rpm0 = this.rpm || rpm1, load0 = this.load < 0 ? load1 : this.load; this.rpm = rpm1; this.load = load1;
    const x = Math.min(1.2, rpm1 / c.red);
    // muffler opens up with load and rpm; a turbine in the way softens it
    const fc = c.muff * (.72 + .38 * load1 + .3 * x) / (1 + .22 * Math.min(boost, 2) * c.turbo);
    if (Math.abs(fc - this.fc) > 4) { for (const p of this.tail) { p.m1.lp(fc, .7, sr); p.m2.lp(fc * 1.9, .6, sr) } this.fc = fc }
    this.inF.bp(220 + 900 * x + 500 * load1, 1.1, sr);
    // pulse width is a crank angle, so it shrinks as the revs rise
    const tau = Math.max(.00018, c.pulseDeg / (6 * Math.max(rpm1, 250)) / 2.6), a1 = Math.exp(-1 / (tau * sr)), a2 = Math.exp(-1 / (tau * c.rise * sr));
    const K = tau * sr / this.pf;
    const inc0 = rpm0 / 60 / c.revs / sr, inc1 = rpm1 / 60 / c.revs / sr; this.fps = Math.max(1, rpm1 / 60 / c.revs * this.ev.length);
    const nb = this.banks.length, ev = this.ev, gain = c.gain, inAmt = c.intake * (.35 + x) * (.25 + load1), mech = c.mech * (.3 + x), sp = c.stereo;
    for (let n = 0; n < N; n++) {
      const f = n / N, load = load0 + (load1 - load0) * f;
      this.pos += inc0 + (inc1 - inc0) * f;
      while (this.pos >= this.cyc + ev[this.next].ph) {
        this.fire(ev[this.next], load, cut, x);
        if (++this.next === ev.length) { this.next = 0; this.cyc++; if (this.cyc > 4096) { this.cyc -= 4096; this.pos -= 4096 } }
      }
      if (this.popQ > 0 && this.rnd() > .997) { this.banks[0].pend.push(this.t, 1.6 + this.rnd() * .6); this.popQ-- }
      let l = 0, r = 0;
      for (let k = 0; k < nb; k++) {
        const b = this.banks[k]; let xin = 0;
        if (b.pend.length) for (let j = 0; j < b.pend.length; j += 2) if (b.pend[j] <= this.t) { xin += b.pend[j + 1]; b.pend.splice(j, 2); j -= 2 }
        b.s1 = a2 * b.s1 + (1 - a2) * xin * K;
        b.s2 = a1 * b.s2 + (1 - a1) * b.s1;
        const gas = b.s2 * (1 + c.noise * this.rnd());                       // blow-down: pressure pulse plus gas-flow noise
        const h = b.pipe.run(gas, b.D, b.g, b.damp);                           // header resonance
        l += h * b.gl; r += h * b.gr;
      }
      this.env *= .9985;
      const w = this.rnd();
      const intake = this.inF.run(w) * inAmt * (.55 + .45 * this.env);
      let kn = 0; if (c.knock) { const ki = this.knockIn; this.knockIn = 0; kn = this.knockF.run(ki * (1 + .5 * this.rnd())) + .6 * this.knockF2.run(ki) }
      const mn = this.mechF.run(this.rnd()) * mech * (.6 + .4 * this.env);
      const common = intake + kn + mn;
      const T0 = this.tail[0];
      let yl = T0.pipe.run(l, c.pipeD * sr, c.pipeG, c.pipeDamp); yl = T0.m2.run(T0.m1.run(yl)); yl += c.cham * T0.ch.run(yl); yl = T0.dc.run(yl);
      if (this.stereo) {
        const T1 = this.tail[1];
        let yr = T1.pipe.run(r, c.pipeD * 1.04 * sr, c.pipeG, c.pipeDamp); yr = T1.m2.run(T1.m1.run(yr)); yr += c.cham * T1.ch.run(yr); yr = T1.dc.run(yr);
        const m = (yl + yr) * .7, d = (yl - yr) * .7 * sp;               // two tailpipes, left and right
        L[n] = softclip(gain * (m + d) + common); if (R) R[n] = softclip(gain * (m - d) + common);
      } else { const v = softclip(gain * yl + common); L[n] = v; if (R) R[n] = v }
      this.t++;
    }
    return this.alive;
  }
}
registerProcessor('mw-engine', EngineVoice);
