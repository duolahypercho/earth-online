# San Francisco Geography Reference

Status: Goal 02 deliverable (reference only)  
Audience: district authoring, road-network, and streaming agents  
Scope: map real SF districts into the game's 384 m sector grid for the next authored expansion ring  

**Do not treat this file as runtime geometry.** It is a stylized, playable translation of public geography into the existing `EXPANSION_SECTORS` / waterfront / grade contracts.

---

## 1. Coordinate convention

| Axis / unit | Meaning |
| --- | --- |
| `+X` | East |
| `+Z` | North |
| `+Y` | Up |
| Sector size | `384 m` |
| Sector center | `(sectorX * 384, sectorZ * 384)` |
| Local bounds | `[-192, 192]` in both X and Z relative to sector center |
| Road lines | Local axis-aligned offsets in `[-192, 192]`; typically 7 values including both edges |
| Diagonals | Optional local polyline `{ start: [x,z], end: [x,z], width, name }` |
| Grade | Authored slope coefficient applied primarily along local `+Z` (see `authoredGradeAtPosition`); edge-faded over ~48 m |
| Waterfront | Local or world edge with `start`, `end`, `outwardNormal`, optional `distance` |

Existing authored sectors (`src/sf-expansion.js`, `AUTHORED_DISTRICT_BY_SECTOR`):

| Key | World center (m) | District |
| --- | --- | --- |
| `0:0` | (0, 0) | Core hand-authored district |
| `1:0` | (384, 0) | Civic Center / SoMa (Market diagonal) |
| `4:0` | (1536, 0) | Financial District |
| `4:4` | (1536, 1536) | North Beach / Telegraph Hill (Columbus, Coit) |
| `0:4` | (0, 1536) | Pacific Heights (California Street hill) |
| `-4:1` | (-1536, 384) | Presidio Heights / Presidio |
| `-3:-2` | (-1152, -768) | Mission District (Mission diagonal, Dolores) |
| `4:-4` | (1536, -1536) | Mission Bay waterfront |
| `-5:-4` | (-1920, -1536) | Outer Sunset ocean frontage |

**Relative map of existing anchors (stylized):**

```text
              N (+Z)
  Presidio -4:1     Pac Hts 0:4     North Beach 4:4
                    Core 0:0   Civic 1:0   FiDi 4:0
  Mission -3:-2                              Mission Bay 4:-4
  Outer Sunset -5:-4
              S (-Z)
```

---

## 2. Placement method and corrections

### Method

1. Keep existing authored keys fixed; they are the geography skeleton.
2. Place new districts by **relative real-world adjacency** (not a global lat/lon re-projection of the whole city). The game already compresses SF into a coarse footprint with non-uniform spacing.
3. Prefer keys that:
   - stay inside `SF_FOOTPRINT` (`createSanFranciscoSectorCatalog` / `isValid`)
   - share a face with an existing or planned authored sector (road-network connectivity)
   - match `districtForPosition` heuristics where possible
4. Street lines are **playable low-poly summaries**: 5–7 axis lines + optional one signature diagonal, not a full OSM import.
5. Grades are game values in the same family as existing authored grades (`0.006`–`0.11`), not raw percent slope pasted into the mesh.

### Suggested set vs accepted set

| District | Suggested | Accepted | Why |
| --- | --- | --- | --- |
| Chinatown | `3:3` | **`3:3`** | Between Nob Hill and North Beach / FiDi stack |
| Nob Hill | `2:3` | **`2:3`** | West of Chinatown, south of Russian Hill / Pac Heights |
| Russian Hill | `1:4` | **`1:4`** | East of Pac Heights `0:4`, west of North Beach band |
| Marina | `-1:4` | **`0:5`** | Real Marina is **north** of Pacific Heights, not west of it. `-1:4` would sit beside Pac Heights and read as Western Addition / Presidio approach |
| Embarcadero / Transamerica-adjacent | `3:0` | **`3:0`** | West of FiDi `4:0`, east of Civic spine |
| SoMa / Design District | `2:-1` | **`2:-1`** | South-east of Civic `1:0`, south of Market corridor |
| Golden Gate Park | `-5:1` | **`-5:0`** | Park is the east–west band between Richmond (north) and Sunset (south). `-5:1` is the better Richmond key |
| Richmond | `-4:2` | **`-5:1`** | North of GGP, east of ocean, west of Presidio Heights; adjacent to existing `-4:1` |
| Inner Sunset | `-4:-2` | **`-4:-2`** | South of park, west of Mission, east of Outer Sunset band |
| Twin Peaks | `-2:-2` | **`-2:-2`** | Hill ridge east of Inner Sunset / west of Mission |

**Corrections made:** Marina `-1:4` → `0:5`; Golden Gate Park `-5:1` → `-5:0`; Richmond takes `-5:1` (replacing the suggested `-4:2` park-edge proxy). Suggested `-4:2` is reserved as a future Laurel Heights / Presidio south-edge fill if needed; it is **not** required for this wave.

### Final planned sector keys

