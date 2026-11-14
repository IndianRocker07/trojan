/**
 * Render test page. /render-test.html
 *   ?t=<sim minutes to fast-forward>   ?disaster=earthquake|flood|cyclone|fire   ?cam=city|close|top|low
 *   ?focus=<buildingId or kind>        ?grid=1 ?labels=0 ?flow=0   ?fixture=1 (force the fixture engine)
 *   keys: G grid, F flow, L labels, 1-5 trigger earthquake/flood/cyclone/fire/grid-fault at a random spot
 */
import { WorldView } from './world';
import { FixtureEngine } from './devFixture';
import type { DisasterKind, DisasterParams, SimSnapshot } from '../core/types';
import { cellCenter } from '../core/constants';

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

async function makeEngine(): Promise<{ engine: Engine; real: boolean }> {
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

async function main() {
  const { engine, real } = await makeEngine();
  const world = new WorldView(document.getElementById('app')!, { preserveDrawingBuffer: true });
  (window as any).world = world;
  (window as any).engine = engine;
  world.build(engine.snapshot);
  if (real) {
    engine.on?.('reset', (s: SimSnapshot) => world.build(s));
    engine.setSpeed?.(Number(q.get('speed') ?? 10));
    if (q.get('play') !== '0') engine.play?.();
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
  const ff = Number(q.get('t') ?? 0);
  const disaster = q.get('disaster') as DisasterKind | null;
  const dcol = Number(q.get('col') ?? 22);
  const drow = Number(q.get('row') ?? 22);
  for (let i = 0; i < ff; i++) engine.step();
  world.sync(engine.snapshot);
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
    return snap.buildings[key] ?? Object.values(snap.buildings).find((b) => b.kind === key);
  };
  const fb = pickBuilding(q.get('focus'));
  const info = fb ? world.buildingInfo?.get(fb.id) : undefined;
  if (cam === 'top') world.setView({ azimuth: 0, elevation: 69, distance: 760 });
  else if (cam === 'low') world.setView({ azimuth: 30, elevation: 28, distance: 520 });
  else if (cam === 'close' || info) {
    const x = info?.cx ?? Number(q.get('x') ?? 0);
    const z = info?.cz ?? Number(q.get('z') ?? 0);
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
  if (fb) world.select(fb.id);

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
    else if (k >= '1' && k <= '5') {
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
    const st = world.stats;
    hud.textContent = `${real ? 'SimEngine' : 'fixture'}  t=${engine.snapshot.tMin}min  hour ${st.hour.toFixed(1)}  calls ${st.calls}  tris ${(st.triangles / 1000).toFixed(0)}k  fps~${st.fps.toFixed(0)} fade ${JSON.stringify(st.fade)} pipes ${st.pipes}`;
  }, 250);
  if (!real) (engine as any).speed = Number(q.get('speed') ?? 0.0001);
}

main();
