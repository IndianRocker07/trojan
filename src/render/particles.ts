import * as THREE from 'three';

let tex: THREE.CanvasTexture | null = null;
const circle = (): THREE.CanvasTexture => {
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
};

/** Small pooled billboard-particle system (one Points draw call, per-particle size and alpha). */
export class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private scl: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private next = 0;
  private color: THREE.Color;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.PointsMaterial;

  constructor(private cap: number, color: number, public gravity = -9, public maxAlpha = 0.8) {
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.scl = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.age = new Float32Array(cap).fill(99);
    this.life = new Float32Array(cap).fill(1);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.color = new THREE.Color(color);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aScale', new THREE.BufferAttribute(this.scl, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.PointsMaterial({ size: 1, map: circle(), transparent: true, depthWrite: false, vertexColors: true, sizeAttenuation: true });
    this.mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('void main() {', 'attribute float aScale;\nvoid main() {')
        .replace('gl_PointSize = size;', 'gl_PointSize = size * aScale;');
    };
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number): void {
    const i = this.next;
    this.next = (i + 1) % this.cap;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
  }

  update(dt: number): void {
    for (let i = 0; i < this.cap; i++) {
      const a = (this.age[i] += dt);
      const L = this.life[i];
      if (a >= L) {
        this.col[i * 4 + 3] = 0;
        this.scl[i] = 0;
        continue;
      }
      const f = a / L;
      this.vel[i * 3 + 1] += this.gravity * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.col[i * 4] = this.color.r;
      this.col[i * 4 + 1] = this.color.g;
      this.col[i * 4 + 2] = this.color.b;
      this.col[i * 4 + 3] = this.maxAlpha * (1 - f);
      this.scl[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * f;
    }
    for (const n of ['position', 'color', 'aScale']) (this.geo.attributes[n] as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.points.removeFromParent();
  }
}
