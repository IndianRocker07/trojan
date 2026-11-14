/**
 * Layer 3 (safety) tests: SafetyValidator unit + integration + prosumer-microgrid properties.
 * Run: npx tsx scripts/safety-tests.ts
 * Self-contained harness (no test framework installed). Exit code 1 on any failure.
 *
 * Every simulation run covers the full scenario (SCENARIO_MINUTES = 24 h from 10:00, docs/MICROGRID.md).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCENARIO_MINUTES } from '../src/core/constants';
import type { AllocationRequest, SimSnapshot, UtilityAgentState, ValidationContext } from '../src/core/types';
import { NegotiationPolicy } from '../src/negotiation';
import { FuzzPolicy, SafetyValidator, checkInvariants } from '../src/safety';
import { SCENARIOS, SimEngine } from '../src/sim';

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

const CRITICAL = 0.8;
const CRIT_SATISFACTION_MIN = 0.99;
/** docs/MICROGRID.md: the validator budget per call (mean, ms). */
const VALIDATE_BUDGET_MS = 2;
const FUZZ_SEEDS: Record<string, number> = { 'quiet-night': 42, 'monsoon-cyclone': 43, earthquake: 44, compound: 45 };
const EPS_KW = 1e-6;

function mkReq(id: string, demandKW: number, minSafeKW: number, o: Partial<AllocationRequest> = {}): AllocationRequest {
  return {
    buildingId: id,
    kind: 'house',
    demandKW,
    minSafeKW,
    criticality: 0.25,
    urgency: 0.1,
    expectedDamagePerHour: 1,
    tokens: 0,
    telemetry: {},
    ...o,
  };
}

/** Prosumer self-supply of this minute (set by the engine at finalize; 0 for non-prosumers). */
const selfOf = (a: SimSnapshot['agents'][string]): number => Math.max(0, a.der?.selfSupplyKW ?? 0);
const backupKW = (a: SimSnapshot['agents'][string]): number => (a.backup.remainingKWh > 0 ? Math.max(0, a.backup.maxKW) : 0);

/**
 * The requests the engine hands to the policy for an island: connected consumers with a positive NET demand
 * (own demand minus self-supply); minSafe and chargeKW are net as well (engine.allocate()).
 */
function requestsOf(snap: SimSnapshot, consumerIds: string[]): AllocationRequest[] {
  const out: AllocationRequest[] = [];
  for (const id of [...consumerIds].sort()) {
    const a = snap.agents[id];
    if (!a || !a.connected || !(a.demandKW > 1e-9)) continue;
    const self = selfOf(a);
    const net = Math.max(0, a.demandKW - self);
    if (!(net > 1e-9)) continue;
    const r: AllocationRequest = {
      buildingId: id,
      kind: a.kind,
      demandKW: net,
      minSafeKW: Math.min(net, Math.max(0, a.minSafeKW - self)),
      criticality: a.criticality,
      urgency: a.urgency,
      expectedDamagePerHour: a.expectedDamagePerHour,
      tokens: a.tokens,
      telemetry: a.telemetry,
    };
    if (a.der) r.selfSupplyKW = self;
    if (a.storage) r.chargeKW = Math.min(net, a.storage.chargeKW);
    if (a.dependentDamagePerHour !== undefined) r.dependentDamagePerHour = a.dependentDamagePerHour;
    out.push(r);
  }
  return out;
}

interface CritTally {
  minutes: number; // critical agent-minutes counted (physically feasible island-minutes)
  satisfied: number;
  skipped: number; // critical agent-minutes on island-minutes that are physically infeasible
}

/**
 * Critical min-safe satisfaction for the current minute. Gross floor F = min(minSafeKW, demandKW); served gross =
 * allocation + self-supply + backup. An island-minute is physically possible when the net floors that the island's
 * supply must cover (F − self-supply − backup) sum to at most the island's P_total (MICROGRID §3).
 */
