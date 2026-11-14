/** Static per-kind utility profiles — SPEC §6.1. Shared by agents.ts and powerNetwork.ts. */
import type { ConsumerKind } from '../core/types';

export interface KindProfile {
  baseKW: number;
  sdKW: number;
  /** minSafe as a fraction of current demand */
  minSafeFrac: number;
  criticality: number;
  /** damage units per hour if unserved */
  damagePerHour: number;
}

export const KIND_PROFILES: Record<ConsumerKind, KindProfile> = {
  hospital: { baseKW: 1800, sdKW: 300, minSafeFrac: 0.45, criticality: 1.0, damagePerHour: 100 },
  emergency: { baseKW: 280, sdKW: 60, minSafeFrac: 0.5, criticality: 0.9, damagePerHour: 60 },
  water: { baseKW: 750, sdKW: 150, minSafeFrac: 0.35, criticality: 0.85, damagePerHour: 70 },
  telecom: { baseKW: 22, sdKW: 6, minSafeFrac: 0.6, criticality: 0.8, damagePerHour: 40 },
  school: { baseKW: 160, sdKW: 40, minSafeFrac: 0.25, criticality: 0.55, damagePerHour: 15 },
  house: { baseKW: 4.5, sdKW: 2, minSafeFrac: 0.1, criticality: 0.25, damagePerHour: 1 },
};

/** Nominal peak demand used to size line capacities before the agents exist. */
export const NOMINAL_PEAK_KW: Record<ConsumerKind, number> = {
  hospital: 1800,
  emergency: 280,
  water: 750,
  telecom: 22,
  school: 160,
  house: 4.5,
};
