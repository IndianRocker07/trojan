import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CELL, GRID_COLS, HALF_D, HALF_W, cellCol, cellRow } from '../core/constants';
import type { Building, BuildingStatus } from '../core/types';
import { COLORS, GLOW_BACKUP, GLOW_OFF, GLOW_ON, MAT } from './palette';
import type { ModelLib } from './modelLib';
import { LOT_Y } from './ground';

/** Geometry baked out of a model group (everything in the group's local frame). */
export interface Baked {
  statics: Map<THREE.Material, THREE.BufferGeometry>;
  glow: THREE.BufferGeometry | null;
  beacon: THREE.BufferGeometry | null;
  /** line-segment positions of ink outlines (pairs of vertices). */
  edges: Float32Array;
  box: THREE.Box3;
  spinRoots: THREE.Object3D[];
}

function cleanGeo(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  g.clearGroups();
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/** Collect a model's meshes into one geometry per material (+ glow, beacon, outline edges). */
export function bake(root: THREE.Object3D, outline = true): Baked {
  root.updateMatrixWorld(true);
  const lists = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const glowL: THREE.BufferGeometry[] = [];
  const beaconL: THREE.BufferGeometry[] = [];
  const edgeParts: Float32Array[] = [];
  const spinRoots: THREE.Object3D[] = [];
  const inSpin = (o: THREE.Object3D | null): boolean => {
    for (let p = o; p && p !== root; p = p.parent) if (p.userData.spin) return true;
    return false;
  };
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (o !== root && o.userData.spin && !inSpin(o.parent)) spinRoots.push(o);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || inSpin(o)) return;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
    const src = mesh.geometry;
    const role = mesh.userData.role as string | undefined;
    const isGlow = role === 'glow' || mat === MAT.glow;
    const isBeacon = role === 'beacon' || mat === MAT.beacon;
    if (outline && !isGlow && !isBeacon && mat !== MAT.ink) {
      if (!src.boundingBox) src.computeBoundingBox();
      const s = new THREE.Vector3();
      src.boundingBox!.getSize(s);
      s.multiply(new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld));
      if (Math.min(s.x, s.y, s.z) >= 0.18) {
        const eg = new THREE.EdgesGeometry(src, 40);
        const pa = eg.attributes.position;
        const arr = new Float32Array(pa.count * 3);
        for (let i = 0; i < pa.count; i++) {
          v.fromBufferAttribute(pa, i).applyMatrix4(mesh.matrixWorld);
          arr[i * 3] = v.x;
          arr[i * 3 + 1] = v.y;
          arr[i * 3 + 2] = v.z;
        }
        edgeParts.push(arr);
        eg.dispose();
      }
    }
    const g = cleanGeo(src.clone());
    g.applyMatrix4(mesh.matrixWorld);
    if (isGlow) glowL.push(g);
    else if (isBeacon) beaconL.push(g);
    else {
      let l = lists.get(mat);
      if (!l) lists.set(mat, (l = []));
      l.push(g);
    }
  });
  const merge = (l: THREE.BufferGeometry[]) => {
    const m = l.length === 1 ? l[0] : mergeGeometries(l, false);
    if (l.length > 1) l.forEach((g) => g.dispose());
    return m;
  };
  const statics = new Map<THREE.Material, THREE.BufferGeometry>();
  const box = new THREE.Box3();
  for (const [m, l] of lists) {
    const g = merge(l);
    if (!g) continue;
    statics.set(m, g);
    g.computeBoundingBox();
    box.union(g.boundingBox!);
  }
  const glow = glowL.length ? merge(glowL) : null;
  const beacon = beaconL.length ? merge(beaconL) : null;
  if (glow) {
    glow.computeBoundingBox();
    box.union(glow.boundingBox!);
  }
  let total = 0;
  edgeParts.forEach((a) => (total += a.length));
  const edges = new Float32Array(total);
  let o = 0;
  for (const a of edgeParts) {
    edges.set(a, o);
    o += a.length;
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 5, 1));
  return { statics, glow, beacon, edges, box, spinRoots };
}

interface MergeItem {
  geo: THREE.BufferGeometry;
  m: THREE.Matrix4;
  id: string;
}

