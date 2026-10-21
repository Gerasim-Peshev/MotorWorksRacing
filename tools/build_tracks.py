"""Build game track files from real data.
Geometry: OpenStreetMap traces (open-racetrack-db, ODbL).
Widths + start/finish: TUMFTM racetrack-database (LGPL-3.0), aligned onto the OSM trace.
Elevation: Mapzen Terrain Tiles grids shipped with open-racetrack-db.
"""
import json, os, sys, math
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial import cKDTree
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt

ORDB = os.environ.get('ORDB', 'open-racetrack-db/data')
TUM = os.environ.get('TUM', 'racetrack-database/tracks')
OUT = sys.argv[1] if len(sys.argv) > 1 else 'tracks'
PLOTS = os.environ.get('PLOTS', '/tmp')
os.makedirs(OUT, exist_ok=True)
R_EARTH = 6371008.8
DS = 1.0      # working resolution (m)
OUT_DS = 4.0  # exported resolution (m)

TRACKS = {
  'nordschleife': dict(name='Nürburgring Nordschleife', short='Nordschleife', country='DE', place='Nürburg, Germany',
      geo='germany/nurburgring/layouts/nordschleife.geojson', elev='de-nurburgring', tum=None, official=20832,
      width=9.6, sf=('near_gp',), theme='forest'),
  'spa': dict(name='Circuit de Spa-Francorchamps', short='Spa', country='BE', place='Stavelot, Belgium',
      geo='belgium/spa-francorchamps/layouts/grand-prix.geojson', elev='be-spa-francorchamps', tum='Spa', official=7004,
      width=11.0, sf=('tum',), theme='ardennes'),
  'suzuka': dict(name='Suzuka Circuit', short='Suzuka', country='JP', place='Suzuka, Japan',
      geo='japan/suzuka-circuit-175231434/layouts/suzuka.geojson', elev='jp-suzuka-circuit-175231434', tum='Suzuka', official=5807,
      width=11.0, sf=('tum',), theme='japan', bridge='second'),
  'catalunya': dict(name='Circuit de Barcelona-Catalunya', short='Barcelona', country='ES', place='Montmeló, Spain',
      geo='spain/barcelona-catalunya/layouts/grand-prix.geojson', elev='es-barcelona-catalunya', tum='Catalunya', official=4657,
      width=12.5, sf=('tum',), theme='dry'),
  'redbullring': dict(name='Red Bull Ring', short='Red Bull Ring', country='AT', place='Spielberg, Austria',
      geo='austria/red-bull-ring-84416610/layouts/main.geojson', elev='at-red-bull-ring-84416610', tum='Spielberg', official=4318,
      width=12.0, sf=('tum',), theme='alpine'),
  'nurburgring-gp': dict(name='Nürburgring GP-Strecke', short='Nürburgring GP', country='DE', place='Nürburg, Germany',
      geo='germany/nurburgring/layouts/grand-prix.geojson', elev='de-nurburgring', tum='Nuerburgring', official=5148,
      width=12.5, sf=('tum',), theme='eifel'),
}

def proj(lonlat, lat0, lon0):
    x = np.radians(lonlat[:, 0] - lon0) * R_EARTH * math.cos(math.radians(lat0))
    y = np.radians(lonlat[:, 1] - lat0) * R_EARTH
    return np.stack([x, y], 1)

def unproj(P, lat0, lon0):
    lon = lon0 + np.degrees(P[:, 0] / (R_EARTH * math.cos(math.radians(lat0))))
    lat = lat0 + np.degrees(P[:, 1] / R_EARTH)
    return np.stack([lon, lat], 1)

def resample_closed(P, ds=None, n=None):
    Q = np.vstack([P, P[:1]])
    seg = np.linalg.norm(np.diff(Q, axis=0), axis=1)
    keep = np.concatenate([[True], seg > 1e-6])
    Q = Q[keep]; seg = np.linalg.norm(np.diff(Q, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)]); L = s[-1]
    if n is None: n = int(round(L / ds))
    t = np.linspace(0, L, n, endpoint=False)
    out = np.stack([np.interp(t, s, Q[:, k]) for k in range(Q.shape[1])], 1)
    return out, L

