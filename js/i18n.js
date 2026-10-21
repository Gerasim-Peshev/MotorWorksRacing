/* English / Bulgarian, sharing the language choice with MotorWorks Tycoon. */
import { BG } from './bg.js';
import { BG2 } from './bg2.js';
const LANGKEY = 'motorworks-lang';
export let LANG = (() => { try { const v = localStorage.getItem(LANGKEY); if (v === 'en' || v === 'bg') return v } catch (e) { } return (navigator.language || '').toLowerCase().startsWith('bg') ? 'bg' : 'en' })();
export function setLang(l) { LANG = l; try { localStorage.setItem(LANGKEY, l) } catch (e) { } document.documentElement.lang = l }
const fmtP = v => Array.isArray(v) ? v.map(x => tx(x)).join(', ') : v;
export function tx(s, p) {
  let r = s;
  if (LANG === 'bg') { if (BG2[s] !== undefined) r = BG2[s]; else if (BG[s] !== undefined) r = BG[s] }
  if (p) r = r.replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? fmtP(p[k]) : m);
  return r;
}
export const dec = (n, d) => { const s = (+n).toFixed(d); return LANG === 'bg' ? s.replace('.', ',') : s };
export const fn = n => Math.round(n).toLocaleString(LANG === 'bg' ? 'bg-BG' : 'en-US');
export function fmtTime(t) {
  if (t == null || !isFinite(t)) return '–';
  const m = Math.floor(t / 60), s = t - m * 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return (m ? m + ':' + ss : s.toFixed(3)).replace('.', LANG === 'bg' ? ',' : '.');
}
export const FLAG_US = '<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="20" fill="#b22234"/><path d="M0 2.3h30M0 5.4h30M0 8.5h30M0 11.5h30M0 14.6h30M0 17.7h30" stroke="#fff" stroke-width="1.54"/><rect width="13" height="10.8" fill="#3c3b6e"/></svg>';
export const FLAG_BG = '<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="6.67" fill="#fff"/><rect y="6.67" width="30" height="6.67" fill="#00966e"/><rect y="13.33" width="30" height="6.67" fill="#d62612"/></svg>';
