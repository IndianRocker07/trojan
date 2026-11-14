/**
 * Prosumer-enabled, topology-aware microgrid model — docs/MICROGRID.md §1–§3 (pure TypeScript, no DOM).
 *
 * Per step the engine calls, in this order:
 *   prepareProsumer(a, …)      for every prosumer       (solar, p_min self-supply, battery capability; before islands)
 *   topo.refreshReach()                                  (live stretch of every feeder chain; after computeIslands)
 *   topo.planIsland(isl, …)    for every island          (battery charging / export discharge, offers, line limit)
 *   topo.curtail()                                       (per-edge export curtailment along the feeder paths)
 *   topo.buildInfo(isl, plan)  for every island          (IslandInfo incl. P_total) → handed to policy / validator
 *   … allocation …
 *   topo.dispatch(info, A, …)                            (prosumer exports FIRST, generators cover the rest)
 *   finalizeProsumer(a)                                  (battery SoC accounting, DER state, telemetry)
 *   topo.netFlows(…)                                     (bidirectional edge flows)
 */
import type { Building, IslandInfo, PowerEdge, PowerNetwork, UtilityAgentState } from '../core/types';
import { GRID_COLS } from '../core/constants';
import type { Rng } from '../core/rng';
import type { AgentRuntime } from './agents';
import type { Island } from './powerNetwork';

/** Distribution edges may carry at most this fraction of their rating of prosumer export (inverters curtail instead of tripping). */
export const EXPORT_MARGIN = 0.97;
/** A prosumer battery exports only above this SoC; it covers its own p_min down to the survival floor. */
export const EXPORT_SOC_FLOOR = 0.2;
export const SURVIVAL_SOC_FLOOR = 0.1;

const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);

/** Normalised sun height, 0 at night. Same curve as the utility solar farm. */
export const daylight = (h: number) => (h >= 6 && h <= 19 ? Math.sin(((h - 6) / 13) * Math.PI) : 0);

const ZONES = 9; // 3 × 3 cloud "districts"
export const cloudZone = (col: number, row: number) => Math.min(2, Math.floor((col / GRID_COLS) * 3)) + 3 * Math.min(2, Math.floor((row / GRID_COLS) * 3));

interface TransLink {
  nodeA: string;
  nodeB: string;
  edges: PowerEdge[];
  capacityKW: number;
}

interface CurtailEdge {
  edge: PowerEdge;
  depth: number;
  pros: AgentRuntime[];
}

/** Result of planning one island (before IslandInfo is assembled). */
export interface IslandPlan {
  pros: AgentRuntime[];
  utilityDerKW: number; // Σ running generator output
  genDeliverKW: number; // min(utility DER, line limit): what the surviving lines can carry from generators
  lineLimitGenKW: number;
  netDemandKW: number;
}

export class MicrogridTopology {
  /** consumer building id → edges of its feeder chain, substation → … → service drop */
  readonly feederEdges = new Map<string, PowerEdge[]>();
  /** consumer building id → its substation building id */
  readonly substationOf = new Map<string, string>();
  private feederList: Array<{ consumerId: string; substationId: string; edges: PowerEdge[]; idx: Int32Array }> = [];
  private feederReach: Int32Array = new Int32Array(0);
  private edgeIndex = new Map<string, number>();
  private edgeList: PowerEdge[] = [];
  readonly prosumers: AgentRuntime[] = [];
  private proFeeder: number[] = []; // prosumer index → feederList index
  private subLinks = new Map<string, TransLink[]>(); // substation building id → transmission links ending there
  private subRoots = new Map<string, PowerEdge[]>(); // substation building id → its feeder-root distribution edges
  private curtailEdges: CurtailEdge[] = [];
  /** per-district slow cloud phases (seeded) */
  private cloudA: number[] = [];
  private cloudB: number[] = [];
  private cloudP: number[] = [];

