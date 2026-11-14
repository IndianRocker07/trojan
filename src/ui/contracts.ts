/**
 * Minimal structural contracts the UI needs from SimEngine (SPEC §7) and WorldView (SPEC §8).
 * The real classes satisfy these structurally, so `new Hud(root, simEngine, worldView)` type-checks
 * without the UI importing sim/render code.
 */
import type { DisasterEvent, DisasterKind, DisasterParams, EngineEvents, SimSnapshot } from '../core/types';

export interface EngineLike {
  readonly snapshot: SimSnapshot;
  on<K extends keyof EngineEvents>(k: K, fn: (p: EngineEvents[K]) => void): () => void;
  play(): void;
  pause(): void;
  step(): void;
  setSpeed(minPerSec: number): void;
  reset(seed?: number): void;
  trigger(kind: DisasterKind, params: DisasterParams): DisasterEvent;
  loadScenario(id: string): void;
  timeOfDay(): number;
}

export type WorldEvents = {
  select: string | null;
  cellPick: { col: number; row: number };
  hover: string | null;
}

export type LayerName = 'power' | 'water' | 'grid' | 'flow' | 'labels' | 'status';

export interface WorldLike {
  on<K extends keyof WorldEvents>(k: K, fn: (p: WorldEvents[K]) => void): () => void;
  setPickMode(m: 'select' | 'cell'): void;
  setLayer(name: LayerName, on: boolean): void;
  focus(buildingId: string): void;
  select(buildingId: string | null): void;
}

export const SCENARIO_OPTIONS: { id: string; name: string }[] = [
  { id: 'quiet-night', name: 'Quiet night' },
  { id: 'monsoon-cyclone', name: 'Monsoon cyclone' },
  { id: 'earthquake', name: 'Earthquake' },
  { id: 'compound', name: 'Compound crisis' },
];

export const SPEEDS = [1, 5, 10, 30, 60];

export const DEFAULT_LAYERS: Record<LayerName, boolean> = { power: true, water: false, grid: false, flow: true, labels: true, status: true };
