/**
 * App wiring: Layer 1 simulation → 3D view → HUD.
 * Layers 2 (negotiation) and 3 (safety) plug in later via engine.setPolicy / engine.setValidator.
 *
 * URL params: ?seed=1337  ?scenario=earthquake  ?t=120 (fast-forward sim minutes)  ?play=1
 */
import './ui/styles.css';
import { SimEngine } from './sim/engine';
import { WorldView } from './render/world';
import { Hud } from './ui/hud';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 1337);

const engine = new SimEngine({ seed });
const world = new WorldView(document.getElementById('world')!);

world.build(engine.snapshot);
world.sync(engine.snapshot);
engine.on('tick', (s) => world.sync(s));
engine.on('reset', (s) => {
  world.build(s);
  world.sync(s);
});

const hud = new Hud(document.getElementById('hud')!, engine, world);

const scenario = params.get('scenario');
if (scenario) engine.loadScenario(scenario);
const ff = Number(params.get('t') ?? 0);
for (let i = 0; i < ff; i++) engine.step();
if (params.get('play') === '1') engine.play();
// verification helpers: ?focus=hospital-0 (or a kind: ?focus=water)  ?select=1  ?layers=water,grid  ?nolayers=power
//                       ?disaster=earthquake&col=28&row=24
world.ready.then(() => {
  for (const l of (params.get('layers') ?? '').split(',').filter(Boolean)) hud.setLayer(l as any, true);
  for (const l of (params.get('nolayers') ?? '').split(',').filter(Boolean)) hud.setLayer(l as any, false);
  let focusId = params.get('focus');
  if (focusId && !engine.snapshot.buildings[focusId])
    focusId = Object.values(engine.snapshot.buildings).find((b) => b.kind === focusId)?.id ?? null;
  if (focusId) {
    world.focus(focusId);
    if (params.get('select') === '1') hud.select(focusId);
  }
});
const dis = params.get('disaster');
if (dis)
  engine.trigger(dis as any, {
    col: Number(params.get('col') ?? 28),
    row: Number(params.get('row') ?? 24),
    intensity: 0.8,
    radius: 7,
  });

let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  engine.update(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// handy in devtools
Object.assign(window, { engine, world });
