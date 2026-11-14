import * as THREE from 'three';
import { MAT, type MatName } from '../render/palette';
import { box, cyl, insulator, railing, rod, setPowerPorts, sphere, windowGrid, type ModelBuilder } from './kit';

/**
 * City water supply: pumping station. Footprint 2×2 cells = 24×24 m, origin at the centre, front = +Z.
 *  - Variant 0: pump house with pipes, valves and pump motors, a round open clarifier basin and an
 *    elevated water tower on four legs with a catwalk, ladder and beacon.
 *  - Variant 1: no tower. A rectangular ground reservoir with two tall storage tanks (spiral stair
 *    on one, ladder on the other) and a treatment shed with a row of filter tanks.
 * Both share the fenced yard, gate and warning sign.
 */
export const VARIANTS = 2;

type V = { x: number; y: number; z: number };

/** Half-size of the fenced yard. Footprint is ±12 m, so this keeps a margin for the sign and fence. */
const YARD = 10.6;
/** Pump house centre (walls 6.4 × 4.8 m). */
const PH = { x: -4.5, z: 3.0 };
/** Elevated tower centre, and the round basin centre (variant 0). */
const TOWER = { x: 4.5, z: -4.0 };
const BASIN = { x: -6.0, z: -5.5 };
/** Catwalk floor top height under the tank (m). */
const CAT_Y = 12.05;

/** Generic mesh with any geometry, using a palette material (the kit has no torus, ring or rotated box). */
function mesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: MatName, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, MAT[mat]);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** Flat ring lying in the XZ plane at height y (open basin rim). */
function flatRing(parent: THREE.Object3D, r0: number, r1: number, y: number, mat: MatName, cx: number, cz: number) {
  const g = new THREE.RingGeometry(r0, r1, 16);
  g.rotateX(-Math.PI / 2);
  return mesh(parent, g, mat, cx, y, cz);
}

/** Pipe run through the given points: straight rods, with a ball at each bend. */
function pipeRun(parent: THREE.Object3D, pts: V[], r: number, mat: MatName): void {
  for (let i = 0; i < pts.length - 1; i++) rod(parent, pts[i], pts[i + 1], r, mat, 10);
  for (let i = 1; i < pts.length - 1; i++) sphere(parent, r * 1.05, mat, pts[i].x, pts[i].y, pts[i].z, 10);
}

/** Thin flange disc across a pipe at point p. axis = direction of the pipe. */
function flange(parent: THREE.Object3D, p: V, axis: 'x' | 'z', r: number): void {
  const d = axis === 'x' ? { x: 0.06, y: 0, z: 0 } : { x: 0, y: 0, z: 0.06 };
  rod(parent, { x: p.x - d.x, y: p.y, z: p.z - d.z }, { x: p.x + d.x, y: p.y, z: p.z + d.z }, r, 'steelDark', 12);
}

/** Gate valve on a pipe: body on the pipe axis, a stem, and a red handwheel on top. */
function gateValve(parent: THREE.Object3D, x: number, y: number, z: number, axis: 'x' | 'z', r: number): void {
  const body = new THREE.CylinderGeometry(r, r, 0.45, 12);
  if (axis === 'x') body.rotateZ(Math.PI / 2);
  else body.rotateX(Math.PI / 2);
  mesh(parent, body, 'steelDark', x, y, z);
  const top = y + r + 0.45;
  rod(parent, { x, y: y + r, z }, { x, y: top, z }, 0.05, 'steelDark', 6);
  const wheel = new THREE.TorusGeometry(0.28, 0.04, 6, 12);
  wheel.rotateX(Math.PI / 2);
  mesh(parent, wheel, 'red', x, top, z);
}

