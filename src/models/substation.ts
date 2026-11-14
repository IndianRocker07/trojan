import * as THREE from 'three';
import { MAT, type MatName } from '../render/palette';
import {
  box,
  cyl,
  rod,
  sphere,
  railing,
  spin,
  setPowerPorts,
  setOutPorts,
  windowGrid,
  type ModelBuilder,
} from './kit';

/**
 * Electrical substation, 2x2 cells = 24 x 24 m. Origin = yard centre, front (+Z) faces the street.
 * Flow: incoming HV portal (back, -Z) -> three phase lanes -> main busbar -> transformers ->
 * LV bus -> breaker row -> outgoing feeder gantry (front, +Z).
 *  - variant 0: outdoor yard, two transformers, breaker row.
 *  - variant 1: compact site, one outdoor transformer and a roller-door switch house.
 */
export const VARIANTS = 2;

const F = 10.6; // fence line, 1.4 m inside the footprint edge
const INC_Y = 11.2; // bottom of the incoming insulator strings (power ports)
const BUS_Y = 7.0; // main busbar height
const LV_Y = 3.4; // LV bus height
const LV_Z = 3.0; // LV bus / breaker row depth
const MAIN_Z = -2; // main busbar depth (also transformer centre depth)
const OUT_Y = 8.2; // bottom of the outgoing feeder strings
const GANTRY_IN_Z = -8.5;
const GANTRY_OUT_Z = 8.5;
const PHASES = [-3, 0, 3];

/** Stacked insulator / bushing: one lathe mesh of `discs` rims on a steel core. (x,y,z) = bottom centre. */
function discStack(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  h: number,
  discs: number,
  rDisc: number,
  mat: MatName = 'ink',
): THREE.Mesh {
  const pitch = h / discs;
  const t = pitch * 0.45;
  const rc = rDisc * 0.4;
  const pts = [new THREE.Vector2(0, 0), new THREE.Vector2(rc, 0)];
  for (let i = 0; i < discs; i++) {
    const y0 = i * pitch;
    pts.push(
      new THREE.Vector2(rDisc, y0),
      new THREE.Vector2(rDisc, y0 + t),
      new THREE.Vector2(rc, y0 + t),
      new THREE.Vector2(rc, y0 + pitch),
    );
  }
  pts.push(new THREE.Vector2(0, h));
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 12), MAT[mat]);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** Horizontal cylinder along X or Z. (x,y,z) = centre. */
function hcyl(
  parent: THREE.Object3D,
  r: number,
  len: number,
  axis: 'x' | 'z',
  mat: MatName,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), MAT[mat]);
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  else m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/**
 * Lattice column: four corner legs that taper from `base` to `top` half-width, with a ring of
 * rods at every interior level and one diagonal brace per face per bay.
 */
function lattice(
  parent: THREE.Object3D,
  cx: number,
  cz: number,
  H: number,
  base: number,
  top: number,
  bays: number,
): void {
  const half = (y: number) => base + (top - base) * (y / H);
  const ring = (y: number): THREE.Vector3[] => {
    const h = half(y);
    return [
      new THREE.Vector3(cx + h, y, cz + h),
      new THREE.Vector3(cx - h, y, cz + h),
      new THREE.Vector3(cx - h, y, cz - h),
      new THREE.Vector3(cx + h, y, cz - h),
    ];
  };
  const levels = Array.from({ length: bays + 1 }, (_, i) => ring((H * i) / bays));
  for (let i = 0; i < 4; i++) rod(parent, levels[0][i], levels[bays][i], 0.09, 'steel', 6);
  for (let k = 1; k < bays; k++) {
    for (let i = 0; i < 4; i++) rod(parent, levels[k][i], levels[k][(i + 1) % 4], 0.05, 'steelDark', 4);
  }
  for (let k = 0; k < bays; k++) {
    for (let i = 0; i < 4; i++) rod(parent, levels[k][i], levels[k + 1][(i + 1) % 4], 0.05, 'steelDark', 4);
  }
}

