import * as THREE from 'three';
import type { GridCell } from '../../core/types';
import { createField } from './field';
import { buildTerrain } from './terrain';
import { buildGrass } from './grass';
import { buildNature } from './nature';
import { buildFauna } from './fauna';
import { updateWind } from './wind';
import type { EnvPart, Field } from './types';

export type { Field, EnvPart } from './types';

export interface Environment {
  group: THREE.Group;
  field: Field;
  update(dt: number, t: number, camera: THREE.Camera): void;
  setNight(n: number): void;
  dispose(): void;
}

/** The landscape around the city board: terrain + animated grass + nature + ambient life. */
export function buildEnvironment(cells: GridCell[]): Environment {
  const field = createField(cells);
  const parts: EnvPart[] = [];
  const group = new THREE.Group();
  group.name = 'environment';
  const add = (name: string, make: () => EnvPart) => {
    try {
      const p = make();
      parts.push(p);
      group.add(p.group);
    } catch (err) {
      console.error(`[env] ${name} failed to build`, err);
    }
  };
  add('terrain', () => buildTerrain(field, cells));
  add('grass', () => buildGrass(field, cells));
  add('nature', () => buildNature(field, cells));
  add('fauna', () => buildFauna(field));
  return {
    group,
    field,
    update(dt, t, camera) {
      updateWind(t);
      for (const p of parts) p.update?.(dt, t, camera);
    },
    setNight(n) {
      for (const p of parts) p.setNight?.(n);
    },
    dispose() {
      for (const p of parts) p.dispose();
      group.removeFromParent();
    },
  };
}
