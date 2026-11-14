/**
 * Power network — SPEC §4. Pure TypeScript.
 *
 * Deviations from the spec text (documented in the sim agent report):
 *  - Distribution trunk edges are sized max(1500 kW, 1.6 × downstream nominal peak) instead of a flat
 *    1500 kW, otherwise every substation trunk would be over capacity in normal operation.
 *  - Poles of different substations that fall on the same road cell are staggered along the road
 *    by 2.4 m so the models never overlap.
 */
import {
  CELL,
  GRID_COLS,
  HALF_D,
  HALF_W,
  POLE_SPACING_CELLS,
  PYLON_SPACING_CELLS,
  cellCenter,
  cellId,
  worldToCell,
} from '../core/constants';
import type { Rng } from '../core/rng';
import type {
  Building,
  ConsumerKind,
  GeneratorState,
  GridCell,
  PowerEdge,
  PowerNetwork,
  PowerNode,
  PowerNodeKind,
  Vec2,
} from '../core/types';
import { NOMINAL_PEAK_KW } from './profiles';

export const TRANSMISSION_CAPACITY_KW = 6000;
/** Ring (sub-to-sub) links are lighter redundancy conductors; a plant outage pushes the whole load onto them. */
export const RING_CAPACITY_KW = 3000;
export const DISTRIBUTION_MIN_CAPACITY_KW = 1500;

const FRONT: Array<[number, number]> = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

export function nodeIdOf(buildingId: string): string {
  return `n-${buildingId}`;
}

/** Axis-aligned bounds (cell units) of the cells a building occupies. */
function bounds(b: Building) {
  let c0 = Infinity,
    r0 = Infinity,
    c1 = -Infinity,
    r1 = -Infinity;
  for (const id of b.cells) {
    const c = id % GRID_COLS;
    const r = Math.floor(id / GRID_COLS);
    c0 = Math.min(c0, c);
    r0 = Math.min(r0, r);
    c1 = Math.max(c1, c);
    r1 = Math.max(r1, r);
  }
  return { c0, r0, ew: c1 - c0 + 1, ed: r1 - r0 + 1 };
}

export function buildingCentre(b: Building): Vec2 {
  const { c0, r0, ew, ed } = bounds(b);
  return { x: (c0 + ew / 2) * CELL - HALF_W, z: (r0 + ed / 2) * CELL - HALF_D };
}

