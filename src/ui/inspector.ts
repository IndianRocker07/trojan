import type { Feeder, SimSnapshot, UtilityAgentState } from '../core/types';
import { createWorker } from './character';
import { DossierView } from './dossier';
import { NegotiationTab } from './negotiationTab';
import type { AgentHistory, Ring } from './history';
import { bufferBlock, dependentsBlock, derBlock } from './microgrid';
import { KIND_LABEL, fmtKW, fmtTele, pct, teleLabel, fmtDuration } from './format';
import {
  button,
  chip,
  gauge,
  h,
  panel,
  powerBar,
  segmented,
  setText,
  sparkline,
  statusPill,
} from './widgets';

export interface InspectorCallbacks {
  onClose(): void;
  onFocus(id: string): void;
  onSelect(id: string): void;
}

type Tab = 'inspect' | 'agents' | 'negotiation';

interface TeleRow {
  key: string;
  val: HTMLElement;
  spark: ReturnType<typeof sparkline>;
}

interface Detail {
  id: string;
  root: HTMLElement;
  pill: ReturnType<typeof statusPill>;
  update(s: SimSnapshot): void;
}

const KIND_TONE: Record<string, string> = { water: 'blue', telecom: 'lilac', school: 'pink' };

export class Inspector {
  readonly el: HTMLElement;
  private tabs;
  private tab: Tab = 'inspect';
  private emptyView: HTMLElement;
  private detailHost: HTMLElement;
  private rosterView: HTMLElement;
  private rosterList: HTMLElement;
  private rosterMore: HTMLElement;
  private roster = new Map<string, { row: HTMLButtonElement; dot: HTMLElement; urg: HTMLElement; bar: ReturnType<typeof powerBar>; pill: HTMLElement }>();
  private rosterOrder = '';
  private rosterKey = '';
  private detail: Detail | null = null;
  private selected: string | null = null;
  private feederIdx: { src: Feeder[]; map: Map<string, Feeder> } | null = null;
  private title: HTMLElement;
  private negTab: NegotiationTab;
  /** The one scroll region: header and tabs stay fixed, the tab content scrolls. */
  private bodyEl: HTMLElement;

  constructor(
    private cb: InspectorCallbacks,
    private history: AgentHistory,
  ) {
    const p = panel({ title: 'Inspector', cls: 'inspector' });
    this.title = p.titleEl;
    this.tabs = segmented<Tab>({
      label: 'Right panel view',
      options: [
        { value: 'inspect', label: 'Inspect' },
        { value: 'agents', label: 'Agents' },
        { value: 'negotiation', label: 'Negotiation' },
      ],
      value: 'inspect',
      cls: 'tabs',
      onChange: (t) => this.showTab(t),
    });
    p.head.insertBefore(this.tabs.el, p.head.lastElementChild);

    const browse = button({ label: 'Browse agents', cls: 'small', onClick: () => this.showTab('agents') });
    this.emptyView = h(
      'div',
      'empty',
      h('div', 'empty-art', createWorker()),
      h('p', 'empty-title', 'Click any building to inspect its agent'),
      h('p', 'muted', 'Every hospital, pump, tower and shelter reports its own live demand, urgency and backup.'),
      h('div', 'chip-row tight', browse, button({ label: 'Negotiation', cls: 'small', onClick: () => this.showTab('negotiation') })),
    );
    this.detailHost = h('div', 'detail');
    this.rosterList = h('div', 'roster-list');
    this.rosterMore = h('p', 'muted small-note');
    this.rosterView = h('div', 'roster', h('p', 'muted small-note', 'Sorted by urgency. Click to focus.'), this.rosterList, this.rosterMore);
    this.negTab = new NegotiationTab({ onSelect: (id) => this.cb.onSelect(id) });
    this.negTab.el.hidden = true;
    p.body.append(this.emptyView, this.detailHost, this.rosterView, this.negTab.el);
    this.bodyEl = p.body;
    p.body.tabIndex = 0;
    p.body.setAttribute('role', 'region');
    p.body.setAttribute('aria-label', 'Inspector content');
    this.el = h('aside', { class: 'rail rail-right', 'aria-label': 'Inspector' }, p.el);
    this.applyView();
  }

  get selectedId() {
    return this.selected;
  }

  showTab(t: Tab) {
    if (t !== this.tab) this.bodyEl.scrollTop = 0;
    this.tab = t;
    this.tabs.set(t);
    this.applyView();
  }

  private applyView() {
    const showDetail = this.tab === 'inspect' && this.selected !== null;
    this.emptyView.hidden = !(this.tab === 'inspect' && this.selected === null);
    this.detailHost.hidden = !showDetail;
    this.rosterView.hidden = this.tab !== 'agents';
    this.negTab.el.hidden = this.tab !== 'negotiation';
  }

