/**
 * Story recorder (docs/STORY.md §5): turns the negotiation of an island-minute into a step-by-step
 * `NegotiationReplay`, plus story events and the plain-language chat feed.
 *
 * Cost model: while the orchestrator runs, it only hands this module *references* to objects it already
 * builds (bids, briefs, clearing results). RoundBid / ReplayStage objects and all caption / feed text are
 * materialised only for the island-minutes selected for recording. Pure: no DOM / three / Node APIs.
 */
import type {
  AgentCaseBrief,
  AllocationRequest,
  AuditEntry,
  ConsumerKind,
  FeedMessage,
  ForwardContract,
  NegotiationEvent,
  NegotiationReplay,
  Perception,
  ReplayStage,
  RoundBid,
  UtilityBid,
} from '../core/types';
import type { Assessment, Proposal, PublicIslandInfo } from './agentApi';
import type { ClearingResult } from './clearing';
import type { NegotiationConfig } from './config';

const MAX_REPLAYS = 40;
const MAX_EVENTS = 100;
const MAX_FEED = 300;
/** Minimum sim-minutes between two recorded replays of the same island. */
const REPLAY_EVERY_MIN = 5;
/** …but a notable happening (contract, big concession) may record sooner. */
const REPLAY_EARLY_MIN = 2;
const SHORTAGE_EVENT_GAP = 60;
const TRIAGE_EVENT_GAP = 30;
const RECOVERED_EVENT_GAP = 30;
const MICRO_EVENT_GAP = 60;
const VETO_EVENT_GAP = 10;
const BIG_CONCESSION_KW = 200;
const BIG_CONCESSION_AGENT_GAP = 60;
const HOSPITAL_BACKUP_GAP = 240;
const HEADLINE_GAP = 15;
const VETO_KW = 50;
const FEED_REPEAT_MIN = 30;
const FEED_CHANGE = 0.1;

const kw = (x: number): string => {
  const r = Math.round(Number.isFinite(x) ? x : 0);
  return r < 1000 && r > -1000 ? String(r) : String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};
const mw = (x: number): string => (Math.abs(x) >= 1000 ? `${(x / 1000).toFixed(1)} MW` : `${kw(x)} kW`);
const f2 = (x: number): string => x.toFixed(2);
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Structural subset of the orchestrator's per-agent entry (policy.ts keeps the full type). */
export interface StoryEntry {
  id: string;
  isCluster: boolean;
  kind: ConsumerKind;
  name: string;
  members: AllocationRequest[];
  assessment: Assessment;
  perception?: Perception;
  proposal: Proposal;
  bid: UtilityBid;
}

export interface RoundSnap {
  round: number;
  /** bids / briefs aligned with the capture's entries, as they stood after this round's proposals */
  bids: UtilityBid[];
  briefs: AgentCaseBrief[];
  /** clearing after this round */
  result: ClearingResult;
  /** shortfall (kW) the notice for this round announced; 0 for round 1 */
  deficitBefore: number;
  totalReq: number;
  totalMin: number;
  conceded: { e: StoryEntry; kw: number }[];
  contracts: ForwardContract[];
}

export interface StoryCapture {
  islandId: number;
  tMin: number;
  info: PublicIslandInfo;
  entries: StoryEntry[];
  regime: ClearingResult['regime'];
  force: boolean;
  events: NegotiationEvent[];
  rounds: RoundSnap[];
  /** set by finalize() when this island-minute is recorded */
  replay?: NegotiationReplay;
  proposedKW?: number[];
  finalGrants?: Record<string, number>;
  /** island headline / notice / grant summary go to the chat feed for this replay */
  chatty?: boolean;
}

interface IslandMemo {
  regime: ClearingResult['regime'] | null;
  lastReplay: number;
  lastShortage: number;
  lastTriage: number;
  lastRecovered: number;
  lastMicro: number;
  lastVeto: number;
  micro: boolean;
  /** last island headline in the chat feed (repeated only when it changes or after a while) */
  headTMin: number;
  headDeficit: number;
  headRegime: string;
}

interface MsgMemo {
  tMin: number;
  stance: string;
  req: number;
}

export interface CommitInfo {
  /** committed kW per capture entry (Σ members) */
  finals: number[];
  earned: number[];
  spent: number[];
}

export class StoryRecorder {
  private replays: NegotiationReplay[] = [];
  private events: NegotiationEvent[] = [];
  private feed: FeedMessage[] = [];
  private evIds = new Set<string>();
  private islands = new Map<number, IslandMemo>();
  private msgMemo = new Map<string, MsgMemo>();
  private lastBig = new Map<string, number>();
  private seq = 0;
  private ver = 0;
  private cached: { ver: number; replays: NegotiationReplay[]; events: NegotiationEvent[]; feed: FeedMessage[] } | null = null;

  constructor(_cfg?: Pick<NegotiationConfig, 'recordStory'>) {
    void _cfg;
  }

  reset(): void {
    this.replays = [];
    this.events = [];
    this.feed = [];
    this.evIds.clear();
    this.islands.clear();
    this.msgMemo.clear();
    this.lastBig.clear();
    this.seq = 0;
    this.ver++;
    this.cached = null;
  }

