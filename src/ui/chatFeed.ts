/**
 * Live negotiation chat feed (docs/STORY.md §4.4). Incremental append, <= MAX_BUBBLES DOM bubbles,
 * grouped by sim minute, filterable, auto-scrolls unless the reader scrolled up.
 */
import type { FeedMessage, SimSnapshot } from '../core/types';
import { kindAvatar } from './avatars';
import { GLOSSARY, MSG_TAG, STANCE_PLAIN, TIP } from './explain';
import { STANCE_LABEL, STANCE_TONE, clockFromMin, fmtKW } from './format';
import { resolveAgent, selectableId } from './negViews';
import { tipProps } from './tip';
import { h, icon, segmented } from './widgets';

export const MAX_BUBBLES = 300;

export type FeedFilter = 'all' | 'concessions' | 'safety' | 'island';

export interface FeedCallbacks {
  onSelect(buildingId: string): void;
  /** Returns false when the replay has scrolled out of the snapshot. */
  onReplay(replayId: string, opener: HTMLElement): boolean;
  onUnread(n: number): void;
}

interface Group {
  el: HTMLElement;
  vis: number;
  size: number;
}
interface Rec {
  m: FeedMessage;
  el: HTMLElement;
  group: Group;
  shown: boolean;
  replayBtn?: HTMLButtonElement;
  expired: boolean;
}

const EMPTY_TEXT: Record<FeedFilter, string> = {
  all: 'Nothing yet. Messages appear here when the utility agents start negotiating for power.',
  concessions: 'No concessions or contracts yet.',
  safety: 'No safety-layer messages yet.',
  island: 'Click a building (or a name in the feed) to follow its island.',
};

type Data = Record<string, number | string>;

