import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF_D, HALF_W } from '../../core/constants';
import { COLORS, MAT } from '../palette';
import { WIND, windGustAt } from './wind';
import type { Biome, EnvPart, Field } from './types';

/**
 * Ambient life of the landscape: bird flocks looping over the foothills, butterflies in the
 * meadow beside the city, drifting mist in the valleys and a few high clouds.
 * Everything is instanced (8 draw calls total), deterministic (seeded PRNG), and wind-driven.
 */

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

/** mulberry32: small deterministic PRNG so the landscape looks the same on every load. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const wrapAngle = (a: number) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
/** Wrap v into [-L/2, L/2). */
const wrapSigned = (v: number, L: number) => ((((v + L / 2) % L) + L) % L) - L / 2;

// ---------------------------------------------------------------------------------------------
// Flock paths: closed loops (ellipses with a little wobble), arc-length resampled, terrain-following.
// ---------------------------------------------------------------------------------------------

interface FlockSpec {
  cx: number;
  cz: number;
  ax: number;
  az: number;
  ph: number;
  speed: number; // m/s along the loop
  hover: [number, number]; // altitude above the highest ground under the flock
  n: number;
  phase: number; // start offset along the loop (0..1)
}

const FLOCKS: FlockSpec[] = [
  // big loop over the north-east foothills
  { cx: 330, cz: -300, ax: 260, az: 200, ph: 0.6, speed: 15, hover: [90, 150], n: 18, phase: 0.1 },
  // low sweep over the meadow south of the city
  { cx: 20, cz: 520, ax: 330, az: 120, ph: 2.1, speed: 12, hover: [50, 90], n: 12, phase: 0.45 },
  // crosses the west edge of the city (occasionally flies over the board)
  { cx: -390, cz: -10, ax: 190, az: 240, ph: 4.0, speed: 13, hover: [110, 150], n: 9, phase: 0.7 },
  // small, fast circuit over the east meadow
  { cx: 600, cz: 150, ax: 120, az: 160, ph: 1.0, speed: 16, hover: [45, 70], n: 8, phase: 0.3 },
  // wide circle over the far north-west mountains
  { cx: -520, cz: -620, ax: 300, az: 240, ph: 2.6, speed: 14, hover: [70, 130], n: 15, phase: 0.9 },
];

interface Path {
  n: number;
  T: number; // loop period (s)
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  tx: Float64Array;
  tz: Float64Array;
}

interface Bird {
  a0: number; a1: number; aw: number; ap: number; // along-track offset (breathing)
  b0: number; b1: number; bw: number; bp: number; // across-track offset
  c0: number; c1: number; cw: number; cp: number; // vertical offset
  fw: number; fp: number; // flap rate / phase
  gw: number; gp: number; // glide cycle
}

interface Flock {
  path: Path;
  phase: number;
  birds: Bird[];
}

interface Sample { x: number; y: number; z: number; tx: number; tz: number }
interface V3 { x: number; y: number; z: number }

function buildPath(spec: FlockSpec, field: Field, rand: () => number): Path {
  const M = 1200;
  const px = new Float64Array(M);
  const pz = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    const th = (TAU * k) / M;
    px[k] = spec.cx + spec.ax * Math.cos(th) + 0.12 * spec.ax * Math.cos(2 * th + spec.ph);
    pz[k] = spec.cz + spec.az * Math.sin(th) + 0.1 * spec.az * Math.sin(3 * th + spec.ph * 0.5);
  }
  const cum = new Float64Array(M + 1);
  for (let k = 0; k < M; k++) {
    const j = (k + 1) % M;
    cum[k + 1] = cum[k] + Math.hypot(px[j] - px[k], pz[j] - pz[k]);
  }
  const L = cum[M];

  // resample at uniform arc length so birds keep a steady speed around the loop
  const n = 240;
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const s = (i / n) * L;
    while (cum[k + 1] < s) k++;
    const j = (k + 1) % M;
    const seg = cum[k + 1] - cum[k] || 1;
    const a = (s - cum[k]) / seg;
    x[i] = px[k] + (px[j] - px[k]) * a;
    z[i] = pz[k] + (pz[j] - pz[k]) * a;
  }

  // highest ground under a 40 m disc at each sample, then a windowed max so the path never dips
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = field.height(x[i], z[i]);
    for (let q = 0; q < 8; q++) {
      const th = (q * TAU) / 8;
      m = Math.max(m, field.height(x[i] + 40 * Math.cos(th), z[i] + 40 * Math.sin(th)));
    }
    g[i] = m;
  }
  const hover = spec.hover[0] + (spec.hover[1] - spec.hover[0]) * rand();
  const y = new Float64Array(n);
  const W = 5;
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let d = -W; d <= W; d++) m = Math.max(m, g[(i + d + n) % n]);
    y[i] = m + hover;
  }
  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    tx[i] = x[b] - x[a];
    tz[i] = z[b] - z[a];
  }
  return { n, T: L / spec.speed, x, y: y as Float64Array, z, tx, tz };
}

