/**
 * Evaluation-only reference policy for the benchmark (not a production policy).
 *
 * Damage-optimal greedy per island, using the true per-kW harm of each request:
 *   1. protected floors min(minSafeKW, demandKW), in descending criticality (tie: harm density desc, id);
 *   2. greedy fill of the non-charge demand by harm density (expectedDamagePerHour + dependentDamagePerHour) per kW;
 *   3. greedy fill of the sheddable buffer-charging demand by the same order.
 * It is the upper bound the negotiation layer is measured against; it never runs in the game itself.
 */
import type { AllocationPolicy, AllocationRequest } from '../../src/core/types';

const pos = (x: number): number => (Number.isFinite(x) && x > 0 ? x : 0);
const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class DamageOraclePolicy implements AllocationPolicy {
  name = 'oracle: damage-optimal greedy (upper bound)';

  allocate(supplyKW: number, requests: AllocationRequest[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of requests) out[r.buildingId] = 0;
    if (requests.length === 0) return out;
    let left = pos(supplyKW);

    const demand = (r: AllocationRequest): number => pos(r.demandKW);
    const charge = (r: AllocationRequest): number => Math.min(pos(r.chargeKW ?? 0), demand(r));
    const density = (r: AllocationRequest): number =>
      (pos(r.expectedDamagePerHour) + pos(r.dependentDamagePerHour ?? 0)) / Math.max(1e-6, demand(r) - charge(r));
    const byDensity = (x: AllocationRequest, y: AllocationRequest): number => density(y) - density(x) || cmpId(x.buildingId, y.buildingId);

    // 1. protected floors, most critical first
    const floorOrder = [...requests].sort((x, y) => y.criticality - x.criticality || byDensity(x, y));
    for (const r of floorOrder) {
      const g = Math.min(Math.min(pos(r.minSafeKW), demand(r)), left);
      out[r.buildingId] += g;
      left -= g;
    }

    // remaining non-charge and charge demand after the floors (floors are served from non-charge demand first)
    const ncRem = new Map<string, number>();
    const cRem = new Map<string, number>();
    for (const r of requests) {
      const got = out[r.buildingId];
      const nonCharge = demand(r) - charge(r);
      ncRem.set(r.buildingId, Math.max(0, nonCharge - got));
      cRem.set(r.buildingId, Math.max(0, charge(r) - Math.max(0, got - nonCharge)));
    }

    const order = [...requests].sort(byDensity);
    // 2. non-charge demand
    for (const r of order) {
      const want = ncRem.get(r.buildingId) ?? 0;
      const g = Math.min(want, left);
      out[r.buildingId] += g;
      left -= g;
    }
    // 3. sheddable buffer charging, only from what is left
    for (const r of order) {
      const want = cRem.get(r.buildingId) ?? 0;
      const g = Math.min(want, left);
      out[r.buildingId] += g;
      left -= g;
    }
    for (const r of requests) out[r.buildingId] = Math.min(out[r.buildingId], demand(r));
    return out;
  }
}
