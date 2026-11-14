import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineTier, PowerEdge, PowerNode, SimSnapshot } from '../core/types';
import { PYLON_HEIGHT } from '../core/constants';
import { COLORS } from './palette';
import type { BuildingBatch } from './batch';
import { bake } from './batch';
import type { ModelLib } from './modelLib';
import { TOP_Y } from './ground';
import { Particles } from './particles';

type SupportKind = 'pylon' | 'pole' | 'poleT';

interface Support {
  node: PowerNode;
  kind: SupportKind;
  index: number;
  pos: THREE.Vector3;
  theta: number;
  attach: THREE.Vector3[];
  alive: boolean;
}

interface Conductor {
  a: THREE.Vector3;
  b: THREE.Vector3;
}

interface EdgeRec {
  edge: PowerEdge;
  tier: LineTier;
  drop: boolean;
  seg: number; // first segment index in the tier buffer
  conds: Conductor[];
  n: number; // samples per conductor
  sag: number;
  code: number; // 0 ok, 1 broken, 2 overloaded
  centre: Float32Array; // sampled centre conductor (n*3)
  length: number;
  phase: number;
  speed: number;
  active: boolean;
  poolOffset: number;
  /** prosumer export: pulses run downstream → upstream and are drawn green */
  reverse: boolean;
}

const WIRE_OK = new THREE.Color(COLORS.ink);
const WIRE_BROKEN = new THREE.Color(COLORS.coral);
const WIRE_OVER = new THREE.Color(COLORS.orange);
const UP = new THREE.Vector3(0, 1, 0);
const SAMPLES = { transmission: 12, distribution: 9 } as const;

function sample(a: THREE.Vector3, b: THREE.Vector3, n: number, sagAmt: number, out: number[] | Float32Array, o: number): void {
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out[o + i * 3] = a.x + (b.x - a.x) * t;
    out[o + i * 3 + 1] = Math.max(0.25, a.y + (b.y - a.y) * t - 4 * sagAmt * t * (1 - t));
    out[o + i * 3 + 2] = a.z + (b.z - a.z) * t;
  }
}

function lateralAngle(attach: THREE.Vector3[]): number {
  let best = 0;
  let ang = 0;
  for (let i = 0; i < attach.length; i++)
    for (let j = i + 1; j < attach.length; j++) {
      const dx = attach[j].x - attach[i].x;
      const dz = attach[j].z - attach[i].z;
      const d = Math.hypot(dx, dz);
      if (d > best) {
        best = d;
        ang = Math.atan2(dz, dx);
      }
    }
  return best > 0.5 ? ang : 0;
}

/** Pylons / poles (instanced), catenary conductors (fat lines) and flow pulses. */
export class PowerLines {
  readonly group = new THREE.Group();
  readonly supportsGroup = new THREE.Group();
  private supports = new Map<string, Support>();
  private instMeshes = new Map<SupportKind, THREE.InstancedMesh[]>();
  private recs: EdgeRec[] = [];
  private tierGeo = new Map<LineTier, LineSegmentsGeometry>();
  private tierMat = new Map<LineTier, LineMaterial>();
  private tierObj = new Map<LineTier, LineSegments2>();
  private pulseMesh = new Map<LineTier, THREE.InstancedMesh>();
  /** green pulses for reverse-flow (prosumer export) edges */
  private pulseMeshRev = new Map<LineTier, THREE.InstancedMesh>();
  private pulseGeo = new THREE.IcosahedronGeometry(1, 1);
  private pulseMats: THREE.MeshBasicMaterial[] = [];
  private disposables: Array<{ dispose(): void }> = [];
  private flowOn = true;
  private supMats: THREE.Material[] = [];
  private sparks = new Particles(300, 0xff6a3a, -14, 1);
  private breaks: Array<{ x: number; y: number; z: number }> = [];
  private opacity = 1;
  private pr = 1;

