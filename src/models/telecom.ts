import * as THREE from 'three';
import { box, cyl, rod, sphere, railing, insulator, setPowerPorts, type ModelBuilder } from './kit';
import { MAT, type MatName } from '../render/palette';

/**
 * Telecom site (mobile / cell tower). Footprint 1x1 cell = 12 x 12 m.
 *  0: 3-legged steel lattice tower, ~32 m, red/white painted sections, antenna platform,
 *     cable ladder, sector panels, two microwave dishes, lightning rod and two beacons.
 *  1: 28 m tapered monopole with a triangular antenna head frame.
 * Both share the same compound: slab + gravel, equipment shelter, battery cabinet,
 * diesel genset, fence with gate, and a power insulator on a pole at the front corner.
 */

export const VARIANTS = 2;

type P = { x: number; y: number; z: number };

const DEG = Math.PI / 180;
const GROUND = 0.13; // top of the gravel slab
const BASE = 0.25; // top of the footings: tower / monopole starts here
const FENCE_S = 4.6; // compound half-size (m)
const FENCE_H = 1.6;

/** Point at angle `deg` (x = cos, z = sin; front = +Z is 90), radius r, height y. */
const pt = (deg: number, r: number, y: number): P => ({
  x: r * Math.cos(deg * DEG),
  y,
  z: r * Math.sin(deg * DEG),
});

/** Lattice legs. The face between 30 and 150 points at the viewer (+Z). */
const LEGS = [30, 150, 270];

// Lattice geometry
const SEC = 3.2; // section height (~3 m)
const N_SEC = 9;
const LAT_H = SEC * N_SEC; // 28.8 m
const TOP = BASE + LAT_H;
const R_BASE = 2.4;
const R_TOP = 0.9;
const latR = (y: number) => R_BASE + (R_TOP - R_BASE) * ((y - BASE) / LAT_H); // linear taper

// Antenna platform (triangular deck on the lattice top)
const DECK_R = 1.3;
const DECK_T = TOP + 0.15; // deck top surface

// Cable ladder up the front-right leg
const LADDER_LEG = 30;
const LADDER_OFF = 0.42;

/** Point on the cable ladder at height y; side -1/+1 selects the left/right rail. */
function ladderPt(y: number, side: number): P {
  const a = LADDER_LEG * DEG;
  const r = latR(y) + LADDER_OFF;
  const tx = -Math.sin(a);
  const tz = Math.cos(a);
  return { x: r * Math.cos(a) + side * 0.16 * tx, y, z: r * Math.sin(a) + side * 0.16 * tz };
}

/** Sector panel on the outward face at angle deg: depth runs along the outward normal. */
function panel(
  g: THREE.Group,
  deg: number,
  r: number,
  y: number,
  w: number,
  h: number,
  d: number,
  mat: MatName,
): THREE.Mesh {
  const m = box(g, w, h, d, mat, r * Math.cos(deg * DEG), y, r * Math.sin(deg * DEG));
  m.rotation.y = Math.PI / 2 - deg * DEG; // local +Z -> outward normal at deg
  return m;
}

/** Fence run between two ground points: posts ~2.3 m apart, mid rail and top rail. */
function fenceRun(g: THREE.Group, ax: number, az: number, bx: number, bz: number): void {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.max(2, Math.round(len / 2.3) + 1);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    rod(g, { x, y: GROUND, z }, { x, y: GROUND + FENCE_H, z }, 0.045, 'ink', 5);
  }
  rod(g, { x: ax, y: GROUND + 0.7, z: az }, { x: bx, y: GROUND + 0.7, z: bz }, 0.035, 'ink', 4);
  rod(g, { x: ax, y: GROUND + FENCE_H, z: az }, { x: bx, y: GROUND + FENCE_H, z: bz }, 0.045, 'ink', 4);
}

/**
 * Shared compound: lot slab, gravel, shelter, battery cabinet, genset, fence with gate,
 * and the power pole with its insulator at the front-right corner. Returns the power port.
 */
