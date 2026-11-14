// American neighbourhood schools. Footprint 3x2 cells = 36 m (X) x 24 m (Z).
// Origin = footprint centre at ground level, Y up, front faces +Z.
//
// Variant 0: Washington Elementary — red-brick two-storey classroom bar, barrel-roof
// gym, formal entrance with canopy, playground and basketball court, bus loop and
// marquee. Variant 1: Trojan High School — limestone three-storey block with a clock
// tower, competition gym, practice football field with bleachers, goalposts and lights.
//
// The site is read like a small real campus: every part belongs to a system (structure,
// glazing, roof plant, grounds, street furniture, school transport) and sits on another
// part. Materials only from MAT; details stay inside the 3x2 cell lot.
import * as THREE from 'three';
import { MAT, type MatName } from '../render/palette';
import {
  box,
  cyl,
  rod,
  sphere,
  spin,
  hipRoof,
  insulator,
  setPowerPorts,
  type Face,
  type ModelBuilder,
} from './kit';

export const VARIANTS = 2;

/** Top of the site slab: every building and prop stands on this plane. */
const G = 0.12;
/** Storey height for the classroom stock. */
const STOREY = 3.2;

/* ================================================================ primitives */

/** Plain mesh for shapes the kit cannot make (arcs, tori, angled slides, wheels). */
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

/** Outward normal of a face (unit). */
function normalOf(face: Face): { x: number; z: number } {
  if (face === '+z') return { x: 0, z: 1 };
  if (face === '-z') return { x: 0, z: -1 };
  if (face === '+x') return { x: 1, z: 0 };
  return { x: -1, z: 0 };
}

/* ================================================================ lettering */

/** 5x7 changeable-marquee alphabet. Only the shapes a school sign needs. */
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
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
};

/**
 * Draw block letters from the marquee alphabet. `face` +z is an upright sign face,
 * +y lies flat on the ground, -z faces the field. Returns the text width.
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
        const px = x0 + (i * 6 + c) * cell;
        if (o.face === '+z' || o.face === '-z') {
          const s = o.face === '+z' ? 1 : -1;
          box(g, cell * 0.84, cell * 0.84, dep, o.mat, px, o.y + (6 - r) * cell + cell * 0.08, o.z + s * dep * 0.5);
        } else if (o.face === '+y') {
          box(g, cell * 0.84, dep, cell * 0.84, o.mat, px, o.y, z0 + (6 - r) * cell + cell * 0.08);
        } else {
          const s = o.face === '+x' ? 1 : -1;
          box(g, dep, cell * 0.84, cell * 0.84, o.mat, o.x + s * dep * 0.5, o.y + (6 - r) * cell + cell * 0.08, px);
        }
      }
    }
  }
  return total;
}

/* ================================================================ site kit */

interface Block {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
}

/** Flat roof with a brick parapet and a concrete coping. */
function flatRoof(g: THREE.Object3D, b: Block, top: number, ph: number, brick: MatName): void {
  const t = 0.3;
  box(g, 2 * b.hw - 0.5, 0.05, 2 * b.hd - 0.5, 'roofInk', b.cx, top + 0.01, b.cz);
  // roofing seams run the long way, edge to edge on the field
  for (let z = b.cz - b.hd + 1.3; z < b.cz + b.hd - 0.8; z += 1.45) {
    box(g, 2 * b.hw - 0.65, 0.035, 0.035, 'steelDark', b.cx, top + 0.06, z);
  }
  const zF = b.cz + b.hd - t / 2;
  const zB = b.cz - b.hd + t / 2;
  const xR = b.cx + b.hw - t / 2;
  const xL = b.cx - b.hw + t / 2;
  box(g, 2 * b.hw, ph, t, brick, b.cx, top, zF);
  box(g, 2 * b.hw, ph, t, brick, b.cx, top, zB);
  box(g, t, ph, 2 * b.hd - 2 * t, brick, xR, top, b.cz);
  box(g, t, ph, 2 * b.hd - 2 * t, brick, xL, top, b.cz);
  box(g, 2 * b.hw + 0.16, 0.1, t + 0.16, 'concrete', b.cx, top + ph, zF);
  box(g, 2 * b.hw + 0.16, 0.1, t + 0.16, 'concrete', b.cx, top + ph, zB);
  box(g, t + 0.16, 0.1, 2 * b.hd - 2 * t, 'concrete', xR, top + ph, b.cz);
  box(g, t + 0.16, 0.1, 2 * b.hd - 2 * t, 'concrete', xL, top + ph, b.cz);
}

/** Barrel roof, ridge along X, standing seams and white end fascias. */
function barrelRoof(
  g: THREE.Object3D,
  o: { x: number; y: number; z: number; len: number; r: number; mat: MatName },
): void {
  const shape = new THREE.Shape();
  shape.moveTo(-o.r, 0);
  shape.absarc(0, 0, o.r, Math.PI, 0, true);
  shape.lineTo(o.r, 0);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: o.len, bevelEnabled: false, curveSegments: 32 });
  geo.translate(0, 0, -o.len / 2);
  geo.rotateY(Math.PI / 2);
  put(g, geo, o.mat, o.x, o.y, o.z);
  // end arches: a rolled edge reads as the gym's gable fascia
  for (const s of [-1, 1]) {
    put(g, new THREE.TorusGeometry(o.r + 0.02, 0.085, 6, 32, Math.PI), 'wallWhite', o.x + (s * o.len) / 2, o.y, o.z, 0, Math.PI / 2, 0);
  }
  // standing seams at even spacing
  const n = 8;
  for (let i = 1; i < n; i++) {
    const x = o.x - o.len / 2 + (i * o.len) / n;
    put(g, new THREE.TorusGeometry(o.r + 0.01, 0.028, 4, 28, Math.PI), 'steelDark', x, o.y, o.z, 0, Math.PI / 2, 0);
  }
  // eaves gutters and downspouts
  for (const s of [-1, 1]) {
    box(g, o.len + 0.2, 0.14, 0.14, 'wallWhite', o.x, o.y - 0.07, o.z + s * o.r);
  }
  cyl(g, 0.07, 0.07, o.y - G, 'steel', o.x + o.len / 2 - 0.25, G, o.z + o.r, 8);
  cyl(g, 0.07, 0.07, o.y - G, 'steel', o.x - o.len / 2 + 0.25, G, o.z + o.r, 8);
}

/** One double-hung classroom window with a white frame, ink sashes and a stone sill. */
function windowUnit(
  g: THREE.Object3D,
  o: {
    face: Face;
    plane: number;
    along: number;
    y: number;
    w: number;
    h: number;
    frame?: MatName;
    sill?: boolean;
    upperMuntin?: boolean;
  },
): void {
  const f = o.frame ?? 'wallWhite';
  const w = o.w;
  const h = o.h;
  fBox(g, o.face, o.plane, 'glow', o.along, o.y + 0.03, -0.02, w, h, 0.06);
  // outer casing, chunky enough for the ink pass to outline every bar
  fBox(g, o.face, o.plane, f, o.along - w / 2 - 0.095, o.y - 0.11, 0.02, 0.19, h + 0.22, 0.2);
  fBox(g, o.face, o.plane, f, o.along + w / 2 + 0.095, o.y - 0.11, 0.02, 0.19, h + 0.22, 0.2);
  fBox(g, o.face, o.plane, f, o.along, o.y + h + 0.035, 0.02, w + 0.38, 0.19, 0.2);
  fBox(g, o.face, o.plane, f, o.along, o.y - 0.1, 0.02, w + 0.38, 0.19, 0.2);
  // meeting rail and upper muntins
  fBox(g, o.face, o.plane, 'ink', o.along, o.y + h * 0.5, 0.06, w - 0.12, 0.07, 0.09);
  fBox(g, o.face, o.plane, 'ink', o.along, o.y, 0.06, 0.06, h - 0.1, 0.09);
  if (o.upperMuntin) {
    fBox(g, o.face, o.plane, 'ink', o.along - w / 4, o.y + h * 0.5, 0.06, 0.045, h * 0.46, 0.09);
    fBox(g, o.face, o.plane, 'ink', o.along + w / 4, o.y + h * 0.5, 0.06, 0.045, h * 0.46, 0.09);
  }
  if (o.sill !== false) {
    fBox(g, o.face, o.plane, 'concrete', o.along, o.y - 0.25, 0.0, w + 0.5, 0.14, 0.34);
    fBox(g, o.face, o.plane, 'wallWhite', o.along, o.y + h + 0.02, 0.0, w + 0.46, 0.13, 0.16);
  }
}

/** Glazed double door with a transom, white surround and kick plates. */
function doubleDoor(
  g: THREE.Object3D,
  o: {
    face: Face;
    plane: number;
    along: number;
    y: number;
    w: number;
    h: number;
    transom?: boolean;
    surround?: MatName;
  },
): void {
  const w = o.w;
  const h = o.h;
  const su = o.surround ?? 'wallWhite';
  // surround
  fBox(g, o.face, o.plane, su, o.along, o.y - 0.06, 0.0, w + 0.5, 0.16, 0.24);
  fBox(g, o.face, o.plane, su, o.along - w / 2 - 0.16, o.y - 0.06, 0.0, 0.28, h + 0.22, 0.24);
  fBox(g, o.face, o.plane, su, o.along + w / 2 + 0.16, o.y - 0.06, 0.0, 0.28, h + 0.22, 0.24);
  fBox(g, o.face, o.plane, su, o.along, o.y + h + 0.1, 0.0, w + 0.68, 0.26, 0.26);
  // ink frame and two glass leaves
  fBox(g, o.face, o.plane, 'ink', o.along, o.y, 0.05, w + 0.06, h, 0.12);
  fBox(g, o.face, o.plane, 'glow', o.along - w / 4, o.y + 0.1, 0.02, w / 2 - 0.1, h - 0.2, 0.06);
  fBox(g, o.face, o.plane, 'glow', o.along + w / 4, o.y + 0.1, 0.02, w / 2 - 0.1, h - 0.2, 0.06);
  fBox(g, o.face, o.plane, su, o.along, o.y + 0.06, 0.13, 0.07, h - 0.08, 0.06);
  fBox(g, o.face, o.plane, 'ink', o.along - w / 4, o.y + 0.06, 0.13, 0.26, 0.38, 0.06);
  fBox(g, o.face, o.plane, 'ink', o.along + w / 4, o.y + 0.06, 0.13, 0.26, 0.38, 0.06);
  // pull handles
  const n = normalOf(o.face);
  const hx = o.face === '+z' || o.face === '-z' ? o.along - 0.1 : o.along;
  const hz = o.face === '+z' || o.face === '-z' ? o.plane + n.z * 0.24 : o.along + 0.28;
  if (o.face === '+z' || o.face === '-z') {
    for (const s of [-1, 1]) {
      box(g, 0.05, 0.55, 0.06, 'ink', hx + s * 0.18, o.y + 0.9, o.plane + n.z * 0.23);
    }
  } else {
    for (const s of [-1, 1]) {
      box(g, 0.06, 0.55, 0.05, 'ink', o.plane + n.x * 0.23, o.y + 0.9, hz + s * 0.18);
    }
  }
  if (o.transom !== false) {
    fBox(g, o.face, o.plane, 'glow', o.along, o.y + h + 0.02, 0.0, w - 0.06, 0.42, 0.06);
    fBox(g, o.face, o.plane, su, o.along, o.y + h - 0.04, 0.08, w + 0.02, 0.08, 0.08);
  }
}