export function bresenham(c0: number, r0: number, c1: number, r1: number): number[] {
  const out: number[] = [];
  let x = c0,
    y = r0;
  const dx = Math.abs(c1 - c0),
    dy = Math.abs(r1 - r0);
  const sx = c0 < c1 ? 1 : -1,
    sy = r0 < r1 ? 1 : -1;
  let err = dx - dy;
  for (let guard = 0; guard < 400; guard++) {
    out.push(cellId(x, y));
    if (x === c1 && y === r1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

export function buildNetwork(cells: GridCell[], buildings: Record<string, Building>, _rng: Rng): PowerNetwork {
  const nodes: Record<string, PowerNode> = {};
  const edges: Record<string, PowerEdge> = {};
  const transmission: Record<string, string[]> = {};
  const feeders: PowerNetwork['feeders'] = [];
  let edgeN = 0;
  let pylonN = 0;
  let poleN = 0;

  const addNode = (id: string, kind: PowerNodeKind, pos: Vec2, buildingId?: string): PowerNode => {
    const c = worldToCell(pos.x, pos.z);
    const n: PowerNode = { id, kind, pos, cell: cellId(c.col, c.row), alive: true };
    if (buildingId) n.buildingId = buildingId;
    nodes[id] = n;
    return n;
  };
  const addEdge = (from: string, to: string, tier: 'transmission' | 'distribution', capacityKW: number): PowerEdge => {
    const a = nodes[from];
    const b = nodes[to];
    const ca = a.cell,
      cb = b.cell;
    const e: PowerEdge = {
      id: `e-${edgeN++}`,
      from,
      to,
      tier,
      cells: bresenham(ca % GRID_COLS, Math.floor(ca / GRID_COLS), cb % GRID_COLS, Math.floor(cb / GRID_COLS)),
      capacityKW,
      status: 'ok',
      flowKW: 0,
    };
    edges[e.id] = e;
    return e;
  };

  const all = Object.values(buildings);
  const gens = all.filter((b) => b.kind === 'generator');
  const subs = all.filter((b) => b.kind === 'substation');
  const consumers = all.filter((b) => b.kind !== 'generator' && b.kind !== 'substation');

  // ── Building nodes ──
  for (const b of all) {
    const c = buildingCentre(b);
    let pos = c;
    let kind: PowerNodeKind = 'consumer';
    if (b.kind === 'generator') kind = 'generator';
    else if (b.kind === 'substation') kind = 'substation';
    else {
      const { ew, ed } = bounds(b);
      const f = FRONT[b.rotation];
      const half = (b.rotation % 2 === 0 ? ed : ew) * CELL * 0.5;
      const off = Math.max(0, half - 2.5);
      pos = { x: c.x + f[0] * off, z: c.z + f[1] * off };
    }
    addNode(nodeIdOf(b.id), kind, pos, b.id);
    b.nodeId = nodeIdOf(b.id);
  }

  // ── Transmission ──
  const linkKeys = new Set<string>();
  const links: Array<[string, string, number]> = [];
  const addLink = (a: string, b: string, cap: number) => {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (a === b || linkKeys.has(k)) return;
    linkKeys.add(k);
    links.push([a, b, cap]);
  };
  for (const g of gens) {
    const gc = buildingCentre(g);
    const near = [...subs]
      .sort((s1, s2) => {
        const a = buildingCentre(s1),
          b = buildingCentre(s2);
        return Math.hypot(a.x - gc.x, a.z - gc.z) - Math.hypot(b.x - gc.x, b.z - gc.z);
      })
      .slice(0, 3);
    transmission[g.id] = near.map((s) => s.id);
    for (const s of near) addLink(g.id, s.id, TRANSMISSION_CAPACITY_KW);
  }
  const ring = [...subs].sort((s1, s2) => {
    const a = buildingCentre(s1),
      b = buildingCentre(s2);
    return Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x);
  });
  for (let i = 0; i < ring.length; i++) addLink(ring[i].id, ring[(i + 1) % ring.length].id, RING_CAPACITY_KW);

  const pylonFree = (p: Vec2) => {
    const c = worldToCell(p.x, p.z);
    const cell = cells[cellId(c.col, c.row)];
    return cell.buildingId === undefined && cell.terrain !== 'river';
  };
  for (const [a, b, cap] of links) {
    const A = nodes[nodeIdOf(a)];
    const B = nodes[nodeIdOf(b)];
    const L = Math.hypot(B.pos.x - A.pos.x, B.pos.z - A.pos.z);
    const spans = Math.max(1, Math.round(L / (PYLON_SPACING_CELLS * CELL)));
    let prev = A.id;
    for (let i = 1; i <= spans; i++) {
      let toId: string;
      if (i === spans) toId = B.id;
      else {
        const t0 = i / spans;
        let pos: Vec2 = { x: A.pos.x + (B.pos.x - A.pos.x) * t0, z: A.pos.z + (B.pos.z - A.pos.z) * t0 };
        if (!pylonFree(pos)) {
          const maxK = Math.max(1, Math.floor(0.35 / spans / 0.02));
          search: for (let k = 1; k <= maxK; k++) {
            for (const sgn of [1, -1]) {
              const t = t0 + sgn * k * 0.02;
              const p = { x: A.pos.x + (B.pos.x - A.pos.x) * t, z: A.pos.z + (B.pos.z - A.pos.z) * t };
              if (pylonFree(p)) {
                pos = p;
                break search;
              }
            }
          }
        }
        toId = `pyl-${pylonN++}`;
        addNode(toId, 'pylon', pos);
      }
      addEdge(prev, toId, 'transmission', cap);
      prev = toId;
    }
  }

  // ── Distribution ──
  const isRoad = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= GRID_COLS || r >= GRID_COLS) return false;
    const t = cells[cellId(c, r)].terrain;
    return t === 'road' || t === 'bridge';
  };
  const roadCells: number[] = [];
  for (const c of cells) if (c.terrain === 'road' || c.terrain === 'bridge') roadCells.push(c.id);
  const nearestRoad = (p: Vec2): number => {
    let best = roadCells[0];
    let bd = Infinity;
    for (const id of roadCells) {
      const cc = cellCenter(id % GRID_COLS, Math.floor(id / GRID_COLS));
      const d = Math.hypot(cc.x - p.x, cc.z - p.z);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  };

  const NB = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  interface Bfs {
    root: number;
    dist: Int32Array;
    parent: Int32Array;
  }
  const bfsFor = (root: number): Bfs => {
    const dist = new Int32Array(cells.length).fill(-1);
    const parent = new Int32Array(cells.length).fill(-1);
    const q: number[] = [root];
    dist[root] = 0;
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      const c = cur % GRID_COLS,
        r = Math.floor(cur / GRID_COLS);
      for (const [dx, dy] of NB) {
        const nc = c + dx,
          nr = r + dy;
        if (!isRoad(nc, nr)) continue;
        const nid = cellId(nc, nr);
        if (dist[nid] >= 0) continue;
        dist[nid] = dist[cur] + 1;
        parent[nid] = cur;
        q.push(nid);
      }
    }
    return { root, dist, parent };
  };

  const subBfs = subs.map((s) => bfsFor(nearestRoad(buildingCentre(s))));
  const assigned: Building[][] = subs.map(() => []);
  const anchorOf = new Map<string, number>();
  for (const b of consumers) {
    const np = nodes[b.nodeId].pos;
    const anchor = nearestRoad(np);
    anchorOf.set(b.id, anchor);
    const ac = anchor % GRID_COLS,
      ar = Math.floor(anchor / GRID_COLS);
    const bc = worldToCell(np.x, np.z);
    let best = -1;
    let bs = Infinity;
    subs.forEach((_, i) => {
      const d = subBfs[i].dist[anchor];
      if (d < 0) return;
      const s = d + Math.abs(ac - bc.col) + Math.abs(ar - bc.row);
      if (s < bs) {
        bs = s;
        best = i;
      }
    });
    if (best < 0) best = 0; // unreachable (should not happen) — attach to first substation anyway
    assigned[best].push(b);
  }

  subs.forEach((s, si) => {
    const bfs = subBfs[si];
    const list = assigned[si];
    // prune tree to the union of paths root → anchors
    const marked = new Set<number>([bfs.root]);
    const childCount = new Map<number, number>();
    for (const b of list) {
      let cur = anchorOf.get(b.id)!;
      if (bfs.dist[cur] < 0) continue;
      while (!marked.has(cur)) {
        marked.add(cur);
        const p = bfs.parent[cur];
        childCount.set(p, (childCount.get(p) ?? 0) + 1);
        cur = p;
      }
    }
    // choose pole cells
    const poleCells = new Set<number>();
    for (const cid of marked) {
      const cc = childCount.get(cid) ?? 0;
      if (cid === bfs.root || cc === 0 || cc >= 2 || bfs.dist[cid] % POLE_SPACING_CELLS === 0) poleCells.add(cid);
    }
    // create pole nodes in BFS depth order
    const ordered = [...poleCells].sort((a, b) => bfs.dist[a] - bfs.dist[b] || a - b);
    const poleNodeOf = new Map<number, string>();
    const parentEdge = new Map<string, string>(); // pole node → edge id from its parent
    const parentPole = new Map<string, string>(); // pole node → parent node id (pole or substation)
    const stagger = ((si % 3) - 1) * 2.4;
    const subNodeId = nodeIdOf(s.id);
    for (const cid of ordered) {
      const col = cid % GRID_COLS,
        row = Math.floor(cid / GRID_COLS);
      const cc = cellCenter(col, row);
      const vertical = col % 6 === 0;
      const horizontal = row % 6 === 0;
      let px = cc.x;
      let pz = cc.z;
      if (vertical && !horizontal) {
        px += 3.5;
        pz += stagger;
      } else if (horizontal && !vertical) {
        pz += 3.5;
        px += stagger;
      } else {
        px += 3.5;
        pz += 3.5;
      }
      const id = `pole-${poleN++}`;
      addNode(id, 'pole', { x: px, z: pz });
      nodes[id].cell = cid;
      poleNodeOf.set(cid, id);
      // find parent pole (or substation for the root)
      let upstream = subNodeId;
      if (cid !== bfs.root) {
        let p = bfs.parent[cid];
        while (!poleNodeOf.has(p)) p = bfs.parent[p];
        upstream = poleNodeOf.get(p)!;
        // edge cells = every road cell between parent pole and this pole (inclusive)
        const cellsPath: number[] = [cid];
        let q = bfs.parent[cid];
        const stop = p;
        while (q !== stop) {
          cellsPath.push(q);
          q = bfs.parent[q];
        }
        cellsPath.push(stop);
        const e = addEdge(upstream, id, 'distribution', DISTRIBUTION_MIN_CAPACITY_KW);
        e.cells = cellsPath.reverse();
        parentEdge.set(id, e.id);
      } else {
        const e = addEdge(upstream, id, 'distribution', DISTRIBUTION_MIN_CAPACITY_KW);
        parentEdge.set(id, e.id);
      }
      parentPole.set(id, upstream);
    }
    const poleIds = [...poleNodeOf.values()];
    // service drops + feeders
    const downstream = new Map<string, number>(); // edge id → nominal peak kW
    for (const b of list) {
      const cn = nodes[b.nodeId];
      let best = poleIds[0];
      let bd = Infinity;
      for (const pid of poleIds) {
        const p = nodes[pid];
        const d = Math.hypot(p.pos.x - cn.pos.x, p.pos.z - cn.pos.z);
        if (d < bd) {
          bd = d;
          best = pid;
        }
      }
      const peak = NOMINAL_PEAK_KW[b.kind as ConsumerKind];
      const drop = addEdge(best, cn.id, 'distribution', Math.max(10, 2 * peak));
      const chain: string[] = [];
      let cur = best;
      while (cur !== subNodeId) {
        chain.push(parentEdge.get(cur)!);
        cur = parentPole.get(cur)!;
      }
      chain.reverse();
      for (const eid of chain) downstream.set(eid, (downstream.get(eid) ?? 0) + peak);
      feeders.push({ substationId: s.id, consumerId: b.id, edgeIds: [...chain, drop.id] });
    }
    for (const [eid, kw] of downstream) edges[eid].capacityKW = Math.max(DISTRIBUTION_MIN_CAPACITY_KW, Math.round(kw * 1.6));
  });

  return { nodes, edges, transmission, feeders };
}

