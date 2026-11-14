/**
 * NegotiationPolicy — Layer 2 orchestrator (docs/NEGOTIATION.md §1–§5). Implements AllocationPolicy.
 *
 *   beginStep → per island: allocate (assess → perceive → propose → clear → shortfall/respond → contracts →
 *   re-clear → per-building allocation) → [validator] → commit (charge/earn tokens, explanations, history) →
 *   endStep (perception pump, ledger tick, contract housekeeping, NegotiationSnapshot).
 *
 * Need, not wealth: tokens are a bounded secondary signal (see clearing.ts); minSafe is protected in phase 1.
 */
import type {
  AgentDossier,
  AllocationExplanation,
  AllocationPolicy,
  AllocationRequest,
  AuditEntry,
  BidRecord,
  ConsumerKind,
  ForwardContract,
  IslandContext,
  IslandTrace,
  NegotiationRound,
  NegotiationSnapshot,
  NegotiatorKind,
  Perception,
  PerceptionProvider,
  ShortfallNotice,
  SimSnapshot,
  UtilityAgentState,
  UtilityBid,
} from '../core/types';
import { hourOf } from '../sim/telemetry';
import type { Assessment, ClusterIndex, ClusterNegotiator, HouseholdCluster, NegotiatingAgent, Proposal, PublicIslandInfo } from './agentApi';
import { UtilityAgent } from './agent';
import { clear, type ClearingResult } from './clearing';
import { NEGOTIATION_CONFIG, minutesToSunsetAt, type NegotiationConfig } from './config';
import { ContractBook } from './contracts';
import { ClusterAgent, buildClusters } from './households';
import { TokenLedger } from './ledger';
import { PerceptionScheduler } from './perception';
import { StoryRecorder, type CommitInfo, type StoryCapture } from './story';

const EPS = 1e-6;
const IDLE_HISTORY_EVERY_MIN = 5;
const NEGOTIATOR_KINDS: ReadonlySet<string> = new Set(['hospital', 'water', 'emergency', 'telecom', 'school']);

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const pos = (x: number): number => (Number.isFinite(x) && x > 0 ? x : 0);
const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const kw = (x: number): string => {
  const r = Math.round(x);
  return r < 1000 && r > -1000 ? String(r) : String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};
const mw = (x: number): string => (Math.abs(x) >= 1000 ? `${(x / 1000).toFixed(1)} MW` : `${Math.round(x)} kW`);
const f2 = (x: number): string => x.toFixed(2);

interface Entry {
  id: string;
  isCluster: boolean;
  kind: ConsumerKind;
  name: string;
  members: AllocationRequest[];
  utility?: NegotiatingAgent;
  cluster?: ClusterNegotiator;
  state?: UtilityAgentState;
  assessment: Assessment;
  perception?: Perception;
  /** latest proposal from the agent */
  proposal: Proposal;
  /** working bid (proposal.bid + contract obligations + sanitised tokens) */
  bid: UtilityBid;
  demandKW: number;
  escrow: number;
  yielded: number;
  yieldNotes: string[];
  roundOneConceded: number;
  /** round-1 request and provisional grant (to tell real concessions from merely stated ones) */
  firstReq: number;
  firstGrant: number;
  /** kW of concession withdrawn because the shortfall was already covered */
  restored: number;
  /** sheddable buffer-charging kW the sim put into the request (docs/MICROGRID.md §5) */
  chargeKW: number;
}

interface Pending {
  islandId: number;
  tMin: number;
  info: PublicIslandInfo;
  entries: Entry[];
  result: ClearingResult;
  trace: IslandTrace;
  roundsRun: number;
  committed: boolean;
  contractNotes: Map<string, string[]>;
  /** story capture (references only) when this island-minute may be recorded */
  cap?: StoryCapture;
}

