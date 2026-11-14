/**
 * Shared contracts for every layer of the Trojan crisis-grid system.
 * Layer 1 (simulation) implements these. Layers 2 (negotiation) and 3 (safety)
 * plug in through AllocationPolicy / ConstraintValidator at the bottom.
 *
 * World units: 1 unit = 1 metre. Ground plane is X/Z, Y is up.
 * Cell (col,row) has its min corner at world (col*CELL - HALF_W, row*CELL - HALF_D).
 */

// ─────────────────────────── Grid ───────────────────────────

export type CellId = number; // row * GRID_COLS + col

export type Terrain = 'land' | 'road' | 'river' | 'bridge' | 'park';

/** Disaster status of a single grid block. "destroyed" = everything on it is fully off. */
export type CellStatus = 'ok' | 'destroyed' | 'flooded' | 'burning';

export interface GridCell {
  id: CellId;
  col: number;
  row: number;
  terrain: Terrain;
  /** 0 (river bed) … 1 (high ground). Drives flood spread. */
  elevation: number;
  status: CellStatus;
  /** Building occupying this cell, if any. */
  buildingId?: string;
}

// ─────────────────────────── Buildings / utilities ───────────────────────────

export type BuildingKind =
  | 'house'
  | 'hospital'
  | 'emergency' // emergency ward / fire + ambulance station
  | 'school' // doubles as disaster shelter
  | 'water' // water supply: pump station + tower + reservoir
  | 'telecom' // mobile tower
  | 'substation' // electric distributor
  | 'generator'; // power plant

/** Kinds that are power consumers represented by an autonomous agent. */
export type ConsumerKind = Exclude<BuildingKind, 'substation' | 'generator'>;

export type BuildingStatus =
  | 'online' // connected and fully served
  | 'brownout' // connected, served below demand
  | 'backup' // grid lost, running on battery/diesel
  | 'offline' // no power at all
  | 'destroyed'; // its block was hit

/** Quarter turns around Y. 0 = front faces +Z. */
export type Rotation = 0 | 1 | 2 | 3;

export interface Building {
  id: string; // e.g. "hospital-2"
  kind: BuildingKind;
  name: string; // human label, e.g. "St. Mary General"
  col: number; // min-corner cell column
  row: number; // min-corner cell row
  w: number; // footprint width in cells (along X, before rotation)
  d: number; // footprint depth in cells (along Z, before rotation)
  rotation: Rotation;
  variant: number; // model variant index
  cells: CellId[];
  /** Power-network node id that feeds this building. */
  nodeId: string;
  status: BuildingStatus;
  /** Static DER fit-out of a prosumer (rooftop solar + battery). Set by city generation; absent otherwise. */
  prosumer?: ProsumerSpec;
}

// ─────────────────────────── Microgrid / prosumers (docs/MICROGRID.md) ───────────────────────────

/** Static prosumer installation: houses (~30% seeded) get 'rooftop', schools get 'campus'. */
export interface ProsumerSpec {
  kind: 'rooftop' | 'campus';
  solarKWp: number;
  batteryKWh: number;
  batteryMaxKW: number; // charge/discharge power limit
  /** p_min: strict survival load served locally first (emergency lighting, fridge, router / shelter core). */
  survivalKW: number;
}

/** Live prosumer state (UtilityAgentState.der). Only the net surplus g − p_min is offered to the island. */
export interface ProsumerState {
  solarKW: number; // g_solar(t) right now (daylight × cloud × kWp)
  batteryKWh: number;
  batteryPct: number;
  /** g_m(t) = solar + allowed battery discharge. */
  generationKW: number;
  selfSupplyKW: number; // min(g, p_min) — consumed locally first
  offeredKW: number; // max(0, g − p_min): surplus offered to the island bus
  exportedKW: number; // what the island actually took after thermal curtailment
  curtailedKW: number; // offered − exported (curtailed at the inverter)
}

/** Physical buffer of a utility (water reservoir, telecom battery, diesel). */
export interface StorageState {
  kind: 'battery' | 'reservoir' | 'diesel';
  socPct: number; // 0..100
  /** The part of demandKW that is buffer charging / refilling (sheddable: coast on reserves). */
  chargeKW: number;
}

