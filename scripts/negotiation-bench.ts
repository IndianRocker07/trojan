/**
 * Layer 1–3 benchmark: allocation policy × validator, over the full 24 h scenario (SCENARIO_MINUTES from 10:00).
 * Run: npx tsx scripts/negotiation-bench.ts [--out <file.json>]
 *
 * Combos: Baseline+BaselineValidator, Baseline+Safety, Negotiation+Safety (NegotiationPolicy, provider null),
 * Oracle+Safety (scripts/lib/oraclePolicy.ts, evaluation-only upper bound). Seeds 1337, 7, 42 × 4 scenarios.
 *
 * Metrics per run
 *  - damage: cumulativeDamage at the end; Δ% vs Baseline+BaselineValidator and vs Baseline+Safety (same scenario, seed).
 *  - gap closed = (Baseline+Safety − Negotiation+Safety) / (Baseline+Safety − Oracle+Safety), per scenario and seed.
 *  - critMinSafe: critical consumers (criticality ≥ 0.8, connected, demand > 0). Gross floor F = min(minSafeKW, demandKW);
 *    served = allocatedKW + self-supply + backup. Counted only on island-minutes where the net floors (F − self − backup)
 *    fit the island's P_total (physically possible).
 *  - Jain's index over per-agent mean served fraction (min(1, (allocatedKW + self-supply) / demandKW), demand > 0,
 *    not destroyed): non-house agents individually, houses as one group.
 *  - overloads: "Overload" trips; violations: snapshot.safety.violationsCommitted (must be 0).
 *  - prosumer MWh / curtailed MWh: Σ over minutes of exported / curtailed kW ÷ 60 ÷ 1000.
 *  - microgrid isl-min: Σ over minutes of the number of microgrid islands.
 *  - ms/step: wall-clock per engine step (includes the policy and the validator).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCENARIO_MINUTES } from '../src/core/constants';
import type { AllocationPolicy, ConstraintValidator, SimSnapshot } from '../src/core/types';
import { NegotiationPolicy } from '../src/negotiation';
import { SafetyValidator } from '../src/safety';
import { BaselinePolicy, BaselineValidator, SCENARIOS, SimEngine } from '../src/sim';
import { DamageOraclePolicy } from './lib/oraclePolicy';

const SEEDS = [1337, 7, 42];
const CRITICAL = 0.8;
const EPS = 1e-6;

const COMBO_BB = 'Baseline+BaselineValidator';
const COMBO_BS = 'Baseline+Safety';
const COMBO_NS = 'Negotiation+Safety';
const COMBO_OS = 'Oracle+Safety';

// ───────────────────────────── combos ─────────────────────────────

interface Combo {
  name: string;
  make: () => { policy: AllocationPolicy; validator: ConstraintValidator };
}

const COMBOS: Combo[] = [
  { name: COMBO_BB, make: () => ({ policy: new BaselinePolicy(), validator: new BaselineValidator() }) },
  { name: COMBO_BS, make: () => ({ policy: new BaselinePolicy(), validator: new SafetyValidator() }) },
  { name: COMBO_NS, make: () => ({ policy: new NegotiationPolicy({ provider: null }), validator: new SafetyValidator() }) },
  { name: COMBO_OS, make: () => ({ policy: new DamageOraclePolicy(), validator: new SafetyValidator() }) },
];

// ───────────────────────────── metrics ─────────────────────────────

interface RunResult {
  scenario: string;
  seed: number;
  combo: string;
  damage: number;
  damageVsBB: number | null;
  damageVsBS: number | null;
  gapClosed: number | null;
  critPct: number | null;
  critMinutes: number;
  jainNonHouse: number | null;
  jainHouse: number | null;
  overloads: number;
  violations: number;
  prosumerMWh: number;
  curtailedMWh: number;
  microIslandMinutes: number;
  msPerStep: number;
  validateMs: number | null;
}

const selfOf = (a: SimSnapshot['agents'][string]): number => Math.max(0, a.der?.selfSupplyKW ?? 0);
const backupKW = (a: SimSnapshot['agents'][string]): number => (a.backup.remainingKWh > 0 ? Math.max(0, a.backup.maxKW) : 0);

interface CritTally {
  minutes: number;
  satisfied: number;
}

/** Critical min-safe tally for the current minute (island-minutes whose net floors exceed P_total are excluded). */
function tallyCritical(e: SimEngine, tally: CritTally): void {
  const s = e.snapshot;
  const infos = e.getIslandInfos();
  e.getIslands().forEach((isl, k) => {
    const ids = isl.consumerIds.filter((id) => {
      const a = s.agents[id];
      return !!a && a.connected && a.demandKW > 0 && a.criticality >= CRITICAL;
    });
    if (ids.length === 0) return;
    let need = 0;
    for (const id of ids) {
      const a = s.agents[id];
      need += Math.max(0, Math.min(a.minSafeKW, a.demandKW) - selfOf(a) - backupKW(a));
    }
    if (need > infos[k].supplyKW + EPS) return;
    for (const id of ids) {
      const a = s.agents[id];
      const floor = Math.min(a.minSafeKW, a.demandKW);
      tally.minutes++;
      if (a.allocatedKW + selfOf(a) + backupKW(a) >= floor - EPS) tally.satisfied++;
    }
  });
}