  reset() {
    this.detail = null;
    this.detailHost.replaceChildren();
    this.roster.clear();
    this.rosterList.replaceChildren();
    this.rosterKey = '';
    this.rosterOrder = '';
    this.feederIdx = null;
    this.negTab.reset();
  }

  setSelected(id: string | null, s: SimSnapshot) {
    if (id === this.selected && (id === null || this.detail?.id === id)) return;
    this.selected = id;
    this.detail = null;
    this.detailHost.replaceChildren();
    if (id && s.buildings[id]) {
      this.bodyEl.scrollTop = 0;
      this.history.track(s.agents[id]);
      this.detail = this.buildDetail(id, s);
      this.detailHost.append(this.detail.root);
      this.tab = 'inspect';
      this.tabs.set('inspect');
      this.detail.update(s);
    } else {
      this.selected = null;
    }
    this.applyView();
  }

  update(s: SimSnapshot) {
    if (this.detail && this.selected) {
      if (!s.buildings[this.selected]) this.setSelected(null, s);
      else this.detail.update(s);
    }
    if (this.tab === 'agents') this.updateRoster(s);
    if (this.tab === 'negotiation') this.negTab.update(s);
  }

  // ───────────────────────── detail ─────────────────────────

  private feeder(s: SimSnapshot, consumerId: string): Feeder | undefined {
    const src = s.network.feeders;
    if (!this.feederIdx || this.feederIdx.src !== src) {
      const map = new Map<string, Feeder>();
      for (const f of src) map.set(f.consumerId, f);
      this.feederIdx = { src, map };
    }
    return this.feederIdx.map.get(consumerId);
  }

