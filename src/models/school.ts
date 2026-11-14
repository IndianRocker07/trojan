// School, also used as a disaster relief shelter. Footprint 3x2 cells = 36 m (X) x 24 m (Z).
// Origin = footprint centre at ground level, Y up, front faces +Z.
import * as THREE from 'three';
import { MAT, type MatName } from '../render/palette';
import {
  box,
  cyl,
  hipRoof,
  insulator,
  ladder,
  rod,
  setPowerPorts,
  windowGrid,
  type Face,
  type ModelBuilder,
} from './kit';

export const VARIANTS = 2;

/** Top of the lot paving slab: the level every building stands on. */
const PAVE = 0.1;
/** Top of the grass slab. */
const GRASS = 0.15;
/** Storey height used for every wall and window row. */
const STOREY = 3.2;
/** Tilt of solar panels in radians (low edge toward +Z). */
const TILT = 0.3;

/** Plain mesh for shapes the kit cannot make (rotated boxes, wheels, rings). Never a new material. */
function put(
  g: THREE.Group,
  geo: THREE.BufferGeometry,
  mat: MatName,
  x: number,
  y: number,
  z: number,
  rx = 0,
): void {
  const m = new THREE.Mesh(geo, MAT[mat]);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  g.add(m);
}

/** Tilted solar panel on a roof (roofY = roof top) with two steel legs down to the roof. */
function solar(g: THREE.Group, x: number, roofY: number, z: number): void {
  const w = 1.7;
  const d = 1.1;
  const cy = roofY + 0.55;
  put(g, new THREE.BoxGeometry(w, 0.08, d), 'roofBlue', x, cy, z, TILT);
  for (const s of [-0.4, 0.4]) {
    // underside height at local offset s along the tilted panel
    const under = cy - s * Math.sin(TILT) - 0.04 * Math.cos(TILT);
    rod(g, { x, y: roofY, z: z + s }, { x, y: under, z: z + s }, 0.04, 'steel', 6);
  }
}

function vent(g: THREE.Group, x: number, y: number, z: number): void {
  cyl(g, 0.22, 0.22, 0.5, 'steel', x, y, z, 10);
  cyl(g, 0.3, 0.3, 0.08, 'ink', x, y + 0.5, z, 10);
}

function hvac(g: THREE.Group, x: number, y: number, z: number): void {
  box(g, 2.2, 1.1, 1.6, 'steel', x, y, z);
  box(g, 1.9, 0.05, 1.3, 'ink', x, y + 1.1, z);
}

/** Water tank on a concrete plinth, with a dome cap. y = roof top. */
function waterTank(g: THREE.Group, x: number, roofY: number, z: number, plinth: number): void {
  box(g, plinth, 0.3, plinth, 'concrete', x, roofY, z);
  const base = roofY + 0.3;
  cyl(g, 1.0, 1.0, 2.0, 'water', x, base, z, 16);
  cyl(g, 0.2, 1.05, 0.35, 'roofBlue', x, base + 2.0, z, 16);
}

/** Pair of glow-less entrance doors in a frame, centred on x, bottom at y0. */
function doubleDoor(g: THREE.Group, x: number, y0: number, zFace: number, w: number): void {
  box(g, w + 0.3, 2.3, 0.08, 'ink', x, y0, zFace + 0.04);
  box(g, w / 2 - 0.02, 2.0, 0.06, 'glass', x - w / 4, y0 + 0.05, zFace + 0.11);
  box(g, w / 2 - 0.02, 2.0, 0.06, 'glass', x + w / 4, y0 + 0.05, zFace + 0.11);
}

/** Relief tent: white skirt, blue hip roof, dark door on +Z, two guy ropes. */
function tent(g: THREE.Group, x: number, z: number): void {
  box(g, 2.6, 0.9, 2.6, 'wallWhite', x, GRASS, z);
  hipRoof(g, 3.0, 3.0, 1.2, 'blue', x, GRASS + 0.9, z);
  box(g, 0.8, 0.8, 0.05, 'ink', x, GRASS, z + 1.32);
  for (const s of [-1, 1]) {
    rod(g, { x: x + s * 1.4, y: GRASS + 0.85, z: z + 1.4 }, { x: x + s * 2.2, y: GRASS, z: z + 2.2 }, 0.02, 'ink', 4);
  }
}

