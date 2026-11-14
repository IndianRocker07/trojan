# Trojan — Layer 2 (Negotiation) & Layer 3 (Safety) build design

Status: build spec for Phase 2 + 3. Normative together with `agent_prompt.md` (NEED-BASED rules — they
override PRD wording about tokens buying priority) and the PDF design ("one agent per utility": System-1
perception via TypeSafe **Jev** + deterministic bid synthesis + 2-round negotiation + safety lock).

Contracts: `src/core/types.ts` sections "Layer hooks", "Layer 2 — Negotiation contracts", "Layer 3 — Safety
contracts". Tunables: `src/negotiation/config.ts` (`NEGOTIATION_CONFIG`). Do not change either without the
orchestrator. All code: TypeScript strict, ES modules, no `any` leaks in public APIs.

## 0. Ground rules for every module

- `src/negotiation/**` and `src/safety/**` are **pure**: no `three`, no DOM, no Node APIs, no `fetch`
  except in `src/negotiation/jevClient.ts`. They must run under `npx tsx` in Node.
- `src/safety/**` MUST NOT import anything from `src/negotiation/**` (independence, FR-3.x). It may
  import `src/core/**` only.
- Determinism: no `Math.random`, no `Date.now()` in decisions (wall clock is allowed only for
  perception refresh throttling and latency stats). Iterate in sorted id order where order matters.
  With the heuristic provider, same seed ⇒ identical run.
- **Need, not wealth** (agent_prompt.md): priority comes from criticality, urgency, expected damage,
  minimum-safe need. Raw requested kW never raises priority. Tokens have a hard-capped weight
  (`maxTokenWeight`) and never influence the protected minimum-safe phase.

## 1. Agents (one per utility)

| Kind | Agent | Perception | Notes |
|---|---|---|---|
| hospital ×3, water ×3, emergency ×3, telecom ×8, school ×4 | `UtilityAgent` | Jev (async, cached) with heuristic fallback | 21 negotiators |
| house (hundreds) | `ClusterAgent` per household cluster | deterministic only | cluster = houses with the same feeder substation and the same 6×6 city block; medical-device homes are a protected sub-bid |

### 1.1 Modes — only affected utilities actively negotiate

Each minute every agent calls `assess()` with its own state + public island info:

- **affected** iff any of: `telemetry.distanceToImpactM ≤ affectedRadiusM`; last-minute served fraction
  `(allocated + backupDraw)/demand < affectedServedFrac` (approximate with `allocatedKW/demandKW` from
  its state); `urgency ≥ affectedUrgency`; kind-specific red flags (hospital `waterSupplyPct < 50`,
  `backupFuelHours < 2` while drawing backup; water `reservoirPct < 40` or `pressureBar < 2`; telecom
  `batteryPct < 50`; school `sheltered > 0`; emergency `activeIncidents > 0`). Collect a human string per
  reason (shown in the dossier), e.g. `"Disaster damage 180 m away"`, `"Running on backup (3.2 h left)"`.
- mode = `active` if affected; else `cooperating` if island `deficitKW / totalRequestKW >
  cooperateDeficitFrac` (i.e. any shortage); else `idle`.
- **idle**: bid = demand, no concession, no Jev call; stance `CRITICAL_HOLD` (field is required) with
  primaryArgument "Operating normally; requesting nominal load." and concessionOffer "None needed —
  island has surplus.", perceptionSource `'none'`.
- **cooperating** (unaffected, but the island is short): "use less power" — concession-only perception
  (Jev asked only `can_concede` + `concession_strategy`); concedes flexible load generously
  (willingness boosted), earns tokens for verified concessions, may become a contract giver.
- **active**: full Jev perception, full case brief; concedes only when perception says so and buffers allow.

Houses (clusters) are `active` if any member is affected (distance / not fully served) else
`cooperating`/`idle` by the same island rule. Clusters never call Jev.

### 1.2 Two-stage loop per agent (PDF §1)

