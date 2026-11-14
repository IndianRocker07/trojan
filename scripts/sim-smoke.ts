/** Headless smoke test of the simulation layer: npx --yes tsx scripts/sim-smoke.ts */
import { SCENARIO_MINUTES, CELL } from '../src/core/constants';
import { SimEngine, SCENARIOS } from '../src/sim';

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error('FAIL:', msg);
};

function hasNaN(o: unknown, path: string): string | null {
  if (typeof o === 'number') return Number.isFinite(o) ? null : path;
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const r = hasNaN(v, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

interface Summary {
  peakDemand: number;
  minServed: number;
  damage: number;
  destroyed: number;
  offline: number;
  tripped: number;
  maxSupplyUse: number;
  deficitMin: number;
  final: string;
  water: string;
}

function run(id: string, checks: boolean): Summary {
  const e = new SimEngine({ seed: 1337 });
  e.loadScenario(id);
  let tripped = 0;
  e.on('log', (l) => {
    if (l.msg.startsWith('Overload')) tripped++;
  });
  let peakDemand = 0;
  let minServed = 100;
  let maxUse = 0;
  let deficitMin = 0;
  let quietMinServed = 100;
  const totalCap = Object.values(e.snapshot.generators).reduce((a, g) => a + g.capacityKW, 0);
  for (let i = 0; i < SCENARIO_MINUTES; i++) {
    e.step();
    const s = e.snapshot;
    const m = s.metrics;
    if (checks) {
      const nan = hasNaN(m, 'metrics') ?? hasNaN(s.agents, 'agents') ?? hasNaN(s.generators, 'generators') ?? hasNaN(s.water.pipes, 'water.pipes');
      if (nan) fail(`${id} t=${s.tMin}: NaN at ${nan}`);
      const edgeNaN = Object.values(s.network.edges).find((x) => !Number.isFinite(x.flowKW));
      if (edgeNaN) fail(`${id} t=${s.tMin}: NaN flow on ${edgeNaN.id}`);
      let deficit = false;
      for (const isl of e.getIslands()) {
        let sup = 0;
        for (const g of isl.generatorIds) sup += s.generators[g].outputKW;
        let al = 0;
        for (const c of isl.consumerIds) al += s.agents[c].allocatedKW;
        if (al > sup + 1e-6) fail(`${id} t=${s.tMin}: island ${isl.id} allocated ${al} > supply ${sup}`);
        let dem = 0;
        for (const c of isl.consumerIds) dem += s.agents[c].demandKW;
        if (dem > sup + 1) deficit = true;
      }
      if (deficit) deficitMin++;
    }
    peakDemand = Math.max(peakDemand, m.demandKW);
    minServed = Math.min(minServed, m.servedPct);
    quietMinServed = Math.min(quietMinServed, m.servedPct);
    maxUse = Math.max(maxUse, m.demandKW / totalCap);
  }
  const s = e.snapshot;
  const m = s.metrics;
  if (checks && id === 'quiet-night') {
    if (tripped > 0) fail(`quiet-night: ${tripped} edge(s) tripped`);
    if (quietMinServed < 98) fail(`quiet-night: served ${quietMinServed.toFixed(1)}% < 98%`);
  }
  if (checks && id === 'compound' && tripped === 0) fail('compound: expected at least one overload trip');
  if (checks && id !== 'quiet-night' && deficitMin === 0) fail(`${id}: no island ever had supply < demand`);
  // water stats
  const pipes = Object.values(s.water.pipes);
  const mains = pipes.filter((p) => p.tier === 'main');
  const km = mains.reduce((a, p) => a + p.cells.length * CELL, 0) / 1000;
  const cons = Object.values(s.agents).filter((a) => a.telemetry.waterSupplyPct !== undefined);
  const withP = cons.filter((a) => a.telemetry.waterSupplyPct > 0).length;
  const broken = pipes.filter((p) => p.status === 'broken').length;
  const water = `pipes=${pipes.length} (broken ${broken}) mains=${km.toFixed(1)}km pressurised=${((100 * withP) / cons.length).toFixed(1)}%`;
  return {
    peakDemand,
    minServed,
    damage: m.cumulativeDamage,
    destroyed: m.cellsDestroyed,
    offline: m.buildingsOffline,
    tripped,
    maxSupplyUse: maxUse,
    deficitMin,
    final: JSON.stringify(m) + s.log.length + JSON.stringify(s.history.at(-1)),
    water,
  };
}

// city stats
{
  const e = new SimEngine({ seed: 1337 });
  const s = e.snapshot;
  const counts: Record<string, number> = {};
  for (const b of Object.values(s.buildings)) counts[b.kind] = (counts[b.kind] ?? 0) + 1;
  const nodes = Object.values(s.network.nodes);
  const cap = Object.values(s.generators).reduce((a, g) => a + g.capacityKW, 0);
  console.log('City 1337 counts:', JSON.stringify(counts));
  console.log(
    `Power: pylons=${nodes.filter((n) => n.kind === 'pylon').length} poles=${nodes.filter((n) => n.kind === 'pole').length} edges=${Object.keys(s.network.edges).length} feeders=${s.network.feeders.length}`,
  );
  console.log(`Generator capacity ${cap.toFixed(0)} kW vs evening-peak demand ${e.peakDemandKW.toFixed(0)} kW (${((100 * e.peakDemandKW) / cap).toFixed(1)}%)`);
  console.log(`Water: nodes=${Object.keys(s.water.nodes).length} pipes=${Object.keys(s.water.pipes).length}`);
}

console.log('\nscenario            peakMW  minServed%  damage    destroyed offline tripped  peak/cap  deficitMin  water');
for (const sc of SCENARIOS) {
  const a = run(sc.id, true);
  const b = run(sc.id, false);
  if (a.final !== b.final) fail(`${sc.id}: non-deterministic final state`);
  console.log(
    `${sc.id.padEnd(19)} ${(a.peakDemand / 1000).toFixed(2).padStart(6)} ${a.minServed.toFixed(1).padStart(10)} ${a.damage.toFixed(0).padStart(8)} ${String(a.destroyed).padStart(9)} ${String(a.offline).padStart(7)} ${String(a.tripped).padStart(7)} ${(a.maxSupplyUse * 100).toFixed(1).padStart(8)}% ${String(a.deficitMin).padStart(10)}  ${a.water}`,
  );
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nOK: no NaN, allocation <= supply on every island every step, deterministic.');
