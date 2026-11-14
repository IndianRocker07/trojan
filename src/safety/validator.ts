/**
 * Layer 3 — independent safety validator (docs/NEGOTIATION.md §6, docs/MICROGRID.md §7).
 * Hard limits, physics (NET feeder flow with prosumer exports), min-safe guarantee, fairness bound, invariants,
 * fallback, audit log. Imports src/core and its own invariants module only.
 */
import type {
  AllocationRequest,
  AuditEntry,
  ConstraintValidator,
  SafetySnapshot,
  SimSnapshot,
  ValidationContext,
} from '../core/types';
import { checkInvariants, edgeStatusInto, getNetIndex, livePathCache, livePathsFor, NO_PATHS, type LivePath, type NetIndex } from './invariants';

export interface SafetyOptions {
  edgeMargin?: number;
  fairnessK?: number;
  criticalThreshold?: number;
  auditKeep?: number;
}

const EPS = 1e-9;
const SUPPLY_SLACK = 1e-7;
/** Corrections smaller than this are numerical rounding (e.g. a policy that hands out exactly the supply): applied, not audited. */
const AUDIT_MIN_KW = 0.5;

const kw = (x: number): string => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const byId = (ids: string[]) => (x: number, y: number): number => (ids[x] < ids[y] ? -1 : ids[x] > ids[y] ? 1 : 0);

/** Physical view of one island at this minute, built once per validate() and shared by every solve of it. */
interface LiveNet {
  ix: NetIndex;
  /** 1 when the span is in service */
  ok: Uint8Array;
  /** signature of `ok` */
  sig: number;
  /** consumer id → live paths (cached per status pattern) */
  paths: Map<string, LivePath[]>;
  /** per edge: Σ planned export (after curtailment) of the island's prosumers injected downstream of it */
  exp: Float64Array;
  /** microgrid island (no generator roots): net-flow rule only; no transmission / transformer checks */
  micro: boolean;
}

// per-validate scratch (validate() is synchronous and not re-entrant); sized to the network
let sanVals = new Float64Array(0);
let liveOk = new Uint8Array(0);
let liveExp = new Float64Array(0);

function buildLive(ctx: ValidationContext): LiveNet {
  const snap = ctx.snapshot;
  const ix = getNetIndex(snap.network, snap.buildings);
  const E = ix.edgeIds.length;
  if (liveOk.length !== E) {
    liveOk = new Uint8Array(E);
    liveExp = new Float64Array(E);
  }
  const ok = liveOk;
  const exp = liveExp;
  const sig = edgeStatusInto(ix, ok);
  exp.fill(0);
  const paths = livePathCache(ix, sig);
  for (const id of ctx.info?.prosumerIds ?? ctx.consumerIds) {
    const x = snap.agents[id]?.der?.exportedKW;
    if (!(x !== undefined && x > 0 && Number.isFinite(x))) continue;
    for (const p of livePathsFor(paths, ix, ok, id)) {
      for (let k = p.from; k < p.edges.length; k++) exp[p.edges[k]] += x;
    }
  }
  const micro = ctx.info?.microgrid === true || ctx.generatorIds.length === 0;
  return { ix, ok, sig, exp, micro, paths };
}

/** Typed-array scratch of one Solve slot (a validate() holds up to four Solves at once), reused across calls. */
interface Pool {
  cap: number;
  demand: Float64Array;
  floor: Float64Array;
  crit: Float64Array;
  harm: Float64Array;
  backup: Float64Array;
  a: Float64Array;
  E: number;
  S: number;
  edgeLoad: Float64Array;
  edgeLim: Float64Array;
  limIx: NetIndex | null;
  limMargin: number;
  mark: Int32Array;
  stamp: number;
  subLoad: Float64Array;
  subLim: Float64Array;
}
const pools: Pool[] = [];
function poolFor(slot: number, n: number, E: number, S: number): Pool {
  let p = pools[slot];
  if (!p) {
    p = pools[slot] = { cap: 0, demand: new Float64Array(0), floor: new Float64Array(0), crit: new Float64Array(0), harm: new Float64Array(0), backup: new Float64Array(0), a: new Float64Array(0), E: -1, S: -1, edgeLoad: new Float64Array(0), edgeLim: new Float64Array(0), limIx: null, limMargin: 0, mark: new Int32Array(0), stamp: 0, subLoad: new Float64Array(0), subLim: new Float64Array(0) };
  }
  if (p.cap < n) {
    const c = Math.max(n, p.cap * 2);
    p.cap = c;
    p.demand = new Float64Array(c);
    p.floor = new Float64Array(c);
    p.crit = new Float64Array(c);
    p.harm = new Float64Array(c);
    p.backup = new Float64Array(c);
    p.a = new Float64Array(c);
  } else {
    p.backup.fill(0, 0, n);
    p.a.fill(0, 0, n);
  }
  if (p.E !== E) {
    p.E = E;
    p.edgeLoad = new Float64Array(E);
    p.edgeLim = new Float64Array(E);
    p.limIx = null;
    p.mark = new Int32Array(E);
    p.stamp = 0;
  } else {
    p.edgeLoad.fill(0);
  }
  if (p.S !== S) {
    p.S = S;
    p.subLoad = new Float64Array(S);
    p.subLim = new Float64Array(S);
  } else {
    p.subLoad.fill(0);
  }
  p.subLim.fill(Infinity);
  return p;
}

