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
  flowKW: number; // set by the engine every tick
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
}

export interface MetricSample {
  tMin: number;
  supplyKW: number;
  demandKW: number;
  allocatedKW: number;
  criticalUnservedKW: number;
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
}

/** Layer 2 implements this (negotiation / bidding). Simulation ships a baseline. */
export interface AllocationPolicy {
  name: string;
  /**
   * @param supplyKW power available to the connected island
   * @returns buildingId → kW granted
   */
  allocate(supplyKW: number, requests: AllocationRequest[], snapshot: SimSnapshot): Record<string, number>;
}

/** Layer 3 implements this (safety). It may clamp/repair an allocation. */
export interface ConstraintValidator {
  name: string;
  validate(
    supplyKW: number,
    requests: AllocationRequest[],
    allocation: Record<string, number>,
  ): { allocation: Record<string, number>; violations: string[] };
}

// ─────────────────────────── Engine events ───────────────────────────

export interface EngineEvents {
  tick: SimSnapshot;
  disaster: DisasterEvent;
  log: LogEntry;
  reset: SimSnapshot;
}
