/** Scripted scenarios — SPEC §7.5. All tuned for the default seed 1337 city (see cityGen). */
import type { DisasterKind } from '../core/types';
import type { SimDisasterParams } from './disasters';

export interface ScenarioEvent {
  atMin: number;
  kind: DisasterKind;
  params: SimDisasterParams;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  seed: number;
  events: ScenarioEvent[];
}

/**
 * All scenarios run 24 h from 10:00 (tMin 0 = 10:00): midday solar surplus → sunset → a night on reserves → dawn.
 * Minute offsets: 13:00 = 180, 14:00 = 240, 16:00 = 360, 16:30 = 390, 19:00 = 540, 12:30 = 150.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: 'quiet-night',
    name: 'Quiet day',
    description: 'No disasters. A full day on a healthy grid — midday solar surplus, evening peak, quiet night. The baseline.',
    seed: 1337,
    events: [],
  },
  {
    id: 'monsoon-cyclone',
    name: 'Monsoon cyclone',
    description:
      'A cyclone makes landfall from the south-east at 13:00 (rooftop and farm solar drop to 20%) and sweeps across the east bank; the river floods from 16:00 into the evening and the night.',
    seed: 1337,
    events: [
      { atMin: 180, kind: 'cyclone', params: { col: 46, row: 46, heading: -Math.PI * 0.75, speed: 6, radius: 6, intensity: 0.5, durationMin: 240 } },
      { atMin: 360, kind: 'flood', params: { intensity: 0.45, durationMin: 360 } },
    ],
  },
  {
    id: 'earthquake',
    name: 'Earthquake & fires',
    description:
      'A M6.8-like earthquake strikes beside the river at 12:30, at the midday solar peak — feeders cut off from their substation keep running as prosumer microgrids. A fire follows 15 minutes later; the day ends on batteries.',
    seed: 1337,
    events: [
      { atMin: 150, kind: 'earthquake', params: { col: 30, row: 14, intensity: 0.85, radius: 9 } },
      { atMin: 165, kind: 'fire', params: { col: 26, row: 17, intensity: 0.9 } },
    ],
  },
  {
    id: 'compound',
    name: 'Compound crisis',
    description:
      'The thermal plant trips at 14:00 for 3 h, an earthquake hits the west bank at 16:30 and the river floods at 19:00 — the city ends up on reserves overnight.',
    seed: 1337,
    events: [
      { atMin: 240, kind: 'grid_fault', params: { targetId: 'generator-0', durationMin: 180 } },
      { atMin: 390, kind: 'earthquake', params: { col: 14, row: 18, intensity: 0.9, radius: 10 } },
      { atMin: 540, kind: 'flood', params: { intensity: 0.4, durationMin: 360 } },
    ],
  },
];

export const getScenario = (id: string): Scenario | undefined => SCENARIOS.find((s) => s.id === id);
