#!/usr/bin/env python3
"""Plan facts (read by Claude) + questionnaire answers -> house_plan.json for gen.py.

  python3 compile.py questions facts.json            -> questionnaire JSON (prefilled, with sources)
  python3 compile.py plan facts.json answers.json out -> house_plan.json (missing answers take the defaults)
"""
import json, math, sys

# ------------------------------------------------------------------ vocabulary
TYPE_LABELS = {
    "bedroom": "Bedroom", "living": "Living room", "dining": "Dining room", "living_dining": "Living + dining",
    "kitchen": "Kitchen", "bathroom": "Bathroom", "wc": "WC", "hallway": "Hallway", "landing": "Landing",
    "stairs": "Stairs", "office": "Office", "storage": "Storage", "closet": "Closet / wardrobe", "laundry": "Laundry",
    "garage": "Garage", "courtyard": "Courtyard", "yard": "Yard / front garden", "terrace": "Terrace",
    "light_shaft": "Light shaft", "other": "Other"}
OUTDOOR = {"courtyard", "yard", "terrace", "light_shaft"}
STYLES = {
    "tunisian": {"label": "Traditional Tunisian", "wall": "white_concrete", "slab": "white_concrete", "roof": "white_concrete",
                 "door": "warped_trapdoor", "shutter": "warped_trapdoor", "stairs": "smooth_sandstone_stairs", "sofa": "warped",
                 "path": "smooth_sandstone", "yard_wall": "white_concrete", "tiles": "smooth_sandstone",
                 "floors": {"living": {"pattern": "rosette", "block": "light_blue_glazed_terracotta"},
                            "kitchen": {"pattern": "rosette", "block": "white_glazed_terracotta"},
                            "wet": {"pattern": "rosette", "block": "white_glazed_terracotta"},
                            "bedroom": "smooth_sandstone", "circulation": "smooth_sandstone", "other": "smooth_sandstone"}},
    "modern": {"label": "Modern", "wall": "white_concrete", "slab": "white_concrete", "roof": "light_gray_concrete",
               "door": "birch_trapdoor", "shutter": None, "stairs": "polished_andesite_stairs", "sofa": "dark_oak",
               "path": "polished_andesite", "yard_wall": "light_gray_concrete", "tiles": "polished_andesite",
               "floors": {"living": "birch_planks", "kitchen": "smooth_quartz", "wet": "smooth_quartz",
                          "bedroom": "birch_planks", "circulation": "polished_diorite", "other": "birch_planks"}},
    "classic": {"label": "Classic wood", "wall": "smooth_sandstone", "slab": "spruce_planks", "roof": "bricks",
                "door": "spruce_trapdoor", "shutter": "spruce_trapdoor", "stairs": "oak_stairs", "sofa": "crimson",
                "path": "cobblestone", "yard_wall": "bricks", "tiles": "polished_granite",
                "floors": {"living": "oak_planks", "kitchen": "polished_granite", "wet": "smooth_quartz",
                           "bedroom": "oak_planks", "circulation": "spruce_planks", "other": "oak_planks"}},
}
FLOOR_GROUP = {"living": "living", "dining": "living", "living_dining": "living", "kitchen": "kitchen", "bathroom": "wet",
               "wc": "wet", "laundry": "wet", "bedroom": "bedroom", "office": "bedroom", "hallway": "circulation",
               "landing": "circulation", "stairs": "circulation"}
DIRS = {"north": (0, -1), "south": (0, 1), "east": (1, 0), "west": (-1, 0)}
OPP = {"north": "south", "south": "north", "east": "west", "west": "east"}


def area(r): return (r[2] - r[0]) * (r[3] - r[1])


# ------------------------------------------------------------------ questionnaire
def infer_street(facts):
    s = facts.get("street_side", {})
    if s.get("value") in DIRS:
        return s["value"], s.get("source", "plan"), s.get("evidence", "")
    g = sorted(facts["levels"], key=lambda l: l["index"])[0]
    ox0, oz0, ox1, oz1 = g["outline"]
    for sp in g["spaces"]:
        if sp["covered"] != "open":
            continue
        x0, z0, x1, z1 = sp["rect"]
        has_door = any(o["type"] in ("door", "opening") and sp["id"] in o["between"] for o in g["openings"])
        for side, touch in (("north", z0 <= oz0), ("south", z1 >= oz1), ("west", x0 <= ox0), ("east", x1 >= ox1)):
            if touch and has_door:
                return side, "guess", f"the open space '{sp['label'] or sp['id']}' is on the {side} edge and the entrance door opens onto it"
    return "north", "default", "no entrance or street on the plan"


def street_edge(r, o, side):
    return {"north": r[1] <= o[1] and r[0] <= o[0] and r[2] >= o[2], "south": r[3] >= o[3] and r[0] <= o[0] and r[2] >= o[2],
            "west": r[0] <= o[0] and r[1] <= o[1] and r[3] >= o[3], "east": r[2] >= o[2] and r[1] <= o[1] and r[3] >= o[3]}[side]


def bedrooms_default(facts):
    beds = [(area(s["rect"]), s["id"]) for l in facts["levels"] for s in l["spaces"] if s["type"] == "bedroom"]
    beds.sort(reverse=True)
    return {sid: ("couple" if i == 0 and len(beds) > 1 else "child" if len(beds) > 1 else "couple") for i, (_, sid) in enumerate(beds)}