/** Cooling fan on the outer face of a radiator bank. The rotor spins about X. */
function fan(g: THREE.Group, x: number, y: number, z: number): void {
  const rotor = new THREE.Group();
  rotor.position.set(x, y, z);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.2, 10), MAT.steelDark);
  hub.rotation.z = Math.PI / 2;
  const bladeA = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.3, 0.22), MAT.steelDark);
  const bladeB = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 1.3), MAT.steelDark);
  rotor.add(hub, bladeA, bladeB);
  spin(rotor, 'x', 9);
  g.add(rotor);
  // static guard ring, normal along X
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.05, 6, 16), MAT.ink);
  guard.rotation.y = Math.PI / 2;
  guard.position.set(x, y, z);
  g.add(guard);
}

/** Oil-immersed transformer on a bund plinth, tank long axis along Z. (cx, cz) = plinth centre. */
function transformer(g: THREE.Group, cx: number, cz: number): void {
  const sgn = Math.sign(cx);
  box(g, 4.4, 0.25, 4.8, 'concrete', cx, 0, cz); // bund plinth
  box(g, 2.8, 2.9, 4.0, 'steelDark', cx, 0.25, cz); // main tank, top at 3.15

  for (const s of [-1, 1]) {
    // radiator fin bank on each side: rows of thin plates along Z
    for (let i = 0; i < 6; i++) {
      box(g, 0.6, 2.65, 0.1, 'steel', cx + s * 1.7, 0.25, cz - 1.6 + i * 0.64);
    }
    // cooling fan on the outer face, carried on a short bracket
    fan(g, cx + s * 2.2, 1.7, cz);
    rod(g, { x: cx + s * 1.9, y: 1.7, z: cz }, { x: cx + s * 2.2, y: 1.7, z: cz }, 0.06, 'steel', 5);
  }

  // three HV bushings on the outer side, tied together and dropped from the busbar
  const bx = cx + sgn * 0.8;
  for (const dz of [-1, 0, 1]) discStack(g, bx, 3.15, cz + dz, 1.25, 5, 0.2);
  rod(g, { x: bx, y: 4.4, z: cz - 1 }, { x: bx, y: 4.4, z: cz + 1 }, 0.05, 'steel', 5);

  // conservator tank on a cradle, opposite the bushings
  const conX = cx - sgn * 0.5;
  hcyl(g, 0.4, 3.2, 'z', 'steel', conX, 3.8, cz);
  cyl(g, 0.07, 0.07, 0.3, 'steel', conX, 3.15, cz - 1.1, 6);
  cyl(g, 0.07, 0.07, 0.3, 'steel', conX, 3.15, cz + 1.1, 6);

  // glow status lamps on the front face
  box(g, 0.3, 0.3, 0.05, 'glow', cx - 0.6, 1.2, cz + 2.02);
  box(g, 0.3, 0.3, 0.05, 'glow', cx + 0.6, 1.2, cz + 2.02);

  // LV feed from the tank front up to the LV bus
  rod(g, { x: cx, y: 2.6, z: cz + 2 }, { x: cx, y: LV_Y, z: LV_Z }, 0.06, 'steel', 5);
}

/** Circuit breaker unit on a concrete plinth with an insulator column. (x, z) = plinth centre. */
function breaker(g: THREE.Group, x: number, z: number): void {
  box(g, 1.0, 0.2, 1.0, 'concrete', x, 0, z);
  discStack(g, x, 0.2, z, 2.1, 5, 0.13);
  box(g, 0.8, 0.6, 0.7, 'steelDark', x, 2.3, z);
  box(g, 0.14, 0.14, 0.04, 'glow', x, 2.5, z + 0.36);
  rod(g, { x, y: 2.9, z }, { x, y: LV_Y, z }, 0.05, 'steel', 5);
}

