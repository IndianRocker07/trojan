import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { Emitter } from '../core/events';
import { HALF_D, HALF_W, START_HOUR } from '../core/constants';
import type { SimSnapshot } from '../core/types';
import { BuildingBatch } from './batch';
import { Effects } from './fx';
import { buildGround, type Ground } from './ground';
import { Labels } from './labels';
import { PowerLines } from './lines';
import { ModelLib } from './modelLib';
import { buildEnvironment, type Environment } from './env';
import { Overlays } from './overlays';
import { WaterLayer } from './water';
import { Picker } from './picking';
import { Scatter } from './scatter';

export type LayerName = 'grid' | 'power' | 'water' | 'flow' | 'labels' | 'status';

export interface WorldEvents extends Record<string, unknown> {
  select: string | null;
  cellPick: { col: number; row: number };
  hover: string | null;
}

export interface ViewOptions {
  /** azimuth degrees (45 default), elevation degrees (50), distance m, target x/z */
  azimuth?: number;
  elevation?: number;
  distance?: number;
  target?: { x: number; z: number };
}

const CREAM = new THREE.Color(0xfbf6e6);
const DUSK = new THREE.Color(0xf4c79c);
const NIGHT = new THREE.Color(0x151b36);
const DUSKP = new THREE.Color(0x7d5f8f);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const SHADOW_SIZE = 4096;

export class WorldView extends Emitter<WorldEvents> {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;

  private container: HTMLElement;
  private lib = new ModelLib();
  private _modelsReady = false;
  private hemi = new THREE.HemisphereLight(0xffffff, 0xd9cfae, 1.5);
  private sun = new THREE.DirectionalLight(0xffffff, 2.3);
  private labels: Labels;
  private picker: Picker;
  private ro: ResizeObserver;

  private ground: Ground | null = null;
  private env: Environment | null = null;
  private nightF = 0;
  private batch: BuildingBatch | null = null;
  private scatter: Scatter | null = null;
  private lines: PowerLines | null = null;
  private overlays: Overlays | null = null;
  private fx: Effects | null = null;
  private waterLayer: WaterLayer | null = null;
  private rings: THREE.LineSegments | null = null;
  private fade = { ground: 1, power: 1, water: 0 };
  private reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  private snap: SimSnapshot | null = null;
  private pending: SimSnapshot | null = null;
  private resolveReady!: () => void;
  /** Resolves after the first build() has actually completed (models loaded, city in the scene). */
  readonly ready: Promise<void> = new Promise((r) => (this.resolveReady = r));
  private built = false;
  private layers: Record<LayerName, boolean> = { grid: false, power: true, water: false, flow: true, labels: true, status: true };
  private selected: string | null = null;
  private clock = new THREE.Clock();
  private t = 0;
  private disposed = false;
  private tween: null | { t: number; dur: number; fromT: THREE.Vector3; toT: THREE.Vector3; fromO: THREE.Vector3; toO: THREE.Vector3 } = null;
  private logCalls = false;
  private frameMs = 16;
  private lastHour = -1;
  private shadowT = 0;
  private pr = 1;
  private _stats = { buildMs: 0, calls: 0, triangles: 0, fps: 0 };
  private sunDir = new THREE.Vector3();

