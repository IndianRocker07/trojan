import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF_D, HALF_W } from '../../core/constants';
import type { GridCell } from '../../core/types';
import { COLORS, MAT } from '../palette';
import { applyWind, type WindOptions } from './wind';
import type { Biome, EnvPart, Field } from './types';

/**
 * Nature: trees, bushes, wildflowers, rocks, stumps, willows and reeds around the city and out
 * over the foothills. Chunky flat-shaded toon models, one merged geometry per kind, one
 * InstancedMesh per kind. Placement is deterministic (hash + value noise), never Math.random.
 * Trees/bushes/flowers sway through env/wind.ts; rocks, logs and stumps stay still.
 */

const TAU = Math.PI * 2;
const CS = 40; // survey cell size (m)
const R_MAX = 1200; // placement radius from the origin (m)
const UP = new THREE.Vector3(0, 1, 0);

// ───────────────────────────── deterministic helpers ─────────────────────────────

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Integer hash -> [0, 1). */
function h2(a: number, b: number, c: number, seed: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0, 1). */
function vnoise(x: number, z: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = smooth(0, 1, fx - ix);
  const tz = smooth(0, 1, fz - iz);
  const a = h2(ix, iz, 0, seed);
  const b = h2(ix + 1, iz, 0, seed);
  const c = h2(ix, iz + 1, 0, seed);
  const d = h2(ix + 1, iz + 1, 0, seed);
  const ab = a + (b - a) * tx;
  const cd = c + (d - c) * tx;
  return ab + (cd - ab) * tz;
}

/** mulberry32: small seeded RNG, one per candidate. */
function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────── palette ─────────────────────────────

const C = {
  bark: 0x7a4a26,
  barkLight: 0xa8703c,
  birchBark: 0xf1ead6,
  birchBand: 0x3b3a33,
  leafLight: 0x6cc83a,
  leafMid: 0x47a82a,
  leafDeep: 0x2f8f1c,
  leafTop: 0x8fd94a,
  pineDeep: 0x23741a,
  pineMid: 0x2f8f1c,
  pineLight: 0x4aae2c,
  birchLeaf: 0xa6e05a,
  birchLeaf2: 0x86cf45,
  poplarDeep: 0x2c7f1a,
  poplarMid: 0x3a9424,
  poplarLight: 0x58b632,
  willowLight: 0x9ad65a,
  willowDeep: 0x6fbf3a,
  reed: 0x6aa83a,
  reedTip: 0x9cc65a,
  rockA: 0xa39f94,
  rockB: 0x7d7f78,
  stumpTop: 0xd9a86a,
  log: 0x8a5a33,
};
const FLOWERS = [COLORS.yellow, COLORS.paper, COLORS.lilac, COLORS.pink, COLORS.coral, COLORS.yellow];

// ───────────────────────────── geometry kit ─────────────────────────────

interface Xf {
  x?: number;
  y?: number;
  z?: number;
  sx?: number;
  sy?: number;
  sz?: number;
  rx?: number;
  ry?: number;
  rz?: number;
}

/**
 * Finish one primitive for merging: optional deterministic vertex jitter (keyed by position so
 * shared corners move together), transform, flat normals, and a vertex colour attribute.
 */
function piece(src: THREE.BufferGeometry, xf: Xf, color: number, jitter = 0, seed = 1): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src;
  if (g !== src) src.dispose();
  g.deleteAttribute('uv');
  if (jitter > 0) {
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const kx = Math.round(x * 1000);
      const ky = Math.round(y * 1000);
      const kz = Math.round(z * 1000);
      p.setXYZ(
        i,
        x + (h2(kx, ky, kz, seed) - 0.5) * 2 * jitter,
        y + (h2(kx, ky, kz, seed + 1) - 0.5) * 2 * jitter,
        z + (h2(kx, ky, kz, seed + 2) - 0.5) * 2 * jitter,
      );
    }
  }
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(xf.x ?? 0, xf.y ?? 0, xf.z ?? 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(xf.rx ?? 0, xf.ry ?? 0, xf.rz ?? 0)),
    new THREE.Vector3(xf.sx ?? 1, xf.sy ?? 1, xf.sz ?? 1),
  );
  g.applyMatrix4(m);
  g.computeVertexNormals();
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Merge finished pieces into one geometry (all pieces share position/normal/color). */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('nature: geometry merge failed');
  parts.forEach((p) => p.dispose());
  return g;
}

