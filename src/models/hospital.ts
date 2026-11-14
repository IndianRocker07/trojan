import * as THREE from 'three';
import { MAT } from '../render/palette';
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

/**
 * General hospital, 3x3 cells (36 x 36 m). The front (+Z) carries the emergency
 * department: a two-storey wing with a canopy over the ambulance bay and a glowing
 * EMERGENCY sign. Behind it stands the six-storey ward block with a red cross on its
 * facade, a glowing cross on the parapet and a helipad with HVAC plant on the roof.
 *
 * Variant 1 re-plans the site as an L: the ward tower moves to the back-right, the
 * low base runs along the front, and a glazed atrium fills the inside corner.
 */

export const VARIANTS = 2;

/** Top of the paving slab. Everything on site stands on this plane. */
const G = 0.12;
const STOREY = 3.2;
const TOWER_H = 6 * STOREY; // 19.2 m ward block
const WING_H = 2 * STOREY; // 6.4 m low wing
/** Red cross on the ward facade: centre height above ground. */
const CROSS_Y = G + 12.8;

interface Block {
  cx: number;
  cz: number;
  hw: number; // half extent along X
  hd: number; // half extent along Z
}

interface Layout {
  tower: Block;
  wing: Block;
  atrium: Block | null;
  /** Window cells on the tower front that are hidden or replaced by the cross. */
  towerFrontSkip: (r: number, c: number) => boolean;
  /** Window spans for faces running along X (front/back) and along Z (sides). */
  fb: { span: number; winW: number };
  lr: { span: number; winW: number };
  crossX: number;
  core: { x: number; z: number; w: number; d: number };
  heli: { x: number; z: number; r: number };
  hvac: Array<{ x: number; z: number; w: number; d: number }>;
  vents: Array<{ x: number; z: number }>;
  wingUnit: { x: number; z: number };
  canopyX: number;
  canopyW: number;
  canopyD: number;
  doorX: number;
  pathLen: number;
  amb: { x: number; z: number };
  bollards: Array<{ x: number; z: number }>;
  lot: { x0: number; x1: number; z0: number; z1: number };
  stripes: number[];
  cars: Array<{ x: number; z: number; mat: 'yellow' | 'blue' }>;
  gen: { x: number; z: number };
  o2: { x: number; z: number };
  lawn: { cx: number; cz: number; w: number; d: number };
  trees: Array<{ x: number; z: number }>;
  monolith: { x: number; z: number };
  flag: { x: number; z: number };
  pipeWallX: number;
  poles: Array<{ x: number; z: number }>;
  downpipes: Array<{ x: number; z: number }>;
  roofVents: Array<{ x: number; z: number }>;
  /** Z of the ward lobby door on the tower's +X face. */
  lobbyZ: number;
}