1. **Local telemetry & incident log** — `UtilityAgentState` (own) + `PerceptionInput.incidentLog` built
   from own telemetry (distance to impact, backup, water supply, battery, reservoir, island deficit).
2. **System-1 perception** — `Perception` (urgency 0..1, damage 0..1, imminentFailureRisk, canConcede,
   concessionStrategy, confidence) from the `PerceptionScheduler` (cached Jev, or heuristic).
3. **Case advocacy & bid synthesis (deterministic guardrail)**:
   - `minSafeKW` = state.minSafeKW (never changed by perception).
   - effective urgency `u = (1−α)·state.urgency + α·p.urgency`, `α = perceptionBlend × p.confidence`.
   - effective damage-rate stays `state.expectedDamagePerHour`; the bid carries it; the clearing
     normalises it and blends `p.damage` the same way (see §3).
   - flex loads from the persona (§1.3); `flexibleKW = min(Σ flex, demand − minSafe)`.
   - concession: only in round ≥ 2 (`respond`) unless mode is `cooperating` (may concede in round 1 too).
     Fraction = 0 / 0.25 / 0.5 of `flexibleKW` per `p.concessionStrategy`, only if `p.canConcede ≥ 0.5`
     and persona guardrails allow; cooperating agents use `max(strategy, shed_25_flex)` when the island is
     short. **requestKW never drops below minSafeKW.** Critical agents (criticality ≥ criticalThreshold)
     with `imminentFailureRisk ≥ 0.6` always `CRITICAL_HOLD`.
   - tokensOffered: `0` when holding with no shortfall; otherwise
     `min(balance × maxOfferFraction, tokenBidCap)` when it projects a shortfall (round ≥ 2) — a bounded,
     secondary signal.
   - stance: `CRITICAL_HOLD` (no concession), `PARTIAL_CONCESSION` (0 < conceded < flexibleKW),
     `FULL_FLEX_SHED` (conceded ≈ flexibleKW).
   - **Case brief**: `primaryArgument` cites real numbers, e.g.
     `"ICU 14/16 beds, diesel 3.1 h left, 42 incoming/h; cannot go below 810 kW (ICU, ventilators, surgery)."`;
     `concessionOffer` e.g. `"Willing to defer 120 kW of admin HVAC/lighting while the 810 kW floor is locked."`
     or `"No concession: backup below 50%."`.

### 1.3 Personas (PDF §4) — `src/negotiation/personas.ts`

| Kind | Buffer metric (0..100) | Hard floor (= minSafeKW) label | Flex loads (fractions of demand above floor) | Concession guardrail |
|---|---|---|---|---|
| hospital | backup fuel % = `backupFuelHours / 10 × 100` (or `backup.remainingKWh/capacityKWh`) | ICU, ventilators, surgical suites, cold-chain meds | admin/HVAC/lighting 18% of demand; elective imaging 7%; backup self-supply (if backup hours > `backupSelfSupplyHours`): up to `backup.maxKW` | almost never below floor; sheds admin/HVAC early only if buffer > 50% and imminentFailureRisk < 0.5 |
| water | `reservoirPct` | minimum-pressure pumps for firefighting & hospital cooling | discretionary pumping (reservoir refill) 40% of demand while reservoir > 60%, 15% while 40–60%, 0 below | high early concession willingness if reservoir > 60%; urgency spikes non-linearly when `pressureBar < 2` (heuristic: `u = max(u, 1 − (pressureBar/2)²)` when below) |
| emergency | backup % (diesel) | 911/112 dispatch, radio repeaters, rapid-response bays | non-urgent fleet charging 25% of demand; station HVAC 10% | sheds fleet charging during peak grid stress (island deficit > 0) unless `activeIncidents ≥ unitsAvailable` |
| telecom | `batteryPct` | core routing & emergency-broadcast control plane | consumer 5G high-bandwidth sectors 30% of demand | sheds 5G first; never the control-plane floor |
| school | `waterLiters / 25` capped 100 (shelter buffer) | shelter lighting, heating, medical corner | classroom/admin HVAC 35% of demand when `sheltered = 0`, 10% when sheltering | concedes freely when not sheltering |
| house cluster | mean member battery % | Σ members' minSafe; medical-device members' full minSafe first | 50% of discretionary load (above floor) | always willing when cooperating; never touches medical-device minSafe |

