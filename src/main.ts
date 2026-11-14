/**
 * App wiring: Layer 1 simulation → Layer 2 negotiation (policy) → Layer 3 safety (validator) → 3D view → HUD.
 *
 * URL params: ?seed=1337  ?scenario=earthquake  ?t=120 (fast-forward sim minutes)  ?play=1
 *             ?policy=baseline|negotiation (default negotiation)  ?safety=baseline|safety (default safety)
 *             ?jev=0 (heuristic perception only, no Jev calls)
 */
import './ui/styles.css';
import type { AllocationPolicy, ConstraintValidator } from './core/types';
import { SimEngine } from './sim/engine';
import { BaselinePolicy, BaselineValidator } from './sim/policy';
import { NegotiationPolicy } from './negotiation';
import { HttpJevProvider } from './negotiation/jevClient';
import { SafetyValidator } from './safety';
import { WorldView } from './render/world';
import { TheaterView } from './theater';
import { Hud } from './ui/hud';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 1337);

// Jev perception runs server-side behind the Vite middleware (/api/jev) so the API key never reaches the browser.
const jevProvider = params.get('jev') === '0' ? null : new HttpJevProvider('/api/jev');
const makePolicy = (id: string): AllocationPolicy =>
  id === 'baseline' ? new BaselinePolicy() : new NegotiationPolicy({ provider: jevProvider });
const makeValidator = (id: string): ConstraintValidator => (id === 'baseline' ? new BaselineValidator() : new SafetyValidator());
let policyId = params.get('policy') === 'baseline' ? 'baseline' : 'negotiation';
let validatorId = params.get('safety') === 'baseline' ? 'baseline' : 'safety';

const engine = new SimEngine({ seed, policy: makePolicy(policyId), validator: makeValidator(validatorId) });
const world = new WorldView(document.getElementById('world')!);

// Negotiation Theater: full-screen reference-style view (dotted glowing globe, bid arcs, light spikes).
const theater = new TheaterView(document.getElementById('world')!);

world.build(engine.snapshot);
world.sync(engine.snapshot);
theater.build(engine.snapshot);
engine.on('tick', (s) => {
  world.sync(s);
  theater.sync(s);
});
engine.on('reset', (s) => {
  world.build(s);
  world.sync(s);
  theater.build(s);
});

// Theater toggle used by the HUD: also hides the city's floating map labels while the globe is shown.
const theaterToggle = {
  setVisible(on: boolean) {
    theater.setVisible(on);
    document.body.classList.toggle('theater-on', on);
  },
  isVisible: () => theater.isVisible(),
};

const welcomeParam = params.get('welcome');
const hud = new Hud(document.getElementById('hud')!, engine, world, {
  // the replay stepper is the master clock for both renderers
  replayRenderers: [theater, world],
  theater: theaterToggle,
  welcome: welcomeParam === '1' ? 'always' : welcomeParam === '0' ? 'never' : 'auto',
  modes: {
    policies: [
      { id: 'baseline', label: 'Baseline' },
      { id: 'negotiation', label: 'Negotiation' },
    ],
    validators: [
      { id: 'baseline', label: 'Baseline' },
      { id: 'safety', label: 'Safety layer' },
    ],
    policy: policyId,
    validator: validatorId,
    onPolicy(id) {
      if (id === policyId) return;
      policyId = id;
      engine.setPolicy(makePolicy(id));
    },
    onValidator(id) {
      if (id === validatorId) return;
      validatorId = id;
      engine.setValidator(makeValidator(id));
    },
  },
});

theater.on('select', (id) => {
  if (id) hud.select(id);
});
if (params.get('theater') === '1') theaterToggle.setVisible(true);

const scenario = params.get('scenario');
if (scenario) engine.loadScenario(scenario);
const ff = Number(params.get('t') ?? 0);
for (let i = 0; i < ff; i++) engine.step();
if (params.get('play') === '1') engine.play();
// ?replay=latest (or a replay id) opens the stepper; ?stage=N freezes on that stage (demos & screenshots)
const replayParam = params.get('replay');
if (replayParam) {
  const reps = engine.snapshot.negotiation?.replays ?? [];
  const r = replayParam === 'latest' ? reps[reps.length - 1] : reps.find((x) => x.id === replayParam);
  const stage = params.get('stage');
  if (r) hud.openReplay(r.id, stage === null ? { autoplay: true } : { stage: Number(stage), progress: 0.7, autoplay: false });
}
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
Object.assign(window, { engine, world, theater, hud });
