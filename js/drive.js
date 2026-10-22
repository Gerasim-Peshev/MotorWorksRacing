/* A driving session on a track: rendering, cameras, HUD, timing, ghost, start lights, pause menu. */
import * as THREE from './vendor/three.module.min.js';
import { Track } from './track.js';
import { World } from './scene.js';
import { buildCar, disposeCar } from './carmodel.js';
import { buildSpec, CarSim, DT } from './physics.js';
import { AutoPilot } from './ai.js';
import { CarAudio, audioCtx, previewTone } from './audio.js';
import { tx, fmtTime } from './i18n.js';

let RENDERER = null;
function renderer(q) {
  if (!RENDERER) {
    RENDERER = new THREE.WebGLRenderer({ antialias: q !== 'low', powerPreference: 'high-performance' });
    RENDERER.toneMapping = THREE.ACESFilmicToneMapping; RENDERER.toneMappingExposure = 1.0; RENDERER.outputColorSpace = THREE.SRGBColorSpace;
    RENDERER.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  RENDERER.setPixelRatio(Math.min(devicePixelRatio || 1, q === 'high' ? 2 : q === 'medium' ? 1.5 : 1));
  RENDERER.shadowMap.enabled = q !== 'low';
  return RENDERER;
}
export function sharedRenderer() { return RENDERER }
export function getRenderer(q) { return renderer(q) }

const CAMS = ['chase', 'far', 'hood', 'bumper', 'tv'];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e };

