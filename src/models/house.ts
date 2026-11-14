// Residential house models: four variants on a 1x1 cell lot (12 x 12 m).
// Origin = centre of the lot at ground level, Y up, front faces +Z.
import * as THREE from 'three';
import {
  box, cyl, gableRoof, hipRoof, insulator, ladder, railing, seeded, setPowerPorts, sphere,
  type Face, type ModelBuilder,
} from './kit';
import { MAT, type MatName } from '../render/palette';

export const VARIANTS = 5;

type Mat = MatName;

/** Heights (m). */
const GROUND = 0.12; // top of the lot slab
const FL = 0.42; // ground floor level (plinth stands 0.3 m above the slab)
const STOREY = 3.2; // wall height per storey
const T1 = FL + STOREY; // 3.62: first-floor level / one-storey eave
const TOP = FL + 2 * STOREY; // 6.82: two-storey eave
const LOT_H = 5.2; // lot edge (0.8 m inside the 12 m cell)

// ---- helpers ----------------------------------------------------------------

function pickFrom<T>(rnd: () => number, list: readonly T[]): T {
  return list[Math.floor(rnd() * list.length)];
}

/**
 * Flat panel on a wall. `surf` = wall plane coordinate, `u` = position along the wall,
 * `y` = centre height, `out` = centre distance outwards from the wall plane.
 * `tw` = width along the wall, `th` = height, `depth` = thickness out of the wall.
 */
function panel(
  g: THREE.Group, face: Face, surf: number, u: number, y: number,
  tw: number, th: number, depth: number, out: number, mat: Mat,
): void {
  const n = surf + (face[0] === '+' ? out : -out);
  if (face[1] === 'z') box(g, tw, th, depth, mat, u, y - th / 2, n);
  else box(g, depth, th, tw, mat, n, y - th / 2, u);
}

/** Framed glow window centred at (u, y) on a wall. `detail` adds mullions and a sill. */
function windowOn(
  g: THREE.Group, face: Face, surf: number, u: number, y: number,
  w: number, h: number, detail = true,
): void {
  panel(g, face, surf, u, y, w + 0.24, h + 0.24, 0.1, 0.05, 'ink'); // ink surround
  panel(g, face, surf, u, y, w, h, 0.06, 0.12, 'glow'); // lit pane
  if (detail) {
    panel(g, face, surf, u, y, 0.07, h, 0.06, 0.17, 'ink'); // mullion
    panel(g, face, surf, u, y, w, 0.07, 0.06, 0.17, 'ink'); // transom
    panel(g, face, surf, u, y - h / 2 - 0.17, w + 0.3, 0.1, 0.22, 0.1, 'concrete'); // sill
  }
}

/** Closely spaced lap siding courses, inset behind the window and door trim. */
function clapboard(g: THREE.Group, face: Face, surf: number, u0: number, u1: number, y0: number, y1: number): void {
  const width = u1 - u0;
  for (let y = y0 + 0.28; y < y1 - 0.12; y += 0.38) {
    panel(g, face, surf, (u0 + u1) / 2, y, width, 0.035, 0.07, 0.005, 'siding');
  }
}

/** Raised asphalt shingle courses on both pitches of a gable roof. */
function shingleCourses(g: THREE.Group, ridgeX: number, ridgeZ: number, eaveY: number, halfDepth: number, rise: number, width: number): void {
  const pitch = Math.atan2(rise, halfDepth);
  for (const side of [-1, 1] as const) {
    for (let run = 0.48; run < halfDepth - 0.08; run += 0.52) {
      const z = ridgeZ + side * run;
      const y = eaveY + rise * (1 - run / halfDepth);
      const course = box(g, width, 0.035, 0.095, 'roofShingle', ridgeX, y + 0.018, z);
      course.rotation.x = side * pitch;
    }
  }
}

/** Paired louvered shutters for the narrow double-hung windows common on US homes. */
function shutters(g: THREE.Group, face: Face, surf: number, u: number, y: number, w: number, h: number): void {
  for (const side of [-1, 1]) {
    const x = u + side * (w / 2 + 0.24);
    panel(g, face, surf, x, y, 0.28, h + 0.12, 0.07, 0.035, 'roofShingle');
    for (let k = 0; k < 4; k++) {
      panel(g, face, surf, x, y - h * 0.34 + k * (h * 0.22), 0.22, 0.035, 0.05, 0.08, 'wallWhite');
    }
  }
}