const ico = (
  r: number,
  detail: number,
  x: number,
  y: number,
  z: number,
  color: number,
  jit: number,
  seed: number,
  s: [number, number, number] = [1, 1, 1],
) => piece(new THREE.IcosahedronGeometry(r, detail), { x, y, z, sx: s[0], sy: s[1], sz: s[2] }, color, jit, seed);

const cyl = (rTop: number, rBot: number, h: number, seg: number, x: number, y: number, z: number, color: number, xf: Xf = {}) =>
  piece(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1), { ...xf, x, y, z }, color);

const cone = (r: number, h: number, seg: number, x: number, y: number, z: number, color: number, xf: Xf = {}, jit = 0, seed = 1) =>
  piece(new THREE.ConeGeometry(r, h, seg, 1, false), { ...xf, x, y, z }, color, jit, seed);

// ───────────────────────────── model builders ─────────────────────────────

/** Round broadleaf, version A: upright trunk under four lumpy crowns. ~12 m. */
function broadleafA(): THREE.BufferGeometry {
  return merge([
    cyl(0.2, 0.36, 5.8, 6, 0, 2.3, 0, C.bark),
    ico(3.0, 1, 0, 7.6, 0, C.leafLight, 0.45, 11),
    ico(2.2, 1, 1.9, 6.4, 0.6, C.leafDeep, 0.3, 12),
    ico(2.1, 1, -1.7, 6.7, -1.1, C.leafMid, 0.3, 13),
    ico(2.0, 1, 0.4, 9.5, -0.6, C.leafTop, 0.3, 14),
  ]);
}

/** Broadleaf, version B: wider, taller crown with a forked trunk feel. ~12 m. */
function broadleafB(): THREE.BufferGeometry {
  return merge([
    cyl(0.18, 0.3, 5.2, 6, 0, 2.0, 0, C.bark),
    ico(3.0, 1, 0, 7.9, 0, C.leafMid, 0.4, 21, [1.1, 1.22, 1.1]),
    ico(2.0, 1, 2.0, 6.8, 0.2, C.leafDeep, 0.25, 22),
    ico(1.9, 1, -1.0, 6.2, 1.6, C.leafLight, 0.25, 23),
    ico(1.8, 1, -0.4, 10.2, -0.9, C.leafTop, 0.25, 24),
  ]);
}

/** Birch: pale slender trunk with dark bands, airy light-green crown. ~11 m. */
function birch(): THREE.BufferGeometry {
  return merge([
    cyl(0.1, 0.17, 10.6, 6, 0, 4.7, 0, C.birchBark),
    cyl(0.18, 0.18, 0.22, 6, 0, 2.0, 0, C.birchBand),
    cyl(0.18, 0.18, 0.22, 6, 0, 5.6, 0, C.birchBand),
    cyl(0.18, 0.18, 0.22, 6, 0, 8.0, 0, C.birchBand),
    ico(1.9, 1, 0, 8.4, 0, C.birchLeaf, 0.25, 31, [0.85, 1.1, 0.85]),
    ico(1.4, 1, 0.9, 6.9, 0.5, C.birchLeaf2, 0.2, 32),
    ico(1.3, 1, -0.7, 7.1, -0.5, C.birchLeaf2, 0.2, 33),
    ico(1.2, 1, 0.1, 10.0, -0.1, C.birchLeaf, 0.2, 34),
  ]);
}

