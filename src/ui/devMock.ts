/** Mock engine + world for developing the UI without the real sim/render. Dev only. */
import { START_HOUR } from '../core/constants';
import { Emitter } from '../core/events';
import type {
  Building,
  BuildingKind,
  BuildingStatus,
  DisasterEvent,
  DisasterKind,
  DisasterParams,
  EngineEvents,
  IslandInfo,
  LogEntry,
  PowerEdge,
  SimSnapshot,
  UtilityAgentState,
} from '../core/types';
import { MockNeg } from './devMockNeg';
import type { EngineLike, LayerName, WorldEvents, WorldLike } from './contracts';

const rnd = (() => {
  let s = 7;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
})();

const SPEC: Record<string, { n: number; w: number; names: string[] }> = {
  generator: { n: 2, w: 0, names: ['Westbank Thermal Plant', 'Eastbank Solar Farm'] },
  substation: { n: 6, w: 0, names: [] },
  hospital: { n: 3, w: 1800, names: ['Riverside General Hospital', 'St. Mary Medical', 'Eastbank Clinic'] },
  emergency: { n: 3, w: 280, names: ['Station 1 - Fire & Rescue', 'Station 2 - Fire & Rescue', 'Station 3 - Ambulance'] },
  water: { n: 3, w: 750, names: ['Northside Pump Station', 'Hilltop Water Tower', 'River Intake Works'] },
  telecom: { n: 8, w: 22, names: [] },
  school: { n: 4, w: 160, names: ['Oakridge School (Shelter)', 'Maple Primary (Shelter)', 'Union High (Shelter)', 'Cedar School (Shelter)'] },
  house: { n: 24, w: 4.5, names: [] },
};

function teleFor(kind: BuildingKind): Record<string, number> {
  switch (kind) {
    case 'hospital':
      return { waterPressureBar: 3.8, waterSupplyPct: 92, patients: 120, icuPatients: 14, icuBeds: 24, incomingPerHour: 6, inflowGrowthPctPerHour: 4, ventilatorsInUse: 9, surgeriesActive: 2, distanceToImpactM: 1400, backupFuelHours: 8, oxygenHours: 36 };
    case 'emergency':
      return { waterPressureBar: 3.9, waterSupplyPct: 95, activeIncidents: 2, unitsDeployed: 3, unitsAvailable: 5, callsPerHour: 12, avgResponseMin: 7, distanceToImpactM: 900 };
    case 'water':
      return { flowM3h: 420, reservoirPct: 0.82, pressureBar: 4.1, pumpsRunning: 3, populationServed: 18000, contaminationRisk: 0.05 };
    case 'telecom':
      return { waterPressureBar: 4, waterSupplyPct: 100, activeConnections: 1800, loadPct: 0.4, emergencyCallsPerMin: 2, batteryPct: 1, coverageKm2: 4.2, backhaulOk: 1 };
    case 'school':
      return { waterPressureBar: 3.6, waterSupplyPct: 88, sheltered: 40, capacity: 400, inflowPerHour: 10, medicalCases: 1, waterLiters: 1200 };
    default:
      return { waterPressureBar: 3.5, waterSupplyPct: 90, occupants: 3, medicalDevice: 0, batteryPct: 0, emergencyRequestsPerHour: 0, evacuated: 0 };
  }
}

export class MockEngine extends Emitter<{ [K in keyof EngineEvents]: EngineEvents[K] }> implements EngineLike {
  snapshot: SimSnapshot;
  private acc = 0;
  private events: { at: number; kind: DisasterKind; params: DisasterParams }[] = [];
  private evCount = 0;
  private neg = new MockNeg();
  policy = 'negotiation';
  validator = 'safety';

  constructor() {
    super();
    this.snapshot = this.make();
    this.snapshot.speed = 10;
  }