  constructor(
    snap: SimSnapshot,
    private batch: BuildingBatch,
    lib: ModelLib,
  ) {
    const net = snap.network;
    const nodes = net.nodes;
    const edges = Object.values(net.edges);

    // ----- incident edges -------------------------------------------------
    const incident = new Map<string, PowerEdge[]>();
    for (const e of edges)
      for (const id of [e.from, e.to]) {
        let l = incident.get(id);
        if (!l) incident.set(id, (l = []));
        l.push(e);
      }

    // ----- supports -------------------------------------------------------
    const tpl: Record<SupportKind, { group: THREE.Group; attach: THREE.Vector3[]; alpha: number; baked: ReturnType<typeof bake> }> =
      {} as any;
    const mkTpl = (k: SupportKind, g: THREE.Group) => {
      const attach = ((g.userData.attach as THREE.Vector3[] | undefined) ?? []).map((p) => p.clone());
      tpl[k] = { group: g, attach, alpha: lateralAngle(attach), baked: bake(g, false) };
    };
    mkTpl('pylon', lib.pylon());
    mkTpl('pole', lib.pole(false));
    mkTpl('poleT', lib.pole(true));

    const counts: Record<SupportKind, number> = { pylon: 0, pole: 0, poleT: 0 };
    for (const node of Object.values(nodes)) {
      if (node.kind !== 'pylon' && node.kind !== 'pole') continue;
      const inc = incident.get(node.id) ?? [];
      const other = (e: PowerEdge) => nodes[e.from === node.id ? e.to : e.from];
      let use = inc.filter((e) => other(e)?.kind !== 'consumer');
      if (!use.length) use = inc;
      let sx = 0;
      let sy = 0;
      for (const e of use) {
        const o = other(e);
        if (!o) continue;
        const phi = Math.atan2(o.pos.z - node.pos.z, o.pos.x - node.pos.x);
        sx += Math.cos(2 * phi);
        sy += Math.sin(2 * phi);
      }
      const delta = use.length ? 0.5 * Math.atan2(sy, sx) : 0;
      let kind: SupportKind = node.kind === 'pylon' ? 'pylon' : 'pole';
      if (kind === 'pole' && inc.some((e) => other(e)?.kind === 'consumer')) kind = 'poleT';
      const t = tpl[kind];
      const theta = t.alpha - delta - Math.PI / 2;
      const gy = TOP_Y.road;
      const pos = new THREE.Vector3(node.pos.x, gy, node.pos.z);
      const attach = t.attach.map((p) => p.clone().applyAxisAngle(UP, theta).add(pos));
      this.supports.set(node.id, { node, kind, index: counts[kind]++, pos, theta, attach, alive: true });
    }
    const mat4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qs = new THREE.Quaternion();
    this.supportMatrix = (s: Support, fallen: boolean, out: THREE.Matrix4) => {
      q.setFromAxisAngle(UP, s.theta);
      const p = s.pos.clone();
      if (fallen) {
        q.multiply(qs.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.38));
        p.y -= 0.35;
      }
      return out.compose(p, q, new THREE.Vector3(1, 1, 1));
    };
    for (const k of ['pylon', 'pole', 'poleT'] as SupportKind[]) {
      if (!counts[k]) continue;
      const list: THREE.InstancedMesh[] = [];
      const addMesh = (geo: THREE.BufferGeometry, src: THREE.Material) => {
        const mat = src.clone();
        this.supMats.push(mat);
        const im = new THREE.InstancedMesh(geo, mat, counts[k]);
        im.castShadow = !(mat as THREE.MeshBasicMaterial).isMeshBasicMaterial;
        im.receiveShadow = true;
        im.frustumCulled = false;
        this.supportsGroup.add(im);
        list.push(im);
      };
      tpl[k].baked.statics.forEach((g, m) => addMesh(g, m));
      if (tpl[k].baked.glow) addMesh(tpl[k].baked.glow!, new THREE.MeshBasicMaterial({ color: 0xffe24a }));
      this.instMeshes.set(k, list);
    }
    for (const s of this.supports.values()) {
      this.supportMatrix(s, false, mat4);
      for (const im of this.instMeshes.get(s.kind)!) im.setMatrixAt(s.index, mat4);
    }

