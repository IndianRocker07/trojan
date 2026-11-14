/** Reusable negotiation widgets: priority stacked bar, allocation waterfall, name lookup. Patch-in-place. */
import type { AllocationExplanation, NegotiationSnapshot, PriorityBreakdown, SimSnapshot } from '../core/types';
import { fmtKW, fmtSignedKW } from './format';
import { chip, h, setText } from './widgets';

/** Human name for an agent / cluster id. */
export function agentName(id: string, s: SimSnapshot): string {
  const b = s.buildings[id];
  if (b) return b.name;
  const a = s.negotiation?.agents[id];
  if (a?.memberIds) return `Household cluster (${a.memberIds.length} homes)`;
  return id;
}

/** Building id the UI can select for an agent id (clusters → first member). */
export function selectableId(id: string, s: SimSnapshot): string | null {
  if (s.buildings[id]) return id;
  const m = s.negotiation?.agents[id]?.memberIds?.[0];
  return m && s.buildings[m] ? m : null;
}

/** Resolve a selected building to its negotiation agent id (houses → cluster). */
export function resolveAgent(buildingId: string, n: NegotiationSnapshot): string {
  return n.houseCluster[buildingId] ?? buildingId;
}

/** A button that reads as a link and selects an agent. */
export function agentLink(id: string, s: SimSnapshot, onSelect: (buildingId: string) => void): HTMLElement {
  const sel = selectableId(id, s);
  const b = h('button', { class: 'ref', type: 'button', text: agentName(id, s), disabled: sel ? null : true });
  if (sel) b.addEventListener('click', () => onSelect(sel));
  return b;
}

// ───────────────────────── priority breakdown ─────────────────────────

const TERMS = [
  { key: 'criticality', label: 'Criticality', cls: 't-crit' },
  { key: 'urgency', label: 'Urgency', cls: 't-urg' },
  { key: 'damage', label: 'Damage', cls: 't-dmg' },
  { key: 'tokens', label: 'Tokens', cls: 't-tok' },
] as const;

export function priorityView() {
  const bar = h('div', { class: 'prio-bar', role: 'img' });
  const segs = TERMS.map((t) => h('span', `prio-seg ${t.cls}`));
  bar.append(...segs);
  const score = h('span', 'mono strong');
  const legend = h('ul', 'prio-legend');
  const rows = [...TERMS, { key: 'fairness', label: 'Fairness (subtracts)', cls: 't-fair' }].map((t) => {
    const val = h('span', 'mono');
    const row = h('li', null, h('span', `prio-swatch ${t.cls}`), h('span', 'prio-name', t.label), val);
    legend.append(row);
    return { key: t.key, val };
  });
  const el = h('div', 'prio', h('div', 'prio-top', h('span', 'muted', 'Priority score'), score), bar, legend);
  return {
    el,
    set(p: PriorityBreakdown) {
      let label = '';
      TERMS.forEach((t, i) => {
        const c = p.weights[t.key] * p.terms[t.key];
        segs[i].style.width = `${Math.max(0, Math.min(1, c)) * 100}%`;
        label += `${t.label} ${c.toFixed(2)}, `;
      });
      for (const r of rows) {
        const k = r.key as keyof PriorityBreakdown['weights'];
        const c = p.weights[k] * p.terms[k];
        setText(r.val, `${p.weights[k].toFixed(2)} × ${p.terms[k].toFixed(2)} = ${k === 'fairness' ? '−' : ''}${c.toFixed(3)}`);
      }
      setText(score, p.score.toFixed(2));
      bar.setAttribute('aria-label', `Priority score ${p.score.toFixed(2)}: ${label}minus fairness`);
    },
  };
}

// ───────────────────────── allocation explanation ─────────────────────────

export function explanationView() {
  const mk = (label: string) => {
    const v = h('span', 'mono wf-val');
    return { v, el: h('li', 'wf-step', h('span', 'wf-label', label), v) };
  };
  const steps = [mk('Phase 1 floor'), mk('Contract'), mk('Phase 2 share'), mk('Validator'), mk('Final')];
  steps[4].el.classList.add('wf-final');
  const wf = h('ol', { class: 'waterfall', 'aria-label': 'Allocation steps' });
  steps.forEach((s, i) => {
    if (i) wf.append(h('li', { class: 'wf-arrow', 'aria-hidden': 'true', text: '→' }));
    wf.append(s.el);
  });
  const chips = h('div', 'chip-row tight');
  const rank = chip('');
  const triage = chip('Triage: floor not protected for all', 'coral');
  const floor = chip('');
  const extra = h('span', 'muted small');
  chips.append(rank, floor, triage);
  const reason = h('p', 'reason');
  const notes = h('ul', 'notes');
  const el = h('div', 'expl', wf, chips, extra, reason, notes);
  let noteKey = '';
  return {
    el,
    set(e: AllocationExplanation) {
      const validatorDelta = e.finalKW - e.proposedKW;
      setText(steps[0].v, fmtKW(e.phase1KW));
      setText(steps[1].v, fmtSignedKW(e.contractKW));
      setText(steps[2].v, fmtKW(e.phase2KW));
      setText(steps[3].v, fmtSignedKW(validatorDelta));
      setText(steps[4].v, fmtKW(e.finalKW));
      steps[3].el.dataset.changed = String(Math.abs(validatorDelta) >= 0.5);
      setText(rank, `Rank #${e.rank} of ${e.ofN}`);
      setText(floor, e.minSafeMet ? 'Min safe met' : 'Below min safe');
      floor.className = `chip ${e.minSafeMet ? 'green' : 'coral'}`;
      triage.hidden = !e.triaged;
      setText(extra, `Asked ${fmtKW(e.requestKW)}, conceded ${fmtKW(e.concededKW)}, tokens +${e.tokensEarned.toFixed(1)} / −${e.tokensSpent.toFixed(1)}`);
      setText(reason, e.reason);
      const nk = e.validatorNotes.join('|');
      if (nk !== noteKey) {
        noteKey = nk;
        notes.replaceChildren(...e.validatorNotes.map((n) => h('li', { text: n })));
      }
      notes.hidden = e.validatorNotes.length === 0;
    },
  };
}
