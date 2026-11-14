import { Hud } from './hud';
import { MockEngine, MockWorld } from './devMock';
import type { NegotiationReplay, ReplayRenderer } from '../core/types';

const q = new URLSearchParams(location.search);
const engine = new MockEngine();
const world = new MockWorld();

// Fake ReplayRenderer: logs stage changes (console + window.__replayLog) and, with ?rlog=1, shows a live readout.
const rlogEl = q.get('rlog') ? Object.assign(document.createElement('pre'), { id: 'rlog' }) : null;
if (rlogEl) {
  rlogEl.style.cssText = 'position:fixed;left:6px;top:6px;z-index:90;margin:0;padding:4px 6px;background:#fff;border:2px solid #121310;font:12px/1.3 monospace;max-width:260px;white-space:pre-wrap';
  document.body.append(rlogEl);
}
const rlog: string[] = [];
let lastKey = '';
const fakeRenderer: ReplayRenderer = {
  showReplay(r: NegotiationReplay | null, stage: number, progress: number) {
    const key = r ? `${r.id}#${stage}` : 'null';
    if (key !== lastKey) {
      lastKey = key;
      const line = r ? `showReplay(${r.id}, stage ${stage} ${r.stages[stage]?.kind})` : 'showReplay(null)';
      rlog.push(line);
      if (rlog.length > 50) rlog.shift();
      console.info('[fake renderer]', line);
      (window as unknown as Record<string, unknown>).__replayLog = rlog;
    }
    if (rlogEl) rlogEl.textContent = r ? `renderer: ${r.id}
stage ${stage} (${r.stages[stage]?.kind})
progress ${progress.toFixed(2)}` : 'renderer: null';
  },
};

// Fake dark "theater" layer so panel legibility can be checked over a dark view.
const fake = document.createElement('div');
fake.style.cssText = 'position:fixed;inset:0;z-index:10;display:none;background-color:#0b1440;background-image:radial-gradient(#7c83ff 1.5px,transparent 1.6px);background-size:14px 14px';
document.body.append(fake);
const theater = {
  setVisible(on: boolean) {
    fake.style.display = on ? 'block' : 'none';
  },
  isVisible: () => fake.style.display === 'block',
};
if (q.get('theater') === '1') theater.setVisible(true);

const hud = new Hud(document.getElementById('ui')!, engine, world, {
  replayRenderers: [fakeRenderer],
  theater,
  welcome: q.get('welcome') === '1' ? 'always' : 'never',
  modes: {
    policies: [{ id: 'baseline', label: 'Baseline' }, { id: 'negotiation', label: 'Negotiation' }],
    validators: [{ id: 'baseline', label: 'Baseline' }, { id: 'safety', label: 'Safety layer' }],
    policy: q.get('policy') ?? 'negotiation',
    validator: q.get('safety') ?? 'safety',
    onPolicy: (id) => { engine.policy = id; engine.step(); },
    onValidator: (id) => { engine.validator = id; engine.step(); },
  },
});
engine.policy = q.get('policy') ?? 'negotiation';
engine.validator = q.get('safety') ?? 'safety';

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
if (tab === 'negotiation') (document.querySelectorAll('.tabs button')[2] as HTMLButtonElement)?.click();
if (tab === 'agents') (document.querySelectorAll('.tabs button')[1] as HTMLButtonElement)?.click();
const sheet = q.get('sheet');
if (sheet) hud.openSheet(sheet as 'disasters' | 'inspect' | 'stats');
if (q.get('pick')) (document.querySelectorAll('.dr-row .btn')[0] as HTMLButtonElement)?.click();
const feedOn = q.get('feed') === '1' || q.get('guided') === '1';
if (q.get('story') === '1') hud.setStoryMode(true);
if (feedOn) hud.openFeed();
if (q.get('guided') === '1') hud.startCoach();
if (q.get('coach') === '1') hud.startCoach();
const rp = q.get('replay');
if (rp != null) {
  const list = engine.snapshot.negotiation?.replays ?? [];
  const i = Number(rp);
  const r = list[i < 0 ? list.length + i : Math.min(i, list.length - 1)];
  if (r) hud.openReplay(r.id, { stage: Number(q.get('stage') ?? 0), progress: Number(q.get('progress') ?? 0), autoplay: q.get('autoplay') === '1', focus: q.get('focus') === '1' });
}
// expose for console poking
(window as unknown as Record<string, unknown>).hud = hud;
(window as unknown as Record<string, unknown>).engine = engine;
(window as unknown as Record<string, unknown>).world = world;
// review helpers: ?scroll=<css selector> scrolls it into view; ?expand=1 opens the 3rd history row
setTimeout(() => {
  const exp = q.get('expand');
  if (exp) (document.querySelectorAll('.hist-head')[Number(exp)] as HTMLButtonElement | undefined)?.click();
  const sc = q.get('scroll');
  const target = sc ? document.querySelector(sc) : null;
  for (let p = target?.parentElement; target && p && p !== document.body; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight + 4 && getComputedStyle(p).overflowY !== 'visible') p.scrollTop += target.getBoundingClientRect().top - p.getBoundingClientRect().top;
  }
}, 300);