/** Island = connected component of the live network G(t) that contains at least one supply source. */
export interface IslandInfo {
  id: number;
  generatorIds: string[];
  substationIds: string[];
  consumerIds: string[];
  prosumerIds: string[]; // consumers on this island with an active DER
  /** No running utility-scale generator: lives on prosumer exports alone (microgrid). */
  microgrid: boolean;
  utilityDerKW: number; // Σ running generator output (utility-scale DER)
  prosumerOfferedKW: number; // Σ max(0, g − p_min) before curtailment
  prosumerKW: number; // P_prosumer after thermal curtailment
  curtailedKW: number;
  lineLimitKW: number; // P_line_thermal_limit(t)
  supplyKW: number; // P_total = min(utilityDerKW + prosumerKW, lineLimitKW)
  demandKW: number;
}

// ─────────────────────────── Power network ───────────────────────────

export type PowerNodeKind = 'generator' | 'substation' | 'consumer' | 'pylon' | 'pole';

export interface Vec2 {
  x: number;
  z: number;
}

export interface PowerNode {
  id: string;
  kind: PowerNodeKind;
  pos: Vec2; // world position (centre of support / building port)
  cell: CellId;
  buildingId?: string; // for generator/substation/consumer
  alive: boolean; // false when its cell is destroyed
}

export type LineTier = 'transmission' | 'distribution';

export interface PowerEdge {
  id: string;
  from: string; // node id (upstream side)
  to: string; // node id (downstream side)
  tier: LineTier;
  cells: CellId[]; // every cell the span passes over
  capacityKW: number;
  status: 'ok' | 'broken';
  flowKW: number; // set by the engine every tick (net magnitude)
  /** true when net flow runs downstream → upstream (prosumer export back toward the substation). */
  reverse?: boolean;
}

/** A feeder = the ordered chain of edges from a substation to one consumer. */
export interface Feeder {
  substationId: string; // building id
  consumerId: string; // building id
  edgeIds: string[];
}

export interface PowerNetwork {
  nodes: Record<string, PowerNode>;
  edges: Record<string, PowerEdge>;
  /** generator building id → substation building ids it feeds (via transmission). */
  transmission: Record<string, string[]>;
  feeders: Feeder[];
}

// ─────────────────────────── Water network (underground) ───────────────────────────

export type WaterNodeKind = 'source' | 'junction' | 'consumer';

export interface WaterNode {
  id: string;
  kind: WaterNodeKind;
  pos: Vec2; // world X/Z; pipes are buried at y = WATER_PIPE_DEPTH
  cell: CellId;
  buildingId?: string; // source = water building, consumer = served building
  alive: boolean;
}

export interface WaterPipe {
  id: string;
  from: string; // upstream node id
  to: string; // downstream node id
  tier: 'main' | 'service'; // trunk mains under roads, service lines into lots
  cells: CellId[];
  diameterMm: number;
  status: 'ok' | 'broken'; // broken when any cell is destroyed (earthquake/cyclone), not by flood
  flowM3h: number; // set every tick; 0 when the upstream pump station is unpowered
  pressureBar: number;
}

export interface WaterNetwork {
  nodes: Record<string, WaterNode>;
  pipes: Record<string, WaterPipe>;
  /** consumer building id → ordered pipe chain from its source. */
  services: Record<string, { sourceId: string; pipeIds: string[] }>;
}

export interface GeneratorState {
  buildingId: string;
  capacityKW: number;
  outputKW: number; // fluctuating actual output
  fuelHours: number;
  status: 'running' | 'tripped' | 'destroyed';
}

// ─────────────────────────── Utility agents & telemetry ───────────────────────────

export interface BackupPower {
  type: 'battery' | 'diesel' | 'none';
  capacityKWh: number;
  remainingKWh: number;
  maxKW: number;
}

/**
 * Live state of one consumer agent. The bid fields (demand, minSafe, criticality,
 * urgency, expectedDamage) are what Layer 2 will turn into bids.
 */
