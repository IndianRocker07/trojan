import * as THREE from 'three';
import { MAT, type MatName } from '../render/palette';
import {
  box,
  cyl,
  rod,
  sphere,
  gableRoof,
  windowGrid,
  ladder,
  insulator,
  spin,
  setPowerPorts,
  setOutPorts,
  type ModelBuilder,
} from './kit';

/**
 * Generator: electricity generating plant on a 3×3 cell (36 × 36 m) lot.
 *  - variant 0: thermal/gas power station (cooling tower, chimney, turbine hall, boiler house,
 *    fuel tanks, pipe rack, step-up transformer yard)
 *  - variant 1: solar + battery farm (tilted array rows, battery containers, control hall,
 *    inverters, wind turbines)
 * Both share the fenced lot, access road, guard hut, site sign and the front (+Z) HV gantry
 * whose three insulator strings are OUTGOING ports. A generator has no incoming line.
 */

export const VARIANTS = 2;

/** Fence line. Footprint half-size is 18 m; the fence sits 1.2 m inside it. */
const FENCE = 16.8;
/** Gap in the front fence where the access road enters. */
const GATE_HALF = 2.4;
/** Front HV gantry (+Z side). */
const GANTRY = { x: 0, z: 15 };
const BEAM_Y = 13.2; // underside of the gantry crossbeam
const HOLD_Y = 12.6; // bottom of the insulator strings = outgoing port height

// ---------------------------------------------------------------- helpers

/** A mesh with a palette material at a position, for geometry the kit cannot make (lathe, torus). */
function place(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: MatName, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, MAT[mat]);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// ------------------------------------------------- cooling tower (hyperboloid)

/**
 * Hyperboloid of one sheet: r(y)^2 = R0^2 + K (y - YW)^2. It is a ruled surface, so its
 * diagonal lattice ribs are exact straight lines on the shell (see `ruling`).
 */
const TOWER = { y0: 0.4, H: 26, R0: 4.0, YW: 16, RB: 6.6 };
const TOWER_K = (TOWER.RB ** 2 - TOWER.R0 ** 2) / (TOWER.YW - TOWER.y0) ** 2;
const TOWER_C = TOWER.R0 / Math.sqrt(TOWER_K); // height per unit ruling parameter t
const towerR = (y: number): number => Math.sqrt(TOWER.R0 ** 2 + TOWER_K * (y - TOWER.YW) ** 2);

/** Point on ruling `fam` (1 or 2) through throat angle `a` at ruling parameter `t` (local coords). */
function ruling(a: number, t: number, fam: 1 | 2): THREE.Vector3Like {
  const { R0, YW } = TOWER;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return fam === 1
    ? { x: R0 * (c - t * s), y: YW + t * TOWER_C, z: R0 * (s + t * c) }
    : { x: R0 * (c + t * s), y: YW + t * TOWER_C, z: R0 * (s - t * c) };
}

function coolingTower(g: THREE.Group, cx: number, cz: number): void {
  const { y0, H } = TOWER;
  // basin / plinth the shell stands on
  cyl(g, 7.0, 7.0, y0, 'concrete', cx, 0, cz, 16);

  // outer shell: the waisted profile, bottom to top, open at both ends
  const outer: THREE.Vector2[] = [];
  const N = 12;
  for (let i = 0; i <= N; i++) {
    const y = y0 + ((H - y0) * i) / N;
    outer.push(new THREE.Vector2(towerR(y), y));
  }
  place(g, new THREE.LatheGeometry(outer, 16), 'concrete', cx, 0, cz);

  // inner wall: reversed profile pulled 0.35 m inward, so its faces look into the tower
  const inner = [...outer].reverse().map((p) => new THREE.Vector2(p.x - 0.35, p.y));
  place(g, new THREE.LatheGeometry(inner, 16), 'concrete', cx, 0, cz);

  // red and white warning bands just under the top
  const band = (ya: number, yb: number, mat: MatName) => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 3; i++) {
      const y = ya + ((yb - ya) * i) / 3;
      pts.push(new THREE.Vector2(towerR(y) + 0.08, y));
    }
    place(g, new THREE.LatheGeometry(pts, 16), mat, cx, 0, cz);
  };
  band(20.4, 21.8, 'red');
  band(21.8, 22.9, 'wallWhite');

  // top rim ring
  const rim = place(g, new THREE.TorusGeometry(towerR(H) - 0.1, 0.22, 6, 16), 'concrete', cx, H, cz);
  rim.rotation.x = Math.PI / 2;

  // diagonal lattice ribs: 12 rulings in each family, base to top
  const t0 = (y0 - TOWER.YW) / TOWER_C;
  const t1 = (H - TOWER.YW) / TOWER_C;
  for (const fam of [1, 2] as const) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const p = ruling(a, t0, fam);
      const q = ruling(a, t1, fam);
      rod(g, { x: cx + p.x, y: p.y, z: cz + p.z }, { x: cx + q.x, y: q.y, z: cz + q.z }, 0.14, 'concrete', 6);
    }
  }
}