/** Supply crate with an ink strap across the lid. */
function crate(g: THREE.Group, x: number, y: number, z: number): void {
  box(g, 1.3, 1.0, 1.1, 'wood', x, y, z);
  box(g, 0.12, 0.03, 1.12, 'ink', x, y + 1.0, z);
}

/** Wheel with its axle along Z; bottom sits on the paving. */
function wheel(g: THREE.Group, x: number, z: number): void {
  put(g, new THREE.CylinderGeometry(0.5, 0.5, 0.36, 12), 'ink', x, PAVE + 0.5, z, Math.PI / 2);
}

/** Yellow school bus parked along X, front (+X end) toward the building. */
function bus(g: THREE.Group, cx: number, cz: number): void {
  const L = 11.8;
  const W = 2.5;
  const x0 = cx - L / 2;
  const x1 = cx + L / 2;
  box(g, L, 1.2, W, 'yellow', cx, 0.8, cz);
  box(g, L, 1.1, W, 'yellow', cx, 2.0, cz);
  // black window band on both sides, a windscreen, one door
  for (const s of [-1, 1]) {
    box(g, 9.0, 0.75, 0.04, 'glass', cx - 1.3, 2.2, cz + s * (W / 2 + 0.02));
  }
  box(g, 0.04, 0.9, 2.0, 'glass', x1 + 0.02, 2.1, cz);
  box(g, 0.9, 1.9, 0.05, 'glass', x1 - 2.0, 0.95, cz + W / 2 + 0.02);
  // bumpers
  box(g, 0.3, 0.35, 2.6, 'ink', x1 + 0.15, 0.45, cz);
  box(g, 0.3, 0.35, 2.6, 'ink', x0 - 0.15, 0.45, cz);
  for (const x of [x0 + 2.0, x1 - 2.2]) {
    for (const s of [-1, 1]) wheel(g, x, cz + s * 1.05);
  }
}

/** Two-tone flagpole with plinth and a red flag, base at (x, z). */
function flagpole(g: THREE.Group, x: number, z: number): void {
  cyl(g, 0.35, 0.35, 0.15, 'concrete', x, PAVE, z, 12);
  cyl(g, 0.06, 0.06, 6.0, 'steel', x, PAVE + 0.15, z, 8);
  box(g, 1.3, 0.8, 0.03, 'red', x + 0.65, 5.2, z);
}

/** Wall-mounted insulator bracket at a corner, returns the power port point. */
function powerBracket(g: THREE.Group, x: number, y: number, z: number, dx: number): THREE.Vector3 {
  // plate on the wall, steel arm out to the insulator
  box(g, 0.12, 0.6, 0.5, 'steelDark', x + dx * 0.06, y - 0.25, z);
  rod(g, { x: x + dx * 0.12, y, z }, { x: x + dx * 1.0, y, z }, 0.05, 'steel', 6);
  return insulator(g, x + dx * 1.0, y, z, 2);
}

/** Playground on the courtyard mat: slide, A-frame swings. Mat top = PAVE + 0.05. */
function playground(g: THREE.Group): void {
  box(g, 11.6, 0.05, 4.2, 'wood', 0, PAVE, -2.6);
  // slide: platform, ramp down to the mat, ladder
  box(g, 1.4, 0.1, 1.4, 'orange', -4.6, 1.1, -4.2);
  for (const x of [-5.2, -4.0]) {
    for (const z of [-4.8, -3.6]) rod(g, { x, y: GRASS, z }, { x, y: 1.1, z }, 0.05, 'steel', 6);
  }
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 3.6), MAT.orange);
  ramp.position.set(-4.6, 0.675, -1.8);
  ramp.rotation.x = Math.asin(1.05 / 3.6);
  g.add(ramp);
  ladder(g, -5.5, -4.2, GRASS, 1.1, '-x', 'steel');
  // swing frame: two A-frames, top bar, two swings
  for (const x of [2.2, 5.2]) {
    rod(g, { x, y: GRASS, z: -1.2 }, { x, y: 2.4, z: -2.6 }, 0.05, 'steel', 6);
    rod(g, { x, y: GRASS, z: -4.0 }, { x, y: 2.4, z: -2.6 }, 0.05, 'steel', 6);
  }
  rod(g, { x: 2.2, y: 2.4, z: -2.6 }, { x: 5.2, y: 2.4, z: -2.6 }, 0.06, 'steel', 6);
  for (const x of [3.1, 4.3]) {
    box(g, 0.5, 0.06, 0.3, 'wood', x, 1.2, -2.6);
    for (const z of [-2.72, -2.48]) rod(g, { x, y: 2.4, z }, { x, y: 1.26, z }, 0.02, 'ink', 4);
  }
}

