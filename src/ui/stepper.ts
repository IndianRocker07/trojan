/**
 * Replay stepper (docs/STORY.md §4.5): floating stage-by-stage walkthrough of one recorded island negotiation.
 * It is the MASTER CLOCK: on every animation frame while open it calls `showReplay(replay, stage, progress)` on every
 * registered ReplayRenderer (theater + city overlay), and `showReplay(null, 0, 0)` on close.
 */
import type { NegotiationReplay, ReplayRenderer, ReplayStage, Stance } from '../core/types';
import { kindAvatar } from './avatars';
import { STAGE_HINT, STAGE_SHORT, STANCE_PLAIN, TIP } from './explain';
import { REGIME_LABEL, REGIME_TONE, STANCE_LABEL, STANCE_TONE, fmtClock, fmtKW } from './format';
import { tipProps } from './tip';
import { button, chip, h, icon, isMobile, reducedMotion, segmented, setText } from './widgets';

const STAGE_MS = 1200;
const MAX_ROWS = 12;
const DETAIL_ROWS = 12;

/** First sentence (or ~160 chars at a word boundary) plus the remainder. */
export function splitCaption(c: string): { lead: string; rest: string } {
  const t = c.trim();
  const m = /^(.{30,}?[.!?])(\s+|$)/.exec(t);
  let used = m ? m[0].length : t.length;
  let lead = m ? m[1] : t;
  if (lead.length > 160) {
    const cut = lead.lastIndexOf(' ', 160);
    const at = cut > 80 ? cut : 160;
    lead = `${lead.slice(0, at).replace(/[,;:\s]+$/, '')}…`;
    used = at;
  }
  return { lead, rest: t.slice(used).trim() };
}
const SPEEDS = [0.5, 1, 2];

export interface StepperCallbacks {
  /** Live list: renderers added later are picked up automatically. */
  renderers: ReplayRenderer[];
  onSelect(buildingId: string): void;
  /** The stepper closed. `byUser` is false when closed from code (reset, story mode finishing). */
  onClosed(byUser: boolean): void;
  /** Autoplay reached the end of the last stage. */
  onFinished(): void;
  /** The user touched the stepper (any click / key), used by story mode to keep it open. */
  onInteract(): void;
}

export interface OpenOptions {
  stage?: number;
  progress?: number;
  autoplay?: boolean;
  /** Move keyboard focus into the stepper (user-initiated opens). */
  focus?: boolean;
  /** Element to return focus to on close. */
  opener?: HTMLElement | null;
}

interface AgentState {
  req: number;
  orig: number;
  floor: number;
  grant: number | null;
  score: number | null;
  stance: Stance | null;
  tag: string;
  tagFull: string;
  perceptionTag: string;
}