const LAYOUT_A: Layout = {
  tower: { cx: 0, cz: -4, hw: 8, hd: 6 },
  wing: { cx: -3.5, cz: 6, hw: 6.5, hd: 4 },
  atrium: null,
  towerFrontSkip: (r, c) => r < 2 && c === 0, // ED wing covers the lower left bays
  fb: { span: 9.2, winW: 4.0 },
  lr: { span: 8.4, winW: 3.2 },
  crossX: 0,
  core: { x: 6, z: -8, w: 2.8, d: 2.8 },
  heli: { x: -2, z: -5, r: 4.2 },
  hvac: [
    { x: 5.2, z: -1.2, w: 2.6, d: 1.8 },
    { x: 5.2, z: -4.3, w: 2.6, d: 1.8 },
  ],
  vents: [
    { x: -6.9, z: -2.2 },
    { x: -6.9, z: -7.6 },
  ],
  wingUnit: { x: -1.5, z: 6 },
  canopyX: -7,
  canopyW: 12,
  canopyD: 6,
  doorX: -3.5,
  pathLen: 7,
  amb: { x: -8.8, z: 12.8 },
  bollards: [
    { x: -0.5, z: 12 },
    { x: -0.5, z: 14 },
    { x: -0.5, z: 16 },
  ],
  lot: { x0: 9, x1: 17, z0: -6, z1: 14 },
  stripes: [-5, -2, 1, 4, 7, 10, 13],
  cars: [
    { x: 13, z: -0.5, mat: 'yellow' },
    { x: 13, z: 5.5, mat: 'blue' },
  ],
  gen: { x: 12.5, z: -12.5 },
  o2: { x: -12.5, z: -3 },
  lawn: { cx: -13.75, cz: -9.5, w: 6.5, d: 15 },
  trees: [
    { x: -15, z: -6 },
    { x: -15, z: -13 },
    { x: 5, z: 15.2 },
    { x: 12.5, z: 15 },
  ],
  monolith: { x: -14.2, z: 15.2 },
  flag: { x: -16.4, z: 15.8 },
  pipeWallX: -8,
  poles: [
    { x: 9.4, z: 2 },
    { x: 9.4, z: 10.5 },
  ],
  downpipes: [
    { x: 8.1, z: 1.9 },
    { x: 8.1, z: -9.9 },
    { x: -8.1, z: -9.9 },
  ],
  roofVents: [
    { x: -6.5, z: 4.5 },
    { x: -6.5, z: 8 },
  ],
  lobbyZ: -4,
};

const LAYOUT_B: Layout = {
  tower: { cx: 7, cz: -9, hw: 6, hd: 5 },
  wing: { cx: -2, cz: -1, hw: 10, hd: 3 },
  atrium: { cx: -1, cz: -7, hw: 2, hd: 3 },
  towerFrontSkip: (r, c) => (r < 2 && c === 0) || ((r === 3 || r === 4) && c === 1),
  fb: { span: 7.6, winW: 3.2 },
  lr: { span: 6.8, winW: 2.6 },
  crossX: 10.5,
  core: { x: 11, z: -11, w: 2.4, d: 2.4 },
  heli: { x: 5.4, z: -9, r: 3.8 },
  hvac: [
    { x: 11, z: -5.8, w: 2.2, d: 1.6 },
    { x: 11, z: -7.9, w: 2.2, d: 1.6 },
  ],
  vents: [
    { x: 2.2, z: -5.6 },
    { x: 2.2, z: -12.4 },
  ],
  wingUnit: { x: -7, z: -1 },
  canopyX: -6,
  canopyW: 10,
  canopyD: 6,
  doorX: -3.2,
  pathLen: 9,
  amb: { x: -7.6, z: 4.6 },
  bollards: [
    { x: -0.4, z: 8 },
    { x: -0.4, z: 10 },
    { x: -0.4, z: 12 },
  ],
  lot: { x0: 9.45, x1: 16.95, z0: -2, z1: 14 },
  stripes: [0, 3, 6, 9, 12],
  cars: [
    { x: 13.2, z: 1.5, mat: 'yellow' },
    { x: 13.2, z: 7.5, mat: 'blue' },
  ],
  gen: { x: -13, z: -13.5 },
  o2: { x: -7, z: -7.5 },
  lawn: { cx: -14.5, cz: -2.5, w: 4.6, d: 17 },
  trees: [
    { x: -14.8, z: -4 },
    { x: -14.8, z: 4.5 },
    { x: 5, z: 15.2 },
    { x: -6.5, z: 15.2 },
  ],
  monolith: { x: -13.8, z: 10 },
  flag: { x: -16.2, z: 11 },
  pipeWallX: -3,
  poles: [
    { x: 9.9, z: 0.5 },
    { x: 9.9, z: 10.5 },
  ],
  downpipes: [
    { x: 13.1, z: -4.1 },
    { x: 13.1, z: -13.9 },
    { x: 0.9, z: -13.9 },
  ],
  roofVents: [
    { x: 3, z: -1 },
    { x: 5, z: -1 },
  ],
  lobbyZ: -9,
};

/* ------------------------------------------------------------------ helpers */

