# CRITICAL ARCHITECTURAL CORRECTION: NEED-BASED BIDDING

This requirement overrides any previous interpretation of token-based bidding in Trojan.

## 1. Core principle

Trojan must implement a NEED-BASED ELECTRICITY AUCTION, not a virtual-currency auction.

The strength and priority of an agent's bid must primarily depend on:

1. Power requirement.
2. Criticality.
3. Urgency.
4. Expected damage from power loss.
5. Minimum safe power requirement.

Virtual tokens must NOT determine who deserves electricity.

An agent with more tokens must never automatically outrank an agent with greater humanitarian or operational need.

## 2. Bid construction

Every utility agent must independently construct a structured bid from its actual simulation telemetry.

Each bid must contain:

- Agent ID.
- Requested power (kW).
- Minimum safe power (kW).
- Criticality score.
- Current urgency score.
- Expected damage from power loss.
- Flexible power demand.
- Backup availability.
- Recent allocation history.
- Concession willingness.
- Optional token commitment.

The first five factors are the primary bidding inputs.

Token commitment is strictly optional and secondary.

## 3. Need-based priority evaluation

Implement a transparent, configurable priority-scoring mechanism.

The scoring mechanism must incorporate:

- Criticality: humanitarian and operational importance.
- Urgency: immediate severity of the agent's need.
- Expected damage: consequences of insufficient electricity.
- Power requirement: magnitude and nature of the unmet demand.
- Minimum safe requirement: protected electricity threshold.

Avoid treating raw requested kW as an automatic advantage. Larger consumers should not win simply because they request more electricity.

Use normalisation, meaningful scoring and documented weighting.

The scoring mechanism should adapt to actual telemetry and crisis conditions.

## 4. Minimum safe power protection

Minimum safe power must be treated as a protected allocation requirement, not merely another ordinary scoring factor.

The auction should:

1. Determine the total minimum safe demand.
2. Check whether available supply can satisfy it.
3. Protect minimum safe requirements where physically feasible.
4. If supply is insufficient, prioritise minimum-safe allocations according to humanitarian criticality, urgency and expected damage.
5. Distribute remaining electricity based on the need-based auction.
6. Pass every proposed allocation through the independent safety validator.

Never promise that all agents can receive minimum safe power when physical supply makes this impossible.

## 5. Role of virtual tokens

Retain the virtual token economy, but fundamentally change its role.

Tokens are for:
- Rewarding voluntary concessions.
- Encouraging flexible consumption.
- Rewarding deferred demand.
- Supporting cooperative forward contracts.
- Tracking historical cooperation.

Tokens are NOT for:
- Purchasing humanitarian priority.
- Overriding criticality.
- Overriding urgency.
- Overriding minimum safe power.
- Outbidding a hospital or emergency utility.

An agent may commit tokens as a secondary expression of willingness to cooperate, but the token contribution must have a tightly bounded influence and must never change protected minimum-safe allocation decisions.

## 6. Auction outcome

The final allocation must reflect:

- Actual electricity requirements.
- Operational criticality.
- Immediate urgency.
- Expected damage from power loss.
- Minimum safe power protection.
- Available physical supply.
- Fairness over time.
- Voluntary concessions.

The auction must produce explainable outcomes.

For every allocation, the system must be able to explain:

"Why did this agent receive this amount of electricity?"

The explanation must reference the actual bidding factors and allocation constraints.

## 7. Required tests

Add tests proving that:

- An agent with more tokens cannot automatically defeat a more critical agent.
- A hospital's protected minimum-safe requirement is prioritised where physically feasible.
- Urgency changes affect auction outcomes.
- Expected damage changes affect auction outcomes.
- Larger power requests do not automatically receive higher priority.
- Agents with zero tokens can still win electricity auctions based on need.
- Token rewards encourage concessions without distorting humanitarian priorities.

## Final principle

Trojan is a humanitarian resource allocation system.

Electricity must be allocated according to NEED, not WEALTH.

The auction should simulate independent agents competing and cooperating based on operational requirements and potential harm, while virtual tokens serve only as a secondary mechanism for encouraging cooperation.
