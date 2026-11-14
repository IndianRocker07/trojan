# Trojan — Product Requirements Document

Version 0.1 · 2026-11-14 · Owner: Trojan team · Status: Phase 1 in build; Phases 2–4 specified for planning.

Related: `PROJECT.md` (vision, concepts, glossary), `SPEC.md` (technical source of truth; this PRD cites
its sections and does not restate its tables), `DESIGN.md` (UI and scene look).

Conventions: "MUST/SHOULD/MAY" per RFC 2119. Story ids `US-1.x` (Phase 1), `US-2.x`, `US-3.x`. Functional
requirement ids `FR-1.x` (simulation), `FR-2.x` (negotiation), `FR-3.x` (safety). Phase 1 is the only phase
being built now; Phases 2–3 are future and must not be started before Phase 1 exit.

---

## 1. Overview

**Product**: a decentralised, simulated crisis-management system in which an autonomous agent per city utility
negotiates a scarce, fluctuating power supply during a multi-hour disaster, while a safety layer guarantees
hard limits. **Problem and motivation**: `PROJECT.md` §2.

| Phase | Scope | Status |
|---|---|---|
| 1 | Simulation layer: 3D city, power network, grid-block disasters, live telemetry, KPIs, scenarios | **Building now** |
| 2 | Negotiation, bidding and prioritisation layer (virtual tokens) | Future |
| 3 | Safety layer (hard constraints, physics, guarantees, audit) | Future |
| 4 | Evaluation and benchmarks against baselines | Future |

## 2. Goals and non-goals

### 2.1 Phase 1 — Simulation

| Goals | Non-goals |
|---|---|
| G1.1 A believable 3D city on a 48×48 grid with all eight building types (house, mobile tower, substation, generator, hospital, emergency ward, school, water supply) | No negotiation, bidding or token spending (agents only sense and report) |
| G1.2 A physical power network (generation, transmission, distribution, service drops) with capacities, islands and overload cascades | No safety guarantees beyond the baseline validator's clamping |
| G1.3 Five disasters computed as affected grid blocks; every utility on an affected block is fully off | No real-world GIS, real grid data or electrical load-flow (no AC power flow, voltage or frequency) |
| G1.4 Live, per-utility telemetry inspectable in the UI | No user accounts, backend, persistence or multiplayer |
| G1.5 Deterministic, headless-capable engine so later layers and batch evaluation plug in unchanged | No mobile-first redesign (mobile must work and remain interactive, but desktop is primary) |
| G1.6 KPIs that make harm and supply/demand visible in real time | No other utilities (gas, transport) and no non-power resources |

### 2.2 Phase 2 — Negotiation (future)

| Goals | Non-goals |
|---|---|
| G2.1 Each utility agent bids from its own telemetry | No real money; no external market |
| G2.2 Dynamic priority score and virtual-token mechanism, not a static rule table | No training infrastructure for learning agents (the design must not preclude it) |
| G2.3 Concessions, counter-offers and forward contracts | No guarantee enforcement (that is Phase 3) |
| G2.4 Outperform the baseline on total damage | No cross-island power transfer by agents (islands are physical) |
| G2.5 Negotiation observable (rounds, offers, token flows) in the UI | |

### 2.3 Phase 3 — Safety (future)

| Goals | Non-goals |
|---|---|
| G3.1 Zero constraint violations: capacity, physics, consistency | No formal proof (property-based and invariant testing instead) |
| G3.2 Critical services receive minSafe whenever physically possible; otherwise an explicit, logged triage | No change to negotiation strategy; the validator constrains, it does not bid |
| G3.3 Bounded fairness | No hardware-in-the-loop |
| G3.4 Atomic, auditable commits | |

### 2.4 Phase 4 — Evaluation (future)
Goals: headless batch runs, baselines (proportional, static priority, baseline critical-first), reproducible
report of PRD §9 metrics. Non-goals: publishing a benchmark suite beyond the four scenarios plus seeded
variants.

## 3. Personas

| Persona | Needs | Primary phase | Success looks like |
|---|---|---|---|
| **Judge / evaluator** | Understand the system and its value in minutes; see a vivid, correct demo; verify claims (constraint violations = 0, damage reduced) | All | Runs a scenario, triggers a disaster, inspects a hospital, reads KPIs, and can compare policies without reading code |
| **Grid operator** | A realistic picture of what fails and why; confidence that critical services are protected; auditability | 1 (picture), 3 (guarantees) | Sees which blocks, lines and islands are down, what each agent is receiving versus its minSafe, and why a decision was made |
| **Researcher / developer** | Deterministic, scriptable, headless engine with swappable policy and validator; clean interfaces; metrics | 1, 2, 3, 4 | Runs `SimEngine` in Node with a seed, plugs in a new `AllocationPolicy`, gets reproducible metrics |