/** Door with an ink frame, a leaf and a knob. (u, y0) = bottom centre of the opening. */
function doorOn(
  g: THREE.Group, face: Face, surf: number, u: number, y0: number,
  w: number, h: number, leaf: Mat,
): void {
  panel(g, face, surf, u, y0 + (h + 0.12) / 2, w + 0.24, h + 0.12, 0.06, 0.03, 'ink');
  panel(g, face, surf, u, y0 + h / 2, w, h, 0.08, 0.06, leaf);
  const s = face[0] === '+' ? 1 : -1;
  const kx = face[1] === 'z' ? u + w * 0.32 : surf + s * 0.12;
  const kz = face[1] === 'z' ? surf + s * 0.12 : u + w * 0.32;
  sphere(g, 0.05, 'yellow', kx, y0 + h * 0.48, kz, 8);
}

/** Service mast: steel pole y0..y1 with a cross-arm; returns the insulator top (power port). */
function mast(g: THREE.Group, x: number, y0: number, z: number, y1: number): THREE.Vector3 {
  cyl(g, 0.07, 0.07, y1 - y0, 'steel', x, y0, z, 8);
  box(g, 1.2, 0.1, 0.1, 'steel', x, y1 - 0.1, z);
  return insulator(g, x, y1, z, 3);
}

/** Lot slab covering the cell minus the margin. */
function lotSlab(g: THREE.Group): void {
  box(g, LOT_H * 2, GROUND, LOT_H * 2, 'paving', 0, 0, 0);
}

/** Concrete path from (x, z0) to (x, z1). */
function path(g: THREE.Group, x: number, z0: number, z1: number, w = 1.2): void {
  box(g, w, 0.03, z1 - z0, 'concrete', x, GROUND, (z0 + z1) / 2);
}

/** Lawn patch, kept a hair below the paths. */
function lawn(g: THREE.Group, x0: number, z0: number, x1: number, z1: number): void {
  box(g, x1 - x0, 0.02, z1 - z0, 'grass', (x0 + x1) / 2, GROUND, (z0 + z1) / 2);
}

/** Small tree: wooden trunk with a round crown. */
function tree(g: THREE.Group, x: number, z: number, r = 0.8): void {
  cyl(g, 0.16, 0.2, 1.5, 'wood', x, GROUND, z, 8);
  sphere(g, r, 'green', x, GROUND + 1.5 + r * 0.6, z, 12);
}

function bush(g: THREE.Group, x: number, z: number, r = 0.55): void {
  sphere(g, r, 'green', x, GROUND + r * 0.9, z, 10);
}

/** Clipped hedge along an axis-aligned run, with rounded bumps on top. */
function hedge(
  g: THREE.Group, x0: number, z0: number, x1: number, z1: number, thick = 0.7, h = 0.9,
): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const L = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  box(g, alongX ? L : thick, h, alongX ? thick : L, 'green', cx, GROUND, cz);
  const n = Math.max(1, Math.round(L / 1.6));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n - 0.5;
    sphere(g, thick * 0.6, 'green', alongX ? cx + t * L : cx, GROUND + h, alongX ? cz : cz + t * L, 10);
  }
}

/** White picket-style fence along an axis-aligned run: posts every ~1.2 m plus two rails. */
function fence(g: THREE.Group, x0: number, z0: number, x1: number, z1: number): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const L = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const n = Math.max(2, Math.round(L / 1.2) + 1);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) - 0.5;
    box(g, 0.12, 1.0, 0.12, 'wallWhite', alongX ? cx + t * L : cx, GROUND, alongX ? cz : cz + t * L);
  }
  for (const y of [GROUND + 0.35, GROUND + 0.75]) {
    box(g, alongX ? L : 0.08, 0.1, alongX ? 0.08 : L, 'wallWhite', cx, y, cz);
  }
}

/** Mailbox on a post, with a little flag on the side. */
function mailbox(g: THREE.Group, x: number, z: number): void {
  cyl(g, 0.05, 0.05, 1.0, 'wood', x, GROUND, z, 6);
  box(g, 0.36, 0.26, 0.55, 'red', x, GROUND + 1.0, z);
  box(g, 0.04, 0.2, 0.04, 'yellow', x + 0.2, GROUND + 1.0, z + 0.22);
}

