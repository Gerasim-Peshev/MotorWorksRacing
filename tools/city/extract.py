"""One pass over the Bulgaria OSM file: keep everything the Sofia map needs inside a box around the Ring Road."""
import osmium, pickle, sys, time
PBF, OUT = sys.argv[1], sys.argv[2]
# bounding box: west east south north (default: Sofia)
W, E, S, N = map(float, sys.argv[3].split(',')) if len(sys.argv) > 3 else (23.12, 23.52, 42.57, 42.80)
inb = lambda lon, lat: W <= lon <= E and S <= lat <= N
KEYS = ('highway', 'building', 'building:part', 'landuse', 'leisure', 'natural', 'amenity', 'railway', 'waterway', 'water', 'tourism', 'historic', 'man_made', 'place', 'bridge', 'area:highway', 'aeroway', 'barrier', 'shop')
nodes, ways, rels, geom = [], [], [], {}
t0 = time.time(); n = 0
for o in osmium.FileProcessor(PBF).with_locations():
    n += 1
    if o.is_node():
        if not o.tags or not o.location.valid() or not inb(o.location.lon, o.location.lat): continue
        t = dict(o.tags)
        if any(k in t for k in ('name', 'natural', 'highway', 'amenity', 'tourism', 'historic', 'railway', 'man_made')):
            nodes.append((o.id, o.location.lon, o.location.lat, t))
    elif o.is_way():
        try: pts = [(nd.lon, nd.lat) for nd in o.nodes]
        except osmium.InvalidLocationError: continue
        if not any(inb(x, y) for x, y in pts): continue
        t = dict(o.tags)
        ids = [nd.ref for nd in o.nodes]
        if any(k in t for k in KEYS): ways.append((o.id, pts, ids, t))
        else: geom[o.id] = pts            # untagged: maybe a multipolygon member
    elif o.is_relation():
        t = dict(o.tags)
        if t.get('type') not in ('multipolygon', 'building') and not ('highway' in t and t.get('type') == 'multipolygon'): continue
        if not any(k in t for k in KEYS): continue
        mem = [(m.ref, m.role) for m in o.members if m.type == 'w']
        rels.append((o.id, mem, t))
print(f'{n} objects in {time.time()-t0:.0f}s: {len(nodes)} nodes, {len(ways)} tagged ways, {len(geom)} untagged ways, {len(rels)} relations')
# keep geometry of tagged ways too for relation assembly
for wid, pts, ids, t in ways: geom.setdefault(wid, pts)
need = {r for _, mem, _ in rels for r, _ in mem}
geom = {k: v for k, v in geom.items() if k in need}
pickle.dump({'nodes': nodes, 'ways': ways, 'rels': rels, 'geom': geom, 'bbox': (W, E, S, N)}, open(OUT, 'wb'))
print('saved', OUT)