/** Jain's fairness index (Σx)² / (n·Σx²); 1 when every x is 0 (nobody is treated differently). */
function jain(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  let s2 = 0;
  for (const x of xs) {
    s += x;
    s2 += x * x;
  }
  if (s2 === 0) return 1;
  return (s * s) / (xs.length * s2);
}

interface ServedAcc {
  sum: number;
  n: number;
}

interface RawRun {
  scenario: string;
  seed: number;
  combo: string;
  damage: number;
  critPct: number | null;
  critMinutes: number;
  jainNonHouse: number | null;
  jainHouse: number | null;
  overloads: number;
  violations: number;
  prosumerKWmin: number;
  curtailedKWmin: number;
  microIslandMinutes: number;
  msPerStep: number;
  validateMs: number | null;
}

function runOne(scenario: string, seed: number, combo: Combo): RawRun {
  const { policy, validator } = combo.make();
  const e = new SimEngine({ seed, policy, validator });
  e.loadScenario(scenario);
  e.reset(seed);
  let overloads = 0;
  e.on('log', (l) => {
    if (l.msg.startsWith('Overload')) overloads++;
  });

  const served = new Map<string, ServedAcc>();
  const crit: CritTally = { minutes: 0, satisfied: 0 };
  let stepMs = 0;
  let prosumerKWmin = 0;
  let curtailedKWmin = 0;
  let microIslandMinutes = 0;
  for (let t = 0; t < SCENARIO_MINUTES; t++) {
    const t0 = performance.now();
    e.step();
    stepMs += performance.now() - t0;
    tallyCritical(e, crit);
    const s = e.snapshot;
    prosumerKWmin += s.metrics.prosumerKW ?? 0;
    curtailedKWmin += s.metrics.curtailedKW ?? 0;
    microIslandMinutes += s.metrics.microgridCount ?? 0;
    for (const id of Object.keys(s.agents)) {
      const a = s.agents[id];
      const b = s.buildings[id];
      if (!(a.demandKW > 0) || b?.status === 'destroyed') continue;
      const acc = served.get(id) ?? { sum: 0, n: 0 };
      acc.sum += Math.min(1, Math.max(0, a.allocatedKW + selfOf(a)) / a.demandKW);
      acc.n++;
      served.set(id, acc);
    }
  }

  const nonHouse: number[] = [];
  const houses: number[] = [];
  for (const [id, acc] of served) {
    if (acc.n === 0) continue;
    const mean = acc.sum / acc.n;
    if (e.snapshot.agents[id].kind === 'house') houses.push(mean);
    else nonHouse.push(mean);
  }

  return {
    scenario,
    seed,
    combo: combo.name,
    damage: e.snapshot.metrics.cumulativeDamage,
    critPct: crit.minutes > 0 ? (100 * crit.satisfied) / crit.minutes : null,
    critMinutes: crit.minutes,
    jainNonHouse: jain(nonHouse),
    jainHouse: jain(houses),
    overloads,
    violations: e.snapshot.safety?.violationsCommitted ?? 0,
    prosumerKWmin,
    curtailedKWmin,
    microIslandMinutes,
    msPerStep: stepMs / SCENARIO_MINUTES,
    validateMs: validator instanceof SafetyValidator ? validator.meanValidateMs() : null,
  };
}

