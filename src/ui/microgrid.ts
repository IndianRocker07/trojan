/** Microgrid widgets: segmented supply bars, island breakdown, prosumer DER, utility buffer, dependents. */
import type { IslandInfo, SimSnapshot, UtilityAgentState } from '../core/types';
import { fmtKW, pct, sunUp } from './format';
import { agentLink } from './negViews';
import { chip, gauge, h, setText } from './widgets';

type SegKind = 'util' | 'pros' | 'curt' | 'self' | 'rest';

export const SEG_LABEL: Record<SegKind, string> = {
  util: 'Utility DER',
  pros: 'Prosumer',
  curt: 'Curtailed',
  self: 'Self-supply',
  rest: 'Unused',
};

interface SegDef {
  kind: SegKind;
  /** label shown in the legend; the number is appended */
  label?: string;
}

/** Stacked bar of kW segments with an optional marker (e.g. the line thermal limit) and a numeric legend. */
export function segBar(defs: SegDef[], markerLabel?: string) {
  const segs = defs.map((d) => h('div', { class: `seg-fill ${d.kind}` }));
  const marker = markerLabel ? h('div', 'seg-mark') : null;
  const bar = h('div', { class: 'seg-bar', role: 'img' }, ...segs, marker);
  const vals = defs.map(() => h('span', 'mono strong'));
  const legend = h(
    'div',
    'seg-legend',
    ...defs.map((d, i) => h('span', 'seg-key', h('i', `seg-sw ${d.kind}`), h('span', null, d.label ?? SEG_LABEL[d.kind], ' '), vals[i])),
  );
  let markVal: HTMLElement | null = null;
  if (marker && markerLabel) {
    markVal = h('span', 'mono strong');
    legend.append(h('span', 'seg-key', h('i', 'seg-sw mark'), h('span', null, markerLabel, ' '), markVal));
  }
  return {
    el: h('div', 'sbar', bar, legend),
    /** values in kW per segment; `mark` is the marker position in kW; scale defaults to max(sum, mark) */
    set(values: number[], mark?: number, aria?: string) {
      const sum = values.reduce((n, v) => n + Math.max(0, v), 0);
      const max = Math.max(sum, mark ?? 0, 1);
      values.forEach((v, i) => {
        segs[i].style.width = `${(Math.max(0, v) / max) * 100}%`;
        setText(vals[i], fmtKW(v));
      });
      if (marker && mark != null && markVal) {
        marker.style.left = `${Math.min(100, (mark / max) * 100)}%`;
        setText(markVal, fmtKW(mark));
      }
      bar.setAttribute('aria-label', aria ?? defs.map((d, i) => `${d.label ?? SEG_LABEL[d.kind]} ${fmtKW(values[i])}`).join(', '));
    },
  };
}

// ───────────────────────── island breakdown ─────────────────────────

/** P_total = min(utility DER + prosumer, line limit), shown as utility DER | prosumer | curtailed with a limit marker. */
export function islandBreakdown() {
  const bar = segBar([{ kind: 'util' }, { kind: 'pros' }, { kind: 'curt' }], 'Line limit');
  const total = h('p', 'small mono');
  return {
    el: h('div', 'island-break', bar.el, total),
    set(i: IslandInfo) {
      bar.set(
        [i.utilityDerKW, i.prosumerKW, i.curtailedKW],
        i.lineLimitKW,
        `Island supply ${fmtKW(i.supplyKW)}: utility DER ${fmtKW(i.utilityDerKW)}, prosumer ${fmtKW(i.prosumerKW)}, curtailed ${fmtKW(i.curtailedKW)}, line limit ${fmtKW(i.lineLimitKW)}`,
      );
      const capped = i.utilityDerKW + i.prosumerKW > i.lineLimitKW + 0.5;
      setText(total, `P_total ${fmtKW(i.supplyKW)}${capped ? ' · capped by line limit' : ''} · demand ${fmtKW(i.demandKW)}`);
    },
  };
}

/** Compact island row for the "Islands" section (also used when negotiation is off). */
export function islandSummary() {
  const title = h('h5', 'sub-title');
  const micro = chip('Microgrid', 'lilac');
  const brk = islandBreakdown();
  const meta = h('p', 'small muted');
  const el = h('div', 'island card-lite', h('div', 'sub-row', title, micro), brk.el, meta);
  return {
    el,
    set(i: IslandInfo) {
      setText(title, `Island ${i.id}`);
      micro.hidden = !i.microgrid;
      brk.set(i);
      const bits = [`${i.consumerIds.length} consumers`, `${i.prosumerIds.length} prosumers`];
      if (i.generatorIds.length) bits.push(`${i.generatorIds.length} generator${i.generatorIds.length > 1 ? 's' : ''}`);
      setText(meta, bits.join(' · '));
    },
  };
}

// ───────────────────────── prosumer DER block ─────────────────────────

