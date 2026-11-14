import type { DisasterEvent, DisasterKind, DisasterParams, SimSnapshot } from '../core/types';
import { GRID_COLS, GRID_ROWS } from '../core/constants';
import { DEFAULT_LAYERS, type LayerName } from './contracts';
import { fmtDuration } from './format';
import { button, h, icon, keyChip, panel, setText, slider, type IconName } from './widgets';
import './rail.css';

/** Smallest height the active card's list may take before the whole left column scrolls instead (px). */
const MIN_LIST = 220;

type LayerGlyph = 'grid' | 'flow' | 'labels' | 'status';

/** Inline 2 px ink strokes, drawn in currentColor so the chip's state colour carries through. */
const GLYPHS: Record<LayerGlyph, string> = {
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  flow: '<path d="M3.5 12h12.5"/><path d="M11 6.5l5.5 5.5-5.5 5.5"/>',
  labels: '<path d="M4 4h8l8 8-8 8-8-8z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
  status: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
};

function glyph(g: LayerGlyph): SVGElement {
  const w = document.createElement('span');
  w.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round">${GLYPHS[g]}</svg>`;
  return w.firstElementChild as SVGElement;
}

interface Def {
  kind: DisasterKind;
  name: string;
  desc: string;
  tone: string;
  mode: 'cell' | 'now' | 'target';
}

const DEFS: Def[] = [
  { kind: 'earthquake', name: 'Earthquake', desc: 'Shakes ground, snaps lines.', tone: 'sand', mode: 'cell' },
  { kind: 'flood', name: 'Flood', desc: 'River rises, swamps low land.', tone: 'blue', mode: 'now' },
  { kind: 'cyclone', name: 'Cyclone', desc: 'Storm sweeps in, kills solar.', tone: 'lilac', mode: 'cell' },
  { kind: 'fire', name: 'Fire', desc: 'Spreads from one block.', tone: 'orange', mode: 'cell' },
  { kind: 'grid_fault', name: 'Grid fault', desc: 'Trips a power plant.', tone: 'yellow', mode: 'target' },
];

const NAME: Record<DisasterKind, string> = {
  earthquake: 'Earthquake',
  flood: 'Flood',
  cyclone: 'Cyclone',
  fire: 'Fire',
  grid_fault: 'Grid fault',
};

export interface RailCallbacks {
  onTrigger(kind: DisasterKind, params: DisasterParams): void;
  onPickMode(m: 'select' | 'cell'): void;
  onPickChange(kind: DisasterKind | null): void;
  onLayer(name: LayerName, on: boolean): void;
}

/**
 * Publish the real bottom edge of the floating top bar as `--topbar-bottom` on the HUD root. The bar wraps onto
 * several rows on narrow screens, so the rails and sheets cannot assume a fixed height.
 */
function trackTopbar(hud: HTMLElement): void {
  const bar = hud.querySelector<HTMLElement>('.topbar');
  if (!bar) return;
  const apply = () => hud.style.setProperty('--topbar-bottom', `${Math.ceil(bar.getBoundingClientRect().bottom)}px`);
  apply();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(apply).observe(bar);
  window.addEventListener('resize', apply);
}

export class DisasterRail {
  readonly el: HTMLElement;
  private tracked = false;
  private intensity;
  private radius;
  private rows = new Map<DisasterKind, { row: HTMLElement; btn: HTMLButtonElement; label: HTMLElement }>();
  private activeList: HTMLElement;
  private activeRows = new Map<string, { row: HTMLElement; fill: HTMLElement; sub: HTMLElement; ev: DisasterEvent }>();
  private activeEmpty: HTMLElement;
  private activeTitle = h('h3', 'section-title', 'Active');
  private genSelect: HTMLSelectElement;
  private genKey = '';
  private picking: DisasterKind | null = null;
  private layerBtns = new Map<LayerName, HTMLButtonElement>();
  private layers: Record<LayerName, boolean> = { ...DEFAULT_LAYERS };
  private pickBanner: HTMLElement;
  readonly pill: HTMLElement;

