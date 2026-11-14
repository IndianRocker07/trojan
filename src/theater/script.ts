/**
 * Stage semantics (docs/STORY.md §2), purely a function of (replay, stageIndex, progress) so that stepping
 * back/forward is deterministic. Produces a geometry-free description that TheaterView turns into marks.
 */
import type { NegotiationReplay, RoundBid, Stance } from '../core/types';

export type ArcRole = 'bid' | 'notice' | 'concede' | 'contract' | 'grant';

export interface FrameArc {
  key: string;
  role: ArcRole;
  from: string; // agent id or 'hub'
  to: string;
  kw: number;
  head: number;
  tail: number;
  alpha: number;
}
export interface FrameAgent {
  id: string;
  req: number;
  grant: number;
  floor: number;
  grow: number; // 0..1 spike growth (perceive)
  red: number; // safety correction tint
  pulse: number; // node pulse
  stance?: Stance;
  bid?: RoundBid;
  corrected?: { proposedKW: number; finalKW: number; reason: string };
}
export interface FrameHub {
  alpha: number;
  pulse: number;
  noticeR: number; // 0..1 expanding shortfall ring
  noticeA: number;
  shield: number;
  shieldOk: boolean; // approval (no corrections) vs corrections
}
export interface Frame {
  agents: Map<string, FrameAgent>;
  arcs: FrameArc[];
  hub: FrameHub;
  sparkle: number;
  maxGrant: number;
}

interface StageState {
  reqB: Map<string, number>;
  reqA: Map<string, number>;
  grB: Map<string, number>;
  grA: Map<string, number>;
  bids: Map<string, RoundBid>;
  floor: Map<string, number>;
}
interface Derived {
  ids: string[];
  stages: StageState[];
  perceiveIdx: number;
  maxGrant: number;
}

const cache = new WeakMap<NegotiationReplay, Derived>();
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function derive(r: NegotiationReplay): Derived {
  const hit = cache.get(r);
  if (hit) return hit;
  const req = new Map<string, number>();
  const gr = new Map<string, number>();
  const bids = new Map<string, RoundBid>();
  const floor = new Map<string, number>();
  const first = r.stages.find((s) => s.bids && s.bids.length);
  for (const b of first?.bids ?? []) {
    req.set(b.agentId, b.originalRequestKW || b.requestKW);
    floor.set(b.agentId, b.minSafeKW);
    bids.set(b.agentId, b);
  }
  const stages: StageState[] = [];
  let maxGrant = 1;
  for (const s of r.stages) {
    const reqB = new Map(req);
    const grB = new Map(gr);
    if (s.bids)
      for (const b of s.bids) {
        req.set(b.agentId, s.kind === 'perceive' ? b.originalRequestKW || b.requestKW : b.requestKW);
        floor.set(b.agentId, b.minSafeKW);
        bids.set(b.agentId, b);
      }
    if (s.kind === 'counter' && s.concessions && !s.bids)
      for (const c of s.concessions) req.set(c.agentId, Math.max(0, (req.get(c.agentId) ?? 0) - c.kw));
    if (s.grants) for (const [id, kw] of Object.entries(s.grants)) gr.set(id, kw);
    if (s.corrections) for (const c of s.corrections) gr.set(c.agentId, c.finalKW);
    for (const v of gr.values()) maxGrant = Math.max(maxGrant, v);
    stages.push({ reqB, reqA: new Map(req), grB, grA: new Map(gr), bids: new Map(bids), floor: new Map(floor) });
  }
  const d: Derived = { ids: r.participants.map((p) => p.agentId), stages, perceiveIdx: r.stages.findIndex((s) => s.kind === 'perceive'), maxGrant };
  cache.set(r, d);
  return d;
}

/** j-th of n staggered draw-on heads for stage progress P. */
const stag = (j: number, n: number, P: number, reduced: boolean, spread = 0.45) =>
  reduced ? 1 : ease((P - (n > 1 ? j / (n - 1) : 0) * spread) / (1 - spread));

function emptyHub(): FrameHub {
  return { alpha: 1, pulse: 0, noticeR: 0, noticeA: 0, shield: 0, shieldOk: true };
}