export function derBlock() {
  const vals = new Map<string, HTMLElement>();
  const tiles = h('div', 'tiles tiles3');
  for (const [k, label] of [
    ['solar', 'Solar'],
    ['self', 'Self-supply'],
    ['offered', 'Offered'],
    ['exported', 'Exported'],
    ['curtailed', 'Curtailed'],
  ] as const) {
    const v = h('span', 'tile-val sm');
    vals.set(k, v);
    tiles.append(h('div', 'tile', h('span', 'tile-label', label), v));
  }
  const batV = h('span', 'tile-val sm');
  const batG = gauge('backup');
  tiles.insertBefore(h('div', 'tile', h('span', 'tile-label', 'Battery'), batV, batG.el), tiles.children[1]);
  const bar = segBar([{ kind: 'self' }, { kind: 'pros', label: 'Exported' }, { kind: 'curt' }]);
  const el = h('section', 'block der-block', h('h4', 'section-title', 'Prosumer solar'), tiles, bar.el);
  el.hidden = true;
  return {
    el,
    update(a: UtilityAgentState) {
      const d = a.der;
      el.hidden = !d;
      if (!d) return;
      setText(vals.get('solar')!, fmtKW(d.solarKW));
      setText(vals.get('self')!, fmtKW(d.selfSupplyKW));
      setText(vals.get('offered')!, fmtKW(d.offeredKW));
      setText(vals.get('exported')!, fmtKW(d.exportedKW));
      setText(vals.get('curtailed')!, fmtKW(d.curtailedKW));
      const bp = d.batteryPct > 1 ? d.batteryPct / 100 : d.batteryPct;
      setText(batV, pct(bp));
      batG.set(bp);
      bar.set([d.selfSupplyKW, d.exportedKW, d.curtailedKW]);
    },
  };
}

// ───────────────────────── utility buffer block ─────────────────────────

const STORAGE_LABEL = { reservoir: 'Reservoir', battery: 'Battery', diesel: 'Diesel tank' } as const;

export function bufferBlock() {
  const kind = h('span', 'strong');
  const soc = h('span', 'mono');
  const g = gauge('backup');
  const charge = h('span', 'mono');
  const state = h('span', 'chip');
  const note = h('p', 'small muted');
  const el = h(
    'section',
    'block buffer-block',
    h('h4', 'section-title', 'Buffer'),
    h('div', 'kv', kind, soc),
    g.el,
    h('div', 'kv', h('span', 'muted', 'Charging'), charge),
    h('div', 'kv', h('span', 'muted', 'State'), state),
    note,
  );
  el.hidden = true;
  return {
    el,
    update(a: UtilityAgentState, s: SimSnapshot) {
      const st = a.storage;
      el.hidden = !st;
      if (!st) return;
      const f = (st.socPct > 1 ? st.socPct / 100 : st.socPct) || 0;
      setText(kind, STORAGE_LABEL[st.kind]);
      setText(soc, pct(f));
      g.set(f);
      setText(charge, fmtKW(st.chargeKW));
      const served = a.demandKW - a.allocatedKW < 0.5;
      let txt = 'Holding';
      let tone = '';
      let why = 'Not drawing power to refill.';
      if (st.chargeKW > 0.5) {
        if (served) {
          const sun = sunUp(s.tMin);
          txt = sun ? 'Pre-charging' : 'Charging';
          tone = 'green';
          why = sun ? 'Refilling on midday prosumer surplus.' : 'Refilling from the grid.';
        } else {
          txt = 'Coasting';
          tone = 'yellow';
          why = 'Charge request not granted: running on reserves.';
        }
      }
      setText(state, txt);
      state.className = `chip ${tone}`.trim();
      setText(note, why);
    },
  };
}

// ───────────────────────── dependents ─────────────────────────

export function dependentsBlock(onSelect: (id: string) => void) {
  const total = h('span', 'mono strong');
  const list = h('ul', 'deps');
  let key = '';
  const el = h('section', 'block deps-block', h('h4', 'section-title', 'Dependents'), h('div', 'kv', h('span', 'muted', 'Damage per hour if lost'), total), list);
  el.hidden = true;
  return {
    el,
    update(a: UtilityAgentState, s: SimSnapshot) {
      const ids = (a.dependents ?? []).filter((id) => s.buildings[id]);
      el.hidden = ids.length === 0 && !(a.dependentDamagePerHour && a.dependentDamagePerHour > 0);
      if (el.hidden) return;
      setText(total, `+${Math.round(a.dependentDamagePerHour ?? 0).toLocaleString('en-US')} /h`);
      const k = ids.map((id) => `${id}:${Math.round(s.agents[id]?.expectedDamagePerHour ?? 0)}`).join('|');
      if (k === key) return;
      key = k;
      list.replaceChildren(
        ...ids.map((id) =>
          h('li', 'dep', agentLink(id, s, onSelect), h('span', 'mono muted small', `${Math.round(s.agents[id]?.expectedDamagePerHour ?? 0)} /h`)),
        ),
      );
    },
  };
}