export interface UtilityAgentState {
  buildingId: string;
  kind: ConsumerKind;
  demandKW: number; // what it wants right now
  minSafeKW: number; // below this, safety-critical functions fail
  criticality: number; // 0..1 static importance of the service
  urgency: number; // 0..1 dynamic, rises with crisis load
  expectedDamagePerHour: number; // damage units/hr if unserved
  allocatedKW: number; // granted by the policy this tick
  connected: boolean; // has an intact path to a running generator
  backup: BackupPower;
  /** Free-form live telemetry, keys documented in SPEC.md §6. */
  telemetry: Record<string, number>;
  /** Virtual negotiation tokens (Layer 2). Simulation only initialises them. */
  tokens: number;
  /** Prosumer DER state (rooftop / campus solar + battery). */
  der?: ProsumerState;
  /** Utility physical buffer (reservoir / battery / diesel) incl. the sheddable charging part of demand. */
  storage?: StorageState;
  /** Building ids that depend on this utility (water → hospitals & shelters it feeds; telecom → emergency dispatch it covers). */
  dependents?: string[];
  /** Σ w_ij · D_j over dependents (cascading cross-utility damage if this utility fails). */
  dependentDamagePerHour?: number;
}

// ─────────────────────────── Disasters ───────────────────────────

export type DisasterKind = 'earthquake' | 'flood' | 'cyclone' | 'fire' | 'grid_fault';

export interface DisasterParams {
  /** Epicentre / origin in cell coordinates. */
  col?: number;
  row?: number;
  /** 0..1 */
  intensity?: number;
  /** Radius in cells (earthquake, cyclone). */
  radius?: number;
  /** Cyclone track heading in radians (0 = +X). */
  heading?: number;
  /** Cells per sim-hour (cyclone travel, fire spread). */
  speed?: number;
  /** grid_fault: generator building id to trip. */
  targetId?: string;
}

export interface DisasterEvent {
  id: string;
  kind: DisasterKind;
  startMin: number;
  durationMin: number;
  params: DisasterParams;
  /** Cells this disaster currently affects. */
  affected: CellId[];
  active: boolean;
}

// ─────────────────────────── Engine snapshot ───────────────────────────

export interface LogEntry {
  tMin: number;
  level: 'info' | 'warn' | 'crit';
  msg: string;
  buildingId?: string;
}

export interface Metrics {
  supplyKW: number;
  demandKW: number;
  allocatedKW: number;
  servedPct: number; // allocated / demand
  criticalUnservedKW: number; // sum max(0, minSafe - allocated) over consumers
  cumulativeDamage: number; // integral of expectedDamage * unserved fraction
  buildingsOffline: number;
  cellsDestroyed: number;
  prosumerKW?: number; // Σ P_prosumer exported to islands
  curtailedKW?: number; // Σ curtailed at inverters
  islandCount?: number;
  microgridCount?: number;
}

export interface SimSnapshot {
  tMin: number; // simulated minutes since scenario start
  running: boolean;
  speed: number; // sim minutes per real second
  cells: GridCell[]; // same array instance every tick; mutate-in-place
  buildings: Record<string, Building>;
  agents: Record<string, UtilityAgentState>;
  generators: Record<string, GeneratorState>;
  network: PowerNetwork;
  water: WaterNetwork;
  disasters: DisasterEvent[];
  metrics: Metrics;
  history: MetricSample[]; // ring of recent samples for charts
  log: LogEntry[]; // newest last, capped
  /** Live islands of G(t) with their supply breakdown (P_total, prosumer, curtailment, line limit). */
  islands?: IslandInfo[];
  /** Layer 2 state for the UI (present when the active policy exposes it). */
  negotiation?: NegotiationSnapshot;
  /** Layer 3 state for the UI (present when the active validator exposes it). */
  safety?: SafetySnapshot;
}

export interface MetricSample {
  tMin: number;
  supplyKW: number;
  demandKW: number;
  allocatedKW: number;
  criticalUnservedKW: number;
  prosumerKW?: number;
}

// ─────────────────────────── Layer hooks (2 & 3) ───────────────────────────

export interface AllocationRequest {
  buildingId: string;
  kind: ConsumerKind;
  demandKW: number;
  minSafeKW: number;
  criticality: number;
  urgency: number;
  expectedDamagePerHour: number;
  tokens: number;
  telemetry: Record<string, number>;
  /** demandKW is the NET grid request: own demand minus local self-supply (prosumers). */
  selfSupplyKW?: number;
  /** Sheddable buffer-charging part of demandKW (utilities with storage). */
  chargeKW?: number;
  dependentDamagePerHour?: number;
}

