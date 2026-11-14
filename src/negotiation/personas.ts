/**
 * Utility personas (docs/NEGOTIATION.md §1.3, PDF §4): buffer metric, hard-floor label, flexible loads,
 * concession guardrails, Jev brief and heuristic urgency non-linearities. Pure functions of an agent's own
 * state plus public island data.
 */
import type { FlexLoad, NegotiatorKind, Perception, UtilityAgentState } from '../core/types';
import type { PublicIslandInfo } from './agentApi';
import { NEGOTIATION_CONFIG } from './config';

/** The part of an agent's view that buffer / urgency functions need (satisfied by state and by PerceptionInput). */
export interface PersonaProbe {
  backup: { remainingKWh: number; maxKW: number; capacityKWh?: number };
  telemetry: Record<string, number>;
}

export interface ConcessionGuard {
  ok: boolean;
  reason: string;
}

export interface Persona {
  kind: NegotiatorKind;
  /** What the hard floor (= minSafeKW) protects. */
  floorLabel: string;
  /** Short name of the buffer metric, e.g. "backup fuel". */
  bufferLabel: string;
  /** Buffer metric 0..100 (how long the utility can ride out an outage). */
  bufferPct(s: PersonaProbe): number;
  /** Sheddable / deferrable loads above the floor (raw; the agent scales them to demand - minSafe). */
  flexLoads(state: UtilityAgentState, island: PublicIslandInfo): FlexLoad[];
  /** Persona guardrail: may this utility concede flexible load right now? */
  canConcede(state: UtilityAgentState, perception: Perception | undefined, island: PublicIslandInfo): ConcessionGuard;
  /** Heuristic urgency non-linearity (used by heuristicPerception only). */
  urgencyAdjust(u: number, s: PersonaProbe): number;
  /** Short facts with real numbers for the case brief. */
  situation(state: UtilityAgentState): string;
  /** One paragraph describing the utility for Jev. */
  jevBrief: string;
}

const cfg = NEGOTIATION_CONFIG;
const t = (s: { telemetry: Record<string, number> }, k: string, d = 0): number => {
  const v = s.telemetry[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
};
const pct = (x: number): number => Math.max(0, Math.min(100, Number.isFinite(x) ? x : 0));
const backupPctOf = (s: PersonaProbe): number => {
  const direct = s.telemetry.backupPct;
  if (typeof direct === 'number' && Number.isFinite(direct)) return pct(direct);
  const cap = s.backup.capacityKWh ?? 0;
  return cap > 0 ? pct((s.backup.remainingKWh / cap) * 100) : 0;
};
const backupHoursOf = (s: PersonaProbe): number => (s.backup.maxKW > 0 ? s.backup.remainingKWh / s.backup.maxKW : 0);
const flex = (label: string, kw: number, maxDurationMin: number): FlexLoad => ({ label, kw: Math.max(0, kw), maxDurationMin });
const R = Math.round;
const f1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);

/** Label of the sheddable buffer-charging flex item (agent.ts recognises it). */
export const CHARGE_LABEL = 'Buffer charging (pre-charge)';

/** Time-decay buffer urgency exp(−k·soc%), only below cfg.bufferDecayBelowPct (docs/MICROGRID.md §6.5). 0 otherwise. */
export function bufferDecayUrgency(socPct: number, c = cfg): number {
  const s = pct(socPct);
  return s < c.bufferDecayBelowPct ? Math.exp(-c.bufferDecayK * s) : 0;
}

/** Buffer SoC % of a utility: published storage SoC when present (telemetry.storageSocPct), else the persona metric. */
export function bufferSocOf(kind: NegotiatorKind, s: PersonaProbe): number | undefined {
  const direct = s.telemetry.storageSocPct;
  if (typeof direct === 'number' && Number.isFinite(direct)) return pct(direct);
  if (kind === 'water' || kind === 'telecom' || kind === 'hospital' || kind === 'emergency') return PERSONAS[kind].bufferPct(s);
  return undefined;
}

const chargeItem = (state: UtilityAgentState): FlexLoad[] => {
  const c = state.storage?.chargeKW;
  return typeof c === 'number' && c > 0 ? [flex(CHARGE_LABEL, c, 240)] : [];
};

