import * as THREE from 'three';
import { BLOCK, CELL, GRID_COLS, GRID_ROWS, HALF_D, HALF_W } from '../core/constants';
import type { CellStatus, GridCell, SimSnapshot } from '../core/types';
import { COLORS } from './palette';

function hatchTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(255,74,46,0.42)';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,74,46,0.95)';
  g.lineWidth = 12;
  for (let i = -128; i < 256; i += 32) {
    g.beginPath();
    g.moveTo(i, 128);
    g.lineTo(i + 128, 0);
    g.stroke();
  }
  g.strokeStyle = 'rgba(18,19,16,0.9)';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 122, 122);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const CAP = GRID_COLS * GRID_ROWS;

/** Grid lines + per-cell status tiles (destroyed hatch, burning flicker, flood water). */
export class Overlays {
  readonly group = new THREE.Group();
  private grid = new THREE.Group();
  private status = new THREE.Group();
  private destroyed: THREE.InstancedMesh;
  private burning: THREE.InstancedMesh;
  private flood: THREE.InstancedMesh;
  private disposables: Array<{ dispose(): void }> = [];
  private last = new Uint8Array(CAP);
  private floodAnim = new Float32Array(CAP);
  private floodTarget = new Uint8Array(CAP);
  private floodLevel = 0.4;
  private burnList: number[] = [];
  private floodList: number[] = [];
  private burnT = 0;
  private dummy = new THREE.Object3D();
  private statusOn = true;

  constructor(private cells: GridCell[]) {
    // ----- grid -----
    const minor: number[] = [];
    const major: number[] = [];
    const y = 0.32;
    for (let i = 0; i <= GRID_COLS; i++) {
      const x = i * CELL - HALF_W;
      (i % BLOCK <= 1 ? major : minor).push(x, y, -HALF_D, x, y, HALF_D);
    }
    for (let j = 0; j <= GRID_ROWS; j++) {
      const z = j * CELL - HALF_D;
      (j % BLOCK <= 1 ? major : minor).push(-HALF_W, y, z, HALF_W, y, z);
    }
    for (const [arr, op] of [
      [minor, 0.22],
      [major, 0.55],
    ] as const) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const m = new THREE.LineBasicMaterial({ color: COLORS.ink, transparent: true, opacity: op, depthWrite: false });
      this.grid.add(new THREE.LineSegments(g, m));
      this.disposables.push(g, m);
    }
    this.grid.visible = false;

    // ----- status tiles -----
    const plane = new THREE.PlaneGeometry(CELL, CELL);
    plane.rotateX(-Math.PI / 2);
    this.disposables.push(plane);
    const hatch = hatchTexture();
    this.disposables.push(hatch);
    const mk = (mat: THREE.Material) => {
      const im = new THREE.InstancedMesh(plane, mat, CAP);
      im.count = 0;
      im.frustumCulled = false;
      im.renderOrder = 2;
      this.status.add(im);
      this.disposables.push(mat);
      return im;
    };
    this.destroyed = mk(
      new THREE.MeshBasicMaterial({ map: hatch, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.burning = mk(
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.burning.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
    this.flood = mk(
      new THREE.MeshBasicMaterial({ color: COLORS.water, transparent: true, opacity: 0.62, depthWrite: false }),
    );
    this.group.add(this.grid, this.status);
  }

  setGrid(on: boolean): void {
    this.grid.visible = on;
  }
  setStatus(on: boolean): void {
    this.statusOn = on;
    this.status.visible = on;
  }

  /** Flood level (elevation units) from the active flood events, per SPEC §7.3. */
  private levelFromEvents(s: SimSnapshot): number {
    for (const e of s.disasters) {
      if (e.kind !== 'flood' || !e.active) continue;
      const peak = 0.15 + 0.45 * (e.params.intensity ?? 0.6);
      const p = Math.min(1, Math.max(0, (s.tMin - e.startMin) / Math.max(1, e.durationMin)));
      const f = p < 0.4 ? p / 0.4 : p < 0.7 ? 1 : (1 - p) / 0.3;
      return peak * Math.max(0.15, f);
    }
    return this.floodLevel;
  }

  sync(s: SimSnapshot): void {
    const code = (st: CellStatus) => (st === 'destroyed' ? 1 : st === 'burning' ? 2 : st === 'flooded' ? 3 : 0);
    this.floodLevel = this.levelFromEvents(s);
    let changed = false;
    for (let i = 0; i < CAP; i++) {
      const c = code(s.cells[i].status);
      if (c !== this.last[i]) {
        this.last[i] = c;
        changed = true;
      }
    }
    if (!changed) return;
    const m = this.dummy;
    let nd = 0;
    this.burnList.length = 0;
    this.floodTarget.fill(0);
    for (let i = 0; i < CAP; i++) {
      const c = this.last[i];
      if (!c) continue;
      const cell = this.cells[i];
      const x = (cell.col + 0.5) * CELL - HALF_W;
      const z = (cell.row + 0.5) * CELL - HALF_D;
      if (c === 1) {
        m.position.set(x, 0.42, z);
        m.updateMatrix();
        this.destroyed.setMatrixAt(nd++, m.matrix);
      } else if (c === 2) this.burnList.push(i);
      else this.floodTarget[i] = 1;
    }
    this.destroyed.count = nd;
    this.destroyed.instanceMatrix.needsUpdate = true;
    this.burning.count = this.burnList.length;
    this.burnList.forEach((i, k) => {
      const cell = this.cells[i];
      m.position.set((cell.col + 0.5) * CELL - HALF_W, 0.4, (cell.row + 0.5) * CELL - HALF_D);
      m.updateMatrix();
      this.burning.setMatrixAt(k, m.matrix);
    });
    this.burning.instanceMatrix.needsUpdate = true;
  }

  update(dt: number, t: number): void {
    // flicker
    this.burnT += dt;
    if (this.burnT > 0.12 && this.burnList.length) {
      this.burnT = 0;
      const c = new THREE.Color();
      this.burnList.forEach((_, k) => {
        c.set(Math.random() < 0.5 ? 0xff8a00 : 0xffb000).multiplyScalar(0.8 + Math.random() * 0.3);
        this.burning.setColorAt(k, c);
      });
      this.burning.instanceColor!.needsUpdate = true;
    }
    // flood water: tiles rise in, drop out
    const m = this.dummy;
    const rise = 0.35 + 2.2 * Math.min(1, this.floodLevel / 0.6);
    let n = 0;
    for (let i = 0; i < CAP; i++) {
      const target = this.floodTarget[i];
      let a = this.floodAnim[i];
      if (a === 0 && !target) continue;
      a += (target - a) * Math.min(1, dt * 2.2);
      if (!target && a < 0.01) a = 0;
      this.floodAnim[i] = a;
      if (a === 0) continue;
      const cell = this.cells[i];
      const x = (cell.col + 0.5) * CELL - HALF_W;
      const z = (cell.row + 0.5) * CELL - HALF_D;
      m.position.set(x, 0.1 + a * rise + Math.sin(t * 1.6 + x * 0.06 + z * 0.045) * 0.09, z);
      m.updateMatrix();
      this.flood.setMatrixAt(n++, m.matrix);
    }
    this.flood.count = n;
    this.flood.instanceMatrix.needsUpdate = true;
    this.destroyed.visible = this.statusOn;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.group.removeFromParent();
  }
}