/** Pipe saddle on a small post: pipe centre at height y with radius r. */
function pipeSupport(parent: THREE.Object3D, x: number, y: number, z: number, r: number): void {
  const saddleY = y - r - 0.12;
  box(parent, 0.5, 0.1, 0.5, 'concrete', x, 0, z);
  rod(parent, { x, y: 0.1, z }, { x, y: saddleY, z }, 0.08, 'steelDark', 6);
  box(parent, 0.5, 0.12, 0.5, 'steelDark', x, saddleY, z);
}

/** Vertical ladder: two stiles and rungs. Stiles sit at ±0.25 m across 'x' or across 'z'. */
function ladderV(
  parent: THREE.Object3D,
  x: number,
  z: number,
  y0: number,
  y1: number,
  across: 'x' | 'z',
  pitch = 0.5,
): void {
  const ox = across === 'x' ? 0.25 : 0;
  const oz = across === 'z' ? 0.25 : 0;
  const a = { x: x - ox, z: z - oz };
  const b = { x: x + ox, z: z + oz };
  rod(parent, { x: a.x, y: y0, z: a.z }, { x: a.x, y: y1, z: a.z }, 0.04, 'ink', 5);
  rod(parent, { x: b.x, y: y0, z: b.z }, { x: b.x, y: y1, z: b.z }, 0.04, 'ink', 5);
  for (let y = y0 + pitch; y < y1; y += pitch) {
    rod(parent, { x: a.x, y, z: a.z }, { x: b.x, y, z: b.z }, 0.03, 'ink', 4);
  }
}

/** Polygonal guard rail around a vertical axis. `gaps` lists segment indices left open (ladder, stair). */
function ringRail(
  parent: THREE.Object3D,
  cx: number,
  y: number,
  cz: number,
  r: number,
  n: number,
  h: number,
  gaps: number[],
): void {
  const pts: V[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y, z: cz + r * Math.sin(a) });
  }
  for (const p of pts) rod(parent, p, { x: p.x, y: p.y + h, z: p.z }, 0.05, 'ink', 5);
  for (let k = 0; k < n; k++) {
    if (gaps.includes(k)) continue;
    const a = pts[k];
    const b = pts[(k + 1) % n];
    rod(parent, { x: a.x, y: a.y + h, z: a.z }, { x: b.x, y: b.y + h, z: b.z }, 0.06, 'ink', 5);
    rod(parent, { x: a.x, y: a.y + h * 0.5, z: a.z }, { x: b.x, y: b.y + h * 0.5, z: b.z }, 0.04, 'ink', 5);
  }
}

/* ------------------------------------------------------------------ yard */

/** Paving slab, chain-link fence (posts + rails), gate, and the warning sign. */
function yardAndFence(g: THREE.Group): void {
  box(g, YARD * 2, 0.12, YARD * 2, 'paving', 0, 0, 0);

  const N = 7;
  const t = (i: number) => -YARD + (2 * YARD * i) / N;
  const post = (x: number, z: number, h = 2.0, r = 0.05) => rod(g, { x, y: 0, z }, { x, y: h, z }, r, 'steel', 5);
  // back and front rows include both corners; side rows skip the corners
  for (let i = 0; i <= N; i++) {
    post(t(i), -YARD);
    post(t(i), YARD);
  }
  for (let i = 1; i < N; i++) {
    post(-YARD, t(i));
    post(YARD, t(i));
  }
  const rails = (x0: number, z0: number, x1: number, z1: number) => {
    rod(g, { x: x0, y: 2.0, z: z0 }, { x: x1, y: 2.0, z: z1 }, 0.05, 'steel', 5);
    rod(g, { x: x0, y: 1.0, z: z0 }, { x: x1, y: 1.0, z: z1 }, 0.035, 'steel', 5);
  };
  rails(-YARD, -YARD, YARD, -YARD); // back
  rails(-YARD, -YARD, -YARD, YARD); // left
  rails(YARD, -YARD, YARD, YARD); // right
  const gx = t(3); // gate half-width (opening is 2 × gx)
  rails(-YARD, YARD, -gx, YARD); // front, left of gate
  rails(gx, YARD, YARD, YARD); // front, right of gate

  // gate: heavier jambs, two closed leaves with a brace and a padlock
  rod(g, { x: -gx, y: 0, z: YARD }, { x: -gx, y: 2.3, z: YARD }, 0.07, 'steelDark', 6);
  rod(g, { x: gx, y: 0, z: YARD }, { x: gx, y: 2.3, z: YARD }, 0.07, 'steelDark', 6);
  rod(g, { x: -gx, y: 2.0, z: YARD }, { x: gx, y: 2.0, z: YARD }, 0.05, 'steelDark', 5);
  rod(g, { x: -gx, y: 0.3, z: YARD }, { x: gx, y: 0.3, z: YARD }, 0.05, 'steelDark', 5);
  rod(g, { x: -gx, y: 0.3, z: YARD }, { x: gx, y: 2.0, z: YARD }, 0.04, 'steelDark', 5);
  box(g, 0.2, 0.25, 0.12, 'yellow', 0, 1.1, YARD + 0.06);

  // warning sign just outside the fence, on its own post
  const sx = 4.0;
  const sz = 10.9;
  rod(g, { x: sx, y: 0, z: sz }, { x: sx, y: 2.2, z: sz }, 0.05, 'steel', 6);
  box(g, 0.9, 0.7, 0.06, 'yellow', sx, 1.5, sz + 0.03);
  box(g, 0.9, 0.14, 0.03, 'red', sx, 1.7, sz + 0.07);
}

