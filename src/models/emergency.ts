// American fire / police-rescue station. Footprint 2x2 cells = 24 x 24 m.
// Origin = footprint centre at ground level, Y up, front (+Z) faces the street.
//
// Variant 0: coral-brick fire station — three apparatus bays, hose-drying tower,
// radio mast, red pumper nose-out, ambulance, forecourt with guide lines and flag.
// Variant 1: police & rescue station — blue/white masonry, radar dish, blue rescue
// truck, squad car in the staff lot.
//
// The site is read like a working small-town station: every part belongs to a system
// (structure, glazing, apparatus doors, roof plant, forecourt, grounds) and sits on
// another part. Materials only from MAT. Deterministic: the variant is the only input.
import * as THREE from 'three';
import { MAT, type MatName } from '../render/palette';
import {
  box,
  cyl,
  rod,
  sphere,
  hipRoof,
  spin,
  insulator,
  setPowerPorts,
  type Face,
  type ModelBuilder,
} from './kit';

export const VARIANTS = 2;

/** Lot slab top. Everything on the site sits on this plane. */
const B = 0.12;
/** Apron paving top. Forecourt vehicles sit on it. */
const APRON = B + 0.06;

/** Station footprint (facade planes) and half width. */
const FRONT_Z = -1.2;
const BACK_Z = -8.8;
const SZ = (FRONT_Z + BACK_Z) / 2;
const HW = 6.7;
const BW = HW * 2;

/** Storey levels (absolute Y). */
const GF_H = 4.05;
const GT = B + GF_H; // top of ground floor / string course base
const UB = GT + 0.2; // upper floor base
const UF_H = 3.1;
const CB = UB + UF_H; // cornice base
const SLAB = CB + 0.26; // roof slab base
const ROOF = SLAB + 0.14; // roof deck (plant sits here)
const PARAPET = 0.52;
const RTOP = ROOF + PARAPET + 0.12;

/** Three apparatus bays across the front. */
const BAYS = [-3.4, 0, 3.4] as const;
const BAY_W = 3.0;
const BAY_H = 3.5;
/** Rear corner program. */
const TOWER = { x: 5.9, z: -9.7 } as const;
const ANNEX = { x: -4.3, z: -9.6 } as const;

interface Look {
  wall: MatName; // ground-floor masonry and parapet
  upper: MatName; // upper storey wall
  pier: MatName; // piers and base accents
  quoin: MatName; // corner quoins on the upper storey
  trim: MatName; // white string course, cornice, frames
  roof: MatName; // tower cap, canopy accents
  body: MatName; // apparatus body
  rescue: boolean; // blue rescue truck instead of a pumper
  radar: boolean; // radar dish instead of the radio mast
  sign: string;
  plate: string; // monument / apron lettering
}

const FIRE_LOOK: Look = {
  wall: 'wallCoral',
  upper: 'wallCoral',
  pier: 'wallCream',
  quoin: 'wallCream',
  trim: 'wallWhite',
  roof: 'roofCoral',
  body: 'red',
  rescue: false,
  radar: false,
  sign: 'FIRE RESCUE',
  plate: 'STATION 1',
};

const POLICE_LOOK: Look = {
  wall: 'wallBlue',
  upper: 'wallWhite',
  pier: 'wallWhite',
  quoin: 'wallBlue',
  trim: 'wallWhite',
  roof: 'roofBlue',
  body: 'blue',
  rescue: true,
  radar: true,
  sign: 'POLICE RESCUE',
  plate: 'RESCUE 2',
};

/* ================================================================ primitives */

/** Plain mesh for shapes the kit cannot make (arcs, tori, angled parts, wheels). */
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

/** A box on a wall face: along = coordinate along the face, out = gap from the wall. */
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
  if (face === '+z' || face === '-z') {
    return box(g, w, h, d, mat, along, y, plane + ns * (out + d / 2));
  }
  return box(g, d, h, w, mat, plane + ns * (out + d / 2), y, along);
}

function normalOf(face: Face): { x: number; z: number } {
  if (face === '+z') return { x: 0, z: 1 };
  if (face === '-z') return { x: 0, z: -1 };
  if (face === '+x') return { x: 1, z: 0 };
  return { x: -1, z: 0 };
}

/* ================================================================ lettering */

/** 5x7 block alphabet, enough for station signs and apparatus lettering. */
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
};

/**
 * Draw block letters. Faces are named by their outward normal; text always reads
 * correctly from in front of that face. `+y` lies flat on the ground, readable
 * from +Z (top of the letters toward -Z).
 */
function pixelText(
  g: THREE.Object3D,
  text: string,
  o: {
    x: number;
    y: number;
    z: number;
    cell: number;
    face: '+z' | '-z' | '+x' | '-x' | '+y';
    mat: MatName;
    align?: 'left' | 'center';
    depth?: number;
  },
): number {
  const cell = o.cell;
  const dep = o.depth ?? 0.06;
  const s = cell * 0.82;
  const total = text.length * 6 * cell - cell;
  const left = o.align === 'center' ? -total / 2 : 0;
  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPHS[text[i].toUpperCase()] ?? GLYPHS[' '];
    for (let r = 0; r < 7; r++) {
      // merge each horizontal run of lit cells into one slab: same silhouette, far fewer parts
      for (let c = 0; c < 5; c++) {
        if (glyph[r][c] !== '1') continue;
        let n = 1;
        while (c + n < 5 && glyph[r][c + n] === '1') n++;
        const w = s + (n - 1) * cell;
        const a = (i * 6 + c) * cell + ((n - 1) * cell) / 2;
        const y = o.y + (6 - r) * cell + cell * 0.09;
        if (o.face === '+z') {
          box(g, w, s, dep, o.mat, o.x + left + a, y, o.z);
        } else if (o.face === '-z') {
          box(g, w, s, dep, o.mat, o.x - left - a, y, o.z);
        } else if (o.face === '+y') {
          // flat on the ground; row 0 (top of the glyph) sits toward -Z
          box(g, w, dep, s, o.mat, o.x + left + a, o.y, o.z - (6 - r) * cell + cell * 0.09);
        } else if (o.face === '+x') {
          box(g, dep, s, w, o.mat, o.x, y, o.z - left - a);
        } else {
          box(g, dep, s, w, o.mat, o.x, y, o.z + left + a);
        }
        c += n - 1;
      }
    }
  }
  return total;
}

/* ================================================================ facade kit */

/** Two-hand window: glow pane, white casing, ink meeting rail and stone sill. */
function windowUnit(
  g: THREE.Object3D,
  o: {
    face: Face;
    plane: number;
    along: number;
    y: number;
    w: number;
    h: number;
    muntin?: boolean;
    sill?: boolean;
  },
): void {
  const f: MatName = 'wallWhite';
  const w = o.w;
  const h = o.h;
  fBox(g, o.face, o.plane, 'glow', o.along, o.y + 0.03, -0.02, w, h, 0.07);
  fBox(g, o.face, o.plane, f, o.along - w / 2 - 0.1, o.y - 0.12, 0.02, 0.2, h + 0.24, 0.2);
  fBox(g, o.face, o.plane, f, o.along + w / 2 + 0.1, o.y - 0.12, 0.02, 0.2, h + 0.24, 0.2);
  fBox(g, o.face, o.plane, f, o.along, o.y + h + 0.04, 0.02, w + 0.4, 0.2, 0.2);
  fBox(g, o.face, o.plane, f, o.along, o.y - 0.11, 0.02, w + 0.4, 0.2, 0.2);
  fBox(g, o.face, o.plane, 'ink', o.along, o.y + h * 0.52, 0.07, w - 0.12, 0.08, 0.1);
  if (o.muntin !== false) fBox(g, o.face, o.plane, 'ink', o.along, o.y, 0.07, 0.08, h - 0.1, 0.1);
  if (o.muntin) {
    fBox(g, o.face, o.plane, 'ink', o.along - w / 4, o.y + h * 0.54, 0.07, 0.06, h * 0.44, 0.1);
    fBox(g, o.face, o.plane, 'ink', o.along + w / 4, o.y + h * 0.54, 0.07, 0.06, h * 0.44, 0.1);
  }
  if (o.sill !== false) fBox(g, o.face, o.plane, 'concrete', o.along, o.y - 0.26, 0.0, w + 0.5, 0.14, 0.32);
}

/** Glazed leaf door with a transom, white surround and kick plate. */
function glazedDoor(
  g: THREE.Object3D,
  o: { face: Face; plane: number; along: number; y: number; w: number; h: number; frame?: MatName },
): void {
  const w = o.w;
  const h = o.h;
  const su = o.frame ?? 'wallWhite';
  fBox(g, o.face, o.plane, su, o.along, o.y - 0.06, 0.0, w + 0.44, 0.18, 0.24);
  fBox(g, o.face, o.plane, su, o.along - w / 2 - 0.14, o.y - 0.06, 0.0, 0.28, h + 0.24, 0.24);
  fBox(g, o.face, o.plane, su, o.along + w / 2 + 0.14, o.y - 0.06, 0.0, 0.28, h + 0.24, 0.24);
  fBox(g, o.face, o.plane, su, o.along, o.y + h + 0.14, 0.0, w + 0.56, 0.26, 0.26);
  fBox(g, o.face, o.plane, 'ink', o.along, o.y, 0.06, w + 0.04, h, 0.12);
  fBox(g, o.face, o.plane, 'glow', o.along, o.y + 0.12, 0.03, w - 0.14, h - 0.34, 0.06);
  fBox(g, o.face, o.plane, 'ink', o.along, o.y + 0.06, 0.16, w - 0.14, 0.46, 0.06);
  fBox(g, o.face, o.plane, su, o.along, o.y + h - 0.06, 0.15, 0.06, h - 0.2, 0.06);
  const n = normalOf(o.face);
  if (o.face === '+z' || o.face === '-z') {
    box(g, 0.06, 0.42, 0.08, 'steel', o.along + 0.22, o.y + 0.85, o.plane + n.z * 0.2);
  } else {
    box(g, 0.08, 0.42, 0.06, 'steel', o.plane + n.x * 0.2, o.y + 0.85, o.along + 0.22);
  }
}