/** Goal: two uprights and a crossbar, opening toward the field centre. */
function goal(g: THREE.Group, x: number, zc: number): void {
  const z1 = zc - 1.5;
  const z2 = zc + 1.5;
  rod(g, { x, y: GRASS, z: z1 }, { x, y: 2.3, z: z1 }, 0.06, 'wallWhite', 6);
  rod(g, { x, y: GRASS, z: z2 }, { x, y: 2.3, z: z2 }, 0.06, 'wallWhite', 6);
  rod(g, { x, y: 2.3, z: z1 }, { x, y: 2.3, z: z2 }, 0.06, 'wallWhite', 6);
}

/** Basketball hoop: pole, arm, white backboard, orange ring facing +Z. */
function hoop(g: THREE.Group, x: number, z: number): void {
  cyl(g, 0.08, 0.08, 3.1, 'steel', x, GRASS, z, 8);
  rod(g, { x, y: 3.0, z: z + 0.05 }, { x, y: 3.0, z: z + 0.65 }, 0.05, 'steel', 6);
  box(g, 1.8, 1.0, 0.05, 'wallWhite', x, 2.9, z + 0.7);
  put(g, new THREE.TorusGeometry(0.23, 0.025, 6, 16), 'orange', x, 3.05, z + 1.15, Math.PI / 2);
  rod(g, { x, y: 3.05, z: z + 0.725 }, { x, y: 3.05, z: z + 0.92 }, 0.02, 'orange', 4);
}

/** Window rows for one wing of the U. cx/cz = wing centre, outer = +1 (east) or -1 (west). */
function wingWindows(g: THREE.Group, cx: number, outer: 1 | -1): void {
  const base = {
    cx,
    cz: -2.5,
    hw: 3,
    hd: 2.5,
    rows: 2,
    y0: PAVE + 1.0,
    pitchY: STOREY,
    winW: 1.2,
    winH: 1.5,
    frames: true,
  };
  const outFace: Face = outer > 0 ? '+x' : '-x';
  const inFace: Face = outer > 0 ? '-x' : '+x';
  windowGrid(g, { ...base, face: outFace, cols: 2 });
  windowGrid(g, { ...base, face: '-z', cols: 3 });
  windowGrid(g, { ...base, face: inFace, cols: 2 });
}

