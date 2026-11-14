/** "Negotiation" tab: island traces, Jev status, open contracts, safety audit feed. */
import type { AuditEntry, IslandTrace, NegotiationSnapshot, SafetySnapshot, SimSnapshot } from '../core/types';
import {
  CONTRACT_LABEL,
  REGIME_LABEL,
  REGIME_TONE,
  SEVERITY_LABEL,
  STANCE_LABEL,
  fmtClock,
  fmtKW,
  pct,
} from './format';
import { NEG_OFF_TEXT } from './dossier';
import { islandBreakdown, islandSummary } from './microgrid';
import { agentLink } from './negViews';
import { chip, h, setText } from './widgets';

interface IslandCard {
  el: HTMLElement;
  title: HTMLElement;
  regime: HTMLElement;
  fill: HTMLElement;
  req: HTMLElement;
  sup: HTMLElement;
  nums: HTMLElement;
  weights: HTMLElement;
  tbody: HTMLElement;
  rowKey: string;
  micro: HTMLElement;
  brk: ReturnType<typeof islandBreakdown>;
}

const AUDIT_MAX = 40;

export class NegotiationTab {
  readonly el: HTMLElement;
  private off = h('p', 'muted dossier-msg', NEG_OFF_TEXT);
  private negBody = h('div', 'neg-body');
  private jev = new Map<string, HTMLElement>();
  private islandHost = h('div', 'islands');
  private cards = new Map<number, IslandCard>();
  private baseTitle = h('h4', 'section-title', 'Islands');
  private baseHost = h('div', 'islands');
  private baseSection: HTMLElement = h('section', 'block');
  private baseRows = new Map<number, ReturnType<typeof islandSummary>>();
  private contractList = h('ul', 'contracts');
  private contractKey = '';
  private safetyOff = h('p', 'muted small', 'Safety layer off. Switch Safety to Safety layer to see the audit feed.');
  private safetyBody = h('div', 'safety-body');
  private viol = h('span', 'viol-num');
  private violBox = h('div', 'viol');
  private violText = h('span', 'viol-text');
  private counters = h('div', 'chip-row tight');
  private counterKey = '';
  private starving = h('div', 'starving');
  private starveKey = '';
  private audit = h('ul', 'audit');
  private auditKey = '';

  constructor(private cb: { onSelect(id: string): void }) {
    const jevGrid = h('div', 'jev');
    for (const [k, label] of [
      ['provider', 'Provider'],
      ['state', 'State'],
      ['flight', 'In flight'],
      ['calls', 'Calls'],
      ['errors', 'Errors'],
      ['latency', 'Avg latency'],
    ] as const) {
      const v = h('span', 'mono');
      this.jev.set(k, v);
      jevGrid.append(h('div', 'kv', h('span', 'muted', label), v));
    }
    const lastErr = h('p', 'small err');
    this.jev.set('lastError', lastErr);
    this.negBody.append(
      h('section', 'block', h('h4', 'section-title', 'Islands, latest minute'), this.islandHost),
      h('section', 'block', h('h4', 'section-title', 'Perception (Jev)'), jevGrid, lastErr),
      h('section', 'block', h('h4', 'section-title', 'Open contracts'), this.contractList),
    );
    this.violBox.append(this.viol, this.violText);
    this.safetyBody.append(this.violBox, this.counters, this.starving, this.audit);
    this.baseSection.append(this.baseTitle, this.baseHost);
    this.baseSection.hidden = true;
    this.el = h('div', 'neg-tab', this.off, this.baseSection, this.negBody, h('section', 'block', h('h4', 'section-title', 'Safety layer'), this.safetyOff, this.safetyBody));
  }

  reset() {
    this.cards.clear();
    this.baseRows.clear();
    this.baseHost.replaceChildren();
    this.islandHost.replaceChildren();
    this.contractKey = this.auditKey = this.starveKey = this.counterKey = '';
  }

  update(s: SimSnapshot) {
    const n = s.negotiation;
    this.off.hidden = !!n;
    this.negBody.hidden = !n;
    if (n) {
      this.jevStatus(n);
      this.islands(n.islands, s);
      this.contracts(n, s);
    }
    this.baseIslands(s);
    const sf = s.safety;
    this.safetyOff.hidden = !!sf;
    this.safetyBody.hidden = !sf;
    if (sf) this.safety(sf, s);
  }

  // ───────────────────────── Jev ─────────────────────────

  private jevStatus(n: NegotiationSnapshot) {
    const p = n.perception;
    const j = (k: string, v: string) => setText(this.jev.get(k)!, v);
    j('provider', p.provider);
    j('state', p.enabled ? 'Enabled' : 'Disabled');
    j('flight', String(p.inFlight));
    j('calls', String(p.calls));
    j('errors', String(p.errors));
    j('latency', p.avgLatencyMs ? `${Math.round(p.avgLatencyMs)} ms` : '—');
    const e = this.jev.get('lastError')!;
    e.hidden = !p.lastError;
    setText(e, p.lastError ? `Last error: ${p.lastError}` : '');
  }