interface Rec {
  first: number;
  edgeId?: string;
}

class Solve {
  readonly n: number;
  readonly ids: string[];
  // length >= n (pooled); only the first n entries are meaningful
  readonly demand: Float64Array;
  readonly floor: Float64Array;
  readonly crit: Float64Array;
  readonly harm: Float64Array;
  readonly backup: Float64Array;
  readonly isHouse: boolean[];
  readonly down: boolean[];
  /** per request: its live feeder paths (edges in service only; subI −1 when not intact to the substation) */
  readonly paths: LivePath[][];
  readonly a: Float64Array;
  /** allocation carried by each span (live stretches) */
  readonly edgeLoad: Float64Array;
  readonly edgeLim: Float64Array;
  /** per substation: allocation through intact feeders */
  readonly subLoad: Float64Array;
  /** per substation transformer limit (Infinity when not checked: microgrid or no transmission) */
  readonly subLim: Float64Array;
  readonly micro: boolean;
  total = 0;
  /** set when a grant was moved between consumers (min-safe / fairness): the transmission check must then re-run */
  moved = false;
  readonly audit: AuditEntry[] = [];
  readonly fired = new Map<string, number>();
  private readonly pool: Pool;
  private donors: number[] | null = null;

  constructor(
    readonly requests: AllocationRequest[],
    readonly supply: number,
    readonly ctx: ValidationContext | undefined,
    readonly live: LiveNet | null,
    margin: number,
    readonly critThr: number,
    readonly quiet: boolean,
    readonly tMin: number,
    readonly islandId: number,
    slot: number,
  ) {
    const n = (this.n = requests.length);
    this.ids = new Array<string>(n);
    this.isHouse = new Array<boolean>(n);
    this.down = new Array<boolean>(n);
    this.paths = new Array<LivePath[]>(n);
    this.micro = live?.micro ?? false;
    const E = live ? live.ix.edgeIds.length : 0;
    const S = live ? live.ix.subIds.length : 0;
    const pool = (this.pool = poolFor(slot, n, E, S));
    this.demand = pool.demand;
    this.floor = pool.floor;
    this.crit = pool.crit;
    this.harm = pool.harm;
    this.backup = pool.backup;
    this.a = pool.a;
    this.edgeLoad = pool.edgeLoad;
    this.edgeLim = pool.edgeLim;
    this.subLoad = pool.subLoad;
    this.subLim = pool.subLim;
    for (let i = 0; i < n; i++) {
      const r = requests[i];
      this.ids[i] = r.buildingId;
      const d = Number.isFinite(r.demandKW) ? Math.max(0, r.demandKW) : 0;
      this.demand[i] = d;
      this.floor[i] = Math.min(Math.max(0, Number.isFinite(r.minSafeKW) ? r.minSafeKW : 0), d);
      this.crit[i] = Number.isFinite(r.criticality) ? r.criticality : 0;
      this.harm[i] = (Number.isFinite(r.expectedDamagePerHour) ? r.expectedDamagePerHour : 0) / Math.max(d, EPS);
      this.isHouse[i] = r.kind === 'house';
      let down = false;
      if (ctx) {
        const ag = ctx.snapshot.agents[r.buildingId];
        // a destroyed consumer is disconnected (the engine sets connected = false), so the agent state decides
        down = ag ? !ag.connected : ctx.snapshot.buildings[r.buildingId]?.status === 'destroyed';
        if (ag && ag.backup.remainingKWh > 0) this.backup[i] = Math.max(0, ag.backup.maxKW);
      }
      this.down[i] = down;
      this.paths[i] = live ? livePathsFor(live.paths, live.ix, live.ok, r.buildingId) : NO_PATHS;
    }
    if (live && (pool.limIx !== live.ix || pool.limMargin !== margin)) {
      for (let e = 0; e < E; e++) pool.edgeLim[e] = live.ix.edgeCap[e] * margin;
      pool.limIx = live.ix;
      pool.limMargin = margin;
    }
    // transformer limit of a substation = its live transmission capacity; generator-fed islands only
    if (live && ctx && !this.micro) {
      for (let s = 0; s < S; s++) {
        const list = live.ix.subTrans[s];
        if (list.length === 0) continue; // no transmission edges at all → skip check
        let cap = 0;
        for (const id of list) {
          const e = ctx.snapshot.network.edges[id];
          if (e && e.status === 'ok') cap += e.capacityKW;
        }
        this.subLim[s] = cap * margin;
      }
    }
  }

  name(i: number): string {
    return this.ctx?.snapshot.buildings[this.ids[i]]?.name ?? this.ids[i];
  }

