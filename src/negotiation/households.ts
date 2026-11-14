/**
 * Household clusters: houses on the same feeder substation and the same 6x6 city block bid together as one
 * deterministic agent (never calls Jev). Medical-device homes are a protected sub-bid.
 */
import type { AgentCaseBrief, AllocationRequest, PowerNetwork, ShortfallNotice, SimSnapshot, Stance, UtilityBid } from '../core/types';
import type { Assessment, ClusterIndex, ClusterNegotiator, HouseholdCluster, Proposal, PublicIslandInfo } from './agentApi';
import { NEGOTIATION_CONFIG, clamp01, type NegotiationConfig } from './config';

const BLOCK = 6;
const R = Math.round;
const tel = (r: AllocationRequest, k: string): number => {
  const v = r.telemetry[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};
const isMedical = (r: AllocationRequest): boolean => tel(r, 'medicalDevice') === 1;
const floorOf = (r: AllocationRequest): number => Math.max(0, Math.min(r.minSafeKW, r.demandKW));

const clusterCache = new WeakMap<PowerNetwork, ClusterIndex>();

export function buildClusters(snapshot: SimSnapshot): ClusterIndex {
  const cached = clusterCache.get(snapshot.network);
  if (cached) return cached;
  const subOf = new Map<string, string>();
  for (const f of snapshot.network.feeders) subOf.set(f.consumerId, f.substationId);
  const groups = new Map<string, HouseholdCluster>();
  const ids = Object.keys(snapshot.buildings).sort();
  for (const id of ids) {
    const b = snapshot.buildings[id];
    if (b.kind !== 'house') continue;
    const sub = subOf.get(id) ?? 'none';
    const cid = `cluster-${sub}-${Math.floor(b.col / BLOCK)}-${Math.floor(b.row / BLOCK)}`;
    let g = groups.get(cid);
    if (!g) {
      g = { id: cid, substationId: sub, memberIds: [] };
      groups.set(cid, g);
    }
    g.memberIds.push(id);
  }
  const clusters = [...groups.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const houseCluster: Record<string, string> = {};
  for (const c of clusters) {
    c.memberIds.sort();
    for (const m of c.memberIds) houseCluster[m] = c.id;
  }
  const idx: ClusterIndex = { clusters, houseCluster };
  clusterCache.set(snapshot.network, idx);
  return idx;
}

const scratch = { got: new Float64Array(64), dem: new Float64Array(64), floor: new Float64Array(64), med: new Uint8Array(64) };

/** One water-filling pass of ClusterAgent.split over the scratch arrays; returns the remaining kW. */
function give(phase: 0 | 1 | 2, n: number, remaining: number): number {
  const { got, dem, floor, med } = scratch;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (phase === 0 ? med[i] === 0 : phase === 1 && med[i] === 1) continue;
    sum += phase === 2 ? Math.max(0, dem[i] - got[i]) : floor[i];
  }
  if (sum <= 0 || remaining <= 0) return remaining;
  const k = Math.min(1, remaining / sum);
  for (let i = 0; i < n; i++) {
    if (phase === 0 ? med[i] === 0 : phase === 1 && med[i] === 1) continue;
    const want = phase === 2 ? Math.max(0, dem[i] - got[i]) : floor[i];
    const g = Math.min(want * k, dem[i] - got[i]);
    got[i] += g;
    remaining -= g;
  }
  return remaining;
}

export class ClusterAgent implements ClusterNegotiator {
  readonly id: string;
  readonly memberIds: string[];
  private served = 1;
  private substationId: string;
  /** rooftop-solar homes among this minute's members (set by assess) */
  private solar = { homes: 0, selfKW: 0, exportKW: 0 };
  /** kW of discretionary load per member whose loss is covered by that home's own battery (set by assess) */
  private batteryCover = new Map<string, number>();
  private slotOf: Map<string, number> | undefined;

  constructor(
    cluster: HouseholdCluster,
    private cfg: NegotiationConfig = NEGOTIATION_CONFIG,
  ) {
    this.id = cluster.id;
    this.memberIds = [...cluster.memberIds];
    this.substationId = cluster.substationId;
  }

  get recentServedShare(): number {
    return this.served;
  }

  /**
   * @param lastFinal optional: each home's last committed grant. When given, `snapshot.agents` may be the live snapshot
   *   (the policy then need not copy every agent state just to overwrite `allocatedKW`).
   */
  assess(members: AllocationRequest[], snapshot: SimSnapshot, island: PublicIslandInfo, lastFinal?: ReadonlyMap<string, number>): Assessment {
    const c = this.cfg;
    const reasons: string[] = [];
    const sol = { homes: 0, selfKW: 0, exportKW: 0 };
    this.batteryCover.clear();
    let near = 0;
    let nearest = Infinity;
    let under = 0;
    const agents = snapshot.agents;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const st = agents[m.buildingId];
      const der = st?.der;
      const self = Math.max(0, m.selfSupplyKW ?? der?.selfSupplyKW ?? 0);
      if (der || self > 0) sol.homes++;
      sol.selfKW += self;
      sol.exportKW += Math.max(0, der?.exportedKW ?? 0);
      if (st && st.backup.maxKW > 0 && st.backup.remainingKWh > 0) {
        const soc = der ? der.batteryPct : st.backup.capacityKWh > 0 ? (100 * st.backup.remainingKWh) / st.backup.capacityKWh : 0;
        if (!(soc <= c.houseBatteryMinPct)) this.batteryCover.set(m.buildingId, Math.min(st.backup.maxKW, st.backup.remainingKWh * 60));
      }
      const d = m.telemetry.distanceToImpactM;
      if (typeof d === 'number' && d <= c.affectedRadiusM) {
        near++;
        nearest = Math.min(nearest, d);
      }
      if (st && m.demandKW > 0 && (lastFinal ? (lastFinal.get(m.buildingId) ?? st.demandKW) : st.allocatedKW) / m.demandKW < c.affectedServedFrac) under++;
    }
    this.solar = sol;
    if (members.length > 0) {
      if (near > 0) reasons.push(`${near} of ${members.length} homes within ${R(nearest)} m of damage`);
      if (under > 0) reasons.push(`${under} homes served below ${R(c.affectedServedFrac * 100)}% of demand`);
    }
    const affected = reasons.length > 0;
    const short = members.length > 0 && island.totalRequestKW > 0 && island.deficitKW / island.totalRequestKW > c.cooperateDeficitFrac;
    if (short) reasons.push(`Island ${island.islandId} is ${R(island.deficitKW)} kW short${affected ? '' : '; asked to use less'}`);
    return { mode: affected ? 'active' : short ? 'cooperating' : 'idle', affected, reasons };
  }

  propose(members: AllocationRequest[], island: PublicIslandInfo, assessment: Assessment, tokenBalance: number): Proposal {
    return this.build(members, island.islandId, island.tMin, island.deficitKW, assessment.mode, 1, tokenBalance, undefined);
  }

  respond(notice: ShortfallNotice, prev: Proposal, members: AllocationRequest[], tokenBalance: number): Proposal {
    return this.build(members, notice.islandId, prev.bid.tMin, notice.deficitKW, prev.bid.mode, Math.max(2, notice.round), tokenBalance, notice);
  }

  split(grantKW: number, members: AllocationRequest[]): Record<string, number> {
    const out: Record<string, number> = {};
    const ms = this.sortedMembers(members);
    const n = ms.length;
    if (scratch.got.length < n) {
      const cap = Math.max(n, 2 * scratch.got.length);
      scratch.got = new Float64Array(cap);
      scratch.dem = new Float64Array(cap);
      scratch.floor = new Float64Array(cap);
      scratch.med = new Uint8Array(cap);
    }
    // per-member scratch (index = position in id order)
    const { got, dem, floor, med } = scratch;
    let nMed = 0;
    let totalDemand = 0;
    for (let i = 0; i < n; i++) {
      const m = ms[i];
      out[m.buildingId] = 0;
      got[i] = 0;
      dem[i] = Math.max(0, m.demandKW);
      floor[i] = floorOf(m);
      med[i] = isMedical(m) ? 1 : 0;
      nMed += med[i];
      totalDemand += dem[i];
    }
    let remaining = Math.min(Math.max(0, Number.isFinite(grantKW) ? grantKW : 0), totalDemand);
    // phase: 0 = medical floors, 1 = other floors, 2 = remaining demand (all). Same arithmetic / order as a reduce-based fill.
    if (nMed > 0) remaining = give(0, n, remaining);
    remaining = give(1, n, remaining);
    give(2, n, remaining);
    for (let i = 0; i < n; i++) out[ms[i].buildingId] = got[i];
    return out;
  }

  /** Members in ascending building-id order. O(n) when all members belong to this cluster, otherwise sorted. */
  private sortedMembers(members: AllocationRequest[]): AllocationRequest[] {
    const n = members.length;
    if (this.slotOf === undefined) {
      this.slotOf = new Map();
      this.memberIds.forEach((id, i) => this.slotOf!.set(id, i));
    }
    if (n > 1 && n <= this.memberIds.length) {
      const slots = new Array<AllocationRequest | undefined>(this.memberIds.length);
      let ok = true;
      for (let i = 0; i < n; i++) {
        const k = this.slotOf.get(members[i].buildingId);
        if (k === undefined || slots[k] !== undefined) {
          ok = false;
          break;
        }
        slots[k] = members[i];
      }
      if (ok) {
        const out: AllocationRequest[] = [];
        for (let k = 0; k < slots.length; k++) if (slots[k] !== undefined) out.push(slots[k]!);
        return out;
      }
    }
    return [...members].sort((a, b) => (a.buildingId < b.buildingId ? -1 : a.buildingId > b.buildingId ? 1 : 0));
  }

  observe(finalKW: number, demandKW: number): void {
    if (!(demandKW > 0)) return;
    this.served += this.cfg.fairnessAlpha * (clamp01(finalKW / demandKW) - this.served);
  }

  private build(
    members: AllocationRequest[],
    islandId: number,
    tMin: number,
    deficitKW: number,
    mode: UtilityBid['mode'],
    round: number,
    tokenBalance: number,
    notice: ShortfallNotice | undefined,
  ): Proposal {
    const c = this.cfg;
    let demand = 0;
    let minSafe = 0;
    let medKW = 0;
    let medN = 0;
    let critW = 0;
    let urgency = 0;
    let damage = 0;
    let discretionary = 0;
    let people = 0;
    let battery = 0;
    let cover = 0;
    const hasCover = this.batteryCover.size > 0;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const d = Math.max(0, m.demandKW);
      const fl = floorOf(m);
      demand += d;
      minSafe += fl;
      critW += m.criticality * d;
      urgency = Math.max(urgency, m.urgency);
      damage += m.expectedDamagePerHour;
      discretionary += Math.max(0, d - fl);
      people += tel(m, 'occupants');
      battery += tel(m, 'batteryPct');
      if (isMedical(m)) {
        medKW += fl;
        medN++;
      }
      if (hasCover) cover += Math.min(this.batteryCover.get(m.buildingId) ?? 0, Math.max(0, m.demandKW - fl));
    }
    let criticality = demand > 0 ? critW / demand : 0;
    if (medN > 0) criticality = Math.max(criticality, 0.7);
    criticality = clamp01(criticality);
    urgency = clamp01(urgency);
    const harmAware = c.harmAwareConcessions;
    const flexibleKW = harmAware
      ? Math.min(cover, 0.5 * discretionary, Math.max(0, demand - minSafe), Math.max(0, deficitKW))
      : Math.min(0.5 * discretionary, Math.max(0, demand - minSafe));
    const batteryAvg = members.length > 0 ? battery / members.length : 0;

    const short = deficitKW > 0 && mode !== 'idle';
    let conceded = 0;
    if (mode === 'cooperating' && short) conceded = flexibleKW;
    else if (mode === 'active' && short && round >= 2) conceded = harmAware ? flexibleKW : 0.5 * flexibleKW;
    const request = Math.max(minSafe, demand - conceded);
    conceded = demand - request;

    let tokens = 0;
    if (notice && mode !== 'idle' && notice.projectedKW + 1e-6 < notice.requestKW) {
      tokens = Math.max(0, Math.min(tokenBalance * c.maxOfferFraction, c.tokenBidCap));
    }

    const flexLabel = harmAware ? 'Home-battery-covered household load' : 'Discretionary household load (appliances, HVAC, EV charging)';
    const flex = flexibleKW > 0 ? [{ label: flexLabel, kw: flexibleKW, maxDurationMin: 120 }] : [];
    const stance: Stance = conceded < 0.5 ? 'CRITICAL_HOLD' : flexibleKW > 0 && conceded >= 0.98 * flexibleKW ? 'FULL_FLEX_SHED' : 'PARTIAL_CONCESSION';

    const bid: UtilityBid = {
      agentId: this.id,
      kind: 'house',
      islandId,
      tMin,
      round,
      mode,
      requestKW: request,
      originalRequestKW: demand,
      minSafeKW: minSafe,
      criticality,
      urgency,
      expectedDamagePerHour: damage,
      flexibleKW,
      flex,
      concededKW: conceded,
      concessionWillingness: mode === 'cooperating' ? 1 : mode === 'active' ? 0.5 : 0,
      backupRemainingKWh: 0,
      backupHours: 0,
      recentServedShare: this.served,
      tokensOffered: tokens,
      memberIds: [...this.memberIds],
      medicalKW: medKW,
    };

    const sol = this.solar;
    const solarTxt = sol.homes > 0 ? ` ${sol.homes} rooftop-solar home${sol.homes === 1 ? '' : 's'} self-supplying ${R(sol.selfKW * 10) / 10} kW, exporting ${R(sol.exportKW * 10) / 10} kW; bids only the net ${R(demand)} kW.` : '';
    const idle = mode === 'idle';
    const homes = idle ? '' : `${members.length} homes (${R(people)} residents) on substation ${this.substationId}`;
    const med = idle ? '' : medN > 0 ? `${medN} with medical devices need ${R(medKW)} kW first` : 'no medical-device homes';
    let primary: string;
    if (mode === 'idle') primary = 'Operating normally; requesting nominal load.';
    else if (mode === 'cooperating') {
      primary = `${homes}, not directly affected; island ${islandId} is ${R(deficitKW)} kW short, so the ${R(minSafe)} kW essential floor stays protected (${med}) while discretionary load is offered.`;
    } else {
      primary = `${homes}; ${med}; essential floor ${R(minSafe)} kW of ${R(demand)} kW demand, battery avg ${R(batteryAvg)}%.`;
      if (notice && notice.projectedKW < notice.requestKW) primary += ` Projected ${R(notice.projectedKW)} of ${R(notice.requestKW)} kW.`;
    }
    let offer: string;
    if (mode === 'idle') offer = 'None needed — island has surplus.';
    else if (conceded >= 0.5 && harmAware) offer = `Running ${R(conceded)} kW of home load on home batteries to free grid power; ${R(minSafe)} kW essential floor (medical devices first) is locked.`;
    else if (conceded >= 0.5) offer = `Willing to defer ${R(conceded)} kW of discretionary load while the ${R(minSafe)} kW essential floor (medical devices first) is locked.`;
    else if (flexibleKW >= 1) offer = `Ready to defer up to ${R(flexibleKW)} kW of discretionary load if the shortage persists; ${R(minSafe)} kW floor locked.`;
    else if (harmAware) offer = `No concession: no battery-covered load; shedding battery-less discretionary load (${R(discretionary)} kW) would only add harm in a shortage. ${R(minSafe)} kW floor locked.`;
    else offer = `No concession: no discretionary load above the ${R(minSafe)} kW floor.`;

    primary += solarTxt;
    const brief: AgentCaseBrief = {
      agentId: this.id,
      utilityType: 'household_cluster',
      stance,
      jevUrgencyScore: urgency,
      jevDamageScore: clamp01(damage / c.damageNorm),
      jevConfidence: 0,
      perceptionSource: 'none',
      primaryArgument: primary,
      concessionOffer: offer,
      renegotiationRound: round,
    };
    return { bid, brief };
  }
}
