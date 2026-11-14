/**
 * Pure invariant checks and the cached network index shared by the safety layer.
 * Imports src/core only (independence from the negotiation layer).
 *
 * Physics (docs/MICROGRID.md §3, §7): a feeder span carries the NET flow of everything downstream of it,
 * |Σ downstream allocation − Σ downstream prosumer export|. Only the live stretch of a feeder chain (the edges
 * between the consumer and the first broken span above it, ending at the service drop) carries power.
 */
import type { AllocationRequest, Building, Feeder, PowerEdge, PowerNetwork, ValidationContext } from '../core/types';

export interface FeederPath {
  /** substation index into NetIndex.subIds; −1 when the chain is not intact up to the substation */
  subI: number;
  /** indices into NetIndex.edgeIds (the whole feeder chain, substation → service drop) */
  edges: Int32Array;
}

/** Static lookup tables derived from a PowerNetwork (cached per network object). */
export interface NetIndex {
  edgeIds: string[];
  edgeCap: Float64Array;
  /** the live edge objects (status is read per minute) */
  edgeRefs: (PowerEdge | undefined)[];
  /** edge index → consumer building ids whose feeder crosses it */
  edgeConsumers: string[][];
  /** consumer id → its feeder paths (normally one) */
  paths: Map<string, FeederPath[]>;
  subIds: string[];
  /** substation building id → index in subIds */
  subIdx: Map<string, number>;
  /** per substation: consumer ids */
  subConsumers: string[][];
  /** per substation: ALL transmission edge ids incident to its node (live check happens per call) */
  subTrans: string[][];
  /** substation node id per substation index */
  subNode: string[];
  /** all transmission edges: id/from/to/capacity */
  tEdges: { id: string; from: string; to: string; cap: number }[];
  /** node id → indices into tEdges */
  tAdj: Map<string, number[]>;
  feeders: Feeder[];
  feederCount: number;
}

const cache = new WeakMap<PowerNetwork, NetIndex>();

export function getNetIndex(net: PowerNetwork, buildings: Record<string, Building>): NetIndex {
  const hit = cache.get(net);
  // the topology is rebuilt (new objects) whenever the city is; only statuses change in place, so identity is enough
  if (hit && hit.feeders === net.feeders && hit.feederCount === net.feeders.length) return hit;
  const edgeIds: string[] = [];
  const edgeIdx = new Map<string, number>();
  const caps: number[] = [];
  const refs: (PowerEdge | undefined)[] = [];
  const edgeConsumers: string[][] = [];
  const paths = new Map<string, FeederPath[]>();
  const subIds: string[] = [];
  const subIdx = new Map<string, number>();
  const subConsumers: string[][] = [];
  for (const f of net.feeders) {
    let si = subIdx.get(f.substationId);
    if (si === undefined) {
      si = subIds.length;
      subIdx.set(f.substationId, si);
      subIds.push(f.substationId);
      subConsumers.push([]);
    }
    subConsumers[si].push(f.consumerId);
    const arr = new Int32Array(f.edgeIds.length);
    f.edgeIds.forEach((eid, k) => {
      let ei = edgeIdx.get(eid);
      if (ei === undefined) {
        ei = edgeIds.length;
        edgeIdx.set(eid, ei);
        edgeIds.push(eid);
        caps.push(net.edges[eid]?.capacityKW ?? Infinity);
        refs.push(net.edges[eid]);
        edgeConsumers.push([]);
      }
      arr[k] = ei;
      edgeConsumers[ei].push(f.consumerId);
    });
    const list = paths.get(f.consumerId);
    if (list) list.push({ subI: si, edges: arr });
    else paths.set(f.consumerId, [{ subI: si, edges: arr }]);
  }
  // transmission edges incident to each substation node
  const nodeToSub = new Map<string, number>();
  subIds.forEach((sid, i) => {
    const nid = buildings[sid]?.nodeId;
    if (nid) nodeToSub.set(nid, i);
  });
  const subTrans: string[][] = subIds.map(() => []);
  for (const e of Object.values(net.edges)) {
    if (e.tier !== 'transmission') continue;
    const a = nodeToSub.get(e.from);
    const b = nodeToSub.get(e.to);
    if (a !== undefined) subTrans[a].push(e.id);
    if (b !== undefined && b !== a) subTrans[b].push(e.id);
  }
  const tEdges: NetIndex['tEdges'] = [];
  const tAdj = new Map<string, number[]>();
  for (const e of Object.values(net.edges)) {
    if (e.tier !== 'transmission') continue;
    const k = tEdges.length;
    tEdges.push({ id: e.id, from: e.from, to: e.to, cap: e.capacityKW });
    for (const n of [e.from, e.to]) {
      const l = tAdj.get(n);
      if (l) l.push(k);
      else tAdj.set(n, [k]);
    }
  }
  const idx: NetIndex = {
    subNode: subIds.map((sid) => buildings[sid]?.nodeId ?? ''),
    tEdges,
    tAdj,
    edgeIds,
    edgeCap: Float64Array.from(caps),
    edgeRefs: refs,
    edgeConsumers,
    paths,
    subIds,
    subIdx,
    subConsumers,
    subTrans,
    feeders: net.feeders,
    feederCount: net.feeders.length,
  };
  cache.set(net, idx);
  return idx;
}

