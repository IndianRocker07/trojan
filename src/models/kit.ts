import * as THREE from 'three';
import { MAT, type MatName } from '../render/palette';

/**
 * Model kit — the only primitives model builders should need.
 * Conventions (SPEC.md §5):
 *  - origin = centre of the footprint at ground level, Y up, front faces +Z
 *  - 1 unit = 1 m; a footprint of w×d cells spans (w*CELL)×(d*CELL) metres;
 *    stay ~1 m inside the footprint edge
 *  - materials ONLY from MAT (pass the name)
 *  - role 'glow' meshes light up when powered; 'beacon' blinks; userData.spin rotates
 */

export type Role = 'static' | 'glow' | 'beacon';

export interface SpinSpec {
  axis: 'x' | 'y' | 'z';
  speed: number; // rad/s
}

function tag(mesh: THREE.Mesh, mat: MatName, role?: Role): THREE.Mesh {
  if (role) mesh.userData.role = role;
  else if (mat === 'glow') mesh.userData.role = 'glow';
  else if (mat === 'beacon') mesh.userData.role = 'beacon';
  return mesh;
}

/** Axis-aligned box. (x,y,z) is the centre of the BOTTOM face, so y=0 sits on the ground. */
export function box(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  mat: MatName,
  x = 0,
  y = 0,
  z = 0,
  role?: Role,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), MAT[mat]);
  m.position.set(x, y + h / 2, z);
  parent.add(tag(m, mat, role));
  return m;
}

/** Vertical cylinder. (x,y,z) is the centre of the bottom cap. */
export function cyl(
  parent: THREE.Object3D,
  rTop: number,
  rBottom: number,
  h: number,
  mat: MatName,
  x = 0,
  y = 0,
  z = 0,
  segments = 16,
  role?: Role,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, segments), MAT[mat]);
  m.position.set(x, y + h / 2, z);
  parent.add(tag(m, mat, role));
  return m;
}

/** Cylinder between two arbitrary points (pipes, struts, braces, rails). */
export function rod(
  parent: THREE.Object3D,
  a: THREE.Vector3Like,
  b: THREE.Vector3Like,
  r: number,
  mat: MatName,
  segments = 8,
): THREE.Mesh {
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  const len = va.distanceTo(vb);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, segments), MAT[mat]);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  parent.add(tag(m, mat));
  return m;
}

export function sphere(
  parent: THREE.Object3D,
  r: number,
  mat: MatName,
  x = 0,
  y = 0,
  z = 0,
  segments = 16,
  role?: Role,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, segments, Math.max(6, segments >> 1)), MAT[mat]);
  m.position.set(x, y, z);
  parent.add(tag(m, mat, role));
  return m;
}

/**
 * Gable roof: a triangular prism. Ridge runs along X. (x,y,z) = centre of the eaves base.
 * overhang extends the roof beyond the w×d wall box.
 */
export function gableRoof(
  parent: THREE.Object3D,
  w: number,
  d: number,
  h: number,
  mat: MatName,
  x = 0,
  y = 0,
  z = 0,
  overhang = 0.4,
): THREE.Mesh {
  const hw = w / 2 + overhang;
  const hd = d / 2 + overhang;
  const shape = new THREE.Shape();
  shape.moveTo(-hd, 0);
  shape.lineTo(hd, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: hw * 2, bevelEnabled: false });
  geo.translate(0, 0, -hw);
  geo.rotateY(Math.PI / 2); // ridge along X
  const m = new THREE.Mesh(geo, MAT[mat]);
  m.position.set(x, y, z);
  parent.add(tag(m, mat));
  return m;
}

/** Hip / pyramid roof (4 sloped faces). (x,y,z) = centre of base. */
export function hipRoof(
  parent: THREE.Object3D,
  w: number,
  d: number,
  h: number,
  mat: MatName,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const geo = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
  geo.rotateY(Math.PI / 4);
  geo.scale(w, h, d);
  geo.translate(0, h / 2, 0);
  const m = new THREE.Mesh(geo, MAT[mat]);
  m.position.set(x, y, z);
  parent.add(tag(m, mat));
  return m;
}

export type Face = '+x' | '-x' | '+z' | '-z';

export interface WindowGridOpts {
  face: Face;
  /** Wall box this grid sits on: centre (cx,cz), half extents (hw along X, hd along Z). */
  cx?: number;
  cz?: number;
  hw: number;
  hd: number;
  rows: number;
  cols: number;
  /** Bottom of the first row, row pitch, window size. */
  y0: number;
  pitchY: number;
  winW: number;
  winH: number;
  /** Horizontal span used by the columns (defaults to 80% of the face). */
  span?: number;
  /** Add an ink frame + sill per window (more detail, more parts). */
  frames?: boolean;
  /** Skip some windows, e.g. (r,c) => r===0 && c===2 for a door slot. */
  skip?: (r: number, c: number) => boolean;
}