def questions(facts):
    street, ssrc, sev = infer_street(facts)
    has_roof_stair = any(st["to"] == "roof" for l in facts["levels"] for st in l["stairs"])
    Q = []
    house = {"id": "house", "title": "The whole house", "items": [
        {"key": "house.style", "label": "Decoration style", "kind": "choice", "value": "tunisian", "source": "default",
         "options": [{"value": k, "label": v["label"]} for k, v in STYLES.items()]},
        {"key": "house.scale", "label": "Scale", "kind": "choice", "value": "0.5", "source": "default",
         "help": "50 cm per block keeps 1 m hallways and stairs walkable. 25 cm is life-size but huge; 1 m is compact but narrow rooms vanish.",
         "options": [{"value": "0.25", "label": "1 block = 25 cm"}, {"value": "0.5", "label": "1 block = 50 cm"}, {"value": "1", "label": "1 block = 1 m"}]},
        {"key": "house.doors", "label": "Doors", "kind": "choice", "value": "open_panels", "source": "default",
         "options": [{"value": "open_panels", "label": "Real-size doors shown open"}, {"value": "doorways", "label": "Open doorways, no doors"}]},
        {"key": "house.street_side", "label": "Which side faces the street?", "kind": "choice", "value": street, "source": ssrc, "evidence": sev,
         "options": [{"value": d, "label": d.capitalize() + " (top of the drawing)" if d == "north" else d.capitalize()} for d in DIRS]},
        {"key": "house.surroundings", "label": "Around the house", "kind": "choice", "value": "street", "source": "default",
         "options": [{"value": "street", "label": "A small street with sidewalks and lamps"}, {"value": "none", "label": "Just grass"}]},
        {"key": "house.roof", "label": "Roof", "kind": "choice", "value": "terrace" if has_roof_stair else "flat",
         "source": "plan" if has_roof_stair else "default",
         "evidence": "a stair goes up to the roof" if has_roof_stair else "",
         "options": [{"value": "terrace", "label": "Flat roof terrace with a low wall"}, {"value": "flat", "label": "Plain flat roof"}]},
    ]}
    Q.append(house)
    beds = bedrooms_default(facts)
    for lv in sorted(facts["levels"], key=lambda l: l["index"]):
        sec = {"id": f"level{lv['index']}", "title": lv["name"], "items": []}
        for sp in lv["spaces"]:
            sid = sp["id"]; name = sp["label"] or sid
            card = {"space": sid, "title": name, "rect": sp["rect"], "fields": []}
            tval, tsrc, tev = (sp["type"] if sp["type"] in TYPE_LABELS else "other"), sp["type_source"], sp["evidence"]
            if lv["index"] == min(l["index"] for l in facts["levels"]) and sp["covered"] == "open" and street_edge(sp["rect"], lv["outline"], street) and tval != "yard":
                tval, tsrc, tev = "yard", "guess", f"open space along the street side ({street}) with the entrance door: treated as the front yard"
            card["fields"].append({"key": f"space.{sid}.type", "label": "What is this space?", "kind": "choice",
                                   "value": tval, "source": tsrc,
                                   "evidence": tev,
                                   "options": [{"value": k, "label": v} for k, v in TYPE_LABELS.items()]})
            outdoor = sp["type"] in OUTDOOR or sp["covered"] != "covered"
            if outdoor:
                card["fields"].append({"key": f"space.{sid}.covered", "label": "Is it covered?", "kind": "choice",
                                       "value": "open" if sp["covered"] != "covered" else "covered",
                                       "source": sp["covered_source"] if sp["covered"] != "unknown" else "unknown", "evidence": sp["evidence"],
                                       "options": [{"value": "open", "label": "Open to the sky"}, {"value": "covered", "label": "Covered (roof / ceiling)"}]})
                card["fields"].append({"key": f"space.{sid}.ground", "label": "Ground", "kind": "choice",
                                       "value": "grass" if sp["type"] == "yard" or (sp["type"] == "courtyard" and area(sp["rect"]) >= 20) else "tiles",
                                       "source": "default",
                                       "options": [{"value": v, "label": v.capitalize()} for v in ("grass", "tiles", "gravel", "sand")],
                                       "show_if": {f"space.{sid}.covered": "open"}})
                card["fields"].append({"key": f"space.{sid}.wall", "label": "Wall toward the street", "kind": "choice", "value": "low",
                                       "source": "default", "show_if": {f"space.{sid}.type": "yard"},
                                       "options": [{"value": "none", "label": "None"}, {"value": "low", "label": "Low wall (1 m) with a gate"}, {"value": "full", "label": "Full wall (2 m) with a gate"}]})
            if sp["type"] == "bedroom" or True:
                card["fields"].append({"key": f"space.{sid}.occupants", "label": "Who sleeps here?", "kind": "choice",
                                       "value": beds.get(sid, "child"), "source": "guess" if sid in beds else "default",
                                       "evidence": "the largest bedroom is assumed to be the parents' room" if beds.get(sid) == "couple" else "",
                                       "show_if": {f"space.{sid}.type": "bedroom"},
                                       "options": [{"value": "couple", "label": "A couple (double bed)"}, {"value": "adult", "label": "One adult"},
                                                   {"value": "child", "label": "A child (bed + desk)"}, {"value": "guest", "label": "Guest room"}]})
                card["fields"].append({"key": f"space.{sid}.kitchen", "label": "Kitchen equipment", "kind": "multi",
                                       "value": ["counters", "oven", "sink", "fridge", "table"], "source": "default",
                                       "show_if": {f"space.{sid}.type": "kitchen"},
                                       "options": [{"value": v, "label": l} for v, l in (("counters", "Counters"), ("oven", "Oven"), ("sink", "Sink"), ("fridge", "Fridge"), ("table", "Small table"))]})
                card["fields"].append({"key": f"space.{sid}.wet", "label": "Equipment", "kind": "multi",
                                       "value": ["toilet", "sink", "shower"] if sp["type"] == "bathroom" or area(sp["rect"]) >= 3.5 else ["toilet", "sink"],
                                       "source": "default", "show_if": {f"space.{sid}.type": ["wc", "bathroom"]},
                                       "options": [{"value": v, "label": v.capitalize()} for v in ("toilet", "sink", "shower")]})
                card["fields"].append({"key": f"space.{sid}.living", "label": "Furniture", "kind": "multi",
                                       "value": ["sofa", "tv", "rug", "dining"] if sp["type"] in ("living", "living_dining") else ["dining"],
                                       "source": "default", "show_if": {f"space.{sid}.type": ["living", "dining", "living_dining"]},
                                       "options": [{"value": "sofa", "label": "Sofa"}, {"value": "tv", "label": "TV"}, {"value": "rug", "label": "Rug"}, {"value": "dining", "label": "Dining table"}]})
            sec["items"].append(card)
        for i, st in enumerate(lv["stairs"]):
            sec["items"].append({"stair": f"{lv['index']}.{i}", "title": f"Stair ({'to the roof' if st['to'] == 'roof' else 'to the next floor'})", "rect": st["rect"],
                                 "fields": [{"key": f"stair.{lv['index']}.{i}.up", "label": "Which way do you walk going up?", "kind": "choice",
                                             "value": st["up"], "source": st["source"], "evidence": st["evidence"],
                                             "options": [{"value": d, "label": d.capitalize()} for d in DIRS]}]})
        Q.append(sec)
    return {"sections": Q, "assumptions": facts.get("assumptions", []), "notes": facts.get("notes", "")}