/** Tilted solar panel on a two-leg rack. Front edge (+Z) is the low side. */
function solarPanel(g: THREE.Group, x: number, z: number, base: number): void {
  const tilt = 0.35;
  const y = base + 0.7; // panel centre
  const p = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.05, 1.0), MAT.ink);
  p.position.set(x, y, z);
  p.rotation.x = tilt;
  g.add(p);
  const underFront = y - 0.4 * Math.sin(tilt) - 0.03;
  const underBack = y + 0.4 * Math.sin(tilt) - 0.03;
  cyl(g, 0.05, 0.05, underFront - base, 'steel', x, base, z + 0.4, 6);
  cyl(g, 0.05, 0.05, underBack - base, 'steel', x, base, z - 0.4, 6);
}

// ---- variant 0: gable cottage, one storey ------------------------------------

function cottage(g: THREE.Group, rnd: () => number): THREE.Vector3 {
  const wall = pickFrom<Mat>(rnd, ['wallCream', 'wallWhite', 'wallSage', 'wallBlueGray']);
  const roof = pickFrom<Mat>(rnd, ['roofShingle', 'roofInk', 'roofBlue']);
  const doorLeaf = pickFrom<Mat>(rnd, ['wood', 'blue', 'green', 'red']);
  const eave = T1;

  lotSlab(g);
  // plinth, walls (z -4..2), gable roof with ridge along X
  box(g, 7.3, FL - GROUND, 6.3, 'concrete', 0, GROUND, -1);
  box(g, 7, STOREY, 6, wall, 0, FL, -1);
  gableRoof(g, 7, 6, 2.4, roof, 0, eave, -1, 0.4);
  for (const [face, surf, a, b] of [['+z', 2, -3.4, 3.4], ['-z', -4, -3.4, 3.4], ['+x', 3.5, -4, 2], ['-x', -3.5, -4, 2]] as const) {
    clapboard(g, face, surf, a, b, FL, eave);
  }
  shingleCourses(g, 0, -1, eave, 3.4, 2.4, 7.5);
  // White corner boards, rake trim, fascia and the projecting Craftsman porch beam.
  for (const x of [-3.42, 3.42]) box(g, 0.18, STOREY, 0.12, 'wallWhite', x, FL, 2.04);
  box(g, 7.8, 0.18, 0.18, 'wallWhite', 0, eave - 0.12, 2.36);
  box(g, 7.8, 0.18, 0.18, 'wallWhite', 0, eave - 0.12, -4.36);

  // chimney on the back slope, rising above the ridge
  box(g, 0.8, 2.5, 0.8, 'concrete', 2.0, 4.3, -1.6);
  box(g, 1.0, 0.14, 1.0, 'ink', 2.0, 6.8, -1.6);

  // gutters under both eaves and downpipes on the front corners
  box(g, 7.7, 0.14, 0.16, 'steel', 0, eave - 0.2, 2.3);
  box(g, 7.7, 0.14, 0.16, 'steel', 0, eave - 0.2, -4.3);
  for (const x of [-3.3, 3.3]) cyl(g, 0.05, 0.05, eave - 0.2 - GROUND, 'steel', x, GROUND, 2.3, 8);

  // front porch: raised deck, two posts, flat roof, step down to the path
  box(g, 3.2, FL - GROUND, 1.8, 'wood', 0, GROUND, 2.9);
  box(g, 0.34, 2.63, 0.34, 'wallWhite', -1.5, FL, 3.6);
  box(g, 0.34, 2.63, 0.34, 'wallWhite', 1.5, FL, 3.6);
  box(g, 3.8, 0.18, 0.18, 'wallWhite', 0, 3.0, 4.05);
  box(g, 3.6, 0.18, 2.3, roof, 0, 3.05, 2.9);
  box(g, 1.6, 0.15, 0.45, 'concrete', 0, GROUND, 4.025);

  // door and windows
  doorOn(g, '+z', 2.0, 0, FL, 1.0, 2.1, doorLeaf);
  windowOn(g, '+z', 2.0, -2.1, FL + 1.5, 1.2, 1.2);
  windowOn(g, '+z', 2.0, 2.1, FL + 1.5, 1.2, 1.2);
  shutters(g, '+z', 2.0, -2.1, FL + 1.5, 1.2, 1.2);
  shutters(g, '+z', 2.0, 2.1, FL + 1.5, 1.2, 1.2);
  windowOn(g, '+x', 3.5, -1.0, FL + 1.5, 1.2, 1.2);
  windowOn(g, '-x', -3.5, -1.0, FL + 1.5, 1.2, 1.2);

  // lot
  path(g, 0, 4.25, LOT_H);
  fence(g, -4.9, -5.0, -4.9, 0.5);
  mailbox(g, 1.3, 4.7);
  tree(g, 4.4, 3.8);
  bush(g, -2.3, 4.2);

  // service mast on the front roof slope, insulator near 7 m
  return mast(g, -2.4, 3.5, 2.2, 6.6);
}

