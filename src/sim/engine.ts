/**
 * SimEngine — SPEC §7. Owns all simulation state, advances it in 1-minute steps and emits snapshots.
 * Pure TypeScript (no DOM, no three). Deterministic: same seed + same triggered events ⇒ same run.
 */
import {
  HISTORY_LEN,
  LOG_LEN,
  SCENARIO_MINUTES,
  SIM_STEP_MIN,
  START_HOUR,
  DEFAULT_SPEED,
  GRID_COLS,
  GRID_ROWS,
} from '../core/constants';
import { Emitter } from '../core/events';
import { Rng } from '../core/rng';
import type {
  AllocationPolicy,
  AllocationRequest,
  Building,
  BuildingStatus,
  ConstraintValidator,
  DisasterEvent,
  DisasterKind,
  EngineEvents,
  GeneratorState,
  GridCell,
  IslandContext,
  IslandInfo,
  LogEntry,
  Metrics,
  PowerEdge,
  SimSnapshot,
} from '../core/types';
import { type AgentRuntime, applyBackupAndStatus, createAgents } from './agents';
import { generateCity } from './cityGen';
import {
  type DisasterCtx,
  type DisasterLayers,
  type DisasterRuntime,
  type SimDisasterParams,
  createDisaster,
  stepDisaster,
} from './disasters';
import { BaselinePolicy, BaselineValidator } from './policy';
import { type Island, buildNetwork, computeIslands, powerNodeIndex } from './powerNetwork';
import { type IslandPlan, MicrogridTopology, daylight, finalizeProsumer, prepareProsumer, setSelfSupply } from './microgrid';
import { buildWaterNetwork, updateWaterNetwork, waterConsumerId, waterIndex, waterSourceId } from './waterNetwork';
import { SCENARIOS, type Scenario } from './scenarios';
import { TelemetryState, computeDemand, hourOf } from './telemetry';

const NCELLS = GRID_COLS * GRID_ROWS;
/** Evening-peak demand as a fraction of total generator capacity (calibration, see report). */
export const PEAK_LOAD_FACTOR = 0.88;
const THERMAL_SHARE = 0.62;
const OVERLOAD_MINUTES = 3;

export interface EngineOptions {
  seed?: number;
  policy?: AllocationPolicy;
  validator?: ConstraintValidator;
}

type EngineEventMap = { [K in keyof EngineEvents]: EngineEvents[K] };

export class SimEngine extends Emitter<EngineEventMap> {
  readonly snapshot: SimSnapshot;
  scenarioId: string | null = null;

  private seed: number;
  private policy: AllocationPolicy;
  private validator: ConstraintValidator;
  private rng!: Rng;
  private acc = 0;
  private evN = 0;

  private agents: Record<string, AgentRuntime> = {};
  private list: AgentRuntime[] = [];
  /** cached iteration orders (the city never changes after build) */
  private bList: Building[] = [];
  private bAgent: Array<AgentRuntime | undefined> = [];
  private infraB: Building[] = [];
  private edgeList: PowerEdge[] = [];
  private aNode: Int32Array = new Int32Array(0);
  private wCons: Int32Array = new Int32Array(0);
  private wSrc: Int32Array = new Int32Array(0);
  private wDem: Float64Array = new Float64Array(0);
  private tele = new TelemetryState();
  private runtimes: DisasterRuntime[] = [];
  private layers: DisasterLayers = {
    destroyed: new Uint8Array(NCELLS),
    burning: new Uint8Array(NCELLS),
    flooded: new Uint8Array(NCELLS),
  };
  private pending: Scenario['events'] = [];
  private tripUntil = new Map<string, number>();
  private genNoise = new Map<string, number>();
  private trippedEdges = new Set<string>();
  private overload = new Map<string, number>();
  private recover = new Map<string, number>();
  private down = new Set<string>();
  private destroyedB = new Set<string>();
  private islands: Island[] = [];
  private infos: IslandInfo[] = [];
  private plans: IslandPlan[] = [];
  private topo!: MicrogridTopology;
  /** persistent island ids: building id → id it had last step; ids are never reused within a run */
  private prevIslandOf = new Map<string, number>();
  private prevIslandIds = new Set<number>();
  private nextIslandId = 0;
  private sources = new Set<string>();
  /** last step's generator load factor (dispatched / available) — drives fuel burn */
  private genLoad = new Map<string, number>();
  private cyclone = false;
  private lastDaylight = 0;
  private lastCurtailLog = -1e9;
  private tAdj = new Map<string, string[]>();
  private impD: number[] = [];
  private impB: number[] = [];
  private disasterStarted = false;
  private badSig = -1;
  private badCells: number[] = [];
  private badChanged = true;
  private lastStatus = new Map<string, BuildingStatus>();
  private lastGenStatus = new Map<string, string>();
  private fuelWarned = new Set<string>();
  private lastViolationLog = new Map<string, number>();
  private lastHomesDark = 0;
  private lastIslandCount = 1;
  private waterOk = 1;
  private cumulativeDamage = 0;
  /** total generator capacity chosen by the calibration (kW) */
  peakDemandKW = 0;

  constructor(opts: EngineOptions = {}) {
    super();
    this.seed = opts.seed ?? 1337;
    this.policy = opts.policy ?? new BaselinePolicy();
    this.validator = opts.validator ?? new BaselineValidator();
    const city = generateCity(this.seed);
    this.snapshot = {
      tMin: 0,
      running: false,
      speed: DEFAULT_SPEED,
      cells: city.cells,
      buildings: city.buildings,
      agents: {},
      generators: {},
      network: { nodes: {}, edges: {}, transmission: {}, feeders: [] },
      water: { nodes: {}, pipes: {}, services: {} },
      disasters: [],
      metrics: emptyMetrics(),
      history: [],
      log: [],
    };
    this.build(this.seed, city);
  }

