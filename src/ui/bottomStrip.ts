import type { LogEntry, MetricSample, SimSnapshot } from '../core/types';
import { clockFromMin, fmtCompact, fmtKW } from './format';
import { C, h, numberTween, panel, setText } from './widgets';
import './kpi.css';

const MAX_LOG = 60;

interface Kpi {
  key: string;
  /** visible label, one line (the card's tooltip carries the full meaning) */
  label: string;
  /** full meaning, shown as the card tooltip */
  title: string;
  unit: string;
  fmt: (v: number) => string;
  value: (s: SimSnapshot) => number;
  /** colour of the left accent bar; the sub-line carries the same status as text */
  tone?: (v: number) => string;
  /** one short line under the value; '' leaves the reserved slot empty. Gets the card's value. */
  sub?: (s: SimSnapshot, v: number) => string;
  /** card is hidden when this returns false (field absent in older snapshots) */
  present?: (s: SimSnapshot) => boolean;
}

const servedTone = (v: number) => (v >= 95 ? 'green' : v >= 80 ? 'yellow' : v >= 50 ? 'orange' : 'coral');
const SERVED_WORD: Record<string, string> = { green: 'on target', yellow: 'stretched', orange: 'short', coral: 'severe' };

const KPIS: Kpi[] = [
  {
    key: 'supply',
    label: 'Supply',
    title: 'Power available to the grid right now',
    unit: 'MW',
    fmt: (v) => v.toFixed(1),
    value: (s) => s.metrics.supplyKW / 1000,
  },
  {
    key: 'demand',
    label: 'Demand',
    title: 'Power requested by consumers right now',
    unit: 'MW',
    fmt: (v) => v.toFixed(1),
    value: (s) => s.metrics.demandKW / 1000,
  },
  {
    key: 'served',
    label: 'Served',
    title: 'Share of demand that is allocated (allocated / demand)',
    unit: '%',
    fmt: (v) => String(Math.round(v)),
    value: (s) => (s.metrics.demandKW > 0 ? (s.metrics.allocatedKW / s.metrics.demandKW) * 100 : 100),
    tone: servedTone,
    sub: (_s, v) => SERVED_WORD[servedTone(v)],
  },
  {
    key: 'critical',
    label: 'Crit. gap',
    title: 'Critical gap: power still missing below each consumer’s safe minimum',
    unit: 'kW',
    fmt: (v) => fmtCompact(v),
    value: (s) => s.metrics.criticalUnservedKW,
    tone: (v) => (v > 0.5 ? 'coral' : ''),
    sub: (_s, v) => (v > 0.5 ? 'loads unmet' : 'critical met'),
  },
  {
    key: 'damage',
    label: 'Damage',
    title: 'Accumulated damage: expected damage times the unserved fraction, over time',
    unit: 'units',
    fmt: (v) => fmtCompact(v),
    value: (s) => s.metrics.cumulativeDamage,
  },
  {
    key: 'prosumer',
    label: 'Prosumer',
    title: 'Power exported into islands by prosumers (homes and buildings with their own generation)',
    unit: 'MW',
    fmt: (v) => v.toFixed(2),
    value: (s) => (s.metrics.prosumerKW ?? 0) / 1000,
    sub: (s) => `curtailed ${fmtKW(s.metrics.curtailedKW ?? 0)}`,
    present: (s) => s.metrics.prosumerKW != null,
  },
  {
    key: 'islands',
    label: 'Islands',
    title: 'Parts of the grid cut off from the main network, and how many of them are microgrids',
    unit: 'islands',
    fmt: (v) => String(Math.round(v)),
    value: (s) => s.metrics.islandCount ?? s.islands?.length ?? 0,
    sub: (s) => {
      const n = s.metrics.microgridCount ?? s.islands?.filter((i) => i.microgrid).length ?? 0;
      return `${n} microgrid${n === 1 ? '' : 's'}`;
    },
    present: (s) => s.metrics.islandCount != null || s.islands != null,
  },
];

export interface StripCallbacks {
  onSelect(id: string): void;
}