## 4. Phase 1 user stories and acceptance criteria

Each criterion is testable by inspection of the running app or by a headless smoke run. Technical behaviour
is defined in the cited SPEC section.

### US-1.1 City view
*As a judge, I want to see a navigable 3D city so I can grasp the scale and layout immediately.* (SPEC §3, §8.1–8.2)
- AC1 On load the full city (576 m × 576 m) is in frame at 45° azimuth, about 50° elevation.
- AC2 Pan (left/right-drag), zoom to cursor and orbit work; polar angle is limited 20°–75°, distance 60–900 m.
- AC3 Roads, a river with bridges, parks and trees, streetlights and parked cars are visible; flat toon style with ink outlines per DESIGN.md §5.
- AC4 Lighting follows time of day: warm low sun at 16:00–18:00, dark blue ambient at night, with lit windows visible.
- AC5 City generation completes in under 1.5 s.

### US-1.2 Grid blocks
*As an operator, I want the city divided into visible grid blocks so I can reason about which area a disaster affects.* (SPEC §2, §3.1, §8.2)
- AC1 A 48×48 grid overlay can be toggled (layer `grid`, key G); block boundaries (every 6th line) are emphasised.
- AC2 Hovering a cell in cell-pick mode shows a radius preview; clicking reports its `(col,row)`.
- AC3 Cell status is shown by overlay: `destroyed` coral hatch, `flooded` translucent water, `burning` orange flicker.
- AC4 Every building on a non-`ok` cell is rendered as off (destroyed buildings charred, with rubble and smoke).

### US-1.3 Every utility type
*As a judge, I want each utility type to look distinct and be identifiable so I know what each does.* (SPEC §3.2, §5, §6)
- AC1 All eight kinds are present in the stated counts (2 generators, 6 substations, 3 hospitals, 3 emergency wards, 4 schools, 3 water systems, 8 mobile towers, houses fill).
- AC2 Each kind has a distinct silhouette and palette colour consistent with DESIGN.md (blue water/transmission, lilac telecom, pink schools).
- AC3 Windows and glow parts reflect status: powered yellow, backup orange (slight flicker), brownout dim yellow, offline dark.
- AC4 Hospitals, emergency wards, water systems, schools, substations and generators carry map labels (layer `labels`, key L) with name and a status dot; houses and towers show a label on hover only.
- AC5 Each kind is individually viewable in `models.html` for review.

### US-1.4 Power lines and flow
*As an operator, I want to see how power travels and where it is strained.* (SPEC §4, §8.4)
- AC1 Generators connect to the 3 nearest substations plus a substation ring; pylons every 4 cells; poles along roads every 2 cells; service drops reach every consumer.
- AC2 Conductors hang as catenaries; colour: ok ink, overloaded (> 90% capacity) orange, broken coral and dropped to the ground.
- AC3 With the `flow` layer on (key F), pulses travel source-to-sink, faster with higher flow/capacity, stationary at zero flow; blue on transmission, yellow on distribution.
- AC4 When a generator, substation, pole or consumer is lost, downstream consumers show offline and the lines are marked broken within the same tick.
- AC5 When lines break, separated parts form islands whose supply is the sum of their running generators; consumers with no source show `connected = false`.
- AC6 An edge exceeding capacity for 3 consecutive minutes trips and is logged.

### US-1.5 Disasters
*As a judge, I want to trigger disasters and watch consequences unfold.* (SPEC §7.3, §8.5, §9)
- AC1 The left rail lists earthquake, flood, cyclone, fire and grid fault, each with description. "Place" enters cell-pick mode; the next map click places the event; Esc cancels.
- AC2 Intensity and radius sliders apply before placing; the cursor shows a radius preview.
- AC3 Earthquake: epicentre ring and 0.6 s camera shake (none with reduced motion); cells destroyed with probability falling with distance; 1–3 aftershocks within 90 min; permanent.
- AC4 Flood: water rises over the first 40% of duration, holds, and recedes over the last 30%; only cells below the level and connected to the river flood; buildings recover 30 minutes after drying.
- AC5 Cyclone: a moving spiral with rain streaks follows its heading; cells near the eye are destroyed probabilistically; solar output is ×0.2 citywide while active.
- AC6 Fire: flames spread to neighbouring cells (twice as fast through parks, never over roads/river), burn 60–120 minutes, then destroy.
- AC7 Grid fault: the chosen generator trips for the set duration; supply visibly drops; a critical log entry appears.
- AC8 Active disasters are listed with progress bars. Disasters can be stacked.
- AC9 Triggered disasters are recorded so a run can be replayed (see US-1.12).