  // ───────────────────────────── public API ─────────────────────────────

  play(): void {
    if (this.snapshot.tMin >= SCENARIO_MINUTES) return;
    this.snapshot.running = true;
  }
  pause(): void {
    this.snapshot.running = false;
  }
  setSpeed(minPerSec: number): void {
    this.snapshot.speed = Math.max(0, minPerSec);
  }
  timeOfDay(): number {
    return hourOf(this.snapshot.tMin);
  }

  /** Advance realDtSec × speed simulated minutes (whole steps). Emits 'tick' at most once. */
  update(realDtSec: number): void {
    const s = this.snapshot;
    if (!s.running) return;
    this.acc += Math.max(0, realDtSec) * s.speed;
    let n = Math.floor(this.acc);
    this.acc -= n;
    n = Math.min(n, 240);
    if (n <= 0) return;
    let did = 0;
    for (let i = 0; i < n; i++) {
      if (s.tMin >= SCENARIO_MINUTES) break;
      this.stepOnce();
      did++;
    }
    if (s.tMin >= SCENARIO_MINUTES && s.running) {
      s.running = false;
      this.log('info', 'Scenario complete (24 h)');
    }
    if (did > 0) this.emit('tick', s);
  }

  /** Exactly one simulated minute. */
  step(): void {
    const s = this.snapshot;
    if (s.tMin >= SCENARIO_MINUTES) return;
    this.stepOnce();
    if (s.tMin >= SCENARIO_MINUTES && s.running) s.running = false;
    this.emit('tick', s);
  }

  /** Regenerate city & network, restart the current scenario's script (if one is loaded). */
  reset(seed?: number): void {
    const sc = this.scenarioId ? SCENARIOS.find((x) => x.id === this.scenarioId) : undefined;
    this.seed = seed ?? this.seed;
    const city = generateCity(this.seed);
    // keep the same cells array instance
    this.snapshot.cells.splice(0, this.snapshot.cells.length, ...city.cells);
    city.cells = this.snapshot.cells;
    this.build(this.seed, city);
    if (sc) this.schedule(sc);
    this.emit('reset', this.snapshot);
  }

  loadScenario(id: string): void {
    const sc = SCENARIOS.find((x) => x.id === id);
    if (!sc) throw new Error(`unknown scenario: ${id}`);
    this.scenarioId = sc.id;
    this.seed = sc.seed;
    const city = generateCity(this.seed);
    this.snapshot.cells.splice(0, this.snapshot.cells.length, ...city.cells);
    city.cells = this.snapshot.cells;
    this.build(this.seed, city);
    this.schedule(sc);
    this.log('info', `Scenario "${sc.name}" loaded — ${sc.description}`);
    this.emit('reset', this.snapshot);
  }

  /** Current electrical islands (generator ids + connected consumer ids) — for tools and tests. */
  getIslands(): ReadonlyArray<Island> {
    return this.islands;
  }
  /** Current islands with their supply breakdown (P_total, prosumer, curtailment, line limit). Same objects as snapshot.islands. */
  getIslandInfos(): ReadonlyArray<IslandInfo> {
    return this.infos;
  }

  setPolicy(p: AllocationPolicy): void {
    this.policy = p;
    p.reset?.();
    this.snapshot.negotiation = undefined;
    for (const a of this.list) a.s.tokens = 100;
    this.log('info', `Allocation policy → ${p.name}`);
  }
  setValidator(v: ConstraintValidator): void {
    this.validator = v;
    v.reset?.();
    this.snapshot.safety = undefined;
    this.log('info', `Constraint validator → ${v.name}`);
  }
  getPolicy(): AllocationPolicy {
    return this.policy;
  }
  getValidator(): ConstraintValidator {
    return this.validator;
  }

  /** Start a disaster now. */
  trigger(kind: DisasterKind, params: SimDisasterParams): DisasterEvent {
    const ev = this.startEvent(kind, params);
    this.applyDisasters(); // reflect the damage in the cell statuses immediately
    this.emit('tick', this.snapshot);
    return ev;
  }

  // ───────────────────────────── construction ─────────────────────────────