// ───────────────────────────── run all ─────────────────────────────

const toMWh = (kwMin: number): number => kwMin / 60 / 1000;
const results: RunResult[] = [];
const gapRows: { scenario: string; seed: number; gapClosed: number | null }[] = [];
const started = performance.now();
for (const sc of SCENARIOS) {
  for (const seed of SEEDS) {
    const raw: RawRun[] = COMBOS.map((c) => runOne(sc.id, seed, c));
    const by = (name: string): RawRun => raw.find((r) => r.combo === name)!;
    const bb = by(COMBO_BB).damage;
    const bs = by(COMBO_BS).damage;
    const ns = by(COMBO_NS).damage;
    const os = by(COMBO_OS).damage;
    // a baseline below 1 damage unit is effectively zero (floating-point residue); % change is then undefined
    const pctOf = (x: number, base: number): number | null => (base >= 1 ? (100 * (x - base)) / base : null);
    const headroom = bs - os;
    const gap = headroom > 1 && bs >= 1 ? (bs - ns) / headroom : null;
    gapRows.push({ scenario: sc.id, seed, gapClosed: gap });
    for (const r of raw) {
      results.push({
        scenario: r.scenario,
        seed: r.seed,
        combo: r.combo,
        damage: r.damage,
        damageVsBB: pctOf(r.damage, bb),
        damageVsBS: pctOf(r.damage, bs),
        gapClosed: r.combo === COMBO_NS ? gap : null,
        critPct: r.critPct,
        critMinutes: r.critMinutes,
        jainNonHouse: r.jainNonHouse,
        jainHouse: r.jainHouse,
        overloads: r.overloads,
        violations: r.violations,
        prosumerMWh: toMWh(r.prosumerKWmin),
        curtailedMWh: toMWh(r.curtailedKWmin),
        microIslandMinutes: r.microIslandMinutes,
        msPerStep: r.msPerStep,
        validateMs: r.validateMs,
      });
    }
    console.error(`done ${sc.id} seed ${seed} (${((performance.now() - started) / 1000).toFixed(0)} s elapsed)`);
  }
}

// ───────────────────────────── report ─────────────────────────────

const f = (x: number | null, digits: number, suffix = ''): string => (x === null || !Number.isFinite(x) ? 'n/a' : `${x.toFixed(digits)}${suffix}`);
const pct = (x: number | null): string => (x === null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
const mean = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
};

console.log(`\nTrojan benchmark — ${SCENARIO_MINUTES} sim minutes per run (24 h from 10:00); seeds ${SEEDS.join(', ')}; 4 scenarios\n`);
const HEAD = [
  ['scenario', 17],
  ['seed', 5],
  ['combo', 28],
  ['damage', 10],
  ['ΔBB', 8],
  ['ΔBS', 8],
  ['gap', 7],
  ['critMinSafe', 12],
  ['Jain(nh)', 9],
  ['Jain(h)', 9],
  ['overload', 9],
  ['viol', 5],
  ['prosMWh', 9],
  ['curtMWh', 9],
  ['microIslMin', 12],
  ['ms/step', 8],
  ['val ms', 7],
] as const;
console.log(HEAD.map(([h, w]) => h.padStart(w)).join(' '));
for (const r of results) {
  const cells = [
    r.scenario.padEnd(17),
    String(r.seed).padStart(5),
    r.combo.padEnd(28),
    f(r.damage, 0).padStart(10),
    pct(r.damageVsBB).padStart(8),
    pct(r.damageVsBS).padStart(8),
    f(r.gapClosed === null ? null : 100 * r.gapClosed, 0, '%').padStart(7),
    f(r.critPct, 2, '%').padStart(12),
    f(r.jainNonHouse, 3).padStart(9),
    f(r.jainHouse, 3).padStart(9),
    String(r.overloads).padStart(9),
    String(r.violations).padStart(5),
    f(r.prosumerMWh, 2).padStart(9),
    f(r.curtailedMWh, 2).padStart(9),
    String(r.microIslandMinutes).padStart(12),
    f(r.msPerStep, 2).padStart(8),
    f(r.validateMs, 2).padStart(7),
  ];
  console.log(cells.join(' '));
}