### US-1.6 Telemetry inspector
*As an operator, I want to click any building and see its agent's live state.* (SPEC §6, §9)
- AC1 Click selects (hover highlights the footprint); the right panel shows name, kind chip, status pill.
- AC2 A power bar shows allocated versus demand, a tick at minSafe and a hatched backup portion.
- AC3 Bid fields shown: criticality, urgency, expected damage per hour, tokens (100 initially, unchanged in Phase 1).
- AC4 A telemetry table lists every key for that kind (SPEC §6.2) with unit, value and a sparkline of the last 60 samples.
- AC5 A backup gauge (remaining hours or %) and the feeder path (substation, span count, broken spans) are shown.
- AC6 Telemetry responds plausibly to events: e.g. hospital `incomingPerHour` rises after a nearby earthquake, water `reservoirPct` falls when unpowered, telecom `batteryPct` falls on backup.
- AC7 With nothing selected, the roster lists all non-house agents sorted by urgency with mini power bars; clicking an entry selects and focuses the camera.

### US-1.7 KPIs and charts
*As a judge, I want live headline numbers.* (SPEC §7.6, §9)
- AC1 KPI cards: Supply MW, Demand MW, Served %, Critical unserved kW, Damage — tweened numerals.
- AC2 Chart of supply (ink), demand (dashed blue) and allocated (green area) over the sample history (every 5 sim minutes).
- AC3 `cumulativeDamage` follows the SPEC §7.6 formula; with no disasters it stays at or near zero.

### US-1.8 Timeline and speed controls
*As any user, I want to control time.* (SPEC §2, §7, §9)
- AC1 The clock shows time of day and day (starts 16:00; 12 h scenario); play/pause (Space), step one minute (`.`), reset.
- AC2 Speeds 1×, 5×, 10×, 30×, 60× (keys 1–5) mean sim minutes per real second.
- AC3 Changing speed or pausing never skips or double-applies a minute (whole steps only).
- AC4 At the scenario end the run stops and a summary of KPIs is shown.

### US-1.9 Event log
- AC1 Newest-first, colour-coded entries for disaster starts, destroyed buildings, line trips, island formation, backup exhaustion and generator trips.
- AC2 Clicking an entry with a building or cell focuses it.

### US-1.10 Scenarios
*As a judge, I want one-click scripted situations.* (SPEC §7.5)
- AC1 A scenario selector offers `quiet-night`, `monsoon-cyclone`, `earthquake`, `compound`, each with a description.
- AC2 Loading resets the city (scenario seed) and schedules its events at the stated times.
- AC3 `quiet-night` runs 12 h with no destroyed cells and Served % ≈ 100% with the baseline policy.

### US-1.11 Layers and view toggles
- AC1 Toggle grid, power flow, labels, status overlay from the left rail and via keys G, F, L; state shown on the control.

### US-1.12 Determinism
*As a researcher, I want identical runs from identical inputs.* (SPEC §1, §12)
- AC1 Same seed and same triggered events at the same minutes produce identical snapshots (Σ allocation, metrics, building statuses) at every step.
- AC2 No NaN in any snapshot field; Σ allocation ≤ island supply every step; checked by a Node smoke script for each scenario.
- AC3 The simulation modules import neither `three` nor the DOM.

### US-1.13 Accessibility and responsiveness
- AC1 Body text contrast ≥ 7:1 where specified in DESIGN.md §3; status never conveyed by colour alone (status pills carry text; legend labels).
- AC2 Full keyboard operation of top bar, rail and inspector; visible focus ring; shortcuts shown as key chips.
- AC3 `prefers-reduced-motion` disables camera shake, tweening, pops and animates FX statically.
- AC4 Below 960 px width panels become bottom sheets and the 3D view remains interactive.

## 5. Phase 2 and 3 user stories (story level)

### Phase 2 — Negotiation (future)

| Id | Story | Acceptance (summary) |
|---|---|---|
| US-2.1 | As a hospital agent, I want to submit a bid from my own telemetry so my real need is visible to the market. | Bid conforms to the FR-2.1 schema and changes when telemetry changes (e.g. patient surge raises urgency and request). |
| US-2.2 | As a researcher, I want priority to be computed dynamically so outcomes are not a fixed ranking. | Same agents rank differently in different crisis states; weights are adaptive and logged. |
| US-2.3 | As an agent, I want to offer a concession and be rewarded so that I can later receive priority. | A conceded kW·h earns tokens by FR-2.4; ledger conserves tokens. |
| US-2.4 | As an agent, I want a forward contract so I can trade power now for power later. | Contract created, honoured or defaulted per FR-2.6; visible in UI. |
| US-2.5 | As an operator, I want to watch a negotiation unfold so I can trust it. | UI shows rounds, offers, counter-offers and the final allocation for any island and minute. |
| US-2.6 | As a judge, I want to compare negotiation to the baseline. | One switch swaps policy; KPIs reported for both. |
| US-2.7 | As a household cluster, I want my medical-device homes protected relative to other homes. | Medical-device load receives its minSafe before non-medical discretionary load. |

