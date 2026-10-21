/* Input: Xbox / PlayStation controllers (Gamepad API, analog triggers), keyboard and touch.
   Also drives menu navigation with the D-pad / stick (A = select, B = back). */
const STD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16 };
export const ACTIONS = ['steer', 'throttle', 'brake', 'shiftUp', 'shiftDown', 'handbrake', 'camera', 'lookBack', 'reset', 'pause', 'autopilot'];
export const DEFAULT_BIND = {
  steer: { t: 'axis', i: 0 }, throttle: { t: 'button', i: STD.RT }, brake: { t: 'button', i: STD.LT },
  shiftUp: [{ t: 'button', i: STD.RB }, { t: 'button', i: STD.B }], shiftDown: [{ t: 'button', i: STD.LB }, { t: 'button', i: STD.X }],
  handbrake: { t: 'button', i: STD.A }, camera: { t: 'button', i: STD.Y }, lookBack: { t: 'button', i: STD.RS },
  reset: { t: 'button', i: STD.VIEW }, pause: { t: 'button', i: STD.MENU }, autopilot: { t: 'button', i: STD.DOWN },
};
const BINDKEY = 'motorworks-racing-binds';

export function padKind(id = '') {
  const s = id.toLowerCase();
  if (/xbox|xinput|045e|microsoft/.test(s)) return 'xbox';
  if (/054c|dualsense|dualshock|playstation|ps4|ps5|wireless controller/.test(s)) return 'ps';
  if (/057e|nintendo|switch/.test(s)) return 'nintendo';
  return 'generic';
}
export const BTN_LABEL = {
  xbox: { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'View', 9: 'Menu', 10: 'LS', 11: 'RS', 12: '↑', 13: '↓', 14: '←', 15: '→' },
  ps: { 0: '✕', 1: '○', 2: '□', 3: '△', 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2', 8: 'Create', 9: 'Options', 10: 'L3', 11: 'R3', 12: '↑', 13: '↓', 14: '←', 15: '→' },
};

export class Input {
  constructor() {
    this.keys = new Set(); this.pressed = new Set();
    this.state = { steer: 0, throttle: 0, brake: 0, handbrake: false };
    this.edges = {}; this.prevBtn = {}; this.pad = null; this.padIdx = -1; this.kind = 'generic';
    this.settings = { steerDead: .06, steerGamma: 1.45, trigDead: .03, trigGamma: 1, vibration: true, invertSteer: false };
    this.binds = this.loadBinds();
    this.axisMin = {}; this.touch = { steer: 0, throttle: 0, brake: 0, active: false };
    this.kbSteer = 0; this.kbThr = 0; this.kbBrk = 0; this.lastSource = 'keyboard';
    this.listeners = [];
    addEventListener('keydown', e => { if (e.repeat) return; this.keys.add(e.code); this.pressed.add(e.code); this.lastSource = 'keyboard' });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', e => { if (!e.gamepad) return; this.padIdx = e.gamepad.index; this.kind = padKind(e.gamepad.id); this.emit('pad', e.gamepad) });
    addEventListener('gamepaddisconnected', e => { if (e.gamepad && e.gamepad.index === this.padIdx) { this.padIdx = -1; this.pad = null } this.emit('pad', null) });
  }
  on(f) { this.listeners.push(f) } emit(k, v) { for (const f of this.listeners) f(k, v) }
  loadBinds() { try { const b = JSON.parse(localStorage.getItem(BINDKEY)); if (b && b.steer) return { ...DEFAULT_BIND, ...b } } catch (e) { } return JSON.parse(JSON.stringify(DEFAULT_BIND)) }
  saveBinds() { try { localStorage.setItem(BINDKEY, JSON.stringify(this.binds)) } catch (e) { } }
  resetBinds() { this.binds = JSON.parse(JSON.stringify(DEFAULT_BIND)); this.saveBinds() }
  pads() { try { return [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean) } catch (e) { return [] } }
  /* read one binding as an analog value 0..1 (or -1..1 for axes when signed) */
  read(gp, b, signed) {
    if (!b || !gp) return 0;
    if (Array.isArray(b)) { let m = 0; for (const x of b) { const v = this.read(gp, x, signed); if (Math.abs(v) > Math.abs(m)) m = v } return m }
    if (b.t === 'button') { const bt = gp.buttons[b.i]; return bt ? (typeof bt === 'object' ? (bt.value || (bt.pressed ? 1 : 0)) : bt) : 0 }
    if (b.t === 'axis') {
      let v = gp.axes[b.i] || 0; if (b.inv) v = -v;
      if (signed) return v;
      // a trigger reported as an axis: rests at -1 (full range) or 0 (half range)
      const key = gp.index + ':' + b.i; this.axisMin[key] = Math.min(this.axisMin[key] ?? 0, v);
      if (b.half) return Math.max(0, v);
      return this.axisMin[key] < -.5 ? (v + 1) / 2 : Math.max(0, v);
    }
    return 0;
  }
  pressedBind(gp, b) { if (Array.isArray(b)) return b.some(x => this.pressedBind(gp, x)); return this.read(gp, b) > .5 }
  /* call once per frame */
  poll(dt) {
    const pads = this.pads();
    // pick the pad that was used most recently
    let gp = null;
    for (const p of pads) { if (!gp || (p.timestamp || 0) > (gp.timestamp || 0)) gp = p }
    const changed = gp && gp.index !== this.padIdx;
    this.pad = gp;
    if (changed) { this.padIdx = gp.index; this.kind = padKind(gp.id); this.emit('pad', gp) }
    const e = this.edges = {};
    const B = this.binds;
    let steer = 0, thr = 0, brk = 0, hb = false;
    if (gp) {
      const sv = this.read(gp, B.steer, true), sd = this.settings.steerDead;
      const a = Math.abs(sv) < sd ? 0 : (Math.abs(sv) - sd) / (1 - sd);
      steer = Math.sign(sv) * Math.pow(Math.min(1, a), this.settings.steerGamma) * (this.settings.invertSteer ? -1 : 1);
      const td = this.settings.trigDead, tg = v => { v = v < td ? 0 : (v - td) / (1 - 2 * td); return Math.pow(Math.min(1, Math.max(0, v)), this.settings.trigGamma) };
      thr = tg(this.read(gp, B.throttle)); brk = tg(this.read(gp, B.brake));
      hb = this.pressedBind(gp, B.handbrake);
      for (const k of ['shiftUp', 'shiftDown', 'camera', 'lookBack', 'reset', 'pause', 'autopilot', 'handbrake']) {
        const now = this.pressedBind(gp, B[k]); if (now && !this.prevBtn[k]) e[k] = true; this.prevBtn[k] = now;
        if (k === 'lookBack') e.lookBackHeld = now;
      }
      if (Math.abs(steer) > .2 || thr > .1 || brk > .1) this.lastSource = 'pad';
      // raw buttons for menus
      this.raw = gp.buttons.map(b => (typeof b === 'object' ? b.pressed || b.value > .5 : !!b));
      this.rawAxes = [...gp.axes];
    } else { this.raw = []; this.rawAxes = [] }
    // keyboard (digital -> smoothed analog)
    const K = this.keys, kl = K.has('ArrowLeft') || K.has('KeyA'), kr = K.has('ArrowRight') || K.has('KeyD');
    const ku = K.has('ArrowUp') || K.has('KeyW'), kd = K.has('ArrowDown') || K.has('KeyS');
    const rate = (cur, tgt, up, down) => cur + Math.max(-down * dt, Math.min(up * dt, tgt - cur));
    this.kbSteer = rate(this.kbSteer, (kr ? 1 : 0) - (kl ? 1 : 0), 3.2, 5);
    this.kbThr = rate(this.kbThr, ku ? 1 : 0, 5, 8); this.kbBrk = rate(this.kbBrk, kd ? 1 : 0, 6, 9);
    const P = this.pressed;
    if (P.has('KeyE') || P.has('ShiftRight')) e.shiftUp = true;
    if (P.has('KeyQ') || P.has('ControlRight')) e.shiftDown = true;
    if (P.has('KeyC')) e.camera = true; if (P.has('KeyR')) e.reset = true; if (P.has('KeyP') || P.has('Escape')) e.pause = true;
    if (P.has('KeyL')) e.autopilot = true; if (P.has('KeyH')) e.hud = true; if (P.has('KeyM')) e.mute = true;
    if (K.has('KeyB')) e.lookBackHeld = true;
    P.clear();
    if (Math.abs(this.kbSteer) > Math.abs(steer)) steer = this.kbSteer;
    thr = Math.max(thr, this.kbThr); brk = Math.max(brk, this.kbBrk);
    if (K.has('Space')) hb = true;
    // touch controls
    const T = this.touch; if (T.active) { if (Math.abs(T.steer) > Math.abs(steer)) steer = T.steer; thr = Math.max(thr, T.throttle); brk = Math.max(brk, T.brake) }
    Object.assign(this.state, { steer, throttle: thr, brake: brk, handbrake: hb });
    return this.state;
  }
  rumble(strong, weak, ms = 110) {
    if (!this.settings.vibration || !this.pad) return;
    const a = this.pad.vibrationActuator; if (!a || !a.playEffect) return;
    try { a.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }).catch(() => { }) } catch (e) { }
  }
  triggerRumble(left, right, ms = 90) {
    if (!this.settings.vibration || !this.pad) return;
    const a = this.pad.vibrationActuator; if (!a || !a.playEffect || !(a.effects || []).includes?.('trigger-rumble')) return;
    try { a.playEffect('trigger-rumble', { startDelay: 0, duration: ms, leftTrigger: Math.min(1, left), rightTrigger: Math.min(1, right), strongMagnitude: 0, weakMagnitude: 0 }).catch(() => { }) } catch (e) { }
  }
  label(b) {
    if (!b) return '—'; if (Array.isArray(b)) return b.map(x => this.label(x)).join(' / ');
    const L = BTN_LABEL[this.kind] || BTN_LABEL.xbox;
    if (b.t === 'button') return L[b.i] ?? ('B' + b.i);
    return (b.i === 0 ? 'LS ↔' : 'Axis ' + b.i) + (b.inv ? ' (inv)' : '');
  }
  /* wait for the next control the player moves; resolves with a binding */
  capture(analog, timeout = 6000) {
    return new Promise(res => {
      const t0 = performance.now(), base = {};
      const pads = this.pads(); for (const p of pads) base[p.index] = { a: [...p.axes], b: p.buttons.map(x => x.value || (x.pressed ? 1 : 0)) };
      const tick = () => {
        if (performance.now() - t0 > timeout) return res(null);
        for (const p of this.pads()) {
          const b0 = base[p.index] || { a: p.axes.map(() => 0), b: p.buttons.map(() => 0) };
          for (let i = 0; i < p.buttons.length; i++) { const v = p.buttons[i].value || (p.buttons[i].pressed ? 1 : 0); if (v - (b0.b[i] || 0) > .5) return res({ t: 'button', i }) }
          for (let i = 0; i < p.axes.length; i++) { const d = p.axes[i] - (b0.a[i] || 0); if (Math.abs(d) > .6) return res(analog === 'steer' ? { t: 'axis', i, inv: d < 0 && false } : { t: 'axis', i, half: Math.abs(b0.a[i] || 0) < .2 && !(b0.a[i] < -.5) ? true : false }) }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
}

/* ---------- gamepad menu navigation ---------- */
export class MenuNav {
  constructor(input, rootFn, backFn, tabFn) {
    this.input = input; this.rootFn = rootFn; this.backFn = backFn; this.tabFn = tabFn;
    this.prev = []; this.repeatT = 0; this.dir = null; this.enabled = true;
  }
  focusables(root) {
    return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0);
  }
  move(dx, dy) {
    const root = this.rootFn(); if (!root) return;
    const list = this.focusables(root); if (!list.length) return;
    const cur = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
    if (!cur) { list[0].focus(); this.mark(list[0]); return }
    // sliders take left/right
    if (cur.type === 'range' && dx) { const st = +cur.step || 1, v = Math.min(+cur.max, Math.max(+cur.min, +cur.value + dx * st * (+cur.dataset.big || 1))); cur.value = v; cur.dispatchEvent(new Event('input', { bubbles: true })); cur.dispatchEvent(new Event('change', { bubbles: true })); return }
    const r0 = cur.getBoundingClientRect(), cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best = null, bs = 1e9;
    for (const el of list) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      const px = (x - cx) * dx + (y - cy) * dy; if (px <= 4) continue;
      const ortho = Math.abs((x - cx) * dy) + Math.abs((y - cy) * dx);
      const s = px + ortho * 2.2; if (s < bs) { bs = s; best = el }
    }
    if (best) { best.focus({ preventScroll: true }); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); this.mark(best) }
  }
  mark(el) { document.body.classList.add('gp-nav') }
  poll(dt) {
    if (!this.enabled) return;
    const raw = this.input.raw || [], ax = this.input.rawAxes || [];
    const was = i => this.prev[i];
    const press = i => raw[i] && !was(i);
    let dx = 0, dy = 0;
    if (raw[14] || ax[0] < -.6) dx = -1; else if (raw[15] || ax[0] > .6) dx = 1;
    if (raw[12] || ax[1] < -.6) dy = -1; else if (raw[13] || ax[1] > .6) dy = 1;
    const dir = dx || dy ? dx + ',' + dy : null;
    if (dir) { if (dir !== this.dir) { this.repeatT = .38; this.move(dx, dy) } else { this.repeatT -= dt; if (this.repeatT <= 0) { this.repeatT = .11; this.move(dx, dy) } } }
    this.dir = dir;
    if (press(0)) { const el = document.activeElement; if (el && el !== document.body) { document.body.classList.add('gp-nav'); if (el.type === 'checkbox') el.click(); else el.click() } else this.move(0, 1) }
    if (press(1)) this.backFn && this.backFn();
    if (press(4)) this.tabFn && this.tabFn(-1);
    if (press(5)) this.tabFn && this.tabFn(1);
    this.prev = raw.slice();
  }
}
