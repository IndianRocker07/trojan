/**
 * Underground water network — SPEC §4.5. Pure TypeScript.
 * One BFS tree of mains per pump station over road cells, junctions every 2 cells / at branches,
 * service lines from the nearest junction to every house, hospital, school and emergency station
 * (telecom towers are not water consumers).
 * Pipes are created parent-before-child, so iterating `pipes` in insertion order is a topological order.
 */
import { GRID_COLS, POLE_SPACING_CELLS, cellCenter, cellId, worldToCell } from '../core/constants';
import type { Rng } from '../core/rng';
import type { Building, GridCell, Vec2, WaterNetwork, WaterNode, WaterPipe } from '../core/types';
import { bresenham, buildingCentre } from './powerNetwork';

export const SERVICE_DIAMETER_MM = 100;
const DIAMETERS = [150, 200, 250, 300, 400];
const SERVED_KINDS = new Set(['house', 'hospital', 'school', 'emergency']);

export const waterSourceId = (bid: string) => `ws-${bid}`;
export const waterConsumerId = (bid: string) => `wc-${bid}`;

export function buildWaterNetwork(cells: GridCell[], buildings: Record<string, Building>, _rng: Rng): WaterNetwork {
  const nodes: Record<string, WaterNode> = {};
  const pipes: Record<string, WaterPipe> = {};
  const services: WaterNetwork['services'] = {};
  let pipeN = 0;
  let juncN = 0;

  const addNode = (id: string, kind: WaterNode['kind'], pos: Vec2, buildingId?: string, cell?: number): WaterNode => {
    const c = worldToCell(pos.x, pos.z);
    const n: WaterNode = { id, kind, pos, cell: cell ?? cellId(c.col, c.row), alive: true };
    if (buildingId) n.buildingId = buildingId;
    nodes[id] = n;
    return n;
  };
  const addPipe = (from: string, to: string, tier: 'main' | 'service', diameterMm: number, cellsPath?: number[]): WaterPipe => {
    const a = nodes[from].cell;
    const b = nodes[to].cell;
    const p: WaterPipe = {
      id: `wp-${pipeN++}`,
      from,
      to,
      tier,
      cells: cellsPath ?? bresenham(a % GRID_COLS, Math.floor(a / GRID_COLS), b % GRID_COLS, Math.floor(b / GRID_COLS)),
      diameterMm,
      status: 'ok',
      flowM3h: 0,
      pressureBar: 0,
    };
    pipes[p.id] = p;
    return p;
  };

  const all = Object.values(buildings);
  const stations = all.filter((b) => b.kind === 'water');
  const consumers = all.filter((b) => SERVED_KINDS.has(b.kind));
  if (stations.length === 0) return { nodes, pipes, services };

  const roadCells: number[] = [];
  for (const c of cells) if (c.terrain === 'road' || c.terrain === 'bridge') roadCells.push(c.id);
  const isRoad = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= GRID_COLS || r >= GRID_COLS) return false;
    const t = cells[cellId(c, r)].terrain;
    return t === 'road' || t === 'bridge';
  };
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

  // multi-source BFS: every road cell joins the tree of its nearest station
  const owner = new Int32Array(cells.length).fill(-1);
  const dist = new Int32Array(cells.length).fill(-1);
  const parent = new Int32Array(cells.length).fill(-1);
  const roots = stations.map((s) => nearestRoad(buildingCentre(s)));
  const q: number[] = [];
  roots.forEach((r, i) => {
    if (owner[r] >= 0) return;
    owner[r] = i;
    dist[r] = 0;
    q.push(r);
  });
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    const c = cur % GRID_COLS;
    const r = Math.floor(cur / GRID_COLS);
    for (const [dx, dy] of NB) {
      if (!isRoad(c + dx, r + dy)) continue;
      const nid = cellId(c + dx, r + dy);
      if (dist[nid] >= 0) continue;
      dist[nid] = dist[cur] + 1;
      owner[nid] = owner[cur];
      parent[nid] = cur;
      q.push(nid);
    }
  }

  for (const s of stations) addNode(waterSourceId(s.id), 'source', buildingCentre(s), s.id);

  const assigned: Building[][] = stations.map(() => []);
  const anchorOf = new Map<string, number>();
  for (const b of consumers) {
    const a = nearestRoad(buildingCentre(b));
    anchorOf.set(b.id, a);
    assigned[owner[a] >= 0 ? owner[a] : 0].push(b);
  }

  stations.forEach((s, si) => {
    const root = roots[si];
    if (owner[root] !== si) return; // shares a road cell with another station (not expected)
    const list = assigned[si];
    const marked = new Set<number>([root]);
    const childCount = new Map<number, number>();
    for (const b of list) {
      let cur = anchorOf.get(b.id)!;
      if (owner[cur] !== si) continue;
      while (!marked.has(cur)) {
        marked.add(cur);
        const p = parent[cur];
        childCount.set(p, (childCount.get(p) ?? 0) + 1);
        cur = p;
      }
    }
    const jCells = new Set<number>();
    for (const cid of marked) {
      const cc = childCount.get(cid) ?? 0;
      if (cid === root || cc === 0 || cc >= 2 || dist[cid] % POLE_SPACING_CELLS === 0) jCells.add(cid);
    }
    const ordered = [...jCells].sort((a, b) => dist[a] - dist[b] || a - b);
    const juncOf = new Map<number, string>();
    const parentPipe = new Map<string, string>();
    const parentNode = new Map<string, string>();
    const srcId = waterSourceId(s.id);
    const mainPipes: WaterPipe[] = [];
    for (const cid of ordered) {
      const cc = cellCenter(cid % GRID_COLS, Math.floor(cid / GRID_COLS));
      const id = `wj-${juncN++}`;
      addNode(id, 'junction', { x: cc.x, z: cc.z }, undefined, cid);
      juncOf.set(cid, id);
      let pipe: WaterPipe;
      let up = srcId;
      if (cid !== root) {
        let p = parent[cid];
        while (!juncOf.has(p)) p = parent[p];
        up = juncOf.get(p)!;
        const tmp: number[] = [cid];
        let qn = parent[cid];
        while (qn !== p) {
          tmp.push(qn);
          qn = parent[qn];
        }
        tmp.push(p);
        pipe = addPipe(up, id, 'main', 400, tmp.reverse());
      } else pipe = addPipe(up, id, 'main', 400);
      mainPipes.push(pipe);
      parentPipe.set(id, pipe.id);
      parentNode.set(id, up);
    }
    const juncIds = [...juncOf.values()];
    const downstream = new Map<string, number>();
    for (const b of list) {
      const bc = buildingCentre(b);
      let best = juncIds[0];
      let bd = Infinity;
      for (const j of juncIds) {
        const d = Math.hypot(nodes[j].pos.x - bc.x, nodes[j].pos.z - bc.z);
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      const cn = addNode(waterConsumerId(b.id), 'consumer', bc, b.id);
      const sp = addPipe(best, cn.id, 'service', SERVICE_DIAMETER_MM);
      const chain: string[] = [];
      let cur = best;
      while (cur !== srcId) {
        const pid = parentPipe.get(cur)!;
        chain.push(pid);
        downstream.set(pid, (downstream.get(pid) ?? 0) + 1);
        cur = parentNode.get(cur)!;
      }
      chain.reverse();
      services[b.id] = { sourceId: srcId, pipeIds: [...chain, sp.id] };
    }
    let mx = 1;
    for (const v of downstream.values()) mx = Math.max(mx, v);
    for (const [pid, cnt] of downstream) {
      const f = Math.sqrt(cnt / mx);
      pipes[pid].diameterMm = DIAMETERS[Math.min(DIAMETERS.length - 1, Math.floor(f * DIAMETERS.length))];
    }
    for (const p of mainPipes) if (!downstream.has(p.id)) p.diameterMm = 150;
  });
  return { nodes, pipes, services };
}

