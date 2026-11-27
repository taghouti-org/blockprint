#!/usr/bin/env python3
"""Plan (JSON, meters) -> voxel grid -> layer previews + Minecraft datapack.

Usage: python3 gen.py plan.json out_dir

Coordinates are meters, x west->east, z north->south (north = -z), converted with scale (blocks per meter).
  lines (walls, footprint, railing)  inclusive: blocks b(x0)..b(x1)
  rects (floors, voids, furniture)   cells:     blocks b(x0)..b(x1)-1
  opening range [a,b] on a wall line cells:     b(a)..b(b)-1
"""
import json, sys, os, shutil, zipfile
from PIL import Image, ImageDraw

BLOCKS_ONLY = "--blocks-only" in sys.argv   # for the shared city: the house alone, no street, no previews / datapack
plan = json.load(open(sys.argv[1])); out = sys.argv[2]
if BLOCKS_ONLY: plan.pop("street", None)
os.makedirs(out, exist_ok=True)
S = plan["scale"]; P = plan["palette"]
def b(m): return int(round(m * S))
def mc(name): return name if ":" in name else "minecraft:" + name

G = {}
def put(x, y, z, blk): G[(x, y, z)] = mc(blk) if blk != "air" else "air"
def box(x0, y0, z0, x1, y1, z1, blk):
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            for z in range(min(z0, z1), max(z0, z1) + 1):
                put(x, y, z, blk)
def line(l): return b(l[0]), b(l[1]), b(l[2]), b(l[3])
def cells(r): return b(r[0]), b(r[1]), b(r[2]) - 1, b(r[3]) - 1
OPP = {"north": "south", "south": "north", "east": "west", "west": "east"}
# open trapdoor: the panel sits on the face opposite to `facing`
def panel(face): return f"open=true,facing={OPP[face]}"

def floor_block(spec, x, z):
    """A floor spec is a block id or {"pattern": "rosette", "block": glazed terracotta}."""
    if isinstance(spec, str): return spec
    f = [["north", "east"], ["west", "south"]][z % 2][x % 2]
    return f'{spec["block"]}[facing={f}]'