const _smp: Sample = { x: 0, y: 0, z: 0, tx: 1, tz: 0 };
function sampleAt(p: Path, phase: number, t: number): Sample {
  let u = t / p.T + phase;
  u -= Math.floor(u);
  const f = u * p.n;
  const i0 = Math.floor(f);
  const a = f - i0;
  const i = i0 % p.n;
  const j = (i + 1) % p.n;
  _smp.x = p.x[i] + (p.x[j] - p.x[i]) * a;
  _smp.y = p.y[i] + (p.y[j] - p.y[i]) * a;
  _smp.z = p.z[i] + (p.z[j] - p.z[i]) * a;
  const tx = p.tx[i] + (p.tx[j] - p.tx[i]) * a;
  const tz = p.tz[i] + (p.tz[j] - p.tz[i]) * a;
  const l = Math.hypot(tx, tz) || 1;
  _smp.tx = tx / l;
  _smp.tz = tz / l;
  return _smp;
}

function makeBird(rand: () => number): Bird {
  const b0 = (rand() * 2 - 1) * 11;
  return {
    a0: -Math.abs(b0) * 0.45 + (rand() - 0.5) * 5, // V-ish: birds at the wings trail a little
    a1: 1.5 + rand() * 3.5,
    aw: 0.25 + rand() * 0.5,
    ap: rand() * TAU,
    b0,
    b1: 1 + rand() * 3,
    bw: 0.2 + rand() * 0.4,
    bp: rand() * TAU,
    c0: (rand() * 2 - 1) * 3.5,
    c1: 0.8 + rand() * 1.8,
    cw: 0.3 + rand() * 0.6,
    cp: rand() * TAU,
    fw: 7 + rand() * 3,
    fp: rand() * TAU,
    gw: 0.25 + rand() * 0.3,
    gp: rand() * TAU,
  };
}

/** Bird position at time t: flock centre on the loop + breathing offsets in the flock frame. */
function birdPos(fl: Flock, b: Bird, t: number, o: V3) {
  const s = sampleAt(fl.path, fl.phase, t);
  const along = b.a0 + b.a1 * Math.sin(b.aw * t + b.ap);
  const across = b.b0 + b.b1 * Math.sin(b.bw * t + b.bp);
  o.x = s.x + s.tx * along - s.tz * across;
  o.z = s.z + s.tz * along + s.tx * across;
  o.y = s.y + b.c0 + b.c1 * Math.sin(b.cw * t + b.cp);
}

const _A: V3 = { x: 0, y: 0, z: 0 };
const _B: V3 = { x: 0, y: 0, z: 0 };
const _C: V3 = { x: 0, y: 0, z: 0 };
const _D: V3 = { x: 0, y: 0, z: 0 };
interface BirdFrame extends V3 { yaw: number; pitch: number; bank: number; flap: number }
const _bf: BirdFrame = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, bank: 0, flap: 0 };

function birdFrame(fl: Flock, b: Bird, t: number, out: BirdFrame) {
  const H = 0.05;
  birdPos(fl, b, t - H, _A);
  birdPos(fl, b, t, _B);
  birdPos(fl, b, t + H, _C);
  birdPos(fl, b, t + 2 * H, _D);
  // velocity at t and at t+H (central differences, same scale so ratios are right)
  const vx = _C.x - _A.x;
  const vy = _C.y - _A.y;
  const vz = _C.z - _A.z;
  const yaw = Math.atan2(vx, vz);
  const yaw2 = Math.atan2(_D.x - _B.x, _D.z - _B.z);
  const hs = Math.hypot(vx, vz);
  const pitch = Math.max(-0.5, Math.min(0.5, -Math.atan2(vy, hs)));
  const omega = wrapAngle(yaw2 - yaw) / H; // heading rate, rad/s
  // bank into the turn: the body's up-vector tilts toward the centre of the turn
  const bank = Math.max(-0.6, Math.min(0.6, -omega * 3.5));
  // flap with occasional glides (wings held up and still)
  const glide = smooth(0.55, 0.9, 0.5 + 0.5 * Math.sin(b.gw * t + b.gp));
  const flap = glide * 0.2 + (1 - glide) * 0.8 * Math.sin(b.fw * t + b.fp);
  out.x = _B.x;
  out.y = _B.y;
  out.z = _B.z;
  out.yaw = yaw;
  out.pitch = pitch;
  out.bank = bank;
  out.flap = flap;
}