def smooth_closed(P, sigma_pts):
    return gaussian_filter1d(P, sigma_pts, axis=0, mode='wrap')

def umeyama(A, B):
    """find s,R,t with A ≈ s R B + t"""
    ma, mb = A.mean(0), B.mean(0)
    Ac, Bc = A - ma, B - mb
    C = Ac.T @ Bc / len(A)
    U, S, Vt = np.linalg.svd(C)
    d = np.sign(np.linalg.det(U @ Vt)); D = np.diag([1, d])
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / (Bc ** 2).sum(1).mean()
    t = ma - s * R @ mb
    return s, R, t

def align_tum(P, T):
    """align TUM centreline T (N,2) onto OSM trace P (fine, closed). returns transformed T."""
    N = 400
    A, _ = resample_closed(P, n=N)
    B, _ = resample_closed(T, n=N)
    best = None
    for k in range(N):
        Bk = np.roll(B, -k, axis=0)
        s, R, t = umeyama(A, Bk)
        err = np.sqrt(((A - (s * (R @ Bk.T).T + t)) ** 2).sum(1).mean())
        if best is None or err < best[0]: best = (err, s, R, t)
    err, s, R, t = best
    tree = cKDTree(P)
    for it in range(15):
        Tt = s * (R @ T.T).T + t
        d, idx = tree.query(Tt)
        thr = max(6.0, np.percentile(d, 80))
        m = d < thr
        s, R, t = umeyama(P[idx[m]], T[m])
    Tt = s * (R @ T.T).T + t
    d, _ = tree.query(Tt)
    print(f'   TUM align: coarse rms {err:.1f}m, scale {s:.4f}, rot {math.degrees(math.atan2(R[1,0],R[0,0])):.1f}deg, '
          f'median fit {np.median(d):.2f}m, p90 {np.percentile(d,90):.2f}m')
    return Tt, R

def normals(P):
    tng = np.roll(P, -1, 0) - np.roll(P, 1, 0)
    tng /= np.linalg.norm(tng, axis=1, keepdims=True)
    nl = np.stack([-tng[:, 1], tng[:, 0]], 1)  # left normal in x-east/y-north
    return tng, nl

def curvature(P, ds):
    tng, _ = normals(P)
    ang = np.arctan2(tng[:, 1], tng[:, 0])
    dang = np.angle(np.exp(1j * (np.roll(ang, -1) - np.roll(ang, 1))))
    return dang / (2 * ds)

def load_dem(key):
    e = json.load(open(f'{ORDB}/elevation/{key}.json'))
    H = np.array([np.nan if v is None else v for v in e['heights']], float).reshape(e['rows'], e['columns'])
    if np.isnan(H).any():
        # fill gaps with nearest valid
        from scipy.ndimage import distance_transform_edt
        idx = distance_transform_edt(np.isnan(H), return_distances=False, return_indices=True)
        H = H[tuple(idx)]
    return e, H