# ------------------------------------------------------------------ furniture library
def furniture(f, fy, h=5):
    t = f["type"]; y = fy + 1
    if "rect" in f: x0, z0, x1, z1 = cells(f["rect"])
    if "at" in f: ax, az = b(f["at"][0]), b(f["at"][1])
    if t == "bed":  # wool mattress, pillow row at the head, blanket carpet
        head = f["head"]
        box(x0, y, z0, x1, y, z1, "white_wool")
        for x in range(x0, x1 + 1):
            for z in range(z0, z1 + 1):
                at_head = {"north": z == z0, "south": z == z1, "west": x == x0, "east": x == x1}[head]
                put(x, y + 1, z, "white_carpet" if at_head else f.get("blanket", "light_blue_carpet"))
    elif t == "sofa":  # stairs, back toward `back`, trapdoor armrests at both ends
        back = f["back"]; mat = f.get("block", "warped")
        box(x0, y, z0, x1, y, z1, f"{mat}_stairs[facing={back}]")
        if back in ("east", "west"):
            put(x0, y, z0 - 1, f"{mat}_trapdoor[{panel('south')}]"); put(x0, y, z1 + 1, f"{mat}_trapdoor[{panel('north')}]")
        else:
            put(x0 - 1, y, z0, f"{mat}_trapdoor[{panel('east')}]"); put(x1 + 1, y, z0, f"{mat}_trapdoor[{panel('west')}]")
    elif t == "table":  # fence legs at the corners, slab top -> 0.75 m high
        wood = f.get("wood", "spruce")
        for x in {x0, x1}:
            for z in {z0, z1}:
                put(x, y, z, f"{wood}_fence")
        box(x0, y + 1, z0, x1, y + 1, z1, f"{wood}_slab[type=bottom]")
        for side in f.get("chairs", []):  # a row of chairs along each listed side, facing the table
            if side == "west":  box(x0 - 1, y, z0, x0 - 1, y, z1, f"{wood}_stairs[facing=west]")
            if side == "east":  box(x1 + 1, y, z0, x1 + 1, y, z1, f"{wood}_stairs[facing=east]")
            if side == "north": box(x0, y, z0 - 1, x1, y, z0 - 1, f"{wood}_stairs[facing=north]")
            if side == "south": box(x0, y, z1 + 1, x1, y, z1 + 1, f"{wood}_stairs[facing=south]")
    elif t == "desk":
        wood = f.get("wood", "birch")
        for x in range(x0, x1 + 1):
            for z in range(z0, z1 + 1):
                put(x, y, z, f"{wood}_fence")
        box(x0, y + 1, z0, x1, y + 1, z1, f"{wood}_slab[type=bottom]")
        if "chair" in f:
            c = f["chair"]; put(b(c["at"][0]), y, b(c["at"][1]), f"{wood}_stairs[facing={c['back']}]")
    elif t == "coffee_table":
        box(x0, y, z0, x1, y, z1, "spruce_slab[type=bottom]")
    elif t == "rug":
        for x in range(x0, x1 + 1):
            for z in range(z0, z1 + 1):
                if (x, y, z) not in G or G[(x, y, z)] == "air":
                    put(x, y, z, f.get("block", "light_blue_carpet"))
    elif t == "tv":  # cabinet + dark screen panel flat against the wall
        wall = f["wall"]
        box(x0, y, z0, x1, y, z1, "spruce_slab[type=bottom]")
        for sx, sz in f["screen"]:
            box(b(sx), y + 1, b(sz), b(sx), y + 2, b(sz), f"dark_oak_trapdoor[{panel(wall)}]")
    elif t == "wardrobe":  # solid wood, trapdoor doors on the front, 2 m high
        front = f["front"]; h = b(f.get("height", 2.0))
        box(x0, y, z0, x1, y + h - 1, z1, "spruce_planks")
        dx, dz = {"north": (0, -1), "south": (0, 1), "west": (-1, 0), "east": (1, 0)}[front]
        for x in range(x0, x1 + 1):
            for z in range(z0, z1 + 1):
                fx, fz = x + dx, z + dz
                if x0 <= fx <= x1 and z0 <= fz <= z1: continue
                box(fx, y, fz, fx, y + h - 1, fz, f"spruce_trapdoor[{panel(OPP[front])}]")
    elif t == "nightstand":
        put(ax, y, az, "spruce_planks"); put(ax, y + 1, az, "lantern")
    elif t == "plant":
        put(ax, y, az, f.get("block", "potted_fern"))
    elif t == "counter":  # cabinets + worktop slab; items: oven / sink / cabinet
        front = f["front"]
        for x in range(x0, x1 + 1):
            for z in range(z0, z1 + 1):
                put(x, y, z, f"barrel[facing={front}]"); put(x, y + 1, z, "smooth_stone_slab[type=bottom]")
        for it in f.get("items", []):
            ix, iz = b(it["at"][0]), b(it["at"][1])
            if it["item"] == "oven": put(ix, y, iz, f"smoker[facing={front}]")
            if it["item"] == "sink": put(ix, y + 1, iz, "water_cauldron[level=3]")
    elif t == "fridge":
        box(ax, y, az, ax, y + 3, az, "iron_block")
    elif t == "toilet":
        put(ax, y, az, f"quartz_stairs[facing={f['back']}]")
    elif t == "sink":
        put(ax, y, az, "smooth_quartz"); put(ax, y + 1, az, "water_cauldron[level=3]")
    elif t == "shower":
        for gx, gz in f.get("glass", []):
            box(b(gx), y, b(gz), b(gx), y + 2, b(gz), "glass_pane")
        hx, hz = b(f["head"][0]), b(f["head"][1])
        put(hx, fy + h, hz, "lightning_rod[facing=down]")
        for x in range(x0, x1 + 1):
            for z in range(z0, z1 + 1):
                put(x, fy, z, "light_blue_glazed_terracotta[facing=north]")
    elif t == "barrel":
        box(ax, y, az, ax, y + 1, az, f"barrel[facing={f['front']}]")
    else:
        raise SystemExit(f"unknown furniture type {t}")

