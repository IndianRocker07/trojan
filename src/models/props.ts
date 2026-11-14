import * as THREE from 'three';
import { MAT, type MatName } from '../render/palette';
import { box, cyl, rod, sphere } from './kit';

/**
 * Street props: trees, street lights and cars. Not buildings, so no VARIANTS/build;
 * index.ts re-exports buildTree, buildStreetLight and buildCar.
 * Origin = ground-level centre, Y up. Cars and lights face +X.
 */

const mod3 = (n: number) => ((n % 3) + 3) % 3;

/** Tapered stem from a to b: rA at a, rB at b (palm trunk). */
function taper(
  parent: THREE.Object3D,
  a: THREE.Vector3Like,
  b: THREE.Vector3Like,
  rA: number,
  rB: number,
  mat: MatName,
  segments = 8,
): void {
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  const dir = vb.clone().sub(va);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rB, rA, dir.length(), segments), MAT[mat]);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  parent.add(m);
}

/** Flat drooping palm frond: blade base at `base`, heading `angle` around Y, dropping by `droop`. */
function frond(
  parent: THREE.Object3D,
  base: THREE.Vector3Like,
  angle: number,
  droop: number,
  len: number,
  mat: MatName,
): void {
  const geo = new THREE.BoxGeometry(0.6, 0.06, len);
  geo.translate(0, 0, len / 2); // base at origin, tip at +Z
  const m = new THREE.Mesh(geo, MAT[mat]);
  const dir = new THREE.Vector3(Math.cos(angle), -droop, Math.sin(angle)).normalize();
  m.position.set(base.x, base.y, base.z);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  parent.add(m);
}

/** Round deciduous, conifer, or palm. Height 5-9 m. */
export function buildTree(variant: number): THREE.Group {
  const g = new THREE.Group();
  const v = mod3(variant);
  if (v === 0) {
    // Round deciduous: tapered wood trunk under three overlapping canopy balls.
    cyl(g, 0.22, 0.34, 3.0, 'wood', 0, 0, 0, 8);
    sphere(g, 2.4, 'green', 0, 4.9, 0, 9);
    sphere(g, 1.9, 'roofGreen', 1.4, 4.2, 0.5, 8);
    sphere(g, 1.7, 'green', -1.2, 4.4, -0.9, 8);
  } else if (v === 1) {
    // Conifer: slim trunk, three stacked cones, lightest tier on top.
    cyl(g, 0.18, 0.26, 1.8, 'wood', 0, 0, 0, 8);
    cyl(g, 0, 2.0, 2.8, 'roofGreen', 0, 1.2, 0, 10);
    cyl(g, 0, 1.6, 2.5, 'roofGreen', 0, 2.9, 0, 10);
    cyl(g, 0, 1.15, 2.3, 'green', 0, 4.6, 0, 10);
  } else {
    // Palm: leaning tall trunk, coconut cluster, five drooping fronds.
    const top = { x: 0.5, y: 6.8, z: 0.2 };
    taper(g, { x: 0, y: 0, z: 0 }, top, 0.26, 0.16, 'wood', 8);
    sphere(g, 0.2, 'wood', top.x + 0.12, top.y - 0.22, top.z + 0.1, 8);
    sphere(g, 0.2, 'wood', top.x - 0.1, top.y - 0.25, top.z - 0.08, 8);
    for (let i = 0; i < 5; i++) {
      frond(g, top, (i / 5) * Math.PI * 2 + 0.3, 0.7, 2.2, 'green');
    }
  }
  return g;
}

/** 7 m steel street light on a base plate, two-rod arm reaching +X, lamp head with glow lens. */
export function buildStreetLight(): THREE.Group {
  const g = new THREE.Group();
  box(g, 0.9, 0.1, 0.9, 'steelDark', 0, 0, 0); // base plate
  cyl(g, 0.16, 0.2, 0.5, 'steelDark', 0, 0.1, 0, 10); // base collar
  cyl(g, 0.07, 0.11, 6.4, 'steel', 0, 0.6, 0, 10); // pole, top at 7.0 m
  rod(g, { x: 0, y: 6.7, z: 0 }, { x: 0.75, y: 7.1, z: 0 }, 0.07, 'steel', 6); // arm, rising
  rod(g, { x: 0.75, y: 7.1, z: 0 }, { x: 1.5, y: 6.8, z: 0 }, 0.07, 'steel', 6); // arm, dropping to lamp
  box(g, 0.8, 0.16, 0.44, 'steelDark', 1.5, 6.6, 0); // lamp housing
  box(g, 0.66, 0.05, 0.3, 'glow', 1.5, 6.55, 0); // lens underneath
  return g;
}