  // ───────────────────────── islands ─────────────────────────

  private makeCard(): IslandCard {
    const title = h('h5', 'sub-title');
    const regime = h('span', 'chip');
    const fill = h('div', 'sr-supply');
    const req = h('div', 'sr-req');
    const sup = h('div', 'sr-tick');
    const nums = h('p', 'small mono');
    const weights = h('p', 'small muted');
    const tbody = h('tbody');
    const table = h('table', 'rounds', h('thead', null, h('tr', null, h('th', null, 'Round'), h('th', null, 'Deficit'), h('th', null, 'Concessions'))), tbody);
    const bar = h('div', { class: 'sr-bar', role: 'img' }, fill, sup);
    void req;
    const micro = chip('Microgrid', 'lilac');
    micro.hidden = true;
    const brk = islandBreakdown();
    brk.el.hidden = true;
    const el = h('div', 'island card-lite', h('div', 'sub-row', title, h('span', 'chip-row tight nomargin', micro, regime)), bar, nums, brk.el, weights, table);
    return { el, title, regime, fill, req, sup, nums, weights, tbody, rowKey: '', micro, brk };
  }

  private islands(traces: IslandTrace[], s: SimSnapshot) {
    const ids = new Set(traces.map((t) => t.islandId));
    for (const [id, c] of this.cards) {
      if (!ids.has(id)) {
        c.el.remove();
        this.cards.delete(id);
      }
    }
    if (!traces.length) {
      if (!this.islandHost.querySelector('.muted')) this.islandHost.replaceChildren(h('p', 'muted small', 'No islands traced yet.'));
      return;
    }
    this.islandHost.querySelector(':scope > p')?.remove();
    for (const t of traces) {
      let c = this.cards.get(t.islandId);
      if (!c) {
        c = this.makeCard();
        this.cards.set(t.islandId, c);
        this.islandHost.append(c.el);
      }
      const info = s.islands?.find((x) => x.id === t.islandId);
      c.micro.hidden = !info?.microgrid;
      c.brk.el.hidden = !info;
      if (info) c.brk.set(info);
      setText(c.title, `Island ${t.islandId} · ${t.activeAgents.length} active, ${t.cooperatingAgents.length} cooperating`);
      setText(c.regime, REGIME_LABEL[t.regime]);
      c.regime.className = `chip ${REGIME_TONE[t.regime]}`;
      const max = Math.max(t.supplyKW, t.totalRequestKW, 1);
      c.fill.style.width = `${(Math.min(t.supplyKW, t.totalRequestKW) / max) * 100}%`;
      c.sup.style.left = `${(t.supplyKW / max) * 100}%`;
      c.el.querySelector('.sr-bar')!.setAttribute('aria-label', `Supply ${fmtKW(t.supplyKW)} against requests of ${fmtKW(t.totalRequestKW)}`);
      setText(c.nums, `Supply ${fmtKW(t.supplyKW)} · asked ${fmtKW(t.totalRequestKW)} · floors ${fmtKW(t.totalMinSafeKW)}`);
      const w = t.weights;
      setText(c.weights, `Weights: criticality ${w.criticality.toFixed(2)}, urgency ${w.urgency.toFixed(2)}, damage ${w.damage.toFixed(2)}, tokens ${w.tokens.toFixed(2)}, fairness ${w.fairness.toFixed(2)}`);
      const key = t.rounds.map((r) => `${r.round}:${Math.round(r.deficitKW)}:${r.concessions.map((x) => x.agentId + Math.round(x.kw)).join(',')}`).join('|') + t.tMin;
      if (key !== c.rowKey) {
        c.rowKey = key;
        c.tbody.replaceChildren(
          ...t.rounds.map((r) => {
            const cc = h('td', 'conc');
            if (!r.concessions.length) cc.append(h('span', 'muted', 'none'));
            for (const x of r.concessions) {
              cc.append(h('span', 'conc-item', agentLink(x.agentId, s, this.cb.onSelect), h('span', 'mono', ` −${fmtKW(x.kw)}`), h('span', 'muted small', ` ${STANCE_LABEL[x.stance]}`)));
            }
            return h('tr', null, h('td', 'mono', String(r.round)), h('td', 'mono', fmtKW(r.deficitKW)), cc);
          }),
        );
      }
    }
  }