  constructor(net: PowerNetwork, buildings: Record<string, Building>, list: AgentRuntime[], rng: Rng) {
    this.edgeList = Object.values(net.edges);
    this.edgeList.forEach((e, i) => this.edgeIndex.set(e.id, i));
    for (const f of net.feeders) {
      const edges = f.edgeIds.map((id) => net.edges[id]);
      this.feederEdges.set(f.consumerId, edges);
      this.substationOf.set(f.consumerId, f.substationId);
      this.feederList.push({ consumerId: f.consumerId, substationId: f.substationId, edges, idx: Int32Array.from(f.edgeIds.map((id) => this.edgeIndex.get(id)!)) });
    }
    this.feederReach = new Int32Array(this.feederList.length);
    for (const a of list) if (a.plan) this.prosumers.push(a);
    const feederOf = new Map<string, number>();
    this.feederList.forEach((f, i) => feederOf.set(f.consumerId, i));
    this.proFeeder = this.prosumers.map((a) => feederOf.get(a.b.id) ?? -1);

    // cloud phases
    for (let z = 0; z < ZONES; z++) {
      this.cloudA.push(rng.range(0, 6.283));
      this.cloudB.push(rng.range(0, 6.283));
      this.cloudP.push(rng.range(0, 1));
    }
    for (const a of this.prosumers) a.plan!.zone = cloudZone(a.b.col, a.b.row);

    // transmission links (chains of edges through pylons between two building nodes)
    const tEdgesAt = new Map<string, PowerEdge[]>();
    for (const e of this.edgeList) {
      if (e.tier !== 'transmission') continue;
      for (const n of [e.from, e.to]) {
        if (!tEdgesAt.has(n)) tEdgesAt.set(n, []);
        tEdgesAt.get(n)!.push(e);
      }
    }
    for (const [nid, es] of tEdgesAt) {
      const n = net.nodes[nid];
      if (n.kind === 'pylon') continue;
      for (const first of es) {
        const edges = [first];
        let prev = nid;
        let cur = first.from === nid ? first.to : first.from;
        let guard = 0;
        while (net.nodes[cur].kind === 'pylon' && guard++ < 200) {
          const next = tEdgesAt.get(cur)!.find((x) => x !== edges[edges.length - 1])!;
          edges.push(next);
          prev = cur;
          cur = next.from === prev ? next.to : next.from;
        }
        if (nid >= cur) continue; // record each link once
        const link: TransLink = { nodeA: nid, nodeB: cur, edges, capacityKW: Math.min(...edges.map((x) => x.capacityKW)) };
        for (const end of [nid, cur]) {
          const b = net.nodes[end].buildingId;
          if (!b || buildings[b]?.kind !== 'substation') continue;
          if (!this.subLinks.has(b)) this.subLinks.set(b, []);
          this.subLinks.get(b)!.push(link);
        }
      }
    }
    // feeder roots
    for (const e of this.edgeList) {
      if (e.tier !== 'distribution') continue;
      const n = net.nodes[e.from];
      if (n.kind !== 'substation' || !n.buildingId) continue;
      if (!this.subRoots.has(n.buildingId)) this.subRoots.set(n.buildingId, []);
      this.subRoots.get(n.buildingId)!.push(e);
    }
    // edges with prosumers beneath them, deepest first (curtailment order)
    const byEdge = new Map<string, CurtailEdge>();
    for (const a of this.prosumers) {
      const chain = this.feederEdges.get(a.b.id);
      if (!chain) continue;
      chain.forEach((edge, depth) => {
        let ce = byEdge.get(edge.id);
        if (!ce) {
          ce = { edge, depth, pros: [] };
          byEdge.set(edge.id, ce);
        }
        ce.pros.push(a);
      });
    }
    this.curtailEdges = [...byEdge.values()].sort((x, y) => y.depth - x.depth || (x.edge.id < y.edge.id ? -1 : 1));
  }

  // ───────────────────── solar / cloud ─────────────────────

  cloudFactor(zone: number, tMin: number): number {
    const w = 0.6 * Math.sin((2 * Math.PI * tMin) / (140 + 13 * zone) + this.cloudA[zone]) + 0.4 * Math.sin((2 * Math.PI * tMin) / (47 + 5 * zone) + this.cloudB[zone]);
    return clamp(1 - 0.3 * clamp(w * 0.8 + 0.2 * (this.cloudP[zone] - 0.5), 0, 1), 0.65, 1);
  }

  // ───────────────────── topology liveness ─────────────────────

