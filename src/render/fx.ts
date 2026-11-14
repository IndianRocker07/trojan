import * as THREE from 'three';
import { CELL, GRID_COLS, HALF_D, HALF_W, cellCenter } from '../core/constants';
import type { DisasterEvent, GridCell, SimSnapshot } from '../core/types';
import type { BuildingInfo } from './batch';
import { COLORS, MAT } from './palette';

const reducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Ring {
  mesh: THREE.Mesh;
  age: number;
  delay: number;
  max: number;
}

interface Cyclone {
  id: string;
  group: THREE.Group;
  layers: THREE.Mesh[];
  rain: THREE.LineSegments;
  rainPos: Float32Array;
  rainSeed: Float32Array;
  radius: number;
  mats: THREE.Material[];
}

const circleTex = (): THREE.CanvasTexture => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

const FLAME_CAP = 1500;
const SMOKE_CAP = 800;
const RUBBLE_CAP = 3600;
const RAIN_N = 1300;

/** Disaster effects: quake ring + shake, cyclone, fire flames, smoke, rubble. All pooled. */
export class Effects {
  readonly group = new THREE.Group();
  private disposables: Array<{ dispose(): void }> = [];
  private seen = new Set<string>();
  private rings: Ring[] = [];
  private ringGeo = new THREE.RingGeometry(0.93, 1, 72);
  private shakeT = 0;
  private cyclones = new Map<string, Cyclone>();
  private reduced = reducedMotion();

  // flames
  private flamesOuter: THREE.InstancedMesh;
  private flamesInner: THREE.InstancedMesh;
  private flames: Array<{ x: number; z: number; ph: number; h: number; s: number }> = [];
  private smokeEmit: Array<{ x: number; y: number; z: number; rate: number }> = [];

  // smoke
  private smoke: THREE.Points;
  private sPos = new Float32Array(SMOKE_CAP * 3);
  private sCol = new Float32Array(SMOKE_CAP * 4);
  private sScale = new Float32Array(SMOKE_CAP);
  private sVel = new Float32Array(SMOKE_CAP * 3);
  private sAge = new Float32Array(SMOKE_CAP).fill(99);
  private sLife = new Float32Array(SMOKE_CAP).fill(1);
  private sNext = 0;

  // rubble
  private rubble: THREE.InstancedMesh;
  private rubbleIds = '';

