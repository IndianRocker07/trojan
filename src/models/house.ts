// Residential house models: four variants on a 1x1 cell lot (12 x 12 m).
// Origin = centre of the lot at ground level, Y up, front faces +Z.
//
// v0 Craftsman bungalow — deep porch on tapered columns, side-gable roof with a
//    shed dormer and a front-gabled garage wing.
// v1 Colonial — symmetrical two-storey front, shutters, pedimented portico,
//    two dormers and a two-car garage wing.
// v2 Split-level ranch — long low main roof, raised front-gabled bedroom wing,
//    carport, rear deck, hoop over the drive.
// v3 Townhouse pair — brick, party wall, two-storey bays, high stoops with iron
//    rails, basement windows, private front gardens.
//
// Everything sits on another part; materials only from MAT; details stay inside
// the 10.4 m lot (LOT_H = 5.2).
import * as THREE from 'three';
import {
  box, cyl, rod, sphere, gableRoof, insulator, railing, seeded, setPowerPorts,
  type Face, type ModelBuilder,
} from './kit';
import { MAT, type MatName } from '../render/palette';

export const VARIANTS = 4;

type Mat = MatName;

/** Heights (m). */
const GROUND = 0.12; // top of the lot slab
const FL = 0.42; // ground floor level
const STOREY = 3.2;
const T1 = FL + STOREY; // 3.62: first-floor level / one-storey eave
const TOP = FL + 2 * STOREY; // 6.82: two-storey eave
const LOT_H = 5.2;

// ---------------------------------------------------------------- primitives

function pickFrom<T>(rnd: () => number, list: readonly T[]): T {
  return list[Math.floor(rnd() * list.length)];
}

/** Mesh from a geometry that the kit cannot make (triangles, angled slabs). */
function put(
  g: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: Mat,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, MAT[mat]);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  g.add(m);
  return m;
}

/**
 * Box on a wall face. `plane` = wall plane, `along` = coordinate along the wall,
 * `out` = gap from the wall, y = BOTTOM. w runs along the wall, d out of it.
 */
function fBox(
  g: THREE.Object3D,
  face: Face,
  plane: number,
  mat: Mat,
  along: number,
  y: number,
  out: number,
  w: number,
  h: number,
  d: number,
): THREE.Mesh {
  const s = face[0] === '+' ? 1 : -1;
  if (face === '+z' || face === '-z') return box(g, w, h, d, mat, along, y, plane + s * (out + d / 2));
  return box(g, d, h, w, mat, plane + s * (out + d / 2), y, along);
}

/** Gable end: triangle filled with wall material plus raking trim. Faces +Z before rotation. */
function gableEnd(
  g: THREE.Object3D,
  o: { face: Face; x: number; y: number; z: number; w: number; rise: number; mat: Mat; trim?: Mat; vent?: boolean },
): void {
  const grp = new THREE.Group();
  grp.position.set(o.x, o.y, o.z);
  grp.rotation.y = o.face === '+z' ? 0 : o.face === '-z' ? Math.PI : o.face === '+x' ? Math.PI / 2 : -Math.PI / 2;
  g.add(grp);
  const depth = 0.22;
  const sh = new THREE.Shape();
  sh.moveTo(-o.w / 2, 0);
  sh.lineTo(o.w / 2, 0);
  sh.lineTo(0, o.rise);
  sh.closePath();
  const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  put(grp, geo, o.mat, 0, 0, 0);
  const trim = o.trim ?? 'wallWhite';
  const rakeLen = Math.hypot(o.w / 2, o.rise);
  const ang = Math.atan2(o.rise, o.w / 2);
  for (const s of [-1, 1]) {
    put(grp, new THREE.BoxGeometry(rakeLen, 0.2, 0.26), trim, (s * o.w) / 4, o.rise / 2, depth / 2 + 0.04, 0, 0, -s * ang);
  }
  // soffit return under the eaves, so the gable never floats
  box(grp, o.w + 0.1, 0.16, 0.22, trim, 0, -0.16, depth / 2 - 0.11);
  if (o.vent) {
    box(grp, 0.56, 0.3, 0.1, 'ink', 0, o.rise * 0.42, depth / 2 + 0.14);
    for (let i = 0; i < 4; i++) box(grp, 0.44, 0.03, 0.05, 'steel', 0, o.rise * 0.42 + 0.05 + i * 0.06, depth / 2 + 0.21);
  }
}

/** Double-hung window: white casing, ink sashes, sill, optional shutters. (along, y) = bottom centre. */
function win(
  g: THREE.Object3D,
  o: {
    face: Face; plane: number; along: number; y: number; w: number; h: number;
    frame?: Mat; shutters?: 'ink' | 'wallWhite' | false; muntins?: boolean; sill?: boolean;
  },
): void {
  const fr = o.frame ?? 'wallWhite';
  const { face, plane, along, y, w, h } = o;
  fBox(g, face, plane, 'glow', along, y + 0.02, -0.01, w, h, 0.07);
  fBox(g, face, plane, fr, along - w / 2 - 0.1, y - 0.1, 0.02, 0.2, h + 0.22, 0.22);
  fBox(g, face, plane, fr, along + w / 2 + 0.1, y - 0.1, 0.02, 0.2, h + 0.22, 0.22);
  fBox(g, face, plane, fr, along, y + h + 0.02, 0.02, w + 0.34, 0.2, 0.22);
  fBox(g, face, plane, 'ink', along, y + h * 0.48, 0.055, w - 0.04, 0.065, 0.1); // meeting rail
  if (o.muntins) {
    fBox(g, face, plane, 'ink', along - w / 4, y + h * 0.45, 0.05, 0.04, h * 0.5, 0.09);
    fBox(g, face, plane, 'ink', along + w / 4, y + h * 0.45, 0.05, 0.04, h * 0.5, 0.09);
    fBox(g, face, plane, 'ink', along, y + h * 0.72, 0.05, w - 0.04, 0.04, 0.09);
  }
  if (o.sill !== false) fBox(g, face, plane, 'concrete', along, y - 0.18, 0.02, w + 0.5, 0.14, 0.3);
  if (o.shutters) {
    const sh = o.shutters;
    for (const s of [-1, 1]) {
      const u = along + s * (w / 2 + 0.36);
      fBox(g, face, plane, sh, u, y - 0.08, 0.02, 0.42, h + 0.16, 0.1);
      if (sh === 'ink') {
        fBox(g, face, plane, 'steelDark', u, y + h * 0.3, 0.12, 0.28, 0.05, 0.03);
        fBox(g, face, plane, 'steelDark', u, y + h * 0.68, 0.12, 0.28, 0.05, 0.03);
      }
    }
  }
}

/** Door with frame, leaf, panels, knob, optional sidelights, transom and hood. */
function doorway(
  g: THREE.Object3D,
  o: {
    face: Face; plane: number; along: number; y0: number; w: number; h: number; leaf: Mat;
    surround?: Mat; sidelights?: boolean; transom?: boolean; hood?: 'none' | 'flat' | 'gable';
  },
): void {
  const { face, plane, along, y0, w, h } = o;
  const su = o.surround ?? 'wallWhite';
  fBox(g, face, plane, su, along - w / 2 - 0.11, y0 - 0.04, 0.02, 0.22, h + 0.18, 0.24); // jambs
  fBox(g, face, plane, su, along + w / 2 + 0.11, y0 - 0.04, 0.02, 0.22, h + 0.18, 0.24);
  fBox(g, face, plane, su, along, y0 + h + 0.02, 0.02, w + 0.44, 0.2, 0.26); // head
  fBox(g, face, plane, 'ink', along, y0, 0.05, w + 0.04, h, 0.08); // dark reveal
  fBox(g, face, plane, o.leaf, along, y0 + 0.03, 0.09, w - 0.08, h - 0.04, 0.07); // leaf
  // two recessed panels
  for (const yy of [y0 + 0.18, y0 + h * 0.6]) {
    fBox(g, face, plane, 'ink', along, yy, 0.165, w - 0.34, h * 0.27, 0.025);
  }
  fBox(g, face, plane, 'ink', along, y0 - 0.03, 0.02, w + 0.3, 0.1, 0.34); // threshold
  const s = face[0] === '+' ? 1 : -1;
  const kx = face === '+z' || face === '-z' ? along + w * 0.32 : plane + s * 0.16;
  const kz = face === '+z' || face === '-z' ? plane + s * 0.16 : along + w * 0.32;
  sphere(g, 0.05, 'yellow', kx, y0 + h * 0.46, kz, 8);
  if (o.sidelights) {
    for (const sd of [-1, 1]) {
      const u = along + sd * (w / 2 + 0.34);
      fBox(g, face, plane, su, u, y0 - 0.04, 0.02, 0.2, h + 0.18, 0.22);
      fBox(g, face, plane, 'glow', u, y0 + 0.12, 0.01, 0.26, h - 0.35, 0.06);
    }
  }
  if (o.transom) {
    fBox(g, face, plane, 'glow', along, y0 + h + 0.22, 0.0, w - 0.1, 0.34, 0.06);
    fBox(g, face, plane, su, along, y0 + h + 0.16, 0.05, w + 0.4, 0.07, 0.14);
  }
  if (o.hood === 'flat') {
    fBox(g, face, plane, su, along, y0 + h + 0.28, 0.04, w + 0.8, 0.14, 0.5);
    for (const sd of [-1, 1]) fBox(g, face, plane, su, along + sd * (w / 2 + 0.3), y0 + h * 0.86, 0.05, 0.12, 0.3, 0.35);
  } else if (o.hood === 'gable') {
    fBox(g, face, plane, su, along, y0 + h + 0.26, 0.04, w + 0.9, 0.16, 0.55);
    const s2 = face[0] === '+' ? 1 : -1;
    const hp = plane + s2 * 0.55;
    const grp = new THREE.Group();
    grp.position.set(face === '+z' || face === '-z' ? along : hp, y0 + h + 0.42, face === '+z' || face === '-z' ? hp : along);
    grp.rotation.y = face === '+z' ? 0 : face === '-z' ? Math.PI : face === '+x' ? Math.PI / 2 : -Math.PI / 2;
    g.add(grp);
    const wdt = w + 0.9;
    const rise = 0.34;
    const sh = new THREE.Shape();
    sh.moveTo(-wdt / 2, 0); sh.lineTo(wdt / 2, 0); sh.lineTo(0, rise); sh.closePath();
    const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.2, bevelEnabled: false });
    geo.translate(0, 0, -0.1);
    const pr = put(grp, geo, 'roofInk', 0, 0, 0);
    pr.position.z += 0.06;
    box(grp, wdt + 0.1, 0.1, 0.3, su, 0, -0.1, 0.02);
  }
}