### Phase 3 — Safety (future)

| Id | Story | Acceptance (summary) |
|---|---|---|
| US-3.1 | As an operator, I want no allocation to exceed supply or line capacity. | Zero violations across fuzzed runs of every scenario and seed set. |
| US-3.2 | As an operator, I want critical services to receive minSafe whenever possible. | If infeasible, a triage decision with reason is logged. |
| US-3.3 | As an operator, I want no inconsistent state. | Allocations commit atomically; invariants checked each step; failure rolls back to last valid allocation. |
| US-3.4 | As an operator, I want fairness protected. | No agent is starved beyond K minutes while others exceed minSafe. |
| US-3.5 | As an auditor, I want every veto and correction explained. | Audit log lists rule, offending allocation, correction and timestamp; UI displays it. |
| US-3.6 | As a researcher, I want to attack the validator. | A fuzzer/adversarial policy that proposes illegal allocations never gets one committed. |

## 6. Functional requirements

### 6.1 FR-1.x Simulation (Phase 1, in build)

| Id | Requirement | Ref |
|---|---|---|
| FR-1.1 | World: 48×48 grid, 12 m cells, centred on origin; `cellId = row*48+col`; helpers for conversion. | SPEC §2 |
| FR-1.2 | Clock: 1 step = 1 simulated minute; 12 h scenario from 16:00; speed 1/5/10/30/60 sim-min per real second. | SPEC §2, §7 |
| FR-1.3 | City generation from a seed: roads every 6th line, meandering river with bridges, elevation, 3–5 park blocks. | SPEC §3.1 |
| FR-1.4 | Building placement with the stated counts, footprints and rules; each building has id, readable name, cells, network node. | SPEC §3.2 |
| FR-1.5 | District naming (Westbank N/S, Riverside, Eastbank N/S). | SPEC §3.3 |
| FR-1.6 | Transmission network: generator-to-3-nearest-substation links, substation ring, pylons every 4 cells, 6 000 kW per edge. | SPEC §4.1 |
| FR-1.7 | Distribution network: road-BFS feeder trees per substation, poles every 2 cells and at branches, kerb-side offset, service drops, 1 500 kW per edge (drops 2× peak demand), `Feeder` records. | SPEC §4.2 |
| FR-1.8 | Connectivity each step: node/edge liveness rules, island discovery by BFS from running generators, island supply. | SPEC §4.3 |
| FR-1.9 | Generators: output from capacity, availability, solar daylight and cloud curves; thermal noise; fuel; trip by fault/overload. | SPEC §7.1 step 3 |
| FR-1.10 | Disasters: earthquake, flood, cyclone, fire, grid fault with the stated parameters and behaviours; each writes cell status; buildings on non-`ok` cells are destroyed (or off while flooded). | SPEC §7.3 |
| FR-1.11 | Utility agents with static profiles per kind, diurnal demand curve and crisis load factor. | SPEC §6.1 |
| FR-1.12 | Live telemetry per kind and `distanceToImpactM` for all consumers, with the stated dynamics. | SPEC §6.2 |
| FR-1.13 | Derived bid fields (`urgency`, `expectedDamagePerHour`) each step; tokens initialised to 100 and unspent. | SPEC §6.3 |
| FR-1.14 | Backup draw and building status (`online`, `brownout`, `backup`, `offline`, `destroyed`). | SPEC §6.4 |
| FR-1.15 | Per-island allocation via `AllocationPolicy` then `ConstraintValidator`; baseline critical-first proportional policy and clamping validator shipped. | SPEC §7.1, §7.2 |
| FR-1.16 | Edge flows from feeders; overload counter and trip after 3 consecutive minutes over capacity. | SPEC §7.1, §7.4 |
| FR-1.17 | Metrics, 5-minute history samples capped at `HISTORY_LEN`, log entries. | SPEC §7.6 |
| FR-1.18 | Scenarios: the four defined in SPEC §7.5; `loadScenario` resets and schedules events. | SPEC §7.5 |
| FR-1.19 | Engine API (`update`, `play`, `pause`, `setSpeed`, `step`, `reset`, `trigger`, `loadScenario`, `setPolicy`, `setValidator`, `timeOfDay`) and one-way data flow via `tick` snapshots. | SPEC §7, §1 |
| FR-1.20 | Determinism and purity: all randomness from `Rng(seed)`; `src/sim/**` free of `three`/DOM. | SPEC §1 |
| FR-1.21 | 3D view: `WorldView` API, scene, ground, batched buildings, power lines with flow pulses, disaster FX, picking, labels. | SPEC §8 |
| FR-1.22 | UI: top bar, disaster rail with layer toggles, inspector, agent roster, KPI strip, chart, event log, keyboard shortcuts, mobile bottom sheets. | SPEC §9, DESIGN.md |
| FR-1.23 | Optional bloom, auto-disabled when the frame time exceeds 25 ms. | SPEC §8.1 |