function tallyCritical(e: SimEngine, tally: CritTally): void {
  const s = e.snapshot;
  const infos = e.getIslandInfos();
  e.getIslands().forEach((isl, k) => {
    const crit = isl.consumerIds.filter((id) => {
      const a = s.agents[id];
      return !!a && a.connected && a.demandKW > 0 && a.criticality >= CRITICAL;
    });
    if (crit.length === 0) return;
    let need = 0;
    for (const id of crit) {
      const a = s.agents[id];
      const floor = Math.min(a.minSafeKW, a.demandKW);
      need += Math.max(0, floor - selfOf(a) - backupKW(a));
    }
    if (need > infos[k].supplyKW + EPS_KW) {
      tally.skipped += crit.length;
      return;
    }
    for (const id of crit) {
      const a = s.agents[id];
      const floor = Math.min(a.minSafeKW, a.demandKW);
      tally.minutes++;
      if (a.allocatedKW + selfOf(a) + backupKW(a) >= floor - EPS_KW) tally.satisfied++;
    }
  });
}

/** Layer-2 + Layer-3 stack used by the production configuration. */
const negotiationStack = (): { policy: NegotiationPolicy; validator: SafetyValidator } => ({
  policy: new NegotiationPolicy({ provider: null }),
  validator: new SafetyValidator(),
});

interface Failures {
  a: string[]; // zero cross-island allocation
  b: string[]; // supply bounds
  c: string[]; // microgrid Σ allocation ≤ prosumerKW
  d: string[]; // prosumer export / curtailment
}

interface NegStats {
  overload: number;
  crit: CritTally;
  fail: Failures;
  microMinutes: number; // island-minutes with a microgrid island
  maxIslands: number;
  validateMsMean: number;
}

const negCache = new Map<string, NegStats>();

/** Per-minute checks (a)–(d) on the committed state of every island. Pushes at most 20 messages per rule. */
function checkMicrogridStep(e: SimEngine, fail: Failures, stats: { micro: number }): void {
  const s = e.snapshot;
  const infos = e.getIslandInfos();
  const push = (arr: string[], msg: string): void => {
    if (arr.length < 20) arr.push(msg);
  };
  // (a) owners: each consumer may be listed in exactly one island
  const owners = new Map<string, number>();
  for (const info of infos) for (const id of info.consumerIds) owners.set(id, (owners.get(id) ?? 0) + 1);
  for (const [id, n] of owners) if (n > 1) push(fail.a, `t=${s.tMin}: ${id} listed in ${n} islands`);
  for (const id of Object.keys(s.agents)) {
    const a = s.agents[id];
    if (!(a.allocatedKW > 0)) continue;
    const n = owners.get(id) ?? 0;
    if (n !== 1) push(fail.a, `t=${s.tMin}: ${id} allocated ${a.allocatedKW.toFixed(1)} kW but listed in ${n} islands`);
  }
  for (const info of infos) {
    let sum = 0;
    for (const id of info.consumerIds) sum += Math.max(0, s.agents[id]?.allocatedKW ?? 0);
    // (b) Σ allocation ≤ P_total and P_total ≤ min(utility DER + prosumer export, line limit)
    if (sum > info.supplyKW + EPS_KW) push(fail.b, `t=${s.tMin} island ${info.id}: Σ allocation ${sum.toFixed(2)} > supply ${info.supplyKW.toFixed(2)}`);
    const bound = Math.min(info.utilityDerKW + info.prosumerKW, info.lineLimitKW) + EPS_KW;
    if (info.supplyKW > bound) push(fail.b, `t=${s.tMin} island ${info.id}: supply ${info.supplyKW.toFixed(2)} > min(DER+prosumer, line limit) ${bound.toFixed(2)}`);
    if (info.microgrid) {
      stats.micro++;
      // (c) a microgrid island lives on its prosumer exports alone
      if (sum > info.prosumerKW + EPS_KW) push(fail.c, `t=${s.tMin} island ${info.id}: microgrid Σ allocation ${sum.toFixed(2)} > prosumerKW ${info.prosumerKW.toFixed(2)}`);
    }
  }
  // (d) prosumers: exports never exceed what they offered; curtailment never negative
  for (const id of Object.keys(s.agents)) {
    const d = s.agents[id].der;
    if (!d) continue;
    if (d.exportedKW > d.offeredKW + EPS_KW) push(fail.d, `t=${s.tMin} ${id}: exported ${d.exportedKW.toFixed(3)} > offered ${d.offeredKW.toFixed(3)}`);
    if (d.curtailedKW < -EPS_KW) push(fail.d, `t=${s.tMin} ${id}: curtailed ${d.curtailedKW.toFixed(3)} < 0`);
    if (d.exportedKW < -EPS_KW) push(fail.d, `t=${s.tMin} ${id}: exported ${d.exportedKW.toFixed(3)} < 0`);
  }
}

