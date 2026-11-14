import * as THREE from 'three';
import { HALF_D, HALF_W } from '../core/constants';
import { MAT } from './palette';
import { makeGrassDetailTexture } from './terrainTexture';

const STEP = 24;
const EXTENT = 2208;
const COUNT = (EXTENT * 2) / STEP + 1;
const TAU = Math.PI * 2;

type Summit = { angle: number; radius: number; height: number; width: number };

const hash = (n: number): number => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

const smoothstep = (a: number, b: number, x: number): number => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function makeSummits(count: number, radius: number, radiusSpread: number, height: number, width: number, seed: number): Summit[] {
  return Array.from({ length: count }, (_, i) => ({
    angle: (i / count) * TAU + (hash(seed + i * 3) - 0.5) * (TAU / count) * 0.58,
    radius: radius + (hash(seed + i * 3 + 1) - 0.5) * radiusSpread,
    height: height * (0.72 + hash(seed + i * 3 + 2) * 0.58),
    width: width * (0.78 + hash(seed + i * 3 + 3) * 0.62),
  }));
}

const nearSummits = makeSummits(25, 680, 140, 205, 0.19, 917);
const farSummits = makeSummits(21, 1280, 210, 350, 0.22, 2841);

function nearestSummit(angle: number, summits: Summit[]): { strength: number; radius: number; height: number } {
  let strength = 0;
  let radiusTotal = 0;
  let heightTotal = 0;
  let weightTotal = 0;
  for (const summit of summits) {
    let delta = Math.abs(angle - summit.angle);
    if (delta > Math.PI) delta = TAU - delta;
    const influence = Math.exp(-0.5 * (delta / summit.width) ** 2);
    strength = Math.max(strength, influence);
    const weight = influence * influence;
    radiusTotal += summit.radius * weight;
    heightTotal += summit.height * weight;
    weightTotal += weight;
  }
  return {
    strength,
    radius: radiusTotal / weightTotal,
    height: heightTotal / weightTotal,
  };
}

function elevation(x: number, z: number): number {
  // A softened square distance makes the range follow the city board while
  // keeping the mountain skyline rounded at the corners.
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const q = Math.pow(ax ** 10 + az ** 10, 0.1);
  const angle = Math.atan2(x, z);
  const near = nearestSummit(angle, nearSummits);
  const far = nearestSummit(angle + 0.17, farSummits);

  const nearRidge = near.radius + Math.sin(angle * 5.3 + 0.8) * 24 + Math.sin(angle * 11.7) * 11;
  const farRidge = far.radius + Math.sin(angle * 4.1 + 1.9) * 38 + Math.sin(angle * 9.3 + 0.4) * 19;
  const nearReach = Math.max(0, 1 - Math.abs(q - nearRidge) / 245);
  const farReach = Math.max(0, 1 - Math.abs(q - farRidge) / 410);
  const nearMass = (64 + near.height * (0.26 + near.strength * 0.74)) * Math.pow(nearReach, 1.35);
  const farMass = (76 + far.height * (0.24 + far.strength * 0.76)) * Math.pow(farReach, 1.3);

  const foothillFade = smoothstep(Math.max(HALF_W, HALF_D) + 24, 500, q);
  const rolling = foothillFade * (8 + Math.sin(x * 0.013 + z * 0.009) * 7 + Math.sin(z * 0.021 - x * 0.007) * 5);
  const rugged = (Math.sin(x * 0.024 + z * 0.019) * Math.sin(z * 0.031 - x * 0.015) * 8
    + Math.sin(x * 0.051 + z * 0.037) * 3.2) * Math.min(1, (nearMass + farMass) / 85);

  return Math.max(0, rolling + nearMass + farMass + rugged);
}

const GREEN = new THREE.Color(0x728765);
const EARTH = new THREE.Color(0x71835a);
const SAGE = new THREE.Color(0x667e75);
const SLATE = new THREE.Color(0x778486);
const ROCK = new THREE.Color(0x8f9088);
const SNOW = new THREE.Color(0xe5e3d9);

function vertexColor(height: number, slope: number, x: number, z: number, q: number): THREE.Color {
  const out = GREEN.clone();
  if (height > 45) out.lerp(SAGE, smoothstep(45, 155, height));
  if (height > 130) out.lerp(SLATE, smoothstep(130, 255, height));
  if (height > 225) out.lerp(ROCK, smoothstep(225, 355, height));
  if (height > 330) out.lerp(SNOW, smoothstep(330, 495, height));

  // Exposed faces read as rock; broad sheltered slopes keep their vegetation.
  out.lerp(ROCK, smoothstep(0.45, 1.35, slope) * (1 - smoothstep(310, 490, height)) * 0.24);
  // The terrain starts in the same warm earth tone as the city lots, then
  // gradually changes to meadow greens as it rises into the foothills.
  const edgeBlend = smoothstep(Math.max(HALF_W, HALF_D), 510, q);
  out.copy(EARTH.clone().lerp(GREEN, edgeBlend).lerp(out, smoothstep(410, 560, q)));
  const variation = 0.975 + (hash(Math.round(x / STEP) * 811 + Math.round(z / STEP) * 1297) - 0.5) * 0.07;
  return out.multiplyScalar(variation);
}

