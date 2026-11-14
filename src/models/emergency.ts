// Emergency services station (fire + ambulance + rescue). Footprint 2x2 cells = 24 x 24 m.
// Origin = footprint centre at ground level, front (+Z) faces the apron.
import * as THREE from 'three';
import { MAT, type MatName } from '../render/palette';
import {
  box,
  cyl,
  rod,
  sphere,
  hipRoof,
  windowGrid,
  spin,
  insulator,
  setPowerPorts,
  type ModelBuilder,
} from './kit';

export const VARIANTS = 2;

/** Lot slab top. Everything in the station sits on it. */
const B = 0.12;
/** Apron paving top. Apron vehicles sit on it. */
const APRON = B + 0.06;
/** Station levels (absolute Y). Ground floor 3.6 m, upper floor 3.2 m. */
const GT = B + 3.6; // top of ground floor
const UB = GT + 0.2; // upper floor base, above the white string course
const CB = UB + 3.2; // cornice base
const RB = CB + 0.25; // roof slab base
const R = RB + 0.08; // roof top
/** Station footprint: front plane, back plane, centre Z. */
const FRONT_Z = -1;
const BACK_Z = -11;
const SZ = -6;
/** Three apparatus bays on the front: centre X, width. */
const BAYS = [-4.3, 0, 4.3] as const;
const BAY_W = 3.6;
/** Hose tower and dispatch annex. */
const TOWER = { x: 9.2, z: -8.5 } as const;
const ANNEX = { x: -9.4, z: -9.0 } as const;

interface Look {
  wall: MatName; // main walls and pillars
  accent: MatName; // tower storey bands, ambulance stripe
  roof: MatName; // tower cap, canopy
  rescue: boolean; // rescue truck instead of fire engine
  radar: boolean; // radar dish instead of antenna mast
}

const FIRE_LOOK: Look = { wall: 'wallCoral', accent: 'wallCoral', roof: 'roofCoral', rescue: false, radar: false };
const POLICE_LOOK: Look = { wall: 'wallBlue', accent: 'wallBlue', roof: 'roofBlue', rescue: true, radar: true };

/** Wheel: ink tyre on its side (axis along X) with a steel hub on the outside face. */
function wheel(parent: THREE.Object3D, x: number, y: number, z: number, r: number): void {
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.36, 12), MAT.ink);
  tyre.rotation.z = Math.PI / 2;
  tyre.position.set(x, y, z);
  parent.add(tyre);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, 0.04, 8), MAT.steel);
  hub.rotation.z = Math.PI / 2;
  hub.position.set(x + Math.sign(x) * 0.2, y, z);
  parent.add(hub);
}