// ----------------------------------------------------------------- chimney

function chimney(g: THREE.Group, cx: number, cz: number): void {
  const H = 34;
  const R0 = 1.7; // base radius
  const R1 = 1.15; // top radius
  const rAt = (y: number) => R0 + ((R1 - R0) * y) / H;
  cyl(g, 2.0, 2.0, 0.4, 'concrete', cx, 0, cz, 16); // plinth
  cyl(g, R1, R0, H - 0.4, 'wallWhite', cx, 0.4, cz, 16); // tapered stack body
  // red bands hugging the taper
  for (const [ya, yb] of [
    [4.5, 7.0],
    [14.0, 16.5],
    [23.5, 26.0],
    [31.0, 33.0],
  ]) {
    cyl(g, rAt(yb) + 0.04, rAt(ya) + 0.04, yb - ya, 'red', cx, ya, cz, 16);
  }
  // top cap ring
  cyl(g, 1.25, 1.25, 0.35, 'steelDark', cx, H - 0.35, cz, 16);
  // two aviation beacons on short masts
  for (const s of [-0.8, 0.8]) {
    rod(g, { x: cx + s, y: H, z: cz }, { x: cx + s, y: H + 0.4, z: cz }, 0.08, 'steel', 5);
    sphere(g, 0.22, 'beacon', cx + s, H + 0.6, cz, 8);
  }
}

// ------------------------------------------------------------ turbine hall

function turbineHall(g: THREE.Group): void {
  const cx = -4;
  const cz = 4.5;
  const hw = 10;
  const hd = 5;
  const dz = cz + hd; // front wall face (+Z)

  box(g, 2 * hw, 9, 2 * hd, 'wallBlue', cx, 0, cz);
  gableRoof(g, 2 * hw, 2 * hd, 3.5, 'roofInk', cx, 9, cz);

  // front: framed clerestory row above the door, plain glow row lower down (skipping the door)
  windowGrid(g, { face: '+z', cx, cz, hw, hd, rows: 1, cols: 12, y0: 6.2, pitchY: 0, winW: 1.0, winH: 1.6, span: 18, frames: true });
  windowGrid(g, {
    face: '+z', cx, cz, hw, hd, rows: 1, cols: 12, y0: 2.6, pitchY: 0, winW: 1.0, winH: 1.4, span: 18,
    skip: (_r, c) => Math.abs(cx - 9 + (18 / 11) * c) < 2.8,
  });
  // back and gable ends: glow clerestory rows
  windowGrid(g, { face: '-z', cx, cz, hw, hd, rows: 1, cols: 12, y0: 6.2, pitchY: 0, winW: 1.0, winH: 1.6, span: 18 });
  windowGrid(g, { face: '-x', cx, cz, hw, hd, rows: 1, cols: 3, y0: 6.2, pitchY: 0, winW: 1.0, winH: 1.6 });
  windowGrid(g, { face: '+x', cx, cz, hw, hd, rows: 1, cols: 3, y0: 6.2, pitchY: 0, winW: 1.0, winH: 1.6 });

  // big roller door on the front, centred on the access road
  box(g, 4.4, 4.6, 0.3, 'ink', 0, 0, dz + 0.1);
  for (let i = 0; i < 5; i++) box(g, 4.2, 0.1, 0.12, 'steel', 0, 0.7 + i * 0.75, dz + 0.3);
  box(g, 0.3, 4.9, 0.4, 'steelDark', -2.35, 0, dz + 0.2);
  box(g, 0.3, 4.9, 0.4, 'steelDark', 2.35, 0, dz + 0.2);
  box(g, 5.0, 0.3, 0.4, 'steelDark', 0, 4.6, dz + 0.2);
  // concrete threshold / step in front of the door
  box(g, 5.0, 0.3, 0.8, 'concrete', 0, 0, dz);

  // roof: three ridge vents and a spinning roof ventilator
  for (const x of [-12, -3, 3.5]) box(g, 1.4, 0.9, 1.8, 'steelDark', x, 12.2, cz);
  const FX = -8;
  cyl(g, 0.8, 0.8, 1.0, 'steelDark', FX, 11.9, cz, 12);
  const fan = new THREE.Group();
  fan.position.set(FX, 12.9, cz);
  spin(fan, 'y', 2.5);
  g.add(fan);
  cyl(fan, 0.2, 0.2, 0.3, 'ink', 0, 0, 0, 8);
  box(fan, 2.6, 0.08, 0.4, 'steel', 0, 0.2, 0);
  box(fan, 0.4, 0.08, 2.6, 'steel', 0, 0.2, 0);
}

