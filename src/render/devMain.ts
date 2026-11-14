/**
 * Render test page. /render-test.html
 *   ?t=<sim minutes to fast-forward>   ?disaster=earthquake|flood|cyclone|fire   ?cam=city|close|top|low|edge|horizon|meadow|far
 *   ?focus=<buildingId or kind>        ?grid=1 ?labels=0 ?flow=0   ?fixture=1 (force the fixture engine)
 *   ?focus=prosumer[&kind=house|school][&variant=n]   the first prosumer building matching (solar check)
 *   ?neg=1   real SimEngine on the compound scenario with NegotiationPolicy + SafetyValidator, fast-forwarded
 *            to t=300 (?t= overrides) and paused (?play=1 runs it). Negotiation overlay:
 *            ?stage=N&progress=p shows the latest replay at that stage (no stage = live mode). When the policy
 *            has recorded no replays yet, a replay is synthesised from the island's consumers (dev stand-in).
 *   keys: G grid, F flow, L labels, 1-5 trigger earthquake/flood/cyclone/fire/grid-fault at a random spot
 */
import { WorldView } from './world';
import { FixtureEngine } from './devFixture';
import type { ConsumerKind, DisasterKind, DisasterParams, NegotiationReplay, ReplayStage, RoundBid, SimSnapshot } from '../core/types';
import { CELL, cellCenter } from '../core/constants';
import { SimEngine } from '../sim/engine';
import { NegotiationPolicy } from '../negotiation/policy';
import { SafetyValidator } from '../safety/validator';

interface Engine {
  snapshot: SimSnapshot;
  update(dt: number): void;
  step(): void;
  trigger(kind: DisasterKind, params: DisasterParams): unknown;
  on?(k: string, fn: (p: any) => void): () => void;
  play?(): void;
  setSpeed?(s: number): void;
  reset?(seed?: number): void;
}

const q = new URLSearchParams(location.search);
const hud = document.getElementById('hud')!;
const neg = q.get('neg') === '1';

async function makeEngine(): Promise<{ engine: Engine; real: boolean }> {
  if (neg) {
    const e = new SimEngine({ seed: 1337, policy: new NegotiationPolicy({ provider: null }), validator: new SafetyValidator() });
    e.loadScenario('compound');
    return { engine: e as unknown as Engine, real: true };
  }
  if (!q.get('fixture')) {
    const mods = import.meta.glob('../sim/engine.ts');
    const loader = mods['../sim/engine.ts'];
    if (loader) {
      try {
        const m: any = await loader();
        const e = new m.SimEngine({ seed: Number(q.get('seed') ?? 7) });
        return { engine: e as Engine, real: true };
      } catch (err) {
        console.warn('real engine failed, using fixture', err);
      }
    }
  }
  return { engine: new FixtureEngine(Number(q.get('seed') ?? 7)) as unknown as Engine, real: false };
}

/**
 * Dev-only replay stand-in: the island with the largest shortfall, its top 14 consumers by demand,
 * proportional grants with min-safe floors, one counter-offer, one contract and one safety correction.
 */
