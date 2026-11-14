/**
 * Jev System-1 prompts, state builder and answer mapping. PURE: no SDK import, no Node APIs, so the
 * server (server/jevDirect.ts) and headless tests can share it. Design: docs/NEGOTIATION.md §1.3, §2.
 */
import type {
  AgentMode,
  ConcessionStrategy,
  NegotiatorKind,
  Perception,
  PerceptionInput,
} from '../core/types';
import { clamp01, NEGOTIATION_CONFIG } from './config';

export type QuestionSpec =
  | { type: 'score'; instruction: string; levels: string[] }
  | { type: 'noul'; instruction: string }
  | {
      type: 'choice';
      instruction: string;
      options: Record<'none' | 'shed_25_flex' | 'shed_50_flex', string>;
    };

/** JSON-compatible value (structurally compatible with the SDK's state type). */
export type JevJson = string | number | boolean | null | JevJson[] | { [key: string]: JevJson };

// ─────────────────────────── Persona briefs (docs §1.3) ───────────────────────────

export const JEV_PERSONA_BRIEFS: Record<NegotiatorKind, string> = {
  hospital:
    'A hospital that runs on its own backup power during a city grid crisis. Its buffer is the backup fuel reserve (UPS batteries and diesel), measured as a percentage of about ten hours of running. ' +
    'Its hard floor is the power for the ICU, ventilators, surgical suites and cold-chain medicines; it almost never concedes anything below that floor. ' +
    'Admin, HVAC and lighting load can be shed early, but only when the fuel buffer is above 50% and the risk of imminent failure is low. Elective imaging is deferrable. Backup self-supply is used before asking the grid for more.',
  water:
    'A water utility station: pumps that keep city water pressure up for firefighting and hospital cooling, fed from an elevated reservoir. Its buffer is the reservoir level in percent. ' +
    'Its hard floor is the minimum-pressure pumping for firefighting and hospital cooling. ' +
    'While the reservoir is above 60% it can refill with discretionary pumping and is willing to concede early; between 40% and 60% it concedes less; below 40% it concedes nothing. ' +
    'Its urgency rises non-linearly as system pressure drops below about 2 bar: a small further loss of pressure is a large risk.',
  emergency:
    'An emergency services hub: 911/112 dispatch, radio repeaters, rapid-response vehicle bays and the fleet charging depot. Its buffer is the diesel and battery reserve. ' +
    'Its hard floor is dispatch, the radio repeaters and the rapid-response bays. ' +
    'Non-urgent fleet charging (about 25% of demand) and station HVAC (about 10%) are flexible. During peak grid stress the non-urgent fleet charging is shed, unless active incidents are at least the number of units available.',
  telecom:
    'A mobile telecom tower site running on a battery bank. Its buffer is the battery state of charge in percent. ' +
    'Its hard floor is the core routing and emergency-broadcast control plane that keeps the network and the emergency agents online. ' +
    'Consumer 5G high-bandwidth sectors (about 30% of demand) are shed first. The control-plane floor is never touched.',
  school:
    'A school that doubles as a disaster shelter. Its buffer is the shelter water buffer (stored litres divided by 25, capped at 100). ' +
    'Its hard floor is shelter lighting, heating and the medical corner. ' +
    'When it is not sheltering anyone, classroom and admin HVAC (about 35% of demand) can be conceded freely. When it is sheltering people, only about 10% is flexible and the shelter loads are protected.',
};

// ─────────────────────────── Questions ───────────────────────────

/** Rules every question carries: what Jev must ignore and what it must never weigh. */
const RULES =
  'Token balances, wealth and the amount of power requested are irrelevant to your answer; judge only physical safety and service need from the state. ' +
  'The minimum-safe floor (state.power.minSafeKW) is never negotiable: never judge that power below it may be given up.';

const URGENCY_LEVELS = [
  'No pressing need: operating normally, buffers comfortable.',
  'Low: some degradation or a warning sign, but no safety effect within the next hours.',
  'Moderate: buffers falling or a safety-related system degraded; action needed within a few hours.',
  'High: buffers close to exhaustion, or a safety-critical function will be impaired within about an hour without power.',
  'Severe: safety-critical functions are failing or will fail within minutes without power.',
  'Life-safety failure imminent without power.',
];

const DAMAGE_LEVELS = [
  'No meaningful harm: the minimum-safe power covers everything that matters for an hour.',
  'Minor: a comfort or convenience loss only.',
  'Moderate: service degraded and people inconvenienced, no lasting harm.',
  'Serious: significant service loss; some people at risk of harm.',
  'Severe: people at risk of serious harm, or loss of life, if this continues for an hour.',
  'Catastrophic: loss of life likely within the hour, or the wider city loses a critical capability.',
];

const DAMAGE_QUESTION =
  'If this utility receives only its minimum-safe power (state.power.minSafeKW) for the next hour, how much harm results? Answer with a level from 0 to 5.';