/** Fire engine or rescue truck, about 8.4 m long, nose toward +Z. (x, z) = centre, ground = Y of tarmac. */
function apparatus(g: THREE.Object3D, kind: 'fire' | 'rescue', x: number, z: number, ground: number): void {
  const t = new THREE.Group();
  t.position.set(x, ground, z);
  g.add(t);
  const body: MatName = kind === 'fire' ? 'red' : 'blue';

  // chassis, rear compartment, cab
  box(t, 2.2, 0.4, 8.2, 'ink', 0, 0.4, 0);
  box(t, 2.5, 2.0, 6.1, body, 0, 0.8, -1.15);
  box(t, 2.52, 0.22, 6.12, 'wallWhite', 0, 1.6, -1.15);
  box(t, 2.5, 1.7, 2.3, body, 0, 0.8, 3.05);
  box(t, 2.52, 0.14, 2.32, 'wallWhite', 0, 2.5, 3.05);
  box(t, 2.3, 0.85, 0.06, 'glass', 0, 1.45, 4.2);
  for (const sx of [-0.8, 0.8]) box(t, 0.35, 0.2, 0.06, 'glow', sx, 1.0, 4.22);
  for (const sx of [-1, 1]) box(t, 0.06, 0.6, 1.6, 'steelDark', sx * 1.27, 0.9, -2.2);
  box(t, 2.5, 0.25, 0.2, 'steel', 0, 0.5, 4.3);
  box(t, 2.5, 0.25, 0.2, 'steel', 0, 0.5, -4.3);

  // roof light bar on the cab, two beacons
  box(t, 1.8, 0.16, 0.34, 'ink', 0, 2.64, 2.9);
  for (const sx of [-0.45, 0.45]) box(t, 0.5, 0.08, 0.26, 'beacon', sx, 2.8, 2.9);

  if (kind === 'fire') {
    // ladder stored flat on the rack: two rails, four posts, rungs
    for (const z of [-3.6, -1.2]) {
      for (const sx of [-0.6, 0.6]) rod(t, { x: sx, y: 2.8, z }, { x: sx, y: 3.05, z }, 0.04, 'steel', 5);
    }
    rod(t, { x: -0.6, y: 3.05, z: -4.0 }, { x: -0.6, y: 3.05, z: 1.2 }, 0.05, 'steel', 6);
    rod(t, { x: 0.6, y: 3.05, z: -4.0 }, { x: 0.6, y: 3.05, z: 1.2 }, 0.05, 'steel', 6);
    for (let z = -4.0; z <= 1.21; z += 0.52) {
      rod(t, { x: -0.6, y: 3.05, z }, { x: 0.6, y: 3.05, z }, 0.03, 'steel', 4);
    }
  } else {
    // rescue rack, yellow hard-case and a hydraulic boom
    box(t, 1.8, 0.5, 2.6, 'steelDark', 0, 2.8, -2.0);
    box(t, 1.2, 0.3, 0.9, 'yellow', 0, 3.3, -2.6);
    rod(t, { x: 0, y: 3.3, z: -3.6 }, { x: 0, y: 4.2, z: -1.0 }, 0.08, 'steel', 6);
  }

  for (const sx of [-1, 1]) {
    wheel(t, sx * 1.22, 0.46, 2.9, 0.46);
    wheel(t, sx * 1.22, 0.46, -2.9, 0.46);
    wheel(t, sx * 1.22, 0.46, -3.9, 0.46);
  }
}

/** Ambulance: white van with a stripe, roof beacons and red crosses. Nose toward +Z. */
function ambulance(g: THREE.Object3D, look: Look, x: number, z: number, ground: number): void {
  const t = new THREE.Group();
  t.position.set(x, ground, z);
  g.add(t);

  box(t, 2.0, 0.3, 4.8, 'ink', 0, 0.35, 0);
  box(t, 2.2, 1.8, 3.8, 'wallWhite', 0, 0.65, -0.6);
  box(t, 2.2, 1.5, 1.3, 'wallWhite', 0, 0.65, 2.05);
  box(t, 2.24, 0.28, 5.2, look.accent, 0, 1.2, 0.1);
  box(t, 1.9, 0.6, 0.06, 'glass', 0, 1.5, 2.72);
  for (const sx of [-1, 1]) {
    box(t, 0.06, 0.5, 0.9, 'glass', sx * 1.12, 1.5, 2.0);
    // red cross on each side, above the stripe
    box(t, 0.04, 0.42, 0.12, 'red', sx * 1.13, 1.65, -0.6);
    box(t, 0.04, 0.12, 0.42, 'red', sx * 1.13, 1.8, -0.6);
  }
  box(t, 0.3, 0.1, 0.06, 'glow', -0.7, 0.9, 2.72);
  box(t, 0.3, 0.1, 0.06, 'glow', 0.7, 0.9, 2.72);
  box(t, 2.2, 0.2, 0.15, 'steel', 0, 0.45, 2.78);
  box(t, 2.2, 0.2, 0.15, 'steel', 0, 0.45, -2.58);

  // roof light bar with two beacons
  box(t, 1.4, 0.12, 0.3, 'ink', 0, 2.45, 0.1);
  box(t, 0.4, 0.1, 0.22, 'beacon', -0.35, 2.57, 0.1);
  box(t, 0.4, 0.1, 0.22, 'beacon', 0.35, 2.57, 0.1);

  for (const wz of [1.8, -1.6]) {
    for (const sx of [-1, 1]) wheel(t, sx * 1.1, 0.4, wz, 0.4);
  }
}