/** Flat roof: ink deck with seams, parapet and a concrete coping. */
function flatRoof(
  g: THREE.Object3D,
  b: { cx: number; cz: number; hw: number; hd: number },
  top: number,
  ph: number,
  mat: MatName,
): void {
  const t = 0.32;
  box(g, 2 * b.hw - 0.3, 0.05, 2 * b.hd - 0.3, 'roofInk', b.cx, top, b.cz);
  for (let z = b.cz - b.hd + 1.2; z < b.cz + b.hd - 0.8; z += 1.5) {
    box(g, 2 * b.hw - 0.5, 0.035, 0.035, 'steelDark', b.cx, top + 0.05, z);
  }
  const zF = b.cz + b.hd - t / 2;
  const zB = b.cz - b.hd + t / 2;
  const xR = b.cx + b.hw - t / 2;
  const xL = b.cx - b.hw + t / 2;
  box(g, 2 * b.hw, ph, t, mat, b.cx, top, zF);
  box(g, 2 * b.hw, ph, t, mat, b.cx, top, zB);
  box(g, t, ph, 2 * b.hd - 2 * t, mat, xR, top, b.cz);
  box(g, t, ph, 2 * b.hd - 2 * t, mat, xL, top, b.cz);
  box(g, 2 * b.hw + 0.14, 0.12, t + 0.14, 'concrete', b.cx, top + ph, zF);
  box(g, 2 * b.hw + 0.14, 0.12, t + 0.14, 'concrete', b.cx, top + ph, zB);
  box(g, t + 0.14, 0.12, 2 * b.hd - 2 * t, 'concrete', xR, top + ph, b.cz);
  box(g, t + 0.14, 0.12, 2 * b.hd - 2 * t, 'concrete', xL, top + ph, b.cz);
}

/** Rooftop air handler: curb, louvres, duct and a spinning condenser fan. */
function hvacUnit(g: THREE.Object3D, x: number, y: number, z: number, w: number, d: number, h = 1.15): void {
  box(g, w + 0.24, 0.16, d + 0.24, 'concrete', x, y, z);
  box(g, w, h, d, 'steel', x, y + 0.16, z);
  box(g, w + 0.08, 0.1, d + 0.08, 'steelDark', x, y + 0.16 + h, z);
  for (let i = 0; i < 4; i++) box(g, w - 0.4, 0.06, 0.04, 'ink', x, y + 0.34 + i * 0.15, z + d / 2 + 0.02);
  const r = Math.min(w, d) * 0.29;
  cyl(g, r + 0.1, r + 0.1, 0.05, 'ink', x, y + 0.26 + h, z, 16);
  const fan = new THREE.Group();
  fan.position.set(x, y + 0.32 + h, z);
  for (let i = 0; i < 3; i++) {
    const blade = box(fan, r * 2, 0.04, 0.22, 'wallWhite', 0, 0, 0);
    blade.rotation.y = (i * Math.PI) / 3;
  }
  cyl(fan, 0.07, 0.07, 0.08, 'steelDark', 0, 0, 0, 8);
  spin(fan, 'y', 4);
  g.add(fan);
  cyl(g, 0.16, 0.16, 0.9, 'steelDark', x - w / 2 - 0.35, y + 0.16, z, 8);
  box(g, 0.7, 0.14, 0.7, 'concrete', x - w / 2 - 0.35, y, z);
}

/** Small exhaust stack with a rain cap. */
function stack(g: THREE.Object3D, x: number, y: number, z: number, h = 0.9): void {
  cyl(g, 0.14, 0.17, h, 'steel', x, y, z, 10);
  cyl(g, 0.24, 0.24, 0.08, 'steelDark', x, y + h, z, 10);
  box(g, 0.5, 0.05, 0.05, 'ink', x, y + h + 0.1, z);
}

/* ================================================================ grounds kit */

/** Round deciduous tree: trunk, two shade tones, a low shrub at the foot. */
function tree(g: THREE.Object3D, x: number, z: number, s = 1): void {
  cyl(g, 0.2 * s, 0.3 * s, 2.6 * s, 'wood', x, B, z, 8);
  sphere(g, 1.6 * s, 'green', x, B + 3.4 * s, z, 12);
  sphere(g, 1.2 * s, 'roofGreen', x + 0.9 * s, B + 2.9 * s, z + 0.35 * s, 10);
  sphere(g, 1.05 * s, 'green', x - 0.7 * s, B + 3.0 * s, z - 0.5 * s, 10);
  sphere(g, 0.5 * s, 'roofGreen', x + 0.5 * s, B + 0.5 * s, z - 0.3 * s, 8);
}

function bush(g: THREE.Object3D, x: number, z: number, s = 1): void {
  sphere(g, 0.56 * s, 'green', x, B + 0.38 * s, z, 9);
  sphere(g, 0.42 * s, 'roofGreen', x + 0.42 * s, B + 0.3 * s, z + 0.2 * s, 8);
}

/** Timber bench facing +Z on steel legs. */
function bench(g: THREE.Object3D, x: number, z: number): void {
  box(g, 2.2, 0.12, 0.56, 'wood', x, B + 0.46, z);
  box(g, 2.2, 0.4, 0.1, 'wood', x, B + 0.62, z - 0.26);
  for (const s of [-0.8, 0.8]) {
    box(g, 0.1, 0.46, 0.5, 'steelDark', x + s, B, z);
    box(g, 0.1, 0.6, 0.1, 'steelDark', x + s, B + 0.46, z - 0.26);
  }
}

/** Picnic table with attached benches and A-frame legs. */
function picnicTable(g: THREE.Object3D, x: number, z: number): void {
  box(g, 1.9, 0.1, 0.88, 'wood', x, B + 0.7, z);
  for (const s of [-0.64, 0.64]) box(g, 1.9, 0.08, 0.3, 'wood', x, B + 0.4, z + s);
  for (const s of [-0.72, 0.72]) {
    rod(g, { x: x + s, y: B, z: z - 0.5 }, { x: x + s, y: B + 0.7, z }, 0.055, 'steelDark', 5);
    rod(g, { x: x + s, y: B, z: z + 0.5 }, { x: x + s, y: B + 0.7, z }, 0.055, 'steelDark', 5);
  }
}

function trashCan(g: THREE.Object3D, x: number, z: number): void {
  cyl(g, 0.3, 0.27, 0.9, 'steelDark', x, B, z, 12);
  cyl(g, 0.33, 0.33, 0.08, 'ink', x, B + 0.9, z, 12);
  cyl(g, 0.31, 0.31, 0.07, 'blue', x, B + 0.5, z, 12);
}

/** Three inverted-U bike hoops on a concrete pad. */
function bikeRack(g: THREE.Object3D, x: number, z: number): void {
  box(g, 2.6, 0.06, 1.0, 'concrete', x, B, z);
  for (let i = 0; i < 3; i++) {
    const bx = x - 0.8 + i * 0.8;
    rod(g, { x: bx, y: B + 0.06, z: z - 0.32 }, { x: bx, y: B + 0.8, z: z - 0.32 }, 0.05, 'steel', 6);
    rod(g, { x: bx, y: B + 0.06, z: z + 0.32 }, { x: bx, y: B + 0.8, z: z + 0.32 }, 0.05, 'steel', 6);
    rod(g, { x: bx, y: B + 0.8, z: z - 0.32 }, { x: bx, y: B + 0.8, z: z + 0.32 }, 0.05, 'steel', 6);
  }
}

/** Red fire hydrant with side caps and a top nut. */
function hydrant(g: THREE.Object3D, x: number, z: number): void {
  cyl(g, 0.22, 0.26, 0.1, 'concrete', x, B, z, 10);
  cyl(g, 0.17, 0.19, 0.6, 'red', x, B + 0.1, z, 10);
  sphere(g, 0.19, 'red', x, B + 0.72, z, 10);
  cyl(g, 0.08, 0.09, 0.12, 'red', x, B + 0.9, z, 8);
  for (const s of [-1, 1]) {
    put(g, new THREE.CylinderGeometry(0.09, 0.09, 0.18, 8), 'red', x + s * 0.24, B + 0.48, z, 0, 0, Math.PI / 2);
  }
  box(g, 0.12, 0.05, 0.05, 'steelDark', x, B + 1.01, z);
}

