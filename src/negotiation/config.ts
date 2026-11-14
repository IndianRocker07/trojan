/**
 * Layer 2 tunables (PRD FR-2.10: configurable for headless experiments). Owned by the orchestrator.
 * Every module in src/negotiation reads its constants from here — no magic numbers elsewhere.
 */
import type { PriorityWeights } from '../core/types';

export interface NegotiationConfig {
  /** Negotiation rounds per island per minute (PDF: 2 = initial bids + one counter-offer round). */
  rounds: number;

  // ── affected / mode detection (agent.ts) ──
  /** An agent within this distance of a non-ok cell is "affected". */
  affectedRadiusM: number;
  /** Telemetry urgency at or above this marks the agent affected. */
  affectedUrgency: number;
  /** Served fraction below this last minute marks the agent affected. */
  affectedServedFrac: number;
  /** Island deficit (fraction of total request) above which unaffected agents are asked to cooperate. */
  cooperateDeficitFrac: number;

  // ── perception (perception.ts) ──
  /** Max weight of System-1 perception in effective urgency/damage: α = perceptionBlend × confidence. */
  perceptionBlend: number;
  /** A Jev perception is refreshed after this many sim minutes. */
  perceptionTtlMin: number;
  /** …or when the agent's telemetry urgency moved by this much since the last request. */
  perceptionUrgencyDelta: number;
  /** Real-time floor between two Jev requests for the same agent (ms). */
  perceptionMinRefreshMs: number;
  /** Max concurrent provider batches. */
  perceptionMaxInFlight: number;
  /** After a provider error/"no key", wait this long (ms) before trying again. */
  perceptionBackoffMs: number;

  // ── priority score (clearing.ts) ──
  baseWeights: PriorityWeights;
  /** Added to urgency and damage weights at full scarcity, removed from criticality/fairness. */
  scarcityShift: number;
  /** Hard cap on the token weight (agent_prompt.md: tightly bounded). */
  maxTokenWeight: number;
  /** Tokens above this per bid add nothing. */
  tokenBidCap: number;
  /** expectedDamagePerHour that normalises to 1.0. */
  damageNorm: number;
  /** Damage per kW·h of demand that normalises to 1.0 (harm density). */
  damageDensityNorm: number;
  /** 0 = damage term is absolute harm rate only; 1 = harm density only (size-neutral). */
  damageDensityShare: number;
  /** Phase 2 weights the remainder by score × harm-per-kW (marginal damage) instead of score alone. */
  phase2MarginalDamage: boolean;
  /** Exponent γ on the phase-2 weight: 1 = proportional, larger = closer to greedy (damage-optimal). */
  phase2Sharpness: number;
  /** Lower bound on a priority score in phase-2 water-filling (so nobody is starved to exactly 0). */
  minScore: number;
  /** EWMA rate for recentServedShare per minute. */
  fairnessAlpha: number;
  /** criticality ≥ this = critical agent (never concedes below minSafe; PRD §9). */
  criticalThreshold: number;

  // ── tokens (ledger.ts) — PRD FR-2.4 ──
  endowment: number;
  tokenCap: number;
  /** Fraction of the balance above the endowment that decays per sim hour. */
  decayPerHour: number;
  /** Tokens granted per sim hour to agents below `replenishBelow`. */
  replenishPerHour: number;
  replenishBelow: number;
  /** Tokens earned per kW·minute of verified concession. */
  earnPerKWMin: number;
  /** Max fraction of its balance an agent offers on one bid. */
  maxOfferFraction: number;

  // ── forward contracts (contracts.ts) — PRD FR-2.6 ──
  contractMinKW: number;
  contractNowMin: number; // giver yields for this long
  contractDelayMin: number; // repayment window starts this long after creation
  contractRepayMin: number; // repayment window length
  contractReturnRatio: number; // laterKW = ratio × nowKW
  contractStake: number;
  maxOpenContracts: number;