# ------------------------------------------------------------------ openings
def opening(o, fy, glass):
    lo, hi = b(o["range"][0]), b(o["range"][1]) - 1
    ax, at = o["line"]; c = b(at)
    kind = o["type"]; d = plan[kind]
    sill = b(o.get("sill", d["sill"])); oh = b(o.get("height", d["height"]))
    y0, y1 = fy + 1 + sill, fy + sill + oh
    blk = "air" if kind == "door" else glass
    if ax == "z": box(lo, y0, c, hi, y1, c, blk)
    else:         box(c, y0, lo, c, y1, hi, blk)
    door = P["door"]
    p = o.get("panel")
    if kind == "door" and p:
        s = p["side"]; hinge = p.get("hinge", "low"); mode = p.get("mode", "swing")
        if ax == "z":
            if mode == "swing":
                x = lo if hinge == "low" else hi
                for k in (1, 2): box(x, y0, c + s * k, x, y1, c + s * k, f"{door}[{panel('west' if hinge == 'low' else 'east')}]")
            else:  # flat against the wall, beside the opening
                xs = (lo - 2, lo - 1) if hinge == "low" else (hi + 1, hi + 2)
                for x in xs: box(x, y0, c + s, x, y1, c + s, f"{door}[{panel('north' if s > 0 else 'south')}]")
        else:
            if mode == "swing":
                z = lo if hinge == "low" else hi
                for k in (1, 2): box(c + s * k, y0, z, c + s * k, y1, z, f"{door}[{panel('north' if hinge == 'low' else 'south')}]")
            else:
                zs = (lo - 2, lo - 1) if hinge == "low" else (hi + 1, hi + 2)
                for z in zs: box(c + s, y0, z, c + s, y1, z, f"{door}[{panel('west' if s > 0 else 'east')}]")
    sh = o.get("shutters")  # window shutters, flat against the outside wall on both sides
    if kind == "window" and sh:
        if ax == "z":
            for x in (lo - 1, hi + 1): box(x, y0, c + sh, x, y1, c + sh, f"{P['shutter']}[{panel('north' if sh > 0 else 'south')}]")
        else:
            for z in (lo - 1, hi + 1): box(c + sh, y0, z, c + sh, y1, z, f"{P['shutter']}[{panel('west' if sh > 0 else 'east')}]")

