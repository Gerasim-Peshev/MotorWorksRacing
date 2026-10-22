"""Build a free-roam city map from an OpenStreetMap extract (extract.py), a city config (sofia.json, veliko-tarnovo.json)
and optional 3" elevation tiles.

  python3 build_city.py <config.json> <raw.pkl> <dem_dir> <out_dir>

Output (out_dir):
  meta.json      projection, playable area, region index, landmarks, challenges, credits
  terrain.bin    Int16 height grid (0.1 m) over the whole view area
  net.bin        road network for the minimap and navigation
  skyline.bin    boxes of the taller buildings for the distant city
  p_<I>_<J>.bin  packs of 1 km region tiles: roads, buildings, ground areas, rails, trees, crossings, signals
With "flat" in the config the drivable area is levelled (everything drives the same); the terrain outside blends back to
real elevation (or decorative hills when there is no elevation data).
World: x = east, z = south, metres from the config centre, y = up (metres above sea level).
"""
import sys, os, math, json, struct, pickle, heapq, collections, hashlib
import numpy as np
from scipy.ndimage import map_coordinates, gaussian_filter, distance_transform_edt
from shapely.geometry import Polygon, MultiPolygon, LineString, Point, box, MultiLineString, MultiPoint
from shapely.ops import unary_union, polygonize, linemerge
from shapely.strtree import STRtree
from shapely.prepared import prep
from shapely import make_valid
from matplotlib.path import Path as MPath

CFG = json.load(open(sys.argv[1])); RAW, DEM, OUT = sys.argv[2], sys.argv[3], sys.argv[4]
os.makedirs(OUT, exist_ok=True)
d = pickle.load(open(RAW, 'rb'))
LAT0, LON0 = CFG['center']
KX = 111320 * math.cos(math.radians(LAT0)); KY = 110540
def P(lon, lat): return ((lon - LON0) * KX, -(lat - LAT0) * KY)
def LL(x, z): return (LON0 + x / KX, LAT0 - z / KY)
REG = 1000.0
log = lambda *a: print(*a, flush=True)
hid = lambda i: int(hashlib.md5(str(i).encode()).hexdigest()[:8], 16)

# ------------------------------------------------------------ playable area
AC = CFG['area']; parts = []
bcent = []
for wid, pts, ids, t in d['ways']:
    if 'building' in t and len(pts) > 2: q = [P(*p) for p in pts]; bcent.append((sum(p[0] for p in q) / len(q), sum(p[1] for p in q) / len(q)))
bcent = np.array(bcent) if bcent else np.zeros((0, 2))
if 'ringRef' in AC:      # hull of a ring road (Sofia: I-18) + margin
    ring = []
    for wid, pts, ids, t in d['ways']:
        if 'highway' in t and t['highway'] in ('trunk', 'primary', 'motorway', 'trunk_link', 'primary_link'):
            refs = [r.strip() for r in t.get('ref', '').replace(',', ';').split(';')]
            if AC['ringRef'] in refs: ring.append(LineString([P(*p) for p in pts]))
    parts.append(MultiLineString(ring).convex_hull.buffer(AC.get('buffer', 380)))
if 'buildings' in AC:    # the built-up area around the centre: clusters of buildings, their hull + margin
    B = AC['buildings']; pts = bcent[np.hypot(bcent[:, 0], bcent[:, 1]) < B['radius']]
    blobs = unary_union([Point(x, z).buffer(90, 4) for x, z in pts])
    keep = [g for g in (blobs.geoms if hasattr(blobs, 'geoms') else [blobs]) if sum(1 for x, z in pts if g.contains(Point(x, z))) >= B.get('minCluster', 20)]
    parts.append(MultiPolygon(keep).convex_hull.buffer(AC.get('buffer', 300)))
for inc in AC.get('include', []):   # extra quarters outside (Gorna Banya): their buildings, joined to the rest
    x0, z0, x1, z1 = inc['box']; sel = bcent[(bcent[:, 0] > x0) & (bcent[:, 0] < x1) & (bcent[:, 1] > z0) & (bcent[:, 1] < z1)]
    g = unary_union([Point(x, z).buffer(inc.get('buffer', 110), 4) for x, z in sel]).buffer(60).buffer(-60)
    big = [q for q in (g.geoms if hasattr(g, 'geoms') else [g]) if q.area > 40000]
    parts.append(unary_union(big)); log('include', inc.get('name'), len(sel), 'buildings', round(unary_union(big).area / 1e6, 2), 'km2')
AREA = unary_union(parts).buffer(40).buffer(-40)
if AREA.geom_type != 'Polygon': AREA = max(AREA.geoms, key=lambda g: g.area)
AREA = Polygon(AREA.exterior).simplify(20)
AREAP = prep(AREA)
log('area km2', round(AREA.area / 1e6, 1), 'bounds', [round(v) for v in AREA.bounds])

# ------------------------------------------------------------ terrain grid
TC = CFG['terrain']; TX0, TX1, TZ0, TZ1 = map(float, TC['extent']); TS = float(TC.get('step', 50))
NX, NZ = int((TX1 - TX0) / TS) + 1, int((TZ1 - TZ0) / TS) + 1
gx = TX0 + np.arange(NX) * TS; gz = TZ0 + np.arange(NZ) * TS
GXX, GZZ = np.meshgrid(gx, gz)
lon = LON0 + GXX / KX; lat = LAT0 - GZZ / KY
def hgt(fn):
    a = np.fromfile(fn, dtype='>i2').reshape(1201, 1201).astype(np.float32); a[a < -500] = np.nan; return a
tiles = {}
for nm in TC.get('dem', []):
    fn = os.path.join(DEM, nm + '.hgt')
    if os.path.exists(fn): tiles[(int(nm[1:3]), int(nm[4:7]))] = hgt(fn)
# outside / inside the playable area, distance to it
inside = MPath(np.array(AREA.exterior.coords)).contains_points(np.c_[GXX.ravel(), GZZ.ravel()]).reshape(GXX.shape)
DOUT = distance_transform_edt(~inside) * TS
if tiles:
    la0, la1 = min(k[0] for k in tiles), max(k[0] for k in tiles); lo0, lo1 = min(k[1] for k in tiles), max(k[1] for k in tiles)
    M = np.full(((la1 - la0 + 1) * 1200 + 1, (lo1 - lo0 + 1) * 1200 + 1), np.nan, np.float32)
    for (la, lo), a in tiles.items():
        r0 = (la1 - la) * 1200; c0 = (lo - lo0) * 1200; M[r0:r0 + 1201, c0:c0 + 1201] = a
    fill = np.nanmedian(M)
    H = map_coordinates(np.nan_to_num(M, nan=fill), [(la1 + 1 - lat) * 1200, (lon - lo0) * 1200], order=3, mode='nearest').astype(np.float32)
    H = gaussian_filter(H, 0.8)
else:
    H = np.zeros_like(GXX, dtype=np.float32)
