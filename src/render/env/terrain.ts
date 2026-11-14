import * as THREE from 'three';
import { HALF_D, HALF_W } from '../../core/constants';
import type { GridCell } from '../../core/types';
import { COLORS, MAT } from '../palette';
import { makeGrassDetailTexture } from '../terrainTexture';
import type { FieldX, Lane, River } from './field';
import type { EnvPart, Field } from './types';
import { WIND, applyWindSheen } from './wind';

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Terrain mesh + country lanes + river/lake water. All geometry derives from the Field lattice. */
export function buildTerrain(field: Field, _cells: GridCell[]): EnvPart {
  const fx = field as FieldX;
  const D = fx.data;
  const { xs, n, H } = D;
  const disposables: Array<{ dispose(): void }> = [];
  const group = new THREE.Group();
  group.name = 'terrain';

  // ───────── terrain mesh ─────────
  const inside = (i: number, j: number) => xs[i] >= -HALF_W - 1e-6 && xs[i + 1] <= HALF_W + 1e-6 && xs[j] >= -HALF_D - 1e-6 && xs[j + 1] <= HALF_D + 1e-6;
  const used = new Uint8Array(n * n);
  let quadCount = 0;
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      if (inside(i, j)) continue;
      used[j * n + i] = used[j * n + i + 1] = used[(j + 1) * n + i] = used[(j + 1) * n + i + 1] = 1;
      quadCount++;
    }
  const skirtVerts = 4 * n;
  const nv = n * n + skirtVerts;
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const colr = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const sheen = new Float32Array(nv);
  const idx = new Uint32Array(quadCount * 6 + 4 * (n - 1) * 6);
  const c = new THREE.Color();
  const sh = new Float32Array(1);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = j * n + i;
      if (!used[v]) continue;
      const x = xs[i];
      const z = xs[j];
      const h = H[v];
      const i0 = i > 0 ? i - 1 : i;
      const i1 = i < n - 1 ? i + 1 : i;
      const j0 = j > 0 ? j - 1 : j;
      const j1 = j < n - 1 ? j + 1 : j;
      const gx = (H[j * n + i1] - H[j * n + i0]) / (xs[i1] - xs[i0]);
      const gz = (H[j1 * n + i] - H[j0 * n + i]) / (xs[j1] - xs[j0]);
      const il = 1 / Math.hypot(gx, 1, gz);
      pos[v * 3] = x;
      pos[v * 3 + 1] = h;
      pos[v * 3 + 2] = z;
      nor[v * 3] = -gx * il;
      nor[v * 3 + 1] = il;
      nor[v * 3 + 2] = -gz * il;
      fx.data.colorAt(x, z, h, Math.hypot(gx, gz), c, sh);
      colr[v * 3] = c.r;
      colr[v * 3 + 1] = c.g;
      colr[v * 3 + 2] = c.b;
      // steep faces: texture runs along the face instead of streaking down it
      const stp = smooth(0.45, 1.1, Math.hypot(gx, gz));
      uv[v * 2] = (x + (0.7071 * (x + z) - x) * stp) / 24;
      uv[v * 2 + 1] = (z + (h - z) * stp) / 24;
      sheen[v] = sh[0];
    }
  }
  let ip = 0;
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      if (inside(i, j)) continue;
      const a = j * n + i;
      idx[ip++] = a; idx[ip++] = a + n; idx[ip++] = a + 1;
      idx[ip++] = a + 1; idx[ip++] = a + n; idx[ip++] = a + n + 1;
    }
  // skirts around the outer rim so no void is ever visible
  {
    let sv = n * n;
    const rim: number[][] = [[], [], [], []];
    for (let k = 0; k < n; k++) {
      rim[0].push(k); // z = -E
      rim[1].push((n - 1) * n + k); // z = +E
      rim[2].push(k * n); // x = -E
      rim[3].push(k * n + n - 1); // x = +E
    }
    rim.forEach((list, side) => {
      const base = sv;
      for (const v of list) {
        pos[sv * 3] = pos[v * 3];
        pos[sv * 3 + 1] = pos[v * 3 + 1] - 160;
        pos[sv * 3 + 2] = pos[v * 3 + 2];
        nor[sv * 3 + 1] = 1;
        colr[sv * 3] = colr[v * 3];
        colr[sv * 3 + 1] = colr[v * 3 + 1];
        colr[sv * 3 + 2] = colr[v * 3 + 2];
        uv[sv * 2] = uv[v * 2];
        uv[sv * 2 + 1] = uv[v * 2 + 1];
        sv++;
      }
      for (let k = 0; k < n - 1; k++) {
        const a = list[k], b = list[k + 1], a2 = base + k, b2 = base + k + 1;
        if (side === 0 || side === 3) {
          idx[ip++] = a; idx[ip++] = b; idx[ip++] = a2;
          idx[ip++] = b; idx[ip++] = b2; idx[ip++] = a2;
        } else {
          idx[ip++] = a; idx[ip++] = a2; idx[ip++] = b;
          idx[ip++] = b; idx[ip++] = a2; idx[ip++] = b2;
        }
      }
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('sheen', new THREE.BufferAttribute(sheen, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  const tex = makeGrassDetailTexture();
  const mat = MAT.grass.clone() as THREE.MeshToonMaterial;
  mat.color.set(0xffffff);
  mat.vertexColors = true;
  mat.map = tex;
  applyWindSheen(mat, { attribute: true, strength: 0.24 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  group.add(mesh);
  disposables.push(geo, mat, tex);

  // ───────── lanes ─────────
  const C = {
    asphalt: new THREE.Color(0x353730),
    asphaltOld: new THREE.Color(0x85836f),
    gravel: new THREE.Color(0xb5a888),
    dirt: new THREE.Color(0x927a54),
    grassy: new THREE.Color(0x7e8f58),
  };
  const lp: number[] = [];
  const lc: number[] = [];
  const li: number[] = [];
  const tmp = new THREE.Color();
  const addLane = (ln: Lane) => {
    const step = 3;
    const cnt = Math.ceil(ln.L / step) + 1;
    const U = [-1, -0.72, 0, 0.72, 1];
    const base0 = lp.length / 3;
    for (let k = 0; k < cnt; k++) {
      const s = Math.min(ln.L, k * step);
      const l = ln.lateral(s);
      const dl = (ln.lateral(s + 0.5) - ln.lateral(s - 0.5)) / 1;
      // centre point and tangent in world xz
      const cxw = ln.ax === 0 ? l : ln.sg * (HALF_W + s);
      const czw = ln.ax === 0 ? ln.sg * (HALF_D + s) : l;
      let tx = ln.ax === 0 ? dl : ln.sg;
      let tz = ln.ax === 0 ? ln.sg : dl;
      const tl = Math.hypot(tx, tz);
      tx /= tl; tz /= tl;
      const nx = tz, nz = -tx;
      const hw = ln.hw(s) * (s < ln.L - 6 ? 1 : 1);
      const y = ln.y(s) + 0.1;
      const f = s / ln.L;
      const road = 1 - smooth(140, 320, s);
      const trackEnd = smooth(0.5, 0.95, f);
      for (let u = 0; u < U.length; u++) {
        const um = Math.abs(U[u]);
        const w = hw * U[u];
        lp.push(cxw + nx * w, y - (um > 0.9 ? 0.03 : 0), czw + nz * w);
        // asphalt near the city -> gravel -> dirt track
        tmp.copy(C.asphalt).lerp(C.asphaltOld, smooth(40, 200, s)).lerp(C.gravel, 1 - road).lerp(C.dirt, trackEnd);
        const edge = um > 0.9 ? 0.75 : um > 0.6 ? 0.4 : 0;
        if (edge > 0) tmp.lerp(C.gravel, edge * smooth(0, 50, s) * 0.8).lerp(C.grassy, um > 0.9 ? smooth(0, 90, s) * 0.45 : 0);
        // tire-track darkening on dirt
        if (um < 0.3 && trackEnd > 0.1) tmp.multiplyScalar(0.93);
        lc.push(tmp.r, tmp.g, tmp.b);
      }
    }
    for (let k = 0; k < cnt - 1; k++)
      for (let u = 0; u < 4; u++) {
        const a = base0 + k * 5 + u;
        li.push(a, a + 5, a + 1, a + 1, a + 5, a + 6);
      }
  };
  D.lanes.forEach(addLane);
  const laneGeo = new THREE.BufferGeometry();
  laneGeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  laneGeo.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
  laneGeo.setIndex(li);
  laneGeo.computeVertexNormals();
  // normals must face up whatever the winding
  {
    const nn = laneGeo.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < nn.count; i++) if (nn.getY(i) < 0) nn.setXYZ(i, -nn.getX(i), -nn.getY(i), -nn.getZ(i));
  }
  const laneMat = MAT.paving.clone() as THREE.MeshToonMaterial;
  laneMat.color.set(0xffffff);
  laneMat.vertexColors = true;
  laneMat.side = THREE.DoubleSide;
  laneMat.polygonOffset = true;
  laneMat.polygonOffsetFactor = -2;
  laneMat.polygonOffsetUnits = -2;
  const laneMesh = new THREE.Mesh(laneGeo, laneMat);
  laneMesh.receiveShadow = true;
  laneMesh.frustumCulled = false;
  group.add(laneMesh);
  disposables.push(laneGeo, laneMat);

  // ───────── hedgerows along the farm-plot boundaries ─────────
  {
    const { w: PW, d: PD, ox: OX, oz: OZ, amount } = D.plot;
    const hp: number[] = [];
    const hc: number[] = [];
    const hi: number[] = [];
    const hcol = [new THREE.Color(0x2f6a33), new THREE.Color(0x3d7d3a), new THREE.Color(0x56933f)];
    const R = 700;
    const addLine = (alongX: boolean, fixed: number, from: number, to: number) => {
      const step = 3;
      let prev = -1;
      for (let t = from, k = 0; t <= to; t += step, k++) {
        const x = alongX ? t : fixed;
        const z = alongX ? fixed : t;
        const ox = alongX ? 0 : 2.5;
        const oz = alongX ? 2.5 : 0;
        const am = Math.max(amount(x + ox, z + oz), amount(x - ox, z - oz));
        const ok =
          am > 0.55 && Math.abs(x) < R + 100 && Math.abs(z) < R + 100 && fx.road(x, z) < 0.02 && fx.road(x + ox * 2, z + oz * 2) < 0.02 && fx.road(x - ox * 2, z - oz * 2) < 0.02 &&
          fx.water(x, z) < 0.01 && fx.slope(x, z) < 0.16;
        if (!ok) { prev = -1; continue; }
        const y = fx.height(x, z);
        const hw = 0.7;
        const hh = 1.1 + 0.35 * Math.sin(t * 0.37 + fixed);
        const wx = alongX ? 0 : hw;
        const wz = alongX ? hw : 0;
        const col = hcol[(k >> 2) % 3];
        const b = hp.length / 3;
        // cross-section: bottom-left, top-left, top-right, bottom-right
        hp.push(x - wx, y - 0.2, z - wz, x - wx * 0.8, y + hh, z - wz * 0.8, x + wx * 0.8, y + hh, z + wz * 0.8, x + wx, y - 0.2, z + wz);
        for (let q = 0; q < 4; q++) hc.push(col.r * (q === 1 || q === 2 ? 1.12 : 1), col.g * (q === 1 || q === 2 ? 1.12 : 1), col.b * (q === 1 || q === 2 ? 1.12 : 1));
        if (prev >= 0) {
          const a = prev;
          for (let q = 0; q < 3; q++) {
            hi.push(a + q, b + q, a + q + 1, a + q + 1, b + q, b + q + 1);
          }
        }
        prev = b;
      }
    };
    for (let ix = Math.floor((-R + OX) / PW); ix <= Math.ceil((R + OX) / PW); ix++) addLine(false, ix * PW - OX, -R, R);
    for (let iz = Math.floor((-R + OZ) / PD); iz <= Math.ceil((R + OZ) / PD); iz++) addLine(true, iz * PD - OZ, -R, R);
    if (hi.length) {
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3));
      hg.setAttribute('color', new THREE.Float32BufferAttribute(hc, 3));
      hg.setIndex(hi);
      hg.computeVertexNormals();
      const hm = MAT.green.clone() as THREE.MeshToonMaterial;
      hm.color.set(0xffffff);
      hm.vertexColors = true;
      hm.side = THREE.DoubleSide;
      const hmesh = new THREE.Mesh(hg, hm);
      hmesh.castShadow = true;
      hmesh.receiveShadow = true;
      group.add(hmesh);
      disposables.push(hg, hm);
    }
  }

  // ───────── water ─────────
  const wp: number[] = [];
  const wc: number[] = [];
  const wi: number[] = [];
  const deep = new THREE.Color(COLORS.water);
  const light = new THREE.Color(0x3d9dff);
  const addRiver = (r: River) => {
    const step = 4;
    const cnt = Math.floor(r.end / step) + 1;
    const U = [-1, -0.6, -0.2, 0.2, 0.6, 1];
    const base0 = wp.length / 3;
    for (let k = 0; k < cnt; k++) {
      const s = k * step;
      const xr = r.xr(s);
      const taper = 1 - smooth(r.end - 90, r.end, s);
      const half = (r.hw(s) + 3.5) * taper + 0.01;
      const z = r.side * (HALF_D + s);
      const y = r.wl(s);
      for (let u = 0; u < U.length; u++) {
        wp.push(xr + half * U[u], y, z);
        const lightK = (Math.abs(U[u]) > 0.9 ? 0.85 : 0) + ((k >> 3) % 3 === 0 ? 0.35 : 0);
        tmp.copy(deep).lerp(light, Math.min(1, lightK));
        wc.push(tmp.r, tmp.g, tmp.b);
      }
    }
    for (let k = 0; k < cnt - 1; k++)
      for (let u = 0; u < U.length - 1; u++) {
        const a = base0 + k * U.length + u;
        wi.push(a, a + U.length, a + 1, a + 1, a + U.length, a + U.length + 1);
      }
  };
  D.rivers.forEach(addRiver);
  // lake
  {
    const lk = D.lake;
    const rings = [0.0001, 0.45, 0.8, 1.18];
    const seg = 72;
    const base0 = wp.length / 3;
    for (let ri = 0; ri < rings.length; ri++) {
      for (let k = 0; k < (ri === 0 ? 1 : seg); k++) {
        const a = (k / seg) * Math.PI * 2;
        let lo = 0, hi = Math.max(lk.ax, lk.az) * 2;
        const dx = Math.cos(a), dz = Math.sin(a);
        for (let it = 0; it < 14; it++) {
          const mid = (lo + hi) / 2;
          if (lk.q(lk.cx + dx * mid, lk.cz + dz * mid) < rings[ri]) lo = mid; else hi = mid;
        }
        const rr = ri === 0 ? 0 : lo;
        wp.push(lk.cx + dx * rr, lk.level, lk.cz + dz * rr);
        tmp.copy(deep).lerp(light, ri === 0 ? 0 : ri === 1 ? 0.1 : ri === 2 ? 0.35 : 0.9);
        wc.push(tmp.r, tmp.g, tmp.b);
      }
    }
    // centre fan
    for (let k = 0; k < seg; k++) wi.push(base0, base0 + 1 + ((k + 1) % seg), base0 + 1 + k);
    for (let ri = 1; ri < rings.length - 1; ri++) {
      const o0 = base0 + 1 + (ri - 1) * seg;
      const o1 = o0 + seg;
      for (let k = 0; k < seg; k++) {
        const k2 = (k + 1) % seg;
        wi.push(o0 + k, o1 + k2, o1 + k, o0 + k, o0 + k2, o1 + k2);
      }
    }
  }
  const wgeo = new THREE.BufferGeometry();
  wgeo.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
  wgeo.setAttribute('color', new THREE.Float32BufferAttribute(wc, 3));
  wgeo.setIndex(wi);
  const wnor = new Float32Array(wp.length);
  for (let i = 1; i < wnor.length; i += 3) wnor[i] = 1;
  wgeo.setAttribute('normal', new THREE.BufferAttribute(wnor, 3));
  const wmat = MAT.water.clone() as THREE.MeshToonMaterial;
  wmat.color.set(0xffffff);
  wmat.vertexColors = true;
  wmat.side = THREE.DoubleSide;
  wmat.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = WIND.uWindTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWaterTime;\nvarying vec3 vWaterPos;')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        vec2 wq = vWaterPos.xz;
        float rip = sin(wq.x * 0.55 + wq.y * 0.33 + uWaterTime * 1.5) * sin(wq.y * 0.67 - wq.x * 0.25 - uWaterTime * 1.1)
                  + 0.6 * sin(wq.x * 1.43 - wq.y * 1.01 + uWaterTime * 2.3) * sin(wq.x * 0.97 + wq.y * 1.27 - uWaterTime * 1.9);
        float spark = smoothstep(1.0, 1.4, rip);
        float band = smoothstep(-0.2, 0.9, rip) * 0.06;
        diffuseColor.rgb += vec3(0.20, 0.24, 0.26) * spark + vec3(0.02, 0.05, 0.08) * band;`,
      );
  };
  wmat.customProgramCacheKey = () => 'terrain-water';
  wmat.needsUpdate = true;
  const wmesh = new THREE.Mesh(wgeo, wmat);
  wmesh.frustumCulled = false;
  wmesh.receiveShadow = true;
  group.add(wmesh);
  disposables.push(wgeo, wmat);

  return {
    group,
    dispose() {
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
}
