/** Utility dossier: everything the negotiation layer knows about one consumer (or house cluster). */
import type { AgentDossier, BidRecord, ForwardContract, LedgerEntry, Perception, SimSnapshot } from '../core/types';
import {
  CONTRACT_LABEL,
  LEDGER_LABEL,
  MODE_HINT,
  MODE_LABEL,
  MODE_TONE,
  SOURCE_LABEL,
  STANCE_LABEL,
  STANCE_TONE,
  fmtClock,
  fmtKW,
  fmtSigned,
  pct,
} from './format';
import { agentLink, explanationView, priorityView, resolveAgent } from './negViews';
import { C, chip, gauge, h, setText } from './widgets';

const MAX_ROWS = 60;

interface HistRow {
  key: number;
  el: HTMLElement;
  head: HTMLButtonElement;
  body: HTMLElement;
  detail?: { expl: ReturnType<typeof explanationView>; prio: ReturnType<typeof priorityView> };
  rec: BidRecord;
  stance: HTMLElement;
}

export const NEG_OFF_TEXT = 'Negotiation engine off — switch Policy to Negotiation';

export class DossierView {
  readonly el: HTMLElement;
  private msg = h('p', 'muted dossier-msg');
  private body = h('div', 'dossier-body');
  private agentId: string | null = null;

  // status
  private modeChip = h('span', 'chip');
  private modeHint = h('span', 'muted small');
  private clusterNote = h('p', 'cluster-note');
  private reasons = h('ul', 'notes');
  private reasonKey = '';
  private island = h('p', 'small');
  // bid
  private bidVals = new Map<string, HTMLElement>();
  // brief
  private stance = h('span', 'chip');
  private source = h('span', 'chip');
  private briefMeta = h('span', 'muted small');
  private argument = h('p', 'reason');
  private offer = h('p', 'reason');
  private meters = new Map<string, { g: ReturnType<typeof gauge>; t: HTMLElement }>();
  // allocation
  private prio = priorityView();
  private expl = explanationView();
  // history
  private rows = new Map<number, HistRow>();
  private expanded = new Set<number>();
  private histList = h('ul', { class: 'hist', 'aria-label': 'Bid history, newest first' });
  private histCount = h('span', 'muted small');
  private spark = h('canvas', 'hist-spark');
  private sparkKey = '';
  private order = '';
  // tokens
  private tokVal = h('span', 'tile-val');
  private ledger = h('ul', 'ledger');
  private ledgerKey = '';
  private contracts = h('ul', 'contracts');
  private contractKey = '';