/* ---------------------------------------------------------- variant 0 */

/** Single-storey pump house with glow windows, door, roof vents and a power mast. Returns the power port. */
function pumpHouse(g: THREE.Group): V {
  const { x, z } = PH;
  box(g, 6.8, 0.3, 5.2, 'concrete', x, 0, z); // plinth 0–0.3
  box(g, 6.4, 3.3, 4.8, 'wallSand', x, 0.3, z); // walls 0.3–3.6
  box(g, 6.6, 0.25, 5.0, 'roofInk', x, 3.6, z); // roof slab 3.6–3.85

  // door with step, frame and lintel on the front (+Z) face
  const fz = z + 2.4;
  box(g, 1.5, 0.3, 0.7, 'concrete', x, 0, fz + 0.55);
  box(g, 1.1, 2.1, 0.12, 'wood', x, 0.3, fz + 0.06);
  box(g, 1.34, 0.14, 0.16, 'ink', x, 2.4, fz + 0.06);
  box(g, 0.12, 2.1, 0.16, 'ink', x - 0.62, 0.3, fz + 0.06);
  box(g, 0.12, 2.1, 0.16, 'ink', x + 0.62, 0.3, fz + 0.06);

  // glow windows: two on the front (door between), two on the west side
  windowGrid(g, {
    face: '+z',
    cx: x,
    cz: z,
    hw: 3.2,
    hd: 2.4,
    rows: 1,
    cols: 3,
    y0: 1.4,
    pitchY: 1,
    winW: 0.9,
    winH: 1.0,
    frames: true,
    skip: (_r, c) => c === 1,
  });
  windowGrid(g, { face: '-x', cx: x, cz: z, hw: 3.2, hd: 2.4, rows: 1, cols: 2, y0: 1.4, pitchY: 1, winW: 0.9, winH: 1.0, frames: true });

  // roof vents
  for (const [vx, vz] of [
    [-6.0, 1.8],
    [-3.0, 4.4],
  ]) {
    cyl(g, 0.3, 0.36, 0.55, 'steelDark', vx, 3.85, vz, 10);
    cyl(g, 0.42, 0.42, 0.08, 'steelDark', vx, 4.4, vz, 10);
  }

  // power mast on the roof with a bracket arm out over the front; insulator at the end
  const mx = -2.3;
  const mz = 4.6;
  rod(g, { x: mx, y: 3.85, z: mz }, { x: mx, y: 5.8, z: mz }, 0.07, 'steel', 6);
  rod(g, { x: mx, y: 5.8, z: mz }, { x: mx, y: 5.8, z: 6.0 }, 0.06, 'steel', 6);
  const top = insulator(g, mx, 5.8, 6.0, 3);
  return { x: top.x, y: top.y, z: top.z };
}