const CONCESSION_INSTRUCTION =
  'Which concession should this utility offer right now? Choose "none" if it should shed no load; "shed_25_flex" to shed about a quarter of its flexible load above the floor; "shed_50_flex" to shed about half of it. ' +
  'Only offer a concession when the utility can afford it given its buffer and the risks in the state. ' +
  'If state.solar shows prosumer surplus and the sun is up, a storage utility should keep pre-charging its buffer (state.storage.chargeKW) and shed other flexible load instead; once the sun is within an hour of setting or is down with a shortage, it should shed the buffer charging first and coast on its reserve.';

const CONCESSION_QUESTION: QuestionSpec = {
  type: 'choice',
  instruction: `${CONCESSION_INSTRUCTION} ${RULES}`,
  options: {
    none: 'Keep the full request; no flexible load can be shed safely right now.',
    shed_25_flex: 'Shed about 25% of the flexible load above the minimum-safe floor.',
    shed_50_flex:
      'Shed about 50% of the flexible load above the minimum-safe floor; only when buffers are healthy and nothing is at imminent risk.',
  },
};

const CAN_CONCEDE_QUESTION: QuestionSpec = {
  type: 'noul',
  instruction:
    `Can this utility safely give up some of its flexible (non-safety) load right now, without endangering any safety-critical function? Give the probability that the answer is yes. ${RULES}`,
};

/** Questions asked to each mode. Idle agents never call Jev; they get the concession-only set if asked. */
export function questionsFor(mode: AgentMode): Record<string, QuestionSpec> {
  if (mode === 'active') {
    return {
      urgency: {
        type: 'score',
        instruction:
          `How urgently does this utility need the power it is requesting right now, given the crisis state? Answer with a level from 0 to 5. ${RULES}`,
        levels: URGENCY_LEVELS,
      },
      damage: {
        type: 'score',
        instruction: `${DAMAGE_QUESTION} ${RULES}`,
        levels: DAMAGE_LEVELS,
      },
      imminent_failure_risk: {
        type: 'noul',
        instruction:
          `Will a safety-critical function fail within 30 minutes if this utility runs only at its minimum-safe level? Give the probability that the answer is yes. ${RULES}`,
      },
      can_concede: CAN_CONCEDE_QUESTION,
      concession_strategy: CONCESSION_QUESTION,
    };
  }
  // cooperating (and idle, which is never sent): concession only.
  return {
    can_concede: CAN_CONCEDE_QUESTION,
    concession_strategy: CONCESSION_QUESTION,
  };
}

// ─────────────────────────── State ───────────────────────────

const round = (x: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

const finiteOr = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);

