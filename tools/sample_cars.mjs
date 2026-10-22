/* Sample engines and cars for the dev tools (autopilot lap tests, physics checks). Not part of the game's garage. */
import { EQUIP, has } from '../js/parts.js';
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
