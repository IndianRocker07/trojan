import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CELL, worldToCell } from '../core/constants';
import { COLORS } from './palette';
import type { BuildingInfo } from './batch';

export interface PickerEvents {
  hover(id: string | null): void;
  select(id: string | null): void;
  cell(col: number, row: number): void;
}

function ring(color: number, width: number): { line: Line2; mat: LineMaterial; geo: LineGeometry } {
  const geo = new LineGeometry();
  geo.setPositions([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 0, -0.5]);
  const mat = new LineMaterial({ color, linewidth: width, worldUnits: false, depthTest: false, transparent: true });
  const line = new Line2(geo, mat);
  line.frustumCulled = false;
  line.renderOrder = 10;
  line.visible = false;
  return { line, mat, geo };
}

/** Invisible hit boxes (one InstancedMesh, not in the scene) + hover / selection rings + cell preview. */
export class Picker {
  readonly group = new THREE.Group();
  private hit: THREE.InstancedMesh | null = null;
  private ids: string[] = [];
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private mode: 'select' | 'cell' = 'select';
  private hoverId: string | null = null;
  private selectedId: string | null = null;
  private hoverRing = ring(COLORS.ink, 3);
  private selRing = ring(COLORS.green, 5);
  private selRingOuter = ring(COLORS.ink, 8);
  private previewDisc: THREE.Mesh;
  private previewRing: THREE.Mesh;
  private previewR = 3;
  private moved = false;
  private down: { x: number; y: number; t: number } | null = null;
  private pr = 1;
  private infos = new Map<string, BuildingInfo>();
  private unsub: Array<() => void> = [];
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private disposables: Array<{ dispose(): void }> = [];

  constructor(
    private dom: HTMLElement,
    private camera: THREE.Camera,
    private ev: PickerEvents,
  ) {
    this.group.add(this.hoverRing.line, this.selRingOuter.line, this.selRing.line);
    const dg = new THREE.CircleGeometry(1, 56);
    dg.rotateX(-Math.PI / 2);
    const dm = new THREE.MeshBasicMaterial({ color: COLORS.coral, transparent: true, opacity: 0.22, depthWrite: false });
    this.previewDisc = new THREE.Mesh(dg, dm);
    const rg = new THREE.RingGeometry(0.97, 1, 56);
    rg.rotateX(-Math.PI / 2);
    const rm = new THREE.MeshBasicMaterial({ color: COLORS.ink, transparent: true, opacity: 0.85, depthWrite: false });
    this.previewRing = new THREE.Mesh(rg, rm);
    for (const m of [this.previewDisc, this.previewRing]) {
      m.visible = false;
      m.renderOrder = 9;
      m.position.y = 0.6;
      this.group.add(m);
    }
    this.disposables.push(dg, dm, rg, rm, this.hoverRing.geo, this.hoverRing.mat, this.selRing.geo, this.selRing.mat, this.selRingOuter.geo, this.selRingOuter.mat);

    const move = (e: PointerEvent) => {
      const r = dom.getBoundingClientRect();
      this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.moved = true;
      if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) this.down.t = -1;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const up = (e: PointerEvent) => {
      const d = this.down;
      this.down = null;
      if (!d || d.t < 0 || e.button !== 0 || performance.now() - d.t > 450) return;
      move(e);
      this.click();
    };
    const leave = () => {
      this.moved = false;
      this.setHover(null);
      this.previewDisc.visible = this.previewRing.visible = false;
    };
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointerleave', leave);
    this.unsub.push(
      () => dom.removeEventListener('pointermove', move),
      () => dom.removeEventListener('pointerdown', down),
      () => dom.removeEventListener('pointerup', up),
      () => dom.removeEventListener('pointerleave', leave),
    );
  }

  setBuildings(infos: Map<string, BuildingInfo>): void {
    this.infos = infos;
    this.hit?.dispose();
    this.ids = [...infos.keys()];
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    this.hit = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), this.ids.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    this.ids.forEach((id, i) => {
      const b = infos.get(id)!;
      m.compose(new THREE.Vector3(b.cx, 0, b.cz), q, new THREE.Vector3(Math.max(2, b.w - 1.5), Math.max(4, b.height), Math.max(2, b.d - 1.5)));
      this.hit!.setMatrixAt(i, m);
    });
    this.hit.updateMatrixWorld(true);
    this.hit.computeBoundingSphere();
  }

  setPickMode(m: 'select' | 'cell'): void {
    this.mode = m;
    this.dom.style.cursor = m === 'cell' ? 'crosshair' : '';
    if (m === 'cell') this.setHover(null);
    else this.previewDisc.visible = this.previewRing.visible = false;
  }

  setPreviewRadius(cells: number): void {
    this.previewR = Math.max(0.5, cells) * CELL;
    this.previewDisc.scale.setScalar(this.previewR);
    this.previewRing.scale.setScalar(this.previewR);
  }

  setResolution(w: number, h: number, pr: number): void {
    this.pr = pr;
    for (const r of [this.hoverRing, this.selRing, this.selRingOuter]) {
      r.mat.resolution.set(w * pr, h * pr);
    }
    this.hoverRing.mat.linewidth = 3 * pr;
    this.selRing.mat.linewidth = 4 * pr;
    this.selRingOuter.mat.linewidth = 7.5 * pr;
  }

  private rayHit(): string | null {
    if (!this.hit) return null;
    this.ray.setFromCamera(this.ndc, this.camera);
    const hits = this.ray.intersectObject(this.hit, false);
    if (!hits.length) return null;
    const id = hits[0].instanceId;
    return id === undefined ? null : this.ids[id];
  }

  private groundPoint(): THREE.Vector3 | null {
    this.ray.setFromCamera(this.ndc, this.camera);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.plane, p);
  }

  private place(r: { line: Line2 }, id: string | null, pad: number, y: number): void {
    if (!id) {
      r.line.visible = false;
      return;
    }
    const b = this.infos.get(id);
    if (!b) return;
    r.line.visible = true;
    r.line.position.set(b.cx, y, b.cz);
    r.line.scale.set(b.w + pad, 1, b.d + pad);
  }

  private setHover(id: string | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.place(this.hoverRing, id === this.selectedId ? null : id, -0.8, 0.5);
    this.dom.style.cursor = this.mode === 'cell' ? 'crosshair' : id ? 'pointer' : '';
    this.ev.hover(id);
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    this.place(this.selRing, id, -0.3, 0.55);
    this.place(this.selRingOuter, id, -0.3, 0.5);
    this.place(this.hoverRing, this.hoverId === id ? null : this.hoverId, -0.8, 0.5);
  }

  private click(): void {
    if (this.mode === 'cell') {
      const p = this.groundPoint();
      if (p) {
        const c = worldToCell(p.x, p.z);
        this.ev.cell(c.col, c.row);
      }
      return;
    }
    const id = this.rayHit();
    this.ev.select(id);
  }

  /** Call every frame (cheap: only raycasts after pointer movement). */
  update(): void {
    if (!this.moved) return;
    this.moved = false;
    if (this.down && this.down.t < 0) return; // dragging the map
    if (this.mode === 'cell') {
      const p = this.groundPoint();
      const on = !!p && Math.abs(p.x) < 400 && Math.abs(p.z) < 400;
      this.previewDisc.visible = this.previewRing.visible = on;
      if (p) {
        this.previewDisc.position.set(p.x, 0.6, p.z);
        this.previewRing.position.set(p.x, 0.62, p.z);
      }
    } else this.setHover(this.rayHit());
  }

  dispose(): void {
    this.unsub.forEach((f) => f());
    this.hit?.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.group.removeFromParent();
  }
}