// ----------------------------------------------------------- boiler house

function boilerHouse(g: THREE.Group): void {
  const cx = 11;
  const cz = 3;
  box(g, 6.5, 17, 10, 'wallSand', cx, 0, cz);
  box(g, 6.9, 0.6, 10.4, 'roofInk', cx, 17, cz); // parapet slab
  windowGrid(g, { face: '+z', cx, cz, hw: 3.25, hd: 5, rows: 4, cols: 2, y0: 2.2, pitchY: 3.4, winW: 1.2, winH: 1.8, span: 5.2 });
  windowGrid(g, { face: '+x', cx, cz, hw: 3.25, hd: 5, rows: 4, cols: 2, y0: 2.2, pitchY: 3.4, winW: 1.2, winH: 1.8, span: 6 });
  cyl(g, 0.45, 0.6, 1.5, 'steel', 9.0, 17.6, 1.0, 10); // roof vents
  cyl(g, 0.45, 0.6, 1.5, 'steel', 13.0, 17.6, 5.0, 10);
}

// ------------------------------------------------------------ fuel tanks

function fuelTank(g: THREE.Group, cx: number, cz: number, ladderSide: '+z' | '-z'): void {
  cyl(g, 3.0, 3.0, 0.3, 'concrete', cx, 0, cz, 16); // bund base
  cyl(g, 2.6, 2.6, 5.6, 'steel', cx, 0.3, cz, 16); // body
  sphere(g, 2.6, 'steel', cx, 5.9, cz, 16); // dome roof
  cyl(g, 2.9, 2.9, 0.12, 'steelDark', cx, 5.8, cz, 16); // walkway ring round the dome
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const px = cx + 2.85 * Math.cos(a);
    const pz = cz + 2.85 * Math.sin(a);
    rod(g, { x: px, y: 5.92, z: pz }, { x: px, y: 6.92, z: pz }, 0.05, 'ink', 5);
  }
  place(g, new THREE.TorusGeometry(2.85, 0.05, 5, 24), 'ink', cx, 6.92, cz).rotation.x = Math.PI / 2;
  // access ladder up the side that is kept clear of pipework
  const off = ladderSide === '+z' ? 2.62 : -2.62;
  ladder(g, cx, cz + off, 0.3, 5.9, ladderSide);
}

// ------------------------------------------------------------ pipe rack

/** Single-bent pipe rack along the west side, with a branch into the turbine hall. */
function pipeRack(g: THREE.Group): void {
  const X = -15.6;
  for (const z of [-0.2, 3.5, 7.2]) cyl(g, 0.14, 0.14, 3.2, 'steel', X, 0, z, 8);
  box(g, 0.9, 0.25, 8.4, 'steelDark', X, 3.2, 3.5);
  rod(g, { x: X - 0.25, y: 3.65, z: -0.7 }, { x: X - 0.25, y: 3.65, z: 7.7 }, 0.2, 'steel', 8);
  rod(g, { x: X + 0.25, y: 3.65, z: -0.7 }, { x: X + 0.25, y: 3.65, z: 7.7 }, 0.2, 'orange', 8);
  rod(g, { x: X, y: 3.95, z: -0.7 }, { x: X, y: 3.95, z: 7.7 }, 0.16, 'steel', 8);
  // branch from the rack into the turbine hall's west wall
  rod(g, { x: X + 0.25, y: 3.65, z: 3.5 }, { x: -13.6, y: 3.65, z: 3.5 }, 0.2, 'orange', 8);
}

// ------------------------------------------------------ transformer yard

