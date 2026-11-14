/** Mock Layer 2 / Layer 3 snapshots derived from the MockEngine state. Dev only; mimics the real shapes. */
import { buildStory } from './devMockStory';
import type {
  FeedMessage,
  NegotiationEvent,
  NegotiationReplay,
  AgentDossier,
  AgentMode,
  AuditEntry,
  BidRecord,
  ConsumerKind,
  ForwardContract,
  IslandTrace,
  LedgerEntry,
  NegotiationSnapshot,
  Perception,
  PriorityWeights,
  SafetySnapshot,
  SimSnapshot,
  Stance,
  UtilityAgentState,
} from '../core/types';

const WEIGHTS: PriorityWeights = { criticality: 0.35, urgency: 0.25, damage: 0.25, tokens: 0.03, fairness: 0.12 };
const HIST_CAP = 120;
const N_CLUSTERS = 4;

const ARGS: Record<string, string> = {
  hospital: 'ICU ventilators and surgery theatres depend on this feed; backup fuel is finite.',
  emergency: 'Dispatch and radio must stay up while incident calls are rising.',
  water: 'Pumps keep pressure for the hospital and shelters downstream.',
  telecom: 'Emergency calls route through this tower; battery is draining.',
  school: 'Shelter is housing evacuees, some with medical needs.',
  house: 'Homes in this cluster need lights, fridges and medical devices.',
};

export class MockNeg {
  private hist = new Map<string, BidRecord[]>();
  private ledger: LedgerEntry[] = [];
  private audit: AuditEntry[] = [];
  private counts: Record<string, number> = {};
  private balances = new Map<string, number>();
  private calls = 0;
  private errors = 0;
  private triage = 0;
  private starve = new Map<string, number>();
  private replays: NegotiationReplay[] = [];
  private events: NegotiationEvent[] = [];
  private feed: FeedMessage[] = [];
  private storyN = 0;
  private storySeen = new Set<number>();

  reset() {
    this.replays = [];
    this.events = [];
    this.feed = [];
    this.storyN = 0;
    this.storySeen.clear();
    this.hist.clear();
    this.ledger = [];
    this.audit = [];
    this.counts = {};
    this.balances.clear();
    this.calls = this.errors = this.triage = 0;
    this.starve.clear();
  }

  private clusters(s: SimSnapshot) {
    const houses = Object.keys(s.agents).filter((id) => s.agents[id].kind === 'house');
    const map: Record<string, string> = {};
    const members: Record<string, string[]> = {};
    houses.forEach((id, i) => {
      const cid = `cluster-${i % N_CLUSTERS}`;
      map[id] = cid;
      (members[cid] ??= []).push(id);
    });
    return { map, members };
  }

