/**
 * Globe cap mapping of the 48×48 city grid + the static globe layers (background, sphere, atmosphere, dot matrix).
 * docs/STORY.md §1–§2.
 */
import * as THREE from 'three';
import { GRID_COLS, GRID_ROWS } from '../core/constants';
import type { Building, CellStatus, GridCell, Terrain } from '../core/types';
import { PAL } from './palette';

export const R = 100;
/** Half-angle of the city square on the sphere (radians) along each grid axis. */
export const CAP = THREE.MathUtils.degToRad(33);
/** Latitude of the city centre (tilts the cap toward the viewer from above). */
export const TILT = THREE.MathUtils.degToRad(31);
const TILT_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -TILT);

/** Unit direction (globe-local) of continuous grid coords (col, row) ∈ [0, 48]. */
export function gridDir(col: number, row: number, out = new THREE.Vector3()): THREE.Vector3 {
  const x = (col / GRID_COLS) * 2 - 1;
  const y = -((row / GRID_ROWS) * 2 - 1);
  return capDir(x * CAP, y * CAP, out);
}
/** Azimuthal-equidistant (x, y in radians) around the cap centre → unit direction. */
export function capDir(x: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
  const rho = Math.hypot(x, y);
  if (rho < 1e-9) out.set(0, 0, 1);
  else {
    const s = Math.sin(rho) / rho;
    out.set(x * s, y * s, Math.cos(rho));
  }
  return out.applyQuaternion(TILT_Q);
}
/** Inverse of capDir for a globe-local unit direction (used to test 'inside the city square'). */
function dirToCap(d: THREE.Vector3): { x: number; y: number } {
  const v = d.clone().applyQuaternion(TILT_Q.clone().invert());
  const rho = Math.acos(Math.min(1, Math.max(-1, v.z)));
  const h = Math.hypot(v.x, v.y);
  if (h < 1e-9) return { x: 0, y: 0 };
  return { x: (v.x / h) * rho, y: (v.y / h) * rho };
}

/** Building centre in continuous grid coords (rotation-safe: centroid of its cells). */
export function buildingGrid(b: Building): { col: number; row: number } {
  let c = 0, r = 0;
  for (const id of b.cells) {
    c += (id % GRID_COLS) + 0.5;
    r += Math.floor(id / GRID_COLS) + 0.5;
  }
  const n = Math.max(1, b.cells.length);
  return { col: c / n, row: r / n };
}

// cheap deterministic hash / value-noise
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const noise3 = (x: number, y: number, z: number) =>
  Math.sin(3.1 * x + 1.7) * Math.sin(2.7 * y + 0.3) * Math.sin(3.3 * z + 2.1) +
  0.55 * Math.sin(6.3 * x + 4.1 * z + 0.7) * Math.sin(5.7 * y - 2.0 * x + 1.3) +
  0.3 * Math.sin(11.0 * z + 9.0 * y) * Math.sin(12.1 * x + 0.4);

// ─────────────────────────── shaders ───────────────────────────

