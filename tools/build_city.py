"""Build a free-roam city package (Sofia) from city_extract.py output and an SRTM .hgt(.gz) tile.
Usage: python3 build_city.py sofia_raw.pkl N42E023.hgt.gz ../cities/sofia
Writes: sofia.json (meta, names, places, spawn points), terrain.bin, far.bin, r_<rx>_<rz>.bin (tiles of streets, markings,
crossings, signals, buildings, trees, land cover). Coordinates: metres, x east, z south, from a transverse Mercator centred on the city."""
import pickle, json, math, sys, os, struct, gzip, collections
import numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon, LineString, Point, box, MultiPolygon, GeometryCollection, MultiLineString
from shapely.ops import unary_union
from shapely import STRtree, make_valid
import shapely
from scipy.ndimage import gaussian_filter, map_coordinates, minimum_filter
from scipy.spatial import cKDTree

RAW, HGT, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
LON0, LAT0 = 23.3219, 42.6977
CITY = (23.185, 42.605, 23.465, 42.775)          # game area (lon/lat)
TILE, REG, TSTEP, FSTEP = 500, 8, 25.0, 200.0
rng = np.random.default_rng(42)
fwd = Transformer.from_crs('EPSG:4326', f'+proj=tmerc +lat_0={LAT0} +lon_0={LON0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84', always_xy=True)
inv = Transformer.from_crs(f'+proj=tmerc +lat_0={LAT0} +lon_0={LON0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84', 'EPSG:4326', always_xy=True)
def proj(pts):
    a = np.asarray(pts, float); x, y = fwd.transform(a[:, 0], a[:, 1]); return np.stack([x, -y], 1)
def unproj(x, z): return inv.transform(np.asarray(x, float), -np.asarray(z, float))

D = pickle.load(open(RAW, 'rb'))
cx, cz = proj([(CITY[0], CITY[1]), (CITY[2], CITY[3]), (CITY[0], CITY[3]), (CITY[2], CITY[1])]).T
X0, X1 = math.floor(cx.min() / TILE) * TILE, math.ceil(cx.max() / TILE) * TILE
Z0, Z1 = math.floor(cz.min() / TILE) * TILE, math.ceil(cz.max() / TILE) * TILE
NX, NZ = (X1 - X0) // TILE, (Z1 - Z0) // TILE
AREA = box(X0, Z0, X1, Z1)
print(f'game area {X1 - X0} x {Z1 - Z0} m, {NX} x {NZ} tiles')

