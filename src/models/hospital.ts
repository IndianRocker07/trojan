// American general-hospital campus. Footprint 3x3 cells = 36 x 36 m.
// Origin = footprint centre at ground level, Y up, front (+Z) faces the street.
//
// Variant 0: cross/linear campus — seven-storey ward tower centred at the back with
// a rooftop helipad, ED wing at the left-front under a broad ambulance canopy, a
// glazed main entrance and drop-off lay-by at the right-front, MOB linked to the
// tower on the east, staff lot in the right-front corner and a service yard behind.
// Variant 1: L-shaped campus — tower at the back-right, two-storey ED/base along the
// front-left, three-storey clinic bar at the corner, glazed atrium filling the inside
// corner, main entrance/drop-off in the middle, parking on the right and a walled
// service yard back-left.
//
// Read the site from the street: kerb and sidewalk, then walks to every entrance,
// the ambulance bay, the drop-off, parking, and finally the service side at the rear.
// Materials only from MAT; trims stay at 0.18 m or thicker so the ink pass draws them.
import * as THREE from 'three';
import { MAT, type MatName } from '../render/palette';
import {
  box,
  cyl,
  rod,
  sphere,
  spin,
  windowGrid,
  insulator,
  setPowerPorts,
  type Face,
  type ModelBuilder,
} from './kit';

export const VARIANTS = 2;

/** Top of the site slab: every building and prop stands on this plane. */
const G = 0.12;
const STOREY = 3.2;
const TOWER_H = 7 * STOREY; // 22.4 m ward tower
const WING_H = 2 * STOREY; // 6.4 m ED / base wing
const MOB_H = 3 * STOREY; // 9.6 m clinic / medical office building

interface Block {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
}

/* ================================================================ basic kit */

/** Plain mesh for torus rings and other shapes the kit lacks. */
function put(
  g: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: MatName,
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

/** Box mounted on a wall face: along = position on the face, out = gap from the wall. */
function fBox(
  g: THREE.Object3D,
  face: Face,
  plane: number,
  mat: MatName,
  along: number,
  y: number,
  out: number,
  w: number,
  h: number,
  d: number,
): THREE.Mesh {
  const ns = face[0] === '+' ? 1 : -1;
  if (face === '+z' || face === '-z') return box(g, w, h, d, mat, along, y, plane + ns * (out + d / 2));
  return box(g, d, h, w, mat, plane + ns * (out + d / 2), y, along);
}

function normalOf(face: Face): { x: number; z: number } {
  if (face === '+z') return { x: 0, z: 1 };
  if (face === '-z') return { x: 0, z: -1 };
  if (face === '+x') return { x: 1, z: 0 };
  return { x: -1, z: 0 };
}

/* ================================================================ lettering */

/** 5x7 block alphabet for signs and painted road text. */
const GLYPHS: Record<string, string[]> = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
};

/**
 * Draw block letters. +z / -z are upright sign faces, +y lies flat on the ground
 * (readable from a camera south of the site), +x / -x are wall faces.
 */
function pixelText(
  g: THREE.Object3D,
  text: string,
  o: {
    x: number;
    y: number;
    z: number;
    cell: number;
    face: '+z' | '-z' | '+y' | '+x' | '-x';
    mat: MatName;
    align?: 'left' | 'center';
    depth?: number;
  },
): number {
  const cell = o.cell;
  const dep = o.depth ?? 0.05;
  const total = text.length * 6 * cell - cell;
  const x0 = o.align === 'center' ? o.x - total / 2 : o.x;
  const z0 = o.align === 'center' ? o.z - (7 * cell) / 2 : o.z;
  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPHS[text[i].toUpperCase()] ?? GLYPHS[' '];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (glyph[r][c] !== '1') continue;
        const u = (i * 6 + c) * cell;
        const v = (6 - r) * cell;
        if (o.face === '+z' || o.face === '-z') {
          const s = o.face === '+z' ? 1 : -1;
          box(g, cell * 0.84, cell * 0.84, dep, o.mat, x0 + u, o.y + v, o.z + s * dep * 0.5);
        } else if (o.face === '+x') {
          box(g, dep, cell * 0.84, cell * 0.84, o.mat, o.x + dep * 0.5, o.y + v, z0 - u + 7 * cell);
        } else if (o.face === '-x') {
          box(g, dep, cell * 0.84, cell * 0.84, o.mat, o.x - dep * 0.5, o.y + v, z0 + u);
        } else {
          box(g, cell * 0.84, dep, cell * 0.84, o.mat, x0 + u, o.y, z0 - v + 7 * cell);
        }
      }
    }
  }
  return total;
}

/* ================================================================ building kit */

/** Flat roof: dark field with seams, parapet walls and concrete coping. */
function flatRoof(g: THREE.Object3D, b: Block, top: number, ph: number, field: MatName = 'roofSand'): void {
  const t = 0.35;
  box(g, 2 * b.hw - 0.3, 0.06, 2 * b.hd - 0.3, field, b.cx, top + 0.01, b.cz);
  for (let z = b.cz - b.hd + 1.4; z < b.cz + b.hd - 0.9; z += 1.5) {
    box(g, 2 * b.hw - 0.7, 0.03, 0.04, 'steelDark', b.cx, top + 0.07, z);
  }
  const zF = b.cz + b.hd - t / 2;
  const zB = b.cz - b.hd + t / 2;
  const xR = b.cx + b.hw - t / 2;
  const xL = b.cx - b.hw + t / 2;
  box(g, 2 * b.hw, ph, t, 'wallWhite', b.cx, top, zF);
  box(g, 2 * b.hw, ph, t, 'wallWhite', b.cx, top, zB);
  box(g, t, ph, 2 * b.hd - 2 * t, 'wallWhite', xR, top, b.cz);
  box(g, t, ph, 2 * b.hd - 2 * t, 'wallWhite', xL, top, b.cz);
  box(g, 2 * b.hw + 0.12, 0.11, t + 0.12, 'concrete', b.cx, top + ph, zF);
  box(g, 2 * b.hw + 0.12, 0.11, t + 0.12, 'concrete', b.cx, top + ph, zB);
  box(g, t + 0.12, 0.11, 2 * b.hd - 2 * t, 'concrete', xR, top + ph, b.cz);
  box(g, t + 0.12, 0.11, 2 * b.hd - 2 * t, 'concrete', xL, top + ph, b.cz);
}

/**
 * Ward-tower skin: continuous horizontal glow bands on all four faces, sand
 * spandrels, chunky concrete sills and a few vertical mullions — no per-pane grid.
 */
function towerBands(g: THREE.Object3D, b: Block, rows: number, y0: number, pitch: number, winH: number): void {
  const faces: Array<{ f: Face; plane: number; along: number; winW: number; mullions: number }> = [
    { f: '+z', plane: b.cz + b.hd, along: b.cx, winW: 2 * b.hw - 3.6, mullions: 3 },
    { f: '-z', plane: b.cz - b.hd, along: b.cx, winW: 2 * b.hw - 3.6, mullions: 3 },
    { f: '+x', plane: b.cx + b.hw, along: b.cz, winW: 2 * b.hd - 3.4, mullions: 2 },
    { f: '-x', plane: b.cx - b.hw, along: b.cz, winW: 2 * b.hd - 3.4, mullions: 2 },
  ];
  for (const { f, plane, along, winW, mullions } of faces) {
    windowGrid(g, {
      face: f,
      cx: b.cx,
      cz: b.cz,
      hw: b.hw,
      hd: b.hd,
      rows,
      cols: 1,
      y0,
      pitchY: pitch,
      winW,
      winH,
    });
    for (let r = 0; r < rows; r++) {
      const yb = y0 + r * pitch;
      fBox(g, f, plane, 'wallSand', along, yb - 1.1, 0.0, winW + 0.5, 0.8, 0.1);
      fBox(g, f, plane, 'concrete', along, yb - 0.28, 0.0, winW + 0.42, 0.22, 0.24);
      fBox(g, f, plane, 'concrete', along, yb + winH, 0.0, winW + 0.42, 0.18, 0.22);
    }
    for (let i = 1; i <= mullions; i++) {
      const t = -winW / 2 + (winW * i) / (mullions + 1);
      fBox(g, f, plane, 'steelDark', along + t, y0 - 0.42, 0.08, 0.2, (rows - 1) * pitch + winH + 0.42, 0.22);
    }
  }
  // corner piers: they shade the ends of every band
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(g, 0.62, TOWER_H, 0.62, 'wallSand', b.cx + sx * (b.hw - 0.18), G, b.cz + sz * (b.hd - 0.18));
    }
  }
  // stone plinth
  box(g, 2 * b.hw + 0.16, 1.05, 2 * b.hd + 0.16, 'concrete', b.cx, G, b.cz);
  box(g, 2 * b.hw + 0.2, 0.28, 2 * b.hd + 0.2, 'wallSand', b.cx, G + 0.9, b.cz);
}

/** One punched window with a painted surround, sill and centre sash. */
function windowUnit(
  g: THREE.Object3D,
  o: { face: Face; plane: number; along: number; y: number; w: number; h: number; frame?: MatName; sill?: boolean },
): void {
  const fr = o.frame ?? 'wallWhite';
  const w = o.w;
  const h = o.h;
  fBox(g, o.face, o.plane, 'glow', o.along, o.y + 0.03, -0.02, w, h, 0.06);
  fBox(g, o.face, o.plane, fr, o.along - w / 2 - 0.1, o.y - 0.12, 0.02, 0.2, h + 0.24, 0.2);
  fBox(g, o.face, o.plane, fr, o.along + w / 2 + 0.1, o.y - 0.12, 0.02, 0.2, h + 0.24, 0.2);
  fBox(g, o.face, o.plane, fr, o.along, o.y + h + 0.04, 0.02, w + 0.4, 0.2, 0.2);
  fBox(g, o.face, o.plane, fr, o.along, o.y - 0.11, 0.02, w + 0.4, 0.2, 0.2);
  fBox(g, o.face, o.plane, 'ink', o.along, o.y + h * 0.5, 0.06, w - 0.14, 0.09, 0.09);
  fBox(g, o.face, o.plane, 'ink', o.along, o.y, 0.06, 0.09, h - 0.12, 0.09);
  if (o.sill !== false) {
    fBox(g, o.face, o.plane, 'concrete', o.along, o.y - 0.27, 0.0, w + 0.55, 0.16, 0.34);
    fBox(g, o.face, o.plane, 'wallWhite', o.along, o.y + h + 0.02, 0.0, w + 0.5, 0.14, 0.16);
  }
}

