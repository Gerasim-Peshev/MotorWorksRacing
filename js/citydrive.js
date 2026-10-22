/* Free roam in a city (Sofia): streamed map, minimap with navigation, point-to-point challenges with records. */
import * as THREE from './vendor/three.module.min.js';
import { DriveSession, getRenderer } from './drive.js';
import { loadCity } from './city.js';
import { CityWorld } from './cityworld.js';
import { DT } from './physics.js';
import { audioCtx } from './audio.js';
import { tx, fmtTime, LANG } from './i18n.js';
const lang = () => LANG;

const CCAMS = ['chase', 'far', 'hood', 'bumper'];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Bulgarian Cyrillic -> Latin (the official streamlined system) for street names in the English UI
const TL = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya' };
export function latin(s) { return s.replace(/[а-яА-Я]/g, ch => { const lo = ch.toLowerCase(), t = TL[lo] ?? lo; return ch === lo ? t : t.charAt(0).toUpperCase() + t.slice(1) }) }
export const challengeKey = (cityId, id) => `${cityId}:${id}`;

export class CitySession extends DriveSession {
  async start() {
    const o = this.o, root = this.root = el('div', 'drive'); document.body.append(root);
    const cn = o.cityName || o.cityId;
    const load = el('div', 'drive-load', `<div><small>${tx('Loading')}</small><h2>${esc(cn)}</h2><p id="dl-msg">${tx('Loading the map of {city}…', { city: cn })}</p></div>`); root.append(load);
    document.documentElement.classList.add('driving');
    const step = async m => { load.querySelector('#dl-msg').textContent = m; await new Promise(r => setTimeout(r, 20)) };
    this.lapsDone = []; this.sessionBest = null; this.state = 'free'; this.clock = 0;
    try {
      this.city = this.track = await loadCity(o.cityId || 'sofia');
      this.cityName = LANG === 'bg' ? (this.city.meta.nameBg || this.city.meta.name) : this.city.meta.name;
      this.city.regions.clear(); this.city.lastY = null;
      this.world = new CityWorld(this.city, { quality: this.q });
      this.setupScene(); this.setupCar(); this.ghost = null; this.rec = [];
      const ch = o.challenge && this.city.meta.challenges.find(c => c.id === o.challenge);
      const sp = ch ? this.startPoint(ch) : this.city.meta.spawn;
      await step(tx('Building the streets…'));
      await this.world.preload(sp.x, sp.z, 420, f => { load.querySelector('#dl-msg').textContent = tx('Building the streets…') + ' ' + Math.round(f * 100) + '%' });
      this.buildHud(); this.buildBeacons();
      this.placeAt(sp);
      await step(tx('Ready'));
      try { this.camera.position.set(sp.x, sp.y + 4, sp.z); this.renderer.compile(this.scene, this.camera) } catch (e) { }
      if (ch) this.beginChallenge(ch, true);
    } catch (e) { console.error(e); load.querySelector('#dl-msg').textContent = tx('Could not load this map.') + ' ' + e.message; setTimeout(() => this.exit(), 2500); return }
    load.remove();
    this.running = true; this.last = performance.now();
    this.onResize = () => this.resize(); addEventListener('resize', this.onResize); this.resize();
    this.onVis = () => { if (document.hidden && !this.paused) this.pause(true) }; document.addEventListener('visibilitychange', this.onVis);
    this.frame = this.frame.bind(this); requestAnimationFrame(this.frame);
    const ac = audioCtx();
    if (ac && ac.state !== 'running') {
      this.msg(tx('Press any key or tap the screen to turn the sound on'), 4);
      const wake = () => { ac.resume().catch(() => { }); removeEventListener('keydown', wake); removeEventListener('pointerdown', wake) };
      addEventListener('keydown', wake); addEventListener('pointerdown', wake);
    }
    if (!this.ch) this.msg(tx('Free roam · open the menu for challenges'), 4);
    if (matchMedia('(pointer:coarse)').matches) { try { await document.documentElement.requestFullscreen?.(); await screen.orientation?.lock?.('landscape') } catch (e) { } }
  }
  setupScene() {
    const r = this.renderer = getRenderer(this.q);
    this.root.prepend(r.domElement); r.domElement.className = 'drive-canvas';
    const scene = this.scene = new THREE.Scene();
    scene.add(this.world.group);
    scene.fog = new THREE.Fog(this.world.fogColor, 250, this.world.R_LOAD * 1.35);
    const pm = new THREE.PMREMGenerator(r); this.envTex = pm.fromScene(this.world.envScene(), .02).texture; scene.environment = this.envTex; pm.dispose();
    scene.add(new THREE.HemisphereLight(0xe2ebf3, 0x77705f, 1.05));
    const sun = this.sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
    sun.castShadow = this.q !== 'low'; sun.shadow.mapSize.set(this.q === 'high' ? 2048 : 1024, this.q === 'high' ? 2048 : 1024);
    Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 700 }); sun.shadow.bias = -.0004; sun.shadow.normalBias = .04;
    scene.add(sun, sun.target);
    this.camera = new THREE.PerspectiveCamera(64, 1, .15, 26000);
    this.camPos = new THREE.Vector3(); this.camLook = new THREE.Vector3();
    this.camMode = CCAMS.includes(this.settings.camera) ? this.settings.camera : 'chase'; this.camInit = false; this.tvSpots = [];
  }
  setupCar() { super.setupCar(); this.canAuto = false; this.autopilot = false; this.hasNav = (this.o.car.equip || []).includes('nav') }
  /* ---------- placing the car ---------- */
  placeAt(p, dirX, dirZ) {
    const dx = dirX ?? p.dx, dz = dirZ ?? p.dz;
    this.sim.reset({ x: p.x, z: p.z, y: p.y, psi: Math.atan2(-dx, -dz), hint: 0 });
    this.city.lastY = p.y; this.city.locate(p.x, p.z, 0, this.sim.loc, 0, 0, p.y); this.sim.y = this.sim.loc.h;
    this.visPitch = this.visRoll = NaN; this.camInit = false; this.camDir = null;
  }
  resetToTrack() {
    const s = this.sim, r = this.city.nearestRoad(s.x, s.z, 350) || this.city.meta.spawn;
    const fx = -Math.sin(s.psi), fz = -Math.cos(s.psi), sg = (r.dx * fx + r.dz * fz) >= 0 ? 1 : -1;
    this.placeAt(r, r.dx * sg, r.dz * sg); this.msg(tx('Car back on the road'), 1.5);
  }
  resetToGrid() { if (this.ch) this.beginChallenge(this.ch.def); else { const sp = this.city.meta.spawn; this.teleport(sp) } }
  async teleport(p, dx, dz) {
    this.loadingTP = true; this.msg(tx('Loading…'), 0);
    await this.world.preload(p.x, p.z, 380);
    this.placeAt(p, dx, dz); this.loadingTP = false; this.msg('');
  }
  /* ---------- challenges & destinations ---------- */
  startPoint(ch) {
    const L = this.city.meta.landmarks, A = L[ch.a].road, B = L[ch.b].road;
    const sg = (A.dx * (B.x - A.x) + A.dz * (B.z - A.z)) >= 0 ? 1 : -1;
    return { ...A, dx: A.dx * sg, dz: A.dz * sg };
  }
  async beginChallenge(def, placed) {
    const L = this.city.meta.landmarks, A = this.startPoint(def), B = L[def.b].road;
    this.ch = { def, A, B, state: 'loading', key: challengeKey(this.city.id, def.id) };
    if (!placed) await this.teleport(A);
    this.ch.state = 'countdown'; this.ch.go = this.clock + 3.2;
    this.setTarget({ x: B.x, z: B.z, y: B.y, name: this.lmName(def.b) });
    this.lapsDone = this.lapsDone || [];
  }
  leaveChallenge() { this.ch = null; this.setTarget(null); this.msg(tx('Challenge left · free roam'), 2) }
  lmName(key) { const l = this.city.meta.landmarks[key]; return l ? (lang() === 'bg' ? l.bg : l.en) : key }
  chName(c) { return lang() === 'bg' ? c.bg : c.en }
  setTarget(t) {
    this.target = t; this.route = null; this.routeT = 0;
    if (this.finishBeam) { this.finishBeam.visible = !!t; if (t) this.finishBeam.position.set(t.x, t.y + 70, t.z) }
  }
  updateRoute(dt) {
    if (!this.target || !this.hasNav) return;
    this.routeT -= dt;
    let off = false;
    if (this.route && this.routeT < 0) { // left the route?
      const s = this.sim; let dmin = 1e9; for (let k = 0; k < this.route.length; k += 2) dmin = Math.min(dmin, Math.hypot(this.route[k] - s.x, this.route[k + 1] - s.z)); off = dmin > 45;
    }
    if (!this.route || (this.routeT < 0 && off) || this.routeT < -12) { this.route = this.city.route(this.sim.x, this.sim.z, this.target.x, this.target.z); this.routeT = 2.5 }
  }
  buildBeacons() {
    const g = this.beacons = new THREE.Group(), mk = (col, r, h, op) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, depthWrite: false, fog: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); m.renderOrder = 5; return m };
    const L = this.city.meta.landmarks, seen = new Set();
    for (const c of this.city.meta.challenges) {
      if (seen.has(c.a)) continue; seen.add(c.a);
      const p = L[c.a].road, b = mk(0x3fd0ff, 3.2, 90, .22); b.position.set(p.x, p.y + 45, p.z); b.userData.start = c; g.add(b);
    }
    this.finishBeam = mk(0xffc21a, 5, 160, .38); this.finishBeam.visible = false; g.add(this.finishBeam);
    this.scene.add(g);
  }
  /* ---------- HUD ---------- */
  buildHud() {
    const h = this.hud = el('div', 'hud');
    const units = this.settings.units === 'mph' ? 'mph' : 'km/h';
    h.innerHTML = `
      <div class="hud-tl city"><div class="hud-street" id="h-street"></div><div id="h-ch"></div></div>
      <div class="hud-tr"><canvas id="h-map" width="220" height="220"></canvas><div class="hud-trk" id="h-area">${esc(this.cityName)}</div></div>
      <div class="hud-nav" id="h-nav"><i id="h-arrow">➤</i><span id="h-dist"></span></div>
      <div class="hud-br"><div class="hud-gear" id="h-gear">N</div><div class="hud-spd"><b id="h-spd">0</b><small>${units}</small></div>
        <div class="hud-rpm"><i id="h-rpm"></i><s style="left:${(this.spec.curve.ev ? 100 : 94)}%"></s></div>
        ${this.spec.boost ? `<div class="hud-boost"><small>${tx('Boost')}</small><div><i id="h-boost"></i></div></div>` : ''}
        <div class="hud-aids"><span id="h-abs">ABS</span><span id="h-tc">ESC</span><span id="h-auto">AUTO</span></div></div>
      <div class="hud-bl"><div class="hud-in"><span>${tx('Steer')}</span><div class="bar c"><i id="h-st"></i></div></div>
        <div class="hud-in"><span>${tx('Throttle')}</span><div class="bar"><i id="h-thr" class="g"></i></div></div>
        <div class="hud-in"><span>${tx('Brake')}</span><div class="bar"><i id="h-brk" class="r"></i></div></div><small id="h-dev"></small></div>
      <div class="hud-msg" id="h-msg"></div>
      <button class="hud-pause" id="h-pause" aria-label="${tx('Pause')}">❚❚</button>`;
    this.root.append(h);
    h.querySelector('#h-pause').onclick = () => this.pause(true);
    this.$ = id => h.querySelector('#' + id);
    this.mapCtx = this.$('h-map').getContext('2d');
    if (matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window) this.buildTouch();
    this.hudT = 0; this.mapT2 = 0;
  }
  updateHud() {
    const s = this.sim, $ = this.$, inp = this.lastInput || {};
    $('h-spd').textContent = this.speedText(s.speed);
    $('h-gear').textContent = s.reverse ? 'R' : this.spec.cvt || this.spec.curve.ev ? (s.speed < .5 && !inp.throttle ? 'N' : 'D') : s.shiftT > 0 ? '·' : s.gear;
    const red = this.spec.curve.red, x = Math.min(1, s.rpm / red);
    const rp = $('h-rpm'); rp.style.width = (x * 100).toFixed(1) + '%'; rp.className = x > .93 ? 'hot' : x > .86 ? 'warm' : '';
    if (this.spec.boost) $('h-boost').style.width = (s.boost * 100).toFixed(0) + '%';
    $('h-abs').className = !this.spec.abs ? 'na' : s.absOn ? 'on' : this.opts.abs ? '' : 'off';
    $('h-tc').className = !this.spec.esc ? 'na' : (s.escOn > 0 || s.tcOn) ? 'on' : this.opts.esc ? '' : 'off';
    $('h-auto').textContent = this.opts.auto ? 'AUTO' : 'MAN'; $('h-auto').className = this.opts.auto ? '' : 'off';
    $('h-st').style.cssText = `left:${50 + Math.min(0, inp.steer || 0) * 50}%;width:${Math.abs(inp.steer || 0) * 50}%`;
    $('h-thr').style.width = ((inp.throttle || 0) * 100).toFixed(0) + '%'; $('h-brk').style.width = ((inp.brake || 0) * 100).toFixed(0) + '%';
    const pad = this.input.pad; $('h-dev').textContent = pad ? (this.input.kind === 'ps' ? 'PlayStation' : this.input.kind === 'xbox' ? 'Xbox' : tx('Controller')) + ' · ' + tx('analog triggers') : '';
    // street
    let st = this.city.roadName(s.loc.name); if (st && lang() !== 'bg') st = latin(st);
    $('h-street').textContent = st || (s.loc.road ? '' : tx('Off road'));
    // challenge / destination panel
    const c = this.ch; let html = '';
    if (c) {
      const t = c.state === 'run' ? this.clock - c.t0 : c.state === 'done' ? c.result : 0;
      const recs = this.app.store.trackRecords(c.key), best = recs[0], mine = this.app.store.record(c.key, this.o.car.id);
      html = `<div class="hud-lap"><span>${esc(this.chName(c.def))}</span><b class="${c.state === 'done' ? 'good' : ''}">${fmtTime(t)}</b></div>
        <div class="hud-row"><small>${tx('To')}</small><span>${esc(this.lmName(c.def.b))}</span></div>
        <div class="hud-row"><small>${tx('Best')}</small><span>${best ? fmtTime(best.t) : '–'}</span></div>
        ${mine && best && mine.car !== best.car ? `<div class="hud-row"><small>${tx('This car')}</small><span>${fmtTime(mine.t)}</span></div>` : ''}`;
    } else if (this.target) html = `<div class="hud-row"><small>${tx('Drive to')}</small><span>${esc(this.target.name)}</span></div>`;
    else html = `<div class="hud-row"><small>${tx('Free roam')}</small><span>${esc(this.cityName)}</span></div>`;
    if (html !== this.lastChHtml) { $('h-ch').innerHTML = html; this.lastChHtml = html }
    // arrow and distance to the target
    const nav = $('h-nav');
    if (this.target) {
      const dx = this.target.x - s.x, dz = this.target.z - s.z, d = Math.hypot(dx, dz), ps = s.psi;
      const rx = dx * Math.cos(ps) - dz * Math.sin(ps), rz = dx * Math.sin(ps) + dz * Math.cos(ps);
      $('h-arrow').style.transform = `rotate(${Math.atan2(rx, -rz) - Math.PI / 2}rad)`;
      $('h-dist').textContent = d > 950 ? (d / 1000).toFixed(1) + ' ' + tx('km') : Math.round(d / 10) * 10 + ' ' + tx('m');
      nav.classList.add('on');
    } else nav.classList.remove('on');
    this.mapT2 -= .05; if (this.mapT2 <= 0) { this.mapT2 = .1; this.drawMap() }
  }
  /* heading-up minimap of the real street network */
  drawMap() {
    const g = this.mapCtx, s = this.sim, c = this.city, W = 220, R = 260 + Math.min(520, s.speed * 9), k = 104 / R;
    g.clearRect(0, 0, W, W); g.save(); g.beginPath(); g.arc(110, 110, 106, 0, 7); g.clip();
    g.fillStyle = 'rgba(16,22,19,.78)'; g.fillRect(0, 0, W, W);
    g.translate(110, 110); g.rotate(s.psi); g.scale(k, k); g.translate(-s.x, -s.z);
    g.lineCap = 'round'; g.lineJoin = 'round';
    const edges = c.edgesNear(s.x, s.z, R * 1.05), groups = [[], [], []];
    for (const e of edges) { const cl = c.eC[e]; groups[cl <= 2 || cl === 11 || cl === 12 ? 0 : cl <= 5 || cl >= 13 ? 1 : 2].push(e) }
    const style = [[5.5, '#f2b705'], [4, '#e9ecea'], [2.6, '#8a948e']];
    for (let gi = 2; gi >= 0; gi--) {
      g.strokeStyle = style[gi][1]; g.lineWidth = style[gi][0] / k * .55; g.beginPath();
      for (const e of groups[gi]) { const p0 = c.eP[e], n = c.eN[e]; g.moveTo(c.netPts[p0 * 2], c.netPts[p0 * 2 + 1]); for (let m = 1; m < n; m++) g.lineTo(c.netPts[(p0 + m) * 2], c.netPts[(p0 + m) * 2 + 1]) }
      g.stroke();
    }
    if (this.route && this.route.length > 2) { g.strokeStyle = '#3fd0ff'; g.lineWidth = 5 / k; g.beginPath(); g.moveTo(this.route[0], this.route[1]); for (let m = 2; m < this.route.length; m += 2) g.lineTo(this.route[m], this.route[m + 1]); g.stroke() }
    // challenge starts and the target
    for (const b of this.beacons?.children || []) if (b.userData.start && b.visible) { g.fillStyle = '#3fd0ff'; g.beginPath(); g.arc(b.position.x, b.position.z, 7 / k, 0, 7); g.fill() }
    if (this.target) { g.fillStyle = '#ffc21a'; g.strokeStyle = '#000'; g.lineWidth = 2 / k; g.beginPath(); g.arc(this.target.x, this.target.z, 8 / k, 0, 7); g.fill(); g.stroke() }
    g.restore();
    // edge arrow when the target is off the map
    if (this.target) {
      const dx = this.target.x - s.x, dz = this.target.z - s.z, d = Math.hypot(dx, dz);
      if (d > R) { const rx = dx * Math.cos(s.psi) - dz * Math.sin(s.psi), rz = dx * Math.sin(s.psi) + dz * Math.cos(s.psi), a = Math.atan2(rz, rx); g.fillStyle = '#ffc21a'; g.beginPath(); g.arc(110 + Math.cos(a) * 98, 110 + Math.sin(a) * 98, 6, 0, 7); g.fill() }
    }
    // the car
    g.fillStyle = this.o.car.color; g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.moveTo(110, 100); g.lineTo(118, 118); g.lineTo(110, 114); g.lineTo(102, 118); g.closePath(); g.fill(); g.stroke();
  }
  /* ---------- main loop ---------- */
  frame(now) {
    if (this.disposed) return;
    requestAnimationFrame(this.frame);
    let dt = Math.max(0, Math.min(.05, (now - this.last) / 1000)); this.last = now;
    const inp = this.input.poll(dt), E = this.input.edges;
    if (E.pause) this.pause(!this.paused);
    if (this.paused) { this.app.nav.poll(dt); return }
    if (E.camera) { this.camMode = CCAMS[(CCAMS.indexOf(this.camMode) + 1) % CCAMS.length]; this.camInit = false; this.msg(tx('Camera') + ': ' + tx(this.camMode), 1.2) }
    if (E.reset && !this.loadingTP) this.resetToTrack();
    if (E.hud) this.hud.classList.toggle('min');
    if (E.mute) { this.muted = !this.muted; this.audio?.mute(this.muted) }
    let ci = { steer: inp.steer, throttle: inp.throttle, brake: inp.brake, handbrake: inp.handbrake, shiftUp: E.shiftUp || this.touchShift === 1, shiftDown: E.shiftDown || this.touchShift === -1 };
    this.touchShift = 0; this.clock += dt;
    const c = this.ch;
    if (c && c.state === 'countdown') {
      const left = c.go - this.clock;
      if (left > 0) { const n = Math.ceil(left); if (n !== c.shown && n <= 3) { c.shown = n; this.msg(String(n), 0) } ci.handbrake = true; this.sim.vx *= .9; this.sim.vz *= .9 }
      else { c.state = 'run'; c.t0 = this.clock; this.msg(tx('Go!'), 1.2) }
    }
    this.lastInput = ci;
    // physics (paused while the tile under the car is still loading)
    const ready = !this.loadingTP && this.city.regionAt(this.sim.x, this.sim.z);
    if (ready) {
      this.acc = (this.acc || 0) + dt; let steps = 0;
      while (this.acc >= DT && steps < 14) { this.sim.step(DT, ci, this.city, this.opts); ci.shiftUp = ci.shiftDown = false; this.acc -= DT; steps++ }
      if (steps >= 14) this.acc = 0;
      if (this.sim.outside && !this.outMsg) { this.outMsg = 1; this.msg(tx('Edge of the map'), 1.5); setTimeout(() => this.outMsg = 0, 2000) }
    } else if (!this.loadingTP) this.msg(tx('Loading…'), .5);
    this.world.update(this.sim.x, this.sim.z, dt);
    // challenge finish / destination reached
    if (this.target) {
      const d = Math.hypot(this.target.x - this.sim.x, this.target.z - this.sim.z);
      if (c && c.state === 'run' && d < 30) this.finishChallenge();
      else if (!c && d < 30) { this.msg(tx('You have arrived: {name}', { name: this.target.name }), 3); this.setTarget(null) }
    }
    this.updateRoute(dt);
    // beacons pulse; start beacons hidden during a challenge
    const pulse = .7 + .3 * Math.sin(this.clock * 3);
    for (const b of this.beacons.children) { const d = Math.hypot(b.position.x - this.sim.x, b.position.z - this.sim.z), fade = Math.min(1, Math.max(0, (d - 25) / 60)); if (b.userData.start) b.visible = !c && fade > 0; b.material.opacity = (b === this.finishBeam ? .38 : .2) * pulse * fade }
    this.feedback(dt);
    this.updateVisuals(dt);
    this.updateCamera(dt, E.lookBackHeld);
    this.audio?.update(this.sim, dt);
    this.hudT -= dt; if (this.hudT <= 0) { this.hudT = 1 / 20; this.updateHud() }
    this.renderer.render(this.scene, this.camera);
  }
  finishChallenge() {
    const c = this.ch, t = this.clock - c.t0; c.state = 'done'; c.result = t;
    const st = this.app.store, prev = st.trackRecords(c.key)[0];
    const saved = st.saveLap(c.key, this.o.car, t, [], false);
    if (!this.sessionBest || t < this.sessionBest) this.sessionBest = t;
    this.lapsDone.push({ t, valid: true });
    const note = prev == null || t < prev.t ? tx('New record!') : saved === 'car' ? tx('Personal best!') : '';
    this.msg(`${this.chName(c.def)}: ${fmtTime(t)}${note ? ' · ' + note : ''}`, 5);
    this.setTarget(null);
    setTimeout(() => { if (this.ch === c) this.ch = null }, 6000);
  }
  /* ---------- pause menu ---------- */
  pauseBack() { if (this.pauseView && this.pauseView !== 'main') { this.pauseView = 'main'; this.renderPause(); setTimeout(() => this.pauseEl?.querySelector('button')?.focus(), 20) } else this.pause(false) }
  pause(on) { if (on) this.pauseView = 'main'; super.pause(on) }
  renderPause() {
    const p = this.pauseEl, o = this.opts, sp = this.spec, view = this.pauseView || 'main', vol = this.app.store.settings.volume, st = this.app.store;
    const tog = (k, label, avail, val) => `<button class="btn ${val ? 'primary' : ''}" data-p="${k}" ${avail ? '' : 'disabled'}>${label}: ${avail ? (val ? tx('On') : tx('Off')) : tx('Not fitted')}</button>`;
    let body;
    if (view === 'ch') {
      body = `<div class="pause-grid">${this.city.meta.challenges.map(c => { const r = st.trackRecords(challengeKey(this.city.id, c.id))[0]; return `<button class="btn ch-btn" data-p="ch:${c.id}"><b>${esc(this.chName(c))}</b><small>${esc(this.lmName(c.a))} → ${esc(this.lmName(c.b))} · ${c.km} ${tx('km')}${r ? ' · ' + fmtTime(r.t) : ''}</small></button>` }).join('')}
        <button class="btn ghost" data-p="back">${tx('Back')}</button></div>`;
    } else if (view === 'goto') {
      const L = this.city.meta.landmarks;
      body = `<p class="muted small">${this.hasNav ? tx('Your car has navigation: the route is shown on the map.') : tx('No navigation fitted: follow the arrow.')}</p><div class="pause-grid">${Object.keys(L).filter(k => !k.startsWith('rwy')).map(k => `<button class="btn" data-p="go:${k}">${esc(this.lmName(k))}</button>`).join('')}
        <button class="btn ghost" data-p="back">${tx('Back')}</button></div>`;
    } else {
      const assistName = o.assist >= .7 ? tx('High') : o.assist > 0 ? tx('Low') : tx('Off');
      body = `<div class="pause-grid">
        <button class="btn primary" data-p="resume">${tx('Resume')}</button>
        <button class="btn" data-p="reset">${tx('Reset car to road')}</button>
        ${this.ch ? `<button class="btn" data-p="restart">${tx('Restart challenge')}</button><button class="btn" data-p="leave">${tx('Leave challenge')}</button>` : ''}
        <button class="btn" data-p="view:ch">${tx('Challenges')} ▸</button>
        <button class="btn" data-p="view:goto">${tx('Drive to…')} ▸</button>
        ${this.target && !this.ch ? `<button class="btn" data-p="clear">${tx('Clear destination')}</button>` : ''}
        <button class="btn" data-p="cam">${tx('Camera')}: ${tx(this.camMode)}</button>
        <button class="btn" data-p="gear">${tx('Gearbox')}: ${o.auto ? tx('Automatic') : tx('Manual')}</button>
        <button class="btn" data-p="assist">${tx('Steering assist')}: ${assistName}</button>
        ${tog('abs', 'ABS', sp.abs, o.abs)}
        ${tog('esc', tx('Stability control'), sp.esc, o.esc)}
        <div class="field pause-vol"><div class="spread"><label class="lbl" for="p-vol">${tx('Volume')}</label><b id="p-vol-v">${Math.round(vol * 100)}%</b></div><input type="range" id="p-vol" min="0" max="1" step=".05" value="${vol}"></div>
        <button class="btn ghost" data-p="exit">${tx('Back to the garage')}</button></div>`;
    }
    const title = view === 'ch' ? tx('Challenges') : view === 'goto' ? tx('Drive to…') : tx('Paused');
    p.innerHTML = `<div class="pause-in"><small>${esc(this.cityName)}${this.ch ? ' · ' + esc(this.chName(this.ch.def)) : ''}</small><h2>${title}</h2>${body}
      ${view === 'main' ? `<p class="muted small">${this.input.pad ? tx('Controller: menu button pauses, view button resets the car, Y/△ changes camera, B/○ and X/□ shift gears, A/✕ handbrake.') : tx('Keyboard: arrows or WASD drive, E/Q shift, Space handbrake, C camera, R reset, Esc pause.')}</p>` : ''}</div>`;
    p.onclick = e => { const b = e.target.closest('[data-p]'); if (b) this.pauseAct(b.dataset.p) };
    p.oninput = e => { if (e.target.id !== 'p-vol') return; const v = +e.target.value; this.app.saveSetting('volume', v); p.querySelector('#p-vol-v').textContent = Math.round(v * 100) + '%'; this.preview() };
  }
  preview() { import('./audio.js').then(m => m.previewTone()) }
  pauseAct(a) {
    const [k, v] = a.split(':');
    if (k === 'view') { this.pauseView = v; this.renderPause(); setTimeout(() => this.pauseEl?.querySelector('button')?.focus(), 20); return }
    if (k === 'back') return this.pauseBack();
    if (k === 'ch') { const def = this.city.meta.challenges.find(c => c.id === v); this.pause(false); this.beginChallenge(def); return }
    if (k === 'go') { const L = this.city.meta.landmarks[v]; if (this.ch) this.ch = null; this.setTarget({ x: L.road.x, z: L.road.z, y: L.road.y, name: this.lmName(v) }); this.pause(false); this.msg(tx('Drive to') + ': ' + this.lmName(v), 2); return }
    if (k === 'leave') { this.leaveChallenge(); return this.pause(false) }
    if (k === 'clear') { this.setTarget(null); return this.pause(false) }
    if (k === 'cam') { this.camMode = CCAMS[(CCAMS.indexOf(this.camMode) + 1) % CCAMS.length]; this.camInit = false; this.app.saveSetting('camera', this.camMode); const f = 'cam'; this.renderPause(); this.pauseEl.querySelector(`[data-p="${f}"]`)?.focus(); return }
    super.pauseAct(a);
  }
  exit() { try { this.world?.disposeAll(); this.city?.regions.clear() } catch (e) { } super.exit() }
}