/** Steel flagpole with a US flag (13 stripes, star field) and a gold finial. */
function flagpole(g: THREE.Object3D, x: number, z: number, h = 8.4): void {
  const ground = B + 0.05;
  box(g, 1.2, 0.16, 1.2, 'concrete', x, B, z);
  cyl(g, 0.3, 0.36, 0.22, 'concrete', x, B + 0.16, z, 12);
  cyl(g, 0.05, 0.075, h, 'steel', x, ground + 0.38, z, 10);
  sphere(g, 0.11, 'yellow', x, ground + 0.38 + h + 0.09, z, 10);
  const fw = 1.85;
  const fh = 1.05;
  const fy = ground + 0.38 + h - fh - 0.1;
  const fx = x + 0.08;
  box(g, fw, fh, 0.035, 'wallWhite', fx, fy, z);
  for (let i = 0; i < 7; i++) box(g, fw, 0.052, 0.04, 'red', fx, fy + 0.07 + i * 0.15, z + 0.006);
  box(g, fw * 0.42, fh * 0.54, 0.05, 'blue', fx, fy + fh * 0.46, z + 0.012);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      box(g, 0.036, 0.036, 0.03, 'wallWhite', fx + 0.11 + c * 0.135, fy + fh * 0.5 + r * 0.105, z + 0.04);
    }
  }
  rod(g, { x: x + 0.07, y: ground + 0.5, z }, { x: x + 0.07, y: ground + 0.38 + h, z }, 0.014, 'ink', 4);
  box(g, 0.1, 0.08, 0.24, 'steelDark', x - 0.08, ground + 1.0, z);
}

/** Low brick monument sign at the kerb with a lit nameplate. */
function monument(g: THREE.Object3D, look: Look, x: number, z: number): void {
  const w = 3.0;
  box(g, w + 0.3, 0.18, 1.2, 'concrete', x, B, z);
  box(g, w, 1.15, 0.62, look.wall, x, B + 0.18, z);
  box(g, w * 0.86, 0.95, 0.1, look.pier, x, B + 0.28, z + 0.3);
  box(g, w + 0.12, 0.14, 0.74, 'concrete', x, B + 1.33, z);
  box(g, w * 0.5, 0.16, 0.5, 'wallWhite', x, B + 1.47, z);
  for (const s of [-1, 1]) box(g, 0.24, 0.52, 0.24, look.wall, x + s * (w / 2 - 0.16), B + 1.47, z);
  pixelText(g, look.plate, { x, y: B + 0.52, z: z + 0.36, cell: 0.048, face: '+z', mat: 'ink', align: 'center', depth: 0.05 });
  // lit emblem above the plate
  box(g, 0.34, 0.34, 0.07, 'glow', x, B + 0.98, z + 0.36);
  box(g, 0.12, 0.46, 0.09, 'ink', x, B + 0.92, z + 0.39);
  box(g, 0.46, 0.12, 0.09, 'ink', x, B + 1.1, z + 0.39);
}

/** Forecourt lamp: octagonal pole, hooded head and a glow lens. */
function siteLamp(g: THREE.Object3D, x: number, z: number, h = 4.4): void {
  box(g, 0.44, 0.16, 0.44, 'concrete', x, B, z);
  cyl(g, 0.09, 0.14, h, 'steelDark', x, B + 0.16, z, 8);
  box(g, 0.5, 0.1, 0.5, 'ink', x, B + h + 0.1, z);
  box(g, 0.4, 0.06, 0.4, 'glow', x, B + h + 0.04, z);
  box(g, 0.56, 0.1, 0.56, 'steelDark', x, B + h + 0.2, z);
  box(g, 0.16, 0.14, 0.16, 'steelDark', x, B + h + 0.3, z);
}

/** Fuel island: kerbed pad, two posts, canopy with under-lights, pump and hose. */
function fuelIsland(g: THREE.Object3D, look: Look, x: number, z: number): void {
  box(g, 3.0, 0.16, 2.2, 'concrete', x, B, z);
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) cyl(g, 0.09, 0.09, 3.3, 'steel', x + s * 1.2, B + 0.16, z + t * 0.8, 8);
    box(g, 0.3, 0.24, 0.3, 'concrete', x + s * 1.2, B + 0.16, z + 0.0);
  }
  box(g, 3.3, 0.2, 2.5, look.roof, x, B + 3.5, z);
  box(g, 3.42, 0.24, 0.14, 'ink', x, B + 3.5, z + 1.19);
  pixelText(g, 'FUEL', { x, y: B + 3.56, z: z + 1.27, cell: 0.058, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.04 });
  for (const s of [-1, 1]) box(g, 0.34, 0.06, 0.34, 'glow', x + s * 0.95, B + 3.44, z);
  // pump on a low island
  box(g, 1.1, 0.22, 0.9, 'concrete', x, B + 0.16, z);
  box(g, 0.56, 1.25, 0.44, 'steelDark', x, B + 0.38, z);
  box(g, 0.6, 0.14, 0.48, 'ink', x, B + 1.63, z);
  box(g, 0.36, 0.26, 0.05, 'glow', x, B + 1.2, z + 0.23);
  box(g, 0.2, 0.1, 0.05, 'yellow', x, B + 0.95, z + 0.23);
  rod(g, { x: x + 0.3, y: B + 1.0, z: z + 0.1 }, { x: x + 0.72, y: B + 0.6, z: z + 0.28 }, 0.035, 'ink', 6);
  box(g, 0.16, 0.22, 0.12, 'steel', x + 0.78, B + 0.5, z + 0.3);
  // wheel stop, so nobody drives into the canopy posts
  box(g, 0.24, 0.16, 2.0, 'yellow', x + 1.35, B + 0.16, z);
}

/** Hose-reel cabinet: steel box with a red reel, crank and a short hose. */
function hoseCabinet(g: THREE.Object3D, x: number, z: number, rotY = 0): void {
  const c = new THREE.Group();
  c.position.set(x, B, z);
  c.rotation.y = rotY;
  g.add(c);
  box(c, 1.0, 1.3, 0.54, 'steelDark', 0, 0, 0);
  box(c, 1.04, 0.08, 0.58, 'ink', 0, 1.3, 0);
  box(c, 0.86, 0.9, 0.05, 'steel', 0, 0.24, 0.28);
  box(c, 0.1, 0.5, 0.06, 'ink', 0, 0.4, 0.31);
  put(c, new THREE.CylinderGeometry(0.26, 0.26, 1.22, 12), 'red', 0, 0.78, 0.0, 0, 0, Math.PI / 2);
  put(c, new THREE.CylinderGeometry(0.09, 0.09, 1.28, 8), 'ink', 0, 0.78, 0.0, 0, 0, Math.PI / 2);
  box(c, 0.1, 0.26, 0.1, 'steel', 0.62, 0.64, 0.0);
  rod(c, { x: 0.55, y: 0.7, z: 0 }, { x: 0.58, y: 0.2, z: 0.18 }, 0.045, 'wallWhite', 5);
}

/** Staff parking stall lines on an asphalt pad. */
function parkingPad(g: THREE.Object3D, x: number, z: number, w: number, d: number, n: number): void {
  box(g, w, 0.06, d, 'asphalt', x, B, z);
  for (let i = 0; i <= n; i++) {
    box(g, 0.1, 0.02, d - 0.3, 'wallWhite', x - w / 2 + 0.3 + (i * (w - 0.6)) / n, B + 0.06, z);
  }
  box(g, w - 0.4, 0.02, 0.1, 'wallWhite', x, B + 0.06, z - d / 2 + 0.35);
}

/* ================================================================ transport */

/** Wheel: ink tyre with a steel hub; axis along X. */
function wheel(parent: THREE.Object3D, x: number, y: number, z: number, r: number, w = 0.36): void {
  put(parent, new THREE.CylinderGeometry(r, r, w, 14), 'ink', x, y, z, 0, 0, Math.PI / 2);
  put(parent, new THREE.CylinderGeometry(r * 0.45, r * 0.45, w + 0.05, 10), 'steel', x, y, z, 0, 0, Math.PI / 2);
}

/** Parked car, front toward local +X; rotY turns it in the lot. */
function car(g: THREE.Object3D, o: { x: number; z: number; mat: MatName; rotY?: number; squad?: boolean }): void {
  const c = new THREE.Group();
  c.position.set(o.x, B, o.z);
  c.rotation.y = o.rotY ?? Math.PI / 2;
  g.add(c);
  const b = o.mat;
  box(c, 4.3, 0.62, 1.8, b, 0, 0.32, 0);
  box(c, 2.2, 0.62, 1.58, 'glass', -0.16, 0.94, 0);
  box(c, 1.9, 0.1, 1.62, b, -0.2, 1.55, 0);
  box(c, 1.3, 0.12, 1.56, b, -1.52, 0.9, 0);
  box(c, 1.0, 0.12, 1.56, b, 1.58, 0.9, 0);
  box(c, 0.1, 0.2, 1.74, 'steel', 2.2, 0.4, 0);
  box(c, 0.1, 0.2, 1.74, 'steel', -2.2, 0.4, 0);
  for (const zz of [-0.56, 0.56]) {
    box(c, 0.05, 0.14, 0.32, 'glow', 2.16, 0.66, zz);
    box(c, 0.05, 0.14, 0.32, 'red', -2.16, 0.66, zz);
  }
  // door seams and mirrors
  for (const zz of [-0.9, 0.9]) {
    box(c, 0.04, 0.5, 0.06, 'ink', -0.1, 0.95, zz);
    box(c, 0.14, 0.1, 0.22, 'ink', 1.0, 1.42, zz * 1.12);
  }
  if (o.squad) {
    box(c, 1.9, 0.16, 0.34, 'ink', -0.2, 1.65, 0);
    for (const s of [-0.6, 0.6]) box(c, 0.5, 0.08, 0.24, 'beacon', -0.2 + s, 1.73, 0);
    for (const zz of [-0.91, 0.91]) {
      box(c, 1.8, 0.22, 0.04, 'blue', -0.3, 0.62, zz);
      box(c, 0.42, 0.2, 0.04, 'wallWhite', 0.9, 0.62, zz);
    }
    pixelText(c, 'POLICE', { x: -0.6, y: 0.64, z: 0.93, cell: 0.028, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.03 });
  }
  for (const xx of [-1.35, 1.35]) {
    for (const zz of [-0.84, 0.84]) wheel(c, xx, 0.34, zz, 0.34, 0.24);
  }
}