const hospital: Persona = {
  kind: 'hospital',
  floorLabel: 'ICU, ventilators, surgical suites, cold-chain medicines',
  bufferLabel: 'backup fuel',
  bufferPct: (s) => (s.telemetry.backupFuelHours !== undefined ? pct((t(s, 'backupFuelHours') / 10) * 100) : pct((backupHoursOf(s) / 10) * 100)),
  flexLoads(state) {
    const out: FlexLoad[] = [flex('Admin HVAC & lighting', 0.18 * state.demandKW, 120), flex('Elective imaging', 0.07 * state.demandKW, 180)];
    return out;
  },
  canConcede(state, perception) {
    const buf = hospital.bufferPct(state);
    if (buf <= 50) return { ok: false, reason: `backup below 50% (${R(buf)}%).` };
    if (perception && perception.imminentFailureRisk >= 0.5) return { ok: false, reason: `imminent failure risk ${perception.imminentFailureRisk.toFixed(2)}.` };
    return { ok: true, reason: `backup at ${R(buf)}%, failure risk low.` };
  },
  urgencyAdjust(u, s) {
    const h = s.telemetry.backupFuelHours !== undefined ? t(s, 'backupFuelHours') : backupHoursOf(s);
    return h < 2 ? Math.max(u, 1 - h / 4) : u;
  },
  situation(s) {
    return `ICU ${R(t(s, 'icuPatients'))}/${R(t(s, 'icuBeds'))} beds, diesel ${f1(t(s, 'backupFuelHours', backupHoursOf(s)))} h left, ${R(t(s, 'incomingPerHour'))} incoming/h`;
  },
  jevBrief:
    'A hospital. Its buffer is backup diesel fuel (hours of autonomy). Its hard floor is ICU, ventilators, surgical suites and cold-chain medicines, which can never be reduced. Flexible loads are administrative HVAC and lighting, elective imaging, and shifting load onto its own generators when fuel is plentiful. It should almost never concede below the floor and only sheds flexible load early if fuel is above half and failure risk is low; rising patient inflow, falling fuel or lost mains water make it more urgent.',
};

const water: Persona = {
  kind: 'water',
  floorLabel: 'minimum-pressure pumps for firefighting and hospital cooling',
  bufferLabel: 'reservoir',
  bufferPct: (s) => pct(t(s, 'reservoirPct', 100)),
  flexLoads(state) {
    const ch = chargeItem(state);
    if (ch.length > 0) return ch; // microgrid sim publishes the refill kW explicitly
    const r = t(state, 'reservoirPct', 100);
    const frac = r > 60 ? 0.4 : r >= 40 ? 0.15 : 0;
    return [flex('Discretionary reservoir refill', frac * state.demandKW, 240)];
  },
  canConcede(state, perception) {
    const r = t(state, 'reservoirPct', 100);
    const p = t(state, 'pressureBar', 3);
    if (p < 2) return { ok: false, reason: `pressure ${p.toFixed(1)} bar below the 2.0 bar minimum.` };
    if (r < 40) return { ok: false, reason: `reservoir only ${R(r)}%.` };
    if (perception && perception.imminentFailureRisk >= 0.5) return { ok: false, reason: `imminent failure risk ${perception.imminentFailureRisk.toFixed(2)}.` };
    return { ok: true, reason: `reservoir ${R(r)}%, pressure ${p.toFixed(1)} bar.` };
  },
  urgencyAdjust(u, s) {
    const p = t(s, 'pressureBar', 3);
    return p < 2 ? Math.max(u, 1 - (p / 2) * (p / 2)) : u;
  },
  situation(s) {
    return `reservoir ${R(t(s, 'reservoirPct'))}%, pressure ${t(s, 'pressureBar').toFixed(1)} bar, ${R(t(s, 'pumpsRunning'))} pumps serving ${R(t(s, 'populationServed'))} people`;
  },
  jevBrief:
    'A water supply station (pumps, tower, reservoir). Its buffer is the reservoir level. Its hard floor is the minimum-pressure pumping needed for firefighting and hospital cooling. Flexible load is discretionary reservoir refilling, which it can defer generously while the reservoir is above 60% and not at all below 40%. Pressure below 2 bar is a sharply non-linear emergency.',
};