function synthReplay(s: SimSnapshot): NegotiationReplay | null {
  const isl = (s.islands ?? [])
    .filter((i) => i.consumerIds.length > 0)
    .sort((a, b) => b.demandKW - b.supplyKW - (a.demandKW - a.supplyKW))[0];
  if (!isl) return null;
  const ids = isl.consumerIds
    .filter((id) => s.agents[id] && s.buildings[id])
    .sort((a, b) => s.agents[b].demandKW - s.agents[a].demandKW)
    .slice(0, 14);
  if (ids.length < 2) return null;
  const total = ids.reduce((acc, id) => acc + s.agents[id].demandKW, 0);
  const minSafe = ids.reduce((acc, id) => acc + s.agents[id].minSafeKW, 0);
  const share = total > 0 ? Math.min(1, isl.supplyKW / total) : 1;
  const prov: Record<string, number> = {};
  const fin: Record<string, number> = {};
  for (const id of ids) {
    const a = s.agents[id];
    prov[id] = Math.min(a.demandKW, Math.max(a.minSafeKW, a.demandKW * share * 0.8));
    fin[id] = Math.min(a.demandKW, Math.max(a.minSafeKW, a.demandKW * share));
  }
  const bids: RoundBid[] = ids.map((id) => {
    const a = s.agents[id];
    const b = s.buildings[id];
    return {
      agentId: id,
      name: b.name,
      kind: b.kind as ConsumerKind,
      mode: 'active',
      requestKW: a.demandKW,
      originalRequestKW: a.demandKW,
      minSafeKW: a.minSafeKW,
      concededKW: 0,
      tokensOffered: 0,
      score: a.urgency,
      stance: 'CRITICAL_HOLD',
      argument: `${b.name} needs ${Math.round(a.demandKW)} kW`,
      offer: '',
    };
  });
  const conc = ids
    .filter((id) => fin[id] < s.agents[id].demandKW - 1)
    .slice(0, 6)
    .map((id) => ({ agentId: id, kw: s.agents[id].demandKW - fin[id], stance: 'PARTIAL_CONCESSION' as const, text: 'Can shed part of its load' }));
  const giver = ids[ids.length - 1];
  const receiver = ids[0];
  const stages: ReplayStage[] = [
    { kind: 'perceive', round: 0, title: 'Perceive', caption: 'Each agent reads its telemetry and asks its model how urgent its case is.' },
    { kind: 'bid', round: 1, title: 'Round 1 — bids', caption: 'Every agent bids its full need to the island clearing hub.', bids },
    { kind: 'clear', round: 1, title: 'Provisional clearing', caption: 'The hub hands out a first, cautious share of supply.', grants: prov },
    {
      kind: 'notice',
      round: 1,
      title: 'Shortfall notice',
      caption: 'Each agent is told how much it would get if nobody moved.',
      notices: ids.map((id) => ({ agentId: id, projectedKW: prov[id], requestKW: s.agents[id].demandKW })),
    },
    { kind: 'counter', round: 2, title: 'Round 2 — counter-offers', caption: 'Some agents offer to shed flexible load in return for a fair share.', concessions: conc },
    {
      kind: 'contract',
      round: 2,
      title: 'Forward contracts',
      caption: 'A flexible site lends power now for power back later.',
      contracts: [{ id: 'c1', giverId: giver, receiverId: receiver, nowKW: 40, laterKW: 60 }],
    },
    { kind: 'final', round: 2, title: 'Final clearing', caption: 'Final grants come from supply, minimum-safe floors and the contracts.', grants: fin },
    {
      kind: 'safety',
      round: 2,
      title: 'Safety check',
      caption: 'The safety layer checks every grant against the grid and the minimum-safe rule.',
      grants: fin,
      corrections: [{ agentId: ids[1], proposedKW: fin[ids[1]] + 30, finalKW: fin[ids[1]], rule: 'min-safe', reason: 'dev stand-in correction' }],
    },
    { kind: 'commit', round: 2, title: 'Committed', caption: 'Grants are committed to the grid for this minute.', grants: fin },
  ];
  const short = Math.max(0, total - isl.supplyKW);
  return {
    id: `synth:${s.tMin}:${isl.id}`,
    tMin: s.tMin,
    islandId: isl.id,
    supplyKW: isl.supplyKW,
    totalRequestKW: total,
    totalMinSafeKW: minSafe,
    deficitKW: short,
    regime: 'shortage',
    microgrid: isl.microgrid,
    prosumerKW: isl.prosumerKW,
    participants: ids.map((id) => ({ agentId: id, name: s.buildings[id].name, kind: s.buildings[id].kind as ConsumerKind, buildingIds: [id] })),
    stages,
    headline: `Island ${isl.id} is ${Math.round(short)} kW short: ${ids.length} agents negotiate`,
  };
}