interface Row {
  id: string;
  buildingIds: string[];
  tr: HTMLTableRowElement;
  tag: HTMLElement;
  stanceDesk: HTMLElement;
  stanceMob: HTMLElement;
  reqFill: HTMLElement;
  grantFill: HTMLElement;
  tick: HTMLElement;
  nums: HTMLElement;
  below: HTMLElement;
  score: HTMLElement;
  scale: number;
  lastReq: number;
  lastGrant: number;
  lastTick: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => 1 - Math.pow(1 - x, 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class ReplayStepper {
  readonly el: HTMLElement;
  private rep: NegotiationReplay | null = null;
  private stage = 0;
  private progress = 0;
  private playing = false;
  private speed = 1;
  private raf = 0;
  private last = 0;
  private opener: HTMLElement | null = null;
  private states: Map<string, AgentState>[] = [];
  private rows: Row[] = [];
  private nameOf = new Map<string, string>();
  private warned = false;

  private headline = h('h2', 'st-headline');
  private facts = h('div', 'st-facts');
  private pills = h('ol', { class: 'st-pills', 'aria-label': 'Negotiation stages' });
  private pillEls: HTMLButtonElement[] = [];
  private stageTitle = h('h3', 'st-stage-title');
  private caption = h('p', 'st-caption');
  private moreBtn: HTMLButtonElement;
  private more = h('div', 'st-more');
  private regimeSlot = h('span', 'st-regime');
  private order: string[] = [];
  private stepLabel = h('span', 'st-steplabel mono');
  private bar = h('div', 'gauge st-progress');
  private barFill = h('div', 'gauge-fill');
  private playBtn: HTMLButtonElement;
  private backBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private tbody = h('tbody');
  private live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  private detailsBtn: HTMLButtonElement;
  private speedSeg;

  constructor(private cb: StepperCallbacks) {
    this.backBtn = button({ icon: 'step', label: 'Back', cls: 'small st-back', aria: 'Previous stage', title: 'Previous stage (Left arrow)', onClick: () => this.go(this.stage - 1) });
    this.nextBtn = button({ icon: 'step', label: 'Next', cls: 'small st-next', aria: 'Next stage', title: 'Next stage (Right arrow)', onClick: () => this.go(this.stage + 1) });
    this.nextBtn.append(this.nextBtn.firstElementChild!); // icon after the label
    this.playBtn = button({ icon: 'play', label: 'Play', cls: 'small primary st-play', aria: 'Play', title: 'Play / pause (Space)', onClick: () => this.toggle() });
    this.speedSeg = segmented<number>({
      label: 'Replay speed',
      options: SPEEDS.map((v) => ({ value: v, label: `${v}×`, aria: `${v} times replay speed` })),
      value: 1,
      cls: 'st-speed',
      onChange: (v) => (this.speed = v),
    });
    this.detailsBtn = button({ icon: 'chevron', label: 'Agent table', cls: 'small st-toggle', aria: 'Show agent table', title: 'Show or hide the agent table', onClick: () => this.toggleDetails() });
    const closeBtn = button({ icon: 'close', cls: 'small icon', aria: 'Close replay', title: 'Close replay (Esc)', onClick: () => this.close(true) });
    this.bar.append(this.barFill);
    this.bar.setAttribute('aria-hidden', 'true');

    const legend = h(
      'div',
      'st-legend',
      h('span', 'lg', h('i', 'sw ask'), ' asked'),
      h('span', 'lg', h('i', 'sw got'), ' got'),
      h('span', { class: 'lg', ...tipProps(TIP.floor) }, h('i', 'sw floor'), ' safe floor'),
    );
    const table = h(
      'table',
      'st-table',
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col', text: 'Agent' }),
          h('th', { scope: 'col', class: 'c-stance', text: 'Stance' }),
          h('th', { scope: 'col', text: 'Asked vs got' }),
          h('th', { scope: 'col', class: 'c-score', ...tipProps(TIP.score), text: 'Score' }),
        ),
      ),
      this.tbody,
    );
    const tableWrap = h('div', 'st-tablewrap', table);

    this.moreBtn = h('button', { class: 'linkish st-morebtn', type: 'button', 'aria-expanded': 'false' }, 'Details');
    this.moreBtn.addEventListener('click', () => {
      const open = this.el.dataset.more !== 'open';
      this.el.dataset.more = open ? 'open' : 'closed';
      this.moreBtn.setAttribute('aria-expanded', String(open));
      this.moreBtn.textContent = open ? 'Hide details' : 'Details';
    });
    this.el = h(
      'section',
      { class: 'stepper card', role: 'region', 'aria-label': 'Negotiation replay stepper', tabindex: -1, hidden: true, 'data-details': 'closed', 'data-more': 'closed' },
      h('div', 'st-details', this.facts, legend, tableWrap),
      h('div', 'st-head', this.headline, this.regimeSlot, h('div', 'st-head-btns', this.detailsBtn, closeBtn)),
      this.pills,
      h('div', 'st-controls', this.backBtn, this.playBtn, this.nextBtn, this.bar, this.stepLabel, this.speedSeg.el),
      h('div', 'st-stage', h('div', 'st-stage-top', this.stageTitle, this.moreBtn), this.caption, this.more),
      this.live,
    );
    this.el.addEventListener('keydown', this.onKey);
    this.el.addEventListener('pointerdown', () => this.cb.onInteract());
  }

  get isOpen() {
    return this.rep !== null;
  }
  get replay() {
    return this.rep;
  }
  get isPlaying() {
    return this.playing;
  }