  private build(seed: number, city: { cells: GridCell[]; buildings: Record<string, Building> }): void {
    const s = this.snapshot;
    s.buildings = city.buildings;
    this.rng = new Rng((seed ^ 0x5eed1234) >>> 0);
    s.network = buildNetwork(city.cells, city.buildings, new Rng((seed ^ 0xabcdef) >>> 0));
    s.water = buildWaterNetwork(city.cells, city.buildings, new Rng((seed ^ 0x3a7e11) >>> 0));
    this.tAdj = new Map();
    for (const e of Object.values(s.network.edges)) {
      if (e.tier !== 'transmission') continue;
      for (const n of [e.from, e.to]) {
        if (!this.tAdj.has(n)) this.tAdj.set(n, []);
        this.tAdj.get(n)!.push(e.id);
      }
    }
    // (separate Rng streams for the DER state: the layout / agent streams stay identical to the pre-microgrid sim)
    this.agents = createAgents(city.buildings, new Rng((seed ^ 0x77aa55) >>> 0), new Rng((seed ^ 0xd3a0c1) >>> 0));
    this.list = Object.values(this.agents);
    this.bList = Object.values(city.buildings);
    this.bAgent = this.bList.map((b) => this.agents[b.id]);
    this.infraB = this.bList.filter((b) => b.kind === 'substation' || b.kind === 'generator');
    this.edgeList = Object.values(s.network.edges);
    const pni = powerNodeIndex(s.network);
    this.aNode = Int32Array.from(this.list, (a) => pni.get(a.b.nodeId!)!);
    this.wCons = new Int32Array(0); // (re)built lazily by updateWater
    s.agents = {};
    for (const a of this.list) s.agents[a.b.id] = a.s;
    this.tele = new TelemetryState();
    this.tele.init(this.list, city.cells, s.water);
    this.topo = new MicrogridTopology(s.network, city.buildings, this.list, new Rng((seed ^ 0xc10d5e) >>> 0));

    // generator calibration: total capacity such that the evening-peak demand is PEAK_LOAD_FACTOR of it
    let peak = 0;
    for (const a of this.list) peak += computeDemand(a, 20);
    this.peakDemandKW = peak;
    const total = peak / PEAK_LOAD_FACTOR;
    s.generators = {};
    for (const b of Object.values(city.buildings)) {
      if (b.kind !== 'generator') continue;
      const thermal = b.variant === 0;
      const cap = Math.round((total * (thermal ? THERMAL_SHARE : 1 - THERMAL_SHARE)) / 10) * 10;
      s.generators[b.id] = {
        buildingId: b.id,
        capacityKW: cap,
        outputKW: cap,
        fuelHours: thermal ? 48 : 18,
        status: 'running',
      };
    }

    // runtime state
    s.tMin = 0;
    s.running = false;
    s.disasters = [];
    s.history = [];
    s.log = [];
    s.islands = [];
    this.acc = 0;
    this.evN = 0;
    this.runtimes = [];
    this.layers = { destroyed: new Uint8Array(NCELLS), burning: new Uint8Array(NCELLS), flooded: new Uint8Array(NCELLS) };
    this.pending = [];
    this.tripUntil.clear();
    this.genNoise.clear();
    this.trippedEdges.clear();
    this.overload.clear();
    this.recover.clear();
    this.down.clear();
    this.islands = [];
    this.infos = [];
    this.plans = [];
    this.prevIslandOf.clear();
    this.prevIslandIds.clear();
    this.nextIslandId = 0;
    this.sources.clear();
    this.genLoad.clear();
    this.cyclone = false;
    this.lastDaylight = daylight(hourOf(0));
    this.lastCurtailLog = -1e9;
    this.impD = [];
    this.impB = [];
    this.disasterStarted = false;
    this.badSig = -1;
    this.badCells = [];
    this.badChanged = true;
    this.lastStatus.clear();
    this.lastGenStatus.clear();
    this.fuelWarned.clear();
    this.lastViolationLog.clear();
    this.lastHomesDark = 0;
    this.lastIslandCount = 1;
    this.waterOk = 1;
    this.cumulativeDamage = 0;
    for (const c of city.cells) c.status = 'ok';
    this.policy.reset?.();
    this.validator.reset?.();
    s.negotiation = undefined;
    s.safety = undefined;

    // initial state: one pass of the pipeline at t=0 without advancing time, so the first snapshot is coherent
    this.pipeline(false);
    s.history.push(this.sample());
  }

  private schedule(sc: Scenario): void {
    this.pending = sc.events.map((e) => ({ ...e })).sort((a, b) => a.atMin - b.atMin);
  }

  private startEvent(kind: DisasterKind, params: SimDisasterParams): DisasterEvent {
    const rt = createDisaster(`ev-${++this.evN}`, kind, params, this.snapshot.tMin, this.rng);
    this.runtimes.push(rt);
    this.snapshot.disasters.push(rt.ev);
    if (this.snapshot.disasters.length > 40) this.snapshot.disasters.shift();
    this.disasterStarted = true;
    this.emit('disaster', rt.ev);
    return rt.ev;
  }

  // ───────────────────────────── logging ─────────────────────────────

  private log(level: LogEntry['level'], msg: string, buildingId?: string): void {
    const e: LogEntry = { tMin: this.snapshot.tMin, level, msg };
    if (buildingId) e.buildingId = buildingId;
    const l = this.snapshot.log;
    l.push(e);
    if (l.length > LOG_LEN) l.shift();
    this.emit('log', e);
  }

  // ───────────────────────────── the step ─────────────────────────────

  private stepOnce(): void {
    const s = this.snapshot;
    for (let k = 0; k < SIM_STEP_MIN; k++) {
      this.pipeline(true);
      s.tMin += 1;
      if (s.tMin % 5 === 0) {
        s.history.push(this.sample());
        if (s.history.length > HISTORY_LEN) s.history.shift();
      }
    }
  }