/** Glazed double door with a transom, chunky surround, kick plates and handles. */
function doubleDoor(
  g: THREE.Object3D,
  o: { face: Face; plane: number; along: number; y: number; w: number; h: number; surround?: MatName; transom?: boolean },
): void {
  const w = o.w;
  const h = o.h;
  const su = o.surround ?? 'wallWhite';
  fBox(g, o.face, o.plane, su, o.along, o.y - 0.08, 0.0, w + 0.56, 0.2, 0.26);
  fBox(g, o.face, o.plane, su, o.along - w / 2 - 0.18, o.y - 0.08, 0.0, 0.3, h + 0.28, 0.26);
  fBox(g, o.face, o.plane, su, o.along + w / 2 + 0.18, o.y - 0.08, 0.0, 0.3, h + 0.28, 0.26);
  fBox(g, o.face, o.plane, su, o.along, o.y + h + 0.12, 0.0, w + 0.72, 0.26, 0.28);
  fBox(g, o.face, o.plane, 'ink', o.along, o.y, 0.04, w + 0.08, h, 0.12);
  fBox(g, o.face, o.plane, 'glow', o.along - w / 4, o.y + 0.1, 0.02, w / 2 - 0.12, h - 0.2, 0.06);
  fBox(g, o.face, o.plane, 'glow', o.along + w / 4, o.y + 0.1, 0.02, w / 2 - 0.12, h - 0.2, 0.06);
  fBox(g, o.face, o.plane, su, o.along, o.y + 0.08, 0.13, 0.08, h - 0.12, 0.07);
  fBox(g, o.face, o.plane, 'ink', o.along - w / 4, o.y + 0.08, 0.14, 0.28, 0.4, 0.06);
  fBox(g, o.face, o.plane, 'ink', o.along + w / 4, o.y + 0.08, 0.14, 0.28, 0.4, 0.06);
  const n = normalOf(o.face);
  if (o.face === '+z' || o.face === '-z') {
    for (const s of [-1, 1]) box(g, 0.06, 0.6, 0.07, 'ink', o.along + s * 0.2, o.y + 0.95, o.plane + n.z * 0.24);
  } else {
    for (const s of [-1, 1]) box(g, 0.07, 0.6, 0.06, 'ink', o.plane + n.x * 0.24, o.y + 0.95, o.along + s * 0.2);
  }
  if (o.transom !== false) {
    fBox(g, o.face, o.plane, 'glow', o.along, o.y + h + 0.04, 0.0, w - 0.08, 0.44, 0.06);
    fBox(g, o.face, o.plane, su, o.along, o.y + h - 0.04, 0.09, w + 0.04, 0.09, 0.08);
  }
}

/** Rooftop air handler on a curb: casing, louvres, duct and a spinning fan. */
function hvacUnit(g: THREE.Object3D, x: number, y: number, z: number, w: number, d: number, h = 1.15): void {
  box(g, w + 0.24, 0.16, d + 0.24, 'concrete', x, y, z);
  box(g, w, h, d, 'steel', x, y + 0.16, z);
  box(g, w + 0.08, 0.09, d + 0.08, 'steelDark', x, y + 0.16 + h, z);
  for (let i = 0; i < 4; i++) box(g, w - 0.35, 0.06, 0.04, 'ink', x, y + 0.32 + i * 0.14, z + d / 2 + 0.02);
  const r = Math.min(w, d) * 0.29;
  cyl(g, r + 0.1, r + 0.1, 0.05, 'ink', x, y + 0.16 + h + 0.09, z, 16);
  const fan = new THREE.Group();
  fan.position.set(x, y + 0.16 + h + 0.14, z);
  for (let i = 0; i < 3; i++) {
    const blade = box(fan, r * 2, 0.035, 0.22, 'wallWhite', 0, 0, 0);
    blade.rotation.y = (i * Math.PI) / 3;
  }
  cyl(fan, 0.07, 0.07, 0.07, 'steelDark', 0, 0, 0, 8);
  spin(fan, 'y', 4);
  g.add(fan);
  cyl(g, 0.16, 0.16, 0.9, 'steelDark', x - w / 2 - 0.35, y + 0.16, z, 8);
  box(g, 0.7, 0.14, 0.7, 'concrete', x - w / 2 - 0.35, y, z);
}

/** Exhaust stack with a dark rain cap. */
function stack(g: THREE.Object3D, x: number, y: number, z: number, h = 1.1): void {
  cyl(g, 0.16, 0.18, h, 'steel', x, y, z, 10);
  cyl(g, 0.26, 0.26, 0.09, 'steelDark', x, y + h, z, 10);
  box(g, 0.55, 0.06, 0.06, 'ink', x, y + h + 0.12, z);
}

/** Rooftop access hatch, upstand and a caged ladder on the rear wall. */
function roofHatch(g: THREE.Object3D, x: number, y: number, z: number): void {
  box(g, 1.3, 0.24, 1.1, 'concrete', x, y, z);
  box(g, 1.05, 0.14, 0.9, 'steelDark', x, y + 0.24, z);
  box(g, 1.0, 0.06, 0.84, 'ink', x, y + 0.36, z - 0.3);
}

/** Stair / lift core rising above a roof, glow slots, mast and aviation beacon. */
function core(g: THREE.Object3D, o: { x: number; z: number; w: number; d: number; y0: number; top: number }): void {
  const h = o.top - o.y0;
  box(g, o.w, h, o.d, 'wallTeal', o.x, o.y0, o.z);
  const b: Block = { cx: o.x, cz: o.z, hw: o.w / 2, hd: o.d / 2 };
  windowGrid(g, { face: '+z', cx: b.cx, cz: b.cz, hw: b.hw, hd: b.hd, rows: 2, cols: 1, y0: o.y0 + h - 2.7, pitchY: 1.6, winW: o.w * 0.6, winH: 0.7 });
  windowGrid(g, { face: '+x', cx: b.cx, cz: b.cz, hw: b.hw, hd: b.hd, rows: 2, cols: 1, y0: o.y0 + h - 2.7, pitchY: 1.6, winW: o.d * 0.6, winH: 0.7 });
  box(g, o.w + 0.22, 0.28, o.d + 0.22, 'roofInk', o.x, o.top, o.z);
  box(g, o.w + 0.1, 0.12, o.d + 0.1, 'concrete', o.x, o.top - 0.14, o.z);
  // louvred plant door at the base
  box(g, 0.9, 2.0, 0.08, 'steelDark', o.x, o.y0 + 0.02, o.z + o.d / 2 + 0.04);
  for (let i = 0; i < 5; i++) box(g, 0.7, 0.06, 0.05, 'ink', o.x, o.y0 + 0.25 + i * 0.32, o.z + o.d / 2 + 0.1);
  cyl(g, 0.07, 0.09, 0.9, 'steel', o.x, o.top + 0.28, o.z, 8);
  sphere(g, 0.26, 'beacon', o.x, o.top + 1.3, o.z, 12);
}

/** Helipad: dark disc, painted ring and H, perimeter glow lights. */
function helipad(g: THREE.Object3D, x: number, y: number, z: number, r: number): void {
  cyl(g, r, r, 0.18, 'roofInk', x, y, z, 32);
  put(g, new THREE.TorusGeometry(r - 0.35, 0.09, 6, 40), 'wallWhite', x, y + 0.2, z, Math.PI / 2, 0, 0);
  box(g, 0.5, 0.04, 2.5, 'wallWhite', x - 0.85, y + 0.2, z);
  box(g, 0.5, 0.04, 2.5, 'wallWhite', x + 0.85, y + 0.2, z);
  box(g, 2.2, 0.04, 0.5, 'wallWhite', x, y + 0.2, z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    box(g, 0.34, 0.14, 0.34, 'glow', x + Math.cos(a) * (r - 0.3), y + 0.18, z + Math.sin(a) * (r - 0.3));
  }
  // aiming circle ticks
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    box(g, 0.22, 0.03, 0.8, 'yellow', x + Math.cos(a) * (r - 0.95), y + 0.2, z + Math.sin(a) * (r - 0.95));
  }
}

/** Rooftop windsock: mast, collar and a tapered orange cone with a white band. */
function windsock(g: THREE.Object3D, x: number, y: number, z: number): void {
  box(g, 0.6, 0.16, 0.6, 'concrete', x, y, z);
  cyl(g, 0.08, 0.1, 2.7, 'steel', x, y + 0.16, z, 8);
  cyl(g, 0.1, 0.1, 0.14, 'steelDark', x, y + 2.5, z, 8);
  const cone = cyl(g, 0.07, 0.27, 0.95, 'orange', x, y + 2.52, z + 0.58, 10);
  cone.rotation.x = Math.PI / 2;
  const band = cyl(g, 0.15, 0.17, 0.18, 'wallWhite', x, y + 2.52, z + 0.58, 10);
  band.rotation.x = Math.PI / 2;
  box(g, 0.05, 0.05, 0.5, 'ink', x, y + 2.72, z + 0.15);
}

/** Red cross on a white plate with an ink border, proud of a facade at z = zf. */
function crossSign(g: THREE.Object3D, x: number, zf: number, yc: number, s = 1): void {
  box(g, 4.6 * s, 5.2 * s, 0.22, 'wallWhite', x, yc - 2.6 * s, zf + 0.11);
  box(g, 4.86 * s, 0.12, 0.26, 'ink', x, yc + 2.6 * s, zf + 0.12);
  box(g, 4.86 * s, 0.12, 0.26, 'ink', x, yc - 2.72 * s, zf + 0.12);
  box(g, 0.12, 5.2 * s, 0.26, 'ink', x - 2.42 * s, yc - 2.6 * s, zf + 0.12);
  box(g, 0.12, 5.2 * s, 0.26, 'ink', x + 2.42 * s, yc - 2.6 * s, zf + 0.12);
  box(g, 1.35 * s, 4.1 * s, 0.3, 'red', x, yc - 2.05 * s, zf + 0.36);
  box(g, 3.6 * s, 1.35 * s, 0.3, 'red', x, yc - 0.675 * s, zf + 0.36);
}

/** Glowing cross standing on the parapet coping, with a small mounting plate. */
function glowCross(g: THREE.Object3D, x: number, z: number, yBase: number, s = 1): void {
  box(g, 1.1 * s, 0.14, 0.5, 'steelDark', x, yBase + 0.07, z);
  box(g, 0.55 * s, 2.4 * s, 0.14, 'glow', x, yBase + 1.2 * s, z);
  box(g, 1.7 * s, 0.55 * s, 0.14, 'glow', x, yBase + 2.15 * s, z);
}

/** Wall power port: plate, arm and a three-disc insulator. */
function powerBracket(g: THREE.Object3D, o: { face: Face; plane: number; along: number; y: number }): void {
  const n = normalOf(o.face);
  const px = (o.face === '+z' || o.face === '-z' ? o.along : o.plane) + n.x * 0.05;
  const pz = (o.face === '+z' || o.face === '-z' ? o.plane : o.along) + n.z * 0.05;
  box(g, n.x ? 0.1 : 0.72, 0.72, n.z ? 0.1 : 0.72, 'steelDark', px, o.y - 0.36, pz);
  const ax = px + n.x * 0.5;
  const az = pz + n.z * 0.5;
  box(g, n.x ? 0.9 : 0.14, 0.12, n.z ? 0.9 : 0.14, 'steel', ax, o.y, az);
  const tipX = px + n.x * 1.05;
  const tipZ = pz + n.z * 1.05;
  const top = insulator(g, tipX, o.y, tipZ, 3);
  setPowerPorts(g as THREE.Group, [top]);
}

