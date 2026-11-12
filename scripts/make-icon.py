# Libertad icon, drawn as pixel art on a 32x32 grid by this program (no image generation) and
# scaled up with nearest neighbour: a bird with raised wings in front of a sun.
import math, sys
MONO = True
from PIL import Image

N = 32
BG, SUN, SUN2 = (18, 21, 31), (244, 176, 52), (214, 122, 42)
W, B, D = (246, 249, 255), (140, 184, 236), (18, 21, 31)
if MONO:
    BG, SUN, SUN2 = (0, 0, 0), (0, 0, 0), (255, 255, 255)
    W, B, D = (255, 255, 255), (255, 255, 255), (0, 0, 0)
img = [[BG] * N for _ in range(N)]
cx, cy, r = 16.0, 16.0, 14.0
for y in range(N):
    for x in range(N):
        d = math.hypot(x + .5 - cx, y + .5 - cy)
        if d <= r:
            img[y][x] = SUN2 if d > r - 2.6 else SUN

shape = {}   # (x, y) -> 'W' | 'B'
def bez(p0, p1, p2, t):
    return tuple((1-t)**2*a + 2*(1-t)*t*b + t*t*c for a, b, c in zip(p0, p1, p2))
def brush(x, y, rad, col):
    for yy in range(N):
        for xx in range(N):
            if math.hypot(xx + .5 - x, yy + .5 - y) <= rad:
                if col == 'W' or (xx, yy) not in shape:
                    shape[(xx, yy)] = col
def stroke(p0, p1, p2, w0, w1, col, mirror=True):
    for i in range(61):
        t = i / 60
        x, y = bez(p0, p1, p2, t)
        w = w0 + (w1 - w0) * t
        brush(x, y, w, col)
        if mirror: brush(N - x, y, w, col)

# lower wing layer first (blue), the upper layer (white) over it
stroke((15, 19), (8, 12), (1.5, 14.5), 3.0, 0.9, 'B')
stroke((15, 18), (9, 8), (2, 6), 3.2, 0.9, 'W')
# body, head, tail
for yy in range(N):
    for xx in range(N):
        if ((xx + .5 - 16) / 2.6) ** 2 + ((yy + .5 - 19) / 5.2) ** 2 <= 1: shape[(xx, yy)] = 'W'
brush(16, 13.5, 2.6, 'W')
for t in range(0, 11):
    brush(16 - t * .45, 22 + t * .75, max(.8, 2.0 - t * .15), 'B')
    brush(16 + t * .45, 22 + t * .75, max(.8, 2.0 - t * .15), 'B')

solid = set(shape)
for (x, y) in solid:
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        p = (x + dx, y + dy)
        if p not in solid and 0 <= p[0] < N and 0 <= p[1] < N:
            shape.setdefault(p, 'D')
pal = {'W': W, 'B': B, 'D': D}
for (x, y), c in shape.items():
    img[y][x] = pal[c]
    if MONO and c == 'B' and (x + y) % 2 == 0:
        img[y][x] = D
for ex in (14, 17):
    img[13][ex] = D
img[15][15] = img[15][16] = D if MONO else (255, 120, 30)

# Writes every icon file the project uses, from the one 32x32 picture above.
# Run from the project folder:  python3 scripts/make-icon.py   (needs Pillow)
def png(path, scale):
    im = Image.new('RGB', (N, N))
    for y in range(N):
        for x in range(N):
            im.putpixel((x, y), img[y][x])
    im.resize((N * scale, N * scale), Image.NEAREST).save(path)

def svg(path):
    parts = []
    for y in range(N):
        x = 0
        while x < N:
            c = img[y][x]
            x2 = x
            while x2 < N and img[y][x2] == c:
                x2 += 1
            if c != BG:
                parts.append(f'<rect x="{x}" y="{y}" width="{x2 - x}" height="1" fill="#{c[0]:02x}{c[1]:02x}{c[2]:02x}"/>')
            x = x2
    body = "\n  ".join(parts)
    open(path, 'w').write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {N} {N}" width="1024" height="1024" shape-rendering="crispEdges">\n'
        f'  <!-- Libertad app icon: a bird with raised wings in front of a sun, pixel art on a {N}x{N} grid,\n'
        f'       drawn by scripts/make-icon.py -->\n'
        f'  <rect width="{N}" height="{N}" fill="#{BG[0]:02x}{BG[1]:02x}{BG[2]:02x}"/>\n  {body}\n</svg>\n')

import os
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
for d, size in (('build', 1024), ('public', 256), ('dist', 256), ('dist-web', 256)):
    if os.path.isdir(os.path.join(root, d)):
        png(os.path.join(root, d, 'icon.png'), size // N)
for p in ('build/icon.svg', 'public/favicon.svg', 'dist/favicon.svg', 'dist-web/favicon.svg'):
    if os.path.isdir(os.path.dirname(os.path.join(root, p))):
        svg(os.path.join(root, p))
