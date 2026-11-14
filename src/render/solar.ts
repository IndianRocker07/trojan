import * as THREE from 'three';
import { CELL, FOOTPRINT } from '../core/constants';
import type { Building, BuildingKind, ProsumerSpec, SimSnapshot } from '../core/types';
import type { BuildingInfo } from './batch';
import { COLORS, MAT } from './palette';
import type { ModelLib } from './modelLib';

/**
 * Rooftop solar for prosumer buildings (docs/MICROGRID.md §8).
 *
 * Draw calls added: 2-3 (panel slabs instanced, legs + battery cabinets instanced, ink outlines static).
 *
 * Roof height is measured, not guessed: each built template is probed with a downward ray grid
 * (RoofMap). A panel block is accepted only where its sample points lie on one plane, so panels sit on
 * flat roofs (20 deg rack, legs down to the roof) or flush on a pitched roof (matching the roof normal).
 * Campus schools also get a battery cabinet on the ground beside the building.
 *
 * Panel base colour is MAT.glass (the palette's dark blue-grey, toon ramp included). The export glow is
 * a per-instance colour multiplier, so no extra material is created.
 */

const PW = 1.6; // panel width along building X (m)
const PD = 1.0; // panel depth along the slope (m)
const PT = 0.05; // panel thickness (m)
const TILT = THREE.MathUtils.degToRad(20);
const RACK = 0.3; // clearance under a flat panel's low edge (m)
const LEG = 0.07; // rack leg width (m)
const STANDOFF = 0.12; // flush-mounted clearance (m)
const GAP_X = 0.3;
const GAP_Z = 0.6;
const ROOF_MIN = 1.5; // hits below this are lot / ground, not roofs
const GRID = 0.5; // roof probe spacing (m)
const CAB = { w: 1.4, h: 1.6, d: 0.8 }; // battery cabinet (m)

/** Panel block shapes (columns × rows) to try, largest first. */
const SHAPES: Record<ProsumerSpec['kind'], Array<[number, number]>> = {
  rooftop: [
    [2, 1],
    [1, 1],
  ],
  campus: [
    [3, 2],
    [3, 1],
    [2, 1],
    [1, 1],
  ],
};

/**
 * Models that already draw their own solar (house.ts modernBox = variant 2; school.ts both variants).
 * Their rooftop houses get no extra panels; campus schools keep only the battery cabinet.
 */
const BUILTIN_SOLAR = new Set(['house:2', 'school:0', 'school:1']);

// Export glow: MAT.glass base, lifted toward palette green by 30 %. Stored as a per-instance multiplier.
const BASE_LIN = new THREE.Color(COLORS.glassOff);
const EXPORT_LIN = new THREE.Color(COLORS.glassOff).lerp(new THREE.Color(COLORS.green), 0.3);
const EXPORT_K = new THREE.Color(EXPORT_LIN.r / BASE_LIN.r, EXPORT_LIN.g / BASE_LIN.g, EXPORT_LIN.b / BASE_LIN.b);
const WHITE = new THREE.Color(1, 1, 1);
const BLACK = new THREE.Color(0, 0, 0);
const STEEL = new THREE.Color(COLORS.steel);
const TEAL = new THREE.Color(COLORS.teal);

interface Cell {
  x: number;
  z: number;
  p: THREE.Vector3; // world-up hit point on the template
  n: THREE.Vector3; // surface normal (world frame of the template)
}

/** Downward ray probe of a built template: height and normal of the first surface at each grid point. */
class RoofMap {
  readonly list: Cell[] = [];
  private cells: Array<Cell | null>;
  private nx: number;
  private nz: number;

  constructor(
    g: THREE.Group,
    private halfW: number,
    private halfD: number,
  ) {
    g.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    this.nx = Math.round((2 * halfW) / GRID) + 1;
    this.nz = Math.round((2 * halfD) / GRID) + 1;
    this.cells = new Array<Cell | null>(this.nx * this.nz).fill(null);
    const rc = new THREE.Raycaster();
    rc.far = 200;
    const down = new THREE.Vector3(0, -1, 0);
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = -halfW + i * GRID;
        const z = -halfD + j * GRID;
        rc.set(new THREE.Vector3(x, 80, z), down);
        const hit = rc.intersectObjects(meshes, false)[0];
        if (!hit?.face) continue;
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        const cell: Cell = { x, z, p: hit.point.clone(), n };
        this.cells[j * this.nx + i] = cell;
        this.list.push(cell);
      }
    }
  }

  at(x: number, z: number): Cell | null {
    const i = Math.round((x + this.halfW) / GRID);
    const j = Math.round((z + this.halfD) / GRID);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return null;
    return this.cells[j * this.nx + i];
  }
}

