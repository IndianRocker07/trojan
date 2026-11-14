/**
 * Need-based clearing auction (docs/NEGOTIATION.md §3). Pure functions, no state.
 *
 *  Phase 1  protected minimum-safe floors (tokens excluded; triage ordering by needScore, wT = 0)
 *  Contract forward-contract claims (receiver "now" window / giver repayment window)
 *  Phase 2  need-weighted water-filling by bisection on λ: f_i = min(1, λ·max(score_i, minScore)).
 *           Two tiers (docs/MICROGRID.md §6.3): tier A = everybody's non-charge demand; tier B = the sheddable
 *           buffer-charging kW (opts.chargeKW), filled only with what tier A leaves over.
 *
 * Request size is never a priority term. Tokens carry a hard-capped weight and are ignored in phase 1.
 * Guarantees: Σ grants ≤ supply, 0 ≤ grant ≤ requestKW, no NaN, ties broken by id.
 */
import type { Perception, PriorityBreakdown, PriorityWeights, UtilityBid } from '../core/types';
import { NEGOTIATION_CONFIG, clamp01, type NegotiationConfig } from './config';

export interface ContractClaim {
  agentId: string;
  kw: number;
  contractId: string;
}

export interface ClearOptions {
  cfg?: NegotiationConfig;
  perceptions?: Record<string, Perception | undefined>;
  contractClaims?: ContractClaim[];
  /** Sheddable buffer-charging part of each agent's request (never part of a floor). */
  chargeKW?: Record<string, number>;
}

export interface ClearingResult {
  supplyKW: number;
  totalRequestKW: number;
  totalMinSafeKW: number;
  phase1: Record<string, number>;
  contract: Record<string, number>;
  phase2: Record<string, number>;
  /** the part of phase2 that is buffer charging (tier B); ⊆ phase2 */
  charge: Record<string, number>;
  grants: Record<string, number>;
  priority: Record<string, PriorityBreakdown>;
  /** priority computed with the token weight set to 0 (used for phase-1 triage ordering) */
  needScore: Record<string, number>;
  /** 1 = highest priority; by full score, ties by id */
  rank: Record<string, number>;
  regime: 'surplus' | 'shortage' | 'triage';
  /** agents whose minimum-safe floor could not be fully protected */
  triaged: Record<string, boolean>;
  weights: PriorityWeights;
  /** kW actually given per contract claim */
  contractGranted: Record<string, number>;
}

const EPS = 1e-9;

const fin = (x: number): number => (Number.isFinite(x) ? x : 0);
const pos = (x: number): number => (Number.isFinite(x) && x > 0 ? x : 0);
const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Scarcity-adaptive weights (§3). Logged in the island trace. */
export function computeWeights(supplyKW: number, bids: UtilityBid[], cfg: NegotiationConfig = NEGOTIATION_CONFIG): PriorityWeights {
  let total = 0;
  for (const b of bids) total += pos(b.requestKW);
  const deficit = Math.max(0, total - pos(supplyKW));
  const s = total > EPS ? clamp01(deficit / total) : 0;
  const b = cfg.baseWeights;
  const shift = cfg.scarcityShift * s;
  return {
    criticality: Math.max(0, b.criticality - shift / 2),
    urgency: b.urgency + shift,
    damage: b.damage + shift,
    tokens: Math.min(b.tokens, cfg.maxTokenWeight),
    fairness: Math.max(0, b.fairness - shift / 2),
  };
}

/**
 * Priority of one bid. All terms 0..1; request size is not a term.
 * `perception` blends its damage score into the telemetry damage term with α = perceptionBlend × confidence.
 */
export function priorityOf(
  bid: UtilityBid,
  weights: PriorityWeights,
  cfg: NegotiationConfig = NEGOTIATION_CONFIG,
  perception?: Perception,
): PriorityBreakdown {
  const c = clamp01(bid.criticality);
  const u = clamp01(bid.urgency);
  // Damage term: blend of absolute harm rate and harm *density* (harm per kW of demand). The density part never
  // rewards size (agent_prompt.md: larger requests must not win by size — for equal harm a smaller request scores
  // higher) and is what minimises total damage when a fixed number of kW has to be shared.
  const absDamage = clamp01(pos(bid.expectedDamagePerHour) / Math.max(1e-9, cfg.damageNorm));
  const density = pos(bid.expectedDamagePerHour) / Math.max(1e-9, pos(bid.originalRequestKW) || pos(bid.requestKW));
  const densityDamage = clamp01(density / Math.max(1e-9, cfg.damageDensityNorm));
  const share = clamp01(cfg.damageDensityShare);
  const telemetryDamage = (1 - share) * absDamage + share * densityDamage;
  let d = telemetryDamage;
  if (perception && perception.source !== undefined) {
    const alpha = clamp01(cfg.perceptionBlend * clamp01(perception.confidence));
    d = (1 - alpha) * telemetryDamage + alpha * clamp01(perception.damage);
  }
  const t = clamp01(Math.min(pos(bid.tokensOffered), cfg.tokenBidCap) / Math.max(1e-9, cfg.tokenBidCap));
  const r = clamp01(bid.recentServedShare);
  const wSum = weights.criticality + weights.urgency + weights.damage + weights.tokens + weights.fairness;
  const num = weights.criticality * c + weights.urgency * u + weights.damage * d + weights.tokens * t + weights.fairness * (1 - r);
  const score = wSum > EPS ? clamp01(num / wSum) : 0;
  return { score, weights, terms: { criticality: c, urgency: u, damage: d, tokens: t, fairness: r } };
}