/** Per-edge service status (1 = in service) of the index's distribution spans, read from the live network. */
export function edgeStatusOf(ix: NetIndex, net: PowerNetwork): Uint8Array {
  const ok = new Uint8Array(ix.edgeIds.length);
  for (let e = 0; e < ok.length; e++) ok[e] = ix.edgeRefs[e]?.status === 'ok' ? 1 : 0;
  return ok;
}

/** Fill `out` (length >= edge count) with the spans' service status and return its signature (FNV-1a over the first E bytes). */
export function edgeStatusInto(ix: NetIndex, out: Uint8Array): number {
  const refs = ix.edgeRefs;
  let sig = 0x811c9dc5;
  for (let e = 0; e < refs.length; e++) {
    const v = refs[e]?.status === 'ok' ? 1 : 0;
    out[e] = v;
    sig = Math.imul(sig ^ v, 0x01000193);
  }
  return sig;
}

/** A feeder chain as the minute's physics sees it: edges[from..] are in service (the live stretch). */
export interface LivePath {
  /** substation index, or −1 when the chain is not intact up to the substation */
  subI: number;
  edges: Int32Array;
  from: number;
}
const NO_PATHS: LivePath[] = [];
export { NO_PATHS };

/**
 * Live paths per consumer, cached while the span statuses are unchanged (they only change on a fault, so most
 * minutes reuse the previous minute's structures instead of allocating one per consumer).
 */
let pathCache: { ix: NetIndex; sig: number; byId: Map<string, LivePath[]> } | null = null;
export function livePathCache(ix: NetIndex, sig: number): Map<string, LivePath[]> {
  if (!pathCache || pathCache.ix !== ix || pathCache.sig !== sig) pathCache = { ix, sig, byId: new Map() };
  return pathCache.byId;
}

export function livePathsOf(paths: FeederPath[] | undefined, ok: Uint8Array): LivePath[] {
  if (!paths) return NO_PATHS;
  const out: LivePath[] = [];
  for (const p of paths) {
    const r = liveReach(p.edges, ok);
    out.push({ subI: r === 0 ? p.subI : -1, edges: p.edges, from: r });
  }
  return out;
}

/** Cached live paths of one consumer (built on first use for the current status pattern). */
export function livePathsFor(cache: Map<string, LivePath[]>, ix: NetIndex, ok: Uint8Array, id: string): LivePath[] {
  let ps = cache.get(id);
  if (!ps) {
    ps = livePathsOf(ix.paths.get(id), ok);
    cache.set(id, ps);
  }
  return ps;
}

// scratch buffers reused across checkInvariants calls (the function is synchronous and non-reentrant)
let scOk = new Uint8Array(0);
let scLoad = new Float64Array(0);
let scExp = new Float64Array(0);
let scVal = new Float64Array(0);

/**
 * Live stretch of a feeder chain: the first index r such that edges r..last are all in service (= length when the
 * service drop itself is broken, i.e. nothing is carried). Matches the engine's refreshReach().
 */
export function liveReach(edges: Int32Array, ok: Uint8Array): number {
  let r = edges.length;
  for (let k = edges.length - 1; k >= 0; k--) {
    if (!ok[edges[k]]) break;
    r = k;
  }
  return r;
}

export interface InvariantOptions {
  edgeMargin?: number;
  /** the allocation record was built from `requests` (one key per request, no others): skip the unknown-key scan */
  keysAreRequests?: boolean;
  /** the minute's span status as already read from the network by the caller (same source, same minute): avoids a second read */
  status?: { ok: Uint8Array; sig: number };
}

/**
 * Hard invariants every committed allocation must satisfy. Returns human-readable failures (empty = OK).
 *  - finite, 0 <= a <= demand, nothing to unknown ids, nothing outside the island's consumers;
 *  - Σ allocation <= supply, where supply = min(argument, ctx.info.supplyKW) (P_total of the island);
 *  - nothing to destroyed / disconnected consumers;
 *  - every feeder span in service: net flow |Σ downstream allocation − Σ downstream export| <= capacity × margin.
 *    Generator islands also keep the allocation-only bound Σ downstream allocation <= capacity × margin.
 */