// ---- variant 1: two-storey family house, hip roof ----------------------------

function familyHouse(g: THREE.Group, rnd: () => number): THREE.Vector3 {
  const wall = pickFrom<Mat>(rnd, ['wallWhite', 'wallCream', 'wallSage', 'wallBlueGray']);
  const roof = pickFrom<Mat>(rnd, ['roofShingle', 'roofBlue', 'roofInk']);
  const doorLeaf = pickFrom<Mat>(rnd, ['wood', 'red', 'ink', 'green']);

  lotSlab(g);
  box(g, 7.6, FL - GROUND, 6.6, 'concrete', 0, GROUND, -1.2); // plinth
  box(g, 7.4, 2 * STOREY, 6.4, wall, 0, FL, -1.2); // z -4.4..2.0
  for (const [face, surf, a, b] of [['+z', 2, -3.5, 3.5], ['-z', -4.4, -3.5, 3.5], ['+x', 3.7, -4.4, 2], ['-x', -3.7, -4.4, 2]] as const) {
    clapboard(g, face, surf, a, b, FL, TOP);
  }
  // string courses at the first-floor line, all round
  box(g, 7.6, 0.14, 0.12, 'concrete', 0, T1 - 0.07, 2.06);
  box(g, 7.6, 0.14, 0.12, 'concrete', 0, T1 - 0.07, -4.46);
  box(g, 0.12, 0.14, 6.6, 'concrete', -3.76, T1 - 0.07, -1.2);
  box(g, 0.12, 0.14, 6.6, 'concrete', 3.76, T1 - 0.07, -1.2);
  hipRoof(g, 8.0, 7.0, 2.6, roof, 0, TOP, -1.2);

  // ground floor front: door left of centre, windows either side of it
  doorOn(g, '+z', 2.0, -1.0, FL, 1.0, 2.1, doorLeaf);
  windowOn(g, '+z', 2.0, -2.9, FL + 1.5, 1.2, 1.2);
  windowOn(g, '+z', 2.0, 2.4, FL + 1.5, 1.2, 1.2);
  shutters(g, '+z', 2.0, -2.9, FL + 1.5, 1.2, 1.2);
  shutters(g, '+z', 2.0, 2.4, FL + 1.5, 1.2, 1.2);
  box(g, 1.6, FL - GROUND, 0.5, 'concrete', -1.0, GROUND, 2.25); // door step

  // first floor: balcony door centred, windows either side, balcony with railing on the front
  doorOn(g, '+z', 2.0, 0, T1, 1.0, 2.1, doorLeaf);
  windowOn(g, '+z', 2.0, -2.5, T1 + 1.5, 1.2, 1.2);
  windowOn(g, '+z', 2.0, 2.5, T1 + 1.5, 1.2, 1.2);
  shutters(g, '+z', 2.0, -2.5, T1 + 1.5, 1.2, 1.2);
  shutters(g, '+z', 2.0, 2.5, T1 + 1.5, 1.2, 1.2);
  box(g, 4.8, 0.2, 1.0, 'concrete', 0, T1 - 0.2, 2.5); // slab z 2..3
  box(g, 0.14, 0.3, 0.75, 'steelDark', -2.2, T1 - 0.5, 2.4); // corbels
  box(g, 0.14, 0.3, 0.75, 'steelDark', 2.2, T1 - 0.5, 2.4);
  railing(g, { x: -2.4, y: T1, z: 2.95 }, { x: 2.4, y: T1, z: 2.95 }, 1.0, 'ink');

  // side (+X): garage door at ground level, windows above and beside it
  panel(g, '+x', 3.7, -0.9, FL + 1.1, 2.8, 2.4, 0.04, 0.02, 'ink'); // frame
  panel(g, '+x', 3.7, -0.9, FL + 1.1, 2.6, 2.2, 0.08, 0.06, 'steel'); // door leaf
  for (let row = 0; row < 4; row++) {
    panel(g, '+x', 3.7, -0.9, FL + 0.45 + row * 0.48, 2.52, 0.045, 0.05, 0.11, 'steelDark');
  }
  for (const u of [-1.75, -1.18, -0.61]) {
    panel(g, '+x', 3.7, u, FL + 2.05, 0.42, 0.34, 0.05, 0.12, 'glow');
  }
  box(g, 1.5, 0.03, 2.6, 'concrete', 4.45, GROUND, -0.9); // driveway
  windowOn(g, '+x', 3.7, -3.0, T1 + 1.5, 1.2, 1.2, false);
  windowOn(g, '+x', 3.7, 1.2, FL + 1.5, 1.0, 1.2, false);

  // side (-X): ground window, first-floor windows, wall-mounted AC unit
  windowOn(g, '-x', -3.7, -2.5, FL + 1.5, 1.2, 1.2);
  windowOn(g, '-x', -3.7, -2.5, T1 + 1.5, 1.2, 1.2, false);
  windowOn(g, '-x', -3.7, 0.4, T1 + 1.5, 1.2, 1.2, false);
  panel(g, '-x', -3.7, 0.4, FL + 1.17, 0.9, 0.06, 0.5, 0.25, 'steel'); // bracket shelf
  panel(g, '-x', -3.7, 0.4, FL + 1.5, 0.9, 0.6, 0.55, 0.275, 'wallWhite'); // unit
  panel(g, '-x', -3.7, 0.4, FL + 1.5, 0.7, 0.45, 0.04, 0.57, 'ink'); // grille

  // lot
  path(g, -1.0, 2.5, LOT_H);
  hedge(g, -4.8, 4.75, -2.0, 4.75, 0.6, 0.9);
  mailbox(g, 0.4, 4.2);
  tree(g, 4.4, 3.8);
  bush(g, 2.6, 4.4);

  // wall bracket on the front, service mast above the eave
  box(g, 0.12, 0.12, 0.6, 'steel', -3.0, 6.3, 2.3);
  return mast(g, -3.0, 6.3, 2.5, 6.9);
}

