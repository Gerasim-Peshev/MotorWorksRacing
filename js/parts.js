/* Engine & car model: the MotorWorks Tycoon formulas, plus the extra data the driving game needs. */
import { TECH, techYear, techName, LAYOUTS, VALVES, FUELS, INJ, SCS, EMATS, BODIES, SHAPES, GEARS, DRIVES, SUSP, INTS, MATS, HEADL, EQUIP, PAINTS } from './tables.js';
export { TECH, techYear, techName, LAYOUTS, VALVES, FUELS, INJ, SCS, EMATS, BODIES, SHAPES, GEARS, DRIVES, SUSP, INTS, MATS, HEADL, EQUIP, PAINTS };

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const YEAR_MIN = 1970, YEAR_MAX = 2026;

/* In the garage every technology invented by a design's model year is available. */
export const has = (t, year) => !t || (t.startsWith && t.startsWith('__') ? false : (techYear(t) ?? 9999) <= year);
const yr = o => o.y || (o.t ? techYear(o.t) : 0) || 0;
export const availableIn = (o, year) => !o.t ? (!o.y || o.y <= year) : has(o.t, year);
export const lockYear = o => o.t ? techYear(o.t) : o.y || null;

export function turboCap(year) {
  if (has('turbo3', year)) return { n: 10, b: 10 }; if (has('turbo2', year)) return { n: 4, b: 2.5 };
  if (has('twin', year)) return { n: 2, b: 1.3 }; if (has('turbo', year)) return { n: 1, b: .8 }; return { n: 0, b: 0 };
}
const qa = year => (has('qa1', year) ? 3 : 0) + (has('qa2', year) ? 4 : 0) + (has('qa3', year) ? 4 : 0);

/* ---------- new parts for driving ---------- */
export const TYRES = {
  eco:   { n: 'Eco tyres',     mu: .90, rr: .80, peak: .135, w: 0,  d: 'Low rolling resistance, modest grip.' },
  road:  { n: 'Touring tyres', mu: 1.00, rr: 1.0, peak: .12, w: 0,  d: 'Balanced road tyres.' },
  sport: { n: 'Sport tyres',   mu: 1.09, rr: 1.08, peak: .105, w: 2, d: 'Stickier compound, sharper response.' },
  semi:  { n: 'Semi-slicks',   mu: 1.21, rr: 1.18, peak: .095, w: 3, y: 1985, d: 'Track-day rubber with a road-legal tread.' },
  slick: { n: 'Racing slicks', mu: 1.36, rr: 1.25, peak: .085, w: 4, y: 1971, d: 'No tread, maximum grip on dry asphalt.' },
};
export const BRAKES = {
  drum:    { n: 'Drum brakes',          f: .78, w: 6, d: 'Cheap and weak. They will not lock good tyres.' },
  disc:    { n: 'Disc brakes',          f: 1.0, w: 0, d: 'Solid discs all round.' },
  vent:    { n: 'Vented discs',         f: 1.12, w: 4, y: 1975, d: 'Bigger, cooler discs for fast cars.' },
  ceramic: { n: 'Carbon-ceramic discs', f: 1.28, w: -12, y: 2001, d: 'Huge stopping power, light weight.' },
};
/* gearbox behaviour */
const GB = (g, type, shift, eff) => ({ g, type, shift, eff });
export const GEARINFO = {
  m4: GB(4, 'manual', .34, .92), a3: GB(3, 'auto', .42, .84), m5: GB(5, 'manual', .32, .92), a4: GB(4, 'auto', .38, .85),
  a5: GB(5, 'auto', .34, .86), m6: GB(6, 'manual', .30, .92), cvt: GB(1, 'cvt', 0, .85), a6: GB(6, 'auto', .28, .88),
  dct: GB(6, 'dct', .08, .92), a8: GB(8, 'auto', .22, .9), dct7: GB(7, 'dct', .07, .92), dct8: GB(8, 'dct', .06, .93),
  dct9: GB(9, 'dct', .05, .93), ev1: GB(1, 'ev', 0, .95),
};
/* physical dimensions of each body (m per SVG unit, width, CoG height, front weight share, glasshouse taper, downforce) */
export const BODYDIM = {
  micro:  { s: .0193, W: 1.56, h: .56, f: .42, tg: .86, cl: 0 },
  hatch:  { s: .0159, W: 1.74, h: .54, f: .60, tg: .80, cl: 0 },
  sedan:  { s: .0169, W: 1.82, h: .52, f: .58, tg: .78, cl: 0 },
  fsedan: { s: .0172, W: 1.86, h: .54, f: .58, tg: .80, cl: 0 },
  ssedan: { s: .0171, W: 1.86, h: .50, f: .56, tg: .76, cl: .14 },
  wagon:  { s: .0171, W: 1.82, h: .54, f: .57, tg: .80, cl: 0 },
  coupe:  { s: .0164, W: 1.84, h: .48, f: .56, tg: .74, cl: .10 },
  cabrio: { s: .0162, W: 1.82, h: .49, f: .56, tg: .80, cl: .05 },
  pickup: { s: .0190, W: 1.96, h: .70, f: .58, tg: .86, cl: 0 },
  suv:    { s: .0171, W: 1.94, h: .72, f: .56, tg: .86, cl: 0 },
  cross:  { s: .0163, W: 1.86, h: .62, f: .58, tg: .82, cl: 0 },
  super:  { s: .0160, W: 2.00, h: .42, f: .41, tg: .70, cl: .62 },
  van:    { s: .0180, W: 2.00, h: .78, f: .55, tg: .97, cl: 0 },
  ltruck: { s: .0236, W: 2.30, h: 1.05, f: .50, tg: .95, cl: 0 },
  htruck: { s: .0298, W: 2.50, h: 1.25, f: .48, tg: .96, cl: 0 },
};
export const VY = 1.1; // vertical stretch of the side profiles in 3D