  /** Run one pass of SPEC §7.1. `advance` = false only for the initial pass. */
  private pipeline(advance: boolean): void {
    const s = this.snapshot;
    const t = s.tMin;

    // scheduled events
    while (this.pending.length && this.pending[0].atMin <= t) {
      const e = this.pending.shift()!;
      this.startEvent(e.kind, e.params as SimDisasterParams);
    }

    // 1. disasters → cell statuses
    this.applyDisasters();

    // 2. building damage / down state
    this.updateBuildingState();

    // 3. generators
    this.updateGenerators(advance);

    // 3b. prosumer DER: sun, p_min self-supply, battery capability (uses last step's demand for p_min)
    const hour = hourOf(t);
    for (const a of this.topo.prosumers) prepareProsumer(a, this.topo, t, hour, this.cyclone);
    this.sources.clear();
    for (const a of this.topo.prosumers) if (!a.down && a.plan!.potential) this.sources.add(a.b.id);

    // 4. connectivity & islands (components of G(t) with a generator or a prosumer source)
    const ci = computeIslands(s.network, s.cells, s.buildings, s.generators, this.down, this.trippedEdges, this.sources);
    this.islands = ci.islands;
    this.assignIslandIds();
    const reached = ci.reached;
    const L0 = this.list;
    for (let i = 0; i < L0.length; i++) L0[i].s.connected = !L0[i].down && reached[this.aNode[i]] === 1;
    this.topo.refreshReach();
    this.logConnectivity();
    this.logSunset(hour);

    // 5. telemetry, demand, urgency
    this.tele.update({
      tMin: t,
      hour: hourOf(t),
      cells: s.cells,
      list: this.list,
      newlyDestroyed: this.impD,
      newlyBurning: this.impB,
      disasterStarted: this.disasterStarted,
      badCells: this.badCells,
      badChanged: this.badChanged,
      waterOk: this.waterOk,
    });
    this.impD = [];
    this.impB = [];
    this.disasterStarted = false;
    this.badChanged = false;

    // 5b. island supply: prosumer plans, per-edge curtailment, P_total = min(DER + prosumer, line limit)
    this.buildSupply();

    // 6. allocation per island
    this.allocate();

    // 7. backup + statuses
    this.updateStatuses();
    this.updateWater();

    // 8. edge flows, 9. overload cascade
    this.computeFlows();
    if (advance) this.overloadCascade();

    // 10. metrics
    s.metrics = this.computeMetrics(advance);
  }

  // ───────────────── step 1 ─────────────────

  private applyDisasters(): void {
    const s = this.snapshot;
    const L = this.layers;
    L.burning.fill(0);
    L.flooded.fill(0);
    const ctx: DisasterCtx = {
      cells: s.cells,
      rng: this.rng,
      layers: L,
      tMin: s.tMin,
      log: (lv, msg, id) => this.log(lv, msg, id),
      tripGenerator: (id, until) => this.tripUntil.set(id, until),
      nearestGenerator: (col, row) => {
        let best: string | undefined;
        let bd = Infinity;
        for (const g of Object.values(s.generators)) {
          if (g.status === 'destroyed') continue;
          const b = s.buildings[g.buildingId];
          const d = Math.hypot(b.col - col, b.row - row);
          if (d < bd) {
            bd = d;
            best = g.buildingId;
          }
        }
        return best;
      },
    };
    for (const rt of this.runtimes) stepDisaster(rt, ctx);
    this.runtimes = this.runtimes.filter((rt) => rt.ev.active || s.tMin - rt.ev.startMin < rt.ev.durationMin + 1);
    // merge layers into cell status
    let sig = 0;
    const bad: number[] = [];
    for (const c of s.cells) {
      const st = L.destroyed[c.id] ? 'destroyed' : L.burning[c.id] ? 'burning' : L.flooded[c.id] ? 'flooded' : 'ok';
      if (st !== c.status) {
        if (st === 'destroyed') this.impD.push(c.id);
        else if (st === 'burning') this.impB.push(c.id);
        c.status = st;
      }
      if (st !== 'ok') {
        bad.push(c.id);
        sig = (sig + (c.id + 1) * (st === 'destroyed' ? 3 : st === 'burning' ? 5 : 7)) % 2147483647;
      }
    }
    sig = (sig * 31 + bad.length) % 2147483647;
    if (sig !== this.badSig) {
      this.badSig = sig;
      this.badChanged = true;
    }
    this.badCells = bad;
  }

  // ───────────────── step 2 ─────────────────

  private updateBuildingState(): void {
    const s = this.snapshot;
    this.down.clear();
    this.destroyedB.clear();
    const bl = this.bList;
    const ba = this.bAgent;
    if (this.badCells.length === 0 && this.recover.size === 0) {
      // nothing damaged and nothing recovering: every building is up
      for (let i = 0; i < ba.length; i++) {
        const a = ba[i];
        if (a) {
          a.down = false;
          a.destroyed = false;
        }
      }
      return;
    }
    for (let i = 0; i < bl.length; i++) {
      const b = bl[i];
      let destroyed = false;
      let bad = false;
      for (const cid of b.cells) {
        const st = s.cells[cid].status;
        if (st === 'destroyed') destroyed = true;
        else if (st !== 'ok') bad = true;
      }
      let isDown = destroyed || bad;
      if (!destroyed) {
        if (bad) this.recover.set(b.id, 0);
        else if (this.recover.has(b.id)) {
          const v = this.recover.get(b.id)! + 1;
          if (v >= 30) this.recover.delete(b.id);
          else this.recover.set(b.id, v);
          isDown = true;
        }
      }
      if (isDown) this.down.add(b.id);
      const a = ba[i];
      if (a) {
        a.down = isDown;
        a.destroyed = destroyed;
      } else if (destroyed) b.status = 'destroyed';
      else if (isDown) b.status = 'offline';
      // substations / generators get their final status after islands are known
      if (destroyed) this.destroyedB.add(b.id);
    }
  }

  // ───────────────── step 3 ─────────────────

