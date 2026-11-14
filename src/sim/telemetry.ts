/**
 * Telemetry dynamics for every utility agent — SPEC §6.2 / §6.3.
 *
 * The numbers are causal: casualties are created where cells are destroyed and flow to the nearest
 * working hospital; fire/quake incidents load the emergency stations; evacuees from hit houses walk to
 * the nearest live school; reservoirs drain when pumps lose power; towers see call surges, etc.
 * Everything here reads state from the previous step (servedFrac) and writes the agent's telemetry,
 * demand, minSafe, criticality, urgency and expected damage for the current step.
 */
import { HALF_D, HALF_W, START_HOUR, CELL, GRID_COLS } from '../core/constants';
import type { GridCell } from '../core/types';
import { KIND_PROFILES } from './profiles';
import { type AgentRuntime, cellDistM } from './agents';

const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

function interp(table: Array<[number, number]>, h: number): number {
  h = ((h % 24) + 24) % 24;
  for (let i = 1; i < table.length; i++) {
    if (h <= table[i][0]) {
      const [h0, v0] = table[i - 1];
      const [h1, v1] = table[i];
      return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
    }
  }
  return table[table.length - 1][1];
}
const HOUSE_CURVE: Array<[number, number]> = [[0, 0.55], [3, 0.4], [6, 0.5], [8, 0.75], [12, 0.6], [15, 0.65], [17, 0.8], [19, 1.0], [22, 0.95], [24, 0.55]];
const WATER_CURVE: Array<[number, number]> = [[0, 0.8], [6, 0.9], [8, 1], [12, 0.95], [17, 1], [21, 0.9], [24, 0.8]];
const TELECOM_CURVE: Array<[number, number]> = [[0, 0.12], [5, 0.08], [9, 0.25], [13, 0.28], [18, 0.34], [21, 0.3], [24, 0.14]];

export const hourOf = (tMin: number) => (START_HOUR + tMin / 60) % 24;

/** Demand (kW) of an agent at an hour of day given its current internal state. */
export function computeDemand(rt: AgentRuntime, hour: number): number {
  if (rt.down) return 0;
  const m = rt.m;
  const base = m.baseKW;
  switch (rt.s.kind) {
    case 'hospital': {
      const crisis = 1 + 0.25 * clamp((m.icu / m.icuBeds - 0.4) / 0.6) + 0.1 * clamp(m.inflowFast / 40);
      return base * 0.93 * crisis;
    }
    case 'emergency':
      return base * (0.7 + 0.3 * clamp(m.incidents / 6));
    case 'water':
      return base * (0.8 + 0.25 * (1 - m.reservoir / 100)) * interp(WATER_CURVE, hour);
    case 'telecom':
      return base * (0.65 + 0.35 * (m.load ?? 0.3));
    case 'school':
      return base * (0.35 + 0.65 * clamp(m.sheltered / m.capacity));
    case 'house':
      return hour >= 0 && m.evacUntil > m.nowMin ? 0 : base * interp(HOUSE_CURVE, hour);
  }
}

export interface TelemetryCtx {
  tMin: number;
  hour: number;
  cells: GridCell[];
  list: AgentRuntime[];
  newlyDestroyed: number[];
  newlyBurning: number[];
  disasterStarted: boolean;
  badCells: number[];
  badChanged: boolean;
  /** fraction of water stations that are serving (0..1), from last step */
  waterOk?: number;
}

interface Casualty {
  x: number;
  z: number;
  amount: number;
  t0: number;
}

export class TelemetryState {
  private casualties: Casualty[] = [];
  private roadDestroyed: number[] = [];
  private hospitals: AgentRuntime[] = [];
  private emergencies: AgentRuntime[] = [];
  private waters: AgentRuntime[] = [];
  private telecoms: AgentRuntime[] = [];
  private schools: AgentRuntime[] = [];
  private houses: AgentRuntime[] = [];
  private nbrs = new Map<string, number[]>();
  private incidentsIn = new Map<string, number>();