  private make(): SimSnapshot {
    const buildings: Record<string, Building> = {};
    const agents: Record<string, UtilityAgentState> = {};
    const gens: SimSnapshot['generators'] = {};
    const subs: string[] = [];
    const consumers: string[] = [];
    for (const [kind, sp] of Object.entries(SPEC)) {
      for (let i = 0; i < sp.n; i++) {
        const id = `${kind}-${i}`;
        const name = sp.names[i] ?? (kind === 'substation' ? `Substation S${i + 1}` : kind === 'telecom' ? `Tower T-${String(i + 1).padStart(2, '0')}` : `House ${i + 1}`);
        buildings[id] = { id, kind: kind as BuildingKind, name, col: Math.floor(rnd() * 44), row: Math.floor(rnd() * 44), w: 1, d: 1, rotation: 0, variant: 0, cells: [], nodeId: `n-${id}`, status: 'online' };
        if (kind === 'substation') subs.push(id);
        else if (kind === 'generator') gens[id] = { buildingId: id, capacityKW: i === 0 ? 14000 : 9000, outputKW: i === 0 ? 11000 : 6000, fuelHours: i === 0 ? 40 : Infinity, status: 'running' };
        else {
          consumers.push(id);
          if ((kind === 'house' && i % 3 === 0) || kind === 'school') {
            const campus = kind === 'school';
            buildings[id].prosumer = { kind: campus ? 'campus' : 'rooftop', solarKWp: campus ? 90 : 4 + (i % 4), batteryKWh: campus ? 200 : 10, batteryMaxKW: campus ? 60 : 3, survivalKW: campus ? 24 : 0.5 };
          }
          const demand = sp.w * (0.85 + rnd() * 0.3);
          const backup = kind === 'hospital' ? { type: 'diesel' as const, capacityKWh: 6000, remainingKWh: 4200, maxKW: 600 } : kind === 'telecom' ? { type: 'battery' as const, capacityKWh: 60, remainingKWh: 60, maxKW: 15 } : kind === 'emergency' ? { type: 'diesel' as const, capacityKWh: 960, remainingKWh: 900, maxKW: 120 } : { type: 'none' as const, capacityKWh: 0, remainingKWh: 0, maxKW: 0 };
          agents[id] = {
            buildingId: id,
            kind: kind as UtilityAgentState['kind'],
            demandKW: demand,
            minSafeKW: demand * (kind === 'hospital' ? 0.45 : kind === 'house' ? 0.1 : 0.4),
            criticality: kind === 'hospital' ? 1 : kind === 'emergency' ? 0.9 : kind === 'water' ? 0.85 : kind === 'telecom' ? 0.8 : kind === 'school' ? 0.55 : 0.25,
            urgency: rnd() * 0.5,
            expectedDamagePerHour: kind === 'hospital' ? 100 : kind === 'house' ? 1 : 40,
            allocatedKW: demand,
            connected: true,
            backup,
            telemetry: teleFor(kind as BuildingKind),
            tokens: 100,
          };
        }
      }
    }
    agents['water-0'].dependents = ['hospital-0', 'school-0', 'hospital-1'];
    agents['water-0'].storage = { kind: 'reservoir', socPct: 82, chargeKW: 40 };
    agents['telecom-0'].storage = { kind: 'battery', socPct: 100, chargeKW: 4 };
    agents['hospital-0'].storage = { kind: 'diesel', socPct: 70, chargeKW: 0 };
    const edges: Record<string, PowerEdge> = {};
    const feeders: SimSnapshot['network']['feeders'] = [];
    let e = 0;
    consumers.forEach((cid, i) => {
      const sid = subs[i % subs.length];
      const ids: string[] = [];
      for (let k = 0; k < 3 + (i % 4); k++) {
        const eid = `e${e++}`;
        edges[eid] = { id: eid, from: 'a', to: 'b', tier: 'distribution', cells: [], capacityKW: 1500, status: 'ok', flowKW: 100 };
        ids.push(eid);
      }
      feeders.push({ substationId: sid, consumerId: cid, edgeIds: ids });
    });
    return {
      tMin: 0,
      running: false,
      speed: 10,
      cells: [],
      buildings,
      agents,
      generators: gens,
      network: { nodes: {}, edges, transmission: {}, feeders },
      water: { nodes: {}, pipes: {}, services: {} },
      disasters: [],
      metrics: { supplyKW: 0, demandKW: 0, allocatedKW: 0, servedPct: 1, criticalUnservedKW: 0, cumulativeDamage: 0, buildingsOffline: 0, cellsDestroyed: 0 },
      history: [],
      log: [],
    };
  }

