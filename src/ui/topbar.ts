import type { SimSnapshot } from '../core/types';
import { SCENARIO_OPTIONS, SPEEDS } from './contracts';
import { clockFromMin } from './format';
import { START_HOUR } from '../core/constants';
import { button, h, icon, keyChip, segmented, setText } from './widgets';

export interface ModeOptions {
  policies: { id: string; label: string }[];
  validators: { id: string; label: string }[];
  policy: string;
  validator: string;
  onPolicy(id: string): void;
  onValidator(id: string): void;
}

export interface TopbarCallbacks {
  onPlayPause(): void;
  onStep(): void;
  onSpeed(v: number): void;
  onReset(): void;
  onScenario(id: string): void;
  onHelp(): void;
  onStory(on: boolean): void;
  onTheater(): void;
  /** Hide the Theater button when no theater view is wired in. */
  theaterAvailable: boolean;
  modes?: ModeOptions;
}

export class Topbar {
  readonly el: HTMLElement;
  private play: HTMLButtonElement;
  private clock: HTMLElement;
  private speedSeg;
  private select: HTMLSelectElement;
  private running: boolean | null = null;
  private storySw: HTMLButtonElement;
  private theaterBtn: HTMLButtonElement;
  private theaterOn: boolean | null = null;
  private pol = '';
  private val = '';

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

    const help = h('button', { class: 'btn icon help-btn', type: 'button', 'aria-label': 'Help: open the welcome guide', 'data-tip': 'Help: replay the welcome guide', text: '?' });
    help.addEventListener('click', cb.onHelp);

    this.theaterBtn = h(
      'button',
      { class: 'btn primary tb-theater', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Negotiation Theater', 'data-tip': 'Negotiation Theater: a full-screen view where every agent bids for power as glowing arcs (T)' },
      icon('globe', 20),
      h('span', { text: 'Theater' }),
    );
    this.theaterBtn.hidden = !cb.theaterAvailable;
    this.theaterBtn.addEventListener('click', cb.onTheater);

    this.storySw = h(
      'button',
      {
        class: 'btn switch tb-story',
        type: 'button',
        role: 'switch',
        'aria-checked': 'false',
        'aria-label': 'Story mode',
        'data-tip': 'Story mode: at big moments the simulation pauses and the negotiation replays step by step, then carries on.',
      },
      h('span', 'sw-track', h('span', 'sw-knob')),
      h('span', 'sw-label', 'Story'),
      h('span', { class: 'sw-state', 'aria-hidden': 'true', text: 'Off' }),
    );
    this.storySw.addEventListener('click', () => cb.onStory(this.storySw.getAttribute('aria-checked') !== 'true'));

    const m = cb.modes;
    let modes: HTMLElement | null = null;
    if (m) {
      const tipText = () => `Engine: ${m.policies.find((x) => x.id === this.pol)?.label ?? ''} policy, ${m.validators.find((x) => x.id === this.val)?.label ?? ''} safety. Click to change.`;
      this.pol = m.policy;
      this.val = m.validator;
      const pop = h(
        'div',
        { class: 'engine-pop card', role: 'dialog', 'aria-label': 'Engine modes', hidden: true },
        h('p', 'muted small', 'Choose how power is shared and whether the safety layer checks it.'),
        this.modeGroup('Policy', m.policies, m.policy, (id) => {
          this.pol = id;
          btn.dataset.tip = tipText();
          m.onPolicy(id);
        }),
        this.modeGroup('Safety', m.validators, m.validator, (id) => {
          this.val = id;
          btn.dataset.tip = tipText();
          m.onValidator(id);
        }),
      );
      const btn = h('button', { class: 'btn tb-engine', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-tip': tipText() }, h('span', { text: 'Engine' }), icon('chevron', 16));
      const close = () => {
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      };
      btn.addEventListener('click', () => {
        const open = pop.hidden;
        pop.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        if (open) {
          const w = pop.offsetWidth;
          pop.style.left = `${Math.max(8, Math.min(btn.offsetLeft + btn.offsetWidth - w, this.el.offsetWidth - w - 8))}px`;
        }
      });
      document.addEventListener('pointerdown', (e) => {
        if (!pop.hidden && !pop.contains(e.target as Node) && !btn.contains(e.target as Node)) close();
      });
      pop.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
          btn.focus();
        }
      });
      modes = h('span', 'tb-modes', btn, pop);
    }

    this.el = h(
      'header',
      { class: 'topbar' },
      mark,
      h('span', 'tb-scenario', this.select),
      clockWrap,
      h('span', 'tb-controls', this.play, step, reset),
      this.speedSeg.el,
      this.theaterBtn,
      this.storySw,
      modes,
      help,
    );
  }

  private modeGroup(label: string, opts: { id: string; label: string }[], value: string, on: (id: string) => void) {
    const seg = segmented<string>({
      label: `${label} mode`,
      options: opts.map((o) => ({ value: o.id, label: o.label, aria: `${label}: ${o.label}` })),
      value,
      onChange: on,
      cls: 'mode',
    });
    return h('span', 'mode-group', h('span', 'mode-label', `${label}:`), seg.el);
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

  setStory(on: boolean) {
    this.storySw.setAttribute('aria-checked', String(on));
    (this.storySw.lastElementChild as HTMLElement).textContent = on ? 'On' : 'Off';
  }

  setTheater(on: boolean) {
    if (on === this.theaterOn) return;
    this.theaterOn = on;
    this.theaterBtn.setAttribute('aria-pressed', String(on));
  }

  get helpButton() {
    return this.el.querySelector<HTMLElement>('.help-btn')!;
  }
  get storySwitch() {
    return this.storySw;
  }
  get theaterButton() {
    return this.theaterBtn;
  }
}

export function helpCard(): HTMLElement {
  const row = (k: string[], t: string) => h('div', 'help-row', h('span', 'help-keys', ...k.map(keyChip)), h('span', { text: t }));
  return h(
    'div',
    { class: 'help-card card', role: 'dialog', 'aria-label': 'Keyboard shortcuts', hidden: true },
    h('h2', 'panel-title', 'Shortcuts'),
    h('p', 'muted small', 'Click the ? button for the welcome guide.'),
    row(['Space'], 'Play / pause'),
    row(['.'], 'Step one minute'),
    row(['1', '–', '5'], 'Speed 1× to 60×'),
    row(['G'], 'Toggle grid'),
    row(['F'], 'Toggle power flow'),
    row(['L'], 'Toggle labels'),
    row(['S'], 'Toggle status overlay'),
    row(['P'], 'Toggle power lines'),
    row(['W'], 'Toggle water network'),
    row(['T'], 'Negotiation Theater on / off'),
    row(['←', '→'], 'Previous / next replay stage'),
    row(['Esc'], 'Close replay / deselect / cancel'),
  );
}