def sample_dem(e, H, lonlat):
    west, south, east, north = e['bounds']
    cols, rows = e['columns'], e['rows']
    x = (lonlat[:, 0] - west) / (east - west) * (cols - 1)
    y = (north - lonlat[:, 1]) / (north - south) * (rows - 1)
    x = np.clip(x, 0, cols - 1.001); y = np.clip(y, 0, rows - 1.001)
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    tx, ty = x - x0, y - y0
    a = H[y0, x0]; b = H[y0, x0 + 1]; c = H[y0 + 1, x0]; d = H[y0 + 1, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty

def seg_intersections(P, step, min_sep):
    Q = P[::step]; n = len(Q)
    A = Q; B = np.roll(Q, -1, 0)
    hits = []
    for i in range(n):
        p, r = A[i], B[i] - A[i]
        q, sv = A, B - A
        den = r[0] * sv[:, 1] - r[1] * sv[:, 0]
        with np.errstate(divide='ignore', invalid='ignore'):
            t = ((q[:, 0] - p[0]) * sv[:, 1] - (q[:, 1] - p[1]) * sv[:, 0]) / den
            u = ((q[:, 0] - p[0]) * r[1] - (q[:, 1] - p[1]) * r[0]) / den
        ok = (t >= 0) & (t < 1) & (u >= 0) & (u < 1) & (np.abs(den) > 1e-9)
        for j in np.where(ok)[0]:
            sep = abs(j - i) * step
            sep = min(sep, len(P) - sep)
            if j > i and sep > min_sep:
                hits.append((i * step, j * step))
    return hits

GP_SF_LONLAT = None
from scipy.sparse import lil_matrix, vstack, identity, csr_matrix
from scipy.optimize import lsq_linear
def min_curvature_line(P, wl, wr, margin=1.25, lam=1e-5):
    """minimise the integral of curvature^2 along the line (exact Menger curvature), offsets bounded by the track edges"""
    from scipy.optimize import least_squares
    from scipy.sparse import lil_matrix
    n = len(P)
    t = np.roll(P, -1, 0) - np.roll(P, 1, 0); t /= np.linalg.norm(t, axis=1, keepdims=True)
    N = np.stack([-t[:, 1], t[:, 0]], 1)
    def curv(L):
        a = L - np.roll(L, 1, 0); b = np.roll(L, -1, 0) - L; c = a + b
        la = np.linalg.norm(a, axis=1); lb = np.linalg.norm(b, axis=1); lc = np.linalg.norm(c, axis=1)
        return 2 * (a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]) / (la * lb * lc + 1e-9), (la + lb) / 2
    def resid(o):
        k, ds = curv(P + N * o[:, None])
        return np.concatenate([k * np.sqrt(ds) * 10, np.sqrt(lam) * o])
    S = lil_matrix((2 * n, n))
    for j in range(n):
        for d in (-1, 0, 1): S[j, (j + d) % n] = 1
        S[n + j, j] = 1
    lo = -(np.asarray(wr) - margin); hi = np.asarray(wl) - margin
    r = least_squares(resid, np.zeros(n), jac_sparsity=S.tocsr(), bounds=(lo, hi), method='trf', max_nfev=250)
    o = r.x
    kP, _ = curv(P); kL, _ = curv(P + N * o[:, None])
    print(f'   racing line: min radius centre {1/np.abs(kP).max():.1f} m -> line {1/np.abs(kL).max():.1f} m')
    return o