/** One Negotiation+Safety run per scenario (full 24 h), shared by the microgrid, FR-3.8 and critical-satisfaction tests. */
function runNegotiationScenario(id: string): NegStats {
  const hit = negCache.get(id);
  if (hit) return hit;
  const { policy, validator } = negotiationStack();
  const e = new SimEngine({ seed: 1337, policy, validator });
  e.loadScenario(id);
  const stats: NegStats = {
    overload: 0,
    crit: { minutes: 0, satisfied: 0, skipped: 0 },
    fail: { a: [], b: [], c: [], d: [] },
    microMinutes: 0,
    maxIslands: 0,
    validateMsMean: 0,
  };
  e.on('log', (l) => {
    if (l.msg.startsWith('Overload')) stats.overload++;
  });
  const micro = { micro: 0 };
  for (let t = 0; t < SCENARIO_MINUTES; t++) {
    e.step();
    tallyCritical(e, stats.crit);
    checkMicrogridStep(e, stats.fail, micro);
    stats.maxIslands = Math.max(stats.maxIslands, e.getIslandInfos().length);
  }
  stats.microMinutes = micro.micro;
  stats.validateMsMean = validator.meanValidateMs();
  negCache.set(id, stats);
  return stats;
}

interface FuzzResult {
  steps: number;
  islandChecks: number;
  failures: string[];
  violationsCommitted: number;
}

/** FR-3.10: adversarial policy, validated every step; invariants checked on the committed allocation per island. */
function runFuzz(id: string, seed: number): FuzzResult {
  const validator = new SafetyValidator();
  const e = new SimEngine({ seed: 1337, policy: new FuzzPolicy(seed), validator });
  e.loadScenario(id);
  const res: FuzzResult = { steps: 0, islandChecks: 0, failures: [], violationsCommitted: 0 };
  for (let t = 0; t < SCENARIO_MINUTES; t++) {
    e.step();
    res.steps++;
    const s = e.snapshot;
    const infos = e.getIslandInfos();
    e.getIslands().forEach((isl, k) => {
      const requests = requestsOf(s, isl.consumerIds);
      if (requests.length === 0) return;
      const allocation: Record<string, number> = {};
      for (const r of requests) allocation[r.buildingId] = s.agents[r.buildingId].allocatedKW;
      const ctx: ValidationContext = {
        tMin: s.tMin,
        islandId: isl.id,
        generatorIds: isl.generatorIds,
        substationIds: isl.substationIds,
        consumerIds: isl.consumerIds,
        info: infos[k],
        snapshot: s,
      };
      res.islandChecks++;
      const fails = checkInvariants(infos[k].supplyKW, requests, allocation, ctx);
      for (const f of fails) res.failures.push(`${id} t=${s.tMin} island ${isl.id}: ${f}`);
    });
  }
  res.violationsCommitted = e.snapshot.safety?.violationsCommitted ?? -1;
  return res;
}

function trace(id: string, policyFactory: () => { policy: NegotiationPolicy; validator: SafetyValidator }): { atT300: string; damageT300: number; end: string; damageEnd: number } {
  const { policy, validator } = policyFactory();
  const e = new SimEngine({ seed: 1337, policy, validator });
  e.loadScenario(id);
  const allocString = (): string => {
    const s = e.snapshot;
    return Object.keys(s.agents)
      .sort()
      .map((k) => `${k}=${s.agents[k].allocatedKW}`)
      .join(';');
  };
  let atT300 = '';
  let damageT300 = NaN;
  for (let t = 0; t < SCENARIO_MINUTES; t++) {
    e.step();
    if (e.snapshot.tMin === 300) {
      atT300 = allocString();
      damageT300 = e.snapshot.metrics.cumulativeDamage;
    }
  }
  return { atT300, damageT300, end: allocString(), damageEnd: e.snapshot.metrics.cumulativeDamage };
}

// ───────────────────────────── (u1) sanitize ─────────────────────────────