/** Pump motors on plinths beside the pump house, plus the control cabinet with indicator lamps. */
function pumpYard(g: THREE.Group): void {
  for (const z of [1.6, 4.6]) {
    box(g, 1.8, 0.3, 1.6, 'concrete', -9.1, 0, z); // plinth
    box(g, 1.4, 0.8, 1.0, 'steelDark', -9.1, 0.3, z); // motor housing
    rod(g, { x: -9.8, y: 1.1, z }, { x: -8.4, y: 1.1, z }, 0.36, 'steelDark', 12); // drive cylinder
    box(g, 0.3, 0.6, 0.6, 'blue', -8.25, 0.4, z); // pump casing
    rod(g, { x: -8.1, y: 0.7, z }, { x: -7.6, y: 0.7, z }, 0.12, 'blue', 6); // suction pipe into the house
  }
  box(g, 1.1, 0.2, 0.7, 'concrete', -9.0, 0, 7.0);
  box(g, 0.9, 1.9, 0.5, 'wallCream', -9.0, 0.2, 7.0);
  box(g, 0.95, 0.08, 0.55, 'steelDark', -9.0, 2.1, 7.0);
  for (const lx of [-9.3, -9.0, -8.7]) box(g, 0.14, 0.14, 0.05, 'glow', lx, 1.6, 7.27);
}

/** Main feed (pump house → tower riser) and a second line (pump house → basin), with valves and supports. */
function feedPipes(g: THREE.Group): void {
  const y = 1.1;
  const wallX = PH.x + 3.2; // east wall face
  const start: V = { x: wallX - 0.2, y, z: 1.6 };
  pipeRun(g, [start, { x: TOWER.x, y, z: 1.6 }, { x: TOWER.x, y, z: TOWER.z + 0.4 }], 0.4, 'blue');
  flange(g, { x: wallX, y, z: 1.6 }, 'x', 0.52);
  gateValve(g, 1.0, y, 1.6, 'x', 0.55);
  pipeSupport(g, -0.4, y, 1.6, 0.4);
  pipeSupport(g, 2.4, y, 1.6, 0.4);
  pipeSupport(g, TOWER.x, y, -2.6, 0.4);

  const y2 = 0.9;
  const backZ = PH.z - 2.4;
  pipeRun(g, [{ x: -5.0, y: y2, z: backZ + 0.1 }, { x: -5.0, y: y2, z: BASIN.z + 3.4 }], 0.28, 'steelDark');
  flange(g, { x: -5.0, y: y2, z: backZ }, 'z', 0.4);
  gateValve(g, -5.0, y2, -0.8, 'z', 0.42);
  pipeSupport(g, -5.0, y2, -1.6, 0.28);
}

/** Round open clarifier: 1 m ring wall, water inside, walkway with rails across the top. */
function roundBasin(g: THREE.Group, cx: number, cz: number): void {
  mesh(g, new THREE.CylinderGeometry(3.4, 3.4, 1.0, 16, 1, true), 'concrete', cx, 0.5, cz);
  flatRing(g, 3.2, 3.4, 1.0, 'concrete', cx, cz);
  cyl(g, 3.2, 3.2, 0.05, 'concrete', cx, 0, cz, 16);
  cyl(g, 3.2, 3.2, 0.67, 'water', cx, 0.05, cz, 16);
  box(g, 6.8, 0.12, 0.7, 'steel', cx, 1.0, cz);
  railing(g, { x: cx - 3.2, y: 1.12, z: cz - 0.35 }, { x: cx + 3.2, y: 1.12, z: cz - 0.35 }, 1.0);
  railing(g, { x: cx - 3.2, y: 1.12, z: cz + 0.35 }, { x: cx + 3.2, y: 1.12, z: cz + 0.35 }, 1.0);
}

