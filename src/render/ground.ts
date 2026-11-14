import * as THREE from 'three';
import { BLOCK, CELL, GRID_COLS, GRID_ROWS, HALF_D, HALF_W } from '../core/constants';
import type { GridCell, Terrain } from '../core/types';
import { COLORS, MAT } from './palette';
import { makeGrassDetailTexture } from './terrainTexture';

/** Top surface height of each terrain type (m). Buildings stand on LOT_Y. */
export const LOT_Y = 0.18;
export const TOP_Y: Record<Terrain, number> = { land: LOT_Y, park: LOT_Y, road: 0, bridge: 0, river: -1.1 };

type V3 = [number, number, number];

class Mesher {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  uv: number[] = [];
  private cross = new THREE.Vector3();
  private ab = new THREE.Vector3();
  private ac = new THREE.Vector3();

  quad(a: V3, b: V3, c: V3, d: V3, n: V3, color: THREE.Color): void {
    this.ab.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    this.ac.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    this.cross.crossVectors(this.ab, this.ac);
    const pts = this.cross.x * n[0] + this.cross.y * n[1] + this.cross.z * n[2] >= 0 ? [a, b, c, d] : [a, d, c, b];
    const base = this.pos.length / 3;
    for (const p of pts) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.col.push(color.r, color.g, color.b);
      this.uv.push(p[0] / 24, p[2] / 24);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  top(x0: number, z0: number, x1: number, z1: number, y: number, color: THREE.Color): void {
    this.quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], [0, 1, 0], color);
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: THREE.Color): void {
    this.top(x0, z0, x1, z1, y1, color);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], color);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], color);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], color);
    this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], color);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