/** Porch light: iron bracket with a glowing lantern. */
function porchLight(g: THREE.Object3D, face: Face, plane: number, along: number, y: number): void {
  fBox(g, face, plane, 'ink', along, y + 0.12, 0.02, 0.1, 0.34, 0.1);
  fBox(g, face, plane, 'ink', along, y + 0.26, 0.06, 0.24, 0.08, 0.2);
  fBox(g, face, plane, 'glow', along, y + 0.02, 0.08, 0.17, 0.22, 0.17);
}

/** Solid concrete stoop: treads stepping away from z0 (dir +1 = toward the street). */
function stoop(
  g: THREE.Object3D, x: number, z0: number, w: number, yTop: number, n = 2,
  mat: Mat = 'concrete', dir = 1,
): void {
  const rise = (yTop - GROUND) / n;
  for (let k = 0; k < n; k++) {
    const top = yTop - rise * k;
    box(g, w, top - GROUND, 0.34, mat, x, GROUND, z0 + dir * 0.34 * (k + 0.5));
  }
}

/** Panelled overhead garage door with a lit top row. */
function garageDoor(
  g: THREE.Object3D, face: Face, plane: number, along: number, y0: number, w: number, h: number,
  leaf: Mat = 'wallWhite',
): void {
  fBox(g, face, plane, 'ink', along, y0 - 0.02, 0.01, w + 0.26, h + 0.24, 0.1);
  fBox(g, face, plane, leaf, along, y0, 0.06, w, h, 0.09);
  for (const t of [0.33, 0.66]) fBox(g, face, plane, 'ink', along, y0 + h * t, 0.155, w - 0.12, 0.06, 0.03);
  for (const sd of [-1, 1]) fBox(g, face, plane, 'ink', along + sd * (w / 2 - 0.05), y0, 0.155, 0.06, h, 0.03);
  // four lit panes in the top panel
  for (let i = 0; i < 4; i++) {
    const u = along - w * 0.33 + i * w * 0.22;
    fBox(g, face, plane, 'glow', u, y0 + h * 0.76, 0.14, w * 0.16, h * 0.13, 0.04);
  }
  fBox(g, face, plane, 'ink', along, y0 + h * 0.74, 0.185, w * 0.8, 0.035, 0.02);
  fBox(g, face, plane, 'steel', along, y0 + 0.28, 0.16, 0.22, 0.07, 0.06); // handle
  fBox(g, face, plane, 'concrete', along, y0 - 0.14, 0.08, w + 0.7, 0.14, 0.5); // apron
}

/** Brick chimney with a corbel band, cap and two flue tiles. */
function chimney(g: THREE.Object3D, x: number, y: number, z: number, h: number, brick: Mat = 'wallCoral'): void {
  box(g, 0.92, 0.22, 0.92, 'concrete', x, y, z);
  box(g, 0.66, h, 0.66, brick, x, y + 0.22, z);
  box(g, 0.82, 0.12, 0.82, 'ink', x, y + 0.22 + h, z);
  box(g, 0.72, 0.14, 0.72, 'concrete', x, y + 0.34 + h, z);
  for (const s of [-0.16, 0.16]) box(g, 0.16, 0.18, 0.16, 'ink', x + s, y + 0.48 + h, z);
}

/** Eave gutter run along X or Z at height y. */
function gutter(g: THREE.Object3D, x0: number, z0: number, x1: number, z1: number, y: number): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const L = Math.abs(alongX ? x1 - x0 : z1 - z0);
  box(g, alongX ? L : 0.16, 0.14, alongX ? 0.16 : L, 'steel', (x0 + x1) / 2, y - 0.07, (z0 + z1) / 2);
}

/** Downspout from the gutter to the ground with two shoes. */
function downspout(g: THREE.Object3D, x: number, z: number, yTop: number): void {
  cyl(g, 0.06, 0.06, yTop - GROUND - 0.18, 'steel', x, GROUND + 0.18, z, 6);
  box(g, 0.13, 0.18, 0.13, 'steel', x, GROUND, z);
  rod(g, { x, y: yTop - 0.18, z }, { x, y: yTop, z: z + (z > 0 ? -0.14 : 0.14) }, 0.055, 'steel', 6);
}

/** Utility meter and riser on a wall. */
function meterBox(g: THREE.Object3D, face: Face, plane: number, along: number, y: number): void {
  fBox(g, face, plane, 'steel', along, y, 0.06, 0.34, 0.44, 0.16);
  fBox(g, face, plane, 'ink', along, y + 0.1, 0.23, 0.2, 0.22, 0.03);
  fBox(g, face, plane, 'steel', along, y + 0.44, 0.06, 0.06, 1.3, 0.06);
}

/** Service mast: pole, cross-arm, three-disc insulator. Returns the port. */
function mast(g: THREE.Object3D, x: number, y0: number, z: number, y1: number): THREE.Vector3 {
  cyl(g, 0.07, 0.09, y1 - y0, 'steel', x, y0, z, 8);
  box(g, 1.15, 0.1, 0.1, 'steelDark', x, y1 - 0.12, z);
  box(g, 0.26, 0.18, 0.26, 'ink', x, y0, z);
  return insulator(g, x, y1, z, 3);
}

// --------------------------------------------------------------- site kit

function lotSlab(g: THREE.Object3D): void {
  box(g, LOT_H * 2, GROUND, LOT_H * 2, 'paving', 0, 0, 0);
}

/** Public sidewalk strip along the street edge. */
function sidewalk(g: THREE.Object3D): void {
  box(g, LOT_H * 2, 0.07, 0.42, 'concrete', 0, GROUND, 4.98);
  for (const x of [-2.6, 0.1, 2.8]) box(g, 0.05, 0.012, 0.42, 'ink', x, GROUND + 0.07, 4.98);
}

function lawn(g: THREE.Object3D, x0: number, z0: number, x1: number, z1: number, mat: Mat = 'grass'): void {
  box(g, x1 - x0, 0.02, z1 - z0, mat, (x0 + x1) / 2, GROUND, (z0 + z1) / 2);
}

/** Concrete front walk from the stoop to the street edge. */
function path(g: THREE.Object3D, x: number, z0: number, z1: number, w = 1.2): void {
  box(g, w, 0.06, z1 - z0, 'concrete', x, GROUND, (z0 + z1) / 2);
  for (let z = z0 + 1.1; z < z1 - 0.3; z += 1.1) box(g, w, 0.012, 0.04, 'ink', x, GROUND + 0.06, z);
}

/** Asphalt drive, with a concrete apron at its street end. */
function drive(g: THREE.Object3D, x0: number, x1: number, z0: number, z1: number): void {
  box(g, x1 - x0, 0.05, z1 - z0, 'asphalt', (x0 + x1) / 2, GROUND, (z0 + z1) / 2);
  box(g, x1 - x0, 0.012, 0.05, 'concrete', (x0 + x1) / 2, GROUND + 0.05, z0 + 0.12);
}

/** Round deciduous tree: trunk, two green tones, a shrub at the foot. */
function tree(g: THREE.Object3D, x: number, z: number, s = 1): void {
  cyl(g, 0.2 * s, 0.31 * s, 2.5 * s, 'wood', x, GROUND, z, 8);
  sphere(g, 1.5 * s, 'green', x, GROUND + 3.15 * s, z, 12);
  sphere(g, 1.1 * s, 'roofGreen', x + 0.8 * s, GROUND + 2.7 * s, z + 0.3 * s, 10);
  sphere(g, 0.95 * s, 'green', x - 0.7 * s, GROUND + 2.85 * s, z - 0.5 * s, 10);
  sphere(g, 0.45 * s, 'roofGreen', x + 0.5 * s, GROUND + 0.45 * s, z - 0.3 * s, 8);
}

