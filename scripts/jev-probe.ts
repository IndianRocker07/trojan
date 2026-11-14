/**
 * Headless Jev probe: npx tsx scripts/jev-probe.ts
 * Sends two fake perception inputs straight through DirectJevProvider and prints the perceptions.
 * Key: TYPESAFE_API_KEY in the environment, or in .env.local / .env at the repo root.
 * Without a key it prints a hint and exits 0.
 */
import { DirectJevProvider } from '../server/jevDirect';
import type { PerceptionInput } from '../src/core/types';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file); // Node 22: does not override variables already set
  } catch {
    // file missing: fine
  }
}

const hospital: PerceptionInput = {
  agentId: 'hospital-2',
  kind: 'hospital',
  name: 'St. Mary General',
  mode: 'active',
  tMin: 214,
  hourOfDay: 14.5,
  demandKW: 1200,
  minSafeKW: 810,
  allocatedKW: 700,
  criticality: 1,
  simUrgency: 0.7,
  expectedDamagePerHour: 180,
  backup: { type: 'diesel', remainingKWh: 420, maxKW: 600, hoursLeft: 1.4 },
  telemetry: { waterSupplyPct: 64, icuBeds: 14, icuBedsTotal: 16, dieselPct: 14 },
  incidentLog: ['Earthquake 240 m away', 'Running on backup (1.4 h left)', 'Incoming casualties 42/h'],
  island: { supplyKW: 4000, totalRequestKW: 6500, deficitKW: 2500, consumers: 37 },
};

const waterStation: PerceptionInput = {
  agentId: 'water-1',
  kind: 'water',
  name: 'Riverside Pump Station',
  mode: 'cooperating',
  tMin: 214,
  hourOfDay: 14.5,
  demandKW: 300,
  minSafeKW: 120,
  allocatedKW: 300,
  criticality: 0.9,
  simUrgency: 0.1,
  expectedDamagePerHour: 40,
  backup: { type: 'none', remainingKWh: 0, maxKW: 0, hoursLeft: 0 },
  telemetry: { reservoirPct: 80, pressureBar: 3.1 },
  incidentLog: [],
  island: { supplyKW: 4000, totalRequestKW: 6500, deficitKW: 2500, consumers: 37 },
};

async function main(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    console.log(
      'No TYPESAFE_API_KEY found. Put TYPESAFE_API_KEY=... in .env.local (see .env.example) or export it, then re-run.',
    );
    return;
  }

  const provider = new DirectJevProvider({ model: process.env.TYPESAFE_DEFAULT_MODEL });
  const perceptions = await provider.perceive([hospital, waterStation]);
  for (const p of perceptions) {
    console.log(JSON.stringify(p, null, 2));
  }
}

main().catch((err: unknown) => {
  console.error('jev probe failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
