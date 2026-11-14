import * as THREE from 'three';
import { BLOCK, CELL, GRID_COLS, GRID_ROWS, HALF_D, HALF_W } from '../../core/constants';
import type { GridCell } from '../../core/types';
import { MAT } from '../palette';
import { WIND, WIND_GLSL } from './wind';
import type { Biome, EnvPart, Field } from './types';

/**
 * Wind-animated grass: chunked, lazily generated, camera-LOD'd instanced clumps.
 *
 *  - A clump = 6 tapered, curved, double-sided blades (7 verts / 5 tris each = 30 tris).
 *  - World is split into CHUNK-sized tiles; a tile's clumps are generated the first time the
 *    camera comes within LOD_FAR of it (jittered grid, rejected by road/water/rock/snow/slope,
 *    thinned by biome noise), then shuffled so any prefix is a uniform subset.
 *  - LOD: per-instance rank r (0..1) is compared in the vertex shader with a density that falls
 *    with camera distance, so clumps shrink away smoothly (no popping) while the remaining
 *    clumps widen to keep the meadow looking filled; mesh instanceCount is cut to the matching
 *    prefix per chunk so far chunks cost almost nothing. Beyond LOD_FAR the terrain's wind
 *    sheen carries the look.
 *  - Wind: same windGust() as the ground/trees, sampled per blade root; per-blade flutter phase;
 *    tips lean further than roots; colour brightens toward a pale highlight as blades lie over.
 */

const CHUNK = 64;
const LOD_NEAR = 45;
const LOD_FAR = 300;
const SPACING = 0.7; // jittered-grid spacing (m) at full density
const BLADES = 6;
const LOT_Y = 0.18;
const MAX_CACHED = 260;

// ───────────────────────── small helpers ─────────────────────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash2 = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
const fbm = (x: number, y: number) => vnoise(x, y) * 0.55 + vnoise(x * 2.1 + 5, y * 2.1 - 3) * 0.3 + vnoise(x * 4.3 - 9, y * 4.3 + 7) * 0.15;

/** Fraction of clumps that survive at camera distance d (matches the GLSL). */
const densAt = (d: number) => (d <= LOD_NEAR ? 1 : Math.max(0.035, Math.pow(LOD_NEAR / d, 1.2)));

