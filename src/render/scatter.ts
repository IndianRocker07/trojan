import * as THREE from 'three';
import { BLOCK, CELL, GRID_COLS, HALF_D, HALF_W } from '../core/constants';
import type { GridCell, PowerNode } from '../core/types';
import type { ModelLib } from './modelLib';
import { bake } from './batch';
import { cellHash, LOT_Y } from './ground';
import { MAT } from './palette';

/** Instanced street dressing: trees, street lights, parked cars. */
export class Scatter {
  readonly group = new THREE.Group();
  private lampMat = new THREE.MeshBasicMaterial({ color: 0xffe24a });
  private disposables: Array<{ dispose(): void }> = [];
  count = { trees: 0, lights: 0, cars: 0 };

  constructor(cells: GridCell[], poles: PowerNode[], lib: ModelLib) {
    this.disposables.push(this.lampMat);
    const at = (c: number, r: number) =>
      c < 0 || r < 0 || c >= GRID_COLS || r >= GRID_COLS ? undefined : cells[r * GRID_COLS + c];
    const roadLike = (c?: GridCell) => !!c && (c.terrain === 'road' || c.terrain === 'bridge');

    const trees: THREE.Matrix4[][] = [[], [], []];
    const lights: THREE.Matrix4[] = [];
    const cars: THREE.Matrix4[][] = [[], [], []];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const place = (arr: THREE.Matrix4[], x: number, y: number, z: number, rot: number, s = 1) => {
      q.setFromAxisAngle(up, rot);
      arr.push(m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s)).clone());
    };

    const poleList = poles.map((p) => p.pos);
    const nearPole = (x: number, z: number, r: number) => poleList.some((p) => Math.hypot(p.x - x, p.z - z) < r);

    for (const c of cells) {
      const x0 = c.col * CELL - HALF_W;
      const z0 = c.row * CELL - HALF_D;
      if (c.terrain === 'park') {
        for (let i = 0; i < 3; i++) {
          const hx = cellHash(c.id, i * 3 + 1);
          const hz = cellHash(c.id, i * 3 + 2);
          const hv = cellHash(c.id, i * 3 + 3);
          const x = x0 + 1.8 + hx * (CELL - 3.6);
          const z = z0 + 1.8 + hz * (CELL - 3.6);
          const onWalk = (c.col % BLOCK === Math.floor(BLOCK / 2) && Math.abs(x - (x0 + CELL / 2)) < 1.8)
            || (c.row % BLOCK === Math.floor(BLOCK / 2) && Math.abs(z - (z0 + CELL / 2)) < 1.8);
          if (onWalk) continue;
          if (nearPole(x, z, 2)) continue;
          place(trees[Math.floor(hv * 3)], x, LOT_Y, z, hv * 6.28, 0.85 + hx * 0.5);
        }
      } else if (c.terrain === 'land' && !c.buildingId) {
        if (cellHash(c.id, 99) < 0.3) {
          const x = x0 + 3 + cellHash(c.id, 98) * (CELL - 6);
          const z = z0 + 3 + cellHash(c.id, 97) * (CELL - 6);
          if (!nearPole(x, z, 2.5)) place(trees[Math.floor(cellHash(c.id, 96) * 3)], x, LOT_Y, z, cellHash(c.id, 95) * 6.28, 0.8 + cellHash(c.id, 94) * 0.5);
        }
      } else if (c.terrain === 'road' || c.terrain === 'bridge') {
        const hz = roadLike(at(c.col - 1, c.row)) && roadLike(at(c.col + 1, c.row));
        const vt = roadLike(at(c.col, c.row - 1)) && roadLike(at(c.col, c.row + 1));
        if (hz === vt) continue; // intersections / odd cells
        const cx = x0 + CELL / 2;
        const cz = z0 + CELL / 2;
        const side = (c.col + c.row) % 2 === 0 ? 1 : -1;
        if (c.terrain === 'road' && (hz ? c.col : c.row) % 2 === 0) {
          // street light: arm points +X in model space, rotate so it reaches over the road
          const lat = 5.3 * side;
          const x = hz ? cx : cx + lat;
          const z = hz ? cz + lat : cz;
          if (!nearPole(x, z, 3)) {
            // want +X local -> toward road centre
            const toward = hz ? new THREE.Vector2(0, -side) : new THREE.Vector2(-side, 0);
            place(lights, x, 0, z, Math.atan2(-toward.y, toward.x));
          }
        }
        if (c.terrain === 'road' && cellHash(c.id, 7) < 0.14) {
          const lat = 4.1 * (cellHash(c.id, 8) < 0.5 ? 1 : -1);
          const lon = (cellHash(c.id, 9) - 0.5) * 5;
          const x = hz ? cx + lon : cx + lat;
          const z = hz ? cz + lat : cz + lon;
          const rot = hz ? (lat > 0 ? 0 : Math.PI) : lat > 0 ? Math.PI / 2 : -Math.PI / 2;
          place(cars[Math.floor(cellHash(c.id, 10) * 3)], x, 0, z, rot + (cellHash(c.id, 11) < 0.3 ? Math.PI : 0));
        }
      }
    }

    const inst = (tpl: THREE.Group, mats: THREE.Matrix4[], cast: boolean, glowMat?: THREE.Material) => {
      if (!mats.length) return;
      const b = bake(tpl, false);
      const mk = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
        const im = new THREE.InstancedMesh(geo, mat, mats.length);
        mats.forEach((mm, i) => im.setMatrixAt(i, mm));
        im.castShadow = cast && !(mat as THREE.MeshBasicMaterial).isMeshBasicMaterial;
        im.receiveShadow = true;
        im.frustumCulled = false;
        this.group.add(im);
        this.disposables.push(geo);
      };
      b.statics.forEach((g, mat) => mk(g, mat));
      if (b.glow) mk(b.glow, glowMat ?? MAT.glow);
      if (b.beacon) mk(b.beacon, MAT.beacon);
    };
    for (let v = 0; v < 3; v++) {
      inst(lib.tree(v), trees[v], true);
      inst(lib.car(v), cars[v], true);
      this.count.trees += trees[v].length;
      this.count.cars += cars[v].length;
    }
    inst(lib.streetLight(), lights, true, this.lampMat);
    this.count.lights = lights.length;
  }

  /** Street lamps glow at dusk. */
  setNight(night: number): void {
    this.lampMat.color.set(night > 0.35 ? 0xffe24a : 0xb8b49c);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.group.removeFromParent();
  }
}