export interface WaterResult {
  /** pressure (bar) at a node */
  pressure: { get(nodeId: string): number | undefined };
  /** water flowing through a node's downstream side (m3/h); for a source = total delivered */
  flow: { get(nodeId: string): number | undefined };
}

interface Compiled {
  nodes: WaterNode[];
  pipes: WaterPipe[];
  idx: Map<string, number>;
  from: Int32Array;
  to: Int32Array;
}
const compiledCache = new WeakMap<WaterNetwork, Compiled>();
function compile(net: WaterNetwork): Compiled {
  let c = compiledCache.get(net);
  if (!c) {
    const nodes = Object.values(net.nodes);
    const pipes = Object.values(net.pipes);
    const idx = new Map<string, number>();
    nodes.forEach((n, i) => idx.set(n.id, i));
    const from = new Int32Array(pipes.length);
    const to = new Int32Array(pipes.length);
    pipes.forEach((p, i) => {
      from[i] = idx.get(p.from)!;
      to[i] = idx.get(p.to)!;
    });
    c = { nodes, pipes, idx, from, to };
    compiledCache.set(net, c);
  }
  return c;
}

/**
 * Per-tick hydraulics (SPEC 4.5).
 * @param sourceServed (grid+backup) served fraction of a pump station building
 * @param demandM3h    water demand of a served consumer building
 */
export function updateWaterNetwork(
  net: WaterNetwork,
  cells: GridCell[],
  sourceServed: (stationId: string) => number,
  demandM3h: (buildingId: string) => number,
): WaterResult {
  const c = compile(net);
  const { nodes, pipes, from, to, idx } = c;
  const pressure = new Float64Array(nodes.length);
  const flow = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    n.alive = cells[n.cell].status !== 'destroyed';
    if (n.kind === 'source') {
      const served = n.alive ? sourceServed(n.buildingId!) : 0;
      pressure[i] = 4.5 * Math.min(1, Math.max(0, served) / 0.35);
    }
  }
  for (let i = 0; i < pipes.length; i++) {
    const p = pipes[i];
    let broken = false;
    for (let k = 0; k < p.cells.length; k++) {
      if (cells[p.cells[k]].status === 'destroyed') {
        broken = true;
        break;
      }
    }
    p.status = broken ? 'broken' : 'ok';
    const pf = pressure[from[i]];
    const drop = p.tier === 'main' ? 0.15 : 0.05;
    const pt = broken || !nodes[to[i]].alive || pf <= 0 ? 0 : Math.max(0, pf - drop);
    pressure[to[i]] = pt;
    p.pressureBar = pt;
    p.flowM3h = 0;
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'consumer') flow[i] = demandM3h(n.buildingId!) * Math.min(1, pressure[i] / 1.5);
  }
  for (let i = pipes.length - 1; i >= 0; i--) {
    const f = flow[to[i]];
    pipes[i].flowM3h = f;
    flow[from[i]] += f;
  }
  const getter = (arr: Float64Array) => ({ get: (id: string) => (idx.has(id) ? arr[idx.get(id)!] : undefined) });
  return { pressure: getter(pressure), flow: getter(flow) };
}
