/**
 * Headless smoke test of the simulation layer: npx --yes tsx scripts/sim-smoke.ts
 * Checks every step of every scenario (24 h): no NaN; per island (incl. prosumer microgrids) Σ allocation <= P_total;
 * zero cross-island allocation; prosumer export <= offered; every edge's downstream export <= 0.97 x capacity; determinism.
 */
import { SCENARIO_MINUTES, CELL } from '../src/core/constants';
import { SimEngine, SCENARIOS } from '../src/sim';

let failures = 0;
const fail = (msg: string) => {
  failures++;
  if (failures < 40) console.error('FAIL:', msg);
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
  exportMWh: number;
  curtailMWh: number;
  maxIslands: number;
  microMin: number;
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
  let exportKWmin = 0;
  let curtailKWmin = 0;
  let maxIslands = 0;
  let microMin = 0;
  const totalCap = Object.values(e.snapshot.generators).reduce((a, g) => a + g.capacityKW, 0);
  for (let i = 0; i < SCENARIO_MINUTES; i++) {
    e.step();
    const s = e.snapshot;
    const m = s.metrics;
    if (checks) {
      const nan =
        hasNaN(m, 'metrics') ?? hasNaN(s.agents, 'agents') ?? hasNaN(s.generators, 'generators') ?? hasNaN(s.water.pipes, 'water.pipes') ?? hasNaN(s.islands, 'islands');
      if (nan) fail(`${id} t=${s.tMin}: NaN at ${nan}`);
      const edgeNaN = Object.values(s.network.edges).find((x) => !Number.isFinite(x.flowKW));
      if (edgeNaN) fail(`${id} t=${s.tMin}: NaN flow on ${edgeNaN.id}`);
      let deficit = false;
      const seen = new Set<string>();
      const ids = new Set<number>();
      const infos = e.getIslandInfos();
      if (s.islands !== infos) fail(`${id} t=${s.tMin}: snapshot.islands is not getIslandInfos()`);
      e.getIslands().forEach((isl, k) => {
        const info = infos[k];
        if (info.id !== isl.id) fail(`${id} t=${s.tMin}: island info/id mismatch`);
        if (ids.has(info.id)) fail(`${id} t=${s.tMin}: duplicate island id ${info.id}`);
        ids.add(info.id);
        let al = 0;
        let dem = 0;
        for (const c of isl.consumerIds) {
          if (seen.has(c)) fail(`${id} t=${s.tMin}: consumer ${c} in two islands`);
          seen.add(c);
          al += s.agents[c].allocatedKW;
          dem += Math.max(0, s.agents[c].demandKW - (s.agents[c].der?.selfSupplyKW ?? 0));
        }
        const tag = `island ${info.id}${info.microgrid ? ' (microgrid)' : ''}`;
        if (al > info.supplyKW + 1e-6) fail(`${id} t=${s.tMin}: ${tag} allocated ${al} > P_total ${info.supplyKW}`);
        let sup = 0;
        for (const g of isl.generatorIds) sup += s.generators[g].outputKW;
        if (Math.abs(info.utilityDerKW - sup) > 1e-6) fail(`${id} t=${s.tMin}: ${tag} utilityDerKW mismatch`);
        if (info.supplyKW > info.utilityDerKW + info.prosumerKW + 1e-6 || info.supplyKW > info.lineLimitKW + 1e-6)
          fail(`${id} t=${s.tMin}: ${tag} P_total above min(DER + prosumer, line limit)`);
        if (info.microgrid !== (isl.generatorIds.length === 0)) fail(`${id} t=${s.tMin}: microgrid flag wrong`);
        let exp = 0;
        for (const pid of info.prosumerIds) {
          const d = s.agents[pid].der!;
          if (d.exportedKW > d.offeredKW + 1e-9) fail(`${id} t=${s.tMin}: ${pid} export ${d.exportedKW} > offered ${d.offeredKW}`);
          if (d.exportedKW < -1e-9 || d.curtailedKW < -1e-9) fail(`${id} t=${s.tMin}: ${pid} negative export/curtail`);
          exp += d.exportedKW;
        }
        if (exp > info.prosumerKW + 1e-6) fail(`${id} t=${s.tMin}: ${tag} exports ${exp} > prosumerKW ${info.prosumerKW}`);
        if (info.microgrid && al > exp + 1e-6) fail(`${id} t=${s.tMin}: ${tag} allocated ${al} > prosumer exports ${exp}`);
        if (dem > info.supplyKW + 1) deficit = true;
      });
      for (const a of Object.values(s.agents)) if (!seen.has(a.buildingId) && a.allocatedKW > 1e-9) fail(`${id} t=${s.tMin}: ${a.buildingId} allocated outside any island`);
      // curtailment keeps every edge's downstream export <= capacity x 0.97 (live stretch of each feeder chain)
      const down = new Map<string, number>();
      for (const f of s.network.feeders) {
        const d = s.agents[f.consumerId]?.der;
        if (!d || d.exportedKW <= 0) continue;
        for (let k = f.edgeIds.length - 1; k >= 0; k--) {
          const ed = s.network.edges[f.edgeIds[k]];
          if (ed.status !== 'ok') break;
          down.set(ed.id, (down.get(ed.id) ?? 0) + d.exportedKW);
        }
      }
      for (const [eid, kw] of down) if (kw > s.network.edges[eid].capacityKW * 0.97 + 1e-6) fail(`${id} t=${s.tMin}: edge ${eid} downstream export ${kw} > 0.97 x ${s.network.edges[eid].capacityKW}`);
      if (deficit) deficitMin++;
    }
    exportKWmin += m.prosumerKW ?? 0;
    curtailKWmin += m.curtailedKW ?? 0;
    maxIslands = Math.max(maxIslands, m.islandCount ?? 0);
    microMin += m.microgridCount ?? 0;
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
    if (maxIslands !== 1) fail(`quiet-night: expected 1 island, saw up to ${maxIslands}`);
  }
  if (checks && id !== 'quiet-night' && deficitMin === 0) fail(`${id}: no island ever had supply < demand`);
  if (checks && exportKWmin <= 0) fail(`${id}: prosumers never exported`);
  if (checks && id === 'earthquake' && microMin === 0) fail('earthquake: expected prosumer microgrid islands after the midday quake');
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
    exportMWh: exportKWmin / 60 / 1000,
    curtailMWh: curtailKWmin / 60 / 1000,
    maxIslands,
    microMin,
    final: JSON.stringify(m) + s.log.length + JSON.stringify(s.history.at(-1)) + JSON.stringify(s.islands),
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
  const pros = Object.values(s.buildings).filter((b) => b.prosumer);
  const kwp = pros.reduce((a, b) => a + b.prosumer!.solarKWp, 0);
  console.log('City 1337 counts:', JSON.stringify(counts));
  console.log(`Prosumers: ${pros.length} (${pros.filter((b) => b.prosumer!.kind === 'campus').length} campus) ${kwp.toFixed(0)} kWp rooftop+campus solar`);
  console.log(
    `Power: pylons=${nodes.filter((n) => n.kind === 'pylon').length} poles=${nodes.filter((n) => n.kind === 'pole').length} edges=${Object.keys(s.network.edges).length} feeders=${s.network.feeders.length}`,
  );
  console.log(`Generator capacity ${cap.toFixed(0)} kW vs evening-peak demand ${e.peakDemandKW.toFixed(0)} kW (${((100 * e.peakDemandKW) / cap).toFixed(1)}%)`);
  console.log(`Water: nodes=${Object.keys(s.water.nodes).length} pipes=${Object.keys(s.water.pipes).length}`);
}