```text
3:3   Chinatown
2:3   Nob Hill
1:4   Russian Hill
0:5   Marina
3:0   Embarcadero / Transamerica-adjacent downtown
2:-1  SoMa / Design District
-5:0  Golden Gate Park
-5:1  Richmond
-4:-2 Inner Sunset
-2:-2 Twin Peaks
```

All ten keys have sector centers inside `SF_FOOTPRINT` (validated via the same point-in-polygon logic as `isValid`).

---

## 3. Footprint validity and proxy notes

### Sanity check (this document)

- Sector size: `384`
- Validation: center `(sx*384, sz*384)` must pass `pointInPolygon` against `SF_FOOTPRINT` in `src/streaming.js`
- Result: all accepted planned keys **VALID**; existing authored keys **VALID**

### Must remain proxies (outside this authored ring)

| Real place | Why proxy | Nearest authored/planned cue |
| --- | --- | --- |
| Golden Gate Bridge | North of Marina/Presidio; full span not in ring | Distant silhouette from `0:5`, `-4:1` |
| Fisherman's Wharf / Pier 39 | Farther NE bay edge than Marina sector center | North silhouette / pier cards from `0:5` and `4:4` |
| Crissy Field / Fort Point | Presidio bay shore beyond `-4:1` | Presidio park edge |
| Ocean Beach (true continuous strand) | Already stylized at `-5:-4`; rest is procedural | Outer Sunset + Richmond west edge |
| Twin Peaks summit road full length | Only one sector budgeted | Landmark ridge massing in `-2:-2` |
| Haight-Ashbury core | Authored at `-3:-1` | Victorian strip + Market approach cues |

Global shoreline distance at most planned sector centers is still >260 m from the coarse city polygon, so **do not rely on auto waterfront** for Marina / Embarcadero character. Author local waterfront descriptors where a bay or ocean edge is a district signature (same pattern as `4:-4` and `-5:-4`).

---

## 4. Shared road-authoring defaults

Match existing expansion style unless a district table overrides:

| Property | Default |
| --- | --- |
| `roadLines` count | Wave B/C + Embarcadero: 9 (~48 m blocks); Wave A / SoMa / Mission Bay: 7 (~64 m). Traffic graph samples ≤7 arterials from denser visual grids |
| Default road width | `12` (grid) |
| Diagonal avenue width | `13`–`16` |
| Sidewalk (runtime) | ~`3.8` |
| Intersection character | Orthogonal 4-way signals; diagonal gets pedestrian junctions |
| Detail building budget | **≤ 36** detailed buildings per authored sector |
| If real density would exceed 36 | Prefer continuous facade runs / party-wall rows, push mid-block fill to proxies, keep 1–3 landmarks detailed |

`roadLines` are used for **both** N–S and E–W strips in the current overlay builder. When a district has unequal spacing, document the primary grid in `roadLines` and note any special cross-street subset in the table notes (road-network agent can still emit both axes).

---

## 5. Existing anchors (brief, for adjacency)

Use these only as connectivity and style neighbors; do not re-author them from this doc.

| Key | Signature | Road notes | Grade | Waterfront |
| --- | --- | --- | --- | --- |
| `1:0` | Market + civic masonry | Lines `[-192,-132,-68,0,64,132,192]`; Market diagonal | ~0 | no |
| `4:0` | Tower/podium skyline | Battery-like dense grid | ~0 | distant bay east (proxy) |
| `4:4` | Columbus + Coit | Columbus diagonal; grade ~0.075 | hill | no local |
| `0:4` | California Street villas | grade **0.11** | steep | no |
| `-4:1` | Presidio gate / park edge | open fill | 0.045 | no local |
| `-3:-2` | Mission + Dolores | Mission diagonal; grade 0.038 | mild | no |
| `4:-4` | Channel frontage | east edge waterfront normal +X | 0.006 | **yes** x=176 |
| `-5:-4` | Ocean edge | west edge waterfront normal −X | 0.012 | **yes** x=-176 |

---

## 6. Planned sectors (full tables)

Local coordinates are meters relative to sector center. World = center + local.

---

### 6.1 Chinatown — `3:3`