    // ----- conductors -----------------------------------------------------
    const portUse = new Map<string, number>();
    void portUse;
    const buildingPorts = (n: PowerNode, tier: LineTier): THREE.Vector3[] => {
      const info = n.buildingId ? this.batch.info.get(n.buildingId) : undefined;
      if (!info) return [new THREE.Vector3(n.pos.x, 8, n.pos.z)];
      let l: THREE.Vector3[];
      if (n.kind === 'generator') l = info.outPorts.length ? info.outPorts : info.inPorts;
      else if (n.kind === 'substation') {
        l = tier === 'transmission' ? info.inPorts : info.outPorts;
        if (!l.length) l = info.inPorts.length ? info.inPorts : info.outPorts;
      } else l = info.inPorts.length ? info.inPorts : info.outPorts;
      return l.length ? l : [new THREE.Vector3(info.cx, 7, info.cz)];
    };
    const ends = (n: PowerNode, tier: LineTier): { pts: THREE.Vector3[]; support: boolean } => {
      const s = this.supports.get(n.id);
      if (s) return { pts: s.attach.length ? s.attach.map((p) => p.clone()) : [s.pos.clone().setY(8)], support: true };
      return { pts: buildingPorts(n, tier).map((p) => p.clone()), support: false };
    };

    const segPos: Record<LineTier, number[]> = { transmission: [], distribution: [] };
    const segCol: Record<LineTier, number[]> = { transmission: [], distribution: [] };
    const segCount: Record<LineTier, number> = { transmission: 0, distribution: 0 };
    let pulseCap: Record<LineTier, number> = { transmission: 0, distribution: 0 };
    const spacing: Record<LineTier, number> = { transmission: 10, distribution: 4.5 };

    for (const e of edges) {
      const na = nodes[e.from];
      const nb = nodes[e.to];
      if (!na || !nb) continue;
      const drop = na.kind === 'consumer' || nb.kind === 'consumer';
      const tier = e.tier;
      const A = ends(na, tier);
      const B = ends(nb, tier);
      const dir = new THREE.Vector2(nb.pos.x - na.pos.x, nb.pos.z - na.pos.z).normalize();
      const lat = (p: THREE.Vector3) => p.x * -dir.y + p.z * dir.x;
      let pa: THREE.Vector3[];
      let pb: THREE.Vector3[];
      if (drop || (!A.support && !B.support)) {
        const ca = A.pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(A.pts.length);
        const cb = B.pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(B.pts.length);
        const bestA = A.pts.reduce((m, p) => (p.distanceToSquared(cb) < m.distanceToSquared(cb) ? p : m));
        const bestB = B.pts.reduce((m, p) => (p.distanceToSquared(bestA) < m.distanceToSquared(bestA) ? p : m));
        void ca;
        pa = [bestA];
        pb = [bestB];
      } else {
        let k = Math.min(A.support ? A.pts.length : 9, B.support ? B.pts.length : 9);
        k = Math.max(1, k);
        const pick = (l: THREE.Vector3[]) => {
          const s = [...l].sort((u, v) => lat(u) - lat(v));
          if (s.length === k) return s;
          const out: THREE.Vector3[] = [];
          for (let i = 0; i < k; i++) out.push(s[k === 1 ? 0 : Math.min(s.length - 1, Math.round((i * (s.length - 1)) / (k - 1)))]);
          if (s.length < k) for (let i = 0; i < k; i++) out[i] = s[Math.min(i, s.length - 1)];
          return out;
        };
        pa = pick(A.pts);
        pb = pick(B.pts);
      }
      const sagFrac = tier === 'transmission' ? 0.04 : drop ? 0.025 : 0.03;
      const n = SAMPLES[tier];
      const conds: Conductor[] = pa.map((a, i) => ({ a, b: pb[i] }));
      const rec: EdgeRec = {
        edge: e,
        tier,
        drop,
        seg: segCount[tier],
        conds,
        n,
        sag: sagFrac,
        code: 0,
        centre: new Float32Array(n * 3),
        length: 0,
        phase: Math.random() * spacing[tier],
        speed: 0,
        active: false,
        poolOffset: 0,
        reverse: false,
      };
      const mid = conds[Math.floor(conds.length / 2)];
      sample(mid.a, mid.b, n, sagFrac * Math.hypot(mid.b.x - mid.a.x, mid.b.z - mid.a.z), rec.centre, 0);
      let len = 0;
      for (let i = 1; i < n; i++)
        len += Math.hypot(
          rec.centre[i * 3] - rec.centre[i * 3 - 3],
          rec.centre[i * 3 + 1] - rec.centre[i * 3 - 2],
          rec.centre[i * 3 + 2] - rec.centre[i * 3 - 1],
        );
      rec.length = len;
      pulseCap[tier] += Math.floor(len / spacing[tier]) + 1;
      const tmp: number[] = new Array(n * 3);
      for (const c of conds) {
        sample(c.a, c.b, n, sagFrac * Math.hypot(c.b.x - c.a.x, c.b.z - c.a.z), tmp, 0);
        for (let i = 0; i < n - 1; i++) {
          segPos[tier].push(tmp[i * 3], tmp[i * 3 + 1], tmp[i * 3 + 2], tmp[i * 3 + 3], tmp[i * 3 + 4], tmp[i * 3 + 5]);
          segCol[tier].push(WIRE_OK.r, WIRE_OK.g, WIRE_OK.b, WIRE_OK.r, WIRE_OK.g, WIRE_OK.b);
        }
        segCount[tier] += n - 1;
      }
      this.recs.push(rec);
    }