# ------------------------------------------------------------------ street
st = plan.get("street")
if st:
  X0, X1 = b(st["x_range"][0]), b(st["x_range"][1])
  sw, rd = b(st["sidewalk"]), b(st["road"])
  near = (-sw, -1); road = (-sw - rd, -sw - 1); far = (-2 * sw - rd, -sw - rd - 1)
  for zr in (near, far):
      box(X0, 0, zr[0], X1, 0, zr[1], "stone"); box(X0, 1, zr[0], X1, 1, zr[1], st["sidewalk_block"])
  box(X0, 1, near[0], X1, 1, near[0], st["curb_block"]); box(X0, 1, far[1], X1, 1, far[1], st["curb_block"])
  box(X0, 0, road[0], X1, 0, road[1], st["road_block"])
  mid = (road[0] + road[1]) // 2
  for x in range(X0, X1 + 1):
      if (x - X0) % 6 < 3: put(x, 0, mid, st["line_block"])
  L = st["lamps"]; step = b(L["every"]); lh = b(L["height"])
  for i, x in enumerate(range(X0 + step // 2, X1, step)):
      z = near[0] + 1 if i % 2 == 0 else far[1] - 1
      box(x, 2, z, x, lh, z, L["pole"]); put(x, lh + 1, z, L["head"])

# ------------------------------------------------------------------ yard
yd = plan.get("yard")
if yd:
  xa, za, xb, zb = line(yd["rect"])
  box(xa, 1, za, xb, 1, zb - 1, yd["ground"])
  wh = b(yd["wall_height"])
  for (x0, z0, x1, z1) in [(xa, za, xb, za), (xa, za, xa, zb - 1), (xb, za, xb, zb - 1)]:
      box(x0, 1, z0, x1, wh + 1, z1, yd["wall"])
  g0, g1 = b(yd["gate"][0]), b(yd["gate"][1]) - 1
  box(g0, 2, za, g1, wh + 1, za, "air")
  box(g0, 1, za, g1, 1, zb - 1, yd["path"])
  for k, x in enumerate((g0, g1)):  # gate leaves, open into the yard
      box(x, 2, za + 1, x, wh + 1, za + 2, f"{P['door']}[{panel('west' if k == 0 else 'east')}]")
      box(x, 2, za + 1, x, wh + 1, za + 2, f"{P['door']}[{panel('west' if k == 0 else 'east')}]")

# ------------------------------------------------------------------ levels
for lv in plan["levels"]:
    fy = lv["floor_y"]; h = b(lv["height"]); lv["_h"] = h
    x0, z0, x1, z1 = line(lv["footprint"])
    box(x0, fy, z0, x1, fy, z1, P["slab"])
    for f in lv["floors"]:
        a, c, d, e = cells(f["rect"])
        for x in range(a, d + 1):
            for z in range(c, e + 1):
                put(x, fy, z, floor_block(f["block"], x, z))
    for v in lv["voids"]:
        a, c, d, e = cells(v); box(a, fy, c, d, fy, e, "air")
    for w in lv["walls"]:
        a, c, d, e = line(w); box(a, fy + 1, c, d, fy + h, e, P["wall"])
    lv["_ceiling"] = fy + h + 1

# roof (before openings so stairs/voids can cut it)
rf = plan["roof"]; ry = rf["y"]
x0, z0, x1, z1 = line(rf["footprint"]); box(x0, ry, z0, x1, ry, z1, rf["block"])
for v in rf["voids"]:
    a, c, d, e = cells(v); box(a, ry, c, d, ry, e, "air")
for w in rf["parapet"]["lines"]:
    a, c, d, e = line(w); box(a, ry + 1, c, d, ry + b(rf["parapet"]["height"]), e, P["wall"])

for lv in plan["levels"]:
    for o in lv["openings"]:
        opening(o, lv["floor_y"], P["glass"])
    for (lx, lz) in lv["lights"]:
        if lv["_ceiling"] == ry:  # ceiling is the roof: hang a lantern instead of a light block showing on the roof
            put(b(lx), ry - 1, b(lz), "lantern[hanging=true]")
        else:
            put(b(lx), lv["_ceiling"], b(lz), P["light"])

for s in plan["stairs"]:
    sx, sz = b(s["start"][0]), b(s["start"][1]); wdt = max(1, b(s["width"]))
    for k in range(1, s["steps"] + 1):
        yy = s["base_y"] + k
        for j in range(wdt):
            dx, dz = {"east": (1, 0), "west": (-1, 0), "south": (0, 1), "north": (0, -1)}[s["dir"]]
            x, z = sx + dx * (k - 1) + (j if dz else 0), sz + dz * (k - 1) + (j if dx else 0)
            put(x, yy, z, f'{s["block"]}[facing={s["dir"]}]')
            for hy in range(yy + 1, yy + 4): put(x, hy, z, "air")

for w in rf["railing"]["lines"]:
    a, c, d, e = line(w); box(a, ry + 1, c, d, ry + 1, e, rf["railing"]["block"])

for lv in plan["levels"]:
    for f in lv.get("furniture", []):
        furniture(f, lv["floor_y"], lv["_h"])

# ------------------------------------------------------------------ guarantee: you can walk in from outside
SOLID_OK = ("carpet", "trapdoor", "potted", "lantern", "sea_lantern", "button", "rail", "torch")
def passable(x, y, z):
    b = G.get((x, y, z))
    return b is None or b == "air" or any(k in b for k in SOLID_OK) and "lantern" not in b.split(":")[1].split("[")[0][:3]
def entrance_check():
    lv = plan["levels"][0]; fy = lv["floor_y"]; ys = (fy + 1, fy + 2)
    fx0, fz0, fx1, fz1 = line(lv["footprint"])
    X0, X1, Z0, Z1 = fx0 - 2, fx1 + 2, fz0 - 2, fz1 + 2
    ok = lambda x, z: all(passable(x, y, z) for y in ys)
    inside = set()
    for f in lv["floors"]:
        a, c, d, e = cells(f["rect"])
        inside.update((x, z) for x in range(a, d + 1) for z in range(c, e + 1) if fx0 < x < fx1 and fz0 < z < fz1 and ok(x, z))
    def reach():
        seen, todo = set(), [(x, z) for x in range(X0, X1 + 1) for z in (Z0, Z1)] + [(x, z) for z in range(Z0, Z1 + 1) for x in (X0, X1)]
        todo = [c for c in todo if ok(*c)]
        seen.update(todo)
        while todo:
            x, z = todo.pop()
            for n in ((x + 1, z), (x - 1, z), (x, z + 1), (x, z - 1)):
                if n not in seen and X0 <= n[0] <= X1 and Z0 <= n[1] <= Z1 and ok(*n):
                    seen.add(n); todo.append(n)
        return seen
    seen = reach()
    if not inside or inside & seen:
        return None
    # carve the shortest straight passage from a door (or the middle of the street wall) to the outside
    door_h = b(plan["door"]["height"])
    cands = []
    for o in lv["openings"]:
        if o["type"] != "door": continue
        ax, at = o["line"]; c = b(at); lo, hi = b(o["range"][0]), b(o["range"][1]) - 1
        for sgn in (-1, 1):
            cut = []
            for k in range(1, 200):
                cs = [((c + sgn * k, p) if ax == "x" else (p, c + sgn * k)) for p in range(lo, hi + 1)]
                if any(not (X0 <= q[0] <= X1 and Z0 <= q[1] <= Z1) for q in cs): break
                if all(q in seen for q in cs):
                    cands.append((len(cut), cut, o)); break
                cut += [q for q in cs if not ok(*q)]
    if not cands:   # no door at all: open the middle of the street-side wall
        mid = (fx0 + fx1) // 2
        cut = [(x, z) for x in (mid, mid + 1) for z in range(fz0 - 1, fz0 + 2) if not ok(x, z)]
        cands.append((len(cut), cut, None))
    n, cut, o = min(cands, key=lambda t: t[0])
    for (x, z) in cut:
        for y in range(fy + 1, fy + 1 + door_h):
            put(x, y, z, "air")
    return f"no way in from outside: opened a {len(cut)}-block passage to the {'door ' + o.get('note', '') if o else 'street-side wall'}"
entry_note = entrance_check()
if entry_note:
    print("ENTRANCE FIX:", entry_note)
    plan.setdefault("notes", []).append(entry_note)

# ------------------------------------------------------------------ emit (run-length along x)
cmds = []
rows = {}
for (x, yv, z) in sorted(G, key=lambda k: (k[1], k[2], k[0])):
    rows.setdefault((yv, z), []).append(x)
for (yv, z), xs in rows.items():
    run = None
    for x in xs + [None]:
        blk = G.get((x, yv, z)) if x is not None else None
        if run and x is not None and x == run[1] + 1 and blk == run[2]:
            run[1] = x; continue
        if run and run[2] != "air":
            cmds.append(f"fill ~{run[0]} ~{yv} ~{z} ~{run[1]} ~{yv} ~{z} {run[2]}" if run[1] > run[0]
                        else f"setblock ~{run[0]} ~{yv} ~{z} {run[2]}")
        run = [x, x, blk] if x is not None else None
cmds = [c.replace("~0 ", "~ ").replace("~-0 ", "~ ") for c in cmds]

# ------------------------------------------------------------------ datapack
W = plan["world"]; gy = W["ground_y"]
dp = os.path.join(out, "maison_rue_datapack"); shutil.rmtree(dp, ignore_errors=True)
fn = os.path.join(dp, "data", "house", "function"); os.makedirs(fn)
json.dump({"pack": {"description": W["title"], "pack_format": 121, "min_format": 121, "max_format": 121}},
          open(os.path.join(dp, "pack.mcmeta"), "w"), indent=1)
open(os.path.join(fn, "build.mcfunction"), "w").write("\n".join(cmds) + "\n")
fl = W["forceload"]; sp = W["spawn"]; bc = W["border_center"]
open(os.path.join(fn, "rules.mcfunction"), "w").write("\n".join([
    "difficulty peaceful", "gamerule spawn_mobs false", "gamerule spawn_monsters false",
    "gamerule spawn_patrols false", "gamerule spawn_phantoms false", "gamerule spawn_wandering_traders false",
    "gamerule spawn_wardens false", "gamerule advance_time false", "gamerule advance_weather false",
    "weather clear", "time set 6000", "kill @e[type=!minecraft:player]"]) + "\n")
open(os.path.join(fn, "setup.mcfunction"), "w").write(
    f"function house:rules\nforceload add {fl[0]} {fl[1]} {fl[2]} {fl[3]}\n"
    'tellraw @a {"text":"Building the house and the street...","color":"yellow"}\n'
    "schedule function house:place 60t\n")
clear = [f"fill {fl[0]} {gy} {fl[1]} {fl[2]} {gy} {fl[3]} grass_block"] + \
        [f"fill {fl[0]} {yy} {fl[1]} {fl[2]} {yy} {fl[3]} air" for yy in range(gy + 1, gy + 41)]
assert (fl[2] - fl[0] + 1) * (fl[3] - fl[1] + 1) <= 32768
open(os.path.join(fn, "place.mcfunction"), "w").write("\n".join(clear) + "\n" +
    f"execute positioned 0 {gy} 0 run function house:build\n"
    f"setworldspawn {sp[0]} {gy+sp[1]} {sp[2]}\nworldborder center {bc[0]} {bc[1]}\nworldborder set {W['border_size']}\n"
    "function house:rules\nforceload remove all\n"
    f"tp @a {sp[0]} {gy+sp[1]} {sp[2]}\n"
    'tellraw @a {"text":"Done. You are on the sidewalk in front of the gate.","color":"green"}\n')
zp = os.path.join(out, "maison_rue_datapack.zip")
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    for r, _, fs in os.walk(dp):
        for f in fs: z.write(os.path.join(r, f), os.path.relpath(os.path.join(r, f), dp))

# ------------------------------------------------------------------ block list for the world writer (absolute world coords)
json.dump({"ground_y": gy, "spawn": [sp[0], gy + sp[1], sp[2]], "border_center": bc, "border_size": W["border_size"],
           "title": W["title"],
           "blocks": [[x, yv + gy, z, blk] for (x, yv, z), blk in sorted(G.items()) if blk != "air"]},
          open(os.path.join(out, "blocks.json"), "w"))

if BLOCKS_ONLY:
    print(f"{sum(1 for v in G.values() if v != 'air')} blocks (blocks only)"); sys.exit(0)

# ------------------------------------------------------------------ previews
COL = {"white_concrete": (245, 245, 245), "smooth_sandstone": (222, 208, 165), "light_blue_glazed_terracotta": (95, 160, 220),
       "white_glazed_terracotta": (225, 235, 240), "glass_pane": (140, 200, 235), "sea_lantern": (255, 240, 90),
       "smooth_sandstone_stairs": (230, 160, 40), "warped_trapdoor": (20, 120, 130), "warped_stairs": (40, 150, 150),
       "spruce_slab": (110, 75, 45), "spruce_fence": (90, 60, 35), "spruce_stairs": (130, 90, 50), "spruce_planks": (115, 85, 50),
       "spruce_trapdoor": (100, 70, 40), "birch_fence": (215, 200, 150), "birch_slab": (200, 185, 130), "birch_stairs": (215, 195, 140),
       "dark_oak_trapdoor": (40, 30, 20), "white_wool": (255, 255, 255), "white_carpet": (250, 250, 250),
       "light_blue_carpet": (120, 190, 240), "blue_carpet": (60, 70, 170), "orange_carpet": (240, 130, 40),
       "lantern": (255, 200, 60), "barrel": (140, 90, 40), "smoker": (80, 80, 80), "smooth_stone_slab": (170, 170, 170),
       "water_cauldron": (60, 90, 220), "iron_block": (210, 210, 215), "quartz_stairs": (240, 235, 230),
       "smooth_quartz": (238, 232, 225), "lightning_rod": (200, 110, 70), "potted_fern": (60, 140, 60),
       "smooth_stone": (165, 160, 155), "stone": (110, 110, 110), "gray_concrete": (60, 62, 66), "polished_andesite": (150, 155, 150),
       "andesite_wall": (130, 135, 130), "oak_fence": (150, 110, 60), "grass_block": (100, 160, 70), "white_terracotta": (210, 180, 160)}
COL.update({"light_gray_concrete": (190, 190, 186), "polished_diorite": (205, 205, 208), "birch_planks": (215, 195, 140),
    "birch_trapdoor": (220, 205, 160), "polished_andesite_stairs": (150, 155, 150), "dark_oak_stairs": (70, 48, 25), "dark_oak_trapdoor": (60, 40, 20),
    "crimson_stairs": (120, 50, 70), "crimson_trapdoor": (110, 45, 65), "bricks": (150, 75, 60), "polished_granite": (160, 105, 85),
    "oak_planks": (170, 135, 85), "oak_stairs": (170, 135, 85), "cobblestone": (125, 125, 125), "gravel": (130, 125, 120), "sand": (220, 205, 155),
    "spruce_planks": (115, 85, 50), "smooth_sandstone_stairs": (230, 160, 40), "white_concrete": (245, 245, 245), "stone_bricks": (125, 125, 125)})
def col(blk): return COL.get(blk.split(":")[1].split("[")[0], (150, 150, 150))
fps = [line(lv["footprint"]) for lv in plan["levels"]] + ([line(plan["yard"]["rect"])] if plan.get("yard") else [])
minx, maxx = min(f[0] for f in fps) - 1, max(f[2] for f in fps) + 1
minz, maxz = min(f[1] for f in fps) - 1, max(f[3] for f in fps) + 1
C = max(6, min(14, 420 // max(1, maxz - minz + 1)))
layers = sorted({k[1] for k in G if 1 <= k[1] <= rf["y"] + 3})
tiles = []
for yv in layers:
    im = Image.new("RGB", ((maxx - minx + 1) * C, (maxz - minz + 1) * C + 16), (255, 255, 255))
    d = ImageDraw.Draw(im); d.text((3, 2), f"y={yv}", fill=(0, 0, 0))
    for x in range(minx, maxx + 1):
        for z in range(minz, maxz + 1):
            blk = G.get((x, yv, z))
            if blk and blk != "air":
                px, pz = (x - minx) * C, (z - minz) * C + 16
                d.rectangle([px, pz, px + C - 1, pz + C - 1], fill=col(blk), outline=(200, 200, 200))
    tiles.append(im)
cols = 6; Wt, Ht = tiles[0].size
sheet = Image.new("RGB", (Wt * cols, Ht * ((len(tiles) + cols - 1) // cols)), (255, 255, 255))
for i, t in enumerate(tiles): sheet.paste(t, ((i % cols) * Wt, (i // cols) * Ht))
sheet.save(os.path.join(out, "layers.png"))
unk = sorted({v.split(":")[1].split("[")[0] for v in G.values() if v != "air"} - set(COL))
print(f"{len(cmds)} commands, {sum(1 for v in G.values() if v != 'air')} blocks, unknown colours: {unk}")

# ------------------------------------------------------------------ isometric pictures (gallery thumbnail + cutaway per floor)
def iso(path, ymax=None, pad=4, a=10):
    """Painter's-algorithm isometric view from the north-east (street side), faces shaded."""
    cells = {k: v for k, v in G.items() if v != "air" and k[1] >= 0 and (ymax is None or k[1] <= ymax)}
    fx0, fx1 = minx - pad, maxx + pad; fz0, fz1 = minz - pad - 6, maxz + 1
    cells = {k: v for k, v in cells.items() if fx0 <= k[0] <= fx1 and fz0 <= k[2] <= fz1}
    def solid(x, y, z): return (x, y, z) in cells
    # screen coords: camera at +x, -z, above
    def sp(x, y, z): return ((x + z) * a, (x - z) * a / 2 - y * a)
    pts = [sp(x + dx, y + dy, z + dz) for (x, y, z) in cells for dx in (0, 1) for dy in (0, 1) for dz in (0, 1)]
    if not pts: return
    X0, Y0 = min(p[0] for p in pts) - 10, min(p[1] for p in pts) - 10
    Wd, Hd = int(max(p[0] for p in pts) - X0 + 10), int(max(p[1] for p in pts) - Y0 + 10)
    im = Image.new("RGBA", (Wd, Hd), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    def P(x, y, z): q = sp(x, y, z); return (q[0] - X0, q[1] - Y0)
    def shade(c, f): return tuple(int(v * f) for v in c) + (255,)
    for (x, y, z) in sorted(cells, key=lambda k: (k[0] - k[2], k[1])):
        c = col(cells[(x, y, z)])
        if not solid(x, y + 1, z):   # top
            d.polygon([P(x, y + 1, z), P(x + 1, y + 1, z), P(x + 1, y + 1, z + 1), P(x, y + 1, z + 1)], fill=shade(c, 1.0))
        if not solid(x, y, z - 1):   # north face (toward the street)
            d.polygon([P(x, y, z), P(x + 1, y, z), P(x + 1, y + 1, z), P(x, y + 1, z)], fill=shade(c, 0.82))
        if not solid(x + 1, y, z):   # east face
            d.polygon([P(x + 1, y, z), P(x + 1, y, z + 1), P(x + 1, y + 1, z + 1), P(x + 1, y + 1, z)], fill=shade(c, 0.66))
    im.save(path)

iso(os.path.join(out, "iso.png"))
for i, lv in enumerate(plan["levels"]):  # dollhouse cutaway: everything up to just under this floor's ceiling
    iso(os.path.join(out, f"iso_level{i}.png"), ymax=lv["floor_y"] + lv["_h"] - 1)