console.log('\nscenario            peakMW  minServed%  damage    destroyed offline tripped  peak/cap  deficitMin  prosMWh  curtMWh  maxIsl  microMin  water');
for (const sc of SCENARIOS) {
  const a = run(sc.id, true);
  const b = run(sc.id, false);
  if (a.final !== b.final) fail(`${sc.id}: non-deterministic final state`);
  console.log(
    `${sc.id.padEnd(19)} ${(a.peakDemand / 1000).toFixed(2).padStart(6)} ${a.minServed.toFixed(1).padStart(10)} ${a.damage.toFixed(0).padStart(8)} ${String(a.destroyed).padStart(9)} ${String(a.offline).padStart(7)} ${String(a.tripped).padStart(7)} ${(a.maxSupplyUse * 100).toFixed(1).padStart(8)}% ${String(a.deficitMin).padStart(10)} ${a.exportMWh.toFixed(2).padStart(8)} ${a.curtailMWh.toFixed(2).padStart(8)} ${String(a.maxIslands).padStart(7)} ${String(a.microMin).padStart(9)}  ${a.water}`,
  );
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nOK: no NaN; Σ allocation <= P_total on every island (incl. microgrids) every step; zero cross-island allocation; export <= offered; edge export <= 0.97 x capacity; deterministic.',
);
