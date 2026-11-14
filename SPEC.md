# Trojan — Technical Specification

Version 0.1 · 2026-11-14 · Scope: **Layers 1–3 built** (Simulation, Negotiation, Safety) plus the prosumer microgrid extension. Layer 2 and 3 build specs: `docs/NEGOTIATION.md`; microgrid: `docs/MICROGRID.md`.

Related: `PROJECT.md` (what & why), `PRD.md` (requirements), `DESIGN.md` (UI look), `docs/MODEL_BRIEF.md`
(3D component rules), `docs/NEGOTIATION.md` (Layers 2–3 build spec), `docs/MICROGRID.md` (prosumers, islands) and `agent_prompt.md` (need-based bidding rules).

---

## 1. Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│ UI (DOM)  src/ui/*        top bar · disaster tools · inspector · KPIs · log │
├────────────────────────────────────────────────────────────────────────────┤
│ 3D View   src/render/*    WorldView: city, lines, flow, disasters, picking  │
│ Models    src/models/*    procedural Three.js components (one file / kind)  │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 3 — Safety          ConstraintValidator   src/safety/* (built)        │
│ Layer 2 — Negotiation     AllocationPolicy      src/negotiation/* (built)   │
│ Server    server/*  /api/jev proxy to TypeSafe Jev (Node only)              │
│ Layer 1 — Simulation      src/sim/*  SimEngine: grid, city, power network,  │
│                           disasters, utility agents, telemetry, clock       │
├────────────────────────────────────────────────────────────────────────────┤
│ Core      src/core/*      types.ts · constants.ts · rng.ts · events.ts      │
└────────────────────────────────────────────────────────────────────────────┘
```

- **One direction of data**: `SimEngine` owns all state and emits `tick` with a `SimSnapshot`. The view and
  UI read snapshots; they never mutate simulation state. User actions call engine methods
  (`trigger`, `play`, `setSpeed`, …).
- **Pure simulation**: `src/sim/**` must not import `three` or touch the DOM. It runs in Node
  (headless runs, tests and the bench).
- **Determinism**: all randomness flows from `Rng(seed)`. Same seed + same triggered events ⇒ identical run.
- **Stack**: Vite 8, TypeScript (strict), Three.js r187, no UI framework (plain DOM + CSS custom properties).

### 1.1 File ownership

| Path | Owner | Notes |
|---|---|---|
| `src/core/*` | orchestrator | contracts — change only via orchestrator |
| `src/sim/*` | sim agent | pure TS |
| `src/render/*` (except `palette.ts`) | render agent | Three.js |
| `src/render/palette.ts`, `src/models/kit.ts`, `src/models/index.ts` | orchestrator | shared |
| `src/models/<kind>.ts`, `pylon.ts`, `props.ts` | one model agent each | |
| `src/negotiation/config.ts` | orchestrator | Layer 2 tunables; change only via orchestrator |
| `src/negotiation/*` (other files) | Layer 2 | pure TS; Jev only in `jevClient.ts` |
| `src/safety/*` | Layer 3 | pure TS; imports `src/core/**` only, never `src/negotiation/**` |
| `src/sim/microgrid.ts` | sim agent | prosumers, islands, export curtailment (`docs/MICROGRID.md`) |
| `server/*` | orchestrator | Node-only Vite `/api/jev` proxy; holds the Jev key |
| `scripts/negotiation-tests.ts`, `scripts/safety-tests.ts`, `scripts/negotiation-bench.ts` | Layer 2 / Layer 3 | run by `npm test` / `npm run bench` |
| `src/ui/*`, `src/styles/*` | UI agent | |
| `src/main.ts`, `index.html` | orchestrator | wiring |
| `src/dev/gallery.ts`, `models.html`, `scripts/shot.mjs` | orchestrator | dev tools |

---

## 2. World & units

- 1 world unit = 1 metre. Ground = X/Z plane, Y up.
- Grid: `GRID_COLS × GRID_ROWS = 48 × 48` cells, `CELL = 12 m` ⇒ city is 576 m × 576 m, centred on origin.
- Cell `(col,row)` min corner at `(col*CELL − HALF_W, row*CELL − HALF_D)`; `cellId = row*48 + col`.
- Helpers in `src/core/constants.ts`: `cellId`, `cellCol`, `cellRow`, `cellCenter`, `worldToCell`.
- Clock: 1 engine step = 1 simulated minute. Scenario length 24 h (`SCENARIO_MINUTES = 1440`). The scenario
  starts at **10:00 local** (`START_HOUR = 10`) so it sees midday solar surplus, sunset, a night on reserves and
  dawn recovery (solar falls away, lit windows make power state visible). Speed = sim minutes per real second (1, 5, 10, 30, 60).

---

## 3. Grid & city generation — `src/sim/cityGen.ts`

`generateCity(seed: number): { cells: GridCell[]; buildings: Record<string, Building> }`

### 3.1 Terrain
1. **Roads**: every column/row with `index % BLOCK === 0` (`BLOCK = 6`) is `road`. City blocks are 5×5 cells.
2. **River**: a meandering band 2 cells wide crossing the map roughly north–south (e.g. centre column
   `c(row) = 30 + 3·sin(row/7) + noise`). River cells: `river`; where a road crosses: `bridge`.
3. **Elevation**: `0` in the river, rising with distance from the river (≈ `min(1, dist/18)` plus small
   noise). Flood spread uses this.
4. **Parks**: 3–5 whole blocks become `park` (green, trees).
5. Everything else: `land`.

### 3.2 Buildings (placement order, all deterministic)
Footprints from `FOOTPRINT` (cells). Buildings occupy `land` cells inside one block, never roads/river.
Rotation: front (+Z before rotation) faces the nearest road side of the block.

| Kind | Count | Footprint | Placement rule |
|---|---|---|---|
| `generator` | 2 | 3×3 | near opposite map edges (west & east), one per side of the river; variant 0 thermal, 1 solar+battery |
| `substation` | 6 | 2×2 | spread over the city (k-means-ish / one per region), ≥ 1 on each side of the river |
| `hospital` | 3 | 3×3 | different districts; one close to the river (flood exposure) |
| `emergency` | 3 | 2×2 | spread, not adjacent to hospitals |
| `school` | 4 | 3×2 | residential districts |
| `water` | 3 | 2×2 | one by the river (intake), others on high ground |
| `telecom` | 8 | 1×1 | spread evenly (coverage) |
| `house` | fill | 1×1 | ~65% of remaining land cells in non-park blocks; variant 0–3 |

**Prosumers** (`docs/MICROGRID.md` §2): a seeded ~30% of houses get rooftop solar and a small battery (houses that already have a battery keep it); every school is a campus prosumer with larger solar and a battery. No new building kinds.

Each `Building` gets `id = "<kind>-<n>"`, a readable `name` (e.g. "Riverside General Hospital",
"Station 2 — Fire & Rescue", "Northside Pump Station", "Tower T-05", "Substation S3", "Westbank Thermal
Plant", "Oakridge School (Shelter)"), its `cells`, and `nodeId` (its power-network node).

### 3.3 Districts (for names and fair spread)
Quadrants split by the river + one north/south line: `Westbank N/S`, `Riverside`, `Eastbank N/S`.

---

## 4. Power network — `src/sim/powerNetwork.ts`

`buildNetwork(cells, buildings, rng): PowerNetwork`

### 4.1 Transmission (high voltage)
- Nodes: one `generator` node per plant, one `substation` node per substation (at the building centre).
- Edges: each generator → its 3 nearest substations; plus a **ring** connecting substations in angular
  order around the city centre (redundancy, gives the network loops so damage can be routed around).
- Each straight transmission link is split into spans with a `pylon` node every `PYLON_SPACING_CELLS = 4`
  cells. Edge `cells` = cells under the span (Bresenham). Capacity: 6 000 kW per transmission edge.

### 4.2 Distribution (feeders)
- Each consumer building is assigned to its nearest substation by **road distance**.
- Per substation, compute a BFS tree over road cells from the road cell next to the substation.
- `pole` nodes along the tree every `POLE_SPACING_CELLS = 2` cells and at every branch point, offset
  3.5 m from the road centre-line to the kerb (consistent side per road direction).
- Each consumer connects by a **service drop** edge from the nearest pole of its substation's tree to the
  building's port. Shared spans are shared edges (the feeders form a tree, not N parallel lines).
- Capacity: 1 500 kW per distribution edge (service drops: 2× consumer peak demand).
- `Feeder { substationId, consumerId, edgeIds }` lists the edge chain substation → consumer.

### 4.3 Connectivity & islands (every engine step)
1. A node is `alive` iff its cell status is `ok` or `flooded` (lines are elevated) — except
   generator/substation/consumer nodes, which are dead if any of their building cells is not `ok`.
2. An edge is `broken` if either endpoint is dead, any of its `cells` is `destroyed` or `burning`, or it
   tripped from overload (§7.4).
3. **Islands** = connected components of the live network that contain at least one supply source: a running generator, a prosumer with `offeredKW > 0`, or a charged battery. A component of consumers only stays dark. Components without a generator are `microgrid: true`. Ids are stable (sorted by smallest node id) and `snapshot.islands: IslandInfo[]` is published every step. Consumers not reached ⇒ `connected = false`.
4. **Supply** `P_total = min(P_utility_DER + P_prosumer, P_line_limit)`: `P_utility_DER` = Σ running generator output; `P_prosumer` = Σ prosumer exports **after curtailment** (for each distribution edge, Σ exports injected downstream ≤ `capacityKW × 0.97`; the excess is curtailed at the inverters, deterministically); `P_line_limit` = what the surviving transmission and feeder-root edges can deliver, plus the curtailed prosumer exports. Policy and validator receive `P_total` as the island supply (`docs/MICROGRID.md` §1, §3).

### 4.4 Rendering contract
Each node has a world `pos` (X/Z). The view places a pylon/pole model there and rotates it so its arms
are perpendicular to the mean direction of its incident edges. Conductors attach at the model's
`userData.attach` points (pylon: 3, pole: 2) and at buildings' `userData.powerPorts` /
`userData.outPorts`.

### 4.5 Water network (underground) — `src/sim/waterNetwork.ts`
`buildWaterNetwork(cells, buildings, rng): WaterNetwork` (types in `types.ts`).
- **Sources**: one `source` node per `water` building (pump station). **Mains** run under road cells:
  a BFS tree from each pump station over road cells (each road cell joins the tree of its nearest
  station; mains are separate trees per station, with `junction` nodes every 2 road cells and at
  branches). Diameter: 400 mm near the source, stepping down to 150 mm at the leaves.
- **Service lines**: every consumer building (houses, hospitals, schools, emergency, telecom excluded)
  gets a `service` pipe from the nearest junction of its station's tree to the building centre (100 mm).
  `services[buildingId] = { sourceId, pipeIds }`.
- Buried at `WATER_PIPE_DEPTH = −2.5 m`. Pipes are **not** affected by flood; a pipe is `broken` iff any
  of its cells is `destroyed` (earthquake, cyclone, fire burn-out).
- **Per tick**: a source delivers pressure `p = 4.5 bar × min(1, servedFraction / 0.35)`, where
  `servedFraction` = the pump station's (grid + backup) power / demand (pumps stall below ~35%).
  Pressure falls 0.15 bar per main span; a broken pipe cuts everything downstream. Flow per service =
  consumer water demand (houses 0.06 m³/h per occupant, hospital 18 m³/h, school-as-shelter
  0.02 × sheltered, emergency 4 m³/h) × min(1, p_local / 1.5); mains carry the sum downstream.
- **Cross-utility coupling**: every consumer's telemetry gains `waterPressureBar` and `waterSupplyPct`.
  Hospitals: `waterSupplyPct < 50` raises urgency and damage rate (sterilisation/dialysis need water);
  shelters: lowers `waterLiters`. The water building's own telemetry (`flowM3h`, `pressureBar`,
  `populationServed`) is the sum over its tree.

---

## 5. 3D models — `src/models/*`

See `docs/MODEL_BRIEF.md` for the full rules. Summary of the contract:
- `build({variant, seed}): THREE.Group`; origin = footprint centre at ground, Y up, front = +Z; fits
  within `w*CELL × d*CELL` minus 0.8 m margin. `VARIANTS` exported.
- Materials only from `MAT` (`src/render/palette.ts`). Mesh roles: `userData.role = 'glow'` (lit when
  powered), `'beacon'` (blinks), `userData.spin = {axis, speed}` (rotating group).
- Ports: `userData.powerPorts: Vector3[]` (incoming), `userData.outPorts: Vector3[]` (substation /
  generator outgoing).
- `pylon.ts`: `buildPylon()`, `buildPole(withTransformer?)`, both with `userData.attach: Vector3[]`.
- `props.ts`: `buildTree(v)`, `buildStreetLight()`, `buildCar(v)`.

---

## 6. Utility agents & telemetry — `src/sim/agents.ts`, `src/sim/telemetry.ts`

Every consumer building (all kinds except `substation`, `generator`) is represented by an autonomous
**utility agent** with a `UtilityAgentState` (see `types.ts`). In Layer 1 the agent only *senses and
reports*; Layer 2 will make it *bid and negotiate*.

### 6.1 Static profile per kind

| Kind | Base demand kW | minSafe (fraction of demand) | criticality | Backup | Damage/h if unserved (units) |
|---|---|---|---|---|---|
| hospital | 1 800 ± 300 | 0.45 | 1.00 | diesel 6–10 h at 600 kW | 100 |
| emergency | 280 ± 60 | 0.50 | 0.90 | diesel 8 h at 120 kW | 60 |
| water | 750 ± 150 | 0.35 | 0.85 | none (variant 1: diesel 3 h) | 70 |
| telecom | 22 ± 6 | 0.60 | 0.80 | battery 4 h at 15 kW | 40 |
| school (shelter) | 160 ± 40 | 0.25 | 0.55 → 0.8 when sheltering | none | 15 + 0.05 × sheltered |
| house | 4.5 ± 2 | 0.10 | 0.25 (0.7 if `medicalDevice`) | 15% have a battery 10 kWh | 1 (8 if medicalDevice) |

Demand follows a diurnal curve (evening peak 18–22 h for houses; flat for hospitals), multiplied by a
**crisis load factor** derived from telemetry (e.g. hospital demand grows with patients).

### 6.2 Live telemetry keys (`telemetry: Record<string, number>`)

| Kind | Keys (unit) | Dynamics |
|---|---|---|
| hospital | `patients`, `icuPatients`, `icuBeds`, `incomingPerHour`, `inflowGrowthPctPerHour`, `ventilatorsInUse`, `surgeriesActive`, `distanceToImpactM`, `backupFuelHours`, `oxygenHours` | inflow ∝ casualties in destroyed cells within 1.5 km, decays with distance; growth % = d(inflow)/dt; patients integrate inflow − discharges; ventilators ∝ ICU |
| emergency | `activeIncidents`, `unitsDeployed`, `unitsAvailable`, `callsPerHour`, `avgResponseMin`, `distanceToImpactM` | incidents spawn per newly destroyed/burning cell; response time rises with incidents and with destroyed road cells |
| water | `flowM3h`, `reservoirPct`, `pressureBar`, `pumpsRunning`, `populationServed`, `contaminationRisk` | reservoir drains when unpowered, refills when powered above demand; pressure ∝ pumps; contamination rises when flooded nearby |
| telecom | `activeConnections`, `loadPct`, `emergencyCallsPerMin`, `batteryPct`, `coverageKm2`, `backhaulOk` | call surge after each disaster event; battery drains on backup |
| school | `sheltered`, `capacity`, `inflowPerHour`, `medicalCases`, `waterLiters` | evacuees from destroyed/flooded house cells walk to the nearest live school |
| house | `occupants`, `medicalDevice` (0/1), `batteryPct`, `emergencyRequestsPerHour`, `evacuated` (0/1) | evacuated when its cell or a neighbour is hit |

All consumers also expose `distanceToImpactM` (distance to the nearest non-`ok` cell).

### 6.3 Derived bid fields (computed by the agent every step)
- `urgency` ∈ [0,1]: kind-specific, e.g. hospital = max(icuPatients/icuBeds, 1 − backupFuelHours/8,
  inflowGrowth); telecom = max(loadPct, 1 − batteryPct); water = 1 − reservoirPct; etc.
- `expectedDamagePerHour` = base damage × (0.5 + urgency) × population factor.
- `tokens`: initialised to 100 for every agent (Layer 2 currency; Layer 1 never spends them).

### 6.4 Backup power
When `allocatedKW < demandKW` an agent draws `min(backup.maxKW, deficit)` from backup while
`remainingKWh > 0`. Building status: `online` (≥ 99% served), `brownout` (≥ minSafe but < demand),
`backup` (grid share < minSafe but backup covers it), `offline`, `destroyed`.

### 6.5 Storage, prosumers and dependencies (`docs/MICROGRID.md` §4–§5)

- `storage` (utility buffers): water `reservoir` (SoC = `reservoirPct`), telecom `battery` (SoC = `batteryPct`), hospital and emergency `diesel`. `chargeKW` is the sheddable part of `demandKW` (refill or charger draw); if not granted the buffer simply does not charge, with no damage.
- `der` (prosumers: rooftop houses and campus schools): `solarKW`, `batteryPct`, `selfSupplyKW`, `offeredKW`, `exportedKW`, `curtailedKW`. The building's grid request is `max(0, demand − selfSupplyKW)`.
- `dependents` / `dependentDamagePerHour` = Σ w·D_j, where D_j is the dependent's `expectedDamagePerHour`: water feeds hospitals (w 0.5) and shelters (w 0.3) on its water tree; telecom covers emergency stations (w 0.4) and hospitals (w 0.1) within 350 m.
- Telemetry keys added: `chargeKW` and `bufferPct` (buffer utilities), `dependentDamagePerHour` (utilities with dependents), and for prosumers `solarKW`, `batteryPct`, `exportKW`, `curtailedKW`.

---

## 7. Engine — `src/sim/engine.ts`

```ts
export class SimEngine extends Emitter<EngineEvents> {
  constructor(opts?: { seed?: number; policy?: AllocationPolicy; validator?: ConstraintValidator });
  readonly snapshot: SimSnapshot;
  update(realDtSec: number): void;   // advance realDt*speed minutes (whole steps), emit 'tick' if advanced
  play(): void; pause(): void; setSpeed(minPerSec: number): void;
  step(): void;                      // exactly one minute (used when paused, "step" button)
  reset(seed?: number): void;        // regenerate city & network, emit 'reset'
  trigger(kind: DisasterKind, params: DisasterParams): DisasterEvent;  // starts now
  loadScenario(id: string): void;    // reset + schedule scripted events
  setPolicy(p: AllocationPolicy): void; setValidator(v: ConstraintValidator): void;
  timeOfDay(): number;               // hours 0..24 (START_HOUR + tMin/60)
}
```

### 7.1 Step order (per simulated minute, as in `engine.ts` `pipeline`)
0. Scheduled scenario events fire at their minute.
1. Advance disasters (spread/move/recede) → update `cells[].status`.
2. Apply damage: buildings on non-`ok` cells → `destroyed`; generators there → `destroyed`.
3. Generators: output = capacity × availability × (solar: daylight curve × cloud factor (cyclone ⇒ ×0.2)); thermal ± 3% noise; fuel decreases; `tripped` by `grid_fault` or overload.
3b. Prosumer DER: solar, battery state, `p_min` self-supply and the offer (`docs/MICROGRID.md` §2).
4. Connectivity / islands (§4.3); components with a prosumer offer or a charged battery count as sourced.
5. Agents: telemetry (§6.2), demand, minSafe, urgency, damage rate, dependents and buffer storage (§6.5).
5b. Island supply: per-island prosumer plans, per-edge export curtailment, `P_total` (§4.3).
6. Allocation per island: consumers' net grid requests → `policy.allocate(supply, requests, snapshot)` → `validator.validate(...)` → `allocatedKW`.
7. Backup draw & building status (§6.4); underground water (§4.5).
8. Edge flows: each feeder carries its consumer's allocation; per edge `flow = |Σ downstream allocation − Σ downstream export|` (net, bidirectional; direction kept for rendering). Transmission edges carry each substation's total across its live incoming links.
9. Overload cascade (§7.4) on advancing steps. 10. Metrics; history sample every 5 sim minutes; log entries.

### 7.2 Baseline policy (Layer 1 placeholder) — `src/sim/policy.ts`
`BaselinePolicy` ("critical-first proportional"): (a) sort requests by criticality desc; grant each
`min(minSafeKW, demandKW)` while supply lasts; (b) split the remainder proportional to unmet demand.
`BaselineValidator`: clamps negative grants to 0, any grant to ≤ demand, and scales down so Σ ≤ supply;
returns violation strings for anything it fixed. Layers 2/3 replace both.

### 7.3 Disasters — `src/sim/disasters.ts`
Every disaster is a `DisasterEvent` updated each minute; it writes cell statuses.

| Kind | Params | Behaviour |
|---|---|---|
| `earthquake` | col,row, intensity (0..1), radius (cells, default 8) | t=0: each cell within radius is `destroyed` with p = intensity·(1 − d/r)^0.7 (roads/river excluded from building logic but roads can be destroyed → cuts lines & slows response). 1–3 aftershocks within 90 min at 40% intensity near the epicentre. Permanent. |
| `flood` | intensity, durationMin (default 360) | water level L(t) rises to `0.15 + 0.45·intensity` over first 40%, holds, recedes over last 30%. A cell is `flooded` iff elevation < L **and** 4-connected to the river through cells below L. Recedes → `ok` again (buildings recover after 30 min dry). |
| `cyclone` | col,row (entry), heading, speed (cells/h, default 6), radius (default 5), intensity, durationMin | eye moves along heading; cells within radius·0.6 of the eye get `destroyed` with p = 0.08·intensity per minute; solar output ×0.2 citywide while active. |
| `fire` | col,row, intensity | ignition cell `burning`; each minute each burning cell ignites 4-neighbours with p = 0.03·intensity (×2 park, ×0 road/river/bridge); a cell burns 60–120 min then becomes `destroyed`. |
| `grid_fault` | targetId (generator), durationMin | trips the generator (`tripped`) for the duration; logs a crit entry. |

### 7.4 Overload cascade
If an edge's `flowKW > capacityKW` for 3 consecutive minutes it trips (`broken`, logged). With the
baseline policy this models real cascading failure; Layer 3 is expected to prevent it.

### 7.5 Scenarios — `src/sim/scenarios.ts`
`SCENARIOS: { id; name; description; seed; events: { atMin; kind; params }[] }[]`
All scenarios use seed 1337 and run 24 h from 10:00 (t = 0). Times below are clock times (t = minutes since 10:00).
1. `quiet-night` — **Quiet day**: no disasters; midday solar surplus, evening peak, quiet night (baseline).
2. `monsoon-cyclone` — **Monsoon cyclone**: cyclone from the south-east at 13:00 (t = 180, 240 min; rooftop and farm solar ×0.2) sweeps across the east bank; flood from 16:00 (t = 360, 360 min) into the evening and night.
3. `earthquake` — **Earthquake & fires**: M6.8-like quake beside the river at 12:30 (t = 150, intensity 0.85, radius 9 cells); fire at 12:45 (t = 165) near the epicentre; the day ends on batteries.
4. `compound` — **Compound crisis**: generator-0 trips at 14:00 (t = 240) for 3 h; quake on the west bank at 16:30 (t = 390, intensity 0.9); flood at 19:00 (t = 540, 360 min). The city ends up on reserves overnight.


### 7.6 Metrics
See `Metrics` in `types.ts`. `cumulativeDamage += Σ expectedDamagePerHour × (1 − servedFraction) / 60`
each minute (servedFraction counts backup). History samples every 5 sim minutes, `HISTORY_LEN` cap.

---

## 8. 3D view — `src/render/*`

```ts
export class WorldView extends Emitter<{ select: string | null; cellPick: { col: number; row: number }; hover: string | null }> {
  constructor(container: HTMLElement);
  build(s: SimSnapshot): void;          // (re)build the static city — on start and on 'reset'
  sync(s: SimSnapshot): void;           // cheap per-tick update
  setPickMode(m: 'select' | 'cell'): void;
  setLayer(name: 'grid' | 'power' | 'water' | 'flow' | 'labels' | 'status', on: boolean): void;
  focus(buildingId: string): void;      // smooth camera move
  select(buildingId: string | null): void;
  dispose(): void;
}
```

### 8.1 Scene
- Cream background `#fbf6e6`, light fog. `HemisphereLight` + one `DirectionalLight` sun with a 4096
  shadow map covering the city (bias tuned so walls show no acne). Sun angle and light colour follow
  `timeOfDay`: warm low sun at 16–18 h, blue-dark ambient at night (glow parts dominate).
- `MapControls` (pan with left/right-drag, zoom to cursor), polar angle limited to 20°–75°, distance
  60–900 m. Default view: 45° azimuth, ~50° elevation, whole city in frame.
- Optional bloom (`UnrealBloomPass`, threshold high so only glow/beacons bloom); disable automatically if
  the frame time exceeds 25 ms.

### 8.2 Ground
- One merged mesh with vertex colours per cell: lots `#e6dcc0`, roads asphalt with dashed centre lines
  and kerbs, parks green, river `MAT.water` slightly below ground with banks, bridges concrete.
- Trees (props) scattered in parks and along some lots; streetlights along roads; a few cars parked on
  roads. All via `InstancedMesh`.
- **Grid overlay** (layer `grid`): thin ink lines on every cell border (0.25 opacity), stronger every
  block; toggleable.
- **Status overlay** (layer `status`): per-cell tiles — `destroyed` coral with diagonal hatch, `flooded`
  translucent water plane at the flood level, `burning` orange flicker. One InstancedMesh per status.

### 8.3 Buildings — batching
- Build each building via `MODELS[kind].build({variant, seed})`, place/rotate it on its footprint.
- **Static merge**: all non-glow, non-beacon, non-spin meshes of all buildings are merged per material
  into one `Mesh` per material, with a per-vertex `color` attribute (materials cloned with
  `vertexColors: true`). Record each building's vertex range per merged mesh ⇒
  `setBuildingTint(id, color)` (destroyed ⇒ charred grey `#55524a`).
- **Glow**: all glow meshes merged into one mesh with vertex colours; per-building range ⇒ glow colour:
  powered `#ffe24a`, backup `#ff8a00` (flickering slightly), brownout dim yellow, offline `#1d2a3a`.
- Spin and beacon parts stay as separate objects (they're few); spin only when the building has power.
- **Outlines**: ink edges (`EdgesGeometry`, threshold 30°) merged into one `LineSegments` per batch.
- **Destroyed** buildings additionally get rubble (instanced small boxes) and a smoke plume (sprites).

### 8.4 Power lines
- Supports: pylons and poles from `buildPylon/buildPole`, baked and rendered as `InstancedMesh` per
  material, oriented per §4.4.
- Conductors: catenary curves between attach points (sag 4% of span for transmission, 3% distribution),
  sampled at 12 points, all in one `LineSegments2` (fat lines, 2 px transmission / 1.4 px distribution).
  Colours: ok = ink, broken = coral (and dropped to the ground), overloaded (flow > 90% capacity) = orange.
- **Flow** (layer `flow`): instanced glowing pulses travel along live edges from source to sink; spacing
  constant, speed ∝ flowKW / capacity (0 when no flow). Yellow on distribution, blue on transmission.

### 8.4b Transmission layers & animations
Two independently toggled layers (`setLayer('power' | 'water', on)`):
- **`power` (ON by default)**: supports, conductors and flow pulses (§8.4). Turning it off hides all
  three. Pulse animation: bright yellow (distribution) / white-blue (transmission) elongated capsules
  that travel along each catenary from source to sink; speed ∝ flowKW/capacity, spacing ~6 m; a broken
  span shows a coral spark burst at the break point and no pulses downstream. Overloaded spans pulse
  orange and faster.
- **`water` (OFF by default) — x-ray view**: the ground fades to ~35% opacity (buildings stay solid,
  their lower 0.3 m keeps a contact ring so they don't look like they float), and the buried network
  appears at `WATER_PIPE_DEPTH`: mains as blue tubes (radius ∝ diameter, 0.2–0.45 m), service lines thin,
  joints as small collars at junctions, a vertical riser from each source up to its pump station.
  Animation: water pulses (light-cyan droplets/dashes) flow along each pipe downstream, speed ∝ flow,
  density ∝ pressure; pipes with no pressure turn dark grey and stop; broken pipes show a leak: a
  blue fountain/puddle particle burst at the break cell on the surface. Turning water on dims the power
  layer to 40% opacity (not hidden) so both can be read together.
- Smooth transitions: layer fades take 400 ms (instant under reduced motion).

### 8.5 Disaster FX
- Earthquake: expanding ring at the epicentre + 0.6 s camera shake.
- Cyclone: a rotating spiral of translucent discs/particles at the eye, moving with it; rain streaks.
- Fire: flickering flame cones + rising particles on `burning` cells.
- Flood: per-cell water tiles rising/falling with the flood level, subtle wave.
- All FX are pooled and cleared on reset.

### 8.6 Picking & labels
- Raycast against an invisible hit-box per building (InstancedMesh). Hover ⇒ footprint highlight ring
  and emits `hover`; click ⇒ `select`. In `cell` mode, click on ground emits `cellPick` (used to place a
  disaster), hover shows a radius preview disc.
- Labels (layer `labels`): `CSS2DRenderer` pills above hospitals, emergency, water, schools, substations
  and generators: `<div class="map-label" data-status="online|brownout|backup|offline|destroyed">`
  with name + status dot. Houses/telecom get no labels (only on hover).

### 8.7 Performance budget
≥ 50 fps at 1440p on a mid laptop GPU with the whole city in view; < 400 draw calls; city build < 1.5 s.

---

## 9. UI — `src/ui/*` (see DESIGN.md for the look)

Layout (desktop): full-bleed 3D canvas; floating panels on top of it.
- **Top bar** (pill): wordmark "Trojan", scenario select, clock `10:00 → Day 1, 15:34`, play/pause,
  step, speed segmented control (1×/5×/10×/30×/60×), reset.
- **Left rail — Disasters**: one card per kind with a short description; click "Place" ⇒ cell pick mode
  (cursor preview), then click on the map; intensity + radius sliders; active disasters listed with
  progress bars. Layer toggles (grid, power flow, labels, status).
- **Right panel — Inspector** (when a building is selected): name, kind chip, status pill; power bar
  (allocated vs demand with the minSafe marker); bid fields (criticality, urgency, expected
  damage/h, tokens); live telemetry table with a sparkline per key (last 60 samples kept in the UI);
  backup gauge; feeder path (substation name, number of spans, broken spans).
- **Bottom strip**: KPI cards (Supply MW, Demand MW, Served %, Critical unserved kW, Damage) + a
  supply/demand/allocated chart (canvas) + event log (newest first, colour-coded).
- **Agents roster** (tab in the right panel when nothing is selected): all non-house agents sorted by
  urgency with mini power bars; click to select/focus.
- Keyboard: Space play/pause, `.` step, 1–5 speeds, G grid, F flow, L labels, Esc deselect/cancel.
- Mobile (< 960 px): panels become bottom sheets; the 3D view stays interactive.

---

## 10. Layer 2 — Negotiation, bidding & prioritisation (built)

Built. Full build spec: `docs/NEGOTIATION.md` (normative together with `agent_prompt.md`, which overrides earlier token-bidding wording). Code: `src/negotiation/*`; tunables: `src/negotiation/config.ts`. Implements `AllocationPolicy.allocate()`.

- **Agents**: one `UtilityAgent` per hospital, water, emergency, telecom and school (21 negotiators); one `ClusterAgent` per household cluster (same feeder substation and 6×6 city block; medical-device homes are a protected sub-bid). Only affected utilities negotiate actively; others cooperate or stay idle.
- **Perception**: System-1 perception via TypeSafe Jev (`@typesafe-ai/sdk`, Node only) returns urgency, damage, imminent-failure risk, concession willingness and strategy. It is cached, blended into the bid at a capped weight, and falls back to a deterministic heuristic; without a provider, headless runs are deterministic.
- **Need-based auction** (`clearing.ts`): phase 1 grants every protected minimum-safe floor, with tokens excluded (triage by need when supply is short); phase 2 water-fills the remainder weighted by need and marginal damage. Raw requested kW is not a priority term.
- **Two rounds per minute** (one if there is no deficit): propose, provisional clear, shortfall notice, concessions, final clear. Concessions are harm-aware: an agent sheds only load whose loss is covered (charging, own backup, own battery); `requestKW` never drops below `minSafeKW`.
- **Pre-charge and coast** (`docs/MICROGRID.md` §6): buffers bid for charging on midday prosumer surplus and coast on reserves near sunset.
- **Tokens and forward contracts**: 100-token endowment with caps, decay and replenishment; tokens are escrowed and charged only when an agent wins phase-2 power; verified concessions earn tokens; contracts (`nowKW`, later repayment, stakes) are honoured, defaulted or cancelled.
- **Explanations**: every allocation carries a plain-language reason and per-minute dossier (Utility dossier and Negotiation tab in the UI).

---

## 11. Layer 3 — Safety (built)

Built. Build spec: `docs/NEGOTIATION.md` §6 and `docs/MICROGRID.md` §7. Code: `src/safety/*`, which imports only `src/core/**` and never negotiation code. Implements `ConstraintValidator.validate()`; it runs after every allocation and can veto or correct it.

- **Sanitize**: non-finite, negative or over-demand values are fixed; unknown, destroyed or disconnected agents get 0.
- **Capacity on net flow**: feeder edges are checked against `capacityKW × 0.97` on net flow (allocation minus prosumer export); substation transformer limits are enforced. Corrections shed the portion above minSafe first, then the least harm per kW.
- **Supply**: Σ allocation ≤ the island's `P_total` (§4.3).
- **Min-safe guarantee**: critical agents (criticality ≥ 0.8) are topped up toward minSafe where physically possible; otherwise a `triage` audit entry records the reason.
- **Fairness**: an agent below minSafe for more than K = 30 consecutive minutes is corrected while others on its island are above theirs.
- **Invariants and fallback**: finite values, within demand, supply and capacity. A failed proposal falls back to the last committed allocation, then to a minSafe-first proportional allocation; `violationsCommitted` must stay 0.
- **Audit**: every correction, triage and fallback is logged with rule, severity and reason; the UI shows the feed.

---

## 12. Testing & verification
- `npm run typecheck` clean. Sim modules runnable in Node (`npx tsx`) for a smoke run of each scenario
  (no NaN, Σ allocation ≤ supply every step, deterministic per seed).
- `npm run typecheck` (strict, both tsconfigs). `npm test` runs the sim smoke run (`scripts/sim-smoke.ts`), negotiation tests (`scripts/negotiation-tests.ts`) and safety tests (`scripts/safety-tests.ts`) under `tsx`. `npm run bench` runs the headless negotiation benchmark (`scripts/negotiation-bench.ts`).
- Visual: `scripts/shot.mjs` screenshots of `models.html` and `index.html` (desktop 1440×900, phone
  390×844) reviewed after every major change.