  constructor(private cb: RailCallbacks) {
    this.intensity = slider({ label: 'Intensity', min: 10, max: 100, step: 5, value: 70, fmt: (v) => `${v}%`, onInput: () => {} });
    this.radius = slider({ label: 'Radius', min: 2, max: 14, step: 1, value: 8, fmt: (v) => `${v} cells`, onInput: () => {} });
    this.genSelect = h('select', { class: 'select small', 'aria-label': 'Power plant to trip' });
    this.pickBanner = h('div', { class: 'pick-banner', hidden: true, role: 'status' });
    this.activeList = h('div', 'active-list');
    this.activeEmpty = h('p', 'muted small-note', 'Nothing active. The city is calm.');

    const dp = panel({ title: 'Disasters', cls: 'disasters' });
    const sliders = h('div', 'sliders', this.intensity.el, this.radius.el);
    const list = h('div', 'disaster-list');
    for (const d of DEFS) list.append(this.buildRow(d));
    // Sliders stay pinned; the list and the active events share one scroll region inside the card.
    const scroll = h(
      'div',
      { class: 'dr-scroll', tabindex: 0, role: 'region', 'aria-label': 'Disaster list and active events' },
      list,
      this.activeTitle,
      this.activeEmpty,
      this.activeList,
    );
    dp.body.classList.add('dr-body');
    dp.body.append(this.pickBanner, sliders, scroll);

    const lp = panel({ title: 'Layers', cls: 'layers-panel', collapsible: false });
    const grid = h('div', { class: 'layer-grid', role: 'group', 'aria-label': 'Map layers' });
    const L: { name: LayerName; label: string; full: string; key: string; g: LayerGlyph }[] = [
      { name: 'grid', label: 'Grid', full: 'Grid', key: 'G', g: 'grid' },
      { name: 'flow', label: 'Flow', full: 'Power flow', key: 'F', g: 'flow' },
      { name: 'labels', label: 'Labels', full: 'Labels', key: 'L', g: 'labels' },
      { name: 'status', label: 'Status', full: 'Status', key: 'S', g: 'status' },
    ];
    for (const l of L) {
      // The key moves into the tooltip and aria-keyshortcuts; the keyboard shortcut itself is unchanged (hud.ts).
      const b = h(
        'button',
        { class: 'layer-chip', type: 'button', 'aria-pressed': String(this.layers[l.name]), title: `${l.full} (${l.key})`, 'aria-keyshortcuts': l.key },
        glyph(l.g),
        h('span', { text: l.label }),
      );
      b.addEventListener('click', () => this.setLayer(l.name, !this.layers[l.name]));
      this.layerBtns.set(l.name, b);
      grid.append(b);
    }
    lp.body.append(grid);

    const pill = h('div', { class: 'layer-pill', role: 'group', 'aria-label': 'Network layers' });
    const PL: { name: LayerName; label: string; key: string; ic: IconName }[] = [
      { name: 'power', label: 'Power lines', key: 'P', ic: 'power' },
      { name: 'water', label: 'Water network', key: 'W', ic: 'water' },
    ];
    for (const l of PL) {
      const b = h('button', { class: `pill-toggle ${l.name}`, type: 'button', 'aria-pressed': String(this.layers[l.name]), title: `${l.label} (${l.key})` }, icon(l.ic, 20), h('span', { text: l.label }), keyChip(l.key));
      b.addEventListener('click', () => this.setLayer(l.name, !this.layers[l.name]));
      this.layerBtns.set(l.name, b);
      pill.append(b);
    }
    this.pill = pill;

    this.el = h('aside', { class: 'rail rail-left', 'aria-label': 'Disaster tools' }, dp.el, lp.el);
    this.observeFit();
  }

  /**
   * Left column height logic. Desktop only: the tall card (Disasters or Live negotiation) takes the leftover height
   * with a MIN_LIST floor, so its list is the one scroller. If that floor does not fit, the card goes to natural
   * height and the whole column scrolls instead. The mode is a class on the column (rail.css decides the styles).
   */
  private fitQueued = false;