  init(list: AgentRuntime[], cells: GridCell[]): void {
    for (const a of list) {
      switch (a.s.kind) {
        case 'hospital': this.hospitals.push(a); break;
        case 'emergency': this.emergencies.push(a); break;
        case 'water': this.waters.push(a); break;
        case 'telecom': this.telecoms.push(a); break;
        case 'school': this.schools.push(a); break;
        case 'house': this.houses.push(a); break;
      }
    }
    // census: population per water station = occupants of the nearest houses
    for (const w of this.waters) w.m.popBase = 0;
    for (const h of this.houses) {
      let best = this.waters[0];
      let bd = Infinity;
      for (const w of this.waters) {
        const d = Math.hypot(w.x - h.x, w.z - h.z);
        if (d < bd) { bd = d; best = w; }
      }
      if (best) best.m.popBase += h.m.occupants;
      // 3×3 neighbourhood for evacuation checks
      const ids: number[] = [];
      for (const cid of h.b.cells) {
        const c = cid % GRID_COLS;
        const r = Math.floor(cid / GRID_COLS);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nc = c + dx, nr = r + dy;
            if (nc >= 0 && nr >= 0 && nc < GRID_COLS && nr < GRID_COLS) ids.push(nr * GRID_COLS + nc);
          }
      }
      this.nbrs.set(h.b.id, ids);
    }
    for (const a of list) a.m.nowMin = 0;
    void cells;
  }

  /** Update every agent for the current step. */
  update(ctx: TelemetryCtx): void {
    const { tMin, hour } = ctx;
    for (const a of ctx.list) a.m.nowMin = tMin;

    // 1. distance to the nearest non-ok cell (only when the damage picture changed)
    if (ctx.badChanged) {
      const nb = ctx.badCells.length;
      const bx = new Float64Array(nb);
      const bz = new Float64Array(nb);
      for (let i = 0; i < nb; i++) {
        const c = ctx.badCells[i];
        bx[i] = ((c % GRID_COLS) + 0.5) * CELL - HALF_W;
        bz[i] = (Math.floor(c / GRID_COLS) + 0.5) * CELL - HALF_D;
      }
      for (const a of ctx.list) {
        let best = 5000 * 5000;
        for (let i = 0; i < nb; i++) {
          const dx = bx[i] - a.x;
          const dz = bz[i] - a.z;
          const d = dx * dx + dz * dz;
          if (d < best) best = d;
        }
        a.impactM = Math.sqrt(best);
      }
    }

    // 2. impacts → casualty events and emergency incidents
    this.recordImpacts(ctx);

    // 3. per-kind dynamics
    const casRate = this.casualtyRates(ctx);
    for (const a of this.houses) this.updateHouse(a, ctx);
    for (const a of this.schools) this.updateSchool(a, ctx);
    for (const a of this.hospitals) this.updateHospital(a, ctx, casRate.get(a.b.id) ?? 0);
    for (const a of this.emergencies) this.updateEmergency(a, ctx);
    for (const a of this.waters) this.updateWater(a, ctx);
    for (const a of this.telecoms) this.updateTelecom(a, ctx);

    // 4. common bid fields
    for (const a of ctx.list) {
      const s = a.s;
      const prof = KIND_PROFILES[s.kind];
      s.demandKW = computeDemand(a, hour);
      s.minSafeKW = s.demandKW * prof.minSafeFrac;
      s.telemetry.distanceToImpactM = Math.round(a.impactM);
      if (a.down) s.urgency = 0;
      s.urgency = clamp(s.urgency);
      const m = a.m;
      let base = prof.damagePerHour;
      let pop = 1;
      switch (s.kind) {
        case 'hospital': pop = clamp(m.patients / 70, 0.7, 2) * ((s.telemetry.waterSupplyPct ?? 100) < 50 ? 1.5 : 1); break;
        case 'emergency': pop = clamp(1 + m.incidents / 6, 1, 2); break;
        case 'water': pop = clamp(this.waterPop(a) / 800, 0.5, 2.5); break;
        case 'telecom': pop = clamp(((m.load ?? 0.3) * 600) / 200, 0.5, 2); break;
        case 'school': base = 15 + 0.05 * m.sheltered; break;
        case 'house': base = m.medicalDevice ? 8 : 1; pop = m.occupants / 3; break;
      }
      s.expectedDamagePerHour = a.down ? 0 : base * (0.5 + s.urgency) * pop;
    }
    void tMin;
  }

  // ─────────────────────────── impacts ───────────────────────────

  private recordImpacts(ctx: TelemetryCtx): void {
    this.incidentsIn.clear();
    const { cells, tMin } = ctx;
    let amount = 0;
    let sx = 0, sz = 0, w = 0;
    let incidents = 0;
    let ix = 0, iz = 0, iw = 0;
    const add = (cid: number, kind: 'destroyed' | 'burning') => {
      const cell = cells[cid];
      if (cell.terrain === 'river') return;
      const cx = (cell.col + 0.5) * CELL - HALF_W;
      const cz = (cell.row + 0.5) * CELL - HALF_D;
      let c = 0;
      const bid = cell.buildingId;
      const occ = bid ? this.occupancyOf(bid, cell) : cell.terrain === 'road' || cell.terrain === 'bridge' ? 0.15 : cell.terrain === 'park' ? 0.03 : 0.05;
      c = kind === 'destroyed' ? occ * 0.5 : occ * 0.15;
      amount += c;
      sx += cx * (c + 0.01); sz += cz * (c + 0.01); w += c + 0.01;
      const inc = kind === 'destroyed' ? 0.3 : 0.5;
      incidents += inc;
      ix += cx * inc; iz += cz * inc; iw += inc;
      if (cell.terrain === 'road' || cell.terrain === 'bridge') if (kind === 'destroyed') this.roadDestroyed.push(cid);
    };
    for (const c of ctx.newlyDestroyed) add(c, 'destroyed');
    for (const c of ctx.newlyBurning) add(c, 'burning');
    if (w > 0 && amount > 0) this.casualties.push({ x: sx / w, z: sz / w, amount, t0: tMin });
    if (incidents > 0 && this.emergencies.length) {
      const px = ix / iw, pz = iz / iw;
      const live = this.emergencies.filter((e) => !e.down);
      const pool = live.length ? live : this.emergencies;
      let tw = 0;
      const ws = pool.map((e) => {
        const wgt = Math.exp(-Math.hypot(e.x - px, e.z - pz) / 350);
        tw += wgt;
        return wgt;
      });
      pool.forEach((e, i) => this.incidentsIn.set(e.b.id, (tw > 0 ? ws[i] / tw : 1 / pool.length) * incidents));
    }
    // keep memory bounded
    if (this.casualties.length > 60) this.casualties = this.casualties.filter((c) => tMin - c.t0 < 700);
  }

  private occupancyOf(buildingId: string, cell: GridCell): number {
    const a = this.houses.find((h) => h.b.id === buildingId); // houses are 1 cell; cheap enough (only on damage)
    if (a) return a.m.occupants;
    void cell;
    return 4; // staff / residents of a larger building, per cell
  }

  /** Casualty arrivals per minute for every live hospital. */
  private casualtyRates(ctx: TelemetryCtx): Map<string, number> {
    const out = new Map<string, number>();
    const live = this.hospitals.filter((h) => !h.down);
    if (live.length === 0) return out;
    for (const e of this.casualties) {
      const age = ctx.tMin - e.t0;
      const rate = (e.amount * Math.exp(-age / 90)) / 90;
      if (rate < 1e-4) continue;
      let tw = 0;
      const ws = live.map((h) => {
        const wgt = Math.exp(-Math.hypot(h.x - e.x, h.z - e.z) / 350);
        tw += wgt;
        return wgt;
      });
      live.forEach((h, i) => out.set(h.b.id, (out.get(h.b.id) ?? 0) + (rate * ws[i]) / tw));
    }
    return out;
  }

  // ─────────────────────────── per kind ───────────────────────────

  private updateHospital(a: AgentRuntime, ctx: TelemetryCtx, cas: number): void {
    const m = a.m;
    const s = a.s;
    const baseArr = m.patientsBase / 2400;
    const arrivals = baseArr + cas;
    m.patients = Math.max(0, m.patients + arrivals - m.patients / 2400);
    m.icu = clamp(m.icu + 0.3 * cas + m.icuBase / 1500 - m.icu / 1500, 0, m.icuBeds * 1.6);
    m.inflowFast += (arrivals * 60 - m.inflowFast) / 8;
    m.inflowSlow += (arrivals * 60 - m.inflowSlow) / 60;
    const growth = clamp(((m.inflowFast - m.inflowSlow) / Math.max(m.inflowSlow, 2)) * 100, -100, 500);
    const eff = a.down ? 0 : a.servedFrac;
    if (eff < 0.6) m.oxygenHours = Math.max(0, m.oxygenHours - ((1 - eff) * 2) / 60);
    else m.oxygenHours = Math.min(36, m.oxygenHours + 0.3 / 60);
    const fuel = s.backup.maxKW > 0 ? s.backup.remainingKWh / s.backup.maxKW : 0;
    const t = s.telemetry;
    t.patients = Math.round(m.patients);
    t.icuPatients = Math.round(m.icu);
    t.icuBeds = m.icuBeds;
    t.incomingPerHour = r1(m.inflowFast);
    t.inflowGrowthPctPerHour = Math.round(growth);
    t.ventilatorsInUse = Math.round(m.icu * 0.55 * (a.down ? 0 : 1));
    t.surgeriesActive = a.down ? 0 : Math.round(clamp(1 + m.inflowFast / 12, 0, 8));
    t.backupFuelHours = r1(fuel);
    t.oxygenHours = r1(m.oxygenHours);
    const wsp = s.telemetry.waterSupplyPct ?? 100; // sterilisation / dialysis need mains water (§4.5)
    s.urgency = Math.max(m.icu / m.icuBeds, 1 - fuel / 8, clamp(growth / 200), wsp < 50 ? 0.5 + (50 - wsp) / 100 : 0);
    s.criticality = KIND_PROFILES.hospital.criticality;
  }

  private updateEmergency(a: AgentRuntime, ctx: TelemetryCtx): void {
    const m = a.m;
    const s = a.s;
    const incoming = this.incidentsIn.get(a.b.id) ?? 0;
    m.incidents += incoming;
    const eff = a.down ? 0 : a.servedFrac;
    let roads = 0;
    for (const c of this.roadDestroyed) if (cellDistM(a.x, a.z, c, HALF_W, HALF_D) < 700) roads++;
    const roadPenalty = clamp(roads / 8, 0, 2);
    const cap = m.units * (0.4 + 0.6 * clamp(eff * 1.2));
    const deployed = a.down ? 0 : Math.min(cap, Math.ceil(m.incidents - 0.01));
    m.incidents = Math.max(0, m.incidents - deployed / (45 + 15 * roadPenalty));
    const fuel = s.backup.maxKW > 0 ? s.backup.remainingKWh / s.backup.maxKW : 0;
    const t = s.telemetry;
    t.activeIncidents = Math.round(m.incidents);
    t.unitsDeployed = Math.round(deployed);
    t.unitsAvailable = Math.max(0, Math.round(m.units - deployed));
    t.callsPerHour = r1(5 + 8 * m.incidents);
    t.avgResponseMin = r1(6 + 4 * roadPenalty + 5 * (m.incidents / m.units) + (eff < 0.5 ? 6 : 0));
    s.urgency = Math.max(clamp(m.incidents / (m.units * 1.5)), 1 - fuel / 8);
    void ctx;
  }

  private waterPop(a: AgentRuntime): number {
    const p = a.s.telemetry.pressureBar ?? 4.5;
    return a.m.popBase * clamp(p / 3);
  }

  private updateWater(a: AgentRuntime, ctx: TelemetryCtx): void {
    const m = a.m;
    const s = a.s;
    const eff = a.down ? 0 : a.servedFrac;
    const pumps = Math.round(3 * eff);
    const pf = pumps / 3;
    const draw = 0.22 * interp(WATER_CURVE, ctx.hour);
    m.reservoir = clamp(m.reservoir + pf * 0.4 - draw, 0, 100);
    // contamination: floods near the intake / pump house
    let near = 0;
    for (const c of ctx.badCells) {
      const cell = ctx.cells[c];
      if (cell.status === 'flooded' || cell.status === 'destroyed') {
        if (cellDistM(a.x, a.z, c, HALF_W, HALF_D) < 5 * CELL) { near = 1; break; }
      }
    }
    if (a.down) m.contamination = Math.min(1, m.contamination + 0.03);
    else if (near) m.contamination = Math.min(1, m.contamination + 0.01);
    else m.contamination = Math.max(0, m.contamination - 0.002);
    const pressure = pumps > 0 ? 4.5 * Math.pow(pf, 0.7) * (0.55 + 0.45 * m.reservoir / 100) : 0.8 * (m.reservoir / 100);
    const t = s.telemetry;
    t.pressureBar = r2(a.down ? 0 : pressure);
    t.pumpsRunning = pumps;
    t.reservoirPct = r1(m.reservoir);
    t.flowM3h = Math.round(900 * pf * (0.5 + 0.5 * m.reservoir / 100));
    t.populationServed = Math.round(a.down ? 0 : this.waterPop(a));
    t.contaminationRisk = r2(m.contamination);
    s.urgency = Math.max(1 - m.reservoir / 100, 0.7 * m.contamination);
  }

  private updateTelecom(a: AgentRuntime, ctx: TelemetryCtx): void {
    const m = a.m;
    const s = a.s;
    m.surge *= 0.985;
    if (ctx.disasterStarted) m.surge += 0.25;
    let near = 0;
    for (const c of ctx.newlyDestroyed) if (cellDistM(a.x, a.z, c, HALF_W, HALF_D) < 1200) near++;
    m.surge = clamp(m.surge + 0.004 * near, 0, 0.75);
    // neighbouring towers down → traffic shifts here
    let downNear = 0;
    for (const o of this.telecoms) if (o !== a && o.down && Math.hypot(o.x - a.x, o.z - a.z) < 250) downNear++;
    m.load = clamp(interp(TELECOM_CURVE, ctx.hour) + m.surge + 0.08 * downNear);
    const bk = s.backup;
    const battery = bk.capacityKWh > 0 ? bk.remainingKWh / bk.capacityKWh : 0;
    const powered = !a.down && (s.connected || a.backupDrawKW > 0 || a.servedFrac > 0.05);
    const t = s.telemetry;
    t.loadPct = Math.round(m.load * 100);
    t.activeConnections = a.down ? 0 : Math.round(600 * m.load * (powered ? 1 : 0.2));
    t.emergencyCallsPerMin = r1(m.load * 2 + m.surge * 6);
    t.batteryPct = Math.round(battery * 100);
    t.coverageKm2 = r2(powered ? 0.5 : 0);
    t.backhaulOk = powered ? 1 : 0;
    s.urgency = Math.max(m.load, 1 - battery);
  }

  private updateSchool(a: AgentRuntime, ctx: TelemetryCtx): void {
    const m = a.m;
    const s = a.s;
    if (a.down && (m.sheltered > 0 || m.pending > 0)) {
      // building lost → evacuees move on to the nearest other live school
      const alt = this.nearestSchool(a.x, a.z, a);
      if (alt) alt.m.pending += m.sheltered + m.pending;
      m.sheltered = 0;
      m.pending = 0;
    }
    const arrivals = a.down ? 0 : m.pending * 0.06;
    m.pending -= arrivals;
    m.sheltered += arrivals;
    m.inflowEma += (arrivals * 60 - m.inflowEma) / 10;
    const waterOk = (s.telemetry.waterSupplyPct ?? (ctx.waterOk ?? 1) * 100) / 100;
    m.waterL = clamp(m.waterL - m.sheltered * 0.05 + 6 * waterOk, 0, 5000);
    m.medical = m.sheltered * 0.03 + m.medical * 0.0;
    const t = s.telemetry;
    t.sheltered = Math.round(m.sheltered);
    t.capacity = m.capacity;
    t.inflowPerHour = r1(m.inflowEma);
    t.medicalCases = Math.round(m.medical);
    t.waterLiters = Math.round(m.waterL);
    const frac = clamp(m.sheltered / m.capacity);
    s.criticality = 0.55 + 0.25 * clamp(m.sheltered / (0.5 * m.capacity));
    s.urgency = Math.max(frac, clamp(m.medical / 25), m.sheltered > 0 ? 1 - m.waterL / 2500 : 0);
  }

  private nearestSchool(x: number, z: number, exclude?: AgentRuntime): AgentRuntime | undefined {
    let best: AgentRuntime | undefined;
    let bd = Infinity;
    for (const sc of this.schools) {
      if (sc === exclude || sc.down) continue;
      const d = Math.hypot(sc.x - x, sc.z - z);
      if (d < bd) { bd = d; best = sc; }
    }
    return best;
  }

  private updateHouse(a: AgentRuntime, ctx: TelemetryCtx): void {
    const m = a.m;
    const s = a.s;
    const ids = this.nbrs.get(a.b.id)!;
    let permanent = false;
    let flooded = false;
    for (const id of ids) {
      const st = ctx.cells[id].status;
      if (st === 'destroyed' || st === 'burning') { permanent = true; break; }
      if (st === 'flooded') flooded = true;
    }
    if (permanent) m.evacUntil = 1e9;
    else if (flooded) m.evacUntil = Math.max(m.evacUntil, ctx.tMin + 90);
    const evacuated = ctx.tMin < m.evacUntil;
    if (evacuated && m.evacCounted === 0) {
      m.evacCounted = 1;
      const sc = this.nearestSchool(a.x, a.z);
      if (sc) sc.m.pending += m.occupants;
    } else if (!evacuated && m.evacCounted === 1) m.evacCounted = 0;
    const bk = s.backup;
    const battery = bk.capacityKWh > 0 ? (bk.remainingKWh / bk.capacityKWh) * 100 : 0;
    const powered = a.servedFrac > 0.5 && !a.down;
    const t = s.telemetry;
    t.occupants = m.occupants;
    t.medicalDevice = m.medicalDevice;
    t.batteryPct = Math.round(battery);
    t.evacuated = evacuated ? 1 : 0;
    t.emergencyRequestsPerHour = evacuated ? 0 : m.medicalDevice && !powered ? (battery > 5 ? 0.3 : 2.5) : 0.02;
    s.criticality = m.medicalDevice ? 0.7 : 0.25;
    s.urgency = evacuated || a.down ? 0 : m.medicalDevice ? (a.servedFrac < 0.99 ? 0.5 + 0.5 * (1 - battery / 100) : 0.35) : 0.1 + 0.2 * (1 - a.servedFrac);
  }
}
