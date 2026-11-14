/**
 * Negotiation Theater — full-screen Three.js view of utility agents negotiating power on a glowing dotted globe.
 * docs/STORY.md §1–§2. Implements ReplayRenderer: the UI replay stepper drives showReplay(replay, stage, progress).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Emitter } from '../core/events';
import type { ConsumerKind, NegotiationReplay, ReplayRenderer, SimSnapshot, Stance } from '../core/types';
import { ArcPool, type ArcSpec } from './arcs';
import { GlobeLayers, R, buildingGrid, gridDir } from './globe';
import { GlintLayer, RingLayer, SpikeLayer, type RingSpec, type SpikeSpec } from './marks';
import { CSS, PAL } from './palette';
import { ambientFrame, stageFrame, type ArcRole, type Frame, type FrameAgent } from './script';
import { synthReplay } from './synth';

export { synthReplay } from './synth';

const HUB_ALT = 13;
const AMBIENT_PERIOD = 4.6; // s per live bid → grant cycle
const FOV = 34;

const STYLE_ID = 'theater-style';
const STYLE = `
.theater-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;z-index:4;pointer-events:none;outline:none;touch-action:none}
.theater-canvas.on{pointer-events:auto}
.theater-overlay{position:absolute;inset:0;z-index:5;pointer-events:none;overflow:hidden;font:600 12px/1.3 Inter,system-ui,sans-serif;color:${CSS.text}}
.theater-label{position:absolute;left:0;top:0;white-space:nowrap;padding:4px 11px;border-radius:999px;background:${CSS.panel};border:2px solid ${CSS.pink};box-shadow:0 0 16px rgba(255,106,213,.45);font-size:12.5px;will-change:transform}
.theater-label b{color:#ff9be6;font-weight:800}
.theater-label.ok{border-color:${CSS.cyan};box-shadow:0 0 14px rgba(111,243,255,.35)}
.theater-label.ok b{color:${CSS.cyan}}
.theater-tip{position:absolute;left:0;top:0;min-width:190px;max-width:270px;padding:8px 11px 9px;border-radius:10px;background:${CSS.panel};border:2px solid ${CSS.border};box-shadow:0 0 18px rgba(124,131,255,.35);display:none}
.theater-tip h4{margin:0 0 2px;font-size:13px;font-weight:800}
.theater-tip .sub{color:${CSS.dim};font-size:11px;margin-bottom:5px}
.theater-tip .row{display:flex;justify-content:space-between;gap:14px;font:600 11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.theater-tip .row span:first-child{color:${CSS.dim};font-family:Inter,system-ui,sans-serif}
.theater-tip .chip{display:inline-block;margin-top:6px;padding:1px 8px;border-radius:999px;border:1.5px solid currentColor;font-size:11px;font-weight:700}
.theater-tip .note{margin-top:5px;color:#ffb3c0;font-size:11px}
`;

const KIND_LABEL: Record<ConsumerKind, string> = {
  hospital: 'Hospital',
  emergency: 'Emergency services',
  school: 'School / shelter',
  water: 'Water utility',
  telecom: 'Telecom tower',
  house: 'Household cluster',
};
const STANCE: Record<Stance, { label: string; color: string }> = {
  CRITICAL_HOLD: { label: 'Holding firm', color: '#ff6ad5' },
  PARTIAL_CONCESSION: { label: 'Partial concession', color: '#b9a6ff' },
  FULL_FLEX_SHED: { label: 'Sheds all flexible load', color: '#6ff3ff' },
};
const fmt = (kw: number) => (Math.abs(kw) >= 1000 ? `${(kw / 1000).toFixed(1)} MW` : `${Math.round(kw)} kW`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const spikeH = (kw: number) => (kw <= 0.5 ? 0 : 3.2 + 8 * Math.log10(1 + kw / 20));
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};

interface Slot {
  id: string;
  name: string;
  kind: ConsumerKind;
  dir: THREE.Vector3;
}
interface Pick {
  id: string;
  selectId: string | null;
  p: THREE.Vector3; // globe-local
  html: () => string;
}
interface HubView {
  key: string;
  dir: THREE.Vector3;
  text: string;
  ok: boolean;
  alpha: number;
}

export class TheaterView extends Emitter<{ select: string | null }> implements ReplayRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 1, 4000);
  readonly controls: OrbitControls;
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private globeGroup = new THREE.Group();
  private u = {
    uLight: { value: new THREE.Vector3(-0.72, 0.62, 0.32).normalize() },
    uScale: { value: 1000 },
    uTime: { value: 0 },
  };
  private globe: GlobeLayers;
  private arcs = new ArcPool();
  private spikes = new SpikeLayer(320);
  private glints: GlintLayer;
  private rings: RingLayer;
  private overlay: HTMLDivElement;
  private tip: HTMLDivElement;
  private labels = new Map<string, HTMLDivElement>();
  private ro: ResizeObserver;

  private snap: SimSnapshot | null = null;
  private slots: Slot[] = [];
  private houses: { id: string; dir: THREE.Vector3 }[] = [];
  private dirOf = new Map<string, THREE.Vector3>();
  private anchorCache = new Map<string, THREE.Vector3>();
  private hubCache = new WeakMap<NegotiationReplay, { dir: THREE.Vector3; radius: number }>();
  private liveHubCache: { sig: string; hubs: { id: number; dir: THREE.Vector3 }[] } = { sig: '', hubs: [] };
  private synthCache: { t: number; r: NegotiationReplay | null } | null = null;

  private replay: NegotiationReplay | null = null;
  private stageIndex = 0;
  private progress = 0;
  private visible = false;
  private disposed = false;
  private reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  private clock = new THREE.Clock(false);
  private t = 0;
  private ambientT = 0;
  private yaw = 0;
  private pr = 1;
  private userMoved = false;
  private picks: Pick[] = [];
  private hover: Pick | null = null;
  private mouse: { x: number; y: number } | null = null;
  private downAt: { x: number; y: number } | null = null;
  private tipTick = 0;
  private fpsAcc = { n: 0, t: 0, fps: 0 };
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmp3 = new THREE.Vector3();
  private col = new THREE.Color();

  constructor(container: HTMLElement) {
    super();
    this.container = container;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.info.autoReset = false;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'theater-canvas';
    this.canvas.style.display = 'none';
    this.canvas.setAttribute('aria-label', 'Negotiation Theater: utility agents negotiating power');
    container.appendChild(this.canvas);
    this.overlay = document.createElement('div');
    this.overlay.className = 'theater-overlay';
    this.overlay.style.display = 'none';
    this.tip = document.createElement('div');
    this.tip.className = 'theater-tip';
    this.overlay.appendChild(this.tip);
    container.appendChild(this.overlay);

    this.scene.background = PAL.bgEdge.clone();
    this.globe = new GlobeLayers(this.u);
    this.glints = new GlintLayer(2400, this.u);
    this.rings = new RingLayer(64, this.u.uTime);
    this.scene.add(this.globe.bg, this.globeGroup);
    this.globeGroup.add(this.globe.group, this.rings.mesh, this.spikes.mesh, this.arcs.mesh, this.glints.points);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, 16, 0);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.45;
    this.controls.zoomSpeed = 0.7;
    this.controls.minDistance = 150;
    this.controls.maxDistance = 900;
    this.controls.minPolarAngle = Math.PI * 0.28;
    this.controls.maxPolarAngle = Math.PI * 0.6;
    this.controls.minAzimuthAngle = -Math.PI * 0.4;
    this.controls.maxAzimuthAngle = Math.PI * 0.4;
    this.controls.addEventListener('start', () => (this.userMoved = true));

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.38, 0.5);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  // ─────────────────────────── public API ───────────────────────────

  build(s: SimSnapshot): void {
    if (this.disposed) return;
    this.snap = s;
    this.globe.build(s.cells, s.buildings);
    this.slots = [];
    this.houses = [];
    this.dirOf.clear();
    this.anchorCache.clear();
    this.liveHubCache.sig = '';
    this.synthCache = null;
    for (const b of Object.values(s.buildings)) {
      if (b.kind === 'generator' || b.kind === 'substation') continue;
      const g = buildingGrid(b);
      const dir = gridDir(g.col, g.row);
      this.dirOf.set(b.id, dir);
      if (b.kind === 'house') this.houses.push({ id: b.id, dir });
      else this.slots.push({ id: b.id, name: b.name, kind: b.kind, dir });
    }
  }

  sync(s: SimSnapshot): void {
    if (this.disposed) return;
    if (!this.slots.length) return this.build(s);
    this.snap = s;
    this.globe.syncStatus(s.cells);
  }

  setVisible(on: boolean): void {
    if (this.disposed || on === this.visible) return;
    this.visible = on;
    this.canvas.style.display = on ? 'block' : 'none';
    this.canvas.classList.toggle('on', on);
    this.overlay.style.display = on ? '' : 'none';
    if (on) {
      this.clock.start();
      this.resize();
      this.renderer.setAnimationLoop(this.frame);
    } else {
      this.renderer.setAnimationLoop(null);
      this.clock.stop();
      this.setHover(null);
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  showReplay(replay: NegotiationReplay | null, stageIndex: number, progress: number): void {
    this.replay = replay;
    this.stageIndex = stageIndex;
    this.progress = progress;
  }

  /** Rendering stats (draw calls of the last frame incl. post-processing; smoothed fps). */
  stats(): { calls: number; triangles: number; fps: number; arcs: number } {
    return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, fps: this.fpsAcc.fps, arcs: this.arcs.live };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.controls.dispose();
    this.globe.dispose();
    this.arcs.dispose();
    this.spikes.dispose();
    this.glints.dispose();
    this.rings.dispose();
    for (const p of this.composer.passes) p.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    this.overlay.remove();
    this.labels.clear();
  }

  // ─────────────────────────── frame ───────────────────────────

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    const dpr = window.devicePixelRatio || 1;
    // cap the backing store (~5 MP) so 1440p/4K stays fast with bloom
    this.pr = Math.min(dpr, 2, Math.sqrt(5.2e6 / (w * h)));
    this.renderer.setPixelRatio(this.pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.u.uScale.value = (h * this.pr) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    this.globe.setResolution(w, h);
    if (!this.userMoved) this.placeCamera();
  }

  private placeCamera(): void {
    const asp = this.camera.aspect;
    const tanH = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    // landscape: globe fills ~the height; portrait: fit most of the globe's width
    const D = Math.max(((R * 2.25) / (2 * tanH)) * 0.97, (R * (asp < 0.8 ? 1.0 : 1.1)) / (tanH * asp));
    const el = THREE.MathUtils.degToRad(asp < 0.8 ? 8 : 4);
    this.controls.target.set(0, asp < 0.8 ? 22 : 16, 0);
    this.camera.position.set(0, this.controls.target.y + D * Math.sin(el), D * Math.cos(el));
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  private frame = (): void => {
    if (this.disposed || !this.visible) return;
    const dt = Math.min(0.1, this.clock.getDelta());
    this.t += dt;
    this.u.uTime.value = this.t;
    this.fpsAcc.n++;
    this.fpsAcc.t += dt;
    if (this.fpsAcc.t >= 0.5) {
      this.fpsAcc.fps = this.fpsAcc.n / this.fpsAcc.t;
      this.fpsAcc.n = 0;
      this.fpsAcc.t = 0;
    }

    let r = this.replay;
    let fr: Frame | null = null;
    let ambient = false;
    if (r) fr = stageFrame(r, this.stageIndex, this.progress, this.reduced);
    else {
      r = this.ambientReplay();
      if (r) {
        this.ambientT += dt;
        fr = ambientFrame(r, (this.ambientT % AMBIENT_PERIOD) / AMBIENT_PERIOD, this.reduced);
        ambient = true;
      }
    }
    const hub = r ? this.replayHub(r) : null;

    // globe yaw: focus the replay island, otherwise slow sway (none with reduced motion)
    let target = 0;
    if (hub && !ambient) target = THREE.MathUtils.clamp(-Math.atan2(hub.dir.x, hub.dir.z), -0.6, 0.6);
    else if (!this.reduced) target = 0.32 * Math.sin(this.t * 0.07);
    this.yaw = this.reduced ? target : this.yaw + (target - this.yaw) * (1 - Math.exp(-dt * (ambient || !hub ? 3 : 2.2)));
    this.globeGroup.rotation.y = this.yaw;

    if (this.snap) this.updateMarks(r, fr, ambient, hub);
    this.controls.update();
    this.globeGroup.updateMatrixWorld();
    this.renderer.info.reset();
    this.composer.render(dt);
    this.updateOverlay();
  };

  private ambientReplay(): NegotiationReplay | null {
    const s = this.snap;
    const rs = s?.negotiation?.replays;
    if (rs && rs.length) return rs[rs.length - 1];
    if (!s?.negotiation) return null;
    const c = this.synthCache;
    if (!c || s.tMin - c.t >= 5 || s.tMin < c.t) this.synthCache = { t: s.tMin, r: synthReplay(s) };
    return this.synthCache!.r;
  }

  /** Unit direction of an agent (building) or cluster (centroid of members). */
  private anchor(id: string, members?: string[]): THREE.Vector3 | null {
    const d = this.dirOf.get(id) ?? this.anchorCache.get(id);
    if (d) return d;
    const m = members ?? this.snap?.negotiation?.agents[id]?.memberIds;
    if (!m || !m.length) return null;
    const v = new THREE.Vector3();
    for (const b of m) {
      const x = this.dirOf.get(b);
      if (x) v.add(x);
    }
    if (v.lengthSq() < 1e-9) return null;
    v.normalize();
    this.anchorCache.set(id, v);
    return v;
  }

  private replayHub(r: NegotiationReplay): { dir: THREE.Vector3; radius: number } {
    const hit = this.hubCache.get(r);
    if (hit) return hit;
    const v = new THREE.Vector3();
    const ds: THREE.Vector3[] = [];
    for (const p of r.participants) {
      const d = this.anchor(p.agentId, p.buildingIds);
      if (d) {
        v.add(d);
        ds.push(d);
      }
    }
    if (v.lengthSq() < 1e-9) v.set(0, Math.sin(0.4), Math.cos(0.4));
    v.normalize();
    let ang = 0;
    for (const d of ds) ang = Math.max(ang, v.angleTo(d));
    const out = { dir: v, radius: Math.max(10, ang * R * 1.05) };
    if (ds.length) this.hubCache.set(r, out);
    return out;
  }

  private liveHubs(): { id: number; dir: THREE.Vector3 }[] {
    const isl = this.snap?.islands ?? [];
    const sig = isl.map((i) => `${i.id}:${i.consumerIds.length}`).join(',');
    if (sig === this.liveHubCache.sig) return this.liveHubCache.hubs;
    const hubs: { id: number; dir: THREE.Vector3 }[] = [];
    for (const i of isl) {
      if (!i.consumerIds.length) continue;
      const v = new THREE.Vector3();
      for (const id of i.consumerIds) {
        const d = this.dirOf.get(id);
        if (d) v.add(d);
      }
      if (v.lengthSq() > 1e-9) hubs.push({ id: i.id, dir: v.normalize() });
    }
    this.liveHubCache = { sig, hubs };
    return hubs;
  }

  // ─────────────────────────── marks ───────────────────────────

  private updateMarks(r: NegotiationReplay | null, fr: Frame | null, ambient: boolean, hub: { dir: THREE.Vector3; radius: number } | null): void {
    const s = this.snap!;
    const focusMode = !!this.replay;
    const parts = new Map((r?.participants ?? []).map((p) => [p.agentId, p]));
    const spikes: SpikeSpec[] = [];
    const g = this.glints;
    g.begin();
    this.picks = [];
    const sparkle = fr?.sparkle ?? 0;
    const memberOfShown = new Set<string>();
    const rings: RingSpec[] = [];

    const pushAgent = (
      id: string,
      dir: THREE.Vector3,
      kind: ConsumerKind,
      name: string,
      v: { req: number; grant: number; floor: number },
      f: FrameAgent | undefined,
      alpha: number,
      cluster: boolean,
      members?: string[],
    ) => {
      const grow = f ? f.grow : 1;
      const h = spikeH(v.req) * grow * (cluster ? 0.85 : 1);
      const red = f?.red ?? 0;
      const pulse = f?.pulse ?? 0;
      const base = this.tmp.copy(dir).multiplyScalar(R + 0.2);
      if (h > 0.3)
        spikes.push({
          base: base.clone(),
          height: h,
          grantFrac: v.req > 0 ? v.grant / v.req : 0,
          floorFrac: v.floor > 0 && v.req > 0 ? Math.min(1, v.floor / v.req) : 0,
          alpha,
          width: cluster ? 0.9 : 1.2,
          red,
          boost: pulse * 0.9 + sparkle * 0.25,
        });
      // node
      const inShown = parts.has(id);
      this.col.copy(inShown ? PAL.node : PAL.nodeDim).lerp(PAL.nodePink, inShown ? 0.35 + 0.4 * pulse : 0);
      if (red > 0) this.col.lerp(PAL.red, red * 0.7);
      g.push(base, this.col, alpha * (cluster ? 0.5 : 0.75) * (1 + pulse * 1.2), cluster ? 1.5 : 2.1 + pulse * 1.6);
      // sparkle tips
      if (h > 0.3) {
        const hs = hash(id);
        this.tmp2.copy(dir).multiplyScalar(R + 0.2 + h + 0.5);
        g.push(this.tmp2, PAL.node, alpha * (0.9 + sparkle * 0.6), -(1.0 + sparkle * 0.8), 0.55);
        this.tmp2.copy(dir).multiplyScalar(R + 0.2 + h + 1.6 + 1.6 * hs);
        this.tmp2.x += (hs - 0.5) * 1.4;
        this.tmp2.z += (hash(id + 'z') - 0.5) * 1.4;
        g.push(this.tmp2, PAL.node, alpha * (0.55 + sparkle * 1.2), -(0.75 + sparkle), 0.9);
      }
      // utility agents get a small pink base ring (the "node where an arc lands")
      if (!cluster && alpha > 0.5)
        rings.push({ center: dir.clone().multiplyScalar(R + 0.5), radius: 1.5 + pulse, thickness: 0.16, alpha: alpha * 0.75, fill: 0.15, color: red > 0 ? PAL.red : PAL.nodePink });
      this.picks.push({ id, selectId: cluster ? (members?.[0] ?? null) : id, p: base.clone(), html: () => this.tipHtml(id, kind, name, v, f, cluster, members) });
    };

    // individual utility agents
    for (const a of this.slots) {
      const f = fr?.agents.get(a.id);
      const inShown = parts.has(a.id);
      let v: { req: number; grant: number; floor: number };
      if (f) v = { req: f.req, grant: f.grant, floor: f.floor };
      else {
        const st = s.agents[a.id];
        v = { req: st?.demandKW ?? 0, grant: st?.allocatedKW ?? 0, floor: st?.minSafeKW ?? 0 };
      }
      const alpha = focusMode ? (inShown ? 1 : 0.22) : ambient && inShown ? 0.95 : 0.7;
      pushAgent(a.id, a.dir, a.kind, a.name, v, f, alpha, false);
    }
    // household clusters: only when part of the shown replay
    for (const p of parts.values()) {
      if (this.dirOf.has(p.agentId)) continue;
      const dir = this.anchor(p.agentId, p.buildingIds);
      if (!dir) continue;
      for (const m of p.buildingIds) memberOfShown.add(m);
      const f = fr?.agents.get(p.agentId);
      let v: { req: number; grant: number; floor: number };
      if (f) v = { req: f.req, grant: f.grant, floor: f.floor };
      else {
        v = { req: 0, grant: 0, floor: 0 };
        for (const m of p.buildingIds) {
          const st = s.agents[m];
          if (!st) continue;
          v.req += st.demandKW;
          v.grant += st.allocatedKW;
          v.floor += st.minSafeKW;
        }
      }
      pushAgent(p.agentId, dir, p.kind, p.name, v, f, focusMode ? 0.9 : 0.75, true, p.buildingIds);
    }
    // houses: faint dots (members of shown clusters a bit brighter)
    for (const h of this.houses) {
      const k = memberOfShown.has(h.id) ? 0.55 : 0.22;
      this.tmp.copy(h.dir).multiplyScalar(R + 0.35);
      g.push(this.tmp, PAL.house, k, -0.95);
    }
    // commit burst: extra sparkles above the hub
    if (hub && sparkle > 0.01) {
      for (let i = 0; i < 40; i++) {
        const a = i * 2.399, rr = 2 + (i % 7) * 1.1;
        this.tmp.copy(hub.dir).multiplyScalar(R + HUB_ALT + 2 + (i % 5) * 1.3 + sparkle * 6);
        this.tmp.x += Math.cos(a) * rr;
        this.tmp.z += Math.sin(a) * rr;
        g.push(this.tmp, PAL.node, sparkle * 0.9, -1.1, 0.8);
      }
    }
    this.spikes.set(spikes);
    g.end();

    // ── arcs
    const arcSpecs: ArcSpec[] = [];
    if (fr && hub) {
      const hubPos = hub.dir.clone().multiplyScalar(R + HUB_ALT);
      const posOf = (ref: string): THREE.Vector3 | null => {
        if (ref === 'hub') return hubPos;
        const d = this.anchor(ref, parts.get(ref)?.buildingIds);
        return d ? d.clone().multiplyScalar(R + 0.3) : null;
      };
      // many arcs converge on the hub: keep the additive sum readable
      const count = new Map<ArcRole, number>();
      for (const a of fr.arcs) count.set(a.role, (count.get(a.role) ?? 0) + 1);
      const density = new Map<ArcRole, number>();
      for (const [k, n] of count) density.set(k, THREE.MathUtils.clamp(5 / Math.sqrt(n), 0.42, 1));
      for (const a of fr.arcs) {
        if (a.alpha <= 0.003) continue;
        const p0 = posOf(a.from), p1 = posOf(a.to);
        if (!p0 || !p1) continue;
        const ang = p0.angleTo(p1);
        const sty = this.arcStyle(a.role, a.kw, fr.maxGrant);
        arcSpecs.push({
          key: a.key,
          p0,
          p1,
          lift: a.role === 'contract' ? 4 + R * ang * 0.55 : 3 + R * ang * (a.role === 'notice' ? 0.3 : 0.45),
          color: sty.color,
          width: sty.width,
          head: a.head,
          tail: a.tail,
          alpha: a.alpha * sty.alpha * (density.get(a.role) ?? 1),
          dashes: sty.dashes,
        });
      }
      // the long straight beam through the hub
      arcSpecs.push({
        key: `beam:${r!.islandId}`,
        p0: hub.dir.clone().multiplyScalar(R + 0.2),
        p1: hub.dir.clone().multiplyScalar(R + HUB_ALT + 30),
        lift: 0,
        straight: true,
        color: PAL.beam,
        width: 0.7,
        head: 1,
        tail: 0,
        alpha: 0.55 * fr.hub.alpha * (1 + fr.hub.pulse * 0.8),
      });
    }
    this.arcs.set(arcSpecs);

    // ── rings + hub labels
    const hubsShown: HubView[] = [];
    const hubRings = (dir: THREE.Vector3, alpha: number, pulse: number) => {
      const c = dir.clone().multiplyScalar(R + HUB_ALT);
      rings.push({ center: c, radius: 3.6, thickness: 0.09, alpha: alpha * (0.9 + pulse * 0.8), fill: 0.12 + pulse * 0.3, color: PAL.hub });
      rings.push({ center: c, radius: 5.6, thickness: 0.05, alpha: alpha * 0.55, fill: 0, color: PAL.hub, dashes: 20, spin: this.reduced ? 0 : 0.03 });
      if (pulse > 0.01) rings.push({ center: c, radius: 3.6 + pulse * 5, thickness: 0.06, alpha: pulse * 0.7, fill: 0, color: PAL.notice });
      rings.push({ center: dir.clone().multiplyScalar(R + 0.45), radius: 2.2, thickness: 0.12, alpha: alpha * 0.45, fill: 0.2, color: PAL.hub });
    };
    if (r && hub && fr) {
      hubRings(hub.dir, fr.hub.alpha, fr.hub.pulse);
      if (fr.hub.noticeA > 0.01) {
        // a small circle of the sphere (lies on the surface): plane at R·cos(th), radius R·sin(th)
        const th = (4 + fr.hub.noticeR * hub.radius) / R;
        const rr = (R + 0.9) * Math.sin(th);
        rings.push({ center: hub.dir.clone().multiplyScalar((R + 0.9) * Math.cos(th)), radius: rr, thickness: 1.1 / rr, alpha: fr.hub.noticeA * 0.95, fill: 0, color: PAL.notice });
      }
      if (fr.hub.shield > 0.01) {
        const c = hub.dir.clone().multiplyScalar(R + HUB_ALT);
        rings.push({ center: c, radius: 7 + fr.hub.shield * 3, thickness: 0.08, alpha: fr.hub.shield, fill: 0.55 * fr.hub.shield, color: fr.hub.shieldOk ? PAL.shield : PAL.red });
        rings.push({ center: c, radius: 9.5 + fr.hub.shield * 4, thickness: 0.04, alpha: fr.hub.shield * 0.6, fill: 0, color: fr.hub.shieldOk ? PAL.shield : PAL.red, dashes: 12, spin: this.reduced ? 0 : -0.05 });
      }
      const short = r.deficitKW > 0.5;
      hubsShown.push({
        key: `r${r.islandId}`,
        dir: hub.dir,
        text: `Island ${r.islandId}${r.microgrid ? ' · microgrid' : ''} · <b>${short ? `${fmt(r.deficitKW)} short` : `${fmt(r.supplyKW)} available`}</b>`,
        ok: !short,
        alpha: fr.hub.alpha,
      });
    }
    if (!focusMode) {
      for (const h of this.liveHubs()) {
        if (r && h.id === r.islandId) continue;
        const info = s.islands?.find((i) => i.id === h.id);
        if (!info) continue;
        const def = Math.max(0, info.demandKW - info.supplyKW);
        hubRings(h.dir, 0.6, 0);
        hubsShown.push({
          key: `l${h.id}`,
          dir: h.dir,
          text: `Island ${h.id}${info.microgrid ? ' · microgrid' : ''} · <b>${def > 0.5 ? `${fmt(def)} short` : 'enough power'}</b>`,
          ok: def <= 0.5,
          alpha: 0.85,
        });
      }
    }
    this.rings.set(rings);
    this.syncLabels(hubsShown);
  }

  private arcStyle(role: ArcRole, kw: number, maxGrant: number): { color: THREE.Color; width: number; alpha: number; dashes?: number } {
    switch (role) {
      case 'bid':
        return { color: PAL.bid, width: 0.55 + 0.35 * Math.log10(1 + kw / 40), alpha: 1 };
      case 'notice':
        return { color: PAL.notice, width: 0.3, alpha: 0.6 };
      case 'concede':
        return { color: PAL.concede, width: 0.85 + 0.4 * Math.log10(1 + kw / 20), alpha: 1.4 };
      case 'contract':
        return { color: PAL.contract, width: 0.7, alpha: 1, dashes: 26 };
      case 'grant':
        return { color: PAL.grant, width: 0.32 + 1.15 * Math.sqrt(Math.min(1, kw / Math.max(1, maxGrant))), alpha: 1 };
    }
  }

  // ─────────────────────────── overlay: labels + tooltip ───────────────────────────

  private syncLabels(hubs: HubView[]): void {
    const seen = new Set<string>();
    const w = this.container.clientWidth, hh = this.container.clientHeight;
    const camDir = this.tmp3.copy(this.camera.position).normalize();
    for (const h of hubs) {
      seen.add(h.key);
      let el = this.labels.get(h.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'theater-label';
        this.overlay.appendChild(el);
        this.labels.set(h.key, el);
      }
      if (el.dataset.t !== h.text) {
        el.innerHTML = h.text;
        el.dataset.t = h.text;
      }
      el.classList.toggle('ok', h.ok);
      const facing = this.tmp2.copy(h.dir).applyQuaternion(this.globeGroup.quaternion).dot(camDir);
      this.tmp.copy(h.dir).multiplyScalar(R + HUB_ALT + 7).applyMatrix4(this.globeGroup.matrixWorld).project(this.camera);
      const x = (this.tmp.x * 0.5 + 0.5) * w, y = (-this.tmp.y * 0.5 + 0.5) * hh;
      const show = facing > 0.05 && this.tmp.z < 1;
      el.style.opacity = show ? String(Math.min(1, h.alpha * 1.2)) : '0';
      el.style.transform = `translate(${x.toFixed(1)}px, ${(y - 26).toFixed(1)}px) translate(-50%, -100%)`;
    }
    for (const [k, el] of this.labels)
      if (!seen.has(k)) {
        el.remove();
        this.labels.delete(k);
      }
  }

  private updateOverlay(): void {
    if (this.mouse && (this.tipTick++ & 3) === 0) this.setHover(this.pickAt(this.mouse.x, this.mouse.y));
    if (this.hover && this.mouse) {
      this.tip.innerHTML = this.hover.html();
      const w = this.container.clientWidth;
      const tw = this.tip.offsetWidth || 220, th = this.tip.offsetHeight || 120;
      let x = this.mouse.x + 16, y = this.mouse.y + 16;
      if (x + tw > w - 8) x = this.mouse.x - tw - 16;
      if (y + th > this.container.clientHeight - 8) y = this.mouse.y - th - 16;
      this.tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
    }
  }

  private pickAt(mx: number, my: number): Pick | null {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const cam = this.camera.position;
    let best: Pick | null = null;
    let bd = 18 * 18;
    for (const p of this.picks) {
      const wp = this.tmp.copy(p.p).applyMatrix4(this.globeGroup.matrixWorld);
      // skip points on the far side of the globe
      if (this.tmp2.copy(wp).normalize().dot(this.tmp3.copy(cam).sub(wp)) <= 0) continue;
      wp.project(this.camera);
      const dx = (wp.x * 0.5 + 0.5) * w - mx, dy = (-wp.y * 0.5 + 0.5) * h - my;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  private setHover(p: Pick | null): void {
    if (p?.id === this.hover?.id) {
      this.hover = p;
      return;
    }
    this.hover = p;
    this.tip.style.display = p ? 'block' : 'none';
    this.canvas.style.cursor = p ? 'pointer' : '';
  }

  private tipHtml(id: string, kind: ConsumerKind, name: string, v: { req: number; grant: number; floor: number }, f: FrameAgent | undefined, cluster: boolean, members?: string[]): string {
    const dos = this.snap?.negotiation?.agents[id];
    const stance = f?.stance ?? dos?.current?.brief.stance;
    const st = stance ? STANCE[stance] : null;
    const sub = cluster ? `${members?.length ?? 0} homes bidding together` : KIND_LABEL[kind];
    const rows = [
      ['Request', fmt(v.req)],
      ['Floor (min safe)', fmt(v.floor)],
      ['Grant', `${fmt(v.grant)}${v.req > 0 ? ` · ${Math.round((100 * v.grant) / v.req)}%` : ''}`],
    ];
    const per = f?.bid?.perception;
    if (per) rows.push(['Model urgency', `${per.urgency.toFixed(2)} (${per.source === 'jev' ? 'Jev' : 'heuristic'})`]);
    let html = `<h4>${esc(name)}</h4><div class="sub">${esc(sub)}</div>`;
    html += rows.map(([k, x]) => `<div class="row"><span>${k}</span><span>${x}</span></div>`).join('');
    if (st) html += `<span class="chip" style="color:${st.color}">${st.label}</span>`;
    if (f?.corrected) html += `<div class="note">Safety: ${fmt(f.corrected.proposedKW)} → ${fmt(f.corrected.finalKW)} — ${esc(f.corrected.reason)}</div>`;
    return html;
  }

  // ─────────────────────────── pointer ───────────────────────────

  private local(e: PointerEvent): { x: number; y: number } {
    const b = this.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }
  private onMove = (e: PointerEvent): void => {
    this.mouse = this.local(e);
    if (!this.downAt) this.setHover(this.pickAt(this.mouse.x, this.mouse.y));
  };
  private onLeave = (): void => {
    this.mouse = null;
    this.setHover(null);
  };
  private onDown = (e: PointerEvent): void => {
    this.downAt = this.local(e);
  };
  private onUp = (e: PointerEvent): void => {
    const d = this.downAt;
    this.downAt = null;
    if (!d) return;
    const p = this.local(e);
    if (Math.hypot(p.x - d.x, p.y - d.y) > 5) return;
    const hit = this.pickAt(p.x, p.y);
    this.emit('select', hit ? hit.selectId : null);
  };
}