### 6.2 FR-2.x Negotiation (Phase 2, future)

Design notes: SPEC §10. Values below are proposed defaults to be tuned in Phase 2.

**FR-2.1 Bid schema.** Each agent MUST submit one bid per island per negotiation tick:

| Field | Type | Meaning |
|---|---|---|
| `agentId` | string | Utility id |
| `requestKW` | number | Desired power now |
| `minSafeKW` | number | Minimum to avoid serious harm (from telemetry, may exceed the static minSafe in a surge) |
| `criticality` | 0–1 | Static importance, possibly raised by state (e.g. sheltering school) |
| `urgency` | 0–1 | Derived from telemetry (SPEC §6.3) |
| `expectedDamagePerHour` | number | Harm rate if unserved |
| `tokensOffered` | number ≥ 0, ≤ balance | Tokens attached to raise priority |
| `flexibility` | `{ sheddableKW, maxDurationMin }[]` | Load the agent can shed or defer and for how long |
| `duration` | minutes | How long the request applies |
| `backupRemainingKWh` | number | Lets others see how long the agent can self-supply (public, coarse) |

**FR-2.2 Dynamic priority score.** `P = w1·criticality + w2·urgency + w3·normalisedDamage + w4·tokensOffered − w5·recentlyServedShare`
(SPEC §10). Weights MUST be state-dependent (a function of crisis phase: e.g. ratio of supply to total demand,
number of active disasters, fraction of the grid islanded) and logged each tick. `recentlyServedShare` is an
exponentially weighted share of requested power served over a rolling window. Scores MUST be normalised so
they are comparable across agent kinds. No fixed per-kind ranking table is allowed.

**FR-2.3 Negotiation rounds.** Per island per minute: (1) collect bids; (2) provisional clearing by priority
until supply is exhausted; (3) up to N rounds (default N = 4) of counter-offers, in which an agent with a
shortfall MAY raise tokens, and an agent with surplus relative to minSafe MAY offer a concession; (4) final
allocation proposal. Bounded: the process MUST terminate within N rounds and MUST always return a proposal
(anytime), using the last provisional clearing if rounds are cut short. Wall time budget per tick: 5 ms
(headless) / 8 ms (in browser). Negotiation MUST run independently on each island.

**FR-2.4 Token earn/spend rules.**

| Rule | Definition |
|---|---|
| Endowment | 100 tokens each at start (SPEC §6.3). Optional replenishment of a small fixed amount per hour so no agent is permanently locked out. |
| Spend | Tokens attached to a bid are *escrowed*; they are charged only if the agent receives more than its minSafe share because of them, in proportion to the extra kW granted; any unspent escrow is returned. |
| Earn (concession) | Conceding `x` kW for `t` minutes below its request pays `c · x · t` tokens (c set so a full-hour concession of a typical load yields a few tokens). Concession below minSafe is not allowed for critical agents. |
| Conservation | Tokens transferred are debited from payers and credited to conceders; the system total changes only by endowment/replenishment (invariant: ledger balanced). |
| Caps and decay | Balance capped (e.g. 300) with slow decay above the endowment to prevent hoarding. |
| No negative balance | An agent can never spend below zero. |
| Fairness coupling | Spending can raise priority only up to a limit so tokens cannot override the minSafe guarantee of a more critical agent. |

**FR-2.5 Concessions.** An agent MAY offer to: reduce consumption to a stated level; shed non-critical
sub-loads (e.g. a hospital's non-critical wards, a school's non-shelter areas); defer load to a later window.
Each concession is a structured offer `{agentId, kwReduced, fromMin, toMin, price}` that the engine accepts or
declines in clearing, and is recorded in the ledger. A concession MUST NOT reduce an agent below its minSafe
while it is critical.

