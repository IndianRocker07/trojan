import { Hud } from './hud';
import { MockEngine, MockWorld } from './devMock';

const q = new URLSearchParams(location.search);
const engine = new MockEngine();
const world = new MockWorld();
const hud = new Hud(document.getElementById('ui')!, engine, world);

// Pre-simulate so charts, logs and sparklines have content.
const pre = Number(q.get('pre') ?? 300);
engine.trigger('grid_fault', { targetId: 'generator-0' });
for (let i = 0; i < pre; i++) {
  if (i === 90) engine.trigger('flood', { intensity: 0.6 });
  if (i === 150) engine.trigger('earthquake', { col: 22, row: 18, intensity: 0.8, radius: 6 });
  if (i === 180) engine.snapshot.generators['generator-0'].status = 'running';
  engine.step();
}
engine.setSpeed(Number(q.get('speed') ?? 10));
if (q.get('play') !== '0') engine.play();

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  engine.update((now - last) / 1000);
  last = now;
}, 50);

const sel = q.get('select');
if (sel && sel !== 'none') hud.select(sel);
const tab = q.get('tab');
if (tab === 'agents') (document.querySelectorAll('.tabs button')[1] as HTMLButtonElement)?.click();
const sheet = q.get('sheet');
if (sheet) hud.openSheet(sheet as 'disasters' | 'inspect' | 'stats');
if (q.get('pick')) (document.querySelectorAll('.dr-row .btn')[0] as HTMLButtonElement)?.click();
// expose for console poking
(window as unknown as Record<string, unknown>).hud = hud;
(window as unknown as Record<string, unknown>).engine = engine;
(window as unknown as Record<string, unknown>).world = world;