interface GlazeOpts {
  face: Face;
  rows: number;
  cols: number;
  span?: number;
  winW: number;
  winH?: number;
  y0: number;
  cx?: number;
  cz?: number;
  hw?: number;
  hd?: number;
  skip?: (r: number, c: number) => boolean;
  frames?: boolean;
}

/** Glow window bands with ink frames on one face of a block. */
function glaze(g: THREE.Object3D, b: Block, o: GlazeOpts): void {
  windowGrid(g, {
    face: o.face,
    cx: o.cx ?? b.cx,
    cz: o.cz ?? b.cz,
    hw: o.hw ?? b.hw,
    hd: o.hd ?? b.hd,
    rows: o.rows,
    cols: o.cols,
    y0: o.y0,
    pitchY: STOREY,
    winW: o.winW,
    winH: o.winH ?? 1.5,
    span: o.span,
    frames: o.frames ?? true,
    skip: o.skip,
  });
}

/** Flat roof with white parapet, concrete coping and a sand roof field. */
function roof(g: THREE.Group, b: Block, y: number, ph: number): void {
  const t = 0.35;
  const zF = b.cz + b.hd - t / 2;
  const zB = b.cz - b.hd + t / 2;
  const xR = b.cx + b.hw - t / 2;
  const xL = b.cx - b.hw + t / 2;
  box(g, 2 * b.hw - 2 * t, 0.06, 2 * b.hd - 2 * t, 'roofSand', b.cx, y, b.cz);
  box(g, 2 * b.hw, ph, t, 'wallWhite', b.cx, y, zF);
  box(g, 2 * b.hw, ph, t, 'wallWhite', b.cx, y, zB);
  box(g, t, ph, 2 * b.hd - 2 * t, 'wallWhite', xR, y, b.cz);
  box(g, t, ph, 2 * b.hd - 2 * t, 'wallWhite', xL, y, b.cz);
  box(g, 2 * b.hw + 0.1, 0.12, t + 0.1, 'concrete', b.cx, y + ph, zF);
  box(g, 2 * b.hw + 0.1, 0.12, t + 0.1, 'concrete', b.cx, y + ph, zB);
  box(g, t + 0.1, 0.12, 2 * b.hd - 2 * t, 'concrete', xR, y + ph, b.cz);
  box(g, t + 0.1, 0.12, 2 * b.hd - 2 * t, 'concrete', xL, y + ph, b.cz);
}

/** Rooftop air handler: casing, ink grille ring and a spinning three-blade fan. */
function hvacUnit(g: THREE.Group, x: number, y: number, z: number, w: number, h: number, d: number): void {
  box(g, w, h, d, 'steel', x, y, z);
  const top = y + h;
  const r = Math.min(w, d) * 0.3;
  cyl(g, r + 0.12, r + 0.12, 0.05, 'ink', x, top, z, 16);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.12, 0.04, 6, 16), MAT.ink);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, top + 0.05, z);
  g.add(ring);
  const fan = new THREE.Group();
  fan.position.set(x, top + 0.05, z);
  for (let i = 0; i < 3; i++) {
    const blade = box(fan, r * 2, 0.03, 0.2, 'wallWhite', 0, 0, 0);
    blade.rotation.y = (i * Math.PI) / 3;
  }
  cyl(fan, 0.08, 0.08, 0.06, 'steelDark', 0, 0, 0, 8);
  spin(fan, 'y', 4);
  g.add(fan);
}

/** Exhaust stack with a dark cap. */
function vent(g: THREE.Group, x: number, y: number, z: number): void {
  cyl(g, 0.2, 0.2, 1.1, 'steel', x, y, z, 10);
  cyl(g, 0.3, 0.3, 0.12, 'steelDark', x, y + 1.1, z, 10);
}