async function main() {
  const { engine, real } = await makeEngine();
  const world = new WorldView(document.getElementById('app')!, { preserveDrawingBuffer: true });
  (window as any).world = world;
  (window as any).engine = engine;
  world.build(engine.snapshot);
  if (real) {
    engine.on?.('reset', (s: SimSnapshot) => world.build(s));
    engine.setSpeed?.(Number(q.get('speed') ?? 10));
    if (q.get('play') === '1' || (q.get('play') !== '0' && !neg)) engine.play?.();
  }
  const randomSpot = () => ({ col: 6 + Math.floor(Math.random() * 36), row: 6 + Math.floor(Math.random() * 36) });
  const fire = (kind: DisasterKind, params: DisasterParams = {}) => {
    const p = { ...randomSpot(), intensity: 0.8, ...params };
    engine.trigger(kind, p);
    world.sync(engine.snapshot);
    const c = cellCenter(p.col!, p.row!);
    world.lookAt(c.x, c.z, 380);
  };
  const kinds: DisasterKind[] = ['earthquake', 'flood', 'cyclone', 'fire', 'grid_fault'];

  // deterministic fast-forward
  const ff = Number(q.get('t') ?? (neg ? 300 : 0));
  const disaster = q.get('disaster') as DisasterKind | null;
  const dcol = Number(q.get('col') ?? 22);
  const drow = Number(q.get('row') ?? 22);
  // ?live=1: sync once the city is built, advance 30 sim-min so the policy records a new replay (live playback)
  const liveQ = q.get("live") === "1";
  for (let i = 0; i < (liveQ ? ff - 30 : ff); i++) engine.step();
  world.sync(engine.snapshot);
  if (liveQ) {
    await world.ready;
    world.sync(engine.snapshot);
    for (let i = 0; i < 30; i++) engine.step();
    world.sync(engine.snapshot);
  }
  if (disaster) {
    setTimeout(() => {
      engine.trigger(disaster, { col: dcol, row: drow, intensity: Number(q.get('i') ?? 0.9), radius: Number(q.get('r') ?? 7), ...(disaster === 'grid_fault' ? { targetId: Object.values(engine.snapshot.buildings).find((b) => b.kind === 'generator')!.id } : {}) });
      world.sync(engine.snapshot);
    }, Number(q.get('delay') ?? 1500));
  }

  const cam = q.get('cam') ?? 'city';
  const snap = engine.snapshot;
  const pickBuilding = (key: string | null) => {
    if (!key) return undefined;
    // focus=prosumer[&kind=house|school][&variant=n]: first building with a prosumer install
    if (key === 'prosumer') return Object.values(snap.buildings).find((b) => b.prosumer && (!q.get('kind') || b.kind === q.get('kind')) && (!q.get('variant') || b.variant === Number(q.get('variant'))));
    return snap.buildings[key] ?? Object.values(snap.buildings).find((b) => b.kind === key);
  };
  const fb = pickBuilding(q.get('focus'));
  const info = fb ? world.buildingInfo?.get(fb.id) : undefined;
  if (cam === 'top') world.setView({ azimuth: 0, elevation: 69, distance: 760 });
  else if (cam === 'low') world.setView({ azimuth: 30, elevation: 28, distance: 520 });
  // landscape checks: board edge seam, far horizon, meadow at ground level, a lane leaving the city
  else if (cam === 'edge') world.setView({ azimuth: 45, elevation: 24, distance: 420, target: { x: 270, z: 270 } });
  else if (cam === 'horizon') world.setView({ azimuth: 200, elevation: 16, distance: 1100, target: { x: 0, z: 0 } });
  else if (cam === 'meadow') world.setView({ azimuth: 10, elevation: 16, distance: 140, target: { x: 40, z: 300 } });
  else if (cam === 'far') world.setView({ azimuth: 45, elevation: 34, distance: 1150, target: { x: 0, z: 0 } });
  else if (cam === 'close' || info) {
    // the building's world position: model info when built, else from its cells (the build is deferred)
    const c0 = fb ? cellCenter(fb.col, fb.row) : null;
    const x = info?.cx ?? (c0 ? c0.x + ((fb!.w - 1) * CELL) / 2 : Number(q.get('x') ?? 0));
    const z = info?.cz ?? (c0 ? c0.z + ((fb!.d - 1) * CELL) / 2 : Number(q.get('z') ?? 0));
    world.setView({
      azimuth: Number(q.get('az') ?? 35),
      elevation: Number(q.get('el') ?? 38),
      distance: Number(q.get('dist') ?? 130),
      target: { x, z },
    });
  } else if (q.get('dist')) {
    world.setView({ azimuth: Number(q.get('az') ?? 45), elevation: Number(q.get('el') ?? 50), distance: Number(q.get('dist')), target: { x: Number(q.get('x') ?? 0), z: Number(q.get('z') ?? 0) } });
  }
  if (q.get('grid')) world.setLayer('grid', true);
  for (const l of (q.get('layers') ?? '').split(',').filter(Boolean)) world.setLayer(l as any, true);
  if (q.get('layers')?.includes('water') && q.get('power') === '0') world.setLayer('power', false);
  if (q.get('labels') === '0') world.setLayer('labels', false);
  if (q.get('flow') === '0') world.setLayer('flow', false);
  if (q.get('negotiation') === '0') world.setLayer('negotiation', false);
  if (fb) world.select(fb.id);

  // negotiation overlay check: the policy's replay when recorded, otherwise the synthesised stand-in
  const stageQ = q.get('stage');
  const progressQ = Number(q.get('progress') ?? q.get('p') ?? 0.5);
  let synth: { tMin: number; rep: NegotiationReplay | null } | null = null;
  const pickReplay = (): NegotiationReplay | null => {
    const reps = engine.snapshot.negotiation?.replays ?? [];
    if (reps.length) return reps[reps.length - 1];
    if (!synth || synth.tMin !== engine.snapshot.tMin) synth = { tMin: engine.snapshot.tMin, rep: synthReplay(engine.snapshot) };
    return synth.rep;
  };
  const stageLabel = () => {
    const r = pickReplay();
    return r ? r.stages.map((x, k) => k + ":" + x.kind).join(" ") : "no replay";
  };
  const applyReplay = () => {
    if (stageQ === null) return;
    world.showReplay(pickReplay(), Number(stageQ), progressQ);
  };
  applyReplay();

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const on = (name: 'grid' | 'flow' | 'labels' | 'water') => {
      const st = ((window as any)._layers ??= { grid: !!q.get('grid'), flow: q.get('flow') !== '0', labels: q.get('labels') !== '0', water: !!q.get('layers')?.includes('water') });
      st[name] = !st[name];
      world.setLayer(name, st[name]);
    };
    if (k === 'g') on('grid');
    else if (k === 'f') on('flow');
    else if (k === 'l') on('labels');
    else if (k === 'w') on('water');
    else if (k === 'n') {
      const w = world as any;
      w._negOn = !(w._negOn ?? true);
      world.setLayer('negotiation', w._negOn);
    } else if (k >= '1' && k <= '5') {
      const kind = kinds[Number(k) - 1];
      fire(kind, kind === 'grid_fault' ? { targetId: Object.values(engine.snapshot.buildings).find((b) => b.kind === 'generator')!.id } : {});
    }
  });
  world.on('select', (id) => console.log('select', id));
  world.on('cellPick', (c) => console.log('cellPick', c));

  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    engine.update((now - last) / 1000);
    last = now;
    world.sync(engine.snapshot);
    applyReplay();
    const st = world.stats;
    const reps = engine.snapshot.negotiation?.replays?.length ?? 0;
    hud.textContent = `${real ? 'SimEngine' : 'fixture'}  t=${engine.snapshot.tMin}min  hour ${st.hour.toFixed(1)}  calls ${st.calls}  tris ${(st.triangles / 1000).toFixed(0)}k  fps~${st.fps.toFixed(0)} fade ${JSON.stringify(st.fade)} pipes ${st.pipes} solar ${JSON.stringify(st.solar)} replays ${reps} overlay ${JSON.stringify(st.overlay)}
${stageLabel()}`;
  }, 250);
  if (!real) (engine as any).speed = Number(q.get('speed') ?? 0.0001);
}

main();