/* ================================================================ site kit */

/** Street edge: asphalt road, yellow dashes, sidewalk, kerb with driveway cuts. */
function street(g: THREE.Object3D, cuts: Array<[number, number]>): void {
  box(g, 34, 0.08, 1.6, 'asphalt', 0, G, 16.15);
  for (let x = -15.6; x <= 15.6; x += 4.2) box(g, 1.6, 0.02, 0.12, 'yellow', x, G + 0.08, 16.15);
  box(g, 34, 0.1, 1.2, 'concrete', 0, G, 14.75);
  for (let x = -16.6; x <= 16.6; x += 3.4) box(g, 0.04, 0.02, 1.15, 'steelDark', x, G + 0.1, 14.75);
  // kerb, broken at each driveway
  const marks = [-17, ...cuts.flat().sort((a, b) => a - b), 17];
  for (let i = 0; i < marks.length; i += 2) {
    const x0 = marks[i];
    const x1 = marks[i + 1];
    if (x1 - x0 > 0.05) box(g, x1 - x0, 0.2, 0.22, 'concrete', (x0 + x1) / 2, G, 14.1);
  }
  for (const [x0, x1] of cuts) {
    box(g, x1 - x0, 0.11, 2.4, 'concrete', (x0 + x1) / 2, G, 14.8);
    box(g, 0.16, 0.1, 2.4, 'wallWhite', x0 + 0.08, G + 0.11, 14.8);
    box(g, 0.16, 0.1, 2.4, 'wallWhite', x1 - 0.08, G + 0.11, 14.8);
  }
  // storm drain at the kerb
  box(g, 0.9, 0.03, 0.42, 'ink', -8.8, G + 0.2, 14.24);
  for (let i = 0; i < 4; i++) box(g, 0.7, 0.02, 0.05, 'steel', -8.8, G + 0.23, 14.05 + i * 0.11);
}

function lawn(g: THREE.Object3D, x: number, z: number, w: number, d: number): void {
  box(g, w, 0.06, d, 'grass', x, G, z);
}

function walk(g: THREE.Object3D, x: number, z: number, w: number, d: number): void {
  box(g, w, 0.08, d, 'concrete', x, G, z);
}

function drive(g: THREE.Object3D, x: number, z: number, w: number, d: number): void {
  box(g, w, 0.07, d, 'asphalt', x, G, z);
}

/** Broad ambulance canopy: white slab, red fascia, columns on pads, glow downlights. */
function ambulanceCanopy(g: THREE.Object3D, cx: number, zFront: number, w: number, d: number): void {
  const y = 4.55;
  const zc = zFront + d / 2;
  box(g, w, 0.35, d, 'wallWhite', cx, y, zc);
  box(g, w + 0.1, 0.1, d + 0.1, 'concrete', cx, y + 0.35, zc);
  box(g, w, 0.62, 0.16, 'red', cx, y - 0.62, zc + d / 2 - 0.08);
  box(g, w + 0.08, 0.09, 0.2, 'ink', cx, y - 0.66, zc + d / 2 - 0.06);
  box(g, 0.16, 0.62, d - 0.2, 'red', cx - w / 2 + 0.08, y - 0.62, zc - 0.06);
  box(g, 0.16, 0.62, d - 0.2, 'red', cx + w / 2 - 0.08, y - 0.62, zc - 0.06);
  for (const sx of [-1, 1]) {
    box(g, 0.85, 0.16, 0.85, 'concrete', cx + sx * (w / 2 - 0.55), G, zc + d / 2 - 0.55);
    cyl(g, 0.22, 0.22, y - G - 0.16, 'steel', cx + sx * (w / 2 - 0.55), G + 0.16, zc + d / 2 - 0.55, 10);
    box(g, 0.16, 0.16, 0.8, 'steelDark', cx + sx * (w / 2 - 0.55), y - 0.2, zc + d / 2 - 0.55);
  }
  for (const dx of [-0.3, 0, 0.3]) {
    box(g, 0.7, 0.05, 0.7, 'glow', cx + dx * w, y - 0.06, zc + d / 2 - 0.9);
  }
  // EMERGENCY on the red fascia
  box(g, 4.7, 0.64, 0.1, 'ink', cx, y - 0.68, zFront + d - 0.01);
  pixelText(g, 'EMERGENCY', { x: cx, y: y - 0.61, z: zFront + d + 0.05, cell: 0.074, face: '+z', mat: 'glow', align: 'center', depth: 0.04 });
}

/** Flat entrance canopy with a blue fascia, two columns on pads and downlights. */
function entranceCanopy(g: THREE.Object3D, cx: number, zFront: number, w: number, d: number): void {
  const y = 4.35;
  const zc = zFront + d / 2;
  box(g, w, 0.3, d, 'wallWhite', cx, y, zc);
  box(g, w + 0.12, 0.1, d + 0.12, 'concrete', cx, y + 0.3, zc);
  box(g, w, 0.45, 0.14, 'wallBlue', cx, y - 0.45, zc + d / 2 - 0.07);
  box(g, w + 0.06, 0.07, 0.18, 'ink', cx, y - 0.49, zc + d / 2 - 0.04);
  for (const sx of [-1, 1]) {
    box(g, 0.9, 0.16, 0.9, 'concrete', cx + sx * (w / 2 - 0.5), G, zc + d / 2 - 0.5);
    cyl(g, 0.18, 0.18, y - G - 0.16, 'steel', cx + sx * (w / 2 - 0.5), G + 0.16, zc + d / 2 - 0.5, 10);
  }
  for (const dx of [-0.25, 0.25]) {
    box(g, 0.8, 0.05, 0.8, 'glow', cx + dx * w, y - 0.06, zc + d / 2 - 0.75);
  }
}

/** Ambulance van: box module, cab, red stripe, red cross, light bar. Front +X locally. */
function ambulance(g: THREE.Object3D, x: number, z: number, rot = 0): void {
  const b = new THREE.Group();
  b.position.set(x, G, z);
  b.rotation.y = rot;
  g.add(b);
  for (const xx of [-1.85, 1.75]) {
    for (const zz of [-0.88, 0.88]) {
      const w = cyl(b, 0.38, 0.38, 0.28, 'ink', 0, 0, 0, 12);
      w.rotation.x = Math.PI / 2;
      w.position.set(xx, 0.38, zz);
      const hub = cyl(b, 0.17, 0.17, 0.3, 'steel', 0, 0, 0, 10);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(xx, 0.38, zz);
      box(b, 0.9, 0.14, 0.12, 'ink', xx, 0.72, zz * 1.12);
    }
  }
  box(b, 5.0, 0.32, 1.85, 'ink', -0.55, 0.34, 0);
  // module body and cab
  box(b, 3.55, 2.05, 2.06, 'wallWhite', -0.95, 0.66, 0);
  box(b, 1.85, 1.9, 2.02, 'wallWhite', 1.75, 0.6, 0);
  box(b, 0.8, 0.9, 1.98, 'wallWhite', 3.0, 0.6, 0);
  box(b, 0.12, 0.75, 1.7, 'glass', 2.62, 1.35, 0);
  box(b, 0.05, 0.55, 0.85, 'glass', 2.4, 1.4, -0.52);
  box(b, 0.05, 0.55, 0.85, 'glass', 2.4, 1.4, 0.52);
  box(b, 0.08, 0.28, 1.8, 'ink', 3.42, 0.68, 0);
  box(b, 0.16, 0.22, 2.0, 'steelDark', 3.46, 0.35, 0);
  box(b, 0.14, 0.22, 2.0, 'steelDark', -2.74, 0.35, 0);
  // red stripe
  box(b, 3.6, 0.3, 0.04, 'red', -0.95, 1.28, 1.04);
  box(b, 3.6, 0.3, 0.04, 'red', -0.95, 1.28, -1.04);
  box(b, 1.6, 0.26, 0.04, 'red', 1.8, 1.25, 1.02);
  box(b, 1.6, 0.26, 0.04, 'red', 1.8, 1.25, -1.02);
  // red cross on the module sides and rear
  for (const s of [-1, 1]) {
    box(b, 0.34, 0.95, 0.03, 'red', -0.7, 1.16, s * 1.05);
    box(b, 0.95, 0.34, 0.03, 'red', -0.7, 1.47, s * 1.05);
  }
  box(b, 0.34, 0.8, 0.03, 'red', -2.74, 1.2, 0);
  box(b, 0.8, 0.34, 0.03, 'red', -2.74, 1.43, 0);
  // module side windows, rear doors
  box(b, 0.7, 0.55, 0.04, 'glass', -1.85, 1.85, 1.05);
  box(b, 0.7, 0.55, 0.04, 'glass', -1.85, 1.85, -1.05);
  box(b, 0.08, 1.8, 0.04, 'ink', -2.73, 0.75, 0);
  box(b, 0.05, 0.28, 0.6, 'glow', -2.76, 1.65, 0.45);
  box(b, 0.05, 0.28, 0.6, 'red', -2.76, 1.65, -0.45);
  // light bar, beacons, mirrors
  box(b, 1.1, 0.12, 0.4, 'steelDark', 1.55, 2.52, 0);
  for (const s of [-1, 1]) {
    box(b, 0.34, 0.2, 0.3, s < 0 ? 'beacon' : 'blue', 1.55, 2.64, s * 0.18);
    box(b, 0.1, 0.06, 0.4, 'steel', 2.8, 1.9, s * 1.05);
  }
  box(b, 0.5, 0.06, 0.06, 'ink', 2.2, 2.62, 0);
}

/** Parked sedan, front +X locally; rotY turns it in the lot. */
function car(g: THREE.Object3D, x: number, z: number, body: MatName, rotY = 0): void {
  const c = new THREE.Group();
  c.position.set(x, G, z);
  c.rotation.y = rotY;
  g.add(c);
  box(c, 4.15, 0.6, 1.8, body, 0, 0.32, 0);
  box(c, 2.1, 0.6, 1.56, 'glass', -0.15, 0.92, 0);
  box(c, 1.7, 0.08, 1.6, body, -0.2, 1.52, 0);
  box(c, 1.2, 0.1, 1.54, body, -1.5, 0.88, 0);
  box(c, 0.9, 0.1, 1.54, body, 1.55, 0.88, 0);
  box(c, 0.1, 0.2, 1.74, 'ink', 2.1, 0.32, 0);
  box(c, 0.1, 0.2, 1.74, 'ink', -2.1, 0.32, 0);
  for (const zz of [-0.6, 0.6]) {
    box(c, 0.05, 0.14, 0.3, 'glow', 2.08, 0.62, zz);
    box(c, 0.05, 0.14, 0.3, 'red', -2.08, 0.62, zz);
  }
  for (const xx of [-1.3, 1.3]) {
    for (const zz of [-0.84, 0.84]) {
      const w = cyl(c, 0.33, 0.33, 0.24, 'ink', 0, 0, 0, 10);
      w.rotation.x = Math.PI / 2;
      w.position.set(xx, 0.33, zz);
    }
  }
}