/** Stair and lift core rising above the ward roof, with glow slots and an aviation beacon. */
function core(g: THREE.Group, c: Layout['core'], tt: number): void {
  box(g, c.w, 4.8, c.d, 'wallTeal', c.x, tt - 1.6, c.z);
  const cb = { cx: c.x, cz: c.z, hw: c.w / 2, hd: c.d / 2 };
  glaze(g, cb, { face: '+z', rows: 1, cols: 1, winW: c.w * 0.55, winH: 1.1, y0: tt + 0.9, frames: false });
  glaze(g, cb, { face: '+x', rows: 1, cols: 1, winW: c.d * 0.55, winH: 1.1, y0: tt + 0.9, frames: false });
  box(g, c.w + 0.2, 0.25, c.d + 0.2, 'roofInk', c.x, tt + 3.2, c.z);
  const mastY = tt + 3.45;
  cyl(g, 0.07, 0.07, 0.9, 'steel', c.x, mastY, c.z, 8);
  sphere(g, 0.25, 'beacon', c.x, mastY + 0.9 + 0.25, c.z, 12);
}

/** Helipad: concrete disc, painted yellow H, ring of glow perimeter lights. */
function helipad(g: THREE.Group, x: number, y: number, z: number, r: number): void {
  cyl(g, r, r, 0.14, 'concrete', x, y, z, 16);
  const top = y + 0.14;
  box(g, 0.4, 0.03, 2.6, 'yellow', x - 0.8, top, z);
  box(g, 0.4, 0.03, 2.6, 'yellow', x + 0.8, top, z);
  box(g, 1.2, 0.03, 0.4, 'yellow', x, top, z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    box(g, 0.32, 0.12, 0.32, 'glow', x + Math.cos(a) * (r - 0.35), top, z + Math.sin(a) * (r - 0.35));
  }
}

/** Red cross on a white plate with an ink border, proud of a facade at z = zf. */
function crossSign(g: THREE.Group, x: number, zf: number): void {
  const yc = CROSS_Y;
  box(g, 4.6, 5.8, 0.2, 'wallWhite', x, yc - 2.9, zf + 0.1);
  box(g, 4.84, 0.12, 0.22, 'ink', x, yc + 2.9, zf + 0.1);
  box(g, 4.84, 0.12, 0.22, 'ink', x, yc - 3.02, zf + 0.1);
  box(g, 0.12, 5.8, 0.22, 'ink', x - 2.36, yc - 2.9, zf + 0.1);
  box(g, 0.12, 5.8, 0.22, 'ink', x + 2.36, yc - 2.9, zf + 0.1);
  box(g, 1.5, 4.0, 0.3, 'red', x, yc - 2.0, zf + 0.35);
  box(g, 3.6, 1.5, 0.3, 'red', x, yc - 0.75, zf + 0.35);
}

/** Glowing cross standing on the parapet; base at y. */
function glowCross(g: THREE.Group, x: number, z: number, y: number): void {
  box(g, 0.55, 2.4, 0.12, 'glow', x, y, z);
  box(g, 1.7, 0.55, 0.12, 'glow', x, y + 0.95, z);
}

/** Power port: steel post on the roof, a cross-arm bracket and a three-disc insulator. */
function powerPort(g: THREE.Group, x: number, z: number, y: number): void {
  cyl(g, 0.12, 0.12, 0.4, 'steel', x, y, z, 8);
  rod(g, { x, y: y + 0.4, z }, { x: x - 1.6, y: y + 0.4, z }, 0.06, 'steel', 6);
  rod(g, { x, y: y + 0.15, z }, { x: x - 0.9, y: y + 0.4, z }, 0.04, 'steel', 5);
  const top = insulator(g, x - 1.6, y + 0.4, z, 3);
  setPowerPorts(g, [top]);
}