// ───────────────────────── Connectivity & islands (§4.3) ─────────────────────────

export interface Island {
  id: number;
  generatorIds: string[]; // building ids of running generators in this island
  substationIds: string[];
  consumerIds: string[]; // building ids of connected consumers
}

const adjCache = new WeakMap<PowerNetwork, Map<string, string[]>>();
function adjacency(net: PowerNetwork): Map<string, string[]> {
  let a = adjCache.get(net);
  if (!a) {
    a = new Map();
    for (const id of Object.keys(net.nodes)) a.set(id, []);
    for (const e of Object.values(net.edges)) {
      a.get(e.from)!.push(e.id);
      a.get(e.to)!.push(e.id);
    }
    adjCache.set(net, a);
  }
  return a;
}

/**
 * Recomputes `node.alive`, `edge.status` and the islands.
 * @param down       building ids that are not operational (any cell non-ok, or still recovering)
 * @param tripped    edge ids that tripped from overload (stay broken)
 */
export function computeIslands(
  net: PowerNetwork,
  cells: GridCell[],
  buildings: Record<string, Building>,
  generators: Record<string, GeneratorState>,
  down: ReadonlySet<string>,
  tripped: ReadonlySet<string>,
): { islands: Island[]; connected: Set<string> } {
  for (const n of Object.values(net.nodes)) {
    if (n.buildingId) n.alive = !down.has(n.buildingId);
    else {
      const st = cells[n.cell].status;
      n.alive = st === 'ok' || st === 'flooded';
    }
  }
  for (const e of Object.values(net.edges)) {
    let broken = tripped.has(e.id) || !net.nodes[e.from].alive || !net.nodes[e.to].alive;
    if (!broken) {
      for (const c of e.cells) {
        const st = cells[c].status;
        if (st === 'destroyed' || st === 'burning') {
          broken = true;
          break;
        }
      }
    }
    e.status = broken ? 'broken' : 'ok';
  }
  const adj = adjacency(net);
  const visited = new Set<string>();
  const islands: Island[] = [];
  const connected = new Set<string>();
  for (const [gid, g] of Object.entries(generators)) {
    if (g.status !== 'running') continue;
    const start = net.nodes[buildings[gid].nodeId];
    if (!start.alive || visited.has(start.id)) continue;
    const isl: Island = { id: islands.length, generatorIds: [], substationIds: [], consumerIds: [] };
    const q = [start.id];
    visited.add(start.id);
    for (let h = 0; h < q.length; h++) {
      const n = net.nodes[q[h]];
      if (n.kind === 'generator' && n.buildingId && generators[n.buildingId]?.status === 'running') isl.generatorIds.push(n.buildingId);
      else if (n.kind === 'substation') isl.substationIds.push(n.buildingId!);
      else if (n.kind === 'consumer') {
        isl.consumerIds.push(n.buildingId!);
        connected.add(n.buildingId!);
      }
      for (const eid of adj.get(n.id)!) {
        const e = net.edges[eid];
        if (e.status !== 'ok') continue;
        const other = e.from === n.id ? e.to : e.from;
        if (visited.has(other)) continue;
        visited.add(other);
        q.push(other);
      }
    }
    islands.push(isl);
  }
  return { islands, connected };
}
