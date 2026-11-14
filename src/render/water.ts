import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WATER_PIPE_DEPTH } from '../core/constants';
import type { SimSnapshot, WaterNetwork, WaterPipe } from '../core/types';
import type { BuildingInfo } from './batch';
import { COLORS } from './palette';
import { Particles } from './particles';

const C_OK = new THREE.Color(COLORS.blue);
const C_DEAD = new THREE.Color(0x4a525c);
const C_BROKEN = new THREE.Color(COLORS.coral);
const C_COLLAR = new THREE.Color(0x7fc4ff);

interface PipeRec {
  pipe: WaterPipe;
  a: THREE.Vector3;
  b: THREE.Vector3;
  len: number;
  r: number;
  start: number;
  count: number;
  state: number; // 0 ok, 1 dead, 2 broken
  phase: number;
  speed: number;
  spacing: number;
  active: boolean;
}

/** Buried water network x-ray: merged pipe tubes, junction collars, risers, flow droplets, leaks. */
export class WaterLayer {
  readonly group = new THREE.Group();
  private recs: PipeRec[] = [];
  private colorAttr: THREE.BufferAttribute;
  private drops: THREE.InstancedMesh;
  private leaks = new Particles(500, 0x5cc8ff, -14, 0.85);
  private puddles: THREE.InstancedMesh;
  private leakList: Array<{ x: number; z: number }> = [];
  private puddleSig = '';
  private disposables: Array<{ dispose(): void }> = [];
  private mats: THREE.Material[] = [];
  private t = 0;

