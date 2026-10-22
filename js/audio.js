/* Car audio. Combustion engines use a physical model running in an AudioWorklet (engineworklet.js): every cylinder
   fires an exhaust pulse at its real crank angle in the firing order, into its own exhaust bank, through headers,
   tailpipes and a muffler. So a cross-plane V8 burbles, a flat-4 rumbles through its unequal headers, an inline-5
   warbles, a V12 screams and a rotary braps. Electric motors, turbo whistle, supercharger whine, tyres, wind and
   impacts are synthesised with ordinary Web Audio nodes. Without AudioWorklet support a simpler oscillator voice is used. */
import { LAYOUTS } from './parts.js';

let ctx = null, master = null, noiseBuf = null, workletP = null, workletOK = false;
export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = .7;
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -5; lim.knee.value = 4; lim.ratio.value = 10; lim.attack.value = .003; lim.release.value = .12;
    master.connect(lim).connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    loadWorklet();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => { });
  return ctx;
}
/* load the engine processor once; falls back to a blob copy when the module URL cannot be fetched */
function loadWorklet() {
  if (workletP || !ctx || !ctx.audioWorklet) return workletP;
  const url = new URL('./engineworklet.js', import.meta.url).href;
  workletP = ctx.audioWorklet.addModule(url)
    .catch(() => fetch(url).then(r => r.text()).then(t => ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([t], { type: 'text/javascript' })))))
    .then(() => { workletOK = true; return true }, () => false);
  return workletP;
}
export function engineReady() { return workletP || Promise.resolve(false) }

/* level trim per layout so a full-throttle pull lands at a similar loudness (bigger engines a little louder); measured offline */
const LOUD = { i3: .93, i4: .82, i5: 1.07, i6: 1.2, i8: 1.27, b4: .775, b6: 1.15, v6: 1.48, v8: 1.52, v10: 2.29, v12: 2.61, w8: 1.63, w12: 3.13, w16: 4.6, r2: .64, r3: .62, r4: .65, diesel: 1 };
/* Engine description for the worklet: firing order, exhaust banks, header and tailpipe lengths, muffler, character. */
export function engineConfig(eng, red, o = {}) {
  const L = LAYOUTS[eng.layout] || LAYOUTS.i4, rot = L.rot || 0, cyl = L.cyl || 4, fo = L.fo || [1, 3, 4, 2];
  const diesel = eng.fuel === 'diesel', turbo = (eng.turbos || 0) > 0, sc = !!eng.sc && eng.sc !== 'none';
  const vc = rot ? .65 : Math.PI / 4 * ((eng.bore || 80) / 10) ** 2 * ((eng.stroke || 80) / 10) / 1000;   // litres per cylinder
  const old = (eng.year || 2000) < 1975, sport = o.sport ?? (red >= 7600 && !diesel);
  // exhaust banks: V and W engines and the flat-6 have one per side; the flat-4 merges unequal-length headers
  let bankOf = () => 0, nb = 1; const delay = {};
  if (L.k === 'v' || L.k === 'w' || eng.layout === 'b6') { nb = 2; bankOf = c => c <= cyl / 2 ? 0 : 1 }
  if (eng.layout === 'b4') { nb = 2; bankOf = c => c === 1 || c === 3 ? 0 : 1; Object.assign(delay, { 1: 0, 3: .0004, 2: .0013, 4: .0017 }) }   // unequal-length headers: one pair runs further
  const n = fo.length, events = fo.map((c, k) => ({ ph: k / n, bank: bankOf(c), delay: delay[c] || 0, amp: 1, i: k }));
  const header = .0021 + .0013 * Math.min(vc, 1.2);
  const merged = eng.layout === 'b4';                     // both banks join one pipe
  const banks = Array.from({ length: nb }, (_, b) => ({ header: header * (b ? (merged ? 1.4 : 1.085) : 1), refl: (sport ? -.6 : -.5) * (merged && b ? .85 : 1), damp: merged && b ? .28 : .34, gl: nb > 1 && !merged ? (b ? 0 : 1) : 1, gr: nb > 1 && !merged ? (b ? 1 : 0) : 1 }));
  let muff = diesel ? 720 : rot ? 1550 : sport ? 1750 : old ? 1350 : 1150; if (turbo) muff *= .82;
  return {
    events, banks, split: nb > 1 && !merged, revs: rot ? 1 : 2, red,
    pulseDeg: diesel ? 62 : rot ? 135 : Math.min(100, Math.max(55, 70 + 34 * (vc - .5))), rise: rot ? .1 : .2,
    noise: diesel ? .22 : rot ? .62 : old ? .42 : .32, jit: rot ? .18 : old ? .13 : diesel ? .06 : .085,
    cylVar: eng.layout === 'v8' ? .06 : .045, idleAmp: diesel ? .34 : .2,
    pop: diesel ? 0 : rot ? 3.5 : sport ? 2.2 : turbo ? .8 : .35,
    knock: diesel ? 1.2 : 0, knockF: vc < .5 ? 3500 : 3000,
    intake: sc ? .035 : turbo ? .02 : .05, mech: .012, stereo: .55, turbo: turbo ? 1 : 0,
    header, pipeD: .0085, pipeG: -.32, pipeDamp: .22, muff, chamber: 105, cham: sport ? .22 : .38,
    gain: .62 / Math.sqrt(n) * (LOUD[eng.layout] || 1) * Math.pow(Math.min(vc, 1.4) / .5, .3) * (diesel ? LOUD.diesel : 1),
  };
}
export function setVolume(v) { if (master) master.gain.value = v }
/* short rev blip straight to the master bus, so the volume can be judged while the car's own sound is muted (pause menu) */
let lastBlip = 0;
export function previewTone() {
  const c = audioCtx(); if (!c || !master) return;
  const t = c.currentTime; if (t - lastBlip < .14) return; lastBlip = t;
  const o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
  o.type = 'sawtooth'; o.frequency.setValueAtTime(92, t); o.frequency.exponentialRampToValueAtTime(165, t + .12); o.frequency.exponentialRampToValueAtTime(120, t + .24);
  f.type = 'lowpass'; f.frequency.value = 1100; f.Q.value = 2;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.32, t + .02); g.gain.exponentialRampToValueAtTime(.001, t + .26);
  o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + .28);
}
export function audioReady() { return ctx && ctx.state === 'running' }