# ------------------------------------------------------------------ terrain
raw = gzip.open(HGT).read() if HGT.endswith('.gz') else open(HGT, 'rb').read()
n = int(round(math.sqrt(len(raw) // 2))); H = np.frombuffer(raw, '>i2').reshape(n, n).astype(np.float32)
bad = H < -1000
if bad.any():
    from scipy.ndimage import distance_transform_edt
    idx = distance_transform_edt(bad, return_distances=False, return_indices=True); H = H[tuple(idx)]
HLAT, HLON = 43.0, 23.0     # north-west corner of the tile (N42E023)
def hgt_at(x, z, sigma_px=0):
    lon, lat = unproj(x, z)
    col = (lon - HLON) * (n - 1); row = (HLAT - lat) * (n - 1)
    src = gaussian_filter(H, sigma_px) if sigma_px else H
    return map_coordinates(src, [row.ravel(), col.ravel()], order=1, mode='nearest').reshape(np.shape(x))
TM = 500   # terrain margin around the game area
tx0, tz0 = X0 - TM, Z0 - TM
tnx, tnz = int((X1 - X0 + 2 * TM) / TSTEP) + 1, int((Z1 - Z0 + 2 * TM) / TSTEP) + 1
gx, gz = np.meshgrid(tx0 + np.arange(tnx) * TSTEP, tz0 + np.arange(tnz) * TSTEP)
T = hgt_at(gx, gz, sigma_px=0.6)
T = gaussian_filter(T, 1.5)                          # ~40 m: removes the urban canopy noise in SRTM
T_dm = np.round(T * 10).astype('<i2')
T_dm.tofile(f'{OUT}/terrain.bin')
def terrain(x, z):          # bilinear on the stored grid (same as the game)
    fx = (np.asarray(x) - tx0) / TSTEP; fz = (np.asarray(z) - tz0) / TSTEP
    return map_coordinates(T, [fz, fx], order=1, mode='nearest')
print(f'terrain {tnx} x {tnz} @ {TSTEP} m, {T.min():.0f}..{T.max():.0f} m')

# ------------------------------------------------------------------ helpers
def ring_xy(r): return proj(r)
def simp_line(P, tol):
    if len(P) < 3: return P
    return np.asarray(LineString(P).simplify(tol, preserve_topology=False).coords)
def tile_of(x, z): return int((x - X0) // TILE), int((z - Z0) // TILE)
def inside_area(x, z): return X0 <= x < X1 and Z0 <= z < Z1
tiles = collections.defaultdict(lambda: dict(roads=[], discs=[], marks=[], cross=[], signals=[], bld=[], trees=[], cover=[]))

# ------------------------------------------------------------------ names
names, name_idx = [], {}
def nid(bg, en):
    if not bg: return 0xFFFF
    k = (bg, en or '')
    if k not in name_idx: name_idx[k] = len(names); names.append([bg, en or ''])
    return name_idx[k]

# ------------------------------------------------------------------ roads
CLS = {'motorway': 0, 'trunk': 0, 'motorway_link': 0, 'trunk_link': 0, 'primary': 1, 'secondary': 1, 'primary_link': 1, 'secondary_link': 1,
       'tertiary': 2, 'tertiary_link': 2, 'unclassified': 2, 'residential': 2, 'road': 2, 'living_street': 2, 'service': 3, 'pedestrian': 4}
RANK = {'motorway': 9, 'trunk': 8, 'primary': 7, 'secondary': 6, 'tertiary': 5, 'motorway_link': 5, 'trunk_link': 5, 'primary_link': 4, 'secondary_link': 4, 'tertiary_link': 3,
        'unclassified': 3, 'residential': 2, 'road': 2, 'living_street': 1, 'pedestrian': 1, 'service': 0}
COBBLE = {'sett', 'cobblestone', 'unhewn_cobblestone', 'paving_stones'}
UNPAVED = {'unpaved', 'gravel', 'dirt', 'ground', 'compacted', 'fine_gravel', 'grass', 'earth', 'mud', 'sand', 'pebblestone'}
ONEWAY_W = {'motorway': 11.5, 'trunk': 10, 'primary': 8, 'secondary': 7, 'tertiary': 6.5, 'motorway_link': 6, 'trunk_link': 6, 'primary_link': 5.5, 'secondary_link': 5.5, 'tertiary_link': 5,
            'unclassified': 5.5, 'residential': 5, 'road': 5, 'living_street': 4.5, 'service': 3.8, 'pedestrian': 6}
TWOWAY_W = {'motorway': 22, 'trunk': 14, 'primary': 12, 'secondary': 10, 'tertiary': 8, 'motorway_link': 7.5, 'trunk_link': 7.5, 'primary_link': 7, 'secondary_link': 7, 'tertiary_link': 6.5,
            'unclassified': 6.5, 'residential': 6, 'road': 6, 'living_street': 5, 'service': 4.2, 'pedestrian': 7}
def road_width(r):
    ow = r['oneway'] in ('yes', '1', '-1') or r['junction'] == 'roundabout' or r['hw'] in ('motorway',)
    w = r['width']
    if w and 2.5 <= w <= 45: return w, ow
    if r['lanes'] and 1 <= r['lanes'] <= 10: return r['lanes'] * 3.3 + (1.2 if r['hw'] in ('motorway', 'trunk') else .6), ow
    return (ONEWAY_W if ow else TWOWAY_W)[r['hw']], ow
def road_cls(r):
    c = CLS[r['hw']]
    if r['surface'] in COBBLE and c in (1, 2, 4): return 5
    if r['surface'] in UNPAVED: return 6
    return c

node_xy, node_ways = {}, collections.defaultdict(list)
R = []
for r in D['roads']:
    P = proj(r['pts'])
    if not any(inside_area(x, z) for x, z in P): continue
    w, ow = road_width(r)
    for k, nd in enumerate(r['nodes']):
        node_xy[nd] = P[k]; node_ways[nd].append((len(R), k, k == 0 or k == len(r['nodes']) - 1))
    R.append(dict(r=r, P=P, w=w, ow=ow, cls=road_cls(r), rank=RANK[r['hw']], name=nid(r['name'], r['name_en'])))
print('roads in area', len(R))

# chunks for streaming
km = 0
for ri, rd in enumerate(R):
    P = simp_line(rd['P'], .35); rd['S'] = P
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1); km += seg.sum() / 1000
    start, acc = 0, 0
    for k in range(1, len(P)):
        acc += seg[k - 1]
        if acc >= 140 or k == len(P) - 1:
            C = P[start:k + 1]; mid = C[len(C) // 2] if len(C) > 2 else C.mean(0)
            t = tile_of(*mid)
            if 0 <= t[0] < NX and 0 <= t[1] < NZ:
                flags = (1 if rd['ow'] else 0) | (2 if rd['r']['bridge'] not in (None, 'no') else 0) | (4 if rd['r']['tunnel'] not in (None, 'no') else 0)
                tiles[t]['roads'].append((rd['cls'], flags, rd['w'], rd['name'], C, rd['rank']))
            start, acc = k, 0
print(f'road length {km:.0f} km')

# junction discs + junction set for trimming markings
junc = {}
for nd, lst in node_ways.items():
    ways = {w for w, _, _ in lst}
    ends = sum(1 for _, _, e in lst if e)
    isj = len(lst) >= 3 or (len(lst) == 2 and len(ways) == 2 and ends < 2) or (len(ways) == 2 and R[lst[0][0]]['w'] != R[lst[1][0]]['w'])
    hwmax = max(R[w]['w'] for w in ways) / 2
    if len(lst) >= 2 or (len(lst) == 1 and lst[0][2]):
        best = max(ways, key=lambda w: (R[w]['rank'], R[w]['w']))
        x, z = node_xy[nd]
        if inside_area(x, z) and (len(lst) >= 2 or True):
            tiles[tile_of(x, z)]['discs'].append((x, z, hwmax, R[best]['cls'], R[best]['rank']))
    if isj: junc[nd] = hwmax
jx = np.array([node_xy[nd] for nd in junc]); jr = np.array([junc[nd] for nd in junc])
jtree = cKDTree(jx)
print('junctions', len(junc))

# markings
def trimmed(line, extra=1.5):
    if line.length < 2: return []
    b = line.bounds; cand = jtree.query_ball_point([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], math.hypot(b[2] - b[0], b[3] - b[1]) / 2 + 40)
    cuts = [Point(jx[i]).buffer(jr[i] + extra, 8) for i in cand if line.distance(Point(jx[i])) < jr[i] + extra]
    g = line.difference(unary_union(cuts)) if cuts else line
    out = [g] if isinstance(g, LineString) else list(getattr(g, 'geoms', []))
    return [l for l in out if isinstance(l, LineString) and l.length > 3]
def add_mark(line, typ, width):
    for l in trimmed(line):
        C = np.asarray(l.coords); mid = C[len(C) // 2]
        t = tile_of(*mid)
        if 0 <= t[0] < NX and 0 <= t[1] < NZ: tiles[t]['marks'].append((typ, width, C))
for rd in R:
    r, P, w = rd['r'], rd['S'], rd['w']
    if rd['cls'] in (3, 4, 6) or len(P) < 2 or r['hw'] in ('living_street',): continue
    L = LineString(P)
    if L.length < 8: continue
    lanes = int(r['lanes']) if r['lanes'] and r['lanes'] >= 1 else None
    major = r['hw'] in ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link')
    off = lambda d: L.offset_curve(d, quad_segs=2, join_style=2, mitre_limit=3)
    if rd['ow']:
        nl = lanes or (max(1, round(w / 3.4)) if major else 1)
        for i in range(1, nl): add_mark(off(-w / 2 + i * w / nl), 0, 12)
        if r['hw'] in ('motorway', 'trunk', 'motorway_link', 'trunk_link'):
            for s in (1, -1): add_mark(off(s * (w / 2 - .35)), 1, 15)
    else:
        if not major and w < 7.5: continue
        nl = lanes or max(2, round(w / 3.4) // 2 * 2)
        add_mark(L, 2 if (r['hw'] in ('trunk', 'primary') and nl >= 4) else 0, 12)
        if nl >= 4:
            for s in (1, -1): add_mark(off(s * w / 4), 0, 12)
        if r['hw'] in ('trunk', 'primary', 'secondary'):
            for s in (1, -1): add_mark(off(s * (w / 2 - .35)), 1, 12)
# rails (tram tracks in the street and railway lines)
for rw, pts, br in D['rail']:
    P = proj(pts)
    if not any(inside_area(x, z) for x, z in P): continue
    L = LineString(simp_line(P, .3))
    if L.length < 4: continue
    for s in (1, -1):
        l = L.offset_curve(s * .72, quad_segs=2, join_style=2)
        for g in ([l] if isinstance(l, LineString) else list(getattr(l, 'geoms', []))):
            C = np.asarray(g.coords)
            for k0 in range(0, len(C) - 1, 40):
                Cc = C[k0:k0 + 41]; mid = Cc[len(Cc) // 2]; t = tile_of(*mid)
                if len(Cc) >= 2 and 0 <= t[0] < NX and 0 <= t[1] < NZ: tiles[t]['marks'].append((3 if rw == 'tram' else 4, 10, Cc))

# crossings and signals
way_nodes = {}
for i, rd in enumerate(R): way_nodes[i] = rd['r']['nodes']
def node_dir(nd):
    lst = node_ways.get(nd)
    if not lst: return None
    wi, k, _ = max(lst, key=lambda e: (R[e[0]]['rank'], R[e[0]]['w']))
    P = R[wi]['P']; a = P[max(0, k - 1)]; b = P[min(len(P) - 1, k + 1)]
    d = b - a; l = np.hypot(*d)
    if l < .1: return None
    return d / l, R[wi]['w'], R[wi]['cls']
for nd, (lon, lat) in D['crossings'].items():
    if nd not in node_xy: continue
    x, z = node_xy[nd]; r = node_dir(nd)
    if not r or not inside_area(x, z) or r[2] in (3, 6): continue
    if nd in junc and len(node_ways[nd]) > 2: continue
    (dx, dz), w, _ = r
    tiles[tile_of(x, z)]['cross'].append((x, z, math.atan2(dx, dz), w))
for nd, (lon, lat) in D['signals'].items():
    if nd not in node_xy: continue
    x, z = node_xy[nd]; r = node_dir(nd)
    if not r or not inside_area(x, z): continue
    (dx, dz), w, _ = r
    tiles[tile_of(x, z)]['signals'].append((x, z, math.atan2(dx, dz), w))

# ------------------------------------------------------------------ land cover (+ water and rail ballast)
COVER_ID = {'base': 0, 'urban': 1, 'industrial': 2, 'bare': 3, 'grass': 4, 'park': 5, 'forest': 6, 'scrub': 7, 'farm': 8, 'cemetery': 9, 'pitch': 10, 'water': 11, 'paved': 12, 'rail': 13}
ORDER = ['farm', 'urban', 'industrial', 'bare', 'grass', 'scrub', 'cemetery', 'park', 'forest', 'pitch', 'paved', 'water', 'rail']
cover_geoms = []
def poly_from(o, holes):
    try:
        p = Polygon(proj(o), [proj(h) for h in holes if len(h) >= 4])
        if not p.is_valid: p = make_valid(p)
        return p
    except Exception: return None
for cls, polys, name in D['cover']:
    for o, holes in polys:
        if len(o) < 4: continue
        p = poly_from(o, holes)
        if p is None or p.is_empty or not p.intersects(AREA): continue
        cover_geoms.append((cls, p.intersection(AREA)))
for ww, pts, wd in D['water']:
    P = proj(pts)
    if not any(inside_area(x, z) for x, z in P) or len(P) < 2: continue
    width = wd if wd and 1 < wd < 80 else (12 if ww == 'river' else 6 if ww == 'canal' else 3)
    cover_geoms.append(('water', LineString(P).buffer(width / 2, quad_segs=2).intersection(AREA)))
for rw, pts, br in D['rail']:
    if rw == 'tram': continue
    P = proj(pts)
    if not any(inside_area(x, z) for x, z in P) or len(P) < 2: continue
    cover_geoms.append(('rail', LineString(P).buffer(2.4, quad_segs=1, cap_style=2).intersection(AREA)))
print('cover geometries', len(cover_geoms))
cg = [g for _, g in cover_geoms]; ctree = STRtree(cg)
for tz in range(NZ):
    for tx in range(NX):
        tb = box(X0 + tx * TILE - 2, Z0 + tz * TILE - 2, X0 + (tx + 1) * TILE + 2, Z0 + (tz + 1) * TILE + 2)
        hits = ctree.query(tb, predicate='intersects')
        items = sorted(((ORDER.index(cover_geoms[i][0]), cover_geoms[i][0], cg[i]) for i in hits), key=lambda e: e[0])
        for _, cls, g in items:
            gi = g.intersection(tb).simplify(.6)
            for p in (gi.geoms if hasattr(gi, 'geoms') else [gi]):
                if isinstance(p, Polygon) and p.area > 6:
                    tiles[(tx, tz)]['cover'].append((COVER_ID[cls], [np.asarray(p.exterior.coords)[:-1]] + [np.asarray(h.coords)[:-1] for h in p.interiors]))

# ------------------------------------------------------------------ buildings
BLD = []
for b in D['buildings']:
    for o, holes in b['polys']:
        if len(o) < 4: continue
        p = poly_from(o, holes)
        if p is None or p.is_empty: continue
        if isinstance(p, (MultiPolygon, GeometryCollection)):
            p = max((g for g in getattr(p, 'geoms', []) if isinstance(g, Polygon)), key=lambda g: g.area, default=None)
            if p is None: continue
        if not isinstance(p, Polygon) or p.area < 9: continue
        c = p.representative_point()
        if not inside_area(c.x, c.y): continue
        BLD.append(dict(b=b, p=p.simplify(.4, preserve_topology=True), area=p.area, c=(c.x, c.y)))
print('buildings in area', len(BLD))
LOWTYPES = {'garage': 1, 'garages': 1, 'shed': 1, 'kiosk': 1, 'hut': 1, 'carport': 1, 'service': 1, 'toilets': 1, 'greenhouse': 1, 'transformer_tower': 1, 'cabin': 1}
HOUSES = {'house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'farm', 'villa'}
known = [(i, (bb['b']['lv'] if bb['b']['lv'] else (bb['b']['h'] - 1) / 3)) for i, bb in enumerate(BLD) if (bb['b']['lv'] and 0 < bb['b']['lv'] < 60) or (bb['b']['h'] and 2 < bb['b']['h'] < 250)]
ki = np.array([k for k, _ in known]); kl = np.array([l for _, l in known]); kc = np.array([BLD[k]['c'] for k in ki]); ka = np.array([BLD[k]['area'] for k in ki])
ktree = cKDTree(kc)
def guess_levels(bb):
    t = bb['b']['b']; a = bb['area']
    if t in LOWTYPES: return 1
    d, idx = ktree.query(bb['c'], k=12, distance_upper_bound=350)
    idx = [i for dd, i in zip(d, idx) if np.isfinite(dd)]
    sim = [kl[i] for i in idx if a / 3 < ka[i] < a * 3]
    if len(sim) >= 3: lv = float(np.median(sim))
    elif len(idx) >= 4: lv = float(np.median([kl[i] for i in idx])) * (0.6 if a < 150 else 1)
    else: lv = 1.5 if a < 90 else 2 if a < 220 else 4 if a < 700 else 7
    if t in HOUSES: lv = min(lv, 3)
    if a < 60: lv = min(lv, 2)
    return max(1, round(lv))
STYLE = {'apartments': 0, 'residential': 1, 'house': 2, 'detached': 2, 'semidetached_house': 2, 'terrace': 2, 'bungalow': 2, 'villa': 2, 'farm': 2,
         'commercial': 3, 'office': 3, 'retail': 3, 'hotel': 3, 'supermarket': 3, 'industrial': 4, 'warehouse': 4, 'service': 4, 'garage': 4, 'garages': 4, 'shed': 4,
         'hangar': 4, 'manufacture': 4, 'storage_tank': 4, 'church': 5, 'cathedral': 5, 'chapel': 5, 'mosque': 5, 'synagogue': 5, 'temple': 5, 'monastery': 5,
         'school': 6, 'university': 6, 'college': 6, 'hospital': 6, 'kindergarten': 6, 'public': 6, 'government': 6, 'civic': 6, 'train_station': 6, 'stadium': 6, 'sports_hall': 6}
heights = []
for bb in BLD:
    b = bb['b']
    if b['h'] and 2 < b['h'] < 250: h = b['h']
    elif b['lv'] and 0 < b['lv'] < 60: h = b['lv'] * 3.0 + 1.0
    else:
        lv = guess_levels(bb); h = lv * 3.0 + 1.0
        if b['b'] in ('industrial', 'warehouse', 'hangar', 'manufacture') and lv <= 2: h = 7.5 + rng.random() * 4
    if b['b'] in ('church', 'cathedral') and h < 14: h = 16
    minh = b['minh'] if b['minh'] and b['minh'] < h - 1 else (b['minlv'] * 3 if b['minlv'] and b['minlv'] * 3 < h - 1 else 0)
    st = STYLE.get(b['b'])
    if st is None: st = 0 if h >= 16 else 1 if h >= 9 else 2 if bb['area'] < 260 else 7
    roof = 0
    ext = np.asarray(bb['p'].exterior.coords)[:-1]
    if st in (2, 7) and h <= 10 and len(ext) == 4 and bb['area'] < 320 and not bb['p'].interiors: roof = 1     # gable on simple houses
    if st == 5: roof = 2
    rings = [ext] + [np.asarray(r.coords)[:-1] for r in bb['p'].interiors if len(r.coords) >= 4]
    t = tile_of(*bb['c'])
    tiles[t]['bld'].append((st, roof, h, minh, int(rng.integers(0, 256)), rings))
    heights.append(h)
print(f'building heights: median {np.median(heights):.1f} m, 90% {np.percentile(heights, 90):.1f} m, max {max(heights):.0f} m')

# ------------------------------------------------------------------ trees
road_buf = STRtree([LineString(rd['S']).buffer(rd['w'] / 2 + 2.5, quad_segs=1) for rd in R if len(rd['S']) >= 2])
bld_tree = STRtree([bb['p'].buffer(1.5) for bb in BLD])
water_tree = STRtree([g for c, g in cover_geoms if c in ('water', 'rail', 'pitch', 'paved')])
def keep_mask(P):
    pts = shapely.points(P)
    bad = np.zeros(len(P), bool)
    for tr in (road_buf, bld_tree, water_tree):
        ii = tr.query(pts, predicate='intersects')
        if ii.size: bad[ii[0]] = True
    return ~bad
def keep_pts(P): return P[keep_mask(P)]
cand = [proj(D['trees'])] if D['trees'] else []
for row in D['tree_rows']:
    L = LineString(proj(row)); k = max(1, int(L.length / 8))
    cand.append(np.array([L.interpolate(i / k, normalized=True).coords[0] for i in range(k + 1)]))
osm_trees = keep_pts(np.vstack(cand)) if cand else np.zeros((0, 2))
DENS = {'forest': 1 / 260, 'park': 1 / 230, 'scrub': 1 / 700, 'cemetery': 1 / 200, 'grass': 1 / 2600, 'urban': 1 / 4000}
fill = []
for cls, g in cover_geoms:
    if cls not in DENS or g.is_empty: continue
    nexp = g.area * DENS[cls]
    if nexp < .5: continue
    nn = int(rng.poisson(nexp))
    if nn == 0: continue
    b = g.bounds; m = int(nn * (box(*b).area / max(g.area, 1)) * 1.1) + 4
    P = np.column_stack([rng.uniform(b[0], b[2], m), rng.uniform(b[1], b[3], m)])
    P = P[shapely.contains_xy(g, P[:, 0], P[:, 1])][:nn]
    fill.append(np.column_stack([P, np.full(len(P), 2 if cls == 'scrub' else -1)]))
fillP = np.vstack(fill) if fill else np.zeros((0, 3))
if len(fillP):
    fillP = fillP[(fillP[:, 0] >= X0) & (fillP[:, 0] < X1) & (fillP[:, 1] >= Z0) & (fillP[:, 1] < Z1)]
    fillP = fillP[keep_mask(fillP[:, :2])]
keepF = fillP
hF = terrain(keepF[:, 0], keepF[:, 1]) if len(keepF) else np.zeros(0)
rr = rng.random(len(keepF))
kinds = np.where(keepF[:, 2] == 2, 2, np.where((hF > 720) & (rr < .65) | (rr < .18), 1, 0)) if len(keepF) else []
for x, z in osm_trees:
    if inside_area(x, z): tiles[tile_of(x, z)]['trees'].append((x, z, 0 if rng.random() < .85 else 1, rng.random()))
for (x, z, _), k, s in zip(keepF, kinds, rng.random(len(keepF))): tiles[tile_of(x, z)]['trees'].append((x, z, int(k), s))
print(f'trees: {len(osm_trees)} mapped + {len(keepF)} in parks and woods')

# ------------------------------------------------------------------ places & spawn points
places = []
for lon, lat, kind, nm, en in D['places']:
    (x, z), = proj([(lon, lat)])
    if inside_area(x, z) and kind in ('suburb', 'quarter', 'neighbourhood'): places.append([round(x, 1), round(z, 1), nm, en or '', kind])
SPOTS = [('Alexander Nevsky Cathedral', 'Храм-паметник „Св. Александър Невски“', 23.3327, 42.6957), ('National Palace of Culture', 'НДК', 23.3190, 42.6853),
         ("Eagles' Bridge", 'Орлов мост', 23.3375, 42.6922), ('Sofia Airport', 'Летище София', 23.4060, 42.6880), ('Business Park, Mladost', 'Бизнес парк, Младост', 23.3757, 42.6272),
         ('Lyulin', 'Люлин', 23.2640, 42.7150), ('Boyana', 'Бояна', 23.2690, 42.6460), ('Tsarigradsko shose', 'Цариградско шосе', 23.3790, 42.6650),
         ('Central Railway Station', 'Централна гара', 23.3215, 42.7105), ('Ring Road, Simeonovo', 'Околовръстен път, Симеоново', 23.3420, 42.6305)]
segs, segw = [], []
for rd in R:
    if rd['cls'] in (3, 4, 6): continue
    P = rd['S']
    for k in range(len(P) - 1): segs.append((P[k], P[k + 1], rd['w'], rd['name']))
sa = np.array([s[0] for s in segs]); sb = np.array([s[1] for s in segs]); smid = (sa + sb) / 2; stree = cKDTree(smid)
spawns = []
for en, bg, lon, lat in SPOTS:
    (x, z), = proj([(lon, lat)])
    _, ii = stree.query((x, z), k=40)
    best = None
    for i in ii:
        a, b = sa[i], sb[i]; d = b - a; L = np.hypot(*d)
        if L < 1: continue
        t = np.clip(np.dot((x, z) - a, d) / L ** 2, 0, 1); p = a + d * t; dist = np.hypot(*(p - (x, z)))
        if best is None or dist < best[0]: best = (dist, p, d / L)
    _, p, u = best
    spawns.append(dict(name=en, name_bg=bg, x=round(float(p[0]), 1), z=round(float(p[1]), 1), psi=round(math.atan2(-u[0], -u[1]), 4)))

# ------------------------------------------------------------------ far backdrop (mountains around the city)
fx0, fx1, fz0, fz1 = -26000.0, 34000.0, -33000.0, 30000.0
fnx, fnz = int((fx1 - fx0) / FSTEP) + 1, int((fz1 - fz0) / FSTEP) + 1
Fx, Fz = np.meshgrid(fx0 + np.arange(fnx) * FSTEP, fz0 + np.arange(fnz) * FSTEP)
F = hgt_at(Fx, Fz, sigma_px=2.5)
inner = (Fx > tx0 - 400) & (Fx < tx0 + tnx * TSTEP + 400) & (Fz > tz0 - 400) & (Fz < tz0 + tnz * TSTEP + 400)
Fmin = minimum_filter(F, 3)
F = np.where(inner, np.minimum(F, Fmin) - 4, F)
# colours: building density inside the city, otherwise farmland / forest / alpine by height and slope
bx = np.array([bb['c'][0] for bb in BLD]); bz = np.array([bb['c'][1] for bb in BLD]); ba = np.array([bb['area'] for bb in BLD])
dens, _, _ = np.histogram2d(bz, bx, bins=[np.append(fz0 - FSTEP / 2 + np.arange(fnz) * FSTEP, fz0 - FSTEP / 2 + fnz * FSTEP), np.append(fx0 - FSTEP / 2 + np.arange(fnx) * FSTEP, fx0 - FSTEP / 2 + fnx * FSTEP)], weights=ba)
dens = gaussian_filter(dens / (FSTEP * FSTEP), 1.0)
gy, gxs = np.gradient(F, FSTEP); slope = np.hypot(gy, gxs)
noise = gaussian_filter(rng.random(F.shape), 2.0); noise = (noise - noise.min()) / (np.ptp(noise) + 1e-9)
def mix(a, b, t): t = np.clip(t, 0, 1)[..., None]; return a * (1 - t) + b * t
c_farm = mix(np.array([150, 150, 92.]), np.array([122, 140, 80.]), noise)
c_forest = np.array([62, 86, 48.]); c_alp = np.array([128, 132, 96.]); c_rock = np.array([128, 124, 116.]); c_city = np.array([168, 160, 148.])
col = c_farm.copy()
forest_t = np.clip((F - 760) / 160, 0, 1) * np.clip((1950 - F) / 200, 0, 1) + np.clip(slope * 3 - .25, 0, 1) * (F < 1900)
col = mix(col, np.broadcast_to(c_forest, col.shape), np.clip(forest_t * (.75 + .5 * noise), 0, 1))
col = mix(col, np.broadcast_to(c_alp, col.shape), np.clip((F - 1850) / 200, 0, 1))
col = mix(col, np.broadcast_to(c_rock, col.shape), np.clip((slope - .45) * 3, 0, 1) * (F > 1400))
col = mix(col, np.broadcast_to(c_city, col.shape), np.clip(dens * 3.2, 0, 1))
with open(f'{OUT}/far.bin', 'wb') as f:
    f.write(np.round(F).astype('<i2').tobytes()); f.write(np.clip(col, 0, 255).astype(np.uint8).tobytes())
print(f'far backdrop {fnx} x {fnz} @ {FSTEP} m, up to {F.max():.0f} m')

# ------------------------------------------------------------------ write regions
def q(v): return int(max(-32767, min(32767, round(v * 10))))
def pts_bytes(P, ox, oz):
    P = np.asarray(P, float); a = np.empty((len(P), 2), '<i2')
    a[:, 0] = np.clip(np.round((P[:, 0] - ox) * 10), -32767, 32767); a[:, 1] = np.clip(np.round((P[:, 1] - oz) * 10), -32767, 32767)
    return a.tobytes()
def tile_block(t, d):
    ox, oz = X0 + t[0] * TILE, Z0 + t[1] * TILE
    o = bytearray()
    o += struct.pack('<H', len(d['roads']))
    for cls, flags, w, name, C, rank in sorted(d['roads'], key=lambda e: e[5]):
        o += struct.pack('<BBHHBH', cls, flags, int(round(w * 100)), name, min(rank, 255), len(C)) + pts_bytes(C, ox, oz)
    o += struct.pack('<H', len(d['discs']))
    for x, z, r, cls, rank in sorted(d['discs'], key=lambda e: e[4]):
        o += struct.pack('<hhHBB', q(x - ox), q(z - oz), int(round(r * 100)), cls, min(rank, 255))
    o += struct.pack('<H', len(d['marks']))
    for typ, w, C in d['marks']: o += struct.pack('<BBH', typ, w, len(C)) + pts_bytes(C, ox, oz)
    o += struct.pack('<H', len(d['cross']))
    for x, z, a, w in d['cross']: o += struct.pack('<hhhH', q(x - ox), q(z - oz), int(round(a * 10000)), int(round(w * 100)))
    o += struct.pack('<H', len(d['signals']))
    for x, z, a, w in d['signals']: o += struct.pack('<hhhH', q(x - ox), q(z - oz), int(round(a * 10000)), int(round(w * 100)))
    o += struct.pack('<I', len(d['bld']))
    for st, roof, h, minh, seed, rings in d['bld']:
        o += struct.pack('<BBHHBB', st, roof, int(round(h * 10)), int(round(minh * 10)), seed, len(rings))
        for rg in rings: o += struct.pack('<H', len(rg)) + pts_bytes(rg, ox, oz)
    o += struct.pack('<I', len(d['trees']))
    for x, z, kind, s in d['trees']: o += struct.pack('<hhB', q(x - ox), q(z - oz), (kind & 3) | (int(s * 63) << 2))
    o += struct.pack('<H', len(d['cover']))
    for cls, rings in d['cover']:
        o += struct.pack('<BB', cls, len(rings))
        for rg in rings: o += struct.pack('<H', len(rg)) + pts_bytes(rg, ox, oz)
    return bytes(o)
regions = []
total = 0
for rz in range(math.ceil(NZ / REG)):
    for rx in range(math.ceil(NX / REG)):
        blocks = []
        for tz in range(rz * REG, min(NZ, (rz + 1) * REG)):
            for tx in range(rx * REG, min(NX, (rx + 1) * REG)):
                d = tiles.get((tx, tz))
                if d and any(d[k] for k in d): blocks.append(((tx, tz), tile_block((tx, tz), d)))
        if not blocks: continue
        head = b'MWC1' + struct.pack('<H', len(blocks)); off = len(head) + len(blocks) * 12
        dirb, body = bytearray(), bytearray()
        for (tx, tz), blk in blocks: dirb += struct.pack('<HHII', tx, tz, off + len(body), len(blk)); body += blk
        fn = f'r_{rx}_{rz}.bin'
        with open(f'{OUT}/{fn}', 'wb') as f: f.write(head + dirb + body)
        regions.append([rx, rz, fn, len(head) + len(dirb) + len(body)]); total += regions[-1][3]
meta = dict(id='sofia', name='Sofia', name_bg='София', country='BG', origin=[LON0, LAT0], x0=X0, z0=Z0, x1=X1, z1=Z1, tile=TILE, region=REG, nx=NX, nz=NZ,
            terrain=dict(file='terrain.bin', x0=tx0, z0=tz0, step=TSTEP, nx=tnx, nz=tnz, scale=.1),
            far=dict(file='far.bin', x0=fx0, z0=fz0, step=FSTEP, nx=fnx, nz=fnz),
            regions=regions, names=names, places=places, spawns=spawns,
            stats=dict(roadKm=round(km), buildings=len(BLD), trees=int(len(osm_trees) + len(keepF)), areaKm2=round((X1 - X0) * (Z1 - Z0) / 1e6), elevMin=round(float(T.min())), elevMax=round(float(T.max()))),
            credits=['Map data © OpenStreetMap contributors (ODbL 1.0), via Geofabrik', 'Elevation: SRTM 1 arc-second (NASA/USGS) via Mapzen Terrain Tiles'])
json.dump(meta, open(f'{OUT}/sofia.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print(f'regions {len(regions)}, {total / 1e6:.1f} MB; names {len(names)}; places {len(places)}; spawns {len(spawns)}')
