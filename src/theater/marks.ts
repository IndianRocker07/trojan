/**
 * Instanced marks, one draw call each:
 *  - SpikeLayer: cylindrical-billboard light bars rising along the sphere normal (outer = request, bright inner = grant,
 *    tick = floor), cyan/blue → white tip, optional red tint (safety correction).
 *  - GlintLayer: round glowing points (agent nodes, faint houses, sparkle tips).
 *  - RingLayer: rings lying tangent to the sphere (island hubs, shortfall broadcast, safety shield).
 */
import * as THREE from 'three';
import { PAL } from './palette';

// ─────────────────────────── spikes ───────────────────────────

const SPIKE_VS = /* glsl */ `
attribute vec3 iBase; attribute vec4 iData; attribute vec4 iTint;
varying vec2 vUv; varying vec4 vD; varying vec4 vT; varying float vFace;
void main(){
  vec3 axis = normalize(mat3(modelMatrix) * normalize(iBase));
  vec4 wb = modelMatrix * vec4(iBase, 1.0);
  vec3 vd = normalize(cameraPosition - wb.xyz);
  vec3 side = normalize(cross(axis, vd));
  float on = step(0.001, iData.z);
  vec3 wp = wb.xyz + axis * (position.y * iData.x) + side * (position.x * iData.w) * on;
  vUv = position.xy; vD = iData; vT = iTint;
  vFace = smoothstep(-0.12, 0.1, dot(normalize(wb.xyz), vd));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const SPIKE_FS = /* glsl */ `