/** Grants (hub → agent) for the latest stage that has them, ordered by kW desc. */
function grantArcs(S: StageState, head: number, alpha: number, out: FrameArc[]): void {
  const list = [...S.grA.entries()].filter(([, kw]) => kw > 0.5).sort((a, b) => b[1] - a[1]);
  for (const [id, kw] of list) out.push({ key: `grant:${id}`, role: 'grant', from: 'hub', to: id, kw, head, tail: 0, alpha });
}

export function stageFrame(r: NegotiationReplay, stageIndex: number, progress: number, reduced: boolean): Frame {
  const D = derive(r);
  const si = Math.max(0, Math.min(r.stages.length - 1, stageIndex | 0));
  const st = r.stages[si];
  const S = D.stages[si];
  const P = reduced ? 1 : clamp01(progress);
  const e = ease(P);
  const hub = emptyHub();
  const arcs: FrameArc[] = [];
  let sparkle = 0;

  const corrected = new Map((st.corrections ?? []).map((c) => [c.agentId, c]));
  const agents = new Map<string, FrameAgent>();
  for (const id of D.ids) {
    const rb = S.reqB.get(id) ?? S.reqA.get(id) ?? 0;
    const ra = S.reqA.get(id) ?? rb;
    const gb = S.grB.get(id) ?? 0;
    const ga = S.grA.get(id) ?? gb;
    let grant = lerp(gb, ga, e);
    if (st.kind === 'clear' && st.phase1) {
      const p1 = Math.min(st.phase1[id] ?? 0, ga);
      grant = P < 0.5 ? lerp(gb, p1, ease(P * 2)) : lerp(p1, ga, ease(P * 2 - 1));
    }
    const bid = S.bids.get(id);
    const grow = D.perceiveIdx >= 0 && si < D.perceiveIdx ? 0 : st.kind === 'perceive' ? e : 1;
    const c = corrected.get(id);
    agents.set(id, {
      id,
      req: lerp(rb, ra, e),
      grant,
      floor: S.floor.get(id) ?? 0,
      grow,
      red: c ? (reduced ? 0.6 : 0.25 + 0.75 * Math.sin(Math.PI * P)) : 0,
      pulse: st.kind === 'perceive' && bid?.perception ? (reduced ? 0.5 : Math.sin(Math.PI * P)) : 0,
      stance: bid?.stance,
      bid,
      corrected: c ? { proposedKW: c.proposedKW, finalKW: c.finalKW, reason: c.reason } : undefined,
    });
  }

  switch (st.kind) {
    case 'perceive':
      hub.alpha = e;
      break;
    case 'bid': {
      const list = (st.bids ?? []).slice().sort((a, b) => b.score - a.score);
      list.forEach((b, j) => arcs.push({ key: `bid:${b.agentId}`, role: 'bid', from: b.agentId, to: 'hub', kw: b.requestKW, head: stag(j, list.length, P, reduced), tail: 0, alpha: 1 }));
      hub.pulse = reduced ? 0 : ease((P - 0.55) / 0.45) * (1 - ease((P - 0.85) / 0.15)) * 0.8;
      break;
    }
    case 'clear': {
      const prev = r.stages.slice(0, si).reverse().find((s) => s.kind === 'bid');
      for (const b of prev?.bids ?? []) arcs.push({ key: `bid:${b.agentId}`, role: 'bid', from: b.agentId, to: 'hub', kw: b.requestKW, head: 1, tail: 0, alpha: lerp(0.75, 0.1, e) });
      hub.pulse = reduced ? 0.6 : Math.sin(Math.PI * P);
      break;
    }
    case 'notice': {
      const ns = (st.notices ?? []).slice().sort((a, b) => a.projectedKW / Math.max(1, a.requestKW) - b.projectedKW / Math.max(1, b.requestKW));
      ns.forEach((n, j) => arcs.push({ key: `notice:${n.agentId}`, role: 'notice', from: 'hub', to: n.agentId, kw: n.projectedKW, head: stag(j, ns.length, P, reduced, 0.3), tail: 0, alpha: 0.85 }));
      hub.noticeR = reduced ? 0.7 : ease(P);
      hub.noticeA = reduced ? 0.5 : 1 - P * P;
      hub.pulse = reduced ? 0 : Math.max(0, 1 - P * 3);
      break;
    }
    case 'counter': {
      const cs = (st.concessions ?? []).slice().sort((a, b) => b.kw - a.kw);
      cs.forEach((c, j) => arcs.push({ key: `concede:${c.agentId}`, role: 'concede', from: c.agentId, to: 'hub', kw: c.kw, head: stag(j, cs.length, P, reduced), tail: 0, alpha: 1 }));
      break;
    }
    case 'contract': {
      const ks = st.contracts ?? [];
      ks.forEach((k, j) => arcs.push({ key: `contract:${k.id}`, role: 'contract', from: k.giverId, to: k.receiverId, kw: k.nowKW, head: stag(j, ks.length, P, reduced, 0.3), tail: 0, alpha: 1 }));
      break;
    }
    case 'final': {
      const list = [...S.grA.entries()].filter(([, kw]) => kw > 0.5).sort((a, b) => b[1] - a[1]);
      list.forEach(([id, kw], j) => arcs.push({ key: `grant:${id}`, role: 'grant', from: 'hub', to: id, kw, head: stag(j, list.length, P, reduced), tail: 0, alpha: 1 }));
      hub.pulse = reduced ? 0 : Math.max(0, 1 - P * 2.5);
      break;
    }
    case 'safety': {
      grantArcs(S, 1, 0.3, arcs);
      hub.shield = reduced ? 0.7 : Math.sin(Math.PI * Math.min(1, P * 1.15));
      hub.shieldOk = !(st.corrections && st.corrections.length);
      break;
    }
    case 'commit': {
      grantArcs(S, 1, lerp(1, 0.5, e), arcs);
      sparkle = reduced ? 0.4 : Math.sin(Math.PI * P);
      hub.pulse = sparkle * 0.5;
      break;
    }
  }
  return { agents, arcs, hub, sparkle, maxGrant: D.maxGrant };
}