/** Hose-drying tower, four storeys, plus the station roof kit (HVAC, siren, mast or radar). */
function roofKit(g: THREE.Object3D, look: Look): THREE.Vector3 {
  // HVAC unit with a grille on top, two roof vent stacks with caps
  box(g, 2.6, 0.9, 1.8, 'steel', -3.2, R, -8);
  box(g, 2.3, 0.06, 1.5, 'steelDark', -3.2, R + 0.9, -8);
  for (const vx of [0.5, 1.6]) {
    cyl(g, 0.22, 0.22, 0.5, 'steel', vx, R, -9.6, 8);
    cyl(g, 0.3, 0.3, 0.08, 'ink', vx, R + 0.5, -9.6, 8);
  }

  // siren: drum, head, two cone horns, beacon
  cyl(g, 0.32, 0.32, 0.4, 'steelDark', -5.8, R, -8, 12);
  cyl(g, 0.24, 0.24, 0.2, 'ink', -5.8, R + 0.4, -8, 12);
  for (const s of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.45, 10), MAT.steel);
    horn.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    horn.position.set(-5.8 + s * 0.36, R + 0.5, -8);
    g.add(horn);
  }
  sphere(g, 0.12, 'beacon', -5.8, R + 0.72, -8, 8);

  if (look.radar) {
    // radar: pedestal, spinning head with a dish and feed horn
    cyl(g, 0.35, 0.45, 1.2, 'steelDark', 4.5, R, -8, 10);
    const head = spin(new THREE.Group(), 'y', 0.8);
    head.position.set(4.5, R + 1.2, -8);
    g.add(head);
    cyl(head, 0.3, 0.3, 0.3, 'steel', 0, 0, 0, 10);
    rod(head, { x: 0, y: 0.3, z: 0 }, { x: 0, y: 1.3, z: 0 }, 0.08, 'steel', 6);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(1.55, 14, 6, 0, Math.PI * 2, 0, 0.7), MAT.wallWhite);
    dish.rotation.x = -Math.PI / 2; // dome toward -Z, concave face toward the front
    dish.position.set(0, 1.3, 1.19); // rim sits in the z = 0 plane
    head.add(dish);
    rod(head, { x: 0, y: 1.3, z: 0 }, { x: 0, y: 1.3, z: 0.9 }, 0.04, 'steel', 6);
    sphere(head, 0.1, 'steel', 0, 1.3, 0.9, 8);
  } else {
    // radio mast with two cross arms and a beacon on top
    box(g, 0.5, 0.3, 0.5, 'steel', 4.5, R, -8);
    cyl(g, 0.1, 0.12, 6, 'steel', 4.5, R + 0.3, -8, 8);
    rod(g, { x: 3.4, y: R + 3.2, z: -8 }, { x: 5.6, y: R + 3.2, z: -8 }, 0.05, 'steel', 6);
    rod(g, { x: 3.7, y: R + 4.8, z: -8 }, { x: 5.3, y: R + 4.8, z: -8 }, 0.05, 'steel', 6);
    sphere(g, 0.18, 'beacon', 4.5, R + 6.45, -8, 8);
  }

  // hose-drying tower: tall narrow box, four storeys, small windows, capped roof
  const { x, z } = TOWER;
  box(g, 2.2, 12, 2.2, 'wallWhite', x, B, z);
  for (const y of [3, 6, 9]) box(g, 2.34, 0.16, 2.34, look.accent, x, B + y - 0.08, z);
  windowGrid(g, { face: '+z', cx: x, cz: z, hw: 1.1, hd: 1.1, rows: 4, cols: 1, y0: B + 1.0, pitchY: 3, winW: 0.6, winH: 0.9 });
  windowGrid(g, { face: '+x', cx: x, cz: z, hw: 1.1, hd: 1.1, rows: 4, cols: 1, y0: B + 1.0, pitchY: 3, winW: 0.6, winH: 0.9 });
  box(g, 2.5, 0.2, 2.5, 'wallWhite', x, B + 12, z);
  hipRoof(g, 2.5, 2.5, 0.9, look.roof, x, B + 12.2, z);
  // hose rails outside the tower with hose hanging to dry
  for (const y of [6.5, 9.5]) {
    rod(g, { x: x + 1.1, y: B + y, z }, { x: x + 1.8, y: B + y, z }, 0.06, 'steel', 6);
    rod(g, { x: x + 1.7, y: B + y, z }, { x: x + 1.7, y: B + y - 1.8, z }, 0.07, 'red', 6);
  }

  // power bracket: post on the roof front-right, arm, insulator
  const px = 5.8;
  const pz = -1.9;
  cyl(g, 0.08, 0.08, 0.55, 'steel', px, R, pz, 6);
  rod(g, { x: px, y: R + 0.35, z: pz }, { x: px + 0.8, y: R + 0.35, z: pz }, 0.06, 'steel', 6);
  return insulator(g, px + 0.8, R + 0.35, pz, 3);
}

