/* Garage UI: cars, engines, tracks, records, settings, and the engine & car designers (ported from MotorWorks Tycoon). */
import * as THREE from './vendor/three.module.min.js';
import { LAYOUTS, VALVES, FUELS, INJ, SCS, EMATS, BODIES, SHAPES, GEARS, DRIVES, SUSP, INTS, MATS, HEADL, EQUIP, PAINTS, TYRES, BRAKES, GEARINFO,
  engStats, carStats, turboCap, has, availableIn, lockYear, techYear, YEAR_MIN, YEAR_MAX, clamp } from './parts.js';
import { buildSpec, perfTest, engineCurve } from './physics.js';
import { buildCar, disposeCar } from './carmodel.js';
import { Store } from './store.js';
import { Input, MenuNav, ACTIONS, DEFAULT_BIND } from './input.js';
import { DriveSession } from './drive.js';
import { audioCtx, setVolume } from './audio.js';
import { tx, LANG, setLang, dec, fn, fmtTime, FLAG_US, FLAG_BG } from './i18n.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICONS = {
  garage: '<path d="M3 16l2.2-5.5A2 2 0 0 1 7 9h10a2 2 0 0 1 1.8 1.5L21 16v3h-3M3 16v3h3M3 16h18M9 19h6"/><circle cx="7.5" cy="19" r="1.6"/><circle cx="16.5" cy="19" r="1.6"/>',
  eng: '<rect x="6" y="3" width="12" height="9" rx="1"/><path d="M6 7h12M12 12v5M8 21l4-4 4 4"/>',
  tracks: '<path d="M5 21V4M5 4h13l-2.5 4 2.5 4H5"/>',
  records: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z"/>',
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
const TABS = [['garage', 'Garage'], ['eng', 'Engines'], ['tracks', 'Tracks'], ['records', 'Records'], ['settings', 'Settings']];
const COUNTRY = { DE: 'Germany', BE: 'Belgium', JP: 'Japan', ES: 'Spain', AT: 'Austria', BG: 'Bulgaria' };

/* ---- the tycoon's 2D side profile (kept for lists) ---- */
export function carSVG(body, color, label) {
  const s = SHAPES[body], wh = s.wh || [[82, 16], [238, 16]];
  const wheel = ([x, r]) => { const cy = 108 - r; let sp = ''; for (let i = 0; i < 5; i++) { const a = i * Math.PI * 2 / 5 - Math.PI / 2; sp += `M${x} ${cy} L${(x + Math.cos(a) * r * .55).toFixed(1)} ${(cy + Math.sin(a) * r * .55).toFixed(1)} ` }
    return `<circle cx="${x}" cy="${cy}" r="${r + 3.5}" fill="var(--arch)"/><circle cx="${x}" cy="${cy}" r="${r}" fill="var(--tyre)"/><circle cx="${x}" cy="${cy}" r="${(r * .62).toFixed(1)}" fill="var(--rim)"/><path d="${sp}" stroke="var(--tyre)" stroke-width="2.2" stroke-linecap="round"/><circle cx="${x}" cy="${cy}" r="${(r * .16).toFixed(1)}" fill="var(--tyre)"/>` };
  let o = `<svg class="carpic" viewBox="0 0 320 116" role="img" aria-label="${esc(label || tx(BODIES[body].n))}"><ellipse cx="160" cy="109" rx="152" ry="5" fill="var(--shadow)"/>`;
  if (s.box) o += `<path d="${s.box}" fill="${color}" stroke="var(--ink)" stroke-opacity=".45" stroke-width="1.5"/><path d="${s.box}" fill="#fff" opacity=".4"/>`;
  o += `<path d="${s.p}" fill="${color}" stroke="var(--ink)" stroke-opacity=".45" stroke-width="1.5" stroke-linejoin="round"/>`;
  o += `<rect x="${s.x[0]}" y="84" width="${s.x[1] - s.x[0]}" height="9" fill="#000" opacity=".13"/>`;
  o += `<path d="${s.g}" fill="var(--glass)"/><path d="${s.g}" fill="#fff" opacity=".08"/>`;
  for (const [x, y1, y2] of s.pil || []) o += `<path d="M${x} ${y1} L${x} ${y2}" stroke="${color}" stroke-width="5"/>`;
  if (s.x2) o += `<path d="${s.x2}" fill="var(--tyre)" opacity=".85"/>`;
  o += `<path d="${s.d}" fill="none" stroke="var(--ink)" stroke-opacity=".35" stroke-width="1.2"/>`;
  if (s.m) o += `<path d="M${s.m[0]} ${s.m[1]} l7 -3 l2 5 l-8 2 z" fill="${color}" stroke="var(--ink)" stroke-opacity=".5"/>`;
  o += `<rect x="${s.tl[0]}" y="${s.tl[1]}" width="5" height="${s.tlh || 6}" rx="1" fill="#d23a28"/><rect x="${s.hl[0]}" y="${s.hl[1]}" width="9" height="5" rx="1.5" fill="#fff1b8" stroke="var(--ink)" stroke-opacity=".3"/>`;
  return o + wh.map(wheel).join('') + '</svg>';
}
function engineDiagram(e) {
  const L = LAYOUTS[e.layout];
  if (L.ev) return `<svg viewBox="0 0 300 110" class="diag" role="img" aria-label="${tx('Electric motor')}"><rect x="70" y="25" width="140" height="60" rx="10" fill="var(--sunk)" stroke="var(--muted)" stroke-width="2"/><rect x="210" y="45" width="24" height="20" rx="3" fill="var(--rim)"/><path d="M146 32l-20 26h18l-10 22 30-32h-18l12-16z" fill="var(--accent)"/></svg>`;
  const n = L.rot || L.cyl, fo = L.fo, pos = {}; let W = 300, H = 120, extra = '';
  if (L.k === 'i') { const st = Math.min(46, 240 / Math.max(1, n - 1)); const x0 = 150 - st * (n - 1) / 2; for (let i = 1; i <= n; i++) pos[i] = [x0 + (i - 1) * st, 52]; extra = `<line x1="${x0 - 24}" x2="${x0 + st * (n - 1) + 24}" y1="88" y2="88" stroke="var(--muted)" stroke-width="3"/>` }
  else if (L.k === 'v' || L.k === 'b') { const h = n / 2, st = Math.min(46, 220 / Math.max(1, h - .5)); const x0 = 150 - st * (h - .5) / 2; for (let i = 1; i <= h; i++) { pos[i] = [x0 + (i - 1) * st, 28]; pos[i + h] = [x0 + (i - 1) * st + st / 2, 92] } extra = `<line x1="${x0 - 20}" x2="${x0 + st * h + 10}" y1="60" y2="60" stroke="var(--muted)" stroke-width="3"/>` }
  else if (L.k === 'w') { const per = n / 4, st = Math.min(44, 220 / Math.max(1, per)); const x0 = 150 - st * (per - .5) / 2; const ys = [14, 40, 80, 106]; H = 124; for (let i = 1; i <= n; i++) { const row = Math.floor((i - 1) / per), ix = (i - 1) % per; pos[i] = [x0 + ix * st + (row % 2) * st / 2, ys[row] + 4] } extra = `<line x1="${x0 - 20}" x2="${x0 + st * per + 10}" y1="64" y2="64" stroke="var(--muted)" stroke-width="3"/>` }
  else { const st = Math.min(70, 240 / Math.max(1, n - 1)); const x0 = 150 - st * (n - 1) / 2; for (let i = 1; i <= n; i++) pos[i] = [x0 + (i - 1) * st, 56]; extra = `<line x1="${x0 - 34}" x2="${x0 + st * (n - 1) + 34}" y1="56" y2="56" stroke="var(--muted)" stroke-width="3"/>` }
  const r = L.k === 'r' ? 22 : Math.max(9, Math.min(17, 130 / n)), T = 1.8;
  const cyls = fo.map((cy, ix) => { const [x, y] = pos[cy]; const sh = L.k === 'r' ? `<path d="M${x} ${y - r} L${(x + r * .87).toFixed(1)} ${(y + r * .5).toFixed(1)} L${(x - r * .87).toFixed(1)} ${(y + r * .5).toFixed(1)} Z" stroke-linejoin="round" class="cylf" style="animation-delay:${(ix * T / n).toFixed(2)}s"/>` : `<circle cx="${x.toFixed(1)}" cy="${y}" r="${r.toFixed(1)}" class="cylf" style="animation-delay:${(ix * T / n).toFixed(2)}s"/>`;
    return sh + `<text x="${x.toFixed(1)}" y="${y + 4}" text-anchor="middle" class="cyln">${L.k === 'r' ? 'R' : ''}${cy}</text>` }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="diag" role="img" aria-label="${tx(L.n)}, ${tx('Firing order')} ${fo.join('-')}">${extra}${cyls}</svg><div><span class="lbl">${tx('Firing order')}</span> <b>${fo.join('-')}</b></div>`;
}
function curveSVG(e) {
  const c = engineCurve(e), W = 300, H = 150, P = 26;
  const tmax = Math.max(...c.pts.map(p => p[1])) * 1.1, hmax = Math.max(...c.pts.map(p => p[2])) * 1.1, rmax = c.red;
  const X = r => P + (r / rmax) * (W - P * 2), Yt = t => H - P - t / tmax * (H - P * 1.6), Yh = h => H - P - h / hmax * (H - P * 1.6);
  const line = (f, col, w) => `<polyline fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round" points="${c.pts.map(p => X(p[0]).toFixed(1) + ',' + f(p).toFixed(1)).join(' ')}"/>`;
  const ticks = []; for (let r = 0; r <= rmax; r += rmax > 9000 ? 2000 : 1000) ticks.push(`<line x1="${X(r)}" x2="${X(r)}" y1="${H - P}" y2="${H - P + 4}" stroke="var(--muted)"/><text x="${X(r)}" y="${H - 8}" class="ax">${r / 1000}k</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" class="diag" role="img" aria-label="${tx('Power and torque curve')}"><line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" stroke="var(--muted)"/>${ticks.join('')}${line(p => Yt(p[1]), 'var(--green)', 2.2)}${line(p => Yh(p[2]), 'var(--accent)', 3)}
    <text x="${P}" y="14" class="ax" text-anchor="start" fill="var(--accent)">● ${tx('Power')}</text><text x="${P + 92}" y="14" class="ax" text-anchor="start">● ${tx('Torque')}</text><text x="${W - P}" y="14" class="ax" text-anchor="end">${tx('rpm')}</text></svg>`;
}
export function engDesc(e) {
  const s = engStats(e), L = LAYOUTS[e.layout]; if (s.ev) return tx('{v} hp electric', { v: fn(s.hp) });
  const ind = e.turbos ? (e.turbos === 1 ? tx('turbo') : e.turbos === 2 ? tx('twin-turbo') : tx('{n} turbos', { n: e.turbos })) : ''; const sc = e.sc && e.sc !== 'none' ? tx('supercharged') : '';
  return `${dec(s.L, 1)} ${tx('L')} ${tx(L.n)} ${tx(FUELS[e.fuel].n).toLowerCase()}${ind ? ' ' + ind : ''}${sc ? ' ' + sc : ''} · ${tx('{v} hp', { v: fn(s.hp) })}`;
}
function trackSVG(t, cls = 'trkpic') {
  const o = t.outline; let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]) }
  const pad = Math.max(x1 - x0, z1 - z0) * .06, vb = `${x0 - pad} ${z0 - pad} ${x1 - x0 + pad * 2} ${z1 - z0 + pad * 2}`, sw = Math.max(x1 - x0, z1 - z0) / 60;
  const pts = []; for (let i = 0; i < o.length; i += 2) pts.push(o[i] + ',' + o[i + 1]);
  return `<svg class="${cls}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><polygon points="${pts.join(' ')}" fill="none" stroke="var(--ink)" stroke-width="${sw * 2.2}" stroke-linejoin="round"/><polygon points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="${sw}" stroke-linejoin="round"/><rect x="${o[0] - sw * 2}" y="${o[1] - sw * 2}" width="${sw * 4}" height="${sw * 4}" fill="var(--ink)"/></svg>`;
}