  /** Requests whose live stretch crosses span e (scan; only needed for an overloaded span, so kept lazy). */
  membersOfEdge(e: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (this.a[i] <= 0) continue;
      for (const p of this.paths[i]) {
        let hit = false;
        for (let k = p.from; k < p.edges.length; k++) if (p.edges[k] === e) { hit = true; break; }
        if (hit) { out.push(i); break; }
      }
    }
    return out;
  }

  /** Requests with an intact feeder to substation s (lazy, as membersOfEdge). */
  membersOfSub(s: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (this.a[i] <= 0) continue;
      if (this.paths[i].some((p) => p.subI === s)) out.push(i);
    }
    return out;
  }

  /**
   * Load the span is checked on: generator islands keep the allocation-only bound and also the net flow (exports as
   * offsets); microgrid islands check the net flow only. Never looser than |net|.
   */
  edgeQ(e: number): number {
    const L = this.edgeLoad[e];
    const net = Math.abs(L - this.live!.exp[e]);
    return this.micro ? net : Math.max(L, net);
  }

  emit(rule: string, severity: AuditEntry['severity'], reason: string, extra: Partial<AuditEntry> = {}): void {
    this.fired.set(rule, (this.fired.get(rule) ?? 0) + 1);
    if (this.quiet) return;
    this.audit.push({ tMin: this.tMin, islandId: this.islandId, rule, severity, reason, ...extra });
  }

  load(vals: Float64Array): void {
    this.a.fill(0, 0, this.n);
    this.edgeLoad.fill(0);
    this.subLoad.fill(0);
    this.total = 0;
    for (let i = 0; i < this.n; i++) if (vals[i] > 0) this.apply(i, vals[i]);
  }

  apply(i: number, delta: number): void {
    this.a[i] += delta;
    this.total += delta;
    for (const p of this.paths[i]) {
      const ed = p.edges;
      for (let k = p.from; k < ed.length; k++) this.edgeLoad[ed[k]] += delta;
      if (p.subI >= 0) this.subLoad[p.subI] += delta;
    }
  }

  /** Reduction order: above min-safe proportionally, then below min-safe by ascending harm/kW, tie id. */
  trim(members: number[], excess: number, rec?: Map<number, Rec>, edgeId?: string): { above: number; below: number; count: number; critCut: boolean } {
    const out = { above: 0, below: 0, count: 0, critCut: false };
    if (excess <= 0) return out;
    const note = (i: number): void => {
      if (rec && !rec.has(i)) rec.set(i, { first: this.a[i], edgeId });
    };
    const above: number[] = [];
    let sumAb = 0;
    for (const i of members) {
      const ab = this.a[i] - this.floor[i];
      if (ab > 1e-12) {
        above.push(i);
        sumAb += ab;
      }
    }
    if (sumAb >= excess) {
      const ratio = excess / sumAb;
      for (const i of above) {
        note(i);
        this.apply(i, -(this.a[i] - this.floor[i]) * ratio);
      }
      out.above = excess;
      out.count = above.length;
      return out;
    }
    const counted = new Set<number>(above);
    for (const i of above) {
      note(i);
      this.apply(i, -(this.a[i] - this.floor[i]));
    }
    out.above = sumAb;
    let rem = excess - sumAb;
    const below = members.filter((i) => this.a[i] > 1e-12);
    const tie = byId(this.ids);
    below.sort((x, y) => this.harm[x] - this.harm[y] || tie(x, y));
    for (const i of below) {
      if (rem <= 1e-12) break;
      const t = Math.min(this.a[i], rem);
      note(i);
      this.apply(i, -t);
      rem -= t;
      out.below += t;
      if (this.crit[i] >= this.critThr) out.critCut = true;
      counted.add(i);
    }
    out.count = counted.size;
    return out;
  }

  /** One audit entry per agent per rule (houses only when pushed below their floor, to keep volume sane). */
  flush(rule: string, rec: Map<number, Rec>, why: string): void {
    if (this.quiet) return;
    for (const [i, r] of rec) {
      const cutBelow = this.a[i] < this.floor[i] - 1e-6;
      if (this.isHouse[i] && !cutBelow) continue;
      if (!cutBelow && r.first - this.a[i] < AUDIT_MIN_KW) continue;
      this.emit(rule, cutBelow && this.crit[i] >= this.critThr ? 'crit' : 'warn',
        `${this.name(i)}: grant cut from ${kw(r.first)} to ${kw(this.a[i])} kW (${why})`,
        { agentId: this.ids[i], edgeId: r.edgeId, proposedKW: r.first, correctedKW: this.a[i] });
    }
  }

  private donorList(): number[] {
    if (!this.donors) {
      const d = Array.from({ length: this.n }, (_, i) => i);
      const tie = byId(this.ids);
      d.sort((x, y) => this.harm[x] - this.harm[y] || tie(x, y));
      this.donors = d;
    }
    return this.donors;
  }

  /**
   * kW that can be added to r's feeder path when the same amount is removed from d (d < 0: unallocated supply).
   * Adding x to a span raises its checked load by at most x, so (limit − current) is a safe bound.
   */
  headroom(r: number, d: number): number {
    const ps = this.paths[r];
    if (ps.length === 0 || !this.live) return Infinity;
    const mark = this.pool.mark;
    const st = ++this.pool.stamp;
    let dsub = -1;
    if (d >= 0) {
      for (const p of this.paths[d]) {
        if (p.subI >= 0) dsub = p.subI;
        for (let k = p.from; k < p.edges.length; k++) mark[p.edges[k]] = st;
      }
    }
    let h = Infinity;
    for (const p of ps) {
      for (let k = p.from; k < p.edges.length; k++) {
        const e = p.edges[k];
        if (mark[e] !== st) h = Math.min(h, this.edgeLim[e] - this.edgeQ(e));
      }
      if (p.subI >= 0 && p.subI !== dsub) h = Math.min(h, this.subLim[p.subI] - this.subLoad[p.subI]);
    }
    return Math.max(0, h);
  }

  /** Move up to `need` kW to receiver r (above-floor donors first, then optionally less-critical below-floor ones). */
  shiftTo(r: number, need: number, allowBelow: boolean): { moved: number; donors: number } {
    let moved = 0;
    let used = 0;
    let skips = 0;
    const list = this.donorList();
    // unallocated supply is the cheapest donor
    const slack = Math.max(0, this.supply - SUPPLY_SLACK) - this.total;
    if (slack > 1e-9) {
      const x = Math.min(need, slack, this.headroom(r, -1));
      if (x > 1e-9) {
        this.apply(r, x);
        moved += x;
        this.moved = true;
      }
    }
    for (let pass = 0; pass < (allowBelow ? 2 : 1) && need - moved > 1e-6; pass++) {
      for (const d of list) {
        if (need - moved <= 1e-6 || skips > 300) break;
        if (d === r) continue;
        const avail = pass === 0 ? this.a[d] - this.floor[d] : this.crit[d] < this.crit[r] - EPS ? this.a[d] : 0;
        if (avail <= 1e-9) continue;
        const x = Math.min(need - moved, avail, this.headroom(r, d));
        if (x <= 1e-9) {
          skips++;
          continue;
        }
        this.apply(d, -x);
        this.apply(r, x);
        moved += x;
        used++;
        this.moved = true;
      }
    }
    return { moved, donors: used };
  }

  maxUtil(): number {
    let m = 0;
    if (!this.live) return m;
    for (let e = 0; e < this.edgeLoad.length; e++) {
      const q = this.edgeQ(e);
      if (q <= 0) continue;
      const u = q / this.live.ix.edgeCap[e];
      if (u > m) m = u;
    }
    return m;
  }
}