function birdBodyGeometry(): THREE.BufferGeometry {
  const g = new THREE.OctahedronGeometry(1, 0);
  g.scale(0.16, 0.14, 0.75); // slim spindle, 1.5 m long
  return g;
}

/** One wing as a swept triangle pair, hinged at the body centre (side -1 = x<0, +1 = x>0). */
function wingGeometry(side: -1 | 1): THREE.BufferGeometry {
  const s = side;
  const pos = new Float32Array([
    0, 0, 0.32, s * 1.32, 0, -0.05, s * 1.18, 0, -0.42,
    0, 0, 0.32, s * 1.18, 0, -0.42, 0, 0, -0.42,
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------------------------

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft, lumpy white blob cluster, faded to a transparent edge. */
function mistTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  const r = rng(0xa11ce);
  for (let i = 0; i < 16; i++) {
    const cx = 48 + r() * 160;
    const cy = 46 + r() * 36;
    const rad = 26 + r() * 30;
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grd.addColorStop(0, 'rgba(255,255,255,0.5)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  }
  // elliptical fade-out so no hard edge ever shows
  g.globalCompositeOperation = 'destination-in';
  g.save();
  g.translate(128, 64);
  g.scale(1, 0.5);
  const m = g.createRadialGradient(0, 0, 0, 0, 0, 128);
  m.addColorStop(0, 'rgba(0,0,0,1)');
  m.addColorStop(0.6, 'rgba(0,0,0,0.8)');
  m.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = m;
  g.fillRect(-128, -128, 256, 256);
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// Butterflies
// ---------------------------------------------------------------------------------------------

interface Fly {
  hx: number; hy: number; hz: number; // home on the meadow
  A: number; A2: number; w1: number; p1: number; w2: number; p2: number; w3: number; p3: number; w4: number; p4: number;
  hov: number; dx: number; dz: number; // wind-nudged drift (spring-relaxed)
  fp: number; fs: number; bob: number;
}

function flyWander(f: Fly, t: number, o: { x: number; z: number }) {
  o.x = f.A * Math.sin(f.w1 * t + f.p1) + f.A2 * Math.sin(f.w3 * t + f.p3);
  o.z = f.A * Math.cos(f.w2 * t + f.p2) + f.A2 * Math.sin(f.w4 * t + f.p4);
}

/** Wing-width flutter: flat wings cycle between narrow and full span. */
function flyWingGeometry(): THREE.BufferGeometry {
  const v: number[] = [];
  for (const s of [-1, 1]) {
    const A = [0, 0, 0.06];
    const B = [s * 0.24, 0, 0.1];
    const C = [s * 0.2, 0, -0.1];
    const D = [0, 0, -0.08];
    v.push(...A, ...B, ...C, ...A, ...C, ...D);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------

export function buildFauna(field: Field): EnvPart {
  const group = new THREE.Group();
  group.name = 'fauna';
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(o: T): T => {
    owned.push(o);
    return o;
  };
  const bio: Biome = { meadow: 0, forest: 0, alpine: 0, rock: 0, snow: 0 };
  // ---------- birds ----------
  const rand = rng(0xb1d5);
  const flocks: Flock[] = FLOCKS.map((spec) => ({
    path: buildPath(spec, field, rand),
    phase: spec.phase,
    birds: Array.from({ length: spec.n }, () => makeBird(rand)),
  }));
  const nBirds = flocks.reduce((s, f) => s + f.birds.length, 0);
  const birdMat = own(new THREE.MeshBasicMaterial({ color: COLORS.ink, side: THREE.DoubleSide, transparent: true }));
  const birdBodies = own(new THREE.InstancedMesh(own(birdBodyGeometry()), birdMat, nBirds));
  const birdWingL = own(new THREE.InstancedMesh(own(wingGeometry(-1)), birdMat, nBirds));
  const birdWingR = own(new THREE.InstancedMesh(own(wingGeometry(1)), birdMat, nBirds));
  for (const m of [birdBodies, birdWingL, birdWingR]) {
    m.frustumCulled = false;
    group.add(m);
  }

  // ---------- butterflies ----------
  const frand = rng(0xf1f1);
  const flyHomes: { x: number; y: number; z: number; e: number }[] = [];
  for (let thr = 0.5; flyHomes.length < 90 && thr >= 0.1; thr -= 0.2) {
    for (let tries = 0; tries < 5000 && flyHomes.length < 90; tries++) {
      const x = (frand() * 2 - 1) * (HALF_W + 170);
      const z = (frand() * 2 - 1) * (HALF_D + 170);
      const e = field.edgeDist(x, z);
      if (e < 12 || e > 150) continue;
      if (field.biome(x, z, bio).meadow < thr) continue;
      const y = field.height(x, z);
      if (y > 40) continue;
      flyHomes.push({ x, y, z, e });
    }
  }
  const flies: Fly[] = flyHomes.map((h) => ({
    hx: h.x,
    hy: h.y,
    hz: h.z,
    A: 2 + frand() * 3,
    A2: 0.8 + frand() * 1.2,
    w1: 0.15 + frand() * 0.25,
    p1: frand() * TAU,
    w2: 0.15 + frand() * 0.25,
    p2: frand() * TAU,
    w3: 0.3 + frand() * 0.3,
    p3: frand() * TAU,
    w4: 0.3 + frand() * 0.3,
    p4: frand() * TAU,
    hov: 0.5 + frand() * 2.5,
    dx: 0,
    dz: 0,
    fp: frand() * TAU,
    fs: 12 + frand() * 5,
    bob: 1.2 + frand() * 1.2,
  }));
  const nFly = flies.length;
  const FLY_COLORS = [COLORS.yellow, 0xf6f2e4, COLORS.lilac, COLORS.coral];
  const flyWingMat = own(MAT.wallWhite.clone());
  flyWingMat.side = THREE.DoubleSide;
  flyWingMat.transparent = true;
  const flyBodyMat = own(new THREE.MeshBasicMaterial({ color: COLORS.ink, transparent: true }));
  const flyWings = own(new THREE.InstancedMesh(own(flyWingGeometry()), flyWingMat, nFly));
  const flyBody = own(new THREE.InstancedMesh(own(new THREE.BoxGeometry(0.025, 0.025, 0.3)), flyBodyMat, nFly));
  const tmpCol = new THREE.Color();
  for (let i = 0; i < nFly; i++) {
    flyWings.setColorAt(i, tmpCol.setHex(FLY_COLORS[i % FLY_COLORS.length]));
  }
  for (const m of [flyWings, flyBody]) {
    m.frustumCulled = false;
    group.add(m);
  }

  // ---------- mist in the valleys around the mountains ----------
  const mrand = rng(0x515);
  const mist: { x: number; y: number; z: number; sp: number; ph: number; w: number; h: number; b: number }[] = [];
  const MIST_L = 180;
  for (let tries = 0; tries < 6000 && mist.length < 90; tries++) {
    const r = 620 + mrand() * 880;
    const th = mrand() * TAU;
    const x = r * Math.cos(th);
    const z = r * Math.sin(th);
    const ground = field.height(x, z);
    let peak = ground;
    for (let q = 0; q < 8; q++) {
      const a = (q * TAU) / 8;
      peak = Math.max(peak, field.height(x + 140 * Math.cos(a), z + 140 * Math.sin(a)));
    }
    if (peak < 110) continue;
    const yT = peak * (0.4 + 0.4 * mrand()); // band at 0.4..0.8 of the local peak
    if (!(ground < yT - 8 && ground > yT - 120)) continue; // floats over slopes and valleys
    const w = 150 + mrand() * 130;
    mist.push({ x, y: yT, z, sp: 1.5 + mrand() * 1.8, ph: mrand() * MIST_L, w, h: w * (0.35 + mrand() * 0.15), b: 0.85 + mrand() * 0.15 });
  }
  const mistTex = own(mistTexture());
  const mistMat = own(
    new THREE.MeshBasicMaterial({ map: mistTex, color: 0xffffff, transparent: true, depthWrite: false, opacity: 0.55, side: THREE.DoubleSide }),
  );
  const mistMesh = own(new THREE.InstancedMesh(own(new THREE.PlaneGeometry(1, 1)), mistMat, Math.max(1, mist.length)));
  mistMesh.frustumCulled = false;
  mistMesh.count = mist.length;
  for (let i = 0; i < mist.length; i++) mistMesh.setColorAt(i, tmpCol.setScalar(mist[i].b));
  group.add(mistMesh);
  const MIST_DAY = new THREE.Color(0xffffff);
  const MIST_NIGHT = new THREE.Color(0x2c3850);

  // ---------- high puffy clouds ----------
  const crand = rng(0xc10d);
  const cloudParts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 7; k++) {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const r = 26 + crand() * 22;
    g.scale(r, r * 0.62, r * (0.85 + crand() * 0.3));
    g.translate((crand() * 2 - 1) * 55, crand() * 18, (crand() * 2 - 1) * 28);
    cloudParts.push(g);
  }
  const cloudGeo = own(mergeGeometries(cloudParts) ?? cloudParts[0]);
  const cloudMat = own(MAT.wallWhite.clone());
  const CLOUD_DAY = new THREE.Color(COLORS.cream);
  const CLOUD_NIGHT = new THREE.Color(0x5a6684);
  cloudMat.color.copy(CLOUD_DAY);
  const clouds: { x: number; y: number; z: number; sp: number; ph: number; s: number }[] = [];
  for (let k = 0; k < 7; k++) {
    const r = 850 + crand() * 300;
    const th = crand() * TAU;
    clouds.push({ x: r * Math.cos(th), y: 400 + crand() * 100, z: r * Math.sin(th), sp: 1 + crand() * 0.6, ph: crand() * 420, s: 1 + crand() * 0.7 });
  }
  const cloudMesh = own(new THREE.InstancedMesh(cloudGeo, cloudMat, clouds.length));
  cloudMesh.frustumCulled = false;
  group.add(cloudMesh);
  const CLOUD_L = 420;

  // ---------- fireflies (night only, meadow beside the city) ----------
  const NF = Math.min(36, flyHomes.filter((h) => h.e <= 90).length);
  const ffHomes = flyHomes.filter((h) => h.e <= 90).slice(0, NF).map((h, i) => ({ x: h.x, y: h.y + 1.2, z: h.z, p: (i * 2.399) % TAU }));
  const ffPos = new Float32Array(NF * 3);
  const ffCol = new Float32Array(NF * 3);
  const ffGeo = own(new THREE.BufferGeometry());
  ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPos, 3));
  ffGeo.setAttribute('color', new THREE.BufferAttribute(ffCol, 3));
  const ffMat = own(
    new THREE.PointsMaterial({
      size: 2.4,
      map: own(glowTexture()),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    }),
  );
  const fireflies = own(new THREE.Points(ffGeo, ffMat));
  fireflies.frustumCulled = false;
  fireflies.visible = false;
  group.add(fireflies);

  // ---------- per-frame scratch ----------
  const m4 = new THREE.Matrix4();
  const base = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const camPos = new THREE.Vector3();
  const w0 = { x: 0, z: 0 };
  const w1 = { x: 0, z: 0 };
  const rotM = new THREE.Matrix4();
  const wingM = new THREE.Matrix4();
  /** Bird wing = bird frame, then a rotation about the bird's forward axis (the hinge). */
  const wingMatrix = (b: THREE.Matrix4, ang: number): THREE.Matrix4 => wingM.multiplyMatrices(b, rotM.makeRotationZ(ang));

  const setClouds = (t: number) => {
    const wd = WIND.uWindDir.value;
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      const s = wrapSigned(t * c.sp + c.ph, CLOUD_L);
      const fade = clamp01((CLOUD_L / 2 - Math.abs(s)) / 90);
      pos.set(c.x + wd.x * s, c.y, c.z + wd.y * s);
      scl.setScalar(c.s * fade);
      base.compose(pos, quat.identity(), scl);
      cloudMesh.setMatrixAt(i, base);
    }
    cloudMesh.instanceMatrix.needsUpdate = true;
  };
  setClouds(0);

  const update = (dt: number, t: number, camera: THREE.Camera) => {
    const h = Math.min(Math.max(dt, 0), 0.1);
    const wd = WIND.uWindDir.value;
    camera.getWorldPosition(camPos);

    // birds (skip the work entirely at night)
    if (birdMat.opacity > 0.01) {
      let bi = 0;
      for (const fl of flocks) {
        for (const b of fl.birds) {
          birdFrame(fl, b, t, _bf);
          euler.set(_bf.pitch, _bf.yaw, _bf.bank, 'YXZ');
          quat.setFromEuler(euler);
          pos.set(_bf.x, _bf.y, _bf.z);
          base.compose(pos, quat, one);
          birdBodies.setMatrixAt(bi, base);
          birdWingL.setMatrixAt(bi, wingMatrix(base, -_bf.flap));
          birdWingR.setMatrixAt(bi, wingMatrix(base, _bf.flap));
          bi++;
        }
      }
      birdBodies.instanceMatrix.needsUpdate = true;
      birdWingL.instanceMatrix.needsUpdate = true;
      birdWingR.instanceMatrix.needsUpdate = true;
    }

    // butterflies
    if (flyWingMat.opacity > 0.01) {
      for (let i = 0; i < nFly; i++) {
        const f = flies[i];
        flyWander(f, t, w0);
        const gust = windGustAt(f.hx, f.hz, t);
        f.dx += (wd.x * 0.9 * gust - f.dx / 5) * h;
        f.dz += (wd.y * 0.9 * gust - f.dz / 5) * h;
        flyWander(f, t + 0.1, w1);
        const yaw = Math.atan2(w1.x - w0.x, w1.z - w0.z);
        pos.set(f.hx + w0.x + f.dx, f.hy + f.hov + 0.3 * Math.sin(t * f.bob + f.p1), f.hz + w0.z + f.dz);
        quat.setFromAxisAngle(UP, yaw);
        base.compose(pos, quat, one);
        flyBody.setMatrixAt(i, base);
        const sx = 0.22 + 0.78 * Math.abs(Math.cos(f.fp + t * f.fs));
        scl.set(sx, 1, 1);
        flyWings.setMatrixAt(i, m4.compose(pos, quat, scl));
      }
      flyWings.instanceMatrix.needsUpdate = true;
      flyBody.instanceMatrix.needsUpdate = true;
    }

    // mist: drifts with the wind and wraps round, fading to nothing at the ends of its trail
    for (let i = 0; i < mist.length; i++) {
      const p = mist[i];
      const s = wrapSigned(t * p.sp + p.ph, MIST_L);
      const x = p.x + wd.x * s;
      const z = p.z + wd.y * s;
      // never hang a sheet of mist in front of the lens or low over the meadow by the city
      const camD = Math.hypot(camPos.x - x, camPos.y - p.y, camPos.z - z);
      const fade = clamp01((MIST_L / 2 - Math.abs(s)) / 60) * smooth(220, 420, camD) * smooth(200, 320, field.edgeDist(x, z));
      pos.set(x, p.y + 4 * Math.sin(t * 0.05 + p.ph), z);
      quat.setFromAxisAngle(UP, Math.atan2(camPos.x - x, camPos.z - z)); // face the camera (yaw only)
      scl.set(p.w * fade, p.h * fade, 1);
      mistMesh.setMatrixAt(i, m4.compose(pos, quat, scl));
    }
    mistMesh.instanceMatrix.needsUpdate = true;

    setClouds(t);

    // fireflies (only while visible)
    if (fireflies.visible) {
      for (let i = 0; i < NF; i++) {
        const f = ffHomes[i];
        ffPos[i * 3] = f.x + 0.8 * Math.sin(t * 0.6 + f.p);
        ffPos[i * 3 + 1] = f.y + 0.6 * Math.sin(t * 0.9 + f.p * 2);
        ffPos[i * 3 + 2] = f.z + 0.8 * Math.cos(t * 0.5 + f.p * 1.3);
        const br = Math.pow(0.5 + 0.5 * Math.sin(t * 2.3 + f.p * 3), 6);
        ffCol[i * 3] = br;
        ffCol[i * 3 + 1] = br * 0.95;
        ffCol[i * 3 + 2] = br * 0.35;
      }
      (ffGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (ffGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }
  };

  const setNight = (n: number) => {
    const birdsOn = 1 - smooth(0.45, 0.65, n);
    birdMat.opacity = birdsOn;
    birdBodies.visible = birdWingL.visible = birdWingR.visible = birdsOn > 0.01;
    flyWingMat.opacity = birdsOn;
    flyBodyMat.opacity = birdsOn;
    flyWings.visible = flyBody.visible = birdsOn > 0.01;
    mistMat.color.copy(MIST_DAY).lerp(MIST_NIGHT, n);
    mistMat.opacity = 0.55 * (1 - 0.35 * n);
    cloudMat.color.copy(CLOUD_DAY).lerp(CLOUD_NIGHT, n);
    ffMat.opacity = smooth(0.35, 0.7, n);
    fireflies.visible = ffMat.opacity > 0.01;
  };

  return {
    group,
    update,
    setNight,
    dispose: () => {
      for (const o of owned) o.dispose();
      group.removeFromParent();
    },
  };
}
