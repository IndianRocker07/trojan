/** Plain-English wording for everything new in the negotiation views. No jargon without a one-line explanation. */
import type { ReplayStageKind } from '../core/types';

export const TIP = {
  floor: 'The power it needs so nothing dangerous fails (its minimum-safe floor). The safety layer protects this first.',
  request: 'How much power this agent is asking for.',
  grant: 'How much power it was actually given at this step.',
  source_jev: 'Jev is the AI language model that read this agent’s live data and scored the situation.',
  source_heuristic: 'A simple built-in rule did the scoring, because the AI model was off, busy or too slow.',
  model: 'The raw scores the AI read from this agent’s live data before it decided what to ask for.',
  urgency: 'Urgency: how fast things get worse if it does not get power. 0 means no rush, 1 means right now.',
  damage: 'Damage: how much harm has already happened or is expected (people, equipment, supplies). 0 is none, 1 is severe.',
  risk: 'Failure risk: the chance that something critical stops working soon, for example backup fuel running out.',
  canConcede: 'Can concede: the share of its request it could give up to help others, without becoming unsafe.',
  confidence: 'Confidence: how sure the model is about these scores. Low confidence means treat them with care.',
  score: 'Priority score: how strongly this agent’s case ranks against the others right now. Higher gets served earlier.',
  deficit: 'How much less power the island has than everyone is asking for.',
  conceded: 'Power this agent offered to give up so others can have it.',
  tokens: 'Tokens are the agents’ fairness currency: giving way earns tokens, asking for extra spends them.',
} as const;

export const STANCE_PLAIN: Record<string, string> = {
  CRITICAL_HOLD: 'Holding firm: something critical depends on this power, so it will not give any up.',
  PARTIAL_CONCESSION: 'Willing to give up part of its request to help others.',
  FULL_FLEX_SHED: 'Giving up everything that can safely wait.',
};

export const STAGE_SHORT: Record<ReplayStageKind, string> = {
  perceive: 'Perceive',
  bid: 'Bids',
  clear: 'Clearing',
  notice: 'Shortfall',
  counter: 'Counter-offers',
  contract: 'Contracts',
  final: 'Final',
  safety: 'Safety',
  commit: 'Commit',
};

export const STAGE_HINT: Record<ReplayStageKind, string> = {
  perceive: 'Each agent reads its own live data and asks the AI model how bad things are.',
  bid: 'Each agent tells the clearing hub how much power it wants and why.',
  clear: 'The hub first covers every agent’s safe minimum, then shares what is left by priority.',
  notice: 'The hub tells each agent how much it is projected to get, and how short the island is.',
  counter: 'Agents can give some power up, or hold firm, and earn tokens for helping.',
  contract: 'Two agents agree a deal: one gives up power now, the other pays it back later.',
  final: 'The hub clears again with everyone’s updated offers.',
  safety: 'The safety layer checks the plan and corrects anything unsafe.',
  commit: 'The checked plan becomes real: power is delivered and tokens are paid out.',
};

export const KIND_PLAIN: Record<string, string> = {
  hospital: 'Hospital',
  emergency: 'Emergency station',
  water: 'Water utility',
  telecom: 'Telecom tower',
  school: 'School shelter',
  house: 'Households',
  clearing: 'Clearing hub',
  safety: 'Safety layer',
};

export const MSG_TAG: Record<string, string> = {
  perception: 'Reading its data',
  bid: 'Bid',
  notice: 'Shortfall notice',
  concession: 'Concession',
  contract: 'Contract',
  grant: 'Result',
  safety: 'Safety check',
  info: 'Info',
};

export const GLOSSARY: { term: string; text: string }[] = [
  { term: 'Jev / Heuristic', text: TIP.source_jev + ' ' + TIP.source_heuristic },
  { term: 'Urgency', text: TIP.urgency },
  { term: 'Damage', text: TIP.damage },
  { term: 'Failure risk', text: TIP.risk },
  { term: 'Can concede', text: TIP.canConcede },
  { term: 'Confidence', text: TIP.confidence },
  { term: 'Floor', text: TIP.floor },
  { term: 'Tokens', text: TIP.tokens },
];