export class SafetyValidator implements ConstraintValidator {
  name = 'safety: hard limits + minSafe + fairness';
  private readonly edgeMargin: number;
  private readonly K: number;
  private readonly critThr: number;
  private readonly auditKeep: number;

  /** starvation counters, keyed by agent id (survive island id changes) */
  private fair = new Map<string, { n: number; t: number }>();
  /** last committed grant per agent (fallback source), keyed by agent id */
  private lastGrant = new Map<string, { t: number; kw: number }>();
  private auditLog: AuditEntry[] = [];
  private counts: Record<string, number> = {};
  private violationsCommitted = 0;
  private triageEvents = 0;
  private curT = 0;
  private stepMaxUtil = 0;
  /** validate() calls and their total wall time (ms), for the per-validate budget (docs/MICROGRID.md, bench) */
  private validateCalls = 0;
  private validateMs = 0;

  constructor(opts: SafetyOptions = {}) {
    this.edgeMargin = opts.edgeMargin ?? 0.97;
    this.K = opts.fairnessK ?? 30;
    this.critThr = opts.criticalThreshold ?? 0.8;
    this.auditKeep = opts.auditKeep ?? 300;
  }

  reset(): void {
    this.fair.clear();
    this.lastGrant.clear();
    this.auditLog = [];
    this.counts = {};
    this.violationsCommitted = 0;
    this.triageEvents = 0;
    this.curT = 0;
    this.stepMaxUtil = 0;
    this.validateCalls = 0;
    this.validateMs = 0;
  }

  /** Mean wall time of a validate() call since the last reset (ms). */
  meanValidateMs(): number {
    return this.validateCalls > 0 ? this.validateMs / this.validateCalls : 0;
  }

  private mk(requests: AllocationRequest[], supply: number, ctx: ValidationContext | undefined, live: LiveNet | null, quiet: boolean, tMin: number, islandId: number, slot: number): Solve {
    return new Solve(requests, supply, ctx, live, this.edgeMargin, this.critThr, quiet, tMin, islandId, slot);
  }

  validate(
    supplyKW: number,
    requests: AllocationRequest[],
    allocation: Record<string, number>,
    ctx?: ValidationContext,
  ): { allocation: Record<string, number>; violations: string[]; audit?: AuditEntry[] } {
    const t0 = performance.now();
    const res = this.validateInner(supplyKW, requests, allocation, ctx);
    this.validateCalls++;
    this.validateMs += performance.now() - t0;
    return res;
  }