| Field | Value |
| --- | --- |
| World center | (1152, 1152) |
| Real bounds (approx) | Roughly Bush/California (S), Broadway (N), Kearny (E), Powell (W); core commercial on Grant & Stockton |
| Bounding streets (stylized) | Powell · Stockton · Grant · Kearny (N–S); California · Clay · Broadway (E–W) |
| Neighbors | W → `2:3` Nob Hill; E/N toward `4:4` North Beach; S toward `3:0` / `4:0` downtown stack |
| `roadName` | Grant Avenue Chinatown spine |
| `roadLines` | `[-192, -128, -64, -8, 56, 120, 192]` |
| Named N–S lines (local x) | −192 Powell · −128 Stockton · −64 Grant · −8 Kearny · 56 Montgomery spur · 120 Sansome spur · 192 sector edge |
| Named E–W lines (local z) | −192 California · −128 Clay · −64 Washington · −8 Jackson · 56 Pacific · 120 Broadway · 192 sector edge |
| Diagonal | **No** (real alleys are dense orthogrid; avoid fake Columbus here) |
| Road widths | Stockton/Grant `11`–`12`; Kearny `13`; side streets `10` |
| Intersections | Tight 4-ways, short sightlines, frequent midblock pedestrian conflict; signals every line |
| Block density | **Very high** fill ≥0.88; deep lots, narrow frontages |
| Footprint archetypes | `rowhouse`, dense `masonry`, occasional `podium` retail; avoid glass towers |
| Hills / grade | Rising toward Nob Hill west/south; game **grade ≈ 0.055** (local +Z still slightly uphill north toward Broadway ridge) |
| Waterfront | none |
| Landmarks | Dragon Gate / southern gate massing at local **(−64, −170)** — *ceremonial paifang framing Grant entry*; Portsmouth Square plaza void at **(−20, −40)** — *open relief in dense fabric* |
| Visual notes | 1) Deep red/green storefront rhythm under continuous canopies. 2) Lanterns / hanging sign density higher than any other district. 3) Party-wall continuity; almost no front setbacks. |
| Gameplay signature | Dense foot traffic + short blocks + vertical retail signs; best night-readable district. |
| Building budget note | Prefer fewer wider multi-bay rows over 36 separate micro-lots. |

---

### 6.2 Nob Hill — `2:3`

| Field | Value |
| --- | --- |
| World center | (768, 1152) |
| Real bounds (approx) | California / Sacramento ridge; roughly Van Ness (W) to Powell (E), Bush/Geary (S) to Pacific/Broadway (N) |
| Bounding streets | Van Ness · Jones · Taylor · Mason · Powell; California · Sacramento · Clay · Washington |
| Neighbors | E → `3:3` Chinatown; N/W toward `1:4` / `0:4`; S toward downtown spine |
| `roadName` | California Street cable ridge |
| `roadLines` | `[-192, -136, -72, -8, 60, 128, 192]` |
| Named N–S (local x) | −192 Van Ness · −136 Hyde · −72 Leavenworth · −8 Taylor · 60 Mason · 128 Powell · 192 edge |
| Named E–W (local z) | −192 Bush · −136 Pine · −72 California · −8 Sacramento · 60 Clay · 128 Washington · 192 edge |
| Diagonal | Optional light **California cable alignment**: start `[-192, -90]` end `[192, -50]`, width `12`, name `California Street` (keep shallower than Pac Heights diagonal if both exist) |
| Road widths | California `14`; Van Ness `16`; hill streets `11`–`12` |
| Intersections | Wide formal crossings on California; steep approaches; cable-car/streetcar cue on California |
| Block density | High formal masonry; fill ~0.78 with larger institutional footprints |
| Footprint archetypes | `masonry`, `villa`/grand hotel masses, `setback` clubs; stone bases |
| Hills / grade | Among steepest playable hills; game **grade ≈ 0.10** (just under Pac Heights 0.11 so Pac Heights remains the peak formal ridge) |
| Waterfront | none |
| Landmarks | Grace Cathedral / Huntington park band at **(−40, −20)** — *long limestone nave + green square*; Fairmont / Mark Hopkins hotel pair at **(80, −10)** — *tall mansard crowns on the ridge* |
| Visual notes | 1) Cream limestone and dark mansards. 2) Cable slots / twin tracks on California. 3) Broader sidewalks and formal stairs. |
| Gameplay signature | Crest views toward bay + cable climb set piece. |

---

### 6.3 Russian Hill — `1:4`

| Field | Value |
| --- | --- |
| World center | (384, 1536) |
| Real bounds (approx) | Between Van Ness and North Beach, north of Nob Hill; Lombard/Chestnut corridor, Hyde/Leavenworth grid |
| Bounding streets | Van Ness · Hyde · Leavenworth · Taylor; Broadway · Vallejo · Green · Union · Filbert · Greenwich · Lombard |
| Neighbors | W → `0:4` Pacific Heights; E toward `4:4`; S → `2:3` / `3:3` stack |
| `roadName` | Hyde Street hill grid |
| `roadLines` | `[-192, -132, -68, -4, 64, 128, 192]` |
| Named N–S (local x) | −192 Van Ness · −132 Polk · −68 Hyde · −4 Leavenworth · 64 Taylor · 128 Jones · 192 edge |
| Named E–W (local z) | −192 Broadway · −128 Vallejo · −64 Green · 0 Union · 64 Filbert · 128 Greenwich · 192 Lombard |
| Diagonal | **No** full diagonal; optional **crooked Lombard** as short special segment local start `[40, 168]` end `[120, 192]`, width `9`, name `Lombard Street` (prop path, not main traffic spine) |
| Road widths | Hyde `12`; Lombard tourist segment `9`; others `11` |
| Intersections | Steep switchback feel; stop-controlled minor streets; signals on Hyde/Lombard/Van Ness |
| Block density | High rowhouse walls; fill ~0.84; pocket stairs and midblock parks |
| Footprint archetypes | `rowhouse`, `stucco`, bay-window runs; rare `villa` corners |
| Hills / grade | Real Lombard/Hyde grades often 20–27%; game **grade ≈ 0.095** with stronger local z rise north of center |
| Waterfront | none (bay views are skybox / far water) |
| Landmarks | Crooked Lombard switchback band at **(80, 176)** — *one-way hairpin garden street*; Ina Coolbrith / stair park void at **(−20, 40)** — *green notch in the hill fabric* |
| Visual notes | 1) Pastel stucco + white trim. 2) Stair streets as pedestrian shortcuts. 3) Cable on Hyde. |
| Gameplay signature | Iconic hill-driving challenge and postcard overlook. |
| Bridge/Wharf context | Clear **north bay** view cone; GGB silhouette possible on clear days from high ground looking NW. |