function bush(g: THREE.Object3D, x: number, z: number, s = 1, mat: Mat = 'green'): void {
  sphere(g, 0.52 * s, mat, x, GROUND + 0.38 * s, z, 9);
  sphere(g, 0.4 * s, 'roofGreen', x + 0.42 * s, GROUND + 0.3 * s, z + 0.18 * s, 8);
}

/** Clipped hedge along an axis-aligned run with rounded bumps on top. */
function hedge(
  g: THREE.Object3D, x0: number, z0: number, x1: number, z1: number, thick = 0.7, h = 0.9,
): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const L = Math.abs(alongX ? x1 - x0 : z1 - z0);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  box(g, alongX ? L : thick, h, alongX ? thick : L, 'green', cx, GROUND, cz);
  const n = Math.max(1, Math.round(L / 1.5));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n - 0.5;
    sphere(g, thick * 0.62, 'green', alongX ? cx + t * L : cx, GROUND + h, alongX ? cz : cz + t * L, 10);
  }
}

/** White picket fence: pickets, two rails, posts with caps. */
function picketFence(g: THREE.Object3D, x0: number, z0: number, x1: number, z1: number): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const L = Math.abs(alongX ? x1 - x0 : z1 - z0);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const n = Math.max(2, Math.round(L / 0.34));
  for (let i = 0; i <= n; i++) {
    const t = i / n - 0.5;
    box(g, 0.09, 0.86, 0.09, 'wallWhite', alongX ? cx + t * L : cx, GROUND, alongX ? cz : cz + t * L);
  }
  for (const y of [GROUND + 0.28, GROUND + 0.66]) {
    box(g, alongX ? L : 0.06, 0.09, alongX ? 0.06 : L, 'wallWhite', cx, y, cz);
  }
  for (const t of [-0.5, 0.5]) {
    box(g, 0.15, 1.05, 0.15, 'wallWhite', alongX ? cx + t * L : cx, GROUND, alongX ? cz : cz + t * L);
    box(g, 0.21, 0.08, 0.21, 'ink', alongX ? cx + t * L : cx, GROUND + 1.05, alongX ? cz : cz + t * L);
  }
}

/** Mailbox on a post with a red flag and a white number patch. */
function mailbox(g: THREE.Object3D, x: number, z: number): void {
  cyl(g, 0.06, 0.07, 1.02, 'wood', x, GROUND, z, 6);
  box(g, 0.36, 0.24, 0.52, 'red', x, GROUND + 1.02, z);
  box(g, 0.38, 0.06, 0.54, 'ink', x, GROUND + 1.26, z);
  box(g, 0.04, 0.22, 0.04, 'yellow', x + 0.2, GROUND + 1.12, z - 0.17);
  box(g, 0.12, 0.1, 0.02, 'wallWhite', x, GROUND + 1.08, z + 0.265);
}

/** 7-segment house number on a small plate. */
const SEG: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg',
  '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};

function numberPlate(
  g: THREE.Object3D, face: Face, plane: number, along: number, y: number, text: string,
): void {
  const w = text.length * 0.15 + 0.1;
  fBox(g, face, plane, 'ink', along, y - 0.03, 0.02, w + 0.06, 0.26, 0.05);
  fBox(g, face, plane, 'wallWhite', along, y, 0.04, w, 0.2, 0.05);
  const ch = 0.13;
  const cw = 0.08;
  const t = 0.024;
  for (let i = 0; i < text.length; i++) {
    const segs = SEG[text[i]] ?? '';
    const x0 = along - (text.length * 0.15) / 2 + i * 0.15 + 0.035;
    const segsPos: Record<string, [number, number, number, number]> = {
      a: [0, ch, cw, 1], b: [cw, ch * 0.5, ch * 0.5, 0], c: [cw, 0, ch * 0.5, 0],
      d: [0, 0, cw, 1], e: [0, 0, ch * 0.5, 0], f: [0, ch * 0.5, ch * 0.5, 0],
      g: [0, ch * 0.5, cw, 1],
    };
    for (const key of segs) {
      const [sx, sy, sw, horiz] = segsPos[key];
      if (horiz) fBox(g, face, plane, 'ink', x0 + sx + sw / 2, y + 0.035 + sy - t / 2, 0.09, sw, t, 0.02);
      else fBox(g, face, plane, 'ink', x0 + sx - t / 2, y + 0.035 + sy, 0.09, t, ch * 0.5 - t, 0.02);
    }
  }
}

/** Outdoor AC condenser on a pad. */
function acUnit(g: THREE.Object3D, x: number, z: number): void {
  box(g, 0.94, 0.1, 0.7, 'concrete', x, GROUND, z);
  box(g, 0.8, 0.62, 0.56, 'steel', x, GROUND + 0.1, z);
  box(g, 0.84, 0.06, 0.6, 'steelDark', x, GROUND + 0.72, z);
  const fan = cyl(g, 0.22, 0.22, 0.03, 'ink', 0, 0, 0, 12);
  fan.rotation.x = Math.PI / 2;
  fan.position.set(x - 0.25, GROUND + 0.43, z + 0.29);
  box(g, 0.06, 0.5, 0.06, 'ink', x + 0.34, GROUND + 0.12, z + 0.3);
}

/** Wheelie bin. */
function bin(g: THREE.Object3D, x: number, z: number, mat: Mat = 'steelDark'): void {
  box(g, 0.56, 0.9, 0.5, mat, x, GROUND, z);
  box(g, 0.62, 0.08, 0.56, 'ink', x, GROUND + 0.9, z);
  box(g, 0.08, 0.08, 0.08, 'ink', x - 0.2, GROUND + 0.02, z + 0.28);
  box(g, 0.08, 0.08, 0.08, 'ink', x + 0.2, GROUND + 0.02, z + 0.28);
}

/** Tidy parked sedan; local front is +X. rotY = PI/2 parks it nose toward -Z. */
function car(g: THREE.Object3D, x: number, z: number, body: Mat, rotY = Math.PI / 2): void {
  const c = new THREE.Group();
  c.position.set(x, GROUND, z);
  c.rotation.y = rotY;
  g.add(c);
  box(c, 3.66, 0.52, 1.62, body, 0, 0.24, 0);
  box(c, 3.5, 0.2, 1.58, body, 0, 0.76, 0);
  box(c, 1.72, 0.5, 1.44, 'glass', -0.22, 0.9, 0);
  box(c, 1.56, 0.09, 1.48, body, -0.22, 1.4, 0);
  box(c, 0.9, 0.1, 1.4, body, -1.15, 0.8, 0);
  box(c, 0.8, 0.1, 1.4, body, 1.25, 0.8, 0);
  box(c, 0.14, 0.16, 1.68, 'ink', 1.86, 0.3, 0);
  box(c, 0.14, 0.16, 1.68, 'ink', -1.86, 0.3, 0);
  for (const s of [-0.52, 0.52]) {
    box(c, 0.06, 0.13, 0.28, 'glow', 1.82, 0.55, s);
    box(c, 0.06, 0.13, 0.26, 'red', -1.82, 0.55, s);
  }
  for (const xx of [-1.2, 1.2]) {
    for (const zz of [-0.76, 0.76]) {
      const w = cyl(c, 0.31, 0.31, 0.22, 'ink', 0, 0, 0, 10);
      w.rotation.x = Math.PI / 2;
      w.position.set(xx, 0.31, zz);
      const hub = cyl(c, 0.13, 0.13, 0.24, 'steel', 0, 0, 0, 8);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(xx, 0.31, zz);
    }
  }
  box(c, 0.1, 0.08, 0.18, 'ink', 0.62, 1.02, 0.8); // mirrors
  box(c, 0.1, 0.08, 0.18, 'ink', 0.62, 1.02, -0.8);
}

/** Basketball hoop: pole, arm, backboard, rim and net. Faces -X. */
function basketHoop(g: THREE.Object3D, x: number, z: number): void {
  box(g, 0.5, 0.16, 0.5, 'concrete', x, GROUND, z);
  cyl(g, 0.09, 0.12, 3.15, 'steel', x, GROUND + 0.16, z, 8);
  box(g, 0.9, 0.1, 0.1, 'steel', x - 0.5, GROUND + 3.0, z);
  box(g, 0.08, 0.82, 1.3, 'wallWhite', x - 0.95, GROUND + 2.6, z);
  box(g, 0.1, 0.36, 0.5, 'ink', x - 1.0, GROUND + 2.82, z);
  const rim = put(g, new THREE.TorusGeometry(0.22, 0.025, 6, 14), 'orange', x - 1.22, GROUND + 3.0, z, Math.PI / 2, 0, 0);
  rim.rotation.z = Math.PI / 2;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    rod(g, { x: x - 1.22 + Math.cos(a) * 0.19, y: GROUND + 2.98, z: z + Math.sin(a) * 0.19 },
      { x: x - 1.22 + Math.cos(a) * 0.1, y: GROUND + 2.62, z: z + Math.sin(a) * 0.1 }, 0.014, 'wallWhite', 4);
  }
}

