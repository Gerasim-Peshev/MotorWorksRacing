"""A1 Motor Park (Samokov, BG): layout traced from the official circuit map, scaled to the official 3.910 km.
No open elevation data was reachable for this circuit, so heights are a gentle estimate (marked in the credits)."""
import numpy as np, json, sys, math
from scipy.ndimage import gaussian_filter1d, gaussian_filter
PATH, OUT = sys.argv[1], sys.argv[2]
OFFICIAL = 3910.0
P = np.load(PATH)                     # image px, x right, y down, in driving order, starting on the start straight
def resample(Q, n):
    Q2 = np.vstack([Q, Q[:1]]); s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(Q2, axis=0), axis=1))])
    t = np.linspace(0, s[-1], n, endpoint=False); return np.stack([np.interp(t, s, Q2[:, k]) for k in range(Q.shape[1])], 1), s[-1]
# to metres: x east, y north (image up = north)
L0 = np.linalg.norm(np.diff(np.vstack([P, P[:1]]), axis=0), axis=1).sum()
sc = OFFICIAL / L0
M = np.stack([(P[:, 0] - P[:, 0].mean()) * sc, -(P[:, 1] - P[:, 1].mean()) * sc], 1)
M, L = resample(M, int(OFFICIAL))
M = gaussian_filter1d(M, 4.0, axis=0, mode='wrap')
M, L = resample(M, int(L)); M = gaussian_filter1d(M, 2.0, axis=0, mode='wrap')
M *= OFFICIAL / np.linalg.norm(np.diff(np.vstack([M, M[:1]]), axis=0), axis=1).sum()
M, L = resample(M, 3910)
n = len(M); ds = L / n
# start/finish under the arrow on the map (about 70 m along the start straight from where the trace begins)
sf = int(round(75 / ds)); M = np.roll(M, -sf, 0)
t = np.roll(M, -1, 0) - np.roll(M, 1, 0); t /= np.linalg.norm(t, axis=1, keepdims=True)
ang = np.arctan2(t[:, 1], t[:, 0]); k = np.angle(np.exp(1j * (np.roll(ang, -1) - np.roll(ang, 1)))) / (2 * ds)
ks = gaussian_filter1d(np.abs(k), 25, mode='wrap')
straight = gaussian_filter1d((ks < 1 / 450).astype(float), 30, mode='wrap')
half = 6.0 + 1.0 * straight                                   # 12 m, 14 m on the straights
signed_turn = np.sum(k * ds)
print(f'length {L:.0f} m, scale {sc:.3f} m/px, total turning {math.degrees(signed_turn):.0f} deg ({"anticlockwise" if signed_turn > 0 else "clockwise"}), min radius {1/np.abs(gaussian_filter1d(k,3,mode="wrap")).max():.1f} m')
# straights
runs, cur = [], 0
for i in range(n):
    if ks[i] < 1 / 450: cur += ds
    else:
        if cur > 150: runs.append(round(cur))
        cur = 0
print('straights (m):', sorted(runs, reverse=True)[:4])
# ---- terrain: Samokov valley floor ~950 m, Rila foothills rising to the south, Plana hills to the north
rng = np.random.default_rng(42)
def natural(x, y):
    base = 5.0 * np.sin(x / 210 + .7) + 4.2 * np.cos(y / 160 - .4) + 2.6 * np.sin((x + y) / 95) + .016 * y
    south = np.clip((-y - 650) / 2700, 0, 1) ** 1.35 * 720       # Rila rising south
    north = np.clip((y - 850) / 2300, 0, 1) ** 1.3 * 340        # Plana hills north
    ridges = (south + north) * (.8 + .2 * np.sin(x / 400) * np.cos(y / 330))
    return base + ridges
h = natural(M[:, 0], M[:, 1])
h = gaussian_filter1d(h, 18, mode='wrap')
g = np.gradient(h, ds); print(f'elevation range {h.max() - h.min():.1f} m, max grade {np.abs(g).max() * 100:.1f}%')
alt0 = float(h.min())
# ---- racing line (same minimum-curvature solver as the other circuits)
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix
def min_curvature_line(P, wl, wr, margin=1.25, lam=1e-5):
    n = len(P)
    t = np.roll(P, -1, 0) - np.roll(P, 1, 0); t /= np.linalg.norm(t, axis=1, keepdims=True)
    N = np.stack([-t[:, 1], t[:, 0]], 1)
    def curv(Lq):
        a = Lq - np.roll(Lq, 1, 0); b = np.roll(Lq, -1, 0) - Lq; c = a + b
        la = np.linalg.norm(a, axis=1); lb = np.linalg.norm(b, axis=1); lc = np.linalg.norm(c, axis=1)
        return 2 * (a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]) / (la * lb * lc + 1e-9), (la + lb) / 2
    def resid(o):
        kk, d2 = curv(P + N * o[:, None]); return np.concatenate([kk * np.sqrt(d2) * 10, np.sqrt(lam) * o])
    S = lil_matrix((2 * n, n))
    for j in range(n):
        for d in (-1, 0, 1): S[j, (j + d) % n] = 1
        S[n + j, j] = 1
    r = least_squares(resid, np.zeros(n), jac_sparsity=S.tocsr(), bounds=(-(np.asarray(wr) - margin), np.asarray(wl) - margin), method='trf', max_nfev=250)
    kP, _ = curv(P); kL, _ = curv(P + N * r.x[:, None])
    print(f'racing line: min radius centre {1/np.abs(kP).max():.1f} m -> line {1/np.abs(kL).max():.1f} m')
    return r.x
OUT_DS = 4.0
m = int(round(L / OUT_DS)); sel = np.linspace(0, n, m, endpoint=False)
def at(a):
    ii = np.floor(sel).astype(int); f = sel - ii; a2 = np.concatenate([a, a[:1]], 0)
    return a2[ii] * (1 - f[:, None] if a.ndim > 1 else 1 - f) + a2[ii + 1] * (f[:, None] if a.ndim > 1 else f)
Pe, he, we = at(M), at(h), at(half)
rl = min_curvature_line(Pe, we, we)
pts = []
for (x, y), hh, w in zip(Pe, he, we): pts += [round(float(x), 2), round(float(-y), 2), round(float(hh - alt0), 2), round(float(w), 2), round(float(w), 2)]
# terrain grid, 100 m spacing over +-5.5 km, row 0 = north
E = 5500; cols = rows = 111
xs = np.linspace(-E, E, cols); ys = np.linspace(E, -E, rows)
X, Y = np.meshgrid(xs, ys); H = natural(X, Y) - alt0
terrain = dict(x0=-E, n0=E, x1=E, n1=-E, cols=cols, rows=rows, h=[round(float(v), 1) for v in H.ravel()])
bounds = [float(M[:, 0].min()), float(-M[:, 1].max()), float(M[:, 0].max()), float(-M[:, 1].min())]
out = dict(id='a1motorpark', name='A1 Motor Park', short='A1 Motor Park', country='BG', place='Samokov, Bulgaria', lengthM=round(float(L)), officialM=3910,
           alt0=round(950 + 0.0, 1), origin=[42.3152361, 23.5383778], theme='balkan', ds=round(L / m, 4), bridge=None, terrainMargin=4200,
           bounds=[round(v, 1) for v in bounds], pts=pts, rl=[round(float(v), 2) for v in rl], terrain=terrain,
           credits=['Layout traced from the official A1 Motor Park circuit map, scaled to the official 3.910 km',
                    'Elevation and surrounding terrain are an estimate, not survey data'])
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
print('wrote', OUT, m, 'points')