export class DriveSession {
  constructor(app, o) {
    this.app = app; this.o = o; this.input = app.input; this.settings = app.settings();
    this.q = this.settings.quality === 'auto' ? app.autoQuality() : this.settings.quality;
    this.running = false; this.paused = false; this.disposed = false;
  }
  async start() {
    const o = this.o, root = this.root = el('div', 'drive'); document.body.append(root);
    const load = el('div', 'drive-load', `<div><small>${tx('Loading')}</small><h2>${o.trackMeta.name}</h2><p id="dl-msg">${tx('Fetching the circuit…')}</p></div>`); root.append(load);
    document.documentElement.classList.add('driving');
    const step = async m => { load.querySelector('#dl-msg').textContent = m; await new Promise(r => setTimeout(r, 30)) };
    try {
      const data = o.trackData || await (await fetch(`tracks/${o.trackMeta.id}.json`)).json();
      await step(tx('Shaping the road and terrain…'));
      this.track = new Track(data);
      this.world = new World(this.track, { quality: this.q });
      await step(tx('Building your car…'));
      this.setupScene();
      this.setupCar();
      this.setupGhost();
      this.buildHud();
      await step(tx('Ready'));
      // compile every shader now, behind the loading screen, instead of stuttering on the first frames
      try { if (this.ghost) this.ghost.model.group.visible = true; this.camera.position.set(this.track.px[0], this.track.py[0] + 5, this.track.pz[0]); this.renderer.compile(this.scene, this.camera); if (this.ghost) this.ghost.model.group.visible = false } catch (e) { }
    } catch (e) { console.error(e); load.querySelector('#dl-msg').textContent = tx('Could not load this circuit.') + ' ' + e.message; setTimeout(() => this.exit(), 2500); return }
    load.remove();
    this.resetToGrid();
    this.running = true; this.last = performance.now();
    this.onResize = () => this.resize(); addEventListener('resize', this.onResize); this.resize();
    this.onVis = () => { if (document.hidden && !this.paused) this.pause(true) }; document.addEventListener('visibilitychange', this.onVis);
    this.frame = this.frame.bind(this); requestAnimationFrame(this.frame);
    // browsers only start sound after a click/tap/key; tell gamepad-only players
    const ac = audioCtx();
    if (ac && ac.state !== 'running') {
      this.msg(tx('Press any key or tap the screen to turn the sound on'), 4);
      const wake = () => { ac.resume().catch(() => { }); removeEventListener('keydown', wake); removeEventListener('pointerdown', wake) };
      addEventListener('keydown', wake); addEventListener('pointerdown', wake);
    }
    if (matchMedia('(pointer:coarse)').matches) { try { await document.documentElement.requestFullscreen?.(); await screen.orientation?.lock?.('landscape') } catch (e) { } }
  }
  setupScene() {
    const r = this.renderer = renderer(this.q);
    this.root.prepend(r.domElement); r.domElement.className = 'drive-canvas';
    const scene = this.scene = new THREE.Scene();
    scene.add(this.world.group);
    const far = (this.q === 'high' ? 3200 : this.q === 'medium' ? 2300 : 1500) * (this.track.theme.fogScale || 1);
    scene.fog = new THREE.Fog(this.world.fogColor, 220, far);
    const pm = new THREE.PMREMGenerator(r); this.envTex = pm.fromScene(this.world.envScene(), .02).texture; scene.environment = this.envTex; pm.dispose();
    scene.add(new THREE.HemisphereLight(0xdfe9f2, 0x4b5a3c, 1.0));
    const sun = this.sun = new THREE.DirectionalLight(0xfff0dc, 2.7);
    sun.castShadow = this.q !== 'low'; sun.shadow.mapSize.set(this.q === 'high' ? 2048 : 1024, this.q === 'high' ? 2048 : 1024);
    Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 700 }); sun.shadow.bias = -.0004; sun.shadow.normalBias = .03;
    scene.add(sun, sun.target);
    this.camera = new THREE.PerspectiveCamera(64, 1, .1, far + 300);
    this.camPos = new THREE.Vector3(); this.camLook = new THREE.Vector3(); this.camMode = this.settings.camera || 'chase'; this.camInit = false;
    // TV camera spots
    this.tvSpots = []; const t = this.track, step = Math.round(260 / t.ds);
    for (let i = 0; i < t.n; i += step) { const left = (i / step) % 2 === 0, B = (left ? t.bl[i] : t.br[i]) + 4, sg = left ? 1 : -1; this.tvSpots.push({ i, p: new THREE.Vector3(t.px[i] + t.tz[i] * B * sg, t.py[i] + 5 + (i % 3) * 2, t.pz[i] - t.tx[i] * B * sg) }) }
  }
  setupCar() {
    const o = this.o;
    this.spec = buildSpec(o.car, o.engine);
    this.sim = new CarSim(this.spec);
    this.model = buildCar(o.car, { number: o.number || 7 });
    this.model.group.traverse(m => { if (m.isMesh) m.castShadow = true });
    this.scene.add(this.model.group);
    this.ap = null; this.autopilot = o.mode === 'autopilot';
    this.canAuto = (o.car.equip || []).includes('selfdrive') || o.mode === 'autopilot';
    this.opts = {
      auto: this.settings.gearbox === 'manual' ? false : this.settings.gearbox === 'auto' ? true : this.spec.gb.type !== 'manual',
      abs: this.spec.abs, esc: this.spec.esc, tc: this.spec.esc, assist: this.settings.assist ?? .8, steerSpeed: this.settings.steerSpeed || 19,
    };
    try { this.audio = new CarAudio(this.spec) } catch (e) { this.audio = null }
  }
  setupGhost() {
    const g = this.app.store.ghost(this.track.id);
    this.ghost = null;
    if (g && g.frames && g.frames.length > 10) {
      const m = buildCar(g.car, {});
      // one translucent material for the whole ghost: a single shader, no stutter when it appears
      const gm = new THREE.MeshStandardMaterial({ color: new THREE.Color(g.car.color || '#ffffff'), roughness: .4, metalness: .2, transparent: true, opacity: .34, depthWrite: false });
      m.group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.material = gm } });
      this.scene.add(m.group); m.group.visible = false;
      this.ghost = { ...g, model: m };
      this.refLap = g;    // time-at-distance reference for the delta
    }
    this.rec = [];
  }
  resetToGrid() {
    const t = this.track, i = t.wrap(Math.round(-12 / t.ds)), d = 2.6;
    this.sim.reset({ x: t.px[i] + t.tz[i] * d, z: t.pz[i] - t.tx[i] * d, y: t.py[i], psi: Math.atan2(-t.tx[i], -t.tz[i]), hint: i });
    t.locate(this.sim.x, this.sim.z, i, this.sim.loc); this.visPitch = this.visRoll = NaN;
    this.state = 'grid'; this.clock = 0; this.lights = 0; this.lightsT = 0; this.lightsOutAt = 2.2 + 5 + Math.random() * 1.2;
    this.lap = 0; this.lapStart = null; this.lapValid = true; this.sector = 0; this.sectors = []; this.lastLap = null; this.sessionBest = null;
    this.offT = 0; this.lastS = null; this.wrongT = 0; this.startPos = [this.sim.x, this.sim.z]; this.rec = []; this.lapsDone = []; this.msg('');
    for (const m of this.world.startLights) m.emissiveIntensity = 0;
    if (this.autopilot) this.ap = new AutoPilot(this.track, this.spec);
  }
  resetToTrack() {
    const t = this.track, loc = this.sim.loc, i = loc.i ?? 0, rl = t.racingLine(), d = Math.max(-t.wr[i] + 1.5, Math.min(t.wl[i] - 1.5, rl.off[i]));
    this.sim.reset({ x: t.px[i] + t.tz[i] * d, z: t.pz[i] - t.tx[i] * d, y: t.py[i], psi: Math.atan2(-t.tx[i], -t.tz[i]), hint: i });
    t.locate(this.sim.x, this.sim.z, i, this.sim.loc); this.visPitch = this.visRoll = NaN;
    if (this.state === 'running') { this.lapValid = false; this.msg(tx('Car reset · lap invalid'), 2) }
    this.camInit = false;
  }
  /* ---------------- HUD ---------------- */
  buildHud() {
    const h = this.hud = el('div', 'hud');
    const units = this.settings.units === 'mph' ? 'mph' : 'km/h';
    h.innerHTML = `
      <div class="hud-tl"><div class="hud-lap"><span id="h-lapn">${tx('Lap')} –</span><b id="h-time">0:00.000</b></div>
        <div class="hud-row"><small>${tx('Last')}</small><span id="h-last">–</span></div>
        <div class="hud-row"><small>${tx('Best')}</small><span id="h-best">–</span></div>
        <div class="hud-delta" id="h-delta"></div><div class="hud-sec" id="h-sec"></div></div>
      <div class="hud-tr"><canvas id="h-map" width="220" height="220"></canvas><div class="hud-trk">${this.track.data.short}</div></div>
      <div class="hud-br"><div class="hud-gear" id="h-gear">N</div><div class="hud-spd"><b id="h-spd">0</b><small>${units}</small></div>
        <div class="hud-rpm"><i id="h-rpm"></i><s style="left:${(this.spec.curve.ev ? 100 : 94)}%"></s></div>
        ${this.spec.boost ? `<div class="hud-boost"><small>${tx('Boost')}</small><div><i id="h-boost"></i></div></div>` : ''}
        <div class="hud-aids"><span id="h-abs">ABS</span><span id="h-tc">ESC</span><span id="h-auto">AUTO</span></div></div>
      <div class="hud-bl"><div class="hud-in"><span>${tx('Steer')}</span><div class="bar c"><i id="h-st"></i></div></div>
        <div class="hud-in"><span>${tx('Throttle')}</span><div class="bar"><i id="h-thr" class="g"></i></div></div>
        <div class="hud-in"><span>${tx('Brake')}</span><div class="bar"><i id="h-brk" class="r"></i></div></div><small id="h-dev"></small></div>
      <div class="hud-msg" id="h-msg"></div>
      <div class="hud-lights" id="h-lights">${'<i></i>'.repeat(5)}</div>
      <button class="hud-pause" id="h-pause" aria-label="${tx('Pause')}">❚❚</button>`;
    this.root.append(h);
    h.querySelector('#h-pause').onclick = () => this.pause(true);
    this.$ = id => h.querySelector('#' + id);
    this.drawMapBase();
    if (matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window) this.buildTouch();
    this.hudT = 0;
  }
  drawMapBase() {
    const t = this.track, c = this.$('h-map'), g = c.getContext('2d');
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (let i = 0; i < t.n; i += 4) { x0 = Math.min(x0, t.px[i]); x1 = Math.max(x1, t.px[i]); z0 = Math.min(z0, t.pz[i]); z1 = Math.max(z1, t.pz[i]) }
    const s = 196 / Math.max(x1 - x0, z1 - z0), ox = 110 - (x0 + x1) / 2 * s, oz = 110 - (z0 + z1) / 2 * s;
    this.mapT = (x, z) => [ox + x * s, oz + z * s];
    const base = document.createElement('canvas'); base.width = base.height = 220; const b = base.getContext('2d');
    b.lineJoin = 'round'; b.lineCap = 'round';
    for (const [w, col] of [[7, 'rgba(0,0,0,.55)'], [3.5, 'rgba(255,255,255,.9)']]) { b.strokeStyle = col; b.lineWidth = w; b.beginPath(); for (let i = 0; i <= t.n; i += 3) { const [x, y] = this.mapT(t.px[t.wrap(i)], t.pz[t.wrap(i)]); i ? b.lineTo(x, y) : b.moveTo(x, y) } b.stroke() }
    const [sx, sy] = this.mapT(t.px[0], t.pz[0]); b.fillStyle = '#f2b705'; b.fillRect(sx - 4, sy - 4, 8, 8);
    this.mapBase = base; this.mapCtx = g;
  }
  drawMap() {
    const g = this.mapCtx; g.clearRect(0, 0, 220, 220); g.drawImage(this.mapBase, 0, 0);
    if (this.ghost && this.ghost.model.group.visible) { const p = this.ghost.model.group.position, [x, y] = this.mapT(p.x, p.z); g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.arc(x, y, 4.5, 0, 7); g.fill() }
    const [x, y] = this.mapT(this.sim.x, this.sim.z); g.fillStyle = this.o.car.color; g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); g.stroke();
  }
  buildTouch() {
    const T = this.input.touch; T.active = true;
    const pad = el('div', 'touch', `<div class="t-steer" id="t-steer"><i></i><span>◀ ▶</span></div>
      <div class="t-gear"><button id="t-up">+</button><button id="t-dn">−</button></div>
      <div class="t-pedals"><div class="t-brk" id="t-brk">${tx('Brake')}</div><div class="t-thr" id="t-thr">${tx('Gas')}</div></div>`);
    this.root.append(pad);
    const steerEl = pad.querySelector('#t-steer'); let sid = null, sx0 = 0;
    steerEl.addEventListener('touchstart', e => { const t = e.changedTouches[0]; sid = t.identifier; sx0 = t.clientX; e.preventDefault() }, { passive: false });
    steerEl.addEventListener('touchmove', e => { for (const t of e.changedTouches) if (t.identifier === sid) { T.steer = Math.max(-1, Math.min(1, (t.clientX - sx0) / 80)); steerEl.firstElementChild.style.transform = `translateX(${T.steer * 60}px)` } e.preventDefault() }, { passive: false });
    const endS = e => { for (const t of e.changedTouches) if (t.identifier === sid) { sid = null; T.steer = 0; steerEl.firstElementChild.style.transform = '' } };
    steerEl.addEventListener('touchend', endS); steerEl.addEventListener('touchcancel', endS);
    const pedal = (id, key) => { const p = pad.querySelector(id); const upd = t => { const r = p.getBoundingClientRect(); T[key] = Math.max(.25, Math.min(1, 1 - (t.clientY - r.top) / r.height + .25)) };
      p.addEventListener('touchstart', e => { upd(e.changedTouches[0]); p.classList.add('on'); e.preventDefault() }, { passive: false });
      p.addEventListener('touchmove', e => { upd(e.changedTouches[0]); e.preventDefault() }, { passive: false });
      const end = () => { T[key] = 0; p.classList.remove('on') }; p.addEventListener('touchend', end); p.addEventListener('touchcancel', end) };
    pedal('#t-thr', 'throttle'); pedal('#t-brk', 'brake');
    pad.querySelector('#t-up').addEventListener('touchstart', e => { this.touchShift = 1; e.preventDefault() }, { passive: false });
    pad.querySelector('#t-dn').addEventListener('touchstart', e => { this.touchShift = -1; e.preventDefault() }, { passive: false });
  }
  msg(text, secs = 0) { const m = this.$ && this.$('h-msg'); if (!m) return; m.textContent = text; m.classList.toggle('on', !!text); clearTimeout(this.msgT); if (secs) this.msgT = setTimeout(() => { m.textContent = ''; m.classList.remove('on') }, secs * 1000) }
  speedText(v) { return Math.round(this.settings.units === 'mph' ? v * 2.23694 : v * 3.6) }
  updateHud() {
    const s = this.sim, $ = this.$, inp = this.lastInput || {};
    $('h-spd').textContent = this.speedText(s.speed);
    $('h-gear').textContent = s.reverse ? 'R' : this.spec.cvt || this.spec.curve.ev ? (s.speed < .5 && !inp.throttle ? 'N' : 'D') : s.shiftT > 0 ? '·' : s.gear;
    const red = this.spec.curve.red, x = Math.min(1, s.rpm / red);
    const rp = $('h-rpm'); rp.style.width = (x * 100).toFixed(1) + '%'; rp.className = x > .93 ? 'hot' : x > .86 ? 'warm' : '';
    if (this.spec.boost) $('h-boost').style.width = (s.boost * 100).toFixed(0) + '%';
    $('h-abs').className = !this.spec.abs ? 'na' : s.absOn ? 'on' : this.opts.abs ? '' : 'off';
    $('h-tc').className = !this.spec.esc ? 'na' : (s.escOn > 0 || s.tcOn) ? 'on' : this.opts.esc ? '' : 'off';
    $('h-auto').className = this.autopilot ? 'on' : this.opts.auto ? '' : 'off';
    $('h-auto').textContent = this.autopilot ? tx('AUTOPILOT') : this.opts.auto ? 'AUTO' : 'MAN';
    $('h-st').style.cssText = `left:${50 + Math.min(0, inp.steer || 0) * 50}%;width:${Math.abs(inp.steer || 0) * 50}%`;
    $('h-thr').style.width = ((inp.throttle || 0) * 100).toFixed(0) + '%'; $('h-brk').style.width = ((inp.brake || 0) * 100).toFixed(0) + '%';
    const now = this.clock;
    $('h-lapn').textContent = this.lap ? `${tx('Lap')} ${this.lap}` : tx('Grid');
    const lt = this.lapStart != null ? now - this.lapStart : 0;
    const te = $('h-time'); te.textContent = fmtTime(lt); te.className = this.lapValid ? '' : 'bad';
    $('h-last').textContent = this.lastLap ? fmtTime(this.lastLap.t) + (this.lastLap.valid ? '' : ' ✕') : '–';
    const best = this.bestRef();
    $('h-best').textContent = best ? fmtTime(best) : '–';
    const dEl = $('h-delta');
    if (this.lapStart != null && this.refLap && this.refLap.tad && s.loc.s != null && this.lapValid && !s.reverse && this.wrongT === 0) {
      const k = Math.floor(this.curS / 10); const ref = this.refLap.tad[k];
      if (ref != null && this.curS > 30) { const d = lt - ref; dEl.textContent = (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2); dEl.className = 'hud-delta ' + (d <= 0 ? 'good' : 'bad') } else dEl.textContent = '';
    } else dEl.textContent = '';
    $('h-sec').innerHTML = this.sectors.map((v, k) => `<span class="${v.cls || ''}">S${k + 1} ${v.t.toFixed(2)}</span>`).join('');
    const pad = this.input.pad;
    $('h-dev').textContent = pad ? (this.input.kind === 'ps' ? 'PlayStation' : this.input.kind === 'xbox' ? 'Xbox' : tx('Controller')) + ' · ' + tx('analog triggers') : '';
    this.drawMap();
  }
  bestRef() { const r = this.app.store.record(this.track.id, this.o.car.id); const a = r ? r.t : null, b = this.sessionBest; return a && b ? Math.min(a, b) : a || b }
  /* ---------------- main loop ---------------- */
  frame(now) {
    if (this.disposed) return;
    requestAnimationFrame(this.frame);
    let dt = Math.max(0, Math.min(.05, (now - this.last) / 1000)); this.last = now;
    const inp = this.input.poll(dt), E = this.input.edges;
    if (E.pause) { this.pause(!this.paused); }
    if (this.paused) { this.app.nav.poll(dt); return }
    if (E.camera) { this.camMode = CAMS[(CAMS.indexOf(this.camMode) + 1) % CAMS.length]; this.camInit = false; this.msg(tx('Camera') + ': ' + tx(this.camMode), 1.2) }
    if (E.reset) this.resetToTrack();
    if (E.autopilot && this.canAuto) this.toggleAuto();
    if (E.hud) this.hud.classList.toggle('min');
    if (E.mute) { this.muted = !this.muted; this.audio?.mute(this.muted) }
    // inputs for the car
    let ci = { steer: inp.steer, throttle: inp.throttle, brake: inp.brake, handbrake: inp.handbrake, shiftUp: E.shiftUp || this.touchShift === 1, shiftDown: E.shiftDown || this.touchShift === -1 };
    this.touchShift = 0;
    const o = this.autopilot ? { ...this.opts, rawSteer: true, assist: 0 } : this.opts;
    this.clock += dt;
    // start sequence
    if (this.state === 'grid') {
      const lt = this.clock - 2.2, n = Math.max(0, Math.min(5, Math.floor(lt) + 1));
      if (lt >= 0 && n !== this.lights) { this.lights = n; this.world.startLights.forEach((m, k) => m.emissiveIntensity = k < n ? 3 : 0); this.$('h-lights').classList.add('on'); [...this.$('h-lights').children].forEach((c, k) => c.classList.toggle('on', k < n)) }
      if (this.clock >= this.lightsOutAt) {
        this.state = 'running'; this.lapStart = this.clock; this.lap = 1; this.world.startLights.forEach(m => m.emissiveIntensity = 0);
        this.$('h-lights').classList.remove('on'); [...this.$('h-lights').children].forEach(c => c.classList.remove('on')); this.msg(tx('Go!'), 1.2);
        if (Math.hypot(this.sim.x - this.startPos[0], this.sim.z - this.startPos[1]) > 1.2) { this.lapValid = false; this.msg(tx('Jump start · lap invalid'), 2.5) }
      } else if (this.clock < 2.2) this.msg(tx('Get ready'), 0);
      if (!this.autopilot) { ci.brake = Math.max(ci.brake, .0); ci.handbrake = true; this.sim.vx *= .9; this.sim.vz *= .9 }
      else ci = { throttle: 0, brake: 1, steer: 0 };
    } else if (this.autopilot && this.ap) { const a = this.ap.control(this.sim, DT); ci = { ...a, shiftUp: false, shiftDown: false } }
    this.lastInput = ci;
    // physics
    this.acc = (this.acc || 0) + dt; let steps = 0;
    while (this.acc >= DT && steps < 14) {
      this.sim.step(DT, ci, this.track, o); ci.shiftUp = ci.shiftDown = false; this.acc -= DT; steps++;
      if (this.state === 'running') this.timing(DT);
    }
    if (steps >= 14) this.acc = 0;
    this.feedback(dt);
    this.updateVisuals(dt);
    this.updateCamera(dt, E.lookBackHeld);
    this.audio?.update(this.sim, dt);
    this.hudT -= dt; if (this.hudT <= 0) { this.hudT = 1 / 20; this.updateHud() }
    this.renderer.render(this.scene, this.camera);
  }
  timing(dt) {
    const s = this.sim, L = this.track.length, cs = s.loc.s;
    this.curS = cs;
    const lt = this.clock - this.lapStart;
    // ghost recording (20 Hz)
    this.recT = (this.recT || 0) + dt;
    if (this.recT >= .05) { this.recT = 0; this.rec.push(lt, s.x, s.y, s.z, s.psi); const k = Math.floor(cs / 10); if (!this.tad) this.tad = []; if (this.tad[k] == null && cs < L - 5) this.tad[k] = lt }
    // track limits: all four wheels beyond the white line + kerb
    const off = s.surf.every(f => f && f.id >= 3);
    if (off) { this.offT += dt; if (this.offT > .25 && this.lapValid) { this.lapValid = false; this.msg(tx('Track limits · lap invalid'), 2) } } else this.offT = 0;
    // wrong way
    const fwdDot = (-Math.sin(s.psi)) * s.loc.fx + (-Math.cos(s.psi)) * s.loc.fz;
    if (fwdDot < -.3 && s.speed > 3) { this.wrongT += dt; if (this.wrongT > 1.5) this.msg(tx('Wrong way'), .5) } else this.wrongT = 0;
    // sectors
    const sec = Math.floor(cs / (L / 3));
    if (this.lastS != null) {
      if (sec === this.sector + 1 && sec <= 2) {
        const t0 = this.sectors.reduce((a, v) => a + v.t, 0), st = lt - t0;
        const rb = this.app.store.record(this.track.id, this.o.car.id), ref = rb && rb.sec ? rb.sec[this.sector] : null;
        this.sectors.push({ t: st, cls: ref == null ? '' : st < ref ? 'good' : 'bad' }); this.sector = sec;
      }
      // finish line
      if (this.lastS > L * .8 && cs < L * .2) {
        if (this.sector >= 2) this.finishLap(lt);
        else { this.lapStart = this.clock; this.sector = 0; this.sectors = []; this.lapValid = true; this.rec = []; this.tad = [] }
      }
    }
    this.lastS = cs;
  }
  finishLap(lt) {
    const t0 = this.sectors.reduce((a, v) => a + v.t, 0); this.sectors.push({ t: lt - t0 });
    const valid = this.lapValid, sec = this.sectors.map(v => v.t);
    this.lastLap = { t: lt, valid }; this.lapsDone.push(this.lastLap);
    let note = '';
    if (valid) {
      if (!this.sessionBest || lt < this.sessionBest) this.sessionBest = lt;
      const saved = this.app.store.saveLap(this.track.id, this.o.car, lt, sec, this.autopilot);
      if (saved === 'car') note = tx('Personal best!');
      const g = this.app.store.ghost(this.track.id);
      if (!this.autopilot && (!g || lt < g.t)) {
        this.app.store.saveGhost(this.track.id, { t: lt, car: { body: this.o.car.body, color: this.o.car.color }, name: this.o.car.mname + ' ' + (this.o.car.trim || ''), frames: this.rec, tad: this.tad });
        note = tx('Track record! New ghost saved.');
        this.refLap = { tad: this.tad };
      }
    }
    this.msg(`${tx('Lap')} ${this.lap}: ${fmtTime(lt)}${valid ? '' : ' · ' + tx('invalid')}${note ? ' · ' + note : ''}`, 4);
    this.lap++; this.lapStart = this.clock; this.lapValid = true; this.sector = 0; this.sectors = []; this.rec = []; this.tad = [];
  }
  feedback(dt) {
    const s = this.sim, I = this.input;
    this.fbT = (this.fbT || 0) - dt; if (this.fbT > 0) return; this.fbT = .1;
    let strong = 0, weak = 0;
    if (s.impact > 1) { strong = Math.min(1, s.impact / 10); weak = strong }
    strong = Math.max(strong, s.bump * Math.min(1, s.speed / 20) * .45); weak = Math.max(weak, s.bump * Math.min(1, s.speed / 20) * .3);
    weak = Math.max(weak, Math.min(1, s.squeal || 0) * .25);
    if (s.landing > 1.5) { strong = Math.max(strong, Math.min(1, s.landing / 6)); s.landing = 0 }
    if (s.limiter > 0) weak = Math.max(weak, .15);
    if (strong > .03 || weak > .03) I.rumble(strong, weak, 130);
    if (s.absOn || s.tcOn || s.escOn > 0) I.triggerRumble(s.absOn ? .55 : 0, s.tcOn || s.escOn > 0 ? .35 : 0, 90);
  }
  updateVisuals(dt) {
    const s = this.sim, g = this.model.group, t = this.track;
    const fx = -Math.sin(s.psi), fz = -Math.cos(s.psi);
    const fin = v => Number.isFinite(v) ? v : 0;
    const along = s.loc.fx != null ? fx * s.loc.fx + fz * s.loc.fz : 1;
    const grade = fin((s.loc.grade || 0) * along);
    let pitch = fin(Math.atan(grade) + Math.max(-.05, Math.min(.05, s.axf * .0055)));
    let roll = fin(Math.max(-.07, Math.min(.07, -s.ayf * .0065)));
    if (!Number.isFinite(this.visPitch)) this.visPitch = pitch;
    if (!Number.isFinite(this.visRoll)) this.visRoll = roll;
    this.visPitch += (pitch - this.visPitch) * Math.min(1, dt * 10);
    this.visRoll += (roll - this.visRoll) * Math.min(1, dt * 8);
    const bump = s.bump > .3 ? (Math.random() - .5) * .012 * s.bump * Math.min(1, s.speed / 15) : 0;
    g.position.set(s.x, s.y + bump, s.z); g.rotation.set(this.visPitch, s.psi, this.visRoll, 'YXZ');
    const W = this.model.wheelsByPos;
    for (let k = 0; k < 4; k++) for (const w of W[k]) { w.spin.rotation.x = -s.wheelRot[k]; if (w.front) w.steer.rotation.y = s.steer }
    this.model.lights.tail.emissiveIntensity = (this.lastInput?.brake || 0) > .05 && !s.reverse ? 2.6 : .35;
    // ghost
    if (this.ghost && this.state === 'running') {
      const f = this.ghost.frames, lt = this.clock - this.lapStart, n = f.length / 5;
      if (lt < f[(n - 1) * 5]) {
        let k = this.ghostK || 0; if (k >= n || f[k * 5] > lt) k = 0; while (k < n - 2 && f[(k + 1) * 5] < lt) k++; this.ghostK = k;
        const a = k * 5, b = (k + 1) * 5, u = Math.max(0, Math.min(1, (lt - f[a]) / ((f[b] - f[a]) || 1)));
        let dy = f[b + 4] - f[a + 4]; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        const gm = this.ghost.model.group; gm.visible = true;
        gm.position.set(f[a + 1] + (f[b + 1] - f[a + 1]) * u, f[a + 2] + (f[b + 2] - f[a + 2]) * u, f[a + 3] + (f[b + 3] - f[a + 3]) * u); gm.rotation.set(0, f[a + 4] + dy * u, 0);
        const dist = Math.hypot(gm.position.x - s.x, gm.position.z - s.z); gm.visible = dist > 3;
      } else this.ghost.model.group.visible = false;
    }
    // sun & sky follow
    this.sun.position.set(s.x, s.y, s.z).addScaledVector(this.world.sunDir, 350); this.sun.target.position.set(s.x, s.y, s.z); this.sun.target.updateMatrixWorld();
  }
  updateCamera(dt, lookBack) {
    const s = this.sim, cam = this.camera, d = this.model.dims, m = this.camMode;
    const fx = -Math.sin(s.psi), fz = -Math.cos(s.psi);
    const car = new THREE.Vector3(s.x, s.y, s.z);
    let fov = 62;
    if (m === 'chase' || m === 'far' || lookBack) {
      const far = m === 'far' ? 1.65 : 1;
      // follow a blend of heading and travel direction
      const vs = s.speed;
      let hx = fx, hz = fz;
      if (vs > 4 && !s.reverse) { const vx = s.vx / vs, vz = s.vz / vs; const bl = Math.min(.55, vs / 60); hx = fx * (1 - bl) + vx * bl; hz = fz * (1 - bl) + vz * bl; const l = Math.hypot(hx, hz); hx /= l; hz /= l }
      this.camDir = this.camDir || new THREE.Vector2(hx, hz);
      const k = 1 - Math.exp(-dt * 5.5); this.camDir.x += (hx - this.camDir.x) * k; this.camDir.y += (hz - this.camDir.y) * k; this.camDir.normalize();
      const sign = lookBack ? -1 : 1;
      const dist = (d.length * .9 + 3.2) * far, hgt = (d.height * .75 + 1.15) * (m === 'far' ? 1.5 : 1);
      const want = new THREE.Vector3(s.x - this.camDir.x * dist * sign, 0, s.z - this.camDir.y * dist * sign);
      want.y = Math.max(s.y + hgt, this.world.terrainAt ? s.y + hgt : 0);
      if (!this.camInit || lookBack !== this.lastLookBack) { this.camPos.copy(want); this.camInit = true }
      else { const kk = 1 - Math.exp(-dt * 9); this.camPos.lerp(want, kk) }
      this.lastLookBack = lookBack;
      cam.position.copy(this.camPos);
      this.camLook.set(s.x + this.camDir.x * 6 * sign, s.y + d.height * .55 + .3, s.z + this.camDir.y * 6 * sign);
      cam.lookAt(this.camLook);
      fov = 60 + Math.min(16, s.speed * .16);
    } else if (m === 'hood' || m === 'bumper') {
      const g = this.model.group; g.updateMatrixWorld();
      const p = m === 'hood' ? new THREE.Vector3(0, d.hoodY + .42, d.frontZ * .35) : new THREE.Vector3(0, .62, d.frontZ - .05);
      cam.position.copy(p.applyMatrix4(g.matrixWorld));
      const look = new THREE.Vector3(0, m === 'hood' ? d.hoodY + .2 : .55, d.frontZ - 30).applyMatrix4(g.matrixWorld);
      cam.lookAt(look); fov = 68 + Math.min(12, s.speed * .12);
    } else if (m === 'tv') {
      let best = null, bd = 1e9; for (const sp of this.tvSpots) { const dd = sp.p.distanceTo(car); if (dd < bd) { bd = dd; best = sp } }
      if (best !== this.tvCur) { this.tvCur = best }
      cam.position.copy(best.p); cam.lookAt(car.x, car.y + .8, car.z); fov = Math.max(12, Math.min(55, 2400 / Math.max(20, bd)));
    }
    // shake
    if (s.impact > 2) this.shake = Math.min(.5, s.impact * .03);
    if (this.shake > 0) { cam.position.x += (Math.random() - .5) * this.shake; cam.position.y += (Math.random() - .5) * this.shake; this.shake *= Math.pow(.02, dt) }
    if (Math.abs(cam.fov - fov) > .05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 4); cam.updateProjectionMatrix() }
    // keep the camera above the ground
    if (this.world.terrainAt && (m === 'chase' || m === 'far')) { const gh = this.world.ground(cam.position.x, cam.position.z).h + .6; if (cam.position.y < gh) cam.position.y = gh }
    this.world.sky.position.copy(cam.position);
  }
  resize() {
    const w = innerWidth, h = innerHeight; this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
  toggleAuto() {
    if (!this.canAuto) return;
    this.autopilot = !this.autopilot;
    if (this.autopilot) { this.ap = new AutoPilot(this.track, this.spec); this.lapValid = false; this.msg(tx('Autopilot engaged · laps not counted for records'), 2.5) }
    else this.msg(tx('Autopilot off'), 1.5);
  }
  /* ---------------- pause menu ---------------- */
  pauseBack() { this.pause(false) }
  pause(on) {
    if (on === this.paused) return;
    this.paused = on;
    this.audio?.mute(on || this.muted);
    if (!on) { this.pauseEl?.remove(); this.pauseEl = null; this.last = performance.now(); return }
    const p = this.pauseEl = el('div', 'pause');
    this.renderPause();
    this.root.append(p);
    setTimeout(() => p.querySelector('button')?.focus(), 30);
  }
  renderPause() {
    const p = this.pauseEl, o = this.opts, sp = this.spec;
    const best = this.bestRef();
    const tog = (k, label, avail, val) => `<button class="btn ${val ? 'primary' : ''}" data-p="${k}" ${avail ? '' : 'disabled'}>${label}: ${avail ? (val ? tx('On') : tx('Off')) : tx('Not fitted')}</button>`;
    const assistName = o.assist >= .7 ? tx('High') : o.assist > 0 ? tx('Low') : tx('Off'), vol = this.app.store.settings.volume;
    p.innerHTML = `<div class="pause-in"><small>${this.track.data.name}</small><h2>${tx('Paused')}</h2>
      <div class="dl"><div><small>${tx('Laps')}</small><b>${this.lapsDone.length}</b></div><div><small>${tx('Session best')}</small><b>${this.sessionBest ? fmtTime(this.sessionBest) : '–'}</b></div><div><small>${tx('Your record')}</small><b>${best ? fmtTime(best) : '–'}</b></div></div>
      <div class="pause-grid">
        <button class="btn primary" data-p="resume">${tx('Resume')}</button>
        <button class="btn" data-p="reset">${tx('Reset car to track')}</button>
        <button class="btn" data-p="restart">${tx('Restart from the grid')}</button>
        <button class="btn" data-p="cam">${tx('Camera')}: ${tx(this.camMode)}</button>
        <button class="btn" data-p="gear">${tx('Gearbox')}: ${o.auto ? tx('Automatic') : tx('Manual')}</button>
        <button class="btn" data-p="assist">${tx('Steering assist')}: ${assistName}</button>
        ${tog('abs', 'ABS', sp.abs, o.abs)}
        ${tog('esc', tx('Stability control'), sp.esc, o.esc)}
        ${this.canAuto ? `<button class="btn ${this.autopilot ? 'primary' : ''}" data-p="auto">${tx('Autopilot')}: ${this.autopilot ? tx('On') : tx('Off')}</button>` : ''}
        <div class="field pause-vol"><div class="spread"><label class="lbl" for="p-vol">${tx('Volume')}</label><b id="p-vol-v">${Math.round(vol * 100)}%</b></div><input type="range" id="p-vol" min="0" max="1" step=".05" value="${vol}"></div>
        <button class="btn ghost" data-p="exit">${tx('Back to the garage')}</button>
      </div>
      <p class="muted small">${this.input.pad ? tx('Controller: menu button pauses, view button resets the car, Y/△ changes camera, B/○ and X/□ shift gears, A/✕ handbrake.') : tx('Keyboard: arrows or WASD drive, E/Q shift, Space handbrake, C camera, R reset, Esc pause.')}</p></div>`;
    p.onclick = e => { const b = e.target.closest('[data-p]'); if (b) this.pauseAct(b.dataset.p) };
    p.oninput = e => { if (e.target.id !== 'p-vol') return; const v = +e.target.value; this.app.saveSetting('volume', v); p.querySelector('#p-vol-v').textContent = Math.round(v * 100) + '%'; previewTone() };
  }
  pauseAct(a) {
    const o = this.opts;
    if (a === 'resume') return this.pause(false);
    if (a === 'reset') { this.resetToTrack(); return this.pause(false) }
    if (a === 'restart') { this.resetToGrid(); this.camInit = false; return this.pause(false) }
    if (a === 'exit') return this.exit();
    if (a === 'cam') { this.camMode = CAMS[(CAMS.indexOf(this.camMode) + 1) % CAMS.length]; this.camInit = false; this.app.saveSetting('camera', this.camMode) }
    if (a === 'gear') { o.auto = !o.auto; this.app.saveSetting('gearbox', o.auto ? 'auto' : 'manual') }
    if (a === 'assist') { o.assist = o.assist >= .7 ? .4 : o.assist > 0 ? 0 : .8; this.app.saveSetting('assist', o.assist) }
    if (a === 'abs') o.abs = !o.abs;
    if (a === 'esc') { o.esc = !o.esc; o.tc = o.esc }
    if (a === 'auto') this.toggleAuto();
    const f = document.activeElement?.dataset?.p; this.renderPause(); if (f) this.pauseEl.querySelector(`[data-p="${f}"]`)?.focus();
  }
  exit() {
    if (this.disposed) return; this.disposed = true;
    removeEventListener('resize', this.onResize); document.removeEventListener('visibilitychange', this.onVis);
    this.audio?.dispose(); this.input.touch.active = false;
    try { this.scene?.traverse(o => { if (o.geometry) o.geometry.dispose(); const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const m of ms) { m.map?.dispose(); m.dispose() } }); this.envTex?.dispose() } catch (e) { }
    if (this.renderer) { this.renderer.renderLists.dispose(); this.renderer.domElement.remove() }
    this.root.remove(); document.documentElement.classList.remove('driving');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { });
    const laps = this.lapsDone.filter(l => l.valid);
    this.app.onDriveEnd({ track: this.track.id, car: this.o.car.id, best: this.sessionBest, laps: this.lapsDone.length, valid: laps.length });
  }
}
