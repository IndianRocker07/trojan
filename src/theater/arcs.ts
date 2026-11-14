/**
 * Pooled glowing arcs: one merged camera-facing ribbon geometry for MAX_ARCS arcs (1 draw call).
 * Per-arc animation state (head, tail, width, alpha, colour, dashes) lives in a tiny float DataTexture,
 * so a frame only uploads 2·MAX_ARCS texels; curve vertices are rewritten only when an arc's endpoints change.
 */
import * as THREE from 'three';

export const MAX_ARCS = 160;
const SEG = 56;
const VPA = (SEG + 1) * 2; // vertices per arc

export interface ArcSpec {
  key: string; // stable identity (role + endpoints) → keeps its slot/geometry across frames
  p0: THREE.Vector3; // globe-local
  p1: THREE.Vector3;
  lift: number; // apex height above the chord's radius (0 + straight → straight beam)
  straight?: boolean;
  color: THREE.Color;
  width: number; // world units (half-width of the glow ribbon)
  head: number; // 0..1 drawn up to here (travelling bright head while < 1)
  tail: number; // 0..1 hidden before here
  alpha: number;
  dashes?: number; // 0 = solid, else dash count along the arc
}

const VS = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uArc;
attribute vec3 aTan; attribute float aSide; attribute float aT; attribute float aIdx;
varying float vT; varying float vSide; varying vec4 vA; varying vec4 vC;
void main(){
  vec4 A = texelFetch(uArc, ivec2(int(aIdx + 0.5), 0), 0);
  vec4 C = texelFetch(uArc, ivec2(int(aIdx + 0.5), 1), 0);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 wt = normalize(mat3(modelMatrix) * aTan);
  vec3 vd = normalize(cameraPosition - wp.xyz);
  vec3 side = normalize(cross(wt, vd));
  float on = step(0.001, A.w) * step(aT, A.x + 0.03) * step(A.y - 0.03, aT);
  wp.xyz += side * aSide * A.z * on;
  vT = aT; vSide = aSide; vA = A; vC = C;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FS = /* glsl */ `
precision highp float;
varying float vT; varying float vSide; varying vec4 vA; varying vec4 vC;
void main(){
  float head = vA.x, tail = vA.y;
  if (vT > head || vT < tail || vA.w < 0.001) discard;
  float s2 = vSide * vSide;
  float glow = exp(-s2 * 4.5);
  float core = exp(-s2 * 55.0);
  float flying = 1.0 - step(0.999, head);
  float trail = mix(1.0, 0.18 + 0.82 * smoothstep(head - 0.5, head, vT), flying);
  float hd = (head - vT) * 45.0;
  float headGlow = flying * exp(-hd * hd);
  float dash = vC.w > 0.5 ? smoothstep(0.62, 0.5, fract(vT * vC.w)) : 1.0;
  float ends = smoothstep(0.0, 0.025, vT - tail) * smoothstep(0.0, 0.02, 1.0 - vT + 0.0001);
  float a = vA.w * trail * dash * ends;
  vec3 col = vC.rgb * (glow * 0.32 + core * 1.05) * a;
  col += vec3(1.0) * core * 0.3 * a;
  col += (vC.rgb + vec3(0.8)) * headGlow * (glow * 0.4 + core) * 1.1 * vA.w;
  gl_FragColor = vec4(col, 1.0);
}`;

export class ArcPool {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private tex: THREE.DataTexture;
  private data = new Float32Array(MAX_ARCS * 2 * 4);
  private pos: Float32Array;
  private tan: Float32Array;
  private slotOf = new Map<string, number>();
  private keyOf: (string | null)[] = new Array(MAX_ARCS).fill(null);
  private sig = new Float32Array(MAX_ARCS * 8);
  private used = new Uint8Array(MAX_ARCS);
  private free: number[] = [];
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  private n0 = new THREE.Vector3();
  private n1 = new THREE.Vector3();
  live = 0;

  constructor() {
    const nv = MAX_ARCS * VPA;
    this.pos = new Float32Array(nv * 3);
    this.tan = new Float32Array(nv * 3);
    const side = new Float32Array(nv);
    const t = new Float32Array(nv);
    const idx = new Float32Array(nv);
    const ind: number[] = [];
    for (let a = 0; a < MAX_ARCS; a++) {
      for (let i = 0; i <= SEG; i++)
        for (let s = 0; s < 2; s++) {
          const k = a * VPA + i * 2 + s;
          side[k] = s ? 1 : -1;
          t[k] = i / SEG;
          idx[k] = a;
        }
      for (let i = 0; i < SEG; i++) {
        const b = a * VPA + i * 2;
        ind.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    const ta = new THREE.BufferAttribute(this.tan, 3);
    ta.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', pa);
    this.geo.setAttribute('aTan', ta);
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    this.geo.setAttribute('aT', new THREE.BufferAttribute(t, 1));
    this.geo.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1));
    this.geo.setIndex(ind);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);
    this.tex = new THREE.DataTexture(this.data, MAX_ARCS, 2, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: { uArc: { value: this.tex } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    for (let i = MAX_ARCS - 1; i >= 0; i--) this.free.push(i);
  }

  /** Replace the full set of visible arcs for this frame. */
  set(arcs: ArcSpec[]): void {
    this.used.fill(0);
    let geoDirty = false;
    let n = 0;
    for (const a of arcs) {
      if (n >= MAX_ARCS) break;
      let slot = this.slotOf.get(a.key);
      if (slot === undefined || this.used[slot]) {
        if (slot !== undefined && this.used[slot]) continue; // duplicate key in one frame
        slot = this.take();
        if (slot < 0) break;
        this.slotOf.set(a.key, slot);
        this.keyOf[slot] = a.key;
        this.sig.fill(NaN, slot * 8, slot * 8 + 8);
      }
      this.used[slot] = 1;
      n++;
      if (this.writeSig(slot, a)) {
        this.writeCurve(slot, a);
        geoDirty = true;
      }
      const d = this.data;
      const o = slot * 4;
      d[o] = a.head;
      d[o + 1] = a.tail;
      d[o + 2] = a.width;
      d[o + 3] = a.alpha;
      const o2 = (MAX_ARCS + slot) * 4;
      d[o2] = a.color.r;
      d[o2 + 1] = a.color.g;
      d[o2 + 2] = a.color.b;
      d[o2 + 3] = a.dashes ?? 0;
    }
    // release unused slots (keep their geometry; just hide)
    for (let s = 0; s < MAX_ARCS; s++) {
      if (this.used[s]) continue;
      this.data[s * 4 + 3] = 0;
      const k = this.keyOf[s];
      if (k !== null) {
        this.slotOf.delete(k);
        this.keyOf[s] = null;
        this.free.push(s);
      }
    }
    this.live = n;
    this.tex.needsUpdate = true;
    if (geoDirty) {
      this.geo.getAttribute('position').needsUpdate = true;
      this.geo.getAttribute('aTan').needsUpdate = true;
    }
  }

  private take(): number {
    return this.free.length ? this.free.pop()! : -1;
  }

  private writeSig(slot: number, a: ArcSpec): boolean {
    const s = this.sig;
    const o = slot * 8;
    const vals = [a.p0.x, a.p0.y, a.p0.z, a.p1.x, a.p1.y, a.p1.z, a.lift, a.straight ? 1 : 0];
    let diff = false;
    for (let i = 0; i < 8; i++)
      if (!(Math.abs(s[o + i] - vals[i]) < 1e-3)) {
        diff = true;
        s[o + i] = vals[i];
      }
    return diff;
  }

  private point(a: ArcSpec, t: number, out: THREE.Vector3): THREE.Vector3 {
    if (a.straight) return out.copy(a.p0).lerp(a.p1, t);
    const r0 = a.p0.length(), r1 = a.p1.length();
    this.n0.copy(a.p0).divideScalar(r0);
    this.n1.copy(a.p1).divideScalar(r1);
    const om = Math.acos(Math.min(1, Math.max(-1, this.n0.dot(this.n1))));
    if (om < 1e-5) out.copy(this.n0);
    else {
      const so = Math.sin(om);
      out
        .copy(this.n0)
        .multiplyScalar(Math.sin((1 - t) * om) / so)
        .addScaledVector(this.n1, Math.sin(t * om) / so);
    }
    // smooth "leap": steep near the ends, flat apex
    const lift = a.lift * Math.pow(4 * t * (1 - t), 0.8);
    return out.multiplyScalar(r0 + (r1 - r0) * t + lift);
  }

  private writeCurve(slot: number, a: ArcSpec): void {
    const base = slot * VPA;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      this.point(a, t, this.v);
      this.point(a, Math.min(1, t + 1 / SEG), this.w);
      if (i === SEG) {
        this.point(a, t - 1 / SEG, this.w);
        this.w.subVectors(this.v, this.w);
      } else this.w.sub(this.v);
      this.w.normalize();
      for (let s = 0; s < 2; s++) {
        const k = (base + i * 2 + s) * 3;
        this.pos[k] = this.v.x;
        this.pos[k + 1] = this.v.y;
        this.pos[k + 2] = this.v.z;
        this.tan[k] = this.w.x;
        this.tan[k + 1] = this.w.y;
        this.tan[k + 2] = this.w.z;
      }
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