    for (const tier of ['transmission', 'distribution'] as LineTier[]) {
      if (!segCount[tier]) continue;
      const geo = new LineSegmentsGeometry();
      geo.setPositions(segPos[tier]);
      geo.setColors(segCol[tier]);
      const mat = new LineMaterial({
        color: 0xffffff,
        linewidth: tier === 'transmission' ? 2 : 1.4,
        vertexColors: true,
        worldUnits: false,
      });
      const obj = new LineSegments2(geo, mat);
      obj.frustumCulled = false;
      this.group.add(obj);
      this.tierGeo.set(tier, geo);
      this.tierMat.set(tier, mat);
      this.tierObj.set(tier, obj);
      this.disposables.push(geo, mat);
    }

    // ----- pulses ---------------------------------------------------------
    const pcol: Record<LineTier, number> = { transmission: 0xcfe8ff, distribution: 0xffe24a };
    for (const tier of ['transmission', 'distribution'] as LineTier[]) {
      if (!pulseCap[tier]) continue;
      const mat = new THREE.MeshBasicMaterial({ color: pcol[tier], toneMapped: false });
      const im = new THREE.InstancedMesh(this.pulseGeo, mat, pulseCap[tier]);
      im.frustumCulled = false;
      im.count = 0;
      this.pulseMesh.set(tier, im);
      this.pulseMats.push(mat);
      this.group.add(im);

      const matRev = new THREE.MeshBasicMaterial({ color: COLORS.green, toneMapped: false });
      const imRev = new THREE.InstancedMesh(this.pulseGeo, matRev, pulseCap[tier]);
      imRev.frustumCulled = false;
      imRev.count = 0;
      this.pulseMeshRev.set(tier, imRev);
      this.pulseMats.push(matRev);
      this.group.add(imRev);
    }
    this.group.add(this.supportsGroup, this.sparks.points);
    void PYLON_HEIGHT;
    this.sync(snap);
  }

  private supportMatrix: (s: Support, fallen: boolean, out: THREE.Matrix4) => THREE.Matrix4;

  private widthScale = 1;

  setResolution(w: number, h: number, pr: number): void {
    this.pr = pr;
    for (const [tier, m] of this.tierMat) {
      m.resolution.set(w * pr, h * pr);
      m.linewidth = (tier === 'transmission' ? 2 : 1.4) * pr * this.widthScale;
    }
  }

  /** Thin the wires as the camera pulls back so the city view isn't a black tangle. */
  setWidthScale(s: number): void {
    if (Math.abs(s - this.widthScale) < 0.02) return;
    this.widthScale = s;
    for (const [tier, m] of this.tierMat) m.linewidth = (tier === 'transmission' ? 2 : 1.4) * this.pr * s;
  }

  setFlowVisible(on: boolean): void {
    this.flowOn = on;
    this.pulseMesh.forEach((m) => (m.visible = on));
    this.pulseMeshRev.forEach((m) => (m.visible = on));
  }

  /** Per-tick: wire state (broken / overloaded), fallen supports, flow speeds. */
  sync(snap: SimSnapshot): void {
    const nodes = snap.network.nodes;
    const mat4 = new THREE.Matrix4();
    for (const s of this.supports.values()) {
      const alive = nodes[s.node.id]?.alive ?? true;
      if (alive !== s.alive) {
        s.alive = alive;
        this.supportMatrix(s, !alive, mat4);
        for (const im of this.instMeshes.get(s.kind)!) {
          im.setMatrixAt(s.index, mat4);
          im.instanceMatrix.needsUpdate = true;
        }
      }
    }
    this.breaks.length = 0;
    for (const rec of this.recs) {
      const e = snap.network.edges[rec.edge.id] ?? rec.edge;
      const na = nodes[e.from];
      const nb = nodes[e.to];
      const dead = !(na?.alive ?? true) || !(nb?.alive ?? true);
      const broken = e.status === 'broken' || dead;
      const over = !broken && e.flowKW > 0.9 * e.capacityKW;
      const code = broken ? 1 : over ? 2 : 0;
      if (code !== rec.code) {
        this.writeEdge(rec, code, !(na?.alive ?? true), !(nb?.alive ?? true));
        rec.code = code;
      }
      if (code === 1 && !rec.drop && this.breaks.length < 60) {
        const m = Math.floor(rec.n / 2) * 3;
        this.breaks.push({ x: rec.centre[m], y: 2, z: rec.centre[m + 2] });
      }
      const ratio = e.capacityKW > 0 ? Math.min(1.2, e.flowKW / e.capacityKW) : 0;
      rec.reverse = !!e.reverse;
      rec.active = !broken && e.flowKW > 0.05;
      rec.speed = rec.active ? (3.5 + 24 * Math.min(1, Math.sqrt(ratio) * 1.6)) * (rec.code === 2 ? 1.6 : 1) : 0;
    }
  }

  private writeEdge(rec: EdgeRec, code: number, deadA: boolean, deadB: boolean): void {
    const geo = this.tierGeo.get(rec.tier);
    if (!geo) return;
    const pos = (geo.attributes.instanceStart as THREE.InterleavedBufferAttribute).data;
    const col = (geo.attributes.instanceColorStart as THREE.InterleavedBufferAttribute).data;
    const pa = pos.array as Float32Array;
    const ca = col.array as Float32Array;
    const color = code === 1 ? WIRE_BROKEN : code === 2 ? WIRE_OVER : WIRE_OK;
    const n = rec.n;
    const tmp = new Float32Array(n * 3);
    let seg = rec.seg;
    for (const c of rec.conds) {
      let a = c.a;
      let b = c.b;
      let sag = rec.sag * Math.hypot(b.x - a.x, b.z - a.z);
      if (code === 1) {
        if (deadA) a = a.clone().setY(0.3);
        if (deadB) b = b.clone().setY(0.3);
        sag = Math.max(a.y, b.y) * 1.1 + 1;
      }
      sample(a, b, n, sag, tmp, 0);
      for (let i = 0; i < n - 1; i++, seg++) {
        for (let k = 0; k < 6; k++) pa[seg * 6 + k] = tmp[i * 3 + k];
        for (let k = 0; k < 2; k++) {
          ca[seg * 6 + k * 3] = color.r;
          ca[seg * 6 + k * 3 + 1] = color.g;
          ca[seg * 6 + k * 3 + 2] = color.b;
        }
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  /** Fade the whole power layer (wires, supports, pulses). */
  setOpacity(o: number): void {
    this.opacity = o;
    this.group.visible = o > 0.01;
    const tr = o < 0.999;
    for (const m of this.tierMat.values()) {
      m.transparent = tr;
      m.opacity = o;
    }
    for (const m of [...this.supMats, ...this.pulseMats]) {
      m.transparent = tr;
      m.opacity = o;
    }
  }

  update(dt: number): void {
    if (this.opacity > 0.01) {
      for (const b of this.breaks) if (Math.random() < 9 * dt) {
        const a = Math.random() * 6.283;
        const s = 2 + Math.random() * 5;
        this.sparks.emit(b.x, b.y, b.z, Math.cos(a) * s, 3 + Math.random() * 6, Math.sin(a) * s, 0.6, 1.4, 0.3);
      }
      this.sparks.update(dt);
    }
    if (!this.flowOn) return;
    const spacing: Record<LineTier, number> = { transmission: 10, distribution: 4.5 };
    const radius: Record<LineTier, number> = { transmission: 0.26, distribution: 0.13 };
    const half: Record<LineTier, number> = { transmission: 1.6, distribution: 0.75 };
    const counters: Record<LineTier, number> = { transmission: 0, distribution: 0 };
    const countersRev: Record<LineTier, number> = { transmission: 0, distribution: 0 };
    for (const rec of this.recs) {
      if (!rec.active) continue;
      const rev = rec.reverse;
      const im = (rev ? this.pulseMeshRev : this.pulseMesh).get(rec.tier);
      if (!im) continue;
      const cnt = rev ? countersRev : counters;
      const sp = spacing[rec.tier];
      rec.phase = (rec.phase + rec.speed * dt) % sp;
      const arr = im.instanceMatrix.array as Float32Array;
      const r = radius[rec.tier] * (rec.code === 2 ? 1.3 : 1);
      const len = half[rec.tier];
      const c = rec.centre;
      const n = rec.n;
      // reverse: the same spacing, mirrored along the span, with the streak pointing back the way it travels
      const sgn = rev ? -1 : 1;
      for (let d = rec.phase; d < rec.length; d += sp) {
        let i = cnt[rec.tier];
        if (i >= im.instanceMatrix.count) break;
        cnt[rec.tier] = i + 1;
        const dd = rev ? rec.length - d : d;
        const t = (dd / rec.length) * (n - 1);
        const i0 = Math.min(n - 2, Math.floor(t));
        const f = t - i0;
        const o = i * 16;
        let zx = (c[i0 * 3 + 3] - c[i0 * 3]) * sgn;
        let zy = (c[i0 * 3 + 4] - c[i0 * 3 + 1]) * sgn;
        let zz = (c[i0 * 3 + 5] - c[i0 * 3 + 2]) * sgn;
        const zl = Math.hypot(zx, zy, zz) || 1;
        zx /= zl;
        zy /= zl;
        zz /= zl;
        // x = normalize(up × z), y = z × x
        let xx = zz;
        let xz = -zx;
        const xl = Math.hypot(xx, xz) || 1;
        xx /= xl;
        xz /= xl;
        const yx = zy * xz;
        const yy = zz * xx - zx * xz;
        const yz = -zy * xx;
        arr[o] = xx * r;
        arr[o + 1] = 0;
        arr[o + 2] = xz * r;
        arr[o + 3] = 0;
        arr[o + 4] = yx * r;
        arr[o + 5] = yy * r;
        arr[o + 6] = yz * r;
        arr[o + 7] = 0;
        arr[o + 8] = zx * len;
        arr[o + 9] = zy * len;
        arr[o + 10] = zz * len;
        arr[o + 11] = 0;
        const px = c[i0 * 3] + (c[i0 * 3 + 3] - c[i0 * 3]) * f;
        const py = c[i0 * 3 + 1] + (c[i0 * 3 + 4] - c[i0 * 3 + 1]) * f;
        const pz = c[i0 * 3 + 2] + (c[i0 * 3 + 5] - c[i0 * 3 + 2]) * f;
        arr[o + 12] = px;
        arr[o + 13] = py;
        arr[o + 14] = pz;
        arr[o + 15] = 1;
      }
    }
    for (const tier of ['transmission', 'distribution'] as LineTier[]) {
      const im = this.pulseMesh.get(tier);
      if (im) {
        im.count = counters[tier];
        im.instanceMatrix.needsUpdate = true;
      }
      const imRev = this.pulseMeshRev.get(tier);
      if (imRev) {
        imRev.count = countersRev[tier];
        imRev.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Attach point of a support for external checks (dev). */
  get stats() {
    return { edges: this.recs.length, supports: this.supports.size };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.pulseGeo.dispose();
    this.pulseMats.forEach((m) => m.dispose());
    this.supMats.forEach((m) => m.dispose());
    this.sparks.dispose();
    this.group.removeFromParent();
  }
}