// ---- variant 2: flat-roof modern box, offset upper volume --------------------

function modernBox(g: THREE.Group, rnd: () => number): THREE.Vector3 {
  const wall = pickFrom<Mat>(rnd, ['wallWhite', 'wallCream', 'wallBlue', 'wallTeal']);
  const roof = pickFrom<Mat>(rnd, ['roofInk', 'roofCoral', 'roofBlue', 'roofGreen']);
  const doorLeaf = pickFrom<Mat>(rnd, ['wood', 'ink', 'red', 'yellow']);
  const PAR = T1 + 0.6; // lower parapet top

  lotSlab(g);
  box(g, 8.2, FL - GROUND, 6.4, 'concrete', 0, GROUND, -0.7); // plinth
  box(g, 8.0, STOREY, 6.2, wall, 0, FL, -0.7); // lower volume x ±4, z -3.8..2.4
  box(g, 6.0, STOREY, 4.4, wall, 1.0, T1, -1.6); // upper volume, pushed back and right

  // parapets on the exposed lower roof and around the upper roof
  box(g, 8.0, 0.6, 0.25, roof, 0, T1, 2.275);
  box(g, 0.25, 0.6, 6.2, roof, -3.875, T1, -0.7);
  box(g, 2.0, 0.6, 0.25, roof, -3.0, T1, -3.675);
  box(g, 0.25, 0.6, 1.8, roof, 3.875, T1, 1.5);
  box(g, 6.0, 0.6, 0.25, roof, 1.0, TOP, 0.475);
  box(g, 6.0, 0.6, 0.25, roof, 1.0, TOP, -3.675);
  box(g, 0.25, 0.6, 4.4, roof, -1.875, TOP, -1.6);
  box(g, 0.25, 0.6, 4.4, roof, 3.875, TOP, -1.6);

  // rooftop solar on the upper roof, and a water tank on a stand
  for (const x of [-1.0, 1.0, 3.0]) solarPanel(g, x, -0.8, TOP);
  const tx = -0.7;
  const tz = -2.7;
  for (const [dx, dz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
    cyl(g, 0.06, 0.06, 0.58, 'steel', tx + dx, TOP, tz + dz, 6);
  }
  box(g, 2.0, 0.1, 2.0, 'steelDark', tx, TOP + 0.58, tz); // stand platform
  cyl(g, 0.9, 0.9, 1.7, 'water', tx, TOP + 0.68, tz, 16); // tank
  ladder(g, tx, tz + 1.15, TOP, TOP + 0.58, '+z', 'ink');

  // external stair: stepped blocks from the ground up to a landing at first-floor level
  const N = 11;
  const rise = (T1 - GROUND) / N;
  const run = 0.27;
  for (let k = 0; k < N; k++) {
    const top = GROUND + rise * (k + 1);
    const x0 = 2.0 - run * (N - k);
    box(g, run, top - GROUND, 1.2, 'concrete', x0 + run / 2, GROUND, 3.05);
  }
  box(g, 2.0, 0.15, 1.3, 'concrete', 3.0, T1 - 0.15, 3.05); // landing
  cyl(g, 0.08, 0.08, T1 - 0.15 - GROUND, 'steel', 2.3, GROUND, 3.4, 8);
  cyl(g, 0.08, 0.08, T1 - 0.15 - GROUND, 'steel', 3.7, GROUND, 3.4, 8);
  railing(g, { x: 2.0, y: T1, z: 3.6 }, { x: -0.97, y: GROUND + rise, z: 3.6 }, 0.95, 'ink');

  // front: entrance on a stoop, one window beside the stair
  doorOn(g, '+z', 2.4, -2.6, FL, 1.1, 2.2, doorLeaf);
  box(g, 1.6, FL - GROUND, 0.5, 'concrete', -2.6, GROUND, 2.65);
  windowOn(g, '+z', 2.4, 3.0, FL + 1.5, 1.0, 1.2);

  // sides
  windowOn(g, '-x', -4.0, -1.6, FL + 1.5, 1.6, 1.2, false);
  windowOn(g, '-x', -4.0, 1.0, FL + 1.5, 1.2, 1.2, false);
  windowOn(g, '+x', 4.0, 1.5, FL + 1.5, 1.0, 1.2, false);
  windowOn(g, '-x', -2.0, -1.5, T1 + 1.5, 1.2, 1.2, false);
  windowOn(g, '+x', 4.0, -1.5, T1 + 1.5, 1.2, 1.2, false);
  windowOn(g, '+z', 0.6, -0.5, T1 + 1.5, 1.4, 1.4, false);
  windowOn(g, '+z', 0.6, 2.5, T1 + 1.5, 1.4, 1.4, false);

  // lot
  path(g, -2.6, 2.9, LOT_H);
  mailbox(g, -0.6, 4.4);
  tree(g, -4.4, 4.2, 0.7);
  bush(g, 1.4, 4.6);
  hedge(g, 4.9, -4.0, 4.9, 4.6, 0.5, 0.9);

  // service mast on the lower parapet, insulator near 7 m
  return mast(g, -2.8, PAR, 2.27, 6.6);
}

// ---- variant 3: narrow two-storey townhouse pair ------------------------------

/** One unit of the pair. side = -1 (left) or +1 (right) of the shared party wall at x = 0. */
function townUnit(g: THREE.Group, side: -1 | 1, leaf: Mat, canopy: Mat): void {
  const s = side;
  // door and stoop on the unit's outer half, ground window toward the party wall
  doorOn(g, '+z', 2.0, s * 2.4, FL, 1.0, 2.1, leaf);
  box(g, 1.4, FL - GROUND, 0.6, 'concrete', s * 2.4, GROUND, 2.3);
  box(g, 1.6, 0.12, 0.8, canopy, s * 2.4, 2.7, 2.4);
  windowOn(g, '+z', 2.0, s * 0.9, FL + 1.5, 1.0, 1.2, true);
  windowOn(g, '+z', 2.0, s * 2.4, T1 + 1.5, 1.0, 1.2, false);
  windowOn(g, '+z', 2.0, s * 0.9, T1 + 1.5, 1.0, 1.2, false);
  windowOn(g, s < 0 ? '-x' : '+x', s * 3.6, -2.0, T1 + 1.5, 1.2, 1.2, false);
  path(g, s * 2.4, 2.6, LOT_H, 1.0);
}

function townhouses(g: THREE.Group, rnd: () => number): THREE.Vector3 {
  const PAIRS: ReadonlyArray<readonly [Mat, Mat]> = [
    ['wallSage', 'wallCream'],
    ['wallBlueGray', 'wallWhite'],
    ['wallSand', 'wallSage'],
    ['wallCream', 'wallBlueGray'],
  ];
  const pair = pickFrom<readonly [Mat, Mat]>(rnd, PAIRS);
  const ROOFS: Mat[] = ['roofShingle', 'roofBlue', 'roofInk'];
  const roofA = pickFrom<Mat>(rnd, ROOFS);
  const roofB = pickFrom<Mat>(rnd, ROOFS.filter((r) => r !== roofA));
  const doorA = pickFrom<Mat>(rnd, ['wood', 'red', 'ink', 'green']);
  const doorB = pickFrom<Mat>(rnd, ['wood', 'red', 'ink', 'green']);

  lotSlab(g);
  // front gardens
  lawn(g, -4.8, 2.0, -0.3, 4.4);
  lawn(g, 0.3, 2.0, 4.8, 4.4);

  // plinth, two units sharing a party wall at x = 0
  box(g, 7.5, FL - GROUND, 6.6, 'concrete', 0, GROUND, -1.2);
  box(g, 3.6, 2 * STOREY, 6.4, pair[0], -1.8, FL, -1.2);
  box(g, 3.6, 2 * STOREY, 6.4, pair[1], 1.8, FL, -1.2);
  clapboard(g, '+z', 2.0, -3.5, 3.5, FL, TOP);
  clapboard(g, '-z', -4.4, -3.5, 3.5, FL, TOP);
  clapboard(g, '+x', 3.6, -4.4, 2.0, FL, TOP);
  clapboard(g, '-x', -3.6, -4.4, 2.0, FL, TOP);
  // one gable roof per unit, ridge along Z (built along X, then turned 90 degrees)
  for (const [cx, rm] of [[-1.8, roofA], [1.8, roofB]] as const) {
    const r = gableRoof(g, 6.4, 3.6, 2.2, rm, cx, TOP, -1.2, 0.3);
    r.rotation.y = Math.PI / 2;
  }
  // front trim line marking the party wall
  box(g, 0.14, 2 * STOREY, 0.12, 'ink', 0, FL, 2.06);

  // one chimney per unit
  for (const x of [-2.6, 2.6]) {
    box(g, 0.7, 2.6, 0.7, 'concrete', x, 7.0, -3.0);
    box(g, 0.9, 0.14, 0.9, 'ink', x, 9.6, -3.0);
  }
  // gutters under the two long eaves
  box(g, 0.16, 0.14, 7.0, 'steel', -3.85, TOP - 0.2, -1.2);
  box(g, 0.16, 0.14, 7.0, 'steel', 3.85, TOP - 0.2, -1.2);

  townUnit(g, -1, doorA, roofA);
  townUnit(g, 1, doorB, roofB);

  // hedges: front line with gaps for the paths, party-line divider, side boundaries
  hedge(g, -4.9, 4.75, -3.0, 4.75, 0.7, 0.9);
  hedge(g, -1.8, 4.75, 1.8, 4.75, 0.7, 0.9);
  hedge(g, 3.0, 4.75, 4.9, 4.75, 0.7, 0.9);
  hedge(g, 0, 2.2, 0, 4.4, 0.5, 0.8);
  hedge(g, -4.9, -2.0, -4.9, 4.4, 0.5, 0.9);
  hedge(g, 4.9, -2.0, 4.9, 4.4, 0.5, 0.9);

  // lot extras
  mailbox(g, -3.8, 3.4);
  tree(g, 4.5, -3.6, 0.7);
  bush(g, -4.4, -4.4, 0.5);

  // service mast on the front gable, bracketed off the wall
  box(g, 0.12, 0.12, 0.6, 'steel', -2.0, 6.2, 2.3);
  return mast(g, -2.0, 6.2, 2.5, 6.9);
}

// ---- variant 4: American brick walk-up apartment -----------------------------

/** Compact four-storey masonry walk-up used to give the inner districts a real skyline. */
function walkUp(g: THREE.Group): THREE.Vector3 {
  const x0 = -4.6;
  const zf = 4.5;
  const floors = 4;
  const floorH = 2.8;
  const wallY = 0.55;
  const wallH = floors * floorH;

  lotSlab(g);
  box(g, 9.4, 0.42, 9.4, 'concrete', 0, GROUND, -0.1); // raised masonry plinth
  box(g, 9.0, wallH, 8.9, 'brick', 0, wallY, -0.1);

  // Stone water table and restrained floor bands make the masonry read at city scale.
  box(g, 9.18, 0.28, 0.12, 'concrete', 0, wallY + 0.15, zf + 0.07);
  box(g, 9.18, 0.16, 0.12, 'wallSand', 0, wallY + floorH - 0.08, zf + 0.07);
  for (let floor = 2; floor < floors; floor++) {
    box(g, 9.18, 0.12, 0.12, 'wallSand', 0, wallY + floor * floorH - 0.06, zf + 0.07);
  }

  // Repeated double-hung windows with stone sills and lintels; a clear entrance bay.
  const rows = [1, 2, 3, 4];
  const cols = [-2.9, 0, 2.9];
  for (const floor of rows) {
    for (const x of cols) {
      if (floor === 1 && x === 0) continue;
      const y = wallY + (floor - 1) * floorH + 1.05;
      windowOn(g, '+z', zf, x, y, 1.15, 1.35, true);
      box(g, 1.45, 0.12, 0.2, 'wallSand', x, y - 0.84, zf + 0.14);
      box(g, 1.42, 0.12, 0.16, 'wallSand', x, y + 0.77, zf + 0.12);
    }
  }
  for (const x of [-1.05, 1.05]) {
    doorOn(g, '+z', zf, x, wallY, 0.9, 2.25, 'roofShingle');
    box(g, 1.5, 0.22, 0.8, 'concrete', x, GROUND + 0.36, zf + 0.55);
    box(g, 1.1, 0.12, 0.3, 'wallWhite', x, wallY + 2.3, zf + 0.4); // shallow entry hood
  }

  // Side elevations keep the building convincing from all four camera directions.
  for (const face of ['+x', '-x'] as const) {
    const surf = face === '+x' ? 4.5 : -4.5;
    for (const floor of rows) {
      const y = wallY + (floor - 1) * floorH + 1.05;
      for (const z of [-2.4, 0.4, 3.1]) windowOn(g, face, surf, z, y, 1.0, 1.25, true);
    }
  }

  // Roof cornice, parapet cap, stair bulkhead and screened mechanical equipment.
  box(g, 9.5, 0.28, 0.25, 'wallWhite', 0, wallY + wallH, zf + 0.02);
  box(g, 9.5, 0.35, 0.25, 'wallSand', 0, wallY + wallH + 0.28, zf + 0.02);
  box(g, 9.25, 0.12, 9.15, 'roofShingle', 0, wallY + wallH + 0.63, -0.1);
  box(g, 2.8, 1.5, 2.4, 'wallSage', -2.6, wallY + wallH + 0.75, -1.2);
  box(g, 3.2, 0.18, 2.8, 'roofInk', -2.6, wallY + wallH + 2.25, -1.2);
  for (const x of [-3.4, 3.4]) {
    box(g, 0.7, 0.8, 0.7, 'steel', x, wallY + wallH + 0.75, -2.4);
    box(g, 0.84, 0.1, 0.84, 'steelDark', x, wallY + wallH + 1.55, -2.4);
  }

  // Rear fire escape: stacked landings and ladders belong to the real building, not decoration.
  for (let floor = 1; floor < floors; floor++) {
    const y = wallY + floor * floorH;
    box(g, 2.3, 0.12, 1.1, 'steelDark', 2.5, y, -4.82);
    railing(g, { x: 1.45, y: y + 0.12, z: -5.25 }, { x: 3.55, y: y + 0.12, z: -5.25 }, 0.82, 'steelDark');
    for (const x of [1.65, 3.35]) cyl(g, 0.045, 0.045, floorH - 0.15, 'steelDark', x, y - floorH + 0.12, -5.25, 6);
  }
  for (let floor = 1; floor < floors - 1; floor++) {
    const y = wallY + floor * floorH;
    for (let step = 0; step < 6; step++) {
      box(g, 0.75, 0.08, 0.28, 'steelDark', 2.5 - step * 0.18, y + step * 0.38, -5.25);
    }
  }

  path(g, 0, 4.5, LOT_H, 1.5);
  return mast(g, -3.7, wallY + wallH + 0.63, 3.9, wallY + wallH + 1.35);
}

// ---- entry point --------------------------------------------------------------

export const build: ModelBuilder = ({ variant, seed }) => {
  const g = new THREE.Group();
  const rnd = seeded(seed);
  const v = ((variant % VARIANTS) + VARIANTS) % VARIANTS;
  let port: THREE.Vector3;
  switch (v) {
    case 0:
      port = cottage(g, rnd);
      break;
    case 1:
      port = familyHouse(g, rnd);
      break;
    case 2:
      port = modernBox(g, rnd);
      break;
    case 3:
      port = townhouses(g, rnd);
      break;
    default:
      port = walkUp(g);
      break;
  }
  setPowerPorts(g, [port]);
  return g;
};