/** Clothesline between two T-posts, three lines and a few hanging pieces. */
function clothesline(g: THREE.Object3D, x0: number, x1: number, z: number): void {
  for (const x of [x0, x1]) {
    cyl(g, 0.06, 0.08, 2.05, 'steel', x, GROUND, z, 6);
    box(g, 1.1, 0.08, 0.08, 'steel', x, GROUND + 1.95, z);
  }
  for (const dz of [-0.34, 0, 0.34]) {
    rod(g, { x: x0, y: GROUND + 1.9, z: z + dz }, { x: x1, y: GROUND + 1.9, z: z + dz }, 0.018, 'steelDark', 4);
  }
  for (const [x, dz, mat] of [[x0 + 0.9, -0.34, 'wallWhite'], [x1 - 0.8, 0.34, 'blue'], [x0 + 1.6, 0, 'yellow']] as const) {
    box(g, 0.5, 0.02, 0.42, mat, x, GROUND + 1.55, z + dz);
  }
}

/** Satellite dish on a foot, tilted toward the sky. */
function satellite(g: THREE.Object3D, x: number, y: number, z: number): void {
  box(g, 0.3, 0.08, 0.3, 'steelDark', x, y, z);
  const pole = cyl(g, 0.05, 0.05, 1.0, 'steel', x, y + 0.08, z, 6);
  pole.rotation.z = 0.18;
  const dish = cyl(g, 0.44, 0.44, 0.05, 'wallWhite', 0, 0, 0, 14);
  dish.rotation.set(0.7, 0, 0.2);
  dish.position.set(x + 0.06, y + 1.02, z - 0.08);
  rod(g, { x: x + 0.06, y: y + 1.02, z: z - 0.08 }, { x: x - 0.2, y: y + 1.32, z: z - 0.34 }, 0.022, 'steelDark', 4);
  sphere(g, 0.06, 'ink', x - 0.2, y + 1.32, z - 0.34, 6);
}

// ================================================================ v0: Craftsman bungalow

function bungalow(g: THREE.Group, rnd: () => number): THREE.Vector3 {
  const wall = pickFrom<Mat>(rnd, ['wallCream', 'wallCream', 'wallSand', 'wallYellow']);
  const accent = wall === 'wallCream' ? 'wallSand' : 'wallCream';
  const roof = pickFrom<Mat>(rnd, ['roofInk', 'roofGreen', 'roofCoral']);
  const leaf = pickFrom<Mat>(rnd, ['wood', 'blue', 'green', 'red']);

  /* ---- lot ---- */
  lotSlab(g);
  sidewalk(g);
  // lawns: left strip, front beds, rear yard, strip beside the garage
  lawn(g, -5.15, -5.1, -4.42, 4.75);
  lawn(g, -2.72, 3.9, 1.3, 4.75);
  lawn(g, -5.15, -5.1, 5.15, -3.45);
  lawn(g, 4.3, 2.4, 5.15, 4.75);
  lawn(g, 4.42, -3.4, 5.15, 2.4);
  path(g, -3.45, 3.85, 5.2, 1.3);
  drive(g, 1.35, 4.25, 2.35, 5.2);

  /* ---- body: 5.5 x 4.6, side-gable roof reaching out over the porch ---- */
  box(g, 5.72, FL - GROUND, 4.82, 'concrete', -1.5, GROUND, -1.05);
  box(g, 5.5, STOREY, 4.6, wall, -1.5, FL, -1.05);
  box(g, 5.56, 0.34, 4.66, accent, -1.5, FL, -1.05); // siding band
  for (const y of [FL + 0.34, FL + 1.9]) {
    box(g, 5.54, 0.07, 0.06, 'ink', -1.5, y, 1.24);
    box(g, 5.54, 0.07, 0.06, 'ink', -1.5, y, -3.34);
  }
  // corner boards
  for (const [x, z] of [[-4.23, 1.23], [1.23, 1.23], [-4.23, -3.33], [1.23, -3.33]] as const) {
    box(g, 0.2, STOREY, 0.2, 'wallWhite', x, FL, z);
  }
  gableRoof(g, 5.5, 6.4, 2.0, roof, -1.5, T1, -0.4, 0.5);
  gableEnd(g, { face: '-x', x: -4.765, y: T1, z: -0.4, w: 7.4, rise: 2.0, mat: wall, vent: true });
  gableEnd(g, { face: '+x', x: 1.765, y: T1, z: -0.4, w: 7.4, rise: 2.0, mat: wall, vent: true });
  // fascia + eave gutter, 7 exposed rafter tails
  box(g, 5.9, 0.18, 0.14, 'wallWhite', -1.5, 3.54, 3.26);
  gutter(g, -4.7, 3.28, 1.7, 3.28, 3.6);
  downspout(g, -4.55, 3.24, 3.56);
  for (let i = 0; i < 7; i++) {
    const x = -4.2 + i * 0.9;
    box(g, 0.13, 0.13, 0.34, 'wood', x, 3.45, 3.16);
  }
  // rear gutter and two downspouts
  gutter(g, -4.6, -3.46, 1.6, -3.46, 3.56);
  downspout(g, -4.3, -3.48, 3.52);
  downspout(g, 1.15, -3.48, 3.52);

  /* ---- deep porch ---- */
  box(g, 5.75, 0.3, 1.9, 'wood', -1.525, GROUND, 2.2);
  box(g, 5.75, 0.24, 0.1, 'wood', -1.525, GROUND, 3.16);
  box(g, 0.1, 0.24, 1.9, 'wood', -4.38, GROUND, 2.2);
  box(g, 0.1, 0.24, 1.9, 'wood', 1.33, GROUND, 2.2);
  // ceiling over the porch + beam across the columns
  box(g, 5.55, 0.06, 1.75, 'wood', -1.5, 3.5, 2.24);
  box(g, 5.7, 0.18, 0.22, 'wallWhite', -1.5, 3.44, 3.0);
  for (const x of [-4.2, -1.15, 1.15]) {
    box(g, 0.42, 0.5, 0.42, 'concrete', x, FL, 3.0);
    box(g, 0.3, 0.1, 0.3, 'wood', x, 0.92, 3.0);
    cyl(g, 0.12, 0.18, 2.46, 'wood', x, 1.02, 3.0, 8);
    box(g, 0.32, 0.16, 0.32, 'wood', x, 3.3, 3.0);
  }
  railing(g, { x: -2.6, y: 0.42, z: 3.0 }, { x: 1.2, y: 0.42, z: 3.0 }, 0.82, 'ink');
  // wide steps at the left end
  stoop(g, -3.45, 3.15, 1.5, FL, 2, 'concrete');
  for (const s of [-1, 1]) box(g, 0.12, 0.55, 0.5, 'wood', -3.45 + s * 1.56, 0.42, 3.15);

  /* ---- front wall ---- */
  doorway(g, { face: '+z', plane: 1.25, along: -3.05, y0: FL, w: 0.98, h: 2.05, leaf });
  win(g, { face: '+z', plane: 1.25, along: -1.55, y: FL + 1.0, w: 1.0, h: 1.35, muntins: true });
  porchLight(g, '+z', 1.25, -3.85, 2.15);
  numberPlate(g, '+z', 1.25, -2.35, 1.95, '24');

  // bay window sitting on the porch deck
  box(g, 1.5, 2.15, 0.65, accent, 0.25, FL, 1.575);
  for (const x of [-0.5, 1.0]) box(g, 0.16, 2.15, 0.16, 'wallWhite', x, FL, 1.86);
  win(g, { face: '+z', plane: 1.9, along: 0.25, y: FL + 0.55, w: 0.95, h: 1.28, muntins: true });
  win(g, { face: '+x', plane: 1.0, along: 1.58, y: FL + 0.58, w: 0.34, h: 1.2, frame: 'wallWhite', sill: false });
  win(g, { face: '-x', plane: -0.5, along: 1.58, y: FL + 0.58, w: 0.34, h: 1.2, frame: 'wallWhite', sill: false });
  box(g, 1.94, 0.12, 0.9, 'wallWhite', 0.25, 2.56, 1.62);
  box(g, 1.94, 0.1, 0.08, 'ink', 0.25, 2.56, 2.02);
  for (const s of [-1, 1]) box(g, 0.09, 0.28, 0.3, 'wood', 0.25 + s * 0.8, 2.3, 1.55);

  /* ---- side + rear ---- */
  win(g, { face: '-x', plane: -4.25, along: -1.7, y: FL + 1.05, w: 1.1, h: 1.25, muntins: true });
  win(g, { face: '-x', plane: -4.25, along: 0.3, y: FL + 1.05, w: 1.1, h: 1.25, muntins: true });
  doorway(g, { face: '-z', plane: -3.35, along: -2.3, y0: FL, w: 0.9, h: 2.0, leaf, hood: 'flat' });
  stoop(g, -2.3, -3.35, 1.3, FL, 2, 'concrete', -1);
  win(g, { face: '-z', plane: -3.35, along: -0.55, y: FL + 1.05, w: 1.0, h: 1.2 });
  win(g, { face: '-z', plane: -3.35, along: 0.75, y: FL + 1.05, w: 0.7, h: 1.2 });

  /* ---- shed dormer on the front slope ---- */
  box(g, 1.9, 0.95, 1.35, wall, -1.7, 4.55, 0.72);
  put(g, new THREE.BoxGeometry(2.2, 0.14, 1.6), roof, -1.7, 5.56, 0.74, 0.2, 0, 0);
  box(g, 2.24, 0.12, 0.1, 'wallWhite', -1.7, 5.4, 1.43);
  win(g, { face: '+z', plane: 1.37, along: -1.7, y: 4.68, w: 1.35, h: 0.66, muntins: true, sill: false });
  for (const s of [-1, 1]) box(g, 0.13, 0.95, 0.13, 'wallWhite', -1.7 + s * 0.97, 4.6, 1.39);

  /* ---- chimney + roof plant ---- */
  chimney(g, 0.6, 4.2, -2.5, 2.2);
  box(g, 0.3, 0.34, 0.3, 'steel', -2.9, 5.0, 0.1); // roof vent
  box(g, 0.38, 0.06, 0.38, 'ink', -2.9, 5.34, 0.1);

  /* ---- attached garage, front gable ---- */
  box(g, 3.34, FL - GROUND, 4.84, 'concrete', 2.8, GROUND, -0.1);
  box(g, 3.1, 2.58, 4.6, accent, 2.8, FL, -0.1);
  box(g, 3.16, 0.34, 4.66, wall, 2.8, FL, -0.1);
  for (const [x, z] of [[1.27, 2.18], [4.33, 2.18], [1.27, -2.38], [4.33, -2.38]] as const) {
    box(g, 0.18, 2.58, 0.18, 'wallWhite', x, FL, z);
  }
  const gr = gableRoof(g, 4.6, 2.7, 0.85, roof, 2.85, 3.0, -0.1, 0.3);
  gr.rotation.y = Math.PI / 2;
  gableEnd(g, { face: '+z', x: 2.85, y: 3.0, z: 2.515, w: 3.3, rise: 0.85, mat: accent, vent: true });
  garageDoor(g, '+z', 2.22, 2.8, FL + 0.02, 2.5, 2.2, 'wallWhite');
  gutter(g, 1.2, 2.44, 4.5, 2.44, 3.02);
  downspout(g, 4.42, 2.36, 2.98);
  // garage side: meter, utility door
  meterBox(g, '+x', 4.35, 0.4, 1.5);
  doorway(g, { face: '+x', plane: 4.35, along: 1.05, y0: FL, w: 0.8, h: 1.9, leaf: 'wallWhite' });

  /* ---- site props ---- */
  acUnit(g, 0.55, -3.9);
  box(g, 3.4, 0.06, 1.7, 'concrete', -1.9, GROUND, -4.35);
  bin(g, 3.5, -3.2, 'steelDark');
  bin(g, 4.1, -3.2, 'blue');
  picketFence(g, -5.05, 4.6, -5.05, 0.1);
  hedge(g, -4.5, -5.0, 5.0, -5.0, 0.65, 0.85);
  mailbox(g, -2.45, 4.72);
  tree(g, -4.35, 4.35, 0.55);
  bush(g, -4.7, 3.45, 0.9);
  bush(g, -2.2, 3.55, 0.75);
  bush(g, 0.8, 3.55, 0.7);
  clothesline(g, -4.2, -2.2, -4.6);

  /* ---- power port on the rear roof ---- */
  return mast(g, -3.35, 4.05, -2.9, 6.95);
}

