import * as THREE from 'three';
import { HALF_D, HALF_W } from '../../core/constants';
import type { GridCell } from '../../core/types';
import type { Biome, Field } from './types';

/**
 * The landform of the whole landscape, computed ONCE at build time onto a non-uniform lattice
 * (4 m from the board out to 400 m, growing to 36 m far away) and then sampled bilinearly.
 *
 *   plain around the board (flush with it) -> rolling meadow -> foothills -> mountain ring
 *   + country lanes continuing every road that reaches the board edge
 *   + the river continuing out of the board (north = from a mountain valley, south = through a lake)
 *
 * terrain.ts builds the meshes from the `TerrainData` attached to the returned field.
 */
export const EXTENT = 2208;
const LOT_Y = 0.18;
const FINE_STEP = 4;
const FINE_TO = 360;
const MAX_STEP = 40;

// ───────────────────────────── helpers ─────────────────────────────
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function ihash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const hash1 = (n: number, s = 0): number => ihash(n, 7919, s);

/** Smooth value noise 0..1. */
function vn(x: number, y: number, s = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = ihash(ix, iy, s);
  const b = ihash(ix + 1, iy, s);
  const c = ihash(ix, iy + 1, s);
  const d = ihash(ix + 1, iy + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x: number, y: number, oct: number, s: number): number {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const rx = (x * 0.8 + y * 0.6) * f;
    const ry = (-x * 0.6 + y * 0.8) * f;
    sum += a * vn(rx, ry, s + i);
    norm += a;
    a *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}
function ridged(x: number, y: number, oct: number, s: number): number {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const rx = (x * 0.8 + y * 0.6) * f;
    const ry = (-x * 0.6 + y * 0.8) * f;
    let n = 1 - Math.abs(vn(rx, ry, s + i) * 2 - 1);
    n *= n;
    sum += a * n;
    norm += a;
    a *= 0.5;
    f *= 2.07;
  }
  return sum / norm;
}

// ───────────────────────────── water ─────────────────────────────
export interface River {
  side: 1 | -1; // +1 leaves through the south edge (z>0), -1 through the north edge
  cx: number; // x of the river centre at the seam
  ph1: number;
  ph2: number;
  amp: number;
  k: number; // water-level rise per metre
  plateau: [number, number] | null; // flat stretch (the lake) in s
  xr(s: number): number;
  hw(s: number): number;
  wl(s: number): number;
  end: number; // water ends (spring) at this s
}
export interface Lake {
  cx: number;
  cz: number;
  ax: number;
  az: number;
  rot: number;
  level: number;
  /** <1 inside the shoreline */
  q(x: number, z: number): number;
}
export interface Lane {
  ax: 0 | 1; // 0: runs along z (lateral = x); 1: runs along x (lateral = z)
  sg: 1 | -1;
  c: number;
  amp: number;
  f: number;
  ph: number;
  L: number;
  ys: Float32Array; // road surface height every 4 m
  lateral(s: number): number;
  hw(s: number): number;
  y(s: number): number;
}

// ───────────────────────────── colours ─────────────────────────────
const col = (h: number) => new THREE.Color(h);
const PAL = {
  lot: col(0x71835a),
  meadowA: col(0x62a043),
  meadowB: col(0x82b84c),
  gold: col(0xb5b84c),
  forestA: col(0x2f7a3a),
  forestB: col(0x4a8c3c),
  alpineA: col(0x86a052),
  alpineB: col(0xa6ae62),
  rockA: col(0x6f675c),
  rockB: col(0xa49a86),
  rockWarm: col(0x9a7e62),
  snow: col(0xf6f3e8),
  snowShade: col(0xc9d6e6),
  sand: col(0xc9b57d),
  mud: col(0x8d7650),
  fieldWheat: col(0xd3b552),
  fieldGreen: col(0x4f9c3e),
  fieldLight: col(0x9bc455),
  fieldPlow: col(0xa57a4a),
  hedge: col(0x2f6a33),
};