/** Canopy over the ambulance bay: slab, red fascia, four steel columns, glow downlights. */
function canopy(g: THREE.Group, x: number, z: number, w: number, d: number): void {
  const y = 5.0;
  const t = 0.45;
  box(g, w, t, d, 'wallWhite', x, y, z);
  box(g, w, t, 0.14, 'red', x, y, z + d / 2 - 0.05);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      cyl(g, 0.22, 0.22, y - G, 'steel', x + sx * (w / 2 - 0.6), G, z + sz * (d / 2 - 0.6), 10);
    }
  }
  box(g, 0.8, 0.05, 0.8, 'glow', x - 2.5, y - 0.05, z + d / 2 - 1.2);
  box(g, 0.8, 0.05, 0.8, 'glow', x + 2.5, y - 0.05, z + d / 2 - 1.2);
}

/** White ambulance van with a red stripe, a roof beacon and four wheels. Long axis along X. */
function ambulance(g: THREE.Group, ax: number, az: number): void {
  const x0 = ax - 3.2; // rear end
  const yb = G + 0.3; // body bottom, raised over the wheels
  box(g, 4.6, 2.5, 2.3, 'wallWhite', x0 + 2.3, yb, az);
  box(g, 1.8, 2.1, 2.3, 'wallWhite', x0 + 5.5, yb, az);
  box(g, 0.06, 0.85, 1.9, 'glass', x0 + 6.42, yb + 1.0, az);
  box(g, 4.6, 0.32, 0.04, 'red', x0 + 2.3, yb + 0.9, az + 1.17);
  box(g, 4.6, 0.32, 0.04, 'red', x0 + 2.3, yb + 0.9, az - 1.17);
  box(g, 0.5, 0.12, 0.5, 'steelDark', x0 + 2.8, yb + 2.5, az);
  sphere(g, 0.22, 'beacon', x0 + 2.8, yb + 2.62 + 0.22, az, 10);
  for (const xw of [x0 + 1.0, x0 + 5.2]) {
    for (const zw of [az - 1.2, az + 1.2]) {
      const wheel = cyl(g, 0.42, 0.42, 0.3, 'ink', xw, G + 0.27, zw, 12);
      wheel.rotation.x = Math.PI / 2;
    }
  }
}

/** Parked car along X with a glass cabin and four wheels. */
function car(g: THREE.Group, x: number, z: number, mat: 'yellow' | 'blue'): void {
  const b = G + 0.3;
  box(g, 4.2, 0.85, 1.8, mat, x, b, z);
  box(g, 2.2, 0.65, 1.6, 'glass', x - 0.2, b + 0.85, z);
  for (const dx of [-1.3, 1.3]) {
    for (const dz of [-0.95, 0.95]) {
      const wheel = cyl(g, 0.32, 0.32, 0.24, 'ink', x + dx, G + 0.2, z + dz, 10);
      wheel.rotation.x = Math.PI / 2;
    }
  }
}

/** Standing backup generator enclosure with louvres, a warning stripe and two exhaust stacks. */
function generator(g: THREE.Group, x: number, z: number): void {
  box(g, 5.0, 0.18, 3.4, 'concrete', x, G, z);
  box(g, 4.6, 2.4, 3.0, 'steelDark', x, G + 0.18, z);
  box(g, 4.0, 1.6, 0.06, 'ink', x, G + 0.6, z + 1.53);
  box(g, 4.6, 0.22, 0.04, 'orange', x, G + 2.0, z + 1.52);
  for (const dx of [-1.0, 0.9]) {
    cyl(g, 0.16, 0.16, 2.2, 'steel', x + dx, G + 2.58, z, 10);
    cyl(g, 0.22, 0.22, 0.14, 'ink', x + dx, G + 4.78, z, 10);
  }
}

/** Oxygen cylinder bank: white tank on three legs, blue band, collar and valve. */
function o2tank(g: THREE.Group, x: number, z: number): void {
  box(g, 1.8, 0.1, 1.8, 'concrete', x, G, z);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + Math.PI / 2;
    cyl(g, 0.08, 0.08, 0.75, 'steelDark', x + Math.cos(a) * 0.45, G + 0.1, z + Math.sin(a) * 0.45, 8);
  }
  cyl(g, 0.62, 0.62, 0.12, 'steelDark', x, G + 0.85, z, 16);
  cyl(g, 0.55, 0.55, 2.9, 'wallWhite', x, G + 0.85, z, 16);
  sphere(g, 0.55, 'wallWhite', x, G + 3.75, z, 16);
  cyl(g, 0.56, 0.56, 0.45, 'blue', x, G + 1.9, z, 16);
  cyl(g, 0.12, 0.12, 0.3, 'steel', x, G + 4.2, z, 8);
}