  private updateGenerators(advance: boolean): void {
    const s = this.snapshot;
    const hour = hourOf(s.tMin);
    const cyclone = this.runtimes.some((r) => r.ev.kind === 'cyclone' && r.ev.active);
    this.cyclone = cyclone; // prosumer rooftop solar sees the same x0.2 as the solar farm
    for (const g of Object.values(s.generators)) {
      // fuel burn follows the dispatched load (prosumer exports are dispatched first and save fuel)
      const burn = Math.max(0.25, this.genLoad.get(g.buildingId) ?? 1) / 60;
      const b = s.buildings[g.buildingId];
      const destroyed = this.destroyedB.has(b.id);
      const until = this.tripUntil.get(g.buildingId);
      let status: GeneratorState['status'] = 'running';
      if (destroyed) status = 'destroyed';
      else if (this.down.has(g.buildingId) || (until !== undefined && s.tMin < until)) status = 'tripped';
      else if (until !== undefined) this.tripUntil.delete(g.buildingId);
      g.status = status;
      if (status !== 'running') {
        g.outputKW = 0;
        continue;
      }
      let out: number;
      if (b.variant === 0) {
        const prev = this.genNoise.get(g.buildingId) ?? 0;
        const nz = advance ? prev + (this.rng.range(-0.03, 0.03) - prev) * 0.35 : prev;
        this.genNoise.set(g.buildingId, nz);
        out = g.capacityKW * (1 + nz);
        if (advance) g.fuelHours = Math.max(0, g.fuelHours - burn);
        if (g.fuelHours <= 0) out = 0;
      } else {
        const d = daylight(hour);
        let frac = g.fuelHours > 0 ? 0.78 + 0.22 * d : d;
        if (cyclone) frac *= 0.2;
        if (advance && d < 0.5) g.fuelHours = Math.max(0, g.fuelHours - burn);
        out = g.capacityKW * frac;
      }
      g.outputKW = Math.max(0, out);
    }
    // log generator status changes
    for (const g of Object.values(s.generators)) {
      const prev = this.lastGenStatus.get(g.buildingId);
      if (prev !== undefined && prev !== g.status) {
        const name = s.buildings[g.buildingId].name;
        if (g.status === 'destroyed') this.log('crit', `${name} destroyed`, g.buildingId);
        else if (g.status === 'tripped') this.log('crit', `${name} offline`, g.buildingId);
        else this.log('info', `${name} back online`, g.buildingId);
      }
      this.lastGenStatus.set(g.buildingId, g.status);
    }
  }

  // ───────────────── connectivity logging ─────────────────

  private logConnectivity(): void {
    const s = this.snapshot;
    // (utility-fed islands only; prosumer microgrids are logged separately when they form)
    const gridIslands = this.islands.reduce((n, i) => n + (i.microgrid ? 0 : 1), 0);
    if (gridIslands !== this.lastIslandCount) {
      if (gridIslands > this.lastIslandCount) this.log('warn', `Grid split into ${gridIslands} islands`);
      else this.log('info', `Grid islands merged: ${gridIslands} remaining`);
      this.lastIslandCount = gridIslands;
    }
    let homesDark = 0;
    for (const a of this.list) {
      if (a.s.kind === 'house') {
        if (!a.s.connected && !a.down) homesDark++;
        continue;
      }
      const prev = this.lastStatus.get(a.b.id);
      void prev;
    }
    if (Math.abs(homesDark - this.lastHomesDark) >= 25) {
      if (homesDark > this.lastHomesDark) this.log('warn', `${homesDark} homes without grid power`);
      else this.log('info', `Power restored: ${homesDark} homes still dark`);
      this.lastHomesDark = homesDark;
    }
    void s;
  }

  // ───────────────── persistent island ids ─────────────────

  /**
   * computeIslands ranks components by their smallest node id; here every component inherits the id of the previous
   * step's island it overlaps most (greedy, ties by lower id), so a split keeps the id on the larger part and a
   * merged/dissolved island's id is retired (never reused). New islands get fresh ids. Deterministic.
   */
  private assignIslandIds(): void {
    const cand: Array<[number, number, number]> = []; // [count, prevId, islandIdx]
    this.islands.forEach((isl, i) => {
      const cnt = new Map<number, number>();
      for (const list of [isl.generatorIds, isl.substationIds, isl.consumerIds])
        for (const b of list) {
          const pid = this.prevIslandOf.get(b);
          if (pid !== undefined) cnt.set(pid, (cnt.get(pid) ?? 0) + 1);
        }
      for (const [pid, c] of cnt) cand.push([c, pid, i]);
    });
    cand.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
    const ids: number[] = new Array(this.islands.length).fill(-1);
    const used = new Set<number>();
    for (const [, pid, i] of cand) {
      if (ids[i] >= 0 || used.has(pid)) continue;
      ids[i] = pid;
      used.add(pid);
    }
    for (let i = 0; i < ids.length; i++) if (ids[i] < 0) ids[i] = this.nextIslandId++;
    this.prevIslandOf.clear();
    this.islands.forEach((isl, i) => {
      isl.id = ids[i];
      for (const list of [isl.generatorIds, isl.substationIds, isl.consumerIds]) for (const b of list) this.prevIslandOf.set(b, isl.id);
    });
  }

  // ───────────────── step 5b: island supply (docs/MICROGRID.md §3) ─────────────────