  timeOfDay() {
    return (START_HOUR + this.snapshot.tMin / 60) % 24;
  }
  play() {
    this.snapshot.running = true;
  }
  pause() {
    this.snapshot.running = false;
  }
  setSpeed(v: number) {
    this.snapshot.speed = v;
  }
  reset() {
    const run = this.snapshot.running;
    const sp = this.snapshot.speed;
    this.neg.reset();
    this.snapshot = this.make();
    this.snapshot.running = run;
    this.snapshot.speed = sp;
    this.events = [];
    this.emit('reset', this.snapshot);
    this.emit('tick', this.snapshot);
  }
  loadScenario(id: string) {
    this.reset();
    this.log('info', `Scenario loaded: ${id}`);
    if (id !== 'quiet-night') this.events.push({ at: 40, kind: id === 'earthquake' ? 'earthquake' : 'flood', params: { col: 20, row: 20, intensity: 0.7, radius: 8 } });
  }
  trigger(kind: DisasterKind, params: DisasterParams): DisasterEvent {
    const s = this.snapshot;
    const ev: DisasterEvent = { id: `d${this.evCount++}`, kind, startMin: s.tMin, durationMin: kind === 'earthquake' ? 0 : kind === 'flood' ? 360 : 180, params, affected: [], active: true };
    s.disasters.push(ev);
    this.log('crit', `${kind.replace('_', ' ')} started${params.col != null ? ` at (${params.col}, ${params.row})` : ''}`);
    // destroy a few buildings nearby
    for (const b of Object.values(s.buildings)) {
      if (b.kind === 'generator' || b.kind === 'substation') continue;
      const d = params.col != null ? Math.hypot(b.col - params.col!, b.row - params.row!) : 99;
      if (d < (params.radius ?? 6) * 0.7 && rnd() < (params.intensity ?? 0.5)) {
        b.status = 'destroyed';
        this.log('crit', `${b.name} destroyed`, b.id);
      }
    }
    if (kind === 'grid_fault' && params.targetId && s.generators[params.targetId]) {
      s.generators[params.targetId].status = 'tripped';
      this.log('crit', `${s.buildings[params.targetId].name} tripped offline`, params.targetId);
    }
    this.emit('disaster', ev);
    return ev;
  }
  step() {
    this.advance(1);
    this.emit('tick', this.snapshot);
  }
  /** Advance by whole minutes without emitting (used for prefill). */
  advance(mins: number) {
    for (let i = 0; i < mins; i++) this.tick1();
  }
  update(dt: number) {
    if (!this.snapshot.running) return;
    this.acc += dt * this.snapshot.speed;
    const whole = Math.floor(this.acc);
    if (whole < 1) return;
    this.acc -= whole;
    this.advance(whole);
    this.emit('tick', this.snapshot);
  }

  private log(level: LogEntry['level'], msg: string, buildingId?: string) {
    const e: LogEntry = { tMin: this.snapshot.tMin, level, msg, buildingId };
    this.snapshot.log.push(e);
    if (this.snapshot.log.length > 200) this.snapshot.log.shift();
    this.emit('log', e);
  }