  /** Compact island list from snapshot.islands: all of them when negotiation is off, otherwise those without a trace. */
  private baseIslands(s: SimSnapshot) {
    const traced = new Set((s.negotiation?.islands ?? []).map((t) => t.islandId));
    const list = (s.islands ?? []).filter((i) => !traced.has(i.id));
    this.baseSection.hidden = list.length === 0;
    setText(this.baseTitle, traced.size ? 'Other islands, not negotiated' : 'Islands');
    const ids = new Set(list.map((i) => i.id));
    for (const [id, r] of this.baseRows) {
      if (!ids.has(id)) {
        r.el.remove();
        this.baseRows.delete(id);
      }
    }
    for (const i of list) {
      let r = this.baseRows.get(i.id);
      if (!r) {
        r = islandSummary();
        this.baseRows.set(i.id, r);
        this.baseHost.append(r.el);
      }
      r.set(i);
    }
  }

  // ───────────────────────── contracts ─────────────────────────

  private contracts(n: NegotiationSnapshot, s: SimSnapshot) {
    const open = n.contracts.filter((c) => c.status === 'open' || c.status === 'repaying');
    const key = open.map((c) => `${c.id}:${c.status}`).join('|');
    if (key === this.contractKey) return;
    this.contractKey = key;
    this.contractList.replaceChildren(
      ...(open.length
        ? open.map((c) =>
            h(
              'li',
              'contract',
              h('div', 'chip-row tight', chip(CONTRACT_LABEL[c.status], c.status === 'repaying' ? 'yellow' : 'green'), h('span', 'small muted', `${fmtClock(c.createdMin)} · stake ${c.tokenStake}`)),
              h('p', 'small', agentLink(c.giverId, s, this.cb.onSelect), ` yields ${fmtKW(c.nowKW)} now to `, agentLink(c.receiverId, s, this.cb.onSelect), `, who returns ${fmtKW(c.laterKW)} at ${fmtClock(c.laterFromMin)}–${fmtClock(c.laterToMin)}.`),
              c.note ? h('p', 'small muted', c.note) : null,
            ),
          )
        : [h('li', 'muted small', 'No open contracts')]),
    );
  }

  // ───────────────────────── safety ─────────────────────────

  private safety(sf: SafetySnapshot, s: SimSnapshot) {
    const bad = sf.violationsCommitted > 0;
    setText(this.viol, String(sf.violationsCommitted));
    setText(this.violText, bad ? 'Violations committed. Invariant broken!' : 'Violations committed. Invariant holds.');
    this.violBox.dataset.bad = String(bad);
    this.violBox.setAttribute('role', bad ? 'alert' : 'status');

    const ck = `${sf.triageEvents}|${Math.round(sf.maxEdgeUtilisation * 100)}|${JSON.stringify(sf.counts)}`;
    if (ck !== this.counterKey) {
      this.counterKey = ck;
      this.counters.replaceChildren(
        chip(`Triage events ${sf.triageEvents}`, sf.triageEvents ? 'yellow' : ''),
        chip(`Peak line load ${pct(sf.maxEdgeUtilisation)}`, sf.maxEdgeUtilisation > 0.95 ? 'coral' : ''),
        ...Object.entries(sf.counts).map(([r, c]) => chip(`${r} ${c}`)),
      );
    }
    const sk = sf.starving.map((x) => `${x.agentId}:${x.minutes}`).join('|');
    if (sk !== this.starveKey) {
      this.starveKey = sk;
      this.starving.replaceChildren(
        h('p', 'lbl', sf.starving.length ? `Starving now (${sf.starving.length}): below min safe` : 'Nobody below min safe'),
        ...sf.starving.map((x) => h('div', 'kv', agentLink(x.agentId, s, this.cb.onSelect), h('span', 'mono', `${x.minutes} min`))),
      );
    }
    const feed = sf.audit.slice(-AUDIT_MAX).reverse();
    const ak = feed.map((a) => `${a.tMin}${a.rule}${a.agentId ?? ''}${a.correctedKW ?? ''}`).join('|');
    if (ak !== this.auditKey) {
      this.auditKey = ak;
      this.audit.replaceChildren(...feed.map((a) => this.auditRow(a, s)));
    }
  }

  private auditRow(a: AuditEntry, s: SimSnapshot): HTMLElement {
    const fix = a.proposedKW != null && a.correctedKW != null ? ` ${fmtKW(a.proposedKW)} → ${fmtKW(a.correctedKW)}` : '';
    return h(
      'li',
      { class: 'audit-row', 'data-sev': a.severity },
      h('div', 'audit-top', h('span', 'sev', SEVERITY_LABEL[a.severity]), chip(a.rule), h('span', 'mono muted small', `${fmtClock(a.tMin)} · island ${a.islandId}`)),
      h('p', 'small', a.reason + fix, a.agentId ? ' ' : null, a.agentId ? agentLink(a.agentId, s, this.cb.onSelect) : null),
    );
  }
}