FLAT = TC.get('flat')
if FLAT is not None:
    level = float(np.median(H[inside])) if FLAT == 'median' else float(FLAT)
    if not tiles:                      # no elevation data: decorative hills around the city
        hc = TC.get('hills', {}); rng = np.random.default_rng(hc.get('seed', 1))
        n = gaussian_filter(rng.normal(size=H.shape), 18) ; n = (n - n.min()) / (n.max() - n.min())
        ramp = np.clip((DOUT - hc.get('start', 700)) / hc.get('range', 4000), 0, 1); ramp = ramp * ramp * (3 - 2 * ramp)
        H = level + hc.get('amp', 200) * (.35 + .65 * n) * ramp
    w = np.clip((DOUT - TC.get('margin', 250)) / TC.get('blend', 1500), 0, 1); w = w * w * (3 - 2 * w)
    H = (level * (1 - w) + H * w).astype(np.float32)
    log('flat level', round(level, 1), 'm')
H = np.round(H * 10) / 10
def terrain(x, z):
    fx = (x - TX0) / TS; fz = (z - TZ0) / TS
    i = min(max(int(fx), 0), NX - 2); j = min(max(int(fz), 0), NZ - 2); u = min(max(fx - i, 0), 1); v = min(max(fz - j, 0), 1)
    return float((H[j, i] * (1 - u) + H[j, i + 1] * u) * (1 - v) + (H[j + 1, i] * (1 - u) + H[j + 1, i + 1] * u) * v)
(np.round(H * 10).astype('<i2')).tofile(os.path.join(OUT, 'terrain.bin'))
log('terrain', NX, 'x', NZ, 'min', H.min(), 'max', H.max())

# ------------------------------------------------------------ helpers
def num(s, dflt=None):
    if s is None: return dflt
    s = str(s).strip().lower().replace(',', '.').replace('m', '').replace("'", '').strip()
    try: return float(s.split(';')[0].split()[0])
    except Exception: return dflt
geom = d['geom']
waydict = {}
for wid, pts, ids, t in d['ways']: waydict[wid] = (pts, ids, t)
def rel_polys(mem):
    outer, inner = [], []
    for ref, role in mem:
        g = geom.get(ref) or (waydict[ref][0] if ref in waydict else None)
        if not g or len(g) < 2: continue
        (inner if role == 'inner' else outer).append(LineString([P(*p) for p in g]))
    if not outer: return None
    try:
        po = list(polygonize(linemerge(outer) if len(outer) > 1 else outer[0]))
        if not po: return None
        res = unary_union(po)
        if inner:
            pi = list(polygonize(linemerge(inner) if len(inner) > 1 else inner[0]))
            if pi: res = res.difference(unary_union(pi))
        return make_valid(res)
    except Exception:
        return None
def polys_of(g):
    if g is None or g.is_empty: return []
    if g.geom_type == 'Polygon': return [g]
    if hasattr(g, 'geoms'): return [p for q in g.geoms for p in polys_of(q)]
    return []

# ------------------------------------------------------------ roads
CLS = {'motorway': 1, 'trunk': 2, 'primary': 3, 'secondary': 4, 'tertiary': 5, 'unclassified': 6, 'residential': 7, 'living_street': 8, 'service': 9, 'pedestrian': 10,
       'motorway_link': 11, 'trunk_link': 12, 'primary_link': 13, 'secondary_link': 14, 'tertiary_link': 15, 'runway': 16, 'taxiway': 17}
LANEW = {1: 3.6, 2: 3.5, 3: 3.4, 4: 3.3, 5: 3.2, 6: 3.0, 7: 3.0, 8: 3.0, 9: 3.0, 10: 3.0, 11: 3.5, 12: 3.5, 13: 3.4, 14: 3.3, 15: 3.2}
def road_width(t, c, oneway):
    w = num(t.get('width'))
    if c == 16: return min(max(w or 45, 30), 60)
    if c == 17: return min(max(w or 20, 12), 30)
    if w and 2.5 <= w <= 40 and c not in (1, 2): return w
    lanes = num(t.get('lanes'))
    if lanes and 1 <= lanes <= 8:
        base = lanes * LANEW[c]
        return base + (2.6 if c == 1 else 1.4 if c == 2 else .8 if c in (3, 11, 12) else 0)
    if c == 1: return 3 * 3.6 + 2.6
    if c == 2: return (2 * 3.5 + 1.4) if oneway else 4 * 3.5 + 1.4
    if c == 3: return 2 * 3.4 + .8 if oneway else 4 * 3.4
    if c == 4: return 2 * 3.3 if oneway else 2 * 3.3 + 2
    if c == 5: return 6.8
    if c in (6, 7): return 6.0
    if c == 8: return 5.0
    if c == 9: return 4.0
    if c == 10: return min(max(w or 9, 4), 30)
    return 4.6
SIDEWALK = {3: 3.2, 4: 3.0, 5: 2.6, 6: 2.0, 7: 2.2, 8: 1.6, 13: 2.0, 14: 2.0, 15: 2.0}
roads = []          # dict: pts [(x,z)], ids, cls, w, oneway, bridge, layer, name, tags
for wid, pts, ids, t in d['ways']:
    h = t.get('highway'); a = t.get('aeroway')
    c = CLS.get(h) if h else CLS.get(a) if a in ('runway', 'taxiway') else None
    if not c: continue
    if t.get('area') == 'yes' or t.get('tunnel') not in (None, 'no') or t.get('covered') == 'yes': continue
    if c == 9 and t.get('service') in ('parking_aisle', 'driveway', 'drive-through', 'emergency_access'): continue
    if t.get('access') in ('no',) and c >= 9 and c != 16: continue
    q = [P(*p) for p in pts]
    if not any(AREAP.contains(Point(p)) for p in q): continue
    oneway = t.get('oneway') in ('yes', '1', 'true') or (c in (1, 11) and t.get('oneway') != 'no')
    br = t.get('bridge') not in (None, 'no')
    layer = int(num(t.get('layer'), 1 if br else 0) or 0)
    nm = t.get('name') or t.get('ref') or ''
    sw = SIDEWALK.get(c, 0)
    if t.get('sidewalk') in ('no', 'none') or c in (1, 2, 9, 10, 11, 12, 16, 17): sw = 0
    roads.append(dict(id=wid, q=q, ids=list(ids), c=c, w=road_width(t, c, oneway), ow=oneway, br=br, layer=layer, name=nm, en=t.get('name:en', ''), sw=sw,
                      lanes=int(num(t.get('lanes'), 0) or 0), tram=False))
log('roads', len(roads))

# clip to the playable area: drop segments with both ends outside
def clip_line(r):
    q, ids = r['q'], r['ids']; out = []; cur_q, cur_i = [], []
    inside = [AREAP.contains(Point(p)) for p in q]
    for k in range(len(q)):
        keep = inside[k] or (k > 0 and inside[k - 1]) or (k + 1 < len(q) and inside[k + 1])
        if keep: cur_q.append(q[k]); cur_i.append(ids[k])
        elif cur_q:
            if len(cur_q) > 1: out.append((cur_q, cur_i))
            cur_q, cur_i = [], []
    if len(cur_q) > 1: out.append((cur_q, cur_i))
    return out
rr = []
for r in roads:
    for q, ids in clip_line(r): rr.append({**r, 'q': q, 'ids': ids})
roads = rr