/** Rooftop air handler with a curb, louvre, duct and a spinning condenser fan. */
function hvacUnit(
  g: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  h = 1.15,
): void {
  box(g, w + 0.24, 0.16, d + 0.24, 'concrete', x, y, z);
  box(g, w, h, d, 'steel', x, y + 0.16, z);
  box(g, w + 0.08, 0.09, d + 0.08, 'steelDark', x, y + 0.16 + h, z);
  // louvre band, closed slots
  for (let i = 0; i < 4; i++) {
    box(g, w - 0.35, 0.055, 0.035, 'ink', x, y + 0.32 + i * 0.14, z + d / 2 + 0.02);
  }
  // fan well
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
  // flexible duct to a roof curb
  cyl(g, 0.16, 0.16, 0.9, 'steelDark', x - w / 2 - 0.35, y + 0.16, z, 8);
  box(g, 0.7, 0.14, 0.7, 'concrete', x - w / 2 - 0.35, y, z);
}

/** Small exhaust stack with a rain cap. */
function stack(g: THREE.Object3D, x: number, y: number, z: number, h = 0.9): void {
  cyl(g, 0.14, 0.16, h, 'steel', x, y, z, 10);
  cyl(g, 0.24, 0.24, 0.08, 'steelDark', x, y + h, z, 10);
  box(g, 0.5, 0.05, 0.05, 'ink', x, y + h + 0.1, z);
}

/** Glazed skylight on a flat roof, with a raised curb and ink frame. */
function skylight(g: THREE.Object3D, x: number, y: number, z: number, w = 1.2, d = 0.9): void {
  box(g, w + 0.24, 0.16, d + 0.24, 'concrete', x, y, z);
  box(g, w, 0.12, d, 'ink', x, y + 0.16, z);
  box(g, w - 0.18, 0.07, d - 0.18, 'glow', x, y + 0.2, z);
  box(g, w + 0.12, 0.07, 0.1, 'steelDark', x, y + 0.28, z);
}

/** Tilted solar panel with two steel legs down to the roof. */
function solarPanel(g: THREE.Object3D, x: number, y: number, z: number): void {
  const w = 1.35;
  const d = 0.85;
  const tilt = 0.18;
  const cy = y + 0.5;
  put(g, new THREE.BoxGeometry(w, 0.06, d), 'roofBlue', x, cy, z, tilt, 0, 0);
  for (const s of [-0.34, 0.34]) {
    rod(g, { x, y, z: z + s }, { x, y: cy - 0.05, z: z + s }, 0.035, 'steel', 6);
  }
  box(g, 0.14, 0.08, 0.14, 'ink', x, cy + 0.06, z + 0.36);
}

/** Rooftop hatch with its open lid and a caged access ladder on the rear wall. */
function roofHatch(g: THREE.Object3D, x: number, y: number, z: number): void {
  box(g, 1.15, 0.24, 1.0, 'concrete', x, y, z);
  box(g, 0.95, 0.12, 0.82, 'steelDark', x, y + 0.24, z);
  box(g, 0.92, 0.06, 0.78, 'ink', x, y + 0.35, z - 0.32);
}

/** Brick boiler chimney with a stepped cap. */
function chimney(g: THREE.Object3D, x: number, y: number, z: number, h = 1.7): void {
  box(g, 0.9, 0.24, 0.9, 'concrete', x, y, z);
  box(g, 0.58, h, 0.58, 'wallCoral', x, y + 0.24, z);
  box(g, 0.68, 0.12, 0.68, 'concrete', x, y + 0.24 + h, z);
  box(g, 0.5, 0.16, 0.5, 'ink', x, y + 0.36 + h, z);
  box(g, 0.72, 0.07, 0.72, 'steelDark', x, y + 0.52 + h, z);
}

/** White cupola with a brass bell, on the elementary roof. */
function cupola(g: THREE.Object3D, x: number, y: number, z: number): void {
  box(g, 2.3, 0.28, 2.3, 'wallWhite', x, y, z);
  for (const sx of [-0.9, 0.9]) {
    for (const sz of [-0.9, 0.9]) {
      box(g, 0.16, 1.15, 0.16, 'wallWhite', x + sx, y + 0.28, z + sz);
    }
  }
  box(g, 2.05, 0.12, 2.05, 'wallWhite', x, y + 1.43, z);
  hipRoof(g, 2.85, 2.85, 0.85, 'roofCoral', x, y + 1.55, z);
  cyl(g, 0.3, 0.42, 0.46, 'yellow', x, y + 0.55, z, 12);
  sphere(g, 0.09, 'yellow', x, y + 1.05, z, 8);
  rod(g, { x, y: y + 1.55, z }, { x, y: y + 2.55, z }, 0.035, 'steelDark', 6);
  box(g, 0.7, 0.05, 0.05, 'steelDark', x - 0.18, y + 2.45, z);
}

/** Wall bracket power port: plate, arm and a three-disc insulator. */
function powerBracket(g: THREE.Group, o: { face: Face; plane: number; along: number; y: number }): void {
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
  setPowerPorts(g, [top]);
}

/** Steel flagpole with a waving US flag (13 stripes, 20 stars) and a gold finial. */
function flagpole(g: THREE.Object3D, x: number, z: number, h = 8.6): void {
  box(g, 1.1, 0.18, 1.1, 'concrete', x, G, z);
  cyl(g, 0.3, 0.36, 0.22, 'concrete', x, G + 0.18, z, 12);
  cyl(g, 0.05, 0.075, h, 'steel', x, G + 0.4, z, 10);
  sphere(g, 0.11, 'yellow', x, G + 0.4 + h + 0.09, z, 10);
  // flag: white field, seven red stripes, blue canton, 20 star dots
  const fw = 1.9;
  const fh = 1.1;
  const fy = G + 0.4 + h - fh - 0.12;
  const fx = x + 0.09;
  box(g, fw, fh, 0.035, 'wallWhite', fx, fy, z);
  for (let i = 0; i < 7; i++) {
    box(g, fw, 0.055, 0.04, 'red', fx, fy + 0.08 + i * 0.158, z + 0.005);
  }
  box(g, fw * 0.42, fh * 0.54, 0.05, 'blue', fx, fy + fh * 0.46, z + 0.01);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      box(g, 0.035, 0.035, 0.03, 'wallWhite', fx + 0.12 + c * 0.14, fy + fh * 0.5 + r * 0.11, z + 0.04);
    }
  }
  // halyard and cleat
  rod(g, { x: x + 0.08, y: G + 0.55, z }, { x: x + 0.08, y: G + 0.4 + h, z }, 0.012, 'ink', 4);
  box(g, 0.1, 0.08, 0.26, 'steelDark', x - 0.08, G + 1.0, z);
}

/** Freestanding changeable-letter marquee on two brick piers. */
function marquee(
  g: THREE.Object3D,
  x: number,
  z: number,
  l1: string,
  l2: string,
  c1 = 0.047,
  c2 = 0.082,
): void {
  const w = 5.5;
  box(g, 1.2, 0.18, 1.3, 'concrete', x - 2.2, G, z);
  box(g, 1.2, 0.18, 1.3, 'concrete', x + 2.2, G, z);
  box(g, 0.62, 1.25, 0.62, 'wallCoral', x - 2.2, G + 0.18, z);
  box(g, 0.62, 1.25, 0.62, 'wallCoral', x + 2.2, G + 0.18, z);
  box(g, w, 2.35, 0.32, 'wallCoral', x, G + 1.43, z);
  box(g, w - 0.1, 2.15, 0.1, 'ink', x, G + 1.53, z + 0.18);
  // white frame and cap
  box(g, w + 0.16, 0.16, 0.5, 'wallWhite', x, G + 3.78, z);
  box(g, 0.16, 2.35, 0.5, 'wallWhite', x - w / 2 - 0.08, G + 1.43, z);
  box(g, 0.16, 2.35, 0.5, 'wallWhite', x + w / 2 + 0.08, G + 1.43, z);
  box(g, w + 0.3, 0.1, 0.58, 'ink', x, G + 3.94, z);
  const front = z + 0.24;
  pixelText(g, l1, { x, y: G + 2.55, z: front, cell: c1, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.04 });
  pixelText(g, l2, { x, y: G + 1.66, z: front, cell: c2, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.04 });
  // two hooded lamps wash the board at night
  for (const s of [-1.4, 1.4]) {
    box(g, 0.22, 0.1, 0.22, 'steelDark', x + s, G + 4.0, z + 0.1);
    box(g, 0.16, 0.03, 0.16, 'glow', x + s, G + 3.97, z + 0.1);
  }
  box(g, 0.1, 0.5, 0.1, 'ink', x, G + 2.55, z - 0.08);
}

/* ================================================================ transport */