/** Elevated water tower: four legs with cross bracing, catwalk with rail, ladder, tank and beacon. */
function elevatedTower(g: THREE.Group, cx: number, cz: number): void {
  const L = 2.2;
  const corners: [number, number][] = [
    [-L, -L],
    [L, -L],
    [L, L],
    [-L, L],
  ];
  const leg = (i: number, y: number): V => ({ x: cx + corners[i][0], y, z: cz + corners[i][1] });

  for (let i = 0; i < 4; i++) {
    const p = leg(i, 0);
    box(g, 0.9, 0.3, 0.9, 'concrete', p.x, 0, p.z);
    rod(g, leg(i, 0.3), leg(i, 11.9), 0.18, 'steel', 8);
  }
  // horizontal ring braces at two levels, X braces on the three faces without the ladder
  for (const y of [4.0, 8.0]) for (let i = 0; i < 4; i++) rod(g, leg(i, y), leg((i + 1) % 4, y), 0.06, 'steelDark', 5);
  for (const [a, b] of [
    [0, 3],
    [1, 2],
    [0, 1],
  ]) {
    for (const [y0, y1] of [
      [0.3, 4],
      [4, 8],
      [8, 11.9],
    ]) {
      rod(g, leg(a, y0), leg(b, y1), 0.05, 'steelDark', 5);
      rod(g, leg(b, y0), leg(a, y1), 0.05, 'steelDark', 5);
    }
  }

  // catwalk floor with a guard rail, open where the ladder arrives (segment 4 = 120°–150°)
  cyl(g, 3.9, 3.9, 0.15, 'steel', cx, 11.9, cz, 16);
  ringRail(g, cx, CAT_Y, cz, 3.7, 12, 1.0, [4]);

  // ladder up the front-left leg, standing against the leg
  ladderV(g, cx - L, cz + L + 0.22, 0, CAT_Y, 'x', 0.5);

  // riser pipe, saddle ring, tank with white band, conical roof and beacon
  rod(g, { x: cx, y: 0, z: cz }, { x: cx, y: 12.55, z: cz }, 0.3, 'steelDark', 8);
  cyl(g, 0.5, 0.5, 0.15, 'steelDark', cx, 0, cz, 10);
  cyl(g, 2.6, 2.6, 0.5, 'steelDark', cx, CAT_Y, cz, 12);
  cyl(g, 3.2, 3.2, 5.2, 'water', cx, 12.55, cz, 16);
  cyl(g, 3.25, 3.25, 0.5, 'wallWhite', cx, 15.0, cz, 16);
  cyl(g, 0.35, 3.2, 1.8, 'roofBlue', cx, 17.75, cz, 16);
  rod(g, { x: cx, y: 19.55, z: cz }, { x: cx, y: 19.9, z: cz }, 0.05, 'steelDark', 5);
  sphere(g, 0.2, 'beacon', cx, 20.1, cz, 10);
}

function towerSite(g: THREE.Group): V {
  const port = pumpHouse(g);
  pumpYard(g);
  feedPipes(g);
  roundBasin(g, BASIN.x, BASIN.z);
  elevatedTower(g, TOWER.x, TOWER.z);
  return port;
}

/* ---------------------------------------------------------- variant 1 */

