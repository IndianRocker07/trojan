/**
 * Utility agents — SPEC §6. One autonomous agent per consumer building.
 * In Layer 1 an agent only senses and reports (telemetry.ts drives its numbers);
 * Layer 2 will make it bid. `AgentRuntime.s` is the public `UtilityAgentState` placed in the snapshot.
 */
import { CELL, GRID_COLS } from '../core/constants';
import type { Rng } from '../core/rng';
import type { Building, BuildingStatus, ConsumerKind, UtilityAgentState } from '../core/types';
import { buildingCentre } from './powerNetwork';
import { KIND_PROFILES } from './profiles';

export interface AgentRuntime {
  b: Building;
  s: UtilityAgentState;
  /** world position of the building centre */
  x: number;
  z: number;
  /** internal (non-public) state of the agent's model, all finite numbers */
  m: Record<string, number>;
  /** fraction of demand actually served last step (grid + backup) */
  servedFrac: number;
  /** distance (m) to the nearest non-ok cell */
  impactM: number;
  /** building not operational (any cell hit, or still recovering from flood) */
  down: boolean;
  /** building has a destroyed cell (permanent) */
  destroyed: boolean;
  /** kW drawn from backup last step */
  backupDrawKW: number;
  /** kW the building covers from its own DER this step (prosumers; min(selfSupply, demand)); 0 otherwise */
  selfKW: number;
  /** fraction of the sheddable buffer-charging power that was granted last step (1 when there is none) */
  chargedFrac: number;
  /** per-step DER scratch (prosumers only) — see microgrid.ts */
  plan?: DerPlan;
  /** houses: ids of the 3x3 cell neighbourhood (evacuation check); set by the telemetry init */
  nbrs?: number[];
}

/** Per-step plan of a prosumer's DER (docs/MICROGRID.md §2). All kW unless noted. */
export interface DerPlan {
  effMin: number; // p_min actually needed (min(survival, last demand))
  solar: number;
  dSurv: number; // battery discharge covering p_min
  dExpCap: number; // battery discharge that could be exported (SoC > 20%)
  baseOffer: number; // max(0, solar - effMin) before charging
  charge: number; // solar kW diverted into the battery
  dExp: number; // battery discharge actually planned for export
  offer: number; // offered to the island (after charge, + dExp)
  export: number; // after thermal curtailment (before dispatch scaling)
  potential: boolean; // can act as an island source
  zone: number; // cloud zone
  reach: number; // lowest feeder-chain index of the live stretch up from the service drop (chain length = unreachable)
}

export const CONSUMER_KINDS: ConsumerKind[] = ['hospital', 'emergency', 'water', 'telecom', 'school', 'house'];
export const isConsumer = (b: Building): boolean => b.kind !== 'generator' && b.kind !== 'substation';

export function createAgents(buildings: Record<string, Building>, rng: Rng, derRng?: Rng): Record<string, AgentRuntime> {
  const out: Record<string, AgentRuntime> = {};
  for (const b of Object.values(buildings)) {
    if (!isConsumer(b)) continue;
    const kind = b.kind as ConsumerKind;
    const prof = KIND_PROFILES[kind];
    const c = buildingCentre(b);
    let baseKW = Math.max(prof.baseKW * 0.4, rng.gauss(prof.baseKW, prof.sdKW));
    if (kind === 'house') baseKW = Math.max(1.5, baseKW);
    const m: Record<string, number> = { baseKW };
    const backup: UtilityAgentState['backup'] = { type: 'none', capacityKWh: 0, remainingKWh: 0, maxKW: 0 };
    const tel: Record<string, number> = {};

    switch (kind) {
      case 'hospital': {
        const hours = rng.range(6, 10);
        backup.type = 'diesel';
        backup.maxKW = 600;
        backup.capacityKWh = hours * 600;
        m.icuBeds = rng.int(16, 22);
        m.patientsBase = rng.int(52, 75);
        m.icuBase = rng.int(5, 8);
        m.patients = m.patientsBase;
        m.icu = m.icuBase;
        m.inflowFast = m.patientsBase / 2400 * 60;
        m.inflowSlow = m.inflowFast;
        m.oxygenHours = rng.range(26, 36);
        break;
      }
      case 'emergency': {
        backup.type = 'diesel';
        backup.maxKW = 120;
        backup.capacityKWh = 8 * 120;
        m.units = rng.int(5, 7);
        m.incidents = 0;
        break;
      }
      case 'water': {
        if (b.variant === 1) {
          backup.type = 'diesel';
          backup.maxKW = 300;
          backup.capacityKWh = 3 * 300;
        }
        m.reservoir = rng.range(78, 95);
        m.contamination = 0;
        m.popBase = 0; // filled in by the telemetry module (nearest-house census)
        break;
      }
      case 'telecom': {
        backup.type = 'battery';
        backup.maxKW = 15;
        backup.capacityKWh = 4 * 15;
        m.surge = 0;
        break;
      }
      case 'school': {
        m.capacity = rng.int(220, 320);
        m.sheltered = 0;
        m.pending = 0;
        m.inflowEma = 0;
        m.waterL = rng.range(2200, 3000);
        m.medical = 0;
        break;
      }
      case 'house': {
        m.occupants = Math.max(1, Math.min(6, Math.round(rng.gauss(3, 1.2))));
        m.medicalDevice = rng.chance(0.06) ? 1 : 0;
        m.evacUntil = -1;
        m.evacCounted = 0;
        // (draw always consumed so the stream stays identical to the pre-microgrid sim)
        // A prosumer's DER battery replaces the house backup battery — never both (no double-counted energy).
        if (rng.chance(0.15) && !b.prosumer) {
          backup.type = 'battery';
          backup.maxKW = 3;
          backup.capacityKWh = 10;
        }
        break;
      }
    }
    backup.remainingKWh = backup.capacityKWh;

    let der: UtilityAgentState['der'];
    let plan: DerPlan | undefined;
    if (b.prosumer) {
      if (kind === 'school') b.prosumer.survivalKW = Math.round(0.15 * baseKW * 10) / 10; // shelter core = 15% of base demand
      const soc = derRng ? derRng.range(0.55, 0.9) : 0.7;
      const kwh = b.prosumer.batteryKWh * soc;
      der = {
        solarKW: 0,
        batteryKWh: kwh,
        batteryPct: soc * 100,
        generationKW: 0,
        selfSupplyKW: 0,
        offeredKW: 0,
        exportedKW: 0,
        curtailedKW: 0,
      };
      plan = { effMin: 0, solar: 0, dSurv: 0, dExpCap: 0, baseOffer: 0, charge: 0, dExp: 0, offer: 0, export: 0, potential: false, zone: 0, reach: 0 };
    }

    out[b.id] = {
      b,
      x: c.x,
      z: c.z,
      m,
      servedFrac: 1,
      impactM: 5000,
      down: false,
      destroyed: false,
      backupDrawKW: 0,
      selfKW: 0,
      chargedFrac: 1,
      plan,
      s: {
        buildingId: b.id,
        kind,
        demandKW: baseKW,
        minSafeKW: baseKW * prof.minSafeFrac,
        criticality: prof.criticality,
        urgency: 0,
        expectedDamagePerHour: 0,
        allocatedKW: 0,
        connected: true,
        backup,
        telemetry: tel,
        tokens: 100,
        ...(der ? { der } : {}),
      },
    };
  }
  return out;
}