// ================================================================ v1: Colonial two-storey

/** Small gabled dormer with a window, sitting on a roof slope. Faces +Z. */
function dormer(
  g: THREE.Object3D,
  o: { x: number; zFront: number; yBase: number; w: number; h: number; d: number; rise: number; wall: Mat; roof: Mat },
): void {
  const zc = o.zFront - o.d / 2;
  box(g, o.w, o.h, o.d, o.wall, o.x, o.yBase, zc);
  const r = gableRoof(g, o.d, o.w, o.rise, o.roof, o.x, o.yBase + o.h, zc, 0.22);
  r.rotation.y = Math.PI / 2;
  gableEnd(g, { face: '+z', x: o.x, y: o.yBase + o.h, z: o.zFront + 0.235, w: o.w + 0.44, rise: o.rise, mat: o.wall });
  win(g, { face: '+z', plane: o.zFront, along: o.x, y: o.yBase + 0.2, w: o.w - 0.5, h: o.h - 0.58, muntins: true, sill: false });
  for (const s of [-1, 1]) box(g, 0.13, o.h, 0.13, 'wallWhite', o.x + s * (o.w / 2 - 0.06), o.yBase, o.zFront - 0.02);
}

function colonial(g: THREE.Group, rnd: () => number): THREE.Vector3 {
  const wall = pickFrom<Mat>(rnd, ['wallWhite', 'wallWhite', 'wallCream', 'wallSand']);
  const roof = pickFrom<Mat>(rnd, ['roofBlue', 'roofInk', 'roofCoral']);
  const leaf = pickFrom<Mat>(rnd, ['red', 'wood', 'ink', 'blue']);
  const X0 = -4.9;
  const X1 = 0.4;
  const ZF = 1.6;
  const ZB = -3.2;
  const CX = (X0 + X1) / 2; // -2.25
  const CZ = (ZF + ZB) / 2; // -0.8
  const W = X1 - X0; // 5.3
  const D = ZF - ZB; // 4.8

  /* ---- lot ---- */
  lotSlab(g);
  sidewalk(g);
  lawn(g, -5.15, 3.75, -3.15, 4.75);
  lawn(g, -1.35, 3.0, 0.85, 4.75);
  lawn(g, -5.15, -5.1, 5.1, -3.3);
  lawn(g, 4.85, -5.1, 5.15, -3.3);
  path(g, -2.25, 3.83, 5.2, 1.65);
  drive(g, 0.9, 4.72, 1.28, 5.2);

  /* ---- body ---- */
  box(g, W + 0.22, FL - GROUND, D + 0.22, 'wallCoral', CX, GROUND, CZ); // brick plinth
  box(g, W + 0.3, 0.08, D + 0.3, 'concrete', CX, FL - 0.08, CZ);
  box(g, W, 2 * STOREY, D, wall, CX, FL, CZ);
  // corner boards + frieze + first-floor string course
  for (const [x, z] of [[X0 + 0.02, ZF - 0.02], [X1 - 0.02, ZF - 0.02], [X0 + 0.02, ZB + 0.02], [X1 - 0.02, ZB + 0.02]] as const) {
    box(g, 0.2, 2 * STOREY, 0.2, 'wallWhite', x, FL, z);
  }
  for (const z of [ZF, ZB]) box(g, W + 0.16, 0.22, 0.16, 'wallWhite', CX, TOP - 0.22, z);
  for (const x of [X0, X1]) box(g, 0.16, 0.22, D + 0.16, 'wallWhite', x, TOP - 0.22, CZ);
  for (const z of [ZF, ZB]) box(g, W + 0.1, 0.14, 0.1, 'wallWhite', CX, FL + STOREY - 0.07, z);
  for (const x of [X0, X1]) box(g, 0.1, 0.14, D + 0.1, 'wallWhite', x, FL + STOREY - 0.07, CZ);
  gableRoof(g, W, D, 2.0, roof, CX, TOP, CZ, 0.45);
  gableEnd(g, { face: '-x', x: X0 - 0.43, y: TOP, z: CZ, w: D + 0.9, rise: 2.0, mat: wall, vent: true });
  gableEnd(g, { face: '+x', x: X1 + 0.43, y: TOP, z: CZ, w: D + 0.9, rise: 2.0, mat: wall });
  gutter(g, X0 - 0.4, ZF + 0.4, X1 + 0.3, ZF + 0.4, TOP + 0.02);
  gutter(g, X0 - 0.4, ZB - 0.4, X1 + 0.3, ZB - 0.4, TOP + 0.02);
  for (const x of [X0 - 0.3, X1 + 0.25]) downspout(g, x, ZF + 0.32, TOP - 0.06);

  /* ---- portico ---- */
  box(g, 2.9, FL - GROUND, 1.75, 'concrete', CX, GROUND, 2.42);
  box(g, 2.9, 0.12, 1.75, 'wallWhite', CX, 0.42, 2.42);
  stoop(g, CX, 3.3, 2.5, FL, 2);
  for (const x of [CX - 1.16, CX + 1.16]) {
    box(g, 0.36, 0.16, 0.36, 'wallWhite', x, FL, 2.96);
    box(g, 0.26, 2.3, 0.26, 'wallWhite', x, FL + 0.16, 2.96);
    box(g, 0.38, 0.16, 0.38, 'wallWhite', x, FL + 2.46, 2.96);
  }
  box(g, 2.9, 0.3, 0.28, 'wallWhite', CX, 3.18, 2.96);
  for (const s of [-1, 1]) box(g, 0.16, 0.3, 1.5, 'wallWhite', CX + s * 1.4, 3.18, 2.3);
  const ped = gableRoof(g, 2.1, 2.9, 0.7, roof, CX, 3.48, 2.35, 0.24);
  ped.rotation.y = Math.PI / 2;
  gableEnd(g, { face: '+z', x: CX, y: 3.48, z: 3.66, w: 3.38, rise: 0.7, mat: 'wallWhite' });
  box(g, 2.94, 0.1, 0.14, 'ink', CX, 3.46, 3.6);
  // door, fanlight, sidelights
  doorway(g, { face: '+z', plane: ZF, along: CX, y0: FL, w: 1.05, h: 2.15, leaf, sidelights: true, transom: true });
  porchLight(g, '+z', ZF, CX - 1.02, 2.45);
  numberPlate(g, '+z', ZF, CX + 1.0, 2.35, '112');
  // ground + first floor windows, shutters on all of them
  for (const x of [-4.0, -0.5]) win(g, { face: '+z', plane: ZF, along: x, y: FL + 0.85, w: 1.1, h: 1.6, shutters: 'ink', muntins: true });
  for (const x of [-4.0, CX, -0.5]) win(g, { face: '+z', plane: ZF, along: x, y: T1 + 0.85, w: 1.1, h: 1.55, shutters: 'ink', muntins: true });

  /* ---- sides and rear ---- */
  for (const y of [FL + 0.85, T1 + 0.85]) {
    win(g, { face: '-x', plane: X0, along: -2.35, y, w: 1.05, h: 1.5, shutters: 'ink' });
    win(g, { face: '-x', plane: X0, along: 0.25, y, w: 1.05, h: 1.5, shutters: 'ink' });
  }
  win(g, { face: '+x', plane: X1, along: -2.2, y: T1 + 0.85, w: 1.0, h: 1.45 });
  doorway(g, { face: '-z', plane: ZB, along: -4.0, y0: FL, w: 0.95, h: 2.1, leaf, hood: 'flat' });
  stoop(g, -4.0, ZB, 1.4, FL, 2, 'concrete', -1);
  for (const x of [-2.4, -1.15, 0.1]) win(g, { face: '-z', plane: ZB, along: x, y: FL + 0.85, w: 0.95, h: 1.5 });
  for (const x of [-3.6, -2.4, -1.15, 0.1]) win(g, { face: '-z', plane: ZB, along: x, y: T1 + 0.85, w: 0.95, h: 1.45 });

  /* ---- two dormers and a chimney ---- */
  for (const x of [-3.85, -0.65]) {
    dormer(g, { x, zFront: 1.12, yBase: 7.38, w: 1.18, h: 1.05, d: 1.05, rise: 0.42, wall, roof });
  }
  chimney(g, -4.35, 7.25, -2.45, 1.75);

  /* ---- two-car garage wing ---- */
  box(g, 4.56, FL - GROUND, 3.86, 'wallCoral', 2.62, GROUND, -0.7);
  box(g, 4.44, 2.58, 3.74, wall, 2.62, FL, -0.7);
  box(g, 4.5, 0.1, 3.8, 'concrete', 2.62, FL - 0.1, -0.7);
  for (const [x, z] of [[0.48, 1.12], [4.78, 1.12], [0.48, -2.54], [4.78, -2.54]] as const) {
    box(g, 0.18, 2.58, 0.18, 'wallWhite', x, FL, z);
  }
  const grr = gableRoof(g, 4.2, 3.6, 0.88, roof, 2.72, 3.0, -0.7, 0.2);
  box(g, 4.4, 0.18, 0.14, 'wallWhite', 2.62, 2.92, 1.16);
  garageDoor(g, '+z', 1.18, 2.62, FL + 0.02, 3.5, 2.25, 'wallWhite');
  meterBox(g, '+x', 4.84, 0.5, 1.6);
  gableEnd(g, { face: '+x', x: 5.03, y: 3.0, z: -0.7, w: 4.0, rise: 0.88, mat: wall });

  /* ---- site props ---- */
  hedge(g, -5.1, 4.9, -3.3, 4.9, 0.6, 0.85);
  hedge(g, -5.1, 1.0, -5.1, 4.6, 0.55, 0.8);
  mailbox(g, -1.15, 4.66);
  tree(g, -4.35, 4.15, 0.68);
  bush(g, -4.2, 2.5, 0.85);
  bush(g, -0.65, 2.15, 0.85);
  bush(g, -3.7, 2.1, 0.7);
  bush(g, -0.9, 3.55, 0.65);
  acUnit(g, -3.9, -3.85);
  box(g, 3.6, 0.06, 1.6, 'concrete', -2.1, GROUND, -4.3);
  bin(g, 4.3, -3.15, 'steelDark');
  bin(g, 4.85, -3.15, 'green');
  // garden shed at the back
  box(g, 1.9, 0.16, 1.45, 'concrete', 3.2, GROUND, -4.2);
  box(g, 1.7, 1.9, 1.3, 'wallSand', 3.2, GROUND + 0.16, -4.2);
  const sr = gableRoof(g, 1.7, 1.45, 0.5, 'roofInk', 3.2, 2.06, -4.2, 0.16);
  sr.rotation.y = Math.PI / 2;
  gableEnd(g, { face: '+z', x: 3.2, y: 2.06, z: -3.39, w: 1.83, rise: 0.5, mat: 'wallSand' });
  box(g, 0.7, 1.5, 0.08, 'ink', 3.2, GROUND + 0.2, -3.53);
  box(g, 0.06, 0.18, 0.06, 'steel', 3.45, GROUND + 0.9, -3.48);
  car(g, 2.8, 3.32, pickFrom<Mat>(rnd, ['blue', 'red', 'orange', 'wallTeal']));

  /* ---- power port on the rear roof ---- */
  return mast(g, -0.9, 7.55, -2.2, 9.0);
}