export class BottomStrip {
  readonly el: HTMLElement;
  private kpis: { def: Kpi; card: HTMLElement; tween: ReturnType<typeof numberTween>; tone: string; sub: HTMLElement }[] = [];
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private chartKey = '';
  private cw = 0;
  private ch = 0;
  private logEl: HTMLElement;
  private logs: LogEntry[] = [];
  private logDirty = true;
  private chartEmpty: HTMLElement;
  private lastSample: MetricSample | undefined;

  constructor(private cb: StripCallbacks) {
    const kpiGrid = h('div', 'kpis');
    for (const def of KPIS) {
      const num = h('span', 'kpi-num');
      // Every card gets the same sub-line slot, so values and units line up across the row.
      const sub = h('span', 'kpi-sub');
      const card = h(
        'div',
        { class: 'kpi card', 'data-key': def.key, title: def.title },
        h('span', 'kpi-label', def.label),
        h('span', 'kpi-body', h('span', 'kpi-val', num, h('span', 'kpi-unit', def.unit)), sub),
      );
      if (def.present) card.hidden = true;
      kpiGrid.append(card);
      this.kpis.push({ def, card, tween: numberTween(num, def.fmt), tone: '', sub });
    }

    this.canvas = h('canvas', { class: 'chart', role: 'img', 'aria-label': 'Supply, demand, allocated and prosumer power over time' });
    this.ctx = this.canvas.getContext('2d')!;
    this.chartEmpty = h('div', 'chart-empty muted', 'Waiting for data');
    const legend = h(
      'div',
      'legend',
      h('span', 'lg', h('i', 'sw supply'), 'Supply'),
      h('span', 'lg', h('i', 'sw demand'), 'Demand'),
      h('span', 'lg', h('i', 'sw alloc'), 'Allocated'),
      h('span', 'lg', h('i', 'sw pros'), 'Prosumer'),
    );
    const chartPanel = panel({ title: 'Power', cls: 'chart-card', titleExtra: legend, collapsible: false });
    chartPanel.body.append(h('div', 'chart-wrap', this.canvas, this.chartEmpty));
    new ResizeObserver(() => {
      this.chartKey = '';
    }).observe(this.canvas);

    this.logEl = h('div', { class: 'log', role: 'log', 'aria-label': 'Event log' });
    const logPanel = panel({ title: 'Events', cls: 'log-card', collapsible: false });
    logPanel.body.append(this.logEl);

    this.el = h('section', { class: 'strip', 'aria-label': 'Statistics' }, kpiGrid, chartPanel.el, logPanel.el);
  }

  reset(s: SimSnapshot) {
    this.logs = s.log.slice(-MAX_LOG);
    this.logDirty = true;
    this.chartKey = '';
  }

  pushLog(e: LogEntry) {
    this.logs.push(e);
    if (this.logs.length > MAX_LOG) this.logs.shift();
    this.logDirty = true;
  }

  update(s: SimSnapshot) {
    for (const k of this.kpis) {
      if (k.def.present) {
        const on = k.def.present(s);
        k.card.hidden = !on;
        if (!on) continue;
      }
      const v = k.def.value(s);
      k.tween.set(v);
      setText(k.sub, k.def.sub ? k.def.sub(s, v) : '');
      const tone = k.def.tone ? k.def.tone(v) : '';
      if (tone !== k.tone) {
        k.tone = tone;
        k.card.dataset.tone = tone;
      }
    }
    this.drawChart(s.history);
    if (this.logDirty) this.renderLog();
  }

  private renderLog() {
    this.logDirty = false;
    const frag = document.createDocumentFragment();
    for (let i = this.logs.length - 1; i >= 0; i--) {
      const e = this.logs[i];
      const inner = [
        h('i', 'lvl'),
        h('span', 'mono log-time', clockFromMin(e.tMin).text),
        h('span', 'log-msg', e.msg),
      ];
      const item = e.buildingId
        ? h('button', { class: 'log-item', type: 'button', 'data-level': e.level, 'aria-label': `${e.msg}. Select building.` }, ...inner)
        : h('div', { class: 'log-item', 'data-level': e.level }, ...inner);
      if (e.buildingId) {
        const id = e.buildingId;
        item.addEventListener('click', () => this.cb.onSelect(id));
      }
      frag.append(item);
    }
    this.logEl.replaceChildren(frag);
  }

