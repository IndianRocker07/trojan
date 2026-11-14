/**
 * Layer-1 PLACEHOLDERS for the two upper layers.
 *  - BaselinePolicy    → replaced by the Layer 2 negotiation engine (bids, tokens, contracts).
 *  - BaselineValidator → replaced by the Layer 3 safety layer (hard limits, physics, fairness audit).
 * They exist so the simulation is a complete closed loop on its own and to define the plug-in contract.
 */
import type { AllocationPolicy, AllocationRequest, ConstraintValidator } from '../core/types';

/** "Critical-first proportional": min-safe grants by criticality, remainder proportional to unmet demand. */
export class BaselinePolicy implements AllocationPolicy {
  name = 'baseline: critical-first proportional';

  allocate(supplyKW: number, requests: AllocationRequest[]): Record<string, number> {
    const out: Record<string, number> = {};
    let left = Math.max(0, supplyKW);
    const sorted = [...requests].sort((a, b) => b.criticality - a.criticality || (a.buildingId < b.buildingId ? -1 : a.buildingId > b.buildingId ? 1 : 0));
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