/** Small control building, back-left corner. (cx, cz) = centre. */
function controlBuilding(g: THREE.Group, cx: number, cz: number): void {
  const W = 5.0;
  const D = 4.0;
  box(g, W + 0.2, 0.2, D + 0.2, 'concrete', cx, 0, cz); // plinth
  box(g, W, 3.4, D, 'wallWhite', cx, 0.2, cz); // walls, 0.2 to 3.6
  box(g, W + 0.2, 0.2, D + 0.2, 'concrete', cx, 3.6, cz); // roof slab
  // parapet ring
  box(g, W + 0.2, 0.4, 0.2, 'wallWhite', cx, 3.8, cz + D / 2);
  box(g, W + 0.2, 0.4, 0.2, 'wallWhite', cx, 3.8, cz - D / 2);
  box(g, 0.2, 0.4, D, 'wallWhite', cx - W / 2, 3.8, cz);
  box(g, 0.2, 0.4, D, 'wallWhite', cx + W / 2, 3.8, cz);
  // glow windows on the front and the east side
  windowGrid(g, {
    face: '+z', cx, cz, hw: W / 2, hd: D / 2,
    rows: 1, cols: 2, y0: 1.5, pitchY: 1, winW: 1.0, winH: 1.1, span: 1.6,
  });
  windowGrid(g, {
    face: '+x', cx, cz, hw: W / 2, hd: D / 2,
    rows: 1, cols: 2, y0: 1.5, pitchY: 1, winW: 1.0, winH: 1.1, span: 2.4,
  });
  // door, step, warning sign over the door
  const dx = cx - 1.9;
  box(g, 0.9, 2.2, 0.08, 'wood', dx, 0.2, cz + D / 2 + 0.02);
  box(g, 1.3, 0.2, 0.6, 'concrete', dx, 0, cz + D / 2 + 0.3);
  box(g, 1.1, 0.35, 0.06, 'yellow', dx, 2.6, cz + D / 2 + 0.03);
  // roof AC unit with a grille lid
  box(g, 1.2, 0.7, 1.0, 'steel', cx + 1.0, 3.8, cz - 0.5);
  box(g, 1.22, 0.08, 1.02, 'ink', cx + 1.0, 4.5, cz - 0.5);
}

/** Large switch house with roller doors (variant 1). Walls span x -0.5..8.5, z -0.25..5.25. */
function switchHouse(g: THREE.Group): void {
  const cx = 4.0;
  const cz = 2.5;
  const W = 9.0;
  const D = 5.5;
  const H = 5.5;
  box(g, W + 0.4, 0.2, D + 0.4, 'concrete', cx, 0, cz); // plinth
  box(g, W, H, D, 'wallSand', cx, 0.2, cz); // walls, 0.2 to 5.7
  box(g, W + 0.4, 0.2, D + 0.4, 'concrete', cx, 5.7, cz); // roof slab
  box(g, W + 0.4, 0.35, 0.2, 'wallWhite', cx, 5.9, cz + D / 2);
  box(g, W + 0.4, 0.35, 0.2, 'wallWhite', cx, 5.9, cz - D / 2);
  box(g, 0.2, 0.35, D, 'wallWhite', cx - W / 2, 5.9, cz);
  box(g, 0.2, 0.35, D, 'wallWhite', cx + W / 2, 5.9, cz);
  // glow windows: east face (three) and one between the doors on the front
  windowGrid(g, {
    face: '+x', cx, cz, hw: W / 2, hd: D / 2,
    rows: 1, cols: 3, y0: 2.0, pitchY: 1, winW: 0.9, winH: 1.5, span: 3.6,
  });
  windowGrid(g, {
    face: '+z', cx, cz, hw: W / 2, hd: D / 2,
    rows: 1, cols: 1, y0: 2.0, pitchY: 1, winW: 0.9, winH: 1.5,
  });
  // two roller doors on the front: steel shutter, ink slats, ink lintel
  for (const xd of [2.0, 6.0]) {
    box(g, 2.4, 3.2, 0.12, 'steel', xd, 0.2, cz + D / 2);
    for (let k = 0; k < 6; k++) box(g, 2.4, 0.07, 0.16, 'ink', xd, 0.5 + k * 0.5, cz + D / 2 + 0.04);
    box(g, 2.7, 0.3, 0.2, 'ink', xd, 3.4, cz + D / 2 + 0.06);
  }
  box(g, 1.6, 0.45, 0.06, 'yellow', cx, 3.8, cz + D / 2 + 0.03);
  // roof AC units
  for (const ax of [1.8, 6.4]) {
    box(g, 1.6, 0.8, 1.2, 'steel', ax, 5.9, 0.6);
    box(g, 1.62, 0.08, 1.22, 'ink', ax, 6.7, 0.6);
  }
}