/**
 * Apparatus: American pumper (fire) or walk-in rescue truck, ~8.4 m long,
 * nose toward local +Z, wheels on the ground plane of the group.
 */
function apparatus(g: THREE.Object3D, o: { kind: 'fire' | 'rescue'; mat: MatName; x: number; z: number; ground: number }): void {
  const t = new THREE.Group();
  t.position.set(o.x, o.ground, o.z);
  g.add(t);
  const body = o.mat;
  const fire = o.kind === 'fire';

  // frame rails and driveline
  box(t, 1.9, 0.26, 7.4, 'ink', 0, 0.52, -0.1);
  box(t, 1.4, 0.18, 2.4, 'steelDark', 0, 0.46, -1.6);
  for (const sx of [-1, 1]) box(t, 0.16, 0.2, 6.6, 'steelDark', sx * 0.86, 0.62, -0.4);

  // rear body
  box(t, 2.46, 1.8, 4.5, body, 0, 0.92, -1.75);
  box(t, 2.48, 0.2, 4.5, 'wallWhite', 0, 2.28, -1.75);
  box(t, 2.4, 0.18, 4.44, body, 0, 2.6, -1.75);
  box(t, 2.46, 0.3, 0.2, 'ink', 0, 0.8, 0.42);

  if (fire) {
    // hose bed with a tarp and two straps
    box(t, 2.1, 0.34, 2.9, 'red', 0, 2.78, -2.45);
    box(t, 2.16, 0.1, 2.95, 'steelDark', 0, 3.12, -2.45);
    for (const zz of [-3.3, -2.4, -1.5]) box(t, 2.2, 0.06, 0.1, 'ink', 0, 3.16, zz);
    // ground ladder on the bed
    for (const sx of [-0.56, 0.56]) rod(t, { x: sx, y: 3.26, z: -3.9 }, { x: sx, y: 3.26, z: 0.15 }, 0.06, 'steel', 6);
    for (let z = -3.7; z <= 0.1; z += 0.42) rod(t, { x: -0.56, y: 3.26, z }, { x: 0.56, y: 3.26, z }, 0.035, 'steel', 4);
    // two hose rolls poking out of the tail
    for (const sx of [-0.6, 0.6]) put(t, new THREE.CylinderGeometry(0.19, 0.19, 0.3, 10), 'red', sx, 2.95, -4.02, Math.PI / 2, 0, 0);
  } else {
    // rescue rack: steel tray, yellow hard cases, hydraulic boom
    box(t, 1.9, 0.42, 3.0, 'steelDark', 0, 2.78, -2.3);
    box(t, 1.2, 0.36, 1.0, 'yellow', 0, 3.2, -3.1);
    box(t, 1.0, 0.3, 0.8, 'yellow', 0.2, 3.2, -1.8);
    rod(t, { x: -0.3, y: 3.3, z: -3.5 }, { x: 0.1, y: 4.3, z: -2.4 }, 0.08, 'steel', 6);
    rod(t, { x: 0.1, y: 4.3, z: -2.4 }, { x: 0.4, y: 4.2, z: -1.2 }, 0.07, 'orange', 6);
    for (const sx of [-0.7, 0.7]) box(t, 0.1, 0.36, 0.1, 'steel', sx, 3.1, 0.1);
  }

  // side compartment doors with ink frames (3 per side)
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const zz = -3.35 + i * 1.28;
      box(t, 0.05, 0.95, 1.14, 'steel', sx * 1.235, 1.02, zz);
      box(t, 0.07, 0.08, 1.2, 'ink', sx * 1.245, 1.95, zz);
      box(t, 0.07, 0.08, 1.2, 'ink', sx * 1.245, 0.96, zz);
      box(t, 0.07, 0.88, 0.07, 'ink', sx * 1.245, 1.02, zz - 0.6);
      box(t, 0.07, 0.88, 0.07, 'ink', sx * 1.245, 1.02, zz + 0.6);
      box(t, 0.09, 0.1, 0.3, 'ink', sx * 1.27, 1.36, zz);
    }
    // step under the cab door and a rub rail along the body
    box(t, 0.42, 0.1, 1.1, 'steelDark', sx * 1.3, 0.5, 1.5);
    box(t, 0.06, 0.1, 4.4, 'ink', sx * 1.235, 2.16, -1.75);
    // mirrors
    rod(t, { x: sx * 1.18, y: 2.6, z: 2.5 }, { x: sx * 1.55, y: 2.72, z: 2.28 }, 0.05, 'ink', 5);
    box(t, 0.1, 0.34, 0.2, 'steel', sx * 1.58, 2.56, 2.28);
  }

  // pump panel on the right flank
  box(t, 0.06, 1.0, 1.0, 'steelDark', 1.26, 1.05, 0.0);
  for (const zz of [-0.3, 0.0, 0.3]) put(t, new THREE.CylinderGeometry(0.085, 0.085, 0.06, 10), 'glow', 1.3, 1.62, zz, 0, 0, Math.PI / 2);
  for (const zz of [-0.34, 0.0, 0.34]) rod(t, { x: 1.3, y: 1.2, z: zz }, { x: 1.42, y: 1.2, z: zz }, 0.035, 'steel', 4);

  // cab
  box(t, 2.42, 1.98, 2.1, body, 0, 0.92, 1.55);
  box(t, 2.46, 0.12, 2.14, body, 0, 2.9, 1.55);
  box(t, 2.44, 0.16, 2.16, 'wallWhite', 0, 2.2, 1.55);
  box(t, 2.14, 0.84, 0.1, 'glass', 0, 1.98, 2.6);
  for (const sx of [-1, 1]) box(t, 0.09, 0.9, 1.0, 'glass', sx * 1.235, 1.96, 1.72);
  box(t, 2.2, 0.12, 0.14, 'ink', 0, 2.82, 2.6);
  box(t, 2.2, 0.12, 0.14, 'ink', 0, 1.9, 2.6);
  for (const sx of [-1, 1]) {
    box(t, 0.09, 1.5, 0.1, 'ink', sx * 1.06, 1.9, 2.6);
    for (const zz of [1.2, 1.9]) box(t, 0.06, 1.1, 0.06, 'ink', sx * 1.245, 1.2, zz);
    box(t, 0.08, 0.1, 0.24, 'steel', sx * 1.27, 1.66, 1.55);
  }
  // wipers
  for (const sx of [-0.55, 0.55]) rod(t, { x: sx, y: 2.0, z: 2.66 }, { x: sx + 0.3, y: 2.3, z: 2.66 }, 0.025, 'ink', 4);

  // hood, grille, bumper, lights
  box(t, 2.3, 0.92, 1.3, body, 0, 0.92, 3.22);
  box(t, 2.34, 0.14, 1.34, 'wallWhite', 0, 1.7, 3.22);
  box(t, 1.95, 0.66, 0.1, 'ink', 0, 1.0, 3.87);
  for (let i = 0; i < 3; i++) box(t, 1.8, 0.08, 0.05, 'steel', 0, 1.12 + i * 0.18, 3.92);
  box(t, 2.52, 0.3, 0.26, 'steel', 0, 0.58, 3.94);
  box(t, 2.2, 0.12, 0.1, 'ink', 0, 0.86, 3.98);
  for (const sx of [-0.8, 0.8]) {
    box(t, 0.4, 0.26, 0.1, 'glow', sx, 1.28, 3.9);
    box(t, 0.5, 0.34, 0.14, 'ink', sx, 1.24, 3.84);
    box(t, 0.24, 0.16, 0.1, 'orange', sx, 1.0, 3.9);
  }
  for (const sx of [-1, 1]) {
    box(t, 0.36, 0.5, 1.5, body, sx * 1.16, 0.86, 2.78);
    box(t, 0.1, 0.3, 0.1, 'ink', sx * 1.3, 1.4, 3.4);
  }

  // rear face: roll-up door, tail lights, step, tow eye
  box(t, 2.2, 1.3, 0.1, 'steel', 0, 0.96, -4.02);
  for (let i = 0; i < 4; i++) box(t, 2.22, 0.07, 0.12, 'ink', 0, 1.06 + i * 0.3, -4.04);
  for (const sx of [-0.95, 0.95]) box(t, 0.34, 0.18, 0.1, 'red', sx, 0.72, -4.04);
  box(t, 1.7, 0.12, 0.34, 'steelDark', 0, 0.5, -4.22);
  box(t, 0.2, 0.2, 0.16, 'ink', 0, 0.34, -4.36);

  // roof light bar
  box(t, 1.95, 0.16, 0.36, 'ink', 0, 3.02, 2.05);
  for (const sx of [-0.52, 0.52]) box(t, 0.62, 0.1, 0.26, 'beacon', sx, 3.1, 2.05);
  box(t, 0.5, 0.1, 0.2, 'wallWhite', 0, 3.1, 2.05);
  box(t, 0.3, 0.2, 0.24, 'steelDark', 0, 3.2, 1.2);

  // wheels: single front axle, dual rear bogie
  for (const sx of [-1, 1]) {
    wheel(t, sx * 1.08, 0.52, 2.78, 0.52);
    wheel(t, sx * 1.08, 0.52, -2.4, 0.52);
    wheel(t, sx * 1.08, 0.52, -3.35, 0.52);
    box(t, 0.3, 0.3, 0.06, 'ink', sx * 1.1, 0.22, -3.6);
  }
}