  private validateInner(
    supplyKW: number,
    requests: AllocationRequest[],
    allocation: Record<string, number>,
    ctx?: ValidationContext,
  ): { allocation: Record<string, number>; violations: string[]; audit?: AuditEntry[] } {
    const tMin = ctx?.tMin ?? this.curT;
    const islandId = ctx?.islandId ?? 0;
    if (tMin > this.curT) this.curT = tMin;
    // supply = min(argument, island P_total): the engine passes the same value; a mismatch is taken conservatively
    let supply = Number.isFinite(supplyKW) ? Math.max(0, supplyKW) : 0;
    const pTotal = ctx?.info?.supplyKW;
    let gap: { given: number; pTotal: number } | undefined;
    if (pTotal !== undefined && Number.isFinite(pTotal)) {
      const p = Math.max(0, pTotal);
      if (Math.abs(p - supply) > SUPPLY_SLACK) gap = { given: supply, pTotal: p };
      supply = Math.min(supply, p);
    }
    const live = ctx ? buildLive(ctx) : null;
    const inv = { edgeMargin: this.edgeMargin, keysAreRequests: true, status: live ? { ok: live.ok, sig: live.sig } : undefined };

    const S = this.mk(requests, supply, ctx, live, false, tMin, islandId, 0);
    if (gap && Math.abs(gap.given - gap.pTotal) >= 1) {
      S.emit('supply', 'info', `Supply argument ${kw(gap.given)} kW differs from island P_total ${kw(gap.pTotal)} kW; validated against the lower value`);
    }
    this.sanitize(S, allocation);
    this.enforceLimits(S);
    this.minSafeGuarantee(S);
    this.fairness(S);
    if (S.moved) this.enforceTransmission(S);

    let result = S;
    let out = this.toRecord(S);
    const fails = checkInvariants(supply, requests, out, ctx, inv);
    if (fails.length) {
      S.emit('invariant', 'crit', `Post-validation invariant failure (${fails.slice(0, 3).join('; ')}); falling back`);
      let used = '';
      // 1) the last committed grants of these agents (kept per agent, so they survive island id changes)
      const F = this.mk(requests, supply, ctx, live, true, tMin, islandId, 1);
      const vals = new Float64Array(requests.length);
      let any = false;
      for (let i = 0; i < requests.length; i++) {
        const prev = this.lastGrant.get(requests[i].buildingId);
        if (F.down[i] || !prev || prev.t < tMin - 1 || !Number.isFinite(prev.kw)) continue;
        vals[i] = Math.max(0, Math.min(prev.kw, F.demand[i]));
        any = true;
      }
      if (any) {
        F.load(vals);
        this.enforceLimits(F);
        const o = this.toRecord(F);
        if (checkInvariants(supply, requests, o, ctx, inv).length === 0) {
          result = F;
          out = o;
          used = 'last committed allocation';
        }
      }
      // 2) min-safe floors first by criticality, then proportional to unmet demand
      if (!used) {
        const G = this.mk(requests, supply, ctx, live, true, tMin, islandId, 2);
        G.load(this.proportional(G, supply));
        this.enforceLimits(G);
        const o = this.toRecord(G);
        if (checkInvariants(supply, requests, o, ctx, inv).length === 0) {
          result = G;
          out = o;
          used = 'min-safe-first proportional allocation';
        }
      }
      // 3) nothing flows (always a physically safe state)
      if (!used) {
        out = {};
        for (const r of requests) out[r.buildingId] = 0;
        result = this.mk(requests, supply, ctx, live, true, tMin, islandId, 3);
        this.violationsCommitted++;
        used = 'all-zero safe state (invariants could not be restored)';
      }
      S.emit('fallback', 'crit', `Fallback engaged: committed ${used} for island ${islandId} at t=${tMin}`);
    }

    this.updateFairness(S, out, tMin);
    for (let i = 0; i < requests.length; i++) {
      const id = requests[i].buildingId;
      const kwOut = out[id] ?? 0;
      const g = this.lastGrant.get(id);
      if (g) {
        g.t = tMin;
        g.kw = kwOut;
      } else this.lastGrant.set(id, { t: tMin, kw: kwOut });
    }
    if (live) {
      const u = result.maxUtil();
      if (u > this.stepMaxUtil) this.stepMaxUtil = u;
    }

    const violations: string[] = [];
    for (const [rule, c] of S.fired) {
      violations.push(`safety ${rule}: ${c} correction${c === 1 ? '' : 's'} applied`);
      this.counts[rule] = (this.counts[rule] ?? 0) + c;
    }
    for (const e of S.audit) this.auditLog.push(e);
    if (this.auditLog.length > this.auditKeep * 4) this.auditLog = this.auditLog.slice(-this.auditKeep * 2);
    return { allocation: out, violations, audit: S.audit };
  }

  endStep(snapshot: SimSnapshot): SafetySnapshot {
    const starving: { agentId: string; minutes: number }[] = [];
    for (const [id, f] of this.fair) {
      // a counter only continues while the agent is still short the next minute: entries older than now can never count again
      if (f.t < this.curT) this.fair.delete(id);
      else starving.push({ agentId: id, minutes: f.n });
    }
    starving.sort((a, b) => b.minutes - a.minutes || (a.agentId < b.agentId ? -1 : 1));
    const snap: SafetySnapshot = {
      validator: this.name,
      tMin: snapshot.tMin,
      audit: this.auditLog.slice(-this.auditKeep),
      counts: { ...this.counts },
      violationsCommitted: this.violationsCommitted,
      triageEvents: this.triageEvents,
      starving: starving.slice(0, 60),
      maxEdgeUtilisation: this.stepMaxUtil,
    };
    this.stepMaxUtil = 0;
    return snap;
  }

  // ───────────────────────── steps ─────────────────────────

  private toRecord(S: Solve): Record<string, number> {
    const o: Record<string, number> = {};
    for (let i = 0; i < S.n; i++) o[S.ids[i]] = Math.max(0, S.a[i]);
    return o;
  }

