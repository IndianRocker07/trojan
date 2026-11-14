import type * as THREE from 'three';
import type { BuildingKind } from '../core/types';
import type { ModelBuilder } from './kit';
import * as house from './house';
import * as hospital from './hospital';
import * as emergency from './emergency';
import * as school from './school';
import * as water from './water';
import * as telecom from './telecom';
import * as substation from './substation';
import * as generator from './generator';
export { buildPylon, buildPole } from './pylon';
export { buildTree, buildStreetLight, buildCar } from './props';

export interface ModelEntry {
  build: ModelBuilder;
  variants: number;
}

/** Registry: building kind → model builder. */
export const MODELS: Record<BuildingKind, ModelEntry> = {
  house: { build: house.build, variants: house.VARIANTS },
  hospital: { build: hospital.build, variants: hospital.VARIANTS },
  emergency: { build: emergency.build, variants: emergency.VARIANTS },
  school: { build: school.build, variants: school.VARIANTS },
  water: { build: water.build, variants: water.VARIANTS },
  telecom: { build: telecom.build, variants: telecom.VARIANTS },
  substation: { build: substation.build, variants: substation.VARIANTS },
  generator: { build: generator.build, variants: generator.VARIANTS },
};

export type { THREE };
