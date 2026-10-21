import numpy as np, networkx as nx, json, sys
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage.morphology import skeletonize
IMG = sys.argv[1]; OUT = sys.argv[2]
im = np.asarray(Image.open(IMG).convert('RGB')).astype(int)
R, G, B = im[..., 0], im[..., 1], im[..., 2]
red = (R > 150) & (G < 90) & (B < 90) & (R - G > 90)
crop = np.zeros_like(red); crop[330:790, 40:1170] = red[330:790, 40:1170]
crop[716:737, 530:572] = True          # bridge the direction arrow drawn over the start straight
crop = ndi.binary_closing(crop, iterations=1)
lab, n = ndi.label(crop); sizes = ndi.sum(crop, lab, range(1, n + 1)); trk = lab == (np.argmax(sizes) + 1)
trk = ndi.binary_fill_holes(trk) & ~ndi.binary_fill_holes(trk) | trk   # keep as is
sk = skeletonize(trk)
ys, xs = np.nonzero(sk)
G_ = nx.Graph()
pts = set(zip(ys.tolist(), xs.tolist()))
for (y, x) in pts:
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if (dy or dx) and (y + dy, x + dx) in pts: G_.add_edge((y, x), (y + dy, x + dx), w=(dx * dx + dy * dy) ** .5)
nodes = np.array(list(G_.nodes))
def snap(x, y):
    d = (nodes[:, 0] - y) ** 2 + (nodes[:, 1] - x) ** 2; k = np.argmin(d); return tuple(nodes[k]), d[k] ** .5
# ordered waypoints (image px) along the full layout, starting on the start/finish straight heading west
WP = [(640, 726), (420, 727), (300, 700), (296, 650), (330, 615), (600, 607), (900, 600), (1040, 595), (1052, 572), (1010, 515), (975, 450),
      (945, 380), (915, 362), (885, 372), (868, 420), (862, 470), (845, 520), (800, 550), (700, 553), (600, 556), (520, 558), (470, 560), (440, 548),
      (410, 500), (370, 430), (330, 375), (300, 362), (265, 372), (220, 395), (205, 440), (200, 500), (198, 555), (185, 588), (150, 600), (110, 618),
      (80, 650), (70, 690), (82, 725), (130, 748), (300, 757), (600, 762), (900, 760), (1100, 752), (1132, 730), (1125, 700), (1095, 680), (1060, 682),
      (1030, 700), (995, 705), (960, 700), (925, 712), (880, 720), (760, 725)]
path = []
snapped = [snap(x, y) for x, y in WP]
bad = [(WP[i], round(s[1], 1)) for i, s in enumerate(snapped) if s[1] > 14]
if bad: print('waypoints far from the centre line:', bad)
for i in range(len(snapped)):
    a, b = snapped[i][0], snapped[(i + 1) % len(snapped)][0]
    seg = nx.shortest_path(G_, a, b, weight='w')
    path += seg[:-1]
P = np.array([(x, y) for (y, x) in path], float)
seglen = np.linalg.norm(np.diff(np.vstack([P, P[:1]]), axis=0), axis=1)
print('raw path px', round(seglen.sum()), 'points', len(P))
np.save(OUT, P)
# debug drawing
img = Image.open(IMG).convert('RGB'); d = ImageDraw.Draw(img)
d.line([tuple(p) for p in P] + [tuple(P[0])], fill=(0, 255, 120), width=3)
for k, (x, y) in enumerate(WP): d.ellipse((x - 4, y - 4, x + 4, y + 4), outline=(255, 255, 0))
d.ellipse((P[0][0] - 8, P[0][1] - 8, P[0][0] + 8, P[0][1] + 8), fill=(255, 255, 255))
img.crop((40, 330, 1170, 790)).save(OUT.replace('.npy', '.png'))
