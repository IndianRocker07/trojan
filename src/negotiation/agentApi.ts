/**
 * Internal seam between the agent side (agent.ts, households.ts, perception.ts, personas.ts) and the
 * market side (clearing.ts, ledger.ts, contracts.ts, policy.ts). Owned by the orchestrator.
 * Types only — implementations live in the files named below.
 */
import type {
  AgentCaseBrief,
  AgentMode,
  AllocationRequest,
  NegotiatorKind,
  Perception,
  PerceptionInput,
  ShortfallNotice,
  SimSnapshot,
  UtilityAgentState,
  UtilityBid,
} from '../core/types';

/** Public island data every agent may see (FR-2.7). */
export interface PublicIslandInfo {
  islandId: number;
  tMin: number;
  hourOfDay: number;
  supplyKW: number;
  totalRequestKW: number; // Σ demand of all requests on the island this minute
  totalMinSafeKW: number;
  deficitKW: number; // max(0, totalRequestKW − supplyKW)
  consumers: number;
  // ── microgrid public data (docs/MICROGRID.md) — optional for older callers ──
  microgrid?: boolean; // no utility-scale generator on this island
  prosumerKW?: number; // P_prosumer currently exported onto the island bus
  utilityDerKW?: number;
  /** Minutes until sunset (solar → 0); negative after sunset; ≥ 0 while the sun is up. */
  minutesToSunset?: number;
  /** Prosumer surplus available above the island's requests right now (cheap power to pre-charge buffers). */
  surplusKW?: number;
}

export interface Assessment {
  mode: AgentMode;
  affected: boolean;
  reasons: string[];
}

export interface Proposal {
  bid: UtilityBid;
  brief: AgentCaseBrief;
}

/** agent.ts — `export class UtilityAgent implements NegotiatingAgent` (constructor(id, kind, name)). */
export interface NegotiatingAgent {
  readonly id: string;
  readonly kind: NegotiatorKind;
  readonly name: string;
  /** EWMA of served fraction (0..1), updated by observe(). Starts at 1. */
  readonly recentServedShare: number;
  assess(state: UtilityAgentState, island: PublicIslandInfo): Assessment;
  perceptionInput(state: UtilityAgentState, island: PublicIslandInfo, mode: AgentMode): PerceptionInput;
  /** Round 1. `perception` is undefined for idle agents. `tokenBalance` = current ledger balance. */
  propose(
    state: UtilityAgentState,
    perception: Perception | undefined,
    island: PublicIslandInfo,
    assessment: Assessment,
    tokenBalance: number,
  ): Proposal;
  /** Round ≥ 2: react to the provisional shortfall (concede flex, offer tokens, or hold). Pure w.r.t. inputs. */
  respond(
    notice: ShortfallNotice,
    prev: Proposal,
    state: UtilityAgentState,
    perception: Perception | undefined,
    tokenBalance: number,
  ): Proposal;
  /** After commit: final kW granted and the agent's demand this minute. */
  observe(finalKW: number, demandKW: number): void;
}

/** households.ts */
export interface HouseholdCluster {
  id: string; // "cluster-<substationId>-<blockCol>-<blockRow>"
  substationId: string;
  memberIds: string[]; // house building ids, sorted
}

/** households.ts — `export function buildClusters(snapshot): ClusterIndex` (cache per snapshot.network object). */
export interface ClusterIndex {
  clusters: HouseholdCluster[];
  houseCluster: Record<string, string>;
}

/** households.ts — `export class ClusterAgent implements ClusterNegotiator` (constructor(cluster)). */
export interface ClusterNegotiator {
  readonly id: string;
  readonly memberIds: string[];
  readonly recentServedShare: number;
  /** `members` = this minute's requests of the cluster's houses on this island (may be a subset). */
  assess(members: AllocationRequest[], snapshot: SimSnapshot, island: PublicIslandInfo): Assessment;
  propose(members: AllocationRequest[], island: PublicIslandInfo, assessment: Assessment, tokenBalance: number): Proposal;
  respond(notice: ShortfallNotice, prev: Proposal, members: AllocationRequest[], tokenBalance: number): Proposal;
  /** Split a cluster grant over members: medical-device minSafe first, then other minSafe, then pro-rata to demand. Σ = min(grant, Σ demand). */
  split(grantKW: number, members: AllocationRequest[]): Record<string, number>;
  observe(finalKW: number, demandKW: number): void;
}

/**
 * perception.ts — `export class PerceptionScheduler implements PerceptionSource`
 * (constructor(provider: PerceptionProvider | null, cfg?: NegotiationConfig)).
 * Also exports `heuristicPerception(input: PerceptionInput): Perception` and `class HeuristicProvider implements PerceptionProvider`.
 */
export interface PerceptionSource {
  /** Synchronous: the perception to use right now (fresh cached Jev or heuristic); queues a refresh if stale. */
  resolve(input: PerceptionInput): Perception;
  /** Called once per step: send at most one queued batch to the provider (non-blocking). */
  pump(): void;
  latest(agentId: string): Perception | undefined;
  stats(): { provider: string; enabled: boolean; inFlight: number; calls: number; errors: number; lastError?: string; avgLatencyMs: number };
  reset(): void;
}