/** Per-island context the engine passes to the policy and the validator (all optional for old impls). */
export interface IslandContext {
  tMin: number;
  islandId: number;
  generatorIds: string[]; // running generators in this island
  substationIds: string[];
  consumerIds: string[]; // connected consumers (superset of requests: zero-demand ones excluded from requests)
  /** Supply breakdown (microgrid model); supplyKW passed to allocate/validate = info.supplyKW. */
  info?: IslandInfo;
}

/** Layer 2 implements this (negotiation / bidding). Simulation ships a baseline. */
export interface AllocationPolicy {
  name: string;
  /** Called once per step, before any island is allocated. */
  beginStep?(snapshot: SimSnapshot): void;
  /**
   * @param supplyKW power available to the connected island
   * @returns buildingId → kW granted
   */
  allocate(supplyKW: number, requests: AllocationRequest[], snapshot: SimSnapshot, ctx?: IslandContext): Record<string, number>;
  /** Called after the validator, with the allocation that was actually committed for this island. */
  commit?(ctx: IslandContext, committed: Record<string, number>, audit: AuditEntry[], snapshot: SimSnapshot): void;
  /** Called once per step after all islands; returns the UI state (attached to snapshot.negotiation). */
  endStep?(snapshot: SimSnapshot): NegotiationSnapshot;
  /** Clear all internal state (engine reset / scenario load). */
  reset?(): void;
}

/** Layer 3 implements this (safety). It may clamp/repair an allocation. */
export interface ConstraintValidator {
  name: string;
  validate(
    supplyKW: number,
    requests: AllocationRequest[],
    allocation: Record<string, number>,
    ctx?: ValidationContext,
  ): { allocation: Record<string, number>; violations: string[]; audit?: AuditEntry[] };
  /** Called once per step after all islands; returns the UI state (attached to snapshot.safety). */
  endStep?(snapshot: SimSnapshot): SafetySnapshot;
  reset?(): void;
}

/** Read-only context for the validator. Must not be mutated. */
export interface ValidationContext extends IslandContext {
  snapshot: SimSnapshot;
}

// ─────────────────────────── Layer 2 — Negotiation contracts ───────────────────────────
// Design: docs/NEGOTIATION.md. Need-based auction (agent_prompt.md): tokens never buy priority.

/** Consumer kinds that run their own Jev-driven agent. Houses bid as deterministic feeder clusters. */
export type NegotiatorKind = 'hospital' | 'water' | 'emergency' | 'telecom' | 'school';

/**
 * idle        — not affected and the island has enough supply: bids its demand, no Jev call.
 * active      — affected by the crisis: Jev perception, full case brief, negotiates.
 * cooperating — not affected but its island is short: asked to use less (concession-only Jev query).
 */
export type AgentMode = 'idle' | 'active' | 'cooperating';
export type Stance = 'CRITICAL_HOLD' | 'PARTIAL_CONCESSION' | 'FULL_FLEX_SHED';
export type ConcessionStrategy = 'none' | 'shed_25_flex' | 'shed_50_flex';

/** What an agent sends to its System-1 perception (Jev or heuristic). Built ONLY from its own state + public island data. */
export interface PerceptionInput {
  agentId: string;
  kind: NegotiatorKind;
  name: string;
  mode: AgentMode;
  tMin: number;
  hourOfDay: number;
  demandKW: number;
  minSafeKW: number;
  allocatedKW: number; // last committed grant
  criticality: number;
  simUrgency: number;
  expectedDamagePerHour: number;
  backup: { type: BackupPower['type']; remainingKWh: number; maxKW: number; hoursLeft: number };
  telemetry: Record<string, number>;
  /** Short human-readable crisis log lines from the agent's own view (e.g. "Earthquake 240 m away", "Feeder span broken"). */
  incidentLog: string[];
  /** Public island data. */
  island: { supplyKW: number; totalRequestKW: number; deficitKW: number; consumers: number };
}

/** System-1 output. Scores normalised to 0..1. */
export interface Perception {
  agentId: string;
  source: 'jev' | 'heuristic';
  tMin: number; // sim minute of the input it was computed from
  urgency: number; // 0..1
  damage: number; // 0..1
  imminentFailureRisk: number; // 0..1 (noul)
  canConcede: number; // 0..1 (noul)
  concessionStrategy: ConcessionStrategy;
  confidence: number; // 0..1
  latencyMs?: number;
  model?: string;
  error?: string;
}

