# Trojan — Prosumer-enabled, topology-aware microgrid (build spec)

Extends Layer 1 (sim), Layer 2 (negotiation) and Layer 3 (safety). Read with `docs/NEGOTIATION.md`.
Contracts: `src/core/types.ts` → `ProsumerSpec`, `ProsumerState`, `StorageState`, `IslandInfo`, new optional
fields on `Building`, `UtilityAgentState`, `AllocationRequest`, `IslandContext.info`, `SimSnapshot.islands`,
`Metrics`; `src/negotiation/agentApi.ts` → `PublicIslandInfo` microgrid fields.

User decisions (2026-11-14):
- **Prosumers = existing buildings**: a seeded ~30% of houses get rooftop solar + battery; every school is a
  campus prosumer (larger solar + BESS). No new building kinds/models (only a rooftop-solar decal).
- **Utility DERs are self-use**: hospital/EMS/water diesel and telecom batteries serve only their owner
  (existing `backup` model). They are never pooled. Only prosumer surplus is exported to the island.
- **Timeline**: 24 h scenario from **10:00** (`START_HOUR = 10`, `SCENARIO_MINUTES = 1440`), so the run sees
  midday solar surplus → pre-charging → sunset shedding → a night on reserves → dawn recovery.

## 1. Graph & islands — G(t) = (V, E(t))

- Islands are the **connected components of the live network** (same liveness rules as SPEC §4.3) that
  contain at least one supply source: a running generator **or** a prosumer with `offeredKW > 0` **or a
  charged battery** (a component of only consumers with no source stays dark). Generator-less islands are
  `microgrid: true` (e.g. a feeder tree cut off from its substation by a fallen line, or a substation whose
  transmission links all broke) and live on prosumer exports alone.
- One clearing loop per island (unchanged engine loop); **zero cross-break allocation**: only consumers and
  prosumers physically in island k are bound to it.
- `snapshot.islands: IslandInfo[]` is published every step (stable ids: sort components by their smallest
  node id). `IslandContext.info` carries the island's `IslandInfo` to the policy/validator.

## 2. Prosumer model (sim)

Static `ProsumerSpec` (cityGen, seeded, deterministic):
| | rooftop (≈30% of houses) | campus (all schools) |
|---|---|---|
| solarKWp | 3–7 | 60–120 |
| batteryKWh / maxKW | 10 / 3 (houses already having a battery keep it as the DER battery) | 150–250 / 60 |
| survivalKW (p_min) | 0.4–0.6 (lights, fridge, router) | 15% of school base demand (shelter core) |

Per minute (`UtilityAgentState.der`):
- `solarKW = solarKWp × daylight(hour) × cloudFactor` (same daylight/cyclone ×0.2 factors as the solar plant,
  plus slow seeded cloud noise per district).
- Battery: charges from solar beyond the building's own load when not exporting everything; discharges up to
  `batteryMaxKW` while SoC > 20% to cover p_min and (during a deficit) to export; SoC never < 0.
- `generationKW g = solarKW + allowed discharge`; `selfSupplyKW = min(g, p_min)`; `offeredKW = max(0, g − p_min)`
  — **clamped at zero: a prosumer never draws emergency power to fill its own p_min from the critical pool
  via the export path**; it bids for the rest of its demand normally.
- The building's **net grid request** = `max(0, demand − selfSupplyKW)` → `AllocationRequest.demandKW`, with
  `selfSupplyKW` attached. Served fraction for damage counts self-supply.

## 3. Supply: dual-layered bottleneck

Per island: `P_total = min(P_utility_DER + P_prosumer, P_line_thermal_limit)` where
- `P_utility_DER` = Σ running generator output in the island;
- `P_prosumer` = Σ exports **after curtailment**: exports flow from each prosumer's service drop up its feeder
  path; for every distribution edge, Σ exports injected downstream of it must be ≤ `capacityKW × 0.97`. If not,
  curtail exports at the inverters downstream of that edge (proportionally, deterministic) — "curtailed locally
  rather than tripping the breaker". `curtailedKW` recorded per prosumer and per island.
- `P_line_thermal_limit` = what the surviving lines can deliver: Σ over island substations of
  min(live transmission capacity into the substation, Σ capacity of its feeder-root edges) for generator power,
  plus the curtailed prosumer exports (already line-feasible). For a microgrid island it is just `P_prosumer`.
- `supplyKW` passed to `policy.allocate` and `validator.validate` is `P_total`.
- Edge flows (step 8) become **net bidirectional**: per edge `flow = |Σ downstream allocation − Σ downstream
  export|`, direction recorded for rendering (`PowerEdge.flowKW` stays ≥ 0; add nothing to the type — the render
  can infer reverse flow from the sign of a new optional `PowerEdge.reverse?: boolean`). Overload cascade uses
  the net flow.

