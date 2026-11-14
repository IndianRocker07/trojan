/** Small DOM widgets shared by every panel. Plain DOM, no framework. */
import { STATUS_LABEL } from './format';

export const C = {
  ink: '#121310',
  green: '#5fc52e',
  blue: '#0a7cff',
  surface2: '#f3ead0',
  white: '#ffffff',
  orange: '#ff8a00',
};

export const isMobile = () => window.matchMedia('(max-width: 959px)').matches;
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

/** Tiny hyperscript. `props` may be a class string. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: string | Props | null,
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const p: Props = typeof props === 'string' ? { class: props } : (props ?? {});
  for (const [k, v] of Object.entries(p)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c != null && c !== false) e.append(c);
  return e;
}

/** Set text only when it changed. */
export function setText(node: HTMLElement, s: string): void {
  if (node.dataset.v !== s) {
    node.dataset.v = s;
    node.textContent = s;
  }
}

export function setAttr(node: HTMLElement, k: string, v: string): void {
  if (node.getAttribute(k) !== v) node.setAttribute(k, v);
}

export function popAnim(e: HTMLElement): void {
  if (reducedMotion() || !e.animate) return;
  e.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], {
    duration: 260,
    easing: 'cubic-bezier(.17,.67,.3,1.33)',
  });
}

// ───────────────────────── icons (flat fills, 2.5 px ink strokes) ─────────────────────────

const S = 'stroke="#121310" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  play: `<polygon points="7,4.5 20,12 7,19.5" fill="currentColor" ${S}/>`,
  pause: `<rect x="5.5" y="4.5" width="4.5" height="15" rx="1" fill="currentColor" ${S}/><rect x="14" y="4.5" width="4.5" height="15" rx="1" fill="currentColor" ${S}/>`,
  step: `<polygon points="4.5,5 15,12 4.5,19" fill="currentColor" ${S}/><line x1="19" y1="5" x2="19" y2="19" ${S}/>`,
  reset: `<path d="M19 12a7 7 0 1 1-2.2-5.1" fill="none" ${S}/><polyline points="19,3.5 18.8,8 14.3,7.6" fill="none" ${S}/>`,
  chevron: `<polyline points="6,9 12,15 18,9" fill="none" ${S}/>`,
  close: `<path d="M6 6L18 18M18 6L6 18" fill="none" ${S}/>`,
  target: `<circle cx="12" cy="12" r="7" fill="#fff" ${S}/><circle cx="12" cy="12" r="2.2" fill="#121310"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" ${S}/>`,
  earthquake: `<polyline points="2.5,12 7,12 9.5,5 14,19 16.5,12 21.5,12" fill="none" ${S}/>`,
  flood: `<path d="M2.5 9.5q3-3.5 6 0t6 0t6 0M2.5 16q3-3.5 6 0t6 0t6 0" fill="none" ${S}/>`,
  cyclone: `<path d="M12 12.5a1.5 1.5 0 1 1 1.5-1.5 3.5 3.5 0 1 1-3.5-3.5 5.5 5.5 0 1 1-5.5 5.5 7.5 7.5 0 0 0 7.5 7.5" fill="none" ${S}/>`,
  fire: `<path d="M12 2.5c.6 4.2 5.8 5.6 5.8 11.2a5.8 5.8 0 0 1-11.6 0c0-2.8 1.6-4 2.8-5.6.4 1.4 1.2 2.2 2.2 2.4C11.2 7.5 11.6 5.2 12 2.5z" fill="#fff" ${S}/>`,
  grid_fault: `<polygon points="13.5,2.5 5,13.5 11,13.5 9.5,21.5 19,9.5 13,9.5" fill="#fff" ${S}/>`,
  power: `<polygon points="13.5,2.5 5,13.5 11,13.5 9.5,21.5 19,9.5 13,9.5" fill="#121310" ${S}/>`,
  water: `<path d="M12 2.8C15 7.5 18.5 10.5 18.5 14.5a6.5 6.5 0 0 1-13 0C5.5 10.5 9 7.5 12 2.8z" fill="#fff" ${S}/>`,
  bolt: `<polygon points="13.5,2.5 5,13.5 11,13.5 9.5,21.5 19,9.5 13,9.5" fill="#ffd60a" ${S}/>`,
  dockDisasters: `<polyline points="2.5,12 7,12 9.5,5 14,19 16.5,12 21.5,12" fill="none" ${S}/>`,
  dockInspect: `<rect x="4" y="9" width="16" height="12" rx="2" fill="#fff" ${S}/><path d="M8 9V4.5h8V9" fill="none" ${S}/>`,
  globe: `<circle cx="12" cy="12" r="8.5" fill="#fff" ${S}/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17" fill="none" ${S}/>`,
  dockLive: `<path d="M4 5h16v11H11l-5 4v-4H4z" fill="#fff" ${S}/><path d="M8 9.5h8M8 12.5h5" fill="none" ${S}/>`,
  dockStats: `<rect x="4" y="12" width="4" height="8" fill="#fff" ${S}/><rect x="10" y="6" width="4" height="14" fill="#fff" ${S}/><rect x="16" y="9" width="4" height="11" fill="#fff" ${S}/>`,
} as const;
export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 20): SVGElement {
  const w = document.createElement('span');
  w.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return w.firstElementChild as SVGElement;
}