function buildUSchool(g: THREE.Group): void {
  // ---- lot, field, courtyard ----
  box(g, 34.4, PAVE, 22.4, 'paving', 0, 0, 0);
  box(g, 32, 0.05, 5.6, 'grass', 0, PAVE, -8.4);
  // white line boxes and centre circle
  box(g, 31.8, 0.02, 0.1, 'wallWhite', 0, GRASS, -11.0);
  box(g, 31.8, 0.02, 0.1, 'wallWhite', 0, GRASS, -5.8);
  box(g, 0.1, 0.02, 5.2, 'wallWhite', 0, GRASS, -8.4);
  box(g, 0.1, 0.02, 5.2, 'wallWhite', -15.9, GRASS, -8.4);
  box(g, 0.1, 0.02, 5.2, 'wallWhite', 15.9, GRASS, -8.4);
  put(g, new THREE.TorusGeometry(1.2, 0.04, 6, 24), 'wallWhite', 0, GRASS + 0.01, -8.4, Math.PI / 2);
  goal(g, -15.3, -8.4);
  goal(g, 15.3, -8.4);
  hoop(g, 12.5, -10.4);
  playground(g);

  // ---- relief shelter kit on the field ----
  tent(g, -11.2, -8.6);
  tent(g, -7.6, -9.4);
  tent(g, -3.6, -8.2);
  crate(g, 5.4, GRASS, -8.0);
  crate(g, 6.8, GRASS, -8.0);
  crate(g, 6.1, GRASS + 1.0, -8.0);

  // ---- U-shaped two-storey block ----
  const WALL_TOP = PAVE + 2 * STOREY; // 6.5
  const ROOF_Y = WALL_TOP + 0.35; // top of coral roof slab, 6.85
  // walls: front bar and two wings reaching back toward the field
  box(g, 26, 2 * STOREY, 5, 'wallYellow', 0, PAVE, 2.5);
  box(g, 6, 2 * STOREY, 5, 'wallYellow', -10, PAVE, -2.5);
  box(g, 6, 2 * STOREY, 5, 'wallYellow', 10, PAVE, -2.5);
  // white cornice bands and coral flat roofs
  box(g, 26.3, 0.22, 5.3, 'wallWhite', 0, WALL_TOP, 2.5);
  box(g, 6.3, 0.22, 5.3, 'wallWhite', -10, WALL_TOP, -2.5);
  box(g, 6.3, 0.22, 5.3, 'wallWhite', 10, WALL_TOP, -2.5);
  box(g, 25.2, 0.13, 4.2, 'roofCoral', 0, WALL_TOP + 0.22, 2.5);
  box(g, 5.2, 0.13, 4.2, 'roofCoral', -10, WALL_TOP + 0.22, -2.5);
  box(g, 5.2, 0.13, 4.2, 'roofCoral', 10, WALL_TOP + 0.22, -2.5);

  // classroom windows: long front row, courtyard face of the bar, both wings
  windowGrid(g, {
    face: '+z',
    cx: 0,
    cz: 2.5,
    hw: 13,
    hd: 2.5,
    rows: 2,
    cols: 9,
    y0: PAVE + 1.0,
    pitchY: STOREY,
    winW: 1.2,
    winH: 1.5,
    frames: true,
    skip: (r, c) => r === 0 && c === 4,
  });
  windowGrid(g, {
    face: '-z',
    cx: 0,
    cz: 2.5,
    hw: 7,
    hd: 2.5,
    rows: 2,
    cols: 5,
    y0: PAVE + 1.0,
    pitchY: STOREY,
    winW: 1.2,
    winH: 1.5,
    frames: true,
  });
  wingWindows(g, -10, -1);
  wingWindows(g, 10, 1);

  // entrance tower over the middle of the front bar: body, belfry, bell, hip roof, clock
  box(g, 4, 2, 4, 'wallYellow', 0, ROOF_Y, 2.5);
  for (const x of [-1.7, 1.7]) {
    for (const z of [0.8, 4.2]) rod(g, { x, y: ROOF_Y + 2, z }, { x, y: ROOF_Y + 2.75, z }, 0.1, 'wallWhite', 6);
  }
  hipRoof(g, 4.4, 4.4, 1.3, 'roofCoral', 0, ROOF_Y + 2.75, 2.5);
  cyl(g, 0.3, 0.42, 0.45, 'orange', 0, ROOF_Y + 2.05, 2.5, 12);
  put(g, new THREE.CylinderGeometry(0.7, 0.7, 0.1, 16), 'wallWhite', 0, 7.85, 4.53, Math.PI / 2);
  box(g, 0.09, 0.42, 0.04, 'ink', 0, 7.85, 4.6);
  box(g, 0.5, 0.07, 0.04, 'ink', 0.25, 7.815, 4.6);

  // entrance: stoop, coral canopy on posts, double doors
  box(g, 4.6, 0.3, 1.2, 'concrete', 0, PAVE, 5.6);
  box(g, 4.6, 0.15, 0.5, 'concrete', 0, PAVE, 6.45);
  box(g, 5.4, 0.25, 2.6, 'roofCoral', 0, 2.9, 6.3);
  for (const x of [-2.4, 2.4]) rod(g, { x, y: PAVE, z: 7.2 }, { x, y: 2.9, z: 7.2 }, 0.1, 'wallWhite', 6);
  doubleDoor(g, 0, 0.4, 5.0, 2.2);

  // roof: solar, vents, water tank with ladder
  solar(g, -11.2, ROOF_Y, -2.5);
  solar(g, -8.6, ROOF_Y, -2.5);
  solar(g, -9.6, WALL_TOP + 0.35, 2.5);
  solar(g, -7.0, WALL_TOP + 0.35, 2.5);
  vent(g, 8.2, ROOF_Y, -3.7);
  vent(g, 8.2, ROOF_Y, -1.3);
  vent(g, -4.5, ROOF_Y, 3.6);
  vent(g, 4.6, ROOF_Y, 3.6);
  waterTank(g, 10, ROOF_Y, -2.5, 2.6);
  ladder(g, 11.15, -2.5, ROOF_Y + 0.3, ROOF_Y + 2.1, '+x');

  // flagpole at the front right
  flagpole(g, 6.0, 8.0);

  // yellow school bus parked along the front left
  bus(g, -10, 9.0);

  // power: front-left corner of the roof edge
  setPowerPorts(g, [powerBracket(g, -12.2, 6.95, 4.2, 1)]);
}