function noise(c) { const n = c.createBufferSource(); n.buffer = noiseBuf; n.loop = true; n.start(); return n }
function shaper(c, k) { const s = c.createWaveShaper(), n = 1024, curve = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / n * 2 - 1; curve[i] = (1 + k) * x / (1 + k * Math.abs(x)) } s.curve = curve; s.oversample = '2x'; return s }

export class CarAudio {
  constructor(spec) {
    const c = audioCtx(); this.ok = !!c; if (!c) return;
    this.spec = spec; const e = spec.eng, L = LAYOUTS[e.layout];
    this.ev = !!L.ev; this.rot = L.rot || 0; this.cyl = L.cyl || 4; this.diesel = e.fuel === 'diesel';
    this.out = c.createGain(); this.out.gain.value = 0; this.out.connect(master);
    this.eg = c.createGain(); this.eg.gain.value = 0; this.eg.connect(this.out);
    if (this.ev) this.oscVoice();
    else if (workletOK) this.modelVoice();
    else { this.oscVoice(); if (workletP) workletP.then(ok => { if (ok && !this.dead) this.modelVoice() }) }
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
  /* the physical engine model (combustion engines) */
  modelVoice() {
    const c = ctx, s = this.spec;
    try {
      this.node = new AudioWorkletNode(c, 'mw-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: engineConfig(s.eng, s.curve.red) });
    } catch (e) { this.node = null; return }
    const P = this.node.parameters; this.pRpm = P.get('rpm'); this.pLoad = P.get('load'); this.pCut = P.get('cut'); this.pBoost = P.get('boost');
    this.pRpm.value = s.curve.idle || 850;
    if (this.osc) { const old = this.osc; this.osc = null; old.g.gain.setTargetAtTime(0, c.currentTime, .05); setTimeout(() => { for (const o of old.src) try { o.stop() } catch (e) { } old.g.disconnect() }, 400) }
    const g = c.createGain(); g.gain.value = 0; g.gain.setTargetAtTime(1, c.currentTime, .08); this.node.connect(g).connect(this.eg); this.ng = g;
  }
  /* oscillator voice: electric motors, and combustion engines when AudioWorklet is missing */
  oscVoice() {
    const c = ctx, e = this.spec.eng, ev = this.ev;
    this.fpr = ev ? 1 / 60 * 8 : this.rot ? this.rot / 60 : this.cyl / 2 / 60;
    const sub = { v8: .55, i3: .4, i5: .35, b4: .38, b6: .3, v6: .22, r2: .18, r3: .15, r4: .12, w8: .25 }[e.layout] ?? .08;
    const o1 = c.createOscillator(), o2 = c.createOscillator(), o3 = c.createOscillator();
    o1.type = ev ? 'sine' : this.rot ? 'square' : 'sawtooth'; o2.type = 'square'; o3.type = ev ? 'sine' : 'triangle';
    const g1 = c.createGain(), g2 = c.createGain(), g3 = c.createGain();
    g1.gain.value = ev ? .22 : .5; g2.gain.value = ev ? 0 : sub * .55; g3.gain.value = ev ? .12 : .22;
    const nz = noise(c), nf = c.createBiquadFilter(); nf.type = 'bandpass'; nf.Q.value = this.diesel ? 1.2 : 2.2; const ngn = c.createGain(); ngn.gain.value = 0;
    const mix = c.createGain(), dist = shaper(c, ev ? 0 : this.diesel ? 6 : 3.5), lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.4;
    const g = c.createGain(); g.gain.value = 1;
    o1.connect(g1).connect(mix); o2.connect(g2).connect(mix); o3.connect(g3).connect(mix); nz.connect(nf).connect(ngn).connect(mix);
    mix.connect(dist).connect(lp).connect(g).connect(this.eg);
    for (const o of [o1, o2, o3]) o.start();
    this.osc = { o1, o2, o3, nf, ng: ngn, lp, g, src: [o1, o2, o3, nz] };
  }
  update(sim, dt) {
    if (!this.ok || !ctx) return;
    const c = ctx, now = c.currentTime, s = this.spec, red = s.curve.red, rpm = Math.max(sim.rpm, this.ev ? 0 : 400), x = rpm / red;
    const thr = sim.throttleEff ?? 0, k = .025, set = (p, v, kk = k) => p.setTargetAtTime(v, now, kk);
    this.t += dt;
    if (this.node) {
      set(this.pRpm, rpm, .012); set(this.pLoad, Math.min(1, thr), .03); set(this.pBoost, sim.boost || 0, .05);
      this.pCut.setValueAtTime(sim.limiter > 0 ? 1 : 0, now);
      set(this.eg.gain, 1.85);
      if (sim.gear > this.prevGear && thr > .75 && x > .55 && Math.random() < .6) this.node.port.postMessage({ pop: 1 + (Math.random() < .4 ? 1 : 0) });   // ignition cut on a hard upshift
    } else if (this.osc) {
      const o = this.osc, f = Math.max(this.ev ? 40 : 18, rpm * this.fpr);
      set(o.o1.frequency, f); set(o.o2.frequency, f / 2); set(o.o3.frequency, f * 2);
      set(o.nf.frequency, Math.min(9000, f * 3)); set(o.ng.gain, (this.diesel ? .35 : .18) * (.25 + thr));
      set(o.lp.frequency, this.ev ? 2500 + x * 3000 : 380 + x * 2400 + thr * 2600);
      let vol = this.ev ? .05 + .25 * Math.min(1, sim.speed / 50) * (.3 + thr) : .16 + .22 * x + .42 * thr * (.4 + x);
      if (sim.limiter > 0) vol *= (Math.sin(this.t * 150) > 0 ? .35 : 1);
      set(this.eg.gain, Math.min(.9, vol));
    }
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
    if (!this.ok) return; this.dead = true;
    try {
      this.out.gain.setTargetAtTime(0, ctx.currentTime, .05);
      const all = [this.tn, this.tw, this.sw, ...(this.osc ? this.osc.src : [])].filter(Boolean), node = this.node;
      setTimeout(() => { for (const o of all) try { o.stop() } catch (e) { } if (node) { try { node.port.postMessage({ stop: true }); node.disconnect() } catch (e) { } } this.out.disconnect() }, 300);
    } catch (e) { }
  }
}

/* Hear an engine in the designer: idle, two blips, a full-throttle pull to the limiter, lift off, idle. Returns stop(). */
let demo = null;
export async function engineDemo(eng, red, idle = 850) {
  stopEngineDemo();
  const c = audioCtx(); if (!c) return null;
  const L = LAYOUTS[eng.layout] || {}, token = demo = { stop: null };
  if (L.ev) {                                          // electric: a motor whine sweep
    const o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain(), t = c.currentTime;
    o.type = 'sine'; o2.type = 'triangle'; o.connect(g); o2.connect(g); g.connect(master);
    o.frequency.setValueAtTime(60, t); o.frequency.exponentialRampToValueAtTime(1400, t + 3.2); o.frequency.exponentialRampToValueAtTime(200, t + 5);
    o2.frequency.setValueAtTime(180, t); o2.frequency.exponentialRampToValueAtTime(4200, t + 3.2); o2.frequency.exponentialRampToValueAtTime(600, t + 5);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.12, t + .3); g.gain.setValueAtTime(.12, t + 4.6); g.gain.linearRampToValueAtTime(0, t + 5.2);
    o.start(t); o2.start(t); o.stop(t + 5.3); o2.stop(t + 5.3);
    token.stop = () => { try { g.gain.setTargetAtTime(0, c.currentTime, .03); o.stop(c.currentTime + .2); o2.stop(c.currentTime + .2) } catch (e) { } };
    return token.stop;
  }
  if (!(await engineReady()) || demo !== token) return null;
  let node; try { node = new AudioWorkletNode(c, 'mw-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: engineConfig(eng, red) }) } catch (e) { return null }
  const g = c.createGain(); g.gain.value = 0; node.connect(g).connect(master);
  const P = node.parameters, rpm = P.get('rpm'), load = P.get('load'), cut = P.get('cut'), boost = P.get('boost'), t = c.currentTime + .05, tb = eng.turbos ? 1 : 0;
  // piecewise-linear automation: [time, value] knots
  const knots = (p, ks) => { p.setValueAtTime(ks[0][1], t + ks[0][0]); for (let i = 1; i < ks.length; i++) { const [at, v] = ks[i]; if (at === ks[i - 1][0]) p.setValueAtTime(v, t + at); else p.linearRampToValueAtTime(v, t + at) } };
  const hi = red * .55, i5 = idle * 1.05;
  knots(rpm, [[0, idle], [1.2, idle], [1.48, hi], [2.05, i5], [2.1, i5], [2.38, hi], [2.95, i5], [3.1, i5], [3.35, idle * 1.6], [6.6, red * 1.002], [6.9, red * 1.01], [7.2, red * .995], [9.2, idle * 1.4], [9.7, idle], [11, idle]]);
  knots(load, [[0, .04], [1.2, .04], [1.23, 1], [1.4, 1], [1.44, 0], [2.05, .04], [2.1, .04], [2.13, 1], [2.3, 1], [2.34, 0], [2.95, .04], [3.1, .04], [3.2, 1], [7.2, 1], [7.25, 0], [9.6, 0], [9.7, .04]]);
  knots(cut, [[0, 0], [6.6, 0], [6.6, 1], [7.2, 1], [7.2, 0]]);
  knots(boost, [[0, 0], [3.1, 0], [4.2, tb], [7.2, tb], [7.6, 0]]);
  knots(g.gain, [[0, 0], [.25, 1.85], [10.2, 1.85], [10.6, 0]]);
  const stop = () => { try { g.gain.cancelScheduledValues(c.currentTime); g.gain.setTargetAtTime(0, c.currentTime, .04); setTimeout(() => { try { node.port.postMessage({ stop: true }); node.disconnect(); g.disconnect() } catch (e) { } }, 250) } catch (e) { } };
  const timer = setTimeout(() => { if (demo === token) demo = null; stop() }, 10800);
  token.stop = () => { clearTimeout(timer); stop() };
  return token.stop;
}
export function stopEngineDemo() { if (demo && demo.stop) demo.stop(); demo = null }
export function engineDemoPlaying() { return !!demo }