function compound(g: THREE.Group): P {
  // Lot slab (10.4 m, 0.6 m inside the footprint edge) and gravel bed on top of it
  box(g, 10.4, 0.1, 10.4, 'paving', 0, 0, 0);
  box(g, 9.2, 0.03, 9.2, 'concrete', 0, 0.1, 0);

  // Equipment shelter, back-left of the compound
  const sx = -2.5;
  const sz = -2.9;
  box(g, 3.0, 2.5, 2.4, 'wallSand', sx, GROUND, sz);
  box(g, 3.3, 0.18, 2.7, 'concrete', sx, GROUND + 2.5, sz); // roof slab with eaves
  cyl(g, 0.12, 0.12, 0.35, 'steel', -3.2, GROUND + 2.68, -3.3, 8); // roof vent
  box(g, 0.9, 2.0, 0.08, 'steelDark', sx, GROUND + 0.15, -1.66); // door
  box(g, 1.3, 0.15, 0.5, 'concrete', sx, GROUND, -1.45); // door step
  for (const x of [-3.7, -3.35, -1.65]) box(g, 0.14, 0.14, 0.03, 'glow', x, GROUND + 2.1, -1.69); // status lights
  box(g, 0.03, 0.6, 0.9, 'glow', -4.01, GROUND + 1.2, sz); // side window (left wall)
  box(g, 0.5, 0.8, 0.9, 'steel', -0.75, GROUND + 0.9, sz); // AC unit on the right wall
  box(g, 0.03, 0.55, 0.7, 'ink', -0.49, GROUND + 1.05, sz); // AC grille

  // Battery / backup cabinet, front-left, on a concrete plinth
  const bx = -3.1;
  const bz = 2.6;
  const cy = GROUND + 0.12;
  box(g, 1.7, 0.12, 1.2, 'concrete', bx, GROUND, bz); // plinth
  box(g, 1.5, 1.3, 1.0, 'steel', bx, cy, bz); // cabinet
  box(g, 1.56, 0.08, 1.06, 'steelDark', bx, cy + 1.3, bz); // lid
  box(g, 1.52, 0.12, 1.02, 'orange', bx, cy + 0.6, bz); // warning band
  for (const y of [cy + 0.2, cy + 0.35]) box(g, 0.9, 0.05, 0.03, 'ink', bx, y, bz + 0.51); // vent slats
  box(g, 0.08, 0.3, 0.05, 'ink', bx, cy + 0.8, bz + 0.52); // handle
  for (const x of [bx - 0.4, bx + 0.4]) box(g, 0.22, 0.12, 0.03, 'glow', x, cy + 1.05, bz + 0.51); // status

  // Diesel genset, front-right: skid, orange canopy, exhaust stack
  const gx = 3.4;
  const gz = 2.8;
  box(g, 2.2, 0.3, 1.3, 'steelDark', gx, GROUND, gz); // skid / fuel base
  box(g, 2.0, 1.0, 1.1, 'orange', gx, GROUND + 0.3, gz); // canopy
  box(g, 2.1, 0.08, 1.2, 'ink', gx, GROUND + 1.3, gz); // canopy lip
  for (const y of [0.7, 0.85, 1.0]) box(g, 0.45, 0.04, 0.03, 'ink', gx, y, gz + 0.56); // louvres
  cyl(g, 0.07, 0.07, 1.1, 'steel', 2.9, GROUND + 1.38, 2.5, 8); // exhaust
  cyl(g, 0.13, 0.13, 0.12, 'ink', 2.9, GROUND + 2.48, 2.5, 8); // rain cap

  // Fence: 4 sides, gate gap in the front (+Z) side
  const S = FENCE_S;
  fenceRun(g, -S, -S, S, -S); // back
  fenceRun(g, -S, -S, -S, S); // left
  fenceRun(g, S, -S, S, S); // right
  fenceRun(g, -S, S, -0.8, S); // front-left
  fenceRun(g, 0.8, S, S, S); // front-right
  // Gate leaf closing the 1.6 m gap
  rod(g, { x: -0.8, y: GROUND + 0.7, z: S }, { x: 0.8, y: GROUND + 0.7, z: S }, 0.035, 'ink', 4);
  rod(g, { x: -0.8, y: GROUND + FENCE_H, z: S }, { x: 0.8, y: GROUND + FENCE_H, z: S }, 0.045, 'ink', 4);
  rod(g, { x: -0.8, y: GROUND, z: S }, { x: 0.8, y: GROUND + FENCE_H, z: S }, 0.03, 'ink', 4);

  // Ground cables: battery -> shelter, genset -> battery (sitting on the gravel)
  const cr = 0.035;
  const cc = GROUND + cr;
  rod(g, { x: bx, y: cc, z: 1.9 }, { x: bx, y: cc, z: -1.7 }, cr, 'ink', 5);
  rod(g, { x: 2.25, y: cc, z: bz }, { x: bx + 0.75, y: cc, z: bz }, cr, 'ink', 5);

  // Power pole at the front-right corner: 6 m insulator stack on a concrete pole
  const px = 3.8;
  const pz = 3.8;
  cyl(g, 0.12, 0.16, 5.4, 'concrete', px, GROUND, pz, 8);
  box(g, 1.2, 0.14, 0.14, 'steelDark', px, 5.3, pz); // cross arm
  return insulator(g, px, GROUND + 5.4, pz, 3);
}

