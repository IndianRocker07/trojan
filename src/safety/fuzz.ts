import { Rng } from '../core/rng';
import type { AllocationPolicy, AllocationRequest } from '../core/types';

/** Adversarial policy for FR-3.10: proposes garbage of every flavour, deterministically from a seed. */
export class FuzzPolicy implements AllocationPolicy {
  name = 'fuzz: adversarial allocations';
  private rng: Rng;
  constructor(private readonly seed = 1) {
    this.rng = new Rng(seed);
  }

  reset(): void {
    this.rng = new Rng(this.seed);
  }

  allocate(supplyKW: number, requests: AllocationRequest[]): Record<string, number> {
    const rng = this.rng;
    const out: Record<string, number> = {};
    const mode = rng.int(0, 10);
    const target = requests.length ? rng.pick(requests).buildingId : '';
    for (const r of requests) {
      const m = mode === 10 ? rng.int(0, 9) : mode;
      let v: number;
      switch (m) {
        case 0: v = rng.range(0, r.demandKW); break;
        case 1: v = -rng.range(0, r.demandKW * 2 + 1); break;
        case 2: v = rng.chance(0.3) ? NaN : rng.range(0, r.demandKW); break;
        case 3: v = rng.chance(0.3) ? (rng.chance(0.5) ? Infinity : -Infinity) : r.demandKW; break;
        case 4: v = r.demandKW * (1 + rng.range(0.01, 5)); break;
        case 5: v = r.demandKW * 3 + supplyKW; break;
        case 6: v = r.buildingId === target ? supplyKW * 10 + 1e6 : 0; break;
        case 7: v = rng.range(0, r.demandKW); break;
        case 8: v = 0; break;
        default: v = rng.chance(0.5) ? r.demandKW : r.minSafeKW * rng.range(0, 1.5); break;
      }
      out[r.buildingId] = v;
    }
    if (mode === 7 || mode === 10) {
      out['unknown-' + rng.int(0, 99)] = rng.range(0, 5000);
      out['ghost'] = Infinity;
    }
    return out;
  }
}
