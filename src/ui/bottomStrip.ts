import type { LogEntry, MetricSample, SimSnapshot } from '../core/types';
import { clockFromMin, fmtCompact } from './format';
import { C, h, numberTween, panel } from './widgets';

const MAX_LOG = 60;

interface Kpi {
  key: string;
  label: string;
  unit: string;
  fmt: (v: number) => string;
  value: (s: SimSnapshot) => number;
  tone?: (v: number) => string;
}

const KPIS: Kpi[] = [
  { key: 'supply', label: 'Supply', unit: 'MW', fmt: (v) => v.toFixed(1), value: (s) => s.metrics.supplyKW / 1000 },
  { key: 'demand', label: 'Demand', unit: 'MW', fmt: (v) => v.toFixed(1), value: (s) => s.metrics.demandKW / 1000 },
  {
    key: 'served',
    label: 'Served',
    unit: '%',
    fmt: (v) => String(Math.round(v)),
    value: (s) => (s.metrics.demandKW > 0 ? (s.metrics.allocatedKW / s.metrics.demandKW) * 100 : 100),
    tone: (v) => (v >= 95 ? 'green' : v >= 80 ? 'yellow' : v >= 50 ? 'orange' : 'coral'),
  },
  {
    key: 'critical',
    label: 'Critical gap',
    unit: 'kW',
    fmt: (v) => fmtCompact(v),
    value: (s) => s.metrics.criticalUnservedKW,
    tone: (v) => (v > 0.5 ? 'coral' : ''),
  },
  { key: 'damage', label: 'Damage', unit: 'units', fmt: (v) => fmtCompact(v), value: (s) => s.metrics.cumulativeDamage },
];

export interface StripCallbacks {
  onSelect(id: string): void;
}

export class BottomStrip {
  readonly el: HTMLElement;
  private kpis: { def: Kpi; card: HTMLElement; tween: ReturnType<typeof numberTween>; tone: string }[] = [];
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
      const card = h(
        'div',
        { class: 'kpi card', 'data-key': def.key },
        h('span', 'kpi-label', def.label),
        h('span', 'kpi-line', num, h('span', 'kpi-unit', def.unit)),
      );
      kpiGrid.append(card);
      this.kpis.push({ def, card, tween: numberTween(num, def.fmt), tone: '' });
    }

    this.canvas = h('canvas', { class: 'chart', role: 'img', 'aria-label': 'Supply, demand and allocated power over time' });
    this.ctx = this.canvas.getContext('2d')!;
    this.chartEmpty = h('div', 'chart-empty muted', 'Waiting for data');
    const legend = h(
      'div',
      'legend',
      h('span', 'lg', h('i', 'sw supply'), 'Supply'),
      h('span', 'lg', h('i', 'sw demand'), 'Demand'),
      h('span', 'lg', h('i', 'sw alloc'), 'Allocated'),
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
      const v = k.def.value(s);
      k.tween.set(v);
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
    const key = `${hist.length}|${last?.tMin}|${last?.supplyKW}|${last?.demandKW}|${last?.allocatedKW}|${Math.round(rect.width)}x${Math.round(rect.height)}`;
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
    for (const p of hist) max = Math.max(max, p.supplyKW, p.demandKW, p.allocatedKW);
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
    g.fillText(clockFromMin(t0).text, L, H - 3);
    g.textAlign = 'right';
    g.fillText(clockFromMin(t1).text, W - R, H - 3);
  }
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  for (const s of steps) if (v * 1.05 <= s) return s;
  return Math.ceil(v * 1.1);
}