// ================================================================ v2: split-level ranch

function ranch(g: THREE.Group, rnd: () => number): THREE.Vector3 {
  const wall = pickFrom<Mat>(rnd, ['wallSand', 'wallYellow', 'wallTeal', 'wallCream']);
  const brick: Mat = 'wallCoral';
  const roof = pickFrom<Mat>(rnd, ['roofInk', 'roofGreen', 'roofSand']);
  const roofW = pickFrom<Mat>(rnd, ['roofInk', 'roofGreen']);
  const leaf = pickFrom<Mat>(rnd, ['wood', 'red', 'blue', 'green']);
  const carMat = pickFrom<Mat>(rnd, ['blue', 'red', 'orange', 'wallTeal']);

  /* ---- lot ---- */
  lotSlab(g);
  sidewalk(g);
  lawn(g, -5.15, 2.15, -0.98, 4.75);
  lawn(g, 0.28, 2.1, 1.2, 4.75);
  lawn(g, -5.15, -5.1, 1.2, -3.5);
  lawn(g, -5.15, -3.6, -2.5, -2.85);
  path(g, -0.35, 2.45, 5.2, 1.15);
  drive(g, 1.4, 4.85, 1.7, 5.2);
  box(g, 3.5, 0.05, 3.9, 'concrete', 3.1, GROUND, -0.15);

  /* ---- raised front-gabled wing (brick), picture window ---- */
  box(g, 2.9, FL - GROUND, 4.8, 'concrete', -3.25, GROUND, -0.5);
  box(g, 2.7, 4.18, 4.6, brick, -3.25, FL, -0.5); // eave at 4.6
  box(g, 2.76, 0.3, 4.66, 'wallCream', -3.25, FL, -0.5);
  box(g, 2.78, 0.2, 4.68, 'wallWhite', -3.25, 4.4, -0.5); // frieze
  for (const [x, z] of [[-4.58, 1.78], [-1.92, 1.78], [-4.58, -2.78], [-1.92, -2.78]] as const) {
    box(g, 0.18, 4.18, 0.18, 'wallWhite', x, FL, z);
  }
  const wr = gableRoof(g, 4.6, 2.7, 1.05, roofW, -3.25, 4.6, -0.5, 0.35);
  wr.rotation.y = Math.PI / 2;
  gableEnd(g, { face: '+z', x: -3.25, y: 4.6, z: 1.82, w: 2.7, rise: 1.05, mat: brick });
  win(g, { face: '+z', plane: 1.95, along: -3.25, y: 4.78, w: 0.55, h: 0.42, sill: false });
  // picture window: wide, three lights, heavy trim
  win(g, { face: '+z', plane: 1.8, along: -3.25, y: FL + 1.0, w: 1.85, h: 1.4, muntins: true });
  box(g, 2.4, 0.12, 0.28, 'concrete', -3.25, FL + 0.68, 1.86);
  win(g, { face: '-x', plane: -4.6, along: -0.6, y: FL + 1.15, w: 1.0, h: 1.15 });
  win(g, { face: '-z', plane: -2.8, along: -3.25, y: FL + 1.15, w: 1.25, h: 1.25 });
  gutter(g, -4.9, 2.14, -1.6, 2.14, 4.62);
  downspout(g, -4.72, 2.08, 4.58);
  // satellite dish up on the wing roof
  satellite(g, -3.05, 5.6, -0.9);

  /* ---- low main block + entry ---- */
  box(g, 3.4, FL - GROUND, 5.4, 'concrete', -0.3, GROUND, -0.8);
  box(g, 3.2, 2.68, 5.2, wall, -0.3, FL, -0.8); // eave 3.1
  box(g, 3.24, 0.2, 5.24, 'wallWhite', -0.3, 2.9, -0.8);
  for (const [x, z] of [[-1.88, 1.78], [1.28, 1.78], [-1.88, -3.38]] as const) {
    box(g, 0.18, 2.68, 0.18, 'wallWhite', x, FL, z);
  }
  gableRoof(g, 3.2, 5.2, 0.85, roof, -0.3, 3.1, -0.8, 0.5);
  gableEnd(g, { face: '+x', x: 1.32, y: 3.1, z: -0.8, w: 5.2, rise: 0.85, mat: wall });
  gableEnd(g, { face: '-x', x: -1.92, y: 3.1, z: -0.8, w: 5.2, rise: 0.85, mat: wall });
  gutter(g, -1.9, 2.3, 1.3, 2.3, 3.12);
  gutter(g, -2.2, -3.86, 1.7, -3.86, 3.12);
  downspout(g, -1.84, 1.9, 3.12);
  doorway(g, { face: '+z', plane: 1.8, along: -0.35, y0: FL, w: 1.0, h: 2.05, leaf, hood: 'flat' });
  stoop(g, -0.35, 1.8, 1.5, FL, 2);
  // storm door in front of the leaf
  box(g, 0.98, 1.95, 0.05, 'ink', -0.35, FL + 0.06, 2.09);
  box(g, 0.78, 1.62, 0.03, 'glow', -0.35, FL + 0.22, 2.12);
  box(g, 0.06, 1.6, 0.04, 'steel', -0.35, FL + 0.24, 2.14);
  win(g, { face: '+z', plane: 1.8, along: 0.75, y: FL + 0.95, w: 0.7, h: 1.2 });
  porchLight(g, '+z', 1.8, -1.12, 2.3);
  numberPlate(g, '+z', 1.8, 0.2, 2.25, '8');
  win(g, { face: '-z', plane: -3.4, along: -1.5, y: FL + 1.15, w: 1.0, h: 1.2 });
  doorway(g, { face: '-z', plane: -3.4, along: -0.4, y0: 0.38, w: 0.95, h: 2.0, leaf, hood: 'flat' });

  /* ---- carport: flat roof on posts, storage door in the side wall ---- */
  for (const [x, z] of [[4.78, 1.88], [4.78, -2.08], [1.46, 1.88]] as const) {
    box(g, 0.34, 0.12, 0.34, 'concrete', x, GROUND, z);
    box(g, 0.18, 2.44, 0.18, 'wood', x, GROUND + 0.12, z);
  }
  box(g, 3.7, 0.16, 4.3, roof, 3.1, 2.9, -0.1);
  box(g, 3.78, 0.2, 0.12, 'wallWhite', 3.1, 2.86, 2.03);
  box(g, 3.78, 0.2, 0.12, 'wallWhite', 3.1, 2.86, -2.23);
  box(g, 0.12, 0.2, 4.36, 'wallWhite', 4.93, 2.86, -0.1);
  box(g, 0.12, 0.2, 4.36, 'wallWhite', 1.27, 2.86, -0.1);
  box(g, 3.78, 0.06, 0.14, 'ink', 3.1, 3.06, 2.02);
  box(g, 0.16, 0.18, 4.2, 'wood', 4.78, 2.7, -0.1);
  doorway(g, { face: '+x', plane: 1.3, along: 0.35, y0: FL, w: 0.95, h: 1.9, leaf: 'wallWhite' });
  car(g, 3.0, -0.15, carMat);

  /* ---- rear deck with railing and steps ---- */
  box(g, 3.7, 0.26, 1.35, 'wood', -0.55, GROUND, -4.08);
  box(g, 3.7, 0.22, 0.1, 'wood', -0.55, GROUND, -4.72);
  for (const [x, z] of [[-2.35, -4.65], [1.25, -4.65], [-2.35, -3.45]] as const) {
    box(g, 0.14, 0.38, 0.14, 'wood', x, GROUND, z);
  }
  railing(g, { x: -2.35, y: 0.38, z: -4.65 }, { x: 0.1, y: 0.38, z: -4.65 }, 0.86, 'ink');
  railing(g, { x: -2.35, y: 0.38, z: -3.4 }, { x: -2.35, y: 0.38, z: -4.65 }, 0.86, 'ink');
  railing(g, { x: 1.25, y: 0.38, z: -4.65 }, { x: 1.25, y: 0.38, z: -3.4 }, 0.86, 'ink');
  stoop(g, 0.65, -4.75, 1.1, 0.38, 1, 'wood', -1);
  // deck chairs
  for (const x of [-1.7, -0.9]) {
    box(g, 0.62, 0.08, 0.6, 'wood', x, 0.6, -4.05);
    box(g, 0.62, 0.5, 0.08, 'wood', x, 0.6, -4.34);
    for (const s of [-0.24, 0.24]) box(g, 0.07, 0.3, 0.55, 'wood', x + s, 0.38, -4.05);
  }

  /* ---- roof + yard plant ---- */
  chimney(g, -1.15, 3.5, -2.55, 1.15);
  box(g, 0.32, 0.3, 0.32, 'steel', -1.0, 3.55, 0.4);
  box(g, 0.4, 0.06, 0.4, 'ink', -1.0, 3.85, 0.4);
  acUnit(g, 1.75, -3.95);
  bin(g, 4.6, -2.95, 'steelDark');
  bin(g, 4.6, -3.6, 'blue');
  basketHoop(g, 3.55, -4.15);
  clothesline(g, -4.8, -2.9, -4.45);
  hedge(g, -5.1, 4.9, -1.35, 4.9, 0.6, 0.8);
  hedge(g, 0.55, 4.9, 1.2, 4.9, 0.55, 0.8);
  hedge(g, -5.1, -5.0, -2.4, -5.0, 0.6, 0.8);
  mailbox(g, -1.35, 4.65);
  tree(g, -4.45, 3.85, 0.7);
  bush(g, -4.4, 2.25, 0.8);
  bush(g, -3.0, 2.3, 0.85);
  bush(g, -2.1, 2.3, 0.7);
  bush(g, 0.95, 2.25, 0.6);
  meterBox(g, '-x', -4.6, 0.7, 1.6);

  /* ---- power port ---- */
  return mast(g, 0.9, 3.25, -3.15, 5.7);
}