function transformer(g: THREE.Group, cx: number, cz: number): void {
  box(g, 3.6, 0.2, 3.0, 'concrete', cx, 0, cz); // pad
  box(g, 3.0, 2.6, 2.4, 'steel', cx, 0.2, cz); // tank
  for (const dx of [-0.9, 0, 0.9]) cyl(g, 0.16, 0.16, 1.0, 'ink', cx + dx, 2.8, cz, 8); // HV bushings
  box(g, 2.6, 1.6, 0.25, 'steelDark', cx, 0.4, cz + 1.325); // cooling radiator
}

// ------------------------------------------------- thermal power station

function thermalStation(g: THREE.Group): void {
  coolingTower(g, -9, -9);
  chimney(g, 12.5, -9);
  boilerHouse(g);
  turbineHall(g);
  fuelTank(g, 1.5, -10.5, '+z');
  fuelTank(g, 7, -13, '-z');
  pipeRack(g);
  transformer(g, 5.8, 12.4);
  transformer(g, 9.8, 12.4);

  // flue duct from the boiler back wall into the stack foot
  rod(g, { x: 12.5, y: 13.5, z: -1.8 }, { x: 12.5, y: 13.5, z: -7.6 }, 0.45, 'steel', 8);
  rod(g, { x: 12.5, y: 13.5, z: -1.8 }, { x: 12.5, y: 13.5, z: -2.2 }, 0.6, 'steelDark', 8);

  // steam/feed pipework from the boiler house into the turbine hall, with flanges at both walls
  for (const [y, mat] of [
    [2.4, 'steel'],
    [3.8, 'orange'],
    [5.2, 'steel'],
  ] as const) {
    rod(g, { x: 5.6, y, z: 2 }, { x: 8.0, y, z: 2 }, 0.22, mat, 8);
    rod(g, { x: 5.95, y, z: 2 }, { x: 6.25, y, z: 2 }, 0.36, 'steelDark', 8);
    rod(g, { x: 7.5, y, z: 2 }, { x: 7.8, y, z: 2 }, 0.36, 'steelDark', 8);
  }

  // fuel line from the second tank to the boiler house
  rod(g, { x: 7, y: 1.2, z: -10.6 }, { x: 7, y: 1.2, z: -1.0 }, 0.22, 'steel', 8);
  rod(g, { x: 7, y: 1.2, z: -1.0 }, { x: 8.0, y: 1.2, z: -1.0 }, 0.22, 'steel', 8);
}

// --------------------------------------------------- solar and battery farm

/** Seven rows of tilted panel tables on steel legs. Panels face +Z (sun side). */
function solarRows(g: THREE.Group): void {
  const TILT = 0.44; // about 25 degrees; the +Z edge is the low edge
  const PIVOT = 1.9; // torque-tube height
  const X = -7.5;
  for (let k = 0; k < 7; k++) {
    const z = -13.5 + k * 2.7;
    rod(g, { x: X - 6, y: PIVOT - 0.13, z }, { x: X + 6, y: PIVOT - 0.13, z }, 0.08, 'steel', 6);
    for (const dx of [-5.6, 0, 5.6]) cyl(g, 0.1, 0.1, PIVOT - 0.2, 'steel', X + dx, 0, z, 6);
    for (const dx of [-4.5, -1.5, 1.5, 4.5]) {
      const p = box(g, 2.9, 0.1, 2.2, 'roofBlue', 0, 0, 0);
      p.position.set(X + dx, PIVOT, z);
      p.rotation.x = TILT;
    }
  }
}

/** Battery storage container: white box, ink ribs, glow status lights, AC unit on top. */
function batteryContainer(g: THREE.Group, cx: number, cz: number): void {
  box(g, 2.8, 0.2, 6.4, 'concrete', cx, 0, cz); // pad
  box(g, 2.4, 2.6, 6.0, 'wallWhite', cx, 0.2, cz); // container 0.2 .. 2.8
  for (const y of [1.0, 1.9]) {
    for (const s of [-1, 1]) box(g, 0.1, 0.12, 5.6, 'ink', cx + s * 1.23, y, cz); // ribs
  }
  box(g, 1.6, 2.2, 0.08, 'ink', cx, 0.2, cz + 3.02); // end door
  box(g, 0.22, 0.22, 0.06, 'glow', cx - 0.6, 2.45, cz + 3.03); // status lights
  box(g, 0.22, 0.22, 0.06, 'glow', cx + 0.6, 2.45, cz + 3.03);
  box(g, 1.6, 0.6, 1.4, 'steel', cx, 2.8, cz - 1.5); // AC unit
  box(g, 1.2, 0.04, 1.0, 'ink', cx, 3.4, cz - 1.5); // AC grille
}

