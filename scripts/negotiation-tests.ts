/**
 * Layer 2 (negotiation) unit tests — agent_prompt.md §7. Run: npx tsx scripts/negotiation-tests.ts
 * Self-contained harness (no test framework installed). Exit code 1 on any failure.
 */
import { Rng } from '../src/core/rng';
import type { AllocationRequest, Perception, UtilityAgentState, UtilityBid } from '../src/core/types';
import type { Assessment, HouseholdCluster, PublicIslandInfo } from '../src/negotiation/agentApi';
import {
  ClusterAgent,
  NEGOTIATION_CONFIG,
  TokenLedger,
  UtilityAgent,
  clear,
  computeWeights,
  priorityOf,
  type ClearingResult,
  type ContractClaim,
} from '../src/negotiation';

// ───────────────────────────── tiny harness ─────────────────────────────

class AssertionError extends Error {}
type Case = { name: string; fn: () => void };
const cases: Case[] = [];
const test = (name: string, fn: () => void): void => {
  cases.push({ name, fn });
};
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}
function assertClose(actual: number, expected: number, eps: number, msg: string): void {
  assert(Number.isFinite(actual) && Math.abs(actual - expected) <= eps, `${msg}: expected ${expected}, got ${actual}`);
}
function assertLe(actual: number, limit: number, msg: string): void {
  assert(actual <= limit, `${msg}: ${actual} > ${limit}`);
}
function assertGe(actual: number, limit: number, msg: string): void {
  assert(actual >= limit, `${msg}: ${actual} < ${limit}`);
}

// ───────────────────────────── helpers ─────────────────────────────

const CFG = NEGOTIATION_CONFIG;

/** UtilityBid with sane defaults for every field. originalRequestKW defaults to requestKW. */
function mkBid(overrides: Partial<UtilityBid> & { agentId: string }): UtilityBid {
  const requestKW = overrides.requestKW ?? 100;
  return {
    kind: 'house',
    islandId: 0,
    tMin: 0,
    round: 1,
    mode: 'active',
    minSafeKW: 0,
    criticality: 0.25,
    urgency: 0.2,
    expectedDamagePerHour: 1,
    flexibleKW: 0,
    flex: [],
    concededKW: 0,
    concessionWillingness: 0,
    backupRemainingKWh: 0,
    backupHours: 0,
    recentServedShare: 1,
    tokensOffered: 0,
    ...overrides,
    requestKW,
    originalRequestKW: overrides.originalRequestKW ?? requestKW,
  };
}

/** Served fraction of a bid's request in a clearing result. */
const servedFrac = (r: ClearingResult, b: UtilityBid): number => (b.requestKW > 0 ? r.grants[b.agentId] / b.requestKW : 0);

function mkReq(id: string, demandKW: number, minSafeKW: number, medical: 0 | 1 = 0): AllocationRequest {
  return {
    buildingId: id,
    kind: 'house',
    demandKW,
    minSafeKW,
    criticality: 0.25,
    urgency: 0.1,
    expectedDamagePerHour: 1,
    tokens: 0,
    telemetry: { medicalDevice: medical },
  };
}

// ───────────────────────────── (a) tokens cannot defeat criticality ─────────────────────────────

test('(a) more tokens cannot defeat a more critical agent (hospital beats token-rich house under scarcity)', () => {
  const hospital = mkBid({ agentId: 'hospital-1', kind: 'hospital', requestKW: 800, minSafeKW: 500, criticality: 1.0, urgency: 0.7, expectedDamagePerHour: 120, tokensOffered: 0 });
  // cluster-like house bid: low criticality/urgency, same absolute damage, maximal token offer
  const rich = mkBid({ agentId: 'cluster-rich', kind: 'house', requestKW: 800, minSafeKW: 50, criticality: 0.25, urgency: 0.2, expectedDamagePerHour: 120, tokensOffered: 1000 });
  const r = clear(900, [hospital, rich]);
  assert(r.regime === 'shortage', `expected shortage regime, got ${r.regime}`);
  const sh = r.priority['hospital-1'].score;
  const sr = r.priority['cluster-rich'].score;
  assert(sh > sr, `hospital score ${sh} must exceed token-rich score ${sr}`);
  const fh = servedFrac(r, hospital);
  const fr = servedFrac(r, rich);
  assert(fh >= fr - 1e-12, `hospital served fraction ${fh} must be >= token-rich ${fr}`);
});