  /** Step 1. */
  private sanitize(S: Solve, proposed: Record<string, number>): void {
    if (sanVals.length < S.n) sanVals = new Float64Array(Math.max(S.n, 2 * sanVals.length));
    const vals = sanVals;
    let nonFinite = 0, negative = 0, over = 0, down = 0, unknown = 0, known = 0;
    const rec: { i: number; before: number; after: number; why: string }[] = [];
    for (let i = 0; i < S.n; i++) {
      const raw = proposed[S.ids[i]];
      if (raw !== undefined || S.ids[i] in proposed) known++;
      let v = raw;
      let why = '';
      if (v === undefined) v = 0;
      else if (!Number.isFinite(v)) { v = 0; nonFinite++; why = 'non-finite'; }
      else if (v < 0) { v = 0; negative++; why = 'negative'; }
      else if (v > S.demand[i] + 1e-6) { v = S.demand[i]; over++; why = 'above demand'; }
      else if (v > S.demand[i]) v = S.demand[i];
      if (S.down[i] && v > 0) {
        rec.push({ i, before: v, after: 0, why: 'destroyed or disconnected' });
        v = 0;
        down++;
      } else if (why && !S.isHouse[i]) rec.push({ i, before: raw, after: v, why });
      vals[i] = v;
    }
    if (Object.keys(proposed).length !== known) {
      // some keys are not requests (or ids repeat): count them exactly
      const mine = new Set<string>(S.ids);
      unknown = 0;
      for (const k of Object.keys(proposed)) if (!mine.has(k)) unknown++;
    }
    S.load(vals);
    if (nonFinite + negative + over + down + unknown === 0) return;
    const parts: string[] = [];
    if (nonFinite) parts.push(`${nonFinite} non-finite`);
    if (negative) parts.push(`${negative} negative`);
    if (over) parts.push(`${over} above-demand`);
    if (down) parts.push(`${down} to destroyed/disconnected consumers`);
    if (unknown) parts.push(`${unknown} for unknown ids`);
    S.emit('sanitize', 'warn', `Policy proposed ${parts.join(', ')} grant(s); corrected to valid values`);
    for (const r of rec) {
      S.emit('sanitize', 'warn',
        `${S.name(r.i)}: proposed ${Number.isFinite(r.before) ? kw(r.before) + ' kW' : 'a non-finite value'} (${r.why}); set to ${kw(r.after)} kW`,
        { agentId: S.ids[r.i], proposedKW: Number.isFinite(r.before) ? r.before : undefined, correctedKW: r.after });
    }
  }

  /** Steps 2–3 (reductions only ever lower loads, so a single pass satisfies every limit). */
  private enforceLimits(S: Solve): void {
    const live = S.live;
    if (live && S.ctx) {
      const bld = S.ctx.snapshot.buildings;
      const edgeRec = new Map<number, Rec>();
      for (let e = 0; e < S.edgeLoad.length; e++) {
        const q = S.edgeQ(e);
        const lim = S.edgeLim[e];
        if (q <= lim + 1e-9) continue;
        // a cut of a member's grant lowers its allocation and its net flow alike: cut the larger of the two excesses
        const L = S.edgeLoad[e];
        let need = L - live.exp[e] - lim;
        if (!S.micro) need = Math.max(need, L - lim);
        // reverse overload (exports beyond the span): trimming demand cannot relieve it (curtailment already bounds it)
        if (need <= 1e-9) continue;
        const members = S.membersOfEdge(e);
        const eid = live.ix.edgeIds[e];
        const t = S.trim(members, need, edgeRec, eid);
        S.emit('edge-capacity', t.critCut ? 'crit' : 'warn',
          `Feeder span ${eid} would carry ${kw(q)} kW${S.micro ? ' net' : ''} > ${kw(lim)} kW limit; trimmed ${kw(t.above)} kW above min-safe` +
          (t.below > 1e-6 ? ` and ${kw(t.below)} kW below min-safe` : '') + ` from ${t.count} consumer${t.count === 1 ? '' : 's'}`,
          { edgeId: eid, proposedKW: q, correctedKW: S.edgeQ(e) });
      }
      S.flush('edge-capacity', edgeRec, 'feeder span limit');
      if (!S.micro) {
        const subRec = new Map<number, Rec>();
        for (let s = 0; s < S.subLoad.length; s++) {
          if (S.subLoad[s] <= S.subLim[s] + 1e-9) continue;
          const members = S.membersOfSub(s);
          const before = S.subLoad[s];
          const sid = live.ix.subIds[s];
          const t = S.trim(members, before - S.subLim[s], subRec, sid);
          const liveLines = live.ix.subTrans[s].filter((id) => S.ctx!.snapshot.network.edges[id]?.status === 'ok').length;
          S.emit('edge-capacity', t.critCut ? 'crit' : 'warn',
            `Substation ${bld[sid]?.name ?? sid} transformer would carry ${kw(before)} kW > ${kw(S.subLim[s])} kW limit (${liveLines} live feed line${liveLines === 1 ? '' : 's'}); trimmed ${kw(t.above)} kW above min-safe` +
            (t.below > 1e-6 ? ` and ${kw(t.below)} kW below min-safe` : '') + ` from ${t.count} consumer${t.count === 1 ? '' : 's'}`,
            { edgeId: sid, proposedKW: before, correctedKW: S.subLoad[s] });
        }
        S.flush('edge-capacity', subRec, 'substation transformer limit');
      }
    }
    this.enforceTransmission(S);
    const lim = Math.max(0, S.supply - SUPPLY_SLACK);
    if (S.total > lim) {
      const all: number[] = [];
      for (let i = 0; i < S.n; i++) if (S.a[i] > 0) all.push(i);
      const rec = new Map<number, Rec>();
      const before = S.total;
      const t = S.trim(all, before - lim, rec);
      if (before - lim < AUDIT_MIN_KW && t.below <= 1e-6) return; // rounding-level trim: applied silently
      S.emit('supply', t.critCut ? 'crit' : 'warn',
        `Allocation ${kw(before)} kW > island supply ${kw(S.supply)} kW; trimmed ${kw(t.above)} kW above min-safe` +
        (t.below > 1e-6 ? ` and ${kw(t.below)} kW below min-safe` : '') + ` from ${t.count} consumer${t.count === 1 ? '' : 's'}`,
        { proposedKW: before, correctedKW: S.total });
      S.flush('supply', rec, 'island supply limit');
    }
  }