/** Steel gas pipe from the oxygen bank into a wall, with a flange at the wall. */
function pipe(g: THREE.Group, x0: number, x1: number, y: number, z: number): void {
  rod(g, { x: x0, y, z }, { x: x1, y, z }, 0.07, 'steel', 8);
  const dir = Math.sign(x1 - x0);
  box(g, 0.14, 0.45, 0.45, 'steelDark', x1 - dir * 0.1, y - 0.225, z);
}

/** Bollard: yellow post with an ink cap. */
function bollard(g: THREE.Group, x: number, z: number): void {
  cyl(g, 0.18, 0.18, 0.9, 'yellow', x, G, z, 10);
  cyl(g, 0.2, 0.2, 0.06, 'ink', x, G + 0.9, z, 10);
}

/** Car-park lamp: steel pole, arm and a glow lens under the head. */
function lampPole(g: THREE.Group, x: number, z: number): void {
  cyl(g, 0.08, 0.08, 5.0, 'steel', x, G, z, 8);
  rod(g, { x, y: G + 5.0, z }, { x: x + 0.9, y: G + 5.0, z }, 0.05, 'steel', 5);
  box(g, 0.6, 0.12, 0.4, 'steelDark', x + 0.9, G + 4.86, z);
  box(g, 0.5, 0.04, 0.32, 'glow', x + 0.9, G + 4.82, z);
}

/** Rain downpipe from the roof edge to the ground. */
function downpipe(g: THREE.Group, x: number, z: number, roofY: number): void {
  cyl(g, 0.09, 0.09, roofY - G, 'steel', x, G, z, 8);
}

/** Ward lobby on the tower's +X face: stepped glow doors under a small canopy on posts. */
function lobby(g: THREE.Group, x: number, z: number): void {
  box(g, 0.7, 0.15, 3.4, 'concrete', x + 0.35, G, z);
  box(g, 0.08, 2.2, 1.1, 'glow', x + 0.06, G + 0.15, z - 0.6);
  box(g, 0.08, 2.2, 1.1, 'glow', x + 0.06, G + 0.15, z + 0.6);
  box(g, 0.14, 2.35, 0.14, 'ink', x + 0.07, G + 0.15, z - 1.2);
  box(g, 0.14, 2.35, 0.14, 'ink', x + 0.07, G + 0.15, z + 1.2);
  box(g, 0.18, 0.18, 2.7, 'ink', x + 0.07, G + 2.35, z);
  box(g, 1.6, 0.3, 3.4, 'wallWhite', x + 0.8, 3.3, z);
  box(g, 1.0, 0.04, 1.0, 'glow', x + 0.8, 3.26, z);
  cyl(g, 0.08, 0.08, 3.3 - G, 'steel', x + 1.4, G, z - 1.5, 8);
  cyl(g, 0.08, 0.08, 3.3 - G, 'steel', x + 1.4, G, z + 1.5, 8);
}

/** Stone entrance monolith with a glow name bar, plus a flagpole. */
function monolith(g: THREE.Group, x: number, z: number, fx: number, fz: number): void {
  box(g, 3.0, 0.2, 1.1, 'concrete', x, G, z);
  box(g, 2.6, 2.4, 0.7, 'wallCream', x, G + 0.2, z);
  box(g, 2.6, 0.14, 0.72, 'blue', x, G + 2.2, z);
  box(g, 2.0, 0.42, 0.06, 'glow', x, G + 1.2, z + 0.38);
  cyl(g, 0.25, 0.25, 0.15, 'concrete', fx, G, fz, 10);
  cyl(g, 0.06, 0.06, 6.0, 'steel', fx, G + 0.15, fz, 8);
  box(g, 1.3, 0.8, 0.04, 'red', fx + 0.65, G + 5.0, fz);
}