/** Stacked-cone conifer. Tiers are [radius, height, base y]. */
function conifer(tiers: Array<[number, number, number]>, colors: number[], trunkTop: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [cyl(0.2, 0.3, trunkTop + 0.6, 6, 0, (trunkTop - 0.6) / 2, 0, C.bark)];
  tiers.forEach(([r, h, base], i) => {
    parts.push(cone(r, h, 7, 0, base + h / 2, 0, colors[i % colors.length], { ry: i * 0.7 }, 0.08, 40 + i));
  });
  return merge(parts);
}
const pineA = () =>
  conifer(
    [
      [3.4, 4.0, 2.6],
      [2.8, 3.6, 4.9],
      [2.2, 3.2, 7.0],
      [1.6, 2.8, 8.9],
    ],
    [C.pineDeep, C.pineMid, C.pineDeep, C.pineLight],
    4.0,
  );
const pineB = () =>
  conifer(
    [
      [2.8, 3.2, 2.2],
      [2.4, 3.0, 4.0],
      [2.0, 2.8, 5.7],
      [1.6, 2.5, 7.4],
      [1.1, 2.2, 8.9],
    ],
    [C.pineMid, C.pineDeep, C.pineMid, C.pineDeep, C.pineLight],
    4.0,
  );

/** Narrow poplar / cypress: three stacked tall lumps. ~12 m. */
function poplar(): THREE.BufferGeometry {
  return merge([
    cyl(0.13, 0.17, 2.2, 6, 0, 0.5, 0, C.bark),
    ico(1.5, 0, 0, 4.4, 0, C.poplarDeep, 0.15, 41, [0.9, 1.9, 0.9]),
    ico(1.4, 0, 0, 7.6, 0, C.poplarMid, 0.15, 42, [0.9, 1.8, 0.9]),
    ico(1.1, 0, 0, 10.2, 0, C.poplarLight, 0.12, 43, [0.88, 1.6, 0.88]),
  ]);
}

/** Willow: low wide crown with drooping curtains around the rim. ~8 m. */
function willow(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    cyl(0.22, 0.34, 3.2, 6, 0, 1.0, 0, C.bark, { rz: 0.12 }),
    ico(2.6, 0, 0, 5.2, 0, C.willowLight, 0.3, 51, [1.2, 0.7, 1.2]),
    ico(2.2, 0, 1.4, 4.6, 0.6, C.willowDeep, 0.25, 52, [1.0, 0.75, 1.0]),
    ico(2.0, 0, -1.2, 4.8, -1.0, C.willowDeep, 0.25, 53, [1.0, 0.75, 1.0]),
  ];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + 0.2;
    parts.push(
      cone(0.55, 3.6, 5, Math.cos(a) * 2.5, 3.6, Math.sin(a) * 2.5, i % 2 ? C.willowLight : C.willowDeep, { rx: Math.PI }, 0.05, 60 + i),
    );
  }
  return merge(parts);
}

/** Reed clump: seven thin open cones standing on the bank. ~1.6 m. */
function reeds(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const a = h2(i, 3, 0, 71) * TAU;
    const d = 0.1 + h2(i, 4, 0, 72) * 0.35;
    const h = 1.1 + h2(i, 5, 0, 73) * 0.7;
    parts.push(
      piece(
        new THREE.ConeGeometry(0.05, h, 3, 1, true),
        { x: Math.cos(a) * d, y: h / 2 - 0.1, z: Math.sin(a) * d, rx: (h2(i, 6, 0, 74) - 0.5) * 0.3, rz: (h2(i, 7, 0, 75) - 0.5) * 0.3 },
        i % 3 === 0 ? C.reedTip : C.reed,
      ),
    );
  }
  return merge(parts);
}

/** Bush: three to four low icosahedron lumps. ~1.3 m. */
function bushA(): THREE.BufferGeometry {
  return merge([
    ico(0.8, 0, 0, 0.55, 0, C.leafDeep, 0.1, 81, [1.1, 0.85, 1.0]),
    ico(0.6, 0, 0.7, 0.42, 0.25, C.leafMid, 0.08, 82),
    ico(0.55, 0, -0.45, 0.42, -0.45, C.leafLight, 0.08, 83),
  ]);
}
function bushB(): THREE.BufferGeometry {
  return merge([
    ico(0.7, 0, 0, 0.5, 0.1, C.leafMid, 0.1, 91, [1.2, 0.8, 1.0]),
    ico(0.55, 0, -0.6, 0.38, 0.1, C.leafDeep, 0.08, 92),
    ico(0.5, 0, 0.2, 0.4, -0.6, C.leafTop, 0.08, 93),
    ico(0.45, 0, 0.6, 0.34, 0.5, C.leafLight, 0.08, 94),
  ]);
}