  private buildDetail(id: string, s0: SimSnapshot): Detail {
    const b = s0.buildings[id];
    const kindChip = chip(KIND_LABEL[b.kind], KIND_TONE[b.kind] ?? '');
    const pill = statusPill();
    const focus = button({ icon: 'target', cls: 'icon small', aria: 'Focus camera on this building', title: 'Focus camera', onClick: () => this.cb.onFocus(id) });
    const close = button({ icon: 'close', cls: 'icon small', aria: 'Deselect building (Esc)', title: 'Deselect (Esc)', onClick: () => this.cb.onClose() });
    const root = h(
      'div',
      'detail-inner',
      h('div', 'detail-head', h('h3', 'detail-name', b.name), h('div', 'detail-actions', focus, close)),
      h('div', 'chip-row', kindChip, pill.el),
    );

    const updaters: ((s: SimSnapshot) => void)[] = [];
    const agent0 = s0.agents[id];

    if (agent0) {
      // ── power
      const bar = powerBar();
      const allocT = h('span', 'mono strong');
      const demT = h('span', 'mono');
      const minT = h('span', 'mono');
      root.append(
        h(
          'section',
          'block',
          h('h4', 'section-title', 'Power'),
          bar.el,
          h('div', 'pbar-legend', h('span', null, allocT, ' of ', demT, ' wanted'), h('span', 'muted', 'min safe ', minT)),
        ),
      );
      // ── bid
      const crit = h('span', 'tile-val');
      const urg = h('span', 'tile-val');
      const dmg = h('span', 'tile-val');
      const tok = h('span', 'tile-val');
      const urgFill = gauge('urgency');
      const tile = (label: string, val: HTMLElement, extra?: Node) => h('div', 'tile', h('span', 'tile-label', label), val, extra);
      root.append(
        h(
          'section',
          'block',
          h('h4', 'section-title', 'Bid'),
          h('div', 'tiles', tile('Criticality', crit), tile('Urgency', urg, urgFill.el), tile('Damage per hour', dmg), tile('Tokens', tok)),
        ),
      );
      // ── microgrid: prosumer DER, utility buffer, dependents (each hides itself when its data is absent)
      const der = derBlock();
      const buf = bufferBlock();
      const deps = dependentsBlock((bid) => this.cb.onSelect(bid));
      root.append(der.el, buf.el, deps.el);
      updaters.push((s) => {
        const a = s.agents[id];
        if (!a) return;
        der.update(a);
        buf.update(a, s);
        deps.update(a, s);
      });
      // ── negotiation dossier
      const dossier = new DossierView(id, { onSelect: (bid) => this.cb.onSelect(bid) });
      root.append(dossier.el);
      updaters.push((s) => dossier.update(s));
      // ── telemetry
      const rows: TeleRow[] = [];
      const table = h('div', 'tele');
      const tbody = h('div', { class: 'tele-body', role: 'table', 'aria-label': 'Live telemetry' });
      table.append(tbody);
      root.append(h('section', 'block', h('h4', 'section-title', 'Live telemetry'), table));
      const waterBody = h('div', { class: 'tele-body', role: 'table', 'aria-label': 'Water telemetry' });
      const waterBlock = h('section', 'block', h('h4', 'section-title', 'Water'), h('div', 'tele', waterBody));
      waterBlock.hidden = true;
      const addRow = (key: string) => {
        const val = h('span', 'mono tele-val');
        const sp = sparkline(72, 22);
        const row = h('div', { class: 'tele-row', role: 'row' }, h('span', 'tele-label', teleLabel(key)), val, sp.el);
        if (key.startsWith('water') && key !== 'waterLiters') {
          waterBody.append(row);
          waterBlock.hidden = false;
        } else tbody.append(row);
        rows.push({ key, val, spark: sp });
      };
      for (const k of Object.keys(agent0.telemetry)) addRow(k);
      root.append(waterBlock);

      // ── backup
      let backupBlock: HTMLElement | null = null;
      let bkG: ReturnType<typeof gauge> | null = null;
      let bkText: HTMLElement | null = null;
      if (agent0.backup.type !== 'none') {
        bkG = gauge('backup');
        bkText = h('span', 'mono');
        backupBlock = h(
          'section',
          'block',
          h('h4', 'section-title', 'Backup power'),
          h('div', 'chip-row', chip(agent0.backup.type === 'diesel' ? 'Diesel' : 'Battery', 'yellow'), h('span', 'muted', `${fmtKW(agent0.backup.maxKW)} max`)),
          bkG.el,
          h('div', 'pbar-legend', bkText),
        );
        root.append(backupBlock);
      }

      // ── feeder
      const fSub = h('span', 'strong');
      const fSpans = h('span', 'mono');
      const fState = h('span', 'chip');
      root.append(
        h(
          'section',
          'block',
          h('h4', 'section-title', 'Feeder path'),
          h('div', 'kv', h('span', 'muted', 'Substation'), fSub),
          h('div', 'kv', h('span', 'muted', 'Spans'), fSpans),
          h('div', 'kv', h('span', 'muted', 'Health'), fState),
        ),
      );

      updaters.push((s) => {
        const a = s.agents[id];
        if (!a) return;
        const status = s.buildings[id].status;
        const draw = backupDraw(a);
        bar.set({ demand: a.demandKW, allocated: a.allocatedKW, backup: draw, minSafe: a.minSafeKW, status });
        setText(allocT, fmtKW(a.allocatedKW));
        setText(demT, fmtKW(a.demandKW));
        setText(minT, fmtKW(a.minSafeKW));
        setText(crit, pct(a.criticality));
        setText(urg, pct(a.urgency));
        urgFill.set(a.urgency);
        setText(dmg, Math.round(a.expectedDamagePerHour).toLocaleString('en-US'));
        setText(tok, String(Math.round(a.tokens)));
        const rings = this.history.get(id);
        for (const k of Object.keys(a.telemetry)) if (!rows.some((r) => r.key === k)) addRow(k);
        for (const r of rows) {
          const v = a.telemetry[r.key];
          setText(r.val, fmtTele(r.key, v));
          const ring: Ring | undefined = rings?.get(r.key);
          if (ring) r.spark.draw(ring.toArray(), ring.ver);
        }
        if (bkG && bkText) {
          const f = a.backup.capacityKWh > 0 ? a.backup.remainingKWh / a.backup.capacityKWh : 0;
          bkG.set(f);
          const hrs = a.backup.maxKW > 0 ? a.backup.remainingKWh / a.backup.maxKW : 0;
          setText(bkText, `${pct(f)} left, about ${hrs.toFixed(1)} h at full draw`);
        }
        const f = this.feeder(s, id);
        if (f) {
          const sub = s.buildings[f.substationId];
          const broken = f.edgeIds.reduce((n, e) => n + (s.network.edges[e]?.status === 'broken' ? 1 : 0), 0);
          setText(fSub, sub ? sub.name : f.substationId);
          setText(fSpans, `${f.edgeIds.length}`);
          const txt = broken ? `${broken} broken` : a.connected ? 'All intact' : 'Disconnected';
          setText(fState, txt);
          fState.className = `chip ${broken || !a.connected ? 'coral' : 'green'}`;
        } else {
          setText(fSub, 'n/a');
          setText(fSpans, '0');
          setText(fState, a.connected ? 'Connected' : 'Disconnected');
          fState.className = `chip ${a.connected ? 'green' : 'coral'}`;
        }
      });
    } else if (b.kind === 'generator') {
      const bar = powerBar();
      const outT = h('span', 'mono strong');
      const capT = h('span', 'mono');
      const fuel = h('span', 'mono');
      const st = h('span', 'chip');
      root.append(
        h('section', 'block', h('h4', 'section-title', 'Output'), bar.el, h('div', 'pbar-legend', h('span', null, outT, ' of ', capT))),
        h('section', 'block', h('h4', 'section-title', 'Plant'), h('div', 'kv', h('span', 'muted', 'Fuel'), fuel), h('div', 'kv', h('span', 'muted', 'State'), st)),
      );
      updaters.push((s) => {
        const g = s.generators[id];
        if (!g) return;
        const status = g.status === 'running' ? 'online' : g.status === 'tripped' ? 'offline' : 'destroyed';
        bar.set({ demand: g.capacityKW, allocated: g.outputKW, backup: 0, minSafe: 0, status });
        setText(outT, fmtKW(g.outputKW));
        setText(capT, fmtKW(g.capacityKW));
        setText(fuel, Number.isFinite(g.fuelHours) ? fmtDuration(g.fuelHours * 60) : 'n/a');
        setText(st, g.status === 'running' ? 'Running' : g.status === 'tripped' ? 'Tripped' : 'Destroyed');
        st.className = `chip ${g.status === 'running' ? 'green' : 'coral'}`;
      });
    } else {
      // substation
      const loadT = h('span', 'mono strong');
      const nT = h('span', 'mono');
      const brk = h('span', 'chip');
      root.append(
        h(
          'section',
          'block',
          h('h4', 'section-title', 'Distribution'),
          h('div', 'kv', h('span', 'muted', 'Load'), loadT),
          h('div', 'kv', h('span', 'muted', 'Consumers fed'), nT),
          h('div', 'kv', h('span', 'muted', 'Feeders'), brk),
        ),
      );
      updaters.push((s) => {
        let load = 0;
        let n = 0;
        let bad = 0;
        for (const f of s.network.feeders) {
          if (f.substationId !== id) continue;
          n++;
          load += s.agents[f.consumerId]?.allocatedKW ?? 0;
          if (f.edgeIds.some((e) => s.network.edges[e]?.status === 'broken')) bad++;
        }
        setText(loadT, fmtKW(load));
        setText(nT, String(n));
        setText(brk, bad ? `${bad} cut` : 'All intact');
        brk.className = `chip ${bad ? 'coral' : 'green'}`;
      });
    }

    return {
      id,
      root,
      pill,
      update: (s) => {
        const bd = s.buildings[id];
        if (bd) pill.set(bd.status);
        for (const u of updaters) u(s);
      },
    };
  }