  /**
   * Generator → substation transmission trunks: replicate the engine's shortest-path (ECMP) load spreading and
   * trim the consumers downstream of any span that would exceed capacity * margin. Generator islands only.
   */
  private enforceTransmission(S: Solve): void {
    const live = S.live;
    const ctx = S.ctx;
    if (!live || !ctx || S.micro) return;
    const ix = live.ix;
    if (ix.tEdges.length === 0) return;
    const net = ctx.snapshot.network;
    const bld = ctx.snapshot.buildings;
    const liveT = (k: number): boolean => net.edges[ix.tEdges[k].id]?.status === 'ok';
    const depth = new Map<string, number>();
    const order: string[] = [];
    for (const gid of ctx.generatorIds) {
      const n = bld[gid]?.nodeId;
      if (n && !depth.has(n)) { depth.set(n, 0); order.push(n); }
    }
    if (!order.length) return;
    for (let h = 0; h < order.length; h++) {
      const n = order[h];
      for (const k of ix.tAdj.get(n) ?? []) {
        if (!liveT(k)) continue;
        const e = ix.tEdges[k];
        const o = e.from === n ? e.to : e.from;
        if (depth.has(o)) continue;
        depth.set(o, depth.get(n)! + 1);
        order.push(o);
      }
    }
    const parents = new Map<string, number[]>();
    for (const n of order) {
      const d = depth.get(n)!;
      if (d === 0) continue;
      const ps: number[] = [];
      for (const k of ix.tAdj.get(n) ?? []) {
        if (!liveT(k)) continue;
        const e = ix.tEdges[k];
        const o = e.from === n ? e.to : e.from;
        if (depth.get(o) === d - 1) ps.push(k);
      }
      parents.set(n, ps);
    }
    const flows = (loads: (s: number) => number): Float64Array => {
      const f = new Float64Array(ix.tEdges.length);
      const load = new Map<string, number>();
      for (let s = 0; s < ix.subIds.length; s++) {
        const l = loads(s);
        if (l > 0 && depth.has(ix.subNode[s])) load.set(ix.subNode[s], (load.get(ix.subNode[s]) ?? 0) + l);
      }
      for (let i = order.length - 1; i >= 0; i--) {
        const n = order[i];
        if (depth.get(n) === 0) continue;
        const l = load.get(n) ?? 0;
        const ps = parents.get(n);
        if (l <= 0 || !ps || !ps.length) continue;
        const share = l / ps.length;
        for (const k of ps) {
          f[k] += share;
          const e = ix.tEdges[k];
          const o = e.from === n ? e.to : e.from;
          load.set(o, (load.get(o) ?? 0) + share);
        }
      }
      return f;
    };
    const rec = new Map<number, Rec>();
    for (let iter = 0; iter < 30; iter++) {
      const f = flows((s) => S.subLoad[s]);
      let bad = -1;
      for (let k = 0; k < f.length; k++) {
        if (f[k] > ix.tEdges[k].cap * this.edgeMargin + 1e-9) { bad = k; break; }
      }
      if (bad < 0) break;
      const e = ix.tEdges[bad];
      const child = depth.get(e.from)! > depth.get(e.to)! ? e.from : e.to;
      // descendants of the span's child node (nodes whose load can route through it)
      const desc = new Set<string>([child]);
      const q = [child];
      for (let h = 0; h < q.length; h++) {
        const n = q[h];
        for (const k of ix.tAdj.get(n) ?? []) {
          if (!liveT(k)) continue;
          const t = ix.tEdges[k];
          const o = t.from === n ? t.to : t.from;
          if (depth.get(o) === depth.get(n)! + 1 && !desc.has(o)) { desc.add(o); q.push(o); }
        }
      }
      const members: number[] = [];
      const inSet = (s: number): boolean => desc.has(ix.subNode[s]);
      let memberLoad = 0;
      for (let s = 0; s < ix.subIds.length; s++) {
        if (!inSet(s) || S.subLoad[s] <= 0) continue;
        memberLoad += S.subLoad[s];
        for (const i of S.membersOfSub(s)) members.push(i);
      }
      if (memberLoad <= 0 || !members.length) break;
      const share = flows((s) => (inSet(s) ? S.subLoad[s] : 0))[bad] / memberLoad;
      if (share <= 1e-9) break;
      const limit = e.cap * this.edgeMargin;
      const amount = Math.min(memberLoad, ((f[bad] - limit) / share) * 1.0005 + 1e-6);
      const t = S.trim(members, amount, rec, e.id);
      S.emit('edge-capacity', t.critCut ? 'crit' : 'warn',
        `Transmission span ${e.id} would carry ${kw(f[bad])} kW > ${kw(limit)} kW limit; trimmed ${kw(t.above)} kW above min-safe` +
        (t.below > 1e-6 ? ` and ${kw(t.below)} kW below min-safe` : '') + ` from ${t.count} consumer${t.count === 1 ? '' : 's'} downstream`,
        { edgeId: e.id, proposedKW: f[bad], correctedKW: limit });
    }
    S.flush('edge-capacity', rec, 'transmission span limit');
  }