  // ── backup self-supply flex ──
  /** An agent with more backup hours than this may offer to self-supply part of its load from backup. */
  backupSelfSupplyHours: number;
  /** Harm-aware concessions: an agent only concedes load whose loss is covered (charging, own backup, own battery). */
  harmAwareConcessions: boolean;
  /** A house battery above this SoC % counts as covering that home deficit. 101 = off: measured, draining home batteries early only moves harm to later. */
  houseBatteryMinPct: number;

  // ── microgrid (docs/MICROGRID.md §6) ──
  /** Daylight window of the sim (engine `daylight`): sun is up for sunriseHour < hour < sunsetHour. */
  sunriseHour: number;
  sunsetHour: number;
  /** Buffer charging is conceded ("coasting") when fewer than this many minutes remain before sunset. */
  coastWindowMin: number;
  /** A buffer below this SoC % never coasts: it keeps bidding for its charge. */
  coastMinSoc: number;
  /** Time-decay buffer urgency exp(−k·soc%): k per percent (soc 15% → 0.85, 5% → 0.95). */
  bufferDecayK: number;
  /** The decay urgency only applies below this SoC % (a full buffer is not urgent). */
  bufferDecayBelowPct: number;
  /** Dependency damage counted into the bid is capped at this multiple of the agent's own damage. */
  dependentDamageCap: number;

  // ── UI / memory ──
  historyPerAgent: number;
  ledgerKeep: number;

  /** Record step-by-step replays, story events and the chat feed (story.ts). */
  recordStory: boolean;
}

export const NEGOTIATION_CONFIG: NegotiationConfig = {
  rounds: 2,

  affectedRadiusM: 260,
  affectedUrgency: 0.6,
  affectedServedFrac: 0.97,
  cooperateDeficitFrac: 0.0,

  perceptionBlend: 0.4,
  perceptionTtlMin: 10,
  perceptionUrgencyDelta: 0.15,
  perceptionMinRefreshMs: 4000,
  perceptionMaxInFlight: 1,
  perceptionBackoffMs: 30000,

  baseWeights: { criticality: 0.35, urgency: 0.25, damage: 0.25, tokens: 0.03, fairness: 0.12 },
  scarcityShift: 0.1,
  maxTokenWeight: 0.03,
  tokenBidCap: 20,
  damageNorm: 150,
  damageDensityNorm: 0.5,
  damageDensityShare: 0.5,
  phase2MarginalDamage: true,
  phase2Sharpness: 3,
  minScore: 0.02,
  fairnessAlpha: 1 / 30,
  criticalThreshold: 0.8,

  endowment: 100,
  tokenCap: 300,
  decayPerHour: 0.01,
  replenishPerHour: 2,
  replenishBelow: 20,
  earnPerKWMin: 2e-4,
  maxOfferFraction: 0.1,

  contractMinKW: 50,
  contractNowMin: 30,
  contractDelayMin: 60,
  contractRepayMin: 60,
  contractReturnRatio: 0.75,
  contractStake: 5,
  maxOpenContracts: 3,

  backupSelfSupplyHours: 6,
  harmAwareConcessions: true,
  houseBatteryMinPct: 101,

  sunriseHour: 6,
  sunsetHour: 19,
  coastWindowMin: 60,
  coastMinSoc: 20,
  bufferDecayK: 0.0108,
  bufferDecayBelowPct: 50,
  dependentDamageCap: 3,

  historyPerAgent: 240,
  ledgerKeep: 400,

  recordStory: true,
};

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);

/** Minutes until sunset: > 0 while the sun is up, ≤ 0 after sunset / before sunrise (negative = minutes since sunset). */
export function minutesToSunsetAt(hourOfDay: number, cfg: Pick<NegotiationConfig, 'sunriseHour' | 'sunsetHour'> = NEGOTIATION_CONFIG): number {
  const h = ((hourOfDay % 24) + 24) % 24;
  if (!Number.isFinite(h)) return 0;
  if (h > cfg.sunriseHour && h < cfg.sunsetHour) return (cfg.sunsetHour - h) * 60;
  const since = h >= cfg.sunsetHour ? h - cfg.sunsetHour : h + 24 - cfg.sunsetHour;
  return -since * 60;
}