/** Box delivery truck, rear toward -X locally. */
function boxTruck(g: THREE.Object3D, x: number, z: number, rot = 0, body: MatName = 'wallWhite', s = 1): void {
  const t = new THREE.Group();
  t.position.set(x, G, z);
  t.rotation.y = rot;
  t.scale.setScalar(s);
  g.add(t);
  for (const xx of [-1.7, 1.7]) {
    for (const zz of [-0.92, 0.92]) {
      const w = cyl(t, 0.42, 0.42, 0.28, 'ink', 0, 0, 0, 12);
      w.rotation.x = Math.PI / 2;
      w.position.set(xx, 0.42, zz);
      const hub = cyl(t, 0.17, 0.17, 0.3, 'steel', 0, 0, 0, 8);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(xx, 0.42, zz);
    }
  }
  box(t, 5.4, 0.3, 1.9, 'ink', 0, 0.36, 0);
  box(t, 3.8, 2.35, 2.1, body, -0.75, 0.65, 0);
  box(t, 1.7, 1.6, 2.0, 'wallWhite', 1.95, 0.65, 0);
  box(t, 0.08, 0.85, 1.65, 'glass', 2.82, 1.25, 0);
  box(t, 0.1, 0.55, 1.9, 'ink', 3.35, 0.55, 0);
  box(t, 0.12, 0.25, 2.12, 'steelDark', 3.3, 0.36, 0);
  box(t, 3.8, 0.16, 2.12, 'steelDark', -0.75, 3.0, 0);
  box(t, 1.2, 1.85, 0.05, 'steelDark', -2.68, 0.75, 0);
  for (let i = 0; i < 5; i++) box(t, 1.1, 0.06, 0.04, 'ink', -2.68, 0.95 + i * 0.32, -0.04);
  box(t, 0.3, 0.3, 0.4, 'glow', -1.9, 1.1, 1.08);
  box(t, 0.3, 0.3, 0.4, 'red', -1.9, 1.1, -1.08);
}

/** Round deciduous tree: trunk, two green tones and a shrub at the foot. */
function tree(g: THREE.Object3D, x: number, z: number, s = 1): void {
  cyl(g, 0.21 * s, 0.32 * s, 2.7 * s, 'wood', x, G, z, 8);
  sphere(g, 1.65 * s, 'green', x, G + 3.55 * s, z, 12);
  sphere(g, 1.25 * s, 'roofGreen', x + 0.95 * s, G + 3.0 * s, z + 0.35 * s, 10);
  sphere(g, 1.1 * s, 'green', x - 0.75 * s, G + 3.1 * s, z - 0.55 * s, 10);
  sphere(g, 0.55 * s, 'roofGreen', x + 0.55 * s, G + 0.55 * s, z - 0.35 * s, 8);
  box(g, 1.1 * s, 0.06, 1.1 * s, 'concrete', x, G, z);
}

function bush(g: THREE.Object3D, x: number, z: number, s = 1): void {
  sphere(g, 0.58 * s, 'green', x, G + 0.4 * s, z, 9);
  sphere(g, 0.45 * s, 'roofGreen', x + 0.45 * s, G + 0.33 * s, z + 0.2 * s, 8);
}

/** Clipped hedge run along X: capped box with a green top and soil edge. */
function hedge(g: THREE.Object3D, x: number, z: number, len: number, d = 0.9, h = 0.72): void {
  box(g, len, 0.12, d + 0.16, 'concrete', x, G, z);
  box(g, len, h, d, 'roofGreen', x, G + 0.12, z);
  box(g, len - 0.2, 0.1, d - 0.1, 'green', x, G + 0.12 + h, z);
}

/** Steel lamp: base, 5 m pole, arm, head and glow lens. */
function lampPole(g: THREE.Object3D, x: number, z: number, h = 5.0): void {
  box(g, 0.7, 0.18, 0.7, 'concrete', x, G, z);
  cyl(g, 0.09, 0.13, h, 'steel', x, G + 0.18, z, 8);
  rod(g, { x, y: G + h, z }, { x: x + 0.95, y: G + h, z }, 0.06, 'steel', 5);
  box(g, 0.65, 0.13, 0.42, 'steelDark', x + 0.95, G + h - 0.13, z);
  box(g, 0.55, 0.04, 0.34, 'glow', x + 0.95, G + h - 0.17, z);
}

/** Yellow bollard with an ink cap. */
function bollard(g: THREE.Object3D, x: number, z: number): void {
  cyl(g, 0.17, 0.19, 0.95, 'yellow', x, G, z, 10);
  cyl(g, 0.2, 0.2, 0.07, 'ink', x, G + 0.95, z, 10);
  box(g, 0.2, 0.03, 0.2, 'wallWhite', x, G + 0.55, z);
}

/** Bench facing +Z: timber seat and back on steel legs. */
function bench(g: THREE.Object3D, x: number, z: number, rot = 0): void {
  const b = new THREE.Group();
  b.position.set(x, G, z);
  b.rotation.y = rot;
  g.add(b);
  box(b, 2.3, 0.12, 0.58, 'wood', 0, 0.46, 0);
  box(b, 2.3, 0.42, 0.1, 'wood', 0, 0.62, -0.27);
  for (const s of [-0.85, 0.85]) {
    box(b, 0.09, 0.46, 0.52, 'steelDark', s, 0, 0);
    box(b, 0.09, 0.62, 0.09, 'steelDark', s, 0.46, -0.28);
  }
}

/** Wheeled refuse bin. */
function refuseBin(g: THREE.Object3D, x: number, z: number, mat: MatName = 'steelDark'): void {
  box(g, 0.72, 0.95, 0.62, mat, x, G + 0.16, z);
  box(g, 0.78, 0.1, 0.68, 'ink', x, G + 1.11, z);
  box(g, 0.12, 0.05, 0.1, 'ink', x, G + 1.21, z - 0.28);
  for (const s of [-1, 1]) {
    const w = cyl(g, 0.11, 0.11, 0.08, 'ink', 0, 0, 0, 8);
    w.rotation.z = Math.PI / 2;
    w.position.set(x + s * 0.3, G + 0.11, z - 0.26);
  }
}

/** Bus-stop pole with a blue flag and painted BUS letters. */
function busStop(g: THREE.Object3D, x: number, z: number): void {
  cyl(g, 0.06, 0.08, 3.0, 'steel', x, G, z, 8);
  box(g, 0.9, 0.62, 0.08, 'wallBlue', x, G + 2.35, z);
  box(g, 0.98, 0.07, 0.1, 'ink', x, G + 2.97, z);
  pixelText(g, 'BUS', { x, y: G + 2.47, z: z + 0.07, cell: 0.05, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.03 });
  box(g, 0.12, 0.18, 0.12, 'glow', x, G + 3.04, z);
}

/** Fire hydrant. */
function hydrant(g: THREE.Object3D, x: number, z: number): void {
  cyl(g, 0.22, 0.26, 0.1, 'concrete', x, G, z, 10);
  cyl(g, 0.17, 0.19, 0.62, 'red', x, G + 0.1, z, 10);
  sphere(g, 0.19, 'red', x, G + 0.76, z, 10);
  cyl(g, 0.07, 0.09, 0.12, 'red', x, G + 0.93, z, 8);
  for (const s of [-1, 1]) {
    const c = cyl(g, 0.09, 0.09, 0.16, 'red', 0, 0, 0, 8);
    c.rotation.z = Math.PI / 2;
    c.position.set(x + s * 0.24, G + 0.5, z);
  }
  box(g, 0.12, 0.05, 0.05, 'steelDark', x, G + 1.04, z);
}

/** Chain-link service fence: posts, top and mid rail. */
function fence(g: THREE.Object3D, x0: number, z0: number, x1: number, z1: number, h = 1.8): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(2, Math.round(len / 2.2));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    cyl(g, 0.05, 0.06, h, 'steel', x0 + (x1 - x0) * t, G, z0 + (z1 - z0) * t, 6);
  }
  rod(g, { x: x0, y: G + h, z: z0 }, { x: x1, y: G + h, z: z1 }, 0.045, 'steel', 5);
  rod(g, { x: x0, y: G + h * 0.5, z: z0 }, { x: x1, y: G + h * 0.5, z: z1 }, 0.035, 'steel', 5);
}

/** Low stone monument with the hospital name in block letters and a red cross. */
function monument(g: THREE.Object3D, x: number, z: number): void {
  box(g, 4.4, 0.2, 1.2, 'concrete', x, G, z);
  box(g, 3.9, 1.9, 0.8, 'wallSand', x, G + 0.2, z);
  box(g, 4.05, 0.16, 0.95, 'concrete', x, G + 2.1, z);
  box(g, 3.95, 0.18, 0.86, 'wallBlue', x, G + 1.7, z);
  box(g, 3.55, 1.15, 0.09, 'wallCream', x, G + 0.42, z + 0.41);
  box(g, 0.34, 0.9, 0.06, 'red', x - 1.68, G + 0.72, z + 0.47);
  box(g, 0.9, 0.34, 0.06, 'red', x - 1.68, G + 1.0, z + 0.47);
  pixelText(g, 'MERCY', { x: x - 0.4, y: G + 0.95, z: z + 0.47, cell: 0.095, face: '+z', mat: 'ink', align: 'center', depth: 0.03 });
  pixelText(g, 'GENERAL', { x: x - 0.4, y: G + 0.55, z: z + 0.47, cell: 0.055, face: '+z', mat: 'ink', align: 'center', depth: 0.03 });
  for (const s of [-1.85, 1.85]) bush(g, x + s, z + 0.28, 0.55);
}

/** Steel flagpole with a waving US flag. */
function flagpole(g: THREE.Object3D, x: number, z: number, h = 8.2): void {
  box(g, 1.0, 0.18, 1.0, 'concrete', x, G, z);
  cyl(g, 0.28, 0.34, 0.22, 'concrete', x, G + 0.18, z, 12);
  cyl(g, 0.05, 0.075, h, 'steel', x, G + 0.4, z, 10);
  sphere(g, 0.1, 'yellow', x, G + 0.4 + h + 0.09, z, 10);
  const fw = 1.9;
  const fh = 1.1;
  const fy = G + 0.4 + h - fh - 0.12;
  const fx = x + 0.09;
  box(g, fw, fh, 0.035, 'wallWhite', fx, fy, z);
  for (let i = 0; i < 7; i++) box(g, fw, 0.055, 0.04, 'red', fx, fy + 0.08 + i * 0.158, z + 0.005);
  box(g, fw * 0.42, fh * 0.54, 0.05, 'blue', fx, fy + fh * 0.46, z + 0.01);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) box(g, 0.035, 0.035, 0.03, 'wallWhite', fx + 0.12 + c * 0.14, fy + fh * 0.5 + r * 0.11, z + 0.04);
  }
}