---

### 6.4 Marina — `0:5`

| Field | Value |
| --- | --- |
| World center | (0, 1920) |
| Real bounds (approx) | North of Pacific Heights / Cow Hollow; roughly Lyon (W) to Van Ness (E), Lombard (S) to Marina Green / yacht harbor (N) |
| Bounding streets | Lyon · Broderick · Fillmore · Steiner · Pierce · Webster · Buchanan · Laguna · Octavia · Van Ness; Chestnut · Lombard · Bay · Marina Blvd |
| Neighbors | S → `0:4` Pacific Heights (primary connector); E toward Russian Hill; W toward Presidio |
| `roadName` | Chestnut Street Marina grid |
| `roadLines` | `[-192, -128, -64, 0, 64, 128, 192]` |
| Named N–S (local x) | −192 Lyon · −128 Broderick · −64 Fillmore · 0 Steiner · 64 Webster · 128 Laguna · 192 Van Ness |
| Named E–W (local z) | −192 Lombard · −128 Chestnut · −64 Greenwich · 0 Filbert · 64 Bay · 128 Marina Blvd · 192 Green edge |
| Diagonal | **No** |
| Road widths | Lombard `15` (US-101 feel); Chestnut `12`; Marina Blvd `14`; others `11` |
| Intersections | Flat, wide, high visibility; signals on Lombard/Chestnut/Fillmore |
| Block density | Medium-high 2–4 story; fill ~0.72; Marina Green open north band |
| Footprint archetypes | `stucco`, `modern-white`, low `rowhouse`; almost no towers |
| Hills / grade | Near-flat reclaimed land; game **grade ≈ 0.008** |
| Waterfront | **Yes — north bay edge** (authored local, same contract as Mission Bay) |
| | `start: { x: -192, z: 176 }`, `end: { x: 192, z: 176 }`, `outwardNormal: { x: 0, z: 1 }`, `distance: 176`, `source: 'marina-green-bay-frontage'` |
| Landmarks | Palace of Fine Arts dome/rotunda at **(−150, 20)** — *beige colonnade + lagoon*; Marina Green lawn strip **(0, 150)** — *open wind-exposed green before seawall* |
| Visual notes | 1) White/cream Mediterranean stucco. 2) Yacht masts and flat horizon. 3) Palm / wide sidewalk commercial on Chestnut. |
| Gameplay signature | Flat coastal cruise after hill districts; fog-prone open north. |
| GGB / Wharf | **Golden Gate Bridge** readable NW (proxy span, not sector geometry). **Fisherman's Wharf** readable NE as distant pier cards toward `4:4` / beyond `0:5`. |

---

### 6.5 Embarcadero / Transamerica-adjacent downtown — `3:0`

| Field | Value |
| --- | --- |
| World center | (1152, 0) |
| Real bounds (approx) | Western Financial / Jackson Square / Transamerica Redwood Park band; roughly Kearny to Battery/Front, California to Broadway/Washington, with Embarcadero presence as eastern sky/bay cue |
| Bounding streets | Kearny · Montgomery · Sansome · Battery · Front; Market (S edge influence) · California · Sacramento · Clay · Washington · Jackson · Pacific |
| Neighbors | E → `4:0` Financial District; W toward `1:0` / `2:0` fill; N toward Chinatown `3:3` |
| `roadName` | Montgomery Street tower grid |
| `roadLines` | `[-192, -124, -52, 16, 80, 140, 192]` |
| Named N–S (local x) | −192 Kearny · −124 Montgomery · −52 Sansome · 16 Battery · 80 Front · 140 Embarcadero service · 192 edge |
| Named E–W (local z) | −192 Market influence · −124 California · −52 Sacramento · 16 Clay · 80 Washington · 140 Jackson · 192 Pacific |
| Diagonal | Optional light **Market remnant** only if linking S edge: start `[-192, -192]` end `[64, -120]`, width `15`, name `Market Street` (prefer connector roads over a full sector diagonal if graph gets noisy) |
| Road widths | Montgomery/California `14`; Battery `13`; service alleys `10` |
| Intersections | Formal downtown signals every other line; deep shadow canyons |
| Block density | Very high; fill ~0.85; large tower plates + podium retail |
| Footprint archetypes | `tower`, `tapered`, `setback` podium; redwood park void |
| Hills / grade | Near flat; game **grade ≈ 0.01** |
| Waterfront | Soft east bay cue if needed: local `start {x:176,z:-192}` `end {x:176,z:192}` normal `{x:1,z:0}` **only if** Embarcadero seawall is authored here; otherwise inherit distant shoreline from footprint and leave hard waterfront to FiDi/Mission Bay |
| Landmarks | Transamerica Pyramid at **(40, 90)** — *unique tapered pyramid tower, district identity*; Redwood Park pocket at **(20, 70)** — *dark green floor among towers*; Ferry Building distant east prop if waterfront authored **(170, -20)** — *clock tower pier shed* |
| Visual notes | 1) Cool glass/steel vs limestone base contrast. 2) Pyramid silhouette must read from Civic and Chinatown. 3) Ground-level arcades / plaza cuts. |
| Gameplay signature | Skyline set piece and downtown traffic density peak. |