/** Concatenate transformed geometries into one with a white vertex-colour attribute; returns id → vertex range. */
function mergeItems(items: MergeItem[]): { geo: THREE.BufferGeometry; ranges: Map<string, [number, number]> } {
  let V = 0;
  let I = 0;
  for (const it of items) {
    V += it.geo.attributes.position.count;
    I += it.geo.index!.count;
  }
  const pos = new Float32Array(V * 3);
  const nor = new Float32Array(V * 3);
  const col = new Float32Array(V * 3).fill(1);
  const idx = V > 65535 ? new Uint32Array(I) : new Uint16Array(I);
  const ranges = new Map<string, [number, number]>();
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let vo = 0;
  let io = 0;
  for (const it of items) {
    const p = it.geo.attributes.position;
    const n = it.geo.attributes.normal;
    nm.getNormalMatrix(it.m);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(it.m);
      pos[(vo + i) * 3] = v.x;
      pos[(vo + i) * 3 + 1] = v.y;
      pos[(vo + i) * 3 + 2] = v.z;
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      nor[(vo + i) * 3] = v.x;
      nor[(vo + i) * 3 + 1] = v.y;
      nor[(vo + i) * 3 + 2] = v.z;
    }
    const ix = it.geo.index!;
    for (let i = 0; i < ix.count; i++) idx[io + i] = ix.getX(i) + vo;
    ranges.set(it.id, [vo, p.count]);
    vo += p.count;
    io += ix.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return { geo, ranges };
}

export interface BuildingInfo {
  id: string;
  kind: Building['kind'];
  cx: number;
  cz: number;
  /** world extents after rotation (m) */
  w: number;
  d: number;
  height: number;
  matrix: THREE.Matrix4;
  inPorts: THREE.Vector3[];
  outPorts: THREE.Vector3[];
}

interface ColorRange {
  attr: THREE.BufferAttribute;
  start: number;
  count: number;
}

const TINT_DESTROYED = new THREE.Color(0x55524a);
const GLOW_DIM = GLOW_ON.clone().lerp(GLOW_OFF, 0.5);
const GLOW_DEAD = new THREE.Color(0x24211d);
const WHITE = new THREE.Color(1, 1, 1);
const BEACON_OFF = new THREE.Color(0.14, 0.14, 0.14);

interface Spinner {
  obj: THREE.Object3D;
  axis: 'x' | 'y' | 'z';
  speed: number;
  id: string;
  angle: number;
}

/**
 * All buildings merged: one mesh per material (vertex-colour tint per building), one glow mesh,
 * one beacon mesh, one outline LineSegments. Spinning parts stay separate objects.
 */
export class BuildingBatch {
  readonly group = new THREE.Group();
  readonly info = new Map<string, BuildingInfo>();
  private tintRanges = new Map<string, ColorRange[]>();
  private glowRanges = new Map<string, ColorRange>();
  private beaconRanges = new Map<string, ColorRange>();
  private spinners: Spinner[] = [];
  private spinHolders = new Map<string, THREE.Group>();
  private active = new Set<string>();
  private backup = new Set<string>();
  private beaconMesh: THREE.Mesh | null = null;
  private glowAttr: THREE.BufferAttribute | null = null;
  private flickerT = 0;
  private status = new Map<string, BuildingStatus>();
  private disposables: Array<{ dispose(): void }> = [];
  meshCount = 0;