  constructor(container: HTMLElement, opts: { preserveDrawingBuffer?: boolean } = {}) {
    super();
    this.container = container;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: opts.preserveDrawingBuffer });
    this.pr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pr);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    const cv = this.renderer.domElement;
    cv.style.display = 'block';
    container.appendChild(cv);

    this.scene.background = CREAM.clone();
    this.scene.fog = new THREE.Fog(CREAM.clone(), 1400, 3600);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    Object.assign(this.sun.shadow.camera, { left: -450, right: 450, top: 450, bottom: -450, near: 10, far: 2800 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;

    this.camera = new THREE.PerspectiveCamera(40, 1, 8, 4500);
    this.controls = new MapControls(this.camera, cv);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 60;
    this.controls.maxDistance = 1150;
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(20);
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(75);
    this.setView({ azimuth: 45, elevation: 50, distance: 1060, target: { x: 35, z: 35 } });

    this.labels = new Labels(container);
    this.picker = new Picker(cv, this.camera, {
      hover: (id) => {
        this.labels.setHover(id, this.snap?.buildings ?? {});
        this.emit('hover', id);
      },
      select: (id) => {
        this.select(id);
        this.emit('select', id);
      },
      cell: (col, row) => this.emit('cellPick', { col, row }),
    });
    this.scene.add(this.picker.group, this.labels.group);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.applyTime(START_HOUR);
    this.renderer.setAnimationLoop(this.frame);
    this.lib.ready.then(() => {
      this._modelsReady = true;
      if (this.pending && !this.disposed) {
        const s = this.pending;
        this.pending = null;
        this.build(s);
      }
    });
  }

  // ─────────────────────────── public API ───────────────────────────

  build(s: SimSnapshot): void {
    if (this.disposed) return;
    // models load asynchronously the first time; defer until ready
    if (!this._modelsReady) {
      this.pending = s;
      return;
    }
    const t0 = performance.now();
    this.teardown();
    this.snap = s;
    const infosAll = Object.values(s.buildings);

    this.ground = buildGround(s.cells);
    this.scene.add(this.ground.group);

    this.env = buildEnvironment(s.cells);
    this.scene.add(this.env.group);
    this.env.setNight(this.nightF);

    this.batch = new BuildingBatch(infosAll, this.lib);
    this.scene.add(this.batch.group);

    const poles = Object.values(s.network.nodes).filter((n) => n.kind === 'pole');
    this.scatter = new Scatter(s.cells, poles, this.lib);
    this.scene.add(this.scatter.group);

    this.lines = new PowerLines(s, this.batch, this.lib);
    this.scene.add(this.lines.group);
    this.lines.setResolution(this.container.clientWidth, this.container.clientHeight, this.pr);
    this.lines.setFlowVisible(this.layers.flow);

    this.waterLayer = new WaterLayer(s, this.batch.info);
    this.scene.add(this.waterLayer.group);
    {
      const pts: number[] = [];
      for (const i of this.batch.info.values()) {
        const x0 = i.cx - i.w / 2 + 0.4, x1 = i.cx + i.w / 2 - 0.4, z0 = i.cz - i.d / 2 + 0.4, z1 = i.cz + i.d / 2 - 0.4;
        pts.push(x0, 0.3, z0, x1, 0.3, z0, x1, 0.3, z0, x1, 0.3, z1, x1, 0.3, z1, x0, 0.3, z1, x0, 0.3, z1, x0, 0.3, z0);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.rings = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x121310 }));
      this.rings.visible = false;
      this.scene.add(this.rings);
    }
    this.fade = { ground: this.layers.water ? 0.35 : 1, power: this.layers.power ? (this.layers.water ? 0.4 : 1) : 0, water: this.layers.water ? 1 : 0 };
    this.applyFade();
    this.pushFade();

    this.overlays = new Overlays(s.cells);
    this.scene.add(this.overlays.group);
    this.overlays.setGrid(this.layers.grid);
    this.overlays.setStatus(this.layers.status);

    this.fx = new Effects(s.cells);
    this.fx.prime(s);
    this.scene.add(this.fx.group);

    this.picker.setBuildings(this.batch.info);
    this.labels.build(s.buildings, this.batch.info);
    this.labels.setVisible(this.layers.labels);
    this.picker.setSelected(this.selected);

    this.built = true;
    this.resolveReady();
    this.lastHour = -1;
    this.sync(s);
    this._stats.buildMs = performance.now() - t0;
    this.logCalls = true;
    console.log(`[render] build ${this._stats.buildMs.toFixed(0)} ms, ${infosAll.length} buildings, ${this.lines.stats.supports} supports, ${this.lines.stats.edges} edges, trees ${this.scatter.count.trees}, cars ${this.scatter.count.cars}, lights ${this.scatter.count.lights}`);
  }

  sync(s: SimSnapshot): void {
    this.snap = s;
    if (!this.built || !this.batch) {
      if (!this.built) this.pending = s;
      return;
    }
    const hour = (START_HOUR + s.tMin / 60) % 24;
    if (Math.abs(hour - this.lastHour) > 0.01) {
      this.lastHour = hour;
      this.applyTime(hour);
    }
    for (const b of Object.values(s.buildings)) this.batch.setStatus(b.id, b.status);
    this.lines!.sync(s);
    this.waterLayer?.sync(s);
    this.overlays!.sync(s);
    this.fx!.sync(s, this.batch.info);
    this.labels.sync(s.buildings);
  }

  setPickMode(m: 'select' | 'cell'): void {
    this.picker.setPickMode(m);
  }

  /** Radius (cells) of the cell-mode preview disc. */
  setCellPreviewRadius(cells: number): void {
    this.picker.setPreviewRadius(cells);
  }

  setLayer(name: LayerName, on: boolean): void {
    this.layers[name] = on;
    if (name === 'grid') this.overlays?.setGrid(on);
    else if (name === 'status') this.overlays?.setStatus(on);
    else if (name === 'flow') this.lines?.setFlowVisible(on);
    else if (name === 'power' || name === 'water') this.applyFade();
    else this.labels.setVisible(on);
  }

  focus(buildingId: string): void {
    const info = this.batch?.info.get(buildingId);
    if (!info) return;
    const toT = new THREE.Vector3(info.cx, info.height * 0.35, info.cz);
    const off = this.camera.position.clone().sub(this.controls.target);
    const dist = Math.min(220, Math.max(70, Math.max(info.w, info.d) * 3 + info.height));
    off.setLength(dist);
    this.tween = {
      t: 0,
      dur: 0.9,
      fromT: this.controls.target.clone(),
      toT,
      fromO: this.camera.position.clone().sub(this.controls.target),
      toO: off,
    };
  }

  select(buildingId: string | null): void {
    this.selected = buildingId;
    this.picker.setSelected(buildingId);
  }

  setView(o: ViewOptions): void {
    const az = THREE.MathUtils.degToRad(o.azimuth ?? 45);
    const el = THREE.MathUtils.degToRad(o.elevation ?? 50);
    const d = o.distance ?? 1060;
    const t = new THREE.Vector3(o.target?.x ?? 35, 0, o.target?.z ?? 35);
    this.controls.target.copy(t);
    this.camera.position.set(t.x + Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, t.z + Math.cos(az) * Math.cos(el) * d);
    this.camera.lookAt(t);
    this.controls.update();
  }

  /** Move the camera to look at a world X/Z point (optional distance). */
  lookAt(x: number, z: number, distance = 160): void {
    const off = this.camera.position.clone().sub(this.controls.target).setLength(distance);
    this.tween = { t: 0, dur: 0.8, fromT: this.controls.target.clone(), toT: new THREE.Vector3(x, 0, z), fromO: this.camera.position.clone().sub(this.controls.target), toO: off };
  }

  get stats() {
    return { ...this._stats, hour: this.lastHour, fade: this.fade, pipes: this.waterLayer ? (this.waterLayer as any).recs.length : -1 };
  }

  get buildingInfo() {
    return this.batch?.info;
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.teardown();
    this.picker.dispose();
    this.labels.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ─────────────────────────── internals ───────────────────────────

  private teardown(): void {
    this.built = false;
    this.ground?.dispose();
    this.env?.dispose();
    this.env = null;
    this.batch?.dispose();
    this.scatter?.dispose();
    this.lines?.dispose();
    this.overlays?.dispose();
    this.fx?.dispose();
    this.waterLayer?.dispose();
    if (this.rings) {
      this.rings.geometry.dispose();
      (this.rings.material as THREE.Material).dispose();
      this.rings.removeFromParent();
      this.rings = null;
    }
    this.waterLayer = null;
    this.ground = this.batch = this.scatter = this.lines = this.overlays = this.fx = null;
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.lines?.setResolution(w, h, this.pr);
    this.picker.setResolution(w, h, this.pr);
  }

  /** Sun / moon, sky colours and street lamps from the hour of day. */
  private applyTime(h: number): void {
    const s = Math.sin((Math.PI * (h - 6)) / 12.5);
    const day = h >= 6 && h <= 18.5;
    const alt = day ? 62 * s : -20;
    const dayF = smooth(-8, 16, alt);
    const warm = (1 - smooth(8, 32, alt)) * dayF;
    const az = (Math.PI * (Math.min(18.5, Math.max(6, h)) - 6)) / 12.5;
    const altEff = THREE.MathUtils.degToRad(Math.max(alt, 6));
    const dSun = new THREE.Vector3(Math.cos(az), 0, Math.sin(az) * 0.8 + 0.4).normalize().multiplyScalar(Math.cos(altEff));
    dSun.y = Math.sin(altEff);
    const dMoon = new THREE.Vector3(-0.55, 0.8, 0.5).normalize();
    this.sunDir.copy(dMoon).lerp(dSun, dayF).normalize();
    this.sun.position.copy(this.sunDir).multiplyScalar(1300);
    this.sun.target.position.set(0, 0, 0);

    const sunCol = new THREE.Color(0xfff4e0).lerp(new THREE.Color(0xff9b4e), warm * 0.85);
    this.sun.color.copy(new THREE.Color(0x8aa4ff).lerp(sunCol, dayF));
    this.sun.intensity = THREE.MathUtils.lerp(1.05, 2.35, dayF);
    this.hemi.color.copy(new THREE.Color(0x6f84d8).lerp(new THREE.Color(0xffffff).lerp(new THREE.Color(0xffd9b8), warm * 0.5), dayF));
    this.hemi.groundColor.copy(new THREE.Color(0x3a4685).lerp(new THREE.Color(0xd9cfae), dayF));
    this.hemi.intensity = THREE.MathUtils.lerp(2.1, 1.5, dayF);

    const dayCol = CREAM.clone().lerp(DUSK, warm * 0.7);
    const bg = dayF < 0.5 ? NIGHT.clone().lerp(DUSKP, dayF * 2) : DUSKP.clone().lerp(dayCol, (dayF - 0.5) * 2);
    (this.scene.background as THREE.Color).copy(bg);
    (this.scene.fog as THREE.Fog).color.copy(bg);
    this.scatter?.setNight(1 - dayF);
    this.nightF = 1 - dayF;
    this.env?.setNight(this.nightF);
    this.renderer.shadowMap.needsUpdate = true;
  }

  private applyFade(): void {
    const w = this.layers.water;
    const target = { ground: w ? 0.35 : 1, power: this.layers.power ? (w ? 0.4 : 1) : 0, water: w ? 1 : 0 };
    (this as any)._fadeTarget = target;
    if (this.reduced) {
      this.fade = { ...target };
      this.pushFade();
    }
  }

  private pushFade(): void {
    this.ground?.setFade(this.fade.ground);
    this.lines?.setOpacity(this.fade.power);
    this.waterLayer?.setOpacity(this.fade.water);
    if (this.waterLayer) this.waterLayer.group.visible = this.fade.water > 0.01;
    if (this.rings) this.rings.visible = this.fade.water > 0.01;
  }

  private stepFade(dt: number): void {
    const tg = (this as any)._fadeTarget as { ground: number; power: number; water: number } | undefined;
    if (!tg) return;
    let changed = false;
    for (const k of ['ground', 'power', 'water'] as const) {
      const d = tg[k] - this.fade[k];
      if (Math.abs(d) < 1e-3) {
        if (d !== 0) {
          this.fade[k] = tg[k];
          changed = true;
        }
        continue;
      }
      this.fade[k] += Math.sign(d) * Math.min(Math.abs(d), dt / 0.4);
      changed = true;
    }
    if (changed) this.pushFade();
  }

  private frame = (): void => {
    if (this.disposed) return;
    const dt = Math.min(0.1, this.clock.getDelta());
    this.t += dt;
    const t0 = performance.now();

    if (this.tween) {
      const tw = this.tween;
      tw.t += dt;
      const f = Math.min(1, tw.t / tw.dur);
      const e = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      const o = new THREE.Vector3().lerpVectors(tw.fromO, tw.toO, e);
      this.camera.position.copy(this.controls.target).add(o);
      if (f >= 1) this.tween = null;
    }
    // keep the target inside the city
    const tg = this.controls.target;
    tg.x = THREE.MathUtils.clamp(tg.x, -HALF_W * 1.05, HALF_W * 1.05);
    tg.z = THREE.MathUtils.clamp(tg.z, -HALF_D * 1.05, HALF_D * 1.05);
    tg.y = 0;
    this.controls.update();
    // never let the camera sink into the surrounding hills
    if (this.env) {
      const cp = this.camera.position;
      const floor = this.env.field.height(cp.x, cp.z) + 30;
      if (cp.y < floor) {
        cp.y = floor;
        this.camera.lookAt(tg);
      }
    }

    this.stepFade(dt);
    const camDist = this.camera.position.distanceTo(this.controls.target);
    this.labels.setDistance(camDist);
    this.lines?.setWidthScale(THREE.MathUtils.clamp(300 / camDist, 0.5, 1.4));
    this.env?.update(dt, this.t, this.camera);
    this.batch?.update(dt, this.t);
    this.waterLayer?.update(dt, this.fade.water > 0.01);
    this.lines?.update(dt);
    this.overlays?.update(dt, this.t);
    this.fx?.update(dt, this.t);
    this.picker.update();

    const amp = this.fx?.shakeAmp ?? 0;
    let sx = 0;
    let sy = 0;
    if (amp > 0) {
      sx = (Math.random() - 0.5) * 2.4 * amp;
      sy = (Math.random() - 0.5) * 1.6 * amp;
      this.camera.position.x += sx;
      this.camera.position.y += sy;
    }
    this.shadowT += dt;
    if (this.shadowT > 0.4) {
      this.shadowT = 0;
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    if (amp > 0) {
      this.camera.position.x -= sx;
      this.camera.position.y -= sy;
    }

    if (this.logCalls) {
      this.logCalls = false;
      const i = this.renderer.info.render;
      this._stats.calls = i.calls;
      this._stats.triangles = i.triangles;
      console.log(`[render] draw calls ${i.calls}, triangles ${i.triangles}, geometries ${this.renderer.info.memory.geometries}`);
    }
    const ms = performance.now() - t0;
    this.frameMs += (ms - this.frameMs) * 0.05;
    this._stats.fps = 1000 / Math.max(1, this.frameMs);
  };
}
