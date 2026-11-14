import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAT } from '../render/palette';
import { POLE_HEIGHT, PYLON_HEIGHT } from '../core/constants';
import { box, cyl, insulator, rod, sphere } from './kit';

/**
 * Transmission pylon and distribution pole.
 * Origin = base centre on the ground, Y up. Lines run along local +/-Z; arms extend along X.
 * userData.attach = wire attachment points (left, middle, right for the pylon; left, right for the pole).
 */

/** Merge geometries into ONE mesh of the given material (keeps the mesh count inside budget). */
function mergedMesh(parent: THREE.Object3D, geos: THREE.BufferGeometry[], mat: 'ink' | 'steel'): void {
  const g = mergeGeometries(geos, false);
  if (!g) throw new Error('pylon: geometry merge failed');
  parent.add(new THREE.Mesh(g, MAT[mat]));
}

/**
 * Hanging suspension string: 10 ink discs (2.0 m, 0.2 m pitch) on a steel post,
 * finished with a steel clamp whose centre is the string tip (= wire attach point).
 * yTop = underside of the cross-arm it hangs from. Returns the tip.
 */
function insulatorString(parent: THREE.Object3D, x: number, yTop: number): THREE.Vector3 {
  const DISCS = 10;
  const PITCH = 0.2;
  const LEN = DISCS * PITCH;
  const discs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < DISCS; i++) {
    discs.push(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 12).translate(x, yTop - 0.1 - i * PITCH, 0));
  }
  const tip = yTop - LEN;
  const steel = [
    new THREE.CylinderGeometry(0.05, 0.05, LEN, 6).translate(x, yTop - LEN / 2, 0),
    new THREE.BoxGeometry(0.22, 0.16, 0.22).translate(x, tip, 0),
  ];
  mergedMesh(parent, discs, 'ink');
  mergedMesh(parent, steel, 'steel');
  return new THREE.Vector3(x, tip, 0);
}

// ---------------------------------------------------------------- pylon

const FOOTING_TOP = 0.5; // top of the concrete footings = bottom of the legs
const WAIST_Y = 12.5;
const TOP_Y = 24;
/** Leg half-width at height y: 2.5 m at the base, 0.7 m at the waist, 0.55 m at the top. */
const hw = (y: number) =>
  y <= WAIST_Y
    ? 2.5 - ((y - FOOTING_TOP) / (WAIST_Y - FOOTING_TOP)) * 1.8
    : 0.7 - ((y - WAIST_Y) / (TOP_Y - WAIST_Y)) * 0.15;

/** Panel nodes (girt rings). Panels are the gaps between consecutive nodes. */
const NODES = [0.5, 4.5, 8.5, 12.5, 15.5, 18.5, 22, 24];
const CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
/** The four faces, each as the pair of corners it spans. */
const FACES: [[number, number], [number, number]][] = [
  [[-1, -1], [1, -1]], // front (-Z)
  [[-1, 1], [1, 1]], // back (+Z)
  [[-1, -1], [-1, 1]], // left (-X)
  [[1, -1], [1, 1]], // right (+X)
];
/** Position of a leg corner at height y. */
const at = (c: [number, number], y: number) => new THREE.Vector3(c[0] * hw(y), y, c[1] * hw(y));

const SIDE_ARM_Y = 18.5;
const SIDE_ARM_HALF = 4.0; // outer conductors at x = +/-4.0
const TOP_ARM_Y = 22;
const WIRE_TIP_OFFSET = 0.07; // strings hang from the underside of a chord (r = 0.07)