  open(r: NegotiationReplay, o: OpenOptions = {}) {
    if (this.rep) this.teardown();
    this.rep = r;
    this.opener = o.opener ?? null;
    this.stage = Math.max(0, Math.min(r.stages.length - 1, o.stage ?? 0));
    this.progress = clamp01(o.progress ?? 0);
    this.playing = !!o.autoplay && r.stages.length > 0;
    this.nameOf = new Map(r.participants.map((p) => [p.agentId, p.name]));
    this.buildStates(r);
    this.buildHeader(r);
    this.buildRows(r);
    this.el.hidden = false;
    this.el.dataset.details = 'closed';
    this.syncDetailsBtn();
    this.stageChanged(true);
    this.syncPlay();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    if (o.focus) this.el.focus({ preventScroll: true });
  }

  close(byUser = false) {
    if (!this.rep) return;
    const opener = this.opener;
    this.teardown();
    this.el.hidden = true;
    for (const r of this.cb.renderers) this.safe(() => r.showReplay(null, 0, 0));
    if (byUser && opener && opener.isConnected) opener.focus({ preventScroll: true });
    this.cb.onClosed(byUser);
  }

  pause() {
    this.playing = false;
    this.syncPlay();
  }

  // ───────────────────────── clock ─────────────────────────

  private teardown() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.rep = null;
    this.playing = false;
    this.rows = [];
    this.states = [];
    this.tbody.replaceChildren();
    this.pills.replaceChildren();
    this.pillEls = [];
  }

  private loop = (t: number) => {
    const r = this.rep;
    if (!r) return;
    const dt = Math.min(400, Math.max(0, t - this.last));
    this.last = t;
    if (this.playing) {
      this.progress += dt / (STAGE_MS / this.speed);
      while (this.progress >= 1) {
        if (this.stage < r.stages.length - 1) {
          this.stage++;
          this.progress -= 1;
          this.stageChanged(false);
        } else {
          this.progress = 1;
          this.playing = false;
          this.syncPlay();
          this.cb.onFinished();
          break;
        }
      }
    }
    this.render(r);
    if (this.rep === r) this.raf = requestAnimationFrame(this.loop);
  };

  private safe(fn: () => void) {
    try {
      fn();
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.error('ReplayRenderer threw (further errors suppressed)', e);
      }
    }
  }

  private render(r: NegotiationReplay) {
    const shown = reducedMotion() ? 1 : this.progress;
    for (const rd of this.cb.renderers) this.safe(() => rd.showReplay(r, this.stage, shown));
    const n = r.stages.length;
    this.barFill.style.width = `${n ? ((this.stage + this.progress) / n) * 100 : 0}%`;
    this.animateRows(reducedMotion() ? 1 : ease(clamp01(this.progress / 0.7)));
  }

  private go(i: number) {
    const r = this.rep;
    if (!r) return;
    this.stage = Math.max(0, Math.min(r.stages.length - 1, i));
    this.progress = 0;
    this.stageChanged(false);
  }

  private toggle() {
    const r = this.rep;
    if (!r) return;
    if (!this.playing && this.stage >= r.stages.length - 1 && this.progress >= 1) {
      this.stage = 0;
      this.progress = 0;
      this.stageChanged(false);
    }
    this.playing = !this.playing;
    this.last = performance.now();
    this.syncPlay();
  }

  private syncPlay() {
    const p = this.playing;
    this.playBtn.replaceChildren(icon(p ? 'pause' : 'play'), h('span', { text: p ? 'Pause' : 'Play' }));
    this.playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
  }

  private toggleDetails() {
    this.el.dataset.details = this.el.dataset.details === 'open' ? 'closed' : 'open';
    this.syncDetailsBtn();
    for (const row of this.rows) row.lastReq = row.lastGrant = row.lastTick = -1;
  }
  private syncDetailsBtn() {
    const open = this.el.dataset.details === 'open';
    this.detailsBtn.setAttribute('aria-expanded', String(open));
    this.detailsBtn.setAttribute('aria-label', open ? 'Hide agent table' : 'Show agent table');
    this.detailsBtn.setAttribute('aria-pressed', String(open));
    this.detailsBtn.classList.toggle('flip', !open);
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.rep) return;
    const t = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.close(true);
      return;
    }
    if (e.defaultPrevented || t.closest('.seg') || t.tagName === 'INPUT' || t.tagName === 'SELECT') return;
    this.cb.onInteract();
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      this.go(this.stage + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      this.go(this.stage - 1);
    } else if (e.key === ' ' && t.tagName !== 'BUTTON') {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    }
  };

  // ───────────────────────── per-open precompute ─────────────────────────

  private buildStates(r: NegotiationReplay) {
    this.states = [];
    let prev = new Map<string, AgentState>();
    for (const st of r.stages) {
      const cur = new Map<string, AgentState>();
      for (const [id, s] of prev) cur.set(id, { ...s, tag: '', tagFull: '', perceptionTag: s.perceptionTag });
      const get = (id: string): AgentState => {
        let s = cur.get(id);
        if (!s) {
          s = { req: 0, orig: 0, floor: 0, grant: null, score: null, stance: null, tag: '', tagFull: '', perceptionTag: '' };
          cur.set(id, s);
        }
        return s;
      };
      for (const b of st.bids ?? []) {
        const s = get(b.agentId);
        s.req = b.requestKW;
        s.orig = Math.max(b.originalRequestKW, b.requestKW);
        s.floor = b.minSafeKW;
        s.score = b.score;
        s.stance = b.stance;
        if (b.perception) {
          const p = b.perception;
          s.perceptionTag = `${p.source === 'jev' ? 'Jev' : 'Heuristic'}: urgency ${p.urgency.toFixed(2)}, damage ${p.damage.toFixed(2)}, can concede ${Math.round(p.canConcede * 100)}%`;
        }
      }
      if (st.grants) for (const [id, kw] of Object.entries(st.grants)) get(id).grant = kw;
      this.tagStage(st, get);
      this.states.push(cur);
      prev = cur;
    }
  }

  private nm(id: string) {
    return this.nameOf.get(id) ?? id;
  }

  private tagStage(st: ReplayStage, get: (id: string) => AgentState) {
    const set = (id: string, short: string, full = short) => {
      const s = get(id);
      s.tag = short;
      s.tagFull = full;
    };
    switch (st.kind) {
      case 'perceive':
        for (const b of st.bids ?? []) {
          const s = get(b.agentId);
          if (s.perceptionTag) set(b.agentId, s.perceptionTag);
          else set(b.agentId, 'Scored by its own rules');
        }
        break;
      case 'clear':
        for (const [id, kw] of Object.entries(st.phase1 ?? {})) {
          const s = get(id);
          set(id, kw >= s.floor - 0.5 ? `Safe floor covered: ${fmtKW(kw)}` : `Floor only partly covered: ${fmtKW(kw)}`);
        }
        break;
      case 'notice':
        for (const n of st.notices ?? []) set(n.agentId, `Told to expect ${fmtKW(n.projectedKW)} of ${fmtKW(n.requestKW)}`);
        break;
      case 'counter':
        for (const c of st.concessions ?? []) set(c.agentId, c.kw > 0.5 ? `Offers to give up ${fmtKW(c.kw)}` : 'Holds firm', c.text);
        break;
      case 'contract':
        for (const c of st.contracts ?? []) {
          set(c.giverId, `Yields ${fmtKW(c.nowKW)} now, repaid ${fmtKW(c.laterKW)} later`);
          set(c.receiverId, `Gets ${fmtKW(c.nowKW)} now, repays ${fmtKW(c.laterKW)} later`);
        }
        break;
      case 'safety':
        for (const c of st.corrections ?? []) {
          const d = c.finalKW - c.proposedKW;
          set(c.agentId, `Safety ${d < 0 ? 'trimmed' : 'raised'} it ${fmtKW(Math.abs(d))}`, `${c.rule}: ${c.reason}`);
        }
        break;
      case 'commit':
        for (const t of st.tokens ?? []) set(t.agentId, `Tokens ${t.delta >= 0 ? '+' : '−'}${Math.abs(t.delta).toFixed(1)}`, t.reason);
        break;
      default:
        break;
    }
  }

  private buildHeader(r: NegotiationReplay) {
    this.headline.textContent = r.headline;
    const regime = chip(REGIME_LABEL[r.regime] ?? r.regime, REGIME_TONE[r.regime] ?? '');
    regime.dataset.tip =
      r.regime === 'triage' ? 'Triage: there is not even enough power to cover everyone’s safe minimum, so the hub protects the most critical first.' : r.regime === 'shortage' ? 'Shortage: there is enough for everyone’s safe minimum but not for everything they asked for.' : 'Surplus: there is enough power for every request.';
    const f = (label: string, v: string, tip?: string) => h('span', { class: 'st-fact', ...(tip ? tipProps(tip) : {}) }, h('span', 'muted', label), h('span', 'mono strong', v));
    this.regimeSlot.replaceChildren(regime, ...(r.microgrid ? [chip('Microgrid', 'lilac')] : []));
    this.facts.replaceChildren(
      h('span', { class: 'st-fact mono', text: `${fmtClock(r.tMin)}` }),
      f('Supply', fmtKW(r.supplyKW)),
      f('Asked', fmtKW(r.totalRequestKW)),
      f('Safe floors', fmtKW(r.totalMinSafeKW), TIP.floor),
      ...(r.deficitKW > 0.5 ? [f('Short', fmtKW(r.deficitKW), TIP.deficit)] : []),
    );
    const kinds = r.stages.map((s) => s.kind);
    this.pills.replaceChildren();
    this.pillEls = r.stages.map((st, i) => {
      const dup = kinds.filter((k) => k === st.kind).length > 1;
      const label = STAGE_SHORT[st.kind] + (dup ? ` ${st.round}` : '');
      const b = h('button', { class: 'st-pill', type: 'button', 'data-state': 'todo', ...tipProps(`${st.title}. ${STAGE_HINT[st.kind]}`) }, h('span', 'st-mark', String(i + 1)), h('span', { text: label }));
      b.addEventListener('click', () => this.go(i));
      this.pills.append(h('li', null, b));
      return b;
    });
  }

  private buildRows(r: NegotiationReplay) {
    this.rows = [];
    const rows: HTMLElement[] = [];
    // utilities first by score (best score seen in any stage), then household clusters; at most MAX_ROWS rows
    const best = (id: string) => {
      let b = -1;
      for (const m of this.states) b = Math.max(b, m.get(id)?.score ?? -1);
      return b;
    };
    const util = r.participants.filter((p) => p.kind !== 'house').sort((a, b) => best(b.agentId) - best(a.agentId));
    const houses = r.participants.filter((p) => p.kind === 'house').sort((a, b) => best(b.agentId) - best(a.agentId));
    const sorted = [...util, ...houses];
    this.order = sorted.map((p) => p.agentId);
    const shownP = sorted.slice(0, MAX_ROWS);
    const hidden = sorted.slice(MAX_ROWS);
    for (const p of shownP) {
      let scale = 1;
      for (const m of this.states) {
        const s = m.get(p.agentId);
        if (s) scale = Math.max(scale, s.orig, s.req, s.grant ?? 0);
      }
      const name = h('button', { class: 'ref st-name', type: 'button', text: p.name, 'aria-label': `${p.name}: select this agent on the map` });
      const tag = h('div', 'st-tag');
      const stanceDesk = h('span', 'chip');
      const stanceMob = h('span', 'chip st-stance-mob');
      const reqFill = h('div', 'sb-req');
      const grantFill = h('div', 'sb-grant');
      const tick = h('div', 'sb-tick');
      const bars = h('div', { class: 'st-bars', role: 'img' }, reqFill, grantFill, tick);
      const nums = h('div', 'st-nums mono');
      const below = h('span', { class: 'chip coral st-below', text: 'Below floor', hidden: true, ...tipProps(TIP.floor) });
      const score = h('span', 'mono');
      const tr = h(
        'tr',
        { class: 'st-row' },
        h('td', 'c-name', h('div', 'st-namebox', kindAvatar(p.kind, 24), h('div', 'st-who', name, tag, stanceMob))),
        h('td', 'c-stance', stanceDesk),
        h('td', 'c-bars', bars, h('div', 'st-numrow', nums, below)),
        h('td', 'c-score', score),
      );
      const sel = () => {
        const id = p.buildingIds[0];
        if (id) {
          this.cb.onSelect(id);
          if (isMobile()) {
            this.el.dataset.details = 'closed';
            this.syncDetailsBtn();
          }
        }
      };
      tr.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        sel();
      });
      name.addEventListener('click', sel);
      rows.push(tr);
      this.rows.push({ id: p.agentId, buildingIds: p.buildingIds, tr, tag, stanceDesk, stanceMob, reqFill, grantFill, tick, nums, below, score, scale, lastReq: -1, lastGrant: -1, lastTick: -1 });
    }
    if (hidden.length) {
      const nh = hidden.filter((p) => p.kind === 'house').length;
      const no = hidden.length - nh;
      const parts = [no ? `${no} more utilities` : '', nh ? `${nh} more household clusters` : ''].filter(Boolean);
      rows.push(h('tr', 'st-more-row', h('td', { colspan: 4, class: 'muted', text: `and ${parts.join(' and ')}` })));
    }
    this.tbody.replaceChildren(...rows);
  }

  // ───────────────────────── stage change + animation ─────────────────────────

  private stageChanged(initial: boolean) {
    const r = this.rep;
    if (!r) return;
    const st: ReplayStage | undefined = r.stages[this.stage];
    const n = r.stages.length;
    this.pillEls.forEach((b, i) => {
      const state = i < this.stage ? 'done' : i === this.stage ? 'current' : 'todo';
      b.dataset.state = state;
      const mark = b.firstElementChild as HTMLElement;
      mark.textContent = state === 'done' ? '✓' : String(i + 1);
      if (state === 'current') b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
    const cur = this.pillEls[this.stage];
    if (cur) {
      const box = this.pills;
      const left = cur.parentElement!.offsetLeft;
      if (left < box.scrollLeft || left + cur.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = left - 24;
    }
    setText(this.stepLabel, n ? `Step ${this.stage + 1} of ${n}` : 'No steps');
    this.backBtn.disabled = this.stage <= 0;
    this.nextBtn.disabled = this.stage >= n - 1;
    if (!st) {
      this.stageTitle.textContent = 'This replay has no recorded stages';
      this.caption.textContent = '';
      this.more.replaceChildren();
      this.moreBtn.hidden = true;
      return;
    }
    this.stageTitle.textContent = st.title;
    const { lead, rest } = splitCaption(st.caption);
    this.caption.textContent = lead;
    this.caption.title = rest ? st.caption : '';
    this.renderMore(st, rest);
    const states = this.states[this.stage];
    for (const row of this.rows) {
      const s = states.get(row.id);
      const tag = s?.tag ?? '';
      row.tag.textContent = tag;
      row.tag.title = s?.tagFull && s.tagFull !== tag ? s.tagFull : '';
      row.tr.dataset.hot = String(tag !== '');
      const stance = s?.stance;
      for (const c of [row.stanceDesk, row.stanceMob]) {
        c.textContent = stance ? STANCE_LABEL[stance] : '–';
        c.className = c === row.stanceMob ? `chip st-stance-mob ${stance ? STANCE_TONE[stance] : ''}` : `chip ${stance ? STANCE_TONE[stance] : ''}`;
        if (stance) c.dataset.tip = STANCE_PLAIN[stance];
        else delete c.dataset.tip;
      }
      setText(row.score, s?.score != null ? s.score.toFixed(2) : '–');
      const short = !!s && s.grant != null && s.floor > 0.5 && s.grant < s.floor - 0.5;
      row.below.hidden = !short;
      row.tr.dataset.short = String(short);
      setText(row.nums, !s || (s.req <= 0 && s.grant == null) ? '–' : s.grant == null ? `asks ${fmtKW(s.req)}` : `${fmtKW(s.grant)} of ${fmtKW(s.req)}`);
      const lbl = !s ? 'No bid yet' : `Asked ${fmtKW(s.req)}${s.grant != null ? `, got ${fmtKW(s.grant)}` : ''}${s.floor > 0 ? `, safe floor ${fmtKW(s.floor)}` : ''}`;
      row.reqFill.parentElement!.setAttribute('aria-label', lbl);
      row.lastReq = row.lastGrant = row.lastTick = -1;
    }
    this.live.textContent = `Step ${this.stage + 1} of ${n}: ${st.title}. ${st.caption}`;
    if (!initial) this.animateRows(reducedMotion() ? 1 : ease(clamp01(this.progress / 0.7)));
  }

  /** Details panel: one row per agent (name + what it offered / what changed). Falls back to the caption remainder. */
  private renderMore(st: ReplayStage, rest: string) {
    const items: { id: string; text: string }[] = [];
    for (const c of st.concessions ?? []) items.push({ id: c.agentId, text: c.text });
    for (const c of st.contracts ?? []) items.push({ id: c.giverId, text: `yields ${fmtKW(c.nowKW)} now to ${this.nm(c.receiverId)}, who gives back ${fmtKW(c.laterKW)} later` });
    for (const c of st.corrections ?? []) items.push({ id: c.agentId, text: `${c.reason} (${fmtKW(c.proposedKW)} → ${fmtKW(c.finalKW)})` });
    if (st.kind === 'notice') for (const n of st.notices ?? []) items.push({ id: n.agentId, text: `expects ${fmtKW(n.projectedKW)} of the ${fmtKW(n.requestKW)} it asked for` });
    if (st.kind === 'commit') for (const t of st.tokens ?? []) items.push({ id: t.agentId, text: `tokens ${t.delta >= 0 ? '+' : '−'}${Math.abs(t.delta).toFixed(1)}: ${t.reason}` });
    const rank = (id: string) => {
      const i = this.order.indexOf(id);
      return i < 0 ? 1e6 : i;
    };
    items.sort((a, b) => rank(a.id) - rank(b.id));
    const kids: HTMLElement[] = [];
    if (items.length) {
      const ul = h('ul', 'st-agents');
      for (const it of items.slice(0, DETAIL_ROWS)) {
        const p = this.rep?.participants.find((x) => x.agentId === it.id);
        const name = p ? h('button', { class: 'ref st-name', type: 'button', text: this.nm(it.id) }) : h('span', { class: 'st-name', text: this.nm(it.id) });
        if (p?.buildingIds[0]) name.addEventListener('click', () => this.cb.onSelect(p.buildingIds[0]));
        const txt = h('span', { class: 'st-agent-text', text: it.text, title: it.text });
        txt.addEventListener('click', () => txt.classList.toggle('open'));
        ul.append(h('li', 'st-agent', name, txt));
      }
      if (items.length > DETAIL_ROWS) ul.append(h('li', 'muted', `and ${items.length - DETAIL_ROWS} more`));
      kids.push(ul);
    } else if (rest) kids.push(h('p', 'st-rest', rest));
    else if (st.kind === 'safety') kids.push(h('p', 'st-rest', 'The safety layer found nothing to correct: the plan is safe as proposed.'));
    this.more.replaceChildren(...kids);
    this.moreBtn.hidden = kids.length === 0;
    if (kids.length === 0) this.el.dataset.more = 'closed';
  }

  private animateRows(e: number) {
    if (!this.rep || this.el.dataset.details === 'closed') return;
    const cur = this.states[this.stage];
    const prev = this.stage > 0 ? this.states[this.stage - 1] : null;
    for (const row of this.rows) {
      const c = cur.get(row.id);
      if (!c) continue;
      const p = prev?.get(row.id);
      const reqV = lerp(p?.req ?? 0, c.req, e);
      const grantV = c.grant == null ? 0 : lerp(p?.grant ?? 0, c.grant, e);
      const rw = Math.round((reqV / row.scale) * 1000) / 10;
      const gw = Math.round((grantV / row.scale) * 1000) / 10;
      const tk = Math.round((c.floor / row.scale) * 1000) / 10;
      if (rw !== row.lastReq) {
        row.lastReq = rw;
        row.reqFill.style.width = `${rw}%`;
      }
      if (gw !== row.lastGrant) {
        row.lastGrant = gw;
        row.grantFill.style.width = `${gw}%`;
      }
      if (tk !== row.lastTick) {
        row.lastTick = tk;
        row.tick.style.left = `${tk}%`;
        row.tick.hidden = c.floor <= 0.5;
      }
    }
  }
}