function numOf(d: Data, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)) return +v;
  }
  return undefined;
}
function strOf(d: Data, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export class ChatFeed {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private jump: HTMLButtonElement;
  private recs: Rec[] = [];
  private head = 0;
  private lastId: string | null = null;
  private curGroup: Group | null = null;
  private curT = NaN;
  private filter: FeedFilter = 'all';
  private selected: string | null = null;
  private island: number | null = null;
  private stick = true;
  private visible = false;
  private unread = 0;
  private replayKey = '';
  private replaySet = new Set<string>();
  private off: HTMLElement;
  private seg;
  private sv: SimSnapshot | null = null;

  constructor(private cb: FeedCallbacks) {
    this.seg = segmented<FeedFilter>({
      label: 'Filter messages',
      options: [
        { value: 'all', label: 'All' },
        { value: 'concessions', label: 'Concessions' },
        { value: 'safety', label: 'Safety' },
        { value: 'island', label: 'Island', aria: 'Selected island' },
      ],
      value: 'all',
      cls: 'feed-filter',
      onChange: (f) => this.setFilter(f),
    });
    const help = h('details', 'fd-help', h('summary', null, 'What do these numbers mean?'));
    const dl = h('dl', 'fd-gloss');
    for (const g of GLOSSARY) dl.append(h('dt', null, g.term), h('dd', null, g.text));
    help.append(dl);

    this.off = h('p', 'dossier-msg fd-off', 'The negotiation policy is off, so there is no conversation to show. Switch Policy to Negotiation in the top bar.');
    this.off.hidden = true;
    this.empty = h('p', 'dossier-msg fd-empty', EMPTY_TEXT.all);
    this.list = h('div', { class: 'fd-list', role: 'log', 'aria-live': 'off', 'aria-label': 'Live negotiation messages', tabindex: 0 });
    this.list.addEventListener('scroll', () => {
      this.stick = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 28;
      if (this.stick) this.jump.hidden = true;
    });
    this.jump = h('button', { class: 'btn small fd-jump', type: 'button', hidden: true }, icon('chevron', 16), h('span', { text: 'New messages' }));
    this.jump.addEventListener('click', () => this.scrollEnd(true));
    this.el = h(
      'section',
      { class: 'panel feed-panel', 'aria-label': 'Live negotiation' },
      h('h2', 'sr-only', 'Live negotiation'),
      h('div', 'fd-top', this.seg.el, help),
      this.off,
      h('div', 'fd-body', this.list, this.empty, this.jump),
    );
  }

  // ───────────────────────── public ─────────────────────────

  setVisible(v: boolean) {
    this.visible = v;
    if (v) {
      this.unread = 0;
      this.cb.onUnread(0);
      if (this.stick) requestAnimationFrame(() => this.scrollEnd(false));
    }
  }

  setSelected(id: string | null) {
    this.selected = id;
    if (this.sv) this.syncIsland(this.sv);
  }

  reset() {
    this.list.replaceChildren();
    this.recs = [];
    this.head = 0;
    this.lastId = null;
    this.curGroup = null;
    this.curT = NaN;
    this.replayKey = '';
    this.replaySet.clear();
    this.stick = true;
    this.jump.hidden = true;
    this.syncEmpty();
  }

  /** Total bubbles in the DOM. */
  get bubbleCount() {
    return this.recs.length - this.head;
  }

  update(s: SimSnapshot) {
    this.sv = s;
    const n = s.negotiation;
    this.off.hidden = !!n;
    if (!n) return;
    this.syncIsland(s);
    const feed = n.feed ?? [];
    const rs = n.replays ?? [];
    const key = `${rs.length}:${rs[0]?.id ?? ''}:${rs[rs.length - 1]?.id ?? ''}`;
    if (key !== this.replayKey) {
      this.replayKey = key;
      this.replaySet = new Set(rs.map((r) => r.id));
      this.sweepExpired();
    }
    if (!feed.length) {
      if (this.lastId) this.reset();
      return;
    }
    let start = 0;
    if (this.lastId) {
      let i = feed.length - 1;
      while (i >= 0 && feed[i].id !== this.lastId) i--;
      if (i === feed.length - 1) return; // nothing new
      if (i < 0) {
        this.reset();
        this.replayKey = key;
        this.replaySet = new Set(rs.map((r) => r.id));
        start = Math.max(0, feed.length - MAX_BUBBLES);
      } else start = i + 1;
    } else start = Math.max(0, feed.length - MAX_BUBBLES);
    this.append(feed, Math.max(start, feed.length - MAX_BUBBLES), s);
  }

  // ───────────────────────── internals ─────────────────────────

  private syncIsland(s: SimSnapshot) {
    let isl: number | null = null;
    const sel = this.selected;
    const n = s.negotiation;
    if (sel && n) {
      isl = n.agents[resolveAgent(sel, n)]?.islandId ?? null;
      if (isl == null) isl = s.islands?.find((i) => i.consumerIds.includes(sel) || i.prosumerIds.includes(sel))?.id ?? null;
    }
    if (isl !== this.island) {
      this.island = isl;
      if (this.filter === 'island') this.refilter();
    }
  }

  private setFilter(f: FeedFilter) {
    this.filter = f;
    this.refilter();
    this.scrollEnd(false);
  }

  private pass(m: FeedMessage): boolean {
    switch (this.filter) {
      case 'concessions':
        return m.kind === 'concession' || m.kind === 'contract';
      case 'safety':
        return m.kind === 'safety' || m.from === 'safety' || m.fromKind === 'safety';
      case 'island':
        return this.island != null && m.islandId === this.island;
      default:
        return true;
    }
  }

  private live(): Rec[] {
    return this.head ? this.recs.slice(this.head) : this.recs;
  }

  private refilter() {
    const live = this.live();
    const groups = new Set<Group>();
    for (const r of live) {
      r.group.vis = 0;
      groups.add(r.group);
    }
    for (const r of live) {
      r.shown = this.pass(r.m);
      r.el.hidden = !r.shown;
      if (r.shown) r.group.vis++;
    }
    for (const g of groups) g.el.hidden = g.vis === 0;
    this.syncEmpty();
  }

  private syncEmpty() {
    const any = this.live().some((r) => r.shown);
    this.empty.hidden = any;
    this.list.hidden = !any;
    this.empty.textContent = EMPTY_TEXT[this.filter];
  }

  private append(feed: FeedMessage[], start: number, s: SimSnapshot) {
    const frag = document.createDocumentFragment();
    const touched = new Set<Group>();
    let added = 0;
    let shownNew = 0;
    for (let i = start; i < feed.length; i++) {
      const m = feed[i];
      if (!this.curGroup || m.tMin !== this.curT) {
        const c = clockFromMin(m.tMin);
        const el = h('div', 'fd-group', h('div', 'fd-time', h('span', { text: `Day ${c.day} · ${c.text}` })));
        this.curGroup = { el, vis: 0, size: 0 };
        this.curT = m.tMin;
        frag.append(el);
      }
      const g = this.curGroup;
      const rec = this.makeBubble(m, g, s);
      rec.shown = this.pass(m);
      rec.el.hidden = !rec.shown;
      if (rec.shown) {
        g.vis++;
        shownNew++;
      }
      g.size++;
      g.el.append(rec.el);
      touched.add(g);
      this.recs.push(rec);
      this.lastId = m.id;
      added++;
    }
    if (!added) return;
    for (const g of touched) g.el.hidden = g.vis === 0;
    this.list.append(frag);
    while (this.recs.length - this.head > MAX_BUBBLES) {
      const r = this.recs[this.head++];
      r.el.remove();
      r.group.size--;
      if (r.shown) r.group.vis--;
      if (r.group.size <= 0) r.group.el.remove();
    }
    if (this.head > 600) {
      this.recs = this.recs.slice(this.head);
      this.head = 0;
    }
    this.syncEmpty();
    if (!this.visible) {
      this.unread += shownNew;
      this.cb.onUnread(this.unread);
    }
    if (this.stick) this.scrollEnd(false);
    else if (shownNew) this.jump.hidden = false;
  }

  private scrollEnd(smooth: boolean) {
    this.list.scrollTo({ top: this.list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    this.stick = true;
    this.jump.hidden = true;
  }

  private sweepExpired() {
    for (const r of this.live()) {
      if (r.replayBtn && !r.expired && !this.replaySet.has(r.m.replayId!)) this.expire(r);
    }
  }

  private expire(r: Rec) {
    r.expired = true;
    if (!r.replayBtn) return;
    r.replayBtn.disabled = true;
    r.replayBtn.replaceChildren(h('span', { text: 'Replay expired' }));
    r.replayBtn.setAttribute('aria-label', 'Replay expired: it is no longer stored');
  }

  private makeBubble(m: FeedMessage, group: Group, s: SimSnapshot): Rec {
    const sys = m.fromKind === 'clearing' || m.fromKind === 'safety' || m.from === 'clearing' || m.from === 'safety';
    const role = m.fromKind === 'safety' || m.from === 'safety' ? 'safety' : m.fromKind === 'clearing' || m.from === 'clearing' ? 'clearing' : 'agent';
    const sel = sys ? null : selectableId(m.from, s);
    const who = sel
      ? h('button', { class: 'ref fd-name', type: 'button', text: m.fromName, 'aria-label': `${m.fromName}: select this building` })
      : h('span', { class: 'fd-name', text: m.fromName });
    if (sel) who.addEventListener('click', () => this.cb.onSelect(sel));
    const meta = h('div', 'fd-meta', who, h('span', 'fd-tag', MSG_TAG[m.kind] ?? m.kind), h('span', 'fd-isl', `Island ${m.islandId}`));
    const body = h('div', 'fd-bubble', meta, h('p', 'fd-text', m.text));
    const av = kindAvatar(m.fromKind, 32);
    av.setAttribute('aria-hidden', 'true');
    const model = this.modelBox(m);
    if (model) body.append(model);
    const foot = this.numChips(m) ?? h('div', 'fd-nums');
    const el = h('div', { class: 'fd-msg', 'data-role': role, 'data-kind': m.kind }, av, body);
    const rec: Rec = { m, el, group, shown: true, expired: false };
    if (m.replayId) {
      const b = h('button', { class: 'btn small fd-replay', type: 'button', 'aria-label': `Watch the replay of this negotiation: ${m.fromName}` }, icon('play', 16), h('span', { text: 'Watch replay' }));
      b.dataset.replay = m.replayId;
      b.addEventListener('click', () => {
        if (!this.cb.onReplay(m.replayId!, b)) this.expire(rec);
      });
      foot.append(b);
      rec.replayBtn = b;
      if (this.replayKey && !this.replaySet.has(m.replayId)) this.expire(rec);
    }
    if (foot.childElementCount) body.append(foot);
    return rec;
  }

  /** "Model output" box: Jev / Heuristic badge + the raw scores. */
  private modelBox(m: FeedMessage): HTMLElement | null {
    const d = m.data;
    if (!d) return null;
    const urgency = numOf(d, 'urgency', 'jevUrgency');
    const damage = numOf(d, 'damage', 'jevDamage');
    const risk = numOf(d, 'risk', 'imminentFailureRisk', 'jevRisk', 'failureRisk');
    const concede = numOf(d, 'canConcede', 'jevCanConcede');
    const conf = numOf(d, 'confidence', 'jevConfidence', 'conf');
    let source = (strOf(d, 'source', 'perceptionSource', 'provider') ?? '').toLowerCase();
    const has = [urgency, damage, risk, concede, conf].some((v) => v !== undefined);
    if (!source && has) source = Object.keys(d).some((k) => k.startsWith('jev')) ? 'jev' : '';
    if (!has && !source) return null;
    const box = h('div', { class: 'fd-model', role: 'group', 'aria-label': `Model output from ${source === 'heuristic' ? 'the built-in heuristic' : 'Jev'}`, ...tipProps(TIP.model) });
    if (source === 'jev' || source === 'heuristic') {
      box.append(h('span', { class: `fd-src ${source}`, text: source === 'jev' ? 'Jev' : 'Heuristic', ...tipProps(source === 'jev' ? TIP.source_jev : TIP.source_heuristic) }));
    }
    const mc = (label: string, v: number | undefined, tip: string, fmt: (x: number) => string = (x) => x.toFixed(2)) => {
      if (v !== undefined) box.append(h('span', { class: 'mchip', text: `${label} ${fmt(v)}`, ...tipProps(tip) }));
    };
    mc('urgency', urgency, TIP.urgency);
    mc('damage', damage, TIP.damage);
    mc('risk', risk, TIP.risk);
    mc('can concede', concede, TIP.canConcede, (x) => `${Math.round((x <= 1 ? x : x / 100) * 100)}%`);
    mc('conf', conf, TIP.confidence);
    return box;
  }

  private numChips(m: FeedMessage): HTMLElement | null {
    const d = m.data;
    if (!d) return null;
    const row = h('div', 'fd-nums');
    const add = (label: string, v: number | undefined, tip: string, tone = '') => {
      if (v !== undefined) row.append(h('span', { class: `chip fd-chip ${tone}`.trim(), text: `${label} ${fmtKW(v)}`, ...tipProps(tip) }));
    };
    add('Asked', numOf(d, 'requestKW', 'request'), TIP.request);
    add('Floor', numOf(d, 'minSafeKW', 'floorKW', 'minSafe'), TIP.floor);
    add('Got', numOf(d, 'grantKW', 'grantedKW', 'finalKW'), TIP.grant, 'green');
    add('Short', numOf(d, 'deficitKW'), TIP.deficit, 'yellow');
    add('Gave up', numOf(d, 'concededKW', 'concessionKW'), TIP.conceded);
    const st = strOf(d, 'stance');
    if (st && STANCE_LABEL[st]) row.append(h('span', { class: `chip fd-chip ${STANCE_TONE[st] ?? ''}`.trim(), text: STANCE_LABEL[st], ...tipProps(STANCE_PLAIN[st]) }));
    return row;
  }
}