const CAR_BODY: MatName[] = ['wallCoral', 'wallBlue', 'wallYellow'];

/** Ink tyre on its side. (x, z) = axle position, outer face sits just proud of the body. */
function wheel(g: THREE.Object3D, x: number, z: number): void {
  const m = cyl(g, 0.33, 0.33, 0.24, 'ink', 0, 0, 0, 12);
  m.rotation.x = Math.PI / 2; // axis along Z
  m.position.set(x, 0.33, z);
}

/** Hatchback, 4.2 x 1.8 m, short sloped-looking cabin. */
function hatchback(g: THREE.Group, body: MatName): void {
  box(g, 4.2, 0.7, 1.8, body, 0, 0.22, 0); // chassis
  box(g, 2.1, 0.48, 1.56, 'glass', -0.2, 0.92, 0); // greenhouse
  box(g, 1.8, 0.06, 1.6, body, -0.2, 1.4, 0); // roof
  box(g, 0.1, 0.14, 1.7, 'ink', 2.12, 0.26, 0); // front bumper
  box(g, 0.1, 0.14, 1.7, 'ink', -2.12, 0.26, 0); // rear bumper
  for (const z of [-0.58, 0.58]) {
    box(g, 0.05, 0.12, 0.28, 'glow', 2.12, 0.6, z); // headlight
    box(g, 0.05, 0.12, 0.28, 'red', -2.12, 0.6, z); // tail light
  }
  for (const x of [-1.3, 1.3]) for (const z of [-0.84, 0.84]) wheel(g, x, z);
}

/** Sedan, 4.2 x 1.8 m, longer cabin with a raised boot. */
function sedan(g: THREE.Group, body: MatName): void {
  box(g, 4.2, 0.7, 1.8, body, 0, 0.22, 0); // chassis
  box(g, 1.75, 0.5, 1.56, 'glass', -0.12, 0.92, 0); // greenhouse
  box(g, 1.5, 0.06, 1.6, body, -0.15, 1.42, 0); // roof
  box(g, 1.0, 0.14, 1.7, body, -1.6, 0.92, 0); // boot lid
  box(g, 0.1, 0.14, 1.7, 'ink', 2.12, 0.26, 0); // front bumper
  box(g, 0.1, 0.14, 1.7, 'ink', -2.12, 0.26, 0); // rear bumper
  for (const z of [-0.58, 0.58]) {
    box(g, 0.05, 0.12, 0.28, 'glow', 2.12, 0.6, z); // headlight
    box(g, 0.05, 0.12, 0.28, 'red', -2.12, 0.6, z); // tail light
  }
  for (const x of [-1.3, 1.3]) for (const z of [-0.84, 0.84]) wheel(g, x, z);
}

/** Delivery van, 5 x 2 m: tall windowless cargo box, short cab with windscreen. */
function van(g: THREE.Group, body: MatName): void {
  box(g, 5.0, 0.5, 1.96, body, 0, 0.3, 0); // lower body
  box(g, 3.25, 1.4, 1.96, body, -0.875, 0.8, 0); // cargo box
  box(g, 1.75, 0.9, 1.96, body, 1.625, 0.8, 0); // cab
  box(g, 0.05, 0.42, 1.2, 'glass', 2.51, 1.0, 0); // windscreen
  for (const z of [-0.99, 0.99]) box(g, 0.9, 0.4, 0.04, 'glass', 1.6, 1.0, z); // cab side windows
  box(g, 0.1, 0.16, 1.9, 'ink', 2.55, 0.34, 0); // front bumper
  for (const z of [-0.7, 0.7]) {
    box(g, 0.05, 0.14, 0.26, 'glow', 2.52, 0.85, z); // headlight
    box(g, 0.05, 0.16, 0.3, 'red', -2.51, 1.9, z); // tail light
  }
  for (const x of [-1.6, 1.8]) for (const z of [-0.92, 0.92]) wheel(g, x, z);
}

/** Hatchback (0), sedan (1) or delivery van (2), real scale, front faces +X. */
export function buildCar(variant: number): THREE.Group {
  const g = new THREE.Group();
  const v = mod3(variant);
  const body = CAR_BODY[v];
  if (v === 0) hatchback(g, body);
  else if (v === 1) sedan(g, body);
  else van(g, body);
  return g;
}