/** Rectangular ground reservoir: 1 m concrete walls, water inside, walkway across the top with rails. */
function groundReservoir(g: THREE.Group, cx: number, cz: number): void {
  box(g, 0.4, 1.0, 4.8, 'concrete', cx - 4.6, 0, cz);
  box(g, 0.4, 1.0, 4.8, 'concrete', cx + 4.6, 0, cz);
  box(g, 9.6, 1.0, 0.4, 'concrete', cx, 0, cz - 2.4);
  box(g, 9.6, 1.0, 0.4, 'concrete', cx, 0, cz + 2.4);
  box(g, 8.8, 0.05, 4.0, 'concrete', cx, 0, cz);
  box(g, 8.8, 0.7, 4.0, 'water', cx, 0.05, cz);
  box(g, 9.6, 0.12, 0.8, 'steel', cx, 1.0, cz);
  railing(g, { x: cx - 4.6, y: 1.12, z: cz - 0.4 }, { x: cx + 4.6, y: 1.12, z: cz - 0.4 }, 1.0);
  railing(g, { x: cx - 4.6, y: 1.12, z: cz + 0.4 }, { x: cx + 4.6, y: 1.12, z: cz + 0.4 }, 1.0);
}

/** Tall storage tank: cream body, blue band, dark conical roof. */
function storageTank(g: THREE.Group, cx: number, cz: number, R: number, H: number): void {
  cyl(g, R, R, H, 'wallCream', cx, 0, cz, 16);
  cyl(g, R + 0.03, R + 0.03, 0.6, 'water', cx, 6.5, cz, 16);
  cyl(g, 0.35, R, 1.2, 'roofInk', cx, H, cz, 16);
}

/**
 * Spiral external stair wrapped round a tank: 20 treads, each attached to the tank wall, with a
 * handrail on posts at the outer edge and a landing slab on top of the tank.
 */
function spiralStair(g: THREE.Group, cx: number, cz: number, R: number, n = 20): void {
  const rc = R + 0.45; // tread centre radius (tread spans R-0.05 … R+0.95)
  const rp = R + 0.9; // handrail post radius
  const rise = 0.5;
  let prev: V | null = null;
  for (let i = 0; i < n; i++) {
    const th = Math.PI / 2 + (i * Math.PI * 2) / n;
    const top = i * rise;
    const tread = mesh(g, new THREE.BoxGeometry(1.0, 0.1, 0.8), 'steel', cx + rc * Math.cos(th), top - 0.05, cz + rc * Math.sin(th));
    tread.rotation.y = -th; // local +X points radially outward
    const p: V = { x: cx + rp * Math.cos(th), y: top, z: cz + rp * Math.sin(th) };
    rod(g, p, { x: p.x, y: top + 1.0, z: p.z }, 0.04, 'ink', 5);
    if (prev) rod(g, { x: prev.x, y: prev.y + 1.0, z: prev.z }, { x: p.x, y: p.y + 1.0, z: p.z }, 0.04, 'ink', 5);
    prev = p;
  }
  cyl(g, R + 1.0, R + 1.0, 0.5, 'steel', cx, 9.5, cz, 20);
}

/** Treatment shed: concrete plinth, cream walls, glow windows, door, roof vents and a power mast. */
function treatmentShed(g: THREE.Group): V {
  const cx = 0;
  const cz = 5.0;
  box(g, 9.4, 0.3, 6.0, 'concrete', cx, 0, cz); // plinth 0–0.3
  box(g, 9.0, 3.6, 5.6, 'wallCream', cx, 0.3, cz); // walls 0.3–3.9
  box(g, 9.2, 0.25, 5.8, 'roofInk', cx, 3.9, cz); // roof 3.9–4.15

  windowGrid(g, {
    face: '+z',
    cx,
    cz,
    hw: 4.5,
    hd: 2.8,
    rows: 1,
    cols: 4,
    y0: 1.5,
    pitchY: 1,
    winW: 0.9,
    winH: 1.2,
    frames: true,
    skip: (_r, c) => c === 1 || c === 2,
  });
  windowGrid(g, { face: '-x', cx, cz, hw: 4.5, hd: 2.8, rows: 1, cols: 2, y0: 1.5, pitchY: 1, winW: 0.9, winH: 1.2, frames: true });
  windowGrid(g, { face: '+x', cx, cz, hw: 4.5, hd: 2.8, rows: 1, cols: 2, y0: 1.5, pitchY: 1, winW: 0.9, winH: 1.2, frames: true });

  // door with step, lintel and frame
  box(g, 1.2, 2.1, 0.12, 'wood', cx, 0.3, 7.86);
  box(g, 1.4, 0.15, 0.16, 'ink', cx, 2.4, 7.88);
  box(g, 1.6, 0.3, 0.7, 'concrete', cx, 0, 8.35);

  // roof vents and hatch
  for (const [vx, vz] of [
    [-2.5, 6.0],
    [2.5, 6.0],
  ]) {
    cyl(g, 0.3, 0.36, 0.55, 'steelDark', vx, 4.15, vz, 10);
    cyl(g, 0.42, 0.42, 0.08, 'steelDark', vx, 4.7, vz, 10);
  }
  box(g, 1.0, 0.12, 1.0, 'steel', 1.0, 4.15, 4.0);

  // power mast at the front-right of the roof, arm out over the front, insulator at the end
  const mx = 3.0;
  const mz = 7.2;
  rod(g, { x: mx, y: 4.15, z: mz }, { x: mx, y: 5.8, z: mz }, 0.07, 'steel', 6);
  rod(g, { x: mx, y: 5.8, z: mz }, { x: mx, y: 5.8, z: 8.4 }, 0.06, 'steel', 6);
  const top = insulator(g, mx, 5.8, 8.4, 3);
  return { x: top.x, y: top.y, z: top.z };
}