interface Block {
  c: Cell; // centre probe (plane origin and normal)
  nx: number;
  nz: number;
  flat: boolean;
}

/** Find the highest block of nx × nz panels whose samples all lie on one plane. */
function findBlock(map: RoofMap, nx: number, nz: number, W: number, D: number): Block | null {
  const bw = nx * PW + (nx - 1) * GAP_X;
  const bd = nz * PD + (nz - 1) * GAP_Z;
  let best: Block | null = null;
  let bestScore = -Infinity;
  for (const c of map.list) {
    if (c.p.y < ROOF_MIN || c.n.y < 0.6) continue;
    if (Math.abs(c.x) + bw / 2 > W / 2 - 0.6 || Math.abs(c.z) + bd / 2 > D / 2 - 0.6) continue;
    const N = c.n;
    let ok = true;
    panels: for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const px = c.x + (i - (nx - 1) / 2) * (PW + GAP_X);
        const pz = c.z + (j - (nz - 1) / 2) * (PD + GAP_Z);
        for (const sx of [-0.6, 0, 0.6]) {
          for (const sz of [-0.35, 0, 0.35]) {
            const q = map.at(px + sx, pz + sz);
            if (!q || q.p.y < ROOF_MIN || q.n.dot(N) < 0.97) {
              ok = false;
              break panels;
            }
            const dev = (q.p.x - c.p.x) * N.x + (q.p.y - c.p.y) * N.y + (q.p.z - c.p.z) * N.z;
            if (Math.abs(dev) > 0.07) {
              ok = false;
              break panels;
            }
          }
        }
      }
    }
    if (!ok) continue;
    const flat = N.y > 0.995;
    const score = (flat ? 1000 : 0) + c.p.y - 0.02 * Math.hypot(c.x, c.z);
    if (score > bestScore) {
      bestScore = score;
      best = { c, nx, nz, flat };
    }
  }
  return best;
}

/** Ground-level spot for the battery cabinet, nearest to the front-right corner of the lot. */
function findGround(map: RoofMap, W: number, D: number): { x: number; z: number; y: number } | null {
  const tx = W / 2 - 2.4;
  const tz = D / 2 - 2.4;
  let best: { x: number; z: number; y: number } | null = null;
  let bestD = Infinity;
  for (const c of map.list) {
    if (c.p.y > 0.6 || c.n.y < 0.99) continue;
    if (Math.abs(c.x) > W / 2 - 1 || Math.abs(c.z) > D / 2 - 1) continue;
    let ok = true;
    for (const sx of [-CAB.w / 2, CAB.w / 2]) {
      for (const sz of [-CAB.d / 2, CAB.d / 2]) {
        const q = map.at(c.x + sx, c.z + sz);
        if (!q || q.p.y > 0.6 || q.n.y < 0.99 || Math.abs(q.p.y - c.p.y) > 0.04) ok = false;
      }
    }
    if (!ok) continue;
    const d = Math.hypot(c.x - tx, c.z - tz);
    if (d < bestD) {
      bestD = d;
      best = { x: c.x, z: c.z, y: c.p.y };
    }
  }
  return best;
}

/** Local (template-frame) instance transforms for one building variant. */
interface Layout {
  panels: THREE.Matrix4[];
  legs: THREE.Matrix4[];
  cabinets: THREE.Matrix4[];
}

const UNIT = new THREE.Quaternion();