const BG_VS = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.99999, 1.0); }`;
const BG_FS = /* glsl */ `
uniform vec3 uCenter; uniform vec3 uEdge; uniform vec2 uRes;
varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 p = vUv - vec2(0.42, 0.55);
  p.x *= uRes.x / uRes.y;
  float d = length(p);
  vec3 col = mix(uCenter, uEdge, smoothstep(0.05, 1.05, d));
  // stars: sparse, faint
  vec2 cell = floor(gl_FragCoord.xy / 3.0);
  float s = h(cell);
  float star = step(0.9965, s) * (0.25 + 0.75 * h(cell + 7.1));
  vec2 f = fract(gl_FragCoord.xy / 3.0) - 0.5;
  star *= smoothstep(0.5, 0.0, length(f));
  col += vec3(0.55, 0.6, 1.0) * star * 0.22;
  // dither (no gradient bands)
  col += (h(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

const SPHERE_VS = /* glsl */ `
varying vec3 vN; varying vec3 vV;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const SPHERE_FS = /* glsl */ `
uniform vec3 uLight; uniform vec3 uDay; uniform vec3 uNight; uniform vec3 uRim;
varying vec3 vN; varying vec3 vV;
void main(){
  vec3 n = normalize(vN);
  float lam = dot(n, uLight);
  float fres = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 2.6);
  vec3 col = mix(uNight, uDay, smoothstep(-0.25, 1.0, lam));
  col += uRim * fres * (0.04 + 1.0 * smoothstep(-0.2, 0.85, lam));
  gl_FragColor = vec4(col, 1.0);
}`;
const ATMO_FS = /* glsl */ `
uniform vec3 uLight; uniform vec3 uRim;
varying vec3 vN; varying vec3 vV;
void main(){
  vec3 n = normalize(vN);
  // back faces of the outer shell: k = 0 at the shell's limb, ~0.5 just outside the globe's silhouette
  float k = -dot(n, normalize(vV));
  float i = pow(smoothstep(0.0, 0.5, k), 2.4);
  float lit = 0.06 + 1.1 * smoothstep(-0.25, 0.85, dot(n, uLight));
  vec3 col = uRim * i * lit * 0.9;
  gl_FragColor = vec4(col, 1.0);
}`;

const DOT_VS = /* glsl */ `
attribute vec3 aColor; attribute float aSize;
uniform float uScale; uniform vec3 uLight;
varying vec3 vCol; varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normalize(position));
  float lam = dot(n, uLight);
  float facing = dot(n, normalize(-mv.xyz));
  vCol = aColor * mix(0.035, 0.9, smoothstep(-0.25, 0.9, lam));
  vA = smoothstep(0.02, 0.3, facing);
  gl_PointSize = max(1.0, aSize * uScale / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const DOT_FS = /* glsl */ `
varying vec3 vCol; varying float vA;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.18, d) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
}`;

export interface GlobeUniforms {
  uLight: { value: THREE.Vector3 };
  uScale: { value: number };
}

/** Background + sphere + atmosphere + dot matrix (city cells + surrounding/far land). 4 draw calls. */
export class GlobeLayers {
  readonly group = new THREE.Group();
  readonly bg: THREE.Mesh;
  readonly sphere: THREE.Mesh;
  readonly atmo: THREE.Mesh;
  dots: THREE.Points | null = null;
  private dotMat: THREE.ShaderMaterial;
  private bgMat: THREE.ShaderMaterial;
  /** dot index ranges per cell (for status recolouring) */
  private cellDots: Int32Array = new Int32Array(0);
  private cellDotN: Uint8Array = new Uint8Array(0);
  private cellBase: Float32Array = new Float32Array(0);
  private statusSig = '';

  constructor(private u: GlobeUniforms) {
    this.bgMat = new THREE.ShaderMaterial({
      vertexShader: BG_VS,
      fragmentShader: BG_FS,
      uniforms: { uCenter: { value: PAL.bgCenter.clone() }, uEdge: { value: PAL.bgEdge.clone() }, uRes: { value: new THREE.Vector2(1, 1) } },
      depthTest: false,
      depthWrite: false,
    });
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMat);
    this.bg.frustumCulled = false;
    this.bg.renderOrder = -10;

    const sg = new THREE.SphereGeometry(R, 96, 64);
    this.sphere = new THREE.Mesh(
      sg,
      new THREE.ShaderMaterial({
        vertexShader: SPHERE_VS,
        fragmentShader: SPHERE_FS,
        uniforms: { uLight: u.uLight, uDay: { value: PAL.sphereDay }, uNight: { value: PAL.sphereNight }, uRim: { value: PAL.rim } },
      }),
    );
    this.sphere.renderOrder = -5;
    this.atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.16, 64, 48),
      new THREE.ShaderMaterial({
        vertexShader: SPHERE_VS,
        fragmentShader: ATMO_FS,
        uniforms: { uLight: u.uLight, uRim: { value: PAL.rim } },
        side: THREE.BackSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.dotMat = new THREE.ShaderMaterial({
      vertexShader: DOT_VS,
      fragmentShader: DOT_FS,
      uniforms: { uScale: u.uScale as { value: number }, uLight: u.uLight },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.group.add(this.sphere, this.atmo);
  }

  setResolution(w: number, h: number): void {
    (this.bgMat.uniforms.uRes.value as THREE.Vector2).set(w, h);
  }

  build(cells: GridCell[], buildings: Record<string, Building>): void {
    if (this.dots) {
      this.group.remove(this.dots);
      this.dots.geometry.dispose();
      this.dots = null;
    }
    const pos: number[] = [];
    const col: number[] = [];
    const size: number[] = [];
    const ncell = cells.length;
    this.cellDots = new Int32Array(ncell).fill(-1);
    this.cellDotN = new Uint8Array(ncell);
    this.cellBase = new Float32Array(ncell * 3);
    const v = new THREE.Vector3();
    const tmp = new THREE.Color();
    const push = (d: THREE.Vector3, c: THREE.Color, s: number, alt = 0.25) => {
      pos.push(d.x * (R + alt), d.y * (R + alt), d.z * (R + alt));
      col.push(c.r, c.g, c.b);
      size.push(s);
    };
    // ── city cells: 3×3 dots on land/park, darker 2×2 band on river, sparse on bridges, gaps on roads
    const SUB: Record<Terrain, number> = { land: 3, park: 3, river: 2, bridge: 1, road: 0 };
    for (const c of cells) {
      const n = SUB[c.terrain];
      if (!n) continue;
      const e = Math.min(c.col + 0.5, GRID_COLS - c.col - 0.5, c.row + 0.5, GRID_ROWS - c.row - 0.5);
      const keepEdge = c.buildingId || e > 1.6 + 2.2 * (0.5 + 0.5 * noise3(c.col * 0.17, c.row * 0.17, 0.3));
      const start = pos.length / 3;
      this.cellDots[c.id] = start;
      const base = this.baseColor(c.terrain, !!c.buildingId, c.col, c.row, tmp);
      this.cellBase[c.id * 3] = base.r;
      this.cellBase[c.id * 3 + 1] = base.g;
      this.cellBase[c.id * 3 + 2] = base.b;
      let k = 0;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const fx = c.col + (i + 0.5) / n;
          const fy = c.row + (j + 0.5) / n;
          if (!keepEdge && hash(fx * 3.1, fy * 2.3) > 0.35) continue;
          gridDir(fx, fy, v);
          const s = c.terrain === 'river' ? 0.5 : c.terrain === 'bridge' ? 0.45 : 0.54;
          push(v, this.statusColor(base, c.status, tmp.clone()), s);
          k++;
        }
      this.cellDotN[c.id] = k;
    }
    // ── surrounding "continent" (same spacing, outside the city square, noise-masked, dimmer)
    const step = (2 * CAP) / (GRID_COLS * 3);
    const ext = CAP * 2.1;
    for (let y = -ext; y <= ext; y += step)
      for (let x = -ext; x <= ext; x += step) {
        const ax = Math.abs(x), ay = Math.abs(y);
        if (ax < CAP && ay < CAP) continue;
        const out = Math.max(ax - CAP, ay - CAP) / CAP; // 0 at the square's edge
        const nz = noise3(x * 2.2 + 0.4, y * 2.2 - 0.2, 0.7);
        if (nz < -0.15 + out * 1.1) continue;
        capDir(x, y, v);
        const b = 0.55 - 0.25 * Math.min(1, out);
        tmp.copy(PAL.dotA).lerp(PAL.dotB, hash(x * 9, y * 7)).multiplyScalar(b);
        push(v, tmp, 0.5);
      }
    // ── far side: sparse fibonacci lattice, noise continents, dim
    const N = 16000;
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const yy = 1 - (2 * (i + 0.5)) / N;
      const rr = Math.sqrt(1 - yy * yy);
      v.set(Math.cos(ga * i) * rr, yy, Math.sin(ga * i) * rr);
      const cp = dirToCap(v);
      if (Math.max(Math.abs(cp.x), Math.abs(cp.y)) < ext + step) continue;
      if (noise3(v.x * 1.6, v.y * 1.6, v.z * 1.6) < 0.25) continue;
      tmp.copy(PAL.dotA).lerp(PAL.dotB, hash(i, 3)).multiplyScalar(0.42);
      push(v, tmp, 0.55);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const ca = new THREE.Float32BufferAttribute(col, 3);
    ca.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aColor', ca);
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    g.computeBoundingSphere();
    this.dots = new THREE.Points(g, this.dotMat);
    this.dots.frustumCulled = false;
    this.group.add(this.dots);
    this.statusSig = '';
    this.syncStatus(cells);
  }

  /** Recolour dots for destroyed / flooded / burning cells (cheap signature check). */
  syncStatus(cells: GridCell[]): void {
    if (!this.dots) return;
    let sig = '';
    for (const c of cells) if (c.status !== 'ok') sig += c.id + c.status[0];
    if (sig === this.statusSig) return;
    this.statusSig = sig;
    const attr = this.dots.geometry.getAttribute('aColor') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const tmp = new THREE.Color();
    const base = new THREE.Color();
    for (const c of cells) {
      const s = this.cellDots[c.id];
      if (s < 0) continue;
      base.setRGB(this.cellBase[c.id * 3], this.cellBase[c.id * 3 + 1], this.cellBase[c.id * 3 + 2]);
      this.statusColor(base, c.status, tmp);
      for (let k = 0; k < this.cellDotN[c.id]; k++) {
        arr[(s + k) * 3] = tmp.r;
        arr[(s + k) * 3 + 1] = tmp.g;
        arr[(s + k) * 3 + 2] = tmp.b;
      }
    }
    attr.needsUpdate = true;
  }

  private baseColor(t: Terrain, built: boolean, c: number, r: number, out: THREE.Color): THREE.Color {
    if (t === 'river') return out.copy(PAL.river);
    if (t === 'bridge') return out.copy(PAL.dotA).multiplyScalar(0.55);
    out.copy(PAL.dotA).lerp(PAL.dotB, 0.25 + 0.6 * hash(c, r));
    if (t === 'park') out.lerp(PAL.park, 0.45);
    if (built) out.lerp(PAL.dotBuilt, 0.5);
    return out;
  }
  private statusColor(base: THREE.Color, s: CellStatus, out: THREE.Color): THREE.Color {
    if (s === 'destroyed') return out.copy(PAL.destroyed);
    if (s === 'flooded') return out.copy(PAL.flooded);
    if (s === 'burning') return out.copy(PAL.burning);
    return out.copy(base);
  }

  dispose(): void {
    this.bg.geometry.dispose();
    this.bgMat.dispose();
    this.sphere.geometry.dispose();
    (this.sphere.material as THREE.Material).dispose();
    this.atmo.geometry.dispose();
    (this.atmo.material as THREE.Material).dispose();
    this.dots?.geometry.dispose();
    this.dotMat.dispose();
  }
}
