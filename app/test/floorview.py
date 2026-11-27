# Render the furniture layer (floor_y+1) of each level from blocks.json, big and labelled. Usage: floorview.py build_dir plan.json out.png
import json, sys
from PIL import Image, ImageDraw
bd, planf, outp = sys.argv[1:4]
d = json.load(open(bd + '/blocks.json')); plan = json.load(open(planf)); gy = d['ground_y']
G = {(x, y - gy, z): b.split(':')[1].split('[')[0] for x, y, z, b in d['blocks']}
ABBR = {'white_concrete': ('', (235, 235, 235)), 'smooth_sandstone': ('', (235, 235, 235)), 'warped_trapdoor': ('D', (20, 120, 130)),
        'white_wool': ('B', (250, 250, 250)), 'spruce_planks': ('W', (115, 85, 50)), 'spruce_trapdoor': ('w', (150, 110, 70)),
        'warped_stairs': ('S', (40, 150, 150)), 'spruce_slab': ('t', (130, 90, 55)), 'spruce_fence': ('T', (90, 60, 35)), 'spruce_stairs': ('c', (170, 120, 70)),
        'birch_fence': ('K', (215, 200, 150)), 'birch_stairs': ('c', (225, 205, 150)), 'barrel': ('C', (140, 90, 40)), 'smoker': ('O', (70, 70, 70)),
        'iron_block': ('F', (200, 200, 210)), 'quartz_stairs': ('L', (245, 240, 235)), 'smooth_quartz': ('s', (238, 232, 225)),
        'glass_pane': ('g', (140, 200, 235)), 'smooth_sandstone_stairs': ('^', (230, 160, 40)), 'potted_fern': ('p', (60, 140, 60)),
        'blue_carpet': ('', (70, 80, 190)), 'light_blue_carpet': ('', (120, 190, 240)), 'dark_oak_trapdoor': ('V', (40, 30, 20)), 'barrel_': ('', 0)}
C = 22
tiles = []
for lv in plan['levels']:
    y = lv['floor_y'] + 1
    xs = [k[0] for k in G if k[1] == y]; zs = [k[2] for k in G if k[1] == y]
    x0, x1, z0, z1 = min(xs) - 1, max(xs) + 1, min(zs) - 1, max(zs) + 1
    x0 = max(x0, -2); z0 = max(z0, -2)
    im = Image.new('RGB', ((x1 - x0 + 1) * C, (z1 - z0 + 1) * C + 20), 'white'); dr = ImageDraw.Draw(im)
    dr.text((4, 3), f"{lv['name']} (y={y})", fill='black')
    for x in range(x0, x1 + 1):
        for z in range(z0, z1 + 1):
            b = G.get((x, y, z)); px, pz = (x - x0) * C, (z - z0) * C + 20
            if not b: continue
            lab, colr = ABBR.get(b, (b[:2], (255, 120, 200)))
            dr.rectangle([px, pz, px + C - 1, pz + C - 1], fill=colr, outline=(190, 190, 190))
            if lab: dr.text((px + 7, pz + 5), lab, fill='white' if sum(colr) < 400 else 'black')
    tiles.append(im)
W = sum(t.width for t in tiles) + 20 * len(tiles); H = max(t.height for t in tiles)
out = Image.new('RGB', (W, H), 'white'); x = 0
for t in tiles: out.paste(t, (x, 0)); x += t.width + 20
out.save(outp)
