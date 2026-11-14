import type { DisasterEvent, DisasterKind, DisasterParams, SimSnapshot } from '../core/types';
import { GRID_COLS, GRID_ROWS } from '../core/constants';
import { DEFAULT_LAYERS, type LayerName } from './contracts';
import { fmtDuration } from './format';
import { button, h, icon, keyChip, panel, setText, slider, type IconName } from './widgets';

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

export class DisasterRail {
  readonly el: HTMLElement;
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
    dp.body.append(
      this.pickBanner,
      sliders,
      list,
      this.activeTitle,
      this.activeEmpty,
      this.activeList,
    );

    const lp = panel({ title: 'Layers', cls: 'layers-panel', collapsible: false });
    const grid = h('div', 'layer-grid');
    const L: { name: LayerName; label: string; key: string }[] = [
      { name: 'grid', label: 'Grid', key: 'G' },
      { name: 'flow', label: 'Power flow', key: 'F' },
      { name: 'labels', label: 'Labels', key: 'L' },
      { name: 'status', label: 'Status', key: 'S' },
    ];
    for (const l of L) {
      const b = h('button', { class: 'toggle', type: 'button', 'aria-pressed': String(this.layers[l.name]) }, h('span', { text: l.label }), keyChip(l.key));
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
