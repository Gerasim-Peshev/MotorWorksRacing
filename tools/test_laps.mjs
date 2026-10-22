import fs from 'fs';
import * as P from '../js/parts.js';
import * as S from './sample_cars.mjs';
import { Track } from '../js/track.js';
import { buildSpec, CarSim, DT } from '../js/physics.js';
import { AutoPilot } from '../js/ai.js';
const tracks = (process.argv[2] || 'spa,suzuka,catalunya,redbullring,nurburgring-gp,nordschleife').split(',');
const cars = (process.argv[3] || 'pc1,pc4').split(',');
const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
for (const tid of tracks) {
  const t0 = performance.now();
  const tr = new Track(JSON.parse(fs.readFileSync(`../tracks/${tid}.json`)));
  const tb = performance.now() - t0;
  for (const cid of cars) {
    const c = S.PRESET_CARS.find(x => x.id === cid), e = S.PRESET_ENGINES.find(x => x.id === c.eng);
    const spec = buildSpec(c, e), sim = new CarSim(spec), ap = new AutoPilot(tr, spec);
    // start 150 m before the line
    const i0 = tr.wrap(-Math.round(150 / tr.ds));
    sim.reset({ x: tr.px[i0], z: tr.pz[i0], y: tr.py[i0], psi: Math.atan2(-tr.tx[i0], -tr.tz[i0]), hint: i0 });
    let t = 0, lastS = null, lapStart = null, laps = [], hits = 0, off = 0, vmax = 0, airT = 0, maxI = 0;
    const o = { auto: true, abs: true, esc: true, tc: true, assist: 0, rawSteer: true };
    while (t < 1200 && laps.length < 1) {
      const inp = ap.control(sim);
      sim.step(DT, inp, tr, o); t += DT;
      const s = sim.loc.s;
      if (lastS != null && lastS > tr.length * .9 && s < tr.length * .1) { if (lapStart != null) laps.push(t - lapStart); lapStart = t }
      lastS = s;
      if (sim.impact > 1) { hits++; maxI = Math.max(maxI, sim.impact) }
      if (sim.offTrack >= 3) off += DT;
      if (sim.air) airT += DT;
      vmax = Math.max(vmax, sim.speed * 3.6);
      if (t > 60 && sim.speed < .5) { console.log('  STUCK at s=', s.toFixed(0)); break }
    }
    console.log(`${tid.padEnd(15)} ${c.mname.padEnd(10)} lap ${laps.length ? fmt(laps[0]) : '—'}  vmax ${vmax.toFixed(0)} km/h  wall hits ${hits} (max ${maxI.toFixed(1)} m/s)  off-track ${off.toFixed(1)}s  airborne ${airT.toFixed(2)}s   [track build ${tb.toFixed(0)}ms]`);
  }
}