/** Async perception backend (Jev over HTTP, Jev direct in Node, or heuristic). */
export interface PerceptionProvider {
  readonly name: string;
  perceive(inputs: PerceptionInput[], signal?: AbortSignal): Promise<Perception[]>;
}

/** A sheddable / deferrable sub-load (e.g. hospital admin HVAC, telecom 5G sectors). */
export interface FlexLoad {
  label: string;
  kw: number;
  maxDurationMin: number;
}

/** The mathematical bid (PDF "UtilityBid"; PRD FR-2.1). Immutable once submitted for a round. */
export interface UtilityBid {
  agentId: string; // building id, or cluster id for household clusters
  kind: ConsumerKind;
  islandId: number;
  tMin: number;
  round: number; // 1-based
  mode: AgentMode;
  requestKW: number; // after concessions this round
  originalRequestKW: number; // demand before any concession
  minSafeKW: number; // protected floor (never raised/lowered by the LLM)
  criticality: number;
  urgency: number; // effective (telemetry blended with bounded perception)
  expectedDamagePerHour: number;
  flexibleKW: number; // sheddable total
  flex: FlexLoad[];
  concededKW: number; // originalRequestKW - requestKW
  concessionWillingness: number; // 0..1
  backupRemainingKWh: number;
  backupHours: number;
  recentServedShare: number; // EWMA 0..1 of served fraction
  tokensOffered: number; // optional, bounded secondary signal
  /** household clusters only */
  memberIds?: string[];
  medicalKW?: number;
}

/** The structured case brief (PDF "AgentCaseBrief"): the agent putting forward its case. */
export interface AgentCaseBrief {
  agentId: string;
  utilityType: NegotiatorKind | 'household_cluster';
  stance: Stance;
  jevUrgencyScore: number; // 0..1
  jevDamageScore: number; // 0..1
  jevConfidence: number; // 0..1
  perceptionSource: 'jev' | 'heuristic' | 'none';
  primaryArgument: string;
  concessionOffer: string;
  renegotiationRound: number;
}

/** Broadcast from the clearing engine to each agent after a provisional round. */
export interface ShortfallNotice {
  islandId: number;
  round: number;
  supplyKW: number;
  totalRequestKW: number;
  totalMinSafeKW: number;
  deficitKW: number; // max(0, totalRequest - supply)
  projectedKW: number; // this agent's provisional grant
  requestKW: number;
  minSafeKW: number;
}

export interface PriorityWeights {
  criticality: number;
  urgency: number;
  damage: number;
  tokens: number; // hard-capped (≤ 0.05)
  fairness: number;
}

export interface PriorityBreakdown {
  score: number; // 0..1
  weights: PriorityWeights;
  /** normalised 0..1 inputs to each term (fairness = recentServedShare, subtracted) */
  terms: { criticality: number; urgency: number; damage: number; tokens: number; fairness: number };
}

/** "Why did this agent receive this amount of electricity?" — one per agent per committed minute. */
export interface AllocationExplanation {
  agentId: string;
  tMin: number;
  islandId: number;
  requestKW: number;
  minSafeKW: number;
  phase1KW: number; // protected min-safe grant
  phase2KW: number; // need-weighted share of the remainder
  contractKW: number; // net forward-contract adjustment (+ received, − yielded)
  proposedKW: number; // phase1 + phase2 + contract (policy output)
  finalKW: number; // after the safety validator (set in commit)
  rank: number; // 1 = highest priority on the island
  ofN: number;
  priority: PriorityBreakdown;
  minSafeMet: boolean;
  triaged: boolean; // min-safe could not be fully protected for everyone on the island
  concededKW: number;
  tokensEarned: number;
  tokensSpent: number;
  validatorNotes: string[];
  reason: string; // one or two plain sentences referencing the actual factors
}

export interface BidRecord {
  tMin: number;
  bid: UtilityBid; // final-round bid
  brief: AgentCaseBrief;
  explanation: AllocationExplanation;
  rounds: number;
}

