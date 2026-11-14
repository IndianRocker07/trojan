/**
 * System-1 perception: deterministic heuristic, heuristic provider, and the non-blocking scheduler that
 * fronts an async provider (Jev). docs/NEGOTIATION.md §2.
 */
import type { ConcessionStrategy, Perception, PerceptionInput, PerceptionProvider } from '../core/types';
import type { PerceptionSource } from './agentApi';
import { NEGOTIATION_CONFIG, clamp01, type NegotiationConfig } from './config';
import { PERSONAS, bufferDecayUrgency, bufferSocOf } from './personas';

const HEURISTIC_CONFIDENCE = 0.6;

export function heuristicPerception(input: PerceptionInput): Perception {
  const cfg = NEGOTIATION_CONFIG;
  const persona = PERSONAS[input.kind];
  let urgency = clamp01(persona.urgencyAdjust(clamp01(input.simUrgency), input));
  // time-decay buffer urgency (docs/MICROGRID.md §6.5): urgency = max(u, exp(−k·soc))
  const soc = bufferSocOf(input.kind, input);
  if (soc !== undefined) urgency = Math.max(urgency, clamp01(bufferDecayUrgency(soc, cfg)));
  const damage = clamp01(input.expectedDamagePerHour / cfg.damageNorm);

  // imminent failure: protected floor not covered by the grid and backup is thin
  const gap = Math.max(0, input.minSafeKW - input.allocatedKW);
  let risk = 0.15 * urgency;
  if (gap > 0 && input.minSafeKW > 0) {
    const hasBackup = input.backup.remainingKWh > 0 && input.backup.maxKW > 0;
    const covered = hasBackup ? Math.min(1, input.backup.maxKW / gap) : 0;
    const hoursRisk = hasBackup ? clamp01(1 - input.backup.hoursLeft / 2) : 1;
    const uncovered = clamp01(1 - covered * (1 - hoursRisk));
    risk = Math.max(risk, uncovered * clamp01(gap / input.minSafeKW + 0.3));
  }
  risk = clamp01(risk);

  const buffer = persona.bufferPct(input) / 100;
  let canConcede = 0;
  if (input.mode === 'cooperating') canConcede = clamp01((0.6 + 0.4 * buffer) * (1 - risk));
  else if (input.mode === 'active') canConcede = clamp01(buffer * (1 - risk));
  let strategy: ConcessionStrategy = canConcede < 0.5 ? 'none' : canConcede < 0.75 ? 'shed_25_flex' : 'shed_50_flex';
  if (input.mode === 'cooperating' && strategy === 'none' && canConcede >= 0.5) strategy = 'shed_25_flex';

  return {
    agentId: input.agentId,
    source: 'heuristic',
    tMin: input.tMin,
    urgency,
    damage,
    imminentFailureRisk: risk,
    canConcede,
    concessionStrategy: strategy,
    confidence: HEURISTIC_CONFIDENCE,
    model: 'heuristic',
  };
}

export class HeuristicProvider implements PerceptionProvider {
  readonly name = 'heuristic';
  perceive(inputs: PerceptionInput[]): Promise<Perception[]> {
    return Promise.resolve(inputs.map(heuristicPerception));
  }
}

interface CacheEntry {
  perception: Perception;
  reqTMin: number;
  simUrgency: number;
  mode: PerceptionInput['mode'];
}

export class PerceptionScheduler implements PerceptionSource {
  private cache = new Map<string, CacheEntry>();
  private lastResolved = new Map<string, Perception>();
  private queue = new Map<string, PerceptionInput>();
  private lastReqWall = new Map<string, number>();
  private inFlight = 0;
  private calls = 0;
  private errors = 0;
  private lastError: string | undefined;
  private latencySumMs = 0;
  private latencyN = 0;
  private backoffUntil = 0;
  private epoch = 0;

  constructor(
    private provider: PerceptionProvider | null,
    private cfg: NegotiationConfig = NEGOTIATION_CONFIG,
  ) {}