function fallbackState(r: AllocationRequest): UtilityAgentState {
  return {
    buildingId: r.buildingId,
    kind: r.kind,
    demandKW: r.demandKW,
    minSafeKW: r.minSafeKW,
    criticality: r.criticality,
    urgency: r.urgency,
    expectedDamagePerHour: r.expectedDamagePerHour,
    allocatedKW: r.demandKW,
    connected: true,
    backup: { type: 'none', capacityKWh: 0, remainingKWh: 0, maxKW: 0 },
    telemetry: r.telemetry,
    tokens: r.tokens,
    dependentDamagePerHour: r.dependentDamagePerHour,
  };
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class NegotiationPolicy implements AllocationPolicy {
  name = 'negotiation: need-based auction (Jev agents)';

  private readonly cfg: NegotiationConfig;
  private provider: PerceptionProvider | null;
  private scheduler: PerceptionScheduler;
  readonly ledger: TokenLedger;
  readonly contracts: ContractBook;

  private utilityAgents = new Map<string, NegotiatingAgent>();
  private clusterAgents = new Map<string, ClusterNegotiator>();
  private clusterIndex: ClusterIndex = { clusters: [], houseCluster: {} };
  private clusterById = new Map<string, HouseholdCluster>();
  private extraHouseCluster: Record<string, string> = {};
  private idsCacheKey: { agents: unknown; index: ClusterIndex } | null = null;
  private clusterLabels = new Map<string, string>();
  private negotiatorIds: { id: string; kind: NegotiatorKind; name: string }[] = [];

  private dossiers = new Map<string, AgentDossier>();
  private lastFinal = new Map<string, number>();
  private openIds = new Map<string, string[]>();
  private shells = new Map<string, AgentDossier>();
  private extraVersion = 0;
  /** house id → cluster id, of the current cluster index */
  private hcMap = new Map<string, string>();
  private hcCache: { base: Record<string, string>; extra: number; view: Record<string, string> } | null = null;
  private pending = new Map<number, Pending>();
  private traces: IslandTrace[] = [];
  private seenIsland = new Map<string, number>();
  private begun = false;
  private tMin = 0;
  private autoIsland = 0;
  private story: StoryRecorder | null;

  constructor(opts: { provider?: PerceptionProvider | null; config?: Partial<NegotiationConfig> } = {}) {
    this.cfg = { ...NEGOTIATION_CONFIG, ...(opts.config ?? {}) };
    this.provider = opts.provider ?? null;
    this.scheduler = new PerceptionScheduler(this.provider, this.cfg);
    this.ledger = new TokenLedger(this.cfg);
    this.contracts = new ContractBook(this.ledger, this.cfg);
    this.story = this.cfg.recordStory ? new StoryRecorder(this.cfg) : null;
  }

  setProvider(p: PerceptionProvider | null): void {
    this.provider = p;
    this.scheduler.reset();
    this.scheduler = new PerceptionScheduler(p, this.cfg);
  }

  reset(): void {
    this.scheduler.reset();
    this.ledger.reset();
    this.contracts.reset();
    this.utilityAgents.clear();
    this.clusterAgents.clear();
    this.clusterIndex = { clusters: [], houseCluster: {} };
    this.hcMap.clear();
    this.clusterById.clear();
    this.clusterLabels.clear();
    this.extraHouseCluster = {};
    this.extraVersion++;
    this.shells.clear();
    this.openIds.clear();
    this.idsCacheKey = null;
    this.negotiatorIds = [];
    this.dossiers.clear();
    this.lastFinal.clear();
    this.pending.clear();
    this.traces = [];
    this.seenIsland.clear();
    this.begun = false;
    this.tMin = 0;
    this.autoIsland = 0;
    this.story?.reset();
  }

  // ───────────────────────────── step lifecycle ─────────────────────────────

  beginStep(snapshot: SimSnapshot): void {
    this.begun = true;
    this.tMin = snapshot.tMin;
    this.autoIsland = 0;
    this.releaseUncommitted();
    this.pending.clear();
    this.traces = [];
    this.seenIsland.clear();
    this.ledger.setTime(snapshot.tMin);
    const idx = buildClusters(snapshot);
    if (idx !== this.clusterIndex) {
      this.clusterIndex = idx;
      this.hcMap.clear();
      for (const h in idx.houseCluster) this.hcMap.set(h, idx.houseCluster[h]);
      this.clusterById.clear();
      this.clusterLabels.clear();
      const perSub = new Map<string, number>();
      for (const c of idx.clusters) {
        this.clusterById.set(c.id, c);
        const k = perSub.get(c.substationId) ?? 0;
        perSub.set(c.substationId, k + 1);
        const sub = snapshot.buildings[c.substationId]?.name ?? c.substationId;
        this.clusterLabels.set(c.id, `near ${sub} (block ${String.fromCharCode(65 + (k % 26))}${k >= 26 ? Math.floor(k / 26) : ""})`);
      }
    }
    if (!this.idsCacheKey || this.idsCacheKey.agents !== snapshot.agents || this.idsCacheKey.index !== idx) {
      this.idsCacheKey = { agents: snapshot.agents, index: idx };
      this.negotiatorIds = [];
      for (const id of Object.keys(snapshot.agents).sort()) {
        const k = snapshot.agents[id].kind;
        if (NEGOTIATOR_KINDS.has(k)) this.negotiatorIds.push({ id, kind: k as NegotiatorKind, name: snapshot.buildings[id]?.name ?? id });
      }
    }
  }

  allocate(supplyKW: number, requests: AllocationRequest[], snapshot: SimSnapshot, ctx?: IslandContext): Record<string, number> {
    if (!this.begun) this.beginStep(snapshot);
    const out: Record<string, number> = {};
    if (requests.length === 0) return out;
    const t0 = now();
    const cfg = this.cfg;
    const tMin = ctx?.tMin ?? snapshot.tMin;
    const islandId = ctx?.islandId ?? this.autoIsland++;
    const supply = pos(supplyKW);
    this.ledger.setTime(tMin);

    const old = this.pending.get(islandId);
    if (old) this.releaseEscrow(old);

    // ── public island info ──
    let totalReq = 0;
    let totalMin = 0;
    let totalCharge = 0;
    for (const r of requests) {
      totalReq += pos(r.demandKW);
      totalMin += Math.min(pos(r.minSafeKW), pos(r.demandKW));
      totalCharge += Math.min(pos(r.chargeKW ?? 0), pos(r.demandKW));
    }
    const hour = hourOf(tMin);
    const info: PublicIslandInfo = {
      islandId,
      tMin,
      hourOfDay: hour,
      supplyKW: supply,
      totalRequestKW: totalReq,
      totalMinSafeKW: totalMin,
      deficitKW: Math.max(0, totalReq - supply),
      consumers: requests.length,
      minutesToSunset: minutesToSunsetAt(hour, cfg),
      surplusKW: Math.max(0, supply - (totalReq - totalCharge)),
    };
    if (ctx?.info) {
      info.microgrid = ctx.info.microgrid;
      info.prosumerKW = ctx.info.prosumerKW;
      info.utilityDerKW = ctx.info.utilityDerKW;
    }

    // ── participants ──
    const entries = this.buildEntries(requests, snapshot, info);
    const presentIds = new Set<string>();
    const perceptions: Record<string, Perception | undefined> = {};
    for (const e of entries) {
      if (!e.isCluster) presentIds.add(e.id);
      if (e.perception) perceptions[e.id] = e.perception;
      this.seenIsland.set(e.id, islandId);
    }

    const notes = new Map<string, string[]>();
    const rounds: NegotiationRound[] = [];

    // ── round 1: propose ──
    for (const e of entries) {
      const balance = this.ledger.balance(e.id);
      e.proposal = e.isCluster
        ? (e.cluster as ClusterNegotiator).propose(e.members, info, e.assessment, balance)
        : (e.utility as NegotiatingAgent).propose(e.state as UtilityAgentState, e.perception, info, e.assessment, balance);
      this.prepareBid(e, tMin);
      e.roundOneConceded = e.bid.concededKW;
    }
    let result = this.clearRound(supply, entries, perceptions, presentIds, tMin);
    for (const e of entries) {
      e.firstReq = e.bid.requestKW;
      e.firstGrant = result.grants[e.id] ?? 0;
    }
    const conceded1 = entries.filter((e) => e.bid.concededKW > 0.5).map((e) => ({ e, kw: e.bid.concededKW }));
    rounds.push(this.roundRecord(1, supply, entries, result, conceded1));
    const cap = this.story ? this.story.begin(islandId, tMin, info, entries, result, conceded1) : null;
    let deficit = this.totalRequest(entries) - supply;
    let round = 1;

    // ── round ≥ 2: shortfall → respond → contracts → re-clear ──
    while (deficit > EPS && round < cfg.rounds) {
      const reqTotal = this.totalRequest(entries);
      const minTotal = entries.reduce((s, e) => s + e.bid.minSafeKW, 0);
      const first = result;
      const conceded: { e: Entry; kw: number }[] = [];
      for (const e of entries) {
        const notice: ShortfallNotice = {
          islandId,
          round,
          supplyKW: supply,
          totalRequestKW: reqTotal,
          totalMinSafeKW: minTotal,
          deficitKW: Math.max(0, deficit),
          projectedKW: first.grants[e.id] ?? 0,
          requestKW: e.bid.requestKW,
          minSafeKW: e.bid.minSafeKW,
        };
        const balance = this.ledger.balance(e.id);
        const before = e.bid.concededKW;
        const next = e.isCluster
          ? (e.cluster as ClusterNegotiator).respond(notice, e.proposal, e.members, balance)
          : (e.utility as NegotiatingAgent).respond(notice, e.proposal, e.state as UtilityAgentState, e.perception, balance);
        e.proposal = next;
        this.prepareBid(e, tMin);
        const d = e.bid.concededKW - before;
        if (d > 0.5) conceded.push({ e, kw: d });
      }
      const made: ForwardContract[] = [];
      this.createContracts(entries, conceded, first, tMin, notes, made);
      result = this.clearRound(supply, entries, perceptions, presentIds, tMin);
      round++;
      if (cap && this.story) this.story.addRound(cap, round, entries, result, deficit, reqTotal, minTotal, conceded, made);
      rounds.push(this.roundRecord(round, supply, entries, result, conceded));
      deficit = this.totalRequest(entries) - supply;
    }

    // ── withdraw over-conceded load: concessions only need to cover the actual shortfall ──
    if (this.restoreSlack(entries, supply)) {
      result = this.clearRound(supply, entries, perceptions, presentIds, tMin);
      const last = rounds[rounds.length - 1];
      last.provisional = { ...result.grants };
      last.totalRequestKW = this.totalRequest(entries);
      last.deficitKW = Math.max(0, last.totalRequestKW - supply);
    }

    // ── escrow the final token offers ──
    for (const e of entries) {
      e.escrow = e.bid.tokensOffered > 0 ? this.ledger.escrow(e.id, e.bid.tokensOffered) : 0;
    }

    // ── per-building allocation ──
    let sum = 0;
    for (const e of entries) {
      const grant = pos(result.grants[e.id] ?? 0);
      if (e.isCluster) {
        const split = (e.cluster as ClusterNegotiator).split(grant, e.members);
        for (const m of e.members) {
          const g = Math.min(pos(split[m.buildingId] ?? 0), pos(m.demandKW));
          out[m.buildingId] = g;
          sum += g;
        }
      } else {
        const g = Math.min(grant, pos(e.members[0].demandKW));
        out[e.id] = g;
        sum += g;
      }
    }
    if (sum > supply) {
      const k = supply / sum;
      for (const id of Object.keys(out)) out[id] *= k;
    }

    const trace: IslandTrace = {
      islandId,
      tMin,
      supplyKW: supply,
      totalRequestKW: info.totalRequestKW,
      totalMinSafeKW: info.totalMinSafeKW,
      regime: result.regime,
      weights: result.weights,
      rounds,
      activeAgents: entries.filter((e) => e.assessment.mode === 'active').map((e) => e.id),
      cooperatingAgents: entries.filter((e) => e.assessment.mode === 'cooperating').map((e) => e.id),
      durationMs: now() - t0,
    };
    this.traces.push(trace);
    const pend: Pending = { islandId, tMin, info, entries, result, trace, roundsRun: round, committed: false, contractNotes: notes };
    if (cap && this.story && this.story.finalize(cap, entries, result, out)) pend.cap = cap;
    this.pending.set(islandId, pend);
    return out;
  }

  commit(ctx: IslandContext, committed: Record<string, number>, audit: AuditEntry[], snapshot: SimSnapshot): void {
    const p = this.pending.get(ctx.islandId);
    if (!p || p.committed) return;
    const t0 = now();
    p.committed = true;
    const tMin = p.tMin;
    this.ledger.setTime(tMin);

    const auditBy = new Map<string, AuditEntry[]>();
    for (const a of audit) {
      if (!a.agentId) continue;
      let l = auditBy.get(a.agentId);
      if (!l) auditBy.set(a.agentId, (l = []));
      l.push(a);
    }

    const res = p.result;
    const rec: CommitInfo | null = p.cap?.replay ? { finals: [], earned: [], spent: [] } : null;
    for (const e of p.entries) {
      const id = e.id;
      let finalKW = 0;
      for (const m of e.members) {
        const g = pos(committed[m.buildingId] ?? 0);
        finalKW += g;
        if (e.isCluster) this.lastFinal.set(m.buildingId, g);
      }

      // validator notes
      const notes: string[] = [];
      if (auditBy.size > 0) {
        const own = e.isCluster ? e.members.flatMap((m) => auditBy.get(m.buildingId) ?? []) : (auditBy.get(id) ?? []);
        for (const a of own) {
          const s = `${a.rule}: ${a.reason}`;
          if (!notes.includes(s)) notes.push(s);
        }
      }
      if (notes.length > 4) notes.splice(4, notes.length - 4, `…and ${notes.length - 4} more correction(s)`);

      // tokens: spend (only if it received phase-2 power), refund the rest, mint for verified concessions
      let spent = 0;
      if (e.escrow > EPS) {
        const pr = res.priority[id];
        if ((res.phase2[id] ?? 0) > EPS && pr && pr.score > EPS) {
          const ratio = Math.min(1, (pr.weights.tokens * pr.terms.tokens) / pr.score);
          spent = this.ledger.charge(id, e.escrow * ratio, 'spend', `t${tMin}`);
        }
        this.ledger.release(id, e.escrow - spent);
      }
      let earned = 0;
      if (e.assessment.mode !== 'idle') {
        const verified = Math.min(Math.max(0, e.bid.originalRequestKW - Math.max(finalKW, e.bid.requestKW)), this.reallyReleased(e));
        if (verified > EPS) earned = this.ledger.earn(id, verified, `t${tMin}`);
      }

      if (rec) {
        rec.finals.push(finalKW);
        rec.earned.push(earned);
        rec.spent.push(spent);
      }
      if (e.isCluster) (e.cluster as ClusterNegotiator).observe(finalKW, e.demandKW);
      else (e.utility as NegotiatingAgent).observe(finalKW, e.demandKW);
      this.lastFinal.set(id, finalKW);

      const explanation = this.explain(p, e, finalKW, notes, spent, earned);
      const record: BidRecord = { tMin, bid: e.bid, brief: e.proposal.brief, explanation, rounds: p.roundsRun };
      const d = this.dossier(id, e.kind, e.isCluster ? e.members.map((m) => m.buildingId) : undefined);
      d.mode = e.assessment.mode;
      d.affected = e.assessment.affected;
      d.affectedReasons = e.assessment.reasons;
      d.islandId = p.islandId;
      d.perception = e.perception;
      d.perceptionAgeMin = e.perception ? Math.max(0, tMin - e.perception.tMin) : undefined;
      d.current = record;
      if (e.assessment.mode !== 'idle' || tMin % IDLE_HISTORY_EVERY_MIN === 0) {
        d.history.push(record);
        const over = d.history.length - this.cfg.historyPerAgent;
        if (over === 1) d.history.shift();
        else if (over > 1) d.history.splice(0, over);
      }
      d.tokens = this.ledger.balance(id);
    }
    this.story?.commit(p.islandId, tMin, p.cap, audit, committed, rec);
    p.trace.durationMs += now() - t0;
    void snapshot;
  }

  endStep(snapshot: SimSnapshot): NegotiationSnapshot {
    const tMin = snapshot.tMin;
    this.releaseUncommitted();
    this.scheduler.pump();
    this.ledger.setTime(tMin);
    this.contracts.housekeeping(tMin, (id) => this.seenIsland.get(id));
    this.ledger.tick(tMin);

    // dossiers for everyone not on an island this minute
    const agents: Record<string, AgentDossier> = {};
    this.openIds.clear();
    for (const c of this.contracts.list(tMin)) {
      if (c.status !== 'open' && c.status !== 'repaying') continue;
      this.pushOpenId(c.giverId, c.id);
      if (c.receiverId !== c.giverId) this.pushOpenId(c.receiverId, c.id);
    }
    for (const n of this.negotiatorIds) this.finishDossier(n.id, n.kind, undefined, agents);
    for (const c of this.clusterIndex.clusters) this.finishDossier(c.id, 'house', c.memberIds, agents);

    for (const id in this.extraHouseCluster) {
      const cid = this.extraHouseCluster[id];
      if (!agents[cid]) this.finishDossier(cid, 'house', [id], agents);
    }
    const houseCluster = this.houseClusterView();

    const st = this.story?.snapshot();
    return {
      policy: this.name,
      tMin,
      agents,
      houseCluster,
      islands: this.traces.slice(),
      contracts: this.contracts.list(tMin),
      ledger: this.ledger.tail(),
      tokenSupply: this.ledger.total(),
      perception: this.scheduler.stats(),
      ...(st ? { replays: st.replays, events: st.events, feed: st.feed } : {}),
    };
  }

  /** Ledger invariant (Σ balances + escrow = minted − burned). */
  ledgerInvariantOk(): boolean {
    return this.ledger.checkInvariant();
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private finishDossier(id: string, kind: ConsumerKind, memberIds: string[] | undefined, out: Record<string, AgentDossier>): void {
    this.ledger.ensure(id);
    const d = this.dossier(id, kind, memberIds);
    if (this.seenIsland.get(id) === undefined) {
      d.mode = 'idle';
      d.affected = false;
      d.affectedReasons = ['Disconnected from the grid'];
      d.islandId = null;
      d.perception = undefined;
      d.perceptionAgeMin = undefined;
      d.current = undefined;
    }
    d.tokens = this.ledger.balance(id);
    const ids = this.openIds.get(id);
    const prev = this.shells.get(id);
    if (ids === undefined && d.contractIds.length === 0) {
      // nothing open: keep the (empty) array already on the dossier
    } else {
      d.contractIds = ids ? ids.slice() : [];
      if (prev && sameIds(prev.contractIds, d.contractIds)) d.contractIds = prev.contractIds;
    }
    // hand out a stable object while nothing visible changed (the UI only reads them)
    if (
      prev &&
      prev.kind === d.kind &&
      prev.mode === d.mode &&
      prev.affected === d.affected &&
      prev.affectedReasons === d.affectedReasons &&
      prev.islandId === d.islandId &&
      prev.perception === d.perception &&
      prev.perceptionAgeMin === d.perceptionAgeMin &&
      prev.current === d.current &&
      prev.tokens === d.tokens &&
      prev.history === d.history &&
      prev.contractIds === d.contractIds &&
      prev.memberIds === d.memberIds
    ) {
      out[id] = prev;
      return;
    }
    const shell: AgentDossier = { ...d };
    out[id] = shell;
    this.shells.set(id, shell);
  }

  private pushOpenId(agent: string, cid: string): void {
    const l = this.openIds.get(agent);
    if (l) l.push(cid);
    else this.openIds.set(agent, [cid]);
  }

  private houseClusterView(): Record<string, string> {
    const base = this.clusterIndex.houseCluster;
    const nExtra = this.extraVersion;
    if (!this.hcCache || this.hcCache.base !== base || this.hcCache.extra !== nExtra) {
      this.hcCache = { base, extra: nExtra, view: { ...base, ...this.extraHouseCluster } };
    }
    return this.hcCache.view;
  }

  private dossier(id: string, kind: ConsumerKind, memberIds?: string[]): AgentDossier {
    let d = this.dossiers.get(id);
    if (!d) {
      d = {
        agentId: id,
        kind,
        mode: 'idle',
        affected: false,
        affectedReasons: ['Disconnected from the grid'],
        islandId: null,
        history: [],
        tokens: this.ledger.balance(id),
        contractIds: [],
      };
      if (memberIds) d.memberIds = memberIds;
      this.dossiers.set(id, d);
    }
    return d;
  }

  private releaseEscrow(p: Pending): void {
    for (const e of p.entries) {
      if (e.escrow > 0) {
        this.ledger.release(e.id, e.escrow);
        e.escrow = 0;
      }
    }
  }

  private releaseUncommitted(): void {
    for (const p of this.pending.values()) if (!p.committed) this.releaseEscrow(p);
  }

  private totalRequest(entries: Entry[]): number {
    let t = 0;
    for (const e of entries) t += e.bid.requestKW;
    return t;
  }

  private clusterOf(houseId: string): string {
    const c = this.hcMap.get(houseId);
    if (c) return c;
    const solo = `cluster-solo-${houseId}`;
    this.extraHouseCluster[houseId] = solo;
    this.extraVersion++;
    if (!this.clusterById.has(solo)) this.clusterById.set(solo, { id: solo, substationId: '', memberIds: [houseId] });
    return solo;
  }

  private buildEntries(requests: AllocationRequest[], snapshot: SimSnapshot, info: PublicIslandInfo): Entry[] {
    const entries: Entry[] = [];
    const groups = new Map<string, AllocationRequest[]>();
    for (const r of requests) {
      if (NEGOTIATOR_KINDS.has(r.kind)) {
        const id = r.buildingId;
        let agent = this.utilityAgents.get(id);
        if (!agent) {
          agent = new UtilityAgent(id, r.kind as NegotiatorKind, snapshot.buildings[id]?.name ?? id, this.cfg);
          this.utilityAgents.set(id, agent);
        }
        const balance = this.ledger.ensure(id);
        const base = snapshot.agents[id] ?? fallbackState(r);
        // The engine zeroes allocatedKW at the start of each allocation; show agents their last committed grant.
        const state: UtilityAgentState = {
          ...base,
          // the request is authoritative (net of prosumer self-supply, incl. the sheddable charge part)
          demandKW: pos(r.demandKW),
          minSafeKW: Math.min(pos(r.minSafeKW), pos(r.demandKW)),
          allocatedKW: this.lastFinal.get(id) ?? base.demandKW,
          tokens: balance,
        };
        if (r.dependentDamagePerHour !== undefined && state.dependentDamagePerHour === undefined) state.dependentDamagePerHour = r.dependentDamagePerHour;
        if (state.storage && r.chargeKW !== undefined) state.storage = { ...state.storage, chargeKW: Math.min(pos(r.chargeKW), pos(r.demandKW)) };
        if (agent instanceof UtilityAgent && state.dependents && state.dependents.length > 0) {
          agent.setDependentNames(state.dependents.map((d) => snapshot.buildings[d]?.name ?? d).sort());
        }
        const assessment = agent.assess(state, info);
        let perception: Perception | undefined;
        if (assessment.mode !== 'idle') perception = this.scheduler.resolve(agent.perceptionInput(state, info, assessment.mode));
        entries.push({
          id,
          isCluster: false,
          kind: r.kind,
          name: agent.name,
          members: [r],
          utility: agent,
          state,
          assessment,
          perception,
          proposal: undefined as unknown as Proposal,
          bid: undefined as unknown as UtilityBid,
          demandKW: pos(r.demandKW),
          escrow: 0,
          yielded: 0,
          yieldNotes: [],
          roundOneConceded: 0,
          firstReq: 0,
          firstGrant: 0,
          restored: 0,
          chargeKW: 0,
        });
      } else {
        const cid = this.clusterOf(r.buildingId);
        let g = groups.get(cid);
        if (!g) groups.set(cid, (g = []));
        g.push(r);
      }
    }
    for (const [cid, members] of groups) {
      let agent = this.clusterAgents.get(cid);
      if (!agent) {
        const c = this.clusterById.get(cid) as HouseholdCluster;
        agent = new ClusterAgent(c, this.cfg);
        this.clusterAgents.set(cid, agent);
      }
      this.ledger.ensure(cid);
      const assessment = (agent as ClusterAgent).assess(members, snapshot, info, this.lastFinal);
      let demand = 0;
      for (const m of members) demand += pos(m.demandKW);
      entries.push({
        id: cid,
        isCluster: true,
        kind: 'house',
        name: `${members.length} ${members.length === 1 ? "home" : "homes"} ${this.clusterLabels.get(cid) ?? "near substation " + cid}`,
        members,
        cluster: agent,
        assessment,
        proposal: undefined as unknown as Proposal,
        bid: undefined as unknown as UtilityBid,
        demandKW: demand,
        escrow: 0,
        yielded: 0,
        yieldNotes: [],
        roundOneConceded: 0,
        firstReq: 0,
        firstGrant: 0,
        restored: 0,
        chargeKW: 0,
      });
    }
    entries.sort((a, b) => cmpId(a.id, b.id));
    return entries;
  }

  /** kW of concession that really freed power: round-1 offers count when the agent was fully served, later ones only above its provisional grant. */
  private reallyReleased(e: Entry): number {
    const r1 = e.firstGrant + 0.5 >= e.firstReq ? e.roundOneConceded : 0;
    const later = Math.max(0, Math.min(e.firstReq - e.bid.requestKW, e.firstGrant - e.bid.requestKW));
    return r1 + later;
  }

  /** Apply contract obligations and sanitise tokens: produces the working bid for the round. */
  private prepareBid(e: Entry, tMin: number): void {
    let bid = e.proposal.bid;
    e.yielded = 0;
    e.yieldNotes = [];
    if (!e.isCluster) {
      for (const ob of this.contracts.obligations(e.id, tMin)) {
        const room = Math.max(0, bid.requestKW - bid.minSafeKW);
        if (ob.role === 'receiver' && room < ob.kw - EPS) {
          this.contracts.default(ob.contractId, tMin);
          e.yieldNotes.push(`Defaulted on ${ob.contractId}: repaying ${kw(ob.kw)} kW would breach its minimum-safe floor`);
          continue;
        }
        const cut = Math.min(ob.kw, room);
        if (cut <= EPS) continue;
        bid = { ...bid, requestKW: bid.requestKW - cut, concededKW: bid.concededKW + cut };
        e.yielded += cut;
        e.yieldNotes.push(ob.role === 'giver' ? `Yielding ${kw(cut)} kW under ${ob.contractId}` : `Repaying ${kw(cut)} kW under ${ob.contractId}`);
      }
    }
    const balance = this.ledger.balance(e.id);
    const offered = Math.min(pos(bid.tokensOffered), balance);
    if (offered !== bid.tokensOffered) bid = { ...bid, tokensOffered: offered };
    e.bid = bid;
    let ch = 0;
    if (e.utility instanceof UtilityAgent) ch = e.utility.lastCharge.requestedKW;
    e.chargeKW = Math.min(pos(ch), Math.max(0, bid.requestKW - bid.minSafeKW));
  }

  /**
   * If the concessions overshoot (Σ requests < supply), hand the surplus back pro-rata to the conceders so spare
   * supply is not wasted while an agent runs below its demand. Contract yields are never withdrawn.
   * Returns true when any bid changed.
   */
  private restoreSlack(entries: Entry[], supply: number): boolean {
    let slack = supply - this.totalRequest(entries);
    if (slack <= EPS) return false;
    let pool = 0;
    for (const e of entries) pool += Math.max(0, e.bid.concededKW - e.yielded);
    if (pool <= EPS) return false;
    const k = Math.min(1, slack / pool);
    for (const e of entries) {
      const back = Math.max(0, e.bid.concededKW - e.yielded) * k;
      if (back <= EPS) continue;
      e.bid = { ...e.bid, requestKW: e.bid.requestKW + back, concededKW: e.bid.concededKW - back };
      e.restored = back;
      slack -= back;
    }
    return true;
  }

  private clearRound(
    supply: number,
    entries: Entry[],
    perceptions: Record<string, Perception | undefined>,
    present: ReadonlySet<string>,
    tMin: number,
  ): ClearingResult {
    const bids = entries.map((e) => e.bid);
    const chargeKW: Record<string, number> = {};
    for (const e of entries) if (e.chargeKW > EPS) chargeKW[e.id] = e.chargeKW;
    return clear(supply, bids, { cfg: this.cfg, perceptions, contractClaims: this.contracts.claims(tMin, present), chargeKW });
  }

  private roundRecord(round: number, supply: number, entries: Entry[], result: ClearingResult, conceded: { e: Entry; kw: number }[]): NegotiationRound {
    const total = this.totalRequest(entries);
    return {
      round,
      deficitKW: Math.max(0, total - supply),
      totalRequestKW: total,
      provisional: { ...result.grants },
      concessions: conceded.map(({ e, kw: k }) => ({ agentId: e.id, kw: k, stance: e.proposal.brief.stance })),
    };
  }

  /** Round ≥ 2: sign forward contracts from givers' new concessions to short, urgent receivers on the same island. */
  private createContracts(
    entries: Entry[],
    conceded: { e: Entry; kw: number }[],
    first: ClearingResult,
    tMin: number,
    notes: Map<string, string[]>,
    made: ForwardContract[],
  ): void {
    const cfg = this.cfg;
    const givers = conceded
      .filter((c) => !c.e.isCluster && c.kw >= cfg.contractMinKW)
      .sort((a, b) => b.kw - a.kw || cmpId(a.e.id, b.e.id));
    if (givers.length === 0) return;
    const gaveIds = new Set(conceded.map((c) => c.e.id));
    const receivers = entries
      .filter((e) => {
        if (e.isCluster || gaveIds.has(e.id)) return false;
        const projected = first.grants[e.id] ?? 0;
        return projected < e.bid.minSafeKW - EPS || (projected < 0.9 * e.bid.requestKW && e.bid.urgency >= 0.6);
      })
      .sort((a, b) => first.priority[b.id].score - first.priority[a.id].score || cmpId(a.id, b.id));
    if (receivers.length === 0) return;
    const assigned = new Map<string, number>();
    for (const g of givers) {
      // only power the giver really releases can move: its provisional grant above its new request
      let remaining = Math.min(g.kw, Math.max(0, (first.grants[g.e.id] ?? 0) - g.e.bid.requestKW));
      if (remaining < cfg.contractMinKW) continue;
      for (const r of receivers) {
        if (remaining < 1) break;
        if (!this.contracts.canSign(g.e.id)) break;
        if (!this.contracts.canSign(r.id) || this.contracts.hasPair(g.e.id, r.id)) continue;
        const need = Math.max(0, r.bid.requestKW - (first.grants[r.id] ?? 0) - (assigned.get(r.id) ?? 0));
        const nowKW = Math.min(remaining, need);
        if (nowKW < 1) continue;
        const c = this.contracts.create(g.e.id, r.id, nowKW, cfg.contractReturnRatio * nowKW, tMin);
        if (!c) continue;
        made.push(c);
        remaining -= nowKW;
        assigned.set(r.id, (assigned.get(r.id) ?? 0) + nowKW);
        const gn = `Signed ${c.id}: yields ${kw(nowKW)} kW to ${r.name} for ${cfg.contractNowMin} min, repaid with ${kw(c.laterKW)} kW later`;
        const rn = `Signed ${c.id}: receives ${kw(nowKW)} kW from ${g.e.name}, to repay ${kw(c.laterKW)} kW later`;
        notes.set(g.e.id, [...(notes.get(g.e.id) ?? []), gn]);
        notes.set(r.id, [...(notes.get(r.id) ?? []), rn]);
      }
    }
  }

  private explain(p: Pending, e: Entry, finalKW: number, validatorNotes: string[], spent: number, earned: number): AllocationExplanation {
    const res = p.result;
    const id = e.id;
    const bid = e.bid;
    const pr = res.priority[id];
    const phase1 = res.phase1[id] ?? 0;
    const phase2 = res.phase2[id] ?? 0;
    const received = res.contract[id] ?? 0;
    const contractNet = received - e.yielded;
    const proposed = res.grants[id] ?? 0;
    const triaged = res.triaged[id] ?? false;
    const original = bid.originalRequestKW;
    const pct = original > EPS ? Math.round((finalKW / original) * 100) : 100;
    const info = p.info;

    // Everything the text needs is copied into locals now (agents and pending state are reused next minute); the text
    // itself is built on first read of `reason` (the UI shows one agent at a time), so it does not retain `p` or `e`.
    const lc = e.utility instanceof UtilityAgent ? { mode: e.utility.lastCharge.mode, concededKW: e.utility.lastCharge.concededKW } : undefined;
    const isCluster = e.isCluster;
    const nMembers = e.members.length;
    const name = e.name;
    const yielded = e.yielded;
    const restored = e.restored;
    const chargeKW = e.chargeKW;
    const yieldNotes = e.yieldNotes;
    const cNotes = p.contractNotes.get(id);
    const nEntries = p.entries.length;
    const rank = res.rank[id];
    const regime = res.regime;
    const totalMinSafe = res.totalMinSafeKW;
    const chargeServed = res.charge[id] ?? 0;
    const build = (): string => {
      const subject = isCluster ? `This ${nMembers}-home cluster` : name;
      const parts: string[] = [];
      let s1 = `${subject} received ${kw(finalKW)} of ${kw(original)} kW (${pct}%).`;
      if (bid.concededKW > 0.5) s1 += ` It offered to draw only ${kw(bid.requestKW)} kW, conceding ${kw(bid.concededKW)} kW of flexible load.`;
      parts.push(s1);

      let s2: string;
      if (triaged) {
        s2 = `Supply could not cover every minimum-safe floor on island ${info.islandId}, so floors were granted in order of need and only ${kw(phase1)} of its ${kw(bid.minSafeKW)} kW floor was protected`;
      } else if (bid.minSafeKW > 0.5) {
        s2 = `Its ${kw(bid.minSafeKW)} kW minimum-safe floor was protected in phase 1`;
      } else {
        s2 = 'It has no protected minimum-safe floor';
      }
      if (phase2 > 0.5) s2 += `; ${kw(phase2)} kW came from the need-weighted share`;
      if (received > 0.5) s2 += `; ${kw(received)} kW arrived through a forward contract`;
      if (yielded > 0.5) s2 += `; ${kw(yielded)} kW was yielded under a forward contract`;
      s2 += ` — rank ${rank} of ${nEntries} (score ${f2(pr.score)}: criticality ${f2(pr.terms.criticality)}, urgency ${f2(pr.terms.urgency)}, damage ${f2(pr.terms.damage)}).`;
      parts.push(s2);

      let s3: string;
      if (regime === 'surplus') s3 = `Island ${info.islandId} had enough supply (${mw(info.supplyKW)} for ${mw(info.totalRequestKW)} requested).`;
      else if (regime === 'triage') s3 = `Island ${info.islandId} was in triage: ${mw(info.supplyKW)} of supply against ${mw(totalMinSafe)} of minimum-safe load.`;
      else s3 = `Island ${info.islandId} was ${mw(info.deficitKW)} short.`;
      if (earned > 0.001) s3 += ` Earned ${earned.toFixed(2)} tokens for the verified concession.`;
      if (spent > 0.001) s3 += ` Spent ${spent.toFixed(2)} of its offered tokens (capped weight ${f2(pr.weights.tokens)}).`;
      parts.push(s3);

      const sunUp = (info.minutesToSunset ?? 0) > 0;
      if (info.microgrid && (info.prosumerKW ?? 0) > 0) {
        parts.push(`Island ${info.islandId} is a microgrid on ${kw(info.prosumerKW ?? 0)} kW of rooftop solar${info.surplusKW ? ` (${kw(info.surplusKW)} kW above the non-charging demand)` : ''}.`);
      } else if ((info.prosumerKW ?? 0) > 0.5) {
        parts.push(`Prosumers export ${kw(info.prosumerKW ?? 0)} kW of rooftop solar onto island ${info.islandId}.`);
      }
      if (chargeServed > 0.5) {
        parts.push(`${kw(chargeServed)} kW of its grant was buffer ${sunUp && (info.surplusKW ?? 0) > 0 ? 'pre-charging from the midday solar surplus' : 'charging'}, served only after every other load on the island.`);
      } else if (lc && lc.mode === 'coast' && lc.concededKW >= 0.5) {
        parts.push(`It is coasting on its reserve, deferring ${kw(lc.concededKW)} kW of buffer charging so other loads keep power.`);
      } else if (chargeKW > 0.5) {
        parts.push(`Its ${kw(chargeKW)} kW of buffer charging got no power: it is served last, after all other demand.`);
      }
      if (restored > 0.5) parts.push(`${kw(restored)} kW of its offered concession was withdrawn because the shortfall was already covered.`);
      const extra = [...yieldNotes, ...(cNotes ?? [])];
      if (extra.length > 0) parts.push(`${extra.join('; ')}.`);
      if (validatorNotes.length > 0) parts.push(`Safety validator: ${validatorNotes.slice(0, 2).join('; ')}.`);
      if (finalKW + 1e-6 < proposed) parts.push(`Final ${kw(finalKW)} kW after validation (proposed ${kw(proposed)} kW).`);
      return parts.join(' ');
    };
    let reason: string | undefined;
    return {
      agentId: id,
      tMin: p.tMin,
      islandId: p.islandId,
      requestKW: bid.requestKW,
      minSafeKW: bid.minSafeKW,
      phase1KW: phase1,
      phase2KW: phase2,
      contractKW: contractNet,
      proposedKW: proposed,
      finalKW,
      rank: res.rank[id],
      ofN: p.entries.length,
      priority: pr,
      minSafeMet: finalKW + 1e-6 >= bid.minSafeKW,
      triaged,
      concededKW: bid.concededKW,
      tokensEarned: earned,
      tokensSpent: spent,
      validatorNotes,
      get reason(): string {
        return reason ?? (reason = build());
      },
    };
  }
}
