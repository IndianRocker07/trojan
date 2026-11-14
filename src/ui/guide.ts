/**
 * First-visit onboarding (docs/STORY.md §4.1-4.2): a welcome dialog with three cards, and coach marks that point at real
 * elements. Plain DOM, keyboard operable, focus is trapped in the welcome dialog and restored when it closes.
 */
import { button, h, keyChip } from './widgets';

const S = 'stroke="#121310" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"';

const ART = {
  city: `<svg viewBox="0 0 120 80" width="120" height="80" aria-hidden="true" focusable="false">
<rect x="4" y="68" width="112" height="8" rx="2" fill="#f3ead0" ${S}/>
<rect x="10" y="34" width="22" height="34" fill="#fff" ${S}/><rect x="40" y="20" width="26" height="48" fill="#0a7cff" ${S}/>
<rect x="74" y="40" width="20" height="28" fill="#fff" ${S}/><rect x="98" y="50" width="14" height="18" fill="#ff7aa8" ${S}/>
<path d="M16 42h10M16 50h10M46 28h14M46 36h14M46 44h14" fill="none" ${S}/>
<polygon points="60,4 46,26 57,26 51,44 72,18 60,18" fill="#ffd60a" ${S}/>
</svg>`,
  agents: `<svg viewBox="0 0 120 80" width="120" height="80" aria-hidden="true" focusable="false">
<circle cx="60" cy="40" r="13" fill="#ffd60a" ${S}/><path d="M56 40h8M60 36v8" fill="none" ${S}/>
<circle cx="16" cy="16" r="10" fill="#ff4a2e" ${S}/><circle cx="104" cy="16" r="10" fill="#0a7cff" ${S}/>
<circle cx="16" cy="64" r="10" fill="#a77bff" ${S}/><circle cx="104" cy="64" r="10" fill="#ff7aa8" ${S}/>
<path d="M25 22l23 13M95 22L72 35M25 58l23-13M95 58L72 45" fill="none" ${S} stroke-dasharray="1 7"/>
</svg>`,
  safety: `<svg viewBox="0 0 120 80" width="120" height="80" aria-hidden="true" focusable="false">
<path d="M60 6l30 12v22c0 18-13 30-30 36C43 70 30 58 30 40V18z" fill="#5fc52e" ${S}/>
<polyline points="46,40 56,50 76,28" fill="none" ${S} stroke-width="5"/>
</svg>`,
};

interface Card {
  art: keyof typeof ART;
  title: string;
  text: string;
}
const CARDS: Card[] = [
  { art: 'city', title: 'A city in a disaster', text: 'Earthquakes, floods and storms break power lines and plants. There is not enough electricity for everyone.' },
  { art: 'agents', title: 'Every utility has an AI agent', text: 'Each hospital, pump station and shelter has an agent that bids for power and explains why. They can give some up for each other, even sign deals.' },
  { art: 'safety', title: 'A safety layer checks every decision', text: 'Before anything is committed, a safety layer makes sure nothing falls below the power it needs so nothing dangerous fails.' },
];

const FOCUSABLE = 'button:not([disabled]), [href], input, select, [tabindex]:not([tabindex="-1"])';

export interface WelcomeCallbacks {
  onGuided(): void;
  onExplore(): void;
  onShortcuts(): void;
}

export class Welcome {
  readonly el: HTMLElement;
  private prevFocus: HTMLElement | null = null;
  private primary: HTMLButtonElement;

  constructor(private cb: WelcomeCallbacks) {
    this.primary = button({ label: 'Start guided demo', cls: 'primary big', onClick: () => this.finish(cb.onGuided) });
    const explore = button({ label: 'Explore on my own', cls: 'big', onClick: () => this.finish(cb.onExplore) });
    const keys = h('button', { class: 'linkish', type: 'button' }, 'Keyboard shortcuts');
    keys.addEventListener('click', () => this.finish(cb.onShortcuts));
    const cards = h('ol', 'wl-cards');
    CARDS.forEach((c, i) => {
      const art = h('div', 'wl-art');
      art.innerHTML = ART[c.art];
      cards.append(h('li', 'wl-card', h('span', 'wl-num', String(i + 1)), art, h('h3', 'wl-card-title', c.title), h('p', null, c.text)));
    });
    this.el = h(
      'div',
      { class: 'welcome', hidden: true },
      h(
        'div',
        { class: 'wl-dialog card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wl-title', 'aria-describedby': 'wl-sub' },
        h('h2', { class: 'wl-title', id: 'wl-title', text: 'Welcome to Trojan' }),
        h('p', { class: 'wl-sub', id: 'wl-sub', text: 'Watch AI agents fight over scarce electricity, and see why every one of them got what it got.' }),
        cards,
        h('div', 'wl-actions', this.primary, explore),
        h('p', 'wl-foot muted', 'Tip: press ', keyChip('Esc'), ' to skip. Reopen this guide any time with the ', h('b', null, '?'), ' button in the top bar. ', keys),
      ),
    );
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.finish(cb.onExplore);
      } else if (e.key === 'Tab') {
        const f = [...this.el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        const a = document.activeElement;
        if (e.shiftKey && a === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && a === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    if (this.isOpen) return;
    this.prevFocus = document.activeElement as HTMLElement | null;
    this.el.hidden = false;
    this.primary.focus();
  }

  private finish(then: () => void) {
    this.el.hidden = true;
    const f = this.prevFocus;
    this.prevFocus = null;
    then();
    if (f && f.isConnected && document.activeElement === document.body) f.focus({ preventScroll: true });
  }
}

// ───────────────────────── coach marks ─────────────────────────

export interface CoachStep {
  title: string;
  text: string;
  /** Element to point at. If it resolves to nothing visible the callout shows centred at the bottom instead. */
  anchor: () => HTMLElement | null;
  /** Called when the step becomes active (e.g. open a panel so the anchor exists). */
  before?: () => void;
  prefer?: ('right' | 'left' | 'below' | 'above')[];
}

export class CoachMarks {
  readonly el: HTMLElement;
  private steps: CoachStep[] = [];
  private i = -1;
  private target: HTMLElement | null = null;
  private timer = 0;
  private title = h('h3', { class: 'cm-title', id: 'cm-title' });
  private text = h('p', { class: 'cm-text', id: 'cm-text' });
  private count = h('span', 'cm-count mono');
  private back: HTMLButtonElement;
  private next: HTMLButtonElement;
  private prevFocus: HTMLElement | null = null;
  onEnd: (completed: boolean) => void = () => {};

  constructor() {
    this.back = button({ label: 'Back', cls: 'small', onClick: () => this.go(this.i - 1) });
    this.next = button({ label: 'Next', cls: 'small primary', onClick: () => (this.i >= this.steps.length - 1 ? this.end(true) : this.go(this.i + 1)) });
    const skip = button({ label: 'Skip tour', cls: 'small', onClick: () => this.end(false) });
    this.el = h(
      'div',
      { class: 'coach card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'cm-title', 'aria-describedby': 'cm-text', hidden: true },
      h('div', 'cm-top', this.count, skip),
      this.title,
      this.text,
      h('div', 'cm-btns', this.back, this.next),
    );
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.end(false);
      } else if (e.key === 'ArrowRight' && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault();
        this.next.click();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (this.i > 0) this.back.click();
      }
    });
  }

