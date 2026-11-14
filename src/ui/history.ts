import type { SimSnapshot, UtilityAgentState } from '../core/types';

export const RING_LEN = 60;
export const SAMPLE_EVERY_MIN = 5;

export class Ring {
  private a = new Float32Array(RING_LEN);
  private n = 0;
  private head = 0;
  ver = 0;
  push(v: number) {
    this.a[this.head] = v;
    this.head = (this.head + 1) % RING_LEN;
    if (this.n < RING_LEN) this.n++;
    this.ver++;
  }
  toArray(): number[] {
    const out: number[] = new Array(this.n);
    const start = this.n < RING_LEN ? 0 : this.head;
    for (let i = 0; i < this.n; i++) out[i] = this.a[(start + i) % RING_LEN];
    return out;
  }
}

/** Per-agent ring buffers (60 samples, one per 5 sim minutes) of every telemetry key. */
export class AgentHistory {
  private map = new Map<string, Map<string, Ring>>();
  private lastT = -Infinity;

  clear() {
    this.map.clear();
    this.lastT = -Infinity;
  }

  get(id: string): Map<string, Ring> | undefined {
    return this.map.get(id);
  }

  private record(a: UtilityAgentState) {
    let rings = this.map.get(a.buildingId);
    if (!rings) this.map.set(a.buildingId, (rings = new Map()));
    for (const k in a.telemetry) {
      let r = rings.get(k);
      if (!r) rings.set(k, (r = new Ring()));
      r.push(a.telemetry[k]);
    }
  }

  /** Call on every engine tick; samples when >= 5 sim minutes passed. Houses are only tracked while selected. */
  sample(s: SimSnapshot, selected: string | null) {
    if (s.tMin < this.lastT) this.clear();
    if (s.tMin - this.lastT < SAMPLE_EVERY_MIN) return;
    this.lastT = s.tMin;
    for (const id in s.agents) {
      const a = s.agents[id];
      if (a.kind === 'house' && id !== selected) continue;
      this.record(a);
    }
  }

  /** Start tracking one agent right now (used when a house is selected). */
  track(a: UtilityAgentState | undefined) {
    if (a && !this.map.has(a.buildingId)) this.record(a);
  }
}