**FR-2.6 Forward contracts.** A contract `{giverId, receiverId, nowKW, laterKW, laterWindow, tokenStake}`:
the giver yields `nowKW` now; the receiver commits to return `laterKW` in the window. Rules: (a) both parties'
stakes are escrowed; (b) a default forfeits the stake to the counterparty; (c) the validator checks the
contract remains feasible against the supply forecast and cancels it, refunding stakes, if not (e.g. the island
changes); (d) contracts expire at the end of the scenario; (e) at most M open contracts per agent (default 3).

**FR-2.7 Telemetry use.** Bids MUST be computed solely from the agent's own telemetry plus public island data
(supply, number of consumers). Agents MUST NOT read other agents' private state.

**FR-2.8 Interface.** The negotiation engine MUST implement `AllocationPolicy.allocate(supply, requests,
snapshot)` and expose a trace (bids, rounds, offers, scores, ledger deltas) for the UI and for logging.

**FR-2.9 Household aggregation.** Households SHOULD be aggregated into per-feeder clusters that bid on behalf
of members, with a medical-device sub-bid protected ahead of discretionary load.

**FR-2.10 Strategy configurability.** Weights, N, token constants and strategy MUST be configurable so that
experiments (including learned agents) can be run headlessly.

### 6.3 FR-3.x Safety (Phase 3, future)

Design notes: SPEC §11. The validator MUST be independent of the policy; it MUST NOT import negotiation code.

| Id | Requirement |
|---|---|
| FR-3.1 **Hard constraints** | After validation: (a) Σ allocation per island ≤ island supply; (b) 0 ≤ allocation ≤ demand per consumer; (c) per-edge flow ≤ capacity along each consumer's feeder and along transmission links; (d) no allocation to destroyed, disconnected or off nodes; (e) generator ramp-rate limits respected between consecutive minutes. |
| FR-3.2 **Physics** | Power balance per island; transformer/substation capacity; line capacity along the feeder path; backup energy never negative and not drawn faster than `maxKW`; generator output not above capacity × availability. |
| FR-3.3 **minSafe guarantee** | Every critical agent receives ≥ its minSafe (backup counted) whenever physically possible. If not possible, the validator selects the least-harmful feasible triage, records `triage` with reason and affected agents. Priority order among criticals in triage is derived from expected damage, not a fixed ranking. |
| FR-3.4 **Fairness bound** | No agent may be below its minSafe (or its starvation floor) for more than K consecutive minutes (default K = 30) while any other agent exceeds its minSafe, unless physically impossible. Jain's index within each criticality class SHOULD stay above a configurable floor; breaches are corrected by reallocation, not just logged. |
| FR-3.5 **Correction** | The validator MAY veto and replace an allocation. Corrections MUST be minimal (closest feasible allocation to the proposal under the priority score) and deterministic. A proposal that cannot be repaired falls back to the last valid committed allocation, then to the baseline policy. |
| FR-3.6 **Atomic commit** | An allocation is applied to the engine in a single step or not at all; partial application MUST NOT be observable by agents, view or metrics. |
| FR-3.7 **Invariants** | Checked every step: no NaN/∞; allocated ≤ demand; connected flag consistent with island membership; status consistent with allocation and backup (SPEC §6.4); token ledger balanced; each building appears in exactly one island; cell status monotonicity rules for permanent disasters. A violated invariant halts commit and raises a logged critical error. |
| FR-3.8 **Overload prevention** | Allocation MUST keep every edge below capacity so that the SPEC §7.4 cascade is never triggered by allocation (cascades caused by disaster damage remain). |
| FR-3.9 **Audit log** | Append-only entries `{tMin, island, rule, proposed, corrected, reason, severity}`; exported as JSON; shown in the UI; included in headless run output. |
| FR-3.10 **Adversarial robustness** | A policy fuzzer proposing random, malicious or non-finite allocations MUST never produce a committed allocation that violates FR-3.1–3.2. |
| FR-3.11 **Performance** | Validation completes within 2 ms per island per tick at the Phase 1 city size. |

## 7. Non-functional requirements