/* ---------- engine (MotorWorks formula, year-gated tech) ---------- */
export function engStats(e) {
  const L0 = LAYOUTS[e.layout], dy = e.year || 2000;
  if (L0.ev) {
    const hp = e.evHp, bat = Math.max(.45, 1 - .025 * (dy - 2008));
    const w0 = Math.round(110 + hp * 1.1 * bat);
    return { ev: true, L: 0, hp, tq: Math.round(hp * 2.1), w: e.wo ? clamp(e.wo, w0 * .5, w0 * 2) : w0, wAuto: w0, rel: clamp(Math.round(90 + qa(dy) / 2), 20, 99), cyl: 0, rpm: 14000, eco: 1, co2: 0 };
  }
  const rot = L0.rot || 0, cyl = L0.cyl, F = FUELS[e.fuel], J = INJ[e.inj], SC = SCS[e.sc || 'none'];
  const L = rot ? .654 * rot : cyl * Math.PI / 4 * e.bore * e.bore * e.stroke / 1e6;
  const r = rot ? 1 : e.bore / e.stroke;
  const tech = 1 + .006 * (dy - 1970);
  const tb = e.turbos || 0, bar = tb ? e.boost : 0;
  const injP = (e.inj === 'di' && e.fuel === 'diesel') ? 1.25 : J.p;
  const strokeF = rot ? 1 : clamp(Math.pow(86 / e.stroke, .8), .45, 1.15);
  const spec = (rot ? 90 : VALVES[e.valve].s) * F.p * injP * tech * (1 + .3 * (r - 1)) * (has('vvt', dy) ? 1.08 : 1) * strokeF;
  const boostM = tb ? 1 + bar * .35 * (1 + .03 * (tb - 1)) : 1;
  const hp = Math.round(L * spec * boostM * SC.p);
  const tq = Math.round(L * 90 * F.q * (1 + .003 * (dy - 1970)) * (1 - .25 * (r - 1)) * (e.inj === 'di' ? 1.08 : 1) * (tb ? 1 + bar * .5 : 1) * SC.p * (rot ? .8 : 1));
  let w = rot ? 70 + 30 * rot : (30 + 12 * cyl + 30 * L) * (L0.wM || 1);
  w *= F.w * EMATS[e.mat].w; w += tb * 12 + (tb ? 8 : 0) + SC.w;
  const w0 = Math.round(w);
  const rel = 85 + (L0.rel || 0) + F.rel - (tb ? 4 + bar * 4 + (tb - 1) * 1.2 : 0) - SC.rel - Math.max(0, spec * boostM * SC.p - 110) * .08 + qa(dy);
  const rpm = Math.round((5200 + (e.valve === 'dohc' ? 1100 : e.valve === 'sohc' ? 500 : 0) + 1800 * (r - 1) + (rot ? 2500 : 0) + F.rpm) / 100) * 100;
  const eco = F.eco * J.eco * (tb ? 1 + .04 * bar : 1) * SC.eco;
  return { L, hp, tq, w: e.wo ? clamp(e.wo, w0 * .5, w0 * 2) : w0, wAuto: w0, rel: clamp(Math.round(rel), 3, 99), cyl, rot, rpm, spec, boostM, eco, co2: F.co2, tb, bar };
}

/* ---------- car (MotorWorks weight & top-speed formulas) ---------- */
export function carStats(c, E) {
  const B = BODIES[c.body], es = engStats(E), G = GEARS[c.gb], D = DRIVES[c.dt], IN = INTS[c.int], M = MATS[c.mat], SU = SUSP[c.susp || 'std'];
  const TY = TYRES[c.tyre || 'road'], BR = BRAKES[c.brake || 'disc'];
  const eq = (c.equip || []).map(k => EQUIP[k]).filter(Boolean);
  const sumq = f => eq.reduce((a, q) => a + (q[f] || 0), 0);
  const year = c.year || 2000;
  const w0 = Math.round(B.w * M.w * (1 + .006 * clamp(year - 1970, 0, 60)) + es.w + G.w + D.w + IN.w + SU.w + (c.lsd ? 8 : 0) + sumq('w') + TY.w + BR.w);
  const w = c.cw ? clamp(c.cw, w0 * .5, w0 * 2) : w0;
  const pw = es.hp / (w / 1000);
  const t = Math.max(1.9, (2.3 + 850 / pw) * G.acc * D.acc * (es.ev ? .85 : 1) * (c.lsd ? .98 : 1));
  const top = Math.round(Math.min(B.vmax || 999, 37.7 * Math.cbrt(es.hp) * B.aero * (es.ev ? .92 : 1)));
  return { w, wAuto: w0, hp: es.hp, tq: es.tq, t, top, ev: es.ev, es, pw };
}

