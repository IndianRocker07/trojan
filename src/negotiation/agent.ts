/**
 * UtilityAgent — one negotiating agent per hospital / water / emergency / telecom / school
 * (docs/NEGOTIATION.md §1). Builds its bid from its OWN telemetry plus public island data only (FR-2.7).
 * Perception can shift urgency (bounded blend) and unlock concessions; it can never change minSafeKW.
 */
import type {
  AgentCaseBrief,
  AgentMode,
  FlexLoad,
  NegotiatorKind,
  Perception,
  PerceptionInput,
  ShortfallNotice,
  Stance,
  UtilityAgentState,
  UtilityBid,
} from '../core/types';
import type { Assessment, NegotiatingAgent, Proposal, PublicIslandInfo } from './agentApi';
import { NEGOTIATION_CONFIG, clamp01, type NegotiationConfig } from './config';
import { CHARGE_LABEL, PERSONAS, bufferDecayUrgency, type Persona } from './personas';

const R = Math.round;
const f1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);
const tel = (s: UtilityAgentState, k: string, d = 0): number => {
  const v = s.telemetry[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
};
const backupHoursOf = (s: UtilityAgentState): number => (s.backup.maxKW > 0 && s.backup.remainingKWh > 0 ? s.backup.remainingKWh / s.backup.maxKW : 0);
const STRATEGY_FRACTION = { none: 0, shed_25_flex: 0.25, shed_50_flex: 0.5 } as const;

interface IslandLike {
  islandId: number;
  tMin: number;
  deficitKW: number;
}

export class UtilityAgent implements NegotiatingAgent {
  readonly id: string;
  readonly kind: NegotiatorKind;
  readonly name: string;
  private served = 1;
  private persona: Persona;
  private depNames: string[] = [];
  /** Outcome of the last synthesize(): buffer-charging kW still requested, how it was treated, kW conceded from it. */
  lastCharge: { requestedKW: number; mode: 'normal' | 'precharge' | 'coast' | 'hold'; concededKW: number } = { requestedKW: 0, mode: 'normal', concededKW: 0 };
  private lastPublic: PublicIslandInfo | undefined;

  constructor(
    id: string,
    kind: NegotiatorKind,
    name: string,
    private cfg: NegotiationConfig = NEGOTIATION_CONFIG,
  ) {
    this.id = id;
    this.kind = kind;
    this.name = name;
    this.persona = PERSONAS[kind];
  }

  /** Names of the buildings this utility feeds (resolved by the policy from public building data). */
  setDependentNames(names: string[]): void {
    this.depNames = names;
  }

  get recentServedShare(): number {
    return this.served;
  }

  assess(state: UtilityAgentState, island: PublicIslandInfo): Assessment {
    const c = this.cfg;
    const reasons: string[] = [];
    const dist = tel(state, 'distanceToImpactM', Infinity);
    if (dist <= c.affectedRadiusM) reasons.push(`Disaster damage ${R(dist)} m away`);
    if (state.demandKW > 0) {
      const frac = state.allocatedKW / state.demandKW;
      if (frac < c.affectedServedFrac) reasons.push(`Only ${R(frac * 100)}% of demand served (${R(state.allocatedKW)} of ${R(state.demandKW)} kW)`);
    }
    if (state.urgency >= c.affectedUrgency) reasons.push(`Urgency ${state.urgency.toFixed(2)} (threshold ${c.affectedUrgency.toFixed(2)})`);

    const onBackup = state.allocatedKW < state.demandKW && state.backup.remainingKWh > 0;
    switch (this.kind) {
      case 'hospital': {
        const wsp = tel(state, 'waterSupplyPct', 100);
        if (wsp < 50) reasons.push(`Mains water supply at ${R(wsp)}%`);
        const fuel = tel(state, 'backupFuelHours', backupHoursOf(state));
        if (fuel < 2 && onBackup) reasons.push(`Running on backup (${f1(fuel)} h left)`);
        break;
      }
      case 'water': {
        const r = tel(state, 'reservoirPct', 100);
        const p = tel(state, 'pressureBar', 3);
        if (r < 40) reasons.push(`Reservoir at ${R(r)}%`);
        if (p < 2) reasons.push(`Pressure ${p.toFixed(1)} bar (below 2.0)`);
        break;
      }
      case 'telecom': {
        const b = tel(state, 'batteryPct', 100);
        if (b < 50) reasons.push(`Battery at ${R(b)}%`);
        break;
      }
      case 'school': {
        const sh = tel(state, 'sheltered');
        if (sh > 0) reasons.push(`Sheltering ${R(sh)} people`);
        break;
      }
      case 'emergency': {
        const inc = tel(state, 'activeIncidents');
        if (inc > 0) reasons.push(`${R(inc)} active incidents`);
        break;
      }
    }

    const affected = reasons.length > 0;
    const short = island.totalRequestKW > 0 && island.deficitKW / island.totalRequestKW > c.cooperateDeficitFrac;
    if (short) {
      reasons.push(
        affected
          ? `Island ${island.islandId} is ${R(island.deficitKW)} kW short`
          : `Island ${island.islandId} is ${R(island.deficitKW)} kW short; asked to use less`,
      );
    }
    const mode: AgentMode = affected ? 'active' : short ? 'cooperating' : 'idle';
    return { mode, affected, reasons };
  }

  perceptionInput(state: UtilityAgentState, island: PublicIslandInfo, mode: AgentMode): PerceptionInput {
    const hoursLeft = backupHoursOf(state);
    const telemetry: Record<string, number> = { ...state.telemetry };
    telemetry.backupPct = state.backup.capacityKWh > 0 ? clamp01(state.backup.remainingKWh / state.backup.capacityKWh) * 100 : 0;
    const log: string[] = [];
    const dist = tel(state, 'distanceToImpactM', Infinity);
    if (Number.isFinite(dist) && dist < 5000) log.push(`Nearest damaged area ${R(dist)} m away`);
    if (state.backup.type !== 'none') log.push(`Backup ${state.backup.type}: ${f1(hoursLeft)} h left at ${R(state.backup.maxKW)} kW`);
    if (state.demandKW > 0) log.push(`Grid supplying ${R(state.allocatedKW)} of ${R(state.demandKW)} kW demand (floor ${R(state.minSafeKW)} kW)`);
    if (!state.connected) log.push('Lost its path to a generator');
    switch (this.kind) {
      case 'hospital':
        log.push(`ICU ${R(tel(state, 'icuPatients'))}/${R(tel(state, 'icuBeds'))} beds, ${R(tel(state, 'incomingPerHour'))} patients arriving per hour`);
        if (tel(state, 'waterSupplyPct', 100) < 100) log.push(`Mains water supply at ${R(tel(state, 'waterSupplyPct', 100))}%`);
        break;
      case 'water':
        log.push(`Reservoir ${R(tel(state, 'reservoirPct'))}%, pressure ${tel(state, 'pressureBar').toFixed(1)} bar`);
        break;
      case 'telecom':
        log.push(`Battery ${R(tel(state, 'batteryPct'))}%, network load ${R(tel(state, 'loadPct'))}%`);
        break;
      case 'school':
        log.push(`${R(tel(state, 'sheltered'))} people sheltering, ${R(tel(state, 'medicalCases'))} medical cases`);
        break;
      case 'emergency':
        log.push(`${R(tel(state, 'activeIncidents'))} active incidents, ${R(tel(state, 'unitsAvailable'))} units available`);
        break;
    }
    if (state.storage) {
      telemetry.storageSocPct = state.storage.socPct;
      telemetry.storageChargeKW = state.storage.chargeKW;
      log.push(`${state.storage.kind} ${R(state.storage.socPct)}%, ${R(state.storage.chargeKW)} kW of its demand is buffer charging (sheddable)`);
    }
    if (state.dependentDamagePerHour !== undefined && state.dependentDamagePerHour > 0) {
      telemetry.dependentDamagePerHour = state.dependentDamagePerHour;
      log.push(`Feeds ${state.dependents?.length ?? 0} dependent buildings: +${R(state.dependentDamagePerHour)} damage/h if it fails`);
    }
    if (state.der) {
      telemetry.selfSupplyKW = state.der.selfSupplyKW;
      telemetry.exportedKW = state.der.exportedKW;
      log.push(`Own solar ${f1(state.der.solarKW)} kW, battery ${R(state.der.batteryPct)}%, self-supplying ${f1(state.der.selfSupplyKW)} kW`);
    }
    if (island.minutesToSunset !== undefined) {
      telemetry.minutesToSunset = island.minutesToSunset;
      telemetry.islandProsumerKW = island.prosumerKW ?? 0;
      telemetry.islandMicrogrid = island.microgrid ? 1 : 0;
      telemetry.islandSurplusKW = island.surplusKW ?? 0;
      log.push(
        island.minutesToSunset > 0
          ? `Sun sets in ${R(island.minutesToSunset)} min; island has ${R(island.prosumerKW ?? 0)} kW prosumer solar${island.microgrid ? ' (microgrid)' : ''}, ${R(island.surplusKW ?? 0)} kW surplus`
          : `Sun is down (${R(-island.minutesToSunset)} min since sunset); island has ${R(island.prosumerKW ?? 0)} kW prosumer supply${island.microgrid ? ' (microgrid)' : ''}`,
      );
    }
    if (island.deficitKW > 0) log.push(`Island ${island.islandId} (${island.consumers} consumers) is short by ${R(island.deficitKW)} of ${R(island.totalRequestKW)} kW requested`);
    return {
      agentId: this.id,
      kind: this.kind,
      name: this.name,
      mode,
      tMin: island.tMin,
      hourOfDay: island.hourOfDay,
      demandKW: state.demandKW,
      minSafeKW: state.minSafeKW,
      allocatedKW: state.allocatedKW,
      criticality: state.criticality,
      simUrgency: state.urgency,
      expectedDamagePerHour: state.expectedDamagePerHour,
      backup: { type: state.backup.type, remainingKWh: state.backup.remainingKWh, maxKW: state.backup.maxKW, hoursLeft },
      telemetry,
      incidentLog: log,
      island: { supplyKW: island.supplyKW, totalRequestKW: island.totalRequestKW, deficitKW: island.deficitKW, consumers: island.consumers },
    };
  }

  propose(
    state: UtilityAgentState,
    perception: Perception | undefined,
    island: PublicIslandInfo,
    assessment: Assessment,
    tokenBalance: number,
  ): Proposal {
    this.lastPublic = island;
    return this.synthesize(state, perception, island, island, assessment.mode, 1, tokenBalance, undefined);
  }

  respond(notice: ShortfallNotice, prev: Proposal, state: UtilityAgentState, perception: Perception | undefined, tokenBalance: number): Proposal {
    const island: PublicIslandInfo = {
      islandId: notice.islandId,
      tMin: prev.bid.tMin,
      hourOfDay: 0,
      supplyKW: notice.supplyKW,
      totalRequestKW: notice.totalRequestKW,
      totalMinSafeKW: notice.totalMinSafeKW,
      deficitKW: notice.deficitKW,
      consumers: 0,
    };
    const lp = this.lastPublic;
    if (lp) {
      island.hourOfDay = lp.hourOfDay;
      if (lp.microgrid !== undefined) island.microgrid = lp.microgrid;
      if (lp.prosumerKW !== undefined) island.prosumerKW = lp.prosumerKW;
      if (lp.utilityDerKW !== undefined) island.utilityDerKW = lp.utilityDerKW;
      if (lp.minutesToSunset !== undefined) island.minutesToSunset = lp.minutesToSunset;
      if (lp.surplusKW !== undefined) island.surplusKW = lp.surplusKW;
    }
    return this.synthesize(state, perception, island, island, prev.bid.mode, Math.max(2, notice.round), tokenBalance, notice);
  }

  observe(finalKW: number, demandKW: number): void {
    if (!(demandKW > 0)) return;
    const share = clamp01(finalKW / demandKW);
    this.served += this.cfg.fairnessAlpha * (share - this.served);
  }

  // ─────────────────────────── bid synthesis ───────────────────────────

  private synthesize(
    state: UtilityAgentState,
    p: Perception | undefined,
    island: PublicIslandInfo,
    il: IslandLike,
    mode: AgentMode,
    round: number,
    tokenBalance: number,
    notice: ShortfallNotice | undefined,
  ): Proposal {
    const c = this.cfg;
    const demand = Math.max(0, state.demandKW);
    const minSafe = Math.max(0, state.minSafeKW);
    const floor = Math.min(minSafe, demand); // request never below this
    const persona = this.persona;

    const alpha = p && mode !== 'idle' ? c.perceptionBlend * clamp01(p.confidence) : 0;
    let urgency = clamp01((1 - alpha) * state.urgency + alpha * (p ? clamp01(p.urgency) : 0));

    // buffer state of charge -> time-decay urgency (docs/MICROGRID.md 6.5)
    const soc = state.storage ? state.storage.socPct : this.kind === 'school' ? undefined : this.persona.bufferPct(state);
    if (mode !== 'idle' && soc !== undefined) urgency = Math.max(urgency, clamp01(bufferDecayUrgency(soc, c)));

    // dependency-weighted damage (6.4): own + min(dependent, cap x own)
    const ownDamage = Math.max(0, state.expectedDamagePerHour);
    const depDamage = Math.max(0, state.dependentDamagePerHour ?? 0);
    const effDamage = ownDamage + Math.min(depDamage, c.dependentDamageCap * ownDamage);

    // flex loads. Harm-aware (c.harmAwareConcessions): only COVERED load is offered — buffer charging and
    // load the agent's own backup carries. Uncovered persona flex (HVAC, 5G, fleet...) is offered only on surplus.
    const rawFlex = persona.flexLoads(state, island);
    if (state.storage && !(state.storage.chargeKW > 0)) {
      // nothing is charging: drop any stale charge flex
      const k = rawFlex.findIndex((f) => f.label === CHARGE_LABEL);
      if (k >= 0) rawFlex.splice(k, 1);
    }
    const room = Math.max(0, demand - floor);
    const harmAware = c.harmAwareConcessions;
    const surplus = il.deficitKW <= 0;
    const bkHours = backupHoursOf(state);
    // load the agent's own backup carries while fuel/battery lasts (the sim draws it automatically)
    const backupCover =
      harmAware && state.backup.maxKW > 0 && bkHours > c.backupSelfSupplyHours ? Math.max(0, Math.min(state.backup.maxKW, il.deficitKW, room)) : 0;
    const chargeRaw = rawFlex.find((f) => f.label === CHARGE_LABEL)?.kw ?? 0;
    const otherRaw = rawFlex.filter((f) => f.label !== CHARGE_LABEL);
    const otherRawSum = otherRaw.reduce((a, f) => a + f.kw, 0);
    const useUncovered = !harmAware || surplus;
    const chargeKW0 = Math.min(chargeRaw, room);
    const uncoveredKW = useUncovered ? Math.min(otherRawSum, Math.max(0, room - chargeKW0)) : 0;
    const flex: FlexLoad[] = [];
    if (chargeKW0 > 0) flex.push({ label: CHARGE_LABEL, kw: chargeKW0, maxDurationMin: 240 });
    if (backupCover > 0) flex.push({ label: `Own ${state.backup.type} backup self-supply`, kw: backupCover, maxDurationMin: 60 });
    if (uncoveredKW > 0) for (const f of otherRaw) flex.push({ label: f.label, kw: (f.kw * uncoveredKW) / otherRawSum, maxDurationMin: f.maxDurationMin });
    const deferrable = !useUncovered ? otherRaw.filter((f) => f.kw >= 1).map((f) => f.label) : [];
    const flexibleKW = Math.min(room, chargeKW0 + backupCover + uncoveredKW);

    // buffer charging: pre-charge on surplus, coast otherwise (6.2)
    const chargeFlex = flex.find((f) => f.label === CHARGE_LABEL)?.kw ?? 0;
    const sun = island.minutesToSunset;
    const sunUp = sun !== undefined && sun > 0;
    let chargeMode: 'normal' | 'precharge' | 'coast' | 'hold' = 'normal';
    if (chargeFlex >= 0.5 && sun !== undefined) {
      if (soc !== undefined && soc < c.coastMinSoc) chargeMode = 'hold';
      else if (mode !== 'idle' && ((sunUp && sun < c.coastWindowMin) || (!sunUp && il.deficitKW > 0))) chargeMode = 'coast';
      else if (sunUp && (island.surplusKW ?? 0) > 0) chargeMode = 'precharge';
    }
    const chargeSep = chargeMode === 'normal' ? 0 : chargeFlex;
    const normalCharge = chargeMode === 'normal' ? chargeFlex : 0; // sheddable at no harm whenever the agent concedes at all
    const scaledPool = uncoveredKW; // uncovered load: only on surplus, scaled by the concession fraction
    const otherFlex = Math.max(0, normalCharge + backupCover + scaledPool);
    const chargeConceded = chargeMode === 'coast' ? chargeFlex : 0;

    // concession decision
    const guard = persona.canConcede(state, p, island);
    const canConcedeP = p ? p.canConcede : mode === 'cooperating' ? 0.8 : 0;
    const critHold = state.criticality >= c.criticalThreshold && !!p && p.imminentFailureRisk >= 0.6;
    const roundAllows = mode === 'cooperating' || (mode === 'active' && round >= 2 && il.deficitKW > 0);
    let strategy = p ? p.concessionStrategy : 'none';
    if (mode === 'cooperating' && il.deficitKW > 0 && STRATEGY_FRACTION[strategy] < STRATEGY_FRACTION.shed_25_flex) strategy = 'shed_25_flex';
    let frac = 0;
    let why = '';
    if (mode === 'idle') why = 'Operating normally; no concession needed.';
    else if (otherFlex < 1) why = deferrable.length > 0 ? `no covered load to shed (backup/charging); ${deferrable.slice(0, 2).join(' and ')} would only add harm in a shortage` : `no flexible load above the ${R(floor)} kW floor`;
    else if (critHold) why = `imminent failure risk ${p ? p.imminentFailureRisk.toFixed(2) : ''} on a critical service`;
    else if (!guard.ok) why = guard.reason.replace(/\.$/, '');
    else if (canConcedeP < 0.5) why = `perception rates its capacity to concede at ${canConcedeP.toFixed(2)}`;
    else if (!roundAllows) why = '';
    else if (strategy === 'none') why = 'perception advises holding';
    else frac = STRATEGY_FRACTION[strategy];

    const chargeShed = frac > 0 ? normalCharge : 0;
    let conceded = (frac > 0 ? backupCover : 0) + chargeShed + frac * scaledPool + chargeConceded;
    this.lastCharge = {
      requestedKW: chargeFlex > 0 ? (chargeMode === 'normal' ? chargeFlex - chargeShed : chargeFlex - chargeConceded) : 0,
      mode: chargeMode,
      concededKW: chargeMode === 'coast' ? chargeConceded : 0,
    };
    const request = Math.max(floor, demand - conceded);
    conceded = demand - request;

    const willingness =
      mode === 'idle' || (chargeConceded < 0.5 && (!guard.ok || critHold || otherFlex < 1)) ? 0 : clamp01(Math.max(canConcedeP, mode === 'cooperating' ? 0.8 : 0) + (mode === 'cooperating' ? 0.2 : 0));

    // tokens: bounded, secondary, only when a shortfall is projected (round >= 2)
    let tokens = 0;
    if (notice && mode !== 'idle' && notice.projectedKW + 1e-6 < notice.requestKW) {
      tokens = Math.max(0, Math.min(tokenBalance * c.maxOfferFraction, c.tokenBidCap));
    }

    const stance: Stance =
      conceded < 0.5 ? 'CRITICAL_HOLD' : flexibleKW > 0 && conceded >= flexibleKW * 0.98 ? 'FULL_FLEX_SHED' : 'PARTIAL_CONCESSION';

    const bid: UtilityBid = {
      agentId: this.id,
      kind: this.kind,
      islandId: island.islandId,
      tMin: island.tMin,
      round,
      mode,
      requestKW: request,
      originalRequestKW: demand,
      minSafeKW: minSafe,
      criticality: state.criticality,
      urgency,
      expectedDamagePerHour: effDamage,
      flexibleKW,
      flex,
      concededKW: conceded,
      concessionWillingness: willingness,
      backupRemainingKWh: state.backup.remainingKWh,
      backupHours: backupHoursOf(state),
      recentServedShare: this.served,
      tokensOffered: tokens,
    };

    const extras: string[] = [];
    if (chargeMode === 'precharge') extras.push(`Pre-charging ${this.persona.bufferLabel} ${soc !== undefined ? R(soc) : '?'}% → 100% on prosumer surplus (${R(chargeFlex)} kW).`);
    else if (chargeMode === 'hold') extras.push(`${this.persona.bufferLabel} only ${soc !== undefined ? R(soc) : '?'}%, so its ${R(chargeFlex)} kW of charging is kept.`);
    if (soc !== undefined && soc < 30 && this.kind !== 'school') {
      const hrs = backupHoursOf(state);
      const mins = hrs * 60;
      extras.push(`${this.persona.bufferLabel} ${R(soc)}%${mins > 0 ? ` — ~${mins < 180 ? `${R(mins)} min` : `${f1(hrs)} h`} left` : ''}.`);
    }

    const brief: AgentCaseBrief = {
      agentId: this.id,
      utilityType: this.kind,
      stance,
      jevUrgencyScore: p ? clamp01(p.urgency) : clamp01(state.urgency),
      jevDamageScore: p ? clamp01(p.damage) : clamp01(effDamage / c.damageNorm),
      jevConfidence: p ? clamp01(p.confidence) : 0,
      perceptionSource: p && mode !== 'idle' ? p.source : 'none',
      primaryArgument: this.argument(state, island, mode, notice, extras, effDamage - ownDamage),
      concessionOffer: this.offerWithCharge(
        this.offer(mode, round, conceded, flexibleKW, flex, floor, why, guard.ok && !critHold && canConcedeP >= 0.5, il.deficitKW > 0, backupCover > 0 && frac > 0 ? `Running ${R(backupCover)} kW of load on ${state.backup.type} (${f1(bkHours)} h left) to free grid power` : '', deferrable),
        chargeMode,
        chargeFlex,
        chargeConceded,
        conceded,
        soc,
        sun,
      ),
      renegotiationRound: round,
    };
    return { bid, brief };
  }

  private dependentsText(state: UtilityAgentState, depGain: number): string {
    if (!(depGain > 0.5)) return '';
    const names = this.depNames;
    const n = state.dependents?.length ?? names.length;
    const who = names.length === 0 ? `${n} dependent building${n === 1 ? '' : 's'}` : names.length <= 3 ? names.join(' & ') : `${names.slice(0, 2).join(' & ')} and ${names.length - 2} more`;
    const loss = this.kind === 'water' ? 'pressure' : this.kind === 'telecom' ? 'coverage' : 'service';
    return ` Feeds ${who}: +${R(depGain)} dmg/h if ${loss} is lost.`;
  }

  private offerWithCharge(base: string, mode: 'normal' | 'precharge' | 'coast' | 'hold', chargeFlex: number, chargeConceded: number, conceded: number, soc: number | undefined, sun: number | undefined): string {
    const label = this.persona.bufferLabel;
    const s = soc !== undefined ? ` ${R(soc)}%` : '';
    if (mode === 'coast' && chargeConceded >= 0.5) {
      const why =
        this.depNames.length > 0 ? `scarce power is kept for ${this.depNames.slice(0, 2).join(" & ")}` : sun !== undefined && sun <= 0 ? 'scarce night-time power goes to critical loads' : 'solar power is kept for critical loads at sunset';
      const rest = conceded - chargeConceded;
      return `Coasting on ${label}${s} so ${why}: deferring ${R(chargeConceded)} kW of buffer charging${rest >= 0.5 ? ` and ${R(rest)} kW of other flexible load` : ''}.`;
    }
    if (mode === 'precharge') return `${base} Pre-charging ${label}${s} → 100% on prosumer surplus: holding ${R(chargeFlex)} kW of buffer charging.`;
    return base;
  }

  private argument(state: UtilityAgentState, island: PublicIslandInfo, mode: AgentMode, notice: ShortfallNotice | undefined, extras: string[], depGain: number): string {
    const tail = this.dependentsText(state, depGain) + (extras.length > 0 ? ` ${extras.join(' ')}` : '');
    return (this.argumentBase(state, island, mode, notice) + tail).trim();
  }

  private argumentBase(state: UtilityAgentState, island: PublicIslandInfo, mode: AgentMode, notice: ShortfallNotice | undefined): string {
    if (mode === 'idle') return 'Operating normally; requesting nominal load.';
    if (!(state.demandKW > 0)) return 'Offline or destroyed; requesting no load.';
    const floorTxt = `${R(state.minSafeKW)} kW (${this.persona.floorLabel})`;
    if (mode === 'cooperating') {
      return `Not directly affected (${this.persona.situation(state)}); island ${island.islandId} is ${R(island.deficitKW)} kW short, so the ${floorTxt} floor stays protected while flexible load is offered.`;
    }
    let s = `${this.persona.situation(state)}; cannot go below ${floorTxt}.`;
    if (notice && notice.projectedKW < notice.requestKW) {
      s += ` Projected ${R(notice.projectedKW)} of ${R(notice.requestKW)} kW requested.`;
    } else if (state.demandKW > 0) {
      s += ` Needs ${R(state.demandKW)} kW; urgency ${state.urgency.toFixed(2)}.`;
    }
    return s;
  }

  private offer(
    mode: AgentMode,
    round: number,
    conceded: number,
    flexibleKW: number,
    flex: FlexLoad[],
    floor: number,
    why: string,
    willing: boolean,
    short: boolean,
    backupNote = '',
    deferrable: string[] = [],
  ): string {
    if (mode === 'idle') return 'None needed — island has surplus.';
    if (floor <= 0 && flexibleKW <= 0) return 'No concession: no load requested.';
    const labels = flex.filter((f) => f.kw >= 1).map((f) => f.label);
    const what = labels.length > 2 ? `${labels.slice(0, 2).join(', ')} and more` : labels.join(' and ');
    const defTxt = deferrable.length > 0 ? ` Deferrable only on surplus: ${deferrable.slice(0, 2).join(', ')}.` : '';
    if (conceded >= 0.5 && backupNote) {
      const rest = flex.filter((f) => f.kw >= 1 && !f.label.includes('backup')).map((f) => f.label).join(' and ');
      return `${backupNote}${rest ? `; also deferring ${rest}` : ''}; ${R(floor)} kW floor locked.${defTxt}`;
    }
    if (conceded >= 0.5) return `Willing to defer ${R(conceded)} kW of ${what} while the ${R(floor)} kW floor is locked.${defTxt}`;
    if (why) return `No concession: ${why}.${defTxt}`;
    if (willing && flexibleKW >= 1 && round < 2 && short) return `Ready to defer up to ${R(flexibleKW)} kW of ${what} if the shortage persists; ${R(floor)} kW floor locked.`;
    if (willing && flexibleKW >= 1) return `Holding ${R(flexibleKW)} kW of deferrable ${what} in reserve; ${R(floor)} kW floor locked.`;
    return 'No concession offered this round.';
  }
}