| Id | Requirement | Target / reference |
|---|---|---|
| NFR-1 Frame rate | Whole city in view at 1440p on a mid laptop GPU | ≥ 50 fps (SPEC §8.7) |
| NFR-2 Draw calls | Per frame | < 400 (SPEC §8.7) |
| NFR-3 City build | Generate city and network and build the scene | < 1.5 s (SPEC §8.7) |
| NFR-4 Sim step cost | One simulated minute, including network and agents | ≤ 4 ms in the browser (leaves headroom at 60×, which is 1 step/ms-frame batch of ≤ 1 per frame at 60 fps) — to be confirmed in profiling |
| NFR-5 Adaptive quality | Bloom auto-off when frame time > 25 ms | SPEC §8.1 |
| NFR-6 Determinism | Same seed and events gives identical results across runs and across browser and Node | SPEC §1 |
| NFR-7 Purity | `src/sim/**` runs in Node without DOM/three | SPEC §1, §12 |
| NFR-8 Correctness | No NaN; Σ allocation ≤ supply every step in all scenarios | SPEC §12 |
| NFR-9 Type safety | `npm run typecheck` clean, TypeScript strict | SPEC §1, §12 |
| NFR-10 Accessibility | AAA (7:1) body text contrast, AA minimum elsewhere; keyboard operability; colour-independent status; reduced-motion support | DESIGN.md §1, §6 |
| NFR-11 Visual identity | Tokens and components as in DESIGN.md (ink borders, 8 px radius, hard shadow, no gradients) | DESIGN.md |
| NFR-12 Responsiveness | Desktop primary (1440×900 reference); under 960 px panels become bottom sheets; checked at 390×844 | SPEC §9, §12 |
| NFR-13 Browser support | Current evergreen Chrome, Edge, Firefox and Safari (WebGL2 required); no polyfills | — |
| NFR-14 Offline | Runs from a static build with no backend (fonts from Google Fonts degrade to system fonts) | — |
| NFR-15 Memory | Steady-state under 500 MB; history capped by `HISTORY_LEN` | — |
| NFR-16 Maintainability | File ownership and module contracts as in SPEC §1.1; `src/core/*` changed only via orchestrator | SPEC §1.1 |

## 8. Scenarios and demo flow

| Scenario | Purpose | What to look for |
|---|---|---|
| `quiet-night` | Baseline sanity | Served ≈ 100%, damage ≈ 0, diurnal demand and solar fade after dusk |
| `monsoon-cyclone` | Weather: solar collapse then flooding | Supply drop at 01:30, flooded riverside hospital and intake, island formation |
| `earthquake` | Structural destruction and fire | Destroyed cells, broken lines, hospital inflow surge, spreading fire |
| `compound` | Everything at once | Thermal plant trip, earthquake, flood; cascades under the baseline policy |

Reference demo (3 minutes, Phase 1): load `earthquake` → run at 10× → select the riverside hospital → watch
telemetry and power bar → place a flood by hand → note overload trips in the log → compare KPIs.

## 9. Metrics and evaluation plan

Definitions are normative for Phase 4; most are already measurable in Phase 1 for the baseline.

| Metric | Formula | Pass target (Phase 1 baseline) | Target (Phase 2+3) |
|---|---|---|---|
| Total damage | Σ over minutes of Σ expectedDamagePerHour × (1 − servedFraction)/60 | Reported | ≥ 25% lower than baseline on `compound` and `earthquake` (to be validated) |
| Critical minSafe satisfaction | agent-minutes with allocation+backup ≥ minSafe ÷ agent-minutes, for agents with criticality ≥ 0.8, counted only when physically possible | Reported | ≥ 99% |
| Fairness (Jain) | `J = (Σxᵢ)² / (n·Σxᵢ²)` with `xᵢ` = served fraction of agent i; reported overall and per criticality class | Reported | Class-level J ≥ 0.9 |
| Constraint violations | Count of committed allocations violating FR-3.1/3.2 or invariants FR-3.7 | Measured by a checker (baseline clamps; reports corrections) | Exactly 0 |
| Cascade count | Overload trips plus consequential outages | Reported | Zero allocation-induced cascades |
| Served % | Σ served ÷ Σ demand | Reported | — |
| Critical unserved kW | Σ unserved kW of critical agents | Reported | — |
| Negotiation cost | Rounds used, ms per tick, tokens conceded | n/a | Within FR-2.3 budget |

**Evaluation plan (Phase 4).**
1. **Policies**: baseline critical-first proportional (SPEC §7.2), pure proportional (equal share of demand), static priority (fixed kind ranking), Trojan negotiation (L2) and Trojan + safety (L2+L3).
2. **Runs**: 4 scenarios × at least 30 seeds each; same seed and events across policies (paired design).
3. **Reporting**: per-metric mean, median and 95% confidence interval; paired differences versus baseline; per-agent-kind breakdown; timelines for selected runs.
4. **Ablations**: negotiation without tokens; without concessions; without forward contracts; safety layer off (to show what it prevents).
5. **Stress**: validator fuzzing (FR-3.10), supply drops of 20/40/60%, random multi-disaster seeds.
6. **Artefacts**: JSON results, a plain-text summary table and the audit log, all reproducible by one command.

