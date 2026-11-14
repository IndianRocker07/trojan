import type * as THREE from 'three';

/**
 * Shared contract for the landscape around the city board (src/render/env/*).
 * The board is the 576 × 576 m square centred on the origin (|x|,|z| ≤ HALF_W/HALF_D = 288).
 * Everything in env/ lives OUTSIDE that square (grass may also appear in park cells).
 */

/** Biome weights at a point; they sum to ~1. Pass `out` to avoid allocation in hot loops. */
export interface Biome {
  meadow: number; // lush low grass + wildflowers, near the city
  forest: number; // foothill woodland belt
  alpine: number; // high sparse grass, conifers thinning out
  rock: number; // cliffs, scree, steep faces
  snow: number; // peaks
}

/** Read-only description of the landscape. Implemented in env/field.ts (terrain agent owns it). */
export interface Field {
  /** Half-size of the generated landscape square (m). */
  readonly extent: number;
  /** Terrain surface height (m) at world x,z. Inside the board this is the board top (0). */
  height(x: number, z: number): number;
  /** Surface normal at x,z (unit, y-up). */
  normal(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  /** |gradient| of height (rise/run); 0 flat, ~1 = 45°. */
  slope(x: number, z: number): number;
  /** Metres outside the board rectangle (0 inside). */
  edgeDist(x: number, z: number): number;
  /** 0..1 — 1 on a country lane / road surface outside the board (keep grass, trees, rocks off it). */
  road(x: number, z: number): number;
  /** 0..1 — 1 on open water (river continuation, lakes) outside the board. */
  water(x: number, z: number): number;
  /** Biome weights. */
  biome(x: number, z: number, out?: Biome): Biome;
}

/** Every env module returns one of these. */
export interface EnvPart {
  group: THREE.Group;
  /** Per-frame animation. `t` is seconds since start. */
  update?(dt: number, t: number, camera: THREE.Camera): void;
  /** 0 = full day, 1 = full night. Optional (lights already darken toon materials). */
  setNight?(n: number): void;
  dispose(): void;
}