/* Human-readable engine line, as in the tycoon */
export function engDescParts(e) {
  const s = engStats(e), L = LAYOUTS[e.layout];
  return { s, L };
}

/* ---------- starter garage ---------- */
export const PRESET_ENGINES = [
  { id: 'pe1', name: 'Kestrel 2.0 Twin Cam', layout: 'i4', bore: 86, stroke: 86, valve: 'dohc', fuel: 'petrol', inj: 'mpi', turbos: 0, boost: .6, sc: 'none', mat: 'iron', evHp: 200, wo: null, year: 1984 },
  { id: 'pe2', name: 'Falcon 2.0 Turbo', layout: 'i4', bore: 86, stroke: 86, valve: 'dohc', fuel: 'petrol', inj: 'mpi', turbos: 1, boost: 1.1, sc: 'none', mat: 'iron', evHp: 200, wo: null, year: 1992 },
  { id: 'pe3', name: 'Liberty 5.7 V8', layout: 'v8', bore: 101, stroke: 88, valve: 'ohv', fuel: 'petrol', inj: 'carb', turbos: 0, boost: .6, sc: 'none', mat: 'iron', evHp: 200, wo: null, year: 1970 },
  { id: 'pe4', name: 'Castellan 4.0 V8 Biturbo', layout: 'v8', bore: 86, stroke: 86, valve: 'dohc', fuel: 'petrol', inj: 'di', turbos: 2, boost: 1.3, sc: 'none', mat: 'alu', evHp: 200, wo: null, year: 2016 },
  { id: 'pe5', name: 'Volta 600', layout: 'ev', bore: 82, stroke: 80, valve: 'dohc', fuel: 'petrol', inj: 'carb', turbos: 0, boost: .6, sc: 'none', mat: 'alu', evHp: 600, wo: null, year: 2024 },
  { id: 'pe6', name: 'Hoshino 1.3 Twin-Rotor', layout: 'r2', bore: 82, stroke: 80, valve: 'dohc', fuel: 'petrol', inj: 'mpi', turbos: 2, boost: .8, sc: 'none', mat: 'alu', evHp: 200, wo: null, year: 1992 },
];
const eqBy = (year, extra = []) => Object.keys(EQUIP).filter(k => has(EQUIP[k].t, year) && ['crumple', 'abs', 'airbag', 'esc', 'pwr'].includes(k)).concat(extra);
export const PRESET_CARS = [
  { id: 'pc1', mname: 'Kestrel', trim: 'GTi 16V', body: 'hatch', eng: 'pe1', gb: 'm5', dt: 'fwd', lsd: false, susp: 'sport', int: 'standard', mat: 'steel', hl: 'halogen', equip: eqBy(1984), color: '#c0392b', cw: null, year: 1984, tyre: 'sport', brake: 'vent' },
  { id: 'pc2', mname: 'Falcon', trim: 'Turbo 4x4', body: 'ssedan', eng: 'pe2', gb: 'm6', dt: 'awd', lsd: true, susp: 'coil', int: 'standard', mat: 'steel', hl: 'xenon', equip: eqBy(1993), color: '#2a6f97', cw: null, year: 1993, tyre: 'sport', brake: 'vent' },
  { id: 'pc3', mname: 'Liberty', trim: '350 V8', body: 'coupe', eng: 'pe3', gb: 'm4', dt: 'rwd', lsd: false, susp: 'std', int: 'standard', mat: 'steel', hl: 'halogen', equip: eqBy(1970), color: '#f2b705', cw: null, year: 1970, tyre: 'road', brake: 'drum' },
  { id: 'pc4', mname: 'Castellan', trim: 'GT 4.0', body: 'super', eng: 'pe4', gb: 'dct7', dt: 'rwd', lsd: true, susp: 'coil', int: 'premium', mat: 'carbon', hl: 'led', equip: eqBy(2016), color: '#e8681e', cw: null, year: 2016, tyre: 'semi', brake: 'ceramic' },
  { id: 'pc5', mname: 'Volta', trim: 'e600 AWD', body: 'ssedan', eng: 'pe5', gb: 'ev1', dt: 'awd', lsd: true, susp: 'air', int: 'premium', mat: 'alu', hl: 'led', equip: eqBy(2024, ['adas', 'selfdrive', 'nav']), color: '#e8ebe5', cw: null, year: 2024, tyre: 'sport', brake: 'vent' },
  { id: 'pc6', mname: 'Hoshino', trim: 'RS Rotary', body: 'coupe', eng: 'pe6', gb: 'm5', dt: 'rwd', lsd: true, susp: 'coil', int: 'standard', mat: 'steel', hl: 'xenon', equip: eqBy(1992), color: '#1c2a4a', cw: null, year: 1992, tyre: 'sport', brake: 'vent' },
];