/** Lattice tower: 3 legs, X bracing in every panel, red/white painted sections. */
function lattice(g: THREE.Group): void {
  // Footings under each leg
  for (const a of LEGS) {
    const p = pt(a, R_BASE, GROUND);
    cyl(g, 0.4, 0.4, BASE - GROUND, 'concrete', p.x, GROUND, p.z, 10);
  }

  const secMat = (i: number): MatName => (i % 2 === 0 ? 'red' : 'wallWhite');

  // Legs and X bracing, one painted section at a time
  for (let i = 0; i < N_SEC; i++) {
    const y0 = BASE + i * SEC;
    const y1 = y0 + SEC;
    const mat = secMat(i);
    for (let k = 0; k < 3; k++) {
      const k2 = (k + 1) % 3;
      rod(g, pt(LEGS[k], latR(y0), y0), pt(LEGS[k], latR(y1), y1), 0.085, mat, 6); // leg
      rod(g, pt(LEGS[k], latR(y0), y0), pt(LEGS[k2], latR(y1), y1), 0.05, mat, 5); // brace
      rod(g, pt(LEGS[k2], latR(y0), y0), pt(LEGS[k], latR(y1), y1), 0.05, mat, 5); // brace
    }
  }

  // Horizontal rings at every section joint (the top ring takes the top section's colour)
  for (let i = 0; i <= N_SEC; i++) {
    const y = BASE + i * SEC;
    const mat = secMat(Math.min(i, N_SEC - 1));
    for (let k = 0; k < 3; k++) {
      rod(g, pt(LEGS[k], latR(y), y), pt(LEGS[(k + 1) % 3], latR(y), y), 0.05, mat, 5);
    }
  }

  // Cable ladder up the front-right leg, bracketed to the leg every section
  const yl0 = BASE + 0.4;
  const yl1 = BASE + 23;
  rod(g, ladderPt(yl0, -1), ladderPt(yl1, -1), 0.03, 'steel', 4);
  rod(g, ladderPt(yl0, 1), ladderPt(yl1, 1), 0.03, 'steel', 4);
  for (let y = yl0 + 0.3; y <= yl1; y += 1.5) {
    rod(g, ladderPt(y, -1), ladderPt(y, 1), 0.025, 'steel', 4);
  }
  for (let i = 0; i < 8; i++) {
    const y = yl0 + i * SEC;
    rod(g, pt(LADDER_LEG, latR(y), y), ladderPt(y, 0), 0.025, 'steel', 4);
  }

  // Antenna platform: triangular deck with railing
  const deck = cyl(g, DECK_R, DECK_R, 0.25, 'steel', 0, DECK_T - 0.25, 0, 3);
  deck.rotation.y = Math.PI / 3; // vertices at 30 / 150 / 270, same as the legs
  for (let k = 0; k < 3; k++) {
    railing(g, pt(LEGS[k], DECK_R, DECK_T), pt(LEGS[(k + 1) % 3], DECK_R, DECK_T), 1.0, 'ink');
  }

  // Three sector antenna panels, one pointing out of each face of the platform
  for (const deg of [90, 210, 330]) panel(g, deg, 0.3, DECK_T, 0.8, 2.0, 0.12, 'wallWhite');

  // Two microwave dishes on brackets at the front corners, facing outward
  const UP = new THREE.Vector3(0, 1, 0);
  const AXIS_Z = new THREE.Vector3(0, 0, 1);
  for (const deg of [30, 150]) {
    const a = deg * DEG;
    const dv = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const cx = dv.x * 1.85;
    const cz = dv.z * 1.85;
    const cy = DECK_T + 1.3;
    rod(g, { x: dv.x * 1.1, y: DECK_T, z: dv.z * 1.1 }, { x: dv.x * 1.7, y: cy, z: dv.z * 1.7 }, 0.04, 'steel', 5);

    const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.12, 0.3, 12), MAT.wallWhite);
    dish.position.set(cx, cy, cz);
    dish.quaternion.setFromUnitVectors(UP, dv); // wide face points outward
    g.add(dish);

    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.045, 6, 14), MAT.ink);
    rim.position.set(cx + dv.x * 0.15, cy, cz + dv.z * 0.15);
    rim.quaternion.setFromUnitVectors(AXIS_Z, dv);
    g.add(rim);

    const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.35, 6), MAT.steel);
    feed.position.set(cx + dv.x * 0.325, cy, cz + dv.z * 0.325);
    feed.quaternion.setFromUnitVectors(UP, dv);
    g.add(feed);
  }

  // Feeder cables: three runs from the top of the cable ladder to the deck corner post
  for (const s of [-0.5, 0, 0.5]) {
    const end = pt(LADDER_LEG, 0.95, DECK_T);
    const tx = -Math.sin(LADDER_LEG * DEG);
    const tz = Math.cos(LADDER_LEG * DEG);
    rod(g, ladderPt(yl1, s), { x: end.x + s * 0.12 * tx, y: end.y, z: end.z + s * 0.12 * tz }, 0.03, 'ink', 4);
  }

  // Lightning rod and red beacon at the very top
  rod(g, { x: 0, y: DECK_T, z: 0 }, { x: 0, y: DECK_T + 2.4, z: 0 }, 0.035, 'steel', 5);
  sphere(g, 0.2, 'beacon', 0, DECK_T + 2.6, 0, 10);

  // Mid-height beacon on a bracket off the front-left leg
  const yM = BASE + 14;
  const rM = latR(yM);
  rod(g, pt(150, rM, yM), pt(150, rM + 0.25, yM), 0.035, 'ink', 5);
  const bm = pt(150, rM + 0.36, yM);
  sphere(g, 0.16, 'beacon', bm.x, bm.y, bm.z, 8);
}