  /** Live stretch of every feeder chain: reach = lowest index k with edges k..last all ok (= length when the drop is broken). */
  refreshReach(): void {
    for (let i = 0; i < this.feederList.length; i++) {
      const edges = this.feederList[i].edges;
      let r = edges.length;
      for (let k = edges.length - 1; k >= 0; k--) {
        if (edges[k].status !== 'ok') break;
        r = k;
      }
      this.feederReach[i] = r;
    }
    this.prosumers.forEach((a, i) => (a.plan!.reach = this.proFeeder[i] >= 0 ? this.feederReach[this.proFeeder[i]] : 0));
  }

  /** Σ over the island's substations of min(live transmission capacity in, feeder-root capacity). Generator power only. */
  private genLineLimit(isl: Island): number {
    let total = 0;
    for (const sid of isl.substationIds) {
      let tin = 0;
      for (const l of this.subLinks.get(sid) ?? []) {
        let ok = true;
        for (const e of l.edges) if (e.status !== 'ok') { ok = false; break; }
        if (ok) tin += l.capacityKW;
      }
      let root = 0;
      for (const e of this.subRoots.get(sid) ?? []) if (e.status === 'ok') root += e.capacityKW;
      total += Math.min(tin, root);
    }
    return total;
  }

  // ───────────────────── island supply ─────────────────────

  /** Resets the per-step offers of every prosumer (those outside any island offer nothing). */
  resetOffers(): void {
    for (const a of this.prosumers) {
      const p = a.plan!;
      p.charge = 0;
      p.dExp = 0;
      p.offer = 0;
      p.export = 0;
      const d = a.s.der!;
      d.offeredKW = d.exportedKW = d.curtailedKW = 0;
    }
  }

  /**
   * Battery charging, export discharge and offers of one island's prosumers; island line limit.
   * Charging is paid from the solar surplus and only while the island has margin (it never creates a shortage);
   * the battery exports only as much as needed to cover a shortfall (energy conservation).
   */
  planIsland(isl: Island, agents: Record<string, AgentRuntime>, genOutput: (id: string) => number): IslandPlan {
    const pros: AgentRuntime[] = [];
    let net = 0;
    for (const cid of isl.consumerIds) {
      const a = agents[cid];
      if (!a || a.down) continue;
      if (a.plan) pros.push(a);
      net += Math.max(0, a.s.demandKW - a.selfKW);
    }
    let util = 0;
    for (const gid of isl.generatorIds) util += genOutput(gid);
    const lim = isl.generatorIds.length ? this.genLineLimit(isl) : 0;
    const gen = Math.min(util, lim);

    let solarOffer = 0;
    for (const a of pros) {
      a.plan!.offer = a.plan!.baseOffer;
      solarOffer += a.plan!.baseOffer;
    }
    // 1. charging
    const margin = gen + solarOffer - net;
    if (margin > 0) {
      let want = 0;
      const wants: number[] = [];
      for (const a of pros) {
        const sp = a.b.prosumer!;
        const head = Math.max(0, sp.batteryKWh - a.s.der!.batteryKWh);
        const w = Math.min(sp.batteryMaxKW, head * 60, a.plan!.baseOffer);
        wants.push(w);
        want += w;
      }
      if (want > 1e-9) {
        const k = Math.min(1, margin / want);
        pros.forEach((a, i) => {
          a.plan!.charge = wants[i] * k;
          a.plan!.offer = a.plan!.baseOffer - a.plan!.charge;
          solarOffer -= a.plan!.charge;
        });
      }
    }
    // 2. battery export, only against a shortfall
    const need = net - (gen + solarOffer);
    if (need > 1e-6) {
      let cap = 0;
      for (const a of pros) cap += a.plan!.dExpCap;
      if (cap > 1e-9) {
        const k = Math.min(1, need / cap);
        for (const a of pros) {
          a.plan!.dExp = a.plan!.dExpCap * k;
          a.plan!.offer += a.plan!.dExp;
        }
      }
    }
    return { pros, utilityDerKW: util, genDeliverKW: gen, lineLimitGenKW: lim, netDemandKW: net };
  }