  private buildSupply(): void {
    const s = this.snapshot;
    for (const a of this.topo.prosumers) setSelfSupply(a);
    for (const a of this.list) if (!a.plan) a.selfKW = 0;
    this.topo.resetOffers();
    this.plans = this.islands.map((isl) => this.topo.planIsland(isl, this.agents, (id) => s.generators[id].outputKW));
    this.topo.curtail();
    this.infos = this.islands.map((isl, i) => this.topo.buildInfo(isl, this.plans[i]));
    s.islands = this.infos;

    // events: microgrid formation, large thermal curtailment
    const ids = new Set<number>();
    let formed = 0;
    let offered = 0;
    let curtailed = 0;
    for (let i = 0; i < this.infos.length; i++) {
      const info = this.infos[i];
      ids.add(info.id);
      offered += info.prosumerOfferedKW;
      curtailed += info.curtailedKW;
      if (info.microgrid && !this.prevIslandIds.has(info.id) && info.consumerIds.length >= 2 && info.prosumerOfferedKW >= 5) {
        if (++formed <= 3) {
          const sub = this.topo.substationOf.get(info.consumerIds[0]);
          const name = sub ? this.snapshot.buildings[sub].name : 'unknown';
          const solar = this.plans[i].pros.reduce((x, a) => x + a.plan!.solar, 0);
          const src = solar >= 0.5 * info.prosumerOfferedKW ? 'rooftop solar' : 'rooftop solar and batteries';
          this.log('warn', `Feeder ${name} islanded — running as a prosumer microgrid on ${Math.round(info.prosumerOfferedKW)} kW of ${src}`);
        }
      }
    }
    if (formed > 3) this.log('warn', `${formed - 3} more feeders islanded as prosumer microgrids`);
    this.prevIslandIds = ids;
    if (curtailed > 100 && curtailed > 0.2 * offered && s.tMin - this.lastCurtailLog >= 45) {
      this.lastCurtailLog = s.tMin;
      this.log('info', `Prosumer curtailment: ${Math.round(curtailed)} kW of rooftop export curtailed at the inverters (feeder thermal limits)`);
    }
  }

  private logSunset(hour: number): void {
    const d = daylight(hour);
    if (this.lastDaylight >= 0.15 && d < 0.15 && hour > 12 && this.topo.prosumers.length > 0) this.log('info', 'Sunset — prosumer solar fading');
    this.lastDaylight = d;
  }

  // ───────────────── step 6 ─────────────────

  private allocate(): void {
    const s = this.snapshot;
    for (const a of this.list) a.s.allocatedKW = 0;
    this.policy.beginStep?.(s);
    for (let ii = 0; ii < this.islands.length; ii++) {
      const isl = this.islands[ii];
      const info = this.infos[ii];
      const plan = this.plans[ii];
      const supply = info.supplyKW; // P_total
      const requests: AllocationRequest[] = [];
      const reqAgents: AgentRuntime[] = [];
      for (const cid of isl.consumerIds) {
        const a = this.agents[cid];
        if (!a || a.down || a.s.demandKW <= 1e-9) continue;
        // NET grid request: own demand minus what the building covers from its own DER
        const net = Math.max(0, a.s.demandKW - a.selfKW);
        if (net <= 1e-9) continue;
        const req: AllocationRequest = {
          buildingId: cid,
          kind: a.s.kind,
          demandKW: net,
          minSafeKW: Math.min(net, Math.max(0, a.s.minSafeKW - a.selfKW)),
          criticality: a.s.criticality,
          urgency: a.s.urgency,
          expectedDamagePerHour: a.s.expectedDamagePerHour,
          tokens: a.s.tokens,
          telemetry: a.s.telemetry,
        };
        if (a.plan) req.selfSupplyKW = a.selfKW;
        if (a.s.storage) req.chargeKW = Math.min(net, a.s.storage.chargeKW);
        if (a.s.dependentDamagePerHour !== undefined) req.dependentDamagePerHour = a.s.dependentDamagePerHour;
        requests.push(req);
        reqAgents.push(a);
      }
      let total = 0;
      if (requests.length > 0) {
        const ctx: IslandContext = {
          tMin: s.tMin,
          islandId: isl.id,
          generatorIds: isl.generatorIds,
          substationIds: isl.substationIds,
          consumerIds: isl.consumerIds,
          info,
        };
        // Layer 2 proposes → Layer 3 validates → the validated allocation is committed atomically (FR-3.6).
        const raw = this.policy.allocate(supply, requests, s, ctx);
        const res = this.validator.validate(supply, requests, raw, { ...ctx, snapshot: s });
        const committed: Record<string, number> = {};
        for (const r of requests) {
          const g = res.allocation[r.buildingId];
          committed[r.buildingId] = Number.isFinite(g) && g > 0 ? Math.min(g, r.demandKW) : 0;
          total += committed[r.buildingId];
        }
        // physical invariant: Σ allocation ≤ P_total (last line of defence; a correct validator never triggers it)
        if (total > supply + 1e-6) {
          const k = total > 0 ? Math.max(0, supply) / total : 0;
          for (const id of Object.keys(committed)) committed[id] *= k;
          total *= k;
          this.log('warn', `Engine: allocation exceeded island ${isl.id} supply — scaled down`);
        }
        for (let k = 0; k < requests.length; k++) reqAgents[k].s.allocatedKW = committed[requests[k].buildingId];
        this.policy.commit?.(ctx, committed, res.audit ?? [], s);
        for (const v of res.violations) {
          const last = this.lastViolationLog.get(v.replace(/\d+/g, '#'));
          if (last === undefined || s.tMin - last >= 30) {
            this.log('warn', `Validator (${this.validator.name}): ${v}`);
            this.lastViolationLog.set(v.replace(/\d+/g, '#'), s.tMin);
          }
        }
      }
      // Export dispatch: prosumer exports are used FIRST (free solar / stored energy), generators cover only the
      // remainder → fuel is conserved. If the island allocates less than P_prosumer, every export is scaled down equally.
      const genServed = this.topo.dispatch(info, total, plan.pros);
      for (const gid of isl.generatorIds) this.genLoad.set(gid, plan.utilityDerKW > 1e-9 ? Math.min(1, genServed / plan.utilityDerKW) : 0);
    }
    for (const a of this.topo.prosumers) finalizeProsumer(a);
    // UI state of the upper layers (one-way data flow: they only reach the view through the snapshot)
    s.negotiation = this.policy.endStep?.(s);
    s.safety = this.validator.endStep?.(s);
    const neg = s.negotiation;
    if (neg) {
      for (const a of this.list) {
        if (a.s.kind === 'house') continue;
        const d = neg.agents[a.b.id];
        if (d) a.s.tokens = d.tokens;
      }
    }
  }