/** Inverter cabinet with a glow status panel on its west face. */
function inverter(g: THREE.Group, x: number, z: number): void {
  box(g, 1.6, 2.2, 1.4, 'steel', x, 0, z);
  box(g, 0.06, 0.3, 0.6, 'glow', x - 0.83, 1.5, z);
  box(g, 1.2, 0.1, 1.0, 'ink', x, 2.2, z);
}

/** Control / inverter hall with a coral gable roof and glow windows on two faces. */
function controlHall(g: THREE.Group): void {
  const cx = 9;
  const cz = 9.5;
  box(g, 9, 4.5, 6, 'wallCream', cx, 0, cz);
  gableRoof(g, 9, 6, 2.0, 'roofCoral', cx, 4.5, cz, 0.5);
  windowGrid(g, { face: '+z', cx, cz, hw: 4.5, hd: 3, rows: 1, cols: 4, y0: 2.2, pitchY: 0, winW: 1.2, winH: 1.5, span: 7.2, frames: true });
  windowGrid(g, { face: '+x', cx, cz, hw: 4.5, hd: 3, rows: 1, cols: 2, y0: 2.2, pitchY: 0, winW: 1.2, winH: 1.5, frames: true });
  box(g, 1.0, 2.3, 0.2, 'ink', 9, 0, 12.6); // door
  box(g, 1.8, 0.2, 0.6, 'concrete', 9, 0, 13.0); // step
  box(g, 1.0, 0.8, 1.2, 'steelDark', 6.5, 5.9, cz); // ridge vents
  box(g, 1.0, 0.8, 1.2, 'steelDark', 11.5, 5.9, cz);
}

/** Wind turbine: tapered tower, nacelle, and a 3-blade rotor that spins about its axis. */
function windTurbine(g: THREE.Group, x: number, z: number): void {
  box(g, 3.0, 0.4, 3.0, 'concrete', x, 0, z); // pad
  cyl(g, 0.45, 0.8, 15.4, 'wallWhite', x, 0.4, z, 12); // tower 0.4 .. 15.8
  box(g, 0.9, 1.0, 2.4, 'wallWhite', x, 15.8, z); // nacelle
  rod(g, { x, y: 16.8, z: z - 0.6 }, { x, y: 17.05, z: z - 0.6 }, 0.05, 'steel', 5);
  sphere(g, 0.18, 'beacon', x, 17.2, z - 0.6, 8);

  const rotor = new THREE.Group();
  rotor.position.set(x, 16.3, z + 1.5);
  spin(rotor, 'z', 1.2);
  g.add(rotor);
  sphere(rotor, 0.45, 'wallWhite', 0, 0, 0, 8); // hub
  for (let k = 0; k < 3; k++) {
    const blade = new THREE.Group();
    blade.rotation.z = (k * Math.PI * 2) / 3;
    rotor.add(blade);
    box(blade, 0.5, 5.5, 0.14, 'wallWhite', 0, 0, 0);
  }
}

function solarFarm(g: THREE.Group): void {
  solarRows(g);
  for (const x of [-13.5, -10.5, -7.5, -4.5]) batteryContainer(g, x, 8.5);
  controlHall(g);
  for (const z of [7.2, 9.4, 11.6]) inverter(g, 15.2, z);
  windTurbine(g, 10.5, -12.5);
  windTurbine(g, 10.5, -3.5);
}

// ------------------------------------------------- shared site features

function lotAndRoad(g: THREE.Group): void {
  box(g, FENCE * 2, 0.12, FENCE * 2, 'paving', 0, 0, 0);
  // access road: from the front gate, under the gantry, to the front of the main building
  box(g, 4.4, 0.08, 7.0, 'asphalt', 0, 0.12, 12.9);
}