  /** Arrays for NegotiationSnapshot (identity is stable while nothing new was recorded). */
  snapshot(): { replays: NegotiationReplay[]; events: NegotiationEvent[]; feed: FeedMessage[] } {
    if (!this.cached || this.cached.ver !== this.ver) {
      this.cached = { ver: this.ver, replays: this.replays.slice(), events: this.events.slice(), feed: this.feed.slice() };
    }
    return this.cached;
  }

  // ───────────────────────────── capture (cheap, reference-only) ─────────────────────────────

  private memo(islandId: number): IslandMemo {
    let m = this.islands.get(islandId);
    if (!m) {
      m = { regime: null, lastReplay: -1e9, lastShortage: -1e9, lastTriage: -1e9, lastRecovered: -1e9, lastMicro: -1e9, lastVeto: -1e9, micro: false, headTMin: -1e9, headDeficit: 0, headRegime: "" };
      this.islands.set(islandId, m);
    }
    return m;
  }

  /**
   * Called once per island-minute right after the round-1 clearing. Tracks the island's regime (emitting
   * shortage / triage / recovered / microgrid events) and returns a capture when this minute may be recorded.
   */
  begin(islandId: number, tMin: number, info: PublicIslandInfo, entries: StoryEntry[], r1: ClearingResult, conceded1: { e: StoryEntry; kw: number }[]): StoryCapture | null {
    const m = this.memo(islandId);
    const prev = m.regime;
    m.regime = r1.regime;
    const wasMicro = m.micro;
    m.micro = !!info.microgrid;

    const hasUtil = entries.length >= 2 && entries.some((e) => !e.isCluster);
    const eligible = r1.regime !== 'surplus' && hasUtil;
    let force = false;
    const evs: NegotiationEvent[] = [];
    const short = Math.max(0, r1.totalRequestKW - info.supplyKW);

    if (eligible) {
      if (r1.regime === 'triage' && prev !== 'triage' && tMin - m.lastTriage >= TRIAGE_EVENT_GAP) {
        m.lastTriage = tMin;
        force = true;
        evs.push(
          this.event('triage_start', tMin, islandId, 3, `Island ${islandId} is in triage: only ${mw(info.supplyKW)} of power for ${mw(r1.totalMinSafeKW)} of life-safety minimums, so some agents cannot even get their minimum.`, [], ''),
        );
      } else if (r1.regime === 'shortage' && (prev === null || prev === 'surplus') && tMin - m.lastShortage >= SHORTAGE_EVENT_GAP) {
        m.lastShortage = tMin;
        force = true;
        evs.push(
          this.event('shortage_start', tMin, islandId, 3, `Island ${islandId} is ${mw(short)} short (${mw(info.supplyKW)} available, ${mw(r1.totalRequestKW)} requested): ${plural(entries.length, 'agent')} start to negotiate.`, [], ''),
        );
      }
    }
    if (r1.regime === 'surplus' && prev !== null && prev !== 'surplus' && tMin - m.lastRecovered >= RECOVERED_EVENT_GAP) {
      m.lastRecovered = tMin;
      evs.push(this.event('recovered', tMin, islandId, 1, `Island ${islandId} is back to surplus: ${mw(info.supplyKW)} now covers the ${mw(r1.totalRequestKW)} requested.`, [], ''));
    }
    if (info.microgrid && !wasMicro && entries.length >= 2 && tMin - m.lastMicro >= MICRO_EVENT_GAP) {
      m.lastMicro = tMin;
      evs.push(
        this.event('microgrid', tMin, islandId, 2, `Island ${islandId} runs as a microgrid with no power plant of its own${(info.prosumerKW ?? 0) > 0.5 ? `, living on ${mw(info.prosumerKW ?? 0)} of rooftop solar` : ''}; ${plural(entries.length, 'agent')} share it.`, [], ''),
      );
    }

    if (!eligible) {
      return null;
    }
    if (!force && tMin - m.lastReplay < REPLAY_EARLY_MIN) {
      return null;
    }
    const cap: StoryCapture = { islandId, tMin, info, entries, regime: r1.regime, force, events: evs, rounds: [], };
    this.addRound(cap, 1, entries, r1, short, r1.totalRequestKW, r1.totalMinSafeKW, conceded1, []);
    return cap;
  }

  addRound(
    cap: StoryCapture,
    round: number,
    entries: StoryEntry[],
    result: ClearingResult,
    deficitBefore: number,
    totalReq: number,
    totalMin: number,
    conceded: { e: StoryEntry; kw: number }[],
    contracts: ForwardContract[],
  ): void {
    const n = entries.length;
    const bids = new Array<UtilityBid>(n);
    const briefs = new Array<AgentCaseBrief>(n);
    for (let i = 0; i < n; i++) {
      bids[i] = entries[i].bid;
      briefs[i] = entries[i].proposal.brief;
    }
    cap.rounds.push({ round, bids, briefs, result, deficitBefore, totalReq, totalMin, conceded, contracts });
  }

  /** Pending events of a capture that were emitted by begin() (no cap → events were stored directly). */
  private event(kind: NegotiationEvent['kind'], tMin: number, islandId: number, importance: 1 | 2 | 3, text: string, agentIds: string[], replayId: string): NegotiationEvent {
    const ev: NegotiationEvent = { id: `${kind}:${tMin}:${islandId}${agentIds.length === 1 ? ':' + agentIds[0] : ''}`, tMin, islandId, kind, importance, text, agentIds };
    if (replayId) ev.replayId = replayId;
    if (!this.evIds.has(ev.id)) {
      this.evIds.add(ev.id);
      this.events.push(ev);
      this.trimEvents();
      this.ver++;
    }
    return ev;
  }

