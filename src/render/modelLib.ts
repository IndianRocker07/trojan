import * as THREE from 'three';
import type { BuildingKind } from '../core/types';
import { CELL, FOOTPRINT } from '../core/constants';
import { box, cyl, setOutPorts, setPowerPorts, sphere } from '../models/kit';
import type { MatName } from './palette';

/**
 * Robust model access. Modules in src/models are loaded lazily (one failing / missing file never
 * breaks the view) and every builder has a coloured-box fallback.
 */
type Loader = () => Promise<any>;
const loaders = import.meta.glob(['../models/*.ts', '!../models/index.ts', '!../models/kit.ts']) as Record<
  string,
  Loader
>;

const KIND_COLOR: Record<BuildingKind, MatName> = {
  house: 'wallCream',
  hospital: 'wallWhite',
  emergency: 'wallCoral',
  school: 'wallPink',
  water: 'wallBlue',
  telecom: 'wallLilac',
  substation: 'steel',
  generator: 'wallYellow',
};
const KIND_HEIGHT: Record<BuildingKind, number> = {
  house: 6,
  hospital: 16,
  emergency: 9,
  school: 8,
  water: 14,
  telecom: 22,
  substation: 8,
  generator: 18,
};

function fallbackBuilding(kind: BuildingKind): THREE.Group {
  const fp = FOOTPRINT[kind];
  const g = new THREE.Group();
  const w = fp.w * CELL - 2;
  const d = fp.d * CELL - 2;
  const h = KIND_HEIGHT[kind];
  box(g, w, 0.15, d, 'paving');
  box(g, w * 0.8, h, d * 0.8, KIND_COLOR[kind], 0, 0.15, 0);
  box(g, w * 0.8 + 0.1, 1, 0.1, 'glow', 0, h * 0.5, d * 0.4);
  box(g, 0.1, 1, d * 0.8 + 0.1, 'glow', w * 0.4, h * 0.5, 0);
  const port = new THREE.Vector3(0, Math.min(h + 2, 8), d / 2 - 1);
  if (kind === 'generator' || kind === 'substation') setOutPorts(g, [port.clone().setX(2)]);
  setPowerPorts(g, kind === 'generator' ? [] : [port]);
  return g;
}

function fallbackPylon(): THREE.Group {
  const g = new THREE.Group();
  box(g, 1.2, 26, 1.2, 'steel');
  box(g, 9, 0.5, 0.5, 'steelDark', 0, 22, 0);
  g.userData.attach = [new THREE.Vector3(-4.5, 22, 0), new THREE.Vector3(0, 25.5, 0), new THREE.Vector3(4.5, 22, 0)];
  return g;
}
function fallbackPole(): THREE.Group {
  const g = new THREE.Group();
  cyl(g, 0.15, 0.2, 9, 'wood');
  box(g, 2.4, 0.15, 0.15, 'wood', 0, 8.4, 0);
  g.userData.attach = [new THREE.Vector3(-1.1, 8.8, 0), new THREE.Vector3(1.1, 8.8, 0)];
  return g;
}

export class ModelLib {
  private mods: Record<string, any> = {};
  private warned = new Set<string>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    await Promise.all(
      Object.entries(loaders).map(async ([path, loader]) => {
        const name = path.split('/').pop()!.replace('.ts', '');
        try {
          this.mods[name] = await loader();
        } catch (e) {
          console.warn(`[render] model module "${name}" failed to load`, e);
        }
      }),
    );
  }

  private warn(key: string, e: unknown): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[render] model "${key}" unavailable, using fallback`, e ?? '');
  }

  variants(kind: BuildingKind): number {
    return Math.max(1, this.mods[kind]?.VARIANTS ?? 1);
  }

  building(kind: BuildingKind, variant: number, seed: number): THREE.Group {
    try {
      const m = this.mods[kind];
      if (m?.build) return m.build({ variant, seed });
      this.warn(kind, 'missing');
    } catch (e) {
      this.warn(kind, e);
    }
    return fallbackBuilding(kind);
  }

  pylon(): THREE.Group {
    try {
      if (this.mods.pylon?.buildPylon) return this.mods.pylon.buildPylon();
    } catch (e) {
      this.warn('pylon', e);
    }
    return fallbackPylon();
  }
  pole(withTransformer: boolean): THREE.Group {
    try {
      if (this.mods.pylon?.buildPole) return this.mods.pylon.buildPole(withTransformer);
    } catch (e) {
      this.warn('pole', e);
    }
    return fallbackPole();
  }
  tree(variant: number): THREE.Group {
    try {
      if (this.mods.props?.buildTree) return this.mods.props.buildTree(variant);
    } catch (e) {
      this.warn('tree', e);
    }
    const g = new THREE.Group();
    cyl(g, 0.25, 0.35, 2.5, 'wood');
    sphere(g, 2.2, 'green', 0, 4);
    return g;
  }
  streetLight(): THREE.Group {
    try {
      if (this.mods.props?.buildStreetLight) return this.mods.props.buildStreetLight();
    } catch (e) {
      this.warn('streetlight', e);
    }
    const g = new THREE.Group();
    cyl(g, 0.1, 0.12, 7, 'steel');
    box(g, 0.8, 0.2, 0.4, 'glow', 1.2, 6.8, 0);
    return g;
  }
  car(variant: number): THREE.Group {
    try {
      if (this.mods.props?.buildCar) return this.mods.props.buildCar(variant);
    } catch (e) {
      this.warn('car', e);
    }
    const g = new THREE.Group();
    box(g, 4.2, 1.3, 1.8, 'wallCoral', 0, 0.3, 0);
    return g;
  }
}