uniform vec3 uBlue; uniform vec3 uCyan; uniform vec3 uRed;
varying vec2 vUv; varying vec4 vD; varying vec4 vT; varying float vFace;
void main(){
  float y = vUv.y, x = vUv.x;
  float h = vD.x, grant = vD.y, alpha = vD.z;
  float glow = exp(-x * x * 4.0);
  float core = exp(-x * x * 40.0);
  vec3 col = mix(uBlue, uCyan, y) * glow * (0.4 + 0.8 * y);
  float g = smoothstep(grant + 0.012, grant - 0.012, y);
  col += (uCyan * 1.05 + vec3(0.1)) * core * g * (0.85 + 0.5 * y / max(grant, 0.05));
  float tip = exp(-pow((1.0 - y) * h * 0.9, 2.0));
  col += vec3(1.0) * tip * (core * 1.6 + glow * 0.4);
  float ft = (y - vT.z) * h * 1.8;
  col += vec3(0.85, 0.9, 1.0) * exp(-ft * ft) * exp(-x * x * 1.5) * 0.9 * step(0.001, vT.z);
  col *= 1.0 + vT.y;
  col = mix(col, uRed * (length(col) * 0.9 + 0.25 * glow), vT.x);
  col *= alpha * vFace * smoothstep(0.0, 0.05, y);
  gl_FragColor = vec4(col, 1.0);
}`;

export interface SpikeSpec {
  base: THREE.Vector3; // globe-local surface point
  height: number;
  grantFrac: number; // 0..1 of height
  floorFrac: number; // 0 = no tick
  alpha: number;
  width: number;
  red: number; // 0..1 tint
  boost: number; // extra brightness
}

export class SpikeLayer {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private base: Float32Array;
  private data: Float32Array;
  private tint: Float32Array;
  constructor(readonly max = 256) {
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.base = new Float32Array(max * 3);
    this.data = new Float32Array(max * 4);
    this.tint = new Float32Array(max * 4);
    const mk = (a: Float32Array, n: number) => {
      const at = new THREE.InstancedBufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    this.geo.setAttribute('iBase', mk(this.base, 3));
    this.geo.setAttribute('iData', mk(this.data, 4));
    this.geo.setAttribute('iTint', mk(this.tint, 4));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SPIKE_VS,
      fragmentShader: SPIKE_FS,
      uniforms: { uBlue: { value: new THREE.Color(0x1d4dff) }, uCyan: { value: PAL.spike.clone().lerp(new THREE.Color(0x9fe6ff), 0.35) }, uRed: { value: PAL.red } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }
  set(list: SpikeSpec[]): void {
    const n = Math.min(this.max, list.length);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      this.base.set([s.base.x, s.base.y, s.base.z], i * 3);
      this.data.set([s.height, Math.min(1, Math.max(0, s.grantFrac)), s.alpha, s.width], i * 4);
      this.tint.set([s.red, s.boost, s.floorFrac, 0], i * 4);
    }
    this.geo.instanceCount = n;
    for (const k of ['iBase', 'iData', 'iTint']) {
      const a = this.geo.getAttribute(k) as THREE.InstancedBufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }
  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ─────────────────────────── glints (nodes + sparkles) ───────────────────────────

const GLINT_VS = /* glsl */ `
attribute vec3 aColor; attribute float aSize; attribute float aTw;
uniform float uScale; uniform float uTime;
varying vec3 vCol; varying float vHalo;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normalize(position));
  float facing = dot(n, normalize(-mv.xyz));
  float tw = 1.0 - aTw * (0.5 + 0.5 * sin(uTime * 4.0 + position.x * 1.7 + position.z * 2.3));
  vCol = aColor * smoothstep(-0.1, 0.18, facing) * tw;
  vHalo = step(0.0, aSize);
  gl_PointSize = max(1.0, abs(aSize) * uScale / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const GLINT_FS = /* glsl */ `
varying vec3 vCol; varying float vHalo;
void main(){
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p);
  float core = smoothstep(0.17, 0.05, d);
  float halo = exp(-d * d * 22.0) * vHalo * 0.6;
  float a = core + halo;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * core * 1.2 + vCol * halo, 1.0);
}`;

/** Fixed-capacity glowing points; write slots each frame. size < 0 = no halo (plain dot). */
export class GlintLayer {
  readonly points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly size: Float32Array;
  readonly tw: Float32Array;
  n = 0;
  constructor(readonly max: number, uniforms: { uScale: { value: number }; uTime: { value: number } }) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.tw = new Float32Array(max);
    const mk = (a: Float32Array, k: number) => {
      const at = new THREE.BufferAttribute(a, k);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    this.geo.setAttribute('position', mk(this.pos, 3));
    this.geo.setAttribute('aColor', mk(this.col, 3));
    this.geo.setAttribute('aSize', mk(this.size, 1));
    this.geo.setAttribute('aTw', mk(this.tw, 1));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: GLINT_VS,
      fragmentShader: GLINT_FS,
      uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  begin(): void {
    this.n = 0;
  }
  push(p: THREE.Vector3, c: THREE.Color, k: number, size: number, tw = 0): void {
    if (this.n >= this.max || k <= 0.002) return;
    const i = this.n++;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.col[i * 3] = c.r * k;
    this.col[i * 3 + 1] = c.g * k;
    this.col[i * 3 + 2] = c.b * k;
    this.size[i] = size;
    this.tw[i] = tw;
  }
  end(): void {
    this.geo.setDrawRange(0, this.n);
    for (const k of ['position', 'aColor', 'aSize', 'aTw']) {
      const a = this.geo.getAttribute(k) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
  }
  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ─────────────────────────── rings ───────────────────────────

const RING_VS = /* glsl */ `
attribute vec3 iCenter; attribute vec4 iData; attribute vec4 iColor; attribute float iSpin;
varying vec2 vUv; varying vec4 vD; varying vec4 vC; varying float vSpin;
void main(){
  vec3 n = normalize(iCenter);
  vec3 up = abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, n));
  vec3 t2 = cross(n, t1);
  float s = iData.x * 1.35 * step(0.001, iData.z);
  vec3 p = iCenter + (t1 * position.x + t2 * position.y) * s;
  vUv = position.xy * 1.35; vD = iData; vC = iColor; vSpin = iSpin;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const RING_FS = /* glsl */ `
uniform float uTime;
varying vec2 vUv; varying vec4 vD; varying vec4 vC; varying float vSpin;
void main(){
  float d = length(vUv);
  float th = vD.y;
  float e = (d - 1.0) / th;
  float ring = exp(-e * e);
  float core = exp(-e * e * 9.0);
  if (vC.w > 0.5) {
    float ang = atan(vUv.y, vUv.x) / 6.28318 + 0.5;
    ring *= 0.2 + 0.8 * smoothstep(0.6, 0.5, fract(ang * vC.w + uTime * vSpin));
  }
  float fill = vD.w * smoothstep(1.0, 0.2, d) * (0.25 + 0.75 * d * d);
  float a = (ring * 0.7 + core * 0.9 + fill * 0.5) * vD.z;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vC.rgb * a + vec3(core * 0.35 * vD.z), 1.0);
}`;

export interface RingSpec {
  center: THREE.Vector3; // globe-local, plane is tangent to the sphere at center
  radius: number;
  thickness: number; // relative to radius
  alpha: number;
  fill: number;
  color: THREE.Color;
  dashes?: number;
  spin?: number;
}

export class RingLayer {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private mat: THREE.ShaderMaterial;
  private c: Float32Array;
  private d: Float32Array;
  private col: Float32Array;
  private spin: Float32Array;
  constructor(readonly max: number, uTime: { value: number }) {
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.c = new Float32Array(max * 3);
    this.d = new Float32Array(max * 4);
    this.col = new Float32Array(max * 4);
    this.spin = new Float32Array(max);
    const mk = (a: Float32Array, n: number) => {
      const at = new THREE.InstancedBufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    this.geo.setAttribute('iCenter', mk(this.c, 3));
    this.geo.setAttribute('iData', mk(this.d, 4));
    this.geo.setAttribute('iColor', mk(this.col, 4));
    this.geo.setAttribute('iSpin', mk(this.spin, 1));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: RING_VS,
      fragmentShader: RING_FS,
      uniforms: { uTime },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }
  set(list: RingSpec[]): void {
    const n = Math.min(this.max, list.length);
    for (let i = 0; i < n; i++) {
      const r = list[i];
      this.c.set([r.center.x, r.center.y, r.center.z], i * 3);
      this.d.set([r.radius, r.thickness, r.alpha, r.fill], i * 4);
      this.col.set([r.color.r, r.color.g, r.color.b, r.dashes ?? 0], i * 4);
      this.spin[i] = r.spin ?? 0;
    }
    this.geo.instanceCount = n;
    for (const k of ['iCenter', 'iData', 'iColor', 'iSpin']) {
      const a = this.geo.getAttribute(k) as THREE.InstancedBufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }
  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