/** Wildflower patch heads: three crossed-quad blossoms held above the grass. Colour per instance. */
const FLOWER_HEADS: Array<[number, number]> = [
  [0, 0],
  [0.3, 0.14],
  [-0.26, 0.22],
];
const FLOWER_TOP = 0.62;
function flowers(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  FLOWER_HEADS.forEach(([x, z], i) => {
    parts.push(piece(new THREE.PlaneGeometry(0.3, 0.3), { x, y: FLOWER_TOP, z }, 0xffffff));
    parts.push(piece(new THREE.PlaneGeometry(0.3, 0.3), { x, y: FLOWER_TOP, z, ry: Math.PI / 2 + i * 0.3 }, 0xffffff));
  });
  return merge(parts);
}
/** Flower stems: thin green crossed quads from the ground to each blossom. */
function flowerStems(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  FLOWER_HEADS.forEach(([x, z], i) => {
    parts.push(piece(new THREE.PlaneGeometry(0.035, FLOWER_TOP), { x, y: FLOWER_TOP / 2 - 0.05, z }, C.leafMid));
    parts.push(piece(new THREE.PlaneGeometry(0.035, FLOWER_TOP), { x, y: FLOWER_TOP / 2 - 0.05, z, ry: Math.PI / 2 + i }, C.leafMid));
  });
  return merge(parts);
}

/** Boulder: one large lump with a smaller companion. Vertex colours carry the stone tone. */
function rockBig(): THREE.BufferGeometry {
  return merge([
    piece(new THREE.IcosahedronGeometry(1.0, 1), { y: 0.4, sx: 1.3, sy: 0.85, sz: 1.05, ry: 0.7 }, C.rockA, 0.22, 101),
    piece(new THREE.IcosahedronGeometry(0.55, 0), { x: 0.95, y: 0.15, z: 0.3 }, C.rockB, 0.08, 102),
  ]);
}
function rockSmall(): THREE.BufferGeometry {
  return piece(new THREE.IcosahedronGeometry(0.5, 0), { y: 0.12, sx: 1.2, sy: 0.8, sz: 1.0 }, C.rockA, 0.08, 111);
}

/** Tree stump with a light cut top. */
function stump(): THREE.BufferGeometry {
  return merge([
    cyl(0.62, 0.72, 0.7, 8, 0, 0.1, 0, C.bark),
    cyl(0.55, 0.55, 0.02, 8, 0, 0.46, 0, C.stumpTop),
  ]);
}

/** Fallen log lying along X. */
function log(): THREE.BufferGeometry {
  return cyl(0.4, 0.42, 3.4, 8, 0, 0.36, 0, C.log, { rz: Math.PI / 2 });
}

// ───────────────────────────── build ─────────────────────────────

type Kind =
  | 'blA'
  | 'blB'
  | 'birch'
  | 'pineA'
  | 'pineB'
  | 'poplar'
  | 'willow'
  | 'reeds'
  | 'bushA'
  | 'bushB'
  | 'flower'
  | 'flowerStem'
  | 'rockBig'
  | 'rockSmall'
  | 'stump'
  | 'log';

interface KindDef {
  build: () => THREE.BufferGeometry;
  /** Wind settings; null = static. Height is the model height at which bending reaches full. */
  wind: WindOptions | null;
  side?: THREE.Side;
}