function buildLayout(lib: ModelLib, kind: BuildingKind, variant: number, pkind: ProsumerSpec['kind']): Layout | null {
  const builtin = BUILTIN_SOLAR.has(`${kind}:${variant}`);
  if (builtin && pkind === 'rooftop') return { panels: [], legs: [], cabinets: [] };
  const g = lib.building(kind, variant, variant * 17 + 3);
  const fp = FOOTPRINT[kind];
  const W = fp.w * CELL;
  const D = fp.d * CELL;
  const map = new RoofMap(g, W / 2, D / 2);

  let block: Block | null = null;
  for (const [nx, nz] of builtin ? [] : SHAPES[pkind]) {
    block = findBlock(map, nx, nz, W, D);
    if (block) break;
  }

  const out: Layout = { panels: [], legs: [], cabinets: [] };
  if (block) {
    const P0 = block.c.p;
    const N0 = block.c.n;
    const planeY = (x: number, z: number) => P0.y - (N0.x * (x - P0.x) + N0.z * (z - P0.z)) / N0.y;
    const s = Math.sin(TILT);
    const c = Math.cos(TILT);
    const rackUp = new THREE.Vector3(0, c, s); // flat panel normal, tilted toward +Z (front)
    const rackFwd = new THREE.Vector3(0, -s, c); // along the slope, low edge at +Z
    const xAxisFlat = new THREE.Vector3(1, 0, 0);

    for (let i = 0; i < block.nx; i++) {
      for (let j = 0; j < block.nz; j++) {
        const px = block.c.x + (i - (block.nx - 1) / 2) * (PW + GAP_X);
        const pz = block.c.z + (j - (block.nz - 1) / 2) * (PD + GAP_Z);
        const py = planeY(px, pz);
        const m = new THREE.Matrix4();
        if (block.flat) {
          const C = new THREE.Vector3(px, py + RACK + (s * PD) / 2 + (c * PT) / 2, pz);
          m.makeBasis(xAxisFlat, rackUp, rackFwd).setPosition(C);
          out.panels.push(m);
          // four legs: two under the low edge, two under the high edge, from the roof up to the underside
          for (const zoff of [PD * 0.4, -PD * 0.4]) {
            for (const xo of [-0.55, 0.55]) {
              const ux = C.x + xo;
              const uz = C.z + rackFwd.z * zoff - rackUp.z * (PT / 2);
              const uy = C.y + rackFwd.y * zoff - rackUp.y * (PT / 2);
              const by = planeY(ux, uz);
              const H = uy - by;
              if (H < 0.05) continue;
              out.legs.push(new THREE.Matrix4().compose(new THREE.Vector3(ux, by + H / 2, uz), UNIT, new THREE.Vector3(LEG, H, LEG)));
            }
          }
        } else {
          // flush mount: the panel lies on the pitched roof, parallel to its surface
          const Y = N0.clone().normalize();
          const X = new THREE.Vector3(1, 0, 0).sub(Y.clone().multiplyScalar(Y.x));
          if (X.lengthSq() < 1e-4) X.set(0, 0, 1);
          X.normalize();
          const Z = new THREE.Vector3().crossVectors(X, Y);
          const C = new THREE.Vector3(px, py, pz).addScaledVector(Y, STANDOFF + PT / 2);
          m.makeBasis(X, Y, Z).setPosition(C);
          out.panels.push(m);
        }
      }
    }

  }

  if (pkind === 'campus') {
    const spot = findGround(map, W, D);
    if (spot) {
      out.cabinets.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(spot.x, spot.y + CAB.h / 2, spot.z),
          UNIT,
          new THREE.Vector3(CAB.w, CAB.h, CAB.d),
        ),
      );
    }
  }
  return out;
}

interface Entry {
  id: string;
  start: number;
  count: number;
  state: number; // 0 idle / night, 1 exporting, 2 destroyed
}

/** Panel slabs, rack legs, battery cabinets and their ink outlines for every prosumer building. */
export class SolarLayer {
  readonly group = new THREE.Group();
  /** Draw calls this layer adds to the scene. */
  readonly drawCalls: number;
  private entries: Entry[] = [];
  private panelIM: THREE.InstancedMesh | null = null;
  private bodyIM: THREE.InstancedMesh | null = null;
  private lines: THREE.LineSegments | null = null;
  private disposables: Array<{ dispose(): void }> = [];
  private cabinets = 0;