/** Row of four filter tanks behind the shed on a manifold, fed from the reservoir. */
function filterRow(g: THREE.Group): void {
  const y = 0.9;
  for (const x of [-2.4, -0.8, 0.8, 2.4]) {
    cyl(g, 0.7, 0.7, 2.6, 'wallWhite', x, 0, 0, 14);
    cyl(g, 0.2, 0.7, 0.4, 'steel', x, 2.6, 0, 14);
    rod(g, { x, y, z: 0.7 }, { x, y, z: 1.1 }, 0.1, 'blue', 6); // stub into the manifold
  }
  pipeRun(g, [{ x: -2.4, y, z: 1.1 }, { x: 3.6, y, z: 1.1 }], 0.15, 'blue');
  pipeRun(g, [{ x: 3.6, y, z: -4.9 }, { x: 3.6, y, z: 1.1 }], 0.2, 'blue');
  sphere(g, 0.2, 'blue', 3.6, y, 1.1, 10);
  gateValve(g, 3.6, y, -2.9, 'z', 0.3);
  pipeSupport(g, -1.6, y, 1.1, 0.15);
  pipeSupport(g, 1.6, y, 1.1, 0.15);
  pipeSupport(g, 3.6, y, -1.6, 0.2);
}

function reservoirSite(g: THREE.Group): V {
  groundReservoir(g, 0, -7.5);
  storageTank(g, -7.0, -1.0, 2.2, 10.0);
  spiralStair(g, -7.0, -1.0, 2.2);
  storageTank(g, 7.0, -1.0, 2.2, 10.0);
  // ladder up the front of the right-hand tank, standing flush against the wall
  ladderV(g, 7.0, -1.0 + Math.sqrt(2.2 * 2.2 - 0.0625) + 0.08, 0, 10.0, 'x', 0.5);
  filterRow(g);
  const port = treatmentShed(g);
  // small control cabinet beside the shed
  box(g, 0.9, 1.9, 0.5, 'wallCream', -6.0, 0, 7.0);
  box(g, 0.95, 0.08, 0.55, 'steelDark', -6.0, 1.9, 7.0);
  for (const lx of [-6.25, -6.0, -5.75]) box(g, 0.14, 0.14, 0.05, 'glow', lx, 1.4, 7.27);
  return port;
}

/* ------------------------------------------------------------- builder */

export const build: ModelBuilder = ({ variant }) => {
  const g = new THREE.Group();
  yardAndFence(g);
  const port = variant === 0 ? towerSite(g) : reservoirSite(g);
  setPowerPorts(g, [port]);
  return g;
};