test('(u1) sanitize: NaN, ±Infinity and negative grants become 0; over-demand grants clamp to demand; unknown ids dropped', () => {
  const requests = [mkReq('nan', 100, 0), mkReq('inf', 200, 0), mkReq('neg', 300, 0), mkReq('over', 400, 0), mkReq('ok', 100, 0)];
  const proposal: Record<string, number> = { nan: NaN, inf: Infinity, neg: -5, over: 9999, ok: 60, ghost: 50 };
  const v = new SafetyValidator();
  const res = v.validate(10000, requests, proposal);
  assertClose(res.allocation.nan, 0, 0, 'NaN grant');
  assertClose(res.allocation.inf, 0, 0, '+Infinity grant');
  assertClose(res.allocation.neg, 0, 0, 'negative grant');
  assertClose(res.allocation.over, 400, 1e-9, 'over-demand grant clamped to demand');
  assertClose(res.allocation.ok, 60, 1e-9, 'valid grant untouched');
  assert(!('ghost' in res.allocation), 'unknown id must not appear in the allocation');
  for (const r of requests) {
    const g = res.allocation[r.buildingId];
    assert(Number.isFinite(g) && g >= 0 && g <= r.demandKW + 1e-9, `${r.buildingId} out of [0, demand]: ${g}`);
  }
  assert(res.violations.some((x) => x.includes('sanitize')), `sanitize must be reported; violations=${JSON.stringify(res.violations)}`);
});

// ───────────────────────────── (u2) over-supply ─────────────────────────────

test('(u2) over-supply proposal is scaled to <= supply, cutting above-min-safe power first', () => {
  const requests = [
    mkReq('crit-a', 600, 200, { criticality: 0.9, kind: 'hospital' }),
    mkReq('low-b', 600, 100, { criticality: 0.3 }),
    mkReq('low-c', 400, 0, { criticality: 0.3 }),
  ];
  const proposal = { 'crit-a': 600, 'low-b': 600, 'low-c': 400 }; // 1600 kW against 1000 kW supply
  const v = new SafetyValidator();
  const res = v.validate(1000, requests, proposal);
  const total = Object.values(res.allocation).reduce((a, x) => a + x, 0);
  assertLe(total, 1000 + 1e-6, 'Σ allocation must not exceed supply');
  assertGe(total, 1000 - 1e-3, 'Σ allocation should use the available supply (scaled, not zeroed)');
  for (const r of requests) {
    const g = res.allocation[r.buildingId];
    assertLe(g, r.demandKW + 1e-9, `${r.buildingId} above demand`);
    assertGe(g, r.minSafeKW - 1e-6, `${r.buildingId} fell below its min-safe floor during scaling`);
  }
  assert(res.violations.some((x) => x.includes('supply')), `supply correction must be reported; violations=${JSON.stringify(res.violations)}`);
});

// ───────────────────────────── (u3) supply = min(argument, P_total) ─────────────────────────────

test('(u3) the supply bound is min(argument, ctx.info.supplyKW): an over-stated argument cannot overspend P_total', () => {
  const e = new SimEngine({ seed: 1337, policy: new NegotiationPolicy({ provider: null }), validator: new SafetyValidator() });
  e.loadScenario('quiet-night');
  for (let i = 0; i < 5; i++) e.step();
  const s = e.snapshot;
  const infos = e.getIslandInfos();
  const k = infos.findIndex((info) => requestsOf(s, info.consumerIds).length >= 2 && info.supplyKW > 1);
  assert(k >= 0, 'no island with two requests and supply to test against');
  const info = infos[k];
  const requests = requestsOf(s, info.consumerIds);
  const pTotal = info.supplyKW * 0.5;
  const proposal: Record<string, number> = {};
  for (const r of requests) proposal[r.buildingId] = r.demandKW;
  const ctx: ValidationContext = { tMin: s.tMin, islandId: info.id, generatorIds: info.generatorIds, substationIds: info.substationIds, consumerIds: info.consumerIds, info: { ...info, supplyKW: pTotal }, snapshot: s };
  const res = new SafetyValidator().validate(info.supplyKW, requests, proposal, ctx);
  const total = Object.values(res.allocation).reduce((a, x) => a + x, 0);
  assertLe(total, pTotal + 1e-6, 'Σ allocation must respect ctx.info.supplyKW even when the argument is larger');
  assert(res.violations.some((x) => x.includes('supply')), 'the supply mismatch / trim must be reported');
});