# ------------------------------------------------------------ rails & trams
rails = []
for wid, pts, ids, t in d['ways']:
    rw = t.get('railway')
    if rw not in ('rail', 'tram', 'light_rail', 'narrow_gauge'): continue
    if t.get('tunnel') not in (None, 'no') or t.get('service') in ('yard', 'siding') and rw == 'rail' and False: continue
    q = [P(*p) for p in pts]
    if not any(AREAP.contains(Point(p)) for p in q): continue
    br = t.get('bridge') not in (None, 'no')
    rails.append(dict(id=wid, q=q, ids=list(ids), kind=2 if rw == 'tram' else 1, br=br, layer=int(num(t.get('layer'), 1 if br else 0) or 0)))
log('rails', len(rails))

# ------------------------------------------------------------ node graph + densify
NODE = {}           # id -> [x, z]
nid_seq = [-1]
def new_node(x, z):
    nid_seq[0] -= 1; NODE[nid_seq[0]] = [x, z]; return nid_seq[0]
def densify(objs, step):
    for r in objs:
        q, ids = r['q'], r['ids']; nq, ni = [q[0]], [ids[0]]
        for k in range(1, len(q)):
            x0, z0 = q[k - 1]; x1, z1 = q[k]; L = math.hypot(x1 - x0, z1 - z0); n = int(L // step)
            for m in range(1, n + 1):
                f = m / (n + 1); x, z = x0 + (x1 - x0) * f, z0 + (z1 - z0) * f
                nq.append((x, z)); ni.append(new_node(x, z))
            nq.append(q[k]); ni.append(ids[k])
        r['q'], r['ids'] = nq, ni
        for (x, z), i in zip(nq, ni):
            if i > 0: NODE.setdefault(i, [x, z])
densify(roads, 14.0); densify(rails, 20.0)

def build_adj(objs):
    adj = collections.defaultdict(dict)
    for r in objs:
        for k in range(1, len(r['ids'])):
            a, b = r['ids'][k - 1], r['ids'][k]
            if a == b: continue
            L = math.hypot(NODE[a][0] - NODE[b][0], NODE[a][1] - NODE[b][1])
            adj[a][b] = L; adj[b][a] = L
    return adj
RADJ = build_adj(roads); LADJ = build_adj(rails)
H0 = {i: terrain(*NODE[i]) for i in NODE}

# ------------------------------------------------------------ bridges: deck heights where a bridge crosses roads or rails
def seg_list(objs, pred):
    segs, meta = [], []
    for ri, r in enumerate(objs):
        if not pred(r): continue
        for k in range(1, len(r['q'])):
            segs.append(LineString([r['q'][k - 1], r['q'][k]])); meta.append((ri, k))
    return segs, meta
HT = dict(H0)
def insert_point(r, k, x, z):
    """split segment k-1..k of r at (x,z) and return the new node id"""
    i = new_node(x, z); r['q'].insert(k, (x, z)); r['ids'].insert(k, i)
    HT[i] = terrain(x, z); return i
def propagate(adj, seeds, grade):
    hq = [(-h, i) for i, h in seeds.items()]; heapq.heapify(hq)
    for i, h in seeds.items(): HT[i] = max(HT.get(i, -1e9), h)
    while hq:
        nh, i = heapq.heappop(hq); h = -nh
        if h < HT[i] - 1e-6: continue
        for j, L in adj[i].items():
            v = h - grade * L
            if v > HT.get(j, -1e9) + 1e-3 and v > H0.get(j, terrain(*NODE[j])):
                HT[j] = v; heapq.heappush(hq, (-v, j))
LOWER = []   # (objs, index, x, z, target height): roads/rails mapped below a bridge (layer < 0)
def bridge_pass(objs, adj, grade, others):
    """others: list of (objs, pred, clearance)"""
    seeds = {}
    for lay in (1, 2, 3):
        cand = [ri for ri, r in enumerate(objs) if r['br'] and (r['layer'] == lay or (lay == 3 and r['layer'] > 3))]
        if not cand: continue
        under_s, under_m = [], []
        for (oo, pred, clr) in others:
            s, m = seg_list(oo, pred)
            for sg, mm in zip(s, m): under_s.append(sg); under_m.append((oo, mm[0], oo[mm[0]]['ids'][mm[1] - 1], oo[mm[0]]['ids'][mm[1]], clr))
        tree = STRtree(under_s)
        for ri in cand:
            r = objs[ri]; k = 1
            while k < len(r['q']):
                seg = LineString([r['q'][k - 1], r['q'][k]])
                best = None
                for idx in tree.query(seg):
                    oo, oi, a, b, clr = under_m[idx]
                    o = oo[oi]
                    if o is r or (o.get('br') and o.get('layer', 0) >= r['layer']): continue
                    if a in (r['ids'][k - 1], r['ids'][k]) or b in (r['ids'][k - 1], r['ids'][k]): continue   # connected, not crossing
                    ip = seg.intersection(under_s[idx])
                    if ip.is_empty or ip.geom_type != 'Point': continue
                    ends = (r['q'][k - 1], r['q'][k], NODE[a], NODE[b])
                    if min(math.hypot(ip.x - e[0], ip.y - e[1]) for e in ends) < .6: continue                   # touching at an end
                    if o.get('layer', 0) < 0 and not o.get('br'):
                        LOWER.append((oo, oi, ip.x, ip.y, terrain(ip.x, ip.y) - clr)); continue
                    qa, qb = NODE[a], NODE[b]
                    L = math.hypot(qb[0] - qa[0], qb[1] - qa[1]) or 1
                    f = math.hypot(ip.x - qa[0], ip.y - qa[1]) / L
                    hu = HT.get(a, H0[a]) * (1 - f) + HT.get(b, H0[b]) * f
                    tgt = hu + clr
                    if best is None or tgt > best[0]: best = (tgt, ip.x, ip.y)
                if best:
                    i = insert_point(r, k, best[1], best[2])
                    for nb in (r['ids'][k - 1], r['ids'][k + 1]):
                        L = math.hypot(NODE[nb][0] - best[1], NODE[nb][1] - best[2]); adj[i][nb] = L; adj[nb][i] = L
                        adj[r['ids'][k - 1]].pop(r['ids'][k + 1], None); adj[r['ids'][k + 1]].pop(r['ids'][k - 1], None)
                    seeds[i] = max(seeds.get(i, 0), best[0]); k += 2
                else: k += 1
        propagate(adj, {i: h for i, h in seeds.items()}, grade)
    return seeds
road_seeds = bridge_pass(roads, RADJ, .052, [(roads, lambda r: True, 6.3), (rails, lambda r: r['kind'] == 1, 7.2)])
rail_seeds = bridge_pass(rails, LADJ, .03, [(roads, lambda r: True, 6.6)])
def propagate_down(adj, seeds, grade):
    hq = [(h, i) for i, h in seeds.items()]; heapq.heapify(hq)
    for i, h in seeds.items(): HT[i] = min(HT.get(i, 1e9), h)
    while hq:
        h, i = heapq.heappop(hq)
        if h > HT[i] + 1e-6: continue
        for j, L in adj[i].items():
            v = h + grade * L
            if v < HT.get(j, 1e9) - 1e-3 and v < H0.get(j, terrain(*NODE[j])):
                HT[j] = v; heapq.heappush(hq, (v, j))
low_seeds = {'road': {}, 'rail': {}}
for oo, oi, x, z, tgt in LOWER:
    o = oo[oi]; q = o['q']; best, bk = 1e18, 1
    for k in range(1, len(q)):
        (x0, z0), (x1, z1) = q[k - 1], q[k]; dx, dz = x1 - x0, z1 - z0; L2 = dx * dx + dz * dz or 1
        t = max(0, min(1, ((x - x0) * dx + (z - z0) * dz) / L2)); d = (x0 + dx * t - x) ** 2 + (z0 + dz * t - z) ** 2
        if d < best: best, bk = d, k
    adj = LADJ if oo is rails else RADJ; a_, b_ = o['ids'][bk - 1], o['ids'][bk]
    i = insert_point(o, bk, x, z)
    for nb in (a_, b_):
        L = math.hypot(NODE[nb][0] - x, NODE[nb][1] - z); adj[i][nb] = L; adj[nb][i] = L
    adj[a_].pop(b_, None); adj[b_].pop(a_, None)
    d_ = low_seeds['rail' if oo is rails else 'road']; d_[i] = min(d_.get(i, 1e9), tgt)
propagate_down(RADJ, low_seeds['road'], .06); propagate_down(LADJ, low_seeds['rail'], .03)
road_seeds.update(low_seeds['road']); rail_seeds.update(low_seeds['rail'])
log('lowered under bridges: roads', len(low_seeds['road']), 'rails', len(low_seeds['rail']))
log('road bridge seeds', len(road_seeds), 'rail bridge seeds', len(rail_seeds))
# graph smoothing of road heights (keeps junctions consistent), bridge seeds pinned
def smooth(adj, seeds, iters):
    keys = [i for i in adj if i in HT]
    for _ in range(iters):
        new = {}
        for i in keys:
            nb = adj[i]
            if not nb or i in seeds: continue
            s = sum(HT[j] for j in nb if j in HT); n = sum(1 for j in nb if j in HT)
            if n: new[i] = .5 * HT[i] + .5 * s / n
        HT.update(new)
smooth(RADJ, road_seeds, 12); smooth(LADJ, rail_seeds, 8)

# junction info: max half width of roads meeting at a node
deg = collections.Counter(); node_hw = collections.defaultdict(float)
for r in roads:
    ids = r['ids']
    for k, i in enumerate(ids):
        deg[i] += 1 if k in (0, len(ids) - 1) else 2
        node_hw[i] = max(node_hw[i], r['w'] / 2)
# tram ways follow roads: mark roads that carry trams nearby (for markings)

# ------------------------------------------------------------ buildings
LANDUSE_IND = []
for wid, pts, ids, t in d['ways']:
    if t.get('landuse') in ('industrial', 'commercial', 'retail', 'construction', 'garages') and len(pts) > 3 and pts[0] == pts[-1]:
        try: LANDUSE_IND.append(Polygon([P(*p) for p in pts]).buffer(0))
        except Exception: pass
IND_TREE = STRtree(LANDUSE_IND)
def in_industrial(pt): return any(LANDUSE_IND[i].contains(pt) for i in IND_TREE.query(pt))

raw_b = []   # (poly, tags, id, is_part)
for wid, pts, ids, t in d['ways']:
    if not ('building' in t or 'building:part' in t) or t.get('building') == 'no' or len(pts) < 4 or pts[0] != pts[-1]: continue
    try: pg = Polygon([P(*p) for p in pts]).buffer(0)
    except Exception: continue
    for p in polys_of(pg): raw_b.append((p, t, wid, 'building:part' in t and 'building' not in t))
for rid, mem, t in d['rels']:
    if 'building' not in t and 'building:part' not in t: continue
    g = rel_polys(mem)
    for p in polys_of(g): raw_b.append((p, t, -rid, 'building:part' in t and 'building' not in t))
raw_b = [b for b in raw_b if AREAP.contains(b[0].representative_point()) and b[0].area > 8]
parts = [b for b in raw_b if b[3]]
ptree = STRtree([b[0].representative_point() for b in parts]) if parts else None
def has_parts(poly):
    if not ptree: return False
    return any(poly.contains(parts[i][0].representative_point()) for i in ptree.query(poly))
COL = dict(cream=0, ochre=1, pink=2, lgrey=3, white=4, blueg=5, panel=6, panel2=7, brick=8, glass=9, dglass=10, ind=11, metal=12, house=13, church=14, stone=15, gold=16)
def style_of(t, area, r, ind, h):
    b = t.get('building') or t.get('building:part') or 'yes'
    hh = hid(t.get('name', '') + str(area))
    if b in ('church', 'cathedral', 'chapel', 'mosque', 'synagogue'): return 6, COL['church']
    if b in ('industrial', 'warehouse', 'hangar', 'factory', 'manufacture', 'storage_tank', 'service', 'transformer_tower') or ind and b == 'yes' and h < 14: return 4, [COL['ind'], COL['metal'], COL['lgrey']][hh % 3]
    if b in ('office', 'commercial') or (h > 40 and b not in ('apartments', 'residential')): return 3, [COL['glass'], COL['dglass'], COL['lgrey'], COL['blueg']][hh % 4]
    if b in ('house', 'detached', 'semidetached_house', 'bungalow', 'terrace', 'farm', 'villa'): return 5, [COL['house'], COL['cream'], COL['white'], COL['ochre']][hh % 4]
    if b in ('garage', 'garages', 'shed', 'kiosk', 'roof', 'carport', 'hut'): return 4, [COL['lgrey'], COL['ind']][hh % 2]
    if b in ('government', 'public', 'civic', 'university', 'museum', 'courthouse'): return 1, [COL['stone'], COL['cream'], COL['ochre']][hh % 3]
    if (b in ('apartments', 'residential', 'yes') and area > 650 and r > 2200 and h >= 18): return 2, [COL['panel'], COL['panel2'], COL['panel'], COL['white']][hh % 4]
    return 1, [COL['cream'], COL['ochre'], COL['pink'], COL['lgrey'], COL['white'], COL['blueg'], COL['brick']][hh % 7]
def b_height(t, area, r, ind, key):
    b = t.get('building') or t.get('building:part') or 'yes'
    h = num(t.get('height'))
    lv = num(t.get('building:levels'))
    if h is None and lv is not None: h = lv * 3.05 + (1.2 if lv >= 2 else .6)
    hh = hid(key)
    if h is None:
        if b in ('garage', 'garages', 'shed', 'kiosk', 'carport', 'hut', 'service', 'transformer_tower'): h = 3.0
        elif b == 'roof': h = 5.0
        elif b in ('house', 'detached', 'semidetached_house', 'bungalow', 'villa', 'farm'): h = 6.5 + (hh % 3) * 1.5
        elif b in ('church', 'cathedral', 'chapel'): h = 12 + min(20, math.sqrt(area) * .4)
        elif b in ('industrial', 'warehouse', 'hangar', 'factory', 'manufacture') or (ind and b in ('yes', 'commercial', 'retail')): h = 7 + (hh % 3) * 2
        elif b in ('retail', 'supermarket'): h = 6 + (hh % 2) * 3
        elif b in ('school', 'kindergarten', 'hospital', 'university', 'public', 'government'): h = 10 + (hh % 3) * 3.1
        else:
            if area < 60: lvls = 1 + hh % 2
            elif area < 220: lvls = 2 + hh % 3 if r > 3000 else 3 + hh % 3
            elif area < 650: lvls = (3 + hh % 4) if r > 3000 else (4 + hh % 3)
            else:
                if r < 2200: lvls = 5 + hh % 3
                elif b in ('apartments', 'residential') or b == 'yes': lvls = [6, 8, 8, 9, 12, 13, 14, 15, 16][hh % 9] if area > 900 else 5 + hh % 5
                else: lvls = 4 + hh % 4
            h = lvls * 3.05 + 1.2
    h = min(max(h, 2.5), 260)
    mh = num(t.get('min_height'))
    if mh is None and t.get('building:min_level') is not None: mh = (num(t.get('building:min_level'), 0) or 0) * 3.05
    return h, min(mh or 0, h - 1)
CNAMES = dict(white='#f2f0ea', black='#2a2a2a', grey='#9a9a96', gray='#9a9a96', darkgrey='#5e5e5c', darkgray='#5e5e5c', lightgrey='#c9c9c4', lightgray='#c9c9c4', silver='#c0c2c4',
    red='#a83c2c', darkred='#7a2a20', brown='#7a5236', maroon='#6e2a22', orange='#d27a35', yellow='#e3c75a', beige='#dccfae', cream='#ece2c4', ivory='#efe9d6', tan='#c9a77d', khaki='#c7b77e',
    gold='#d4ac3f', green='#4f7d52', darkgreen='#2f5a3c', olive='#7d7d45', lime='#9ac35a', teal='#3f8a86', blue='#4f74a8', navy='#2c3e66', lightblue='#9cbcd8', skyblue='#8fc0e0', pink='#e2a9a6',
    purple='#7a5a8c', wheat='#e3d2a6', salmon='#e09a82', sand='#d8c59a', terracotta='#b1593c', copper='#5f9a87', bronze='#8a6a3a', sienna='#9a5634', peru='#c08549', chocolate='#7a4a2a')
def colour(v):
    if not v: return None
    v = v.strip().lower().replace(' ', '').split(';')[0]
    if v.startswith('#') and len(v) in (4, 7):
        try:
            if len(v) == 4: v = '#' + ''.join(ch * 2 for ch in v[1:])
            return (int(v[1:3], 16), int(v[3:5], 16), int(v[5:7], 16))
        except ValueError: return None
    v = CNAMES.get(v)
    return (int(v[1:3], 16), int(v[3:5], 16), int(v[5:7], 16)) if v else None
RSHAPE = {'dome': 1, 'onion': 2, 'pyramidal': 3, 'hipped': 3, 'gabled': 3, 'half-hipped': 3, 'mansard': 3, 'gambrel': 3, 'cone': 4}
buildings = []
for poly, t, key, part in raw_b:
    if not part and has_parts(poly): continue
    poly = poly.simplify(.35, preserve_topology=True)
    if poly.is_empty or poly.area < 8 or poly.geom_type != 'Polygon': continue
    c = poly.representative_point(); r = math.hypot(c.x, c.y); ind = in_industrial(c)
    h, mh = b_height(t, poly.area, r, ind, key)
    st, col = style_of(t, poly.area, r, ind, h)
    ring = list(poly.exterior.coords)[:-1]
    if len(ring) < 3 or len(ring) > 400: continue
    base = min(terrain(x, z) for x, z in ring[::max(1, len(ring) // 8)])
    flags = 0
    b = t.get('building') or t.get('building:part') or ''
    if b in ('roof', 'carport'): flags |= 1
    if b in ('church', 'cathedral') and poly.area > 250: flags |= 4
    wc, rc = colour(t.get('building:colour') or t.get('colour')), colour(t.get('roof:colour'))
    if wc: flags |= 16
    if rc: flags |= 32
    rs = RSHAPE.get(t.get('roof:shape', ''), 0); rh = num(t.get('roof:height'))
    if rs and rh is None: rh = min(8, math.sqrt(poly.area) * (.45 if rs in (1, 2, 4) else .3))
    if rs and (flags & 4): flags &= ~4
    buildings.append(dict(ring=ring, h=h, mh=mh, base=base, st=st, col=col, flags=flags, cx=c.x, cz=c.y, area=poly.area, name=t.get('name', ''),
                          rs=rs, rh=min(rh or 0, h * .6), wc=wc or (0, 0, 0), rc=rc or (0, 0, 0)))
log('buildings', len(buildings), 'parts kept', sum(1 for b in raw_b if b[3]))

# ------------------------------------------------------------ ground areas
def area_kind(t):
    L, Le, N, A, W = t.get('landuse'), t.get('leisure'), t.get('natural'), t.get('amenity'), t.get('water')
    if N == 'water' or W or t.get('waterway') == 'riverbank' or L in ('reservoir', 'basin'): return 3
    if t.get('aeroway') in ('apron',): return 12
    if Le in ('pitch', 'track', 'stadium') and 'building' not in t: return 7
    if L in ('forest',) or N in ('wood',): return 2
    if N in ('scrub', 'heath'): return 13
    if Le in ('park', 'garden', 'dog_park') or L in ('grass', 'village_green', 'recreation_ground', 'flowerbed', 'meadow') or N in ('grassland',) or Le == 'playground': return 1
    if L in ('cemetery',) or A == 'grave_yard': return 9
    if L in ('farmland', 'orchard', 'vineyard', 'allotments', 'plant_nursery', 'farmyard'): return 8
    if A == 'parking' and t.get('parking', 'surface') == 'surface': return 5
    if t.get('place') == 'square' or t.get('highway') == 'pedestrian' or 'area:highway' in t or A == 'marketplace': return 4
    if L == 'railway': return 6
    if L in ('industrial', 'construction', 'brownfield', 'garages', 'commercial', 'retail', 'landfill', 'quarry'): return 10
    if N in ('sand', 'bare_rock', 'scree', 'beach'): return 11
    if A in ('school', 'kindergarten', 'university', 'college', 'hospital'): return 14
    return 0
TREE_DENS = {1: 1 / 140, 2: 1 / 55, 13: 1 / 160, 9: 1 / 120}   # park trees are thinned near paths at runtime
areas = []
for wid, pts, ids, t in d['ways']:
    if 'building' in t or len(pts) < 4 or pts[0] != pts[-1]: continue
    k = area_kind(t)
    if not k: continue
    if k in (4,) and t.get('highway') == 'pedestrian' and t.get('area') != 'yes': continue
    try: pg = Polygon([P(*p) for p in pts]).buffer(0)
    except Exception: continue
    for p in polys_of(pg.intersection(AREA)): areas.append((k, p, t.get('leisure') == 'garden'))
for rid, mem, t in d['rels']:
    if 'building' in t: continue
    k = area_kind(t)
    if not k: continue
    g = rel_polys(mem)
    if g is None: continue
    for p in polys_of(g.intersection(AREA)): areas.append((k, p, False))
areas = [a for a in areas if a[1].area > 20]
log('areas', len(areas), collections.Counter(a[0] for a in areas))

# rivers as lines (painted as water)
rivers = []
for wid, pts, ids, t in d['ways']:
    ww = t.get('waterway')
    if ww not in ('river', 'stream', 'canal', 'drain', 'ditch') or t.get('tunnel') not in (None, 'no') or t.get('layer', '0').startswith('-'): continue
    q = [P(*p) for p in pts]
    if not any(AREAP.contains(Point(p)) for p in q): continue
    w = num(t.get('width')) or {'river': 9, 'canal': 6, 'stream': 3, 'drain': 2, 'ditch': 1.5}[ww]
    rivers.append((q, min(w, 40)))

# ------------------------------------------------------------ points: trees, crossings, signals
road_of_node = {}
for ri, r in enumerate(roads):
    for k, i in enumerate(r['ids']):
        if i > 0 and (i not in road_of_node or r['c'] < roads[road_of_node[i][0]]['c']): road_of_node[i] = (ri, k)
trees, crossings, signals = [], [], []
for nid, lo, la, t in d['nodes']:
    x, z = P(lo, la)
    if not AREAP.contains(Point(x, z)): continue
    if t.get('natural') == 'tree': trees.append((x, z)); continue
    h = t.get('highway')
    if h in ('crossing', 'traffic_signals') and nid in road_of_node:
        ri, k = road_of_node[nid]; r = roads[ri]; q = r['q']
        a, b = q[max(k - 1, 0)], q[min(k + 1, len(q) - 1)]
        L = math.hypot(b[0] - a[0], b[1] - a[1]) or 1; dx, dz = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        hh = HT.get(nid, terrain(x, z))
        if h == 'crossing' and t.get('crossing') not in ('unmarked', 'no', 'informal') and r['c'] not in (1, 2, 11, 12, 16, 17): crossings.append((x, z, hh, dx, dz, r['w'] / 2))
        if h == 'traffic_signals' or t.get('crossing') == 'traffic_signals': signals.append((x, z, hh, dx, dz, r['w'] / 2, 1 if h == 'traffic_signals' else 0))
for wid, pts, ids, t in d['ways']:
    if t.get('natural') == 'tree_row':
        q = [P(*p) for p in pts]
        for k in range(1, len(q)):
            L = math.hypot(q[k][0] - q[k - 1][0], q[k][1] - q[k - 1][1]); n = max(1, int(L / 9))
            for m in range(n):
                f = m / n; x, z = q[k - 1][0] + (q[k][0] - q[k - 1][0]) * f, q[k - 1][1] + (q[k][1] - q[k - 1][1]) * f
                if AREAP.contains(Point(x, z)): trees.append((x, z))
log('trees', len(trees), 'crossings', len(crossings), 'signals', len(signals))

# ------------------------------------------------------------ split lines into 1 km region pieces
def reg_of(x, z): return (int(math.floor(x / REG)), int(math.floor(z / REG)))
def split_poly(q, hs):
    """split a polyline at region borders -> list of (region, q, hs, idx_map) pieces"""
    out = []; cur = [(q[0], hs[0], 0)]
    for k in range(1, len(q)):
        (x0, z0), (x1, z1) = q[k - 1], q[k]; h0, h1 = hs[k - 1], hs[k]
        cuts = []
        for axis, a0, a1 in ((0, x0, x1), (1, z0, z1)):
            lo, hi = min(a0, a1), max(a0, a1)
            g = math.floor(lo / REG) + 1
            while g * REG < hi:
                f = (g * REG - a0) / (a1 - a0); cuts.append(f); g += 1
        for f in sorted(cuts):
            pt = (x0 + (x1 - x0) * f, z0 + (z1 - z0) * f); hh = h0 + (h1 - h0) * f
            cur.append((pt, hh, -1)); out.append(cur); cur = [(pt, hh, -1)]
        cur.append(((x1, z1), h1, k))
    out.append(cur)
    res = []
    for piece in out:
        if len(piece) < 2: continue
        mx = sum(p[0][0] for p in piece[:2]) / 2; mz = sum(p[0][1] for p in piece[:2]) / 2
        res.append((reg_of(mx, mz), piece))
    return res

REGIONS = collections.defaultdict(lambda: dict(roads=[], bld=[], areas=[], rails=[], rivers=[], trees=[], cross=[], sig=[]))
names = []; name_idx = {}
def nidx(s):
    if not s: return 65535
    if s not in name_idx: name_idx[s] = len(names); names.append(s)
    return name_idx[s]
for r in roads:
    hs = [HT.get(i, terrain(*NODE[i])) for i in r['ids']]
    jw = [(node_hw[i] if deg[i] >= 3 or (deg[i] == 2 and k in (0, len(r['ids']) - 1) and False) else 0) for k, i in enumerate(r['ids'])]
    # elevation above terrain (for bridge walls)
    for reg, piece in split_poly(r['q'], hs):
        pts = [(p[0][0], p[0][1], p[1], jw[p[2]] if p[2] >= 0 else 0) for p in piece]
        REGIONS[reg]['roads'].append(dict(p=pts, c=r['c'], w=r['w'], ow=r['ow'], br=r['br'], sw=r['sw'], lanes=r['lanes'], name=nidx(r['name'])))
for r in rails:
    hs = [HT.get(i, terrain(*NODE[i])) for i in r['ids']]
    for reg, piece in split_poly(r['q'], hs):
        REGIONS[reg]['rails'].append(dict(p=[(p[0][0], p[0][1], p[1]) for p in piece], k=r['kind'], br=r['br']))
for q, w in rivers:
    hs = [terrain(*p) for p in q]
    for reg, piece in split_poly(q, hs): REGIONS[reg]['rivers'].append(dict(p=[(p[0][0], p[0][1]) for p in piece], w=w))
for b in buildings: REGIONS[reg_of(b['cx'], b['cz'])]['bld'].append(b)
for k, p, garden in areas:
    x0, z0, x1, z1 = p.bounds
    for i in range(int(math.floor(x0 / REG)), int(math.floor(x1 / REG)) + 1):
        for j in range(int(math.floor(z0 / REG)), int(math.floor(z1 / REG)) + 1):
            c = p.intersection(box(i * REG, j * REG, (i + 1) * REG, (j + 1) * REG))
            for pp in polys_of(c):
                pp = pp.simplify(.6, preserve_topology=True)
                if pp.area > 12: REGIONS[(i, j)]['areas'].append((k, pp))
for x, z in trees: REGIONS[reg_of(x, z)]['trees'].append((x, z))
for c in crossings: REGIONS[reg_of(c[0], c[1])]['cross'].append(c)
for s in signals: REGIONS[reg_of(s[0], s[1])]['sig'].append(s)
# only regions touching the playable area
REGIONS = {k: v for k, v in REGIONS.items() if AREA.intersects(box(k[0] * REG, k[1] * REG, (k[0] + 1) * REG, (k[1] + 1) * REG))}

# ------------------------------------------------------------ binary writer
def q16(v, o): return int(max(-32767, min(32767, round((v - o) * 10))))
def write_region(key, R):
    ox, oz = key[0] * REG, key[1] * REG
    arrs = {}
    # roads
    rp, rn, ra, rj, rnm = [], [], [], [], []
    for r in R['roads']:
        rn.append(len(r['p']))
        for x, z, h, jw in r['p']: rp += [q16(x, ox), q16(z, oz), int(round(h * 10))]; rj.append(min(255, int(round(jw * 2))))
        ra += [r['c'], min(255, int(round(r['w'] * 4))), (1 if r['ow'] else 0) | (2 if r['br'] else 0), min(255, int(round(r['sw'] * 4))), min(255, r['lanes']), 0]
        rnm.append(r['name'])
    arrs['rp'] = ('i16', rp); arrs['rn'] = ('u16', rn); arrs['ra'] = ('u8', ra); arrs['rj'] = ('u8', rj); arrs['rnm'] = ('u16', rnm)
    # buildings
    bp, bn, bh, bm, bb, bs = [], [], [], [], [], []
    for b in R['bld']:
        bn.append(len(b['ring']))
        for x, z in b['ring']: bp += [q16(x, ox), q16(z, oz)]
        bh.append(int(round(b['h'] * 10))); bm.append(int(round(b['mh'] * 10))); bb.append(int(round(b['base'] * 10)))
        bs += [b['st'], b['col'], b['flags'], b['rs'], *b['wc'], *b['rc'], min(255, int(round(b['rh'] * 4))), 0]
    arrs['bp'] = ('i16', bp); arrs['bn'] = ('u16', bn); arrs['bh'] = ('u16', bh); arrs['bm'] = ('u16', bm); arrs['bb'] = ('i16', bb); arrs['bs'] = ('u8', bs)
    # areas (rings: outer then holes)
    ap, an, ak = [], [], []
    for k, p in sorted(R['areas'], key=lambda a: a[0]):
        rings = [list(p.exterior.coords)[:-1]] + [list(h.coords)[:-1] for h in p.interiors]
        for n, ring in enumerate(rings):
            if len(ring) < 3: continue
            an.append(len(ring)); ak.append(k | (0x80 if n else 0))
            for x, z in ring: ap += [q16(x, ox), q16(z, oz)]
    arrs['ap'] = ('i16', ap); arrs['an'] = ('u16', an); arrs['ak'] = ('u8', ak)
    # rails, rivers
    lp, ln, lk = [], [], []
    for r in R['rails']:
        ln.append(len(r['p'])); lk.append(r['k'] | (0x10 if r['br'] else 0))
        for x, z, h in r['p']: lp += [q16(x, ox), q16(z, oz), int(round(h * 10))]
    for r in R['rivers']:
        ln.append(len(r['p'])); lk.append(3);
        for x, z in r['p']: lp += [q16(x, ox), q16(z, oz), min(32767, int(round(r['w'] * 10)))]
    arrs['lp'] = ('i16', lp); arrs['ln'] = ('u16', ln); arrs['lk'] = ('u8', lk)
    tp = []
    for x, z in R['trees']: tp += [q16(x, ox), q16(z, oz)]
    arrs['tp'] = ('i16', tp)
    cp = []
    for x, z, h, dx, dz, hw in R['cross']: cp += [q16(x, ox), q16(z, oz), int(round(h * 10)), int(round(dx * 1000)), int(round(dz * 1000)), int(round(hw * 10))]
    arrs['cp'] = ('i16', cp)
    sp = []
    for x, z, h, dx, dz, hw, kind in R['sig']: sp += [q16(x, ox), q16(z, oz), int(round(h * 10)), int(round(dx * 1000)), int(round(dz * 1000)), int(round(hw * 10)), kind]
    arrs['sp'] = ('i16', sp)
    # pack
    TY = {'i16': ('<i2', 2), 'u16': ('<u2', 2), 'u8': ('u1', 1)}
    header = {'v': 1, 'x0': ox, 'z0': oz, 'arr': {}}
    blobs = b''; off = 0
    for nm, (ty, data) in arrs.items():
        a = np.asarray(data, dtype=TY[ty][0]).tobytes()
        while off % 4: blobs += b'\0'; off += 1
        header['arr'][nm] = [ty, off, len(data)]
        blobs += a; off += len(a)
    hj = json.dumps(header, separators=(',', ':')).encode()
    hj += b' ' * ((4 - (len(hj) + 8) % 4) % 4)
    return b'MWC1' + struct.pack('<I', len(hj)) + hj + blobs
# tiles are bundled into packs of PACK x PACK km (fewer files to host and upload)
PACK = CFG.get('pack', 4)
for fn in os.listdir(OUT):
    if (fn.startswith('r_') or fn.startswith('p_')) and fn.endswith('.bin'): os.remove(os.path.join(OUT, fn))
packs = collections.defaultdict(list); tot = 0; sizes = {}
for key, R in REGIONS.items():
    blob = write_region(key, R); sizes[key] = len(blob); tot += len(blob)
    packs[(key[0] // PACK, key[1] // PACK)].append((key, blob))
psz = []
for pk, items in packs.items():
    head = struct.pack('<4sI', b'MWP1', len(items)); body = b''; idx = b''
    off0 = 8 + 12 * len(items)
    for key, blob in items:
        while (off0 + len(body)) % 4: body += b'\0'
        idx += struct.pack('<hhII', key[0], key[1], off0 + len(body), len(blob)); body += blob
    data = head + idx + body; psz.append(len(data))
    open(os.path.join(OUT, f'p_{pk[0]}_{pk[1]}.bin'), 'wb').write(data)
log('regions', len(REGIONS), 'in', len(packs), 'packs; total MB', round(tot / 1e6, 2), 'max tile KB', round(max(sizes.values()) / 1e3), 'max pack KB', round(max(psz) / 1e3))

# ------------------------------------------------------------ network for minimap & navigation (all roads except service)
NET_C = set(range(1, 9)) | {10, 11, 12, 13, 14, 15}
nodes_net = {}; edges = []
def nn(i):
    if i not in nodes_net: nodes_net[i] = len(nodes_net)
    return nodes_net[i]
keep_node = set(i for i, c in deg.items() if c >= 3)
for r in roads:
    if r['c'] not in NET_C: continue
    ids = r['ids']; start = 0
    for k in range(1, len(ids)):
        if k == len(ids) - 1 or ids[k] in keep_node:
            seg = ids[start:k + 1]
            q = [NODE[i] for i in seg]
            L = sum(math.hypot(q[m][0] - q[m - 1][0], q[m][1] - q[m - 1][1]) for m in range(1, len(q)))
            simp = list(LineString(q).simplify(2.5).coords) if len(q) > 2 else q
            edges.append((nn(seg[0]), nn(seg[-1]), r['c'], 1 if r['ow'] else 0, L, simp, nidx(r['name'])))
            start = k
nodexy = [None] * len(nodes_net)
for i, k in nodes_net.items(): nodexy[k] = NODE[i]
buf = bytearray()
buf += struct.pack('<4sII', b'MWN1', len(nodexy), len(edges))
buf += np.asarray(nodexy, dtype='<f4').tobytes()
E = np.zeros((len(edges), 5), dtype='<u4'); EL = np.zeros(len(edges), dtype='<f4'); pts = []; pc = []
for e, (a, b, c, ow, L, simp, nm) in enumerate(edges):
    E[e] = (a, b, c | (ow << 8), len(pts) // 2, nm); EL[e] = L; pc.append(len(simp))
    for x, z in simp: pts += [x, z]
buf += E.tobytes() + EL.tobytes() + np.asarray(pc, dtype='<u2').tobytes()
while len(buf) % 4: buf += b'\0'
buf += struct.pack('<I', len(pts) // 2) + np.asarray(pts, dtype='<f4').tobytes()
open(os.path.join(OUT, 'net.bin'), 'wb').write(buf)
log('net nodes', len(nodexy), 'edges', len(edges), 'KB', round(len(buf) / 1e3))

# ------------------------------------------------------------ landmarks, challenges, skyline
def way_centroid(wid):
    if wid in waydict: return Polygon([P(*p) for p in waydict[wid][0]]).centroid.coords[0] if len(waydict[wid][0]) > 3 else P(*waydict[wid][0][0])
    return None
nodepos = {nid: P(lo, la) for nid, lo, la, t in d['nodes']}
def find_named(sub, pred=lambda t: True):
    for wid, pts, ids, t in d['ways']:
        if sub in t.get('name', '') and pred(t): return way_centroid(wid)
    for nid, lo, la, t in d['nodes']:
        if sub in t.get('name', '') and pred(t): return P(lo, la)
    return None
# nearest drivable road point (major roads preferred) for a landmark
road_pts = []
for r in roads:
    if r['c'] in (9, 16, 17): continue
    for k in range(len(r['q'])):
        a = r['q'][k]; b = r['q'][min(k + 1, len(r['q']) - 1)] if k + 1 < len(r['q']) else r['q'][k - 1]
        L = math.hypot(b[0] - a[0], b[1] - a[1]) or 1; s = 1 if k + 1 < len(r['q']) else -1
        road_pts.append((a[0], a[1], r['c'], s * (b[0] - a[0]) / L, s * (b[1] - a[1]) / L, HT.get(r['ids'][k], terrain(*a))))
RPA = np.array([(p[0], p[1]) for p in road_pts])
def snap(x, z, maxc=7):
    dd = np.hypot(RPA[:, 0] - x, RPA[:, 1] - z) + np.array([0 if p[2] <= 5 else 70 if p[2] <= maxc else 1e6 for p in road_pts])
    k = int(np.argmin(dd)); p = road_pts[k]
    return dict(x=round(p[0], 1), z=round(p[1], 1), y=round(p[5], 1), dx=round(p[3], 3), dz=round(p[4], 3))
landmarks = {}
for L in CFG['landmarks']:
    p = None
    try:
        if 'way' in L: p = way_centroid(L['way'])
        elif 'node' in L: p = nodepos.get(L['node'])
        if p is None and 'name' in L:
            for nm in L['name']:
                p = find_named(nm)
                if p: break
    except Exception: p = None
    if not p or not AREAP.contains(Point(p)): log('landmark missing/outside', L['key']); continue
    s_ = snap(p[0], p[1])
    landmarks[L['key']] = dict(en=L['en'], bg=L['bg'], x=round(p[0], 1), z=round(p[1], 1), road=s_)
rw = [r for r in roads if r['c'] == 16] if CFG.get('runway') else []
if rw:
    r = max(rw, key=lambda r: LineString(r['q']).length); a, b = r['q'][0], r['q'][-1]
    L = math.hypot(b[0] - a[0], b[1] - a[1]); dx, dz = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    landmarks['rwy_a'] = dict(en='Runway 09', bg='Писта 09', x=a[0] + dx * 120, z=a[1] + dz * 120, road=dict(x=round(a[0] + dx * 120, 1), z=round(a[1] + dz * 120, 1), y=round(terrain(a[0], a[1]), 1), dx=round(dx, 3), dz=round(dz, 3)))
    landmarks['rwy_b'] = dict(en='Runway 27', bg='Писта 27', x=b[0] - dx * 120, z=b[1] - dz * 120, road=dict(x=round(b[0] - dx * 120, 1), z=round(b[1] - dz * 120, 1), y=round(terrain(b[0], b[1]), 1), dx=round(-dx, 3), dz=round(-dz, 3)))
log('landmarks', list(landmarks))
challenges = []
for cid, en, bg, a, b in CFG['challenges']:
    if a in landmarks and b in landmarks:
        A_, B_ = landmarks[a]['road'], landmarks[b]['road']
        challenges.append(dict(id=cid, en=en, bg=bg, a=a, b=b, km=round(math.hypot(A_['x'] - B_['x'], A_['z'] - B_['z']) / 1000, 1)))
    else: log('challenge dropped', cid)
# far city: oriented boxes of every building 18 m and taller, tagged with their region (hidden where the tile is built)
reg_index = {tuple(k): n for n, k in enumerate(sorted([list(k) for k in REGIONS]))}
sky = []
for b in buildings:
    if b['h'] < 18 or b['flags'] & 1: continue
    key = reg_of(b['cx'], b['cz'])
    if key not in reg_index: continue
    rect = Polygon(b['ring']).minimum_rotated_rectangle
    if rect.geom_type != 'Polygon': continue
    c4 = list(rect.exterior.coords)[:4]
    sky.append((c4, b['base'], b['h'] - (b['rh'] if b['rs'] else 0), b['col'], b['st'], reg_index[key]))
buf = bytearray(struct.pack('<4sI', b'MWS1', len(sky)))
SP = np.array([[round(v * 2) for xz in c4 for v in xz] for c4, *_ in sky], dtype='<i2').reshape(-1, 8)
buf += SP.tobytes() + np.array([round(x[1] * 10) for x in sky], dtype='<i2').tobytes() + np.array([round(x[2] * 10) for x in sky], dtype='<u2').tobytes()
buf += np.array([x[5] for x in sky], dtype='<u2').tobytes() + np.array([x[3] for x in sky], dtype='u1').tobytes() + np.array([x[4] for x in sky], dtype='u1').tobytes()
open(os.path.join(OUT, 'skyline.bin'), 'wb').write(buf)
skyline = []
log('far city boxes', len(sky), 'KB', round(len(buf) / 1e3))
spawn = landmarks[CFG['spawn']]['road'] if CFG.get('spawn') in landmarks else snap(0, 0)
meta = dict(v=1, id=CFG['id'], name=CFG['name'], nameBg=CFG.get('nameBg', CFG['name']), desc=CFG.get('desc', {}), flat=FLAT is not None, proj=dict(lat0=LAT0, lon0=LON0, kx=KX, ky=KY), reg=REG, pack=PACK,
            regions=sorted([list(k) for k in REGIONS]), sizes={f'{k[0]}_{k[1]}': v for k, v in sizes.items()},
            terrain=dict(x0=TX0, z0=TZ0, s=TS, nx=NX, nz=NZ),
            area=[[round(x), round(z)] for x, z in AREA.exterior.coords[:-1]], names=names,
            landmarks=landmarks, challenges=challenges, skyN=len(sky), spawn=spawn,
            credits=CFG.get('credits', ['Map data © OpenStreetMap contributors (ODbL 1.0)']))
json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
log('meta KB', round(os.path.getsize(os.path.join(OUT, 'meta.json')) / 1e3), 'challenges', [c['id'] for c in challenges])