---

### 6.6 SoMa / Design District — `2:-1`

| Field | Value |
| --- | --- |
| World center | (768, -384) |
| Real bounds (approx) | South of Market, design/showroom band: roughly 8th–2nd concepts mapped into local grid; Townsend / Bryant / Brannan / Folsom / Howard fabric |
| Bounding streets | 8th · 7th · 6th · 5th · 4th · 3rd (stylized N–S numbering); Market (N influence) · Mission · Howard · Folsom · Harrison · Bryant · Brannan · Townsend |
| Neighbors | N/W toward `1:0` Civic/SoMa; E toward waterfront/Mission Bay stack; **needs connector roads** through `2:0` or `1:-1` procedural fill to join the authored graph |
| `roadName` | Townsend–Brannan warehouse grid |
| `roadLines` | `[-192, -140, -80, -16, 48, 112, 192]` |
| Named N–S (local x) | −192 8th · −140 7th · −80 6th · −16 5th · 48 4th · 112 3rd · 192 2nd edge |
| Named E–W (local z) | −192 Townsend · −128 Brannan · −64 Bryant · 0 Harrison · 64 Folsom · 128 Howard · 192 Mission/Market rim |
| Diagonal | Prefer **no** strong diagonal if `1:0` already owns Market; if needed: start `[-192, 160]` end `[192, 40]`, width `15`, name `Market Street` |
| Road widths | Townsend/Bryant `14`; numbered streets `13`; alleys `9` |
| Intersections | Long blocks, fewer signals, wide truck turning radii; T-junctions at freeway-ish rims |
| Block density | Medium-large plates; fill ~0.70 with parking voids / yards |
| Footprint archetypes | `warehouse`, `brick-industrial`, mid `podium`, occasional `tower` near east edge |
| Hills / grade | Mild southward drain; game **grade ≈ 0.012** |
| Waterfront | none local (Mission Bay owns channel) |
| Landmarks | SFMOMA / Yerba Buena scale massing cue at **(40, 120)** if north half reads cultural — *large white/grey museum box*; Design District showroom strip **(0, -40)** — *low brick + glass storefronts*; freeway overpass prop band **(−120, −160)** — *horizontal concrete slab landmark* |
| Visual notes | 1) Brick + black metal + supergraphics. 2) Wider streets, fewer trees than Mission. 3) Loading docks and blank side walls. |
| Gameplay signature | Industrial scale change after tight NE hills; good truck/traffic variety. |
| Connectivity risk | **Highest.** Road-network agent must author spine connectors from `1:0` and toward `4:-4` / `4:0` before relying on this sector alone. |

---

### 6.7 Golden Gate Park — `-5:0`

| Field | Value |
| --- | --- |
| World center | (-1920, 0) |
| Real bounds (approx) | East–west park band: roughly Fulton (N) to Lincoln (S), Stanyan (E) to chain of lakes / ocean approach (W) |
| Bounding streets | Fulton (N edge road) · JFK Drive (internal) · Middle Drive · MLK / South Drive · Lincoln (S edge); 19th Ave crosses; Stanyan on east |
| Neighbors | N → `-5:1` Richmond; S → Inner Sunset / Outer Sunset stack; E toward `-4:1` Presidio Heights approach |
| `roadName` | JFK Drive park loop |
| `roadLines` | `[-192, -120, -48, 24, 96, 160, 192]` (sparser; not a full urban wall) |
| Named N–S (local x) | −192 25th Ave · −120 19th Ave · −48 14th Ave · 24 10th Ave · 96 6th Ave · 160 Stanyan · 192 edge |
| Named E–W (local z) | −192 Lincoln · −96 South Drive · 0 JFK Drive · 96 Fulton · 192 edge |
| Diagonal | **No** city diagonal; optional curved path prop only (do not put curved paths into `roadLines`) |
| Road widths | 19th Ave `16`; JFK `12`; park drives `10`; edge arterials `13` |
| Intersections | Roundabouts / 3-ways more than downtown grid; signals mainly on 19th/Fulton/Lincoln |
| Block density | **Very low** urban fill; fillRatio target **0.20–0.30**; meadows and tree masses dominate |
| Footprint archetypes | `park`, sparse `masonry` museums, `box` service buildings |
| Hills / grade | Rolling; game **grade ≈ 0.02** with meadow noise from terrain function |
| Waterfront | none (ocean is west/south via Outer Sunset) |
| Landmarks | Music Concourse / museum band at **(80, 20)** — *paired large cultural masses + open bowl*; Conservatory-scale glasshouse cue at **(140, 60)** — *white Victorian greenhouse*; Windmill / west end cue at **(−160, -20)** — *vertical park marker toward ocean* |
| Visual notes | 1) Continuous tree canopy > building mass. 2) Ochre paths and meadow greens, not grey sidewalk city. 3) Fog corridors east–west. |
| Gameplay signature | Navigation through park drives; contrast silence after urban sectors. |
| Budget note | Detailed buildings may be museum/service only; trees/paths are the density. Stay under 36 solid masses easily. |