// ───────────────────────────── (u4) starvation counters survive island id changes ─────────────────────────────

test('(u4) starvation counter is keyed by agent id: it keeps counting across island id changes', () => {
  const e = new SimEngine({ seed: 1337, policy: new NegotiationPolicy({ provider: null }), validator: new SafetyValidator() });
  e.loadScenario('quiet-night');
  for (let i = 0; i < 3; i++) e.step();
  const s = e.snapshot;
  const info = e.getIslandInfos().find((x) => requestsOf(s, x.consumerIds).some((r) => r.minSafeKW > 0));
  assert(info, 'an island with a floor-bearing request is required');
  const target = requestsOf(s, info.consumerIds).find((r) => r.minSafeKW > 0)!;
  const v = new SafetyValidator();
  const N = 40;
  const ids = [3, 9, 4, 11, 5, 17];
  for (let t = 1; t <= N; t++) {
    // the agent is starved every minute (no supply at all) while its island id changes every minute
    const ctx: ValidationContext = { tMin: s.tMin + t, islandId: ids[t % ids.length], generatorIds: [], substationIds: [], consumerIds: [target.buildingId], info: { ...info, microgrid: true, supplyKW: 0, consumerIds: [target.buildingId] }, snapshot: s };
    v.validate(0, [target], { [target.buildingId]: 0 }, ctx);
  }
  const snap = v.endStep({ ...s, tMin: s.tMin + N });
  const row = snap.starving.find((x) => x.agentId === target.buildingId);
  assert(row, `${target.buildingId} must be listed as starving`);
  assertGe(row.minutes, N, `starvation minutes must accumulate across island ids (got ${row.minutes}, expected ${N})`);
});

// ───────────────────────────── (a) zero cross-island allocation ─────────────────────────────

for (const sc of SCENARIOS) {
  test(`(a) zero cross-island allocation [${sc.id}]: every allocated consumer is listed in exactly one island, every step`, () => {
    const st = runNegotiationScenario(sc.id);
    assert(st.fail.a.length === 0, `${st.fail.a.length} violation(s); first: ${st.fail.a.slice(0, 3).join(' | ')}`);
  });
}

// ───────────────────────────── (b) supply bounds ─────────────────────────────

for (const sc of SCENARIOS) {
  test(`(b) Σ allocation <= island supply and supply <= min(DER + prosumer, line limit) [${sc.id}], every island every step`, () => {
    const st = runNegotiationScenario(sc.id);
    assert(st.fail.b.length === 0, `${st.fail.b.length} violation(s); first: ${st.fail.b.slice(0, 3).join(' | ')}`);
  });
}

// ───────────────────────────── (c) microgrid islands live on prosumer exports ─────────────────────────────

for (const sc of SCENARIOS) {
  test(`(c) microgrid islands: Σ allocation <= prosumerKW [${sc.id}]`, () => {
    const st = runNegotiationScenario(sc.id);
    assert(st.fail.c.length === 0, `${st.fail.c.length} violation(s); first: ${st.fail.c.slice(0, 3).join(' | ')}`);
  });
}

// ───────────────────────────── (d) prosumer exports and curtailment ─────────────────────────────

for (const sc of SCENARIOS) {
  test(`(d) prosumer exportedKW <= offeredKW and curtailedKW >= 0 [${sc.id}], every step`, () => {
    const st = runNegotiationScenario(sc.id);
    assert(st.fail.d.length === 0, `${st.fail.d.length} violation(s); first: ${st.fail.d.slice(0, 3).join(' | ')}`);
  });
}

// ───────────────────────────── (e) FR-3.10 fuzz ─────────────────────────────