  constructor(buildings: Building[], info: Map<string, BuildingInfo>, lib: ModelLib) {
    const layouts = new Map<string, Layout | null>();
    type Placed = { id: string; panels: THREE.Matrix4[]; bodies: Array<{ m: THREE.Matrix4; cab: boolean }> };
    const placed: Placed[] = [];
    for (const b of buildings) {
      if (!b.prosumer) continue;
      const inf = info.get(b.id);
      if (!inf) continue;
      const key = `${b.kind}:${b.variant}:${b.prosumer.kind}`;
      let lay = layouts.get(key);
      if (lay === undefined) {
        lay = buildLayout(lib, b.kind, b.variant, b.prosumer.kind);
        layouts.set(key, lay);
        if (!lay) console.warn(`[render] no roof space found for prosumer on ${b.kind}:${b.variant}`);
      }
      if (!lay) continue;
      const toWorld = (m: THREE.Matrix4) => new THREE.Matrix4().multiplyMatrices(inf.matrix, m);
      placed.push({
        id: b.id,
        panels: lay.panels.map(toWorld),
        bodies: [...lay.legs.map((m) => ({ m: toWorld(m), cab: false })), ...lay.cabinets.map((m) => ({ m: toWorld(m), cab: true }))],
      });
    }

    const nPanels = placed.reduce((n, p) => n + p.panels.length, 0);
    const nBodies = placed.reduce((n, p) => n + p.bodies.length, 0);
    this.cabinets = placed.reduce((n, p) => n + p.bodies.filter((b) => b.cab).length, 0);
    if (!nPanels && !nBodies) {
      this.drawCalls = 0;
      return;
    }

    const panelGeo = new THREE.BoxGeometry(PW, PT, PD);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.disposables.push(panelGeo, boxGeo);
    const panelEdges = new THREE.EdgesGeometry(panelGeo);
    const boxEdges = new THREE.EdgesGeometry(boxGeo);
    const pe = panelEdges.attributes.position as THREE.BufferAttribute;
    const be = boxEdges.attributes.position as THREE.BufferAttribute;

    // panel slabs: MAT.glass base, per-instance colour carries the export glow
    const panelIM = nPanels ? new THREE.InstancedMesh(panelGeo, MAT.glass, nPanels) : null;
    if (panelIM) {
      panelIM.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nPanels * 3).fill(1), 3);
      panelIM.castShadow = true;
      panelIM.receiveShadow = true;
      panelIM.frustumCulled = false;
      this.panelIM = panelIM;
      this.group.add(panelIM);
    }

    // legs and cabinets share one unit box: steel legs, teal cabinets (instance colour on a white base)
    const bodyIM = nBodies ? new THREE.InstancedMesh(boxGeo, MAT.wallWhite, nBodies) : null;
    if (bodyIM) {
      bodyIM.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nBodies * 3).fill(1), 3);
      bodyIM.castShadow = true;
      bodyIM.receiveShadow = true;
      bodyIM.frustumCulled = false;
      this.bodyIM = bodyIM;
      this.group.add(bodyIM);
    }

    // ink outlines for panels and cabinets (static: transforms never change)
    const outline = new Float32Array((nPanels * pe.count + this.cabinets * be.count) * 3);
    let oi = 0;
    const v = new THREE.Vector3();
    const pushEdges = (attr: THREE.BufferAttribute, m: THREE.Matrix4) => {
      for (let k = 0; k < attr.count; k++) {
        v.fromBufferAttribute(attr, k).applyMatrix4(m);
        outline[oi++] = v.x;
        outline[oi++] = v.y;
        outline[oi++] = v.z;
      }
    };

    let ip = 0;
    let ib = 0;
    for (const p of placed) {
      const start = ip;
      for (const m of p.panels) {
        panelIM?.setMatrixAt(ip, m);
        pushEdges(pe, m);
        ip++;
      }
      this.entries.push({ id: p.id, start, count: p.panels.length, state: 0 });
      for (const { m, cab } of p.bodies) {
        bodyIM?.setMatrixAt(ib, m);
        bodyIM?.setColorAt(ib, cab ? TEAL : STEEL);
        if (cab) pushEdges(be, m);
        ib++;
      }
    }
    panelEdges.dispose();
    boxEdges.dispose();
    if (panelIM) panelIM.instanceMatrix.needsUpdate = true;
    if (bodyIM) {
      bodyIM.instanceMatrix.needsUpdate = true;
      bodyIM.instanceColor!.needsUpdate = true;
    }

    let lines = 0;
    if (oi) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(outline.subarray(0, oi), 3));
      const lm = new THREE.LineBasicMaterial({ color: COLORS.ink });
      const ls = new THREE.LineSegments(lg, lm);
      ls.frustumCulled = false;
      this.lines = ls;
      this.group.add(ls);
      this.disposables.push(lg, lm);
      lines = 1;
    }
    this.drawCalls = (panelIM ? 1 : 0) + (bodyIM ? 1 : 0) + lines;
  }

  /** Per tick: glow while exporting in daylight, flat at night, black when the building is destroyed. */
  sync(s: SimSnapshot): void {
    const im = this.panelIM;
    if (!im || !this.entries.length) return;
    const arr = im.instanceColor!.array as Float32Array;
    let changed = false;
    for (const e of this.entries) {
      const b = s.buildings[e.id];
      const der = s.agents[e.id]?.der;
      const code = b?.status === 'destroyed' ? 2 : der && der.solarKW > 0.05 && der.exportedKW > 0.05 ? 1 : 0;
      if (code === e.state) continue;
      e.state = code;
      changed = true;
      const c = code === 2 ? BLACK : code === 1 ? EXPORT_K : WHITE;
      for (let i = e.start; i < e.start + e.count; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
    }
    if (changed) im.instanceColor!.needsUpdate = true;
  }

  get stats() {
    return { panels: this.panelIM?.count ?? 0, rackParts: this.bodyIM?.count ?? 0, buildings: this.entries.length, cabinets: this.cabinets };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.panelIM?.dispose();
    this.bodyIM?.dispose();
    this.group.removeFromParent();
    this.entries = [];
    this.panelIM = this.bodyIM = null;
    this.lines = null;
  }
}