function buildSlab(g: THREE.Group): void {
  const MX = -6.25; // centre X of the main block
  // ---- lot, lawn and entrance path ----
  box(g, 34.4, PAVE, 22.4, 'paving', 0, 0, 0);
  box(g, 14, 0.05, 5.4, 'grass', -4, PAVE, 8.1);
  box(g, 2.6, 0.06, 6.3, 'concrete', MX, PAVE, 7.65);
  flagpole(g, -12.4, 8.8);

  // ---- straight three-storey teal slab ----
  box(g, 19.5, 3 * STOREY, 9, 'wallTeal', MX, PAVE, 0);
  // white floor bands and a parapet cornice
  for (const y of [PAVE + STOREY, PAVE + 2 * STOREY, PAVE + 3 * STOREY - 0.22]) {
    box(g, 19.8, 0.22, 9.3, 'wallWhite', MX, y, 0);
  }
  box(g, 19.2, 0.15, 8.7, 'roofSand', MX, PAVE + 3 * STOREY, 0);
  // classroom windows on front, back and both ends; front ground-floor door slot
  windowGrid(g, {
    face: '+z',
    cx: MX,
    cz: 0,
    hw: 9.75,
    hd: 4.5,
    rows: 3,
    cols: 7,
    y0: PAVE + 0.9,
    pitchY: STOREY,
    winW: 1.2,
    winH: 1.5,
    frames: true,
    skip: (r, c) => r === 0 && c === 3,
  });
  windowGrid(g, {
    face: '-z',
    cx: MX,
    cz: 0,
    hw: 9.75,
    hd: 4.5,
    rows: 3,
    cols: 7,
    y0: PAVE + 0.9,
    pitchY: STOREY,
    winW: 1.2,
    winH: 1.5,
    frames: true,
  });
  windowGrid(g, {
    face: '-x',
    cx: MX,
    cz: 0,
    hw: 9.75,
    hd: 4.5,
    rows: 3,
    cols: 3,
    y0: PAVE + 0.9,
    pitchY: STOREY,
    winW: 1.2,
    winH: 1.5,
    frames: true,
  });
  windowGrid(g, {
    face: '+x',
    cx: MX,
    cz: 0,
    hw: 9.75,
    hd: 4.5,
    rows: 3,
    cols: 3,
    y0: PAVE + 0.9,
    pitchY: STOREY,
    winW: 1.2,
    winH: 1.5,
    frames: true,
    skip: (_r, c) => c === 1, // walkway lands on this end
  });

  // main entrance: stoop, white canopy on steel posts, double doors
  box(g, 4.0, 0.3, 1.2, 'concrete', MX, PAVE, 5.1);
  box(g, 4.0, 0.15, 0.5, 'concrete', MX, PAVE, 5.95);
  box(g, 5.0, 0.25, 2.2, 'wallWhite', MX, 2.9, 5.6);
  for (const x of [MX - 2.1, MX + 2.1]) rod(g, { x, y: PAVE, z: 6.4 }, { x, y: 2.9, z: 6.4 }, 0.08, 'steel', 6);
  doubleDoor(g, MX, 0.4, 4.5, 2.4);

  // roof: stair bulkhead, solar, HVAC, vents, water tank
  box(g, 2.4, 2.3, 2.4, 'wallWhite', -14.5, PAVE + 3 * STOREY + 0.15, -2.5);
  box(g, 0.9, 1.8, 0.05, 'ink', -14.5, PAVE + 3 * STOREY + 0.15, -1.27);
  const roofY = PAVE + 3 * STOREY + 0.15; // 9.85
  for (const x of [-11.6, -8.9, -6.2]) solar(g, x, roofY, 1.5);
  hvac(g, -3.8, roofY, -2.5);
  hvac(g, -0.9, roofY, -2.5);
  vent(g, -1.5, roofY, 1.5);
  vent(g, 0.5, roofY, 1.5);
  waterTank(g, 2.0, roofY, -2.5, 2.4);

  // covered walkway to the gym (floor, coral roof on four posts)
  box(g, 6.0, 0.15, 3.0, 'concrete', 6.5, PAVE, 0);
  box(g, 6.4, 0.2, 3.4, 'roofCoral', 6.5, 3.4, 0);
  for (const x of [4.4, 8.6]) {
    for (const z of [-1.4, 1.4]) box(g, 0.2, 3.15, 0.2, 'wallWhite', x, 0.25, z);
  }
  // doorway in the slab's east end
  box(g, 0.06, 2.1, 1.8, 'glass', 3.52, 0.25, 0);

  // ---- separate gym hall: white box with a curved coral barrel roof ----
  box(g, 7, 5.0, 9, 'wallWhite', 13, PAVE, 0);
  const shape = new THREE.Shape();
  shape.moveTo(4.5, 0);
  shape.absarc(0, 0, 4.5, 0, Math.PI, false);
  shape.closePath();
  const barrelGeo = new THREE.ExtrudeGeometry(shape, { depth: 7, bevelEnabled: false, curveSegments: 16 });
  barrelGeo.translate(0, 0, -3.5);
  barrelGeo.rotateY(Math.PI / 2); // length along X, arch across Z
  const barrel = new THREE.Mesh(barrelGeo, MAT.roofCoral);
  barrel.position.set(13, PAVE + 5.0, 0);
  g.add(barrel);
  // gym front door (north side, toward the street), west door onto the walkway
  box(g, 2.1, 2.35, 0.05, 'ink', 13, PAVE, 4.5);
  box(g, 1.8, 2.2, 0.08, 'glass', 13, PAVE, 4.56);
  box(g, 0.06, 2.2, 1.8, 'glass', 9.53, PAVE, 0);
  // clerestory windows on front, back and east end
  windowGrid(g, {
    face: '+z',
    cx: 13,
    cz: 0,
    hw: 3.5,
    hd: 4.5,
    rows: 1,
    cols: 5,
    y0: 2.9,
    pitchY: 0,
    winW: 1.1,
    winH: 1.5,
    frames: true,
  });
  windowGrid(g, {
    face: '-z',
    cx: 13,
    cz: 0,
    hw: 3.5,
    hd: 4.5,
    rows: 1,
    cols: 5,
    y0: 2.9,
    pitchY: 0,
    winW: 1.1,
    winH: 1.5,
    frames: true,
  });
  windowGrid(g, {
    face: '+x',
    cx: 13,
    cz: 0,
    hw: 3.5,
    hd: 4.5,
    rows: 1,
    cols: 3,
    y0: 2.9,
    pitchY: 0,
    winW: 1.1,
    winH: 1.5,
    frames: true,
  });

  // power: front-left corner of the slab, bracket at about 7 m (slab roof is at 9.85 m)
  setPowerPorts(g, [powerBracket(g, MX - 9.75, 6.8, 3.9, -1)]);
}

export const build: ModelBuilder = ({ variant }) => {
  const g = new THREE.Group();
  if (variant === 1) buildSlab(g);
  else buildUSchool(g);
  return g;
};