/** Yellow school bus, built facing local +X, then turned to face -X. */
function schoolBus(g: THREE.Object3D, cx: number, cz: number): void {
  const b = new THREE.Group();
  b.position.set(cx, G, cz);
  b.rotation.y = Math.PI;
  g.add(b);
  // running gear
  for (const x of [-2.25, 2.35]) {
    for (const z of [-1.02, 1.02]) {
      const w = cyl(b, 0.46, 0.46, 0.3, 'ink', 0, 0, 0, 12);
      w.rotation.x = Math.PI / 2;
      w.position.set(x, 0.46, z);
      const hub = cyl(b, 0.2, 0.2, 0.32, 'steel', 0, 0, 0, 10);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(x, 0.46, z);
      box(b, 1.2, 0.16, 0.14, 'ink', x, 0.78, z * 1.08);
    }
  }
  box(b, 7.5, 0.3, 1.9, 'ink', 0, 0.36, 0);
  // skirt, body and roof
  box(b, 6.6, 0.55, 2.18, 'yellow', -0.4, 0.56, 0);
  box(b, 6.6, 1.75, 2.2, 'yellow', -0.4, 1.11, 0);
  box(b, 6.62, 0.18, 2.26, 'yellow', -0.4, 2.86, 0);
  // hood, grille and bumper
  box(b, 1.35, 0.95, 2.0, 'yellow', 3.25, 0.56, 0);
  box(b, 0.1, 0.55, 1.7, 'ink', 3.93, 0.7, 0);
  box(b, 0.18, 0.3, 2.24, 'ink', 3.95, 0.36, 0);
  box(b, 0.18, 0.3, 2.24, 'ink', -3.75, 0.36, 0);
  // windshield above the hood and the front cap of the body
  box(b, 0.07, 1.05, 1.86, 'glass', 2.96, 1.55, 0);
  box(b, 0.06, 0.16, 2.0, 'yellow', 2.93, 2.66, 0);
  // side windows in a black band, separated by yellow pillars
  const winX = [-2.75, -1.6, -0.45, 0.7, 1.85];
  for (const z of [-1.11, 1.11]) {
    box(b, 5.75, 0.86, 0.04, 'glass', -0.35, 1.68, z);
    for (const x of winX) {
      if (z > 0 && x > 1.7) continue; // door occupies the front bay on the kerb side
      box(b, 0.98, 0.72, 0.05, 'glow', x, 1.74, z + Math.sign(z) * 0.025);
    }
    for (const x of [-2.16, -1.01, 0.14, 1.29, 2.42]) {
      box(b, 0.13, 0.9, 0.07, 'yellow', x, 1.67, z);
    }
    // rub rails
    for (const y of [1.02, 1.42, 2.62]) box(b, 6.7, 0.07, 0.04, 'ink', -0.35, y, z + Math.sign(z) * 0.02);
    // SCHOOL BUS lettering on both sides
    pixelText(b, 'SCHOOL BUS', {
      x: -1.9,
      y: 1.08,
      z: z + Math.sign(z) * 0.045,
      cell: 0.024,
      face: z > 0 ? '+z' : '-z',
      mat: 'ink',
      depth: 0.025,
    });
  }
  // loading door on the kerb side (local +Z)
  box(b, 0.95, 2.12, 0.07, 'ink', 2.35, 0.74, 1.115);
  box(b, 0.8, 1.92, 0.04, 'glow', 2.35, 0.84, 1.155);
  box(b, 0.06, 1.9, 0.05, 'yellow', 2.35, 0.85, 1.16);
  // stop sign on the driver side and crossing arm at the front
  const oct = put(b, new THREE.CylinderGeometry(0.36, 0.36, 0.05, 8), 'red', 0.7, 1.75, -1.18, Math.PI / 2, 0, 0);
  oct.rotation.z = Math.PI / 8;
  pixelText(b, 'STOP', { x: 0.48, y: 1.63, z: -1.22, cell: 0.021, face: '-z', mat: 'wallWhite', depth: 0.03 });
  box(b, 0.5, 0.07, 0.07, 'ink', 0.7, 2.14, -1.03);
  box(b, 0.07, 0.07, 1.3, 'yellow', 3.9, 0.9, 1.45);
  box(b, 0.34, 0.34, 0.05, 'yellow', 3.9, 0.72, 2.05);
  // lights, roof hatches and rear door
  for (const z of [-0.62, 0.62]) {
    box(b, 0.05, 0.18, 0.28, 'glow', 4.04, 0.78, z);
    box(b, 0.05, 0.18, 0.2, 'red', -3.83, 0.95, z);
  }
  box(b, 0.05, 0.35, 0.55, 'orange', 4.02, 1.45, 0);
  for (const x of [-1.6, 0.6]) {
    box(b, 0.72, 0.07, 0.85, 'steelDark', x, 3.04, 0);
    box(b, 0.55, 0.03, 0.65, 'yellow', x, 3.11, 0);
  }
  box(b, 0.9, 1.55, 0.06, 'glass', -3.7, 1.05, 0);
  box(b, 0.06, 0.55, 0.06, 'ink', -3.74, 1.55, -0.45);
  // licence plate and mud flaps
  box(b, 0.04, 0.22, 0.34, 'wallWhite', -3.88, 0.62, 0);
  box(b, 0.3, 0.35, 0.04, 'ink', -2.25, 0.2, -1.12);
  box(b, 0.3, 0.35, 0.04, 'ink', -2.25, 0.2, 1.12);
}

/** Parked sedan, front +X locally; rotY turns it in the lot. */
function car(g: THREE.Object3D, x: number, z: number, body: MatName, rotY = Math.PI / 2): void {
  const c = new THREE.Group();
  c.position.set(x, G, z);
  c.rotation.y = rotY;
  g.add(c);
  box(c, 4.2, 0.62, 1.8, body, 0, 0.32, 0);
  box(c, 2.1, 0.62, 1.58, 'glass', -0.18, 0.94, 0);
  box(c, 1.75, 0.08, 1.62, body, -0.22, 1.56, 0);
  box(c, 1.15, 0.1, 1.56, body, -1.5, 0.9, 0);
  box(c, 0.9, 0.1, 1.56, body, 1.55, 0.9, 0);
  box(c, 0.1, 0.18, 1.74, 'ink', 2.13, 0.33, 0);
  box(c, 0.1, 0.18, 1.74, 'ink', -2.13, 0.33, 0);
  for (const zz of [-0.58, 0.58]) {
    box(c, 0.05, 0.13, 0.3, 'glow', 2.1, 0.62, zz);
    box(c, 0.05, 0.13, 0.3, 'red', -2.1, 0.62, zz);
  }
  for (const xx of [-1.3, 1.3]) {
    for (const zz of [-0.84, 0.84]) {
      const w = cyl(c, 0.33, 0.33, 0.24, 'ink', 0, 0, 0, 10);
      w.rotation.x = Math.PI / 2;
      w.position.set(xx, 0.33, zz);
    }
  }
}

/* ================================================================ grounds kit */

/** Round deciduous tree: trunk, two shade tones, a low shrub at the foot. */
function tree(g: THREE.Object3D, x: number, z: number, s = 1): void {
  cyl(g, 0.21 * s, 0.32 * s, 2.7 * s, 'wood', x, G, z, 8);
  sphere(g, 1.65 * s, 'green', x, G + 3.55 * s, z, 12);
  sphere(g, 1.25 * s, 'roofGreen', x + 0.95 * s, G + 3.0 * s, z + 0.35 * s, 10);
  sphere(g, 1.1 * s, 'green', x - 0.75 * s, G + 3.1 * s, z - 0.55 * s, 10);
  sphere(g, 0.55 * s, 'roofGreen', x + 0.55 * s, G + 0.55 * s, z - 0.35 * s, 8);
}

function bush(g: THREE.Object3D, x: number, z: number, s = 1): void {
  sphere(g, 0.58 * s, 'green', x, G + 0.4 * s, z, 9);
  sphere(g, 0.45 * s, 'roofGreen', x + 0.45 * s, G + 0.33 * s, z + 0.2 * s, 8);
}

/** Bench facing +Z: timber seat and back on steel legs. */
function bench(g: THREE.Object3D, x: number, z: number): void {
  box(g, 2.3, 0.12, 0.58, 'wood', x, G + 0.46, z);
  box(g, 2.3, 0.42, 0.1, 'wood', x, G + 0.62, z - 0.27);
  for (const s of [-0.85, 0.85]) {
    box(g, 0.08, 0.46, 0.52, 'steelDark', x + s, G, z);
    box(g, 0.08, 0.62, 0.08, 'steelDark', x + s, G + 0.46, z - 0.28);
  }
}

/** Picnic table with attached benches and A-frame legs. */
function picnicTable(g: THREE.Object3D, x: number, z: number): void {
  box(g, 2.0, 0.1, 0.9, 'wood', x, G + 0.72, z);
  for (const s of [-0.66, 0.66]) box(g, 2.0, 0.08, 0.3, 'wood', x, G + 0.42, z + s);
  for (const s of [-0.75, 0.75]) {
    rod(g, { x: x + s, y: G, z: z - 0.55 }, { x: x + s, y: G + 0.72, z: z }, 0.05, 'steelDark', 5);
    rod(g, { x: x + s, y: G, z: z + 0.55 }, { x: x + s, y: G + 0.72, z: z }, 0.05, 'steelDark', 5);
  }
}

function trashCan(g: THREE.Object3D, x: number, z: number): void {
  cyl(g, 0.3, 0.27, 0.92, 'steelDark', x, G, z, 12);
  cyl(g, 0.33, 0.33, 0.07, 'ink', x, G + 0.92, z, 12);
  cyl(g, 0.31, 0.31, 0.06, 'blue', x, G + 0.55, z, 12);
}

/** Three inverted-U bike hoops on a concrete pad. */
function bikeRack(g: THREE.Object3D, x: number, z: number): void {
  box(g, 3.0, 0.06, 1.0, 'concrete', x, G, z);
  for (let i = 0; i < 3; i++) {
    const bx = x - 0.9 + i * 0.9;
    rod(g, { x: bx, y: G + 0.06, z: z - 0.34 }, { x: bx, y: G + 0.82, z: z - 0.34 }, 0.045, 'steel', 6);
    rod(g, { x: bx, y: G + 0.06, z: z + 0.34 }, { x: bx, y: G + 0.82, z: z + 0.34 }, 0.045, 'steel', 6);
    rod(g, { x: bx, y: G + 0.82, z: z - 0.34 }, { x: bx, y: G + 0.82, z: z + 0.34 }, 0.045, 'steel', 6);
  }
}

/** Red fire hydrant with side caps and a top nut. */
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

/** Steel sign post with a board; `kind` picks a school-zone or speed sign. */
function streetSign(g: THREE.Object3D, x: number, z: number, kind: 'school' | '20'): void {
  cyl(g, 0.055, 0.07, 2.6, 'steel', x, G, z, 8);
  if (kind === 'school') {
    box(g, 1.55, 0.82, 0.07, 'ink', x, G + 1.65, z);
    box(g, 1.43, 0.7, 0.08, 'yellow', x, G + 1.71, z + 0.02);
    pixelText(g, 'SCHOOL', { x, y: G + 1.83, z: z + 0.075, cell: 0.038, face: '+z', mat: 'ink', align: 'center', depth: 0.02 });
  } else {
    box(g, 0.82, 1.04, 0.06, 'ink', x, G + 1.45, z);
    box(g, 0.7, 0.92, 0.07, 'wallWhite', x, G + 1.51, z + 0.02);
    pixelText(g, '20', { x, y: G + 1.83, z: z + 0.06, cell: 0.082, face: '+z', mat: 'ink', align: 'center', depth: 0.02 });
    box(g, 0.5, 0.05, 0.03, 'ink', x, G + 1.64, z + 0.07);
  }
}

/* ================================================================ playground */