  // ───────────────── step 7 ─────────────────

  private updateStatuses(): void {
    const s = this.snapshot;
    let waterN = 0;
    let waterOk = 0;
    for (const a of this.list) {
      const st = applyBackupAndStatus(a);
      a.b.status = st;
      const kind = a.s.kind;
      if (kind === 'water' && !a.down) {
        waterN++;
        if (a.servedFrac > 0.5) waterOk++;
      }
      if (kind !== 'house') {
        const prev = this.lastStatus.get(a.b.id);
        if (prev !== undefined && prev !== st) {
          const name = a.b.name;
          if (st === 'destroyed') this.log('crit', `${name} destroyed`, a.b.id);
          else if (st === 'offline') this.log(a.s.criticality >= 0.8 ? 'crit' : 'warn', `${name} has no power`, a.b.id);
          else if (st === 'backup') this.log('warn', `${name} running on ${a.s.backup.type} backup`, a.b.id);
          else if ((prev === 'offline' || prev === 'backup' || prev === 'destroyed') && (st === 'online' || st === 'brownout'))
            this.log('info', `${name} grid power ${st === 'online' ? 'restored' : 'partially restored'}`, a.b.id);
        }
        this.lastStatus.set(a.b.id, st);
        if (a.s.backup.type === 'diesel' && a.s.backup.maxKW > 0 && a.backupDrawKW > 0) {
          const hrs = a.s.backup.remainingKWh / a.s.backup.maxKW;
          if (hrs < 1 && !this.fuelWarned.has(a.b.id)) {
            this.fuelWarned.add(a.b.id);
            this.log('crit', `${a.b.name}: backup fuel under 1 h`, a.b.id);
          }
        }
      }
    }
    this.waterOk = waterN > 0 ? waterOk / waterN : 1;
    // substations / generators
    const inIsland = new Set<string>();
    for (const isl of this.islands) for (const id of isl.substationIds) inIsland.add(id);
    for (const b of this.infraB) {
      if (b.kind === 'substation') {
        const destroyed = this.destroyedB.has(b.id);
        b.status = destroyed ? 'destroyed' : this.down.has(b.id) || !inIsland.has(b.id) ? 'offline' : 'online';
      } else if (b.kind === 'generator') {
        const g = s.generators[b.id];
        b.status = g.status === 'destroyed' ? 'destroyed' : g.status === 'tripped' ? 'offline' : 'online';
      }
    }
  }

  // ───────────────── step 7b: underground water (SPEC §4.5) ─────────────────

  private waterDemand(id: string): number {
    const a = this.agents[id];
    return a ? this.waterDemandOf(a) : 0;
  }

  private waterDemandOf(a: AgentRuntime): number {
    if (a.down) return 0;
    switch (a.s.kind) {
      case 'house': return a.m.evacUntil > this.snapshot.tMin ? 0 : 0.06 * a.m.occupants;
      case 'hospital': return 18;
      case 'school': return 0.02 * a.m.sheltered;
      case 'emergency': return 4;
      default: return 0;
    }
  }