/** Plain hospital flag: teal field with a white/red cross. */
function plainFlag(g: THREE.Object3D, x: number, z: number, h = 8.2): void {
  box(g, 1.0, 0.18, 1.0, 'concrete', x, G, z);
  cyl(g, 0.28, 0.34, 0.22, 'concrete', x, G + 0.18, z, 12);
  cyl(g, 0.05, 0.075, h, 'steel', x, G + 0.4, z, 10);
  sphere(g, 0.1, 'yellow', x, G + 0.4 + h + 0.09, z, 10);
  const fy = G + 0.4 + h - 1.15;
  const fx = x + 0.09;
  box(g, 1.8, 1.0, 0.035, 'wallTeal', fx, fy, z);
  box(g, 0.22, 0.72, 0.04, 'wallWhite', fx + 0.9, fy + 0.14, z + 0.01);
  box(g, 0.62, 0.22, 0.04, 'wallWhite', fx + 0.9, fy + 0.39, z + 0.01);
  box(g, 0.22, 0.62, 0.05, 'red', fx + 0.9, fy + 0.19, z + 0.02);
  box(g, 0.52, 0.22, 0.05, 'red', fx + 0.9, fy + 0.39, z + 0.02);
}

/** Parking-lot sign: two posts, blue panel, white P and a glow arrow. */
function parkingSign(g: THREE.Object3D, x: number, z: number): void {
  for (const s of [-0.55, 0.55]) cyl(g, 0.05, 0.06, 2.5, 'steel', x + s, G, z, 8);
  box(g, 1.5, 1.25, 0.08, 'wallBlue', x, G + 1.25, z);
  box(g, 1.58, 0.08, 0.1, 'ink', x, G + 2.5, z);
  pixelText(g, 'P', { x, y: G + 1.44, z: z + 0.07, cell: 0.145, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.03 });
  box(g, 0.7, 0.13, 0.04, 'glow', x, G + 1.32, z + 0.1);
  box(g, 0.15, 0.26, 0.04, 'glow', x + 0.28, G + 1.25, z + 0.1);
}

/** Blue hospital wayfinding sign at the kerb: white H on a blue panel. */
function hospitalSign(g: THREE.Object3D, x: number, z: number): void {
  box(g, 0.7, 0.16, 0.7, 'concrete', x, G, z);
  cyl(g, 0.07, 0.09, 2.8, 'steel', x, G + 0.16, z, 8);
  box(g, 1.7, 1.7, 0.1, 'wallBlue', x, G + 1.75, z);
  box(g, 1.78, 0.1, 0.12, 'ink', x, G + 3.45, z);
  pixelText(g, 'H', { x, y: G + 2.18, z: z + 0.08, cell: 0.15, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.03 });
  box(g, 1.2, 0.1, 0.04, 'glow', x, G + 1.95, z + 0.1);
}

/** Red EMERGENCY street sign with a white arrow, on two posts. */
function emergencySign(g: THREE.Object3D, x: number, z: number): void {
  for (const s of [-1.15, 1.15]) cyl(g, 0.06, 0.07, 2.4, 'steel', x + s, G, z, 8);
  box(g, 2.7, 0.9, 0.1, 'red', x, G + 1.6, z);
  box(g, 2.78, 0.08, 0.12, 'ink', x, G + 2.5, z);
  pixelText(g, 'EMERGENCY', { x, y: G + 1.98, z: z + 0.08, cell: 0.038, face: '+z', mat: 'glow', align: 'center', depth: 0.03 });
  box(g, 1.5, 0.09, 0.04, 'wallWhite', x - 0.25, G + 1.74, z + 0.09);
  box(g, 0.3, 0.28, 0.04, 'wallWhite', x + 0.5, G + 1.64, z + 0.09);
}

/** Standby generator on a pad: louvred steel enclosure, warning stripe, twin stacks. */
function generator(g: THREE.Object3D, x: number, z: number): void {
  box(g, 5.6, 0.18, 3.9, 'concrete', x, G, z);
  box(g, 4.9, 2.4, 3.1, 'steelDark', x, G + 0.18, z);
  box(g, 4.9, 0.18, 3.14, 'steel', x, G + 2.58, z);
  for (let i = 0; i < 5; i++) box(g, 3.9, 0.07, 0.05, 'ink', x, G + 0.55 + i * 0.22, z + 1.57);
  box(g, 4.9, 0.24, 0.04, 'orange', x, G + 1.95, z + 1.56);
  box(g, 1.4, 1.6, 0.06, 'steel', x - 1.55, G + 0.5, z + 1.6);
  box(g, 0.5, 0.5, 0.05, 'glow', x - 1.55, G + 2.35, z + 1.62);
  for (const dx of [-1.05, 0.9]) {
    cyl(g, 0.17, 0.17, 2.4, 'steel', x + dx, G + 2.7, z, 10);
    cyl(g, 0.24, 0.24, 0.16, 'ink', x + dx, G + 5.1, z, 10);
  }
  // fuel fill and control panel
  box(g, 0.55, 0.55, 0.08, 'steel', x + 2.1, G + 1.0, z + 1.58);
  box(g, 0.3, 0.3, 0.04, 'ink', x + 2.1, G + 1.1, z + 1.63);
  cyl(g, 0.14, 0.14, 0.5, 'steel', x - 2.3, G + 0.18, z + 1.2, 8);
}

/** Oxygen cylinder bank on a steel rack, with a manifold pipe into a wall. */
function o2Bank(g: THREE.Object3D, x: number, z: number): void {
  box(g, 2.8, 0.12, 1.6, 'concrete', x, G, z);
  for (let k = 0; k < 3; k++) {
    const tx = x - 0.85 + k * 0.85;
    cyl(g, 0.26, 0.26, 1.5, 'wallWhite', tx, G + 0.12, z, 14);
    sphere(g, 0.26, 'wallWhite', tx, G + 1.62, z, 12);
    cyl(g, 0.27, 0.27, 0.28, 'blue', tx, G + 0.75, z, 14);
    cyl(g, 0.06, 0.06, 0.18, 'steel', tx, G + 1.86, z, 6);
    cyl(g, 0.12, 0.16, 0.1, 'steelDark', tx, G + 2.02, z, 8);
  }
  for (const s of [-1, 1]) box(g, 0.08, 1.1, 0.08, 'steel', x + s * 1.35, G + 0.12, z + 0.66);
  box(g, 2.8, 0.09, 0.09, 'steel', x, G + 1.2, z + 0.66);
  box(g, 0.1, 0.1, 1.4, 'steel', x, G + 1.1, z - 0.1);
}

/** Steel gas line from the O2 bank into a wall, with a drop leg and flange. */
function gasLine(g: THREE.Object3D, x0: number, x1: number, y: number, z: number): void {
  rod(g, { x: x0, y, z }, { x: x1, y, z }, 0.065, 'steel', 8);
  const dir = Math.sign(x1 - x0);
  box(g, 0.16, 0.55, 0.55, 'steelDark', x1 - dir * 0.12, y - 0.28, z);
  rod(g, { x: x0, y: G + 1.1, z: z - 0.1 }, { x: x0, y, z: z - 0.1 }, 0.05, 'steel', 6);
  cyl(g, 0.1, 0.1, 0.12, 'ink', x0, y, z, 8);
}

/** Loading dock: platform, roll-up door on the wall, bumpers, steps and a lamp. */
function loadingDock(
  g: THREE.Object3D,
  o: { x: number; zWall: number; dir: 1 | -1; w?: number },
): void {
  const w = o.w ?? 4.6;
  const zPlat = o.zWall + o.dir * 0.75;
  box(g, w, 0.9, 1.5, 'concrete', o.x, G, zPlat);
  box(g, w, 0.08, 0.16, 'yellow', o.x, G + 0.9, zPlat - o.dir * 0.92);
  for (let i = 0; i < 3; i++) box(g, w - 0.4, 0.04, 0.1, 'ink', o.x, G + 0.93, zPlat - o.dir * (0.2 + i * 0.55));
  // roll-up door recessed into the wall
  box(g, 3.1, 2.9, 0.12, 'ink', o.x, G + 0.9, o.zWall + o.dir * 0.06);
  box(g, 2.9, 2.7, 0.09, 'steelDark', o.x, G + 1.0, o.zWall + o.dir * 0.12);
  for (let i = 0; i < 7; i++) box(g, 2.7, 0.06, 0.05, 'ink', o.x, G + 1.12 + i * 0.35, o.zWall + o.dir * 0.18);
  for (const s of [-1, 1]) {
    box(g, 0.24, 0.5, 0.32, 'ink', o.x + s * 1.25, G + 0.45, o.zWall + o.dir * 0.2);
  }
  box(g, 0.9, 2.95, 0.16, 'wallWhite', o.x - 1.95, G + 0.9, o.zWall + o.dir * 0.08);
  box(g, 0.9, 2.95, 0.16, 'wallWhite', o.x + 1.95, G + 0.9, o.zWall + o.dir * 0.08);
  box(g, 0.55, 0.12, 0.55, 'steelDark', o.x, G + 3.1, o.zWall + o.dir * 0.4);
  box(g, 0.42, 0.05, 0.42, 'glow', o.x, G + 3.06, o.zWall + o.dir * 0.4);
  // side steps and a handrail
  const sx = o.x + w / 2 + 0.55;
  box(g, 1.0, 0.3, 1.0, 'concrete', sx, G, zPlat - o.dir * 0.4);
  box(g, 1.0, 0.6, 0.7, 'concrete', sx, G, zPlat - o.dir * 0.1);
  rod(g, { x: sx + 0.45, y: G + 0.3, z: zPlat - o.dir * 0.85 }, { x: sx + 0.45, y: G + 1.55, z: zPlat - o.dir * 0.85 }, 0.04, 'steel', 5);
}

/** Dumpster with a lid and skids. */
function dumpster(g: THREE.Object3D, x: number, z: number): void {
  box(g, 1.9, 1.15, 1.2, 'roofGreen', x, G + 0.12, z);
  box(g, 2.0, 0.12, 1.3, 'ink', x, G + 1.27, z);
  box(g, 1.8, 0.1, 1.1, 'green', x, G + 1.39, z);
  for (const s of [-0.8, 0.8]) box(g, 0.16, 0.12, 1.3, 'steelDark', x + s, G, z);
}

/* ================================================================ campus A */