// ───────────────────────── buttons, chips, key chips ─────────────────────────

export function button(opts: {
  label?: string;
  icon?: IconName;
  aria?: string;
  cls?: string;
  onClick?: (e: MouseEvent) => void;
  title?: string;
}): HTMLButtonElement {
  const b = h('button', {
    class: `btn ${opts.cls ?? ''}`.trim(),
    type: 'button',
    'aria-label': opts.aria ?? null,
    title: opts.title,
  });
  if (opts.icon) b.append(icon(opts.icon));
  if (opts.label) b.append(h('span', { text: opts.label }));
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

export const keyChip = (k: string) => h('kbd', { class: 'key', text: k });

export function chip(text: string, tone = ''): HTMLElement {
  return h('span', { class: `chip ${tone}`.trim(), text });
}

export function statusPill() {
  const el = h('span', 'pill');
  let cur = '';
  return {
    el,
    set(s: string) {
      if (s === cur) return;
      const first = cur === '';
      cur = s;
      el.dataset.status = s;
      el.textContent = STATUS_LABEL[s] ?? s;
      if (!first) popAnim(el);
    },
  };
}

// ───────────────────────── slider ─────────────────────────

export function slider(o: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  fmt: (v: number) => string;
  onInput: (v: number) => void;
}) {
  const out = h('output', 'slider-val');
  const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: o.value, 'aria-label': o.label });
  const paint = () => {
    input.style.setProperty('--pct', `${((+input.value - o.min) / (o.max - o.min)) * 100}%`);
    out.textContent = o.fmt(+input.value);
  };
  input.addEventListener('input', () => {
    paint();
    o.onInput(+input.value);
  });
  paint();
  const el = h('label', 'slider', h('span', 'slider-top', h('span', 'slider-label', o.label), out), input);
  return {
    el,
    get: () => +input.value,
    set(v: number) {
      input.value = String(v);
      paint();
    },
  };
}

// ───────────────────────── segmented control ─────────────────────────

export function segmented<T extends string | number>(o: {
  label: string;
  options: { value: T; label: string; aria?: string }[];
  value: T;
  onChange: (v: T) => void;
  cls?: string;
}) {
  const el = h('div', { class: `seg ${o.cls ?? ''}`.trim(), role: 'radiogroup', 'aria-label': o.label });
  let cur: T | undefined;
  const btns = o.options.map((opt) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-label': opt.aria ?? null, text: opt.label });
    b.addEventListener('click', () => {
      set(opt.value);
      o.onChange(opt.value);
    });
    return b;
  });
  el.append(...btns);
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const n = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    n.focus();
    n.click();
    e.preventDefault();
  });
  function set(v: T) {
    if (v === cur) return;
    cur = v;
    o.options.forEach((opt, i) => {
      const on = opt.value === v;
      btns[i].setAttribute('aria-checked', String(on));
      btns[i].tabIndex = on ? 0 : -1;
    });
  }
  set(o.value);
  return { el, set };
}

// ───────────────────────── power bar ─────────────────────────

export interface PowerBarData {
  demand: number;
  allocated: number;
  backup: number;
  minSafe: number;
  status: string;
}

