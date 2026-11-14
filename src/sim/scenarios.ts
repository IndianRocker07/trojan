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

export const SCENARIOS: Scenario[] = [
  {
    id: 'quiet-night',
    name: 'Quiet evening',
    description: 'No disasters. Evening peak on a healthy grid — the baseline.',
    seed: 1337,
    events: [],
  },
  {
    id: 'monsoon-cyclone',
    name: 'Monsoon cyclone',
    description: 'A cyclone makes landfall from the south-east at 17:30 and sweeps across the east bank; the river floods from 19:00.',
    seed: 1337,
    events: [
      { atMin: 90, kind: 'cyclone', params: { col: 46, row: 46, heading: -Math.PI * 0.75, speed: 6, radius: 6, intensity: 0.5, durationMin: 240 } },
      { atMin: 180, kind: 'flood', params: { intensity: 0.45, durationMin: 360 } },
    ],
  },
  {
    id: 'earthquake',
    name: 'Earthquake & fires',
    description: 'A M6.8-like earthquake strikes beside the river at 17:00, followed by aftershocks and a fire.',
    seed: 1337,
    events: [
      { atMin: 60, kind: 'earthquake', params: { col: 26, row: 22, intensity: 0.85, radius: 9 } },
      { atMin: 75, kind: 'fire', params: { col: 21, row: 24, intensity: 0.9 } },
    ],
  },
  {
    id: 'compound',
    name: 'Compound crisis',
    description: 'The thermal plant trips at 16:30, an earthquake hits the west bank at 18:00 and the river floods at 20:00.',
    seed: 1337,
    events: [
      { atMin: 30, kind: 'grid_fault', params: { targetId: 'generator-0', durationMin: 150 } },
      { atMin: 120, kind: 'earthquake', params: { col: 14, row: 22, intensity: 0.9, radius: 10 } },
      { atMin: 240, kind: 'flood', params: { intensity: 0.4, durationMin: 360 } },
    ],
  },
];

export const getScenario = (id: string): Scenario | undefined => SCENARIOS.find((s) => s.id === id);