function campusA(g: THREE.Group): void {
  const T: Block = { cx: 0.5, cz: -7.5, hw: 7, hd: 5.5 };
  const E: Block = { cx: -10.5, cz: 2.6, hw: 4.5, hd: 4.6 };
  const L: Block = { cx: 4.4, cz: -0.2, hw: 3.4, hd: 2.2 };
  const M: Block = { cx: 12.6, cz: -5.5, hw: 3.2, hd: 4.4 };
  const TT = G + TOWER_H;
  const WT = G + WING_H;
  const MT = G + MOB_H;
  const LT = G + 5.4;

  /* ---- site and street ---- */
  box(g, 34, G, 34, 'paving', 0, 0, 0);
  street(g, [
    [-12.5, -9.5],
    [2.0, 4.8],
    [9.2, 12.0],
  ]);
  lawn(g, -16.0, 3.0, 2.0, 21.0);
  lawn(g, 14.8, 12.3, 4.0, 3.4);
  lawn(g, -2.1, 12.2, 3.0, 3.6);
  lawn(g, -12.4, -7.4, 8.8, 10.6);
  lawn(g, -12.5, -14.95, 8.4, 3.9);
  lawn(g, 12.8, -13.35, 7.8, 6.8);
  // drop-off court, ambulance apron, parking and drives
  drive(g, 4.1, 9.1, 9.4, 9.0);
  drive(g, -9.5, 10.4, 11.8, 6.4);
  drive(g, 13.0, 5.6, 7.6, 9.6);
  drive(g, 10.6, 12.25, 2.8, 3.7);
  // walks
  walk(g, 4.4, 8.2, 1.7, 11.8);
  walk(g, -4.0, 10.65, 1.3, 6.9);
  walk(g, 10.9, 0.35, 3.0, 1.5);
  walk(g, 4.4, 4.4, 1.7, 1.2);
  // kerbs at the lot and around the drop-off court
  box(g, 4.8, 0.16, 0.22, 'concrete', 14.4, G, 10.4);
  box(g, 0.22, 0.16, 9.7, 'concrete', 16.8, G, 5.6);
  for (const z of [4.6, 13.6]) box(g, 9.4, 0.14, 0.2, 'concrete', 4.1, G, z);
  box(g, 0.2, 0.14, 9.0, 'concrete', -0.6, G, 9.1);
  box(g, 0.2, 0.14, 9.0, 'concrete', 8.8, G, 9.1);
  // lot stalls: four bays on the east side, aisle to the west
  for (const z of [3.3, 5.7, 8.1]) box(g, 4.8, 0.02, 0.14, 'wallWhite', 14.4, G + 0.07, z);
  box(g, 4.8, 0.02, 0.14, 'wallWhite', 14.4, G + 0.07, 0.8);
  box(g, 0.14, 0.02, 9.6, 'wallWhite', 12.0, G + 0.07, 5.6);
  for (const z of [2.1, 4.5, 9.3]) box(g, 0.9, 0.16, 0.34, 'concrete', 16.1, G + 0.07, z);
  // aisle arrows
  box(g, 0.3, 0.02, 2.2, 'wallWhite', 10.4, G + 0.07, 5.0);
  box(g, 0.8, 0.02, 0.28, 'wallWhite', 10.4, G + 0.07, 6.2);
  box(g, 0.28, 0.02, 0.8, 'wallWhite', 10.4, G + 0.07, 6.0);
  // ambulance bay markings
  box(g, 7.0, 0.02, 0.14, 'wallWhite', -9.4, G + 0.07, 7.55);
  box(g, 7.0, 0.02, 0.14, 'wallWhite', -9.4, G + 0.07, 10.15);
  box(g, 7.0, 0.02, 0.14, 'wallWhite', -7.2, G + 0.07, 11.1);
  box(g, 7.0, 0.02, 0.14, 'wallWhite', -7.2, G + 0.07, 13.45);
  for (const x of [-12.9, -5.9]) box(g, 0.14, 0.02, 2.6, 'wallWhite', x, G + 0.07, 8.85);
  pixelText(g, 'AMBULANCE', { x: -9.4, y: G + 0.075, z: 10.75, cell: 0.05, face: '+y', mat: 'wallWhite', align: 'center', depth: 0.012 });

  /* ---- ward tower ---- */
  box(g, 2 * T.hw, TOWER_H, 2 * T.hd, 'wallWhite', T.cx, G, T.cz);
  towerBands(g, T, 7, G + 1.55, 2.95, 1.65);
  crossSign(g, 0.5, T.cz + T.hd, 14.55);
  flatRoof(g, T, TT, 0.92);
  glowCross(g, 0.5, T.cz + T.hd + 0.02, TT + 0.98);
  helipad(g, -1.6, TT + 0.07, -8.2, 3.3);
  hvacUnit(g, 4.5, TT + 0.07, -4.4, 2.6, 1.8);
  hvacUnit(g, 4.5, TT + 0.07, -7.6, 2.6, 1.8);
  stack(g, -5.4, TT + 0.07, -3.4);
  stack(g, -5.4, TT + 0.07, -6.6, 0.8);
  roofHatch(g, 4.6, TT + 0.07, -11.8);
  windsock(g, 5.9, TT + 0.07, -12.2);
  core(g, { x: 8.4, z: -11.45, w: 1.8, d: 2.9, y0: G, top: 24.3 });
  for (const [x, z] of [
    [-5.6, -1.93],
    [6.9, -1.93],
    [7.45, -3.0],
    [-6.45, -3.0],
  ]) {
    cyl(g, 0.09, 0.09, TT - G, 'steel', x, G, z, 8);
    box(g, 0.16, 0.1, 0.16, 'steelDark', x, G + 0.02, z);
  }
  powerBracket(g, { face: '+z', plane: T.cz + T.hd, along: 6.7, y: 10.4 });

  /* ---- emergency department ---- */
  box(g, 2 * E.hw, WING_H, 2 * E.hd, 'wallCream', E.cx, G, E.cz);
  box(g, 2 * E.hw + 0.16, 1.0, 2 * E.hd + 0.2, 'concrete', E.cx, G, E.cz);
  box(g, 2 * E.hw + 0.2, 0.34, 2 * E.hd + 0.24, 'wallWhite', E.cx, WT - 0.34, E.cz);
  box(g, 2 * E.hw + 0.1, 0.24, 0.2, 'red', E.cx, WT - 0.58, E.cz + E.hd + 0.04);
  for (const x of [-14.85, -9.4, -5.4]) {
    box(g, 0.4, WING_H - 0.6, 0.16, 'wallSand', x, G + 0.3, E.cz + E.hd + 0.06);
  }
  for (const x of [-13.4, -11.9, -10.4, -8.9, -7.4]) {
    windowUnit(g, { face: '+z', plane: E.cz + E.hd, along: x, y: G + 5.0, w: 1.25, h: 1.05 });
  }
  for (const z of [0.7, 3.6]) {
    windowUnit(g, { face: '+x', plane: E.cx + E.hw, along: z, y: G + 3.5, w: 1.3, h: 1.6 });
    windowUnit(g, { face: '-x', plane: E.cx - E.hw, along: z, y: G + 3.5, w: 1.3, h: 1.6 });
  }
  flatRoof(g, E, WT, 0.55);
  hvacUnit(g, -12.6, WT + 0.05, 4.7, 2.0, 1.4);
  stack(g, -8.0, WT + 0.05, 5.4);
  roofHatch(g, -13.3, WT + 0.05, 0.6);
  entranceCanopy(g, -9.4, E.cz + E.hd, 6.4, 2.2);
  // doors under the ambulance canopy
  doubleDoor(g, { face: '+z', plane: E.cz + E.hd, along: -9.4, y: G + 0.1, w: 3.2, h: 2.6, surround: 'wallWhite' });
  for (const s of [-1, 1]) {
    fBox(g, '+z', E.cz + E.hd, 'glow', -9.4 + s * 2.4, G + 0.35, 0.0, 0.5, 2.0, 0.06);
    fBox(g, '+z', E.cz + E.hd, 'wallWhite', -9.4 + s * 2.42, G + 0.18, 0.06, 0.66, 2.35, 0.12);
  }
  ambulanceCanopy(g, -9.4, E.cz + E.hd, 10.0, 3.8);
  ambulance(g, -9.4, 8.8);
  ambulance(g, -7.2, 12.3);
  // ambulance apron kerb
  for (const [x, z, w, d] of [
    [-3.55, 10.4, 0.2, 6.4],
    [-15.45, 10.4, 0.2, 6.4],
    [-9.5, 13.65, 11.8, 0.2],
  ]) {
    box(g, w, 0.16, d, 'concrete', x, G, z);
  }

  /* ---- main entrance lobby ---- */
  box(g, 2 * L.hw, 5.4, 2 * L.hd, 'glass', L.cx, G, L.cz);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(g, 0.42, 5.4, 0.42, 'wallWhite', L.cx + sx * (L.hw - 0.2), G, L.cz + sz * (L.hd - 0.2));
    }
  }
  box(g, 2 * L.hw + 0.2, 0.3, 2 * L.hd + 0.2, 'concrete', L.cx, LT - 0.3, L.cz);
  box(g, 2 * L.hw - 0.6, 0.14, 2 * L.hd - 0.6, 'roofInk', L.cx, LT, L.cz);
  windowGrid(g, { face: '+z', cx: L.cx, cz: L.cz, hw: L.hw, hd: L.hd, rows: 1, cols: 3, y0: G + 3.45, pitchY: 0, winW: 1.5, winH: 1.25, span: 5.2, frames: true });
  windowGrid(g, { face: '+x', cx: L.cx, cz: L.cz, hw: L.hw, hd: L.hd, rows: 1, cols: 2, y0: G + 3.45, pitchY: 0, winW: 1.2, winH: 1.25, span: 2.6, frames: true });
  windowGrid(g, { face: '-x', cx: L.cx, cz: L.cz, hw: L.hw, hd: L.hd, rows: 1, cols: 2, y0: G + 3.45, pitchY: 0, winW: 1.2, winH: 1.25, span: 2.6, frames: true });
  doubleDoor(g, { face: '+z', plane: L.cz + L.hd, along: 4.4, y: G + 0.1, w: 2.6, h: 2.6 });
  for (const s of [-1, 1]) {
    fBox(g, '+z', L.cz + L.hd, 'glow', 4.4 + s * 1.65, G + 0.35, 0.0, 0.55, 2.0, 0.06);
    fBox(g, '+z', L.cz + L.hd, 'wallWhite', 4.4 + s * 1.67, G + 0.18, 0.06, 0.72, 2.35, 0.12);
  }
  box(g, 1.8, 0.5, 1.0, 'steelDark', L.cx, LT + 0.14, L.cz - 0.4);
  for (let i = 0; i < 4; i++) box(g, 1.5, 0.06, 0.04, 'ink', L.cx, LT + 0.25 + i * 0.1, L.cz + 0.12);
  entranceCanopy(g, 4.4, L.cz + L.hd, 6.8, 4.4);
  for (const x of [1.9, 6.9]) {
    box(g, 0.9, 0.42, 0.7, 'concrete', x, G, 3.2);
    bush(g, x, 3.2, 0.6);
  }
  // crosswalk from the kerb to the lobby door
  for (let i = 0; i < 6; i++) box(g, 1.5, 0.02, 0.35, 'wallWhite', 4.4, G + 0.08, 7.3 + i * 0.62);

  /* ---- medical office building + glazed link ---- */
  box(g, 2 * M.hw, MOB_H, 2 * M.hd, 'wallSand', M.cx, G, M.cz);
  box(g, 2 * M.hw + 0.18, 1.0, 2 * M.hd + 0.18, 'concrete', M.cx, G, M.cz);
  box(g, 2 * M.hw + 0.2, 0.3, 2 * M.hd + 0.2, 'wallWhite', M.cx, MT - 0.3, M.cz);
  windowGrid(g, { face: '+z', cx: M.cx, cz: M.cz, hw: M.hw, hd: M.hd, rows: 3, cols: 2, y0: G + 1.25, pitchY: 2.75, winW: 1.35, winH: 1.45, span: 4.2, frames: true });
  windowGrid(g, { face: '-z', cx: M.cx, cz: M.cz, hw: M.hw, hd: M.hd, rows: 3, cols: 2, y0: G + 1.25, pitchY: 2.75, winW: 1.35, winH: 1.45, span: 4.2, frames: true });
  windowGrid(g, { face: '+x', cx: M.cx, cz: M.cz, hw: M.hw, hd: M.hd, rows: 3, cols: 3, y0: G + 1.25, pitchY: 2.75, winW: 1.2, winH: 1.45, span: 6.6, frames: true });
  windowGrid(g, { face: '-x', cx: M.cx, cz: M.cz, hw: M.hw, hd: M.hd, rows: 3, cols: 2, y0: G + 1.25, pitchY: 2.75, winW: 1.2, winH: 1.45, span: 4.4, frames: true });
  flatRoof(g, M, MT, 0.62);
  hvacUnit(g, 12.4, MT + 0.06, -6.9, 1.8, 1.3);
  box(g, 2.0, 1.6, 2.0, 'wallTeal', 14.3, MT + 0.06, -8.4);
  box(g, 2.2, 0.22, 2.2, 'roofInk', 14.3, MT + 1.66, -8.4);
  stack(g, 11.2, MT + 0.06, -2.5, 0.8);
  // MOB entrance facing its forecourt
  box(g, 2.5, 3.5, 1.0, 'glass', 11.0, G, -0.6);
  box(g, 2.7, 0.2, 1.2, 'wallWhite', 11.0, G + 3.5, -0.6);
  doubleDoor(g, { face: '+z', plane: -0.1, along: 11.0, y: G + 0.1, w: 2.0, h: 2.4 });
  box(g, 3.2, 0.22, 1.7, 'wallWhite', 11.0, 3.85, 0.45);
  box(g, 3.3, 0.3, 0.12, 'ink', 11.0, 3.77, 1.24);
  for (const x of [9.8, 12.2]) {
    box(g, 0.7, 0.05, 0.7, 'glow', x, 3.79, 0.6);
  }
  box(g, 0.9, 0.12, 1.8, 'concrete', 11.0, G, 1.4);
  // link
  const link: Block = { cx: 8.45, cz: -5.3, hw: 0.95, hd: 1.3 };
  box(g, 2 * link.hw, 3.5, 2 * link.hd, 'glass', link.cx, G, link.cz);
  box(g, 2 * link.hw + 0.16, 0.25, 2 * link.hd + 0.16, 'wallWhite', link.cx, G + 3.5, link.cz);
  for (const z of [-6.6, -4.0]) {
    fBox(g, '+z', z, 'ink', link.cx, G + 0.2, 0.0, 1.9, 0.2, 0.14);
    fBox(g, '+z', z, 'glow', link.cx, G + 0.9, 0.0, 1.5, 1.5, 0.06);
  }
  for (const x of [7.6, 9.3]) box(g, 0.16, 3.5, 0.16, 'ink', x, G, link.cz - 1.25);

  /* ---- parking, entrance furniture ---- */
  car(g, 14.3, 2.1, 'wallBlue');
  car(g, 14.3, 4.5, 'wallYellow');
  car(g, 14.3, 9.3, 'wallSand');
  lampPole(g, 9.6, 1.9);
  lampPole(g, 9.6, 7.8);
  lampPole(g, -0.1, 12.8);
  lampPole(g, -14.2, 12.9, 4.4);
  parkingSign(g, 12.7, 11.1);
  hydrant(g, -13.8, 14.5);
  busStop(g, -1.0, 14.55);
  bench(g, -2.0, 13.6);
  hedge(g, -2.1, 10.8, 2.6);
  emergencySign(g, -8.5, 14.55);
  hospitalSign(g, 7.9, 14.55);
  for (const b of [
    [-0.35, 4.3],
    [-0.35, 13.5],
    [8.65, 4.3],
    [8.65, 13.5],
    [1.2, 13.5],
    [7.6, 13.5],
  ]) {
    bollard(g, b[0], b[1]);
  }
  flagpole(g, -16.2, 10.2);
  plainFlag(g, -16.2, 12.2);
  monument(g, 14.8, 13.3);
  for (const t of [
    [-16.1, -4.6, 0.95],
    [-16.1, 6.1, 0.8],
    [-12.0, -7.2, 1.0],
    [-15.7, -10.7, 0.9],
    [-2.3, 11.9, 0.8],
    [16.1, -12.7, 0.8],
  ]) {
    tree(g, t[0], t[1], t[2]);
  }

  /* ---- service side: generator yard, loading dock, O2 ---- */
  box(g, 8.6, 0.05, 4.1, 'concrete', -12.5, G, -14.95);
  generator(g, -13.2, -15.1);
  fence(g, -17, -12.9, -8.6, -12.9);
  fence(g, -17, -17, -8.6, -17);
  fence(g, -17, -17, -17, -12.9);
  refuseBin(g, -9.4, -14.0);
  refuseBin(g, -8.6, -14.0, 'steel');
  drive(g, 0.3, -15.15, 17.0, 3.3);
  drive(g, 12.8, -13.35, 8.0, 6.9);
  loadingDock(g, { x: 12.6, zWall: -9.9, dir: -1, w: 4.6 });
  boxTruck(g, 12.6, -13.54, Math.PI / 2, 'wallWhite', 0.8);
  refuseBin(g, 9.7, -11.4);
  refuseBin(g, 9.7, -12.4, 'steel');
  dumpster(g, 9.9, -15.2);
  fence(g, 16.8, -16.8, 16.8, -10.0);
  fence(g, 8.8, -16.7, 16.8, -16.7);
  // oxygen bank against the tower's west wall
  o2Bank(g, -7.9, -9.5);
  gasLine(g, -7.0, -6.5, G + 2.4, -9.5);

  /* ---- roof plant on the ED and lobby ---- */
  box(g, 0.9, 0.9, 0.9, 'steel', -0.4, WT + 0.55, 5.6);
  box(g, 1.2, 0.16, 1.2, 'concrete', -0.4, WT + 0.4, 5.6);
  stack(g, -2.0, WT + 0.4, 6.4, 0.7);
}

