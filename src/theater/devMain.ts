/**
 * Dev page for the Negotiation Theater (theater.html).
 *   ?stage=N&progress=0.6  freeze on a stage (screenshots)
 *   ?live=1                ambient mode (engine keeps running, no replay selected)
 *   ?t=300                 sim minutes to pre-step (default 300)
 */
import { SimEngine } from '../sim';
import { NegotiationPolicy } from '../negotiation';
import { SafetyValidator } from '../safety';
import type { NegotiationReplay } from '../core/types';
import { TheaterView, synthReplay } from './index';

const q = new URLSearchParams(location.search);
const engine = new SimEngine({ policy: new NegotiationPolicy({ provider: null }), validator: new SafetyValidator() });
engine.loadScenario(q.get('scenario') ?? 'compound');
const T = Number(q.get('t') ?? 300);
for (let i = 0; i < T; i++) engine.step();
const s = engine.snapshot;

const theater = new TheaterView(document.getElementById('app')!);
theater.build(s);
theater.sync(s);
theater.setVisible(true);
theater.on('select', (id) => console.log('select', id));

const cap = document.getElementById('cap')!;
const stats = document.getElementById('stats')!;
const live = q.get('live') === '1';

const pickReplay = (): { r: NegotiationReplay | null; real: boolean } => {
  const rs = engine.snapshot.negotiation?.replays;
  if (rs && rs.length) return { r: rs[rs.length - 1], real: true };
  return { r: synthReplay(engine.snapshot), real: false };
};
let { r: replay, real } = pickReplay();

const stageQ = q.get('stage');
const progQ = q.get('progress');
const frozen = stageQ !== null;
const STAGE_SEC = 1.6;
let stage = frozen ? Number(stageQ) : 0;
let progress = progQ !== null ? Number(progQ) : 0;

function caption(): void {
  if (live || !replay) {
    cap.innerHTML = `<b>Live</b> · t = ${engine.snapshot.tMin} min · ${real ? 'recorded replays' : 'synthetic replay'} animate every few seconds`;
    return;
  }
  const st = replay.stages[Math.max(0, Math.min(replay.stages.length - 1, stage))];
  cap.innerHTML = `<b>${st.title}</b> · ${stage + 1}/${replay.stages.length}${real ? '' : ' · synthetic'}<div class="c">${st.caption}</div>`;
}

if (live) {
  engine.setSpeed(Number(q.get('speed') ?? 4));
  engine.play();
  engine.on('tick', (snap) => theater.sync(snap));
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    engine.update((now - last) / 1000);
    last = now;
    caption();
  }, 100);
  theater.showReplay(null, 0, 0);
} else {
  let last = performance.now();
  const tick = (): void => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (!frozen && replay) {
      progress += dt / STAGE_SEC;
      if (progress >= 1.35) {
        progress = 0;
        stage = (stage + 1) % replay.stages.length;
        if (stage === 0 && !real) ({ r: replay, real } = pickReplay()); // switch to real data once recorded
      }
    }
    theater.showReplay(replay, stage, Math.min(1, progress));
    caption();
    requestAnimationFrame(tick);
  };
  tick();
}

setInterval(() => {
  const st = theater.stats();
  stats.textContent = `${st.fps.toFixed(0)} fps · ${st.calls} calls · ${st.arcs} arcs · ${(st.triangles / 1000).toFixed(0)}k tris`;
}, 500);

(window as unknown as Record<string, unknown>).theater = theater;
(window as unknown as Record<string, unknown>).engine = engine;

// ?hover=x,y — synthesize a pointer move (verifies the tooltip in headless screenshots)
const hv = q.get('hover');
if (hv) {
  const [hx, hy] = hv.split(',').map(Number);
  setTimeout(() => {
    const cv = document.querySelector('.theater-canvas') as HTMLCanvasElement;
    cv.dispatchEvent(new PointerEvent('pointermove', { clientX: hx, clientY: hy, bubbles: true }));
  }, 1500);
}