export function checkInvariants(
  supplyKW: number,
  requests: AllocationRequest[],
  allocation: Record<string, number>,
  ctx?: ValidationContext,
  opts: InvariantOptions = {},
): string[] {
  const fails: string[] = [];
  const margin = opts.edgeMargin ?? 0.97;
  let supply = Math.max(0, supplyKW);
  const pTotal = ctx?.info?.supplyKW;
  if (pTotal !== undefined && Number.isFinite(pTotal)) supply = Math.min(supply, Math.max(0, pTotal));
  const nReq = requests.length;
  if (scVal.length < nReq) scVal = new Float64Array(Math.max(nReq, 2 * scVal.length));
  const vals = scVal; // NaN marks "absent"; non-finite grants are kept as read
  // per request (the common case): grant present, finite, within [0, demand]
  let total = 0;
  let bad = 0;
  let present = 0;
  for (let i = 0; i < nReq; i++) {
    const r = requests[i];
    const v = allocation[r.buildingId];
    if (v === undefined) {
      vals[i] = NaN;
      continue;
    }
    vals[i] = v;
    present++;
    if (!Number.isFinite(v)) { bad++; continue; }
    if (v < 0) fails.push(`negative allocation ${v} for ${r.buildingId}`);
    if (v > r.demandKW + 1e-9) fails.push(`allocation ${v} exceeds demand ${r.demandKW} for ${r.buildingId}`);
    total += v;
  }
  // keys that are not requests (only on the slow path: the counts differ)
  if (!opts.keysAreRequests && Object.keys(allocation).length !== present) {
    const demand = new Set<string>();
    for (const r of requests) demand.add(r.buildingId);
    for (const id of Object.keys(allocation)) {
      if (demand.has(id)) continue;
      if (allocation[id] !== 0) fails.push(`allocation to unknown id ${id}`);
    }
  }
  if (bad) fails.push(`${bad} non-finite allocation(s)`);
  if (total > supply + 1e-6) fails.push(`total ${total} exceeds supply ${supply}`);
  if (ctx) {
    const snap = ctx.snapshot;
    const cids = ctx.consumerIds;
    // island membership: requests normally follow consumerIds in order, so a lockstep walk avoids building a Set
    let aligned = true;
    let cur = 0;
    let island: Set<string> | null = null;
    for (let i = 0; i < nReq; i++) {
      const id = requests[i].buildingId;
      if (aligned) {
        if (cids[cur] === id) cur++;
        else aligned = false;
      }
      const v = vals[i];
      if (!(v > 0)) continue;
      if (!aligned) {
        if (!island) island = new Set(cids);
        if (!island.has(id)) fails.push(`allocation ${v} to ${id}, which is not a consumer of island ${ctx.islandId}`);
      }
      // a destroyed building takes its consumer down (connected = false), so the agent state decides
      const a = snap.agents[id];
      const destroyed = a ? !a.connected : snap.buildings[id]?.status === 'destroyed';
      if (destroyed) fails.push(`allocation ${v} to destroyed/disconnected ${id}`);
    }
    const ix = getNetIndex(snap.network, snap.buildings);
    const E = ix.edgeIds.length;
    if (scOk.length < E) {
      scOk = new Uint8Array(E);
      scLoad = new Float64Array(E);
      scExp = new Float64Array(E);
    }
    const load = scLoad;
    const exp = scExp;
    const given = opts.status;
    const ok = given ? given.ok : scOk;
    const sig = given ? given.sig : edgeStatusInto(ix, ok);
    load.fill(0, 0, E);
    exp.fill(0, 0, E);
    const paths = livePathCache(ix, sig);
    for (let i = 0; i < nReq; i++) {
      const v = vals[i];
      if (!(v > 0) || !Number.isFinite(v)) continue;
      for (const p of livePathsFor(paths, ix, ok, requests[i].buildingId)) {
        const ed = p.edges;
        for (let k = p.from; k < ed.length; k++) load[ed[k]] += v;
      }
    }
    // only prosumers export; the island info lists them (falls back to every consumer)
    for (const id of ctx.info?.prosumerIds ?? cids) {
      const x = snap.agents[id]?.der?.exportedKW;
      if (x !== undefined && x > 0 && Number.isFinite(x)) {
        for (const p of livePathsFor(paths, ix, ok, id)) {
          const ed = p.edges;
          for (let k = p.from; k < ed.length; k++) exp[ed[k]] += x;
        }
      }
    }
    const micro = ctx.info?.microgrid === true || ctx.generatorIds.length === 0;
    for (let e = 0; e < E; e++) {
      const L = load[e];
      const net = L - exp[e];
      const lim = ix.edgeCap[e] * margin;
      const q = micro ? Math.abs(net) : Math.max(L, Math.abs(net));
      if (q > lim + 1e-6) {
        const what = micro ? `net flow ${net.toFixed(1)} kW` : `allocation ${L.toFixed(1)} kW (net ${net.toFixed(1)} kW)`;
        fails.push(`edge ${ix.edgeIds[e]} carries ${what} > ${lim.toFixed(1)} kW`);
      }
    }
  }
  return fails;
}