  get active() {
    return this.i >= 0;
  }

  start(steps: CoachStep[]) {
    this.steps = steps;
    if (!steps.length) return;
    this.prevFocus = document.activeElement as HTMLElement | null;
    this.el.hidden = false;
    window.addEventListener('resize', this.place);
    this.timer = window.setInterval(this.place, 400);
    this.go(0);
  }

  end(completed: boolean) {
    if (!this.active) return;
    this.i = -1;
    this.setTarget(null);
    this.el.hidden = true;
    window.removeEventListener('resize', this.place);
    window.clearInterval(this.timer);
    const f = this.prevFocus;
    this.prevFocus = null;
    this.onEnd(completed);
    if (f && f.isConnected && (document.activeElement === document.body || this.el.contains(document.activeElement))) f.focus({ preventScroll: true });
  }

  private go(i: number) {
    if (i < 0 || i >= this.steps.length) return;
    this.i = i;
    const s = this.steps[i];
    s.before?.();
    this.title.textContent = s.title;
    this.text.textContent = s.text;
    this.count.textContent = `${i + 1} / ${this.steps.length}`;
    this.back.disabled = i === 0;
    this.next.textContent = i === this.steps.length - 1 ? 'Got it' : 'Next';
    this.setTarget(null);
    this.place();
    this.next.focus({ preventScroll: true });
  }

  private setTarget(t: HTMLElement | null) {
    if (t === this.target) return;
    this.target?.classList.remove('coach-target');
    this.target = t;
    t?.classList.add('coach-target');
  }

  private place = () => {
    if (this.i < 0) return;
    const s = this.steps[this.i];
    let a = s.anchor();
    if (a) {
      const r = a.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || getComputedStyle(a).visibility === 'hidden') a = null;
    }
    this.setTarget(a);
    const card = this.el;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 12;
    if (!a) {
      card.dataset.side = 'none';
      card.style.left = `${Math.round((vw - cw) / 2)}px`;
      card.style.top = `${Math.round(Math.max(M, vh - ch - 90))}px`;
      return;
    }
    const r = a.getBoundingClientRect();
    const GAP = 16;
    const fits = {
      right: r.right + GAP + cw <= vw - M,
      left: r.left - GAP - cw >= M,
      below: r.bottom + GAP + ch <= vh - M,
      above: r.top - GAP - ch >= M,
    };
    const order = s.prefer ?? (isNarrow() ? ['above', 'below', 'right', 'left'] : ['right', 'below', 'above', 'left']);
    const side = order.find((o) => fits[o]) ?? 'below';
    let x: number;
    let y: number;
    if (side === 'right' || side === 'left') {
      x = side === 'right' ? r.right + GAP : r.left - GAP - cw;
      y = r.top + r.height / 2 - ch / 2;
    } else {
      y = side === 'below' ? r.bottom + GAP : r.top - GAP - ch;
      x = r.left + r.width / 2 - cw / 2;
    }
    x = Math.max(M, Math.min(vw - cw - M, x));
    y = Math.max(M, Math.min(vh - ch - M, y));
    card.dataset.side = side;
    card.style.left = `${Math.round(x)}px`;
    card.style.top = `${Math.round(y)}px`;
    const ax = r.left + r.width / 2 - x;
    const ay = r.top + r.height / 2 - y;
    card.style.setProperty('--ax', `${Math.round(Math.max(20, Math.min(cw - 20, ax)))}px`);
    card.style.setProperty('--ay', `${Math.round(Math.max(20, Math.min(ch - 20, ay)))}px`);
  };
}

const isNarrow = () => window.matchMedia('(max-width: 959px)').matches;