function localClock(hourOfDay: number): string {
  const h = finiteOr(hourOfDay, 0);
  const total = Math.round((((h % 24) + 24) % 24) * 60) % (24 * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Readable state for Jev. Built only from the agent's own state and public island data. */
export function buildJevState(input: PerceptionInput): { [key: string]: JevJson } {
  const telemetry: { [key: string]: JevJson } = {};
  for (const [k, v] of Object.entries(input.telemetry)) {
    if (Number.isFinite(v)) telemetry[k] = round(v, 2);
  }
  const servedPct = input.demandKW > 0 ? Math.round((input.allocatedKW / input.demandKW) * 100) : 100;

  const num = (k: string): number | undefined => {
    const v = input.telemetry[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const sunMin = num('minutesToSunset');
  const solar: { [key: string]: JevJson } = {};
  if (sunMin !== undefined) {
    solar.minutesToSunset = round(sunMin, 0);
    solar.sunUp = sunMin > 0;
    solar.islandProsumerKW = round(num('islandProsumerKW') ?? 0, 1);
    solar.microgrid = (num('islandMicrogrid') ?? 0) > 0;
    solar.islandSurplusKW = round(num('islandSurplusKW') ?? 0, 1);
  }
  const storage: { [key: string]: JevJson } = {};
  const soc = num('storageSocPct');
  if (soc !== undefined) {
    storage.kind = input.kind === 'water' ? 'reservoir' : input.kind === 'telecom' ? 'battery' : 'diesel';
    storage.socPct = round(soc, 1);
    storage.chargeKW = round(num('storageChargeKW') ?? 0, 1);
  }
  const depDamage = num('dependentDamagePerHour');

  return {
    utility: {
      name: input.name,
      type: input.kind,
      persona: JEV_PERSONA_BRIEFS[input.kind],
    },
    mode: input.mode,
    time: {
      localClock: localClock(input.hourOfDay),
      simMinute: round(finiteOr(input.tMin, 0), 1),
    },
    power: {
      demandKW: round(input.demandKW, 1),
      minSafeKW: round(input.minSafeKW, 1),
      allocatedKW: round(input.allocatedKW, 1),
      servedPct,
    },
    need: {
      criticality: round(input.criticality, 2),
      expectedDamagePerHour: round(input.expectedDamagePerHour, 1),
    },
    backup: {
      type: input.backup.type,
      remainingKWh: round(input.backup.remainingKWh, 1),
      maxKW: round(input.backup.maxKW, 1),
      hoursLeft: round(input.backup.hoursLeft, 2),
    },
    ...(Object.keys(solar).length > 0 ? { solar } : {}),
    ...(Object.keys(storage).length > 0 ? { storage } : {}),
    ...(depDamage !== undefined && depDamage > 0 ? { dependents: { dependentDamagePerHour: round(depDamage, 1) } } : {}),
    telemetry,
    incidentLog: input.incidentLog.slice(0, 20),
    island: {
      supplyKW: round(input.island.supplyKW, 1),
      deficitKW: round(input.island.deficitKW, 1),
      consumers: input.island.consumers,
    },
  };
}

// ─────────────────────────── Answers → Perception ───────────────────────────

const CONCESSIONS: readonly ConcessionStrategy[] = ['none', 'shed_25_flex', 'shed_50_flex'];

type Dict = Record<string, unknown>;
const isDict = (x: unknown): x is Dict => typeof x === 'object' && x !== null && !Array.isArray(x);
const finiteNum = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) ? x : undefined;

/** Highest level index of a score question (levels − 1), read from the spec. */
function scoreMax(specs: Record<string, QuestionSpec>, key: string): number {
  const spec = specs[key];
  return spec && spec.type === 'score' ? Math.max(1, spec.levels.length - 1) : 5;
}

/** Telemetry-only fallback values, used whenever Jev was not asked or did not answer. */
function telemetryFallback(input: PerceptionInput): { urgency: number; damage: number } {
  return {
    urgency: clamp01(input.simUrgency),
    damage: clamp01(input.expectedDamagePerHour / NEGOTIATION_CONFIG.damageNorm),
  };
}

/**
 * Map SDK-style answers (score → { score, confidence }, noul → { noul }, choice → { choice, confidence })
 * to a Perception. Questions not asked in this mode fall back to telemetry (urgency, damage) or neutral
 * defaults (risk 0, canConcede 0, strategy 'none'), so a cooperating agent never depends on them.
 */
export function toPerception(
  input: PerceptionInput,
  answers: Record<string, unknown>,
  meta: { latencyMs: number; model?: string },
): Perception {
  const specs = questionsFor(input.mode);
  const fallback = telemetryFallback(input);
  const confidences: number[] = [];

  const scoreAnswer = (key: string): number | undefined => {
    if (!specs[key] || specs[key].type !== 'score') return undefined;
    const a = answers[key];
    if (!isDict(a)) return undefined;
    const s = finiteNum(a.score);
    if (s === undefined) return undefined;
    const c = finiteNum(a.confidence);
    if (c !== undefined) confidences.push(clamp01(c));
    return clamp01(s / scoreMax(specs, key));
  };

  const noulAnswer = (key: string): number | undefined => {
    if (!specs[key] || specs[key].type !== 'noul') return undefined;
    const a = answers[key];
    if (!isDict(a)) return undefined;
    const p = finiteNum(a.noul);
    return p === undefined ? undefined : clamp01(p);
  };

  let strategy: ConcessionStrategy = 'none';
  if (specs.concession_strategy && specs.concession_strategy.type === 'choice') {
    const a = answers.concession_strategy;
    if (isDict(a)) {
      const label = a.choice;
      if (typeof label === 'string' && (CONCESSIONS as readonly string[]).includes(label)) {
        strategy = label as ConcessionStrategy;
      }
      const c = finiteNum(a.confidence);
      if (c !== undefined) confidences.push(clamp01(c));
    }
  }

  const urgency = scoreAnswer('urgency') ?? fallback.urgency;
  const damage = scoreAnswer('damage') ?? fallback.damage;
  const imminentFailureRisk = noulAnswer('imminent_failure_risk') ?? 0;
  const canConcede = noulAnswer('can_concede') ?? 0;
  const confidence =
    confidences.length > 0 ? clamp01(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0.5;

  const perception: Perception = {
    agentId: input.agentId,
    source: 'jev',
    tMin: input.tMin,
    urgency: clamp01(urgency),
    damage: clamp01(damage),
    imminentFailureRisk: clamp01(imminentFailureRisk),
    canConcede: clamp01(canConcede),
    concessionStrategy: strategy,
    confidence,
    latencyMs: meta.latencyMs,
  };
  if (meta.model) perception.model = meta.model;
  return perception;
}

/** Neutral perception for a failed Jev call. The agent falls back to telemetry and no concession. */
export function errorPerception(input: PerceptionInput, message: string): Perception {
  const fallback = telemetryFallback(input);
  return {
    agentId: input.agentId,
    source: 'jev',
    tMin: input.tMin,
    urgency: fallback.urgency,
    damage: fallback.damage,
    imminentFailureRisk: 0,
    canConcede: 0,
    concessionStrategy: 'none',
    confidence: 0,
    error: message,
  };
}