console.log('\nMean across 4 scenarios × 3 seeds (gap closed = mean of the per-scenario/seed values):\n');
const SUM_HEAD = [
  ['combo', 28],
  ['damage', 10],
  ['ΔBB', 8],
  ['ΔBS', 8],
  ['gap', 7],
  ['critMinSafe', 12],
  ['Jain(nh)', 9],
  ['Jain(h)', 9],
  ['overload', 9],
  ['viol', 5],
  ['prosMWh', 9],
  ['curtMWh', 9],
  ['microIslMin', 12],
  ['ms/step', 8],
  ['val ms', 7],
] as const;
console.log(SUM_HEAD.map(([h, w]) => h.padStart(w)).join(' '));
const summary = COMBOS.map((c) => {
  const rs = results.filter((r) => r.combo === c.name);
  return {
    combo: c.name,
    damage: mean(rs.map((r) => r.damage)),
    damageVsBB: mean(rs.map((r) => r.damageVsBB)),
    damageVsBS: mean(rs.map((r) => r.damageVsBS)),
    gapClosed: c.name === COMBO_NS ? mean(gapRows.map((g) => g.gapClosed)) : null,
    critPct: mean(rs.map((r) => r.critPct)),
    jainNonHouse: mean(rs.map((r) => r.jainNonHouse)),
    jainHouse: mean(rs.map((r) => r.jainHouse)),
    overloads: mean(rs.map((r) => r.overloads)),
    violations: mean(rs.map((r) => r.violations)),
    prosumerMWh: mean(rs.map((r) => r.prosumerMWh)),
    curtailedMWh: mean(rs.map((r) => r.curtailedMWh)),
    microIslandMinutes: mean(rs.map((r) => r.microIslandMinutes)),
    msPerStep: mean(rs.map((r) => r.msPerStep)),
    validateMs: mean(rs.map((r) => r.validateMs)),
  };
});
for (const s of summary) {
  console.log(
    [
      s.combo.padEnd(28),
      f(s.damage, 0).padStart(10),
      pct(s.damageVsBB).padStart(8),
      pct(s.damageVsBS).padStart(8),
      f(s.gapClosed === null ? null : 100 * s.gapClosed, 0, '%').padStart(7),
      f(s.critPct, 2, '%').padStart(12),
      f(s.jainNonHouse, 3).padStart(9),
      f(s.jainHouse, 3).padStart(9),
      f(s.overloads, 1).padStart(9),
      f(s.violations, 1).padStart(5),
      f(s.prosumerMWh, 2).padStart(9),
      f(s.curtailedMWh, 2).padStart(9),
      f(s.microIslandMinutes, 0).padStart(12),
      f(s.msPerStep, 2).padStart(8),
      f(s.validateMs, 2).padStart(7),
    ].join(' '),
  );
}
console.log(`\nTotal wall time ${((performance.now() - started) / 1000).toFixed(0)} s. Jain = 1 means perfectly even served fractions.`);

const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  const file = resolve(process.argv[outIdx + 1]);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ seeds: SEEDS, steps: SCENARIO_MINUTES, runs: results, gapClosed: gapRows, summary }, null, 2));
  console.log(`JSON written to ${file}`);
}
