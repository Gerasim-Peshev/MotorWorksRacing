/* Synthesised car audio: the engine's layout, cylinder count, fuel and induction shape the sound. */
import { LAYOUTS } from './parts.js';

let ctx = null, master = null, noiseBuf = null;
export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = .7; master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => { });
  return ctx;
}
export function setVolume(v) { if (master) master.gain.value = v }
export function audioReady() { return ctx && ctx.state === 'running' }

function noise(c) { const n = c.createBufferSource(); n.buffer = noiseBuf; n.loop = true; n.start(); return n }
function shaper(c, k) { const s = c.createWaveShaper(), n = 1024, curve = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / n * 2 - 1; curve[i] = (1 + k) * x / (1 + k * Math.abs(x)) } s.curve = curve; s.oversample = '2x'; return s }

export class CarAudio {
  constructor(spec) {
    const c = audioCtx(); this.ok = !!c; if (!c) return;
    this.spec = spec; const e = spec.eng, L = LAYOUTS[e.layout];
    this.ev = !!L.ev; this.rot = L.rot || 0; this.cyl = L.cyl || 4; this.diesel = e.fuel === 'diesel';
    // firing frequency per rpm (4-stroke: cyl/2 pulses per rev; rotary: one per rotor per rev)
    this.fpr = this.ev ? 1 / 60 * 8 : this.rot ? this.rot / 60 : this.cyl / 2 / 60;
    const sub = { v8: .55, i3: .4, i5: .35, b4: .38, b6: .3, v6: .22, r2: .18, r3: .15, r4: .12, w8: .25 }[e.layout] ?? .08;
    this.out = c.createGain(); this.out.gain.value = 0; this.out.connect(master);
    // engine voice
    this.o1 = c.createOscillator(); this.o1.type = this.ev ? 'sine' : this.rot ? 'square' : 'sawtooth';
    this.o2 = c.createOscillator(); this.o2.type = 'square';
    this.o3 = c.createOscillator(); this.o3.type = this.ev ? 'sine' : 'triangle';
    this.g1 = c.createGain(); this.g2 = c.createGain(); this.g3 = c.createGain();
    this.g1.gain.value = this.ev ? .22 : .5; this.g2.gain.value = this.ev ? 0 : sub * .55; this.g3.gain.value = this.ev ? .12 : .22;
    this.nz = noise(c); this.nf = c.createBiquadFilter(); this.nf.type = 'bandpass'; this.nf.Q.value = this.diesel ? 1.2 : 2.2; this.ng = c.createGain(); this.ng.gain.value = 0;
    this.mix = c.createGain();
    this.dist = shaper(c, this.ev ? 0 : this.diesel ? 6 : 3.5);
    this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.Q.value = 1.4;
    this.eg = c.createGain(); this.eg.gain.value = .0;
    this.o1.connect(this.g1).connect(this.mix); this.o2.connect(this.g2).connect(this.mix); this.o3.connect(this.g3).connect(this.mix);
    this.nz.connect(this.nf).connect(this.ng).connect(this.mix);
    this.mix.connect(this.dist).connect(this.lp).connect(this.eg).connect(this.out);
    for (const o of [this.o1, this.o2, this.o3]) o.start();
    // turbo whistle, supercharger whine
    if (spec.boost) { this.tw = c.createOscillator(); this.tw.type = 'sine'; this.twg = c.createGain(); this.twg.gain.value = 0; this.tw.connect(this.twg).connect(this.out); this.tw.start() }
    if (spec.sc) { this.sw = c.createOscillator(); this.sw.type = 'sawtooth'; this.swf = c.createBiquadFilter(); this.swf.type = 'lowpass'; this.swf.frequency.value = 3500; this.swg = c.createGain(); this.swg.gain.value = 0; this.sw.connect(this.swf).connect(this.swg).connect(this.out); this.sw.start() }
    // tyres, wind, rumble
    this.tn = noise(c); this.tf = c.createBiquadFilter(); this.tf.type = 'bandpass'; this.tf.frequency.value = 1050; this.tf.Q.value = 5; this.tg = c.createGain(); this.tg.gain.value = 0; this.tn.connect(this.tf).connect(this.tg).connect(this.out);
    this.wf = c.createBiquadFilter(); this.wf.type = 'lowpass'; this.wf.frequency.value = 700; this.wg = c.createGain(); this.wg.gain.value = 0; this.tn.connect(this.wf).connect(this.wg).connect(this.out);
    this.rf = c.createBiquadFilter(); this.rf.type = 'lowpass'; this.rf.frequency.value = 140; this.rg = c.createGain(); this.rg.gain.value = 0; this.tn.connect(this.rf).connect(this.rg).connect(this.out);
    this.prevThr = 0; this.prevGear = 1; this.t = 0;
    this.out.gain.setTargetAtTime(1, c.currentTime, .3);
  }
  update(sim, dt) {
    if (!this.ok || !ctx) return;
    const c = ctx, now = c.currentTime, s = this.spec, red = s.curve.red, rpm = Math.max(sim.rpm, this.ev ? 0 : 400), x = rpm / red;
    const thr = sim.throttleEff ?? 0, k = .025, set = (p, v, kk = k) => p.setTargetAtTime(v, now, kk);
    this.t += dt;
    const f = Math.max(this.ev ? 40 : 18, rpm * this.fpr);
    set(this.o1.frequency, f); set(this.o2.frequency, f / 2); set(this.o3.frequency, f * 2);
    set(this.nf.frequency, Math.min(9000, f * 3)); set(this.ng.gain, (this.diesel ? .35 : .18) * (.25 + thr));
    set(this.lp.frequency, this.ev ? 2500 + x * 3000 : 380 + x * 2400 + thr * 2600);
    let vol = this.ev ? .05 + .25 * Math.min(1, sim.speed / 50) * (.3 + thr) : .16 + .22 * x + .42 * thr * (.4 + x);
    if (sim.limiter > 0) vol *= (Math.sin(this.t * 150) > 0 ? .35 : 1);
    set(this.eg.gain, Math.min(.9, vol));
    if (this.tw) { const b = sim.boost || 0; set(this.tw.frequency, 2600 + 5200 * b * (.6 + .4 * x)); set(this.twg.gain, .045 * b * b); if (this.prevThr > .7 && thr < .2 && b > .4) this.blowOff(b) }
    if (this.sw) { set(this.sw.frequency, rpm / 60 * 16); set(this.swg.gain, .03 * x * (.3 + thr)) }
    const v = sim.speed;
    set(this.tg.gain, .32 * Math.min(1, sim.squeal || 0) * Math.min(1, v / 8));
    set(this.tf.frequency, 900 + 400 * Math.min(1, sim.squeal || 0));
    set(this.wg.gain, .2 * Math.min(1, (v / 80) ** 2));
    set(this.rg.gain, .5 * (sim.bump || 0) * Math.min(1, v / 15));
    if (sim.impact > 1.5) this.thump(Math.min(1, sim.impact / 12));
    if (sim.gear !== this.prevGear && !this.ev) { this.thump(.12); this.prevGear = sim.gear }
    this.prevThr = thr;
  }
  blowOff(b) {
    const c = ctx, n = c.createBufferSource(); n.buffer = noiseBuf; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200; f.Q.value = 1.5;
    const g = c.createGain(); g.gain.setValueAtTime(.22 * b, c.currentTime); g.gain.exponentialRampToValueAtTime(.001, c.currentTime + .45);
    n.connect(f).connect(g).connect(this.out); n.start(); n.stop(c.currentTime + .5);
  }
  thump(a) {
    const c = ctx, n = c.createBufferSource(); n.buffer = noiseBuf; const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 260;
    const g = c.createGain(); g.gain.setValueAtTime(.9 * a, c.currentTime); g.gain.exponentialRampToValueAtTime(.001, c.currentTime + .25);
    n.connect(f).connect(g).connect(this.out); n.start(); n.stop(c.currentTime + .3);
  }
  mute(m) { if (this.ok) this.out.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, .05) }
  dispose() {
    if (!this.ok) return;
    try { this.out.gain.setTargetAtTime(0, ctx.currentTime, .05); const all = [this.o1, this.o2, this.o3, this.nz, this.tn, this.tw, this.sw].filter(Boolean); setTimeout(() => { for (const o of all) try { o.stop() } catch (e) { } this.out.disconnect() }, 300) } catch (e) { }
  }
}
