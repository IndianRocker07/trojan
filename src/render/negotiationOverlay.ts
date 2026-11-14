import * as THREE from 'three';
import type { NegotiationReplay, RoundBid } from '../core/types';

/**
 * City overlay for the negotiation replay (docs/STORY.md §3).
 *
 * Everything is drawn by ONE shader material across three instanced ribbon meshes (3 draw calls):
 *   arcs   — bezier ribbons agent ↔ hub (style 0 solid, 1 dashed), draw-on driven by `uProgress`
 *   spikes — straight vertical bars at each participant (style 2), outer = request, inner = grant
 *   rings  — closed circles (style 3): hub glow, notice expansion, safety shield and pulses
 * Ribbons are billboarded in the vertex shader with a minimum on-screen width, so thin arcs stay
 * visible at city zoom. Output is premultiplied so the glow adds on the night sky and tints the
 * day background (normal blending, not pure additive: additive vanishes on the cream day scene).
 *
 * Buffers are allocated once; per-frame work only writes preallocated typed arrays. Stage layout is
 * rebuilt only when (replay, stage) changes; progress updates touch one uniform plus the spike and
 * ring instances (≤ 152 small writes).
 */

const PINK = new THREE.Color(0xff6ad5);
const VIOLET = new THREE.Color(0xb37bff);
const GOLD = new THREE.Color(0xffc94a);
const BLUE = new THREE.Color(0x3aa0ff);
const RED = new THREE.Color(0xff5a5a);
const ICE = new THREE.Color(0xe6f6ff);

/** Building anchor data the overlay needs (BuildingInfo from batch.ts satisfies it). */
export interface OverlayBuilding {
  readonly cx: number;
  readonly cz: number;
  readonly height: number;
}

const MAX_ARCS = 120;
const MAX_PARTS = 60; // two spike bars per participant → 120 bars
const MAX_RINGS = 32;
const SEG = 56; // ribbon segments per curve / ring
const HUB_Y = 60; // hub altitude (m)
const ANCHOR_UP = 6; // arc anchor above the building roof (m)
const ARC_W = 0.9; // core width (m); widened on screen by uMinPx
const SPIKE_W = 3.0;
const LIVE_DRAW_S = 2.0;
const LIVE_HOLD_S = 0.4;
const LIVE_FADE_S = 0.8;

const STYLE = { arc: 0, dash: 1, spike: 2, ring: 3 } as const;