/** Monopole: tapered 28 m shaft, painted in alternating sections, with a triangular head frame. */
function monopole(g: THREE.Group): void {
  // Concrete footing and base flange
  cyl(g, 1.0, 1.0, BASE - GROUND, 'concrete', 0, GROUND, 0, 12);
  const MB = BASE + 0.15; // shaft start (above the flange)
  cyl(g, 0.95, 0.95, 0.15, 'steelDark', 0, BASE, 0, 12);

  // Tapered shaft: 7 sections of 4 m, red and white
  const MH = 28;
  const mr = (y: number) => 0.85 + (0.25 - 0.85) * ((y - MB) / MH);
  for (let i = 0; i < 7; i++) {
    const y0 = MB + i * 4;
    const y1 = y0 + 4;
    cyl(g, mr(y1), mr(y0), 4, i % 2 === 0 ? 'red' : 'wallWhite', 0, y0, 0, 12);
  }
  const MT = MB + MH;

  // Triangular antenna head frame around the top of the shaft
  const yA = MT - 3.0;
  const HR = 1.2;
  for (let k = 0; k < 3; k++) {
    const a = LEGS[k];
    const b = LEGS[(k + 1) % 3];
    rod(g, pt(a, HR, yA), pt(a, HR, MT), 0.06, 'steelDark', 5); // corner post
    rod(g, pt(a, HR, yA), pt(b, HR, yA), 0.05, 'steelDark', 5); // bottom ring
    rod(g, pt(a, HR, yA + 1.5), pt(b, HR, yA + 1.5), 0.05, 'steelDark', 5); // mid ring
    rod(g, pt(a, HR, MT), pt(b, HR, MT), 0.05, 'steelDark', 5); // top ring
    rod(g, pt(a, HR, yA), pt(b, HR, MT), 0.04, 'steelDark', 5); // X brace
    rod(g, pt(b, HR, yA), pt(a, HR, MT), 0.04, 'steelDark', 5); // X brace
  }
  // Sector panels on the head frame, one per face, outward
  for (const deg of [90, 210, 330]) panel(g, deg, 0.72, yA + 0.5, 0.8, 2.0, 0.12, 'wallWhite');

  // Lightning rod and red beacon on top
  rod(g, { x: 0, y: MT, z: 0 }, { x: 0, y: MT + 2.0, z: 0 }, 0.035, 'steel', 5);
  sphere(g, 0.2, 'beacon', 0, MT + 2.2, 0, 10);

  // Mid-height beacon on a bracket off the shaft (back side)
  const yM = MB + 14;
  const rM = mr(yM);
  rod(g, pt(270, rM, yM), pt(270, rM + 0.25, yM), 0.035, 'ink', 5);
  const bm = pt(270, rM + 0.36, yM);
  sphere(g, 0.16, 'beacon', bm.x, bm.y, bm.z, 8);
}

/** Signature every model module exports as `build`. */
export const build: ModelBuilder = ({ variant }) => {
  const g = new THREE.Group();
  const port = compound(g);
  if (variant === 1) monopole(g);
  else lattice(g);
  setPowerPorts(g, [port]);
  return g;
};