/* ================= APP ================= */
export class App {
  constructor() {
    this.store = new Store(); this.input = new Input(); this.tab = 'garage'; this.sheet = null; this.draft = null; this.session = null;
    this.applyInputSettings();
    this.nav = new MenuNav(this.input, () => this.navRoot(), () => this.back(), d => this.cycleTab(d));
    this.input.on((k) => { if (k === 'pad') this.renderTop() });
    this.tracks = [];
  }
  async boot() {
    document.documentElement.lang = LANG;
    try { this.tracks = await (await fetch('tracks/index.json')).json() } catch (e) { this.tracks = [] }
    try { const ids = await (await fetch('city/index.json')).json(); this.cities = (await Promise.all(ids.map(id => fetch(`city/${id}/info.json`).then(r => r.json()).catch(() => null)))).filter(Boolean) } catch (e) { this.cities = [] }
    this.renderTop(); this.renderNav(); this.renderView();
    document.addEventListener('click', e => { const t = e.target.closest('[data-a]'); if (!t || t.disabled) return; audioCtx(); this.act(t.dataset.a, t) });
    document.addEventListener('input', e => this.onInput(e));
    document.addEventListener('change', e => this.onChange(e));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !this.session) this.back() });
    document.addEventListener('pointerdown', () => document.body.classList.remove('gp-nav'));
    let last = performance.now();
    const loop = now => { const dt = Math.min(.1, (now - last) / 1000); last = now; if (!this.session) { this.input.poll(dt); this.nav.poll(dt); this.liveControls() } requestAnimationFrame(loop) };
    requestAnimationFrame(loop);
    const ty = this.store.tycoonSave();
    if (ty && ty.engines && ty.engines.length && !this.store.d.tyAsked) { this.store.d.tyAsked = 1; this.store.save(); this.modal(`<h2>${tx('MotorWorks Tycoon save found')}</h2><p>${tx('Your company {name} has {e} engines and {c} cars. Bring them into the garage so you can drive them?', { name: esc(ty.name), e: ty.engines.length, c: ty.cars.length })}</p>`, [[tx('Not now'), 'close'], [tx('Import'), 'importTycoon', 1]]) }
  }
  settings() { return this.store.settings }
  saveSetting(k, v) { this.store.setSetting(k, v); this.applyInputSettings() }
  applyInputSettings() { const s = this.store.settings; Object.assign(this.input.settings, { vibration: s.vibration, steerDead: s.steerDead, steerGamma: s.steerGamma, trigDead: s.trigDead }); setVolume(s.volume) }
  autoQuality() { const mobile = matchMedia('(pointer:coarse)').matches; const cores = navigator.hardwareConcurrency || 4; return mobile ? (cores >= 8 ? 'medium' : 'low') : cores >= 8 ? 'high' : 'medium' }
  navRoot() { return this.session?.pauseEl || $('#modal') || $('#sheet') || $('#app') }
  back() { if (this.session?.paused) return this.session.pauseBack(); if ($('#modal')) return this.closeModal(); if (this.sheet) { this.closeSheet(); return } }
  cycleTab(d) { if (this.session || $('#modal') || this.sheet) return; const i = TABS.findIndex(t => t[0] === this.tab); this.tab = TABS[(i + d + TABS.length) % TABS.length][0]; this.renderNav(); this.renderView(); setTimeout(() => this.focusFirst(), 20) }
  focusFirst() { const r = this.navRoot(); const f = r && this.nav.focusables(r).find(el => !el.closest('.top')); if (f && document.body.classList.contains('gp-nav')) f.focus() }
  /* ---------- chrome ---------- */
  renderTop() {
    const pad = this.input.pad, kind = this.input.kind;
    $('#top').innerHTML = `<div class="brand"><svg class="logo" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="var(--accent)" stroke="var(--ink)" stroke-width="2.5"/><circle cx="20" cy="20" r="7" fill="var(--ink)"/><path d="M20 2v11M20 27v11M2 20h11M27 20h11" stroke="var(--ink)" stroke-width="2.5"/></svg><div style="min-width:0"><b>MotorWorks Racing</b><small>${tx('Build it. Drive it.')}</small></div></div>
      <span class="padtag ${pad ? 'on' : ''}" title="${pad ? esc(pad.id) : ''}">${pad ? (kind === 'ps' ? '🎮 PlayStation' : kind === 'xbox' ? '🎮 Xbox' : '🎮 ' + tx('Controller')) : tx('No controller')}</span>
      <button class="langsw" data-a="lang" aria-label="${LANG === 'bg' ? 'Switch to English' : 'Превключи на български'}"><span class="fl ${LANG === 'en' ? 'on' : ''}">${FLAG_US}</span><span class="fl ${LANG === 'bg' ? 'on' : ''}">${FLAG_BG}</span></button>`;
  }
  renderNav() { $('#nav').innerHTML = TABS.map(([k, l]) => `<button data-a="tab:${k}" ${this.tab === k ? 'aria-current="page"' : ''}>${icon(k)}<span>${tx(l)}</span></button>`).join('') }
  renderView() { const v = $('#view'); v.innerHTML = ({ garage: () => this.viewGarage(), eng: () => this.viewEngines(), tracks: () => this.viewTracks(), records: () => this.viewRecords(), settings: () => this.viewSettings() })[this.tab](); }
  modal(html, btns, wide) {
    this.closeModal(); const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.id = 'modal';
    bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}<div class="row" style="justify-content:flex-end">${btns.map(([l, a, p]) => `<button class="btn ${p ? 'primary' : ''}" data-a="${a}">${l}</button>`).join('')}</div></div>`;
    bg.addEventListener('click', e => { if (e.target === bg) this.closeModal() });
    document.body.append(bg); setTimeout(() => { if (document.body.classList.contains('gp-nav')) (bg.querySelector('.btn.primary') || bg.querySelector('button'))?.focus() }, 30);
  }
  closeModal() { $('#modal')?.remove() }
  toast(t) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = t; $('#toasts').append(el); setTimeout(() => el.remove(), 3800); while ($('#toasts').children.length > 2) $('#toasts').firstChild.remove() }
  /* ---------- views ---------- */
  carStatsLine(c) { const e = this.store.engine(c.eng); if (!e) return { line: tx('Engine missing'), st: null }; const st = carStats(c, e); return { st, line: `${esc(engDesc(e))} · ${tx(GEARS[c.gb].n)} · ${tx(DRIVES[c.dt].n)}` } }
  viewGarage() {
    const cars = this.store.cars.slice().reverse();
    const card = c => { const { st, line } = this.carStatsLine(c); const rec = this.tracks.map(t => this.store.record(t.id, c.id)).filter(Boolean).length;
      return `<article class="card carcard"><div class="spread"><div style="min-width:0"><small>${tx(BODIES[c.body].n)} · ${c.year}</small><h3>${esc(c.mname)} <span class="trimname">${esc(c.trim)}</span></h3></div>${rec ? `<span class="tag good">${tx('{n} track records', { n: rec })}</span>` : ''}</div>
        <div class="pic">${carSVG(c.body, c.color, c.mname)}</div><div class="muted small">${line}</div>
        ${st ? `<div class="dl"><div><small>${tx('Power')}</small><b>${tx('{v} hp', { v: fn(st.hp) })}</b></div><div><small>${tx('Weight')}</small><b>${tx('{v} kg', { v: fn(st.w) })}</b></div><div><small>${tx('hp per tonne')}</small><b>${fn(st.pw)}</b></div><div><small>${tx('Tyres')}</small><b>${tx(TYRES[c.tyre || 'road'].n)}</b></div></div>` : ''}
        <div class="row"><button class="btn primary" data-a="pickTrack:${c.id}" ${st ? '' : 'disabled'}>${tx('Drive')}</button><button class="btn" data-a="editCar:${c.id}">${tx('Edit')}</button><button class="btn ghost" data-a="dupCar:${c.id}">${tx('Copy')}</button><button class="btn ghost" data-a="delCar:${c.id}" aria-label="${tx('Delete')}">✕</button></div></article>` };
    const ty = this.store.tycoonSave();
    return `<div class="sect-h"><div><small>${tx('{n} cars', { n: cars.length })}</small><h2>${tx('Garage')}</h2></div><div class="row"><button class="btn primary" data-a="newCar">${tx('Design car')}</button></div></div>
      <div class="coach"><b>${tx('How it works')}</b><span>${tx('Design an engine, build a car around it, then take it to the Nordschleife, Spa, Suzuka, Barcelona, the Red Bull Ring or A1 Motor Park. Every part you choose changes how it drives.')}</span></div>
      ${cars.length ? `<div class="grid">${cars.map(card).join('')}</div>` : this.store.engines.length
        ? `<div class="card empty"><h3>${tx('No cars yet')}</h3><p class="muted">${tx('Build a car around one of your engines.')}</p><div class="row"><button class="btn primary" data-a="newCar">${tx('Design car')}</button></div></div>`
        : `<div class="card empty"><h3>${tx('Your garage is empty')}</h3><p class="muted">${tx('Start with an engine: pick its layout, size and technology. Then build a car around it.')}</p><div class="row"><button class="btn primary" data-a="newEngine">${tx('Design engine')}</button></div></div>`}
      ${ty && ty.cars && ty.cars.length ? `<section class="card"><h3>${tx('From MotorWorks Tycoon')}</h3><p class="muted">${tx('Your company {name} has {e} engines and {c} cars on this device.', { name: esc(ty.name), e: ty.engines.length, c: ty.cars.length })}</p><button class="btn" data-a="importTycoon">${tx('Import them into the garage')}</button></section>` : ''}`;
  }
  viewEngines() {
    const es = this.store.engines.slice().reverse();
    const card = e => { const s = engStats(e), L = LAYOUTS[e.layout], used = this.store.cars.filter(c => c.eng === e.id).length;
      const parts = s.ev ? [tx('Battery-electric')] : [tx(FUELS[e.fuel].n), s.rot ? tx('Rotary') : tx(VALVES[e.valve].n), tx(INJ[e.inj].n), e.turbos ? tx('{n}× turbo @ {b} bar', { n: e.turbos, b: dec(e.boost, 1) }) : '', e.sc && e.sc !== 'none' ? tx('{size} supercharger', { size: [SCS[e.sc].n] }) : '', tx(EMATS[e.mat].n)].filter(Boolean);
      return `<article class="card"><div class="spread"><div><small>${tx(L.n)} · ${e.year}</small><h3>${esc(e.name)}</h3></div>${used ? `<span class="tag">${tx('{n} cars', { n: used })}</span>` : ''}</div>
        <div class="dl"><div><small>${tx('Power')}</small><b>${tx('{v} hp', { v: fn(s.hp) })}</b></div><div><small>${tx('Torque')}</small><b>${tx('{v} Nm', { v: fn(s.tq) })}</b></div><div><small>${s.ev ? tx('Motor') : tx('Displacement')}</small><b>${s.ev ? tx('Electric') : dec(s.L, 1) + ' ' + tx('L')}</b></div><div><small>${tx('Redline')}</small><b>${tx('{v} rpm', { v: fn(s.rpm) })}</b></div><div><small>${tx('Weight')}</small><b>${tx('{v} kg', { v: s.w })}</b></div></div>
        <small class="muted">${parts.join(' · ')}</small><div class="row"><button class="btn" data-a="editEngine:${e.id}">${tx('Edit')}</button><button class="btn ghost" data-a="dupEngine:${e.id}">${tx('Copy')}</button><button class="btn ghost" data-a="delEngine:${e.id}" aria-label="${tx('Delete')}">✕</button></div></article>` };
    return `<div class="sect-h"><div><small>${tx('{n} engines', { n: es.length })}</small><h2>${tx('Engines')}</h2></div><button class="btn primary" data-a="newEngine">${tx('Design engine')}</button></div>${es.length ? `<div class="grid">${es.map(card).join('')}</div>` : `<div class="card empty"><h3>${tx('No engines yet')}</h3><p class="muted">${tx('Start with an engine: pick its layout, size and technology. Then build a car around it.')}</p><div class="row"><button class="btn primary" data-a="newEngine">${tx('Design engine')}</button></div></div>`}`;
  }
  viewTracks() {
    const card = t => { const recs = this.store.trackRecords(t.id), best = recs[0];
      return `<article class="card trkcard"><div class="spread"><div><small>${tx(COUNTRY[t.country] || t.country)} · ${esc(t.place.split(',')[0])}</small><h3>${esc(t.name)}</h3></div>${t.id === 'nordschleife' ? `<span class="tag y">${tx('Green Hell')}</span>` : t.id === 'a1motorpark' ? `<span class="tag y">${tx('New track')}</span>` : ''}</div>
        <div class="trkbox">${trackSVG(t)}</div>
        <div class="dl"><div><small>${tx('Length')}</small><b>${dec(t.officialM / 1000, 3)} ${tx('km')}</b></div><div><small>${tx('Elevation change')}</small><b>${t.estimated ? '≈' : ''}${t.elev} ${tx('m')}</b></div><div><small>${tx('Steepest')}</small><b>${t.grade}%</b></div><div><small>${tx('Your best')}</small><b>${best ? fmtTime(best.t) : '–'}</b></div></div>
        ${best ? `<small class="muted">${tx('Record holder: {car}', { car: esc(best.name) })}</small>` : ''}
        <button class="btn primary" data-a="pickCar:${t.id}">${tx('Drive here')}</button></article>` };
    return `<div class="sect-h"><div><small>${tx('Real layouts and real elevation')}</small><h2>${tx('Tracks')}</h2></div></div><div class="grid">${(this.cities || []).map(c => this.cityCard(c)).join('')}${this.tracks.map(card).join('')}</div>