/** Ambulance: white box body, stripe, red crosses, light bar. Nose toward +Z. */
function ambulance(g: THREE.Object3D, look: Look, x: number, z: number, ground: number): void {
  const t = new THREE.Group();
  t.position.set(x, ground, z);
  g.add(t);

  box(t, 1.8, 0.24, 5.0, 'ink', 0, 0.42, 0);
  // box body
  box(t, 2.3, 1.96, 3.9, 'wallWhite', 0, 0.6, -0.85);
  box(t, 2.34, 0.2, 3.94, look.wall, 0, 1.5, -0.85);
  box(t, 2.34, 0.12, 3.94, 'wallWhite', 0, 2.42, -0.85);
  // cab
  box(t, 2.16, 1.5, 1.75, 'wallWhite', 0, 0.62, 2.0);
  box(t, 1.98, 0.62, 0.5, 'wallWhite', 0, 0.62, 2.95);
  box(t, 1.86, 0.72, 0.1, 'glass', 0, 1.3, 2.9);
  box(t, 2.2, 0.14, 1.8, 'wallWhite', 0, 2.12, 2.0);
  for (const sx of [-1, 1]) box(t, 0.08, 0.6, 1.0, 'glass', sx * 1.1, 1.3, 1.95);
  // side door on the kerb side with a glow window
  box(t, 0.06, 1.1, 0.9, 'ink', 1.17, 0.62, -0.4);
  box(t, 0.06, 0.62, 0.7, 'glow', 1.2, 1.02, -0.4);
  for (const sx of [-1, 1]) {
    box(t, 0.06, 0.4, 0.14, 'red', sx * 1.17, 1.62, -0.85);
    box(t, 0.06, 0.14, 0.4, 'red', sx * 1.17, 1.75, -0.85);
    box(t, 0.06, 0.5, 0.9, 'glow', sx * 1.17, 1.15, -2.1);
    box(t, 0.07, 0.56, 0.96, 'ink', sx * 1.16, 1.12, -2.1);
  }
  // rear doors
  box(t, 2.1, 1.6, 0.08, 'wallWhite', 0, 0.7, -2.82);
  for (const sx of [-0.5, 0.5]) box(t, 0.7, 0.6, 0.1, 'glow', sx, 1.5, -2.84);
  for (const sx of [-0.5, 0.5]) box(t, 0.08, 1.4, 0.06, 'ink', sx, 0.75, -2.86);
  box(t, 0.3, 0.16, 0.1, 'red', -0.7, 0.9, -2.88);
  box(t, 0.3, 0.16, 0.1, 'red', 0.7, 0.9, -2.88);
  // front face: grille, bumper, lights
  box(t, 1.7, 0.34, 0.1, 'ink', 0, 0.8, 3.16);
  box(t, 1.8, 0.24, 0.22, 'steel', 0, 0.56, 3.2);
  for (const sx of [-0.72, 0.72]) box(t, 0.36, 0.18, 0.1, 'glow', sx, 1.0, 3.18);
  box(t, 0.34, 0.12, 0.08, 'orange', 0, 1.5, 3.0);
  box(t, 0.3, 0.2, 0.1, 'steel', 0, 0.5, 3.22);
  // roof kit
  box(t, 1.6, 0.12, 0.3, 'ink', 0, 2.48, 0.5);
  for (const sx of [-0.4, 0.4]) box(t, 0.42, 0.1, 0.22, 'beacon', sx, 2.56, 0.5);
  for (const zz of [-1.4, -0.2]) {
    box(t, 0.6, 0.18, 0.5, 'steelDark', 0, 2.54, zz);
    box(t, 0.44, 0.05, 0.36, 'steel', 0, 2.72, zz);
  }
  for (const zz of [1.8, -1.9]) {
    for (const sx of [-1, 1]) wheel(t, sx * 1.02, 0.42, zz, 0.42, 0.3);
  }
}

/* ================================================================ station */

/** One apparatus bay: ink reveal, dark liner, glow ceiling strip and either a door or the open bay. */
function bay(g: THREE.Object3D, look: Look, cx: number, num: string, open: boolean): void {
  const x0 = cx - BAY_W / 2;
  const x1 = cx + BAY_W / 2;
  const top = B + BAY_H;

  // floor slab, flush with the apron
  box(g, BAY_W + 0.06, 0.06, 7.0, 'concrete', cx, B, -4.75);
  box(g, BAY_W - 0.2, 0.02, 0.16, 'yellow', cx, APRON, -1.05);

  // ink reveal around the opening
  box(g, BAY_W + 0.44, 0.24, 0.16, 'ink', cx, top - 0.26, FRONT_Z + 0.1);
  for (const sx of [-1, 1]) box(g, 0.28, BAY_H + 0.02, 0.16, 'ink', cx + sx * (BAY_W / 2 + 0.08), B + 0.06, FRONT_Z + 0.1);

  // ceiling light strip, visible from the apron
  box(g, BAY_W - 0.6, 0.08, 0.3, 'glow', cx, top - 0.16, FRONT_Z + 0.55);
  box(g, BAY_W - 0.5, 0.06, 0.06, 'ink', cx, top - 0.06, FRONT_Z + 0.62);

  if (open) {
    // liner: dark ceiling, side walls and back wall, so the bay reads deep
    box(g, BAY_W + 0.02, 0.08, 7.0, 'ink', cx, B + BAY_H - 0.08, -4.75);
    for (const sx of [-1, 1]) box(g, 0.1, BAY_H - 0.1, 7.0, 'ink', x0 + (sx < 0 ? 0.05 : BAY_W - 0.05), B + 0.06, -4.75);
    box(g, BAY_W, BAY_H - 0.1, 0.12, 'ink', cx, B + 0.06, -8.3);
    box(g, BAY_W - 0.4, 0.06, 0.4, 'glow', cx, B + BAY_H - 0.2, -7.6);
    // rear wall gear: two hanging hose coils and a shelf
    for (const sx of [-0.75, 0.15]) {
      put(g, new THREE.CylinderGeometry(0.34, 0.34, 0.18, 12), 'red', cx + sx, 2.25, -8.16, Math.PI / 2, 0, 0);
      put(g, new THREE.CylinderGeometry(0.16, 0.16, 0.22, 8), 'ink', cx + sx, 2.25, -8.16, Math.PI / 2, 0, 0);
    }
    box(g, 1.7, 0.08, 0.45, 'steel', cx + 0.75, 1.15, -8.1);
    box(g, 1.3, 0.5, 0.35, 'steelDark', cx + 0.75, 0.66, -8.1);
    // safety bollard inside the bay mouth
    for (const sx of [-1, 1]) cyl(g, 0.1, 0.1, 0.7, 'yellow', cx + sx * 1.36, APRON, -1.6, 8);
  } else {
    // panelled roller door
    box(g, BAY_W, BAY_H - 0.16, 0.14, 'steelDark', cx, APRON, FRONT_Z + 0.05);
    for (let i = 0; i < 7; i++) box(g, BAY_W - 0.02, 0.09, 0.17, 'ink', cx, APRON + 0.22 + i * 0.45, FRONT_Z + 0.07);
    box(g, BAY_W, 0.16, 0.2, 'steel', cx, APRON + BAY_H - 0.34, FRONT_Z + 0.08);
    for (const sx of [-0.72, 0.72]) {
      box(g, 0.54, 0.34, 0.06, 'glow', cx + sx, 2.62, FRONT_Z + 0.14);
      box(g, 0.6, 0.4, 0.06, 'ink', cx + sx, 2.59, FRONT_Z + 0.12);
    }
    // bay number plate
    box(g, 1.26, 0.42, 0.07, 'ink', cx, 2.98, FRONT_Z + 0.15);
    pixelText(g, `BAY ${num}`, { x: cx, y: 3.05, z: FRONT_Z + 0.2, cell: 0.036, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.04 });
    // handle and lock
    box(g, 0.7, 0.1, 0.08, 'steel', cx, 0.66, FRONT_Z + 0.15);
    box(g, 0.16, 0.12, 0.08, 'ink', cx, 0.98, FRONT_Z + 0.15);
  }
  // door-top light bar
  box(g, BAY_W - 0.5, 0.09, 0.12, 'glow', cx, top + 0.06, FRONT_Z + 0.16);
}