def defaults(facts):
    d = {}
    for sec in questions(facts)["sections"]:
        for it in sec["items"]:
            for f in (it["fields"] if "fields" in it else [it]):
                d[f["key"]] = f["value"]
    return d


def visible(field, ans):
    for k, v in field.get("show_if", {}).items():
        if (ans.get(k) not in v) if isinstance(v, list) else (ans.get(k) != v):
            return False
    return True


# ------------------------------------------------------------------ geometry helpers
def rotator(street, W, D):
    """Transform so the street side becomes north (-z)."""
    if street == "north": return (lambda x, z: (x, z)), (W, D), {d: d for d in DIRS}
    if street == "south": return (lambda x, z: (W - x, D - z)), (W, D), {"north": "south", "south": "north", "east": "west", "west": "east"}
    if street == "east":  return (lambda x, z: (z, W - x)), (D, W), {"east": "north", "north": "west", "west": "south", "south": "east"}
    return (lambda x, z: (D - z, x)), (D, W), {"west": "north", "north": "east", "east": "south", "south": "west"}


def tr_rect(T, r):
    a = T(r[0], r[1]); b = T(r[2], r[3])
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])]


def transform(facts, street):
    W, D = facts["lot"]["width"], facts["lot"]["depth"]
    xs = [v for l in facts["levels"] for r in [l["outline"]] for v in (r[0], r[2])]
    zs = [v for l in facts["levels"] for r in [l["outline"]] for v in (r[1], r[3])]
    W, D = max(W, max(xs)), max(D, max(zs))
    T, size, dmap = rotator(street, W, D)
    out = {"lot": {"width": size[0], "depth": size[1]}, "levels": []}
    for l in sorted(facts["levels"], key=lambda l: l["index"]):
        nl = {"index": l["index"], "name": l["name"], "outline": tr_rect(T, l["outline"]),
              "spaces": [dict(s, rect=tr_rect(T, s["rect"])) for s in l["spaces"]],
              "walls": [tr_rect(T, w) for w in l["walls"]],
              "openings": [], "stairs": []}
        for o in l["openings"]:
            seg = [o["at"], o["from"], o["at"], o["to"]] if o["axis"] == "x" else [o["from"], o["at"], o["to"], o["at"]]
            r = tr_rect(T, seg)
            if r[0] == r[2]: no = dict(o, axis="x", at=r[0], **{"from": r[1], "to": r[3]})
            else:            no = dict(o, axis="z", at=r[1], **{"from": r[0], "to": r[2]})
            nl["openings"].append(no)
        for i, st in enumerate(l["stairs"]):
            nl["stairs"].append(dict(st, rect=tr_rect(T, st["rect"]), up=dmap[st["up"]], key=f"{l['index']}.{i}"))
        out["levels"].append(nl)
    # drop the empty margin Claude may have read around the building (estimated lot, driveway, site lines):
    # the front of the house (or its yard / front deck) starts at the street, the west side at x = 0
    rects = [l["outline"] for l in out["levels"]] + [s["rect"] for l in out["levels"] for s in l["spaces"]]
    dx, dz = min(r[0] for r in rects), min(r[1] for r in rects)
    if dx or dz:
        sh = lambda r: [r[0] - dx, r[1] - dz, r[2] - dx, r[3] - dz]
        for l in out["levels"]:
            l["outline"] = sh(l["outline"])
            for s in l["spaces"]: s["rect"] = sh(s["rect"])
            l["walls"] = [sh(w) for w in l["walls"]]
            for st in l["stairs"]: st["rect"] = sh(st["rect"])
            for o in l["openings"]:
                d = dx if o["axis"] == "x" else dz; e = dz if o["axis"] == "x" else dx
                o["at"] -= d; o["from"] -= e; o["to"] -= e
    out["lot"] = {"width": max(r[2] for r in rects) - dx, "depth": max(r[3] for r in rects) - dz}
    return out


# ------------------------------------------------------------------ compiler
class Level:
    def __init__(self, S, lv):
        self.S = S; self.lv = lv
        self.wall_cells = set()
        for w in lv["walls"]:
            x0, z0, x1, z1 = (self.b(v) for v in w)
            for x in range(min(x0, x1), max(x0, x1) + 1):
                for z in range(min(z0, z1), max(z0, z1) + 1):
                    self.wall_cells.add((x, z))
        self.blocked = set()   # door approaches, door panels, stairs
        self.used = set()      # furniture

    def b(self, m): return int(round(m * self.S))

    def interior(self, r):
        return [(x, z) for x in range(self.b(r[0]) + 1, self.b(r[2])) for z in range(self.b(r[1]) + 1, self.b(r[3]))
                if (x, z) not in self.wall_cells]