/** Station building: two storeys, three bays on the front, glowing windows and sign. */
function station(g: THREE.Object3D, look: Look): void {
  const w = look.wall;

  // ground floor shell: back and side walls, front pillars and lintel (bays are open pockets)
  box(g, 14, 3.6, 0.6, w, 0, B, BACK_Z + 0.3);
  box(g, 0.6, 3.6, 10, w, -6.7, B, SZ);
  box(g, 0.6, 3.6, 10, w, 6.7, B, SZ);
  for (const [x, pw] of [
    [-6.55, 0.9],
    [-2.15, 0.7],
    [2.15, 0.7],
    [6.55, 0.9],
  ] as const) {
    box(g, pw, 3.2, 0.6, w, x, B, FRONT_Z - 0.3);
  }
  box(g, 14, 0.4, 0.6, w, 0, B + 3.2, FRONT_Z - 0.3);

  // white string course, upper floor, cornice, roof slab
  box(g, 14.3, 0.2, 10.3, 'wallWhite', 0, GT, SZ);
  box(g, 14, 3.2, 10, w, 0, UB, SZ);
  box(g, 14.4, 0.25, 10.4, 'wallWhite', 0, CB, SZ);
  box(g, 13.6, 0.08, 9.6, 'roofInk', 0, RB, SZ);

  // upper floor glow windows on front and both sides
  windowGrid(g, { face: '+z', cx: 0, cz: SZ, hw: 7, hd: 5, rows: 1, cols: 4, y0: UB + 0.4, pitchY: 1, winW: 1.2, winH: 1.2, frames: true });
  windowGrid(g, { face: '-x', cx: 0, cz: SZ, hw: 7, hd: 5, rows: 1, cols: 3, y0: UB + 0.4, pitchY: 1, winW: 1.2, winH: 1.2, frames: true });
  windowGrid(g, { face: '+x', cx: 0, cz: SZ, hw: 7, hd: 5, rows: 1, cols: 3, y0: UB + 0.4, pitchY: 1, winW: 1.2, winH: 1.2, frames: true });

  // glowing station sign above the bays, with a red cross
  box(g, 10, 0.6, 0.12, 'glow', 0, 5.9, FRONT_Z + 0.06);
  box(g, 0.14, 0.46, 0.04, 'red', 0, 5.97, -0.85);
  box(g, 0.46, 0.14, 0.04, 'red', 0, 6.13, -0.85);

  // roller doors on the two outer bays (steel, horizontal ink ribs), open centre bay
  for (const x of [BAYS[0], BAYS[2]]) {
    box(g, BAY_W, 3.2, 0.1, 'steelDark', x, B, FRONT_Z + 0.03);
    for (let i = 0; i < 6; i++) box(g, BAY_W - 0.04, 0.07, 0.1, 'ink', x, B + 0.4 + i * 0.45, FRONT_Z + 0.1);
  }
  // bay-door top lights under each lintel
  for (const x of BAYS) box(g, 3.2, 0.1, 0.1, 'glow', x, 3.36, FRONT_Z);
  // a concrete step in front of every bay
  for (const x of BAYS) box(g, 3.8, 0.12, 0.5, 'concrete', x, B, -0.67);

  // roof extras: radio/radar and HVAC are added by roofKit
}