const KINDS: Record<Kind, KindDef> = {
  blA: { build: broadleafA, wind: { height: 11.6, amplitude: 0.75, curve: 1.5, flutter: 0.3, flutterSpeed: 3.2 } },
  blB: { build: broadleafB, wind: { height: 12.0, amplitude: 0.75, curve: 1.5, flutter: 0.3, flutterSpeed: 3.0 } },
  birch: { build: birch, wind: { height: 11.2, amplitude: 0.6, curve: 1.5, flutter: 0.35, flutterSpeed: 3.6 } },
  pineA: { build: pineA, wind: { height: 11.7, amplitude: 0.45, curve: 1.7, flutter: 0.18, flutterSpeed: 2.8 } },
  pineB: { build: pineB, wind: { height: 11.1, amplitude: 0.45, curve: 1.7, flutter: 0.18, flutterSpeed: 2.6 } },
  poplar: { build: poplar, wind: { height: 12.0, amplitude: 0.5, curve: 1.6, flutter: 0.25, flutterSpeed: 3.4 } },
  willow: { build: willow, wind: { height: 6.0, amplitude: 0.9, curve: 1.2, flutter: 0.4, flutterSpeed: 3.6 } },
  reeds: { build: reeds, wind: { height: 1.8, amplitude: 0.25, curve: 1.5, flutter: 0.5, flutterSpeed: 4.5 } },
  bushA: { build: bushA, wind: { height: 1.3, amplitude: 0.14, curve: 1.6, flutter: 0.3, flutterSpeed: 4.5 } },
  bushB: { build: bushB, wind: { height: 1.3, amplitude: 0.14, curve: 1.6, flutter: 0.3, flutterSpeed: 4.8 } },
  flower: { build: flowers, wind: { height: FLOWER_TOP, amplitude: 0.14, curve: 1.3, flutter: 0.35, flutterSpeed: 5.2 }, side: THREE.DoubleSide },
  flowerStem: { build: flowerStems, wind: { height: FLOWER_TOP, amplitude: 0.14, curve: 1.3, flutter: 0.35, flutterSpeed: 5.2 }, side: THREE.DoubleSide },
  rockBig: { build: rockBig, wind: null },
  rockSmall: { build: rockSmall, wind: null },
  stump: { build: stump, wind: null },
  log: { build: log, wind: null },
};
const KIND_ORDER = Object.keys(KINDS) as Kind[];

interface Inst {
  x: number;
  y: number;
  z: number;
  yaw: number;
  tiltAxis: number;
  tilt: number;
  sx: number;
  sy: number;
  sz: number;
  col?: THREE.Color;
}

/** Shared placement state for one build. */
interface Cell {
  gx: number;
  gz: number;
  cx: number;
  cz: number;
  e: number; // edge distance of the cell centre (m)
  nb: number; // near-city band weight (1 at the edge, fading out by ~100 m)
  m: number; // meadow weight
  f: number; // forest weight (faded in from 70 m out)
  a: number; // alpine weight
  r: number; // rock weight
  pS: number; // conifer share from height (0 low, 1 high)
  wet: number; // 0..1 share of samples in the water shore band
  n1: number; // 60 m value noise (patchiness)
  g: number; // grove mask 0..1 (110 m noise, thresholded)
}

interface Channel {
  id: number;
  cap: number;
  lam: (c: Cell) => number;
  place: (x: number, z: number, c: Cell, r: () => number) => void;
}