  update(s: SimSnapshot): { negotiation: NegotiationSnapshot; safety: SafetySnapshot } {
    const t = s.tMin;
    const { map, members } = this.clusters(s);
    const rnd = (k: number) => Math.abs(Math.sin(t * 12.9898 + k * 78.233)) % 1;

    // Build agent views: individual non-house consumers plus house clusters.
    interface V {
      id: string;
      kind: ConsumerKind;
      a: UtilityAgentState;
      demand: number;
      alloc: number;
      floor: number;
      mem?: string[];
    }
    const views: V[] = [];
    for (const a of Object.values(s.agents)) if (a.kind !== 'house') views.push({ id: a.buildingId, kind: a.kind, a, demand: a.demandKW, alloc: a.allocatedKW, floor: a.minSafeKW });
    for (const [cid, mem] of Object.entries(members)) {
      const ag = mem.map((m) => s.agents[m]);
      const sum = (f: (x: UtilityAgentState) => number) => ag.reduce((n, x) => n + f(x), 0);
      views.push({
        id: cid,
        kind: 'house',
        a: { ...ag[0], urgency: sum((x) => x.urgency) / ag.length },
        demand: sum((x) => x.demandKW),
        alloc: sum((x) => x.allocatedKW),
        floor: sum((x) => x.minSafeKW),
        mem,
      });
    }

    const island = (v: V) => (v.mem ? 1 : Number(v.id.split('-')[1]) % 2);
    const traces: IslandTrace[] = [];
    const deficitOf = new Map<number, number>();
    const rank = new Map<string, number>();
    const score = new Map<string, number>();
    for (const iid of [0, 1]) {
      const vs = views.filter((v) => island(v) === iid);
      const totalReq = vs.reduce((n, v) => n + v.demand, 0);
      const supply = vs.reduce((n, v) => n + v.alloc, 0);
      const floors = vs.reduce((n, v) => n + v.floor, 0);
      const regime = floors > supply ? 'triage' : totalReq > supply * 1.001 ? 'shortage' : 'surplus';
      deficitOf.set(iid, Math.max(0, totalReq - supply));
      if (regime === 'triage' && t % 6 === 0) this.triage++;
      for (const v of vs) score.set(v.id, +(WEIGHTS.criticality * v.a.criticality + WEIGHTS.urgency * v.a.urgency + WEIGHTS.damage * Math.min(1, v.a.expectedDamagePerHour / 120) - WEIGHTS.fairness * (v.alloc / Math.max(1, v.demand)) * 0.5).toFixed(3));
      [...vs].sort((x, y) => score.get(y.id)! - score.get(x.id)!).forEach((v, i) => rank.set(v.id, i + 1));
      const conc = vs.filter((v) => v.a.criticality < 0.6 && totalReq > supply).slice(0, 4);
      const rounds = [1, 2, 3].map((r) => ({
        round: r,
        deficitKW: Math.max(0, (totalReq - supply) * (1 - 0.3 * (r - 1))),
        totalRequestKW: totalReq,
        provisional: {},
        concessions: conc.map((v, i) => ({ agentId: v.id, kw: v.demand * 0.08 * (r + (i % 2)), stance: (i % 2 ? 'FULL_FLEX_SHED' : 'PARTIAL_CONCESSION') as Stance })),
      }));
      traces.push({
        islandId: iid,
        tMin: t,
        supplyKW: supply,
        totalRequestKW: totalReq,
        totalMinSafeKW: floors,
        regime,
        weights: WEIGHTS,
        rounds: regime === 'surplus' ? rounds.slice(0, 1).map((r) => ({ ...r, concessions: [] })) : rounds,
        activeAgents: vs.filter((v) => v.a.urgency > 0.4 || v.a.criticality >= 0.85).map((v) => v.id),
        cooperatingAgents: conc.map((v) => v.id),
        durationMs: 3 + rnd(iid) * 4,
      });
    }

    const agents: Record<string, AgentDossier> = {};
    let tokenSupply = 0;
    for (const v of views) {
      const iid = island(v);
      const urgent = v.a.urgency > 0.4 || v.a.criticality >= 0.85;
      const def = deficitOf.get(iid)! > 0;
      const mode: AgentMode = urgent ? 'active' : def && v.a.criticality < 0.6 ? 'cooperating' : 'idle';
      const stance: Stance = v.a.criticality >= 0.8 && urgent ? 'CRITICAL_HOLD' : mode === 'cooperating' ? 'FULL_FLEX_SHED' : 'PARTIAL_CONCESSION';
      const flex = v.demand * (v.kind === 'hospital' ? 0.12 : 0.3);
      const conceded = mode === 'active' ? (stance === 'CRITICAL_HOLD' ? 0 : flex * 0.5) : mode === 'cooperating' ? flex : 0;
      const request = Math.max(v.floor, v.demand - conceded);
      const p1 = Math.min(v.floor, v.alloc);
      const contract = v.id === 'hospital-0' && t > 120 ? 40 : v.id === 'school-1' && t > 120 ? -40 : 0;
      const trim = v.id.startsWith('hospital') && t % 11 === 0 ? 0 : 0;
      const finalKW = v.alloc;
      const proposed = finalKW + (t % 17 === 0 && v.kind === 'water' ? 18 : trim);
      const p2 = Math.max(0, proposed - p1 - contract);
      const tokens = this.balances.get(v.id) ?? 100;
      const per: Perception | undefined =
        mode === 'idle'
          ? undefined
          : { agentId: v.id, source: (v.id.charCodeAt(0) + (v.mem ? 1 : 0)) % 3 === 0 ? 'heuristic' : 'jev', tMin: t - (t % 5), urgency: v.a.urgency, damage: Math.min(1, v.a.expectedDamagePerHour / 120), imminentFailureRisk: Math.min(1, v.a.urgency * 0.8 + 0.05), canConcede: flex / Math.max(1, v.demand) * 2.2, concessionStrategy: 'shed_25_flex', confidence: 0.6 + (rnd(3) * 0.3) };
      const terms = { criticality: v.a.criticality, urgency: v.a.urgency, damage: Math.min(1, v.a.expectedDamagePerHour / 120), tokens: Math.min(1, tokens / 200), fairness: Math.min(1, v.alloc / Math.max(1, v.demand)) * 0.5 };
      const triaged = traces[iid].regime === 'triage';
      const rec: BidRecord = {
        tMin: t,
        rounds: mode === 'idle' ? 1 : 3,
        bid: {
          agentId: v.id, kind: v.kind, islandId: iid, tMin: t, round: 3, mode, requestKW: request, originalRequestKW: v.demand, minSafeKW: v.floor,
          criticality: v.a.criticality, urgency: v.a.urgency, expectedDamagePerHour: v.a.expectedDamagePerHour, flexibleKW: flex, flex: [], concededKW: conceded,
          concessionWillingness: 0.6, backupRemainingKWh: v.a.backup.remainingKWh, backupHours: v.a.backup.maxKW > 0 ? v.a.backup.remainingKWh / v.a.backup.maxKW : Infinity,
          recentServedShare: terms.fairness * 2, tokensOffered: mode === 'active' ? 2 : 0, memberIds: v.mem,
        },
        brief: {
          agentId: v.id, utilityType: v.mem ? 'household_cluster' : (v.kind as 'hospital'), stance, jevUrgencyScore: per?.urgency ?? 0, jevDamageScore: per?.damage ?? 0, jevConfidence: per?.confidence ?? 0,
          perceptionSource: per?.source ?? 'none', primaryArgument: ARGS[v.kind], renegotiationRound: 3,
          concessionOffer: conceded > 0 ? `Will shed ${Math.round(conceded)} kW of flexible load (${v.kind === 'hospital' ? 'admin HVAC' : 'non-essential load'}) for a better share later.` : 'No concession: holding the protected floor.',
        },
        explanation: {
          agentId: v.id, tMin: t, islandId: iid, requestKW: request, minSafeKW: v.floor, phase1KW: p1, phase2KW: p2, contractKW: contract, proposedKW: proposed, finalKW,
          rank: rank.get(v.id)!, ofN: views.filter((x) => island(x) === iid).length,
          priority: { score: score.get(v.id)!, weights: WEIGHTS, terms }, minSafeMet: finalKW >= v.floor - 0.5, triaged, concededKW: conceded,
          tokensEarned: conceded > 0 ? 1.5 : 0, tokensSpent: mode === 'active' ? 2 : 0,
          validatorNotes: proposed !== finalKW ? ['Trimmed to stay within feeder capacity.'] : [],
          reason: `Ranked ${rank.get(v.id)} of ${views.filter((x) => island(x) === iid).length} on island ${iid}: criticality ${Math.round(terms.criticality * 100)}% and urgency ${Math.round(terms.urgency * 100)}% weigh most. ${finalKW >= v.floor - 0.5 ? 'Its protected floor is covered' : 'The island could not cover its floor'}${contract ? `, adjusted ${contract > 0 ? '+' : '−'}${Math.abs(contract)} kW by a forward contract` : ''}.`,
        },
      };
      const list = this.hist.get(v.id) ?? [];
      list.push(rec);
      if (list.length > HIST_CAP) list.shift();
      this.hist.set(v.id, list);
      if (finalKW < v.floor - 0.5) this.starve.set(v.id, (this.starve.get(v.id) ?? 0) + 1);
      else this.starve.delete(v.id);
      // ledger
      const k = v.id.length * 7 + (t % 23);
      if (t % 9 === k % 9 && (mode !== 'idle' || t % 27 === 0)) {
        const delta = conceded > 0 ? 1.5 : -2;
        this.balances.set(v.id, +(tokens + delta).toFixed(2));
        this.ledger.push({ tMin: t, agentId: v.id, delta, balance: +(tokens + delta).toFixed(2), reason: delta > 0 ? 'concession' : 'spend' });
      }
      tokenSupply += this.balances.get(v.id) ?? 100;
      agents[v.id] = {
        agentId: v.id, kind: v.kind, mode, affected: mode === 'active', islandId: iid,
        affectedReasons: mode === 'active' ? [`Island deficit ${Math.round(deficitOf.get(iid)!)} kW`, v.a.backup.type !== 'none' && v.alloc < v.demand ? 'On backup power' : 'Urgency above 45%', ...(s.disasters.some((d) => d.active) ? ['Disaster active nearby'] : [])] : mode === 'cooperating' ? ['Asked to use less: island is short'] : [],
        perception: per, perceptionAgeMin: per ? t - per.tMin : undefined, current: rec, history: list, tokens: this.balances.get(v.id) ?? 100,
        contractIds: contract ? ['c1'] : [], memberIds: v.mem,
      };
      if (per) this.calls += t % 5 === 0 ? 1 : 0;
    }
    if (this.ledger.length > 200) this.ledger.splice(0, this.ledger.length - 200);

    // audit
    const crit = views.find((v) => v.alloc < v.floor - 0.5 && v.a.criticality > 0.7);
    if (crit && t % 4 === 0) this.push({ tMin: t, islandId: island(crit), rule: 'min-safe', severity: 'crit', agentId: crit.id, proposedKW: crit.alloc, correctedKW: crit.floor, reason: 'Critical floor could not be fully protected.' }, 'min-safe');
    if (t % 13 === 0) this.push({ tMin: t, islandId: 0, rule: 'edge-capacity', severity: 'warn', agentId: 'water-0', proposedKW: 780, correctedKW: 750, reason: 'Proposed grant exceeded feeder capacity; clipped.' }, 'edge-capacity');
    if (t % 31 === 0) this.push({ tMin: t, islandId: 1, rule: 'sanitize', severity: 'info', reason: 'Non-finite request replaced with demand.' }, 'sanitize');
    if (this.triage && t % 6 === 0 && traces.some((x) => x.regime === 'triage')) this.push({ tMin: t, islandId: traces.find((x) => x.regime === 'triage')!.islandId, rule: 'triage', severity: 'warn', reason: 'Sum of floors exceeds supply: lowest-priority floors reduced first.' }, 'triage');

    // story: a recorded negotiation every 30 sim-minutes, alternating islands (docs/STORY.md)
    if (t > 0 && t % 30 === 15) {
      const iid = this.storyN % 2;
      const first = !this.storySeen.has(iid);
      this.storySeen.add(iid);
      const st = buildStory(s, { agents }, t, iid, this.storyN % 3, first);
      this.storyN++;
      this.replays.push(st.replay);
      this.events.push(...st.events);
      this.feed.push(...st.feed);
      if (this.replays.length > 40) this.replays.shift();
      if (this.events.length > 100) this.events.splice(0, this.events.length - 100);
      if (this.feed.length > 300) this.feed.splice(0, this.feed.length - 300);
    }

    const m = s.metrics;
    const contracts: ForwardContract[] =
      t > 120
        ? [
            { id: 'c1', giverId: 'school-1', receiverId: 'hospital-0', nowKW: 40, laterKW: 48, createdMin: 120, nowUntilMin: 180, laterFromMin: 240, laterToMin: 280, tokenStake: 3, status: t < 180 ? 'open' : 'repaying', note: 'Shelter yields for ICU surge, repaid after the evening peak.' },
            { id: 'c2', giverId: 'telecom-2', receiverId: 'emergency-0', nowKW: 6, laterKW: 7, createdMin: 100, nowUntilMin: 130, laterFromMin: 150, laterToMin: 170, tokenStake: 1, status: 'honoured' },
            { id: 'c3', giverId: 'cluster-1', receiverId: 'water-1', nowKW: 25, laterKW: 30, createdMin: 140, nowUntilMin: 190, laterFromMin: 230, laterToMin: 260, tokenStake: 2, status: 'open' },
          ]
        : [];

    return {
      negotiation: {
        policy: 'negotiation', tMin: t, agents, houseCluster: map, islands: traces, contracts, ledger: this.ledger, tokenSupply,
        perception: { provider: 'jev', enabled: true, inFlight: t % 5 === 0 ? 3 : 0, calls: this.calls, errors: this.errors, lastError: this.errors ? 'timeout' : undefined, avgLatencyMs: 420 + rnd(9) * 60 },
        replays: this.replays,
        events: this.events,
        feed: this.feed,
      },
      safety: {
        validator: 'safety', tMin: t, audit: this.audit, counts: this.counts, violationsCommitted: 0, triageEvents: this.triage,
        starving: [...this.starve].map(([agentId, minutes]) => ({ agentId, minutes })).slice(0, 5),
        maxEdgeUtilisation: Math.min(1, m.supplyKW > 0 ? 0.55 + (m.demandKW / Math.max(1, m.supplyKW)) * 0.3 : 0.5),
      },
    };
  }

  private push(e: AuditEntry, rule: string) {
    this.audit.push(e);
    if (this.audit.length > 80) this.audit.shift();
    this.counts[rule] = (this.counts[rule] ?? 0) + 1;
  }
}