  /** Prosumer DER, utility buffers, dependents and islands (docs/MICROGRID.md). */
  private microgrid(s: SimSnapshot, hour: number) {
    const sun = hour >= 6 && hour <= 18 ? Math.sin(((hour - 6) / 12) * Math.PI) : 0;
    const t = s.tMin;
    let houseOff = 0;
    let houseCurt = 0;
    let schoolOff = 0;
    let schoolCurt = 0;
    const houseIds: string[] = [];
    const schoolIds: string[] = [];
    for (const a of Object.values(s.agents)) {
      const sp = s.buildings[a.buildingId].prosumer;
      if (!sp) continue;
      const solar = sp.solarKWp * sun * (0.9 + 0.1 * Math.sin(t / 9 + sp.solarKWp));
      const bat = Math.max(0.05, Math.min(1, 0.65 + 0.3 * Math.sin((hour - 9) / 24 * Math.PI * 2)));
      const gen = solar + (bat > 0.2 ? sp.batteryMaxKW * 0.2 : 0);
      const self = Math.min(gen, sp.survivalKW);
      const offered = Math.max(0, gen - sp.survivalKW);
      const curt = offered * (sp.kind === 'campus' ? 0.2 : 0.1) * (sun > 0.8 ? 1 : 0.3);
      a.der = { solarKW: solar, batteryKWh: sp.batteryKWh * bat, batteryPct: bat, generationKW: gen, selfSupplyKW: self, offeredKW: offered, exportedKW: offered - curt, curtailedKW: curt };
      a.telemetry.solarKW = solar;
      a.telemetry.exportKW = offered - curt;
      a.telemetry.curtailedKW = curt;
      if (sp.kind === 'campus') {
        schoolOff += offered;
        schoolCurt += curt;
        schoolIds.push(a.buildingId);
      } else {
        houseOff += offered;
        houseCurt += curt;
        houseIds.push(a.buildingId);
      }
    }
    const sunny = sun > 0.05;
    for (const a of Object.values(s.agents)) {
      if (!a.storage) continue;
      const st = a.storage;
      if (st.kind === 'reservoir') {
        st.chargeKW = sunny ? 40 : 25;
        st.socPct = Math.max(5, Math.min(100, st.socPct + (a.allocatedKW >= a.demandKW - 0.5 ? 0.03 : -0.06)));
        a.telemetry.chargeKW = st.chargeKW;
        a.telemetry.bufferPct = st.socPct;
      } else if (st.kind === 'battery') {
        st.chargeKW = st.socPct < 99.5 ? 4 : 0;
        a.telemetry.chargeKW = st.chargeKW;
        a.telemetry.bufferPct = st.socPct;
      }
    }
    const w = s.agents['water-0'];
    if (w?.dependents) {
      w.dependentDamagePerHour = w.dependents.reduce((n, id) => n + (s.agents[id]?.expectedDamagePerHour ?? 0) * (id.startsWith('hospital') ? 0.5 : 0.3), 0);
      w.telemetry.dependentDamagePerHour = w.dependentDamagePerHour;
    }
    const g0 = s.generators['generator-0'];
    const g1 = s.generators['generator-1'];
    const mk = (id: number, gens: string[], util: number, offered: number, curt: number, limitF: number, cons: string[], pros: string[], microgrid: boolean): IslandInfo => {
      const prosumerKW = offered - curt;
      const lineLimitKW = Math.max(1, (util + prosumerKW) * limitF);
      return { id, generatorIds: gens, substationIds: [`substation-${id}`], consumerIds: cons, prosumerIds: pros, microgrid, utilityDerKW: util, prosumerOfferedKW: offered, prosumerKW, curtailedKW: curt, lineLimitKW, supplyKW: Math.min(util + prosumerKW, lineLimitKW), demandKW: cons.reduce((n, c) => n + (s.agents[c]?.demandKW ?? 0), 0) };
    };
    const ids = Object.keys(s.agents);
    s.islands = [
      mk(0, ['generator-0'], g0?.outputKW ?? 0, schoolOff, schoolCurt, 0.97, ids.filter((_, i) => i % 3 !== 2), schoolIds, false),
      mk(1, [], 0, houseOff, houseCurt, 1, ids.filter((_, i) => i % 3 === 2).slice(0, 12), houseIds, true),
      mk(2, ['generator-1'], g1?.outputKW ?? 0, 0, 0, 1.05, ids.slice(-4), [], false),
    ];
  }