/** Run the full two-phase clearing for one island. */
export function clear(supplyKW: number, rawBids: UtilityBid[], opts: ClearOptions = {}): ClearingResult {
  const cfg = opts.cfg ?? NEGOTIATION_CONFIG;
  const supply = pos(supplyKW);

  // sanitise (request ≥ 0, floor ≤ request)
  const bids: UtilityBid[] = [];
  for (const b of rawBids) {
    const request = pos(b.requestKW);
    const minSafe = Math.min(pos(b.minSafeKW), request);
    bids.push(request === b.requestKW && minSafe === b.minSafeKW ? b : { ...b, requestKW: request, minSafeKW: minSafe });
  }
  bids.sort((a, b) => cmpId(a.agentId, b.agentId));
  const n = bids.length;

  const weights = computeWeights(supply, bids, cfg);
  const needWeights: PriorityWeights = { ...weights, tokens: 0 };

  // All per-bid state lives in arrays indexed by the (id-sorted) bid position; the Records of the result are built at the end.
  const priority: PriorityBreakdown[] = new Array(n);
  const needScoreA = new Float64Array(n);
  const p1 = new Float64Array(n);
  const ctr = new Float64Array(n);
  const p2 = new Float64Array(n);
  const chg = new Float64Array(n);
  const chargeReq = new Float64Array(n);
  const tri = new Uint8Array(n);
  const idx = new Map<string, number>();
  const contractGranted: Record<string, number> = {};

  const nwSum = needWeights.criticality + needWeights.urgency + needWeights.damage + needWeights.tokens + needWeights.fairness;
  let totalRequest = 0;
  let totalFloor = 0;
  for (let i = 0; i < n; i++) {
    const b = bids[i];
    idx.set(b.agentId, i);
    const p = opts.perceptions?.[b.agentId];
    const pr = priorityOf(b, weights, cfg, p);
    priority[i] = pr;
    // need score: same terms, token weight 0 (== priorityOf(b, needWeights, cfg, p).score without rebuilding the terms)
    const t = pr.terms;
    const num =
      needWeights.criticality * t.criticality +
      needWeights.urgency * t.urgency +
      needWeights.damage * t.damage +
      needWeights.tokens * t.tokens +
      needWeights.fairness * (1 - t.fairness);
    needScoreA[i] = nwSum > EPS ? clamp01(num / nwSum) : 0;
    // charging is capped to what lies above the floor (floors never include it)
    chargeReq[i] = Math.min(pos(opts.chargeKW?.[b.agentId] ?? 0), Math.max(0, b.requestKW - b.minSafeKW));
    totalRequest += b.requestKW;
    totalFloor += b.minSafeKW;
  }

  // ranks by full priority
  const byScore = new Array<number>(n);
  for (let i = 0; i < n; i++) byScore[i] = i;
  byScore.sort((a, b) => priority[b].score - priority[a].score || cmpId(bids[a].agentId, bids[b].agentId));

  // ── phase 1: protected minimum-safe floors ──
  let left = supply;
  let regime: ClearingResult['regime'];
  if (totalFloor <= supply + EPS) {
    regime = totalRequest > supply + EPS ? 'shortage' : 'surplus';
    for (let i = 0; i < n; i++) {
      const g = Math.min(bids[i].minSafeKW, left);
      p1[i] = g;
      left -= g;
    }
    left = Math.max(0, left);
  } else {
    regime = 'triage';
    const order = new Array<number>(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => needScoreA[b] - needScoreA[a] || cmpId(bids[a].agentId, bids[b].agentId));
    for (const i of order) {
      const b = bids[i];
      const g = Math.max(0, Math.min(b.minSafeKW, left));
      p1[i] = g;
      left -= g;
      if (g < b.minSafeKW - 1e-6) tri[i] = 1;
    }
    left = Math.max(0, left);
  }

  // ── contract claims ──
  if (opts.contractClaims) {
    for (const c of opts.contractClaims) {
      const i = idx.get(c.agentId);
      if (i === undefined || left <= EPS) continue;
      const unmet = bids[i].requestKW - chargeReq[i] - p1[i] - ctr[i];
      const g = Math.max(0, Math.min(pos(c.kw), left, unmet));
      if (g <= 0) continue;
      ctr[i] += g;
      contractGranted[c.contractId] = (contractGranted[c.contractId] ?? 0) + g;
      left -= g;
    }
    left = Math.max(0, left);
  }

  // ── phase 2: need-weighted water-filling (tier A: non-charge demand; tier B: buffer charging) ──
  const waterFill = (oi: number[], om: number[], os: number[], avail: number, out: Float64Array): number => {
    const m = oi.length;
    if (m === 0 || avail <= EPS) return 0;
    let sumUnmet = 0;
    let minS = Infinity;
    for (let k = 0; k < m; k++) {
      sumUnmet += om[k];
      if (os[k] < minS) minS = os[k];
    }
    let used = 0;
    if (avail >= sumUnmet - EPS) {
      for (let k = 0; k < m; k++) {
        out[oi[k]] += om[k];
        used += om[k];
      }
      return used;
    }
    const served = (lambda: number): number => {
      let t = 0;
      for (let k = 0; k < m; k++) t += Math.min(1, lambda * os[k]) * om[k];
      return t;
    };
    let lo = 0;
    let hi = 1 / minS; // at hi every f_i = 1 ⇒ served = sumUnmet > avail
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (served(mid) > avail) hi = mid;
      else lo = mid;
    }
    const total = served(lo);
    const scale = total > avail ? avail / total : 1;
    for (let k = 0; k < m; k++) {
      const g = Math.min(om[k], Math.min(1, lo * os[k]) * om[k] * scale);
      out[oi[k]] += g;
      used += g;
    }
    return used;
  };

  // Phase-2 weight = need score × harm prevented per kW (marginal damage), sharpened by γ. Floors are already
  // protected, so the remainder goes where each kW prevents the most need-weighted harm; request size never helps
  // (per-kW harm falls as requests grow). γ → ∞ approaches greedy damage-optimal filling; γ = 1, no density = the
  // original proportional water-fill.
  const w = new Float64Array(n);
  let maxW = 0;
  for (let i = 0; i < n; i++) {
    const b = bids[i];
    const base = Math.max(priority[i].score, cfg.minScore, 1e-6);
    let v: number;
    if (!cfg.phase2MarginalDamage) v = base;
    else {
      const kw = Math.max(1e-6, pos(b.originalRequestKW) || pos(b.requestKW));
      const dens = Math.min(4, Math.max(0.02, pos(b.expectedDamagePerHour) / kw / Math.max(1e-9, cfg.damageDensityNorm)));
      v = Math.pow(base * dens, Math.max(1, cfg.phase2Sharpness));
    }
    w[i] = v;
    maxW = Math.max(maxW, v);
  }
  const aI: number[] = [];
  const aM: number[] = [];
  const aS: number[] = [];
  const bI: number[] = [];
  const bM: number[] = [];
  const bS: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = bids[i];
    const unmet = Math.max(0, b.requestKW - p1[i] - ctr[i]);
    const s = Math.max(maxW > 0 ? w[i] / maxW : 1, 1e-9);
    const mB = Math.min(chargeReq[i], unmet);
    const mA = unmet - mB;
    if (mA > EPS) {
      aI.push(i);
      aM.push(mA);
      aS.push(s);
    }
    if (mB > EPS) {
      bI.push(i);
      bM.push(mB);
      bS.push(s);
    }
  }
  left -= waterFill(aI, aM, aS, left, p2);
  left = Math.max(0, left);
  waterFill(bI, bM, bS, left, chg);
  for (let i = 0; i < n; i++) p2[i] += chg[i];

  // ── totals, with a hard guard on Σ ≤ supply ──
  const gr = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const g = fin(p1[i]) + fin(ctr[i]) + fin(p2[i]);
    gr[i] = Math.min(bids[i].requestKW, g);
    sum += gr[i];
  }
  if (sum > supply) {
    const k = supply / sum;
    for (let i = 0; i < n; i++) {
      gr[i] *= k;
      p2[i] *= k;
      chg[i] *= k;
      ctr[i] *= k;
      p1[i] *= k;
    }
  }

  const prio: Record<string, PriorityBreakdown> = {};
  const needScore: Record<string, number> = {};
  const phase1: Record<string, number> = {};
  const contract: Record<string, number> = {};
  const phase2: Record<string, number> = {};
  const charge: Record<string, number> = {};
  const grants: Record<string, number> = {};
  const triaged: Record<string, boolean> = {};
  const rank: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const id = bids[i].agentId;
    prio[id] = priority[i];
    needScore[id] = needScoreA[i];
    phase1[id] = p1[i];
    contract[id] = ctr[i];
    phase2[id] = p2[i];
    charge[id] = chg[i];
    triaged[id] = tri[i] === 1;
    grants[id] = gr[i];
  }
  for (let r = 0; r < n; r++) rank[bids[byScore[r]].agentId] = r + 1;

  return {
    supplyKW: supply,
    totalRequestKW: totalRequest,
    totalMinSafeKW: totalFloor,
    phase1,
    contract,
    phase2,
    charge,
    grants,
    priority: prio,
    needScore,
    rank,
    regime,
    triaged,
    weights,
    contractGranted,
  };
}