function addFoothillTrees(group: THREE.Group): { dispose(): void } {
  const spacing = 30;
  const trees: Array<{ x: number; z: number; y: number; scale: number; kind: number }> = [];
  const roadGap = (v: number) => {
    const d = ((v + 282) % 72 + 72) % 72;
    return Math.min(d, 72 - d);
  };
  for (let z = -EXTENT + spacing / 2; z < EXTENT; z += spacing) {
    for (let x = -EXTENT + spacing / 2; x < EXTENT; x += spacing) {
      const q = Math.pow(Math.abs(x) ** 10 + Math.abs(z) ** 10, 0.1);
      if (q < 340 || q > 660 || (q < 410 && (roadGap(x) < 9 || roadGap(z) < 9))) continue;
      const gx = Math.floor((x + EXTENT) / spacing);
      const gz = Math.floor((z + EXTENT) / spacing);
      const sample = hash(gx * 971 + gz * 313);
      if (sample > 0.29) continue;
      const size = 0.78 + hash(gx * 577 + gz * 1291) * 0.62;
      trees.push({ x, z, y: elevation(x, z), scale: size, kind: Math.floor(hash(gx * 1733 + gz * 947) * 3) });
    }
  }

  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 2.5, 7);
  const crownGeo = new THREE.ConeGeometry(1.65, 4.6, 7);
  const makeInstances = (geometry: THREE.BufferGeometry, material: THREE.Material, select: (tree: typeof trees[number]) => boolean, crown: boolean) => {
    const selected = trees.filter(select);
    if (!selected.length) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, selected.length);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    selected.forEach((tree, i) => {
      position.set(tree.x, tree.y + (crown ? 4.0 : 1.25), tree.z);
      scale.setScalar(tree.scale);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), tree.kind * 0.7);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };

  makeInstances(trunkGeo, MAT.wood, () => true, false);
  const crownMaterials = [MAT.roofGreen, MAT.grass, MAT.green];
  crownMaterials.forEach((material, kind) => makeInstances(crownGeo, material, (tree) => tree.kind === kind, true));

  const bladePositions: number[] = [];
  for (let blade = 0; blade < 5; blade++) {
    const angle = (blade / 5) * Math.PI * 2 + 0.35;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const sideX = -dz * 0.075;
    const sideZ = dx * 0.075;
    const reach = 0.22 + (blade % 3) * 0.035;
    const bend = 0.08 + (blade % 2) * 0.045;
    const h = 0.76 + (blade % 3) * 0.12;
    const baseL: [number, number, number] = [-sideX, 0, -sideZ];
    const baseR: [number, number, number] = [sideX, 0, sideZ];
    const midL: [number, number, number] = [dx * bend - sideX * 0.55, h * 0.54, dz * bend - sideZ * 0.55];
    const midR: [number, number, number] = [dx * bend + sideX * 0.55, h * 0.54, dz * bend + sideZ * 0.55];
    const tip: [number, number, number] = [dx * reach, h, dz * reach];
    bladePositions.push(...baseL, ...baseR, ...midR, ...baseL, ...midR, ...midL, ...midL, ...midR, ...tip);
  }
  const bladeGeo = new THREE.BufferGeometry();
  bladeGeo.setAttribute('position', new THREE.Float32BufferAttribute(bladePositions, 3));
  bladeGeo.computeVertexNormals();

  const tufts: Array<{ x: number; z: number; y: number; scale: number; height: number; kind: number }> = [];
  const step = 5.5;
  for (let z = -EXTENT + step / 2; z < EXTENT; z += step) {
    for (let x = -EXTENT + step / 2; x < EXTENT; x += step) {
      const gx = Math.floor((x + EXTENT) / step);
      const gz = Math.floor((z + EXTENT) / step);
      const jx = (hash(gx * 137 + gz * 863) - 0.5) * 3.2;
      const jz = (hash(gx * 431 + gz * 239) - 0.5) * 3.2;
      const px = x + jx;
      const pz = z + jz;
      const q = Math.pow(Math.abs(px) ** 10 + Math.abs(pz) ** 10, 0.1);
      if (q < 302 || q > 625 || (q < 410 && (roadGap(px) < 7 || roadGap(pz) < 7))) continue;
      const density = q < 380 ? 0.16 : q < 500 ? 0.105 : 0.055;
      if (hash(gx * 971 + gz * 313) > density) continue;
      if (trees.some((tree) => Math.hypot(tree.x - px, tree.z - pz) < 4.5)) continue;
      const n = hash(gx * 577 + gz * 1291);
      tufts.push({
        x: px,
        z: pz,
        y: elevation(px, pz) + 0.025,
        scale: 0.7 + n * 0.85,
        height: 1.25 + hash(gx * 887 + gz * 619) * 1.15,
        kind: Math.floor(hash(gx * 1733 + gz * 947) * 3),
      });
    }
  }

  const tuftMats = [0x637d45, 0x849052, 0xa39460].map((color) => {
    const material = MAT.grass.clone();
    material.color.set(color);
    material.side = THREE.DoubleSide;
    return material;
  });
  for (let kind = 0; kind < tuftMats.length; kind++) {
    const selected = tufts.filter((tuft) => tuft.kind === kind);
    if (!selected.length) continue;
    const mesh = new THREE.InstancedMesh(bladeGeo, tuftMats[kind], selected.length);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    selected.forEach((tuft, i) => {
      position.set(tuft.x, tuft.y, tuft.z);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash(Math.floor(tuft.x) * 139 + Math.floor(tuft.z) * 311) * Math.PI * 2);
      scale.set(tuft.scale, tuft.height, tuft.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  return {
    dispose() {
      trunkGeo.dispose();
      crownGeo.dispose();
      bladeGeo.dispose();
      tuftMats.forEach((material) => material.dispose());
    },
  };
}

export interface Mountains {
  group: THREE.Group;
  dispose(): void;
}

/** A soft, fully surrounding mountain basin behind the playable city board. */
export function buildMountains(): Mountains {
  const positions = new Float32Array(COUNT * COUNT * 3);
  const uvs = new Float32Array(COUNT * COUNT * 2);
  const heights = new Float32Array(COUNT * COUNT);
  const colors = new Float32Array(COUNT * COUNT * 3);
  const indices: number[] = [];
  const coord = (i: number) => -EXTENT + i * STEP;
  const id = (x: number, z: number) => z * COUNT + x;

  for (let row = 0; row < COUNT; row++) {
    const z = coord(row);
    for (let col = 0; col < COUNT; col++) {
      const x = coord(col);
      const i = id(col, row);
      const y = elevation(x, z);
      heights[i] = y;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = x / 24;
      uvs[i * 2 + 1] = z / 24;
    }
  }

  for (let row = 0; row < COUNT; row++) {
    const z = coord(row);
    for (let col = 0; col < COUNT; col++) {
      const x = coord(col);
      const i = id(col, row);
      const left = heights[id(Math.max(0, col - 1), row)];
      const right = heights[id(Math.min(COUNT - 1, col + 1), row)];
      const back = heights[id(col, Math.max(0, row - 1))];
      const front = heights[id(col, Math.min(COUNT - 1, row + 1))];
      const slope = Math.hypot((right - left) / (2 * STEP), (front - back) / (2 * STEP));
      const c = vertexColor(heights[i], slope, x, z, Math.pow(Math.abs(x) ** 10 + Math.abs(z) ** 10, 0.1));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;

      if (col >= COUNT - 1 || row >= COUNT - 1) continue;
      const x1 = x + STEP;
      const z1 = z + STEP;
      const minX = x <= 0 && x1 >= 0 ? 0 : Math.min(Math.abs(x), Math.abs(x1));
      const minZ = z <= 0 && z1 >= 0 ? 0 : Math.min(Math.abs(z), Math.abs(z1));
      if (Math.max(minX, minZ) < Math.max(HALF_W, HALF_D)) continue;

      const a = i;
      const b = id(col + 1, row);
      const c0 = id(col, row + 1);
      const d = id(col + 1, row + 1);
      indices.push(a, c0, b, b, c0, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = MAT.paving.clone() as THREE.MeshToonMaterial;
  material.color.set(0xffffff);
  material.vertexColors = true;
  const grassTexture = makeGrassDetailTexture();
  material.map = grassTexture;
  material.needsUpdate = true;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.frustumCulled = true;
  const group = new THREE.Group();
  group.add(mesh);
  const groves = addFoothillTrees(group);

  return {
    group,
    dispose() {
      geometry.dispose();
      grassTexture.dispose();
      material.dispose();
      groves.dispose();
      group.removeFromParent();
    },
  };
}