const hash = (a: number, b: number): number => {
  let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 1274126177, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
export { hash as cellHash };

const C = {
  land: new THREE.Color(0x71835a),
  park: new THREE.Color(0x658d4d),
  road: new THREE.Color(0x353730),
  bridge: new THREE.Color(0xcfc8b4),
  river: new THREE.Color(COLORS.water),
  riverLight: new THREE.Color(0x3d9dff),
  side: new THREE.Color(0xd2c6a2),
  bank: new THREE.Color(0xb59b6a),
  dash: new THREE.Color(0xf3efdc),
  centerline: new THREE.Color(0xffce4a),
  rail: new THREE.Color(COLORS.ink),
  curb: new THREE.Color(0xf0e8cc),
  parkPath: new THREE.Color(0xbab39f),
};

export interface Ground {
  group: THREE.Group;
  setFade(o: number): void;
  dispose(): void;
}

export function buildGround(cells: GridCell[]): Ground {
  const m = new Mesher();
  const grass = new Mesher();
  const at = (c: number, r: number): GridCell | undefined =>
    c < 0 || r < 0 || c >= GRID_COLS || r >= GRID_ROWS ? undefined : cells[r * GRID_COLS + c];
  const roadLike = (c: GridCell | undefined) => !!c && (c.terrain === 'road' || c.terrain === 'bridge');
  const tmp = new THREE.Color();
  const lines: number[] = [];

  const cls = (c: GridCell | undefined): number =>
    !c ? -1 : c.terrain === 'river' ? 0 : c.terrain === 'road' || c.terrain === 'bridge' ? 1 : c.terrain === 'park' ? 3 : 2;

  for (const cell of cells) {
    const { col, row, terrain } = cell;
    const x0 = col * CELL - HALF_W;
    const z0 = row * CELL - HALF_D;
    const x1 = x0 + CELL;
    const z1 = z0 + CELL;
    const y = TOP_Y[terrain];
    const base = C[terrain];
    const jitter = (hash(col, row) - 0.5) * 0.035;
    tmp.copy(base).offsetHSL(0, 0, terrain === 'road' || terrain === 'river' ? jitter * 0.5 : jitter);
    if (terrain === 'river' && (col + row) % 3 === 0) tmp.copy(C.riverLight);
    m.top(x0, z0, x1, z1, y, tmp);
    if (terrain === 'land' || terrain === 'park') grass.top(x0, z0, x1, z1, y + 0.018, tmp);

    // side walls toward lower neighbours / board edge
    const nbs: Array<[number, number, V3, V3, V3, V3, V3]> = [
      [col + 1, row, [x1, 0, z0], [x1, 0, z1], [x1, 0, z1], [x1, 0, z0], [1, 0, 0]],
      [col - 1, row, [x0, 0, z0], [x0, 0, z1], [x0, 0, z1], [x0, 0, z0], [-1, 0, 0]],
      [col, row + 1, [x0, 0, z1], [x1, 0, z1], [x1, 0, z1], [x0, 0, z1], [0, 0, 1]],
      [col, row - 1, [x0, 0, z0], [x1, 0, z0], [x1, 0, z0], [x0, 0, z0], [0, 0, -1]],
    ];
    for (const [nc, nr, p0, p1, , , n] of nbs) {
      const nb = at(nc, nr);
      // no wall at the board perimeter: the env terrain continues flush from the edge
      const ny = nb ? TOP_Y[nb.terrain] : terrain === 'bridge' ? -1.7 : y;
      let yTop = y;
      let yBot = ny;
      if (terrain === 'bridge' && nb?.terrain === 'river') yBot = -1.7; // thick deck
      if (!(yTop > yBot + 1e-4)) continue;
      const sideCol = !nb ? C.side : nb.terrain === 'river' && terrain !== 'bridge' ? C.bank : C.side;
      m.quad(
        [p0[0], yTop, p0[2]],
        [p1[0], yTop, p1[2]],
        [p1[0], yBot, p1[2]],
        [p0[0], yBot, p0[2]],
        n,
        sideCol,
      );
      // bridge railings
      if (terrain === 'bridge' && nb?.terrain === 'river') {
        const along = n[0] !== 0;
        const o = 0.35;
        const px = n[0] > 0 ? x1 - o : n[0] < 0 ? x0 : x0;
        const pz = n[2] > 0 ? z1 - o : n[2] < 0 ? z0 : z0;
        if (along) m.box(px, 0, z0, px + o, 1, z1, C.rail);
        else m.box(x0, 0, pz, x1, 1, pz + o, C.rail);
      }
    }

    // outline between different terrain classes (right & bottom neighbours + board edge)
    const k = cls(cell);
    const right = at(col + 1, row);
    const down = at(col, row + 1);
    const ly = (o: GridCell | undefined) => Math.max(y, o ? TOP_Y[o.terrain] : y) + 0.03;
    if (right && cls(right) !== k) lines.push(x1, ly(right), z0, x1, ly(right), z1);
    if (down && cls(down) !== k) lines.push(x0, ly(down), z1, x1, ly(down), z1);

    // road markings
    if (terrain === 'road' || terrain === 'bridge') {
      const hz = roadLike(at(col - 1, row)) && roadLike(at(col + 1, row));
      const vt = roadLike(at(col, row - 1)) && roadLike(at(col, row + 1));
      const yy = y + 0.035;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const arterial = col === GRID_COLS / 2 || row === GRID_ROWS / 2;
      if (hz && !vt) {
        if (arterial) {
          // Central two-way boulevard: double yellow centreline and broken white lane guides.
          m.top(x0, cz - 0.14, x1, cz - 0.06, yy, C.centerline);
          m.top(x0, cz + 0.06, x1, cz + 0.14, yy, C.centerline);
          for (const s of [1.2, 7.2]) for (const side of [-1, 1]) {
            m.top(x0 + s, cz + side * 3.1 - 0.1, x0 + s + 3.6, cz + side * 3.1 + 0.1, yy, C.dash);
          }
        } else {
          for (const s of [1.2, 7.2]) m.top(x0 + s, cz - 0.18, x0 + s + 3.6, cz + 0.18, yy, C.dash);
        }
      } else if (vt && !hz) {
        if (arterial) {
          m.top(cx - 0.14, z0, cx - 0.06, z1, yy, C.centerline);
          m.top(cx + 0.06, z0, cx + 0.14, z1, yy, C.centerline);
          for (const s of [1.2, 7.2]) for (const side of [-1, 1]) {
            m.top(cx + side * 3.1 - 0.1, z0 + s, cx + side * 3.1 + 0.1, z0 + s + 3.6, yy, C.dash);
          }
        } else {
          for (const s of [1.2, 7.2]) m.top(cx - 0.18, z0 + s, cx + 0.18, z0 + s + 3.6, yy, C.dash);
        }
      } else if (hz && vt && terrain === 'road') {
        // zebra crossings on the four arms of an intersection
        for (let i = 0; i < 5; i++) {
          const o = 1.6 + i * 2;
          m.top(x0 + 0.5, z0 + o, x0 + 2.3, z0 + o + 1, yy, C.dash);
          m.top(x1 - 2.3, z0 + o, x1 - 0.5, z0 + o + 1, yy, C.dash);
          m.top(x0 + o, z0 + 0.5, x0 + o + 1, z0 + 2.3, yy, C.dash);
          m.top(x0 + o, z1 - 2.3, x0 + o + 1, z1 - 0.5, yy, C.dash);
        }
      }
    }

    // pavement strip along lots that face a road
    if (terrain === 'land' || terrain === 'park') {
      const yy = y + 0.02;
      const w = 0.9;
      if (roadLike(at(col - 1, row))) m.top(x0, z0, x0 + w, z1, yy, C.curb);
      if (roadLike(at(col + 1, row))) m.top(x1 - w, z0, x1, z1, yy, C.curb);
      if (roadLike(at(col, row - 1))) m.top(x0, z0, x1, z0 + w, yy, C.curb);
      if (roadLike(at(col, row + 1))) m.top(x0, z1 - w, x1, z1, yy, C.curb);
    }

    // Quiet paved walks cross each reserved park block through its centre.
    if (terrain === 'park') {
      const pathWidth = 2.2;
      if (col % BLOCK === Math.floor(BLOCK / 2)) m.top((x0 + x1 - pathWidth) / 2, z0, (x0 + x1 + pathWidth) / 2, z1, y + 0.035, C.parkPath);
      if (row % BLOCK === Math.floor(BLOCK / 2)) m.top(x0, (z0 + z1 - pathWidth) / 2, x1, (z0 + z1 + pathWidth) / 2, y + 0.035, C.parkPath);
    }
  }

  const geo = m.build();
  const mat = MAT.paving.clone() as THREE.MeshToonMaterial;
  mat.vertexColors = true;
  mat.color.set(0xffffff);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  const grassGeo = grass.build();
  const grassMat = MAT.grass.clone() as THREE.MeshToonMaterial;
  grassMat.color.set(0xffffff);
  grassMat.vertexColors = true;
  const grassTexture = makeGrassDetailTexture();
  grassMat.map = grassTexture;
  grassMat.needsUpdate = true;
  const grassMesh = new THREE.Mesh(grassGeo, grassMat);
  grassMesh.receiveShadow = true;
  grassMesh.castShadow = false;

  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const lmat = new THREE.LineBasicMaterial({ color: COLORS.ink, transparent: true, opacity: 0.55 });
  const outline = new THREE.LineSegments(lg, lmat);

  const group = new THREE.Group();
  group.add(mesh, grassMesh, outline);
  return {
    group,
    setFade(o: number) {
      mat.transparent = o < 0.999;
      mat.opacity = o;
      mat.needsUpdate = true;
      grassMat.transparent = o < 0.999;
      grassMat.opacity = o;
      grassMat.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      grassGeo.dispose();
      grassTexture.dispose();
      grassMat.dispose();
      mat.dispose();
      lg.dispose();
      lmat.dispose();
      group.removeFromParent();
    },
  };
}