// ================================================================ v3: townhouse pair

function townhouses(g: THREE.Group, rnd: () => number): THREE.Vector3 {
  const brick = pickFrom<Mat>(rnd, ['wallCoral', 'wallCoral', 'wallSand']);
  const trim: Mat = 'wallWhite';
  const doorA = pickFrom<Mat>(rnd, ['red', 'blue', 'green', 'wood']);
  const doorB = pickFrom<Mat>(rnd, (['red', 'blue', 'green', 'wood'] as Mat[]).filter((d) => d !== doorA));
  const flower = pickFrom<Mat>(rnd, ['wallPink', 'yellow', 'wallCoral', 'wallLilac']);
  const PFL = 1.02;
  const T1L = PFL + 3.05; // 4.07
  const TOPL = 7.12;
  const ZF = 2.2;
  const ZB = -3.6;

  /* ---- lot ---- */
  lotSlab(g);
  sidewalk(g);
  lawn(g, -5.1, 2.35, -3.85, 4.6);
  lawn(g, -2.2, 2.35, 2.2, 4.6);
  lawn(g, 3.9, 2.35, 5.1, 4.6);
  lawn(g, -5.1, -5.1, 5.1, -3.7);
  path(g, -3.15, 3.9, 5.2, 1.2);
  path(g, 3.15, 3.9, 5.2, 1.2);
  box(g, 7.0, 0.06, 1.1, 'concrete', 0, GROUND, -4.2);

  /* ---- shared body: brick, raised parlour floor, flat roof with cornice ---- */
  box(g, 7.8, PFL - GROUND, 5.8, 'concrete', 0, GROUND, -0.7);
  box(g, 7.86, 0.14, 5.86, 'wallWhite', 0, PFL - 0.16, -0.7); // water table
  box(g, 7.8, TOPL - PFL, 5.8, brick, 0, PFL, -0.7);
  // quoin strip on the party wall line, front and back
  box(g, 0.26, TOPL - PFL, 0.1, trim, 0, PFL, ZF + 0.02);
  box(g, 0.16, TOPL - PFL, 0.06, 'ink', 0, PFL, ZF + 0.09);
  box(g, 0.26, TOPL - PFL, 0.1, trim, 0, PFL, ZB - 0.02);
  // band courses
  for (const y of [T1L - 0.1, PFL + 0.06]) {
    box(g, 7.84, 0.14, 0.1, trim, 0, y, ZF + 0.02);
    box(g, 7.84, 0.14, 0.1, trim, 0, y, ZB - 0.02);
  }
  // cornice: bed moulding, frieze, corona, brackets
  box(g, 7.9, 0.16, 5.9, trim, 0, TOPL - 0.16, -0.7);
  box(g, 8.0, 0.22, 6.0, trim, 0, TOPL, -0.7);
  box(g, 8.12, 0.12, 6.12, 'ink', 0, TOPL + 0.22, -0.7);
  for (let i = 0; i < 7; i++) {
    const x = -3.3 + i * 1.1;
    box(g, 0.14, 0.28, 0.24, trim, x, TOPL - 0.12, ZF + 0.14);
  }
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      box(g, 0.24, 0.28, 0.14, trim, s * 3.94, TOPL - 0.12, -2.9 + i * 1.45);
    }
  }
  // parapet + coping
  box(g, 7.8, 0.55, 0.3, brick, 0, TOPL + 0.34, ZF - 0.15);
  box(g, 7.8, 0.55, 0.3, brick, 0, TOPL + 0.34, ZB + 0.15);
  for (const s of [-1, 1]) box(g, 0.3, 0.55, 5.8, brick, s * 3.75, TOPL + 0.34, -0.7);
  box(g, 7.8, 0.06, 5.8, 'roofInk', 0, TOPL + 0.34, -0.7);
  box(g, 8.0, 0.1, 0.44, 'concrete', 0, TOPL + 0.89, ZF - 0.15);
  box(g, 8.0, 0.1, 0.44, 'concrete', 0, TOPL + 0.89, ZB + 0.15);
  for (const s of [-1, 1]) box(g, 0.44, 0.1, 5.9, 'concrete', s * 3.75, TOPL + 0.89, -0.7);
  for (const x of [-2.3, 2.3]) chimney(g, x, 7.55, -2.8, 1.25, brick);

  /* ---- one unit at a time: bay, door, stoop, iron rails ---- */
  const units: Array<{ s: -1 | 1; leaf: Mat }> = [{ s: -1, leaf: doorA }, { s: 1, leaf: doorB }];
  for (const u of units) {
    const s = u.s;
    const bx = s * 1.3;
    const dx = s * 3.15;
    // two-storey box bay
    box(g, 1.9, 5.95, 0.6, brick, bx, PFL, 2.5);
    box(g, 0.16, 5.95, 0.16, trim, bx - 0.95, PFL, 2.78);
    box(g, 0.16, 5.95, 0.16, trim, bx + 0.95, PFL, 2.78);
    box(g, 2.12, 0.16, 0.82, trim, bx, 6.97, 2.48);
    box(g, 2.12, 0.1, 0.06, 'ink', bx, 6.97, 2.91);
    box(g, 2.02, 0.14, 0.74, 'concrete', bx, PFL - 0.14, 2.5);
    win(g, { face: '+z', plane: 2.8, along: bx, y: PFL + 0.72, w: 1.52, h: 1.45, muntins: true, frame: trim });
    win(g, { face: '+z', plane: 2.8, along: bx, y: PFL + 3.62, w: 1.52, h: 1.45, muntins: true, frame: trim });
    win(g, { face: s > 0 ? '+x' : '-x', plane: s * 2.25, along: 2.5, y: PFL + 0.78, w: 0.38, h: 1.32, sill: false, frame: trim });
    win(g, { face: s > 0 ? '+x' : '-x', plane: s * 2.25, along: 2.5, y: PFL + 3.68, w: 0.38, h: 1.32, sill: false, frame: trim });
    // door with a fanlight, individual colour
    doorway(g, { face: '+z', plane: ZF, along: dx, y0: PFL, w: 1.02, h: 2.18, leaf: u.leaf, transom: true });
    win(g, { face: '+z', plane: ZF, along: dx, y: PFL + 3.62, w: 0.82, h: 1.4, frame: trim });
    porchLight(g, '+z', ZF, dx + s * 0.72, PFL + 2.05);
    numberPlate(g, '+z', ZF, dx - s * 0.7, PFL + 2.3, s > 0 ? '20' : '18');
    // basement window in the foundation
    fBox(g, '+z', ZF, 'ink', bx, GROUND + 0.2, 0.02, 0.86, 0.55, 0.1);
    fBox(g, '+z', ZF, 'glow', bx, GROUND + 0.26, 0.09, 0.68, 0.42, 0.04);
    fBox(g, '+z', ZF, 'steel', bx, GROUND + 0.15, 0.13, 0.78, 0.04, 0.16);
    // stoop with iron handrails
    stoop(g, dx, ZF, 1.7, PFL, 5);
    box(g, 1.9, 0.1, 1.8, 'concrete', dx, PFL - 0.1, ZF + 0.85);
    for (const t of [-0.86, 0.86]) {
      const xa = dx + t;
      rod(g, { x: xa, y: PFL + 0.86, z: ZF + 0.08 }, { x: xa, y: GROUND + 0.86, z: 3.92 }, 0.045, 'ink', 6);
      for (const [pz, top] of [[2.4, PFL + 0.86], [3.05, 1.44], [3.86, 0.98]] as const) {
        rod(g, { x: xa, y: GROUND, z: pz }, { x: xa, y: top, z: pz }, 0.04, 'ink', 5);
      }
      sphere(g, 0.08, 'ink', xa, GROUND + 0.9, 3.9, 8);
    }
    // end-wall windows
    win(g, { face: s > 0 ? '+x' : '-x', plane: s * 3.9, along: -0.5, y: PFL + 0.8, w: 1.0, h: 1.35, frame: trim });
    win(g, { face: s > 0 ? '+x' : '-x', plane: s * 3.9, along: -0.5, y: PFL + 3.7, w: 1.0, h: 1.32, frame: trim });
    // rear door and rear windows
    doorway(g, { face: '-z', plane: ZB, along: s * 3.0, y0: PFL, w: 0.9, h: 2.05, leaf: u.leaf, hood: 'flat' });
    stoop(g, s * 3.0, ZB, 1.3, PFL, 4, 'concrete', -1);
    win(g, { face: '-z', plane: ZB, along: s * 1.0, y: PFL + 0.8, w: 1.0, h: 1.35, frame: trim });
    win(g, { face: '-z', plane: ZB, along: s * 1.0, y: PFL + 3.7, w: 1.0, h: 1.35, frame: trim });
    win(g, { face: '-z', plane: ZB, along: s * 2.2, y: PFL + 3.7, w: 0.8, h: 1.3, frame: trim });
    // small front garden
    box(g, 1.6, 0.06, 2.0, 'concrete', s * 4.55, GROUND, 3.3);
    bush(g, s * 4.55, 3.0, 0.55, 'roofGreen');
    bush(g, s * 4.4, 4.1, 0.4, 'green');
    for (const [fx, fz] of [[s * 1.4, 3.0], [s * 0.7, 3.7], [s * 2.0, 4.0], [s * 1.1, 4.35]] as const) {
      sphere(g, 0.13, flower, fx, GROUND + 0.24, fz, 6);
      box(g, 0.03, 0.16, 0.03, 'green', fx, GROUND + 0.02, fz);
    }
    meterBox(g, '+z', ZF, s * 0.55, PFL + 0.6);
  }

  /* ---- rear yards ---- */
  picketFence(g, 0, -3.65, 0, -5.0);
  hedge(g, -5.1, -5.0, -0.2, -5.0, 0.6, 0.8);
  hedge(g, 0.2, -5.0, 5.1, -5.0, 0.6, 0.8);
  acUnit(g, -2.6, -4.85);
  acUnit(g, 2.6, -4.85);
  bin(g, 4.55, -3.15, 'steelDark');
  bin(g, 4.55, -3.9, 'green');
  tree(g, -4.3, -4.15, 0.55);
  bush(g, 4.4, 4.1, 0.5);
  hedge(g, -5.1, 4.72, -4.0, 4.72, 0.55, 0.75);
  hedge(g, -2.35, 4.72, 2.35, 4.72, 0.55, 0.75);
  hedge(g, 4.0, 4.72, 5.1, 4.72, 0.55, 0.75);
  mailbox(g, -4.45, 4.78);

  /* ---- power port on the roof beside the party wall ---- */
  return mast(g, 0.3, 7.4, -3.0, 8.8);
}

// ================================================================ entry point

export const build: ModelBuilder = ({ variant, seed }) => {
  const g = new THREE.Group();
  const rnd = seeded(seed);
  const v = ((variant % VARIANTS) + VARIANTS) % VARIANTS;
  let port: THREE.Vector3;
  switch (v) {
    case 0:
      port = bungalow(g, rnd);
      break;
    case 1:
      port = colonial(g, rnd);
      break;
    case 2:
      port = ranch(g, rnd);
      break;
    default:
      port = townhouses(g, rnd);
      break;
  }
  setPowerPorts(g, [port]);
  return g;
};