Each persona also provides `jevBrief` — one paragraph for Jev describing what the utility is, its buffer,
floor and concession behaviour (taken from this table and the PDF).

## 2. Perception — Jev System-1 (`perception.ts`, `jevPrompts.ts`, `jevClient.ts`, `server/*`)

- SDK: `@typesafe-ai/sdk` v0.7.0 (installed). Node only (refuses browsers by default). Usage:
  ```ts
  import { TypeSafeClient, score, noul, choice } from '@typesafe-ai/sdk';
  const client = new TypeSafeClient(); // TYPESAFE_API_KEY from env; baseURL default https://api.typesafe.ai; model jev-latest
  const { answers, model } = await client.systemOne({ state, questions: {
    urgency: score('…', ['level 0 description', …, 'level 5 description']),   // answers.urgency.score (0-based index), .confidence
    damage: score('…', [...]),
    imminent_failure_risk: noul('…'),                                          // answers.x.noul (probability 0..1)
    can_concede: noul('…'),
    concession_strategy: choice('…', { none: '…', shed_25_flex: '…', shed_50_flex: '…' }), // answers.x.choice, .confidence
  }});
  ```
  Errors: `TypeSafeError` (bad input / missing key), `APIError`, `APIConnectionError`, `APITimeoutError`.
- **Browser path**: Vite dev/preview middleware `POST /api/jev` (body `{ inputs: PerceptionInput[] }`,
  response `{ perceptions: Perception[] }`, `503 { error: 'no_api_key' }` when `TYPESAFE_API_KEY` is
  missing). Key read with Vite `loadEnv(mode, cwd, '')` → from `.env.local` (git-ignored). The key never
  reaches the browser. `GET /api/jev/health` → `{ ok, hasKey, model }`.
- **Node path** (headless scripts): `server/jevDirect.ts` `DirectJevProvider` calls the SDK directly.
- Server runs one `systemOne` call per input with `Promise.all` (21 agents in parallel), per-call timeout
  4 s, `retry.maxRetries = 1`. Mode `cooperating` asks only `can_concede` + `concession_strategy` and fills
  `urgency = simUrgency`, `damage = clamp(expectedDamagePerHour / 150)`, `imminentFailureRisk = 0`.
  Mapping: `urgency = score / (levels − 1)`, same for damage; `confidence` = mean of the returned score /
  choice confidences. Failed call ⇒ that agent's perception has `error` set and the client falls back.
- `PerceptionScheduler` (never blocks a tick): `resolve(input)` returns, synchronously, the cached Jev
  perception if fresh (age < `perceptionTtlMin` sim-min and |Δ simUrgency| < `perceptionUrgencyDelta`
  and same mode), else the heuristic perception; and queues the agent for refresh. `pump()` (called once
  per step by the policy) sends ONE batch of queued agents if `inFlight < perceptionMaxInFlight` and each
  agent's last request is older than `perceptionMinRefreshMs` wall-clock. On provider error / 503 it backs
  off `perceptionBackoffMs`. With `provider = null` it is purely heuristic and deterministic.
- `heuristicPerception(input)` deterministic: urgency from simUrgency + persona non-linearities;
  damage = clamp(expectedDamagePerHour / damageNorm); imminentFailureRisk from buffer hours (< 1 h ⇒
  high) and served fraction; canConcede from buffer and mode; strategy from canConcede; confidence 0.6.

## 3. Clearing — need-based auction (`clearing.ts`)

Input: island `supplyKW`, final-round `UtilityBid[]`, contract adjustments. Output per bid: phase1, phase2,
contract kW, priority breakdown, rank, regime, triaged flag.