// ───────────────────────────── public data ─────────────────────────────
export interface TerrainData {
  xs: Float64Array; // lattice coordinates (same for x and z)
  n: number;
  H: Float32Array; // n*n, index iz*n + ix
  rivers: River[];
  lake: Lake;
  lanes: Lane[];
  /** distance beyond the water edge (negative inside water); Infinity far from water */
  waterMargin(x: number, z: number): number;
  /** terrain colour; sheen written to sheenOut[0] (0..1) */
  colorAt(x: number, z: number, h: number, slope: number, out: THREE.Color, sheenOut: Float32Array): void;
  /** farm-field plots for hedge placement */
  plot: { w: number; d: number; ox: number; oz: number; amount(x: number, z: number): number };
}
export type FieldX = Field & { data: TerrainData };

export function createField(cells: GridCell[]): FieldX {
  // ── river seam positions from the city cells ──
  const seamCx = (row: number, fallback: number): number => {
    let min = Infinity;
    let max = -Infinity;
    for (const c of cells) {
      if (c.row === row && (c.terrain === 'river' || c.terrain === 'bridge')) {
        min = Math.min(min, c.col);
        max = Math.max(max, c.col);
      }
    }
    return isFinite(min) ? ((min + max + 1) / 2) * 12 - HALF_W : fallback;
  };
  const lastRow = Math.max(...cells.map((c) => c.row));
  const mkRiver = (side: 1 | -1, cx: number, seed: number): River => {
    const amp = 38;
    const ph1 = hash1(seed, 1) * 6.28;
    const ph2 = hash1(seed, 2) * 6.28;
    const k = side === 1 ? 0.011 : 0.017;
    const plateau: [number, number] | null = side === 1 ? [200, 440] : null;
    const r: River = {
      side, cx, ph1, ph2, amp, k, plateau, end: side === 1 ? 1000 : 1750,
      xr(s) {
        return cx + amp * smooth(0, 150, s) * Math.sin(s / 175 + ph1) + amp * 0.26 * smooth(0, 320, s) * Math.sin(s / 63 + ph2);
      },
      hw(s) {
        return (12 + 2.2 * Math.sin(s / 95 + ph2) * smooth(30, 120, s)) * (1 - 0.8 * smooth((side === 1 ? 1000 : 1750) - 340, (side === 1 ? 1000 : 1750) - 40, s));
      },
      wl(s) {
        let w = s;
        if (plateau) w = s < plateau[0] ? s : s < plateau[1] ? plateau[0] : s - (plateau[1] - plateau[0]);
        return -1.1 + k * w;
      },
    };
    return r;
  };
  const rivers: River[] = [mkRiver(-1, seamCx(0, 60), 11), mkRiver(1, seamCx(lastRow, 60), 23)];
  const riverS = rivers[1];

  // lake beside/under the southern river
  const lakeS = 330;
  const lakeCx = riverS.xr(lakeS) + 55;
  const lakeCz = HALF_D + lakeS;
  const lakeRot = 0.5;
  const lakeLevel = riverS.wl(lakeS);
  const lake: Lake = {
    cx: lakeCx, cz: lakeCz, ax: 100, az: 64, rot: lakeRot, level: lakeLevel,
    q(x, z) {
      const dx = x - lakeCx;
      const dz = z - lakeCz;
      if (dx > 420 || dx < -420 || dz > 420 || dz < -420) return 9;
      const c = Math.cos(lakeRot);
      const s = Math.sin(lakeRot);
      const u = (dx * c + dz * s) / lake.ax;
      const v = (-dx * s + dz * c) / lake.az;
      const th = Math.atan2(v, u);
      const wob = 1 + 0.14 * Math.sin(3 * th + 1.1) + 0.08 * Math.sin(5 * th + 0.4) + 0.05 * Math.sin(8 * th);
      return Math.hypot(u, v) / wob;
    },
  };

  // river geometry at a point, written into a scratch struct
  const RW = { r: rivers[0], s: 0, dr: Infinity, hw: 0, wl: 0 };
  const riverAt = (x: number, z: number): boolean => {
    const az = Math.abs(z);
    if (az < HALF_D) return false;
    const r = z > 0 ? rivers[1] : rivers[0];
    const s = az - HALF_D;
    if (s > 1500) return false;
    RW.r = r;
    RW.s = s;
    RW.dr = Math.abs(x - r.xr(s));
    RW.hw = r.hw(s);
    RW.wl = r.wl(s);
    return RW.dr < 420;
  };

  // ── base landform (no water, no lanes) ──
  const base = (x: number, z: number): number => {
    const ax = Math.abs(x);
    const az = Math.abs(z);
    const ed = Math.hypot(Math.max(0, ax - HALF_W), Math.max(0, az - HALF_D));
    // level of the board edge: lots (east/south) vs roads (west/north)
    const sel = Math.max(x - HALF_W, z - HALF_D) - Math.max(-x - HALF_W, -z - HALF_D);
    const T = LOT_Y * smooth(-30, 30, sel) * (1 - smooth(0, 50, ed));
    const r6 = Math.pow(ax ** 6 + az ** 6, 1 / 6);
    const dd = Math.max(0, r6 - 300);

    const A1 = smooth(8, 150, ed);
    const n1 = clamp01((fbm(x * 0.0045, z * 0.0045, 3, 11) - 0.28) / 0.44);
    const n2 = fbm(x * 0.016, z * 0.016, ed < 400 ? 3 : 2, 23) - 0.5;
    const n3 = ed < 300 ? fbm(x * 0.05, z * 0.05, 2, 29) - 0.5 : 0;
    const hill = A1 * (5 + 30 * smooth(120, 750, dd)) * n1 + A1 * smooth(20, 220, ed) * (n2 * 6 + n3 * 1.2);

    const bowl = 105 * Math.pow(smooth(60, 560, ed), 1.6);
    if (dd < 380) return T + hill + bowl;
    const rg = ridged(x * 0.0031, z * 0.0031, 3, 31);
    const foot = smooth(420, 1000, dd) * (28 + 80 * smooth(550, 1150, dd)) * rg;

    const mt = smooth(780, 1400, dd);
    if (mt <= 0) return T + hill + foot + bowl;
    const ang = Math.atan2(z, x);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const env = 0.55 * vn(ca * 1.7 + 7, sa * 1.7 + 3, 5) + 0.45 * vn(ca * 3.9 + 1, sa * 3.9 + 9, 6);
    const envS = smooth(0.22, 0.78, env);
    const mr = ridged(x * 0.0013 + 3, z * 0.0013 - 5, 4, 41);
    const peak = Math.pow(mr, 1.25);
    let mh = mt * (130 + (150 + 520 * envS) * peak);
    mh *= 1 + 0.5 * smooth(1000, 1700, dd);
    mh *= 1 - 0.5 * smooth(1750, 2150, dd);
    const detail = mt * ((fbm(x * 0.012, z * 0.012, 3, 51) - 0.5) * 55 + (vn(x * 0.03, z * 0.03, 53) - 0.5) * 26 + (vn(x * 0.07, z * 0.07, 54) - 0.5) * 10) * (0.4 + peak);
    return T + hill + foot + mh + detail + bowl;
  };

  // ── lanes ──
  const lanes: Lane[] = [];
  const mkLane = (ax: 0 | 1, sg: 1 | -1, c: number, idx: number, edgeRoad: boolean, arterial: boolean): void => {
    const amp = (hash1(idx, 3) - 0.5) * (edgeRoad ? 12 : 54);
    const f = 1 / (120 + hash1(idx, 4) * 120);
    const ph = hash1(idx, 5) * 6.28;
    const lat = (s: number) => c + amp * smooth(0, 170, s) * Math.sin(s * f + ph);
    const hwF = (s: number, L: number) => (3.1 + 2.9 * (1 - smooth(0, 90, s))) * (1 - 0.45 * smooth(L - 90, L, s));
    let Lc = edgeRoad ? 90 + hash1(idx, 6) * 70 : arterial ? 1100 : 230 + hash1(idx, 6) * 560;
    // walk out, stop at steep/high ground, water, lake
    const step = FINE_STEP;
    const N = Math.ceil(Lc / step);
    const raw = new Float32Array(N + 1);
    let stop = Lc;
    for (let i = 0; i <= N; i++) {
      const s = i * step;
      const l = lat(s);
      const wx = ax === 0 ? l : sg * (HALF_W + s);
      const wz = ax === 0 ? sg * (HALF_D + s) : l;
      raw[i] = base(wx, wz);
      if (s > 20) {
        if (raw[i] > 80) { stop = Math.min(stop, s); break; }
        if (Math.abs(raw[i] - raw[Math.max(0, i - 4)]) / (4 * step) > 0.1) { stop = Math.min(stop, s); break; }
      }
      if (riverAt(wx, wz) && RW.dr < RW.hw + 46 && RW.s < RW.r.end + 60) { stop = Math.min(stop, Math.max(0, s - 12)); break; }
      if (lake.q(wx, wz) < 2.3) { stop = Math.min(stop, Math.max(0, s - 12)); break; }
    }
    Lc = Math.min(Lc, stop);
    if (Lc < 50) Lc = 0;
    const n = Math.floor(Lc / step) + 1;
    const sm = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? raw : sm.slice();
      for (let i = 0; i < n; i++) {
        let a = 0, w = 0;
        for (let j = -5; j <= 5; j++) {
          const k = Math.min(n - 1, Math.max(0, i + j));
          a += src[k];
          w++;
        }
        sm[i] = a / w;
      }
    }
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) ys[i] = lerp(0, sm[i], smooth(0, 60, i * step));
    const lane: Lane = {
      ax, sg, c, amp, f, ph, L: Lc, ys,
      lateral: lat,
      hw: (s) => hwF(s, Lc),
      y(s) {
        const t = Math.max(0, Math.min(n - 1.001, s / step));
        const i = Math.floor(t);
        return lerp(ys[i], ys[i + 1] ?? ys[i], t - i);
      },
    };
    if (Lc > 0) lanes.push(lane);
  };
  {
    let idx = 100;
    for (let k = 0; k < 8; k++) {
      const c = -282 + 72 * k;
      const edgeRoad = k === 0;
      const arterial = k === 4;
      for (const sg of [-1, 1] as const) {
        mkLane(0, sg, c, idx++, edgeRoad, arterial);
        mkLane(1, sg, c, idx++, edgeRoad, arterial);
      }
    }
  }

  const laneAt = { s: 0, dl: 0, hw: 0, lane: lanes[0] as Lane | undefined };
  /** nearest lane influence; returns false if none close. */
  const laneNear = (x: number, z: number, reach: number): boolean => {
    const ax_ = Math.abs(x);
    const az_ = Math.abs(z);
    if (ax_ < HALF_W - 1 && az_ < HALF_D - 1) return false;
    let found = false;
    let best = Infinity;
    for (let i = 0; i < lanes.length; i++) {
      const ln = lanes[i];
      const s = ln.ax === 0 ? ln.sg * z - HALF_D : ln.sg * x - HALF_W;
      if (s < -1 || s > ln.L + 40) continue;
      const lat = ln.ax === 0 ? x : z;
      if (Math.abs(lat - ln.c) > Math.abs(ln.amp) + reach + 8) continue;
      const dl = Math.abs(lat - ln.lateral(s));
      const hw = ln.hw(s);
      if (dl - hw < best) {
        best = dl - hw;
        laneAt.s = s;
        laneAt.dl = dl;
        laneAt.hw = hw;
        laneAt.lane = ln;
        found = true;
      }
    }
    return found && best < reach;
  };

  // ── full height (build time only; runtime uses the lattice) ──
  const heightRaw = (x: number, z: number): number => {
    if (Math.abs(x) < HALF_W - 8 && Math.abs(z) < HALF_D - 8) return 0;
    let h = base(x, z);
    // lake
    const q = lake.q(x, z);
    if (q < 3.2) {
      const L0 = lake.level;
      const raised = Math.max(h, L0 + 0.9 + Math.max(0, q - 1) * 5);
      h = lerp(h, raised, smooth(3.2, 1.6, q));
    }
    // river
    if (riverAt(x, z)) {
      const { r, s, dr, hw, wl } = RW;
      const fade = 1 - smooth(r.end - 40, r.end + 220, s);
      if (fade > 0) {
        const bed = wl - 0.6;
        const near = Math.max(wl + 0.55, Math.min(h, wl + 1.3 + Math.max(0, dr - hw) * 0.12));
        const W = 4 + 72 * smooth(0, 170, s) + 170 * smooth(150, 700, s);
        const t = smooth(hw + 4, hw + 4 + W, dr);
        const hv = Math.max(h, wl + 0.6 + Math.min(40, Math.max(0, dr - hw)) * 0.05);
        const prof = lerp(bed, near, smooth(hw - 4, hw + 2, dr));
        const wR = 1 - smooth(hw + W + 10, hw + W + 120, dr);
        h = lerp(h, lerp(prof, hv, t), fade * wR);
        if (r.side === -1) {
          // northern river comes down from a mountain valley
          const nb = smooth(560, 1200, s) * (1 - smooth(260, 640, dr)) * fade;
          const notch = wl + 8 + dr * 0.25 + dr * dr * 0.0009;
          h = lerp(h, Math.min(h, notch), nb);
        }
      }
    }
    // lake basin (after the river so the river's valley-raising never dries the lake)
    if (q < 1.85) {
      const bedP = q < 1 ? lake.level - 0.5 - 3.2 * (1 - q) : lake.level - 0.5 + (q - 1) * 4.5;
      h = Math.min(h, lerp(h, bedP, smooth(1.85, 1.0, q)));
    }
    // lanes
    if (laneNear(x, z, 14)) {
      const ln = laneAt.lane!;
      const endF = 1 - smooth(ln.L - 10, ln.L + 30, laneAt.s);
      const kcore = (1 - smooth(laneAt.hw + 3, laneAt.hw + 11, laneAt.dl)) * endF;
      if (kcore > 0) h = lerp(h, ln.y(Math.min(laneAt.s, ln.L)), kcore);
    }
    return h;
  };

  // ── lattice ──
  const half: number[] = [0];
  {
    let x = 0;
    let step = FINE_STEP;
    while (x < EXTENT - 1e-6) {
      if (x >= FINE_TO) step = Math.min(MAX_STEP, step * 1.045);
      x = Math.min(EXTENT, x + step);
      half.push(x);
    }
  }
  const n = half.length * 2 - 1;
  const xs = new Float64Array(n);
  for (let i = 0; i < half.length; i++) {
    xs[half.length - 1 + i] = half[i];
    xs[half.length - 1 - i] = -half[i];
  }
  const H = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    const z = xs[iz];
    for (let ix = 0; ix < n; ix++) H[iz * n + ix] = heightRaw(xs[ix], z);
  }
  // slope grid
  const S = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    const z0 = iz > 0 ? iz - 1 : iz;
    const z1 = iz < n - 1 ? iz + 1 : iz;
    for (let ix = 0; ix < n; ix++) {
      const x0 = ix > 0 ? ix - 1 : ix;
      const x1 = ix < n - 1 ? ix + 1 : ix;
      const gx = (H[iz * n + x1] - H[iz * n + x0]) / (xs[x1] - xs[x0]);
      const gz = (H[z1 * n + ix] - H[z0 * n + ix]) / (xs[z1] - xs[z0]);
      S[iz * n + ix] = Math.hypot(gx, gz);
    }
  }
  // index lookup: largest i with xs[i] <= k - EXTENT
  const lut = new Int16Array(2 * EXTENT + 2);
  {
    let i = 0;
    for (let k = 0; k < lut.length; k++) {
      const v = k - EXTENT;
      while (i < n - 2 && xs[i + 1] <= v) i++;
      lut[k] = i;
    }
  }
  const sample = (G: Float32Array, x: number, z: number): number => {
    const cx = x < -EXTENT ? -EXTENT : x > EXTENT ? EXTENT : x;
    const cz = z < -EXTENT ? -EXTENT : z > EXTENT ? EXTENT : z;
    const i = lut[(cx + EXTENT) | 0];
    const j = lut[(cz + EXTENT) | 0];
    const tx = (cx - xs[i]) / (xs[i + 1] - xs[i]);
    const tz = (cz - xs[j]) / (xs[j + 1] - xs[j]);
    const o = j * n + i;
    const a = G[o] + (G[o + 1] - G[o]) * tx;
    const b = G[o + n] + (G[o + n + 1] - G[o + n]) * tx;
    return a + (b - a) * tz;
  };

  // ── runtime queries ──
  const edgeDist = (x: number, z: number) => Math.hypot(Math.max(0, Math.abs(x) - HALF_W), Math.max(0, Math.abs(z) - HALF_D));
  const height = (x: number, z: number) => (Math.abs(x) <= HALF_W && Math.abs(z) <= HALF_D ? 0 : sample(H, x, z));
  const slope = (x: number, z: number) => sample(S, x, z);

  const waterMargin = (x: number, z: number): number => {
    let m = Infinity;
    if (riverAt(x, z) && RW.s < RW.r.end - 20) m = RW.dr - RW.hw;
    const q = lake.q(x, z);
    if (q < 1.6) m = Math.min(m, (q - 1) * 55);
    return m;
  };
  const water = (x: number, z: number): number => {
    const m = waterMargin(x, z);
    return m === Infinity ? 0 : 1 - smooth(-2, 1.5, m);
  };
  const road = (x: number, z: number): number => {
    if (!laneNear(x, z, 4)) return 0;
    const ln = laneAt.lane!;
    const endF = 1 - smooth(ln.L - 5, ln.L + 25, laneAt.s);
    return (1 - smooth(laneAt.hw + 0.3, laneAt.hw + 2.5, laneAt.dl)) * endF;
  };

  // farm plots (in the meadow, outside the board)
  const PW = 96;
  const PD = 66;
  const OX = 17;
  const OZ = 9;
  const plotAmount = (x: number, z: number, ed: number, s: number): number => {
    const ix = Math.floor((x + OX) / PW);
    const iz = Math.floor((z + OZ) / PD);
    const hsh = ihash(ix, iz, 91);
    const zone = smooth(18, 55, ed) * (1 - smooth(200, 330, ed)) * (1 - smooth(0.05, 0.14, s));
    return hsh < 0.74 ? zone : 0;
  };

  const biome = (x: number, z: number, out: Biome = { meadow: 0, forest: 0, alpine: 0, rock: 0, snow: 0 }): Biome => {
    const h = height(x, z);
    const s = slope(x, z);
    const ed = edgeDist(x, z);
    biomeCore(x, z, h, s, ed, out);
    const veg = (1 - road(x, z)) * (1 - water(x, z));
    if (veg < 1) {
      out.meadow *= veg;
      out.forest *= veg;
      out.alpine *= veg;
      out.snow *= veg;
      out.rock = out.rock * veg + (1 - veg);
    }
    return out;
  };
  function biomeCore(x: number, z: number, h: number, s: number, ed: number, out: Biome): void {
    const patch = vn(x * 0.0065, z * 0.0065, 61);
    const snowLine = 430 + (patch - 0.5) * 120;
    const snow = smooth(snowLine, snowLine + 70, h) * (1 - 0.65 * smooth(0.9, 1.7, s));
    const rock = (1 - snow) * Math.max(smooth(0.9, 1.5, s), smooth(300, 400, h + (patch - 0.5) * 60));
    const rest = 1 - snow - rock;
    const alpine = rest * smooth(150, 250, h + (patch - 0.5) * 50);
    const fz = smooth(70, 190, ed) * (1 - smooth(170, 260, h)) * smooth(0.12, 0.42, vn(x * 0.0045 + 3, z * 0.0045 - 8, 63) + 0.25 * (h / 120));
    const forest = (rest - alpine) * fz;
    out.snow = snow;
    out.rock = rock;
    out.alpine = alpine;
    out.forest = forest;
    out.meadow = Math.max(0, rest - alpine - forest);
  }

  const bio: Biome = { meadow: 0, forest: 0, alpine: 0, rock: 0, snow: 0 };
  const tmpA = new THREE.Color();
  const tmpB = new THREE.Color();
  const cF = new THREE.Color(), cA = new THREE.Color(), cR = new THREE.Color(), cS = new THREE.Color();
  const colorAt = (x: number, z: number, h: number, s: number, out: THREE.Color, sheenOut: Float32Array): void => {
    const ed = edgeDist(x, z);
    biomeCore(x, z, h, s, ed, bio);
    const pa = vn(x * 0.012, z * 0.012, 71);
    const pb = vn(x * 0.04, z * 0.04, 72);
    // meadow
    tmpA.copy(PAL.meadowA).lerp(PAL.meadowB, pa);
    tmpA.lerp(PAL.gold, smooth(0.6, 0.85, vn(x * 0.02 + 5, z * 0.02, 73)) * 0.45);
    tmpA.multiplyScalar(1 + (pb - 0.5) * 0.2);
    // farm plots
    const farm = ed < 340 ? plotAmount(x, z, ed, s) : 0;
    let farmAmt = 0;
    if (farm > 0) {
      const ix = Math.floor((x + OX) / PW);
      const iz = Math.floor((z + OZ) / PD);
      const type = ihash(ix, iz, 92);
      const fc = type < 0.28 ? PAL.fieldWheat : type < 0.5 ? PAL.fieldGreen : type < 0.72 ? PAL.fieldLight : type < 0.82 ? PAL.fieldPlow : PAL.meadowB;
      tmpB.copy(fc);
      const stripe = Math.sin((type > 0.5 ? x : z) * 0.52 + type * 9) * 0.5 + 0.5;
      tmpB.multiplyScalar(1 + (stripe - 0.5) * 0.2 + (ihash(ix, iz, 93) - 0.5) * 0.18);
      tmpA.lerp(tmpB, farm * 0.9);
      farmAmt = farm;
      // hedge lines between plots
      const fx = x + OX - ix * PW;
      const fz2 = z + OZ - iz * PD;
      const bd = Math.min(fx, PW - fx, fz2, PD - fz2);
      const hedge = (1 - smooth(1.2, 4.2, bd)) * farm;
      tmpA.lerp(PAL.hedge, hedge * 0.75);
    }
    // forest / alpine / rock / snow
    const fN = bio.forest + bio.rock > 0.001 ? vn(x * 0.03, z * 0.03, 74) : 0;
    out.setRGB(tmpA.r * bio.meadow, tmpA.g * bio.meadow, tmpA.b * bio.meadow);
    if (bio.forest > 0.001) {
      const c = cF.copy(PAL.forestA).lerp(PAL.forestB, fN);
      out.r += c.r * bio.forest; out.g += c.g * bio.forest; out.b += c.b * bio.forest;
    }
    if (bio.alpine > 0.001) {
      const c = cA.copy(PAL.alpineA).lerp(PAL.alpineB, pb);
      out.r += c.r * bio.alpine; out.g += c.g * bio.alpine; out.b += c.b * bio.alpine;
    }
    if (bio.rock > 0.001) {
      const c = cR.copy(PAL.rockA).lerp(PAL.rockB, 0.5 + 0.3 * Math.sin(h * 0.11 + fN * 6) + (pb - 0.5) * 0.5).lerp(PAL.rockWarm, smooth(0.55, 0.85, vn(x * 0.011, z * 0.011, 75)) * 0.5);
      out.r += c.r * bio.rock; out.g += c.g * bio.rock; out.b += c.b * bio.rock;
    }
    if (bio.snow > 0.001) {
      const c = cS.copy(PAL.snow).lerp(PAL.snowShade, smooth(0.5, 1.5, s) * 0.6);
      out.r += c.r * bio.snow; out.g += c.g * bio.snow; out.b += c.b * bio.snow;
    }
    // blend into the city lot colour at the seam
    let roadHere = 0;
    if (ed < 120) {
      const cellJit = (ihash(Math.floor((x + HALF_W) / 12), Math.floor((z + HALF_D) / 12), 0) - 0.5) * 0.035;
      tmpB.copy(PAL.lot).multiplyScalar(1 + cellJit * 2.5);
      const seam = 1 - smooth(0, 85, ed);
      out.lerp(tmpB, seam * seam * (1 - farmAmt * 0.3));
    }
    if (ed < 1100) roadHere = road(x, z);
    // shores and river banks
    const wm2 = ed < 1900 && Math.abs(x) < 800 ? waterMargin(x, z) : Infinity;
    let shore = 0;
    if (wm2 < Infinity) {
      shore = 1 - smooth(1.0, 9, wm2);
      tmpB.copy(PAL.sand).lerp(PAL.mud, smooth(-1, 3, wm2) * 0.4 + (1 - shore) * 0.3);
      out.lerp(tmpB, shore * 0.92);
    }
    sheenOut[0] = clamp01(bio.meadow + bio.alpine * 0.6 + bio.forest * 0.4) * (1 - shore) * (1 - roadHere);
  };

  const field: FieldX = {
    extent: EXTENT,
    height,
    edgeDist,
    slope,
    normal(x, z, out = new THREE.Vector3()) {
      const e = 2;
      return out.set(height(x - e, z) - height(x + e, z), 2 * e, height(x, z - e) - height(x, z + e)).normalize();
    },
    road,
    water,
    biome,
    data: {
      xs, n, H, rivers, lake, lanes, waterMargin, colorAt,
      plot: { w: PW, d: PD, ox: OX, oz: OZ, amount: (x, z) => plotAmount(x, z, edgeDist(x, z), slope(x, z)) },
    },
  };
  return field;
}