  private drawChart(hist: MetricSample[]) {
    const last = hist[hist.length - 1];
    const rect = this.canvas.getBoundingClientRect();
    const key = `${hist.length}|${last?.tMin}|${last?.supplyKW}|${last?.demandKW}|${last?.allocatedKW}|${last?.prosumerKW}|${Math.round(rect.width)}x${Math.round(rect.height)}`;
    if (key === this.chartKey) return;
    this.chartKey = key;
    this.lastSample = last;
    this.chartEmpty.hidden = hist.length > 1;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(10, Math.round(rect.width));
    const H = Math.max(10, Math.round(rect.height));
    if (W !== this.cw || H !== this.ch || this.canvas.width !== W * dpr) {
      this.cw = W;
      this.ch = H;
      this.canvas.width = W * dpr;
      this.canvas.height = H * dpr;
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (hist.length < 2) return;

    const L = 38;
    const B = 18;
    const T = 6;
    const R = 6;
    const pw = W - L - R;
    const ph = H - B - T;
    let max = 0;
    for (const p of hist) max = Math.max(max, p.supplyKW, p.demandKW, p.allocatedKW, p.prosumerKW ?? 0);
    const maxMW = niceMax(max / 1000);
    const t0 = hist[0].tMin;
    const t1 = Math.max(hist[hist.length - 1].tMin, t0 + 60);
    const X = (t: number) => L + ((t - t0) / (t1 - t0)) * pw;
    const Y = (kw: number) => T + ph - (kw / 1000 / maxMW) * ph;

    // allocated area (flat green)
    g.fillStyle = C.green;
    g.beginPath();
    g.moveTo(X(hist[0].tMin), Y(0));
    for (const p of hist) g.lineTo(X(p.tMin), Y(p.allocatedKW));
    g.lineTo(X(hist[hist.length - 1].tMin), Y(0));
    g.closePath();
    g.fill();

    g.lineJoin = 'round';
    g.lineWidth = 2;
    // demand dashed blue
    g.strokeStyle = C.blue;
    g.setLineDash([6, 4]);
    g.beginPath();
    hist.forEach((p, i) => (i ? g.lineTo(X(p.tMin), Y(p.demandKW)) : g.moveTo(X(p.tMin), Y(p.demandKW))));
    g.stroke();
    g.setLineDash([]);
    // supply ink
    g.strokeStyle = C.ink;
    g.beginPath();
    hist.forEach((p, i) => (i ? g.lineTo(X(p.tMin), Y(p.supplyKW)) : g.moveTo(X(p.tMin), Y(p.supplyKW))));
    g.stroke();

    // prosumer supply: dotted orange (legend swatch is dotted too, so it is not colour alone)
    if (hist.some((p) => (p.prosumerKW ?? 0) > 0)) {
      g.strokeStyle = C.orange;
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.setLineDash([1, 6]);
      g.beginPath();
      hist.forEach((p, i) => (i ? g.lineTo(X(p.tMin), Y(p.prosumerKW ?? 0)) : g.moveTo(X(p.tMin), Y(p.prosumerKW ?? 0))));
      g.stroke();
      g.setLineDash([]);
      g.lineCap = 'butt';
      g.lineWidth = 2;
    }

    // ink axes
    g.strokeStyle = C.ink;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(L, T);
    g.lineTo(L, T + ph);
    g.lineTo(W - R, T + ph);
    g.stroke();
    g.fillStyle = C.ink;
    g.font = '500 12px "JetBrains Mono", ui-monospace, monospace';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillText(`${maxMW}`, L - 5, T + 6);
    g.fillText('0', L - 5, T + ph - 2);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillText(axisLabel(t0), L, H - 3);
    g.textAlign = 'right';
    g.fillText(axisLabel(t1), W - R, H - 3);
  }
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  for (const s of steps) if (v * 1.05 <= s) return s;
  return Math.ceil(v * 1.1);
}

/** hh:mm, with a day suffix once the run passes midnight (24 h scenarios). */
function axisLabel(tMin: number): string {
  const c = clockFromMin(tMin);
  return c.day > 1 ? `${c.text} D${c.day}` : c.text;
}