for (const sc of SCENARIOS) {
  test(`(e) FR-3.10 fuzz [${sc.id}]: ${SCENARIO_MINUTES} adversarial steps, invariants hold on every island every step`, () => {
    const r = runFuzz(sc.id, FUZZ_SEEDS[sc.id] ?? 1);
    assert(r.steps === SCENARIO_MINUTES, `expected ${SCENARIO_MINUTES} steps, ran ${r.steps}`);
    assert(r.islandChecks > 0, 'no island checks were executed');
    if (r.failures.length) throw new AssertionError(`${r.failures.length} invariant failure(s); first: ${r.failures.slice(0, 5).join(' | ')}`);
    assert(r.violationsCommitted === 0, `snapshot.safety.violationsCommitted = ${r.violationsCommitted}, expected 0`);
  });
}

// ───────────────────────────── FR-3.8 no overloads ─────────────────────────────

for (const sc of SCENARIOS) {
  test(`(FR-3.8) [${sc.id}]: Negotiation + Safety produces zero Overload trips`, () => {
    const st = runNegotiationScenario(sc.id);
    assert(st.overload === 0, `${st.overload} Overload log event(s)`);
  });
}

// ───────────────────────────── (f) critical min-safe satisfaction ─────────────────────────────

for (const sc of SCENARIOS) {
  test(`(f) critical min-safe satisfaction >= 99% when physically possible [${sc.id}] (Negotiation + Safety)`, () => {
    const st = runNegotiationScenario(sc.id);
    assert(st.crit.minutes > 0, 'no physically feasible critical agent-minutes were measured');
    const pct = (100 * st.crit.satisfied) / st.crit.minutes;
    assertGe(pct, CRIT_SATISFACTION_MIN * 100, `critical satisfaction ${pct.toFixed(2)}% (${st.crit.satisfied}/${st.crit.minutes}, ${st.crit.skipped} infeasible skipped)`);
  });
}

// ───────────────────────────── per-validate budget ─────────────────────────────

test(`(budget) SafetyValidator.validate averages <= ${VALIDATE_BUDGET_MS} ms per call in the production stack [${SCENARIOS[0].id}]`, () => {
  const st = runNegotiationScenario(SCENARIOS[0].id);
  assertLe(st.validateMsMean, VALIDATE_BUDGET_MS, `mean validate() ${st.validateMsMean.toFixed(3)} ms`);
});

// ───────────────────────────── determinism ─────────────────────────────

test('(det) determinism: two identical earthquake runs match on cumulativeDamage and allocations at t=300 and at the end', () => {
  const stack = negotiationStack;
  const a = trace('earthquake', stack);
  const b = trace('earthquake', stack);
  assert(a.atT300.length > 0, 'no snapshot captured at t=300');
  assert(Object.is(a.damageT300, b.damageT300), `cumulativeDamage at t=300 differs: ${a.damageT300} vs ${b.damageT300}`);
  assert(a.atT300 === b.atT300, 'allocations at t=300 differ between identical runs');
  assert(Object.is(a.damageEnd, b.damageEnd), `final cumulativeDamage differs: ${a.damageEnd} vs ${b.damageEnd}`);
  assert(a.end === b.end, 'final allocations differ between identical runs');
});

// ───────────────────────────── (g) independence ─────────────────────────────

test('(g) independence: no file in src/safety imports anything whose path contains "negotiation"', () => {
  const dir = fileURLToPath(new URL('../src/safety/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert(files.length >= 4, `expected the safety sources, found ${files.length}`);
  const specs = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  const offenders: string[] = [];
  let imports = 0;
  for (const f of files) {
    const src = readFileSync(dir + f, 'utf8');
    for (const m of src.matchAll(specs)) {
      imports++;
      if (/negotiation/i.test(m[1])) offenders.push(`${f} -> ${m[1]}`);
    }
  }
  assert(imports > 0, 'no import statements were scanned');
  assert(offenders.length === 0, `safety imports negotiation: ${offenders.join(', ')}`);
});

// ───────────────────────────── run ─────────────────────────────

let passed = 0;
const failed: string[] = [];
for (const c of cases) {
  const t0 = Date.now();
  try {
    c.fn();
    passed++;
    console.log(`PASS  ${c.name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    failed.push(c.name);
    const msg = err instanceof AssertionError ? err.message : err instanceof Error ? err.stack ?? err.message : String(err);
    console.log(`FAIL  ${c.name}\n        ${msg}`);
  }
}
console.log(`\nsafety-tests: ${passed}/${cases.length} passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
if (failed.length) process.exit(1);