/** Small dispatch annex, back-left, with its own door, step, windows and antenna. */
function annex(g: THREE.Object3D): void {
  const { x, z } = ANNEX;
  box(g, 3.0, 2.8, 3.4, 'wallCream', x, B, z);
  box(g, 3.2, 0.2, 3.6, 'roofSand', x, B + 2.8, z);
  windowGrid(g, { face: '+z', cx: x, cz: z, hw: 1.5, hd: 1.7, rows: 1, cols: 2, y0: B + 1.1, pitchY: 1, winW: 0.8, winH: 1.0, frames: true });
  windowGrid(g, { face: '-x', cx: x, cz: z, hw: 1.5, hd: 1.7, rows: 1, cols: 2, y0: B + 1.1, pitchY: 1, winW: 0.8, winH: 1.0, frames: true });
  box(g, 1.0, 2.0, 0.1, 'red', x, B, z + 1.75);
  box(g, 1.3, 0.12, 0.5, 'concrete', x, B, z + 2.05);
  cyl(g, 0.04, 0.04, 1.0, 'steel', x + 1.0, B + 3.0, z, 6);
}

/** Apron, parking lines, bollards, flagpole, fuel island with canopy. */
function site(g: THREE.Object3D): void {
  // the lot slab (footprint minus margin) and the apron in front of the bays
  box(g, 22.4, B, 22.4, 'concrete', 0, 0, 0);
  box(g, 16, 0.06, 11, 'paving', 0, B, 4.5);
  for (const x of [-6.6, -2.4, 2.4, 6.6]) box(g, 0.12, 0.01, 9.2, 'wallWhite', x, APRON, 4.8);

  // yellow bollards at the apron corners
  for (const [x, z] of [
    [-8.4, 9.4],
    [8.4, 9.4],
    [-8.4, -0.4],
    [8.4, -0.4],
  ]) {
    cyl(g, 0.14, 0.14, 0.9, 'yellow', x, B, z, 10);
    cyl(g, 0.16, 0.16, 0.1, 'ink', x, B + 0.8, z, 10);
  }

  // flagpole with a red flag and white cross
  const fx = -9.2;
  const fz = -4.0;
  box(g, 0.6, 0.2, 0.6, 'concrete', fx, B, fz);
  cyl(g, 0.06, 0.06, 7.0, 'steel', fx, B + 0.2, fz, 8);
  sphere(g, 0.1, 'steel', fx, B + 7.25, fz, 8);
  box(g, 1.4, 0.9, 0.04, 'red', fx + 0.76, B + 5.9, fz);
  box(g, 0.16, 0.6, 0.06, 'wallWhite', fx + 0.76, B + 6.05, fz);
  box(g, 0.9, 0.16, 0.06, 'wallWhite', fx + 0.76, B + 6.27, fz);

  // fuel island with a canopy and a hose
  const px = -9.8;
  const pz = 1.0;
  box(g, 1.8, 0.15, 1.2, 'concrete', px, B, pz);
  box(g, 0.5, 1.3, 0.35, 'orange', px, B + 0.15, pz);
  box(g, 0.56, 0.1, 0.4, 'ink', px, B + 1.45, pz);
  box(g, 0.34, 0.22, 0.04, 'glow', px, B + 0.95, pz + 0.195);
  rod(g, { x: px + 0.25, y: B + 0.7, z: pz + 0.1 }, { x: px + 0.85, y: B + 0.18, z: pz + 0.35 }, 0.03, 'ink', 6);
  for (const dx of [-1.1, 1.1]) {
    for (const dz of [-0.8, 0.8]) cyl(g, 0.08, 0.08, 3.15, 'steel', px + dx, B + 0.15, pz + dz, 6);
  }
  box(g, 2.6, 0.2, 2.0, 'roofCoral', px, B + 3.3, pz);
}

/** Power port: insulator on a roof bracket near the front-right corner, about 8 m up. */
export const build: ModelBuilder = ({ variant }) => {
  const look = variant === 1 ? POLICE_LOOK : FIRE_LOOK;
  const g = new THREE.Group();

  site(g);
  station(g, look);
  annex(g);
  const port = roofKit(g, look);

  // apparatus: vehicle on the apron, vehicle inside the open centre bay
  apparatus(g, look.rescue ? 'rescue' : 'fire', -4.5, 4.5, APRON);
  ambulance(g, look, 4.5, 4.5, APRON);
  apparatus(g, look.rescue ? 'rescue' : 'fire', 0, -5.9, B);

  setPowerPorts(g, [port]);
  return g;
};