---

### 6.8 Richmond — `-5:1`

| Field | Value |
| --- | --- |
| World center | (-1920, 384) |
| Real bounds (approx) | North of Golden Gate Park to the Presidio south edge / Clement commercial; ocean influence on west |
| Bounding streets | Park Presidio / 14th–25th Ave grid; Geary · Clement · California · Fulton; Arguello east influence |
| Neighbors | S → `-5:0` GGP; E → `-4:1` Presidio Heights; W ocean proxy |
| `roadName` | Clement Street Richmond grid |
| `roadLines` | `[-192, -144, -88, -24, 40, 112, 192]` |
| Named N–S (local x) | −192 28th/ocean approach · −144 25th · −88 20th · −24 15th · 40 10th · 112 6th · 192 Arguello |
| Named E–W (local z) | −192 Fulton · −128 Clement · −64 Geary · 0 Anza · 64 Balboa · 128 Cabrillo · 192 California rim |
| Diagonal | **No** |
| Road widths | Geary `15`; Clement `12`; avenues `11` |
| Intersections | Regular 4-ways; neighborhood signals on Geary/Clement |
| Block density | High low-rise; fill ~0.84; continuous avenue walls |
| Footprint archetypes | `stucco`, `rowhouse`, small `masonry` mixed-use |
| Hills / grade | Gentle rise toward Presidio; game **grade ≈ 0.03** |
| Waterfront | Optional **west ocean fringe** if sector is used as outer Richmond: `start {-176,-192}` `end {-176,192}` normal `{-1,0}` — only if Outer Sunset’s ocean story needs a northern twin; otherwise keep ocean exclusive to `-5:-4` |
| Landmarks | Clement commercial strip centerline **(0, -128)** — *continuous restaurant awnings*; Richmond plaza void **(40, -100)** — *one open lot break*; Presidio wall/gate hint on NE **(160, 160)** — *tree wall + low stone* |
| Visual notes | 1) Fog-grey stucco and avenue lights. 2) Dense Asian/Russian storefront mix on Clement. 3) Flatter than Pac Heights, tighter than Sunset. |
| Gameplay signature | Everyday neighborhood grid + park south edge. |

---

### 6.9 Inner Sunset — `-4:-2`

| Field | Value |
| --- | --- |
| World center | (-1536, -768) |
| Real bounds (approx) | South of Golden Gate Park, east of Outer Sunset; Irving / Judah / Noriega commercial; 9th–19th Avenues |
| Bounding streets | Lincoln (N) · Irving · Judah · Kirkham · Lawton · Moraga · Noriega; 7th–19th Avenues |
| Neighbors | N toward park `-5:0` / `-4:1`; W toward Outer Sunset `-5:-4`; E → `-3:-2` Mission |
| `roadName` | Irving Street Sunset grid |
| `roadLines` | `[-192, -144, -88, -28, 40, 108, 192]` |
| Named N–S (local x) | −192 19th · −144 16th · −88 12th · −28 9th · 40 7th · 108 5th · 192 edge |
| Named E–W (local z) | −192 Noriega · −128 Moraga · −64 Lawton · 0 Kirkham · 64 Judah · 128 Irving · 192 Lincoln |
| Diagonal | **No** |
| Road widths | 19th `15`; Irving/Judah `12`; others `11` |
| Intersections | Regular grid; N-Judah transit feel on Judah |
| Block density | High low-rise; fill ~0.82; backyard midblock voids |
| Footprint archetypes | `stucco`, `rowhouse`, corner commercial `box` |
| Hills / grade | Rises toward Twin Peaks east; game **grade ≈ 0.04** |
| Waterfront | none |
| Landmarks | Inner Sunset village node at Irving × 9th **(−28, 128)** — *low commercial main street*; UCSF / hospital massing east-north cue **(150, 160)** — *long mid-rise bar buildings*; stair-street toward Moraga **(80, -40)** — *pedestrian climb prop* |
| Visual notes | 1) Soft pastel stucco with garage ground floors. 2) Transit wires / island stops on Judah. 3) Greener than Outer Sunset, denser commerce than Richmond avenues. |
| Gameplay signature | Transit neighborhood between park and hills. |

---

### 6.10 Twin Peaks — `-2:-2`