/** Play tower with a slide, climbing wall, ladder and rails, on the mulch mat. */
function playTower(g: THREE.Object3D, x: number, z: number): void {
  const y = G + 0.06;
  for (const sx of [-0.9, 0.9]) {
    for (const sz of [-0.9, 0.9]) {
      box(g, 0.14, 2.95, 0.14, 'steel', x + sx, y, z + sz);
    }
  }
  box(g, 1.9, 0.14, 1.9, 'wood', x, y + 1.35, z);
  // guard rails around the platform, open at the slide
  for (const s of [-0.88, 0.88]) {
    rod(g, { x: x + s, y: y + 1.49, z: z - 0.9 }, { x: x + s, y: y + 2.25, z: z - 0.9 }, 0.045, 'yellow', 5);
  }
  rod(g, { x: x - 0.9, y: y + 2.25, z: z - 0.9 }, { x: x - 0.9, y: y + 2.25, z: z + 0.9 }, 0.045, 'yellow', 5);
  rod(g, { x: x - 0.9, y: y + 2.25, z: z - 0.9 }, { x: x + 0.9, y: y + 2.25, z: z - 0.9 }, 0.045, 'yellow', 5);
  rod(g, { x: x - 0.9, y: y + 2.25, z: z + 0.9 }, { x: x + 0.9, y: y + 2.25, z: z + 0.9 }, 0.045, 'yellow', 5);
  hipRoof(g, 2.5, 2.5, 0.9, 'roofCoral', x, y + 2.95, z);
  // slide down +X from the platform
  const run = 2.5;
  const drop = 1.3;
  const ang = Math.atan2(drop, run);
  put(g, new THREE.BoxGeometry(run, 0.09, 0.82), 'orange', x + 1.55, y + 0.72, z, 0, 0, -ang);
  for (const s of [-0.44, 0.44]) {
    put(g, new THREE.BoxGeometry(run, 0.2, 0.07), 'yellow', x + 1.55, y + 0.87, z + s, 0, 0, -ang);
  }
  box(g, 0.12, 0.5, 0.96, 'yellow', x + 2.85, y, z);
  // ladder on the -Z face
  for (const s of [-0.36, 0.36]) {
    rod(g, { x: x + s, y, z: z - 0.95 }, { x: x + s, y: y + 1.35, z: z - 0.95 }, 0.045, 'steel', 5);
  }
  for (let i = 0; i < 4; i++) {
    rod(g, { x: x - 0.36, y: y + 0.28 + i * 0.3, z: z - 0.95 }, { x: x + 0.36, y: y + 0.28 + i * 0.3, z: z - 0.95 }, 0.035, 'steel', 5);
  }
  // climbing wall on the +Z face with coloured holds
  put(g, new THREE.BoxGeometry(1.5, 0.09, 1.15), 'blue', x, y + 0.35, z + 1.3, -0.85, 0, 0);
  const holds: Array<[number, number, MatName]> = [
    [-0.5, 0.55, 'yellow'],
    [0.2, 0.62, 'red'],
    [0.52, 0.9, 'orange'],
    [-0.24, 1.0, 'yellow'],
  ];
  for (const [hx, hy, mat] of holds) box(g, 0.14, 0.08, 0.1, mat, x + hx, y + hy, z + 1.3);
}

/** Two-seat A-frame swing set. */
function swingSet(g: THREE.Object3D, x: number, z: number): void {
  const y = G + 0.06;
  for (const s of [-1.5, 1.5]) {
    rod(g, { x: x + s, y, z: z - 1.15 }, { x: x + s, y: y + 2.55, z }, 0.075, 'steel', 6);
    rod(g, { x: x + s, y, z: z + 1.15 }, { x: x + s, y: y + 2.55, z }, 0.075, 'steel', 6);
    box(g, 0.9, 0.1, 0.12, 'steelDark', x + s, y, z);
  }
  rod(g, { x: x - 1.5, y: y + 2.55, z }, { x: x + 1.5, y: y + 2.55, z }, 0.075, 'steel', 8);
  for (const s of [-0.65, 0.65]) {
    for (const c of [-0.28, 0.28]) {
      rod(g, { x: x + s + c, y: y + 0.7, z }, { x: x + s + c, y: y + 2.55, z }, 0.018, 'ink', 4);
    }
    box(g, 0.58, 0.07, 0.3, 'blue', x + s, y + 0.63, z);
  }
}

/** Bouncy spring rider: spring, saddle, handlebar and footrests. */
function springRider(g: THREE.Object3D, x: number, z: number): void {
  const y = G + 0.06;
  for (let i = 0; i < 4; i++) {
    const ring = put(g, new THREE.TorusGeometry(0.16, 0.035, 5, 12), 'steel', x, y + 0.12 + i * 0.1, z, Math.PI / 2, 0, 0);
    ring.rotation.z = i * 0.5;
  }
  box(g, 0.22, 0.32, 0.6, 'yellow', x, y + 0.52, z);
  box(g, 0.18, 0.3, 0.18, 'red', x, y + 0.8, z - 0.18);
  rod(g, { x, y: y + 0.88, z: z + 0.12 }, { x, y: y + 1.15, z: z + 0.12 }, 0.035, 'steelDark', 5);
  rod(g, { x: x - 0.24, y: y + 1.15, z: z + 0.12 }, { x: x + 0.24, y: y + 1.15, z: z + 0.12 }, 0.03, 'ink', 5);
  for (const s of [-1, 1]) box(g, 0.28, 0.05, 0.12, 'steelDark', x + s * 0.2, y + 0.55, z + 0.18);
}

/** Seesaw: plank on a steel fulcrum with two handles. */
function seesaw(g: THREE.Object3D, x: number, z: number): void {
  const y = G + 0.06;
  box(g, 0.6, 0.5, 0.6, 'steelDark', x, y, z);
  put(g, new THREE.BoxGeometry(3.2, 0.1, 0.4), 'yellow', x, y + 0.7, z, 0, 0, 0.12);
  for (const s of [-1.3, 1.3]) {
    rod(g, { x: x + s, y: y + 0.7, z }, { x: x + s, y: y + 1.12, z }, 0.035, 'ink', 5);
    rod(g, { x: x + s - 0.2, y: y + 1.12, z }, { x: x + s + 0.2, y: y + 1.12, z }, 0.03, 'ink', 5);
  }
}

/** Half-court with white key and boundary, plus a detailed hoop facing -X. */
function halfCourt(g: THREE.Object3D, cx: number, cz: number, w = 8.4, d = 4.8): void {
  const y = G + 0.02;
  box(g, w, 0.05, d, 'asphalt', cx, y, cz);
  box(g, w, 0.02, 0.07, 'wallWhite', cx, y + 0.05, cz - d / 2 + 0.06);
  box(g, w, 0.02, 0.07, 'wallWhite', cx, y + 0.05, cz + d / 2 - 0.06);
  box(g, 0.07, 0.02, d, 'wallWhite', cx - w / 2 + 0.06, y + 0.05, cz);
  box(g, 0.07, 0.02, d, 'wallWhite', cx + w / 2 - 0.06, y + 0.05, cz);
  // key and free-throw circle at the hoop end
  box(g, 2.4, 0.02, 0.07, 'wallWhite', cx + w / 2 - 1.5, y + 0.05, cz - 0.9);
  box(g, 2.4, 0.02, 0.07, 'wallWhite', cx + w / 2 - 1.5, y + 0.05, cz + 0.9);
  box(g, 0.07, 0.02, 1.8, 'wallWhite', cx + w / 2 - 2.7, y + 0.05, cz);
  put(g, new THREE.TorusGeometry(0.55, 0.035, 4, 20, Math.PI), 'wallWhite', cx + w / 2 - 2.7, y + 0.06, cz, -Math.PI / 2, 0, Math.PI / 2);
  // hoop at the +X baseline
  const hx = cx + w / 2 - 0.35;
  cyl(g, 0.09, 0.11, 3.25, 'steel', hx, y, cz, 8);
  rod(g, { x: hx, y: y + 3.05, z: cz }, { x: hx - 0.55, y: y + 3.05, z: cz }, 0.05, 'steel', 6);
  box(g, 0.06, 1.0, 1.75, 'wallWhite', hx - 0.62, y + 2.55, cz);
  box(g, 0.07, 0.62, 0.42, 'ink', hx - 0.66, y + 2.68, cz);
  put(g, new THREE.TorusGeometry(0.23, 0.025, 6, 16), 'orange', hx - 0.9, y + 3.02, cz, Math.PI / 2, 0, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    rod(g, { x: hx - 0.9 + Math.cos(a) * 0.21, y: y + 3.0, z: cz + Math.sin(a) * 0.21 }, { x: hx - 0.9 + Math.cos(a) * 0.13, y: y + 2.65, z: cz + Math.sin(a) * 0.13 }, 0.012, 'wallWhite', 4);
  }
}

/** Chain-link boundary: posts, top and mid rails, with a gate gap. */
function fence(g: THREE.Object3D, x0: number, z0: number, x1: number, z1: number, h = 1.25): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(2, Math.round(len / 2.4));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = x0 + (x1 - x0) * t;
    const pz = z0 + (z1 - z0) * t;
    cyl(g, 0.045, 0.055, h, 'steel', px, G, pz, 6);
  }
  rod(g, { x: x0, y: G + h, z: z0 }, { x: x1, y: G + h, z: z1 }, 0.04, 'steel', 5);
  rod(g, { x: x0, y: G + h * 0.5, z: z0 }, { x: x1, y: G + h * 0.5, z: z1 }, 0.03, 'steel', 5);
}

/* ================================================================ site A: Washington Elementary */