  constructor(snap: SimSnapshot, infos: Map<string, BuildingInfo>) {
    const w: WaterNetwork = snap.water;
    const nodes = w?.nodes ?? {};
    const pipes = Object.values(w?.pipes ?? {});
    const Y = WATER_PIPE_DEPTH;
    const geos: THREE.BufferGeometry[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    let vtx = 0;

    const cyl = (a: THREE.Vector3, b: THREE.Vector3, r: number, col: THREE.Color, seg = 8): THREE.BufferGeometry => {
      const len = Math.max(0.01, a.distanceTo(b));
      const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
      const q = new THREE.Quaternion().setFromUnitVectors(up, b.clone().sub(a).normalize());
      g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
      g.deleteAttribute('uv');
      const n = g.attributes.position.count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        c[i * 3] = col.r;
        c[i * 3 + 1] = col.g;
        c[i * 3 + 2] = col.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return g;
    };

    for (const p of pipes) {
      const na = nodes[p.from];
      const nb = nodes[p.to];
      if (!na || !nb) continue;
      const a = new THREE.Vector3(na.pos.x, Y, na.pos.z);
      const b = new THREE.Vector3(nb.pos.x, Y, nb.pos.z);
      const r = p.tier === 'main' ? THREE.MathUtils.clamp(0.2 + ((p.diameterMm - 150) / 250) * 0.25, 0.2, 0.45) : 0.13;
      const g = cyl(a, b, r, C_OK);
      const rec: PipeRec = {
        pipe: p,
        a,
        b,
        len: a.distanceTo(b),
        r,
        start: vtx,
        count: g.attributes.position.count,
        state: 0,
        phase: Math.random() * 6,
        speed: 0,
        spacing: 6,
        active: false,
      };
      vtx += rec.count;
      geos.push(g);
      this.recs.push(rec);
    }
    // collars at junctions & consumer ends, risers at sources
    for (const n of Object.values(nodes)) {
      const p = new THREE.Vector3(n.pos.x, Y, n.pos.z);
      if (n.kind === 'junction') {
        const g = cyl(p.clone().setY(Y - 0.25), p.clone().setY(Y + 0.25), 0.6, C_COLLAR, 10);
        vtx += g.attributes.position.count;
        geos.push(g);
      } else if (n.kind === 'source') {
        const g = cyl(p.clone().setY(Y), p.clone().setY(0.6), 0.9, C_COLLAR, 12);
        vtx += g.attributes.position.count;
        geos.push(g);
      }
    }
    const mat = new THREE.MeshToonMaterial({ vertexColors: true });
    this.mats.push(mat);
    if (geos.length) {
      const merged = mergeGeometries(geos, false)!;
      geos.forEach((g) => g.dispose());
      this.colorAttr = merged.attributes.color as THREE.BufferAttribute;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(merged);
    } else this.colorAttr = new THREE.BufferAttribute(new Float32Array(3), 3);

    // droplets
    let cap = 0;
    for (const r of this.recs) cap += Math.floor(r.len / 3.5) + 1;
    const dg = new THREE.IcosahedronGeometry(1, 1);
    const dm = new THREE.MeshBasicMaterial({ color: 0xb8f4ff, toneMapped: false });
    this.mats.push(dm);
    this.disposables.push(dg);
    this.drops = new THREE.InstancedMesh(dg, dm, Math.max(1, cap));
    this.drops.count = 0;
    this.drops.frustumCulled = false;
    this.group.add(this.drops);

    // puddles
    const pg = new THREE.CircleGeometry(1, 20);
    pg.rotateX(-Math.PI / 2);
    const pm = new THREE.MeshBasicMaterial({ color: 0x5cc8ff, transparent: true, opacity: 0.7, depthWrite: false });
    this.disposables.push(pg, pm);
    this.puddles = new THREE.InstancedMesh(pg, pm, 80);
    this.puddles.count = 0;
    this.puddles.frustumCulled = false;
    this.group.add(this.puddles, this.leaks.points);
    void infos;
    this.sync(snap);
  }

  private paint(rec: PipeRec, c: THREE.Color): void {
    const a = this.colorAttr.array as Float32Array;
    for (let i = rec.start; i < rec.start + rec.count; i++) {
      a[i * 3] = c.r;
      a[i * 3 + 1] = c.g;
      a[i * 3 + 2] = c.b;
    }
    this.colorAttr.needsUpdate = true;
  }

  sync(snap: SimSnapshot): void {
    const pipes = snap.water?.pipes;
    if (!pipes) return;
    this.leakList.length = 0;
    for (const rec of this.recs) {
      const p = pipes[rec.pipe.id] ?? rec.pipe;
      const state = p.status === 'broken' ? 2 : p.pressureBar > 0.05 ? 0 : 1;
      if (state !== rec.state) {
        rec.state = state;
        this.paint(rec, state === 2 ? C_BROKEN : state === 1 ? C_DEAD : C_OK);
      }
      rec.active = state === 0;
      const prs = Math.min(1, p.pressureBar / 4.5);
      rec.spacing = THREE.MathUtils.lerp(9, 3.5, prs);
      const cap = p.tier === 'main' ? 40 : 1;
      rec.speed = rec.active ? 1.5 + 9 * Math.pow(Math.min(1, p.flowM3h / cap), 0.35) : 0;
      if (state === 2 && this.leakList.length < 70) this.leakList.push({ x: (rec.a.x + rec.b.x) / 2, z: (rec.a.z + rec.b.z) / 2 });
    }
    const sig = this.leakList.map((l) => `${l.x | 0},${l.z | 0}`).join(';');
    if (sig !== this.puddleSig) {
      this.puddleSig = sig;
      const m = new THREE.Matrix4();
      this.leakList.forEach((l, i) => {
        m.makeScale(3.5, 1, 3.5).setPosition(l.x, 0.33, l.z);
        this.puddles.setMatrixAt(i, m);
      });
      this.puddles.count = this.leakList.length;
      this.puddles.instanceMatrix.needsUpdate = true;
    }
  }

  update(dt: number, visible: boolean): void {
    if (!visible) return;
    this.t += dt;
    const arr = this.drops.instanceMatrix.array as Float32Array;
    let n = 0;
    const cap = this.drops.instanceMatrix.count;
    for (const r of this.recs) {
      if (!r.active) continue;
      r.phase = (r.phase + r.speed * dt) % r.spacing;
      const dx = (r.b.x - r.a.x) / r.len;
      const dz = (r.b.z - r.a.z) / r.len;
      const rr = r.r * 1.35;
      const hl = 1.1;
      for (let d = r.phase; d < r.len && n < cap; d += r.spacing) {
        const o = n++ * 16;
        // stretch along pipe direction (horizontal)
        arr[o] = -dz * rr;
        arr[o + 1] = 0;
        arr[o + 2] = dx * rr;
        arr[o + 3] = 0;
        arr[o + 4] = 0;
        arr[o + 5] = rr;
        arr[o + 6] = 0;
        arr[o + 7] = 0;
        arr[o + 8] = dx * hl;
        arr[o + 9] = 0;
        arr[o + 10] = dz * hl;
        arr[o + 11] = 0;
        arr[o + 12] = r.a.x + dx * d;
        arr[o + 13] = r.a.y;
        arr[o + 14] = r.a.z + dz * d;
        arr[o + 15] = 1;
      }
    }
    this.drops.count = n;
    this.drops.instanceMatrix.needsUpdate = true;
    for (const l of this.leakList) {
      if (Math.random() < 14 * dt) {
        const a = Math.random() * 6.283;
        const s = 1.5 + Math.random() * 2.5;
        this.leaks.emit(l.x, 0.4, l.z, Math.cos(a) * s * 0.5, 9 + Math.random() * 5, Math.sin(a) * s * 0.5, 1.1, 1.6, 0.8);
      }
    }
    this.leaks.update(dt);
  }

  setOpacity(o: number): void {
    // fade pipes via material opacity
    for (const m of [this.mats[0], this.mats[1]]) {
      m.transparent = o < 0.999;
      (m as THREE.Material).opacity = o;
    }
  }

  dispose(): void {
    this.leaks.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.mats.forEach((m) => m.dispose());
    this.group.removeFromParent();
  }
}
