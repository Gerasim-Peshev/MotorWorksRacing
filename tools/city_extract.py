"""Extract a city from an OpenStreetMap .osm.pbf into a compact pickle for build_city.py.
Usage: python3 city_extract.py bulgaria.osm.pbf out.pkl  (bounding box below: Sofia with a margin)
Keeps drivable roads, buildings, land cover areas, water, rail, trees and place names."""
import osmium, pickle, sys, math

PBF, OUT = sys.argv[1], sys.argv[2]
W, S, E, N = 23.13, 42.56, 23.52, 42.80          # lon/lat box (city + margin)
ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'service', 'pedestrian', 'road'}
SKIP_SERVICE = {'parking_aisle', 'driveway', 'drive-through', 'emergency_access'}
COVER = {  # tag -> value set -> cover class
    'landuse': {'residential': 'urban', 'commercial': 'urban', 'retail': 'urban', 'industrial': 'industrial', 'railway': 'industrial', 'construction': 'bare',
                'brownfield': 'bare', 'garages': 'urban', 'grass': 'grass', 'meadow': 'grass', 'recreation_ground': 'grass', 'village_green': 'grass',
                'cemetery': 'cemetery', 'forest': 'forest', 'farmland': 'farm', 'orchard': 'farm', 'allotments': 'farm', 'farmyard': 'farm', 'greenfield': 'grass', 'military': 'bare'},
    'natural': {'wood': 'forest', 'scrub': 'scrub', 'grassland': 'grass', 'heath': 'scrub', 'water': 'water', 'bare_rock': 'bare', 'sand': 'bare', 'wetland': 'grass'},
    'leisure': {'park': 'park', 'garden': 'park', 'pitch': 'pitch', 'stadium': 'pitch', 'golf_course': 'grass', 'playground': 'park', 'track': 'pitch', 'nature_reserve': 'forest'},
    'amenity': {'parking': 'paved', 'school': 'urban', 'university': 'urban', 'hospital': 'urban', 'college': 'urban', 'kindergarten': 'urban'},
    'waterway': {'riverbank': 'water', 'dock': 'water'},
    'place': {'square': 'paved'},
    'highway': {'pedestrian': 'paved'},
    'aeroway': {'aerodrome': 'grass', 'apron': 'paved', 'runway': 'paved', 'taxiway': 'paved'},
}

def inb(lon, lat): return W <= lon <= E and S <= lat <= N
def num(v):
    if v is None: return None
    try: return float(str(v).split(';')[0].replace(',', '.').replace('m', '').strip())
    except Exception: return None

class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.roads, self.buildings, self.cover, self.water_lines, self.rail, self.trees, self.places, self.tree_rows = [], [], [], [], [], [], [], []
        self.crossings, self.signals = {}, {}
    def node(self, n):
        if not n.location.valid() or not inb(n.location.lon, n.location.lat): return
        t = n.tags
        if t.get('natural') == 'tree': self.trees.append((n.location.lon, n.location.lat))
        hw = t.get('highway')
        if hw == 'crossing' and t.get('crossing') not in ('unmarked', 'no', 'informal') and t.get('crossing_ref') != 'none': self.crossings[n.id] = (n.location.lon, n.location.lat)
        elif hw == 'traffic_signals': self.signals[n.id] = (n.location.lon, n.location.lat)
        p = t.get('place')
        if p in ('suburb', 'quarter', 'neighbourhood', 'city', 'town', 'village') and t.get('name'):
            self.places.append((n.location.lon, n.location.lat, p, t.get('name'), t.get('name:en') or t.get('int_name')))
    def way(self, w):
        t = w.tags
        hw = t.get('highway'); ww = t.get('waterway'); rw = t.get('railway'); nt = t.get('natural')
        if not (hw in ROADS or ww in ('river', 'stream', 'canal') or rw in ('rail', 'tram', 'light_rail', 'subway', 'narrow_gauge') or nt == 'tree_row'): return
        try: pts = [(nd.lon, nd.lat) for nd in w.nodes]
        except osmium.InvalidLocationError: return
        if not any(inb(*p) for p in pts): return
        if hw in ROADS:
            if hw == 'service' and t.get('service') in SKIP_SERVICE: return
            if t.get('access') in ('private', 'no') and hw == 'service': return
            if t.get('area') == 'yes': return
            self.roads.append(dict(id=w.id, hw=hw, pts=pts, nodes=[nd.ref for nd in w.nodes], name=t.get('name'), name_en=t.get('name:en') or t.get('int_name'),
                                   ref=t.get('ref'), lanes=num(t.get('lanes')), width=num(t.get('width')), oneway=t.get('oneway'), bridge=t.get('bridge'),
                                   tunnel=t.get('tunnel'), layer=num(t.get('layer')) or 0, surface=t.get('surface'), junction=t.get('junction'), service=t.get('service')))
        elif ww: self.water_lines.append((ww, pts, num(t.get('width'))))
        elif rw:
            if t.get('tunnel') in ('yes', 'building_passage') or rw == 'subway': return
            self.rail.append((rw, pts, t.get('bridge')))
        elif nt == 'tree_row': self.tree_rows.append(pts)
    def area(self, a):
        t = a.tags
        b = t.get('building')
        cls = None
        if not b:
            for k, m in COVER.items():
                v = t.get(k)
                if v in m: cls = m[v]; break
            if cls is None: return
        try:
            polys = []
            for outer in a.outer_rings():
                o = [(n.lon, n.lat) for n in outer]
                holes = [[(n.lon, n.lat) for n in inner] for inner in a.inner_rings(outer)]
                polys.append((o, holes))
        except osmium.InvalidLocationError: return
        if not polys or not any(inb(*p) for o, _ in polys for p in o[:: max(1, len(o) // 8)]): return
        if b:
            if b in ('roof', 'no', 'construction_site') or t.get('location') == 'underground': return
            self.buildings.append(dict(id=a.orig_id(), b=b, polys=polys, h=num(t.get('height')), lv=num(t.get('building:levels')), minh=num(t.get('min_height')),
                                       minlv=num(t.get('building:min_level')), roof=t.get('roof:shape'), name=t.get('name'), amenity=t.get('amenity'),
                                       colour=t.get('building:colour'), religion=t.get('religion'), man_made=t.get('man_made')))
        else:
            self.cover.append((cls, polys, t.get('name')))

h = H()
h.apply_file(PBF, locations=True, idx='flex_mem')
print(f"roads {len(h.roads)}  buildings {len(h.buildings)}  cover {len(h.cover)}  water {len(h.water_lines)}  rail {len(h.rail)}  trees {len(h.trees)}  rows {len(h.tree_rows)}  places {len(h.places)}  crossings {len(h.crossings)}  signals {len(h.signals)}")
pickle.dump(dict(bbox=(W, S, E, N), roads=h.roads, buildings=h.buildings, cover=h.cover, water=h.water_lines, rail=h.rail, trees=h.trees, tree_rows=h.tree_rows, places=h.places, crossings=h.crossings, signals=h.signals), open(OUT, 'wb'))
