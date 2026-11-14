/**
 * Model gallery — preview any model in isolation.
 *   /models.html                       all building models in a row (variant 0)
 *   /models.html?kind=hospital         one model, all variants
 *   /models.html?kind=hospital&az=135  camera azimuth in degrees (default 35), &el= elevation
 *   /models.html?kind=pylon | pole | props
 *   &zoom=2                            move camera closer (detail check)
 * Blue balls mark userData.powerPorts / userData.attach points.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CELL, FOOTPRINT } from '../core/constants';

const params = new URLSearchParams(location.search);
const only = params.get('kind');
const az = (Number(params.get('az') ?? 35) * Math.PI) / 180;
const el = (Number(params.get('el') ?? 30) * Math.PI) / 180;
const zoom = Number(params.get('zoom') ?? 1);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xfbf6e6);
scene.add(new THREE.HemisphereLight(0xffffff, 0xd9cfae, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(60, 100, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, far: 500 });
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshToonMaterial({ color: 0xe6dcc0 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.5, 4000);
const controls = new OrbitControls(camera, renderer.domElement);

const mods = import.meta.glob('../models/*.ts');
const KINDS = Object.keys(FOOTPRINT) as (keyof typeof FOOTPRINT)[];

function finish(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}

function footprintTile(wCells: number, dCells: number, x: number) {
  const tile = new THREE.Mesh(
    new THREE.BoxGeometry(wCells * CELL, 0.05, dCells * CELL),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  tile.position.set(x, 0.01, 0);
  scene.add(tile);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(tile.geometry),
    new THREE.LineBasicMaterial({ color: 0x121310 }),
  );
  edges.position.copy(tile.position);
  scene.add(edges);
}

async function load(name: string): Promise<any | null> {
  const key = `../models/${name}.ts`;
  if (!mods[key]) return null;
  try {
    return await mods[key]();
  } catch (e) {
    console.error(name, e);
    return null;
  }
}

async function main() {
  const items: { obj: THREE.Object3D; w: number; d: number; label: string }[] = [];
  if (only === 'pylon' || only === 'pole') {
    const m = await load('pylon');
    if (m) items.push({ obj: only === 'pylon' ? m.buildPylon() : m.buildPole(), w: 1, d: 1, label: only });
  } else if (only === 'props') {
    const m = await load('props');
    if (m) {
      for (let v = 0; v < 3; v++) items.push({ obj: m.buildTree(v), w: 1, d: 1, label: `tree ${v}` });
      items.push({ obj: m.buildStreetLight(), w: 1, d: 1, label: 'streetlight' });
      for (let v = 0; v < 3; v++) items.push({ obj: m.buildCar(v), w: 1, d: 1, label: `car ${v}` });
    }
  } else {
    const kinds = only ? [only as keyof typeof FOOTPRINT] : KINDS;
    for (const k of kinds) {
      const m = await load(k);
      if (!m) continue;
      const fp = FOOTPRINT[k];
      const nv = only ? (m.VARIANTS ?? 1) : 1;
      for (let v = 0; v < nv; v++)
        items.push({ obj: m.build({ variant: v, seed: 7 + v }), w: fp.w, d: fp.d, label: `${k} v${v}` });
    }
  }

  let x = 0;
  let maxH = 10;
  const gap = CELL * 0.6;
  for (const it of items) {
    const W = it.w * CELL;
    x += W / 2;
    footprintTile(it.w, it.d, x);
    it.obj.position.x = x;
    finish(it.obj);
    scene.add(it.obj);
    const bb = new THREE.Box3().setFromObject(it.obj);
    maxH = Math.max(maxH, bb.max.y);
    const ports: THREE.Vector3[] = it.obj.userData.powerPorts ?? it.obj.userData.attach ?? [];
    for (const p of ports) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.35), new THREE.MeshBasicMaterial({ color: 0x0a7cff }));
      s.position.copy(p).add(it.obj.position);
      scene.add(s);
    }
    // outgoing ports (substation / generator) in orange
    for (const p of (it.obj.userData.outPorts ?? []) as THREE.Vector3[]) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.35), new THREE.MeshBasicMaterial({ color: 0xff8a00 }));
      s.position.copy(p).add(it.obj.position);
      scene.add(s);
    }
    x += W / 2 + gap;
  }
  const total = Math.max(x - gap, CELL);
  const cx = total / 2;
  const target = new THREE.Vector3(cx, maxH * 0.35, 0);
  const dist = Math.max(total * 1.15, maxH * 2.6, 40) / zoom;
  camera.position.set(
    cx + Math.sin(az) * Math.cos(el) * dist,
    target.y + Math.sin(el) * dist,
    Math.cos(az) * Math.cos(el) * dist,
  );
  controls.target.copy(target);
  controls.update();
  document.getElementById('label')!.textContent = items.map((i) => i.label).join('  ·  ') || 'no models yet';
  let meshes = 0;
  scene.traverse((o) => ((o as THREE.Mesh).isMesh ? meshes++ : 0));
  console.log(`gallery: ${items.length} items, ${meshes} meshes`);

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    scene.traverse((o) => {
      const s = o.userData.spin;
      if (s) o.rotation[s.axis as 'x' | 'y' | 'z'] = t * s.speed;
      if (o.userData.role === 'beacon') o.visible = Math.sin(t * 4) > 0;
    });
    controls.update();
    renderer.render(scene, camera);
  });
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

main();