function elementary(g: THREE.Group): void {
  const y0 = G;

  /* ---- lot, lawns, walk, bus loop, sidewalk ---- */
  box(g, 34.4, G, 22.4, 'paving', 0, 0, 0);
  box(g, 8.6, 0.05, 3.3, 'grass', -11.9, y0, 6.55);
  box(g, 21.2, 0.05, 3.3, 'grass', 5.8, y0, 6.55);
  box(g, 1.9, 0.05, 14.6, 'grass', -16.2, y0, -2.5);
  box(g, 2.4, 0.05, 14.6, 'grass', 15.9, y0, -2.5);
  box(g, 0.14, 0.12, 14.7, 'concrete', -15.28, y0, -2.5);
  box(g, 0.14, 0.12, 14.7, 'concrete', 14.72, y0, -2.5);
  box(g, 1.95, 0.12, 0.14, 'concrete', -16.2, y0, -9.82);
  box(g, 2.45, 0.12, 0.14, 'concrete', 15.9, y0, -9.82);
  // entrance walk and a pad at the rear door
  box(g, 2.4, 0.07, 2.4, 'concrete', -6.2, y0, 7.0);
  box(g, 1.8, 0.06, 2.4, 'concrete', 2.0, y0, -3.1);
  // bus loop
  box(g, 33.2, 0.06, 2.2, 'asphalt', 0, y0, 9.3);
  box(g, 33.2, 0.18, 0.16, 'concrete', 0, y0, 8.2);
  box(g, 33.2, 0.18, 0.16, 'concrete', 0, y0, 10.4);
  box(g, 33.2, 0.06, 0.03, 'yellow', 0, y0 + 0.05, 8.31);
  box(g, 34.4, 0.1, 0.8, 'concrete', 0, y0, 10.8);
  for (let x = -15.2; x <= 15.3; x += 2.2) {
    if (x > -7.4 && x < -5.0) continue;
    box(g, 0.95, 0.02, 0.09, 'wallWhite', x, y0 + 0.06, 9.3);
  }
  for (let i = 0; i < 6; i++) {
    box(g, 1.7, 0.02, 0.24, 'wallWhite', -6.2, y0 + 0.06, 8.48 + i * 0.31);
  }
  box(g, 3.0, 0.02, 0.1, 'wallWhite', -6.2, y0 + 0.06, 8.28);

  /* ---- classroom bar: red brick, two storeys ---- */
  const B: Block = { cx: -6.2, cz: 1.3, hw: 8.8, hd: 3.3 };
  const top = y0 + 2 * 3.3;
  box(g, 17.6, 2 * 3.3, 6.6, 'wallCoral', B.cx, y0, B.cz);
  box(g, 17.76, 0.5, 6.76, 'concrete', B.cx, y0, B.cz);
  box(g, 17.8, 0.24, 6.8, 'wallWhite', B.cx, y0 + 3.24, B.cz);
  box(g, 17.92, 0.3, 6.92, 'wallWhite', B.cx, y0 + 6.3, B.cz);
  // brick pilasters mark the entrance bays and break up the long facade
  for (const px of [-14.92, -8.25, -4.15, 2.5]) {
    box(g, 0.26, 5.75, 0.12, 'wallCoral', px, y0 + 0.5, 4.63);
  }
  flatRoof(g, B, top, 0.6, 'wallCoral');

  // front windows: four bays left, one above the entrance, four right
  const rowsY = [y0 + 0.95, y0 + 4.05];
  for (const wy of rowsY) {
    for (const wx of [-14.0, -12.3, -10.6, -8.9, -3.6, -1.9, -0.2, 1.5]) {
      windowUnit(g, { face: '+z', plane: 4.6, along: wx, y: wy, w: 1.35, h: 1.9, upperMuntin: true });
    }
  }
  windowUnit(g, { face: '+z', plane: 4.6, along: -6.2, y: rowsY[1], w: 1.35, h: 1.9, upperMuntin: true });
  // rear windows and a service door
  for (const wy of rowsY) {
    for (const wx of [-13.6, -11.6, -9.6, -7.6, -5.6, -3.6, -1.6, 0.4]) {
      windowUnit(g, { face: '-z', plane: -2.0, along: wx, y: wy, w: 1.35, h: 1.9, upperMuntin: true });
    }
  }
  // west end windows
  for (const wy of rowsY) {
    for (const wz of [-0.6, 1.0, 2.6]) {
      windowUnit(g, { face: '-x', plane: -15.0, along: wz, y: wy, w: 1.25, h: 1.9, upperMuntin: true });
    }
  }
  // rear service door under a small hood
  fBox(g, '-z', -2.0, 'ink', 2.0, y0 + 0.05, 0.02, 1.25, 2.15, 0.1);
  fBox(g, '-z', -2.0, 'steel', 2.0, y0 + 0.12, 0.12, 1.05, 1.95, 0.06);
  fBox(g, '-z', -2.0, 'wallWhite', 2.0, y0 + 2.38, 0.0, 1.8, 0.16, 0.5);
  box(g, 1.8, 0.14, 0.9, 'concrete', 2.0, y0, -2.45);

  /* ---- formal entrance: projecting brick vestibule, canopy, steps, ramp ---- */
  box(g, 3.4, 4.0, 0.95, 'wallCoral', -6.2, y0, 5.08);
  box(g, 3.64, 0.16, 1.15, 'wallWhite', -6.2, y0 + 4.0, 5.08);
  doubleDoor(g, { face: '+z', plane: 5.555, along: -6.2, y: y0 + 0.2, w: 2.2, h: 2.35, transom: true });
  // sidelights either side of the doors
  for (const s of [-1.55, 1.55]) {
    fBox(g, '+z', 5.555, 'glow', -6.2 + s, y0 + 0.35, 0.0, 0.34, 2.0, 0.06);
    fBox(g, '+z', 5.555, 'wallWhite', -6.2 + s, y0 + 0.2, 0.06, 0.46, 2.35, 0.12);
  }
  // stoop and two steps
  box(g, 5.8, 0.2, 2.15, 'concrete', -6.2, y0, 6.58);
  box(g, 5.8, 0.12, 0.32, 'concrete', -6.2, y0, 7.73);
  box(g, 5.8, 0.06, 0.32, 'concrete', -6.2, y0, 7.98);
  box(g, 0.22, 0.32, 2.15, 'concrete', -9.02, y0, 6.58);
  box(g, 0.22, 0.32, 2.15, 'concrete', -3.38, y0, 6.58);
  // accessible ramp at the left cheek
  put(g, new THREE.BoxGeometry(1.05, 0.09, 2.9), 'concrete', -9.65, y0 + 0.14, 6.9, -0.072, 0, 0);
  for (const s of [-0.58, 0.58]) {
    for (const zz of [5.75, 7.95]) {
      box(g, 0.06, 0.92, 0.06, 'steel', -9.65 + s, y0 + 0.22, zz);
    }
    rod(g, { x: -9.65 + s, y: y0 + 1.12, z: 5.7 }, { x: -9.65 + s, y: y0 + 1.12, z: 8.0 }, 0.04, 'steel', 5);
  }
  // canopy: slab, ink fascia with SCHOOL lettering, two posts, downlights
  box(g, 5.6, 0.22, 2.1, 'wallWhite', -6.2, y0 + 3.56, 6.55);
  box(g, 5.72, 0.42, 0.12, 'ink', -6.2, y0 + 3.46, 7.58);
  pixelText(g, 'SCHOOL', { x: -6.2, y: y0 + 3.55, z: 7.65, cell: 0.046, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.03 });
  for (const px of [-8.6, -3.8]) {
    box(g, 0.16, 3.36, 0.16, 'wallWhite', px, y0 + 0.32, 7.2);
    box(g, 0.34, 0.08, 0.34, 'steelDark', px, y0 + 0.24, 7.2);
  }
  for (const px of [-7.4, -4.9]) {
    box(g, 0.34, 0.05, 0.34, 'glow', px, y0 + 3.5, 6.9);
  }
  // planters flanking the walk
  for (const px of [-8.35, -4.05]) {
    box(g, 0.82, 0.48, 0.82, 'wallCoral', px, y0, 7.9);
    box(g, 0.9, 0.1, 0.9, 'concrete', px, y0 + 0.48, 7.9);
    bush(g, px, 7.9, 0.65);
  }

  /* ---- gymnasium: cream walls, brick base, green barrel roof ---- */
  const GB: Block = { cx: 8.5, cz: 0.4, hw: 5.9, hd: 3.2 };
  const gy = y0 + 5.1;
  box(g, 11.8, 5.1, 6.4, 'wallCream', GB.cx, y0, GB.cz);
  box(g, 11.88, 1.05, 6.48, 'wallCoral', GB.cx, y0, GB.cz);
  for (const px of [2.78, 14.22]) {
    for (const pz of [-2.68, 3.48]) {
      box(g, 0.36, 4.05, 0.36, 'wallWhite', px, y0 + 1.05, pz);
    }
  }
  box(g, 11.92, 0.2, 6.52, 'wallWhite', GB.cx, y0 + 4.78, GB.cz);
  barrelRoof(g, { x: GB.cx, y: gy, z: GB.cz, len: 11.8, r: 2.0, mat: 'roofGreen' });
  // front windows, upper transoms, gym doors under a canopy
  for (const wx of [4.4, 6.0, 7.6, 9.2]) {
    windowUnit(g, { face: '+z', plane: 3.6, along: wx, y: y0 + 1.28, w: 1.2, h: 1.95 });
  }
  for (const wx of [4.4, 7.6, 10.8]) {
    windowUnit(g, { face: '+z', plane: 3.6, along: wx, y: y0 + 3.55, w: 1.05, h: 0.68, sill: false });
  }
  doubleDoor(g, { face: '+z', plane: 3.6, along: 12.15, y: y0 + 0.15, w: 2.15, h: 2.35, transom: true });
  box(g, 3.3, 0.12, 1.0, 'concrete', 12.15, y0, 4.05);
  box(g, 3.4, 0.18, 1.65, 'wallWhite', 12.15, y0 + 3.42, 4.2);
  box(g, 3.52, 0.36, 0.1, 'ink', 12.15, y0 + 3.33, 5.06);
  pixelText(g, 'GYM', { x: 12.15, y: y0 + 3.4, z: 5.13, cell: 0.062, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.03 });
  for (const px of [10.85, 13.45]) {
    rod(g, { x: px, y: y0 + 3.42, z: 4.95 }, { x: px, y: y0 + 4.7, z: 3.62 }, 0.035, 'steel', 5);
    box(g, 0.24, 0.05, 0.24, 'glow', px, y0 + 3.36, 4.2);
  }
  // west and east end windows; a round gym window in the east wall
  for (const wz of [-1.2, 2.0]) {
    windowUnit(g, { face: '+x', plane: 14.4, along: wz, y: y0 + 1.28, w: 1.2, h: 1.95 });
  }
  const ring = put(g, new THREE.TorusGeometry(0.92, 0.11, 6, 24), 'wallWhite', 14.42, y0 + 3.1, 0.4, 0, Math.PI / 2, 0);
  ring.rotation.x = 0;
  const disc = cyl(g, 0.84, 0.84, 0.08, 'glow', 0, 0, 0, 20);
  disc.rotation.z = Math.PI / 2;
  disc.position.set(14.4, y0 + 3.1, 0.4);
  box(g, 0.1, 1.7, 0.08, 'wallWhite', 14.46, y0 + 2.25, 0.4);
  box(g, 0.1, 0.08, 1.7, 'wallWhite', 14.46, y0 + 3.06, 0.4);
  // rear windows, service door and louvres
  for (const wx of [4.4, 6.8, 9.2, 11.6]) {
    windowUnit(g, { face: '-z', plane: -2.8, along: wx, y: y0 + 1.28, w: 1.2, h: 1.95 });
  }
  fBox(g, '-z', -2.8, 'ink', 13.1, y0 + 0.12, 0.02, 1.2, 2.2, 0.1);
  fBox(g, '-z', -2.8, 'steel', 13.1, y0 + 0.2, 0.12, 1.0, 2.0, 0.05);
  box(g, 1.6, 0.14, 0.8, 'concrete', 13.1, y0, -3.2);
  for (const wx of [3.2, 4.1]) {
    fBox(g, '-z', -2.8, 'ink', wx, y0 + 3.3, 0.0, 0.75, 0.9, 0.08);
    for (let i = 0; i < 5; i++) fBox(g, '-z', -2.8, 'steelDark', wx, y0 + 3.36 + i * 0.15, 0.08, 0.65, 0.045, 0.04);
  }

  /* ---- classroom roof plant: cupola, HVAC, skylights, solar, chimney ---- */
  cupola(g, -6.2, top + 0.06, 1.3);
  hvacUnit(g, -11.8, top + 0.06, 0.8, 2.2, 1.4);
  hvacUnit(g, -1.2, top + 0.06, 1.6, 2.0, 1.3, 1.0);
  for (const sx of [-13.3, -11.5, -9.7]) skylight(g, sx, top + 0.06, -0.9);
  for (const sx of [-4.3, -2.8, -1.3, 0.2]) solarPanel(g, sx, top + 0.06, -0.8);
  chimney(g, -8.8, top + 0.06, 2.5);
  roofHatch(g, 1.8, top + 0.06, 1.5);
  stack(g, -13.4, top + 0.06, 2.3, 0.85);
  stack(g, 0.6, top + 0.06, 2.4, 0.75);
  // downpipes and scuppers
  for (const px of [-14.82, 2.42]) {
    for (const pz of [4.58, -1.98]) {
      cyl(g, 0.075, 0.075, top - G, 'steel', px, G, pz, 8);
      box(g, 0.16, 0.1, 0.16, 'steelDark', px, G + 0.02, pz);
    }
  }
  for (const px of [-11.2, 0.4]) box(g, 0.5, 0.16, 0.55, 'concrete', px, top + 0.3, 4.62);

  /* ---- playground on the west half of the rear yard ---- */
  box(g, 11.4, 0.06, 4.8, 'wood', -7.2, G, -7.2);
  box(g, 11.5, 0.14, 0.16, 'concrete', -7.2, G, -4.78);
  box(g, 11.5, 0.14, 0.16, 'concrete', -7.2, G, -9.62);
  box(g, 0.16, 0.14, 4.8, 'concrete', -12.92, G, -7.2);
  box(g, 0.16, 0.14, 4.8, 'concrete', -1.48, G, -7.2);
  playTower(g, -10.3, -7.6);
  swingSet(g, -5.0, -8.4);
  springRider(g, -2.8, -6.2);
  seesaw(g, -4.4, -5.5);
  // a second climbing bar between tower and swing
  for (const px of [-7.6, -6.4]) box(g, 0.1, 2.2, 0.1, 'steel', px, G + 0.06, -8.8);
  rod(g, { x: -7.6, y: G + 2.26, z: -8.8 }, { x: -6.4, y: G + 2.26, z: -8.8 }, 0.055, 'steel', 6);
  for (let i = 0; i < 4; i++) rod(g, { x: -7.4 + i * 0.33, y: G + 2.2, z: -8.8 }, { x: -7.4 + i * 0.33, y: G + 1.75, z: -8.8 }, 0.025, 'ink', 4);

  /* ---- basketball half court east of the playground ---- */
  halfCourt(g, 8.6, -7.2);
  // paved path from the rear service door to the court
  box(g, 1.6, 0.05, 2.6, 'concrete', 2.0, G, -3.3);

  /* ---- playground fence, gates and the rear pair of trees ---- */
  fence(g, -13.6, -10.5, 0.6, -10.5, 1.3);
  fence(g, 3.4, -10.5, 13.6, -10.5, 1.3);
  fence(g, -13.6, -10.5, -13.6, -4.2, 1.3);
  fence(g, 13.6, -10.5, 13.6, -4.2, 1.3);
  for (const px of [0.6, 3.4]) box(g, 0.14, 1.5, 0.14, 'steelDark', px, G, -10.5);
  box(g, 2.8, 0.06, 0.06, 'ink', 2.0, G + 1.35, -10.5);
  tree(g, -15.4, -9.9, 0.95);
  tree(g, 15.4, -9.9, 0.95);
  tree(g, 15.2, -3.8, 0.8);

  /* ---- front grounds: flag, bench, bike rack, signs, hydrant ---- */
  flagpole(g, -12.2, 6.9);
  bench(g, -9.8, 7.0);
  bench(g, 14.0, 7.2);
  bikeRack(g, 3.9, 6.2);
  hydrant(g, 12.4, 8.0);
  trashCan(g, 10.0, 7.8);
  streetSign(g, -8.6, 10.82, 'school');
  streetSign(g, 12.0, 10.82, '20');
  for (const px of [-12.6, -1.8]) {
    box(g, 3.5, 0.16, 0.9, 'concrete', px, G, 5.0);
    box(g, 3.2, 0.32, 0.6, 'green', px, G + 0.16, 5.0);
    box(g, 3.32, 0.08, 0.7, 'roofGreen', px, G + 0.48, 5.0);
  }
  box(g, 4.5, 0.16, 0.85, 'concrete', 6.4, G, 3.98);
  box(g, 4.2, 0.26, 0.55, 'green', 6.4, G + 0.16, 3.98);
  // lawn trees
  tree(g, -14.6, 6.3, 0.95);
  tree(g, 14.4, 6.3, 0.85);
  tree(g, 15.2, -3.8, 0.8);

  /* ---- two school buses and the marquee ---- */
  schoolBus(g, -12.4, 9.3);
  schoolBus(g, 7.2, 9.3);
  box(g, 6.0, 0.06, 1.7, 'concrete', 0.2, y0, 7.4);
  marquee(g, 0.2, 7.4, 'HOME OF THE', 'TROJANS');
  // backpack bench and a waiting parent's car in the pickup bay? keep the loop clear
  picnicTable(g, -1.1, -3.35);

  /* ---- power port on the west end wall near the street ---- */
  powerBracket(g, { face: '-x', plane: -15.0, along: 3.9, y: 6.1 });
}