  /** Step 4. */
  private minSafeGuarantee(S: Solve): void {
    const crit: number[] = [];
    for (let i = 0; i < S.n; i++) if (S.crit[i] >= this.critThr && S.floor[i] > 0) crit.push(i);
    const tie = byId(S.ids);
    crit.sort((x, y) => S.crit[y] - S.crit[x] || tie(x, y));
    for (const i of crit) {
      const covered = Math.min(S.backup[i], S.floor[i]);
      const need = S.floor[i] - covered - S.a[i];
      if (need <= 1e-6) continue;
      const before = S.a[i];
      const r = S.shiftTo(i, need, true);
      if (r.moved > 1e-6) {
        S.emit('min-safe', 'warn',
          `${S.name(i)} would get ${kw(before)} kW${covered > 0 ? ` + ${kw(covered)} kW backup` : ''}, below its ${kw(S.floor[i])} kW min-safe floor; moved ${kw(r.moved)} kW from ${r.donors} other consumer${r.donors === 1 ? '' : 's'} (least harm per kW first)`,
          { agentId: S.ids[i], proposedKW: before, correctedKW: S.a[i] });
      }
      if (S.floor[i] - covered - S.a[i] > 1e-3) {
        this.triageEvents++;
        S.emit('triage', 'crit',
          `${S.name(i)} cannot reach its ${kw(S.floor[i])} kW min-safe floor (gets ${kw(S.a[i])} kW${covered > 0 ? ` + ${kw(covered)} kW backup` : ''}): no further power can be moved within supply ${kw(S.supply)} kW and feeder limits`,
          { agentId: S.ids[i], proposedKW: before, correctedKW: S.a[i] });
      }
    }
  }

  /** Step 5. */
  private fairness(S: Solve): void {
    const cands: { i: number; n: number }[] = [];
    for (let i = 0; i < S.n; i++) {
      if (S.floor[i] <= 0 || S.a[i] >= S.floor[i] - 1e-6) continue;
      const f = this.fair.get(S.ids[i]);
      const prior = f && f.t >= S.tMin - 1 ? f.n : 0;
      if (prior + 1 > this.K) cands.push({ i, n: prior + 1 });
    }
    if (!cands.length) return;
    const tie = byId(S.ids);
    cands.sort((x, y) => y.n - x.n || tie(x.i, y.i));
    for (const c of cands) {
      const i = c.i;
      const need = S.floor[i] - S.a[i];
      if (need <= 1e-6) continue;
      const before = S.a[i];
      const r = S.shiftTo(i, need, false);
      if (r.moved <= 1e-6) continue;
      if (S.isHouse[i] && cands.length > 25) {
        S.fired.set('fairness-K', (S.fired.get('fairness-K') ?? 0) + 1);
        continue;
      }
      S.emit('fairness-K', 'warn',
        `${S.name(i)} has been below its ${kw(S.floor[i])} kW min-safe floor for ${c.n} minutes (> ${this.K}); moved ${kw(r.moved)} kW from ${r.donors} consumer${r.donors === 1 ? '' : 's'} above their floors`,
        { agentId: S.ids[i], proposedKW: before, correctedKW: S.a[i] });
    }
  }

  private updateFairness(S: Solve, out: Record<string, number>, tMin: number): void {
    for (let i = 0; i < S.n; i++) {
      const id = S.ids[i];
      if (!(S.floor[i] > 0 && (out[id] ?? 0) < S.floor[i] - 1e-6)) {
        if (this.fair.size > 0) this.fair.delete(id);
        continue;
      }
      const f = this.fair.get(id);
      const n = f && f.t === tMin ? f.n : f && f.t >= tMin - 1 ? f.n + 1 : 1;
      this.fair.set(id, { n, t: tMin });
    }
  }

  /** Internal fallback: min-safe floors by criticality, then proportional to unmet demand. */
  private proportional(S: Solve, supply: number): Float64Array {
    const v = new Float64Array(S.n);
    const tie = byId(S.ids);
    const order = Array.from({ length: S.n }, (_, i) => i).filter((i) => !S.down[i]);
    order.sort((x, y) => S.crit[y] - S.crit[x] || tie(x, y));
    let left = Math.max(0, supply - 1e-6);
    for (const i of order) {
      const g = Math.min(S.floor[i], left);
      v[i] = g;
      left -= g;
    }
    let unmet = 0;
    for (const i of order) unmet += S.demand[i] - v[i];
    if (unmet > EPS && left > 0) {
      const share = Math.min(1, left / unmet);
      for (const i of order) v[i] += (S.demand[i] - v[i]) * share;
    }
    return v;
  }
}