export function buildPylon(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'pylon';

  // concrete footings under each leg
  for (const c of CORNERS) box(g, 1.6, FOOTING_TOP, 1.6, 'concrete', c[0] * 2.5, 0, c[1] * 2.5);

  // four legs, one rod per leg per panel
  for (let i = 0; i < NODES.length - 1; i++) {
    for (const c of CORNERS) rod(g, at(c, NODES[i]), at(c, NODES[i + 1]), 0.08, 'steel', 8);
  }

  // horizontal girts: a square ring at every node above the footings
  for (const y of NODES.slice(1)) {
    for (const [a, b] of FACES) rod(g, at(a, y), at(b, y), 0.06, 'steel', 6);
  }

  // X bracing in every panel on every face
  for (let i = 0; i < NODES.length - 1; i++) {
    const y0 = NODES[i];
    const y1 = NODES[i + 1];
    for (const [a, b] of FACES) {
      rod(g, at(a, y0), at(b, y1), 0.05, 'steel', 6);
      rod(g, at(b, y0), at(a, y1), 0.05, 'steel', 6);
    }
  }

  // side arms (outer conductors): top chord, lower chord, and a strut from each lower-chord
  // node up to the chord tip. The chords meet the girt ring on the left/right faces.
  const ya = SIDE_ARM_Y;
  const L = SIDE_ARM_HALF;
  rod(g, { x: -L, y: ya, z: 0 }, { x: L, y: ya, z: 0 }, 0.07, 'steel', 8);
  rod(g, { x: -3.2, y: ya - 0.5, z: 0 }, { x: 3.2, y: ya - 0.5, z: 0 }, 0.06, 'steel', 6);
  for (const s of [-1, 1]) {
    rod(g, { x: s * hw(ya), y: ya - 0.5, z: 0 }, { x: s * L, y: ya, z: 0 }, 0.05, 'steel', 6);
  }

  // top (middle conductor) arm: a flat steel beam resting on the top girt, bottom face at TOP_ARM_Y - 0.07
  box(g, 3.6, 0.14, 0.14, 'steel', 0, TOP_ARM_Y - WIRE_TIP_OFFSET, 0);

  // suspension strings; each returns its tip (the wire attach point)
  const yS = ya - WIRE_TIP_OFFSET;
  const attachLeft = insulatorString(g, -L, yS);
  const attachMiddle = insulatorString(g, 0, TOP_ARM_Y - WIRE_TIP_OFFSET);
  const attachRight = insulatorString(g, L, yS);

  // earth-wire peak: four rods from the top girt to an apex clamp, with a red aviation beacon
  const apexY = PYLON_HEIGHT - 0.3;
  const apex = new THREE.Vector3(0, apexY, 0);
  for (const c of CORNERS) rod(g, at(c, TOP_Y), apex, 0.05, 'steel', 6);
  sphere(g, 0.14, 'steel', 0, apexY, 0, 8);
  sphere(g, 0.12, 'beacon', 0, PYLON_HEIGHT - 0.12, 0, 8);

  // anti-climb guard ring around the legs, tied to each corner by a short spoke
  const RING_Y = 2.6;
  const ringR = hw(RING_Y) * Math.SQRT2 + 0.25;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(ringR, 0.05, 6, 24), MAT.steel);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = RING_Y;
  g.add(ring);
  const k = ringR / Math.SQRT2;
  for (const c of CORNERS) {
    rod(g, at(c, RING_Y), new THREE.Vector3(c[0] * k, RING_Y, c[1] * k), 0.035, 'steel', 6);
  }

  // yellow warning plate on the front-left leg, with an ink backer that touches the leg
  const PLATE_Y = 1.25;
  const ph = hw(PLATE_Y);
  box(g, 0.7, 0.6, 0.1, 'ink', -ph, PLATE_Y - 0.3, -ph - 0.05);
  box(g, 0.6, 0.5, 0.03, 'yellow', -ph, PLATE_Y - 0.25, -ph - 0.115);

  g.userData.attach = [attachLeft, attachMiddle, attachRight];
  return g;
}

// ---------------------------------------------------------------- pole

/**
 * Distribution utility pole, POLE_HEIGHT tall. withTransformer adds a pole-mounted
 * transformer can on the back (-Z) face.
 */
export function buildPole(withTransformer = false): THREE.Group {
  const g = new THREE.Group();
  g.name = 'pole';

  const BASE = 0.2; // the pole stands on a small concrete collar
  /** Pole surface radius at height y (tapers 0.24 m at the base to 0.15 m at the top). */
  const rAt = (y: number) => 0.24 - 0.09 * ((y - BASE) / (POLE_HEIGHT - BASE));

  cyl(g, 0.28, 0.28, BASE, 'concrete', 0, 0, 0, 12);
  cyl(g, 0.15, 0.24, POLE_HEIGHT - BASE, 'wood', 0, BASE, 0, 12);

  // crossarm bolted to the pole's +Z face, 1 m below the top
  const CA_Y = 8.0;
  const CA_H = 0.16;
  const CA_Z = rAt(CA_Y) + CA_H / 2;
  box(g, 2.6, CA_H, CA_H, 'wood', 0, CA_Y, CA_Z);

  // two pin insulators on the crossarm; the returned tops are the wire attach points
  const PIN_X = 1.1;
  const pinLeft = insulator(g, -PIN_X, CA_Y + CA_H, CA_Z, 3);
  const pinRight = insulator(g, PIN_X, CA_Y + CA_H, CA_Z, 3);

  // diagonal braces from the pole to the crossarm underside
  for (const s of [-1, 1]) {
    rod(g, { x: 0, y: 7.4, z: rAt(7.4) - 0.02 }, { x: s * 0.95, y: CA_Y, z: CA_Z }, 0.04, 'wood', 6);
  }

  // streetlight arm on the +X side with a glowing lens facing +X
  const LAMP_Y = 6.8;
  rod(g, { x: rAt(LAMP_Y) - 0.02, y: LAMP_Y, z: 0 }, { x: 1.25, y: 7.08, z: 0 }, 0.04, 'steel', 6);
  box(g, 0.34, 0.16, 0.3, 'ink', 1.25, 7.0, 0);
  box(g, 0.04, 0.12, 0.24, 'glow', 1.43, 7.02, 0);

  // guy wire to a ground anchor on the -X side
  rod(g, { x: -rAt(6.2) + 0.02, y: 6.2, z: 0 }, { x: -2.0, y: 0.5, z: 0 }, 0.025, 'steel', 5);
  box(g, 0.24, 0.5, 0.24, 'steelDark', -2.0, 0, 0);

  if (withTransformer) {
    const TY = 3.2;
    const TH = 0.9;
    const TR = 0.24;
    const zb = -rAt(3.5); // pole back surface
    box(g, 0.14, 0.5, 0.08, 'steel', 0, 3.5, zb - 0.04); // bracket, pole to can
    const cz = zb - 0.08 - TR; // can sits against the bracket
    cyl(g, TR, TR, TH, 'steelDark', 0, TY, cz, 12);
    cyl(g, 0.05, 0.05, 0.22, 'ink', -0.1, TY + TH, cz, 6); // bushings
    cyl(g, 0.05, 0.05, 0.22, 'ink', 0.1, TY + TH, cz, 6);
  }

  g.userData.attach = [pinLeft, pinRight];
  return g;
}