// ───────────────────────────── (b) hospital min-safe protection ─────────────────────────────

test('(b) hospital min-safe floor protected: every floor granted when supply = Σ minSafe + epsilon', () => {
  const bids: UtilityBid[] = [mkBid({ agentId: 'hospital-1', kind: 'hospital', requestKW: 800, minSafeKW: 300, criticality: 1, urgency: 0.7, expectedDamagePerHour: 100 })];
  for (let i = 0; i < 30; i++) {
    bids.push(mkBid({ agentId: `house-${String(i).padStart(2, '0')}`, kind: 'house', requestKW: 40, minSafeKW: 10, criticality: 0.25, urgency: 0.2, expectedDamagePerHour: 1, tokensOffered: 1000 }));
  }
  const sumFloor = bids.reduce((a, b) => a + b.minSafeKW, 0);
  const r = clear(sumFloor + 0.5, bids);
  assert(r.regime === 'shortage', `expected shortage (floors fit, requests exceed supply), got ${r.regime}`);
  for (const b of bids) {
    assertClose(r.phase1[b.agentId], b.minSafeKW, 1e-9, `phase1 of ${b.agentId}`);
    assert(!r.triaged[b.agentId], `${b.agentId} must not be triaged when floors fit`);
  }
});

test('(b) hospital floor granted before low-criticality floors in triage; tokens do not change phase 1', () => {
  const build = (houseTokens: number): UtilityBid[] => {
    const bids: UtilityBid[] = [mkBid({ agentId: 'hospital-1', kind: 'hospital', requestKW: 800, minSafeKW: 300, criticality: 1, urgency: 0.7, expectedDamagePerHour: 100 })];
    for (let i = 0; i < 30; i++) {
      bids.push(mkBid({ agentId: `house-${String(i).padStart(2, '0')}`, kind: 'house', requestKW: 40, minSafeKW: 10, criticality: 0.25, urgency: 0.2, expectedDamagePerHour: 1, tokensOffered: houseTokens }));
    }
    return bids;
  };
  const supply = 450; // < Σ minSafe (600), >= hospital floor (300)
  const noTokens = clear(supply, build(0));
  const maxTokens = clear(supply, build(1000));
  assert(noTokens.regime === 'triage', `expected triage regime, got ${noTokens.regime}`);
  assertClose(noTokens.phase1['hospital-1'], 300, 1e-9, 'hospital phase1 in triage');
  assert(!noTokens.triaged['hospital-1'], 'hospital must not be triaged while its floor fits');
  const houseSum = Object.keys(noTokens.phase1).filter((id) => id.startsWith('house-')).reduce((a, id) => a + noTokens.phase1[id], 0);
  assertClose(houseSum, supply - 300, 1e-6, 'remaining supply goes to house floors');
  assert(Object.keys(noTokens.triaged).some((id) => id.startsWith('house-') && noTokens.triaged[id]), 'some low-criticality floors must be triaged');
  for (const id of Object.keys(noTokens.phase1)) {
    assertClose(maxTokens.phase1[id], noTokens.phase1[id], 1e-12, `phase1 of ${id} must not depend on tokens`);
    assert(maxTokens.triaged[id] === noTokens.triaged[id], `triaged flag of ${id} must not depend on tokens`);
  }
});

// ───────────────────────────── (c) urgency ─────────────────────────────