export interface NegotiationRound {
  round: number;
  deficitKW: number;
  totalRequestKW: number;
  provisional: Record<string, number>; // agentId → kW (clusters by cluster id)
  concessions: { agentId: string; kw: number; stance: Stance }[];
}

export interface IslandTrace {
  islandId: number;
  tMin: number;
  supplyKW: number;
  totalRequestKW: number;
  totalMinSafeKW: number;
  regime: 'surplus' | 'shortage' | 'triage'; // triage = Σ minSafe > supply
  weights: PriorityWeights;
  rounds: NegotiationRound[];
  activeAgents: string[];
  cooperatingAgents: string[];
  durationMs: number;
}

export interface ForwardContract {
  id: string;
  giverId: string;
  receiverId: string;
  nowKW: number;
  laterKW: number;
  createdMin: number;
  nowUntilMin: number; // giver yields nowKW during [createdMin, nowUntilMin)
  laterFromMin: number; // receiver returns laterKW during [laterFromMin, laterToMin)
  laterToMin: number;
  tokenStake: number; // escrowed from each party
  status: 'open' | 'repaying' | 'honoured' | 'defaulted' | 'cancelled';
  note?: string;
}

export type LedgerReason =
  | 'endowment'
  | 'concession'
  | 'spend'
  | 'refund'
  | 'contract_stake'
  | 'contract_refund'
  | 'contract_forfeit'
  | 'decay'
  | 'replenish';

export interface LedgerEntry {
  tMin: number;
  agentId: string;
  delta: number;
  balance: number; // after this entry
  reason: LedgerReason;
  ref?: string;
}

/** Per-agent negotiation state shown in the utility dossier. */
export interface AgentDossier {
  agentId: string; // building id or cluster id
  kind: ConsumerKind;
  mode: AgentMode;
  affected: boolean;
  affectedReasons: string[]; // e.g. "Earthquake damage 180 m away", "On backup power", "Island deficit 1.2 MW"
  islandId: number | null;
  perception?: Perception;
  perceptionAgeMin?: number;
  current?: BidRecord;
  history: BidRecord[]; // newest last, capped (HISTORY_PER_AGENT)
  tokens: number;
  contractIds: string[];
  memberIds?: string[]; // clusters
}

export interface NegotiationSnapshot {
  policy: string;
  tMin: number;
  agents: Record<string, AgentDossier>; // keyed by agent id (building id / cluster id)
  houseCluster: Record<string, string>; // house building id → cluster id
  islands: IslandTrace[]; // latest minute
  contracts: ForwardContract[]; // open + recently closed
  ledger: LedgerEntry[]; // recent, newest last, capped
  tokenSupply: number; // Σ balances (ledger invariant check)
  perception: {
    provider: string; // 'jev' | 'heuristic' | ...
    enabled: boolean;
    inFlight: number;
    calls: number;
    errors: number;
    lastError?: string;
    avgLatencyMs: number;
  };
  /** Step-by-step recordings of recent island negotiations (newest last, capped ~40). docs/STORY.md */
  replays?: NegotiationReplay[];
  /** Notable moments for story mode (newest last, capped ~100). */
  events?: NegotiationEvent[];
  /** Plain-language live chat feed (newest last, capped ~300). */
  feed?: FeedMessage[];
}

// ─────────────────────────── Presentation: replays, story events, chat feed ───────────────────────────
// Produced by the negotiation policy (Layer 2) for the UI, theater view and city overlay. docs/STORY.md

/** One agent's bid as it stood in a given round. */
export interface RoundBid {
  agentId: string; // building id or cluster id
  name: string;
  kind: ConsumerKind;
  mode: AgentMode;
  requestKW: number;
  originalRequestKW: number;
  minSafeKW: number;
  concededKW: number;
  tokensOffered: number;
  score: number; // priority score this round
  stance: Stance;
  /** The model's raw System-1 output used for this bid (absent for idle agents and clusters). */
  perception?: {
    source: 'jev' | 'heuristic';
    urgency: number;
    damage: number;
    imminentFailureRisk: number;
    canConcede: number;
    concessionStrategy: ConcessionStrategy;
    confidence: number;
    ageMin: number;
  };
  argument: string; // case brief primary argument
  offer: string; // case brief concession offer
}