// ───────────────────────── clump geometry ─────────────────────────
function buildClump(): THREE.BufferGeometry {
  const r = rng(7788);
  const pos: number[] = [];
  const base: number[] = [];
  const phase: number[] = [];
  const idx: number[] = [];
  const rows = [0, 0.34, 0.68];
  for (let b = 0; b < BLADES; b++) {
    const a = b * 2.39996 + r() * 0.6;
    const rad = (b === 0 ? 0.04 : 0.15 + r() * 0.38);
    const bx = Math.cos(a) * rad, bz = Math.sin(a) * rad;
    const f = a + (r() - 0.5) * 1.0; // facing / lean direction (outward fan)
    const h = b === 0 ? 1 : 0.55 + r() * 0.4;
    const w0 = 0.085 + r() * 0.04;
    const lean = 0.1 + r() * 0.26;
    const cx = Math.cos(f), cz = Math.sin(f);
    const wx = -cz, wz = cx;
    const ph = r() * 6.2831;
    const v0 = pos.length / 3;
    for (const t of rows) {
      const hw = w0 * (1 - t * 0.82);
      const curve = lean * h * t * t;
      for (const side of [-1, 1]) {
        pos.push(bx + wx * hw * side + cx * curve, t * h, bz + wz * hw * side + cz * curve);
        base.push(bx, bz);
        phase.push(ph);
      }
    }
    const tc = lean * h;
    pos.push(bx + cx * tc, h, bz + cz * tc);
    base.push(bx, bz);
    phase.push(ph);
    for (let i = 0; i < 2; i++) {
      const o = v0 + i * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    idx.push(v0 + 4, v0 + 5, v0 + 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBase', new THREE.Float32BufferAttribute(base, 2));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

// ───────────────────────── material ─────────────────────────
function buildMaterial(): { mat: THREE.MeshToonMaterial; uniforms: Record<string, THREE.IUniform> } {
  const mat = MAT.grass.clone() as THREE.MeshToonMaterial;
  mat.color.set(0xffffff);
  mat.side = THREE.DoubleSide;
  mat.fog = true;
  const col = (hex: number) => new THREE.Color(hex);
  const uniforms: Record<string, THREE.IUniform> = {
    uRootLush: { value: col(0x238a14) },
    uRootDry: { value: col(0x5d6a1a) },
    uTipLush: { value: col(0xa6ea3c) },
    uTipDry: { value: col(0xd9b84a) },
    uSheenCol: { value: col(0xe9f77a) },
    uNight: { value: 0 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uWindTime = WIND.uWindTime;
    shader.uniforms.uWindDir = WIND.uWindDir;
    shader.uniforms.uWindStrength = WIND.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
${WIND_GLSL}
attribute vec4 iPos;   // xyz root, w yaw
attribute vec4 iData;  // x rank 0..1, y dry(-1 wet..1 dry), z height m, w tone
attribute vec2 aBase;
attribute float aPhase;
uniform vec3 uRootLush, uRootDry, uTipLush, uTipDry, uSheenCol;
varying vec3 vGrass;
`,
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        float gT = position.y;                       // blade-height fraction (clump is 1 unit tall)
        vec3 gRoot = iPos.xyz;
        float gDist = distance(gRoot, cameraPosition);
        float gLod = smoothstep(${LOD_NEAR.toFixed(1)}, ${LOD_FAR.toFixed(1)}, gDist);
        float gDens = gDist <= ${LOD_NEAR.toFixed(1)} ? 1.0 : max(0.035, pow(${LOD_NEAR.toFixed(1)} / gDist, 1.2));
        float gThr = gDens * 1.12;
        float gKeep = (1.0 - smoothstep(gThr - 0.12, gThr, iData.x))
                    * (1.0 - smoothstep(${(LOD_FAR * 0.86).toFixed(1)}, ${LOD_FAR.toFixed(1)}, gDist));
        float gWS = 0.85 + 0.5 * fract(iData.x * 57.31);
        float gH = iData.z * gKeep;
        vec3 gP = position;
        gP.xz *= gWS * (1.0 + 1.6 * gLod) * gKeep;
        gP.y *= gH;
        float gc = cos(iPos.w), gs = sin(iPos.w);
        gP.xz = vec2(gc * gP.x + gs * gP.z, -gs * gP.x + gc * gP.z);
        vec2 gB = vec2(gc * aBase.x + gs * aBase.y, -gs * aBase.x + gc * aBase.y);

        // wind: same travelling gust as ground/trees, sampled at the blade root
        float gG = windGust(gRoot.xz + gB);
        float gPh = aPhase + iData.x * 6.2831;
        float gFl = sin(uWindTime * (2.7 + aPhase * 0.22) + gPh + gRoot.x * 0.31 + gRoot.z * 0.17);
        float gFl2 = sin(uWindTime * (1.9 + aPhase * 0.13) + gPh * 1.7 + gRoot.z * 0.23);
        float gBend = gT * gT * (1.15 - 0.15 * gT);
        vec2 gPerp = vec2(-uWindDir.y, uWindDir.x);
        float gLift = gG * uWindStrength;
        vec2 gOff = (uWindDir * (0.14 + 0.95 * gG + 0.07 * gFl * (0.4 + gG)) + gPerp * 0.07 * gFl2 * (0.4 + gG)) * gH * gBend;
        vec4 gW = vec4(gRoot + vec3(gP.x, gP.y, gP.z), 1.0);
        gW.xz += gOff;
        gW.y -= dot(gOff, gOff) * 0.5 / max(0.05, gH);
        vec4 mvPosition = viewMatrix * gW;
        gl_Position = projectionMatrix * mvPosition;

        // colour: root -> tip gradient, dry/lush variety, tone jitter, gust sheen
        float gDry = clamp(iData.y, 0.0, 1.0);
        float gWet = clamp(-iData.y, 0.0, 1.0);
        vec3 gRC = mix(uRootLush, uRootDry, gDry) * (1.0 - 0.25 * gWet);
        vec3 gTC = mix(uTipLush, uTipDry, gDry);
        gTC = mix(gTC, gTC * vec3(0.78, 0.92, 0.85), gWet);
        vec3 gCol = mix(gRC, gTC, pow(gT, 0.9));
        float gTone = iData.w;
        gCol *= vec3(1.0 + gTone * 0.14, 1.0 + gTone * 0.05, 1.0 - gTone * 0.18);
        gCol *= 0.55 + 0.45 * smoothstep(0.0, 0.4, gT);       // dark contact shadow at the root
        float gSheen = smoothstep(0.3, 0.92, gG) * uWindStrength;
        gCol = mix(gCol, uSheenCol * (0.7 + 0.3 * gT), gSheen * smoothstep(0.05, 0.8, gT) * 0.75);
        vGrass = gCol;
        `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrass;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vGrass;')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal *= faceDirection;');
  };
  mat.customProgramCacheKey = () => 'grass-clump-v1';
  mat.needsUpdate = true;
  return { mat, uniforms };
}

// ───────────────────────── chunk generation ─────────────────────────
interface Chunk {
  cx: number;
  cz: number;
  x0: number;
  z0: number;
  mesh: THREE.Mesh | null;
  geo: THREE.InstancedBufferGeometry | null;
  total: number;
  built: boolean;
  lastUse: number;
}

export function buildGrass(field: Field, cells: GridCell[]): EnvPart {
  const group = new THREE.Group();
  group.name = 'grass';
  const clump = buildClump();
  const { mat, uniforms } = buildMaterial();

  const parkAt = (col: number, row: number) =>
    col >= 0 && row >= 0 && col < GRID_COLS && row < GRID_ROWS && parkGrid[row * GRID_COLS + col] === 1;
  const parkGrid = new Uint8Array(GRID_COLS * GRID_ROWS);
  for (const c of cells) if (c.terrain === 'park') parkGrid[c.row * GRID_COLS + c.col] = 1;

  const extent = field.extent;
  const nChunks = Math.ceil((extent * 2) / CHUNK);
  const chunks = new Map<number, Chunk>();
  const bio: Biome = { meadow: 0, forest: 0, alpine: 0, rock: 0, snow: 0 };
  let frame = 0;

  const getChunk = (ix: number, iz: number): Chunk => {
    const key = iz * nChunks + ix;
    let c = chunks.get(key);
    if (!c) {
      c = { cx: ix, cz: iz, x0: -extent + ix * CHUNK, z0: -extent + iz * CHUNK, mesh: null, geo: null, total: 0, built: false, lastUse: 0 };
      chunks.set(key, c);
    }
    return c;
  };

  function generate(c: Chunk): void {
    c.built = true;
    const rand = rng(c.cx * 73856093 ^ c.cz * 19349663 ^ 0x51ed);
    const px: number[] = [], py: number[] = [], pz: number[] = [], yaw: number[] = [];
    const dry: number[] = [], hgt: number[] = [], tone: number[] = [];
    const n = Math.ceil(CHUNK / SPACING);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = c.x0 + (i + rand()) * SPACING;
        const z = c.z0 + (j + rand()) * SPACING;
        const rr = rand(), r2 = rand(), r3 = rand();
        if (x > c.x0 + CHUNK || z > c.z0 + CHUNK) continue;
        const edge = field.edgeDist(x, z);
        let y: number;
        let hMul = 1;
        let keepP = 1;
        let wet = 0;
        if (edge <= 0) {
          // inside the board: only open lawn in park cells
          const col = Math.floor((x + HALF_W) / CELL), row = Math.floor((z + HALF_D) / CELL);
          if (!parkAt(col, row)) continue;
          const lx = x + HALF_W - col * CELL, lz = z + HALF_D - row * CELL;
          if (lx < 1.2 && !parkAt(col - 1, row)) continue;
          if (lx > CELL - 1.2 && !parkAt(col + 1, row)) continue;
          if (lz < 1.2 && !parkAt(col, row - 1)) continue;
          if (lz > CELL - 1.2 && !parkAt(col, row + 1)) continue;
          if (col % BLOCK === Math.floor(BLOCK / 2) && Math.abs(lx - CELL / 2) < 1.9) continue;
          if (row % BLOCK === Math.floor(BLOCK / 2) && Math.abs(lz - CELL / 2) < 1.9) continue;
          y = LOT_Y + 0.03;
          hMul = 0.34 + 0.12 * fbm(x * 0.2, z * 0.2); // mown lawn
          keepP = 0.85;
        } else {
          if (edge < 0.6) continue;
          if (field.road(x, z) > 0.3) continue;
          const w = field.water(x, z);
          if (w > 0.2) continue;
          y = field.height(x, z);
          field.biome(x, z, bio);
          const rock = bio.rock;
          if (rock > 0.55 || bio.snow > 0.35) continue;
          const sl = field.slope(x, z);
          if (sl > 1.1) continue;
          // reed / tall-grass band along water
          if (w > 0.001) wet = 1;
          else {
            const wn = Math.max(field.water(x + 5, z), field.water(x - 5, z), field.water(x, z + 5), field.water(x, z - 5));
            if (wn > 0.3) wet = 0.6 + 0.4 * wn;
            else {
              const w2 = Math.max(field.water(x + 11, z + 11), field.water(x - 11, z - 11), field.water(x + 11, z - 11), field.water(x - 11, z + 11));
              if (w2 > 0.3) wet = 0.35;
            }
          }
          const veg = bio.meadow * 1.0 + bio.forest * 0.78 + bio.alpine * 0.3 + 0.04;
          const cluster = ss(0.28, 0.62, fbm(x * 0.045 + 11, z * 0.045 - 4)); // meadow clearings / tuft patches
          const patch = 0.55 + 0.45 * cluster;
          keepP = veg * patch * (1 - ss(0.2, 0.55, rock)) * (1 - ss(0.7, 1.1, sl)) * (1 - ss(0.15, 0.35, bio.snow));
          // taller in the meadow, shorter high up / on steeper ground
          hMul = (0.55 + 0.75 * bio.meadow + 0.45 * bio.forest + 0.3 * bio.alpine) * (0.65 + 0.7 * fbm(x * 0.03 - 7, z * 0.03 + 2));
          hMul *= 1 - 0.4 * ss(0.3, 1.0, sl);
          if (wet > 0) hMul = Math.max(hMul, 1.0) * (1 + 1.1 * wet);
        }
        if (rr > keepP) continue;
        const h = y; // sampled height
        const dryV =
          ss(30, 320, edge) * 0.45 + ss(18, 140, h) * 0.55 + (fbm(x * 0.02 + 40, z * 0.02 + 8) - 0.5) * 0.9 - wet * 1.1 - (edge <= 0 ? 1 : 0);
        px.push(x); py.push(y); pz.push(z);
        yaw.push(r2 * 6.2831);
        hgt.push(Math.max(0.12, hMul * (0.8 + 0.4 * r3)) * 1.65);
        dry.push(Math.max(-1, Math.min(1, dryV)));
        tone.push((fbm(x * 0.11, z * 0.11) - 0.5) * 2.2 + (r3 - 0.5) * 0.7);
      }
    }
    const N = px.length;
    if (N === 0) return;
    // shuffle so any prefix is a uniform subset, then rank = index / N
    const order = new Uint32Array(N);
    for (let i = 0; i < N; i++) order[i] = i;
    for (let i = N - 1; i > 0; i--) {
      const k = Math.floor(rand() * (i + 1));
      const t = order[i]; order[i] = order[k]; order[k] = t;
    }
    const iPos = new Float32Array(N * 4), iData = new Float32Array(N * 4);
    let minY = 1e9, maxY = -1e9, maxH = 0;
    for (let i = 0; i < N; i++) {
      const s = order[i];
      iPos[i * 4] = px[s]; iPos[i * 4 + 1] = py[s]; iPos[i * 4 + 2] = pz[s]; iPos[i * 4 + 3] = yaw[s];
      iData[i * 4] = (i + 0.5) / N; iData[i * 4 + 1] = dry[s]; iData[i * 4 + 2] = hgt[s]; iData[i * 4 + 3] = tone[s];
      if (py[s] < minY) minY = py[s];
      if (py[s] > maxY) maxY = py[s];
      if (hgt[s] > maxH) maxH = hgt[s];
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = clump.index;
    for (const k of ['position', 'normal', 'aBase', 'aPhase']) geo.setAttribute(k, clump.getAttribute(k));
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 4));
    geo.setAttribute('iData', new THREE.InstancedBufferAttribute(iData, 4));
    geo.instanceCount = N;
    const cxm = c.x0 + CHUNK / 2, czm = c.z0 + CHUNK / 2, cym = (minY + maxY) / 2;
    const rad = Math.hypot(CHUNK / 2, CHUNK / 2, (maxY - minY) / 2 + maxH) + 4;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cxm, cym, czm), rad);
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(c.x0 - 2, minY - 1, c.z0 - 2), new THREE.Vector3(c.x0 + CHUNK + 2, maxY + maxH + 2, c.z0 + CHUNK + 2));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = `grass-${c.cx}-${c.cz}`;
    group.add(mesh);
    c.mesh = mesh; c.geo = geo; c.total = N;
  }

  function evict(): void {
    if (chunks.size <= MAX_CACHED) return;
    const list = [...chunks.entries()].sort((a, b) => a[1].lastUse - b[1].lastUse);
    for (const [k, c] of list.slice(0, chunks.size - MAX_CACHED + 30)) {
      if (c.mesh) group.remove(c.mesh);
      c.geo?.dispose();
      chunks.delete(k);
    }
  }

  const queue: { c: Chunk; d: number }[] = [];
  let first = true;

  return {
    group,
    update(_dt, _t, camera) {
      frame++;
      const cp = camera.position;
      const lo = Math.max(0, Math.floor((cp.x - LOD_FAR + extent) / CHUNK));
      const hi = Math.min(nChunks - 1, Math.floor((cp.x + LOD_FAR + extent) / CHUNK));
      const lo2 = Math.max(0, Math.floor((cp.z - LOD_FAR + extent) / CHUNK));
      const hi2 = Math.min(nChunks - 1, Math.floor((cp.z + LOD_FAR + extent) / CHUNK));
      queue.length = 0;
      // Ground-level distance (camera height counts, but modestly, so a high camera still gets nearby chunks).
      for (let iz = lo2; iz <= hi2; iz++) {
        for (let ix = lo; ix <= hi; ix++) {
          const x0 = -extent + ix * CHUNK, z0 = -extent + iz * CHUNK;
          const dx = Math.max(x0 - cp.x, 0, cp.x - (x0 + CHUNK));
          const dz = Math.max(z0 - cp.z, 0, cp.z - (z0 + CHUNK));
          const d = Math.hypot(dx, dz, Math.max(0, cp.y - 20));
          const key = iz * nChunks + ix;
          const c = chunks.get(key);
          if (d > LOD_FAR) {
            if (c?.mesh) c.mesh.visible = false;
            continue;
          }
          if (!c || !c.built) {
            queue.push({ c: getChunk(ix, iz), d });
            continue;
          }
          c.lastUse = frame;
          if (c.mesh && c.geo) {
            c.mesh.visible = true;
            c.geo.instanceCount = Math.min(c.total, Math.ceil(c.total * Math.min(1, densAt(d) * 1.16 + 0.01)));
          }
        }
      }
      if (queue.length) {
        queue.sort((a, b) => a.d - b.d);
        const budget = first ? 400 : 14;
        first = false;
        const t0 = performance.now();
        for (const q of queue) {
          generate(q.c);
          q.c.lastUse = frame;
          if (q.c.geo) q.c.geo.instanceCount = Math.min(q.c.total, Math.ceil(q.c.total * Math.min(1, densAt(q.d) * 1.16 + 0.01)));
          if (performance.now() - t0 > budget) break;
        }
        evict();
      }
    },
    setNight(n) {
      uniforms.uNight.value = n;
    },
    dispose() {
      for (const c of chunks.values()) c.geo?.dispose();
      chunks.clear();
      clump.dispose();
      mat.dispose();
      group.removeFromParent();
    },
  };
}