const emergency: Persona = {
  kind: 'emergency',
  floorLabel: '911/112 dispatch, radio repeaters, rapid-response bays',
  bufferLabel: 'backup power',
  bufferPct: backupPctOf,
  flexLoads(state) {
    return [flex('Non-urgent fleet charging', 0.25 * state.demandKW, 120), flex('Station HVAC', 0.1 * state.demandKW, 90)];
  },
  canConcede(state, _perception, island) {
    const inc = t(state, 'activeIncidents');
    const avail = t(state, 'unitsAvailable');
    if (island.deficitKW <= 0) return { ok: false, reason: 'island has no shortage to relieve.' };
    if (inc >= avail && inc > 0) return { ok: false, reason: `${R(inc)} active incidents with only ${R(avail)} units available.` };
    return { ok: true, reason: `${R(avail)} units available for ${R(inc)} incidents; island is short.` };
  },
  urgencyAdjust: (u) => u,
  situation(s) {
    return `${R(t(s, 'activeIncidents'))} active incidents, ${R(t(s, 'unitsAvailable'))} units available, ${R(t(s, 'avgResponseMin'))} min response`;
  },
  jevBrief:
    'An emergency station (fire, ambulance, dispatch). Its buffer is diesel backup. Its hard floor is dispatch, radio repeaters and rapid-response bays. Flexible loads are non-urgent fleet charging and station HVAC, which it sheds during grid stress unless active incidents outnumber available units.',
};

const telecom: Persona = {
  kind: 'telecom',
  floorLabel: 'core routing and emergency-broadcast control plane',
  bufferLabel: 'battery',
  bufferPct: (s) => pct(t(s, 'batteryPct', 100)),
  flexLoads(state) {
    return [flex('Consumer 5G sectors', 0.3 * state.demandKW, 180), ...chargeItem(state)];
  },
  canConcede(state, perception) {
    const b = t(state, 'batteryPct', 100);
    if (b < 25) return { ok: false, reason: `battery at ${R(b)}%.` };
    if (perception && perception.imminentFailureRisk >= 0.6) return { ok: false, reason: `imminent failure risk ${perception.imminentFailureRisk.toFixed(2)}.` };
    return { ok: true, reason: `battery ${R(b)}%; consumer sectors can be shed first.` };
  },
  urgencyAdjust(u, s) {
    const b = t(s, 'batteryPct', 100);
    return b < 30 ? Math.max(u, 1 - b / 60) : u;
  },
  situation(s) {
    return `battery ${R(t(s, 'batteryPct'))}%, load ${R(t(s, 'loadPct'))}%, ${f1(t(s, 'emergencyCallsPerMin'))} emergency calls/min`;
  },
  jevBrief:
    'A mobile telecom tower. Its buffer is its battery. Its hard floor is the core routing and emergency-broadcast control plane, which is never shed. Flexible load is consumer high-bandwidth 5G sectors, which it sheds first when power is scarce. Call surges and a draining battery raise urgency.',
};

const school: Persona = {
  kind: 'school',
  floorLabel: 'shelter lighting, heating and medical corner',
  bufferLabel: 'shelter water',
  bufferPct: (s) => pct(t(s, 'waterLiters') / 25),
  flexLoads(state) {
    const sheltering = t(state, 'sheltered') > 0;
    return [flex('Classroom HVAC', (sheltering ? 0.1 : 0.35) * state.demandKW, 240)];
  },
  canConcede(state) {
    const sh = t(state, 'sheltered');
    return sh > 0
      ? { ok: true, reason: `sheltering ${R(sh)} people; only a small HVAC trim.` }
      : { ok: true, reason: 'not sheltering anyone; classroom HVAC can go.' };
  },
  urgencyAdjust(u, s) {
    return t(s, 'medicalCases') > 0 ? Math.max(u, 0.5) : u;
  },
  situation(s) {
    return `${R(t(s, 'sheltered'))}/${R(t(s, 'capacity'))} sheltered, ${R(t(s, 'medicalCases'))} medical cases, ${R(t(s, 'waterLiters'))} L water`;
  },
  jevBrief:
    'A school that doubles as a disaster shelter. Its buffer is stored shelter water. Its hard floor is shelter lighting, heating and the medical corner. Flexible load is classroom and administrative HVAC, which it concedes freely when nobody is sheltering and only slightly when it is housing evacuees.',
};

export const PERSONAS: Record<NegotiatorKind, Persona> = { hospital, water, emergency, telecom, school };
