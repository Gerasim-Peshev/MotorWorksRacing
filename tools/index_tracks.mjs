import fs from 'fs';
const order = ['nordschleife', 'spa', 'suzuka', 'a1motorpark', 'catalunya', 'redbullring', 'nurburgring-gp'];
const out = [];
for (const id of order) {
  const f = `tracks/${id}.json`; if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f)); const m = d.pts.length / 5;
  let ymax = -1e9, gmax = 0; const pts = [];
  for (let i = 0; i < m; i++) { ymax = Math.max(ymax, d.pts[i * 5 + 2]); const j = (i + 3) % m; gmax = Math.max(gmax, Math.abs(d.pts[j * 5 + 2] - d.pts[i * 5 + 2]) / (3 * d.ds)) }
  const step = Math.max(1, Math.floor(m / 160));
  for (let i = 0; i < m; i += step) pts.push(Math.round(d.pts[i * 5]), Math.round(d.pts[i * 5 + 1]));
  out.push({ id, name: d.name, short: d.short, country: d.country, place: d.place, lengthM: d.lengthM, officialM: d.officialM, theme: d.theme, alt0: d.alt0, elev: Math.round(ymax), grade: Math.round(gmax * 100), outline: pts, credits: d.credits, bridge: !!d.bridge, estimated: /estimate/i.test((d.credits || []).join(' ')) });
}
fs.writeFileSync('tracks/index.json', JSON.stringify(out));
console.log(out.map(t => `${t.id} ${t.lengthM}m elev ${t.elev}m grade ${t.grade}%`).join('\n'));