`;
  }
  cityName(c) { return LANG === 'bg' ? (c.nameBg || c.name) : c.name }
  cityCard(c) {
    const chs = c.challenges.map(ch => { const r = this.store.trackRecords(c.id + ':' + ch.id)[0]; return `<button class="chbtn" data-a="pickCar:${c.id}~${ch.id}"><span><b>${esc(LANG === 'bg' ? ch.bg : ch.en)}</b><small>${dec(ch.km, 1)} ${tx('km')}</small></span><small>${r ? fmtTime(r.t) : '–'}</small></button>` }).join('');
    return `<article class="card trkcard citycard"><div class="spread"><div><small>${tx('Bulgaria')} · ${tx('Free roam')}</small><h3>${esc(this.cityName(c))}</h3></div><span class="tag y">${tx('New')}</span></div>
      <div class="cityin"><div class="citybox"><img src="city/${c.id}/preview.svg" alt="${esc(tx('Map of {city}', { city: this.cityName(c) }))}" loading="lazy" width="300" height="320"></div>
      <div class="citytxt"><p class="muted">${esc((c.desc && (c.desc[LANG] || c.desc.en)) || '')}</p>
        <div class="dl"><div><small>${tx('Area')}</small><b>${fn(c.km2)} ${tx('km²')}</b></div><div><small>${tx('Streets')}</small><b>${fn(c.streetKm)} ${tx('km')}</b></div><div><small>${tx('Buildings')}</small><b>${fn(c.buildings)}</b></div><div><small>${tx('Challenges')}</small><b>${c.challenges.length}</b></div></div>
        <button class="btn primary" data-a="pickCar:${c.id}">${tx('Free roam in {city}', { city: this.cityName(c) })}</button>
        <small class="lbl">${tx('Challenges')}</small><div class="chlist">${chs}</div></div></div></article>`;
  }
  viewRecords() {
    const cityRows = (this.cities || []).map(c => { const rows = c.challenges.map(ch => ({ ch, r: this.store.trackRecords(c.id + ':' + ch.id)[0] })).filter(x => x.r);
      return `<section class="card"><div class="spread"><h3>${esc(this.cityName(c))} · ${tx('Challenges')}</h3>${rows.length ? `<button class="btn sm ghost" data-a="clearCity:${c.id}">${tx('Clear')}</button>` : ''}</div>
        ${rows.length ? `<div class="tbl"><table><thead><tr><th>${tx('Challenge')}</th><th>${tx('Car')}</th><th class="n">${tx('Time')}</th></tr></thead><tbody>${rows.map(({ ch, r }) => `<tr><td>${esc(LANG === 'bg' ? ch.bg : ch.en)}</td><td><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</td><td class="n"><b>${fmtTime(r.t)}</b></td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">${tx('No times yet.')}</p>`}</section>` }).join('');
    const rows = this.tracks.map(t => { const recs = this.store.trackRecords(t.id), g = this.store.ghost(t.id);
      return `<section class="card"><div class="spread"><h3>${esc(t.name)}</h3>${recs.length ? `<button class="btn sm ghost" data-a="clearRec:${t.id}">${tx('Clear')}</button>` : ''}</div>
        ${recs.length ? `<div class="tbl"><table><thead><tr><th>#</th><th>${tx('Car')}</th><th class="n">${tx('Lap')}</th><th class="n">S1</th><th class="n">S2</th><th class="n">S3</th></tr></thead><tbody>${recs.map((r, i) => `<tr><td>${i + 1}</td><td><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</td><td class="n"><b>${fmtTime(r.t)}</b></td>${(r.sec || []).map(v => `<td class="n">${v.toFixed(2)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<p class="muted">${tx('No laps yet.')}</p>`}
        ${g ? `<small class="muted">${tx('Ghost: {name}, {t}', { name: esc(g.name), t: fmtTime(g.t) })}</small>` : ''}</section>` }).join('');
    return `<div class="sect-h"><div><small>${tx('Best valid lap per car')}</small><h2>${tx('Records')}</h2></div></div>${cityRows}${rows}`;
  }
  viewSettings() {
    const s = this.store.settings, I = this.input, chips = (k, opts) => `<div class="chips">${opts.map(([v, l]) => `<button class="chip" data-a="set:${k}:${v}" aria-pressed="${String(s[k]) === String(v)}">${l}</button>`).join('')}</div>`;
    const bindRow = a => `<div class="bind"><span>${tx(BIND_N[a])}</span><b>${esc(I.label(I.binds[a]))}</b><button class="btn sm" data-a="rebind:${a}">${tx('Change')}</button></div>`;
    return `<div class="sect-h"><div><small>MotorWorks Racing</small><h2>${tx('Settings')}</h2></div></div>
    <div class="grid">
      <section class="card"><h3>${tx('Controller')}</h3>
        <p class="muted small" id="padname">${I.pad ? esc(I.pad.id) : tx('Connect an Xbox or PlayStation controller by USB or Bluetooth, then press any button.')}</p>
        <div class="live"><div class="hud-in"><span>${tx('Steer')}</span><div class="bar c"><i id="lv-st"></i></div></div><div class="hud-in"><span>${tx('Throttle')}</span><div class="bar"><i id="lv-thr" class="g"></i></div><b id="lv-thrv"></b></div><div class="hud-in"><span>${tx('Brake')}</span><div class="bar"><i id="lv-brk" class="r"></i></div><b id="lv-brkv"></b></div></div>
        <small class="muted">${tx('The triggers are fully analog: squeeze gently for part throttle or light braking.')}</small>
        <div class="field"><div class="spread"><label class="lbl" for="s-sd">${tx('Steering dead zone')}</label><b>${Math.round(s.steerDead * 100)}%</b></div><input type="range" id="s-sd" data-i="steerDead" min="0" max=".2" step=".01" value="${s.steerDead}"></div>
        <div class="field"><div class="spread"><label class="lbl" for="s-sg">${tx('Steering linearity')}</label><b>${dec(s.steerGamma, 2)}</b></div><input type="range" id="s-sg" data-i="steerGamma" min="1" max="2.5" step=".05" value="${s.steerGamma}"></div>
        <div class="field"><div class="spread"><label class="lbl" for="s-td">${tx('Trigger dead zone')}</label><b>${Math.round(s.trigDead * 100)}%</b></div><input type="range" id="s-td" data-i="trigDead" min="0" max=".15" step=".01" value="${s.trigDead}"></div>
        <div class="field"><div class="spread"><label class="lbl" for="s-ss">${tx('Steering at speed')}</label><b>${s.steerSpeed}</b></div><input type="range" id="s-ss" data-i="steerSpeed" min="12" max="40" step="1" value="${s.steerSpeed}"><small class="muted">${tx('Higher keeps more steering lock at high speed.')}</small></div>
        <div class="row"><button class="chip" data-a="set:vibration:${!s.vibration}" aria-pressed="${s.vibration}">${tx('Vibration')}</button><button class="btn sm" data-a="testRumble">${tx('Test vibration')}</button></div>
        <h3 style="margin-top:6px">${tx('Buttons')}</h3>${ACTIONS.map(bindRow).join('')}<button class="btn sm ghost" data-a="resetBinds">${tx('Reset to defaults')}</button>
        <small class="muted">${tx('Keyboard: arrows or WASD drive, E/Q shift, Space handbrake, C camera, R reset, B look back, L autopilot, Esc pause.')}</small></section>
      <section class="card"><h3>${tx('Driving')}</h3>
        <div class="field"><span class="lbl">${tx('Gearbox')}</span>${chips('gearbox', [['car', tx('As built')], ['auto', tx('Automatic')], ['manual', tx('Manual')]])}</div>
        <div class="field"><span class="lbl">${tx('Steering assist')}</span>${chips('assist', [[0, tx('Off')], [.4, tx('Low')], [.8, tx('High')]])}<small class="muted">${tx('Assist points the front wheels along the direction of travel, which makes catching slides easier on a stick.')}</small></div>
        <div class="field"><span class="lbl">${tx('Camera')}</span>${chips('camera', [['chase', tx('chase')], ['far', tx('far')], ['hood', tx('hood')], ['bumper', tx('bumper')], ['tv', tx('tv')]])}</div>
        <div class="field"><span class="lbl">${tx('Units')}</span>${chips('units', [['kmh', 'km/h'], ['mph', 'mph']])}</div>
        <h3>${tx('Graphics & sound')}</h3>
        <div class="field"><span class="lbl">${tx('Quality')}</span>${chips('quality', [['auto', tx('Auto')], ['low', tx('Low')], ['medium', tx('Medium')], ['high', tx('High')]])}</div>
        <div class="field"><div class="spread"><label class="lbl" for="s-vol">${tx('Volume')}</label><b>${Math.round(s.volume * 100)}%</b></div><input type="range" id="s-vol" data-i="volume" min="0" max="1" step=".05" value="${s.volume}"></div></section>
      <section class="card"><h3>${tx('Your garage')}</h3>
        <p class="muted small">${tx('Paste a MotorWorks Tycoon save code (Menu → Copy save code) or a garage code from another device.')}</p>
        <textarea id="impcode" rows="3" class="code" placeholder="${tx('Paste code')}"></textarea>
        <div class="row"><button class="btn" data-a="importCode">${tx('Import')}</button><button class="btn ghost" data-a="exportCode">${tx('Copy garage code')}</button></div><span id="impmsg" class="small"></span>
        <h3>${tx('Data & credits')}</h3>
        <p class="muted small">${tx('Track geometry © OpenStreetMap contributors (ODbL) via Open Racetrack DB. Terrain: Mapzen Terrain Tiles (USGS, NOAA, Copernicus EU-DEM). Track widths and start lines: TUMFTM racetrack-database (LGPL-3.0). 3D engine: three.js (MIT). Parts and car shapes from MotorWorks Tycoon.')}</p>
        <p class="muted small">${tx('Sofia: map data © OpenStreetMap contributors (ODbL). Elevation: Viewfinder Panoramas 3″ DEM by Jonathan de Ferranti, based on SRTM.')}</p></section>
    </div>`;
  }
  liveControls() {
    if (this.tab !== 'settings' || this.sheet) return; const st = this.input.state, e = $('#lv-st'); if (!e) return;
    e.style.cssText = `left:${50 + Math.min(0, st.steer) * 50}%;width:${Math.abs(st.steer) * 50}%`;
    $('#lv-thr').style.width = st.throttle * 100 + '%'; $('#lv-brk').style.width = st.brake * 100 + '%';
    $('#lv-thrv').textContent = Math.round(st.throttle * 100) + '%'; $('#lv-brkv').textContent = Math.round(st.brake * 100) + '%';
    const pn = $('#padname'); if (pn && this.input.pad && pn.textContent !== this.input.pad.id) pn.textContent = this.input.pad.id;
  }
  /* ---------- designers ---------- */
  chipRow(key, opts, cur, kind, year, extraDisabled) {
    return `<div class="chips">${Object.entries(opts).map(([k, o]) => { const lock = !availableIn(o, year), ly = lockYear(o); return `<button class="chip" data-a="${kind}:${key}:${k}" aria-pressed="${cur === k}" ${lock || (extraDisabled && extraDisabled(k)) ? 'disabled' : ''}>${tx(o.n)}${lock && ly ? ` <span class="lk">${ly}</span>` : ''}</button>` }).join('')}</div>`;
  }
  yearField(year) { return `<div class="field"><div class="spread"><label class="lbl" for="dyear">${tx('Model year')}</label><b id="dyearv">${year}</b></div><input type="range" id="dyear" data-i="year" data-big="5" min="${YEAR_MIN}" max="${YEAR_MAX}" step="1" value="${year}"><small class="muted">${tx('Technology available to the design depends on its year.')}</small></div>` }
  openEngine(e) {
    this.draft = e ? { ...e } : { id: null, name: tx('Engine {n}', { n: this.store.engines.length + 1 }), layout: 'i4', bore: 82, stroke: 80, valve: 'dohc', fuel: 'petrol', inj: 'mpi', turbos: 0, boost: .6, sc: 'none', mat: 'alu', evHp: 250, wo: null, year: 1995 };
    this.fixEngine(); this.sheet = 'engine'; this.renderSheet();
  }
  fixEngine() {
    const d = this.draft, L = LAYOUTS[d.layout], y = d.year;
    if (!availableIn(L, y)) d.layout = 'i4';
    if (LAYOUTS[d.layout].ev) return;
    if (L.rot && d.fuel === 'diesel') d.fuel = 'petrol';
    if (!availableIn(FUELS[d.fuel], y)) d.fuel = 'petrol';
    if (!availableIn(VALVES[d.valve], y)) d.valve = has('dohc', y) ? 'dohc' : has('sohc', y) ? 'sohc' : 'ohv';
    if (!INJ[d.inj].f.includes(d.fuel) || !availableIn(INJ[d.inj], y)) { const ok = Object.entries(INJ).filter(([k, j]) => j.f.includes(d.fuel) && availableIn(j, y)); d.inj = (ok.find(([k]) => k === 'di') || ok.find(([k]) => k === 'mpi') || ok[0])[0] }
    if (!availableIn(SCS[d.sc || 'none'], y)) d.sc = 'none';
    if (!availableIn(EMATS[d.mat], y)) d.mat = 'iron';
    const cap = turboCap(y); d.turbos = Math.min(d.turbos, cap.n); d.boost = clamp(d.boost, .2, Math.max(.2, cap.b));
    d.bore = clamp(d.bore, 60, d.fuel === 'diesel' ? 140 : 110); d.stroke = clamp(d.stroke, 55, d.fuel === 'diesel' ? 160 : 110);
  }
  engStatsHTML() {
    const d = this.draft, s = engStats(d);
    return `${engineDiagram(d)}${curveSVG(d)}
      <div class="dl"><div><small>${tx('Power')}</small><b>${tx('{v} hp', { v: fn(s.hp) })}</b></div><div><small>${tx('Torque')}</small><b>${tx('{v} Nm', { v: fn(s.tq) })}</b></div><div><small>${s.ev ? tx('Type') : tx('Displacement')}</small><b>${s.ev ? tx('Electric') : dec(s.L, 2) + ' ' + tx('L')}</b></div><div><small>${tx('Redline')}</small><b>${tx('{v} rpm', { v: fn(s.rpm) })}</b></div><div><small>${tx('Weight')}</small><b>${tx('{v} kg', { v: s.w })}</b></div><div><small>${tx('Reliability')}</small><b>${s.rel}</b></div></div>
      ${s.ev ? '' : `<div class="stat"><span>${tx('hp per litre')}</span><div class="meter"><i style="width:${clamp(s.hp / s.L / 2, 0, 100)}%"></i></div><span>${Math.round(s.hp / s.L)}</span></div>`}
      ${d.turbos ? `<small class="muted">${tx('Turbo lag grows with boost and the number of turbos.')}</small>` : ''}`;
  }
  sheetEngine() {
    const d = this.draft, L = LAYOUTS[d.layout], cap = turboCap(d.year), mm = tx('mm'), y = d.year;
    const fuels = Object.fromEntries(Object.entries(FUELS).map(([k, f]) => [k, L.rot && k === 'diesel' ? { ...f, y: 9999 } : f]));
    const injs = Object.fromEntries(Object.entries(INJ).filter(([k, j]) => j.f.includes(d.fuel)));
    return `<div class="sheet-in"><div class="sect-h"><div><small>${tx('Engine bay · {y} technology', { y })}</small><h2>${d.id ? tx('Edit engine') : tx('Design engine')}</h2></div><button class="btn ghost" data-a="closeSheet">${tx('Cancel')}</button></div>
    <div class="split"><div class="sect">
      ${this.yearField(y)}
      <div class="field"><label class="lbl" for="ename">${tx('Name')}</label><input type="text" id="ename" data-i="dname" value="${esc(d.name)}" maxlength="28"></div>
      <div class="field"><span class="lbl">${tx('Layout')}</span>${this.chipRow('layout', LAYOUTS, d.layout, 'eo', y)}</div>
      ${L.ev ? `<div class="field"><div class="spread"><label class="lbl" for="evhp">${tx('Motor power')}</label><b id="evv">${tx('{v} hp', { v: d.evHp })}</b></div><input type="range" id="evhp" data-i="evHp" data-big="5" min="80" max="1500" step="10" value="${d.evHp}"></div>` : `
      <div class="field"><span class="lbl">${tx('Fuel')}</span>${this.chipRow('fuel', fuels, d.fuel, 'eo', y)}</div>
      <div class="field"><span class="lbl">${tx('Fuel system')}</span>${this.chipRow('inj', injs, d.inj, 'eo', y)}</div>
      ${L.rot ? '' : `<div class="field"><div class="spread"><label class="lbl" for="bore">${tx('Bore')}</label><b id="borev">${d.bore} ${mm}</b></div><input type="range" id="bore" data-i="bore" min="60" max="${d.fuel === 'diesel' ? 140 : 110}" value="${d.bore}"></div>
      <div class="field"><div class="spread"><label class="lbl" for="stroke">${tx('Stroke')}</label><b id="strokev">${d.stroke} ${mm}</b></div><input type="range" id="stroke" data-i="stroke" min="55" max="${d.fuel === 'diesel' ? 160 : 110}" value="${d.stroke}"></div>
      <small class="muted">${tx('Bore wider than stroke revs higher for more power. A long stroke gives more torque.')}</small>
      <div class="field"><span class="lbl">${tx('Valvetrain')}</span>${this.chipRow('valve', VALVES, d.valve, 'eo', y)}</div>`}
      <div class="field"><div class="spread"><label class="lbl" for="turbos">${tx('Turbochargers')}</label><b id="turbosv">${d.turbos || tx('None')}</b></div>
        ${cap.n ? `<input type="range" id="turbos" data-i="turbos" min="0" max="${cap.n}" step="1" value="${d.turbos}">` : `<small class="muted">${tx('Turbochargers arrive in {y}.', { y: techYear('turbo') })}</small>`}</div>
      ${cap.n ? `<div class="field"><div class="spread"><label class="lbl" for="boost">${tx('Boost per turbo')}</label><b id="boostv">${d.turbos ? dec(d.boost, 1) + ' bar' : tx('no turbos')}</b></div><input type="range" id="boost" data-i="boost" min="0.2" max="${cap.b}" step="0.1" value="${d.boost}"><small class="muted">${tx('{y} technology allows up to {n} turbo(s) at {b} bar.', { y, n: cap.n, b: dec(cap.b, 1) })}</small></div>` : ''}
      <div class="field"><span class="lbl">${tx('Supercharger')}</span>${this.chipRow('sc', SCS, d.sc, 'eo', y)}</div>
      <div class="field"><span class="lbl">${tx('Block material')}</span>${this.chipRow('mat', EMATS, d.mat, 'eo', y)}</div>`}
    </div><div class="card sticky" id="estats">${this.engStatsHTML()}</div></div></div>
    <div class="sheet-foot"><span class="muted small">${tx('Engines are free to build in the garage.')}</span><button class="btn primary" data-a="saveEngine">${d.id ? tx('Save engine') : tx('Build engine')}</button></div>`;
  }
  openCar(c) {
    const engs = this.store.engines;
    if (!engs.length) { this.toast(tx('Design an engine first.')); this.tab = 'eng'; this.renderNav(); this.renderView(); return }
    if (c) this.draft = { ...c, equip: (c.equip || []).slice() };
    else { const e = engs[engs.length - 1], year = Math.max(e.year, 1990);
      this.draft = { id: null, mname: tx('Kestrel'), trim: '', body: 'coupe', eng: e.id, gb: LAYOUTS[e.layout].ev ? 'ev1' : 'm6', dt: 'rwd', lsd: true, susp: 'sport', int: 'standard', mat: 'steel', hl: 'xenon', equip: ['crumple', 'abs', 'airbag', 'pwr'], color: PAINTS[Math.floor(Math.random() * PAINTS.length)][1], cw: null, year, tyre: 'sport', brake: 'vent' } }
    this.fixCar(); this.sheet = 'car'; this.renderSheet();
  }
  fixCar() {
    const d = this.draft, y = d.year, E = this.store.engine(d.eng);
    if (!availableIn(BODIES[d.body], y)) d.body = 'sedan';
    const ev = E && LAYOUTS[E.layout].ev;
    if (ev) d.gb = 'ev1'; else if (GEARS[d.gb].ev || !availableIn(GEARS[d.gb], y)) d.gb = ['m6', 'm5', 'm4'].find(g => availableIn(GEARS[g], y));
    for (const [k, T] of [['dt', DRIVES], ['susp', SUSP], ['int', INTS], ['mat', MATS], ['hl', HEADL], ['tyre', TYRES], ['brake', BRAKES]]) if (!availableIn(T[d[k]], y)) d[k] = Object.keys(T).find(q => availableIn(T[q], y));
    if (d.lsd && !has('lsd', y)) d.lsd = false;
    d.equip = d.equip.filter(k => EQUIP[k] && has(EQUIP[k].t, y));
  }
  perfHTML() {
    const d = this.draft, E = this.store.engine(d.eng); if (!E) return '';
    const st = carStats(d, E), spec = buildSpec(d, E);
    const p = this.perf && this.perf.key === this.perfKey() ? this.perf.r : null;
    const v = (x, f) => p ? f(x) : '…';
    const ratios = spec.cvt ? tx('Stepless (CVT)') : spec.ratios.length === 1 ? tx('Single speed') : spec.ratios.map(r => dec(r / spec.final, 2)).join(' · ') + ` · ${tx('final')} ${dec(spec.final, 2)}`;
    return `<div class="dl"><div><small>${tx('0–100 km/h')}</small><b>${v(p?.t100, x => x ? tx('{v} s', { v: dec(x, 1) }) : '—')}</b></div><div><small>${tx('0–200 km/h')}</small><b>${v(p?.t200, x => x ? tx('{v} s', { v: dec(x, 1) }) : '—')}</b></div><div><small>${tx('Top speed')}</small><b>${v(p?.vmax, x => tx('{v} km/h', { v: Math.round(x) }))}</b></div>
      <div><small>${tx('100–0 km/h')}</small><b>${v(p?.brake100, x => dec(x, 1) + ' ' + tx('m'))}</b></div><div><small>${tx('Cornering grip')}</small><b>${v(p?.latG, x => dec(x, 2) + ' g')}</b></div><div><small>${tx('Weight')}</small><b>${tx('{v} kg', { v: fn(st.w) })}</b></div>
      <div><small>${tx('Power')}</small><b>${tx('{v} hp', { v: fn(st.hp) })}</b></div><div><small>${tx('hp per tonne')}</small><b>${fn(st.pw)}</b></div><div><small>${tx('Weight front')}</small><b>${Math.round(spec.fr * 100)}%</b></div></div>
      <small class="muted">${tx('Gear ratios')}: ${ratios}</small>
      <small class="muted">${tx('Figures come from the same physics you drive with, on a flat road.')}</small>`;
  }
  perfKey() { const d = this.draft, E = this.store.engine(d.eng); return JSON.stringify([d.body, d.gb, d.dt, d.lsd, d.susp, d.int, d.mat, d.equip, d.cw, d.year, d.tyre, d.brake, E]) }
  schedulePerf() {
    clearTimeout(this.perfT);
    this.perfT = setTimeout(() => { const d = this.draft, E = this.store.engine(d.eng); if (!d || !E) return; const key = this.perfKey(); try { this.perf = { key, r: perfTest(buildSpec(d, E)) } } catch (e) { console.error(e) } const el = $('#cperf'); if (el) el.innerHTML = this.perfHTML() }, 220);
  }
  sheetCar() {
    const d = this.draft, y = d.year, E = this.store.engine(d.eng), ev = E && LAYOUTS[E.layout].ev;
    const gears = Object.fromEntries(Object.entries(GEARS).filter(([k, g]) => ev ? g.ev : !g.ev));
    const eqRow = cat => `<div class="chips">${Object.entries(EQUIP).filter(([k, o]) => o.cat === cat).map(([k, o]) => { const lock = !has(o.t, y); return `<button class="chip" data-a="cs:${k}" aria-pressed="${d.equip.includes(k)}" ${lock ? 'disabled' : ''}>${tx(o.n)}${lock ? ` <span class="lk">${techYear(o.t)}</span>` : ''}</button>` }).join('')}</div>`;
    const engChips = `<div class="chips">${this.store.engines.map(e => `<button class="chip" data-a="ceng:${e.id}" aria-pressed="${e.id === d.eng}" ${e.year > y ? 'disabled' : ''}>${esc(e.name)} <span class="lk">${fn(engStats(e).hp)} ${tx('hp')}</span></button>`).join('')}</div>`;
    const st = E ? carStats(d, E) : null;
    return `<div class="sheet-in"><div class="sect-h"><div><small>${tx('Design studio')}</small><h2>${d.id ? tx('Edit car') : tx('Design car')}</h2></div><button class="btn ghost" data-a="closeSheet">${tx('Cancel')}</button></div>
    <div class="split"><div class="sect">
      ${this.yearField(y)}
      <div class="row"><div class="field" style="flex:2"><label class="lbl" for="cname">${tx('Model name')}</label><input type="text" id="cname" data-i="mname" value="${esc(d.mname)}" maxlength="24"></div><div class="field" style="flex:1"><label class="lbl" for="ctrim">${tx('Version name')}</label><input type="text" id="ctrim" data-i="trim" value="${esc(d.trim)}" maxlength="18" placeholder="${tx('e.g. 2.0d 4x4')}"></div></div>
      <div class="field"><span class="lbl">${tx('Body')}</span>${this.chipRow('body', BODIES, d.body, 'co', y)}</div>
      <div class="field"><span class="lbl">${tx('Engine')}</span>${engChips}${E ? `<small class="muted">${esc(engDesc(E))}</small>` : ''}</div>
      <div class="field"><span class="lbl">${tx('Gearbox')}</span>${this.chipRow('gb', gears, d.gb, 'co', y)}</div>
      <div class="field"><span class="lbl">${tx('Drive')}</span>${this.chipRow('dt', DRIVES, d.dt, 'co', y)}<div class="chips"><button class="chip" data-a="lsd" aria-pressed="${!!d.lsd}" ${has('lsd', y) ? '' : 'disabled'}>${tx('Limited-slip diff')}${has('lsd', y) ? '' : ` <span class="lk">${techYear('lsd')}</span>`}</button></div></div>
      <div class="field"><span class="lbl">${tx('Tyres')}</span>${this.chipRow('tyre', TYRES, d.tyre, 'co', y)}<small class="muted">${tx(TYRES[d.tyre].d)}</small></div>
      <div class="field"><span class="lbl">${tx('Brakes')}</span>${this.chipRow('brake', BRAKES, d.brake, 'co', y)}<small class="muted">${tx(BRAKES[d.brake].d)}</small></div>
      <div class="field"><span class="lbl">${tx('Suspension')}</span>${this.chipRow('susp', SUSP, d.susp, 'co', y)}</div>
      <div class="field"><span class="lbl">${tx('Body material')}</span>${this.chipRow('mat', MATS, d.mat, 'co', y)}</div>
      <div class="field"><span class="lbl">${tx('Interior')}</span>${this.chipRow('int', INTS, d.int, 'co', y)}</div>
      <div class="field"><span class="lbl">${tx('Headlights')}</span>${this.chipRow('hl', HEADL, d.hl, 'co', y)}</div>
      <div class="field"><span class="lbl">${tx('Safety')}</span>${eqRow('s')}<small class="muted">${tx('ABS stops wheels locking, stability control catches slides, and Self-driving L3 unlocks the autopilot.')}</small></div>
      <div class="field"><span class="lbl">${tx('Comfort & tech')}</span>${eqRow('c')}</div>
      <div class="field"><span class="lbl">${tx('Paint')}</span><div class="chips">${PAINTS.map(([n, h]) => `<button class="swatch" style="background:${h}" data-a="paint:${h.slice(1)}" aria-pressed="${d.color === h}" aria-label="${tx(n)}"></button>`).join('')}</div>
        <div class="row"><input type="color" id="cpick" data-i="color" value="${d.color}" aria-label="${tx('Any colour')}"><input type="text" id="chex" data-i="hex" value="${d.color}" maxlength="7" style="max-width:130px" aria-label="${tx('Hex colour')}"></div></div>
      <div class="field"><label class="lbl" for="ccw">${tx('Curb weight override (kg)')}</label><input type="number" id="ccw" data-i="cw" min="300" step="1" placeholder="${st ? tx('Calculated: {v} kg', { v: st.wAuto }) : ''}" value="${d.cw || ''}"></div>
    </div><div class="card sticky"><div class="prev3d" id="prev3d"><small>${tx('Drag to turn')}</small></div><div id="cperf">${this.perfHTML()}</div></div></div></div>
    <div class="sheet-foot"><button class="btn" data-a="saveCar">${tx('Save car')}</button><button class="btn primary" data-a="saveDrive">${tx('Save & drive')}</button></div>`;
  }
  renderSheet(keep) {
    let el = $('#sheet'); const top = el ? el.scrollTop : 0;
    if (!this.sheet) { if (el) el.remove(); this.stopPreview(); return }
    if (!el) { el = document.createElement('div'); el.className = 'sheet'; el.id = 'sheet'; document.body.append(el) }
    const f = document.activeElement?.dataset?.a || document.activeElement?.id;
    el.innerHTML = this.sheet === 'engine' ? this.sheetEngine() : this.sheetCar();
    if (keep) el.scrollTop = top;
    if (f && keep) { const n = el.querySelector(`[data-a="${CSS.escape(f)}"]`) || el.querySelector('#' + CSS.escape(f)); if (n) n.focus({ preventScroll: true }) }
    if (this.sheet === 'car') { this.startPreview(); this.schedulePerf() } else this.stopPreview();
  }
  closeSheet() { this.sheet = null; this.draft = null; this.renderSheet() }
  updateSheetStats() { if (this.sheet === 'engine') $('#estats').innerHTML = this.engStatsHTML(); else if (this.sheet === 'car') { this.refreshPreview(); this.schedulePerf() } }
  /* ---------- 3D preview ---------- */
  startPreview() {
    const host = $('#prev3d'); if (!host) return;
    if (!this.pv) {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true }); r.toneMapping = THREE.ACESFilmicToneMapping; r.outputColorSpace = THREE.SRGBColorSpace; r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
      const scene = new THREE.Scene();
      const pm = new THREE.PMREMGenerator(r), es = new THREE.Scene();
      es.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({ side: THREE.BackSide, vertexShader: 'varying vec3 v;void main(){v=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}', fragmentShader: 'varying vec3 v;void main(){float h=v.y;vec3 c=mix(vec3(.45,.48,.44),vec3(.85,.9,.95),smoothstep(-.1,.4,h));gl_FragColor=vec4(c,1.);}' })));
      scene.environment = pm.fromScene(es, .04).texture;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x445044, 1.1));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-4, 8, 5); scene.add(sun);
      const floor = new THREE.Mesh(new THREE.CircleGeometry(4.2, 48), new THREE.MeshStandardMaterial({ color: 0x8a9290, roughness: .95 })); floor.rotation.x = -Math.PI / 2; scene.add(floor);
      const cam = new THREE.PerspectiveCamera(32, 1.6, .1, 100);
      this.pv = { r, scene, cam, yaw: .7, model: null, drag: null };
      const el = r.domElement;
      el.addEventListener('pointerdown', e => { this.pv.drag = e.clientX; el.setPointerCapture(e.pointerId) });
      el.addEventListener('pointermove', e => { if (this.pv.drag != null) { this.pv.yaw += (e.clientX - this.pv.drag) * .01; this.pv.drag = e.clientX } });
      el.addEventListener('pointerup', () => this.pv.drag = null);
    }
    host.prepend(this.pv.r.domElement);
    this.refreshPreview(true);
    if (!this.pvLoop) { const loop = () => { if (!this.pv || !this.sheet || this.sheet !== 'car') { this.pvLoop = null; return } this.pvLoop = requestAnimationFrame(loop); this.drawPreview() }; this.pvLoop = requestAnimationFrame(loop) }
  }
  refreshPreview(force) {
    if (!this.pv) return; const d = this.draft, key = d.body + d.color;
    if (!force && key === this.pv.key) return; this.pv.key = key;
    if (this.pv.model) { this.pv.scene.remove(this.pv.model.group); disposeCar(this.pv.model) }
    this.pv.model = buildCar(d, {}); this.pv.scene.add(this.pv.model.group);
    const L = this.pv.model.dims.length; this.pv.dist = Math.max(6, L * 1.75);
  }
  drawPreview() {
    const P = this.pv, host = $('#prev3d'); if (!host) return;
    const w = host.clientWidth, h = Math.round(w * .56);
    if (P.w !== w) { P.r.setSize(w, h); P.cam.aspect = w / h; P.cam.updateProjectionMatrix(); P.w = w }
    if (P.drag == null) P.yaw += .004;
    const dd = P.dist, H = this.pv.model.dims.height;
    P.cam.position.set(Math.sin(P.yaw) * dd, H * .9 + 1.2, Math.cos(P.yaw) * dd); P.cam.lookAt(0, H * .4, 0);
    P.r.render(P.scene, P.cam);
  }
  stopPreview() { if (this.pvLoop) cancelAnimationFrame(this.pvLoop); this.pvLoop = null }
  /* ---------- driving ---------- */
  pickTrack(carId) {
    const c = this.store.car(carId);
    this.modal(`<small>${tx('Choose a circuit for')}</small><h2>${esc(c.mname)} ${esc(c.trim)}</h2><div class="pickgrid">${this.tracks.map(t => { const r = this.store.record(t.id, c.id); return `<button class="pick" data-a="go:${t.id}:${c.id}">${trackSVG(t, 'trkmini')}<b>${esc(t.short)}</b><small>${r ? fmtTime(r.t) : dec(t.officialM / 1000, 1) + ' ' + tx('km')}</small></button>` }).join('')}</div>`, [[tx('Cancel'), 'close']], true);
  }
  placeMeta(id) {
    const [cid, ch] = id.split('~'), city = (this.cities || []).find(c => c.id === cid);
    if (city) { const c = ch && city.challenges.find(x => x.id === ch); return { id, city, ch: c, name: c ? (LANG === 'bg' ? c.bg : c.en) : this.cityName(city), key: c ? city.id + ':' + c.id : null } }
    return this.tracks.find(x => x.id === id);
  }
  pickCar(trackId) {
    const t = this.placeMeta(trackId);
    if (!this.store.cars.length) return this.modal(`<small>${esc(t.name)}</small><h2>${tx('No cars yet')}</h2><p class="muted">${this.store.engines.length ? tx('Design a car first, then bring it here.') : tx('Start with an engine: pick its layout, size and technology. Then build a car around it.')}</p>`, [[tx('Cancel'), 'close'], this.store.engines.length ? [tx('Design car'), 'newCar', 1] : [tx('Design engine'), 'newEngine', 1]]);
    this.modal(`<small>${esc(t.name)}</small><h2>${tx('Choose your car')}</h2><div class="pickgrid cars">${this.store.cars.slice().reverse().map(c => { const r = t.city ? (t.key ? this.store.record(t.key, c.id) : null) : this.store.record(t.id, c.id); return `<button class="pick" data-a="go:${t.id}:${c.id}">${carSVG(c.body, c.color, c.mname)}<b>${esc(c.mname)} ${esc(c.trim)}</b><small>${r ? fmtTime(r.t) : tx('{v} hp', { v: fn(engStats(this.store.engine(c.eng) || {}).hp || 0) })}</small></button>` }).join('')}</div>`, [[tx('Cancel'), 'close']], true);
  }
  async drive(trackId, carId, mode) {
    const t = this.placeMeta(trackId), c = this.store.car(carId), e = c && this.store.engine(c.eng);
    if (!t || !c || !e) return;
    this.closeModal(); this.closeSheet(); audioCtx();
    if (t.city) { const { CitySession } = await import('./citydrive.js'); this.session = new CitySession(this, { cityId: t.city.id, cityName: this.cityName(t.city), challenge: t.ch?.id, car: c, engine: e, number: (this.store.cars.indexOf(c) % 98) + 1 }); return this.session.start() }
    this.session = new DriveSession(this, { trackMeta: t, car: c, engine: e, mode, number: (this.store.cars.indexOf(c) % 98) + 1 });
    await this.session.start();
  }
  onDriveEnd(res) {
    this.session = null;
    const t = this.tracks.find(x => x.id === res.track);
    this.renderView();
    if (res.best) this.toast(tx('{track}: best lap {t} in {n} laps.', { track: t ? t.short : '', t: fmtTime(res.best), n: res.laps }));
  }
  /* ---------- actions ---------- */
  act(a, el) {
    const [k, x, y] = a.split(':'); const d = this.draft;
    switch (k) {
      case 'tab': this.tab = x; this.renderNav(); this.renderView(); scrollTo(0, 0); break;
      case 'lang': setLang(LANG === 'en' ? 'bg' : 'en'); this.renderTop(); this.renderNav(); this.renderView(); if (this.sheet) this.renderSheet(true); break;
      case 'close': this.closeModal(); break;
      case 'newCar': this.closeModal(); this.openCar(); break;
      case 'editCar': this.openCar(this.store.car(x)); break;
      case 'dupCar': { const c = this.store.car(x); this.store.putCar({ ...c, id: this.store.id('c'), mname: c.mname, trim: (c.trim ? c.trim + ' ' : '') + tx('copy'), equip: c.equip.slice(), src: null }); this.renderView(); break }
      case 'delCar': { const c = this.store.car(x); this.modal(`<h3>${tx('Delete the {name}?', { name: esc(c.mname + ' ' + c.trim) })}</h3><p>${tx('Its lap records are deleted too.')}</p>`, [[tx('Keep it'), 'close'], [tx('Delete'), 'doDelCar:' + x, 1]]); break }
      case 'doDelCar': this.store.delCar(x); this.closeModal(); this.renderView(); break;
      case 'newEngine': this.closeModal(); this.openEngine(); break;
      case 'editEngine': this.openEngine(this.store.engine(x)); break;
      case 'dupEngine': { const e = this.store.engine(x); this.store.putEngine({ ...e, id: this.store.id('e'), name: e.name + ' ' + tx('copy'), src: null }); this.renderView(); break }
      case 'delEngine': if (!this.store.delEngine(x)) this.toast(tx('This engine is fitted to a car. Change or delete those cars first.')); this.renderView(); break;
      case 'closeSheet': this.closeSheet(); break;
      case 'eo': d[x] = y; if (x === 'fuel' && y === 'diesel') { d.bore = Math.max(d.bore, 80); d.stroke = Math.max(d.stroke, 86) } this.fixEngine(); this.renderSheet(true); break;
      case 'saveEngine': { const e = { ...d, id: d.id || this.store.id('e') }; this.store.putEngine(e); this.closeSheet(); this.tab = this.store.cars.length ? 'eng' : 'garage'; this.renderNav(); this.renderView(); this.toast(tx('{name} is ready: {hp}.', { name: e.name, hp: tx('{v} hp', { v: fn(engStats(e).hp) }) })); break }
      case 'co': d[x] = y; this.fixCar(); this.renderSheet(true); break;
      case 'ceng': d.eng = x; this.fixCar(); this.renderSheet(true); break;
      case 'cs': d.equip = d.equip.includes(x) ? d.equip.filter(s => s !== x) : [...d.equip, x]; this.renderSheet(true); break;
      case 'lsd': d.lsd = !d.lsd; this.renderSheet(true); break;
      case 'paint': d.color = '#' + x; this.renderSheet(true); break;
      case 'saveCar': case 'saveDrive': { const c = { ...d, id: d.id || this.store.id('c') }; this.store.putCar(c); this.closeSheet(); this.tab = 'garage'; this.renderNav(); this.renderView(); if (k === 'saveDrive') this.pickTrack(c.id); else this.toast(tx('{name} saved.', { name: c.mname })); break }
      case 'pickTrack': this.pickTrack(x); break;
      case 'clearCity': this.modal(`<h3>${tx('Clear the challenge times?')}</h3><p>${tx('All best times for this city are removed.')}</p>`, [[tx('Keep them'), 'close'], [tx('Clear'), 'doClearCity:' + x, 1]]); break;
      case 'doClearCity': { this.closeModal(); const c = (this.cities || []).find(q => q.id === x); if (c) { for (const ch of c.challenges) this.store.clearRecords(c.id + ':' + ch.id); this.renderView() } break }
      case 'pickCar': this.pickCar(x); break;
      case 'go': this.drive(x, y); break;
      case 'clearRec': this.modal(`<h3>${tx('Clear the records for this track?')}</h3><p>${tx('Lap times and the ghost are removed.')}</p>`, [[tx('Keep them'), 'close'], [tx('Clear'), 'doClearRec:' + x, 1]]); break;
      case 'doClearRec': this.store.clearRecords(x); this.closeModal(); this.renderView(); break;
      case 'set': { let v = y; if (v === 'true') v = true; else if (v === 'false') v = false; else if (!isNaN(+v) && v !== '') v = +v; this.saveSetting(x, v); this.renderView(); break }
      case 'testRumble': this.input.rumble(.8, .5, 400); this.input.triggerRumble(.6, .6, 300); break;
      case 'resetBinds': this.input.resetBinds(); this.renderView(); break;
      case 'rebind': this.rebind(x); break;
      case 'importTycoon': { const r = this.store.importAny(this.store.tycoonSave()); this.closeModal(); this.toast(r.ok ? tx('Imported {e} engines and {c} cars.', { e: r.engines, c: r.cars }) : tx('Nothing to import.')); this.tab = 'garage'; this.renderNav(); this.renderView(); break }
      case 'importCode': { const r = this.store.importAny($('#impcode').value); $('#impmsg').textContent = r.ok ? tx('Imported {e} engines and {c} cars.', { e: r.engines, c: r.cars }) : tx('That code could not be read. Copy the whole code and try again.'); break }
      case 'exportCode': { const code = this.store.exportCode(); $('#impcode').value = code; try { navigator.clipboard.writeText(code).then(() => this.toast(tx('Garage code copied.'))) } catch (e) { } break }
    }
  }
  async rebind(a) {
    if (!this.input.pads().length) { this.toast(tx('Connect a controller first.')); return }
    this.modal(`<h3>${tx('Change: {a}', { a: tx(BIND_N[a]) })}</h3><p>${a === 'steer' ? tx('Move the stick fully to the right.') : tx('Press the button or squeeze the trigger you want to use.')}</p>`, [[tx('Cancel'), 'close']]);
    const b = await this.input.capture(a);
    this.closeModal();
    if (b) { this.input.binds[a] = b; this.input.saveBinds(); this.toast(tx('{a} set to {b}.', { a: tx(BIND_N[a]), b: this.input.label(b) })) }
    this.renderView();
  }
  onInput(e) {
    const t = e.target, k = t.dataset && t.dataset.i; if (!k) return; const d = this.draft;
    if (['steerDead', 'steerGamma', 'trigDead', 'steerSpeed', 'volume'].includes(k)) { this.store.setSetting(k, +t.value); this.applyInputSettings(); const b = t.closest('.field')?.querySelector('b'); if (b) b.textContent = k === 'steerGamma' ? dec(+t.value, 2) : k === 'steerSpeed' ? t.value : Math.round(t.value * 100) + '%'; return }
    if (!d) return;
    if (k === 'year') { d.year = +t.value; $('#dyearv').textContent = t.value; clearTimeout(this.yrT); this.yrT = setTimeout(() => { if (this.sheet === 'engine') this.fixEngine(); else this.fixCar(); this.renderSheet(true) }, 180); return }
    if (k === 'dname') d.name = t.value || 'Engine';
    else if (k === 'mname') d.mname = t.value || 'Car';
    else if (k === 'trim') d.trim = t.value;
    else if (k === 'bore' || k === 'stroke' || k === 'evHp') { d[k] = +t.value; const lab = $(k === 'evHp' ? '#evv' : '#' + k + 'v'); if (lab) lab.textContent = k === 'evHp' ? tx('{v} hp', { v: t.value }) : t.value + ' ' + tx('mm'); this.updateSheetStats() }
    else if (k === 'turbos') { d.turbos = +t.value; $('#turbosv').textContent = d.turbos || tx('None'); const bv = $('#boostv'); if (bv) bv.textContent = d.turbos ? dec(d.boost, 1) + ' bar' : tx('no turbos'); this.updateSheetStats() }
    else if (k === 'boost') { d.boost = +t.value; $('#boostv').textContent = d.turbos ? dec(d.boost, 1) + ' bar' : tx('no turbos'); this.updateSheetStats() }
    else if (k === 'cw') { d.cw = +t.value || null; this.updateSheetStats() }
    else if (k === 'color') { d.color = t.value; const h = $('#chex'); if (h) h.value = t.value; document.querySelectorAll('.swatch').forEach(s => s.setAttribute('aria-pressed', 'false')); this.refreshPreview() }
    else if (k === 'hex') { if (/^#[0-9a-fA-F]{6}$/.test(t.value)) { d.color = t.value.toLowerCase(); const p = $('#cpick'); if (p) p.value = d.color; this.refreshPreview() } }
  }
  onChange(e) { }
}
const BIND_N = { steer: 'Steer', throttle: 'Throttle', brake: 'Brake', shiftUp: 'Shift up', shiftDown: 'Shift down', handbrake: 'Handbrake', camera: 'Camera', lookBack: 'Look back', reset: 'Reset car', pause: 'Pause', autopilot: 'Autopilot' };