/** Perimeter fence: steel posts, two rails per side, gap at the front for the road. */
function fence(g: THREE.Group): void {
  const H = 2.0;
  const post = (x: number, z: number) => cyl(g, 0.07, 0.07, H, 'steel', x, 0, z, 6);
  const span = [-FENCE, -12.6, -8.4, -4.2, 0, 4.2, 8.4, 12.6, FENCE];
  for (const x of span) post(x, -FENCE); // back
  for (const x of span) if (Math.abs(x) >= GATE_HALF) post(x, FENCE); // front, minus the gate
  post(-GATE_HALF, FENCE);
  post(GATE_HALF, FENCE);
  for (const z of span.slice(1, -1)) {
    post(-FENCE, z);
    post(FENCE, z);
  }
  for (const h of [0.6, 1.9]) {
    rod(g, { x: -FENCE, y: h, z: -FENCE }, { x: FENCE, y: h, z: -FENCE }, 0.04, 'steel', 5);
    rod(g, { x: -FENCE, y: h, z: FENCE }, { x: -GATE_HALF, y: h, z: FENCE }, 0.04, 'steel', 5);
    rod(g, { x: GATE_HALF, y: h, z: FENCE }, { x: FENCE, y: h, z: FENCE }, 0.04, 'steel', 5);
    rod(g, { x: -FENCE, y: h, z: -FENCE }, { x: -FENCE, y: h, z: FENCE }, 0.04, 'steel', 5);
    rod(g, { x: FENCE, y: h, z: -FENCE }, { x: FENCE, y: h, z: FENCE }, 0.04, 'steel', 5);
  }
}

/** Portal HV gantry at the front. Returns the three insulator-string ends (outgoing ports). */
function gantry(g: THREE.Group): THREE.Vector3Like[] {
  const { x, z } = GANTRY;
  const LEG = 4.5;
  for (const dx of [-LEG, LEG]) {
    box(g, 1.6, 0.4, 1.6, 'concrete', x + dx, 0, z); // footing
    box(g, 0.6, BEAM_Y, 0.6, 'steel', x + dx, 0, z); // leg
  }
  box(g, 2 * LEG + 0.6, 0.6, 0.6, 'steel', x, BEAM_Y, z); // crossbeam
  rod(g, { x: x - LEG, y: 6.5, z }, { x: x + LEG, y: 6.5, z }, 0.14, 'steel', 6); // girt
  rod(g, { x: x - LEG, y: 0.8, z }, { x: x + LEG, y: 6.2, z }, 0.1, 'steel', 6); // braces
  rod(g, { x: x + LEG, y: 0.8, z }, { x: x - LEG, y: 6.2, z }, 0.1, 'steel', 6);

  const ports: THREE.Vector3Like[] = [];
  for (const dx of [-3.5, 0, 3.5]) {
    insulator(g, x + dx, HOLD_Y, z, 3); // string hangs from the beam; its bottom end is the port
    ports.push({ x: x + dx, y: HOLD_Y, z });
  }
  return ports;
}

/** Guard hut at the front-left corner: glow windows on the front and west faces. */
function guardHut(g: THREE.Group): void {
  const x = -11;
  const z = 13.5;
  box(g, 3.2, 2.8, 2.6, 'wallCream', x, 0, z);
  gableRoof(g, 3.2, 2.6, 1.2, 'roofCoral', x, 2.8, z);
  windowGrid(g, { face: '+z', cx: x, cz: z, hw: 1.6, hd: 1.3, rows: 1, cols: 1, y0: 1.2, pitchY: 0, winW: 0.9, winH: 0.9, frames: true });
  windowGrid(g, { face: '-x', cx: x, cz: z, hw: 1.6, hd: 1.3, rows: 1, cols: 1, y0: 1.2, pitchY: 0, winW: 0.9, winH: 0.9 });
  box(g, 0.8, 2.0, 0.2, 'ink', x + 1.1, 0, z + 1.3); // door
  box(g, 1.2, 0.2, 0.5, 'concrete', x + 1.1, 0, z + 1.55); // step
}

/** Site sign on two posts, with a glow header strip. */
function siteSign(g: THREE.Group): void {
  const x = -6;
  const z = 14.6;
  cyl(g, 0.07, 0.07, 2.4, 'steel', x - 1.2, 0, z, 6);
  cyl(g, 0.07, 0.07, 2.4, 'steel', x + 1.2, 0, z, 6);
  box(g, 3.4, 1.3, 0.2, 'wallYellow', x, 2.4, z);
  box(g, 2.6, 0.2, 0.06, 'ink', x, 2.6, z + 0.13);
  box(g, 2.0, 0.12, 0.06, 'ink', x, 3.0, z + 0.13);
  box(g, 2.8, 0.14, 0.06, 'glow', x, 3.38, z + 0.13);
}

// ------------------------------------------------------------ entry point

export const build: ModelBuilder = ({ variant }) => {
  const g = new THREE.Group();
  lotAndRoad(g);
  fence(g);
  guardHut(g);
  siteSign(g);
  const outPorts = gantry(g);
  if (variant === 1) solarFarm(g);
  else thermalStation(g);

  setOutPorts(g, outPorts);
  setPowerPorts(g, []);
  return g;
};
