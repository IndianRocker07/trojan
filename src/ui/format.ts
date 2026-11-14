import { START_HOUR } from '../core/constants';
import type { BuildingKind } from '../core/types';

export const STATUS_LABEL: Record<string, string> = {
  online: 'Online',
  brownout: 'Brownout',
  backup: 'On backup',
  offline: 'Offline',
  destroyed: 'Destroyed',
};

export const KIND_LABEL: Record<BuildingKind, string> = {
  house: 'House',
  hospital: 'Hospital',
  emergency: 'Emergency',
  school: 'School shelter',
  water: 'Water',
  telecom: 'Telecom',
  substation: 'Substation',
  generator: 'Generator',
};

const pad = (n: number) => String(n).padStart(2, '0');

export function clockFromMin(tMin: number) {
  const total = START_HOUR * 60 + Math.floor(tMin);
  const day = Math.floor(total / 1440) + 1;
  const m = total % 1440;
  return { day, text: `${pad(Math.floor(m / 60))}:${pad(m % 60)}` };
}

export function fmtKW(kw: number): string {
  const a = Math.abs(kw);
  if (a >= 1000) return `${(kw / 1000).toFixed(a >= 10000 ? 1 : 2)} MW`;
  return `${Math.round(kw)} kW`;
}

export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

export const pct = (f: number) => `${Math.round(f * 100)}%`;

type TeleType = 'num' | 'pctRaw' | 'pct' | 'bool' | 'dist' | 'frac';
interface TeleMeta {
  label: string;
  unit?: string;
  type?: TeleType;
}

const TELE: Record<string, TeleMeta> = {
  patients: { label: 'Patients' },
  icuPatients: { label: 'ICU patients' },
  icuBeds: { label: 'ICU beds' },
  incomingPerHour: { label: 'Incoming', unit: '/h' },
  inflowGrowthPctPerHour: { label: 'Inflow growth', unit: '%/h' },
  ventilatorsInUse: { label: 'Ventilators in use' },
  surgeriesActive: { label: 'Surgeries active' },
  distanceToImpactM: { label: 'Distance to impact', type: 'dist' },
  backupFuelHours: { label: 'Backup fuel', unit: 'h' },
  oxygenHours: { label: 'Oxygen', unit: 'h' },
  activeIncidents: { label: 'Active incidents' },
  unitsDeployed: { label: 'Units deployed' },
  unitsAvailable: { label: 'Units available' },
  callsPerHour: { label: 'Calls', unit: '/h' },
  avgResponseMin: { label: 'Avg response', unit: 'min' },
  flowM3h: { label: 'Flow', unit: 'm³/h' },
  reservoirPct: { label: 'Reservoir', type: 'pct' },
  pressureBar: { label: 'Pressure', unit: 'bar' },
  pumpsRunning: { label: 'Pumps running' },
  populationServed: { label: 'Population served' },
  contaminationRisk: { label: 'Contamination risk', type: 'frac' },
  activeConnections: { label: 'Active connections' },
  loadPct: { label: 'Load', type: 'pct' },
  emergencyCallsPerMin: { label: 'Emergency calls', unit: '/min' },
  batteryPct: { label: 'Battery', type: 'pct' },
  coverageKm2: { label: 'Coverage', unit: 'km²' },
  backhaulOk: { label: 'Backhaul OK', type: 'bool' },
  waterPressureBar: { label: 'Water pressure', unit: 'bar' },
  waterSupplyPct: { label: 'Water supply', type: 'pctRaw' },
  sheltered: { label: 'Sheltered' },
  capacity: { label: 'Capacity' },
  inflowPerHour: { label: 'Inflow', unit: '/h' },
  medicalCases: { label: 'Medical cases' },
  waterLiters: { label: 'Water', unit: 'L' },
  occupants: { label: 'Occupants' },
  medicalDevice: { label: 'Medical device', type: 'bool' },
  emergencyRequestsPerHour: { label: 'Emergency requests', unit: '/h' },
  evacuated: { label: 'Evacuated', type: 'bool' },
};

export function teleLabel(key: string): string {
  const m = TELE[key];
  if (m) return m.label;
  const s = key.replace(/([A-Z])/g, ' $1').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function num(v: number): string {
  const a = Math.abs(v);
  if (a >= 100) return Math.round(v).toLocaleString('en-US');
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(a >= 10 ? 1 : 2).replace(/\.?0+$/, '');
}

/** Format a telemetry value. `*Pct` keys may be 0..1 fractions or 0..100; values <= 1 are treated as fractions. */
export function fmtTele(key: string, v: number): string {
  if (!Number.isFinite(v)) return '–';
  const m = TELE[key];
  switch (m?.type) {
    case 'bool':
      return v >= 0.5 ? 'Yes' : 'No';
    case 'pct':
      return `${num(v <= 1 ? v * 100 : v)}%`;
    case 'pctRaw':
      return `${num(v)}%`;
    case 'frac':
      return `${num(v <= 1 ? v * 100 : v)}%`;
    case 'dist':
      return v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`;
    default:
      return m?.unit ? `${num(v)} ${m.unit}` : num(v);
  }
}