test('(c) raising an agent\'s urgency raises its score and its grant', () => {
  const pair = (urgencyA: number): UtilityBid[] => [
    mkBid({ agentId: 'agent-a', kind: 'school', requestKW: 800, minSafeKW: 50, criticality: 0.6, urgency: urgencyA, expectedDamagePerHour: 40 }),
    mkBid({ agentId: 'agent-b', kind: 'school', requestKW: 800, minSafeKW: 50, criticality: 0.6, urgency: 0.5, expectedDamagePerHour: 40 }),
  ];
  const low = pair(0.3);
  const high = pair(0.9);
  const rLow = clear(900, low);
  const rHigh = clear(900, high);
  assert(rLow.regime === 'shortage' && rHigh.regime === 'shortage', 'expected shortage regime');
  assert(rHigh.priority['agent-a'].score > rLow.priority['agent-a'].score, `urgency 0.9 score ${rHigh.priority['agent-a'].score} must exceed urgency 0.3 score ${rLow.priority['agent-a'].score}`);
  assert(rHigh.grants['agent-a'] > rLow.grants['agent-a'], `grant must rise with urgency: ${rLow.grants['agent-a']} -> ${rHigh.grants['agent-a']}`);
  assert(rHigh.grants['agent-b'] < rLow.grants['agent-b'], 'the competing agent must receive less when the other is more urgent');
});

// ───────────────────────────── (d) expected damage ─────────────────────────────

test('(d) changing expected damage per hour changes score and grant', () => {
  const pair = (damageA: number): UtilityBid[] => [
    mkBid({ agentId: 'agent-a', kind: 'water', requestKW: 800, minSafeKW: 50, criticality: 0.6, urgency: 0.4, expectedDamagePerHour: damageA }),
    mkBid({ agentId: 'agent-b', kind: 'water', requestKW: 800, minSafeKW: 50, criticality: 0.6, urgency: 0.4, expectedDamagePerHour: 40 }),
  ];
  const low = clear(900, pair(10));
  const high = clear(900, pair(120));
  assert(high.priority['agent-a'].score > low.priority['agent-a'].score, `damage 120 score ${high.priority['agent-a'].score} must exceed damage 10 score ${low.priority['agent-a'].score}`);
  assert(high.grants['agent-a'] > low.grants['agent-a'], `grant must rise with expected damage: ${low.grants['agent-a']} -> ${high.grants['agent-a']}`);
});

// ───────────────────────────── (e) request size ─────────────────────────────

test('(e) identical bids with requestKW 50 vs 2000 get equal scores (zero damage) and small fraction >= large', () => {
  const base = { kind: 'school' as const, minSafeKW: 20, criticality: 0.55, urgency: 0.4, expectedDamagePerHour: 0, tokensOffered: 0 };
  const small = mkBid({ ...base, agentId: 'small', requestKW: 50 });
  const large = mkBid({ ...base, agentId: 'large', requestKW: 2000 });
  const r = clear(1000, [small, large]);
  assert(r.regime === 'shortage', `expected shortage, got ${r.regime}`);
  assertClose(r.priority.small.score, r.priority.large.score, 1e-12, 'scores of identical bids differing only in request size');
  assertGe(servedFrac(r, small), servedFrac(r, large), 'served fraction of small request vs large');
});

test('(e) with equal nonzero damage, the larger request never gets the higher priority', () => {
  const base = { kind: 'school' as const, minSafeKW: 20, criticality: 0.55, urgency: 0.4, expectedDamagePerHour: 30, tokensOffered: 0 };
  const small = mkBid({ ...base, agentId: 'small', requestKW: 50 });
  const large = mkBid({ ...base, agentId: 'large', requestKW: 2000 });
  const r = clear(1000, [small, large]);
  assertLe(r.priority.large.score, r.priority.small.score + 1e-12, 'large request score must not exceed small request score');
  assertGe(servedFrac(r, small), servedFrac(r, large), 'served fraction of small request vs large');
});

// ───────────────────────────── (f) zero tokens win on need ─────────────────────────────

test('(f) a zero-token high-need bid beats a high-token low-need bid', () => {
  const needy = mkBid({ agentId: 'water-needy', kind: 'water', requestKW: 800, minSafeKW: 280, criticality: 0.85, urgency: 0.8, expectedDamagePerHour: 70, tokensOffered: 0 });
  const rich = mkBid({ agentId: 'house-rich', kind: 'house', requestKW: 800, minSafeKW: 80, criticality: 0.25, urgency: 0.1, expectedDamagePerHour: 5, tokensOffered: 1000 });
  const r = clear(900, [needy, rich]);
  assert(r.priority['water-needy'].score > r.priority['house-rich'].score, 'zero-token high-need score must exceed token-rich low-need score');
  assert(r.grants['water-needy'] > r.grants['house-rich'], `zero-token agent must receive more power: ${r.grants['water-needy']} vs ${r.grants['house-rich']}`);
  assert(servedFrac(r, needy) > servedFrac(r, rich), 'zero-token agent must have the higher served fraction');
});