| Field | Value |
| --- | --- |
| World center | (-768, -768) |
| Real bounds (approx) | Twin Peaks / Clarendon / Midtown Terrace ridge; between Inner Sunset and Mission / Castro approaches |
| Bounding streets | Twin Peaks Blvd (ridge), Portola, Clarendon, Market approach from east, 7th Ave approach from west |
| Neighbors | W → `-4:-2` Inner Sunset; E → `-3:-2` Mission; N toward park/Castro fill |
| `roadName` | Twin Peaks ridge road |
| `roadLines` | `[-192, -120, -40, 24, 96, 160, 192]` (fewer urban streets; more open) |
| Named N–S (local x) | −192 7th Ave approach · −120 Clarendon · −40 Twin Peaks Blvd W · 24 Crest · 96 Twin Peaks Blvd E · 160 Market approach · 192 edge |
| Named E–W (local z) | −192 Portola · −96 Crestline · 0 Overlook terrace · 96 Midtown · 192 north saddle |
| Diagonal | **Yes — ridge drive:** start `[-160, -180]` end `[160, 160]`, width `11`, name `Twin Peaks Boulevard` |
| Road widths | Ridge road `11`; Portola `14`; local `10` |
| Intersections | Sparse; overlook pullouts; few full signals |
| Block density | Low; fill **0.35–0.45**; large open slopes |
| Footprint archetypes | sparse `stucco` homes, `park`/rock outcrop masses; **no towers** |
| Hills / grade | Highest authored hill after Pac Heights; game **grade ≈ 0.12** (allowed to slightly exceed Pac Heights 0.11 for summit read) with strong local Z and diagonal climb |
| Waterfront | none |
| Landmarks | Christmas Tree Point overlook at **(40, 40)** — *360° city viewpoint pad*; Sutro Tower silhouette proxy at **(−80, -20)** — *red-white truss tower, west sky*; dual peak berms **(−30, 10)** & **(50, -10)** — *two green summits* |
| Visual notes | 1) Open grass and scrub, not street trees in grids. 2) Windswept sky exposure. 3) City carpet views to FiDi and Mission. |
| Gameplay signature | Summit reveal / photo stop; hardest climb. |
| Budget note | Prefer terrain + 8–16 structures; do not fill 36 buildings. |

---

## 7. Bridge, Wharf, and long-range context

| Feature | Real position relative to map | Authored handling |
| --- | --- | --- |
| Golden Gate Bridge | NW of Marina / N of Presidio | **Proxy only.** Readable from `0:5` and `-4:1` as distant span + towers; do not invent a full bridge sector in this wave |
| Fisherman's Wharf / Pier 39 | NE bay, north of North Beach | **Proxy cards / pier silhouettes** off `0:5` and `4:4`; not a full authored key |
| Alcatraz | N bay | Horizon prop from Marina / North Beach |
| Bay Bridge | E of FiDi / Mission Bay | Distant eastern span from `4:0` / `4:-4` |

---

## 8. Road-network agent: sector dependencies

### Authored adjacency graph (face neighbors among existing + planned)

```text
Marina 0:5
   |
Pac Hts 0:4 ---- Russian Hill 1:4
                    |
Nob Hill 2:3 ---- Chinatown 3:3 ---- (toward North Beach 4:4)
                    |
         Embarcadero/TAP 3:0 ---- FiDi 4:0
                    |
Civic 1:0 ---- (needs 2:0 fill) ---- SoMa Design 2:-1
                                      |
Presidio -4:1 ---- Richmond -5:1
                      |
                 GGP -5:0
                      |
Outer Sunset -5:-4   Inner Sunset -4:-2 ---- Twin Peaks -2:-2 ---- Mission -3:-2
                                                      |
                                                 Mission Bay 4:-4 (far E)
```

### Required connectors (priority)

1. **`0:4` ↔ `0:5`** — Pac Heights to Marina (primary north expansion).
2. **`0:4` ↔ `1:4`** and **`1:4` ↔ `2:3` / `3:3`** — hill chain continuity.
3. **`2:3` ↔ `3:3`** and north links toward **`4:4`** (even if via procedural `3:4`/`4:3`).
4. **`3:0` ↔ `4:0`** and **`3:0` ↔ `1:0`** (via `2:0` spine) — downtown continuity.
5. **`2:-1` ↔ `1:0`** (via `1:-1` or `2:0`) — SoMa must not be an island.
6. **`-5:1` ↔ `-4:1`** and **`-5:1` ↔ `-5:0`** — Richmond/Presidio/park ring.
7. **`-5:0` ↔ `-4:-2`** and **`-4:-2` ↔ `-3:-2` / `-2:-2`** — west park to Mission/Twin Peaks.
8. Keep **Mission Bay `4:-4`** and **Outer Sunset `-5:-4`** on existing waterfront graph; do not break their edge normals.

### Diagonal inventory (planned + existing)