  resolve(input: PerceptionInput): Perception {
    const heur = heuristicPerception(input);
    if (!this.provider || input.mode === 'idle') {
      this.lastResolved.set(input.agentId, heur);
      return heur;
    }
    const c = this.cache.get(input.agentId);
    const fresh =
      c !== undefined &&
      c.mode === input.mode &&
      input.tMin - c.reqTMin < this.cfg.perceptionTtlMin &&
      Math.abs(input.simUrgency - c.simUrgency) < this.cfg.perceptionUrgencyDelta;
    if (fresh) {
      this.lastResolved.set(input.agentId, c.perception);
      return c.perception;
    }
    this.queue.set(input.agentId, input);
    this.lastResolved.set(input.agentId, heur);
    return heur;
  }

  pump(): void {
    const provider = this.provider;
    if (!provider || this.queue.size === 0) return;
    if (this.inFlight >= this.cfg.perceptionMaxInFlight) return;
    const now = Date.now();
    if (now < this.backoffUntil) return;

    const batch: PerceptionInput[] = [];
    for (const id of [...this.queue.keys()].sort()) {
      const last = this.lastReqWall.get(id);
      if (last !== undefined && now - last < this.cfg.perceptionMinRefreshMs) continue;
      batch.push(this.queue.get(id) as PerceptionInput);
    }
    if (batch.length === 0) return;
    for (const inp of batch) {
      this.queue.delete(inp.agentId);
      this.lastReqWall.set(inp.agentId, now);
    }

    const epoch = this.epoch;
    this.inFlight++;
    this.calls++;
    const done = (): boolean => {
      if (epoch !== this.epoch) return false; // reset() happened meanwhile
      this.inFlight = Math.max(0, this.inFlight - 1);
      return true;
    };
    const fail = (msg: string): void => {
      this.errors++;
      this.lastError = msg;
      this.backoffUntil = Date.now() + this.cfg.perceptionBackoffMs;
    };

    let promise: Promise<Perception[]>;
    try {
      promise = provider.perceive(batch);
    } catch (e) {
      if (done()) fail(e instanceof Error ? e.message : String(e));
      return;
    }
    promise.then(
      (results) => {
        if (!done()) return;
        const ms = Date.now() - now;
        this.latencySumMs += ms;
        this.latencyN++;
        const byId = new Map<string, Perception>();
        for (const p of Array.isArray(results) ? results : []) if (p && typeof p.agentId === 'string') byId.set(p.agentId, p);
        let failed = 0;
        for (const inp of batch) {
          const p = byId.get(inp.agentId);
          if (!p) continue;
          if (p.error) {
            failed++;
            this.errors++;
            this.lastError = p.error;
            continue; // heuristic keeps serving this agent
          }
          this.cache.set(inp.agentId, {
            perception: { ...p, latencyMs: p.latencyMs ?? ms },
            reqTMin: inp.tMin,
            simUrgency: inp.simUrgency,
            mode: inp.mode,
          });
        }
        if (failed > 0 && failed === batch.length) this.backoffUntil = Date.now() + this.cfg.perceptionBackoffMs;
      },
      (e: unknown) => {
        if (done()) fail(e instanceof Error ? e.message : String(e));
      },
    );
  }

  latest(agentId: string): Perception | undefined {
    return this.cache.get(agentId)?.perception ?? this.lastResolved.get(agentId);
  }

  stats(): { provider: string; enabled: boolean; inFlight: number; calls: number; errors: number; lastError?: string; avgLatencyMs: number } {
    const s: { provider: string; enabled: boolean; inFlight: number; calls: number; errors: number; lastError?: string; avgLatencyMs: number } = {
      provider: this.provider ? this.provider.name : 'heuristic',
      enabled: this.provider !== null && Date.now() >= this.backoffUntil,
      inFlight: this.inFlight,
      calls: this.calls,
      errors: this.errors,
      avgLatencyMs: this.latencyN > 0 ? this.latencySumMs / this.latencyN : 0,
    };
    if (this.lastError !== undefined) s.lastError = this.lastError;
    return s;
  }

  reset(): void {
    this.epoch++;
    this.cache.clear();
    this.lastResolved.clear();
    this.queue.clear();
    this.lastReqWall.clear();
    this.inFlight = 0;
    this.calls = 0;
    this.errors = 0;
    this.lastError = undefined;
    this.latencySumMs = 0;
    this.latencyN = 0;
    this.backoffUntil = 0;
  }
}