  private trimEvents(): void {
    const over = this.events.length - MAX_EVENTS;
    if (over > 0) {
      for (const e of this.events.splice(0, over)) this.evIds.delete(e.id);
    }
  }

  /**
   * End of allocate(): decide whether this island-minute is recorded; if so build the replay up to the
   * `final` stage and the pre-safety feed messages. `out` = proposed per-building allocation.
   */
  finalize(cap: StoryCapture, entries: StoryEntry[], final: ClearingResult, out: Record<string, number>): boolean {
    const m = this.memo(cap.islandId);
    const since = cap.tMin - m.lastReplay;
    const rounds = cap.rounds;
    let contracts = 0;
    const big: { e: StoryEntry; kw: number; hospital: boolean }[] = [];
    for (let r = 0; r < rounds.length; r++) {
      const snap = rounds[r];
      contracts += snap.contracts.length;
      const rel = snap.conceded.length > 0 ? this.releasedOf(cap, r) : [];
      for (let ci = 0; ci < snap.conceded.length; ci++) {
        const c = snap.conceded[ci];
        if (rel[ci] < 1) continue; // stated only: frees no power here
        const offer = c.e.proposal.brief.concessionOffer;
        const hosp = c.e.kind === 'hospital' && /^Running [\d ]+ kW of load on /.test(offer);
        if (rel[ci] >= BIG_CONCESSION_KW || hosp) big.push({ e: c.e, kw: rel[ci], hospital: hosp });
      }
    }
    const bigFresh = big.filter((b) => cap.tMin - (this.lastBig.get(b.e.id) ?? -1e9) >= (b.hospital ? HOSPITAL_BACKUP_GAP : BIG_CONCESSION_AGENT_GAP));
    const notable = contracts > 0 || bigFresh.length > 0;
    const selected = cap.force || since >= REPLAY_EVERY_MIN || (notable && since >= REPLAY_EARLY_MIN);
    if (!selected) return false;

    m.lastReplay = cap.tMin;
    const n = entries.length;
    const proposed = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const mem of entries[i].members) s += out[mem.buildingId] ?? 0;
      proposed[i] = s;
    }
    cap.proposedKW = proposed;
    cap.finalGrants = { ...final.grants };

    const finalSnap: RoundSnap = {
      round: rounds[rounds.length - 1].round,
      bids: entries.map((e) => e.bid),
      briefs: entries.map((e) => e.proposal.brief),
      result: final,
      deficitBefore: 0,
      totalReq: 0,
      totalMin: 0,
      conceded: [],
      contracts: [],
    };
    const replay = this.buildReplay(cap, entries, finalSnap);
    cap.replay = replay;
    this.replays.push(replay);
    if (this.replays.length > MAX_REPLAYS) this.replays.splice(0, this.replays.length - MAX_REPLAYS);
    for (const ev of cap.events) ev.replayId = replay.id;

    // events that need the full picture
    for (const b of bigFresh.slice(0, 3)) {
      this.lastBig.set(b.e.id, cap.tMin);
      const name = dn(b.e);
      const text = b.hospital
        ? `${name} moves ${kw(b.kw)} kW of load onto its backup power to free grid power for others.`
        : `${name} offers to give up ${kw(b.kw)} kW of its ${kw(b.e.bid.originalRequestKW)} kW demand so that others keep power.`;
      this.event('big_concession', cap.tMin, cap.islandId, 2, text, [b.e.id], replay.id);
    }
    for (const snap of rounds) {
      for (const c of snap.contracts) {
        const g = entries.find((e) => e.id === c.giverId);
        const r = entries.find((e) => e.id === c.receiverId);
        const gn = g ? dn(g) : c.giverId;
        const rn = r ? dn(r) : c.receiverId;
        this.event('contract', cap.tMin, cap.islandId, 2, `${gn} agrees to give ${rn} ${kw(c.nowKW)} kW for ${Math.max(1, c.nowUntilMin - c.createdMin)} min, in return for ${kw(c.laterKW)} kW later.`, [c.giverId, c.receiverId], replay.id);
      }
    }
    this.writeFeed(cap, entries, finalSnap);
    this.ver++;
    return true;
  }

  /** kW each conceder of round r (0-based) really freed: its prior provisional grant above its new request (round-1 offers count when the agent was fully served). */
  private releasedOf(cap: StoryCapture, r: number): number[] {
    const snap = cap.rounds[r];
    const idx = new Map<string, number>();
    for (let i = 0; i < cap.entries.length; i++) idx.set(cap.entries[i].id, i);
    return snap.conceded.map((c) => {
      const i = idx.get(c.e.id) as number;
      const req = snap.bids[i].requestKW;
      if (r === 0) return (snap.result.grants[c.e.id] ?? 0) + 0.5 >= req ? c.kw : 0;
      return Math.min(c.kw, Math.max(0, (cap.rounds[r - 1].result.grants[c.e.id] ?? 0) - req));
    });
  }

  // ───────────────────────────── replay ─────────────────────────────

  private bidsOf(entries: StoryEntry[], snap: RoundSnap, tMin: number): RoundBid[] {
    const out: RoundBid[] = new Array(entries.length);
    for (let i = 0; i < entries.length; i++) out[i] = roundBid(entries[i], snap.bids[i], snap.briefs[i], snap.result, tMin);
    return out;
  }

  private buildReplay(cap: StoryCapture, entries: StoryEntry[], fin: RoundSnap): NegotiationReplay {
    const { info, tMin, islandId } = cap;
    const r1 = cap.rounds[0];
    const supply = info.supplyKW;
    const total1 = r1.result.totalRequestKW;
    const min1 = r1.result.totalMinSafeKW;
    const deficit1 = Math.max(0, total1 - supply);
    const triage = cap.regime === 'triage';
    const nameOf = new Map<string, string>();
    for (const e of entries) nameOf.set(e.id, dn(e));
    const stages: ReplayStage[] = [];

    // ── perceive ──
    const bids1 = this.bidsOf(entries, r1, tMin);
    let jev = 0;
    let heur = 0;
    let topU = -1;
    let top: RoundBid | undefined;
    for (const b of bids1) {
      if (!b.perception) continue;
      if (b.perception.source === 'jev') jev++;
      else heur++;
      if (b.perception.urgency > topU) {
        topU = b.perception.urgency;
        top = b;
      }
    }
    if (jev + heur > 0 && top) {
      const how = jev > 0 && heur > 0 ? `${jev} asked the Jev language model, ${heur} used a built-in rule of thumb` : jev > 0 ? 'asking the Jev language model' : 'using a built-in rule of thumb because no language model is attached';
      stages.push({
        kind: 'perceive',
        round: 1,
        title: 'Perceive — reading the situation',
        caption: `${jev + heur === 1 ? '1 utility agent reads its' : `${jev + heur} utility agents read their`} own telemetry and ${jev + heur === 1 ? "scores" : "score"} how urgent things are (${how}). Most urgent: ${top.name} (urgency ${f2(top.perception ? top.perception.urgency : 0)}, damage risk ${f2(top.perception ? top.perception.damage : 0)}).`,
        bids: bids1,
      });
    }

    // ── bid ──
    stages.push({
      kind: 'bid',
      round: 1,
      title: 'Round 1 — bids',
      caption: `${plural(entries.length, 'agent')} send their bids to the island's clearing hub: ${mw(total1)} requested in total, against ${mw(supply)} of supply.`,
      bids: bids1,
    });

    // ── clear ──
    let p1 = 0;
    for (const e of entries) p1 += r1.result.phase1[e.id] ?? 0;
    const clearCap = triage
      ? `Island ${islandId} has only ${mw(supply)} but life-safety minimums alone add up to ${mw(min1)} (triage). Minimums are served in order of need, so ${mw(p1)} of them can be protected and some agents get less than their minimum.`
      : `Island ${islandId} has ${mw(supply)} but ${mw(total1)} is requested. Every agent first gets its life-safety floor (${mw(min1)} in total); the remaining ${mw(Math.max(0, supply - p1))} is shared by need (urgency, criticality, expected damage), not by size.`;
    stages.push({
      kind: 'clear',
      round: 1,
      title: 'Provisional clearing',
      caption: clearCap,
      bids: bids1,
      grants: { ...r1.result.grants },
      phase1: { ...r1.result.phase1 },
    });

    // ── later rounds ──
    let prev = r1;
    for (let r = 1; r < cap.rounds.length; r++) {
      const snap = cap.rounds[r];
      const first = prev.result;
      const notices = entries.map((e, i) => ({ agentId: e.id, projectedKW: first.grants[e.id] ?? 0, requestKW: prev.bids[i].requestKW }));
      let worst = -1;
      let wi = -1;
      let below = 0;
      for (let i = 0; i < entries.length; i++) {
        const gap = notices[i].requestKW - notices[i].projectedKW;
        if (gap > 0.5) below++;
        const score = gap + (entries[i].isCluster ? 0 : 1e-3); // prefer named utilities on ties
        if (gap > 0.5 && score > worst && !entries[i].isCluster) {
          worst = score;
          wi = i;
        }
      }
      if (wi < 0) {
        for (let i = 0; i < entries.length; i++) {
          const gap = notices[i].requestKW - notices[i].projectedKW;
          if (gap > worst) {
            worst = gap;
            wi = i;
          }
        }
      }
      const exa = wi >= 0 ? ` — ${nameOf.get(notices[wi].agentId)} ${kw(notices[wi].projectedKW)} of ${kw(notices[wi].requestKW)} kW` : '';
      stages.push({
        kind: 'notice',
        round: snap.round,
        title: `Round ${snap.round - 1} — shortfall broadcast`,
        caption: `Shortfall broadcast: each agent is told what it would get${exa}. ${plural(below, 'agent')} would receive less than requested; the island is ${mw(snap.deficitBefore)} short.`,
        notices,
      });

      const relC = this.releasedOf(cap, r);
      const rows = snap.conceded
        .map((c, ci) => ({ c, rel: relC[ci], stated: relC[ci] < 1, prevGrant: prev.result.grants[c.e.id] ?? 0 }))
        .sort((x, y) => y.c.kw - x.c.kw || (x.c.e.id < y.c.e.id ? -1 : 1));
      const concessions = rows.map((o) => ({
        agentId: o.c.e.id,
        kw: o.c.kw,
        stance: o.c.e.proposal.brief.stance,
        text: o.stated
          ? `${o.c.e.proposal.brief.concessionOffer} (stated only: it frees no power here, the agent was getting just ${kw(o.prevGrant)} kW anyway)`
          : o.c.e.proposal.brief.concessionOffer,
      }));
      const real = rows.filter((o) => !o.stated);
      const stated = rows.filter((o) => o.stated);
      let totalC = 0;
      for (const o of real) totalC += o.rel;
      const parts: string[] = [];
      if (real.length > 0) {
        const lead = real[0];
        const leadName = nameOf.get(lead.c.e.id) ?? lead.c.e.id;
        const leadText = lead.c.e.kind !== 'house' ? `${leadName}: ${clip(lead.c.e.proposal.brief.concessionOffer, 190)}` : `${leadName} offers ${kw(lead.c.kw)} kW.`;
        parts.push(`Counter-offers: ${plural(real.length, 'agent')} ${real.length === 1 ? 'frees' : 'free'} ${mw(totalC)} of power by giving up flexible load. ${leadText}`);
      }
      if (stated.length > 0) {
        const o = stated[0];
        const nm = nameOf.get(o.c.e.id) ?? o.c.e.id;
        const more = stated.length > 1 ? `; ${stated.length - 1} other ${stated.length === 2 ? 'offer is' : 'offers are'} like that` : '';
        parts.push(`${real.length === 0 ? 'Counter-offers: ' : ''}${nm} offers to cut ${kw(o.c.kw)} kW, but on this island that frees no power: even after the cut it would still ask for more than the ${kw(o.prevGrant)} kW it was getting anyway${more}.`);
      }
      const counterCap = parts.length === 0 ? 'Counter-offers: nobody can give up more without breaking a safety minimum, so every agent holds its position.' : parts.join(' ');
      stages.push({
        kind: 'counter',
        round: snap.round,
        title: `Round ${snap.round} — counter-offers`,
        caption: counterCap,
        bids: this.bidsOf(entries, snap, tMin),
        concessions,
      });

      if (snap.contracts.length > 0) {
        const cs = snap.contracts;
        const c0 = cs[0];
        stages.push({
          kind: 'contract',
          round: snap.round,
          title: 'Forward contracts',
          caption: `${plural(cs.length, 'forward contract')} signed: ${nameOf.get(c0.giverId) ?? c0.giverId} gives ${nameOf.get(c0.receiverId) ?? c0.receiverId} ${kw(c0.nowKW)} kW now and gets ${kw(c0.laterKW)} kW back later${cs.length > 1 ? `; ${cs.length - 1} more like it` : ''}.`,
          contracts: cs.map((c) => ({ id: c.id, giverId: c.giverId, receiverId: c.receiverId, nowKW: c.nowKW, laterKW: c.laterKW })),
        });
      }
      prev = snap;
    }

    // ── final ──
    const fr = fin.result;
    let given = 0;
    let wanted = 0;
    let belowN = 0;
    let floors = 0;
    for (let i = 0; i < entries.length; i++) {
      const g = fr.grants[entries[i].id] ?? 0;
      given += g;
      wanted += fin.bids[i].originalRequestKW;
      if (g + 0.5 < fin.bids[i].originalRequestKW) belowN++;
      if (g + 0.5 >= fin.bids[i].minSafeKW) floors++;
    }
    stages.push({
      kind: 'final',
      round: fin.round,
      title: cap.rounds.length > 1 ? 'Final clearing' : 'Clearing',
      caption: `After the counter-offers the hub delivers ${mw(given)} of the ${mw(wanted)} that agents originally wanted. ${floors === entries.length ? 'Every agent keeps its life-safety floor' : `${floors} of ${entries.length} agents keep their life-safety floor`}; ${plural(belowN, 'agent')} get less than they asked for.`,
      bids: this.bidsOf(entries, fin, tMin),
      grants: { ...fr.grants },
      phase1: { ...fr.phase1 },
    });

    const headline = triage
      ? `Island ${islandId} is in triage — ${mw(supply)} for ${mw(min1)} of minimums — ${plural(entries.length, 'agent')} negotiate`
      : `Island ${islandId} is ${mw(deficit1)} short — ${plural(entries.length, 'agent')} negotiate`;
    return {
      id: `${tMin}:${islandId}`,
      tMin,
      islandId,
      supplyKW: supply,
      totalRequestKW: total1,
      totalMinSafeKW: min1,
      deficitKW: deficit1,
      regime: cap.regime,
      microgrid: !!info.microgrid,
      prosumerKW: info.prosumerKW ?? 0,
      participants: entries.map((e) => ({ agentId: e.id, name: nameOf.get(e.id) ?? e.id, kind: e.kind, buildingIds: e.members.map((mm) => mm.buildingId) })),
      stages,
      headline,
    };
  }

  // ───────────────────────────── feed ─────────────────────────────

  private push(msg: Omit<FeedMessage, 'id'>): void {
    this.feed.push({ id: `f${this.seq++}`, ...msg });
    const over = this.feed.length - MAX_FEED;
    if (over > 0) this.feed.splice(0, over);
  }

  private chips(e: StoryEntry, bid: UtilityBid, grant: number): Record<string, number | string> {
    const d: Record<string, number | string> = { requestKW: Math.round(bid.requestKW), minSafeKW: Math.round(bid.minSafeKW), grantKW: Math.round(grant) };
    const p = e.perception;
    if (p) {
      d.jevUrgency = round2(p.urgency);
      d.jevDamage = round2(p.damage);
      d.jevRisk = round2(p.imminentFailureRisk);
      d.jevCanConcede = round2(p.canConcede);
      d.jevConfidence = round2(p.confidence);
      d.source = p.source;
    }
    return d;
  }

  private writeFeed(cap: StoryCapture, entries: StoryEntry[], fin: RoundSnap): void {
    const rid = cap.replay?.id;
    const { tMin, islandId, info } = cap;
    const r1 = cap.rounds[0];
    const rep = cap.replay as NegotiationReplay;
    const base = { tMin, islandId, replayId: rid } as const;
    const m = this.memo(islandId);
    const defNow = rep.deficitKW;
    const chatty = tMin - m.headTMin >= HEADLINE_GAP || m.headRegime !== cap.regime || Math.abs(defNow - m.headDeficit) > 0.2 * Math.max(50, m.headDeficit);
    cap.chatty = chatty;
    if (chatty) {
      m.headTMin = tMin;
      m.headDeficit = defNow;
      m.headRegime = cap.regime;
    }
    if (chatty) this.push({
      ...base,
      from: 'clearing',
      fromName: 'Clearing hub',
      fromKind: 'clearing',
      kind: 'info',
      text: rep.headline + `. ${mw(r1.result.totalRequestKW)} requested, ${mw(info.supplyKW)} available, ${mw(r1.result.totalMinSafeKW)} of that is life-safety minimum.`,
      data: { supplyKW: Math.round(info.supplyKW), requestKW: Math.round(r1.result.totalRequestKW), minSafeKW: Math.round(r1.result.totalMinSafeKW), grantKW: 0, deficitKW: Math.round(rep.deficitKW) },
    });

    // first-person agent messages (round-1 bids), only utility negotiators whose stance / request changed
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.isCluster || e.assessment.mode === 'idle') continue;
      const bid = r1.bids[i];
      const brief = r1.briefs[i];
      const memo = this.msgMemo.get(e.id);
      const changed = !memo || tMin - memo.tMin >= FEED_REPEAT_MIN || memo.stance !== brief.stance || Math.abs(bid.requestKW - memo.req) > FEED_CHANGE * Math.max(1, memo.req);
      if (!changed) continue;
      this.msgMemo.set(e.id, { tMin, stance: brief.stance, req: bid.requestKW });
      const src = e.perception ? (e.perception.source === 'jev' ? 'Jev model' : 'heuristic') : '';
      this.push({
        ...base,
        from: e.id,
        fromName: e.name,
        fromKind: e.kind,
        kind: e.perception ? 'perception' : 'bid',
        text: `I need ${kw(bid.requestKW)} kW (${kw(bid.minSafeKW)} kW is my safe minimum). ${clip(brief.primaryArgument, 230)}${src ? ` [scored by ${src}]` : ''}`,
        data: { ...this.chips(e, bid, r1.result.grants[e.id] ?? 0), stance: brief.stance },
      });
    }

    // later rounds
    for (let r = 1; r < cap.rounds.length; r++) {
      const snap = cap.rounds[r];
      const prev = cap.rounds[r - 1];
      const idx = new Map<string, number>();
      for (let i = 0; i < entries.length; i++) idx.set(entries[i].id, i);
      let worst = '';
      let worstGap = 0.5;
      for (let i = 0; i < entries.length; i++) {
        const gap = prev.bids[i].requestKW - (prev.result.grants[entries[i].id] ?? 0);
        if (gap > worstGap) {
          worstGap = gap;
          worst = `${dn(entries[i])} would get ${kw(prev.result.grants[entries[i].id] ?? 0)} of ${kw(prev.bids[i].requestKW)} kW`;
        }
      }
      if (chatty) this.push({
        ...base,
        from: 'clearing',
        fromName: 'Clearing hub',
        fromKind: 'clearing',
        kind: 'notice',
        text: `Island ${islandId} is ${mw(snap.deficitBefore)} short. Shortfall broadcast to every agent${worst ? ` — e.g. ${worst}` : ''}. Who can give way?`,
        data: { deficitKW: Math.round(snap.deficitBefore), requestKW: Math.round(prev.result.totalRequestKW), minSafeKW: Math.round(prev.result.totalMinSafeKW), grantKW: Math.round(prev.result.totalRequestKW - snap.deficitBefore) },
      });
      const relF = this.releasedOf(cap, r);
      const top = snap.conceded
        .map((c, ci) => ({ ...c, rel: relF[ci] }))
        .filter((c) => !c.e.isCluster)
        .sort((a, b) => b.rel - a.rel || b.kw - a.kw || (a.e.id < b.e.id ? -1 : 1))
        .slice(0, 6);
      for (const c of top) {
        const i = idx.get(c.e.id) as number;
        this.push({
          ...base,
          from: c.e.id,
          fromName: c.e.name,
          fromKind: c.e.kind,
          kind: 'concession',
          text:
            c.rel >= 1
              ? `I can give up ${kw(c.kw)} kW more, which frees ${kw(c.rel)} kW for others. ${clip(snap.briefs[i].concessionOffer, 220)}`
              : `I offer to cut ${kw(c.kw)} kW, but that frees no power on this island: I would still ask for more than the ${kw(prev.result.grants[c.e.id] ?? 0)} kW I was getting anyway. ${clip(snap.briefs[i].concessionOffer, 160)}`,
          data: { ...this.chips(c.e, snap.bids[i], snap.result.grants[c.e.id] ?? 0), concededKW: Math.round(c.kw), releasedKW: Math.round(c.rel), stance: snap.briefs[i].stance },
        });
      }
      for (const c of snap.contracts) {
        const gi = idx.get(c.giverId);
        const ri = idx.get(c.receiverId);
        if (gi === undefined || ri === undefined) continue;
        const g = entries[gi];
        this.push({
          ...base,
          from: g.id,
          fromName: g.name,
          fromKind: g.kind,
          kind: 'contract',
          text: `I will yield ${kw(c.nowKW)} kW to ${dn(entries[ri])} for ${Math.max(1, c.nowUntilMin - c.createdMin)} min; they promise ${kw(c.laterKW)} kW back later (contract ${c.id}).`,
          data: { ...this.chips(g, snap.bids[gi], snap.result.grants[g.id] ?? 0), nowKW: Math.round(c.nowKW), laterKW: Math.round(c.laterKW) },
        });
      }
    }
    void fin;
  }

  // ───────────────────────────── commit (safety + commit stages) ─────────────────────────────

  /**
   * Called from commit(): safety-veto event (always, from the audit alone) and — when this island-minute was
   * recorded — the `safety` and `commit` stages plus the closing feed messages.
   */
  commit(islandId: number, tMin: number, cap: StoryCapture | undefined, audit: AuditEntry[], committed: Record<string, number>, info: CommitInfo | null): void {
    // veto event (needs only the audit)
    let moved = 0;
    let first: AuditEntry | undefined;
    const vetoAgents: string[] = [];
    for (const a of audit) {
      if (a.islandId !== islandId || a.proposedKW === undefined || a.correctedKW === undefined) continue;
      const d = Math.abs(a.proposedKW - a.correctedKW);
      if (d < 1) continue;
      moved += d;
      if (!first) first = a;
      if (a.agentId && vetoAgents.length < 4 && !vetoAgents.includes(a.agentId)) vetoAgents.push(a.agentId);
    }
    const m = this.memo(islandId);
    if (moved >= VETO_KW && first && tMin - m.lastVeto >= VETO_EVENT_GAP) {
      m.lastVeto = tMin;
      this.event('safety_veto', tMin, islandId, 2, `Safety layer overruled the plan on island ${islandId} (${kw(moved)} kW moved): ${first.rule} — ${clip(first.reason, 160)}`, vetoAgents, cap?.replay?.id ?? '');
    }

    const rep = cap?.replay;
    if (!cap || !rep || !info || !cap.proposedKW) return;
    const entries = cap.entries;

    // ── safety stage ──
    const byAgent = new Map<string, AuditEntry[]>();
    for (const a of audit) {
      if (!a.agentId) continue;
      let l = byAgent.get(a.agentId);
      if (!l) byAgent.set(a.agentId, (l = []));
      l.push(a);
    }
    const corrections: NonNullable<ReplayStage['corrections']> = [];
    let movedKW = 0;
    const nameOf = new Map<string, string>();
    for (const p of rep.participants) nameOf.set(p.agentId, p.name);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const proposed = cap.proposedKW[i];
      const finalKW = info.finals[i];
      if (Math.abs(proposed - finalKW) < 0.5) continue;
      const own: AuditEntry[] = [];
      for (const mem of e.members) {
        const l = byAgent.get(mem.buildingId);
        if (l) for (const a of l) own.push(a);
      }
      const rules: string[] = [];
      const reasons: string[] = [];
      for (const a of own) {
        if (!rules.includes(a.rule)) rules.push(a.rule);
        if (!reasons.includes(a.reason) && reasons.length < 2) reasons.push(a.reason);
      }
      corrections.push({
        agentId: e.id,
        proposedKW: proposed,
        finalKW,
        rule: rules.length > 0 ? rules.join(', ') : 'fairness/limits',
        reason: reasons.length > 0 ? reasons.join('; ') : 'Adjusted to respect a line limit or a protected minimum.',
      });
      movedKW += Math.abs(proposed - finalKW);
    }
    const committedGrants: Record<string, number> = {};
    let sum = 0;
    let wanted = 0;
    let below = 0;
    for (let i = 0; i < entries.length; i++) {
      committedGrants[entries[i].id] = info.finals[i];
      sum += info.finals[i];
      wanted += entries[i].bid.originalRequestKW;
      if (info.finals[i] + 0.5 < entries[i].bid.originalRequestKW) below++;
    }
    let safetyCap: string;
    if (corrections.length === 0) {
      safetyCap = 'Safety layer checked every line and limit — approved unchanged.';
    } else {
      const c = corrections.slice().sort((a, b) => Math.abs(b.proposedKW - b.finalKW) - Math.abs(a.proposedKW - a.finalKW))[0];
      safetyCap = `Safety layer corrected ${plural(corrections.length, 'allocation')} (${kw(movedKW)} kW moved). Largest: ${nameOf.get(c.agentId) ?? c.agentId} ${kw(c.proposedKW)} → ${kw(c.finalKW)} kW (${c.rule}: ${clip(c.reason, 140)}).`;
    }
    rep.stages.push({ kind: 'safety', round: rep.stages[rep.stages.length - 1].round, title: 'Safety check', caption: safetyCap, grants: committedGrants, corrections });

    // ── commit stage ──
    const tokens: NonNullable<ReplayStage['tokens']> = [];
    let earnedT = 0;
    let spentT = 0;
    for (let i = 0; i < entries.length; i++) {
      if (info.earned[i] > 0.001) {
        tokens.push({ agentId: entries[i].id, delta: info.earned[i], reason: 'Earned for a verified concession' });
        earnedT += info.earned[i];
      }
      if (info.spent[i] > 0.001) {
        tokens.push({ agentId: entries[i].id, delta: -info.spent[i], reason: 'Spent on offered tokens that won extra power' });
        spentT += info.spent[i];
      }
    }
    const tokCap = tokens.length === 0 ? 'No tokens changed hands.' : `Tokens: ${earnedT > 0.001 ? `${earnedT.toFixed(1)} earned for verified concessions` : ''}${earnedT > 0.001 && spentT > 0.001 ? ', ' : ''}${spentT > 0.001 ? `${spentT.toFixed(1)} spent` : ''}.`;
    rep.stages.push({
      kind: 'commit',
      round: rep.stages[rep.stages.length - 1].round,
      title: 'Committed',
      caption: `Committed: ${mw(sum)} delivered to ${plural(entries.length, 'agent')} out of ${mw(rep.supplyKW)} available; ${below === 0 ? 'Nobody was left short' : `${plural(below, 'agent')} got less than they wanted (${mw(wanted)} wanted in total)`}. ${tokCap}`,
      grants: committedGrants,
      tokens,
    });

    // ── feed ──
    const base = { tMin, islandId, replayId: rep.id } as const;
    let shown = 0;
    for (const c of corrections.slice().sort((a, b) => Math.abs(b.proposedKW - b.finalKW) - Math.abs(a.proposedKW - a.finalKW))) {
      if (shown++ >= 4) break;
      this.push({
        ...base,
        from: 'safety',
        fromName: 'Safety layer',
        fromKind: 'safety',
        kind: 'safety',
        text: `I changed ${nameOf.get(c.agentId) ?? c.agentId} from ${kw(c.proposedKW)} to ${kw(c.finalKW)} kW (${c.rule}): ${clip(c.reason, 200)}`,
        data: { requestKW: 0, minSafeKW: 0, grantKW: Math.round(c.finalKW), proposedKW: Math.round(c.proposedKW) },
      });
    }
    const lows: { i: number; gap: number }[] = [];
    for (let i = 0; i < entries.length; i++) {
      const gap = entries[i].bid.originalRequestKW - info.finals[i];
      if (gap > 0.5) lows.push({ i, gap });
    }
    if (lows.length > 0 && cap.chatty) {
      lows.sort((a, b) => b.gap - a.gap || (entries[a.i].id < entries[b.i].id ? -1 : 1));
      const list = lows
        .slice(0, 4)
        .map((l) => `${dn(entries[l.i])} ${kw(info.finals[l.i])} of ${kw(entries[l.i].bid.originalRequestKW)} kW`)
        .join('; ');
      this.push({
        ...base,
        from: 'clearing',
        fromName: 'Clearing hub',
        fromKind: 'clearing',
        kind: 'grant',
        text: `Final power: ${list}${lows.length > 4 ? `; and ${lows.length - 4} more below request` : ''}. ${mw(sum)} delivered of ${mw(rep.supplyKW)} available.`,
        data: { requestKW: Math.round(wanted), minSafeKW: Math.round(rep.totalMinSafeKW), grantKW: Math.round(sum), agentsBelowRequest: lows.length },
      });
    }
    this.ver++;
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Display name: cluster ids become a readable neighbourhood label. */
function dn(e: StoryEntry): string {
  return e.name;
}

function roundBid(e: StoryEntry, bid: UtilityBid, brief: AgentCaseBrief, result: ClearingResult, tMin: number): RoundBid {
  const rb: RoundBid = {
    agentId: e.id,
    name: dn(e),
    kind: e.kind,
    mode: bid.mode,
    requestKW: bid.requestKW,
    originalRequestKW: bid.originalRequestKW,
    minSafeKW: bid.minSafeKW,
    concededKW: bid.concededKW,
    tokensOffered: bid.tokensOffered,
    score: result.priority[e.id]?.score ?? 0,
    stance: brief.stance,
    argument: brief.primaryArgument,
    offer: brief.concessionOffer,
  };
  const p = e.perception;
  if (p && !e.isCluster && bid.mode !== 'idle') {
    rb.perception = {
      source: p.source,
      urgency: p.urgency,
      damage: p.damage,
      imminentFailureRisk: p.imminentFailureRisk,
      canConcede: p.canConcede,
      concessionStrategy: p.concessionStrategy,
      confidence: p.confidence,
      ageMin: Math.max(0, tMin - p.tMin),
    };
  }
  return rb;
}