results = {}
ORDER=['nurburgring-gp','nordschleife','spa','suzuka','catalunya','redbullring']
for key in ORDER:
    cfg = TRACKS[key]
    print('==', key)
    g = json.load(open(os.path.join(ORDB, cfg['geo'])))
    tr = [f for f in g['features'] if f['properties'].get('role') == 'trace'][0]
    ll = np.array(tr['geometry']['coordinates'], float)
    if np.allclose(ll[0], ll[-1]): ll = ll[:-1]
    lat0, lon0 = ll[:, 1].mean(), ll[:, 0].mean()
    P0 = proj(ll, lat0, lon0)
    P, L = resample_closed(P0, ds=DS)
    P = smooth_closed(P, 5.0 / DS)
    P, L = resample_closed(P, ds=DS)
    P = smooth_closed(P, 2.5 / DS)
    P, L = resample_closed(P, n=int(round(L / DS)))
    ds = L / len(P)
    n = len(P)
    tng, nl = normals(P)
    # ---- widths
    half = cfg['width'] / 2
    wl = np.full(n, half); wr = np.full(n, half)
    sf_idx = 0
    if cfg['tum']:
        T = np.loadtxt(f"{TUM}/{cfg['tum']}.csv", delimiter=',', comments='#')
        Tt, Rm = align_tum(P, T[:, :2])
        tree = cKDTree(Tt)
        d, idx = tree.query(P)
        off = ((Tt[idx] - P) * nl).sum(1)          # TUM centre offset to the left
        twr, twl = T[idx, 2], T[idx, 3]
        good = d < 9
        wl_t = np.clip(twl + off, 3.6, 16); wr_t = np.clip(twr - off, 3.6, 16)
        med = np.median((twl + twr)[good]) / 2
        wl = np.where(good, wl_t, med); wr = np.where(good, wr_t, med)
        wl = gaussian_filter1d(wl, 25 / ds, mode='wrap'); wr = gaussian_filter1d(wr, 25 / ds, mode='wrap')
        print(f'   width matched {good.mean()*100:.0f}% of trace; total width mean {(wl+wr).mean():.1f} min {(wl+wr).min():.1f} max {(wl+wr).max():.1f}')
        # start/finish = TUM first point
        sf_idx = int(cKDTree(P).query(Tt[0])[1])
        # sanity: TUM direction must match
        dirdot = (tng[sf_idx] * (Tt[3] - Tt[0])).sum()
        print('   S/F from TUM index', sf_idx, 'direction agree', dirdot > 0)
    else:
        # Nordschleife: gentle width variation, wider on Döttinger Höhe-type straights
        rng = np.random.default_rng(7)
        noise = gaussian_filter1d(rng.normal(0, 1, n), 120 / ds, mode='wrap')
        noise = noise / (np.abs(noise).max() + 1e-9)
        k = np.abs(gaussian_filter1d(curvature(P, ds), 30 / ds, mode='wrap'))
        straight = gaussian_filter1d((k < 1 / 1500).astype(float), 60 / ds, mode='wrap')
        wl = half + 0.6 * noise + 0.8 * straight
        wr = half + 0.6 * np.roll(noise, 300) + 0.8 * straight
        if cfg['sf'][0] == 'near_gp' and GP_SF_LONLAT is not None:
            gp = proj(GP_SF_LONLAT[None, :], lat0, lon0)[0]
            dists = np.linalg.norm(P - gp, axis=1)
            sf_idx = int(np.argmin(dists))
            print('   S/F nearest GP start/finish, distance', round(float(dists[sf_idx])), 'm')
    # ---- rotate so index 0 = start/finish
    roll = -sf_idx
    P = np.roll(P, roll, 0); wl = np.roll(wl, roll); wr = np.roll(wr, roll)
    tng, nl = normals(P)
    if key == 'nurburgring-gp':
        GP_SF_LONLAT = unproj(P[:1], lat0, lon0)[0]
    # ---- elevation
    e, H = load_dem(cfg['elev'])
    lonlat = unproj(P, lat0, lon0)
    west, south, east, north = e['bounds']
    inside = (lonlat[:, 0] >= west) & (lonlat[:, 0] <= east) & (lonlat[:, 1] >= south) & (lonlat[:, 1] <= north)
    print('   DEM covers', f'{inside.mean()*100:.1f}% of trace')
    h = sample_dem(e, H, lonlat)
    h = gaussian_filter1d(h, 30 / ds, mode='wrap')
    # bridges / crossovers
    hits = seg_intersections(P, 5, 200)
    bridge = None
    if hits:
        print('   crossings', hits)
        if cfg.get('bridge'):
            i, j = hits[0]
            up, low = (j, i) if cfg['bridge'] == 'second' else (i, j)
            need = h[low] + 8.0 - h[up]
            idxs = np.arange(n)
            dd = np.abs(idxs - up); dd = np.minimum(dd, n - dd) * ds
            w = np.where(dd < 260, 0.5 * (1 + np.cos(np.pi * dd / 260)), 0)
            if need > 0: h = h + need * w
            dd2 = np.abs(idxs - low); dd2 = np.minimum(dd2, n - dd2) * ds
            bridge = dict(upper=int(up), lower=int(low))
            print(f'   bridge: upper idx {up} (raised {need:.1f} m), lower idx {low}')
    grade = np.gradient(h, ds)
    alt0 = float(h.min())
    k = curvature(P, ds)
    print(f'   length {L:.0f} m (official {cfg["official"]}), elev range {h.max()-h.min():.0f} m '
          f'({h.min():.0f}-{h.max():.0f} m asl), max grade +{grade.max()*100:.1f}% / {grade.min()*100:.1f}%, '
          f'min radius {1/np.abs(k).max():.1f} m')
    # ---- terrain grid (local coordinates)
    cols, rows = e['columns'], e['rows']
    corner = proj(np.array([[west, north], [east, south]]), lat0, lon0)
    terrain = dict(x0=round(float(corner[0, 0]), 1), n0=round(float(corner[0, 1]), 1),
                   x1=round(float(corner[1, 0]), 1), n1=round(float(corner[1, 1]), 1),
                   cols=cols, rows=rows, h=[round(float(v - alt0), 1) for v in H.ravel()])
    # ---- export at OUT_DS
    m = int(round(L / OUT_DS))
    sel = np.linspace(0, n, m, endpoint=False)
    def at(a):
        ii = np.floor(sel).astype(int); f = sel - ii
        a2 = np.concatenate([a, a[:1]], 0)
        return a2[ii] * (1 - f[:, None] if a.ndim > 1 else 1 - f) + a2[ii + 1] * (f[:, None] if a.ndim > 1 else f)
    Pe, he, wle, wre = at(P), at(h), at(wl), at(wr)
    # x east, z = -north
    pts = []
    for (x, y), hh, a, b in zip(Pe, he, wle, wre):
        pts += [round(float(x), 2), round(float(-y), 2), round(float(hh - alt0), 2), round(float(a), 2), round(float(b), 2)]
    rl = min_curvature_line(Pe, wle, wre)
    bounds = [float(P[:, 0].min()), float(-P[:, 1].max()), float(P[:, 0].max()), float(-P[:, 1].min())]
    out = dict(id=key, name=cfg['name'], short=cfg['short'], country=cfg['country'], place=cfg['place'],
               lengthM=round(float(L)), officialM=cfg['official'], alt0=round(alt0, 1),
               origin=[round(lat0, 7), round(lon0, 7)], theme=cfg['theme'], ds=round(L / m, 4),
               bridge=None if bridge is None else dict(upper=round(bridge['upper'] * ds / (L / m)), lower=round(bridge['lower'] * ds / (L / m))),
               bounds=[round(v, 1) for v in bounds], pts=pts, rl=[round(float(v), 2) for v in rl], terrain=terrain,
               credits=['Track geometry © OpenStreetMap contributors (ODbL), via Open Racetrack DB',
                        'Terrain: Mapzen Terrain Tiles (USGS, NOAA, Copernicus EU-DEM)'] +
                       (['Track widths & start line: TUMFTM racetrack-database (LGPL-3.0)'] if cfg['tum'] else []))
    with open(f'{OUT}/{key}.json', 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print('   wrote', f'{OUT}/{key}.json', os.path.getsize(f'{OUT}/{key}.json') // 1024, 'KB', m, 'pts')
    # ---- preview
    fig, ax = plt.subplots(1, 2, figsize=(18, 8), gridspec_kw=dict(width_ratios=[1.1, 1]))
    sc = ax[0].scatter(P[::4, 0], P[::4, 1], c=h[::4] - alt0, s=2, cmap='terrain')
    plt.colorbar(sc, ax=ax[0])
    for d0 in range(0, int(L), 500):
        i = int(d0 / ds); ax[0].annotate(f'{d0}', P[i], fontsize=7)
    ax[0].plot(P[0, 0], P[0, 1], 'r*', ms=18)
    ax[0].arrow(P[0, 0], P[0, 1], tng[0, 0] * 150, tng[0, 1] * 150, width=10, color='r')
    if cfg['tum']:
        ax[0].plot(Tt[:, 0], Tt[:, 1], 'k-', lw=0.4, alpha=0.6)
    ax[0].set_aspect('equal'); ax[0].set_title(f'{key}  S/F=red star, numbers = metres from S/F')
    sdist = np.arange(n) * ds
    ax[1].plot(sdist, h, lw=1); ax[1].set_title('elevation (m asl) vs distance'); ax[1].grid(alpha=.3)
    ax2 = ax[1].twinx(); ax2.plot(sdist, wl + wr, 'g', lw=0.6, alpha=.6); ax2.set_ylabel('width')
    plt.tight_layout(); plt.savefig(f'{PLOTS}/final_{key}.png', dpi=65); plt.close()