  constructor(
    buildings: Building[],
    lib: ModelLib,
  ) {
    const templates = new Map<string, Baked>();
    const statics = new Map<THREE.Material, MergeItem[]>();
    const glowItems: MergeItem[] = [];
    const beaconItems: MergeItem[] = [];
    const edgeSets: Array<{ edges: Float32Array; m: THREE.Matrix4 }> = [];
    let edgeTotal = 0;

    for (const b of buildings) {
      const key = `${b.kind}:${b.variant}`;
      let tpl = templates.get(key);
      let spinSrc: THREE.Group | null = null;
      if (!tpl) {
        const g = lib.building(b.kind, b.variant, b.variant * 17 + 3);
        tpl = bake(g, true);
        const meta = {
          inP: (g.userData.powerPorts as THREE.Vector3[] | undefined) ?? [],
          outP: (g.userData.outPorts as THREE.Vector3[] | undefined) ?? [],
        };
        (tpl as any).meta = meta;
        templates.set(key, tpl);
        if (tpl.spinRoots.length) spinSrc = g;
      }
      const meta = (tpl as any).meta as { inP: THREE.Vector3[]; outP: THREE.Vector3[] };

      // placement from occupied cells (rotation-safe)
      let c0 = 1e9,
        c1 = -1,
        r0 = 1e9,
        r1 = -1;
      for (const id of b.cells) {
        const c = cellCol(id);
        const r = cellRow(id);
        c0 = Math.min(c0, c);
        c1 = Math.max(c1, c);
        r0 = Math.min(r0, r);
        r1 = Math.max(r1, r);
      }
      const cx = ((c0 + c1 + 1) / 2) * CELL - HALF_W;
      const cz = ((r0 + r1 + 1) / 2) * CELL - HALF_D;
      const m = new THREE.Matrix4().makeRotationY((b.rotation * Math.PI) / 2).setPosition(cx, LOT_Y, cz);
      const info: BuildingInfo = {
        id: b.id,
        kind: b.kind,
        cx,
        cz,
        w: (c1 - c0 + 1) * CELL,
        d: (r1 - r0 + 1) * CELL,
        height: tpl.box.max.y + LOT_Y,
        matrix: m,
        inPorts: meta.inP.map((p) => p.clone().applyMatrix4(m)),
        outPorts: meta.outP.map((p) => p.clone().applyMatrix4(m)),
      };
      this.info.set(b.id, info);

      for (const [mat, geo] of tpl.statics) {
        let l = statics.get(mat);
        if (!l) statics.set(mat, (l = []));
        l.push({ geo, m, id: b.id });
      }
      if (tpl.glow) glowItems.push({ geo: tpl.glow, m, id: b.id });
      if (tpl.beacon) beaconItems.push({ geo: tpl.beacon, m, id: b.id });
      if (tpl.edges.length) {
        edgeSets.push({ edges: tpl.edges, m });
        edgeTotal += tpl.edges.length;
      }

      if (tpl.spinRoots.length) this.addSpinners(b, lib, m, spinSrc);
    }

    // merged static meshes (one per material)
    for (const [mat, items] of statics) {
      const { geo, ranges } = mergeItems(items);
      const mm = (mat as THREE.MeshToonMaterial).clone() as THREE.MeshToonMaterial;
      mm.vertexColors = true; // per-building tint multiplies the palette colour (white = untinted)
      mm.polygonOffset = true;
      mm.polygonOffsetFactor = 1;
      mm.polygonOffsetUnits = 1;
      const mesh = new THREE.Mesh(geo, mm);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.disposables.push(geo, mm);
      const attr = geo.attributes.color as THREE.BufferAttribute;
      for (const [id, [start, count]] of ranges) {
        let l = this.tintRanges.get(id);
        if (!l) this.tintRanges.set(id, (l = []));
        l.push({ attr, start, count });
      }
      this.meshCount++;
    }

    if (glowItems.length) {
      const { geo, ranges } = mergeItems(glowItems);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      this.disposables.push(geo, mat);
      this.glowAttr = geo.attributes.color as THREE.BufferAttribute;
      for (const [id, [start, count]] of ranges) this.glowRanges.set(id, { attr: this.glowAttr, start, count });
      this.meshCount++;
    }
    if (beaconItems.length) {
      const { geo, ranges } = mergeItems(beaconItems);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
      mat.color.copy(new THREE.Color(COLORS.red));
      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      this.beaconMesh = mesh;
      this.disposables.push(geo, mat);
      const attr = geo.attributes.color as THREE.BufferAttribute;
      for (const [id, [start, count]] of ranges) this.beaconRanges.set(id, { attr, start, count });
      this.meshCount++;
    }
    if (edgeTotal) {
      const pos = new Float32Array(edgeTotal);
      const v = new THREE.Vector3();
      let o = 0;
      for (const { edges, m } of edgeSets) {
        for (let i = 0; i < edges.length; i += 3) {
          v.set(edges[i], edges[i + 1], edges[i + 2]).applyMatrix4(m);
          pos[o++] = v.x;
          pos[o++] = v.y;
          pos[o++] = v.z;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({ color: COLORS.ink });
      const lines = new THREE.LineSegments(geo, mat);
      lines.frustumCulled = false;
      this.group.add(lines);
      this.disposables.push(geo, mat);
      this.meshCount++;
    }
    templates.forEach((t) => {
      t.statics.forEach((g) => g.dispose());
      t.glow?.dispose();
      t.beacon?.dispose();
    });
  }

  private addSpinners(b: Building, lib: ModelLib, m: THREE.Matrix4, src: THREE.Group | null): void {
    // Build a fresh copy so each building owns its spinning parts; drop everything that was merged.
    const g = src ?? lib.building(b.kind, b.variant, b.variant * 17 + 3);
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(m);
    holder.add(g);
    const keep = new Set<THREE.Object3D>();
    const spins: THREE.Object3D[] = [];
    g.traverse((o) => {
      if (o !== g && o.userData.spin && !spins.some((s) => this.isDescendant(o, s))) spins.push(o);
    });
    for (const s of spins) {
      keep.add(s);
      s.traverse((o) => keep.add(o));
      for (let p: THREE.Object3D | null = s.parent; p; p = p.parent) keep.add(p);
    }
    const drop: THREE.Object3D[] = [];
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !keep.has(o)) drop.push(o);
    });
    drop.forEach((o) => o.removeFromParent());
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    holder.updateMatrixWorld(true);
    this.group.add(holder);
    this.spinHolders.set(b.id, holder);
    for (const s of spins) {
      const sp = s.userData.spin as { axis: 'x' | 'y' | 'z'; speed: number };
      this.spinners.push({ obj: s, axis: sp.axis, speed: sp.speed, id: b.id, angle: 0 });
    }
  }

  private isDescendant(o: THREE.Object3D, anc: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === anc) return true;
    return false;
  }

  private paint(r: ColorRange | undefined, c: THREE.Color): void {
    if (!r) return;
    const a = r.attr.array as Float32Array;
    for (let i = r.start; i < r.start + r.count; i++) {
      a[i * 3] = c.r;
      a[i * 3 + 1] = c.g;
      a[i * 3 + 2] = c.b;
    }
    r.attr.needsUpdate = true;
  }

  /** Apply a building's status to tint / glow / beacon / spin. */
  setStatus(id: string, s: BuildingStatus): void {
    if (this.status.get(id) === s) return;
    this.status.set(id, s);
    const tints = this.tintRanges.get(id);
    const tint = s === 'destroyed' ? TINT_DESTROYED : WHITE;
    tints?.forEach((r) => this.paint(r, tint));
    const gr = this.glowRanges.get(id);
    this.backup.delete(id);
    switch (s) {
      case 'online':
        this.paint(gr, GLOW_ON);
        break;
      case 'brownout':
        this.paint(gr, GLOW_DIM);
        break;
      case 'backup':
        this.paint(gr, GLOW_BACKUP);
        this.backup.add(id);
        break;
      case 'offline':
        this.paint(gr, GLOW_OFF);
        break;
      case 'destroyed':
        this.paint(gr, GLOW_DEAD);
        break;
    }
    const powered = s === 'online' || s === 'brownout' || s === 'backup';
    this.paint(this.beaconRanges.get(id), powered ? WHITE : BEACON_OFF);
    if (powered) this.active.add(id);
    else this.active.delete(id);
    const holder = this.spinHolders.get(id);
    if (holder) holder.visible = s !== 'destroyed';
  }

  update(dt: number, t: number): void {
    for (const sp of this.spinners) {
      if (!this.active.has(sp.id)) continue;
      sp.angle += sp.speed * dt;
      sp.obj.rotation[sp.axis] = sp.angle;
    }
    if (this.beaconMesh) this.beaconMesh.visible = Math.sin(t * 4.2) > -0.2;
    this.flickerT += dt;
    if (this.flickerT > 0.11 && this.backup.size) {
      this.flickerT = 0;
      const c = new THREE.Color();
      for (const id of this.backup) {
        c.copy(GLOW_BACKUP).multiplyScalar(0.72 + Math.random() * 0.4);
        this.paint(this.glowRanges.get(id), c);
      }
    }
  }

  setShadows(on: boolean): void {
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = on;
    });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.group.removeFromParent();
  }
}

export { GRID_COLS };
