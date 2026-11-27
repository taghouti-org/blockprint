# Plan → Minecraft world: web app spec

## Flow
1. **Upload** a plan (image or PDF, one or several floors).
2. **Claude reads the plan** and writes a draft `house_plan.json` (walls, openings, stairs, spaces, in meters).
   For every space it gives a *guess* (from labels such as "Chambre", "Salle", "Cuisine", "WC", "Esc.",
   "Courette", "Non couvert", from hatching, and from the shape) and a confidence.
3. **Questionnaire** (below). Answers are pre-filled, and each one shows where it came from:
   - **From the plan**: written or drawn on the plan (room label "Chambre" → bedroom, "Cuisine" → kitchen,
     "Non couvert" → open to the sky, hatching → open space, door and window symbols, stair arrows,
     dimensions, toilet/shower/bed symbols). Pre-filled and shown as confirmed; the card is collapsed,
     and the user only opens it to change something.
   - **Claude's guess**: not on the plan but inferred (e.g. a 3 × 5 m room next to the landing is the
     parents' bedroom). Pre-filled but highlighted so the user checks it.
   - **Default**: nothing to go on (e.g. floor material from the chosen style). Pre-filled, marked as default.
   - **Unknown**: no sensible default (e.g. a space with no label and no hatching). Left empty and the
     user must answer before building.
   The draft JSON carries this per answer: `{"value": ..., "source": "plan" | "guess" | "default" | "unknown", "evidence": "label 'Chambre 3x4 m'"}`.
4. **Review**: floor-by-floor preview plus the list of assumptions; the user can fix things or ask Claude in plain words.
5. **Build and download** the world (Java first, Bedrock later).

## Questionnaire

### A. Whole house (asked once)
- Scale: 25 cm / 50 cm / 1 m per block (explain the trade-offs: door size, narrow hallways).
- Edition and game version.
- Decoration style (e.g. Traditional Tunisian, Modern, Classic wood).
- Surroundings: small street / garden / nothing. Small world with a border: yes/no.
- Mobs off, always day, clear weather: yes/no.
- Doors: real-size panels shown open / Minecraft doors / open doorways.

### B. Each room (one card per room, every floor)
- **What is this room?** Bedroom, living room, dining room, living + dining, kitchen, bathroom, WC,
  hallway, stairs, office, storage, laundry, garage, other.
- Follow-up questions by type:
  - Bedroom: who sleeps here (couple, one adult, child, guest), bed size, desk yes/no, wardrobe.
  - Living / dining: sofa, TV, number of dining seats.
  - Kitchen: counters, oven, sink, fridge, small table.
  - Bathroom / WC: toilet, sink, shower, bath (warn when the room is too small for what is asked).
  - Office: desk(s), shelves, sofa bed.
- Floor material (default from the style).
- Doors: if the plan shows no door into the room, ask whether to add one and from which room.

### C. Each empty or hatched space (yard, courtyard, terrace, light shaft…)
- **Is it covered?** Open to the sky / roofed / covered on the ground floor only.
- What is it: yard, garden, courtyard, terrace, parking, light shaft, other.
- Ground: grass, tiles, gravel, sand.
- Wall around it: none / low wall (height) / full wall.
- How do you get in: door from which room / windows only / gate from the street.
- Furniture or plants: none / plants / table and chairs / car.

### D. Stairs and roof
- For each stair: which way it goes up (shown on the preview), where it arrives.
- Roof: flat terrace (with low wall, access stair) / plain flat roof / pitched roof.

### E. Assumptions
- Everything Claude had to guess (e.g. "door added from the landing into the large bedroom",
  "stairs climb east over the WC") is listed for the user to accept or change.

## Notes from the first house (2026-11-27)
- 25 cm/block: doors and furniture look right but the house feels huge to the player.
- 1 m/block: 1 m hallways and stairs disappear because walls are 1 block thick.
- 50 cm/block chosen. A 1 m × 50 cm WC under the stairs can hold a toilet only.
- 26.3 game rules use snake_case names (spawn_mobs, advance_time…). One invalid line makes the whole function fail to load.
- Keep the "Vanilla" data pack selected when creating the world.