/** Station: two storeys, three bays, watch room, sign, cornice, parapet. */
function station(g: THREE.Object3D, look: Look): void {
  const w = look.wall;
  const depth = FRONT_Z - BACK_Z;

  // back and side walls
  box(g, BW, GF_H, 0.5, w, 0, B, BACK_Z + 0.25);
  for (const sx of [-1, 1]) box(g, 0.5, GF_H, depth, w, sx * (HW - 0.25), B, SZ);
  // rear and side base bands
  box(g, BW + 0.1, 0.72, 0.62, 'concrete', 0, B, BACK_Z + 0.25);
  for (const sx of [-1, 1]) box(g, 0.62, 0.72, depth, 'concrete', sx * (HW - 0.25), B, SZ);

  // front piers + their plinths
  const piers: Array<[number, number]> = [
    [-5.8, 1.8],
    [-1.7, 0.4],
    [1.7, 0.4],
    [5.8, 1.8],
  ];
  for (const [px, pw] of piers) {
    box(g, pw, GF_H, 0.62, w, px, B, FRONT_Z + 0.31);
    box(g, pw + 0.12, 0.72, 0.74, 'concrete', px, B, FRONT_Z + 0.31);
    box(g, pw + 0.04, 0.12, 0.7, 'concrete', px, B + 0.72, FRONT_Z + 0.31);
  }
  // deep lintel / fascia band over the bays
  box(g, BW, GT - (B + BAY_H), 0.62, w, 0, B + BAY_H, FRONT_Z + 0.31);

  // white string course, upper storey, cornice
  box(g, BW + 0.36, 0.2, depth + 0.36, look.trim, 0, GT, SZ);
  box(g, BW, UF_H, depth, look.upper, 0, UB, SZ);
  box(g, BW + 0.5, 0.26, depth + 0.5, look.trim, 0, CB, SZ);
  // brick corner quoins on the upper storey
  for (const sx of [-1, 1]) {
    box(g, 0.7, UF_H, 0.18, look.quoin, sx * (HW - 0.35), UB, FRONT_Z + 0.09);
    box(g, 0.18, UF_H, 0.7, look.quoin, sx * (HW - 0.09), UB, FRONT_Z + 0.35);
  }
  flatRoof(g, { cx: 0, cz: SZ, hw: HW, hd: depth / 2 }, SLAB, PARAPET, w);

  // ---- bays
  bay(g, look, BAYS[0], '1', false);
  bay(g, look, BAYS[1], '2', true);
  bay(g, look, BAYS[2], '3', false);

  // ---- glowing station sign on the fascia band
  // The ground-floor block projects 0.62 in front of the upper wall, so the sign
  // has to sit on the lintel face (FRONT_Z + 0.62), not on the wall plane.
  const face = FRONT_Z + 0.62;
  const cell = 0.058;
  const textW = look.sign.length * 6 * cell - cell;
  const plateW = textW + 0.55;
  box(g, plateW, 0.44, 0.12, 'ink', 0, B + BAY_H + 0.04, face + 0.02);
  box(g, plateW - 0.12, 0.34, 0.06, 'steelDark', 0, B + BAY_H + 0.09, face + 0.07);
  pixelText(g, look.sign, {
    x: 0,
    y: B + BAY_H + 0.06,
    z: face + 0.15,
    cell,
    face: '+z',
    mat: 'glow',
    align: 'center',
    depth: 0.05,
  });

  // ---- upper floor: dorm windows + projecting watch room
  for (const wx of [-5.55, -3.15, -0.85, 1.35]) {
    windowUnit(g, { face: '+z', plane: FRONT_Z, along: wx, y: UB + 0.78, w: 1.35, h: 1.55, muntin: true });
  }
  // watch room, projecting over the third bay
  const wx = 3.9;
  const wy = UB + 0.1;
  const wFace = FRONT_Z + 1.25;
  box(g, 3.4, 2.3, 1.3, look.upper, wx, wy, FRONT_Z + 0.6);
  box(g, 3.56, 0.18, 1.5, look.trim, wx, wy + 2.3, FRONT_Z + 0.62);
  box(g, 3.4, 0.26, 1.2, look.pier, wx, wy + 2.48, FRONT_Z + 0.66);
  box(g, 3.5, 0.1, 1.3, 'concrete', wx, wy + 2.74, FRONT_Z + 0.66);
  for (const bx of [-1.06, 0, 1.06]) box(g, 0.2, 0.44, 0.98, look.quoin, wx + bx, wy - 0.44, FRONT_Z + 0.72);
  for (const bx of [-1.12, 0, 1.12]) {
    fBox(g, '+z', wFace, 'ink', wx + bx, wy + 0.34, 0.0, 0.98, 1.7, 0.1);
    fBox(g, '+z', wFace, 'glow', wx + bx, wy + 0.42, 0.09, 0.78, 1.5, 0.08);
    fBox(g, '+z', wFace, 'wallWhite', wx + bx, wy + 0.3, 0.13, 0.98, 0.14, 0.06);
    fBox(g, '+z', wFace, 'wallWhite', wx + bx, wy + 1.86, 0.13, 0.98, 0.14, 0.06);
    fBox(g, '+z', wFace, 'ink', wx + bx, wy + 1.1, 0.15, 0.06, 0.86, 0.05);
  }
  // watch-room side window and a small glow downlight under the corbels
  fBox(g, '+x', wx + 1.7, 'ink', FRONT_Z + 0.8, wy + 0.4, 0.0, 1.55, 1.5, 0.1);
  fBox(g, '+x', wx + 1.7, 'glow', FRONT_Z + 0.8, wy + 0.48, 0.09, 1.35, 1.3, 0.08);
  box(g, 0.3, 0.08, 0.3, 'glow', wx, wy - 0.5, FRONT_Z + 1.0);

  // ---- crew door with canopy, in the left end bay; it sits on the projecting
  // pier face so the deep reveal does not swallow it.
  const fp = FRONT_Z + 0.62;
  glazedDoor(g, { face: '+z', plane: fp, along: -5.8, y: APRON, w: 0.92, h: 2.14 });
  box(g, 1.9, 0.16, 1.15, look.trim, -5.8, 2.96, fp + 0.575);
  box(g, 2.02, 0.2, 0.12, 'ink', -5.8, 2.92, fp + 1.09);
  for (const sx of [-0.75, 0.75]) {
    box(g, 0.16, 0.3, 0.16, 'steel', -5.8 + sx, 2.66, fp + 1.0);
    rod(g, { x: -5.8 + sx, y: 2.7, z: fp + 0.2 }, { x: -5.8 + sx, y: 2.96, z: fp + 0.95 }, 0.05, 'steel', 5);
  }
  // crew sign above the door, under the canopy
  box(g, 0.96, 0.22, 0.06, 'ink', -5.8, 2.72, fp + 0.05);
  pixelText(g, 'CREW', { x: -5.8, y: 2.75, z: fp + 0.09, cell: 0.024, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.04 });
  // downlight under the canopy and a threshold
  box(g, 0.28, 0.06, 0.22, 'glow', -5.8, 2.9, fp + 0.6);
  box(g, 1.5, 0.06, 0.6, 'concrete', -5.8, APRON, fp + 0.5);

  // ---- side and rear windows
  for (const sx of [-1, 1]) {
    for (const wz of [-2.6, -5.4]) {
      windowUnit(g, { face: sx > 0 ? '+x' : '-x', plane: sx * HW, along: wz, y: UB + 0.8, w: 1.15, h: 1.45, muntin: true });
    }
    // ground-floor side windows and a louvre panel
    windowUnit(g, { face: sx > 0 ? '+x' : '-x', plane: sx * HW, along: -2.2, y: B + 1.35, w: 1.0, h: 1.15 });
    fBox(g, sx > 0 ? '+x' : '-x', sx * HW, 'ink', -6.9, B + 2.3, 0.0, 1.1, 0.9, 0.12);
    for (let i = 0; i < 4; i++) fBox(g, sx > 0 ? '+x' : '-x', sx * HW, 'steelDark', -6.9, B + 2.38 + i * 0.2, 0.08, 0.98, 0.06, 0.05);
    // downpipe at each corner
    cyl(g, 0.065, 0.065, GT - B, 'steel', sx * (HW + 0.12), B, FRONT_Z - 0.3, 8);
    box(g, 0.18, 0.12, 0.18, 'steelDark', sx * (HW + 0.12), B + 0.02, FRONT_Z - 0.3);
  }
  for (const wx2 of [-1.2, 2.0]) {
    windowUnit(g, { face: '-z', plane: BACK_Z, along: wx2, y: UB + 0.8, w: 1.2, h: 1.45, muntin: true });
  }
  windowUnit(g, { face: '-z', plane: BACK_Z, along: 3.4, y: B + 1.3, w: 1.0, h: 1.1 });

  // ---- rear service door with a hood and step
  fBox(g, '-z', BACK_Z, 'ink', 0.9, APRON, 0.02, 1.2, 2.2, 0.12);
  fBox(g, '-z', BACK_Z, 'steel', 0.9, APRON + 0.04, 0.13, 1.04, 2.12, 0.06);
  for (let i = 0; i < 5; i++) fBox(g, '-z', BACK_Z, 'ink', 0.9, APRON + 0.3 + i * 0.36, 0.16, 0.9, 0.06, 0.03);
  box(g, 1.7, 0.14, 0.9, look.trim, 0.9, APRON + 2.3, BACK_Z - 0.45);
  box(g, 1.6, 0.06, 0.7, 'concrete', 0.9, B, BACK_Z - 0.75);
  fBox(g, '-z', BACK_Z, 'glow', 1.9, APRON + 2.16, 0.06, 0.3, 0.14, 0.1);
}