// ───────────────────────────── (g) token rewards ─────────────────────────────

test('(g) a verified concession earns tokens (balance goes up) and the ledger invariant holds', () => {
  const ledger = new TokenLedger(CFG);
  ledger.setTime(60);
  const before = ledger.ensure('house-1');
  // verified concession: 200 kW deferred for one minute => kW·min = 200
  const earned = ledger.earn('house-1', 200, 'conc-test');
  const after = ledger.balance('house-1');
  assert(earned > 0, 'concession must earn a positive amount');
  assert(after > before, `balance must rise after a verified concession: ${before} -> ${after}`);
  assertClose(after - before, earned, 1e-12, 'balance change equals the amount earned');
  assert(ledger.checkInvariant(), 'ledger invariant must hold after earning');
});

test('(g) maximum token offer shifts priority by at most maxTokenWeight / Σweights and never changes phase 1', () => {
  const sharedRequests = (tokens: number): UtilityBid[] => [
    mkBid({ agentId: 'hospital-1', kind: 'hospital', requestKW: 800, minSafeKW: 500, criticality: 1, urgency: 0.7, expectedDamagePerHour: 100, tokensOffered: 0 }),
    mkBid({ agentId: 'house-x', kind: 'house', requestKW: 800, minSafeKW: 60, criticality: 0.25, urgency: 0.2, expectedDamagePerHour: 5, tokensOffered: tokens }),
    mkBid({ agentId: 'school-x', kind: 'school', requestKW: 300, minSafeKW: 40, criticality: 0.55, urgency: 0.3, expectedDamagePerHour: 15, tokensOffered: 0 }),
  ];
  const supply = 900;
  const zero = sharedRequests(0);
  const max = sharedRequests(CFG.tokenCap);
  const weights = computeWeights(supply, zero, CFG);
  const wSum = weights.criticality + weights.urgency + weights.damage + weights.tokens + weights.fairness;
  const bound = CFG.maxTokenWeight / wSum;
  const base = priorityOf(zero[1], weights, CFG).score;
  const withMax = priorityOf(max[1], weights, CFG).score;
  assertLe(Math.abs(withMax - base), bound + 1e-12, 'token-driven score change must be bounded by maxTokenWeight / Σweights');
  const huge = priorityOf(mkBid({ ...max[1], tokensOffered: 1e9 }), weights, CFG).score;
  assertClose(huge, withMax, 1e-12, 'tokens beyond tokenBidCap must add nothing');
  assertLe(weights.tokens, CFG.maxTokenWeight + 1e-12, 'token weight must respect the hard cap');

  // phase 1 must be identical with zero or maximal tokens, both in shortage and in triage
  for (const s of [supply, 500]) {
    const a = clear(s, zero);
    const b = clear(s, max);
    for (const id of Object.keys(a.phase1)) {
      assertClose(b.phase1[id], a.phase1[id], 1e-12, `phase1 of ${id} at supply ${s}`);
      assert(a.triaged[id] === b.triaged[id], `triaged flag of ${id} at supply ${s} must not depend on tokens`);
    }
  }
});

// ───────────────────────────── invariants over random clearings ─────────────────────────────

