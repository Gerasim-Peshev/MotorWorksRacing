"""Small summary (info.json) and a preview map (preview.svg) for the menus. Run after build_city.py:  python3 make_info.py <city_dir>"""
import sys, os, json, struct, glob, math
import numpy as np
D = sys.argv[1]
meta = json.load(open(os.path.join(D, 'meta.json')))
def read(fn):
    b = open(fn, 'rb').read(); n = struct.unpack('<I', b[4:8])[0]; h = json.loads(b[8:8 + n]); base = 8 + n; out = {}
    T = {'i16': '<i2', 'u16': '<u2', 'u8': 'u1'}
    for k, (ty, off, cnt) in h['arr'].items(): out[k] = np.frombuffer(b, dtype=T[ty], count=cnt, offset=base + off)
    return out
km = 0; nb = 0; nt = 0
def tiles():
    for fn in glob.glob(os.path.join(D, 'p_*.bin')):
        b = open(fn, 'rb').read(); n = struct.unpack('<I', b[4:8])[0]
        for k in range(n):
            i, j, off, ln = struct.unpack('<hhII', b[8 + 12 * k: 20 + 12 * k]); yield b[off:off + ln]
def read_bytes(b):
    n = struct.unpack('<I', b[4:8])[0]; h = json.loads(b[8:8 + n]); base = 8 + n; out = {}
    T = {'i16': '<i2', 'u16': '<u2', 'u8': 'u1'}
    for k, (ty, off, cnt) in h['arr'].items(): out[k] = np.frombuffer(b, dtype=T[ty], count=cnt, offset=base + off)
    return out
for tb in tiles():
    R = read_bytes(tb); rp = R['rp'].reshape(-1, 3).astype(float) / 10; k0 = 0; ra = R['ra'].reshape(-1, 6)
    for n, a in zip(R['rn'], ra):
        if a[0] not in (9, 16, 17): km += np.hypot(*np.diff(rp[k0:k0 + n, :2], axis=0).T).sum()
        k0 += n
    nb += len(R['bn']); nt += len(R['tp']) // 2
# area
A = meta['area']; area = abs(sum(A[k][0] * A[(k + 1) % len(A)][1] - A[(k + 1) % len(A)][0] * A[k][1] for k in range(len(A)))) / 2
info = dict(id=meta['id'], name=meta['name'], km2=round(area / 1e6), streetKm=round(km / 1000), buildings=nb, trees=nt,
            challenges=[dict(id=c['id'], en=c['en'], bg=c['bg'], a=c['a'], b=c['b'], km=c['km']) for c in meta['challenges']],
            landmarks={k: dict(en=v['en'], bg=v['bg']) for k, v in meta['landmarks'].items()}, credits=meta['credits'])
json.dump(info, open(os.path.join(D, 'info.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
# preview: main roads from the network + the map edge + landmarks
b = open(os.path.join(D, 'net.bin'), 'rb').read(); nN, nE = struct.unpack('<II', b[4:12]); o = 12 + nN * 8
E = np.frombuffer(b, '<u4', nE * 5, o).reshape(-1, 5); o += nE * 20; o += nE * 4; PC = np.frombuffer(b, '<u2', nE, o); o += nE * 2
while o % 4: o += 1
nP = struct.unpack('<I', b[o:o + 4])[0]; P = np.frombuffer(b, '<f4', nP * 2, o + 4).reshape(-1, 2)
xs = [p[0] for p in A]; zs = [p[1] for p in A]; x0, x1, z0, z1 = min(xs) - 300, max(xs) + 300, min(zs) - 300, max(zs) + 300
W = 400; sc = W / (x1 - x0); H = round((z1 - z0) * sc)
f = lambda x, z: f'{(x - x0) * sc:.0f},{(z - z0) * sc:.0f}'
paths = {1: [], 2: [], 3: []}
for e in range(nE):
    c = E[e, 2] & 255; g = 1 if c in (1, 2) else 2 if c in (3,) else 0
    if not g: continue
    s, n = E[e, 3], PC[e]; pts = P[s:s + n]
    q = [f(x, z) for x, z in pts[::max(1, n // 3)].tolist() + [pts[-1].tolist()]]; q = [v for k, v in enumerate(q) if k == 0 or v != q[k - 1]]
    if len(q) > 1: paths[g].append('M' + ' '.join(q))
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" fill="none" stroke-linecap="round" stroke-linejoin="round">',
       f'<path d="M{" ".join(f(x, z) for x, z in A)}Z" fill="#cfd6c9" stroke="#18201b" stroke-width="1.5" stroke-dasharray="4 3"/>',
       f'<path d="{" ".join(paths[3])}" stroke="#7a857d" stroke-width=".8"/>',
       f'<path d="{" ".join(paths[2])}" stroke="#18201b" stroke-width="1.3"/>',
       f'<path d="{" ".join(paths[1])}" stroke="#f2b705" stroke-width="2.6"/>']
for c in meta['challenges']:
    for k, col in ((c['a'], '#1f8fbf'), (c['b'], '#c2412d')):
        L = meta['landmarks'][k]; svg.append(f'<circle cx="{(L["x"] - x0) * sc:.1f}" cy="{(L["z"] - z0) * sc:.1f}" r="3" fill="{col}" stroke="#fff" stroke-width="1"/>')
svg.append('</svg>')
open(os.path.join(D, 'preview.svg'), 'w').write('\n'.join(svg))
print('info', {k: info[k] for k in ('km2', 'streetKm', 'buildings', 'trees')}, 'preview KB', round(os.path.getsize(os.path.join(D, 'preview.svg')) / 1e3))