## 4. Cross-utility dependency damage (sim → agents)

`UtilityAgentState.dependents` / `dependentDamagePerHour = Σ_j w_ij · D_j`:
- water station → hospitals and shelters (schools with sheltered > 0) served by its water tree
  (`snapshot.water.services[*].sourceId`), `w = 0.5` hospitals, `0.3` shelters;
- telecom tower → emergency stations within 350 m (dispatch radio/backhaul), `w = 0.4`, and hospitals within
  350 m, `w = 0.1`;
- `D_j` = dependent's `expectedDamagePerHour`. Computed in telemetry each step from the agent's own service
  topology (its own data, so FR-2.7 holds). Copied onto `AllocationRequest.dependentDamagePerHour`.

## 5. Utility buffers (sim) — pre-charge & coast

`UtilityAgentState.storage`:
- water: `{ kind:'reservoir', socPct: reservoirPct, chargeKW }` where `chargeKW` = refill pumping above the
  demand needed to hold pressure (0 when the reservoir is full);
- telecom: `{ kind:'battery', socPct: batteryPct, chargeKW = charger draw when battery < 100% }` (charger
  ≤ 25% of maxKW today — raise to 50% so pre-charging matters);
- hospital / emergency (diesel): `{ kind:'diesel', socPct: fuel %, chargeKW: 0 }`.
- `chargeKW` is part of `demandKW` and is **sheddable**: if not granted, the buffer simply does not charge (no
  damage). Copied onto `AllocationRequest.chargeKW`.

## 6. Layer 2 strategies

1. **Dynamic component partitioning**: already per island; `PublicIslandInfo` gains `microgrid`,
   `prosumerKW`, `utilityDerKW`, `minutesToSunset`, `surplusKW`.
2. **Solar-harvest pre-charging & tiered shedding**: storage agents (water, telecom, and household-cluster
   batteries implicitly) treat `chargeKW` as a flex load whose priority depends on the solar outlook: while
   `surplusKW > 0` and the sun is up they **bid for it** (do not concede; flag `"Pre-charging on prosumer
   surplus"`), and when `minutesToSunset < 60` or after sunset with a deficit they **shed it first and coast on
   reserves** (stance PARTIAL_CONCESSION, offer "Coasting on reservoir 78% so diesel is kept for the hospital").
   Clearing: charging kW is served only from phase 2 after every floor and never displaces another agent's
   floor; mark it so explanations can say "x kW pre-charge from midday solar surplus".
3. **Thermal clamping & curtailment**: sim (§3) + safety (§7).
4. **Dependency-weighted marginal damage**: bid `expectedDamagePerHour` used by the clearing =
   own + `dependentDamagePerHour` (cap ×3 own), and the case brief cites it ("Feeds 2 hospitals: +68 dmg/h if
   pressure is lost").
5. **Time-decay buffer thresholds (inter-temporal fairness)**: as a buffer nears depletion the marginal damage
   steepens exponentially: `urgency = max(u, exp(−k·soc))` with k chosen so soc 15% → 0.85, 5% → 0.95,
   40% → ~0.5; plus a **survival pulse**: an agent below 15% buffer gets its floor counted as phase-1 protected
   even at night (it already is — and the safety fairness bound K enforces it).

## 7. Layer 3 additions (safety, still independent)

- Supply invariant uses `ctx.info.supplyKW` (= P_total) when present.
- Generator-less (microgrid) islands: skip the transmission / substation checks that assume generator roots;
  feeder edges are checked on **net** flow: `|Σ downstream allocation − Σ downstream export|`
  (exports from `snapshot.agents[id].der.exportedKW`) ≤ capacity × margin. Without `der`, behaviour unchanged.
- Audit rule `'curtailment'` (info) is not emitted by the validator; the sim logs curtailment events.

## 8. UI / render

- Render: rooftop solar panel decal on prosumer houses, a small panel array + battery cabinet on campus
  schools (instanced; driven by `building.prosumer`), island tinting optional (layer `islands`).
- KPIs: add "Prosumer MW" (with curtailed kW sub-line) and island count / microgrids; chart gains a prosumer
  supply series.
- Negotiation tab island cards show the P_total breakdown bar: utility DER | prosumer | curtailed, with the line
  limit marker, and a "Microgrid" chip.
- Dossier: a DER block for prosumers (solar, battery %, self-supply, offered, exported, curtailed) and a buffer
  block for utilities (storage kind, SoC, charging kW, "pre-charging" / "coasting" state, dependents with
  dependent damage).