/**
 * Grid of glow windows on one face of a wall box. Each window is a thin glow pane
 * that sits 0.05 m proud of the wall, with an optional ink frame and sill.
 */
export function windowGrid(parent: THREE.Object3D, o: WindowGridOpts): void {
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  const alongX = o.face === '+z' || o.face === '-z';
  const faceHalf = alongX ? o.hw : o.hd;
  const span = o.span ?? faceHalf * 2 * 0.8;
  const step = o.cols > 1 ? span / (o.cols - 1) : 0;
  const sign = o.face[0] === '+' ? 1 : -1;
  const off = (alongX ? o.hd : o.hw) + 0.05;
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      if (o.skip?.(r, c)) continue;
      const t = o.cols > 1 ? -span / 2 + c * step : 0;
      const y = o.y0 + r * o.pitchY;
      const px = alongX ? cx + t : cx + sign * off;
      const pz = alongX ? cz + sign * off : cz + t;
      const pw = alongX ? o.winW : 0.1;
      const pd = alongX ? 0.1 : o.winW;
      box(parent, pw, o.winH, pd, 'glow', px, y, pz);
      if (o.frames) {
        // sill below + lintel above, slightly wider, ink
        const fw = alongX ? o.winW + 0.3 : 0.18;
        const fd = alongX ? 0.18 : o.winW + 0.3;
        const fx = alongX ? px : cx + sign * (off + 0.04);
        const fz = alongX ? cz + sign * (off + 0.04) : pz;
        box(parent, fw, 0.14, fd, 'ink', fx, y - 0.14, fz);
        box(parent, fw, 0.1, fd, 'ink', fx, y + o.winH, fz);
      }
    }
  }
}

/** Mark an object to spin around its local axis (turbines, fans, radar). */
export function spin(obj: THREE.Object3D, axis: SpinSpec['axis'], speed: number): THREE.Object3D {
  obj.userData.spin = { axis, speed } satisfies SpinSpec;
  return obj;
}

/** Simple railing along a straight line at height y (posts every ~1.2 m + top rail). */
export function railing(
  parent: THREE.Object3D,
  a: THREE.Vector3Like,
  b: THREE.Vector3Like,
  h = 1,
  mat: MatName = 'ink',
): void {
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  const n = Math.max(2, Math.round(va.distanceTo(vb) / 1.2) + 1);
  for (let i = 0; i < n; i++) {
    const p = va.clone().lerp(vb, i / (n - 1));
    rod(parent, p, p.clone().setY(p.y + h), 0.05, mat, 5);
  }
  rod(parent, va.clone().setY(va.y + h), vb.clone().setY(vb.y + h), 0.06, mat, 5);
}

/** Vertical ladder on a wall/tank: two stiles + rungs. */
export function ladder(
  parent: THREE.Object3D,
  x: number,
  z: number,
  y0: number,
  y1: number,
  facing: Face = '+z',
  mat: MatName = 'ink',
): void {
  const alongX = facing === '+z' || facing === '-z';
  const dx = alongX ? 0.25 : 0;
  const dz = alongX ? 0 : 0.25;
  rod(parent, { x: x - dx, y: y0, z: z - dz }, { x: x - dx, y: y1, z: z - dz }, 0.04, mat, 5);
  rod(parent, { x: x + dx, y: y0, z: z + dz }, { x: x + dx, y: y1, z: z + dz }, 0.04, mat, 5);
  for (let y = y0 + 0.3; y < y1; y += 0.35) {
    rod(parent, { x: x - dx, y, z: z - dz }, { x: x + dx, y, z: z + dz }, 0.03, mat, 4);
  }
}

/** Declare where incoming power lines attach (local coords). Call once per model. */
export function setPowerPorts(group: THREE.Group, ports: THREE.Vector3Like[]): void {
  group.userData.powerPorts = ports.map((p) => new THREE.Vector3(p.x, p.y, p.z));
}

/**
 * Substations & generators only: where OUTGOING lines leave (local coords).
 * Generator: HV transmission out. Substation: distribution feeders out.
 */
export function setOutPorts(group: THREE.Group, ports: THREE.Vector3Like[]): void {
  group.userData.outPorts = ports.map((p) => new THREE.Vector3(p.x, p.y, p.z));
}

/** Insulator stack: small ink discs on a post — use at power ports. Returns top point. */
export function insulator(parent: THREE.Object3D, x: number, y: number, z: number, discs = 3): THREE.Vector3 {
  for (let i = 0; i < discs; i++) cyl(parent, 0.22, 0.22, 0.08, 'ink', x, y + i * 0.2, z, 10);
  cyl(parent, 0.05, 0.05, discs * 0.2, 'steel', x, y, z, 6);
  return new THREE.Vector3(x, y + discs * 0.2, z);
}

/** Deterministic per-model RNG so variants are stable. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Signature every model module exports as `build`. */
export interface BuildOpts {
  variant: number;
  seed: number;
}
export type ModelBuilder = (opts: BuildOpts) => THREE.Group;