export function buildNature(field: Field, _cells: GridCell[]): EnvPart {
  const group = new THREE.Group();
  group.name = 'nature';

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const meshes: THREE.InstancedMesh[] = [];
  const lists = Object.fromEntries(KIND_ORDER.map((k) => [k, [] as Inst[]])) as Record<Kind, Inst[]>;

  // ── ground sampling ──────────────────────────────────────────────────────────
  /** Height at (x,z) if the spot is valid ground for the given rules, else NaN. */
  const ground = (x: number, z: number, slopeMax: number, roadMax: number, shoreD: number): number => {
    if (field.edgeDist(x, z) < 3) return NaN;
    if (field.road(x, z) > roadMax) return NaN;
    if (field.water(x, z) > 0.1) return NaN;
    if (shoreD > 0 && !openWaterWithin(x, z, shoreD)) return NaN;
    if (slopeMax < 9 && field.slope(x, z) > slopeMax) return NaN;
    return field.height(x, z);
  };
  /** True when open water lies within d metres (the water band itself is only ~1.5 m wide). */
  const openWaterWithin = (x: number, z: number, d: number): boolean => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      for (const f of [0.4, 0.7, 1]) {
        if (field.water(x + Math.cos(a) * d * f, z + Math.sin(a) * d * f) > 0.5) return true;
      }
    }
    return false;
  };

  const tint = (r: () => number, base = 0.88, range = 0.2): THREE.Color => {
    const t = base + range * r();
    return new THREE.Color(t * (0.94 + 0.1 * r()), t, t * (0.86 + 0.12 * r()));
  };
  /** Instance with random yaw, slight tilt (<= 0.065 rad ~ 3.7 deg), and sink into the ground. */
  const inst = (x: number, y: number, z: number, r: () => number, s0: number, s1: number, sink = 0.3, withTint = true): Inst => {
    const s = s0 + (s1 - s0) * r();
    return {
      x,
      y: y - sink,
      z,
      yaw: r() * TAU,
      tiltAxis: r() * TAU,
      tilt: r() * 0.065,
      sx: s * (0.92 + 0.16 * r()),
      sy: s * (0.9 + 0.2 * r()),
      sz: s * (0.92 + 0.16 * r()),
      col: withTint ? tint(r) : undefined,
    };
  };

  // ── survey: biome/height/water on a coarse grid ─────────────────────────────
  const R = Math.min(field.extent - 60, R_MAX);
  const N = Math.ceil((2 * R) / CS);
  const cells: Cell[] = [];
  const bio: Biome = { meadow: 0, forest: 0, alpine: 0, rock: 0, snow: 0 };
  for (let gz = 0; gz < N; gz++) {
    for (let gx = 0; gx < N; gx++) {
      const cx = -R + (gx + 0.5) * CS;
      const cz = -R + (gz + 0.5) * CS;
      if (Math.abs(cx) < HALF_W - CS && Math.abs(cz) < HALF_D - CS) continue; // wholly inside the board
      field.biome(cx, cz, bio);
      if (bio.snow > 0.6) continue;
      const e = field.edgeDist(cx, cz);
      const h = field.height(cx, cz);
      let shore = 0;
      const offs = [
        [0, 0],
        [CS * 0.4, 0],
        [-CS * 0.4, 0],
        [0, CS * 0.4],
        [0, -CS * 0.4],
        [CS * 0.3, CS * 0.3],
        [-CS * 0.3, CS * 0.3],
        [CS * 0.3, -CS * 0.3],
        [-CS * 0.3, -CS * 0.3],
      ];
      for (const [ox, oz] of offs) {
        const w = field.water(cx + ox, cz + oz);
        if (w > 0.02 && w < 0.9) shore = 1;
      }
      cells.push({
        gx,
        gz,
        cx,
        cz,
        e,
        nb: 1 - smooth(50, 100, e),
        m: bio.meadow,
        f: bio.forest * smooth(70, 150, e),
        a: bio.alpine,
        r: bio.rock,
        pS: smooth(40, 140, h),
        wet: shore, // 1 where a cell touches a river/lake shore, else 0
        n1: vnoise(cx, cz, 60, 17),
        g: smooth(0.42, 0.7, vnoise(cx, cz, 110, 29)),
      });
    }
  }

  // ── channels: expected density per cell -> capped instance budgets ─────────────
  const A = CS * CS;
  const sel = (r: () => number, a: Kind, b: Kind) => (r() < 0.5 ? a : b);
  const CHANNELS: Channel[] = [
    {
      // scattered park trees spilling out of the city, sparse
      id: 1,
      cap: 200,
      lam: (c) => (A / 900) * c.nb * c.m * (0.25 + 0.75 * c.n1),
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists[sel(r, 'blA', 'blB')].push(inst(x, y, z, r, 0.9, 1.22));
      },
    },
    {
      id: 2,
      cap: 50,
      lam: (c) => (A / 2400) * c.nb * c.m * (0.5 + c.n1),
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists.birch.push(inst(x, y, z, r, 0.85, 1.1));
      },
    },
    {
      // meadow groves: clumps of broadleaf with clearings between them
      id: 3,
      cap: 520,
      lam: (c) => (A / 240) * c.m * c.g * (0.4 + 0.6 * c.n1),
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists[sel(r, 'blA', 'blB')].push(inst(x, y, z, r, 0.85, 1.3));
      },
    },
    {
      id: 4,
      cap: 120,
      lam: (c) => (A / 1100) * c.m * c.g,
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists.birch.push(inst(x, y, z, r, 0.85, 1.15));
      },
    },
    {
      id: 5,
      cap: 90,
      lam: (c) => (A / 1400) * c.m * c.g * c.n1,
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists.poplar.push(inst(x, y, z, r, 0.9, 1.2));
      },
    },
    {
      // foothill forest: dense, pines dominate higher up
      id: 6,
      cap: 1800,
      lam: (c) => (A / 380) * c.f * (0.45 + 0.55 * c.pS),
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.7, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists[sel(r, 'pineA', 'pineB')].push(inst(x, y, z, r, 0.9, 1.5));
      },
    },
    {
      id: 7,
      cap: 320,
      lam: (c) => (A / 700) * c.f * (1 - c.pS),
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.7, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists[sel(r, 'blA', 'blB')].push(inst(x, y, z, r, 0.9, 1.3));
      },
    },
    {
      // alpine: small stunted conifers
      id: 8,
      cap: 500,
      lam: (c) => (A / 900) * c.a,
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.8, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists[sel(r, 'pineA', 'pineB')].push(inst(x, y, z, r, 0.55, 0.85));
      },
    },
    {
      // bushes out in the meadow and at forest edges
      id: 9,
      cap: 1000,
      lam: (c) => (A / 320) * c.m * (0.2 + c.g) + (A / 260) * c.f * 0.6,
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.6, 0.15, 0);
        if (Number.isNaN(y)) return;
        lists[sel(r, 'bushA', 'bushB')].push(inst(x, y, z, r, 0.8, 1.25, 0.2));
      },
    },
    {
      // wildflower patches: thick near the city, clustered in the meadow
      id: 10,
      cap: 1800,
      lam: (c) => (A / 42) * c.nb * c.m,
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.05, 0);
        if (Number.isNaN(y)) return;
        const i = Math.floor(r() * FLOWERS.length);
        const p = inst(x, y, z, r, 0.9, 1.15, 0.02, false);
        p.col = new THREE.Color(FLOWERS[i]);
        lists.flower.push(p);
        lists.flowerStem.push({ ...p, col: undefined });
      },
    },
    {
      id: 11,
      cap: 1500,
      lam: (c) => (A / 80) * c.m * (0.3 + c.g),
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.05, 0);
        if (Number.isNaN(y)) return;
        const p = inst(x, y, z, r, 0.9, 1.15, 0.02, false);
        p.col = new THREE.Color(FLOWERS[Math.floor(r() * FLOWERS.length)]);
        lists.flower.push(p);
        lists.flowerStem.push({ ...p, col: undefined });
      },
    },
    {
      // boulders: rock biome, alpine, and the odd one in the meadow
      id: 12,
      cap: 380,
      lam: (c) => (A / 1000) * c.r + (A / 2500) * c.a,
      place: (x, z, _c, r) => {
        const slope = field.slope(x, z);
        if (slope < 0.35 && r() > 0.35) return;
        const y = ground(x, z, 99, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists.rockBig.push(inst(x, y, z, r, 0.8, 1.6, 0.35, true));
      },
    },
    {
      id: 13,
      cap: 900,
      lam: (c) => (A / 260) * (c.r + 0.6 * c.a) + (A / 1800) * c.m,
      place: (x, z, _c, r) => {
        const slope = field.slope(x, z);
        if (slope < 0.35 && r() > 0.5) return;
        const y = ground(x, z, 99, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists.rockSmall.push(inst(x, y, z, r, 0.5, 1.2, 0.2, true));
      },
    },
    {
      // stumps and fallen logs at forest edges
      id: 14,
      cap: 70,
      lam: (c) => (A / 3000) * c.f,
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists.stump.push(inst(x, y, z, r, 0.9, 1.2, 0.25, false));
      },
    },
    {
      id: 15,
      cap: 50,
      lam: (c) => (A / 4000) * c.f,
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.2, 0);
        if (Number.isNaN(y)) return;
        lists.log.push(inst(x, y, z, r, 0.9, 1.2, 0.15, false));
      },
    },
    {
      // willows on the shore of water
      id: 16,
      cap: 140,
      lam: (c) => (A / 450) * c.wet,
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.2, 9);
        if (Number.isNaN(y)) return;
        lists.willow.push(inst(x, y, z, r, 1.0, 1.3));
      },
    },
    {
      id: 17,
      cap: 280,
      lam: (c) => (A / 160) * c.wet,
      place: (x, z, _c, r) => {
        const y = ground(x, z, 0.5, 0.2, 4);
        if (Number.isNaN(y)) return;
        lists.reeds.push(inst(x, y, z, r, 0.8, 1.2, 0.1, true));
      },
    },
  ];

  for (const ch of CHANNELS) {
    let total = 0;
    for (const c of cells) total += ch.lam(c);
    const scale = total > ch.cap ? ch.cap / total : 1;
    for (const c of cells) {
      const L = ch.lam(c) * scale;
      if (L <= 0) continue;
      const whole = Math.floor(L);
      const n = whole + (h2(c.gx, c.gz, ch.id, 99) < L - whole ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const r = rngFrom(Math.floor(h2(c.gx * 3 + k, c.gz, ch.id * 131 + k, 7) * 4294967296));
        const x = c.cx + (r() - 0.5) * CS;
        const z = c.cz + (r() - 0.5) * CS;
        ch.place(x, z, c, r);
      }
    }
  }

  // ── hedgerows: bush lines parallel to the city edge, broken into runs by noise ──
  {
    let count = 0;
    const HEDGE_MAX = 420;
    const hedge = (x: number, z: number, r: () => number) => {
      if (count >= HEDGE_MAX) return;
      const y = ground(x, z, 0.55, 0.1, 0);
      if (Number.isNaN(y)) return;
      lists[r() < 0.5 ? 'bushA' : 'bushB'].push(inst(x, y, z, r, 0.75, 1.0, 0.2));
      count++;
    };
    let seed = 0;
    for (const off of [4.5, 27, 58]) {
      for (const sgn of [-1, 1]) {
        for (const axis of ['x', 'z'] as const) {
          const half = axis === 'x' ? HALF_D : HALF_W;
          const edge = (axis === 'x' ? HALF_W : HALF_D) + off;
          for (let t = -half; t <= half; t += 5.2) {
            seed++;
            if (vnoise(t, off * sgn, 42, 53 + off) < 0.6) continue;
            const r = rngFrom(seed * 7919 + off * 13);
            const along = t + (r() - 0.5) * 1.6;
            const across = sgn * edge + (r() - 0.5) * 0.8;
            if (axis === 'x') hedge(across, along, r);
            else hedge(along, across, r);
          }
        }
      }
    }
  }

  // ── meshes: one merged geometry + one InstancedMesh per kind ────────────────
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qt = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const tiltAxis = new THREE.Vector3();
  for (const kind of KIND_ORDER) {
    const list = lists[kind];
    if (!list.length) continue;
    const def = KINDS[kind];
    const geo = def.build();
    geos.push(geo);
    const mat = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: MAT.grass.gradientMap,
      side: def.side ?? THREE.FrontSide,
    });
    if (def.wind) applyWind(mat, def.wind);
    mats.push(mat);

    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = `nature-${kind}`;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    list.forEach((d, i) => {
      p.set(d.x, d.y, d.z);
      q.setFromAxisAngle(UP, d.yaw);
      tiltAxis.set(Math.cos(d.tiltAxis), 0, Math.sin(d.tiltAxis));
      qt.setFromAxisAngle(tiltAxis, d.tilt);
      q.multiply(qt);
      sc.set(d.sx, d.sy, d.sz);
      m4.compose(p, q, sc);
      mesh.setMatrixAt(i, m4);
      if (d.col) mesh.setColorAt(i, d.col);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 6; // room for wind sway
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    meshes.push(mesh);
    group.add(mesh);
  }

  return {
    group,
    dispose() {
      meshes.forEach((m) => m.dispose());
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      group.removeFromParent();
    },
  };
}