export type ReplayStageKind =
  | 'perceive' // agents read telemetry, query Jev / heuristic
  | 'bid' // round-1 bids submitted to the clearing hub
  | 'clear' // provisional clearing: phase 1 floors + phase 2 shares
  | 'notice' // shortfall broadcast back to each agent
  | 'counter' // counter-offers: concessions, tokens, holds
  | 'contract' // forward contracts signed
  | 'final' // final clearing
  | 'safety' // safety validator corrections / approval
  | 'commit'; // committed grants, tokens minted

export interface ReplayStage {
  kind: ReplayStageKind;
  round: number;
  title: string; // short, e.g. "Round 1 — bids"
  caption: string; // one or two plain sentences for non-experts
  bids?: RoundBid[];
  grants?: Record<string, number>; // agentId → kW at this stage
  phase1?: Record<string, number>;
  notices?: { agentId: string; projectedKW: number; requestKW: number }[];
  concessions?: { agentId: string; kw: number; stance: Stance; text: string }[];
  contracts?: { id: string; giverId: string; receiverId: string; nowKW: number; laterKW: number }[];
  corrections?: { agentId: string; proposedKW: number; finalKW: number; rule: string; reason: string }[];
  tokens?: { agentId: string; delta: number; reason: string }[];
}

export interface NegotiationReplay {
  id: string; // `${tMin}:${islandId}`
  tMin: number;
  islandId: number;
  supplyKW: number;
  totalRequestKW: number;
  totalMinSafeKW: number;
  deficitKW: number;
  regime: IslandTrace['regime'];
  microgrid: boolean;
  prosumerKW: number;
  /** Agents shown (negotiators + clusters on the island), with map anchors. */
  participants: { agentId: string; name: string; kind: ConsumerKind; buildingIds: string[] }[];
  stages: ReplayStage[];
  headline: string; // e.g. "Island 0 is 1.8 MW short — 12 agents negotiate"
}

export interface NegotiationEvent {
  id: string;
  tMin: number;
  islandId: number;
  kind: 'shortage_start' | 'triage_start' | 'big_concession' | 'contract' | 'microgrid' | 'safety_veto' | 'recovered';
  importance: 1 | 2 | 3; // 3 = auto-pause worthy
  text: string;
  agentIds: string[];
  replayId?: string;
}

export interface FeedMessage {
  id: string;
  tMin: number;
  islandId: number;
  from: string; // agentId, 'clearing' or 'safety'
  fromName: string;
  fromKind: ConsumerKind | 'clearing' | 'safety';
  kind: 'perception' | 'bid' | 'notice' | 'concession' | 'contract' | 'grant' | 'safety' | 'info';
  text: string;
  /** Optional numbers for chips, e.g. { requestKW, minSafeKW, urgency, jevUrgency } */
  data?: Record<string, number | string>;
  replayId?: string;
}

/**
 * Presentation playback contract: the UI replay stepper is the master clock and drives every view that
 * can draw a replay (theater view, city overlay). `progress` ∈ [0,1] within the current stage.
 */
export interface ReplayRenderer {
  showReplay(replay: NegotiationReplay | null, stageIndex: number, progress: number): void;
}

// ─────────────────────────── Layer 3 — Safety contracts ───────────────────────────

export interface AuditEntry {
  tMin: number;
  islandId: number;
  rule: string; // e.g. 'supply', 'edge-capacity', 'min-safe', 'fairness-K', 'invariant', 'sanitize', 'triage', 'fallback'
  severity: 'info' | 'warn' | 'crit';
  agentId?: string;
  edgeId?: string;
  proposedKW?: number;
  correctedKW?: number;
  reason: string;
}

export interface SafetySnapshot {
  validator: string;
  tMin: number;
  audit: AuditEntry[]; // recent, newest last, capped
  counts: Record<string, number>; // rule → corrections so far
  violationsCommitted: number; // must stay 0: post-validation invariant failures
  triageEvents: number;
  starving: { agentId: string; minutes: number }[]; // agents below minSafe now, with consecutive minutes
  maxEdgeUtilisation: number; // 0..1 over the committed allocation this step
}

// ─────────────────────────── Engine events ───────────────────────────

export interface EngineEvents {
  tick: SimSnapshot;
  disaster: DisasterEvent;
  log: LogEntry;
  reset: SimSnapshot;
}