const VERT = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aP1;
attribute vec3 aP2;
attribute vec4 aCol;
attribute vec4 aPar; // x core width (m), y static flag, z style, w dash phase
uniform float uProgress;
uniform float uPxToWorld;
uniform float uMinPx;
varying vec4 vCol;
varying float vS;
varying float vT;
varying float vPr;
varying float vStyle;
varying float vPhase;
void main() {
  float t = position.x;
  vec3 p;
  vec3 tanv;
  if (aPar.z > 2.5) {
    // ring: centre + axis1 cos + axis2 sin
    float th = t * 6.2831853;
    p = aP0 + aP1 * cos(th) + aP2 * sin(th);
    tanv = aP1 * (-sin(th)) + aP2 * cos(th);
  } else {
    // quadratic bezier P0 → P1 (control) → P2
    vec3 a = mix(aP0, aP1, t);
    vec3 b = mix(aP1, aP2, t);
    p = mix(a, b, t);
    tanv = (1.0 - t) * (aP1 - aP0) + t * (aP2 - aP1);
  }
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  vec3 sd = cross(tanv, toCam);
  float sl = length(sd);
  sd = sl > 1e-6 ? sd / sl : vec3(0.0, 1.0, 0.0);
  float hw = max(aPar.x, dist * uPxToWorld * uMinPx) * 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(p + sd * position.y * hw * 3.0, 1.0);
  vCol = aCol;
  vS = position.y;
  vT = t;
  vPr = aPar.y > 0.5 ? 1.0 : uProgress;
  vStyle = aPar.z;
  vPhase = aPar.w;
}
`;

const FRAG = /* glsl */ `
uniform float uFade;
uniform float uHead;
varying vec4 vCol;
varying float vS;
varying float vT;
varying float vPr;
varying float vStyle;
varying float vPhase;
void main() {
  float a = abs(vS);
  float core = 1.0 - smoothstep(0.2, 0.34, a);
  float glow = pow(max(0.0, 1.0 - a), 2.2) * 0.35;
  float prof = core + glow;
  float draw = vPr > 0.999 ? 1.0 : 1.0 - smoothstep(vPr - 0.004, vPr + 0.004, vT);
  float head = (vPr > 0.001 && vPr < 0.999) ? uHead * exp(-pow((vT - vPr) / 0.03, 2.0)) : 0.0;
  float isDash = step(0.5, vStyle) * (1.0 - step(1.5, vStyle));
  float isSpike = step(1.5, vStyle) * (1.0 - step(2.5, vStyle));
  float dash = mix(1.0, step(0.45, fract(vT * 14.0 + vPhase)), isDash);
  float tip = isSpike * smoothstep(0.55, 1.0, vT);
  vec3 col = mix(vCol.rgb, vec3(1.0), core * 0.45 + tip * 0.6);
  float alpha = clamp((prof * draw * dash + core * head * 1.2) * vCol.a * uFade, 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha); // premultiplied
  #include <colorspace_fragment>
}
`;

/** Ribbon base strip: position.x = u along the curve (0..1), position.y = side (-1 / +1). */
function makeBase(): THREE.BufferGeometry {
  const n = SEG + 1;
  const pos = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < 2; s++) {
      const k = (i * 2 + s) * 3;
      pos[k] = i / SEG;
      pos[k + 1] = s === 0 ? -1 : 1;
      pos[k + 2] = 0;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

interface V3 {
  x: number;
  y: number;
  z: number;
}
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const setV = (v: V3, x: number, y: number, z: number): V3 => {
  v.x = x;
  v.y = y;
  v.z = z;
  return v;
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Bar height (m) for a request in kW: log-scaled so 10 kW and 2 MW both read. */
const spikeHeight = (req: number) => Math.min(45, 4 + 9 * Math.log10(1 + req / 10));

interface Part {
  id: string;
  x: number;
  z: number;
  roof: number;
  req: number;
  hasReq: boolean;
  prevG: number;
  curG: number;
  corrected: boolean;
}

/** One pooled instanced ribbon mesh (all instance attributes preallocated). */
class Bars {
  readonly mesh: THREE.Mesh;
  n = 0;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly aP0: Float32Array;
  private readonly aP1: Float32Array;
  private readonly aP2: Float32Array;
  private readonly aCol: Float32Array;
  private readonly aPar: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[] = [];

  constructor(base: THREE.BufferGeometry, readonly cap: number, mat: THREE.ShaderMaterial) {
    this.geo.setIndex(base.getIndex());
    this.geo.setAttribute('position', base.getAttribute('position'));
    const mk = (name: string, size: number): Float32Array => {
      const arr = new Float32Array(cap * size);
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, a);
      this.attrs.push(a);
      return arr;
    };
    this.aP0 = mk('aP0', 3);
    this.aP1 = mk('aP1', 3);
    this.aP2 = mk('aP2', 3);
    this.aCol = mk('aCol', 4);
    this.aPar = mk('aPar', 4);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.raycast = () => {};
    this.mesh.visible = false;
  }

  /** Write instance i: quadratic curve a → c (control) → b, or ring/spike parameters (see shader). */
  set(i: number, a: V3, c: V3, b: V3, col: THREE.Color, alpha: number, width: number, style: number, stat: boolean, phase: number): void {
    const o3 = i * 3;
    const o4 = i * 4;
    this.aP0[o3] = a.x;
    this.aP0[o3 + 1] = a.y;
    this.aP0[o3 + 2] = a.z;
    this.aP1[o3] = c.x;
    this.aP1[o3 + 1] = c.y;
    this.aP1[o3 + 2] = c.z;
    this.aP2[o3] = b.x;
    this.aP2[o3 + 1] = b.y;
    this.aP2[o3 + 2] = b.z;
    this.aCol[o4] = col.r;
    this.aCol[o4 + 1] = col.g;
    this.aCol[o4 + 2] = col.b;
    this.aCol[o4 + 3] = alpha;
    this.aPar[o4] = width;
    this.aPar[o4 + 1] = stat ? 1 : 0;
    this.aPar[o4 + 2] = style;
    this.aPar[o4 + 3] = phase;
  }

  /** Append (layout time only). Returns false when full. */
  push(a: V3, c: V3, b: V3, col: THREE.Color, alpha: number, width: number, style: number, stat: boolean, phase: number): boolean {
    if (this.n >= this.cap) return false;
    this.set(this.n++, a, c, b, col, alpha, width, style, stat, phase);
    return true;
  }

  clear(): void {
    this.n = 0;
    this.commit();
  }

  /** Push the written instances to the GPU and set the instance count. */
  commit(): void {
    for (const a of this.attrs) a.needsUpdate = true;
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
  }

  dispose(): void {
    this.geo.dispose();
  }
}

export class NegotiationOverlay {
  readonly group = new THREE.Group();
  private readonly base: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly arcs: Bars;
  private readonly spikes: Bars;
  private readonly rings: Bars;
  private readonly reduced: boolean;

  private info: ReadonlyMap<string, OverlayBuilding> = new Map();
  /** undefined until the first sync; then the id of the newest replay seen. */
  private lastSeen: string | null | undefined = undefined;
  private selected = false;
  private live: { t: number } | null = null;

  // current layout
  private rep: NegotiationReplay | null = null;
  private idx = -1;
  private liveLayout = false;
  private parts: Part[] = [];
  private byId = new Map<string, Part>();
  private hub: { x: number; z: number } | null = null;
  private progress = 0;

  // scratch (no per-frame allocation)
  private readonly sa = v3(0, 0, 0);
  private readonly sb = v3(0, 0, 0);
  private readonly sc = v3(0, 0, 0);

  constructor() {
    this.reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.base = makeBase();
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uProgress: { value: 1 },
        uFade: { value: 1 },
        uHead: { value: this.reduced ? 0 : 1 },
        uPxToWorld: { value: 0.002 },
        uMinPx: { value: 2.2 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
    });
    this.arcs = new Bars(this.base, MAX_ARCS, this.mat);
    this.spikes = new Bars(this.base, 2 * MAX_PARTS, this.mat);
    this.rings = new Bars(this.base, MAX_RINGS, this.mat);
    this.group.add(this.arcs.mesh, this.spikes.mesh, this.rings.mesh);
  }

  // ─────────────────────────── public API ───────────────────────────

  /** Building anchors for the current build (BuildingInfo map). Re-lays out the current replay. */
  setBuildings(info: ReadonlyMap<string, OverlayBuilding>): void {
    this.info = info;
    if (this.rep) {
      this.layout(this.rep, this.idx, this.liveLayout);
      if (!this.liveLayout) this.setProgress(this.progress);
    }
  }

  /** Pixel → world scale for the minimum ribbon width. */
  setViewport(heightPx: number, fovDeg: number): void {
    this.mat.uniforms.uPxToWorld.value = (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)) / Math.max(1, heightPx);
  }

  /** replay null = no replay selected (live mode). */
  showReplay(rep: NegotiationReplay | null, stageIndex: number, progress: number): void {
    this.selected = rep !== null;
    if (!rep || rep.stages.length === 0) {
      if (this.rep && !this.live) this.clearAll();
      return;
    }
    this.live = null;
    this.mat.uniforms.uFade.value = 1;
    const idx = Math.max(0, Math.min(rep.stages.length - 1, stageIndex));
    if (rep !== this.rep || idx !== this.idx || this.liveLayout) this.layout(rep, idx, false);
    this.setProgress(clamp01(progress));
  }

  /** Per tick: detect a new newest replay and, when none is selected, play its final grants once. */
  sync(s: { negotiation?: { replays?: NegotiationReplay[] } }): void {
    const reps = s.negotiation?.replays;
    const last = reps && reps.length ? reps[reps.length - 1] : null;
    const id = last ? last.id : null;
    if (this.lastSeen === undefined) {
      this.lastSeen = id;
      return;
    }
    if (id === this.lastSeen) return;
    this.lastSeen = id;
    if (last && !this.selected) this.startLive(last);
  }

  /** Per frame: advances the live playback clock (no-op otherwise). */
  update(dt: number): void {
    if (!this.live) return;
    this.live.t += dt;
    const t = this.live.t;
    const fadeStart = LIVE_DRAW_S + LIVE_HOLD_S;
    const fade = t < fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / LIVE_FADE_S);
    this.mat.uniforms.uProgress.value = this.reduced ? 1 : Math.min(1, t / LIVE_DRAW_S);
    this.mat.uniforms.uFade.value = fade;
    if (fade <= 0) this.endLive();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.arcs.dispose();
    this.spikes.dispose();
    this.rings.dispose();
    this.base.dispose();
    this.mat.dispose();
  }

  // ─────────────────────────── internals ───────────────────────────

  private startLive(rep: NegotiationReplay): void {
    let fi = -1;
    for (let k = 0; k < rep.stages.length; k++) if (rep.stages[k].kind === 'final') fi = k;
    if (fi < 0) for (let k = 0; k < rep.stages.length; k++) if (rep.stages[k].kind === 'commit') fi = k;
    if (fi < 0) fi = rep.stages.length - 1;
    if (fi < 0) return;
    this.live = { t: 0 };
    this.layout(rep, fi, true);
    this.mat.uniforms.uProgress.value = this.reduced ? 1 : 0;
    this.mat.uniforms.uFade.value = 1;
  }

  private endLive(): void {
    this.live = null;
    this.mat.uniforms.uFade.value = 1;
    this.clearAll();
  }

  private clearAll(): void {
    this.arcs.clear();
    this.spikes.clear();
    this.rings.clear();
    this.rep = null;
    this.idx = -1;
    this.liveLayout = false;
    this.parts = [];
    this.byId.clear();
    this.hub = null;
  }

  /** Arc / spike / ring instances for one stage. Progress-independent except the arc uniform. */
  private layout(rep: NegotiationReplay, idx: number, live: boolean): void {
    this.arcs.clear();
    this.spikes.clear();
    this.rings.clear();
    this.parts = [];
    this.byId.clear();
    this.hub = null;
    this.rep = rep;
    this.idx = idx;
    this.liveLayout = live;
    const stages = rep.stages;
    const st = stages[idx];
    if (!st) return;

    // anchors: building centre (cluster → centroid of members) at mean roof height
    let sx = 0;
    let sz = 0;
    for (const pr of rep.participants) {
      if (this.parts.length >= MAX_PARTS) break;
      if (this.byId.has(pr.agentId)) continue;
      let x = 0;
      let z = 0;
      let h = 0;
      let k = 0;
      for (const bid of pr.buildingIds) {
        const b = this.info.get(bid);
        if (!b) continue;
        x += b.cx;
        z += b.cz;
        h += b.height;
        k++;
      }
      if (!k) continue;
      const p: Part = { id: pr.agentId, x: x / k, z: z / k, roof: h / k, req: 0, hasReq: false, prevG: 0, curG: 0, corrected: false };
      this.parts.push(p);
      this.byId.set(p.id, p);
      sx += p.x;
      sz += p.z;
    }
    if (!this.parts.length) return;
    const hub = { x: sx / this.parts.length, z: sz / this.parts.length };
    this.hub = hub;

    // requests: latest bid at or before this stage, else the first one that follows
    const bidNow = new Map<string, RoundBid>();
    for (let k = 0; k <= idx; k++) for (const b of stages[k].bids ?? []) bidNow.set(b.agentId, b);
    for (let k = idx + 1; k < stages.length; k++) for (const b of stages[k].bids ?? []) if (!bidNow.has(b.agentId)) bidNow.set(b.agentId, b);
    // grants: last value before this stage (prev) and at this stage (cur)
    const gPrev = new Map<string, number>();
    for (let k = 0; k < idx; k++) for (const [id, kw] of Object.entries(stages[k].grants ?? {})) gPrev.set(id, kw);
    const gCur = new Map(gPrev);
    for (const [id, kw] of Object.entries(st.grants ?? {})) gCur.set(id, kw);
    let maxG = 0;
    for (const p of this.parts) {
      const b = bidNow.get(p.id);
      p.hasReq = !!b;
      p.req = b?.requestKW ?? 0;
      p.prevG = gPrev.get(p.id) ?? 0;
      p.curG = gCur.get(p.id) ?? 0;
      maxG = Math.max(maxG, p.curG);
    }
    for (const c of st.corrections ?? []) {
      const p = this.byId.get(c.agentId);
      if (p) p.corrected = true;
    }

    const H = v3(hub.x, HUB_Y, hub.z);
    const at = (p: Part) => v3(p.x, p.roof + ANCHOR_UP, p.z);
    const arc = (a: V3, b: V3, col: THREE.Color, alpha: number, width: number, style: number, stat: boolean, phase: number) => {
      const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const c = v3((a.x + b.x) / 2, (a.y + b.y) / 2 + 10 + 0.3 * d, (a.z + b.z) / 2);
      this.arcs.push(a, c, b, col, alpha, width, style, stat, phase);
    };
    const toHub = (p: Part, col: THREE.Color, alpha: number, width: number, stat: boolean) => arc(at(p), H, col, alpha, width, STYLE.arc, stat, 0);
    const fromHub = (p: Part, col: THREE.Color, alpha: number, width: number, stat: boolean) => arc(H, at(p), col, alpha, width, STYLE.arc, stat, 0);
    const grantWidth = (kw: number) => 0.6 + 1.6 * (kw / (maxG || 1));

    switch (st.kind) {
      case 'bid':
        for (const b of st.bids ?? []) {
          const p = this.byId.get(b.agentId);
          if (p) toHub(p, PINK, 1, ARC_W, false);
        }
        break;
      case 'clear':
        // provisional clearing: the round-1 bids stay as faint context
        for (const p of this.parts) if (p.hasReq) toHub(p, PINK, 0.3, ARC_W, true);
        break;
      case 'notice':
        for (const n of st.notices ?? []) {
          const p = this.byId.get(n.agentId);
          if (p) fromHub(p, PINK, 0.75, 0.7, false);
        }
        break;
      case 'counter':
        for (const c of st.concessions ?? []) {
          const p = this.byId.get(c.agentId);
          if (p) toHub(p, VIOLET, 1, 0.9, false);
        }
        break;
      case 'contract': {
        let k = 0;
        for (const c of st.contracts ?? []) {
          const g = this.byId.get(c.giverId);
          const r = this.byId.get(c.receiverId);
          if (g && r) arc(at(g), at(r), GOLD, 1, 1.0, STYLE.dash, false, (k++ * 0.37) % 1);
        }
        break;
      }
      case 'final':
      case 'commit':
        for (const p of this.parts) if (p.curG > 0.5) fromHub(p, PINK, 1, grantWidth(p.curG), false);
        break;
      case 'safety':
        // final grants stay as a faint ghost; corrected agents get red pulses (setProgress)
        for (const p of this.parts) if (p.curG > 0.5) fromHub(p, PINK, 0.35, grantWidth(p.curG), true);
        break;
      default:
        break; // perceive: spikes and hub only
    }
    this.arcs.commit();
  }

  /** Spikes, rings and the arc draw-on for the current stage. Cheap; called every stepper frame. */
  private setProgress(p: number): void {
    const rep = this.rep;
    const hub = this.hub;
    if (!rep || !hub || this.liveLayout) return;
    const st = rep.stages[this.idx];
    if (!st) return;
    this.progress = p;
    const pr = this.reduced ? 1 : p;
    this.mat.uniforms.uProgress.value = pr;
    this.mat.uniforms.uHead.value = this.reduced ? 0 : 1;

    // spikes: outer height ∝ log(request); inner ∝ grant share, easing from the previous grant over the stage
    // (reduced motion: jump straight to the stage's grant)
    const { sa, sb, sc } = this;
    let k = 0;
    for (const q of this.parts) {
      if (!q.hasReq || k >= MAX_PARTS) continue;
      const H = spikeHeight(q.req);
      const g = this.reduced ? q.curG : q.prevG + (q.curG - q.prevG) * p;
      const frac = q.req > 0 ? clamp01(g / q.req) : 0;
      setV(sa, q.x, q.roof, q.z);
      setV(sc, q.x, q.roof + H, q.z);
      setV(sb, q.x, q.roof + H / 2, q.z);
      this.spikes.set(2 * k, sa, sb, sc, BLUE, 0.9, SPIKE_W, STYLE.spike, true, 0);
      const innerTop = q.roof + H * frac;
      setV(sc, q.x, innerTop, q.z);
      setV(sb, q.x, q.roof + (H * frac) / 2, q.z);
      this.spikes.set(2 * k + 1, sa, sb, sc, q.corrected ? RED : ICE, frac > 0.01 ? 1 : 0, SPIKE_W * 0.6, STYLE.spike, true, 0);
      k++;
    }
    this.spikes.n = 2 * k;
    this.spikes.commit();

    // rings: hub glow, stage-specific expansion, safety pulses
    let r = 0;
    const ring = (cx: number, cy: number, cz: number, rad: number, col: THREE.Color, alpha: number, width: number) => {
      if (r >= MAX_RINGS) return;
      this.rings.set(r++, setV(sa, cx, cy, cz), setV(sb, rad, 0, 0), setV(sc, 0, 0, rad), col, alpha, width, STYLE.ring, true, 0);
    };
    ring(hub.x, HUB_Y, hub.z, 22, BLUE, 0.95, 1.3);
    ring(hub.x, HUB_Y, hub.z, 36, BLUE, 0.35, 3.2);
    const sweep = this.reduced ? 0.5 : p;
    if (st.kind === 'notice') ring(hub.x, HUB_Y, hub.z, 6 + 44 * sweep, PINK, 0.9 * (1 - sweep) + 0.1, 1.2);
    if (st.kind === 'safety') ring(hub.x, HUB_Y, hub.z, 18, RED, 0.25 + 0.75 * Math.sin(Math.PI * sweep), 1.2);
    for (const q of this.parts) {
      if (!q.corrected) continue;
      const amp = this.reduced ? 0.9 : Math.sin(Math.PI * p);
      ring(q.x, q.roof + ANCHOR_UP, q.z, this.reduced ? 8 : 3 + 9 * p, RED, 0.2 + 0.8 * amp, 0.9);
    }
    this.rings.n = r;
    this.rings.commit();
  }

  /** Test hook / debug: current draw-call-relevant counts. */
  get stats(): { arcs: number; spikes: number; rings: number } {
    return { arcs: this.arcs.n, spikes: this.spikes.n, rings: this.rings.n };
  }
}