/**
 * Ambient (live) loop over a replay: bids fly in, then grants fly out, then fade. `a` = cycle phase 0..1.
 * Spikes are not driven here (they follow the live snapshot).
 */
export function ambientFrame(r: NegotiationReplay, a: number, reduced: boolean): Frame {
  const D = derive(r);
  const hub = emptyHub();
  const arcs: FrameArc[] = [];
  const last = D.stages[D.stages.length - 1];
  const bidStage = r.stages.find((s) => s.kind === 'bid') ?? r.stages.find((s) => s.bids?.length);
  const bids = (bidStage?.bids ?? []).slice().sort((x, y) => y.score - x.score);
  if (reduced) {
    grantArcs(last, 1, 0.55, arcs);
    return { agents: new Map(), arcs, hub, sparkle: 0, maxGrant: D.maxGrant };
  }
  if (a < 0.42) {
    const P = clamp01(a / 0.3);
    const fade = 1 - ease((a - 0.3) / 0.12);
    bids.forEach((b, j) => arcs.push({ key: `bid:${b.agentId}`, role: 'bid', from: b.agentId, to: 'hub', kw: b.requestKW, head: stag(j, bids.length, P, false, 0.5), tail: 0, alpha: 0.9 * fade }));
    hub.pulse = ease((a - 0.25) / 0.1) * (1 - ease((a - 0.36) / 0.08));
  } else {
    const P = clamp01((a - 0.42) / 0.34);
    const fade = 1 - ease((a - 0.8) / 0.2);
    const list = [...last.grA.entries()].filter(([, kw]) => kw > 0.5).sort((x, y) => y[1] - x[1]);
    list.forEach(([id, kw], j) => arcs.push({ key: `grant:${id}`, role: 'grant', from: 'hub', to: id, kw, head: stag(j, list.length, P, false, 0.5), tail: ease((a - 0.8) / 0.2), alpha: fade }));
  }
  return { agents: new Map(), arcs, hub, sparkle: 0, maxGrant: D.maxGrant };
}