## 10. Risks and mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| 3D performance below budget (draw calls, shadows) | Poor demo | Medium | Static merge per material, instancing, fat-line batching, adaptive bloom, pooled FX (SPEC §8) |
| Simulation realism disputed (no AC power flow) | Credibility | Medium | State scope honestly; use capacities and islands, physically consistent power balance; document limits |
| Cascades dominate every scenario and swamp comparison | Weak evaluation | Medium | Tunable edge capacities and scenario intensity; report cascade count separately |
| Negotiation does not beat a good proportional baseline | Phase 2 miss | Medium | Strong baselines kept honest; ablations; start with simple clearing and add richness |
| Negotiation too slow for a tick | Frame hitches | Low–Med | Anytime algorithm, N-round cap, per-island parallel structure, time budget |
| Token economy gamed (hoarding, collusion) | Unfair outcomes | Medium | Caps, decay, conservation, fairness term, escrow, validator override |
| Safety layer too conservative or inconsistent with policy | Lost value | Medium | Minimal corrections; metric for correction magnitude; policy sees its vetoes |
| Determinism broken by stray `Math.random` or iteration order | Irreproducible results | Medium | Lint/grep check; golden-run test on every scenario |
| Scope creep into Layers 2/3 during Phase 1 | Delay | Medium | Phase gating; interfaces and baselines only |
| Accessibility versus strong visual style | Compliance | Low | Contrast tokens pre-validated in DESIGN.md; text-labelled statuses |
| Browser/GPU variability | Demo failure | Low–Med | Reference-hardware check; adaptive quality; static screenshot fallback |

## 11. Open questions

| # | Question | Owner | Needed by |
|---|---|---|---|
| OQ-1 | Negotiation mechanism: sealed-bid priority auction with concession rounds versus contract-net with token transfers (SPEC §10 lists both)? | Phase 2 lead | Phase 2 start |
| OQ-2 | Should agents be rule-parameterised, heuristic or learned (RL / LLM)? How does that affect the determinism requirement? | Research | Phase 2 start |
| OQ-3 | Is the damage function linear in unserved fraction, or convex below minSafe? Need an agreed harm model for the evaluation. | Domain / judge | Phase 4 |
| OQ-4 | Should medical-device households be individual bidders or only a protected sub-bid inside a cluster? | Phase 2 | Phase 2 |
| OQ-5 | Fairness definition: Jain over served fraction overall, within class, or weighted by criticality? Fairness bound K value? | Phase 3 | Phase 3 |
| OQ-6 | Can agents influence supply (e.g. start backup generation, ask hospitals to run diesel to free grid power)? | Product | Phase 2 |
| OQ-7 | Is inter-island power transfer (re-closing lines, mobile generators) in scope for agents? | Product | Phase 2 |
| OQ-8 | Should disaster outcomes be stochastic per run (seeded) or fixed per scenario for judging? | Product | Phase 1 polish |
| OQ-9 | Reference hardware definition for the 50 fps budget. | Team | Phase 1 exit |
| OQ-10 | Do we add a headless CLI in Phase 1 or defer to Phase 4? (Engine is already Node-runnable.) | Team | Phase 1 exit |

## 12. Milestones

| Milestone | Contents | Exit criterion |
|---|---|---|
| **M1.0 Contracts** | `src/core` types, constants, RNG, events; SPEC/DESIGN/PRD/PROJECT | `npm run typecheck` clean |
| **M1.1 Models** | Eight building models, pylon, pole, props; `models.html` gallery | Visual review at desktop and phone sizes |
| **M1.2 Sim core** | City gen, network, engine loop, baseline policy/validator | Node smoke run for `quiet-night`: no NaN, Σ ≤ supply |
| **M1.3 Disasters and agents** | Five disasters, telemetry, backup, cascade, scenarios | All four scenarios deterministic |
| **M1.4 3D view** | WorldView: ground, batching, lines, flow, FX, picking, labels | NFR-1 to NFR-3 met |
| **M1.5 UI** | Top bar, rail, inspector, KPIs, chart, log, shortcuts, responsive | US-1.1 to US-1.13 pass |
| **M1 Release (Phase 1 exit)** | Integration, polish, accessibility pass, demo script | All Phase 1 ACs met; open questions OQ-8–OQ-10 resolved |
| **M2.x Negotiation** | Bid schema, score, ledger, rounds, concessions, forward contracts, trace UI | Beats baseline; FR-2.x tests pass |
| **M3.x Safety** | Validator, physics, guarantees, atomic commit, invariants, audit | 0 violations under fuzzing |
| **M4 Evaluation** | Headless runner, baselines, report | Reproducible report per §9 |

Dates are intentionally not committed: Phase 1 is in active build; Phases 2–4 are scheduled after Phase 1 exit.