  constructor(
    private buildingId: string,
    private cb: { onSelect(id: string): void },
  ) {
    this.body.append(
      h('div', 'dsec', h('div', 'chip-row tight', this.modeChip, this.modeHint), this.clusterNote, this.island, h('h5', 'sub-title', 'Why affected'), this.reasons),
      h('div', 'dsec', h('h5', 'sub-title', 'Current bid'), this.bidTiles()),
      h('div', 'dsec', h('h5', 'sub-title', 'Priority breakdown'), this.prio.el),
      h('div', 'dsec', h('h5', 'sub-title', 'Case brief'), this.briefBlock()),
      h('div', 'dsec', h('h5', 'sub-title', 'Allocation: why this much'), this.expl.el),
      h('div', 'dsec', h('div', 'sub-row', h('h5', 'sub-title', 'Bid history'), this.histCount), this.sparkBlock(), this.histList),
      h('div', 'dsec', h('h5', 'sub-title', 'Tokens'), h('div', 'tile tok-tile', h('span', 'tile-label', 'Balance'), this.tokVal), this.ledger),
      h('div', 'dsec', h('h5', 'sub-title', 'Forward contracts'), this.contracts),
    );
    const sum = h('summary', 'dossier-sum', h('span', 'section-title', 'Negotiation dossier'));
    this.el = h('details', { class: 'block dossier', open: true }, sum, this.msg, this.body);
    this.histList.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('.hist-head');
      if (t) this.toggle(Number((t.closest('li') as HTMLElement).dataset.k));
    });
  }

  private bidTiles() {
    const tiles = h('div', 'tiles tiles3');
    for (const [k, label] of [
      ['request', 'Request'],
      ['floor', 'Min-safe floor'],
      ['flex', 'Flexible'],
      ['conceded', 'Conceded'],
      ['tokens', 'Tokens offered'],
      ['backup', 'Backup hours'],
    ] as const) {
      const v = h('span', 'tile-val sm');
      this.bidVals.set(k, v);
      tiles.append(h('div', 'tile', h('span', 'tile-label', label), v));
    }
    return tiles;
  }

  private briefBlock() {
    const grid = h('div', 'meters');
    for (const [k, label] of [
      ['urgency', 'Urgency'],
      ['damage', 'Damage'],
      ['risk', 'Imminent risk'],
      ['concede', 'Can concede'],
    ] as const) {
      const g = gauge(k === 'concede' ? 'backup' : 'urgency');
      const t = h('span', 'mono');
      this.meters.set(k, { g, t });
      grid.append(h('div', 'meter', h('span', 'meter-top', h('span', null, label), t), g.el));
    }
    return h(
      'div',
      null,
      h('div', 'chip-row tight', this.stance, this.source, this.briefMeta),
      h('p', 'lbl', 'Primary argument'),
      this.argument,
      h('p', 'lbl', 'Concession offer'),
      this.offer,
      grid,
    );
  }

  private sparkBlock() {
    this.spark.width = 640;
    this.spark.height = 96;
    this.spark.setAttribute('role', 'img');
    return h('div', 'spark-wrap', this.spark, h('div', 'spark-legend', h('span', 'lg-req', 'Request (dashed)'), h('span', 'lg-fin', 'Final grant (solid)')));
  }

  // ───────────────────────── update ─────────────────────────

  update(s: SimSnapshot) {
    const n = s.negotiation;
    if (!n) return this.empty(NEG_OFF_TEXT);
    const id = resolveAgent(this.buildingId, n);
    const d = n.agents[id];
    if (!d) return this.empty('This building takes no part in negotiation.');
    this.msg.hidden = true;
    this.body.hidden = false;
    if (id !== this.agentId) this.switchAgent(id);
    this.status(d, s);
    this.bid(d.current);
    this.brief(d.current, d.perception, d.perceptionAgeMin);
    if (d.current) {
      this.prio.set(d.current.explanation.priority);
      this.expl.set(d.current.explanation);
    }
    this.history(d.history);
    setText(this.tokVal, d.tokens.toFixed(1));
    this.ledgerList(n.ledger, id);
    this.contractList(n.contracts, d, id, s);
  }

  private empty(text: string) {
    setText(this.msg, text);
    this.msg.hidden = false;
    this.body.hidden = true;
  }

  private switchAgent(id: string) {
    this.agentId = id;
    this.rows.clear();
    this.expanded.clear();
    this.histList.replaceChildren();
    this.order = '';
    this.sparkKey = '';
    this.ledgerKey = '';
    this.contractKey = '';
  }

  private status(d: AgentDossier, s: SimSnapshot) {
    setText(this.modeChip, MODE_LABEL[d.mode] ?? d.mode);
    this.modeChip.className = `chip ${MODE_TONE[d.mode] ?? ''}`;
    setText(this.modeHint, MODE_HINT[d.mode] ?? '');
    this.clusterNote.hidden = !d.memberIds;
    if (d.memberIds) setText(this.clusterNote, `Household cluster of ${d.memberIds.length} homes. They negotiate together as one utility.`);
    const rk = d.affectedReasons.join('|');
    if (rk !== this.reasonKey) {
      this.reasonKey = rk;
      this.reasons.replaceChildren(...(d.affectedReasons.length ? d.affectedReasons : ['Not affected by the crisis']).map((r) => h('li', { text: r })));
    }
    const tr = s.negotiation!.islands.find((i) => i.islandId === d.islandId);
    const def = tr ? Math.max(0, tr.totalRequestKW - tr.supplyKW) : 0;
    setText(this.island, d.islandId === null ? 'Not on an island' : `Island ${d.islandId}${tr ? ` · deficit ${fmtKW(def)} of ${fmtKW(tr.totalRequestKW)} requested` : ''}`);
  }

  private bid(rec?: BidRecord) {
    const b = rec?.bid;
    const set = (k: string, v: string) => setText(this.bidVals.get(k)!, b ? v : '—');
    set('request', fmtKW(b?.requestKW ?? 0));
    set('floor', fmtKW(b?.minSafeKW ?? 0));
    set('flex', fmtKW(b?.flexibleKW ?? 0));
    set('conceded', fmtKW(b?.concededKW ?? 0));
    set('tokens', (b?.tokensOffered ?? 0).toFixed(1));
    set('backup', b && Number.isFinite(b.backupHours) ? `${b.backupHours.toFixed(1)} h` : 'n/a');
  }

  private brief(rec: BidRecord | undefined, p: Perception | undefined, age: number | undefined) {
    const br = rec?.brief;
    setText(this.stance, br ? STANCE_LABEL[br.stance] : 'No brief yet');
    this.stance.className = `chip ${br ? STANCE_TONE[br.stance] : ''}`;
    const src = p?.source ?? br?.perceptionSource ?? 'none';
    setText(this.source, `Perception: ${SOURCE_LABEL[src]}`);
    this.source.className = `chip ${src === 'jev' ? 'lilac' : ''}`;
    setText(this.briefMeta, `${age == null ? 'no reading' : `${Math.round(age)} min old`} · confidence ${p ? pct(p.confidence) : br ? pct(br.jevConfidence) : '—'}`);
    setText(this.argument, br?.primaryArgument ?? '—');
    setText(this.offer, br?.concessionOffer ?? '—');
    const m = (k: string, v: number | undefined) => {
      const e = this.meters.get(k)!;
      e.g.set(v ?? 0);
      setText(e.t, v == null ? '—' : pct(v));
    };
    m('urgency', p?.urgency ?? br?.jevUrgencyScore);
    m('damage', p?.damage ?? br?.jevDamageScore);
    m('risk', p?.imminentFailureRisk);
    m('concede', p?.canConcede);
  }

  // ───────────────────────── history ─────────────────────────

  private toggle(key: number) {
    const r = this.rows.get(key);
    if (!r) return;
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    this.syncRow(r);
  }

  private syncRow(r: HistRow) {
    const open = this.expanded.has(r.key);
    r.head.setAttribute('aria-expanded', String(open));
    r.body.hidden = !open;
    if (open) {
      if (!r.detail) {
        r.detail = { expl: explanationView(), prio: priorityView() };
        r.body.append(r.detail.prio.el, r.detail.expl.el);
      }
      r.detail.prio.set(r.rec.explanation.priority);
      r.detail.expl.set(r.rec.explanation);
    }
  }

  private makeRow(rec: BidRecord): HistRow {
    const k = rec.tMin;
    const stance = h('span', 'chip');
    const head = h(
      'button',
      { class: 'hist-head', type: 'button', 'aria-expanded': 'false' },
      h('span', 'mono hh', fmtClock(k)),
      h('span', 'mono hv', `ask ${fmtKW(rec.bid.requestKW)}`),
      h('span', 'mono hv strong', `→ ${fmtKW(rec.explanation.finalKW)}`),
      stance,
      h('span', 'hm', MODE_LABEL[rec.bid.mode]),
    );
    const body = h('div', 'hist-body');
    body.hidden = true;
    const el = h('li', { class: 'hist-row', 'data-k': String(k) }, head, body);
    const row: HistRow = { key: k, el, head, body, rec, stance };
    this.paintRow(row, rec);
    return row;
  }

  private paintRow(r: HistRow, rec: BidRecord) {
    r.rec = rec;
    setText(r.stance, STANCE_LABEL[rec.brief.stance]);
    r.stance.className = `chip ${STANCE_TONE[rec.brief.stance]}`;
  }

  private history(hist: BidRecord[]) {
    const win = hist.slice(-MAX_ROWS);
    const keep = new Set(win.map((r) => r.tMin));
    for (const [k, r] of this.rows) {
      if (!keep.has(k)) {
        r.el.remove();
        this.rows.delete(k);
      }
    }
    for (const rec of win) {
      let r = this.rows.get(rec.tMin);
      if (!r) {
        r = this.makeRow(rec);
        this.rows.set(rec.tMin, r);
      } else if (r.rec !== rec) {
        this.paintRow(r, rec);
        if (this.expanded.has(rec.tMin)) this.syncRow(r);
      }
    }
    const order = win.map((r) => r.tMin).join(',');
    if (order !== this.order) {
      this.order = order;
      const frag = document.createDocumentFragment();
      for (let i = win.length - 1; i >= 0; i--) frag.append(this.rows.get(win[i].tMin)!.el);
      this.histList.replaceChildren(frag);
    }
    setText(this.histCount, hist.length ? `showing ${win.length} of ${hist.length}` : 'no bids yet');
    this.drawSpark(hist);
  }

  private drawSpark(hist: BidRecord[]) {
    const key = `${hist.length}:${hist[hist.length - 1]?.tMin ?? -1}`;
    if (key === this.sparkKey) return;
    this.sparkKey = key;
    const c = this.spark;
    const ctx = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (hist.length < 2) return;
    let hi = 1;
    for (const r of hist) hi = Math.max(hi, r.bid.requestKW, r.explanation.finalKW);
    const px = (i: number) => 8 + (i / (hist.length - 1)) * (W - 16);
    const py = (v: number) => H - 8 - (v / hi) * (H - 16);
    const line = (get: (r: BidRecord) => number, dash: number[], color: string) => {
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      hist.forEach((r, i) => (i ? ctx.lineTo(px(i), py(get(r))) : ctx.moveTo(px(i), py(get(r)))));
      ctx.stroke();
    };
    line((r) => r.bid.requestKW, [12, 8], C.blue);
    line((r) => r.explanation.finalKW, [], C.ink);
    ctx.setLineDash([]);
    const last = hist[hist.length - 1];
    ctx.fillStyle = C.green;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px(hist.length - 1), py(last.explanation.finalKW), 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    c.setAttribute('aria-label', `Request versus final grant over ${hist.length} minutes. Latest: asked ${fmtKW(last.bid.requestKW)}, got ${fmtKW(last.explanation.finalKW)}.`);
  }

  // ───────────────────────── tokens & contracts ─────────────────────────

  private ledgerList(all: LedgerEntry[], id: string) {
    const mine = all.filter((e) => e.agentId === id).slice(-6).reverse();
    const key = mine.map((e) => `${e.tMin}:${e.delta}:${e.balance}`).join('|');
    if (key === this.ledgerKey) return;
    this.ledgerKey = key;
    this.ledger.replaceChildren(
      ...(mine.length
        ? mine.map((e) => h('li', null, h('span', 'mono hh', fmtClock(e.tMin)), h('span', 'ledger-r', LEDGER_LABEL[e.reason] ?? e.reason), h('span', 'mono strong', fmtSigned(e.delta)), h('span', 'mono muted', `= ${e.balance.toFixed(1)}`)))
        : [h('li', 'muted', 'No ledger entries yet')]),
    );
  }

  private contractList(all: ForwardContract[], d: AgentDossier, id: string, s: SimSnapshot) {
    const mine = all.filter((c) => c.giverId === id || c.receiverId === id || d.contractIds.includes(c.id));
    const key = mine.map((c) => `${c.id}:${c.status}`).join('|');
    if (key === this.contractKey) return;
    this.contractKey = key;
    this.contracts.replaceChildren(
      ...(mine.length
        ? mine.map((c) => {
            const giver = c.giverId === id;
            const other = giver ? c.receiverId : c.giverId;
            return h(
              'li',
              'contract',
              h('div', 'chip-row tight', chip(giver ? 'Yields now' : 'Receives now', giver ? 'yellow' : 'green'), chip(CONTRACT_LABEL[c.status] ?? c.status, c.status === 'defaulted' ? 'coral' : '')),
              h('p', 'small', `${giver ? 'Gives' : 'Gets'} ${fmtKW(c.nowKW)} until ${fmtClock(c.nowUntilMin)}, ${giver ? 'repaid' : 'returns'} ${fmtKW(c.laterKW)} ${fmtClock(c.laterFromMin)}–${fmtClock(c.laterToMin)}. Stake ${c.tokenStake} tokens. With `, agentLink(other, s, this.cb.onSelect)),
            );
          })
        : [h('li', 'muted', 'No contracts')]),
    );
  }
}