  // ───────────────────────── roster ─────────────────────────

  private updateRoster(s: SimSnapshot) {
    const agents = Object.values(s.agents).filter((a) => a.kind !== 'house');
    const key = agents.map((a) => a.buildingId).join(',');
    if (key !== this.rosterKey) {
      this.rosterKey = key;
      this.roster.clear();
      this.rosterList.replaceChildren();
      this.rosterOrder = '';
      for (const a of agents) {
        const b = s.buildings[a.buildingId];
        const dot = h('span', 'dot');
        const urg = h('span', 'mono urg');
        const bar = powerBar(true);
        const pill = h('span', 'roster-kind', KIND_LABEL[a.kind]);
        const row = h(
          'button',
          { class: 'roster-row', type: 'button', 'data-id': a.buildingId },
          h('span', 'roster-top', dot, h('span', 'roster-name', b?.name ?? a.buildingId), urg),
          h('span', 'roster-sub', pill, bar.el),
        );
        row.addEventListener('click', () => this.cb.onSelect(a.buildingId));
        this.roster.set(a.buildingId, { row, dot, urg, bar, pill });
        this.rosterList.append(row);
      }
    }
    const sorted = [...agents].sort((x, y) => y.urgency - x.urgency || y.criticality - x.criticality);
    const order = sorted.map((a) => a.buildingId).join(',');
    if (order !== this.rosterOrder) {
      this.rosterOrder = order;
      for (const a of sorted) this.rosterList.append(this.roster.get(a.buildingId)!.row);
    }
    for (const a of sorted) {
      const r = this.roster.get(a.buildingId)!;
      const st = s.buildings[a.buildingId]?.status ?? 'online';
      r.dot.dataset.status = st;
      r.row.dataset.status = st;
      setText(r.urg, `${Math.round(a.urgency * 100)}%`);
      r.bar.set({ demand: a.demandKW, allocated: a.allocatedKW, backup: backupDraw(a), minSafe: a.minSafeKW, status: st });
      r.row.classList.toggle('selected', a.buildingId === this.selected);
    }
    const houses = Object.keys(s.agents).length - agents.length;
    setText(this.rosterMore, houses > 0 ? `+ ${houses} houses. Click one on the map to inspect it.` : '');
  }
}

/** kW currently drawn from backup (SPEC 6.4). */
export function backupDraw(a: UtilityAgentState): number {
  const deficit = Math.max(0, a.demandKW - a.allocatedKW);
  if (deficit <= 0 || a.backup.type === 'none' || a.backup.remainingKWh <= 0) return 0;
  return Math.min(a.backup.maxKW, deficit);
}