/** Slender hose-drying tower at the rear-right corner with exterior hose rails. */
function hoseTower(g: THREE.Object3D, look: Look): void {
  const { x, z } = TOWER;
  const h = 11.2;
  box(g, 2.7, 0.5, 2.7, 'concrete', x, B, z);
  box(g, 2.3, h, 2.3, look.wall, x, B + 0.5, z);
  // corner quoin strips give the tower a masonry read
  for (const sx of [-1, 1]) box(g, 0.26, h, 0.26, look.pier, x + sx * 1.14, B + 0.5, z + 1.14);
  for (const sy of [3.4, 6.6, 9.8]) box(g, 2.46, 0.18, 2.46, look.trim, x, B + sy, z);
  box(g, 2.56, 0.26, 2.56, look.trim, x, B + 0.5 + h, z);
  box(g, 2.6, 0.18, 2.6, 'concrete', x, B + 0.76 + h, z);
  hipRoof(g, 2.7, 2.7, 0.95, look.roof, x, B + 0.94 + h, z);
  sphere(g, 0.1, 'steel', x, B + 1.96 + h, z, 8);
  // small storey windows on the two visible faces
  for (const sy of [1.5, 4.7, 7.9]) {
    for (const f of ['-z', '+x'] as const) {
      const plane = f === '-z' ? z - 1.15 : x + 1.15;
      const along = f === '-z' ? x : z;
      fBox(g, f, plane, 'glow', along, B + sy, 0.0, 0.55, 0.85, 0.1);
      fBox(g, f, plane, 'ink', along, B + sy - 0.08, 0.05, 0.75, 1.0, 0.09);
      fBox(g, f, plane, 'wallWhite', along, B + sy - 0.16, 0.1, 0.85, 0.12, 0.08);
    }
  }
  // hose rails on the +X face, with hose hanging to dry
  for (const sy of [7.4, 9.6]) {
    rod(g, { x: x + 1.15, y: B + sy, z }, { x: x + 1.95, y: B + sy, z }, 0.06, 'steel', 6);
    rod(g, { x: x + 1.9, y: B + sy, z: z - 0.72 }, { x: x + 1.9, y: B + sy, z: z + 0.72 }, 0.05, 'steel', 6);
    for (const sz of [-0.5, 0.45]) {
      rod(g, { x: x + 1.9, y: B + sy - 0.02, z: z + sz }, { x: x + 1.9, y: B + sy - 1.9, z: z + sz }, 0.07, 'red', 6);
      box(g, 0.06, 0.5, 0.24, 'red', x + 1.9, B + sy - 2.3, z + sz);
    }
  }
  // access ladder on the +X face
  for (const dz of [-0.24, 0.24]) rod(g, { x: x + 1.16, y: B + 1.2, z: z + dz }, { x: x + 1.16, y: B + 9.4, z: z + dz }, 0.04, 'steel', 5);
  for (let y = B + 1.5; y < B + 9.3; y += 0.42) rod(g, { x: x + 1.16, y, z: z - 0.24 }, { x: x + 1.16, y, z: z + 0.24 }, 0.03, 'steel', 4);
}

/** Dispatch annex at the rear-left: own door, step, windows and a small roof sign. */
function annex(g: THREE.Object3D, look: Look): void {
  const { x, z } = ANNEX;
  const w = 3.6;
  const h = 2.7;
  box(g, w, 0.5, 2.5, 'concrete', x, B, z);
  box(g, w, h, 2.4, 'wallCream', x, B + 0.5, z);
  box(g, 0.16, h, 2.4, look.pier, x - w / 2 + 0.08, B + 0.5, z);
  box(g, 0.16, h, 2.4, look.pier, x + w / 2 - 0.08, B + 0.5, z);
  flatRoof(g, { cx: x, cz: z, hw: w / 2, hd: 1.2 }, B + 0.5 + h, 0.34, 'wallCream');
  // rear door, step and lamp
  const zBack = z - 1.2;
  fBox(g, '-z', zBack, 'ink', x - 0.85, APRON, 0.02, 1.24, 2.14, 0.1);
  fBox(g, '-z', zBack, 'wallCream', x - 0.85, APRON + 0.03, 0.1, 1.08, 2.08, 0.06);
  fBox(g, '-z', zBack, 'glow', x - 0.85, APRON + 1.25, 0.16, 0.62, 0.7, 0.05);
  box(g, 1.7, 0.14, 0.7, 'concrete', x - 0.85, B, zBack - 0.5);
  box(g, 0.3, 0.12, 0.22, 'ink', x - 0.85, APRON + 2.34, zBack - 0.13);
  box(g, 0.2, 0.05, 0.14, 'glow', x - 0.85, APRON + 2.31, zBack - 0.15);
  // windows on the rear and west faces
  for (const wx of [0.5, 1.35]) fBox(g, '-z', zBack, 'glow', x + wx, APRON + 1.1, 0.0, 0.62, 0.8, 0.1);
  for (const wx of [0.5, 1.35]) fBox(g, '-z', zBack, 'ink', x + wx, APRON + 1.02, 0.06, 0.78, 0.96, 0.08);
  fBox(g, '-z', zBack, 'ink', x + 0.92, APRON + 0.7, 0.06, 2.0, 0.1, 0.08);
  for (const wz of [-0.4, 0.5]) {
    fBox(g, '-x', x - w / 2, 'glow', wz, APRON + 1.1, 0.0, 0.7, 0.85, 0.1);
    fBox(g, '-x', x - w / 2, 'ink', wz, APRON + 1.02, 0.05, 0.86, 1.0, 0.08);
  }
  // dish and antenna on the annex roof
  cyl(g, 0.06, 0.06, 1.1, 'steel', x + 1.0, B + 3.3, z, 6);
  const dish = put(g, new THREE.SphereGeometry(0.5, 10, 6, 0, Math.PI * 2, 0, 0.75), 'wallWhite', x + 1.0, B + 3.95, z + 0.34, -Math.PI / 2, 0, 0);
  dish.rotation.x = -Math.PI / 2 - 0.4;
  pixelText(g, 'DISPATCH', { x, y: B + 2.86, z: z + 1.21, cell: 0.045, face: '+z', mat: 'ink', align: 'center', depth: 0.04 });
  box(g, 2.6, 0.26, 0.1, 'ink', x, B + 2.74, z + 1.2);
}

/** Turnout-gear lockers along the east wall, plus a bench and boot rack. */
function lockers(g: THREE.Object3D): void {
  for (let i = 0; i < 3; i++) {
    const z = -2.5 - i * 1.45;
    box(g, 0.62, 1.85, 1.3, 'steelDark', HW + 0.2, B, z);
    box(g, 0.68, 0.1, 1.36, 'ink', HW + 0.2, B + 1.85, z);
    box(g, 0.06, 1.55, 1.1, 'steel', HW + 0.53, B + 0.18, z);
    for (let j = 0; j < 4; j++) box(g, 0.05, 0.07, 0.95, 'ink', HW + 0.56, B + 0.34 + j * 0.28, z);
    box(g, 0.06, 0.1, 0.2, 'ink', HW + 0.57, B + 0.95, z + 0.42);
  }
  // helmet shelf and a bench in front of the lockers
  box(g, 0.42, 0.1, 3.9, 'wood', HW + 0.72, B + 1.9, -3.95);
  for (let i = 0; i < 4; i++) sphere(g, 0.16, i % 2 ? 'yellow' : 'orange', HW + 0.72, B + 2.06, -5.0 + i * 0.55, 8);
  box(g, 0.5, 0.12, 2.2, 'wood', HW + 0.95, B + 0.46, -6.9);
  for (const s of [-0.8, 0.8]) box(g, 0.46, 0.46, 0.1, 'steelDark', HW + 0.95, B, -6.9 + s);
}

/** Roof plant: HVAC, vents, siren, mast or radar, skylight, hatch and power bracket. */
function roofKit(g: THREE.Object3D, look: Look): THREE.Vector3 {
  hvacUnit(g, -3.2, ROOF, -6.6, 2.8, 1.8);
  hvacUnit(g, 0.9, ROOF, -4.6, 1.8, 1.3, 0.95);
  stack(g, -5.6, ROOF, -7.6, 1.0);
  stack(g, 1.9, ROOF, -7.8, 0.8);
  // skylight over the stair and the roof hatch
  box(g, 1.3, 0.18, 1.0, 'concrete', -0.4, ROOF, -2.6);
  box(g, 1.1, 0.1, 0.8, 'ink', -0.4, ROOF + 0.18, -2.6);
  box(g, 1.0, 0.06, 0.7, 'glow', -0.4, ROOF + 0.22, -2.6);
  box(g, 1.2, 0.22, 1.0, 'concrete', 2.4, ROOF, -2.9);
  box(g, 1.0, 0.12, 0.8, 'steelDark', 2.4, ROOF + 0.22, -2.9);
  box(g, 0.96, 0.06, 0.76, 'ink', 2.4, ROOF + 0.33, -3.2);

  // siren: drum, head, two cone horns and a beacon
  cyl(g, 0.34, 0.34, 0.42, 'steelDark', 3.0, ROOF, -7.4, 12);
  cyl(g, 0.26, 0.26, 0.2, 'ink', 3.0, ROOF + 0.42, -7.4, 12);
  for (const s of [-1, 1]) {
    put(g, new THREE.ConeGeometry(0.17, 0.48, 10), 'steel', 3.0 + s * 0.38, ROOF + 0.52, -7.4, 0, 0, s > 0 ? -Math.PI / 2 : Math.PI / 2);
  }
  sphere(g, 0.12, 'beacon', 3.0, ROOF + 0.74, -7.4, 8);

  if (look.radar) {
    cyl(g, 0.36, 0.48, 1.3, 'steelDark', 4.7, ROOF, -6.5, 10);
    const head = new THREE.Group();
    head.position.set(4.7, ROOF + 1.3, -6.5);
    g.add(spin(head, 'y', 0.8));
    cyl(head, 0.3, 0.3, 0.32, 'steel', 0, 0, 0, 10);
    rod(head, { x: 0, y: 0.3, z: 0 }, { x: 0, y: 1.25, z: 0 }, 0.08, 'steel', 6);
    const dish = put(head, new THREE.SphereGeometry(1.5, 14, 6, 0, Math.PI * 2, 0, 0.7), 'wallWhite', 0, 1.25, 1.15, -Math.PI / 2, 0, 0);
    dish.rotation.x = -Math.PI / 2;
    rod(head, { x: 0, y: 1.25, z: 0 }, { x: 0, y: 1.25, z: 0.9 }, 0.04, 'steel', 6);
    sphere(head, 0.1, 'steel', 0, 1.25, 0.9, 8);
    box(head, 0.06, 0.06, 1.0, 'steelDark', 0, 1.25, 0.4);
  } else {
    // radio mast with two cross-arms and a beacon
    box(g, 0.55, 0.3, 0.55, 'steel', 4.9, ROOF, -6.5);
    cyl(g, 0.1, 0.13, 6.2, 'steel', 4.9, ROOF + 0.3, -6.5, 8);
    rod(g, { x: 3.7, y: ROOF + 3.4, z: -6.5 }, { x: 6.1, y: ROOF + 3.4, z: -6.5 }, 0.06, 'steel', 6);
    rod(g, { x: 4.0, y: ROOF + 5.0, z: -6.5 }, { x: 5.8, y: ROOF + 5.0, z: -6.5 }, 0.055, 'steel', 6);
    for (const sx of [-1.05, -0.6, 0.6, 1.05]) rod(g, { x: 4.9 + sx, y: ROOF + 3.4, z: -6.5 }, { x: 4.9 + sx, y: ROOF + 3.82, z: -6.5 }, 0.035, 'steelDark', 4);
    sphere(g, 0.17, 'beacon', 4.9, ROOF + 6.66, -6.5, 8);
    // small point-to-point dish on the mast
    const d2 = put(g, new THREE.SphereGeometry(0.62, 10, 6, 0, Math.PI * 2, 0, 0.7), 'wallWhite', 4.3, ROOF + 2.4, -6.1, -Math.PI / 2, 0, 0);
    d2.rotation.x = -Math.PI / 2 + 0.3;
    rod(g, { x: 4.9, y: ROOF + 2.4, z: -6.5 }, { x: 4.5, y: ROOF + 2.4, z: -6.3 }, 0.04, 'steel', 5);
  }

  // power bracket at the front-right of the roof
  const px = 5.9;
  const pz = -2.6;
  box(g, 0.5, 0.22, 0.5, 'concrete', px, ROOF, pz);
  cyl(g, 0.08, 0.1, 0.9, 'steel', px, ROOF + 0.22, pz, 6);
  rod(g, { x: px, y: ROOF + 0.95, z: pz }, { x: px + 0.85, y: ROOF + 0.95, z: pz }, 0.06, 'steel', 6);
  rod(g, { x: px, y: ROOF + 0.95, z: pz + 0.3 }, { x: px + 0.85, y: ROOF + 0.95, z: pz }, 0.04, 'steel', 5);
  return insulator(g, px + 0.85, ROOF + 0.95, pz, 3);
}

