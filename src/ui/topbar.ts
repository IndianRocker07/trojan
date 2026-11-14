import type { SimSnapshot } from '../core/types';
import { SCENARIO_OPTIONS, SPEEDS } from './contracts';
import { clockFromMin } from './format';
import { START_HOUR } from '../core/constants';
import { button, h, icon, keyChip, segmented, setText } from './widgets';

export interface TopbarCallbacks {
  onPlayPause(): void;
  onStep(): void;
  onSpeed(v: number): void;
  onReset(): void;
  onScenario(id: string): void;
  onHelp(): void;
}

export class Topbar {
  readonly el: HTMLElement;
  private play: HTMLButtonElement;
  private clock: HTMLElement;
  private speedSeg;
  private select: HTMLSelectElement;
  private running: boolean | null = null;

  constructor(cb: TopbarCallbacks) {
    const mark = h('span', 'wordmark', h('span', 'logo', icon('bolt', 22)), h('span', 'wordmark-text', 'Trojan'));

    this.select = h('select', { class: 'select', 'aria-label': 'Scenario' });
    for (const s of SCENARIO_OPTIONS) this.select.append(h('option', { value: s.id, text: s.name }));
    this.select.addEventListener('change', () => cb.onScenario(this.select.value));

    this.clock = h('span', { class: 'clock', 'aria-live': 'off' });
    const clockWrap = h(
      'span',
      { class: 'clock-wrap', role: 'timer', 'aria-label': 'Simulation clock' },
      h('span', 'clock-start', `${String(START_HOUR).padStart(2, '0')}:00 →`),
      this.clock,
    );

    this.play = button({ icon: 'play', cls: 'primary icon', aria: 'Play', title: 'Play / pause (Space)', onClick: cb.onPlayPause });
    const step = button({ icon: 'step', cls: 'icon', aria: 'Step one minute', title: 'Step one minute (.)', onClick: cb.onStep });
    const reset = button({ icon: 'reset', cls: 'icon', aria: 'Reset simulation', title: 'Reset', onClick: cb.onReset });

    this.speedSeg = segmented<number>({
      label: 'Simulation speed',
      options: SPEEDS.map((s) => ({ value: s, label: `${s}×`, aria: `${s} times speed` })),
      value: 10,
      onChange: cb.onSpeed,
      cls: 'speed',
    });

    const help = h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)', text: '?' });
    help.addEventListener('click', cb.onHelp);

    this.el = h(
      'header',
      { class: 'topbar' },
      mark,
      h('span', 'tb-scenario', this.select),
      clockWrap,
      h('span', 'tb-controls', this.play, step, reset),
      this.speedSeg.el,
      help,
    );
  }

  setScenario(id: string) {
    this.select.value = id;
  }

  update(s: SimSnapshot, timeOfDay: number) {
    const c = clockFromMin(s.tMin);
    const hh = Math.floor(timeOfDay % 24);
    const mm = Math.floor((timeOfDay % 1) * 60);
    const clockText = Number.isFinite(timeOfDay)
      ? `Day ${c.day}, ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
      : `Day ${c.day}, ${c.text}`;
    setText(this.clock, clockText);
    this.speedSeg.set(s.speed);
    this.setRunning(s.running);
  }

  setRunning(r: boolean) {
    if (r === this.running) return;
    this.running = r;
    this.play.replaceChildren(icon(r ? 'pause' : 'play'));
    this.play.setAttribute('aria-label', r ? 'Pause' : 'Play');
  }

  setSpeed(v: number) {
    this.speedSeg.set(v);
  }
}

export function helpCard(): HTMLElement {
  const row = (k: string[], t: string) => h('div', 'help-row', h('span', 'help-keys', ...k.map(keyChip)), h('span', { text: t }));
  return h(
    'div',
    { class: 'help-card card', role: 'dialog', 'aria-label': 'Keyboard shortcuts', hidden: true },
    h('h2', 'panel-title', 'Shortcuts'),
    row(['Space'], 'Play / pause'),
    row(['.'], 'Step one minute'),
    row(['1', '–', '5'], 'Speed 1× to 60×'),
    row(['G'], 'Toggle grid'),
    row(['F'], 'Toggle power flow'),
    row(['L'], 'Toggle labels'),
    row(['S'], 'Toggle status overlay'),
    row(['P'], 'Toggle power lines'),
    row(['W'], 'Toggle water network'),
    row(['Esc'], 'Deselect / cancel placing'),
  );
}