  private updateWater(): void {
    const s = this.snapshot;
    const L = this.list;
    if (this.wCons.length !== L.length) {
      const idx = waterIndex(s.water);
      this.wCons = new Int32Array(L.length);
      this.wSrc = new Int32Array(L.length);
      L.forEach((a, i) => {
        this.wCons[i] = idx.get(waterConsumerId(a.b.id)) ?? -1;
        this.wSrc[i] = a.s.kind === 'water' ? (idx.get(waterSourceId(a.b.id)) ?? -1) : -1;
      });
      this.wDem = new Float64Array(idx.size);
    }
    const dem = this.wDem;
    for (let i = 0; i < L.length; i++) {
      const ix = this.wCons[i];
      if (ix >= 0) dem[ix] = this.waterDemandOf(L[i]);
    }
    const res = updateWaterNetwork(
      s.water,
      s.cells,
      (id) => {
        const a = this.agents[id];
        return a && !a.down ? a.servedFrac : 0;
      },
      (id) => this.waterDemand(id),
      dem,
    );
    const pop = new Map<string, number>();
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      const ix = this.wCons[i];
      if (ix < 0) continue; // telecom: no water service
      const p = res.pressureArr[ix];
      const pct = Math.round(Math.min(1, p / 1.5) * 100);
      a.s.telemetry.waterPressureBar = Math.round(p * 100) / 100;
      a.s.telemetry.waterSupplyPct = pct;
      if (pct > 0 && !a.down) {
        const src = s.water.services[a.b.id]?.sourceId;
        const people = a.s.kind === 'house' ? (a.m.evacUntil > s.tMin ? 0 : a.m.occupants) : a.s.kind === 'school' ? a.m.sheltered : 0;
        if (src && people > 0) pop.set(src, (pop.get(src) ?? 0) + people);
      }
    }
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      if (a.s.kind !== 'water') continue;
      const sid = waterSourceId(a.b.id);
      const ix = this.wSrc[i];
      const t = a.s.telemetry;
      t.flowM3h = Math.round((ix >= 0 ? res.flowArr[ix] : 0) * 10) / 10;
      t.pressureBar = Math.round((ix >= 0 ? res.pressureArr[ix] : 0) * 100) / 100;
      t.populationServed = Math.round(pop.get(sid) ?? 0);
    }
  }

  // ───────────────── step 8 ─────────────────

  private computeFlows(): void {
    const s = this.snapshot;
    const net = s.network;
    // distribution: NET bidirectional flow per edge (allocation - export of everything downstream, live stretch only)
    const subNet = this.topo.netFlows(this.agents);
    // transmission: spread each island's substation loads back to its generators (ECMP over shortest paths)
    for (const isl of this.islands) {
      const depth = new Map<string, number>();
      const order: string[] = [];
      for (const gid of isl.generatorIds) {
        const n = s.buildings[gid].nodeId;
        depth.set(n, 0);
        order.push(n);
      }
      for (let h = 0; h < order.length; h++) {
        const n = order[h];
        for (const eid of this.tAdj.get(n) ?? []) {
          const e = net.edges[eid];
          if (e.status !== 'ok') continue;
          const o = e.from === n ? e.to : e.from;
          if (depth.has(o)) continue;
          depth.set(o, depth.get(n)! + 1);
          order.push(o);
        }
      }
      // substations that export (net < 0) offset the import of the others before generator power is spread
      let pos = 0;
      let neg = 0;
      for (const sid of isl.substationIds) {
        const v = subNet.get(sid) ?? 0;
        if (v > 0) pos += v;
        else neg -= v;
      }
      const f = pos > 0 ? Math.max(0, pos - neg) / pos : 0;
      const load = new Map<string, number>();
      for (const sid of isl.substationIds) {
        const v = subNet.get(sid) ?? 0;
        load.set(net.nodes[s.buildings[sid].nodeId].id, v > 0 ? v * f : 0);
      }
      for (let i = order.length - 1; i >= 0; i--) {
        const n = order[i];
        const d = depth.get(n)!;
        if (d === 0) continue;
        const l = load.get(n) ?? 0;
        if (l <= 0) continue;
        const parents: string[] = [];
        for (const eid of this.tAdj.get(n) ?? []) {
          const e = net.edges[eid];
          if (e.status !== 'ok') continue;
          const o = e.from === n ? e.to : e.from;
          if (depth.get(o) === d - 1) parents.push(eid);
        }
        if (parents.length === 0) continue;
        const share = l / parents.length;
        for (const eid of parents) {
          const e = net.edges[eid];
          e.flowKW += share;
          const o = e.from === n ? e.to : e.from;
          load.set(o, (load.get(o) ?? 0) + share);
        }
      }
    }
  }

  // ───────────────── step 9 ─────────────────

  private overloadCascade(): void {
    const net = this.snapshot.network;
    for (const e of this.edgeList) {
      if (e.status !== 'ok') {
        if (this.overload.size > 0) this.overload.delete(e.id);
        continue;
      }
      if (e.flowKW > e.capacityKW) {
        const n = (this.overload.get(e.id) ?? 0) + 1;
        if (n >= OVERLOAD_MINUTES) {
          this.trippedEdges.add(e.id);
          e.status = 'broken';
          this.overload.delete(e.id);
          this.log(
            'crit',
            `Overload: ${e.tier} span ${e.id} tripped (${Math.round(e.flowKW)} kW > ${e.capacityKW} kW)`,
          );
        } else this.overload.set(e.id, n);
      } else if (this.overload.size > 0) this.overload.delete(e.id);
    }
  }

  // ───────────────── step 10 ─────────────────

  private computeMetrics(advance: boolean): Metrics {
    const s = this.snapshot;
    // supply = Σ island P_total (line-limited, incl. prosumer exports); demand/allocation are on the NET grid basis
    // (own demand minus local self-supply), i.e. exactly what the islands' clearing sees.
    let supply = 0;
    for (const info of this.infos) supply += info.supplyKW;
    let demand = 0;
    let alloc = 0;
    let critUnserved = 0;
    let damage = 0;
    let offline = 0;
    let prosumerKW = 0;
    let curtailedKW = 0;
    for (const a of this.list) {
      if (a.down) continue;
      demand += Math.max(0, a.s.demandKW - a.selfKW);
      alloc += a.s.allocatedKW;
      critUnserved += Math.max(0, a.s.minSafeKW - a.selfKW - a.s.allocatedKW);
      damage += (a.s.expectedDamagePerHour * (1 - a.servedFrac)) / 60;
      if (a.s.der) {
        prosumerKW += a.s.der.exportedKW;
        curtailedKW += a.s.der.curtailedKW;
      }
    }
    if (advance) this.cumulativeDamage += damage;
    let destroyedCells = 0;
    for (const c of s.cells) if (c.status === 'destroyed') destroyedCells++;
    for (const b of this.bList) if (b.status === 'offline' || b.status === 'destroyed') offline++;
    return {
      supplyKW: supply,
      demandKW: demand,
      allocatedKW: alloc,
      servedPct: demand > 1e-9 ? (alloc / demand) * 100 : 100,
      criticalUnservedKW: critUnserved,
      cumulativeDamage: this.cumulativeDamage,
      buildingsOffline: offline,
      cellsDestroyed: destroyedCells,
      prosumerKW,
      curtailedKW,
      islandCount: this.infos.length,
      microgridCount: this.infos.reduce((n, i) => n + (i.microgrid ? 1 : 0), 0),
    };
  }

  private sample() {
    const m = this.snapshot.metrics;
    return {
      tMin: this.snapshot.tMin,
      supplyKW: m.supplyKW,
      demandKW: m.demandKW,
      allocatedKW: m.allocatedKW,
      criticalUnservedKW: m.criticalUnservedKW,
      prosumerKW: m.prosumerKW ?? 0,
    };
  }
}

function emptyMetrics(): Metrics {
  return {
    supplyKW: 0,
    demandKW: 0,
    allocatedKW: 0,
    servedPct: 100,
    criticalUnservedKW: 0,
    cumulativeDamage: 0,
    buildingsOffline: 0,
    cellsDestroyed: 0,
  };
}

export { START_HOUR };
