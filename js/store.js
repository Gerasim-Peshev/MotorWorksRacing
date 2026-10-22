/* Garage persistence: engines, cars, lap records, ghosts, settings. Imports from MotorWorks Tycoon saves. */
import { BODIES, GEARS, DRIVES, SUSP, INTS, MATS, HEADL, EQUIP, LAYOUTS, clamp } from './parts.js';

const KEY = 'motorworks-racing-v1', TYCOON_KEY = 'motorworks-tycoon-v1', GHOST = 'motorworks-racing-ghost-';
export const DEFAULT_SETTINGS = { units: 'kmh', quality: 'auto', volume: .75, camera: 'chase', gearbox: 'car', assist: .8, steerSpeed: 19, vibration: true, steerDead: .06, steerGamma: 1.45, trigDead: .03 };

const b64e = s => btoa(unescape(encodeURIComponent(s)));
const b64d = s => decodeURIComponent(escape(atob(s.trim().replace(/\s+/g, ''))));

export class Store {
  constructor() { this.d = this.load() }
  fresh() {
    return { v: 1, nid: 100, engines: [], cars: [], records: {}, settings: { ...DEFAULT_SETTINGS }, imported: [], noDemo: 1 };
  }
  load() {
    try { const r = JSON.parse(localStorage.getItem(KEY)); if (r && r.v === 1 && Array.isArray(r.cars)) { r.settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) }; r.records = r.records || {}; r.imported = r.imported || []; if (!r.noDemo) this.dropDemo(r); return r } } catch (e) { }
    return this.fresh();
  }
  /* earlier versions started with six demo cars (pc1–pc6 on engines pe1–pe6): remove them once, keeping any demo engine a player's own car still uses */
  dropDemo(r) {
    const demoCar = id => /^pc[1-6]$/.test(id), demoEng = id => /^pe[1-6]$/.test(id);
    r.cars = r.cars.filter(c => !demoCar(c.id));
    r.engines = (r.engines || []).filter(e => !demoEng(e.id) || r.cars.some(c => c.eng === e.id));
    for (const t of Object.values(r.records)) for (const id of Object.keys(t)) if (demoCar(id)) delete t[id];
    r.noDemo = 1;
    try { localStorage.setItem(KEY, JSON.stringify(r)) } catch (e) { }
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.d)) } catch (e) { } }
  id(p) { return p + (this.d.nid++).toString(36) + Math.floor(Math.random() * 1296).toString(36) }
  get engines() { return this.d.engines } get cars() { return this.d.cars }
  engine(id) { return this.d.engines.find(e => e.id === id) }
  car(id) { return this.d.cars.find(c => c.id === id) }
  putEngine(e) { const i = this.d.engines.findIndex(x => x.id === e.id); if (i >= 0) this.d.engines[i] = e; else this.d.engines.push(e); this.save() }
  putCar(c) { const i = this.d.cars.findIndex(x => x.id === c.id); if (i >= 0) this.d.cars[i] = c; else this.d.cars.push(c); this.save() }
  delCar(id) { this.d.cars = this.d.cars.filter(c => c.id !== id); for (const t of Object.values(this.d.records)) delete t[id]; this.save() }
  delEngine(id) { if (this.d.cars.some(c => c.eng === id)) return false; this.d.engines = this.d.engines.filter(e => e.id !== id); this.save(); return true }
  /* records */
  record(track, car) { return (this.d.records[track] || {})[car] || null }
  trackRecords(track) { return Object.entries(this.d.records[track] || {}).map(([car, r]) => ({ car, ...r })).sort((a, b) => a.t - b.t) }
  saveLap(track, car, t, sec, autopilot) {
    if (autopilot) return null;
    const R = this.d.records[track] = this.d.records[track] || {};
    const cur = R[car.id];
    const res = !cur || t < cur.t ? 'car' : null;
    if (res) { R[car.id] = { t, sec, d: Date.now(), name: (car.mname + ' ' + (car.trim || '')).trim(), color: car.color, body: car.body }; this.save() }
    return res;
  }
  clearRecords(track) { if (track) delete this.d.records[track]; else this.d.records = {}; this.save(); try { if (track) localStorage.removeItem(GHOST + track); else for (const k of Object.keys(localStorage)) if (k.startsWith(GHOST)) localStorage.removeItem(k) } catch (e) { } }
  ghost(track) {
    try {
      const g = JSON.parse(localStorage.getItem(GHOST + track)); if (!g) return null;
      const bin = atob(g.f), buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return { ...g, frames: new Float32Array(buf.buffer) };
    } catch (e) { return null }
  }
  saveGhost(track, g) {
    try {
      const f = new Float32Array(g.frames), u = new Uint8Array(f.buffer); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      localStorage.setItem(GHOST + track, JSON.stringify({ t: g.t, car: g.car, name: g.name, tad: g.tad, f: btoa(s) }));
    } catch (e) { /* storage full: keep going without a ghost */ }
  }
  /* settings */
  get settings() { return this.d.settings }
  setSetting(k, v) { this.d.settings[k] = v; this.save() }
  /* ---- import / export ---- */
  exportCode() { return b64e(JSON.stringify({ mwr: 1, engines: this.d.engines, cars: this.d.cars })) }
  tycoonSave() { try { const r = localStorage.getItem(TYCOON_KEY); return r ? JSON.parse(r) : null } catch (e) { return null } }
  /* accepts a racing export code, a tycoon save code or a tycoon state object */
  importAny(input) {
    let o = input;
    if (typeof input === 'string') { try { o = JSON.parse(b64d(input)) } catch (e) { try { o = JSON.parse(input) } catch (e2) { return { ok: false } } } }
    if (!o || !Array.isArray(o.engines) || !Array.isArray(o.cars)) return { ok: false };
    const tycoon = !o.mwr;
    const src = tycoon ? 'ty:' + (o.name || '') + ':' : 'mw:';
    const map = {}; let ne = 0, nc = 0;
    for (const e of o.engines) {
      const key = src + e.id; if (this.d.imported.includes(key)) { const ex = this.d.engines.find(x => x.src === key); if (ex) map[e.id] = ex.id; continue }
      if (!LAYOUTS[e.layout]) continue;
      const ne2 = { ...e, id: this.id('e'), src: key, year: Math.round(e.year || 1990), name: e.name || 'Engine' };
      if (!ne2.inj) ne2.inj = 'carb'; if (!ne2.fuel) ne2.fuel = 'petrol'; if (ne2.turbos == null) ne2.turbos = 0; if (!ne2.sc) ne2.sc = 'none'; if (!ne2.mat) ne2.mat = 'iron'; if (!ne2.valve) ne2.valve = 'ohv';
      map[e.id] = ne2.id; this.d.engines.push(ne2); this.d.imported.push(key); ne++;
    }
    for (const c of o.cars) {
      const key = src + c.id; if (this.d.imported.includes(key)) continue;
      if (!BODIES[c.body] || !map[c.eng]) continue;
      const year = Math.round(c.year || 1990);
      const nc2 = {
        id: this.id('c'), src: key, mname: c.mname || c.name || 'Car', trim: c.trim || '', body: c.body, eng: map[c.eng], gb: GEARS[c.gb] ? c.gb : 'm5', dt: DRIVES[c.dt] ? c.dt : 'fwd', lsd: !!c.lsd,
        susp: SUSP[c.susp] ? c.susp : 'std', int: INTS[c.int] ? c.int : 'standard', mat: MATS[c.mat] ? c.mat : 'steel', hl: HEADL[c.hl] ? c.hl : 'halogen', equip: (c.equip || []).filter(k => EQUIP[k]),
        color: c.color || '#c0392b', cw: c.cw || null, year,
        tyre: c.tyre || (BODIES[c.body].sport >= 70 ? 'sport' : 'road'), brake: c.brake || (year < 1975 && BODIES[c.body].sport < 60 ? 'drum' : year >= 1990 && BODIES[c.body].sport >= 70 ? 'vent' : 'disc'),
      };
      this.d.cars.push(nc2); this.d.imported.push(key); nc++;
    }
    this.save();
    return { ok: true, engines: ne, cars: nc, tycoon };
  }
}