  constructor(private cells: GridCell[]) {
    this.disposables.push(this.ringGeo);
    // flames
    const cone = new THREE.ConeGeometry(1, 1, 6);
    cone.translate(0, 0.5, 0);
    this.disposables.push(cone);
    const fo = new THREE.MeshBasicMaterial({ color: COLORS.orange });
    const fi = new THREE.MeshBasicMaterial({ color: COLORS.yellow });
    this.disposables.push(fo, fi);
    this.flamesOuter = new THREE.InstancedMesh(cone, fo, FLAME_CAP);
    this.flamesInner = new THREE.InstancedMesh(cone, fi, FLAME_CAP);
    for (const f of [this.flamesOuter, this.flamesInner]) {
      f.count = 0;
      f.frustumCulled = false;
      this.group.add(f);
    }
    // smoke
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.sCol, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aScale', new THREE.BufferAttribute(this.sScale, 1).setUsage(THREE.DynamicDrawUsage));
    const tex = circleTex();
    const mat = new THREE.PointsMaterial({ size: 1, map: tex, transparent: true, depthWrite: false, vertexColors: true, sizeAttenuation: true });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('void main() {', 'attribute float aScale;\nvoid main() {')
        .replace('gl_PointSize = size;', 'gl_PointSize = size * aScale;');
    };
    this.smoke = new THREE.Points(geo, mat);
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 3;
    this.group.add(this.smoke);
    this.disposables.push(geo, mat, tex);
    // rubble
    const bg = new THREE.BoxGeometry(1, 1, 1);
    this.rubble = new THREE.InstancedMesh(bg, MAT.concrete, RUBBLE_CAP);
    this.rubble.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RUBBLE_CAP * 3), 3);
    this.rubble.count = 0;
    this.rubble.castShadow = true;
    this.rubble.receiveShadow = true;
    this.rubble.frustumCulled = false;
    this.group.add(this.rubble);
    this.disposables.push(bg);
  }

  /** Treat everything currently in the snapshot as already seen (no quake ring on (re)build). */
  prime(s: SimSnapshot): void {
    this.seen.clear();
    for (const e of s.disasters) this.seen.add(e.id);
  }

  get shakeAmp(): number {
    return this.reduced ? 0 : Math.max(0, this.shakeT / 0.6);
  }

  private addRing(x: number, z: number, maxR: number): void {
    for (let k = 0; k < 2; k++) {
      const mat = new THREE.MeshBasicMaterial({
        color: k === 0 ? COLORS.coral : COLORS.ink,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 1.2 + k * 0.05, z);
      mesh.renderOrder = 4;
      this.group.add(mesh);
      this.rings.push({ mesh, age: 0, delay: k * 0.3, max: maxR });
    }
  }

  private makeCyclone(ev: DisasterEvent): Cyclone {
    const R = (ev.params.radius ?? 5) * CELL;
    const group = new THREE.Group();
    const mats: THREE.Material[] = [];
    const layers: THREE.Mesh[] = [];
    for (let i = 0; i < 7; i++) {
      const f = i / 6;
      const r = R * (0.22 + 0.7 * f * f + 0.1 * f);
      const geo = new THREE.RingGeometry(r * 0.5, r, 40, 1, 0, 4.2);
      const mat = new THREE.MeshBasicMaterial({
        color: i % 2 ? 0xffffff : 0xdfe7f2,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      mats.push(mat);
      this.disposables.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = 8 + i * 9.5;
      m.userData.speed = 1.3 - f * 0.7;
      m.userData.phase = i * 1.1;
      group.add(m);
      layers.push(m);
    }
    const fgeo = new THREE.CylinderGeometry(R * 0.9, R * 0.12, 70, 24, 1, true);
    const fmat = new THREE.MeshBasicMaterial({ color: 0x6d7a8c, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
    const funnel = new THREE.Mesh(fgeo, fmat);
    funnel.position.y = 35;
    group.add(funnel);
    mats.push(fmat);
    this.disposables.push(fgeo);
    // rain
    const rainPos = new Float32Array(RAIN_N * 6);
    const rainSeed = new Float32Array(RAIN_N * 3);
    for (let i = 0; i < RAIN_N; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * R * 1.3;
      rainSeed[i * 3] = Math.cos(a) * rr;
      rainSeed[i * 3 + 1] = Math.random() * 90;
      rainSeed[i * 3 + 2] = Math.sin(a) * rr;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    const rmat = new THREE.LineBasicMaterial({ color: 0x8fc2ff, transparent: true, opacity: 0.6 });
    const rain = new THREE.LineSegments(rg, rmat);
    rain.frustumCulled = false;
    this.disposables.push(rg, rmat);
    mats.push(rmat);
    this.group.add(rain);
    this.group.add(group);
    return { id: ev.id, group, layers, rain, rainPos, rainSeed, radius: R, mats };
  }

  private eye(ev: DisasterEvent, tMin: number): { x: number; z: number } {
    const p = ev.params;
    const c = cellCenter(p.col ?? 0, p.row ?? 0);
    const dist = ((p.speed ?? 6) * Math.max(0, tMin - ev.startMin)) / 60 * CELL;
    const h = p.heading ?? 0;
    return { x: c.x + Math.cos(h) * dist, z: c.z + Math.sin(h) * dist };
  }

  /** Per-tick snapshot sync: new events, burning cells, destroyed buildings. */
  sync(s: SimSnapshot, infos: Map<string, BuildingInfo>): void {
    for (const ev of s.disasters) {
      if (!this.seen.has(ev.id)) {
        this.seen.add(ev.id);
        if (ev.kind === 'earthquake' && s.tMin - ev.startMin <= 3) {
          const c = cellCenter(ev.params.col ?? 24, ev.params.row ?? 24);
          this.addRing(c.x, c.z, (ev.params.radius ?? 8) * CELL * 1.15);
          this.shakeT = 0.6;
        }
      }
    }
    // cyclones
    const live = new Set<string>();
    for (const ev of s.disasters) {
      if (ev.kind !== 'cyclone' || !ev.active) continue;
      live.add(ev.id);
      let c = this.cyclones.get(ev.id);
      if (!c) this.cyclones.set(ev.id, (c = this.makeCyclone(ev)));
      const e = this.eye(ev, s.tMin);
      c.group.position.set(e.x, 0, e.z);
      c.group.userData.eye = e;
    }
    for (const [id, c] of this.cyclones)
      if (!live.has(id)) {
        c.group.removeFromParent();
        c.rain.removeFromParent();
        c.mats.forEach((m) => m.dispose());
        this.cyclones.delete(id);
      }

    // flames + smoke emitters
    this.flames.length = 0;
    this.smokeEmit.length = 0;
    for (const cell of s.cells) {
      if (cell.status !== 'burning') continue;
      const c = cellCenter(cell.col, cell.row);
      const park = cell.terrain === 'park';
      const n = 3;
      for (let k = 0; k < n && this.flames.length < FLAME_CAP; k++) {
        const a = (cell.id * 7 + k * 2.1) % 6.28;
        const r = k === 0 ? 0 : 2.6;
        this.flames.push({
          x: c.x + Math.cos(a) * r,
          z: c.z + Math.sin(a) * r,
          ph: (cell.id * 13 + k * 5) % 10,
          h: (park ? 5 : 7.5) * (k === 0 ? 1.25 : 0.9),
          s: k === 0 ? 3.4 : 2.4,
        });
      }
      this.smokeEmit.push({ x: c.x, y: 3, z: c.z, rate: 1.4 });
    }
    // destroyed buildings: smoke + rubble
    const destroyed: BuildingInfo[] = [];
    for (const b of Object.values(s.buildings)) {
      if (b.status !== 'destroyed') continue;
      const info = infos.get(b.id);
      if (info) destroyed.push(info);
    }
    destroyed.sort((a, b) => b.w * b.d - a.w * a.d);
    destroyed.slice(0, 70).forEach((i) => this.smokeEmit.push({ x: i.cx, y: 2, z: i.cz, rate: i.w * i.d > 200 ? 1.2 : 0.45 }));
    const key = destroyed.map((d) => d.id).join('|');
    if (key !== this.rubbleIds) {
      this.rubbleIds = key;
      this.buildRubble(destroyed);
    }
    void HALF_W;
    void HALF_D;
    void GRID_COLS;
  }

  private buildRubble(list: BuildingInfo[]): void {
    const o = new THREE.Object3D();
    const col = new THREE.Color();
    let n = 0;
    for (const info of list) {
      const count = Math.min(46, Math.max(7, Math.round((info.w * info.d) / 7)));
      let seed = Math.floor(info.cx * 13 + info.cz * 7) >>> 0;
      const rnd = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      for (let i = 0; i < count && n < RUBBLE_CAP; i++) {
        const sx = 0.6 + rnd() * 2.2;
        const sy = 0.4 + rnd() * 1.3;
        const sz = 0.6 + rnd() * 2.2;
        o.position.set(info.cx + (rnd() - 0.5) * (info.w - 3), 0.2 + sy / 2, info.cz + (rnd() - 0.5) * (info.d - 3));
        o.rotation.set((rnd() - 0.5) * 0.6, rnd() * 6.28, (rnd() - 0.5) * 0.6);
        o.scale.set(sx, sy, sz);
        o.updateMatrix();
        this.rubble.setMatrixAt(n, o.matrix);
        col.setScalar(0.22 + rnd() * 0.3);
        this.rubble.setColorAt(n, col);
        n++;
      }
    }
    this.rubble.count = n;
    this.rubble.instanceMatrix.needsUpdate = true;
    this.rubble.instanceColor!.needsUpdate = true;
  }

  private spawnSmoke(x: number, y: number, z: number): void {
    const i = this.sNext;
    this.sNext = (this.sNext + 1) % SMOKE_CAP;
    this.sPos[i * 3] = x + (Math.random() - 0.5) * 4;
    this.sPos[i * 3 + 1] = y;
    this.sPos[i * 3 + 2] = z + (Math.random() - 0.5) * 4;
    this.sVel[i * 3] = 1.2 + Math.random() * 0.8; // light wind
    this.sVel[i * 3 + 1] = 4 + Math.random() * 3;
    this.sVel[i * 3 + 2] = 0.4 + Math.random() * 0.6;
    this.sAge[i] = 0;
    this.sLife[i] = 4.5 + Math.random() * 3;
  }

  update(dt: number, t: number): void {
    // rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      const a = r.age - r.delay;
      if (a < 0) {
        r.mesh.visible = false;
        continue;
      }
      r.mesh.visible = true;
      const f = a / 3.4;
      if (f >= 1) {
        r.mesh.removeFromParent();
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const e = 1 - Math.pow(1 - f, 3);
      const s = Math.max(1, r.max * e);
      r.mesh.scale.set(s, s, 1);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - f);
    }
    if (this.shakeT > 0) this.shakeT = Math.max(0, this.shakeT - dt);

    // cyclones
    for (const c of this.cyclones.values()) {
      const eye = c.group.userData.eye as { x: number; z: number } | undefined;
      for (const l of c.layers) {
        l.rotation.z = this.reduced ? 0 : t * l.userData.speed + l.userData.phase;
      }
      if (!eye) continue;
      const pos = c.rainPos;
      for (let i = 0; i < RAIN_N; i++) {
        let y = c.rainSeed[i * 3 + 1] - (this.reduced ? 0 : 70 * dt);
        if (y < 0) y += 90;
        c.rainSeed[i * 3 + 1] = y;
        const x = eye.x + c.rainSeed[i * 3] + y * 0.12;
        const z = eye.z + c.rainSeed[i * 3 + 2];
        pos[i * 6] = x;
        pos[i * 6 + 1] = y;
        pos[i * 6 + 2] = z;
        pos[i * 6 + 3] = x + 0.4;
        pos[i * 6 + 4] = y + 3.4;
        pos[i * 6 + 5] = z;
      }
      (c.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }

    // flames
    const nf = this.flames.length;
    this.flamesOuter.count = nf;
    this.flamesInner.count = nf;
    const ao = this.flamesOuter.instanceMatrix.array as Float32Array;
    const ai = this.flamesInner.instanceMatrix.array as Float32Array;
    for (let i = 0; i < nf; i++) {
      const f = this.flames[i];
      const fl = this.reduced ? 1 : 0.8 + 0.28 * Math.sin(t * 9 + f.ph) + 0.12 * Math.sin(t * 17 + f.ph * 2);
      const h = f.h * fl;
      const w = f.s * (0.9 + 0.1 * Math.sin(t * 7 + f.ph));
      const o = i * 16;
      ao.fill(0, o, o + 16);
      ao[o] = w;
      ao[o + 5] = h * 1.6;
      ao[o + 10] = w;
      ao[o + 12] = f.x;
      ao[o + 13] = 0.3;
      ao[o + 14] = f.z;
      ao[o + 15] = 1;
      ai.fill(0, o, o + 16);
      ai[o] = w * 0.4;
      ai[o + 5] = h * 1.85;
      ai[o + 10] = w * 0.4;
      ai[o + 12] = f.x;
      ai[o + 13] = 0.3;
      ai[o + 14] = f.z;
      ai[o + 15] = 1;
    }
    this.flamesOuter.instanceMatrix.needsUpdate = true;
    this.flamesInner.instanceMatrix.needsUpdate = true;

    // smoke
    if (!this.reduced) {
      for (const e of this.smokeEmit) if (Math.random() < e.rate * dt) this.spawnSmoke(e.x, e.y, e.z);
    }
    for (let i = 0; i < SMOKE_CAP; i++) {
      const age = (this.sAge[i] += dt);
      const life = this.sLife[i];
      if (age >= life) {
        this.sCol[i * 4 + 3] = 0;
        this.sScale[i] = 0;
        continue;
      }
      const f = age / life;
      this.sPos[i * 3] += this.sVel[i * 3] * dt;
      this.sPos[i * 3 + 1] += this.sVel[i * 3 + 1] * dt * (1 - f * 0.5);
      this.sPos[i * 3 + 2] += this.sVel[i * 3 + 2] * dt;
      const g = 0.32 + f * 0.25;
      this.sCol[i * 4] = g;
      this.sCol[i * 4 + 1] = g;
      this.sCol[i * 4 + 2] = g * 0.95;
      this.sCol[i * 4 + 3] = 0.62 * Math.min(1, f * 6) * (1 - f);
      this.sScale[i] = 5 + f * 14;
    }
    const geo = this.smoke.geometry;
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.aScale as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.cyclones.forEach((c) => c.mats.forEach((m) => m.dispose()));
    this.rings.forEach((r) => (r.mesh.material as THREE.Material).dispose());
    this.disposables.forEach((d) => d.dispose());
    this.group.removeFromParent();
  }
}