/* ================================================================ site */

/** Lot slab, apron, guide lines, kerb, forecourt props, grounds and rear yard. */
function site(g: THREE.Object3D, look: Look): void {
  // slab and lawn strips
  box(g, 22.4, B, 22.4, 'paving', 0, 0, 0);
  box(g, 22.4, 0.05, 22.4, 'paving', 0, B, 0);
  box(g, 4.0, 0.06, 11.0, 'grass', -9.0, B, 4.3);
  box(g, 1.0, 0.06, 22.2, 'grass', -10.75, B, -0.1);
  box(g, 1.0, 0.06, 22.2, 'grass', 10.75, B, -0.1);
  // concrete apron in front of the bays
  box(g, 14.0, 0.06, 10.0, 'concrete', 0, B, 3.8);
  // paved walk from the sidewalk to the crew door
  box(g, 1.3, 0.02, 11.3, 'paving', -5.8, APRON, 4.45);
  box(g, 0.09, 0.03, 11.3, 'wallWhite', -6.42, APRON, 4.45);
  box(g, 0.09, 0.03, 11.3, 'wallWhite', -5.18, APRON, 4.45);
  // driveway to the street and sidewalk beyond the kerb
  box(g, 13.0, 0.06, 1.5, 'asphalt', 0, B, 9.55);
  box(g, 22.4, 0.1, 0.9, 'concrete', 0, B, 10.55);
  for (const s of [-1, 1]) box(g, 4.7, 0.16, 0.18, 'concrete', s * 8.65, B, 10.06);
  box(g, 13.0, 0.07, 0.18, 'concrete', 0, B, 10.06);
  for (const s of [-1, 1]) box(g, 0.16, 0.16, 1.5, 'concrete', s * 6.55, B, 9.55);

  // guide lines and stop bars, one lane per bay; the lane number sits beside its lane
  for (const cx of BAYS) {
    for (const s of [-1, 1]) box(g, 0.14, 0.02, 8.9, 'yellow', cx + s * 1.3, APRON, 3.85);
    box(g, 3.0, 0.02, 0.14, 'yellow', cx, APRON, 8.05);
    pixelText(g, `${BAYS.indexOf(cx) + 1}`, { x: cx + 1.68, y: APRON, z: 8.2, cell: 0.105, face: '+y', mat: 'wallWhite', align: 'center', depth: 0.02 });
  }

  // bollards at the apron corners
  for (const [bx, bz] of [
    [-7.3, -0.9],
    [7.3, -0.9],
    [-7.3, 8.85],
    [7.3, 8.85],
  ]) {
    cyl(g, 0.15, 0.15, 0.9, 'yellow', bx, APRON, bz, 10);
    cyl(g, 0.17, 0.17, 0.1, 'ink', bx, APRON + 0.8, bz, 10);
  }

  // flagpole, monument, picnic and bench on the left lawn
  flagpole(g, -9.35, 2.3);
  monument(g, look, -8.75, 9.6);
  picnicTable(g, -9.2, 5.5);
  bench(g, -8.3, 7.3);
  siteLamp(g, -7.35, 3.5);
  for (let i = 0; i < 3; i++) {
    const z = 1.7 + i * 1.05;
    box(g, 0.72, 0.78, 0.95, 'green', -10.55, B, z);
    box(g, 0.78, 0.12, 1.0, 'roofGreen', -10.55, B + 0.78, z);
  }
  tree(g, -9.9, 0.4, 0.85);
  tree(g, -10.05, 7.7, 0.7);
  tree(g, 4.0, -10.1, 0.75);
  bush(g, -7.6, 1.0, 0.9);
  trashCan(g, 7.6, 9.5);

  // right side: fuel island, bike rack and the marked staff lot
  fuelIsland(g, look, 9.0, 0.9);
  bikeRack(g, 9.0, 3.25);
  parkingPad(g, 9.0, 7.35, 3.9, 4.7, 2);
  car(g, { x: 8.05, z: 7.35, mat: 'steel', rotY: Math.PI / 2 });
  if (look.rescue) car(g, { x: 9.95, z: 7.35, mat: 'wallWhite', squad: true, rotY: Math.PI / 2 });
  else car(g, { x: 9.95, z: 7.35, mat: 'wallCream', rotY: Math.PI / 2 });

  // forecourt hose-reel cabinet by the right pier
  hoseCabinet(g, 7.05, 2.7, 0);
  hydrant(g, 10.45, 9.85);

  // rear training yard: pad, hydrant, hose reel, ladder to the roof
  box(g, 6.2, 0.06, 2.0, 'asphalt', 0.4, B, -9.95);
  box(g, 2.4, 0.02, 0.12, 'yellow', 0.4, B + 0.06, -9.1);
  hydrant(g, 2.4, -10.1);
  // hose-reel stand at the rear: two posts, drum, crank and drying hose
  for (const s of [-0.5, 0.5]) box(g, 0.14, 1.0, 0.14, 'steelDark', -1.3, B, -10.0 + s);
  put(g, new THREE.CylinderGeometry(0.42, 0.42, 1.0, 12), 'red', -1.3, B + 1.0, -10.0, 0, 0, Math.PI / 2);
  put(g, new THREE.CylinderGeometry(0.12, 0.12, 1.1, 8), 'ink', -1.3, B + 1.0, -10.0, 0, 0, Math.PI / 2);
  box(g, 0.12, 0.28, 0.12, 'steel', -0.75, B + 0.86, -10.45);
  rod(g, { x: -1.7, y: B + 0.7, z: -9.7 }, { x: -2.3, y: B + 0.2, z: -9.3 }, 0.06, 'wallWhite', 6);
  // roof access ladder on the rear wall
  for (const sx of [-1.75, -1.25]) rod(g, { x: sx, y: B + 0.8, z: BACK_Z - 0.2 }, { x: sx, y: ROOF, z: BACK_Z - 0.2 }, 0.05, 'steel', 5);
  for (let y = B + 1.1; y < ROOF - 0.2; y += 0.42) rod(g, { x: -1.75, y, z: BACK_Z - 0.2 }, { x: -1.25, y, z: BACK_Z - 0.2 }, 0.035, 'steel', 4);
  box(g, 0.9, 0.12, 0.3, 'steelDark', -1.5, ROOF - 0.2, BACK_Z - 0.2);
}

export const build: ModelBuilder = ({ variant }) => {
  const look = variant === 1 ? POLICE_LOOK : FIRE_LOOK;
  const g = new THREE.Group();

  site(g, look);
  station(g, look);
  hoseTower(g, look);
  annex(g, look);
  lockers(g);
  const port = roofKit(g, look);

  // apparatus: pumper at bay 1, second rig half inside the open centre bay,
  // ambulance at bay 3
  apparatus(g, { kind: look.rescue ? 'rescue' : 'fire', mat: look.body, x: BAYS[0], z: 4.4, ground: APRON });
  apparatus(g, { kind: look.rescue ? 'rescue' : 'fire', mat: look.body, x: BAYS[1], z: -2.4, ground: APRON });
  ambulance(g, look, BAYS[2] + 0.3, 5.2, APRON);

  setPowerPorts(g, [port]);
  return g;
};