test('invariants over 500 randomized clearings: Σ grants <= supply, 0 <= grant <= request, no NaN', () => {
  const rng = new Rng(20260601);
  let clearings = 0;
  let scarce = 0;
  for (let it = 0; it < 500; it++) {
    const n = rng.int(0, 12);
    const bids: UtilityBid[] = [];
    const perceptions: Record<string, Perception> = {};
    for (let i = 0; i < n; i++) {
      const id = `agent-${i}`;
      const requestKW = rng.chance(0.1) ? 0 : rng.range(0, 3000);
      const minSafeKW = rng.range(-10, requestKW * 1.5); // deliberately out-of-range sometimes
      bids.push(
        mkBid({
          agentId: id,
          kind: rng.pick(['hospital', 'water', 'emergency', 'telecom', 'school', 'house'] as const),
          requestKW,
          minSafeKW,
          criticality: rng.range(-0.2, 1.2),
          urgency: rng.range(-0.1, 1.3),
          expectedDamagePerHour: rng.range(0, 300),
          tokensOffered: rng.range(0, 50),
          recentServedShare: rng.next(),
        }),
      );
      if (rng.chance(0.5)) {
        perceptions[id] = {
          agentId: id,
          source: rng.chance(0.5) ? 'jev' : 'heuristic',
          tMin: 0,
          urgency: rng.next(),
          damage: rng.next(),
          imminentFailureRisk: rng.next(),
          canConcede: rng.next(),
          concessionStrategy: 'none',
          confidence: rng.next(),
        };
      }
    }
    const supply = rng.range(-100, 8000);
    const claims: ContractClaim[] = [];
    const nClaims = rng.int(0, 2);
    for (let k = 0; k < nClaims && n > 0; k++) {
      claims.push({ agentId: `agent-${rng.int(0, n - 1)}`, kw: rng.range(0, 500), contractId: `c${it}-${k}` });
    }
    const r = clear(supply, bids, { perceptions, contractClaims: claims });
    clearings++;
    const supplyPos = Math.max(0, supply);
    if (r.totalRequestKW > supplyPos) scarce++;
    let sum = 0;
    for (const b of bids) {
      const g = r.grants[b.agentId];
      const cap = Math.max(0, b.requestKW);
      assert(Number.isFinite(g), `iteration ${it}: non-finite grant for ${b.agentId}`);
      assertGe(g, 0, `iteration ${it}: negative grant for ${b.agentId}`);
      assertLe(g, cap + 1e-9, `iteration ${it}: grant above request for ${b.agentId}`);
      for (const table of [r.phase1, r.phase2, r.contract, r.needScore]) {
        assert(!Number.isNaN(table[b.agentId]), `iteration ${it}: NaN in table for ${b.agentId}`);
      }
      const p = r.priority[b.agentId];
      assert(p && Number.isFinite(p.score) && p.score >= 0 && p.score <= 1, `iteration ${it}: priority score out of [0,1] for ${b.agentId}`);
      sum += g;
    }
    assertLe(sum, supplyPos + 1e-6, `iteration ${it}: Σ grants exceeds supply`);
  }
  assert(clearings === 500, 'expected 500 clearings');
  assert(scarce > 50, `randomised set should exercise scarcity often (got ${scarce})`);
});

// ───────────────────────────── cluster split ─────────────────────────────

test('ClusterAgent.split sums correctly (Σ = min(grant, Σ demand)) and never exceeds any member demand', () => {
  const cluster: HouseholdCluster = { id: 'cluster-test', substationId: 'substation-0', memberIds: [] };
  const agent = new ClusterAgent(cluster);
  const members = [mkReq('med-1', 100, 60, 1), mkReq('med-2', 80, 40, 1), mkReq('house-a', 200, 30), mkReq('house-b', 50, 20), mkReq('house-c', 500, 0)];
  const totalDemand = members.reduce((a, m) => a + m.demandKW, 0);
  for (const grant of [0, 1, 50, 120, 500, 930, 5000]) {
    const out = agent.split(grant, members);
    let sum = 0;
    for (const m of members) {
      const g = out[m.buildingId];
      assert(Number.isFinite(g) && g >= -1e-12, `non-finite or negative split for ${m.buildingId}`);
      assertLe(g, m.demandKW + 1e-9, `split above demand for ${m.buildingId}`);
      sum += g;
    }
    assertClose(sum, Math.min(grant, totalDemand), 1e-6, `Σ split for grant ${grant}`);
  }
});