/* ================================================================ stadium kit */

/** Four-row aluminium bleacher facing -Z, with a rear rail and end rails. */
function bleachers(g: THREE.Object3D, x: number, z: number, w = 6.4): void {
  for (let i = 0; i < 4; i++) {
    const y = G + i * 0.36;
    const zz = z + i * 0.46;
    box(g, w, 0.34, 0.46, 'concrete', x, y, zz);
    box(g, w, 0.08, 0.44, 'steel', x, y + 0.34, zz);
    box(g, w, 0.05, 0.06, 'steelDark', x, y + 0.34, zz - 0.2);
  }
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i += 2) {
      box(g, 0.07, 0.95, 0.07, 'steelDark', x + (s * w) / 2 - s * 0.06, G + i * 0.36 + 0.34, z + i * 0.46);
    }
    rod(
      g,
      { x: x + (s * w) / 2, y: G + 1.9, z: z },
      { x: x + (s * w) / 2, y: G + 1.9, z: z + 1.38 },
      0.045,
      'steelDark',
      5,
    );
  }
  box(g, w, 0.06, 0.06, 'steelDark', x, G + 1.9, z + 1.38);
}

/** Practice goalpost: yellow post, crossbar and two uprights. Faces +X/-X. */
function goalpost(g: THREE.Object3D, x: number, z: number): void {
  box(g, 0.7, 0.12, 1.3, 'concrete', x, G, z);
  cyl(g, 0.09, 0.13, 3.0, 'yellow', x, G + 0.12, z, 8);
  box(g, 0.14, 0.14, 4.7, 'yellow', x, G + 3.1, z);
  for (const s of [-2.28, 2.28]) {
    cyl(g, 0.075, 0.085, 3.2, 'yellow', x, G + 3.17, z + s, 8);
    sphere(g, 0.09, 'orange', x, G + 6.4, z + s, 8);
  }
  box(g, 0.7, 0.05, 0.05, 'ink', x, G + 3.0, z);
}

/** Tall stadium light: concrete base, pole, crossarm and four hooded lamps. */
function fieldLight(g: THREE.Object3D, x: number, z: number, h = 8.4): void {
  box(g, 0.9, 0.22, 0.9, 'concrete', x, G, z);
  cyl(g, 0.09, 0.16, h, 'steel', x, G + 0.22, z, 8);
  box(g, 2.0, 0.1, 0.12, 'steelDark', x, G + h + 0.1, z);
  for (const s of [-0.68, 0.68]) {
    box(g, 0.62, 0.34, 0.28, 'steelDark', x + s, G + h + 0.2, z);
    box(g, 0.5, 0.24, 0.05, 'glow', x + s, G + h + 0.24, z + 0.16);
    box(g, 0.72, 0.07, 0.38, 'ink', x + s, G + h + 0.55, z);
  }
  box(g, 0.12, 0.5, 0.12, 'steelDark', x, G + h + 0.2, z);
}

/** Square stone monument with the school name, on a concrete plinth. */
function stoneSign(g: THREE.Object3D, x: number, z: number): void {
  box(g, 3.5, 0.18, 1.1, 'concrete', x, G, z);
  box(g, 3.0, 1.5, 0.6, 'wallSand', x, G + 0.18, z);
  box(g, 3.16, 0.14, 0.74, 'concrete', x, G + 1.68, z);
  box(g, 2.7, 0.86, 0.1, 'wallCream', x, G + 0.5, z + 0.32);
  pixelText(g, 'TROJANS', { x, y: G + 0.72, z: z + 0.4, cell: 0.055, face: '+z', mat: 'ink', align: 'center', depth: 0.03 });
  pixelText(g, 'HIGH SCHOOL', { x, y: G + 0.5, z: z + 0.4, cell: 0.03, face: '+z', mat: 'ink', align: 'center', depth: 0.02 });
}

/** Clock face on one tower side. `face` names the outward normal. */
function clockFace(g: THREE.Object3D, face: Face, x: number, y: number, z: number, r = 0.7): void {
  const n = normalOf(face);
  const cx = x + n.x * 0.08;
  const cz = z + n.z * 0.08;
  const disc = cyl(g, r, r, 0.08, 'wallWhite', 0, 0, 0, 24);
  disc.rotation.set(face === '+x' || face === '-x' ? 0 : Math.PI / 2, 0, face === '+x' || face === '-x' ? Math.PI / 2 : 0);
  disc.position.set(cx, y, cz);
  const rim = put(
    g,
    new THREE.TorusGeometry(r + 0.01, 0.05, 6, 28),
    'steelDark',
    cx + n.x * 0.03,
    y,
    cz + n.z * 0.03,
    0,
    face === '+x' || face === '-x' ? Math.PI / 2 : 0,
    0,
  );
  rim.renderOrder = 1;
  // ten past two, chunky enough to read from the street
  if (face === '+z' || face === '-z') {
    const s = face === '+z' ? 1 : -1;
    box(g, 0.05, r * 0.72, 0.04, 'ink', cx, y, cz + s * 0.07);
    box(g, r * 0.5, 0.05, 0.04, 'ink', cx + r * 0.22, y - r * 0.1, cz + s * 0.07);
  } else {
    const s = face === '+x' ? 1 : -1;
    box(g, 0.04, r * 0.72, 0.05, 'ink', cx + s * 0.07, y, cz);
    box(g, 0.04, 0.05, r * 0.5, 'ink', cx + s * 0.07, y - r * 0.1, cz + r * 0.22);
  }
  box(g, 0.09, 0.09, 0.09, 'ink', cx + n.x * 0.04, y, cz + n.z * 0.04);
}