def compile_plan(facts, answers):
    ans = defaults(facts); ans.update({k: v for k, v in answers.items() if v is not None})
    style = STYLES[ans["house.style"]]
    S = {"0.25": 4, "0.5": 2, "1": 1}[str(ans["house.scale"])]
    q = 1 / S
    H = int(round(2.5 * S))            # interior height in blocks
    f = transform(facts, ans["house.street_side"])
    for l in f["levels"]:  # apply per-space answers
        for s in l["spaces"]:
            s["type"] = ans.get(f"space.{s['id']}.type", s["type"])
            s["covered"] = ans.get(f"space.{s['id']}.covered", "covered" if s["covered"] == "covered" else "open" if s["type"] in OUTDOOR else "covered")
        for st in l["stairs"]:
            st["up"] = rotator(ans["house.street_side"], 1, 1)[2][ans[f"stair.{st['key']}.up"]] if f"stair.{st['key']}.up" in answers else st["up"]
    snap = lambda v: round(v * S) / S
    for l in f["levels"]:
        l["outline"] = [snap(v) for v in l["outline"]]
        for s in l["spaces"]: s["rect"] = [snap(v) for v in s["rect"]]
        l["walls"] = [[snap(v) for v in w] for w in l["walls"]]
        for o in l["openings"]:
            o["at"], o["from"], o["to"] = snap(o["at"]), snap(o["from"]), snap(o["to"])
        for st in l["stairs"]: st["rect"] = [snap(v) for v in st["rect"]]

    levels = f["levels"]
    g = levels[0]; gox0, goz0, gox1, goz1 = g["outline"]
    # ---- yard: an open ground-floor space along the whole street edge
    yard = None
    for s in g["spaces"]:
        r = s["rect"]
        if s["covered"] == "open" and r[1] <= goz0 and r[0] <= gox0 and r[2] >= gox1 and r[3] < goz1:
            yard = s
    notes = []
    plan_levels = []
    floor_y = 1
    lvl_objs = []
    for i, l in enumerate(levels):
        L = Level(S, l)
        fp = list(l["outline"])
        if i == 0 and yard: fp[1] = max(fp[1], yard["rect"][3])
        # walls: drop the ones that belong to the yard (the yard draws its own low wall)
        walls = []
        for w in l["walls"]:
            if i == 0 and yard:
                yr = yard["rect"]
                inside = yr[0] <= min(w[0], w[2]) and max(w[0], w[2]) <= yr[2] and yr[1] <= min(w[1], w[3]) and max(w[1], w[3]) <= yr[3]
                if inside and not (w[1] == w[3] == yr[3]): continue
            walls.append(w)
        # outer walls around the floor, except along open spaces (decks, patios) on the edge: those stay open to the outside
        opens = [s_["rect"] for s_ in l["spaces"] if s_["covered"] == "open" and s_ is not yard]
        for e in ([fp[0], fp[1], fp[2], fp[1]], [fp[0], fp[3], fp[2], fp[3]], [fp[0], fp[1], fp[0], fp[3]], [fp[2], fp[1], fp[2], fp[3]]):
            walls.extend(cut_open(e, opens, q))
        l["walls"] = walls
        L = Level(S, l); L.footprint = fp
        lvl_objs.append(L)
        plan_levels.append({"name": l["name"], "floor_y": floor_y, "height": H / S, "footprint": fp,
                            "voids": [], "floors": [], "walls": walls, "openings": [], "lights": [], "furniture": []})
        floor_y += H + 1
    roof_y = floor_y

    # ---- floors, open spaces
    open_rects = []
    for i, (l, pl) in enumerate(zip(levels, plan_levels)):
        for s in l["spaces"]:
            if s is yard: continue
            r = s["rect"]
            if s["covered"] == "open":
                pl["voids"].append([r[0] + q, r[1] + q, r[2], r[3]])
                open_rects.append((i, r, s))
                continue
            grp = FLOOR_GROUP.get(s["type"], "other")
            pl["floors"].append({"rect": [r[0], r[1], r[2] + q, r[3] + q], "block": style["floors"][grp], "room": s["label"] or s["id"]})
    # open space on the ground floor: give it a ground (no slab void, it is the ground)
    for i, r, s in open_rects:
        pl = plan_levels[i]
        ground = {"grass": "grass_block", "tiles": style["tiles"], "gravel": "gravel", "sand": "sand"}[ans.get(f"space.{s['id']}.ground", "tiles")]
        if i == 0:
            pl["voids"].remove([r[0] + q, r[1] + q, r[2], r[3]])
            pl["floors"].append({"rect": [r[0] + q, r[1] + q, r[2], r[3]], "block": ground, "room": s["label"] or s["id"]})
    # a space open on a lower level stays open above (light shaft) unless an upper floor covers it with a room
    roof_voids = []
    for i, r, s in open_rects:
        top_open = True
        for j in range(i + 1, len(levels)):
            covering = [t for t in levels[j]["spaces"] if t["covered"] != "open" and t["rect"][0] < r[2] and t["rect"][2] > r[0] and t["rect"][1] < r[3] and t["rect"][3] > r[1]]
            if covering: top_open = False; break
            v = [r[0] + q, r[1] + q, r[2], r[3]]
            if v not in plan_levels[j]["voids"]: plan_levels[j]["voids"].append(v)
        if top_open and i == len(levels) - 1 or top_open:
            roof_voids.append([r[0] + q, r[1] + q, r[2], r[3]])

    # ---- stairs
    stairs = []
    railings = []
    for i, l in enumerate(levels):
        L = lvl_objs[i]
        for st in l["stairs"]:
            r = st["rect"]; dx, dz = DIRS[st["up"]]
            cells = L.interior(r) or [(L.b(r[0]), L.b(r[1]))]
            xs = sorted({c[0] for c in cells}); zs = sorted({c[1] for c in cells})
            n = H + 1
            if dx:   # running east/west, width along z
                width = zs; run = xs if dx > 0 else xs[::-1]
            else:
                width = xs; run = zs if dz > 0 else zs[::-1]
            first = run[-1] - (n - 1) * (dx or dz) if len(run) >= n else run[0]
            steps = [(first + k * dx, width[0]) if dx else (width[0], first + k * dz) for k in range(n)]
            # cells of every step across the width
            step_cells = []
            for k in range(n):
                for w in width:
                    step_cells.append(((first + k * dx, w) if dx else (w, first + k * dz), k))
            start = steps[0]
            stairs.append({"name": f"{l['name']} stair", "start": [start[0] / S, start[1] / S], "dir": st["up"],
                           "width": len(width) / S, "steps": n, "base_y": plan_levels[i]["floor_y"], "block": style["stairs"]})
            for c, k in step_cells:
                L.blocked.add(c)
            # opening above every step but the last, in the next slab (or the roof)
            hole = [c for c, k in step_cells if k < n - 1]
            if hole:
                x0 = min(c[0] for c in hole); x1 = max(c[0] for c in hole); z0 = min(c[1] for c in hole); z1 = max(c[1] for c in hole)
                rect = [x0 / S, z0 / S, (x1 + 1) / S, (z1 + 1) / S]
                if st["to"] == "roof" or i == len(levels) - 1:
                    roof_voids.append(rect)
                    rx = [x0 - 1, x1 + 1]; rz = [z0 - 1, z1 + 1]
                    railings.append((x0 - 1, z0 - 1, x1 + 1, z1 + 1, steps[-1]))
                else:
                    plan_levels[i + 1]["voids"].append(rect)
                    lvl_objs[i + 1].blocked.update((x, z) for x in range(x0, x1 + 1) for z in range(z0, z1 + 1))
                    top = steps[-1]
                    lvl_objs[i + 1].blocked.update({(top[0] + dx, top[1] + dz), top})

    # ---- openings (doors with panels, windows with shutters)
    space_by_id = {s["id"]: s for l in levels for s in l["spaces"]}
    for i, (l, pl) in enumerate(zip(levels, plan_levels)):
        L = lvl_objs[i]
        rooms = {s["id"]: s for s in l["spaces"]}
        for o in l["openings"]:
            lo, hi = L.b(o["from"]), L.b(o["to"]) - 1
            if o["type"] in ("door", "opening") and hi - lo + 1 < max(1, int(round(0.8 * S))):
                mid = (L.b(o["from"]) + L.b(o["to"])) // 2; need = max(1, int(round(0.8 * S)))
                lo = mid - need // 2; hi = lo + need - 1
            if hi < lo: hi = lo
            rng = [lo / S, (hi + 1) / S]
            c = L.b(o["at"]); ax = o["axis"]
            between = [rooms.get(b) or space_by_id.get(b) for b in o["between"] if b != "outside"]
            outside = "outside" in o["between"] or any(b and b["covered"] == "open" for b in between)
            spec = {"type": "window" if o["type"] == "window" else "door", "line": [ax, o["at"]], "range": rng,
                    "note": " -> ".join(b["label"] or b["id"] for b in between if b) or "outside"}
            if o["type"] == "window":
                if outside and style["shutter"]:
                    inner = [b for b in between if b and b["covered"] != "open"]
                    if inner:
                        rr = inner[0]["rect"]; centre = (rr[1] + rr[3]) / 2 if ax == "z" else (rr[0] + rr[2]) / 2
                        spec["shutters"] = -1 if centre > o["at"] else 1
                if pl["floor_y"] == 1 and any(b and b["type"] in ("wc", "bathroom") for b in between):
                    spec["sill"] = 0.5 * 2 / S if S < 2 else 1.0
                pl["openings"].append(spec); continue
            # door approach: keep the cells in front of the opening free on both sides
            for side in (-1, 1):
                for k in (1, 2):
                    for p in range(lo, hi + 1):
                        L.blocked.add((c + side * k, p) if ax == "x" else (p, c + side * k))
            if o["type"] == "door" and ans["house.doors"] == "open_panels":
                panel = choose_panel(L, ax, c, lo, hi, between, o, S)
                if panel: spec["panel"] = panel
            pl["openings"].append(spec)

    # ---- closets that are too narrow to walk in: barrels in the wall facing each room they open to
    for i, (l, pl) in enumerate(zip(levels, plan_levels)):
        L = lvl_objs[i]
        for s in l["spaces"]:
            if s["type"] != "closet": continue
            cells = L.interior(s["rect"])
            for o in l["openings"]:
                if s["id"] not in o["between"]: continue
                other = [b for b in o["between"] if b != s["id"]]
                tgt = space_by_id.get(other[0]) if other else None
                if not tgt: continue
                tr = tgt["rect"]
                if o["axis"] == "x": front = "east" if (tr[0] + tr[2]) / 2 > o["at"] else "west"
                else: front = "south" if (tr[1] + tr[3]) / 2 > o["at"] else "north"
                lo, hi = L.b(o["from"]), L.b(o["to"]) - 1
                c = L.b(o["at"])
                for p in range(lo, max(lo, hi) + 1):
                    at = (c, p) if o["axis"] == "x" else (p, c)
                    pl["furniture"].append({"type": "barrel", "at": [at[0] / S, at[1] / S], "front": front, "note": "closet " + (s["label"] or s["id"])})
                pl["openings"] = [x for x in pl["openings"] if not (x["line"] == [o["axis"], o["at"]] and abs(x["range"][0] - lo / S) < 1e-9)]
            L.blocked.update(cells)

    # ---- furniture and lights per room
    for i, (l, pl) in enumerate(zip(levels, plan_levels)):
        L = lvl_objs[i]
        for s in l["spaces"]:
            if s["covered"] == "open" or s is yard: continue
            cells = [c for c in L.interior(s["rect"]) if c not in L.blocked]
            allc = L.interior(s["rect"])
            if allc:
                cx = sum(c[0] for c in allc) / len(allc); cz = sum(c[1] for c in allc) / len(allc)
                pl["lights"].append([round(cx) / S, round(cz) / S])
            furnish(L, s, ans, style, pl["furniture"], notes)

    # ---- roof, yard, street, world
    top = plan_levels[-1]
    roof = {"y": roof_y, "block": style["roof"], "footprint": top["footprint"], "voids": roof_voids,
            "parapet": {"height": 1.0 if ans["house.roof"] == "terrace" else 0.5, "lines": []},
            "railing": {"block": "oak_fence", "lines": []}}
    fp = top["footprint"]
    roof["parapet"]["lines"] = [[fp[0], fp[1], fp[2], fp[1]], [fp[0], fp[3], fp[2], fp[3]], [fp[0], fp[1], fp[0], fp[3]], [fp[2], fp[1], fp[2], fp[3]]]
    for _, r, s in open_rects:  # wall around light shafts on the roof
        roof["parapet"]["lines"] += [[r[0], r[1], r[2], r[1]], [r[0], r[3], r[2], r[3]], [r[0], r[1], r[0], r[3]], [r[2], r[1], r[2], r[3]]]
    for x0, z0, x1, z1, topstep in railings:
        ring = [(x, z0) for x in range(x0, x1 + 1)] + [(x, z1) for x in range(x0, x1 + 1)] + [(x0, z) for z in range(z0, z1 + 1)] + [(x1, z) for z in range(z0, z1 + 1)]
        fx0, fz0, fx1, fz1 = (int(round(v * S)) for v in fp)
        for (x, z) in ring:
            if x in (fx0, fx1) or z in (fz0, fz1): continue
            if abs(x - topstep[0]) + abs(z - topstep[1]) <= 1: continue
            roof["railing"]["lines"].append([x / S, z / S, x / S, z / S])

    plan = {"_comment": "Generated by compile.py from Claude's reading of the plan and the questionnaire answers.",
            "scale": S,
            "palette": {"wall": style["wall"], "slab": style["slab"], "glass": "glass_pane", "light": "sea_lantern",
                        "door": style["door"], "shutter": style["shutter"] or style["door"]},
            "door": {"sill": 0, "height": 2.0}, "window": {"sill": 1.0, "height": 1.0},
            "levels": plan_levels, "roof": roof, "stairs": stairs}
    lotW, lotD = f["lot"]["width"], f["lot"]["depth"]
    gate_x = None
    if yard:
        yr = yard["rect"]; wall = ans.get(f"space.{yard['id']}.wall", "low")
        front = [o for o in levels[0]["openings"] if o["type"] in ("door", "opening") and yard["id"] in o["between"]]
        gx0, gx1 = (front[0]["from"], front[0]["to"]) if front else ((yr[0] + yr[2]) / 2 - 0.5, (yr[0] + yr[2]) / 2 + 0.5)
        gx0 = snap(gx0); gx1 = max(snap(gx1), gx0 + 2 * q)
        ground = {"grass": "grass_block", "tiles": style["tiles"], "gravel": "gravel", "sand": "sand"}[ans.get(f"space.{yard['id']}.ground", "grass")]
        plan["yard"] = {"rect": yr, "ground": ground, "wall": style["yard_wall"],
                        "wall_height": {"none": 0, "low": 1.0, "full": 2.0}[wall], "gate": [gx0, gx1], "path": style["path"]}
        gate_x = int(round((gx0 + gx1) / 2 * S))
    else:
        front = [o for o in levels[0]["openings"] if o["type"] in ("door", "opening") and "outside" in o["between"]]
        gate_x = int(round((front[0]["from"] + front[0]["to"]) / 2 * S)) if front else int(round(lotW / 2 * S))
    if ans["house.surroundings"] == "street":
        plan["street"] = {"x_range": [-9, lotW + 9], "sidewalk": 1.5, "road": 6, "sidewalk_block": "smooth_stone", "curb_block": "stone",
                          "road_block": "gray_concrete", "line_block": "white_concrete",
                          "lamps": {"every": 8, "height": 4, "pole": "andesite_wall", "head": "sea_lantern"}}
        depth_front = (1.5 * 2 + 6) * S
    else:
        depth_front = 3 * S
    Wb, Db = int(lotW * S), int(lotD * S)
    cx, cz = Wb // 2, (Db - depth_front) // 2
    size = int(max(Wb + 18 * S, Db + depth_front + 6 * S)) + 10
    plan["world"] = {"title": "", "ground_y": -61, "spawn": [gate_x, 2, -2],
                     "border_center": [cx, cz], "border_size": size,
                     "forceload": [cx - size // 2 - 8, cz - size // 2 - 8, cx + size // 2 + 8, cz + size // 2 + 8]}
    plan["notes"] = notes
    return plan


def cut_open(seg, opens, q):
    """Split an outer wall segment so it skips the parts that border an open space (deck, patio)."""
    x0, z0, x1, z1 = seg
    horiz = z0 == z1
    a, b = (x0, x1) if horiz else (z0, z1)
    gaps = []
    for r in opens:
        if horiz and r[1] - q <= z0 <= r[3] + q: gaps.append((max(a, r[0] + q), min(b, r[2] - q)))
        if not horiz and r[0] - q <= x0 <= r[2] + q: gaps.append((max(a, r[1] + q), min(b, r[3] - q)))
    pieces, cur = [], a
    for g0, g1 in sorted(g for g in gaps if g[1] > g[0]):
        if g0 > cur: pieces.append((cur, g0 - q))
        cur = max(cur, g1 + q)
    if cur <= b: pieces.append((cur, b))
    return [[p0, z0, p1, z1] if horiz else [x0, p0, x1, p1] for p0, p1 in pieces if p1 >= p0]


def choose_panel(L, ax, c, lo, hi, between, o, S):
    """Pick the side and hinge of an open door panel: swing into a room if 2 free cells, else lie flat, else none."""
    depth = max(1, int(round(1.0 * S)))   # door leaf = 1 m
    pref = sorted([b for b in between if b], key=lambda b: 0 if b["type"] not in ("hallway", "landing", "stairs", "closet") else 1)
    for b in pref:
        r = b["rect"]
        side = (1 if (r[0] + r[2]) / 2 > o["at"] else -1) if ax == "x" else (1 if (r[1] + r[3]) / 2 > o["at"] else -1)
        inside = set(L.interior(r))
        for hinge, p in (("low", lo), ("high", hi)):
            cells = [((c + side * k, p) if ax == "x" else (p, c + side * k)) for k in range(1, depth + 1)]
            if all(cell in inside and cell not in L.used for cell in cells):
                L.blocked.update(cells)
                return {"side": side, "hinge": hinge}
        for hinge in ("low", "high"):
            ps = range(lo - depth, lo) if hinge == "low" else range(hi + 1, hi + 1 + depth)
            cells = [((c + side, p) if ax == "x" else (p, c + side)) for p in ps]
            if all(cell in inside and cell not in L.used for cell in cells):
                L.blocked.update(cells)
                return {"side": side, "hinge": hinge, "mode": "flat"}
    return None


# ------------------------------------------------------------------ furniture layout
def furnish(L, s, ans, style, out, notes):
    S = L.S; sid = s["id"]; t = s["type"]
    free = set(c for c in L.interior(s["rect"]) if c not in L.blocked)
    allcells = set(L.interior(s["rect"]))
    if not free: return
    xs = [c[0] for c in allcells]; zs = [c[1] for c in allcells]
    bx0, bx1, bz0, bz1 = min(xs), max(xs), min(zs), max(zs)
    cm = lambda m: max(1, int(round(m * S)))
    M = lambda x0, z0, x1, z1: [x0 / S, z0 / S, (x1 + 1) / S, (z1 + 1) / S]
    P = lambda x, z: [x / S, z / S]

    def against(side, w, d, along=None):
        """Candidate footprints of w (along the wall) x d (depth) cells against wall `side`."""
        res = []
        if side in ("north", "south"):
            z0 = bz0 if side == "north" else bz1 - d + 1
            for x0 in range(bx0, bx1 - w + 2):
                res.append([(x, z) for x in range(x0, x0 + w) for z in range(z0, z0 + d)])
        else:
            x0 = bx0 if side == "west" else bx1 - d + 1
            for z0 in range(bz0, bz1 - w + 2):
                res.append([(x, z) for z in range(z0, z0 + w) for x in range(x0, x0 + d)])
        return res

    def wall_backed(cells, side):
        dx, dz = DIRS[side]
        return all((x + dx, z + dz) not in allcells for (x, z) in cells if (x + dx, z + dz) not in cells)

    def ok(cells, extra_free=()):
        return all(c in free and c not in L.used for c in cells) and all(c in free and c not in L.used for c in extra_free)

    def take(cells): L.used.update(cells)

    def front_cells(cells, side, k=1):
        dx, dz = DIRS[OPP[side]]
        return [(x + dx * k, z + dz * k) for (x, z) in cells]

    def bounds(cells):
        return min(c[0] for c in cells), min(c[1] for c in cells), max(c[0] for c in cells), max(c[1] for c in cells)

    sides = sorted(DIRS, key=lambda sd: -sum(1 for c in allcells if (c[0] + DIRS[sd][0], c[1] + DIRS[sd][1]) in L.wall_cells))

    def place_against(w, d, front_clear=1, prefer=None):
        for side in (prefer or []) + [x for x in sides if x not in (prefer or [])]:
            for cells in against(side, w, d):
                if not wall_backed(cells, side): continue
                fc = [c for k in range(1, front_clear + 1) for c in front_cells([c for c in cells], side, k) if c not in cells]
                if ok(cells, fc):
                    return side, cells
        return None, None

    if t == "bedroom":
        occ = ans.get(f"space.{sid}.occupants", "child")
        double = occ in ("couple", "guest")
        bw, bd = cm(1.5 if double else 1.0), cm(2.0)
        placed = False
        for side in sides:   # bed: head against a wall, nightstand(s) beside the head
            for cells in against(side, bw, bd):
                if not wall_backed(cells, side) or not ok(cells): continue
                x0, z0, x1, z1 = bounds(cells)
                if side in ("north", "south"):
                    hz = z0 if side == "north" else z1
                    ns = [(x0 - 1, hz), (x1 + 1, hz)]
                else:
                    hx = x0 if side == "west" else x1
                    ns = [(hx, z0 - 1), (hx, z1 + 1)]
                ns = [c for c in ns if c in free and c not in L.used]
                if double and len(ns) < 2 and S > 1: continue
                take(cells); out.append({"type": "bed", "rect": M(x0, z0, x1, z1), "head": side,
                                         "blanket": "blue_carpet" if double else "orange_carpet" if occ == "child" else "light_blue_carpet"})
                for c in ns[: 2 if double else 1]:
                    take([c]); out.append({"type": "nightstand", "at": P(*c)})
                placed = True; break
            if placed: break
        side, cells = place_against(cm(1.0 if not double else 1.5), cm(0.5), 1)
        if cells:
            take(cells); x0, z0, x1, z1 = bounds(cells)
            out.append({"type": "wardrobe", "rect": M(x0, z0, x1, z1), "front": OPP[side]})
        if occ in ("child", "adult"):
            side, cells = place_against(cm(1.0), cm(0.5), 1)
            if cells:
                x0, z0, x1, z1 = bounds(cells); chair = front_cells(cells, side)[0]
                take(cells + [chair])
                out.append({"type": "desk", "rect": M(x0, z0, x1, z1), "chair": {"at": P(*chair), "back": OPP[side]}})
    elif t in ("living", "dining", "living_dining"):
        want = ans.get(f"space.{sid}.living", ["sofa", "tv", "rug", "dining"])
        if "sofa" in want:
            side, cells = place_against(cm(2.0), cm(0.5), 2)
            if cells:
                take(cells); x0, z0, x1, z1 = bounds(cells)
                out.append({"type": "sofa", "rect": M(x0, z0, x1, z1), "back": side, "block": style["sofa"]})
                for c in ((x0, z0 - 1), (x1, z1 + 1)) if side in ("east", "west") else ((x0 - 1, z0), (x1 + 1, z1)):
                    L.used.add(c)
                ct = front_cells(cells, side, 2)
                ct = ct[len(ct) // 4: len(ct) - len(ct) // 4] or ct
                if ok(ct):
                    take(ct); a = bounds(ct); out.append({"type": "coffee_table", "rect": M(*a)})
                if "tv" in want:   # TV on the opposite wall, facing the sofa
                    opp = OPP[side]
                    for tc in against(opp, len(cells) // max(1, cm(0.5)), cm(0.5)):
                        a = bounds(tc)
                        if ok(tc) and wall_backed(tc, opp) and (side in ("east", "west") and a[1] <= z1 and a[3] >= z0 or side in ("north", "south") and a[0] <= x1 and a[2] >= x0):
                            take(tc)
                            scr = tc[len(tc) // 4: len(tc) - len(tc) // 4] or tc
                            out.append({"type": "tv", "rect": M(*a), "wall": opp, "screen": [P(*c) for c in scr]})
                            break
                # keep the whole sofa-to-TV band for the living area
                band = cells + ct
                bx_0, bz_0, bx_1, bz_1 = bounds(band)
                if side in ("east", "west"):
                    zone = [(x, z) for x in range(bx0, bx1 + 1) for z in range(bz_0, bz_1 + 1)]
                else:
                    zone = [(x, z) for x in range(bx_0, bx_1 + 1) for z in range(bz0, bz1 + 1)]
                L.used.update(c for c in zone if c in allcells)
                if "rug" in want:
                    rx0, rz0, rx1, rz1 = bounds(cells + ct)
                    out.append({"type": "rug", "rect": M(rx0 - (1 if side in ('north', 'south') else 0), rz0 - (1 if side in ('east', 'west') else 0),
                                                         rx1 + (1 if side in ('north', 'south') else 0), rz1 + (1 if side in ('east', 'west') else 0)),
                                "block": "blue_carpet"})
        if "dining" in want:
            tw, td = cm(1.5), cm(1.0)
            for (w, d, chairs) in ((tw, td, "ns"), (td, tw, "ew"), (cm(1.0), cm(1.0), "ns")):
                done = False
                for z0 in range(bz0 + 1, bz1 - d + 1):
                    for x0 in range(bx0 + 1, bx1 - w + 1):
                        cells = [(x, z) for x in range(x0, x0 + w) for z in range(z0, z0 + d)]
                        if chairs == "ns":
                            ch = [(x, z0 - 1) for x in range(x0, x0 + w)] + [(x, z0 + d) for x in range(x0, x0 + w)]
                        else:
                            ch = [(x0 - 1, z) for z in range(z0, z0 + d)] + [(x0 + w, z) for z in range(z0, z0 + d)]
                        if ok(cells + ch):
                            take(cells + ch)
                            out.append({"type": "table", "rect": M(x0, z0, x0 + w - 1, z0 + d - 1),
                                        "chairs": ["north", "south"] if chairs == "ns" else ["west", "east"]})
                            done = True; break
                    if done: break
                if done: break
    elif t == "kitchen":
        eq = ans.get(f"space.{sid}.kitchen", ["counters", "oven", "sink", "fridge", "table"])
        if "fridge" in eq:
            side, cells = place_against(1, 1, 1)
            if cells: take(cells); out.append({"type": "fridge", "at": P(*cells[0])})
        if "counters" in eq or "oven" in eq or "sink" in eq:
            best = None
            for side in sides:
                for w in range(max(bx1 - bx0, bz1 - bz0) + 1, 1, -1):
                    for cells in against(side, w, 1):
                        if wall_backed(cells, side) and ok(cells, front_cells(cells, side)):
                            if not best or len(cells) > len(best[1]): best = (side, cells)
                    if best and len(best[1]) >= w: break
            if best:
                side, cells = best; take(cells); a = bounds(cells)
                cs = sorted(cells)
                items = []
                if "oven" in eq: items.append({"at": P(*cs[0]), "item": "oven"})
                if "sink" in eq and len(cs) > 1: items.append({"at": P(*cs[len(cs) // 2]), "item": "sink"})
                out.append({"type": "counter", "rect": M(*a), "front": OPP[side], "items": items})
        if "table" in eq:
            for z0 in range(bz0, bz1 + 1):
                done = False
                for x0 in range(bx0, bx1):
                    cells = [(x0, z0), (x0 + 1, z0)]; ch = [(x0, z0 - 1), (x0 + 1, z0 - 1)]
                    if ok(cells + ch) and ok(front_cells(cells, "north")):
                        take(cells + ch); out.append({"type": "table", "rect": M(x0, z0, x0 + 1, z0), "chairs": ["north"]}); done = True; break
                if done: break
    elif t in ("wc", "bathroom"):
        eq = ans.get(f"space.{sid}.wet", ["toilet", "sink"])
        if "shower" in eq:
            sw = cm(0.9)
            done = False
            for side, (w_, d_) in [(sd, wd) for wd in ((sw, sw), (sw, 1)) for sd in sides]:
                for cells in against(side, w_, d_):
                    if wall_backed(cells, side) and ok(cells):
                        a = bounds(cells); take(cells)
                        glass = [c for c in front_cells(cells, side) if c in allcells][:1]
                        out.append({"type": "shower", "rect": M(*a), "glass": [P(*c) for c in glass], "head": P(*cells[0])})
                        done = True; break
                if done: break
            if not done: notes.append(f"{s['label'] or sid}: too small for a shower")
        if "toilet" in eq:
            side, cells = place_against(1, 1, 1)
            if cells: take(cells); out.append({"type": "toilet", "at": P(*cells[0]), "back": side})
            else: notes.append(f"{s['label'] or sid}: no free wall for the toilet")
        if "sink" in eq:
            side, cells = place_against(1, 1, 1)
            if cells: take(cells); out.append({"type": "sink", "at": P(*cells[0])})
            else: notes.append(f"{s['label'] or sid}: too small for a sink")
    elif t == "office":
        side, cells = place_against(cm(1.5), cm(0.5), 1)
        if cells:
            x0, z0, x1, z1 = bounds(cells); chair = front_cells(cells, side)[len(cells) // 2]
            take(cells + [chair]); out.append({"type": "desk", "rect": M(x0, z0, x1, z1), "chair": {"at": P(*chair), "back": OPP[side]}})
        side, cells = place_against(cm(1.0), cm(0.5), 1)
        if cells:
            take(cells); a = bounds(cells); out.append({"type": "wardrobe", "rect": M(*a), "front": OPP[side]})
    if t in ("living", "living_dining", "hallway", "landing", "office", "bedroom"):
        corners = [(bx0, bz0), (bx1, bz0), (bx0, bz1), (bx1, bz1)]
        for c in corners:
            if c in free and c not in L.used and len(free) > 6:
                take([c]); out.append({"type": "plant", "at": P(*c)}); break


if __name__ == "__main__":
    cmd = sys.argv[1]
    facts = json.load(open(sys.argv[2]))
    facts = facts.get("facts", facts)
    if cmd == "questions":
        print(json.dumps(questions(facts), indent=1))
    elif cmd == "plan":
        answers = json.load(open(sys.argv[3])) if sys.argv[3] != "-" else {}
        plan = compile_plan(facts, answers)
        json.dump(plan, open(sys.argv[4], "w"), indent=1)
        print(json.dumps({"levels": len(plan["levels"]), "furniture": sum(len(l["furniture"]) for l in plan["levels"]),
                          "doors": sum(1 for l in plan["levels"] for o in l["openings"] if o["type"] == "door"),
                          "notes": plan["notes"]}))