| Sector | Diagonal | Purpose |
| --- | --- | --- |
| `1:0` (existing) | Market | Civic spine |
| `4:4` (existing) | Columbus | North Beach cut |
| `0:4` (existing) | California | Hill route |
| `-3:-2` (existing) | Mission | Mission corridor |
| `2:3` (planned) | California (light) | Cable ridge continuity |
| `2:-1` (planned) | Market optional | Only if graph needs it |
| `-2:-2` (planned) | Twin Peaks Blvd | Ridge drive |
| others | none | Preserve orthogrid identity |

### Grade quick list (game coefficients)

| Key | District | grade |
| --- | --- | --- |
| `3:3` | Chinatown | 0.055 |
| `2:3` | Nob Hill | 0.10 |
| `1:4` | Russian Hill | 0.095 |
| `0:5` | Marina | 0.008 |
| `3:0` | Embarcadero / TAP | 0.01 |
| `2:-1` | SoMa Design | 0.012 |
| `-5:0` | Golden Gate Park | 0.02 |
| `-5:1` | Richmond | 0.03 |
| `-4:-2` | Inner Sunset | 0.04 |
| `-2:-2` | Twin Peaks | 0.12 |

### Waterfront quick list (planned)

| Key | Local edge | Normal | Notes |
| --- | --- | --- | --- |
| `0:5` | z = 176, x ∈ [-192,192] | (0, +1) | Marina Green bay |
| `3:0` | optional x = 176 | (+1, 0) | only if Embarcadero authored here |
| `-5:1` | optional x = -176 | (−1, 0) | only if outer-Richmond ocean twin desired |
| existing `4:-4` / `-5:-4` | keep | keep | do not move |

---

## 9. Implementation checklist for district agents

For each planned key, implement against existing contracts:

1. `EXPANSION_SECTORS` entry: `key`, `district`, `tone`, `roadName`, `roadLines`, optional `diagonal`, `heightRange`, `styles`, `palette`, `accent`, `landmark`, `treeCadence`, `signalEvery`, optional `grade`.
2. `AUTHORED_DISTRICT_BY_SECTOR` + massing profile overrides in `district_massing.js`.
3. `AUTHORED_WATERFRONT_BY_SECTOR` only for Marina (required) and optional Embarcadero/Richmond ocean.
4. Overlay landmarks under 36 detail buildings; interiors ≥2 archetypes per sector (verify script expectation).
5. Road network merged graph remains **one connected component** with core connectors.
6. Wave order: Goal 03 dense NE (`3:3`,`2:3`,`1:4`,`0:5`,`3:0`,`2:-1`) then Goal 04 west/parks (`-5:0`,`-5:1`,`-4:-2`,`-2:-2`).

---

## 10. Sources actually used

Public sources consulted for this reference (geography only; no proprietary 3D):

| Source | Use |
| --- | --- |
| **OpenStreetMap / Overpass API** (ODbL) | Landmark nodes/ways: Dragon Gate, Transamerica Pyramid, Coit Tower, Grace Cathedral, Palace of Fine Arts, Lombard Street, Sutro Tower, Ferry Building transit positions |
| **DataSF Analysis Neighborhoods** (`p5b7-5n3h`) | District naming / neighborhood aggregation concept (portal metadata + pipeline notes) |
| **DataSF pipeline notes in repo** (`Docs/CITY_DATA_PIPELINE.md`) | Approved street centerlines, shoreline, building footprints, SFMTA signals policy |
| **USGS 3DEP / National Map** (via project source policy) | Elevation grade family (relative steepness: Nob/Russian/Twin Peaks vs Marina flat fill) |
| **NOAA shoreline / Digital Coast** (via project source policy) | Bay vs ocean edge orientation for Marina / Outer Sunset / Mission Bay |
| **SFMTA public system maps** (via project source policy) | Arterial roles: Geary, 19th Ave, Lombard, Market, Judah N-line corridor |
| **Existing game code** | Authoritative sector centers, roadLine schema, waterfront schema, grades, footprint `isValid` |

Wikipedia / Wikidata tags on OSM objects were used only as **secondary labels**, not as geometry sources.

Cross-check rule applied: every planned sector is constrained by (1) real relative adjacency and (2) at least one of OSM landmark position or DataSF/pipeline district semantics, then snapped to the game's stylized grid.

---

## 11. Acceptance summary

| Item | Result |
| --- | --- |
| Planned sector keys | `3:3`, `2:3`, `1:4`, `0:5`, `3:0`, `2:-1`, `-5:0`, `-5:1`, `-4:-2`, `-2:-2` |
| Suggested-set corrections | Marina `-1:4`→`0:5`; GGP `-5:1`→`-5:0`; Richmond assigned `-5:1`; Laurel Heights uses `-4:2`; Haight `-3:-1` |
| Footprint validity | All accepted keys VALID under `SF_FOOTPRINT` / `isValid` |
| Schema compatibility | Tables map 1:1 to `EXPANSION_SECTORS` fields + waterfront/grade overlays |
| Proxies called out | GGB, Fisherman's Wharf, full Ocean Beach, full Twin Peaks road |
| Performance note | ≤36 detailed buildings; park/ridge sectors intentionally sparse |

---

*End of Goal 02 geography reference.*