/* ================================================================ variant B: Trojan High School */

function highSchool(g: THREE.Group): void {
  const y0 = G;

  /* ---- site base, drives and walks ---- */
  box(g, 34.4, G, 22.4, 'paving', 0, 0, 0);
  // front bus loop, kerbs and sidewalk
  box(g, 33.2, 0.06, 2.2, 'asphalt', 0, y0, 9.3);
  box(g, 33.2, 0.18, 0.16, 'concrete', 0, y0, 8.2);
  box(g, 33.2, 0.18, 0.16, 'concrete', 0, y0, 10.4);
  box(g, 33.2, 0.06, 0.03, 'yellow', 0, y0 + 0.05, 8.31);
  box(g, 34.4, 0.1, 0.8, 'concrete', 0, y0, 10.8);
  for (let x = -15.2; x <= 15.3; x += 2.2) {
    if (x > -8.2 && x < -4.2) continue;
    box(g, 0.95, 0.02, 0.09, 'wallWhite', x, y0 + 0.06, 9.3);
  }
  // crosswalk from the entrance walk
  for (let i = 0; i < 6; i++) box(g, 2.6, 0.02, 0.24, 'wallWhite', -6.2, y0 + 0.06, 8.48 + i * 0.31);
  box(g, 3.0, 0.02, 0.1, 'wallWhite', -6.2, y0 + 0.06, 8.28);
  // entrance walk from the steps to the kerb
  box(g, 2.6, 0.07, 2.3, 'concrete', -6.2, y0, 7.05);
  // service drive down the east flank into the student lot
  box(g, 2.3, 0.06, 11.4, 'asphalt', 4.0, y0, 2.6);
  box(g, 11.1, 0.06, 7.9, 'asphalt', 10.25, y0, -6.95);
  box(g, 2.3, 0.06, 3.9, 'asphalt', 4.0, y0, -8.9);
  box(g, 0.14, 0.2, 0.14, 'steel', 2.75, y0, 8.15);
  box(g, 0.14, 0.2, 0.14, 'steel', 5.25, y0, 8.15);

  /* ---- academic block: limestone, three storeys, flat roof ---- */
  const A: Block = { cx: -6.2, cz: 2.0, hw: 8.9, hd: 2.2 };
  const AH = 9.15;
  box(g, 17.8, AH, 4.4, 'wallSand', A.cx, y0, A.cz);
  box(g, 17.92, 0.9, 4.52, 'wallCream', A.cx, y0, A.cz);
  // rusticated base joints
  for (let i = 1; i < 3; i++) box(g, 17.94, 0.045, 4.54, 'concrete', A.cx, y0 + i * 0.3, A.cz);
  // string courses and cornice
  for (const sy of [3.0, 6.05]) box(g, 17.98, 0.16, 4.5, 'wallWhite', A.cx, y0 + sy, A.cz);
  box(g, 18.06, 0.42, 4.56, 'wallWhite', A.cx, y0 + AH - 0.42, A.cz);
  flatRoof(g, A, y0 + AH, 0.55, 'wallSand');
  // front windows, three floors, held clear of the tower bay
  const rowsY = [y0 + 0.92, y0 + 3.98, y0 + 7.02];
  for (const wy of rowsY) {
    for (const wx of [-14.0, -12.2, -10.4, -8.6, -3.8, -2.0, -0.2, 1.6]) {
      windowUnit(g, { face: '+z', plane: 4.2, along: wx, y: wy, w: 1.15, h: 1.62, upperMuntin: true });
    }
  }
  // rear and end windows
  for (const wy of [y0 + 0.92, y0 + 3.98, y0 + 7.02]) {
    for (const wx of [-13.9, -11.5, -9.1, -6.7, -4.3, -1.9, 0.5]) {
      windowUnit(g, { face: '-z', plane: -0.2, along: wx, y: wy, w: 1.15, h: 1.62, upperMuntin: true });
    }
  }
  for (const wy of [y0 + 0.92, y0 + 3.98, y0 + 7.02]) {
    for (const wz of [0.5, 2.1, 3.5]) {
      windowUnit(g, { face: '-x', plane: -15.1, along: wz, y: wy, w: 1.0, h: 1.62, upperMuntin: true });
    }
  }
  // roof plant
  hvacUnit(g, -11.6, y0 + AH + 0.06, 1.0, 2.2, 1.35);
  hvacUnit(g, -2.2, y0 + AH + 0.06, 2.6, 1.8, 1.2, 1.0);
  for (const sx of [-9.4, -8.2, 0.2]) skylight(g, sx, y0 + AH + 0.06, 2.2);
  for (const sx of [-13.0, -11.8, -10.6]) solarPanel(g, sx, y0 + AH + 0.06, 2.9);
  stack(g, 1.0, y0 + AH + 0.06, 1.4, 0.9);
  roofHatch(g, -6.9, y0 + AH + 0.06, 2.9);
  // downpipes
  for (const px of [-14.95, 2.55]) {
    for (const pz of [4.16, -0.16]) cyl(g, 0.075, 0.075, AH, 'steel', px, y0, pz, 8);
  }

  /* ---- entrance portico ---- */
  box(g, 4.8, 4.6, 0.9, 'wallSand', -6.2, y0, 4.5);
  box(g, 5.2, 0.3, 1.5, 'wallWhite', -6.2, y0 + 4.55, 4.95);
  box(g, 5.35, 0.16, 1.62, 'concrete', -6.2, y0 + 4.85, 4.95);
  hipRoof(g, 5.35, 1.7, 0.6, 'roofSand', -6.2, y0 + 5.01, 4.95);
  for (const px of [-7.85, -4.55]) {
    cyl(g, 0.24, 0.28, 4.45, 'wallWhite', px, y0 + 0.15, 5.55, 12);
    box(g, 0.62, 0.16, 0.62, 'wallWhite', px, y0 + 0.15, 5.55);
    box(g, 0.62, 0.14, 0.62, 'wallWhite', px, y0 + 4.45, 5.55);
  }
  doubleDoor(g, { face: '+z', plane: 4.95, along: -6.2, y: y0 + 0.32, w: 2.4, h: 2.6, transom: true });
  for (const s of [-1.75, 1.75]) {
    fBox(g, '+z', 4.95, 'glow', -6.2 + s, y0 + 0.45, 0.0, 0.34, 2.1, 0.06);
    fBox(g, '+z', 4.95, 'wallWhite', -6.2 + s, y0 + 0.3, 0.06, 0.48, 2.42, 0.12);
  }
  pixelText(g, 'TROJAN HIGH', { x: -6.2, y: y0 + 4.63, z: 5.73, cell: 0.04, face: '+z', mat: 'steelDark', align: 'center', depth: 0.03 });
  // steps and cheek walls
  box(g, 5.4, 0.3, 1.5, 'concrete', -6.2, y0, 5.75);
  box(g, 5.4, 0.18, 0.45, 'concrete', -6.2, y0, 6.75);
  box(g, 5.4, 0.09, 0.4, 'concrete', -6.2, y0, 7.15);
  for (const s of [-1, 1]) {
    box(g, 0.24, 0.55, 1.5, 'concrete', -6.2 + s * 2.82, y0, 5.75);
  }
  // accessible ramp on the east cheek
  put(g, new THREE.BoxGeometry(1.05, 0.08, 2.7), 'concrete', -3.2, y0 + 0.16, 6.3, -0.06, 0, 0);
  for (const zz of [5.1, 7.5]) {
    for (const s of [-0.58, 0.58]) box(g, 0.06, 0.9, 0.06, 'steel', -3.2 + s, y0 + 0.24, zz);
  }

  /* ---- clock tower ---- */
  const TW = 3.2;
  const tx = -6.2;
  const tz = 2.0;
  box(g, TW, 12.2, TW, 'wallSand', tx, y0, tz);
  // corner quoins and bands
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(g, 0.18, 12.2, 0.18, 'wallWhite', tx + (sx * TW) / 2, y0, tz + (sz * TW) / 2);
    }
  }
  for (const by of [5.0, 8.55, 10.0, 12.05]) box(g, TW + 0.22, 0.16, TW + 0.22, 'wallWhite', tx, y0 + by, tz);
  // narrow paired windows on the tower
  for (const wy of [y0 + 6.2, y0 + 8.7]) {
    windowUnit(g, { face: '+z', plane: 3.6, along: tx - 0.55, y: wy, w: 0.62, h: 1.35, upperMuntin: false });
    windowUnit(g, { face: '+z', plane: 3.6, along: tx + 0.55, y: wy, w: 0.62, h: 1.35, upperMuntin: false });
  }
  // clock faces on all four sides
  clockFace(g, '+z', tx, y0 + 10.6, tz + TW / 2, 0.72);
  clockFace(g, '-z', tx, y0 + 10.6, tz - TW / 2, 0.72);
  clockFace(g, '+x', tx + TW / 2, y0 + 10.6, tz, 0.72);
  clockFace(g, '-x', tx - TW / 2, y0 + 10.6, tz, 0.72);
  // belfry louvres
  for (const face of ['+z', '-z', '+x', '-x'] as Face[]) {
    const fn = normalOf(face);
    const px = face === '+x' || face === '-x' ? tx + fn.x * (TW / 2 + 0.03) : tx;
    const pz = face === '+z' || face === '-z' ? tz + fn.z * (TW / 2 + 0.03) : tz;
    if (face === '+z' || face === '-z') {
      box(g, 1.6, 0.95, 0.08, 'ink', px, y0 + 11.2, pz);
      for (let i = 0; i < 4; i++) box(g, 1.5, 0.09, 0.1, 'steelDark', px, y0 + 11.3 + i * 0.2, pz + fn.z * 0.04);
    } else {
      box(g, 0.08, 0.95, 1.6, 'ink', px, y0 + 11.2, pz);
      for (let i = 0; i < 4; i++) box(g, 0.1, 0.09, 1.5, 'steelDark', px + fn.x * 0.04, y0 + 11.3 + i * 0.2, pz);
    }
  }
  hipRoof(g, 4.0, 4.0, 1.55, 'roofGreen', tx, y0 + 12.2, tz);
  cyl(g, 0.06, 0.1, 1.0, 'steelDark', tx, y0 + 13.7, tz, 8);
  sphere(g, 0.17, 'yellow', tx, y0 + 14.7, tz, 10);
  box(g, 0.7, 0.05, 0.05, 'steelDark', tx - 0.25, y0 + 14.4, tz);

  /* ---- gymnasium ---- */
  const GB: Block = { cx: 10.0, cz: 2.1, hw: 4.6, hd: 3.1 };
  const GH = 6.5;
  box(g, 9.2, GH, 6.2, 'wallCream', GB.cx, y0, GB.cz);
  box(g, 9.32, 1.0, 6.32, 'wallSand', GB.cx, y0, GB.cz);
  box(g, 9.34, 0.16, 6.34, 'wallWhite', GB.cx, y0 + 1.0, GB.cz);
  box(g, 9.4, 0.32, 6.4, 'wallWhite', GB.cx, y0 + GH - 0.32, GB.cz);
  hipRoof(g, 9.8, 6.7, 1.55, 'roofGreen', GB.cx, y0 + GH, GB.cz);
  for (let sx = GB.cx - 4.0; sx <= GB.cx + 4.0; sx += 1.33) {
    rod(g, { x: sx, y: y0 + GH + 0.03, z: GB.cz + GB.hd + 0.2 }, { x: sx, y: y0 + GH + 1.5, z: GB.cz }, 0.022, 'steelDark', 4);
    rod(g, { x: sx, y: y0 + GH + 0.03, z: GB.cz - GB.hd - 0.2 }, { x: sx, y: y0 + GH + 1.5, z: GB.cz }, 0.022, 'steelDark', 4);
  }
  box(g, 9.5, 0.09, 0.18, 'steelDark', GB.cx, y0 + GH + 1.5, GB.cz);
  for (const wx of [6.4, 8.0, 11.4, 13.0]) {
    windowUnit(g, { face: '+z', plane: 5.2, along: wx, y: y0 + 1.35, w: 1.25, h: 2.6, upperMuntin: true });
  }
  doubleDoor(g, { face: '+z', plane: 5.2, along: 9.75, y: y0 + 0.25, w: 2.3, h: 2.45, transom: true });
  box(g, 3.6, 0.2, 1.5, 'wallWhite', 9.75, y0 + 3.95, 5.55);
  box(g, 3.72, 0.4, 0.12, 'ink', 9.75, y0 + 3.85, 6.26);
  pixelText(g, 'GYM', { x: 9.75, y: y0 + 3.92, z: 6.33, cell: 0.07, face: '+z', mat: 'wallWhite', align: 'center', depth: 0.03 });
  box(g, 3.8, 0.12, 1.2, 'concrete', 9.75, y0, 5.7);
  // rear and east windows
  for (const wx of [7.4, 10.0, 12.6]) {
    windowUnit(g, { face: '-z', plane: -1.0, along: wx, y: y0 + 3.3, w: 1.1, h: 1.2, sill: false });
  }
  for (const wz of [0.4, 2.4, 4.2]) {
    windowUnit(g, { face: '+x', plane: 14.6, along: wz, y: y0 + 3.2, w: 1.0, h: 1.4, sill: false });
  }
  fBox(g, '-z', -1.0, 'ink', 12.9, y0 + 0.25, 0.02, 1.2, 2.2, 0.1);
  fBox(g, '-z', -1.0, 'steel', 12.9, y0 + 0.33, 0.12, 1.0, 2.0, 0.05);
  box(g, 1.6, 0.14, 0.9, 'concrete', 12.9, y0, -1.4);
  // gym boiler chimney
  chimney(g, 5.6, y0 + GH + 0.06, 4.2, 1.3);

  /* ---- practice football field ---- */
  box(g, 18.0, 0.06, 7.4, 'grass', -6.4, y0, -7.2);
  // sidelines and end lines
  box(g, 18.0, 0.02, 0.09, 'wallWhite', -6.4, y0 + 0.06, -10.86);
  box(g, 18.0, 0.02, 0.09, 'wallWhite', -6.4, y0 + 0.06, -3.54);
  box(g, 0.09, 0.02, 7.4, 'wallWhite', -15.36, y0 + 0.06, -7.2);
  box(g, 0.09, 0.02, 7.4, 'wallWhite', 2.56, y0 + 0.06, -7.2);
  // yard lines every 1.5 m, with hash marks
  for (let x = -13.86; x < 1.5; x += 1.5) {
    box(g, 0.05, 0.02, 7.3, 'wallWhite', x, y0 + 0.06, -7.2);
    for (const hz of [-6.1, -8.3]) box(g, 0.36, 0.02, 0.05, 'wallWhite', x, y0 + 0.06, hz);
  }
  box(g, 0.14, 0.02, 7.4, 'wallWhite', -14.46, y0 + 0.06, -7.2);
  box(g, 0.14, 0.02, 7.4, 'wallWhite', 1.66, y0 + 0.06, -7.2);
  pixelText(g, 'THS', { x: -6.4, y: y0 + 0.085, z: -7.2, cell: 0.2, face: '+y', mat: 'wallWhite', align: 'center', depth: 0.02 });
  // goalposts and lights
  goalpost(g, -14.9, -7.2);
  goalpost(g, 2.1, -7.2);
  fieldLight(g, -15.2, -3.2);
  fieldLight(g, -15.2, -10.9);
  fieldLight(g, 3.0, -3.2);
  fieldLight(g, 3.0, -10.9);
  // bleachers between the field and the school
  bleachers(g, -8.4, -2.2, 6.8);
  box(g, 1.5, 0.05, 2.3, 'concrete', -6.4, y0 + 0.01, -2.25);
  // scoreboard at the east end, turned to face down the field
  const sb = new THREE.Group();
  sb.position.set(2.9, y0, -7.2);
  sb.rotation.y = -Math.PI / 2;
  g.add(sb);
  box(sb, 0.18, 2.4, 0.18, 'steel', -2.5, 0, -0.24);
  box(sb, 0.18, 2.4, 0.18, 'steel', 2.5, 0, -0.24);
  box(sb, 5.2, 2.0, 0.28, 'ink', 0, 2.3, 0);
  box(sb, 5.0, 1.8, 0.1, 'wallCream', 0, 2.4, 0.16);
  pixelText(sb, 'HOME 0  GUEST 0', { x: 0, y: 3.45, z: 0.24, cell: 0.05, face: '+z', mat: 'ink', align: 'center', depth: 0.02 });
  pixelText(sb, 'TROJANS', { x: 0, y: 2.72, z: 0.24, cell: 0.07, face: '+z', mat: 'red', align: 'center', depth: 0.02 });
  box(sb, 5.4, 0.12, 0.5, 'steelDark', 0, 4.3, 0);

  /* ---- student parking ---- */
  box(g, 4.2, 0.02, 0.07, 'wallWhite', 14.4, y0 + 0.06, -7.0);
  for (const sx of [5.3, 7.9, 10.5, 13.1, 15.7]) {
    box(g, 0.07, 0.02, 4.1, 'wallWhite', sx, y0 + 0.06, -5.25);
  }
  box(g, 10.5, 0.02, 0.07, 'wallWhite', 10.5, y0 + 0.06, -3.2);
  const cars: Array<[number, number, MatName, number]> = [
    [6.6, -5.2, 'wallBlue', Math.PI / 2],
    [9.2, -5.2, 'wallCoral', Math.PI / 2],
    [11.8, -5.2, 'wallCream', Math.PI / 2],
    [14.4, -5.2, 'wallYellow', Math.PI / 2],
    [7.4, -9.6, 'wallLilac', 0],
    [11.4, -9.6, 'wallTeal', 0],
  ];
  for (const [cx, cz, mat, ry] of cars) car(g, cx, cz, mat, ry);
  // lot sign
  box(g, 0.1, 2.2, 0.1, 'steel', 5.6, y0, -2.5);
  box(g, 1.1, 0.5, 0.06, 'ink', 5.6, y0 + 1.75, -2.5);
  box(g, 0.98, 0.4, 0.07, 'wallWhite', 5.6, y0 + 1.8, -2.45);
  pixelText(g, 'PARKING', { x: 5.6, y: y0 + 1.87, z: -2.41, cell: 0.026, face: '+z', mat: 'ink', align: 'center', depth: 0.02 });

  /* ---- front grounds ---- */
  box(g, 8.4, 0.05, 3.0, 'grass', -11.7, y0, 6.6);
  box(g, 7.6, 0.05, 3.0, 'grass', -1.3, y0, 6.6);
  box(g, 9.0, 0.05, 3.0, 'grass', 10.1, y0, 6.6);
  for (const px of [-8.15, -4.35]) {
    box(g, 0.8, 0.5, 0.8, 'wallCoral', px, y0, 7.8);
    box(g, 0.88, 0.1, 0.88, 'concrete', px, y0 + 0.5, 7.8);
    bush(g, px, 7.8, 0.62);
  }
  flagpole(g, -14.4, 7.6);
  box(g, 6.0, 0.06, 1.7, 'concrete', 13.2, y0, 7.4);
  marquee(g, 13.2, 7.4, 'TROJAN HIGH', 'HOME OF THE TROJANS', 0.044, 0.041);
  bench(g, -9.6, 7.4);
  bikeRack(g, 0.6, 5.9);
  stoneSign(g, -1.6, 7.8);
  hydrant(g, 15.0, 8.5);
  trashCan(g, 13.0, 8.4);
  streetSign(g, -8.8, 10.82, 'school');
  streetSign(g, 12.4, 10.82, '20');
  // lawn beds and trees
  for (const px of [-14.6, 13.6]) {
    box(g, 3.0, 0.16, 0.8, 'concrete', px, y0, 4.9);
    box(g, 2.7, 0.3, 0.55, 'green', px, y0 + 0.16, 4.9);
  }
  tree(g, -16.2, 6.5, 0.8);
  tree(g, 15.4, 5.9, 0.8);
  tree(g, -16.0, -9.6, 0.85);
  tree(g, 16.0, -9.6, 0.8);
  // flagpole, bus and a drop-off car in the loop
  schoolBus(g, -12.8, 9.3);
  car(g, 15.0, 9.3, 'wallBlue', 0);
  picnicTable(g, -1.0, -2.05);

  /* ---- power port on the west end wall ---- */
  powerBracket(g, { face: '-x', plane: -15.1, along: 3.9, y: 8.2 });
}


export const build: ModelBuilder = ({ variant }) => {
  const g = new THREE.Group();
  if (variant === 1) highSchool(g);
  else elementary(g);
  return g;
};