/** Demand = full width. Fill = allocated (status colour), hatched = backup, ink tick = minSafe. */
export function powerBar(compact = false) {
  const fill = h('div', 'pbar-fill');
  const back = h('div', 'pbar-backup');
  const tick = h('div', 'pbar-tick');
  const el = h('div', { class: compact ? 'pbar compact' : 'pbar', role: 'img' }, fill, back, tick);
  const last = { a: -1, b: -1, m: -1, s: '' };
  return {
    el,
    set(d: PowerBarData) {
      const dem = Math.max(d.demand, 1e-6);
      const a = Math.min(1, d.allocated / dem);
      const b = Math.min(1 - a, d.backup / dem);
      const m = Math.min(1, d.minSafe / dem);
      if (a !== last.a) {
        last.a = a;
        fill.style.width = `${a * 100}%`;
        back.style.left = `${a * 100}%`;
      }
      if (b !== last.b) {
        last.b = b;
        back.style.width = `${b * 100}%`;
      }
      if (m !== last.m) {
        last.m = m;
        tick.style.left = `${m * 100}%`;
      }
      if (d.status !== last.s) {
        last.s = d.status;
        el.dataset.status = d.status;
      }
      setAttr(el, 'aria-label', `Allocated ${Math.round(a * 100)}% of demand, ${d.status}`);
    },
  };
}

/** Plain horizontal gauge, 0..1. */
export function gauge(tone = '') {
  const fill = h('div', 'gauge-fill');
  const el = h('div', { class: `gauge ${tone}`.trim() }, fill);
  let last = -1;
  return {
    el,
    set(f: number) {
      const v = Math.max(0, Math.min(1, f));
      if (v === last) return;
      last = v;
      fill.style.width = `${v * 100}%`;
    },
  };
}

// ───────────────────────── sparkline (canvas) ─────────────────────────

export function sparkline(w = 72, hgt = 22) {
  const c = h('canvas', 'spark');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = w * dpr;
  c.height = hgt * dpr;
  c.style.width = `${w}px`;
  c.style.height = `${hgt}px`;
  c.setAttribute('aria-hidden', 'true');
  const ctx = c.getContext('2d')!;
  let lastVer = -2;
  return {
    el: c,
    draw(values: number[], ver: number) {
      if (ver === lastVer) return;
      lastVer = ver;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hgt);
      const n = values.length;
      if (n < 2) return;
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of values) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const span = hi - lo || 1;
      const px = (i: number) => 3 + (i / (n - 1)) * (w - 6);
      const py = (v: number) => (hi === lo ? hgt / 2 : hgt - 3 - ((v - lo) / span) * (hgt - 6));
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = C.ink;
      ctx.beginPath();
      values.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
      ctx.stroke();
      ctx.fillStyle = C.green;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px(n - 1), py(values[n - 1]), 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    },
  };
}

// ───────────────────────── number tween ─────────────────────────

export function numberTween(node: HTMLElement, fmt: (v: number) => string) {
  let cur = NaN;
  let from = 0;
  let to = 0;
  let t0 = 0;
  let raf = 0;
  const render = (v: number) => {
    const s = fmt(v);
    if (node.textContent !== s) node.textContent = s;
  };
  const frame = () => {
    const k = Math.max(0, Math.min(1, (performance.now() - t0) / 280));
    cur = from + (to - from) * (1 - Math.pow(1 - k, 3));
    render(cur);
    raf = k < 1 ? requestAnimationFrame(frame) : 0;
  };
  return {
    set(v: number) {
      if (v === to && !Number.isNaN(cur)) return;
      if (Number.isNaN(cur) || reducedMotion()) {
        cur = to = v;
        render(v);
        return;
      }
      from = cur;
      to = v;
      t0 = performance.now();
      if (!raf) raf = requestAnimationFrame(frame);
    },
  };
}

// ───────────────────────── panel ─────────────────────────

export function panel(o: { title: string; cls?: string; titleExtra?: Node; collapsible?: boolean }) {
  const titleEl = h('h2', 'panel-title', o.title);
  const head = h('div', 'panel-head', titleEl);
  if (o.titleExtra) head.append(o.titleExtra);
  const body = h('div', 'panel-body');
  const el = h('section', { class: `panel ${o.cls ?? ''}`.trim() }, head, body);
  let toggle: HTMLButtonElement | undefined;
  const setCollapsed = (c: boolean) => {
    el.dataset.collapsed = String(c);
    toggle?.setAttribute('aria-expanded', String(!c));
    toggle?.setAttribute('aria-label', `${c ? 'Expand' : 'Collapse'} ${o.title}`);
  };
  if (o.collapsible !== false) {
    toggle = button({ icon: 'chevron', cls: 'icon small chev', aria: `Collapse ${o.title}` });
    toggle.addEventListener('click', () => {
      if (isMobile()) el.dispatchEvent(new CustomEvent('hud-close-sheet', { bubbles: true }));
      else setCollapsed(el.dataset.collapsed !== 'true');
    });
    head.append(toggle);
    setCollapsed(false);
  }
  return { el, head, body, titleEl, setCollapsed };
}