/**
 * Backup power + status — SPEC §6.4. Call after the allocation of a step.
 * Returns nothing; mutates `rt` (backup energy, servedFrac, backupDrawKW) and returns the status.
 */
export function applyBackupAndStatus(rt: AgentRuntime): BuildingStatus {
  const s = rt.s;
  if (rt.destroyed) {
    rt.servedFrac = 0;
    rt.backupDrawKW = 0;
    rt.chargedFrac = 0;
    return 'destroyed';
  }
  if (rt.down) {
    rt.servedFrac = 0;
    rt.backupDrawKW = 0;
    rt.chargedFrac = 0;
    return 'offline';
  }
  const bk = s.backup;
  // What the building actually gets = grid grant (net request) + its own DER (self-supply).
  const got = s.allocatedKW + rt.selfKW;
  // The sheddable buffer-charging part of demand is excluded from the service level (no damage if not charged).
  const charge = Math.min(s.demandKW, s.storage?.chargeKW ?? 0);
  const hold = Math.max(0, s.demandKW - charge);
  const deficit = Math.max(0, hold - got);
  const chargeGranted = Math.max(0, Math.min(charge, got - hold));
  let draw = 0;
  if (deficit > 1e-6 && bk.type !== 'none' && bk.remainingKWh > 0) {
    draw = Math.min(bk.maxKW, deficit, bk.remainingKWh * 60);
    bk.remainingKWh = Math.max(0, bk.remainingKWh - draw / 60);
  } else if (s.storage) {
    // telecom battery: refills only from the granted charging power
    if (bk.type === 'battery' && chargeGranted > 0) bk.remainingKWh = Math.min(bk.capacityKWh, bk.remainingKWh + (chargeGranted * 0.92) / 60);
  } else if (deficit <= 1e-6 && bk.type === 'battery' && bk.remainingKWh < bk.capacityKWh) {
    bk.remainingKWh = Math.min(bk.capacityKWh, bk.remainingKWh + (bk.maxKW * 0.25) / 60);
  }
  rt.backupDrawKW = draw;
  rt.chargedFrac = charge > 1e-9 ? Math.min(1, chargeGranted / charge) : 1;
  rt.servedFrac = hold > 1e-9 ? Math.min(1, (Math.min(got, hold) + draw) / hold) : 1;

  if (s.demandKW <= 1e-9) return s.connected ? 'online' : 'offline';
  if (got >= 0.99 * hold && hold > 1e-9) return 'online';
  if (got >= s.minSafeKW && got > 0) return 'brownout';
  if (draw > 0) return 'backup';
  return got > 0.005 * s.demandKW ? 'brownout' : 'offline';
}

/** Distance in metres between a point and a cell centre. */
export function cellDistM(x: number, z: number, cellIdx: number, halfW: number, halfD: number): number {
  const cx = ((cellIdx % GRID_COLS) + 0.5) * CELL - halfW;
  const cz = (Math.floor(cellIdx / GRID_COLS) + 0.5) * CELL - halfD;
  return Math.hypot(cx - x, cz - z);
}
