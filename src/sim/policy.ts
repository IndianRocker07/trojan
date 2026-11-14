/**
 * Layer-1 PLACEHOLDERS for the two upper layers.
 *  - BaselinePolicy    → replaced by the Layer 2 negotiation engine (bids, tokens, contracts).
 *  - BaselineValidator → replaced by the Layer 3 safety layer (hard limits, physics, fairness audit).
 * They exist so the simulation is a complete closed loop on its own and to define the plug-in contract.
 */
import type { AllocationPolicy, AllocationRequest, ConstraintValidator, SimSnapshot } from '../core/types';

/** building id → rank in ascending id order (so the id tie-break is a number compare); cached per buildings object */
const idRanks = new WeakMap<object, Map<string, number>>();
function rankOf(buildings: object): Map<string, number> {
  let m = idRanks.get(buildings);
  if (!m) {
    m = new Map();
    Object.keys(buildings).sort().forEach((id, i) => m!.set(id, i));
    idRanks.set(buildings, m);
  }
  return m;
}

/** "Critical-first proportional": min-safe grants by criticality, remainder proportional to unmet demand. */
export class BaselinePolicy implements AllocationPolicy {
  name = 'baseline: critical-first proportional';

  allocate(supplyKW: number, requests: AllocationRequest[], snapshot?: SimSnapshot): Record<string, number> {
    const out: Record<string, number> = {};
    let left = Math.max(0, supplyKW);
    let sorted: AllocationRequest[];
    const ranks = snapshot ? rankOf(snapshot.buildings) : undefined;
    const n = requests.length;
    const rk = new Float64Array(n);
    let ok = ranks !== undefined;
    if (ranks) {
      for (let i = 0; i < n; i++) {
        const v = ranks.get(requests[i].buildingId);
        if (v === undefined) { ok = false; break; }
        rk[i] = v;
      }
    }
    if (ok) {
      // same total order as the string comparison below (criticality desc, id asc), with the id as a precomputed rank
      const idx = new Array<number>(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      idx.sort((i, j) => requests[j].criticality - requests[i].criticality || rk[i] - rk[j]);
      sorted = idx.map((i) => requests[i]);
    } else {
      sorted = [...requests].sort((a, b) => b.criticality - a.criticality || (a.buildingId < b.buildingId ? -1 : a.buildingId > b.buildingId ? 1 : 0));
    }
    for (const r of sorted) {
      const g = Math.max(0, Math.min(r.minSafeKW, r.demandKW, left));
      out[r.buildingId] = g;
      left -= g;
    }
    if (left > 1e-9) {
      let unmet = 0;
      for (const r of requests) unmet += Math.max(0, r.demandKW - out[r.buildingId]);
      if (unmet > 1e-9) {
        const share = Math.min(1, left / unmet);
        for (const r of requests) out[r.buildingId] += Math.max(0, r.demandKW - out[r.buildingId]) * share;
      }
    }
    return out;
  }
}

/** Clamps negatives, caps each grant at demand and scales the total down to the supply. */
export class BaselineValidator implements ConstraintValidator {
  name = 'baseline: clamp to demand & supply';

  validate(
    supplyKW: number,
    requests: AllocationRequest[],
    allocation: Record<string, number>,
  ): { allocation: Record<string, number>; violations: string[] } {
    const violations: string[] = [];
    const out: Record<string, number> = {};
    let total = 0;
    let negs = 0;
    let over = 0;
    for (const r of requests) {
      let g = allocation[r.buildingId];
      if (!Number.isFinite(g)) g = 0;
      if (g < 0) { g = 0; negs++; }
      if (g > r.demandKW + 1e-9) { g = r.demandKW; over++; }
      out[r.buildingId] = Math.min(g, r.demandKW);
      total += out[r.buildingId];
    }
    if (negs) violations.push(`${negs} negative grant(s) clamped to 0`);
    if (over) violations.push(`${over} grant(s) above demand clamped`);
    const supply = Math.max(0, supplyKW);
    if (total > supply + 1e-6) {
      const k = total > 0 ? supply / total : 0;
      for (const id of Object.keys(out)) out[id] *= k;
      violations.push(`allocation ${total.toFixed(0)} kW exceeded supply ${supply.toFixed(0)} kW — scaled down`);
    }
    return { allocation: out, violations };
  }
}