**Weights** (`computeWeights(supply, bids, cfg)`): scarcity `s = clamp(deficit / totalRequest)`.
`urgency += scarcityShift·s`, `damage += scarcityShift·s`, `criticality −= scarcityShift·s/2`,
`fairness −= scarcityShift·s/2`, `tokens = min(base.tokens, maxTokenWeight)`. Logged in the trace.

**Priority** (`priorityOf(bid, weights, perceptionDamage?)`), all terms 0..1:
- `c = criticality`, `u = bid.urgency`, `d = (1−α)·clamp(expectedDamagePerHour/damageNorm) + α·p.damage`
  (α as in §1.2; if no perception d is the telemetry term), `t = min(tokensOffered, tokenBidCap)/tokenBidCap`,
  `r = recentServedShare`.
- `score = (wC·c + wU·u + wD·d + wT·t + wF·(1 − r)) / (wC + wU + wD + wT + wF)`.
- Request size is NOT a term.

**Phase 1 — protected minimum safe** (tokens excluded): `floor_i = min(minSafeKW, requestKW)`.
If `Σ floor ≤ supply` grant every floor (regime `shortage` if Σ request > supply else `surplus`).
Else regime `triage`: order bids by `needScore` = priority computed with `wT = 0` (desc; tie → id asc) and
grant floors in order until supply runs out; the first one that does not fit gets the remaining partial
amount; mark all floors not fully granted `triaged`.