/** Tree: wood trunk, dark crown and a lighter puff. */
function tree(g: THREE.Group, x: number, z: number): void {
  cyl(g, 0.22, 0.26, 2.2, 'wood', x, G, z, 8);
  sphere(g, 1.5, 'roofGreen', x, G + 3.1, z, 14);
  sphere(g, 1.0, 'grass', x + 0.8, G + 3.8, z + 0.3, 12);
}

/** Glazed atrium: dark glass body, glow window bands on its exposed faces, roof slab. */
function atrium(g: THREE.Group, a: Block): void {
  const h = 9.6;
  box(g, 2 * a.hw, h, 2 * a.hd, 'glass', a.cx, G, a.cz);
  box(g, 2 * a.hw + 0.4, 0.3, 2 * a.hd + 0.4, 'roofInk', a.cx, G + h, a.cz);
  glaze(g, a, { face: '-x', rows: 3, cols: 2, span: 3.6, winW: 1.6, winH: 1.6, y0: G + 1.2 });
  glaze(g, a, { face: '-z', rows: 3, cols: 2, span: 2.4, winW: 1.2, winH: 1.6, y0: G + 1.2 });
}

/* -------------------------------------------------------------------- build */

export const build: ModelBuilder = ({ variant }) => {
  const L = variant === 1 ? LAYOUT_B : LAYOUT_A;
  const g = new THREE.Group();
  const T = L.tower;
  const W = L.wing;
  const TT = G + TOWER_H; // ward roof
  const WT = G + WING_H; // low wing roof
  const zTf = T.cz + T.hd; // ward front face
  const zWf = W.cz + W.hd; // ED / base front face

  /* site */
  box(g, 34, 0.12, 34, 'paving', 0, 0, 0);
  box(g, L.lawn.w, 0.04, L.lawn.d, 'grass', L.lawn.cx, G, L.lawn.cz);
  const { x0, x1, z0, z1 } = L.lot;
  box(g, x1 - x0, 0.04, z1 - z0, 'asphalt', (x0 + x1) / 2, G, (z0 + z1) / 2);
  for (const z of L.stripes) box(g, x1 - x0 - 1, 0.02, 0.14, 'ink', (x0 + x1) / 2, G + 0.04, z);
  for (const c of L.cars) car(g, c.x, c.z, c.mat);
  for (const p of L.poles) lampPole(g, p.x, p.z);
  // ambulance-bay markings either side of the van
  box(g, 7.6, 0.02, 0.14, 'ink', L.amb.x, G, L.amb.z - 1.85);
  box(g, 7.6, 0.02, 0.14, 'ink', L.amb.x, G, L.amb.z + 1.85);
  generator(g, L.gen.x, L.gen.z);
  o2tank(g, L.o2.x, L.o2.z);
  pipe(g, L.o2.x + 0.5, L.pipeWallX, G + 2.6, L.o2.z);
  for (const t of L.trees) tree(g, t.x, t.z);
  monolith(g, L.monolith.x, L.monolith.z, L.flag.x, L.flag.z);

  /* ward block, six storeys */
  box(g, 2 * T.hw, TOWER_H, 2 * T.hd, 'wallWhite', T.cx, G, T.cz);
  const ty = G + 1.4;
  glaze(g, T, { face: '+z', rows: 6, cols: 2, span: L.fb.span, winW: L.fb.winW, y0: ty, skip: L.towerFrontSkip });
  glaze(g, T, { face: '-z', rows: 6, cols: 2, span: L.fb.span, winW: L.fb.winW, y0: ty });
  glaze(g, T, { face: '+x', rows: 6, cols: 2, span: L.lr.span, winW: L.lr.winW, y0: ty });
  if (L.atrium) {
    // only the stretch of west face the atrium does not cover
    const zb = T.cz - T.hd;
    const za = L.atrium.cz - L.atrium.hd;
    glaze(g, T, { face: '-x', rows: 6, cols: 1, winW: 3.2, y0: ty, cz: (zb + za) / 2, hd: (za - zb) / 2 });
  } else {
    glaze(g, T, { face: '-x', rows: 6, cols: 2, span: L.lr.span, winW: L.lr.winW, y0: ty });
  }
  crossSign(g, L.crossX, zTf);
  roof(g, T, TT, 0.9);
  glowCross(g, L.crossX, zTf - 0.175, TT + 0.9 + 0.12);
  helipad(g, L.heli.x, TT, L.heli.z, L.heli.r);
  for (const h of L.hvac) hvacUnit(g, h.x, TT, h.z, h.w, 1.2, h.d);
  for (const v of L.vents) vent(g, v.x, TT, v.z);
  core(g, L.core, TT);
  for (const d of L.downpipes) downpipe(g, d.x, d.z, TT);
  lobby(g, T.cx + T.hw, L.lobbyZ);

  /* emergency department / base wing, two storeys */
  box(g, 2 * W.hw, WING_H, 2 * W.hd, 'wallCream', W.cx, G, W.cz);
  const wy = G + 1.2;
  if (variant === 0) {
    glaze(g, W, { face: '+x', rows: 2, cols: 2, span: 4.8, winW: 1.8, winH: 1.6, y0: wy });
    glaze(g, W, { face: '-x', rows: 2, cols: 2, span: 4.8, winW: 1.8, winH: 1.6, y0: wy });
  } else {
    glaze(g, W, { face: '+x', rows: 2, cols: 2, span: 3.6, winW: 1.6, winH: 1.6, y0: wy });
    glaze(g, W, { face: '-x', rows: 2, cols: 1, winW: 3.2, winH: 1.6, y0: wy });
    glaze(g, W, { face: '+z', rows: 2, cols: 1, cx: 4.5, winW: 5.0, winH: 1.6, y0: wy });
  }
  roof(g, W, WT, 0.6);
  hvacUnit(g, L.wingUnit.x, WT, L.wingUnit.z, 2.0, 0.9, 1.4);
  for (const v of L.roofVents) vent(g, v.x, WT, v.z);
  powerPort(g, W.cx - W.hw + 0.8, zWf - 0.8, WT);

  /* entrance: step, sliding glow doors, frame, EMERGENCY bar */
  const dx = L.doorX;
  box(g, 3.4, 0.15, 0.7, 'concrete', dx, G, zWf + 0.35);
  box(g, 1.1, 2.2, 0.08, 'glow', dx - 0.6, G + 0.15, zWf + 0.06);
  box(g, 1.1, 2.2, 0.08, 'glow', dx + 0.6, G + 0.15, zWf + 0.06);
  box(g, 0.14, 2.35, 0.14, 'ink', dx - 1.2, G + 0.15, zWf + 0.07);
  box(g, 0.14, 2.35, 0.14, 'ink', dx + 1.2, G + 0.15, zWf + 0.07);
  box(g, 2.7, 0.18, 0.14, 'ink', dx, G + 2.35, zWf + 0.07);
  box(g, 6.0, 0.7, 0.08, 'ink', dx, 5.55, zWf + 0.04);
  box(g, 5.6, 0.5, 0.06, 'glow', dx, 5.65, zWf + 0.09);
  canopy(g, L.canopyX, zWf - 0.2 + L.canopyD / 2, L.canopyW, L.canopyD);
  box(g, 3.0, 0.05, L.pathLen, 'concrete', dx, G, zWf + L.pathLen / 2);
  for (const b of L.bollards) bollard(g, b.x, b.z);
  ambulance(g, L.amb.x, L.amb.z);

  if (L.atrium) atrium(g, L.atrium);

  return g;
};