export const build: ModelBuilder = ({ variant }) => {
  const v1 = variant === 1;
  const g = new THREE.Group();

  // ---- yard: concrete slab, gravel top, fence and gate ----
  box(g, 22, 0.12, 22, 'concrete', 0, 0, 0);
  box(g, 20.4, 0.06, 20.4, 'paving', 0, 0.12, 0);

  const fh = 2.0;
  railing(g, { x: -F, y: 0, z: -F }, { x: F, y: 0, z: -F }, fh);
  railing(g, { x: F, y: 0, z: -F }, { x: F, y: 0, z: F }, fh);
  railing(g, { x: F, y: 0, z: F }, { x: 1.5, y: 0, z: F }, fh);
  railing(g, { x: -1.5, y: 0, z: F }, { x: -F, y: 0, z: F }, fh);
  railing(g, { x: -F, y: 0, z: F }, { x: -F, y: 0, z: -F }, fh);
  // gate across the front opening, yellow rails with a brace and steel gate posts
  railing(g, { x: -1.5, y: 0, z: F }, { x: 1.5, y: 0, z: F }, fh, 'yellow');
  rod(g, { x: -1.5, y: 0.1, z: F }, { x: 1.5, y: 1.9, z: F }, 0.04, 'ink', 4);
  box(g, 0.3, 2.3, 0.3, 'steelDark', -1.5, 0, F);
  box(g, 0.3, 2.3, 0.3, 'steelDark', 1.5, 0, F);

  // yellow warning plates: ink border behind, yellow plate in front
  const sign = (x: number, z: number, face: '+z' | '+x' | '-x') => {
    if (face === '+z') {
      box(g, 0.7, 0.55, 0.04, 'yellow', x, 1.1, z + 0.03);
      box(g, 0.78, 0.63, 0.02, 'ink', x, 1.06, z);
    } else {
      const s = face === '+x' ? 1 : -1;
      box(g, 0.04, 0.55, 0.7, 'yellow', x + s * 0.03, 1.1, z);
      box(g, 0.02, 0.63, 0.78, 'ink', x, 1.06, z);
    }
  };
  sign(-5, F, '+z');
  sign(5, F, '+z');
  sign(-F, 0, '-x');
  sign(F, 0, '+x');

  // ---- incoming HV portal, back (-Z) ----
  for (const gx of [-4.5, 4.5]) {
    box(g, 1.2, 0.4, 1.2, 'concrete', gx, 0, GANTRY_IN_Z);
    lattice(g, gx, GANTRY_IN_Z, 12, 0.5, 0.3, 3);
    sphere(g, 0.2, 'beacon', gx, 12.8, GANTRY_IN_Z); // red aviation light
  }
  box(g, 10.2, 0.6, 0.8, 'steel', 0, 12.0, GANTRY_IN_Z); // crossbeam, 12.0 to 12.6

  // three incoming insulator strings, droppers to the busbar, and phase lanes along Z
  for (const px of PHASES) {
    discStack(g, px, INC_Y, GANTRY_IN_Z, 0.8, 4, 0.22);
    rod(g, { x: px, y: INC_Y, z: GANTRY_IN_Z }, { x: px, y: BUS_Y, z: GANTRY_IN_Z }, 0.06, 'steel', 6);
    rod(g, { x: px, y: BUS_Y, z: GANTRY_IN_Z }, { x: px, y: BUS_Y, z: MAIN_Z }, 0.1, 'steel', 6);
    cyl(g, 0.12, 0.12, 6.4, 'steel', px, 0, -5.0, 8);
    discStack(g, px, 6.4, -5.0, 0.55, 3, 0.2);
  }
  setPowerPorts(
    g,
    PHASES.map((px) => ({ x: px, y: INC_Y, z: GANTRY_IN_Z })),
  );

  // main busbar across the yard, on steel posts
  rod(g, { x: -8.5, y: BUS_Y, z: MAIN_Z }, { x: v1 ? 3.5 : 8.5, y: BUS_Y, z: MAIN_Z }, 0.12, 'steel', 8);
  for (const bx of v1 ? [-4, 1.5] : [-4, 4]) {
    cyl(g, 0.12, 0.12, 6.4, 'steel', bx, 0, MAIN_Z, 8);
    discStack(g, bx, 6.4, MAIN_Z, 0.55, 3, 0.2);
  }

  // transformers, each dropped from the busbar onto its HV bushings
  const txs = v1 ? [-7] : [-7, 7];
  for (const cx of txs) {
    transformer(g, cx, MAIN_Z);
    const bx = cx + Math.sign(cx) * 0.8;
    rod(g, { x: bx, y: BUS_Y, z: MAIN_Z }, { x: bx, y: 4.4, z: MAIN_Z }, 0.06, 'steel', 6);
  }

  // LV bus along X on insulator posts; breakers hang off it (variant 0), or it enters the switch house (variant 1)
  rod(g, { x: -7, y: LV_Y, z: LV_Z }, { x: v1 ? -0.5 : 7, y: LV_Y, z: LV_Z }, 0.1, 'steel', 6);
  for (const x of v1 ? [-4, -2] : [-4, 0, 4]) discStack(g, x, 0, LV_Z, LV_Y - 0.1, 6, 0.2);

  // outgoing feeders: breaker or roof bushing, riser, jog to the front gantry
  const outXs = v1 ? [0.5, 2.9, 5.3, 7.7] : [-6, -2, 2, 6];
  if (!v1) for (const x of outXs) breaker(g, x, LV_Z);
  for (const x of outXs) {
    if (v1) discStack(g, x, 5.9, LV_Z, 0.6, 3, 0.16);
    const y0 = v1 ? 6.5 : LV_Y;
    rod(g, { x, y: y0, z: LV_Z }, { x, y: OUT_Y, z: LV_Z }, 0.05, 'steel', 5);
    rod(g, { x, y: OUT_Y, z: LV_Z }, { x, y: OUT_Y, z: GANTRY_OUT_Z }, 0.05, 'steel', 5);
    discStack(g, x, OUT_Y, GANTRY_OUT_Z, 0.8, 4, 0.22);
  }
  setOutPorts(
    g,
    outXs.map((x) => ({ x, y: OUT_Y, z: GANTRY_OUT_Z })),
  );

  // outgoing feeder gantry, front (+Z), lower
  for (const gx of [-8.5, 8.5]) {
    box(g, 1.2, 0.4, 1.2, 'concrete', gx, 0, GANTRY_OUT_Z);
    lattice(g, gx, GANTRY_OUT_Z, 9, 0.5, 0.3, 2);
  }
  box(g, 17.6, 0.6, 0.8, 'steel', 0, 9.0, GANTRY_OUT_Z); // crossbeam, 9.0 to 9.6

  // buildings
  controlBuilding(g, -7.9, -7.6);
  if (v1) switchHouse(g);

  return g;
};