test('ClusterAgent.split protects medical-device members first', () => {
  const agent = new ClusterAgent({ id: 'cluster-test', substationId: 'substation-0', memberIds: [] });
  const members = [mkReq('med-1', 100, 60, 1), mkReq('med-2', 80, 40, 1), mkReq('house-a', 200, 30), mkReq('house-b', 50, 20), mkReq('house-c', 500, 0)];

  // grant covers every medical floor (100 kW) plus part of the rest
  const enough = agent.split(120, members);
  assertClose(enough['med-1'], 60, 1e-9, 'medical floor 1 fully protected');
  assertClose(enough['med-2'], 40, 1e-9, 'medical floor 2 fully protected');
  assertClose(enough['house-a'], 12, 1e-9, 'remaining 20 kW shared pro-rata over non-medical floors (house-a)');
  assertClose(enough['house-b'], 8, 1e-9, 'remaining 20 kW shared pro-rata over non-medical floors (house-b)');

  // grant below the medical floors: nothing may go to non-medical members
  const scarce = agent.split(60, members);
  assert(scarce['med-1'] > 0 && scarce['med-2'] > 0, 'medical members must receive power first');
  assertClose(scarce['house-a'] + scarce['house-b'] + scarce['house-c'], 0, 1e-12, 'non-medical members must receive nothing while medical floors are short');
});

// ───────────────────────────── ledger ─────────────────────────────

test('TokenLedger: never negative and invariant holds after 2000 random escrow/charge/release/earn/transfer/tick ops', () => {
  const rng = new Rng(777);
  const ledger = new TokenLedger(CFG);
  const ids = ['a', 'b', 'c', 'd'];
  let t = 0;
  for (let step = 0; step < 2000; step++) {
    const id = rng.pick(ids);
    const op = rng.int(0, 6);
    switch (op) {
      case 0:
        ledger.escrow(id, rng.range(-5, 50), 'contract_stake');
        break;
      case 1:
        ledger.release(id, rng.range(-5, 50), 'contract_refund');
        break;
      case 2:
        ledger.charge(id, rng.range(-5, 50));
        break;
      case 3:
        ledger.earn(id, rng.range(-100, 5000));
        break;
      case 4:
        ledger.transfer(id, rng.pick(ids), rng.range(0, 30), 'contract_forfeit', undefined, rng.chance(0.5));
        break;
      case 5:
        t += rng.int(0, 180);
        ledger.setTime(t);
        ledger.tick(t);
        break;
      default:
        ledger.ensure(id);
    }
    assert(ledger.checkInvariant(), `invariant broken at step ${step} (op ${op})`);
    for (const x of ids) {
      assertGe(ledger.balance(x), 0, `negative balance for ${x} at step ${step}`);
      assertGe(ledger.escrowed(x), 0, `negative escrow for ${x} at step ${step}`);
    }
  }
  assertGe(ledger.total(), 0, 'total balance');
});

// ───────────────────────────── (h) buffer charging is served last ─────────────────────────────

test('(h) buffer charging (chargeKW) is served only after all non-charge demand on the island', () => {
  const bids: UtilityBid[] = [
    mkBid({ agentId: 'water-1', kind: 'water', requestKW: 600, minSafeKW: 100, criticality: 0.85, urgency: 0.5, expectedDamagePerHour: 40 }),
    mkBid({ agentId: 'house-1', kind: 'house', requestKW: 400, minSafeKW: 50, criticality: 0.25, urgency: 0.2, expectedDamagePerHour: 5 }),
    mkBid({ agentId: 'school-1', kind: 'school', requestKW: 200, minSafeKW: 20, criticality: 0.55, urgency: 0.3, expectedDamagePerHour: 15 }),
  ];
  // 300 of the water station's 600 kW is pre-charging its reservoir; the rest of the island needs 900 kW (non-charge)
  const chargeKW: Record<string, number> = { 'water-1': 300 };
  const nonCharge: Record<string, number> = { 'water-1': 300, 'house-1': 400, 'school-1': 200 };
  const chargeSum = (r: ClearingResult): number => Object.values(r.charge).reduce((a, x) => a + x, 0);
  for (let supply = 170; supply <= 1200; supply += 10) {
    const r = clear(supply, bids, { chargeKW });
    for (const b of bids) {
      assertLe(r.charge[b.agentId], (chargeKW[b.agentId] ?? 0) + 1e-9, `supply ${supply}: charge above chargeKW for ${b.agentId}`);
    }
    if (chargeSum(r) > 1e-6) {
      for (const b of bids) {
        const nc = r.grants[b.agentId] - r.charge[b.agentId];
        assertGe(nc, nonCharge[b.agentId] - 1e-6, `supply ${supply}: ${b.agentId} non-charge demand not fully served while buffers charge`);
      }
    }
  }
  const atTotal = clear(900, bids, { chargeKW });
  assertClose(chargeSum(atTotal), 0, 1e-6, 'no charging while non-charge demand exactly fits the supply');
  assertClose(atTotal.grants['water-1'], 300, 1e-6, 'water station gets exactly its non-charge demand');
  const surplus = clear(1000, bids, { chargeKW });
  assertClose(surplus.charge['water-1'], 100, 1e-6, 'the 100 kW left after all non-charge demand goes to charging');
  assertClose(surplus.grants['house-1'], 400, 1e-6, 'house fully served before any charging');
});