  private tick1() {
    const s = this.snapshot;
    s.tMin++;
    for (const ev of this.events.filter((x) => x.at === s.tMin)) this.trigger(ev.kind, ev.params);
    for (const d of s.disasters) if (d.active && d.durationMin > 0 && s.tMin - d.startMin > d.durationMin) d.active = false;
    const t = s.tMin;
    const hour = (START_HOUR + t / 60) % 24;
    let supply = 0;
    for (const g of Object.values(s.generators)) {
      if (g.status === 'running') {
        const solar = g.fuelHours === Infinity;
        g.outputKW = g.capacityKW * (solar ? Math.max(0, Math.cos(((hour - 13) / 24) * Math.PI * 2)) * 0.7 : 0.78 + Math.sin(t / 7) * 0.03);
        if (!solar) g.fuelHours = Math.max(0, g.fuelHours - 1 / 60);
      } else g.outputKW = 0;
      supply += g.outputKW;
    }
    const active = s.disasters.filter((d) => d.active).length;
    supply *= 1 - Math.min(0.5, active * 0.18);
    let demand = 0;
    const evening = 1 + 0.35 * Math.max(0, Math.sin(((hour - 15) / 7) * Math.PI));
    for (const a of Object.values(s.agents)) {
      const b = s.buildings[a.buildingId];
      const base = (a.minSafeKW / (a.kind === 'house' ? 0.1 : a.kind === 'hospital' ? 0.45 : 0.4)) / (a.kind === 'house' ? evening : 1);
      a.demandKW = b.status === 'destroyed' ? 0 : base * (a.kind === 'house' ? evening : 1);
      demand += a.demandKW;
    }
    const ratio = demand > 0 ? Math.min(1, supply / demand) : 1;
    let alloc = 0;
    let crit = 0;
    let off = 0;
    for (const a of Object.values(s.agents)) {
      const b = s.buildings[a.buildingId];
      if (b.status === 'destroyed') {
        a.allocatedKW = 0;
        off++;
        continue;
      }
      const prio = a.criticality > 0.5 ? Math.min(1, ratio * 1.25) : ratio * 0.85;
      a.allocatedKW = a.demandKW * prio;
      a.connected = true;
      alloc += a.allocatedKW;
      crit += Math.max(0, a.minSafeKW - a.allocatedKW);
      const frac = a.allocatedKW / Math.max(1e-6, a.demandKW);
      let st: BuildingStatus = frac >= 0.99 ? 'online' : frac >= a.minSafeKW / Math.max(1e-6, a.demandKW) ? 'brownout' : a.backup.remainingKWh > 0 ? 'backup' : 'offline';
      b.status = st;
      if (st === 'backup') a.backup.remainingKWh = Math.max(0, a.backup.remainingKWh - a.backup.maxKW / 60);
      a.urgency = Math.min(1, Math.max(0, 1 - frac) * 1.3 + 0.1 + (active ? 0.25 : 0) * a.criticality + Math.sin(t / 30 + a.criticality * 9) * 0.05);
      a.expectedDamagePerHour = (a.kind === 'hospital' ? 100 : a.kind === 'house' ? 1 : 40) * (0.5 + a.urgency);
      s.metrics.cumulativeDamage += (a.expectedDamagePerHour * (1 - Math.min(1, frac))) / 60;
      // telemetry wobble
      const T = a.telemetry;
      for (const k of Object.keys(T)) {
        if (k === 'waterSupplyPct') { T[k] = Math.min(100, Math.max(0, T[k] + (rnd() - 0.5) * 2)); continue; }
        if (k === 'backhaulOk' || k === 'medicalDevice' || k === 'evacuated') continue;
        if (k.endsWith('Pct') && T[k] <= 1) T[k] = Math.min(1, Math.max(0, T[k] + (rnd() - 0.5) * 0.02 - (k === 'reservoirPct' || k === 'batteryPct' ? (1 - frac) * 0.004 : 0)));
        else T[k] = Math.max(0, T[k] + (rnd() - 0.45) * (Math.abs(T[k]) * 0.02 + 0.2) * (1 + active));
      }
    }
    this.microgrid(s, hour);
    for (const b of Object.values(s.buildings)) if (b.kind === 'substation') b.status = 'online';
    for (const g of Object.values(s.generators)) s.buildings[g.buildingId].status = g.status === 'running' ? 'online' : 'offline';
    if (active) {
      const eids = Object.keys(s.network.edges);
      for (let i = 0; i < Math.min(eids.length, 6); i++) s.network.edges[eids[(t * 3 + i * 17) % eids.length]].status = t % 40 < 20 ? 'broken' : 'ok';
    }
    Object.assign(s.metrics, { supplyKW: supply, demandKW: demand, allocatedKW: alloc, servedPct: demand ? alloc / demand : 1, criticalUnservedKW: crit, buildingsOffline: off });
    const exported = s.islands!.reduce((n, i) => n + i.prosumerKW, 0);
    s.metrics.prosumerKW = exported;
    s.metrics.curtailedKW = s.islands!.reduce((n, i) => n + i.curtailedKW, 0);
    s.metrics.islandCount = s.islands!.length;
    s.metrics.microgridCount = s.islands!.filter((i) => i.microgrid).length;
    if (t % 5 === 0) {
      s.history.push({ tMin: t, supplyKW: supply, demandKW: demand, allocatedKW: alloc, criticalUnservedKW: crit, prosumerKW: exported });
      if (s.history.length > 1440) s.history.shift();
    }
    const ns = this.neg.update(s);
    s.negotiation = this.policy === 'negotiation' ? ns.negotiation : undefined;
    s.safety = this.validator === 'safety' ? ns.safety : undefined;
    if (t % 45 === 0) this.log('info', `Evening demand ${(demand / 1000).toFixed(1)} MW, supply ${(supply / 1000).toFixed(1)} MW`);
    if (crit > 50 && t % 20 === 0) this.log('warn', 'Critical load below minimum safe level', 'hospital-0');
  }
}

export class MockWorld extends Emitter<WorldEvents> implements WorldLike {
  mode: 'select' | 'cell' = 'select';
  layers: Record<string, boolean> = {};
  setPickMode(m: 'select' | 'cell') {
    this.mode = m;
    document.body.style.cursor = m === 'cell' ? 'crosshair' : '';
  }
  setLayer(name: LayerName, on: boolean) {
    this.layers[name] = on;
  }
  focus(id: string) {
    console.info('[mock world] focus', id);
  }
  select(id: string | null) {
    console.info('[mock world] select', id);
  }
}