/* ================================================================ campus B */

function campusB(g: THREE.Group): void {
  const T: Block = { cx: 8.5, cz: -9, hw: 6.5, hd: 5.5 };
  const E: Block = { cx: -7, cz: 3.7, hw: 7, hd: 3.7 };
  const C: Block = { cx: 3.5, cz: 3.7, hw: 3.5, hd: 3.7 };
  const A: Block = { cx: 4.5, cz: -1.75, hw: 2.5, hd: 1.75 };
  const TT = G + TOWER_H;
  const WT = G + WING_H;
  const MT = G + MOB_H;

  /* ---- site ---- */
  box(g, 34, G, 34, 'paving', 0, 0, 0);
  street(g, [
    [-16.8, -14.4],
    [-12.5, -9.5],
    [2.0, 4.8],
    [9.2, 12.0],
  ]);
  lawn(g, -2.2, 10.7, 4.0, 6.6);
  lawn(g, 14.8, 12.4, 4.0, 3.2);
  lawn(g, -8.0, -12.5, 11.0, 7.5);
  lawn(g, 0.0, -8.2, 3.4, 6.0);
  drive(g, -7.0, 10.45, 11.0, 6.1);
  drive(g, 3.6, 11.8, 6.8, 3.2);
  drive(g, 13.0, 5.6, 7.6, 9.6);
  drive(g, 10.6, 12.25, 2.8, 3.7);
  drive(g, -15.6, 0.0, 2.4, 27.0);
  box(g, 18.6, 0.07, 15.5, 'concrete', -6.1, G, -8.45);
  // walks
  walk(g, 3.4, 11.9, 1.6, 4.2);
  walk(g, -4.0, 10.7, 1.2, 6.6);
  walk(g, 8.25, 7.0, 1.3, 14.0);
  walk(g, 8.0, 4.6, 1.5, 1.4);
  walk(g, 9.0, 0.3, 2.6, 1.4);
  box(g, 5.0, 0.16, 0.22, 'concrete', 14.3, G, 10.4);
  box(g, 0.22, 0.16, 9.7, 'concrete', 16.8, G, 5.6);
  for (const z of [3.3, 5.7, 8.1]) box(g, 4.8, 0.02, 0.14, 'wallWhite', 14.4, G + 0.07, z);
  box(g, 4.8, 0.02, 0.14, 'wallWhite', 14.4, G + 0.07, 0.8);
  box(g, 0.14, 0.02, 9.6, 'wallWhite', 12.0, G + 0.07, 5.6);
  for (const z of [2.1, 4.5, 9.3]) box(g, 0.9, 0.16, 0.34, 'concrete', 16.1, G + 0.07, z);
  box(g, 0.3, 0.02, 2.2, 'wallWhite', 10.4, G + 0.07, 5.0);
  box(g, 0.8, 0.02, 0.28, 'wallWhite', 10.4, G + 0.07, 6.2);
  box(g, 0.28, 0.02, 0.8, 'wallWhite', 10.4, G + 0.07, 6.0);
  for (const z of [8.95, 13.35]) box(g, 7.0, 0.02, 0.14, 'wallWhite', -9.3, G + 0.07, z);
  for (const x of [-12.7, -5.9]) box(g, 0.14, 0.02, 4.4, 'wallWhite', x, G + 0.07, 11.15);
  box(g, 7.0, 0.02, 0.14, 'wallWhite', -3.4, G + 0.07, 11.6);
  box(g, 7.0, 0.02, 0.14, 'wallWhite', -3.4, G + 0.07, 13.4);
  pixelText(g, 'AMBULANCE', { x: -9.3, y: G + 0.075, z: 11.9, cell: 0.045, face: '+y', mat: 'wallWhite', align: 'center', depth: 0.012 });

  /* ---- ward tower ---- */
  box(g, 2 * T.hw, TOWER_H, 2 * T.hd, 'wallWhite', T.cx, G, T.cz);
  towerBands(g, T, 7, G + 1.55, 2.95, 1.65);
  crossSign(g, T.cx, T.cz + T.hd, 15.0);
  flatRoof(g, T, TT, 0.92);
  glowCross(g, T.cx, T.cz + T.hd + 0.02, TT + 0.98);
  helipad(g, 7.4, TT + 0.07, -9.2, 3.2);
  hvacUnit(g, 12.6, TT + 0.07, -6.4, 2.2, 1.6);
  hvacUnit(g, 12.6, TT + 0.07, -10.4, 2.2, 1.6);
  stack(g, 3.0, TT + 0.07, -4.4);
  stack(g, 3.0, TT + 0.07, -13.6, 0.8);
  roofHatch(g, 4.0, TT + 0.07, -12.2);
  windsock(g, 11.4, TT + 0.07, -13.6);
  core(g, { x: 13.5, z: -15.45, w: 2.2, d: 1.9, y0: G, top: 24.3 });
  for (const [x, z] of [
    [2.07, -5.0],
    [14.93, -5.0],
    [14.93, -13.0],
    [2.07, -13.0],
  ]) {
    cyl(g, 0.09, 0.09, TT - G, 'steel', x, G, z, 8);
    box(g, 0.16, 0.1, 0.16, 'steelDark', x, G + 0.02, z);
  }
  powerBracket(g, { face: '+z', plane: T.cz + T.hd, along: 14.0, y: 10.6 });

  /* ---- emergency department / base ---- */
  box(g, 2 * E.hw, WING_H, 2 * E.hd, 'wallCream', E.cx, G, E.cz);
  box(g, 2 * E.hw + 0.16, 1.0, 2 * E.hd + 0.2, 'concrete', E.cx, G, E.cz);
  box(g, 2 * E.hw + 0.2, 0.34, 2 * E.hd + 0.24, 'wallWhite', E.cx, WT - 0.34, E.cz);
  box(g, 2 * E.hw + 0.1, 0.24, 0.2, 'red', E.cx, WT - 0.58, E.cz + E.hd + 0.04);
  for (const x of [-13.8, -8.5, -3.5]) {
    box(g, 0.4, WING_H - 0.6, 0.16, 'wallSand', x, G + 0.3, E.cz + E.hd + 0.06);
  }
  for (const x of [-12.9, -11.4, -9.9, -8.4, -6.9, -5.4]) {
    windowUnit(g, { face: '+z', plane: E.cz + E.hd, along: x, y: G + 5.0, w: 1.2, h: 1.05 });
  }
  for (const z of [1.7, 5.2]) {
    windowUnit(g, { face: '-x', plane: E.cx - E.hw, along: z, y: G + 3.5, w: 1.3, h: 1.6 });
  }
  flatRoof(g, E, WT, 0.55);
  hvacUnit(g, -9.0, WT + 0.05, 4.8, 2.0, 1.4);
  stack(g, -12.0, WT + 0.05, 5.6);
  roofHatch(g, -4.0, WT + 0.05, 2.0);
  ambulanceCanopy(g, -9.3, E.cz + E.hd, 8.6, 3.5);
  doubleDoor(g, { face: '+z', plane: E.cz + E.hd, along: -9.3, y: G + 0.1, w: 3.2, h: 2.6 });
  for (const s of [-1, 1]) {
    fBox(g, '+z', E.cz + E.hd, 'glow', -9.3 + s * 2.35, G + 0.35, 0.0, 0.5, 2.0, 0.06);
    fBox(g, '+z', E.cz + E.hd, 'wallWhite', -9.3 + s * 2.37, G + 0.18, 0.06, 0.66, 2.35, 0.12);
  }
  ambulance(g, -9.3, 9.0);
  ambulance(g, -3.6, 12.4);
  for (const [x, z, w, d] of [
    [-4.35, 10.45, 0.2, 6.1],
    [-14.45, 10.45, 0.2, 6.1],
    [-7.0, 13.55, 11.0, 0.2],
  ]) {
    box(g, w, 0.16, d, 'concrete', x, G, z);
  }

  /* ---- clinic bar (MOB) and its entrance ---- */
  box(g, 2 * C.hw, MOB_H, 2 * C.hd, 'wallSand', C.cx, G, C.cz);
  box(g, 2 * C.hw + 0.18, 1.0, 2 * C.hd + 0.18, 'concrete', C.cx, G, C.cz);
  box(g, 2 * C.hw + 0.2, 0.3, 2 * C.hd + 0.2, 'wallWhite', C.cx, MT - 0.3, C.cz);
  box(g, 0.22, WT - G, 0.18, 'ink', 0.0, G, C.cz + C.hd + 0.04);
  windowGrid(g, { face: '+z', cx: C.cx, cz: C.cz, hw: C.hw, hd: C.hd, rows: 3, cols: 2, y0: G + 1.3, pitchY: 2.75, winW: 1.25, winH: 1.45, span: 4.4, frames: true });
  windowGrid(g, { face: '+x', cx: C.cx, cz: C.cz, hw: C.hw, hd: C.hd, rows: 3, cols: 2, y0: G + 1.3, pitchY: 2.75, winW: 1.2, winH: 1.45, span: 4.4, frames: true });
  windowGrid(g, { face: '-z', cx: C.cx, cz: C.cz, hw: C.hw, hd: C.hd, rows: 3, cols: 1, y0: G + 1.3, pitchY: 2.75, winW: 1.2, winH: 1.45, frames: true });
  flatRoof(g, C, MT, 0.62);
  hvacUnit(g, 2.4, MT + 0.06, 3.4, 1.8, 1.3);
  box(g, 1.8, 1.6, 1.8, 'wallTeal', 5.8, MT + 0.06, 1.5);
  box(g, 2.0, 0.22, 2.0, 'roofInk', 5.8, MT + 1.66, 1.5);
  // clinic entrance on the east face, facing the walk and the lot
  box(g, 1.0, 4.2, 2.4, 'glass', 7.45, G, 4.6);
  box(g, 1.2, 0.24, 2.6, 'wallWhite', 7.45, G + 4.2, 4.6);
  doubleDoor(g, { face: '+x', plane: 7.95, along: 4.6, y: G + 0.1, w: 1.9, h: 2.4 });
  box(g, 1.7, 0.2, 3.2, 'wallWhite', 8.25, 3.85, 4.6);
  box(g, 0.12, 0.28, 3.3, 'wallBlue', 9.06, 3.76, 4.6);
  for (const z of [3.5, 5.7]) box(g, 0.7, 0.05, 0.7, 'glow', 8.0, 3.79, z);
  for (const x of [7.4, 8.25]) box(g, 0.9, 0.12, 0.9, 'concrete', x, G, 2.9);
  box(g, 1.4, 0.12, 1.4, 'concrete', 8.1, G, 2.9);

  /* ---- glazed atrium in the inside corner ---- */
  box(g, 2 * A.hw, MOB_H, 2 * A.hd, 'glass', A.cx, G, A.cz);
  box(g, 2 * A.hw + 0.24, 0.3, 2 * A.hd + 0.24, 'roofInk', A.cx, G + MOB_H, A.cz);
  box(g, 2 * A.hw + 0.12, 0.12, 2 * A.hd + 0.12, 'concrete', A.cx, G + MOB_H - 0.16, A.cz);
  windowGrid(g, { face: '+x', cx: A.cx, cz: A.cz, hw: A.hw, hd: A.hd, rows: 3, cols: 1, y0: G + 1.2, pitchY: 2.8, winW: 2.4, winH: 1.8 });
  windowGrid(g, { face: '-x', cx: A.cx, cz: A.cz, hw: A.hw, hd: A.hd, rows: 3, cols: 1, y0: G + 1.2, pitchY: 2.8, winW: 2.4, winH: 1.8 });
  for (const z of [-2.7, -1.75, -0.8]) box(g, 0.16, MOB_H, 0.16, 'steelDark', 7.0, G, z);
  for (const z of [-2.7, -1.75, -0.8]) box(g, 0.16, MOB_H, 0.16, 'steelDark', 2.0, G, z);

  /* ---- main entrance ---- */
  entranceCanopy(g, 3.4, C.cz + C.hd, 5.0, 2.8);
  doubleDoor(g, { face: '+z', plane: C.cz + C.hd, along: 3.4, y: G + 0.1, w: 2.6, h: 2.6 });
  for (const s of [-1, 1]) {
    fBox(g, '+z', C.cz + C.hd, 'glow', 3.4 + s * 1.65, G + 0.35, 0.0, 0.55, 2.0, 0.06);
    fBox(g, '+z', C.cz + C.hd, 'wallWhite', 3.4 + s * 1.67, G + 0.18, 0.06, 0.72, 2.35, 0.12);
  }
  for (const x of [1.4, 5.4]) {
    box(g, 0.9, 0.42, 0.7, 'concrete', x, G, 8.0);
    bush(g, x, 8.0, 0.6);
  }
  for (let i = 0; i < 5; i++) box(g, 1.4, 0.02, 0.32, 'wallWhite', 3.4, G + 0.08, 10.5 + i * 0.6);

  /* ---- parking and furniture ---- */
  car(g, 14.3, 2.1, 'wallYellow');
  car(g, 14.3, 4.5, 'wallBlue');
  car(g, 14.3, 9.3, 'wallSand');
  lampPole(g, 9.6, 1.9);
  lampPole(g, 9.6, 7.8);
  lampPole(g, 0.0, 12.9);
  lampPole(g, 8.1, 13.3, 4.4);
  parkingSign(g, 8.9, 11.6);
  hydrant(g, -10.9, 14.5);
  busStop(g, -0.9, 14.55);
  bench(g, -2.4, 13.4);
  hedge(g, -2.2, 10.2, 2.8);
  emergencySign(g, -7.6, 14.55);
  hospitalSign(g, 12.4, 14.55);
  for (const b of [
    [-0.3, 10.5],
    [-0.3, 13.3],
    [7.1, 10.5],
    [7.1, 13.3],
    [7.9, 2.6],
    [7.9, 6.6],
  ]) {
    bollard(g, b[0], b[1]);
  }
  flagpole(g, 13.5, 11.5);
  plainFlag(g, 16.0, 11.5);
  monument(g, 14.8, 13.35);
  for (const t of [
    [-2.3, 11.4, 0.8],
    [-4.7, -12.4, 0.9],
    [-11.8, -13.7, 0.95],
    [1.0, -11.8, 0.85],
    [-13.4, -2.6, 0.8],
  ]) {
    tree(g, t[0], t[1], t[2]);
  }

  /* ---- service yard back-left ---- */
  generator(g, -14.0, -9.6);
  loadingDock(g, { x: -8.5, zWall: 0, dir: -1, w: 4.6 });
  boxTruck(g, -8.5, -4.18, Math.PI / 2);
  o2Bank(g, -1.3, -6.2);
  gasLine(g, -0.6, 2.0, G + 2.4, -6.2);
  refuseBin(g, -5.6, -2.5);
  refuseBin(g, -6.4, -2.5, 'steel');
  dumpster(g, -12.4, -3.2);
  fence(g, -16.8, -16.8, 1.7, -16.8);
  fence(g, -16.8, -16.8, -16.8, 13.4);
  fence(g, -16.8, 13.4, -14.4, 13.4);
  box(g, 8.0, 1.8, 0.75, 'steel', -12.0, -11.6, 0);
  box(g, 8.0, 0.2, 0.8, 'steelDark', -12.0, -9.8, 0);
  // paved apron behind the base
  box(g, 12.0, 0.06, 5.5, 'concrete', -8.0, G, -3.0);
}

/* ==================================================================== build */

export const build: ModelBuilder = ({ variant }) => {
  const g = new THREE.Group();
  if (variant === 1) campusB(g);
  else campusA(g);
  return g;
};