// ───────────────────────────── (i) dependency damage ─────────────────────────────

test('(i) dependency damage raises a water station bid damage, score and grant (dependent part capped at 3 x own)', () => {
  const island: PublicIslandInfo = { islandId: 0, tMin: 600, hourOfDay: 12, supplyKW: 500, totalRequestKW: 900, totalMinSafeKW: 200, deficitKW: 400, consumers: 2 };
  const assessment: Assessment = { mode: 'active', affected: true, reasons: ['test'] };
  const stateOf = (dep: number | undefined): UtilityAgentState => ({
    buildingId: 'water-1',
    kind: 'water',
    demandKW: 400,
    minSafeKW: 120,
    criticality: 0.85,
    urgency: 0.4,
    expectedDamagePerHour: 20,
    allocatedKW: 0,
    connected: true,
    backup: { type: 'none', capacityKWh: 0, remainingKWh: 0, maxKW: 0 },
    telemetry: {},
    tokens: 0,
    ...(dep !== undefined ? { dependents: ['hospital-1'], dependentDamagePerHour: dep } : {}),
  });
  const bidOf = (dep: number | undefined): UtilityBid => new UtilityAgent('water-1', 'water', 'Water station').propose(stateOf(dep), undefined, island, assessment, 0).bid;
  const own = bidOf(undefined);
  const dep30 = bidOf(30);
  const depHuge = bidOf(1000);
  assertClose(own.expectedDamagePerHour, 20, 1e-9, 'own damage only without dependents');
  assertClose(dep30.expectedDamagePerHour, 50, 1e-9, '20 own + 30 dependent');
  assertClose(depHuge.expectedDamagePerHour, 80, 1e-9, 'dependent part capped at dependentDamageCap (3) x own');

  // same request, same floor, against an equal-size house bid with the same own damage
  const house = mkBid({ agentId: 'house-1', kind: 'house', requestKW: 400, minSafeKW: 0, criticality: 0.25, urgency: 0.2, expectedDamagePerHour: 20 });
  const a = clear(300, [own, house]);
  const b = clear(300, [dep30, house]);
  assert(b.priority['water-1'].score > a.priority['water-1'].score, `dependency-weighted score ${b.priority['water-1'].score} must exceed own-only ${a.priority['water-1'].score}`);
  assert(b.grants['water-1'] > a.grants['water-1'], `dependency-weighted grant must rise: ${a.grants['water-1']} -> ${b.grants['water-1']}`);
});

// ───────────────────────────── run ─────────────────────────────

let passed = 0;
const failed: string[] = [];
for (const c of cases) {
  try {
    c.fn();
    passed++;
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failed.push(c.name);
    const msg = err instanceof AssertionError ? err.message : err instanceof Error ? err.stack ?? err.message : String(err);
    console.log(`FAIL  ${c.name}\n        ${msg}`);
  }
}
console.log(`\nnegotiation-tests: ${passed}/${cases.length} passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
if (failed.length) process.exit(1);