  private observeFit() {
    // The column's own size is fixed by its top/bottom offsets, so resizing it cannot feed back into this observer.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.scheduleFit()).observe(this.el);
    // Content changes (active events, feed messages) and hidden/collapsed toggles change the card's natural height.
    // Only childList and these two attributes are watched, so the class and style writes in fit() cannot loop.
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => this.scheduleFit()).observe(this.el, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'data-collapsed'],
      });
    }
    this.scheduleFit();
  }

  private scheduleFit() {
    if (this.fitQueued) return;
    this.fitQueued = true;
    requestAnimationFrame(() => {
      this.fitQueued = false;
      this.fit();
    });
  }

  private mainCard(): HTMLElement | null {
    if (!window.matchMedia('(min-width: 960px)').matches) return null;
    const cards = [...this.el.children] as HTMLElement[];
    return (
      cards.find((c) => (c.classList.contains('disasters') || c.classList.contains('feed-panel')) && !c.hidden && c.dataset.collapsed !== 'true') ?? null
    );
  }

  private fit() {
    const col = this.el;
    col.classList.remove('rail-fit', 'rail-stack');
    const card = this.mainCard();
    if (!card) return;
    const region = card.querySelector<HTMLElement>(card.classList.contains('disasters') ? '.dr-scroll' : '.fd-list');
    if (!region) return;
    // Fit mode: the card may shrink to chrome + MIN_LIST. Chrome is measured from the live card, so banners and
    // headers that appear or disappear are picked up on the next pass.
    col.classList.add('rail-fit');
    card.style.setProperty('--rail-min', `${card.offsetHeight - region.offsetHeight + MIN_LIST}px`);
    // The feed never switches to column scroll: its auto-scroll and "New messages" cue need its own list to scroll.
    if (!card.classList.contains('feed-panel') && col.scrollHeight > col.clientHeight + 1) {
      col.classList.replace('rail-fit', 'rail-stack');
    }
  }

  private buildRow(d: Def): HTMLElement {
    const label = h('span', { text: d.mode === 'cell' ? 'Place' : d.mode === 'now' ? 'Start' : 'Trip' });
    const btn = h('button', { class: 'btn small', type: 'button', 'aria-label': `${d.mode === 'cell' ? 'Place' : d.mode === 'now' ? 'Start' : 'Trip'} ${d.name}` }, label);
    btn.addEventListener('click', () => this.act(d));
    const text = h('div', 'dr-text', h('div', 'dr-name', d.name), h('div', 'dr-desc', d.desc));
    const row = h('div', { class: 'dr-row', 'data-tone': d.tone }, h('span', 'dr-icon', icon(d.kind as IconName, 22)), text, btn);
    if (d.mode === 'target') {
      row.classList.add('has-extra');
      row.append(h('div', 'dr-extra', this.genSelect));
    }
    this.rows.set(d.kind, { row, btn, label });
    return row;
  }

  private act(d: Def) {
    const intensity = this.intensity.get() / 100;
    if (d.mode === 'now') {
      this.cb.onTrigger(d.kind, { intensity });
    } else if (d.mode === 'target') {
      const id = this.genSelect.value;
      if (id) this.cb.onTrigger(d.kind, { targetId: id });
    } else if (this.picking === d.kind) {
      this.cancel();
    } else {
      this.startPick(d.kind);
    }
  }

  private startPick(kind: DisasterKind) {
    this.picking = kind;
    this.cb.onPickMode('cell');
    this.paintPick();
    this.cb.onPickChange(kind);
  }

  get isPicking(): boolean {
    return this.picking !== null;
  }

  cancel() {
    if (!this.picking) return;
    this.picking = null;
    this.cb.onPickMode('select');
    this.paintPick();
    this.cb.onPickChange(null);
  }

  private paintPick() {
    for (const [k, r] of this.rows) {
      const on = this.picking === k;
      r.row.dataset.active = String(on);
      if (this.picking !== null || true) {
        const def = DEFS.find((d) => d.kind === k)!;
        r.label.textContent = on ? 'Cancel' : def.mode === 'cell' ? 'Place' : def.mode === 'now' ? 'Start' : 'Trip';
      }
      r.btn.classList.toggle('danger', on);
    }
    this.pickBanner.hidden = this.picking === null;
    if (this.picking) {
      this.pickBanner.replaceChildren(
        h('span', { text: `Click the map to place the ${NAME[this.picking].toLowerCase()}. ` }),
        keyChip('Esc'),
        h('span', { text: ' cancels.' }),
      );
    }
  }

  /** world 'cellPick' */
  onCellPick(col: number, row: number) {
    const kind = this.picking;
    if (!kind) return;
    const intensity = this.intensity.get() / 100;
    const radius = this.radius.get();
    const params: DisasterParams = { col, row, intensity };
    if (kind === 'earthquake') params.radius = radius;
    if (kind === 'cyclone') {
      params.radius = Math.max(3, Math.round(radius * 0.7));
      // aim the storm at the city centre
      params.heading = Math.atan2(GRID_ROWS / 2 - row, GRID_COLS / 2 - col);
    }
    this.cb.onTrigger(kind, params);
    this.cancel();
  }

  setLayer(name: LayerName, on: boolean, silent = false) {
    this.layers[name] = on;
    this.layerBtns.get(name)?.setAttribute('aria-pressed', String(on));
    if (!silent) this.cb.onLayer(name, on);
  }

  toggleLayer(name: LayerName) {
    this.setLayer(name, !this.layers[name]);
  }

  syncLayers() {
    for (const n of Object.keys(this.layers) as LayerName[]) this.cb.onLayer(n, this.layers[n]);
  }

  /** Rebuild the generator list (on reset). */
  refreshTargets(s: SimSnapshot) {
    const gens = Object.values(s.buildings).filter((b) => b.kind === 'generator');
    const key = gens.map((g) => g.id).join(',');
    if (key === this.genKey) return;
    this.genKey = key;
    this.genSelect.replaceChildren(...gens.map((g) => h('option', { value: g.id, text: g.name })));
  }

  update(s: SimSnapshot) {
    if (!this.tracked) {
      // First refresh runs after the HUD is attached, so the top bar can be measured.
      const hud = this.el.closest<HTMLElement>('.hud');
      if (hud) {
        this.tracked = true;
        trackTopbar(hud);
      }
    }
    this.refreshTargets(s);
    const active = s.disasters.filter((d) => d.active);
    const ids = new Set(active.map((d) => d.id));
    for (const [id, r] of this.activeRows) {
      if (!ids.has(id)) {
        r.row.remove();
        this.activeRows.delete(id);
      }
    }
    for (const d of [...active].reverse()) {
      let r = this.activeRows.get(d.id);
      if (!r) {
        const fill = h('div', 'gauge-fill');
        const sub = h('span', 'dr-sub');
        const row = h(
          'div',
          { class: 'active-row' },
          h('div', 'active-top', h('span', 'active-name', NAME[d.kind]), sub),
          h('div', { class: 'gauge', role: 'progressbar', 'aria-label': `${NAME[d.kind]} progress` }, fill),
        );
        r = { row, fill, sub, ev: d };
        this.activeRows.set(d.id, r);
        this.activeList.append(row);
      }
      const where = d.params.col != null && d.params.row != null ? `(${d.params.col}, ${d.params.row})` : '';
      if (d.durationMin > 0) {
        const f = Math.max(0, Math.min(1, (s.tMin - d.startMin) / d.durationMin));
        r.fill.style.width = `${f * 100}%`;
        r.row.dataset.open = 'false';
        setText(r.sub, `${where} ${fmtDuration(d.durationMin * (1 - f))} left`.trim());
      } else {
        r.fill.style.width = '100%';
        r.row.dataset.open = 'true';
        setText(r.sub, `${where} ongoing`.trim());
      }
    }
    this.activeEmpty.hidden = true;
    this.activeTitle.hidden = active.length === 0;
  }
}