  /**
   * Per-edge export curtailment (docs §3): for every distribution edge, Σ exports injected downstream of it ≤
   * capacity × EXPORT_MARGIN. Deepest edges first, proportional scaling of the exports beneath — deterministic and
   * never increases a previously satisfied constraint.
   */
  curtail(): void {
    for (const a of this.prosumers) a.plan!.export = a.plan!.offer;
    for (const ce of this.curtailEdges) {
      if (ce.edge.status !== 'ok') continue;
      let sum = 0;
      for (const a of ce.pros) {
        const p = a.plan!;
        if (p.export > 0 && ce.depth >= p.reach) sum += p.export;
      }
      const lim = ce.edge.capacityKW * EXPORT_MARGIN;
      if (sum > lim) {
        const k = lim / sum;
        for (const a of ce.pros) {
          const p = a.plan!;
          if (p.export > 0 && ce.depth >= p.reach) p.export *= k;
        }
      }
    }
  }

  buildInfo(isl: Island, plan: IslandPlan): IslandInfo {
    let offered = 0;
    let exported = 0;
    for (const a of plan.pros) {
      const d = a.s.der!;
      offered += a.plan!.offer;
      exported += a.plan!.export;
      // Until dispatch these are the PLANNED values (what validators see): exports after thermal curtailment.
      d.offeredKW = a.plan!.offer;
      d.exportedKW = a.plan!.export;
      d.curtailedKW = Math.max(0, d.offeredKW - d.exportedKW);
    }
    const microgrid = isl.generatorIds.length === 0;
    const lineLimit = plan.lineLimitGenKW + exported;
    return {
      id: isl.id,
      generatorIds: isl.generatorIds,
      substationIds: isl.substationIds,
      consumerIds: isl.consumerIds,
      prosumerIds: plan.pros.map((a) => a.b.id),
      microgrid,
      utilityDerKW: plan.utilityDerKW,
      prosumerOfferedKW: offered,
      prosumerKW: exported,
      curtailedKW: Math.max(0, offered - exported),
      lineLimitKW: lineLimit,
      supplyKW: plan.genDeliverKW + exported, // = min(utilityDER + prosumer, line limit)
      demandKW: plan.netDemandKW,
    };
  }

  /**
   * Export dispatch: prosumer exports are dispatched FIRST (free solar / stored energy), the utility generators
   * cover only the remainder of the island's committed allocation A. If A < P_prosumer every export is scaled down
   * by the same factor (the rest is curtailed at the inverters). Returns the generator-served share of A.
   */
  dispatch(info: IslandInfo, allocatedKW: number, pros: AgentRuntime[]): number {
    const P = info.prosumerKW;
    const X = Math.min(P, Math.max(0, allocatedKW));
    const k = P > 1e-9 ? X / P : 0;
    let curtailed = 0;
    for (const a of pros) {
      const d = a.s.der!;
      d.exportedKW = a.plan!.export * k;
      d.curtailedKW = Math.max(0, d.offeredKW - d.exportedKW);
      curtailed += d.curtailedKW;
    }
    info.curtailedKW = curtailed;
    return Math.max(0, allocatedKW - X);
  }

  // ───────────────────── flows ─────────────────────

  /**
   * Net bidirectional distribution flows: per edge |Σ downstream (allocation − export)| over the consumers whose
   * feeder chain is live up to that edge. Returns the per-substation net load (only chains intact up to the substation).
   * Sets `flowKW` (magnitude) and `reverse` (true when export exceeds consumption downstream).
   */
  netFlows(agents: Record<string, AgentRuntime>): Map<string, number> {
    const acc = new Float64Array(this.edgeList.length);
    const subNet = new Map<string, number>();
    for (let i = 0; i < this.feederList.length; i++) {
      const f = this.feederList[i];
      const a = agents[f.consumerId];
      if (!a) continue;
      const v = a.s.allocatedKW - (a.s.der?.exportedKW ?? 0);
      if (Math.abs(v) < 1e-9) continue;
      const r = this.feederReach[i];
      for (let k = f.idx.length - 1; k >= r; k--) acc[f.idx[k]] += v;
      if (r === 0) subNet.set(f.substationId, (subNet.get(f.substationId) ?? 0) + v);
    }
    for (let i = 0; i < this.edgeList.length; i++) {
      const e = this.edgeList[i];
      if (e.tier === 'distribution') {
        const v = acc[i];
        e.flowKW = Math.abs(v) < 1e-9 ? 0 : Math.abs(v);
        e.reverse = v < -1e-9;
      } else {
        e.flowKW = 0;
        e.reverse = false;
      }
    }
    return subNet;
  }
}