**Contracts** — after phase 1, open contracts in their "now" window give the receiver
`min(nowKW, remaining, receiver unmet)` before phase 2; in the repayment window the giver gets `laterKW` the
same way (the receiver's bid already carries the reduced request).

**Phase 2 — need-weighted water-filling** of the remainder `R` over unmet `m_i = request − granted`:
each agent gets fraction `f_i = min(1, λ·max(score_i, minScore))` of its unmet; find `λ` by bisection
(60 iterations) so `Σ f_i·m_i = min(R, Σ m_i)`. Higher priority ⇒ higher served fraction regardless of size.

**Rounds** (`NegotiationPolicy`): round 1 propose → provisional clear → if deficit > 0 and rounds left,
broadcast `ShortfallNotice` to each agent → `respond` (concessions, tokens) → (new contracts) → re-clear →
final. If there is no deficit, one round only.

## 4. Tokens (`ledger.ts`) and contracts (`contracts.ts`)

- `TokenLedger`: balances (endowment 100 each), entries with running balance (`LedgerEntry`), cap,
  hourly decay above endowment, hourly replenish below `replenishBelow`, never negative.
  `escrow(agent, n)`, `release(agent, n)` (refund), `charge(agent, n)`, `earn(agent, kwMin)`,
  `transfer(from, to, n, reason)`, `total()`; invariant `Σ balances + Σ escrow = Σ minted − Σ burned`.
- Spend: tokens offered are escrowed at bid time; at commit, charged only if the agent got phase-2 power,
  `charge = tokensOffered × min(1, wT·t / score)`; rest refunded.
- Earn: at commit, verified concession `kw = max(0, originalRequest − max(final, request))` — i.e. the
  agent really consumed less than its demand by choice — earns `earnPerKWMin × kw` (1 minute) tokens.
  Never for idle agents.
- Contracts (FR-2.6): created in round ≥ 2 when a giver conceded ≥ `contractMinKW` and a receiver on the
  same island has `projected < minSafe` or (`projected < 0.9·request` and `urgency ≥ 0.6`). Highest-priority
  receiver first; `nowKW = min(conceded, receiver shortfall)`; `laterKW = contractReturnRatio × nowKW`
  in `[t + contractDelayMin, t + contractDelayMin + contractRepayMin)`; both stake `contractStake`
  (escrow). ≤ `maxOpenContracts` per agent. Repayment: receiver's request reduced by `laterKW` unless that
  takes it below minSafe ⇒ `defaulted`, its stake goes to the giver. Ends ⇒ `honoured`, stakes refunded.
  Either party disconnected / on a different island / destroyed ⇒ `cancelled`, stakes refunded. Houses
  and clusters do not sign contracts.

## 5. Explanations & dossier (`policy.ts`)

For every agent each minute an `AllocationExplanation` with `reason` — 1–2 plain sentences referencing the
actual factors, e.g. *"Received 1 240 of 1 800 kW (69%). Its 810 kW minimum-safe floor was protected in
phase 1; 430 kW came from the need-weighted share — rank 1 of 37 (score 0.82: criticality 1.00, urgency
0.74, damage 0.91). Island 0 was 1.8 MW short."* Validator corrections are appended in `commit`.
History: `BidRecord` per minute for active/cooperating agents, every 5 minutes for idle ones, capped at
`historyPerAgent`. Houses: the dossier is the cluster's; `houseCluster[houseId]` maps it.

## 6. Safety layer (`src/safety/validator.ts`) — implements `ConstraintValidator`

Order (all deterministic, minimal corrections, never imports negotiation):
1. **Sanitize**: non-finite → 0, negative → 0, > demand → demand, ids not in `requests` dropped, agents
   destroyed / not connected (from `ctx.snapshot`) → 0.
2. **Edge capacity** (FR-3.1c / 3.8): per-edge flow = Σ allocation of the island's consumers whose feeder
   (`snapshot.network.feeders`) contains the edge; limit `capacityKW × 0.97`; **substation transformer
   limit** = Σ capacity of live transmission edges incident to the substation node. Reduce offenders:
   first the portion above minSafe (proportionally), then below minSafe in ascending order of
   `expectedDamagePerHour / demandKW` (least harm per kW first), tie → id.
3. **Supply** (FR-3.1a): Σ ≤ supply − 1e-6 using the same reduction order.
4. **minSafe guarantee** (FR-3.3): for critical agents (criticality ≥ 0.8) with `alloc + backupKW <
   minSafe` (`backupKW = remainingKWh > 0 ? backup.maxKW : 0`) shift power from other agents' above-minSafe
   portion (least harm per kW first), respecting edge limits. If impossible, audit `triage` with reason.
5. **Fairness bound** (FR-3.4): per-agent consecutive minutes below minSafe while connected; if > K = 30
   and others on the island are above minSafe, shift as in 4. Track counters across steps (`reset()`
   clears).
6. **Invariants** (FR-3.7) on the result: finite, 0 ≤ a ≤ demand, Σ ≤ supply, every edge ≤ capacity.
   If any fails ⇒ fallback to the last committed allocation for this island (re-sanitized and scaled),
   then to an internal minSafe-first proportional allocation; audit `fallback` (crit). A failure after
   fallback increments `violationsCommitted` (must stay 0).
7. Returns `{ allocation, violations, audit }` — the engine applies it atomically. `endStep` returns
   `SafetySnapshot` (audit capped 300, counts per rule, starving list, max edge utilisation).
   Performance: ≤ 2 ms per island per tick (cache feeder lookups per network object with a `WeakMap`).

## 7. UI (`src/ui/*`)

- Clicking any consumer opens the **Utility dossier** in the inspector (houses show their cluster): mode
  chip (Active / Cooperating / Idle), affected reasons, island + its deficit, current bid (request, floor,
  flex, conceded, tokens offered), **priority breakdown** (stacked bar of weighted terms), **case brief**
  (stance chip, primary argument, concession offer, perception source/age/confidence + Jev scores),
  **allocation explanation** (phase 1 → contract → phase 2 → validator → final, rank, reason sentence),
  **bid history** (newest first; each row: time, request, final, stance; click to expand that bid's
  explanation), tokens + recent ledger entries, contracts.
- **Negotiation tab** (next to the roster when nothing is selected): per-island trace for the latest minute
  (regime, supply vs request, weights, rounds with deficit and concessions), Jev status
  (provider, enabled, in flight, calls, errors, avg latency), safety audit feed, open contracts.
- **Policy switch** in the top bar: Policy `Baseline | Negotiation`, Safety `Baseline | Safety layer`.
- The UI reads `snapshot.negotiation` / `snapshot.safety` only — never imports negotiation/safety code.