// ───────────────────── prosumer physics ─────────────────────

/** Step 1 of a prosumer's minute (before islands are known): sun, p_min self-supply, battery capability, source flag. */
export function prepareProsumer(a: AgentRuntime, topo: MicrogridTopology, tMin: number, hour: number, cyclone: boolean): void {
  const sp = a.b.prosumer!;
  const der = a.s.der!;
  const p = a.plan!;
  if (a.down) {
    p.solar = p.effMin = p.dSurv = p.dExpCap = p.baseOffer = p.charge = p.dExp = p.offer = p.export = 0;
    p.potential = false;
    der.solarKW = der.generationKW = der.selfSupplyKW = der.offeredKW = der.exportedKW = der.curtailedKW = 0;
    return;
  }
  const S = sp.solarKWp * daylight(hour) * topo.cloudFactor(p.zone, tMin) * (cyclone ? 0.2 : 1);
  const effMin = Math.min(sp.survivalKW, Math.max(0, a.s.demandKW));
  const kwh = der.batteryKWh;
  const cap = sp.batteryKWh;
  const avail = Math.max(0, kwh - SURVIVAL_SOC_FLOOR * cap); // kWh usable for p_min
  const dSurv = Math.min(Math.max(0, effMin - S), sp.batteryMaxKW, avail * 60);
  // Export discharge is PACED so the usable energy lasts until sunrise instead of being burnt at the first deficit
  // (a midday shortfall must not leave the feeder with empty batteries at night).
  const usable = Math.max(0, kwh - EXPORT_SOC_FLOOR * cap);
  const hoursToDawn = Math.max(0.5, hour >= 6 ? 30 - hour : 6 - hour);
  const expAvail = Math.min(usable * 60, usable / hoursToDawn); // kW
  p.solar = S;
  p.effMin = effMin;
  p.dSurv = dSurv;
  p.dExpCap = Math.max(0, Math.min(sp.batteryMaxKW - dSurv, expAvail));
  p.baseOffer = Math.max(0, S - effMin);
  p.potential = p.baseOffer > 0.05 || p.dExpCap > 0.05;
  der.solarKW = S;
}

/** Local self-supply of this minute (needs the current demand). */
export function setSelfSupply(a: AgentRuntime): void {
  if (!a.plan) {
    a.selfKW = 0;
    return;
  }
  const p = a.plan;
  a.selfKW = a.down ? 0 : Math.min(p.effMin, p.solar + p.dSurv, Math.max(0, a.s.demandKW));
}

/**
 * Battery SoC accounting after dispatch (also for prosumers outside any island). Sources: solar first, battery for
 * the remainder; solar that is neither used, exported nor stored is lost. Writes the live DER state + inspector telemetry.
 */
export function finalizeProsumer(a: AgentRuntime): void {
  const sp = a.b.prosumer!;
  const der = a.s.der!;
  const p = a.plan!;
  const t = a.s.telemetry;
  if (!a.down) {
    const load = a.selfKW + der.exportedKW + p.charge;
    const dis = clamp(load - p.solar, 0, Math.min(sp.batteryMaxKW, der.batteryKWh * 60));
    der.batteryKWh = clamp(der.batteryKWh + (p.charge - dis) / 60, 0, sp.batteryKWh);
    der.batteryPct = sp.batteryKWh > 0 ? (der.batteryKWh / sp.batteryKWh) * 100 : 0;
    der.generationKW = p.solar + dis;
    der.selfSupplyKW = a.selfKW;
  } else {
    der.batteryPct = sp.batteryKWh > 0 ? (der.batteryKWh / sp.batteryKWh) * 100 : 0;
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  t.solarKW = r1(der.solarKW);
  t.batteryPct = Math.round(der.batteryPct);
  t.exportKW = r1(der.exportedKW);
  t.curtailedKW = r1(der.curtailedKW);
}

/** Type guard helper for callers that only have the public state. */
export const isProsumerState = (s: UtilityAgentState): boolean => s.der !== undefined;
