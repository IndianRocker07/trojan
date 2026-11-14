/**
 * Disasters — SPEC §7.3. Each DisasterEvent is advanced once per simulated minute and writes into
 * the shared cell "layers" (destroyed is permanent; burning / flooded are rebuilt every minute).
 * The engine merges the layers into `GridCell.status` (destroyed > burning > flooded > ok).
 */
import { GRID_COLS, GRID_ROWS, cellId } from '../core/constants';
import type { Rng } from '../core/rng';
import type { DisasterEvent, DisasterKind, DisasterParams, GridCell, LogEntry } from '../core/types';

/** DisasterParams plus `durationMin` (SPEC §7.3 lists it for flood/cyclone/grid_fault; not in core types). */
export type SimDisasterParams = DisasterParams & { durationMin?: number };

export interface DisasterLayers {
  destroyed: Uint8Array;
  burning: Uint8Array;
  flooded: Uint8Array;
}

export interface DisasterCtx {
  cells: GridCell[];
  rng: Rng;
  layers: DisasterLayers;
  tMin: number;
  log(level: LogEntry['level'], msg: string, buildingId?: string): void;
  tripGenerator(id: string, untilMin: number): void;
  /** running generator closest to a cell (for seismic protective trips) */
  nearestGenerator(col: number, row: number): string | undefined;
}

export interface DisasterRuntime {
  ev: DisasterEvent;
  lastAge: number;
  // kind-specific state
  aftershocks: Array<{ at: number; col: number; row: number }>;
  eye: { x: number; y: number };
  burn: Map<number, number>;
  flood: Uint8Array;
  level: number;
}

const DEFAULT_DURATION: Record<DisasterKind, number> = {
  earthquake: 90,
  flood: 360,
  cyclone: 240,
  fire: 240,
  grid_fault: 90,
};

export function createDisaster(id: string, kind: DisasterKind, params: SimDisasterParams, startMin: number, rng: Rng): DisasterRuntime {
  const p: SimDisasterParams = { ...params };
  p.col = p.col ?? Math.floor(GRID_COLS / 2);
  p.row = p.row ?? Math.floor(GRID_ROWS / 2);
  p.intensity = Math.max(0.05, Math.min(1, p.intensity ?? 0.7));
  if (kind === 'earthquake') p.radius = p.radius ?? 8;
  if (kind === 'cyclone') {
    p.radius = p.radius ?? 5;
    p.speed = p.speed ?? 6;
    p.heading = p.heading ?? -Math.PI * 0.75;
  }
  if (kind === 'fire') p.speed = p.speed ?? 1;
  const durationMin = p.durationMin ?? DEFAULT_DURATION[kind];
  const ev: DisasterEvent = {
    id,
    kind,
    startMin,
    durationMin,
    params: p,
    affected: [],
    active: true,
  };
  const rt: DisasterRuntime = {
    ev,
    lastAge: -1,
    aftershocks: [],
    eye: { x: p.col, y: p.row },
    burn: new Map(),
    flood: new Uint8Array(GRID_COLS * GRID_ROWS),
    level: 0,
  };
  if (kind === 'earthquake') {
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++)
      rt.aftershocks.push({
        at: rng.int(8, Math.max(9, durationMin)),
        col: Math.round(p.col + rng.range(-3, 3)),
        row: Math.round(p.row + rng.range(-3, 3)),
      });
    rt.aftershocks.sort((a, b) => a.at - b.at);
  }
  return rt;
}

/** Advance (once per age) and re-mark the layers. */
export function stepDisaster(rt: DisasterRuntime, ctx: DisasterCtx): void {
  const ev = rt.ev;
  const age = ctx.tMin - ev.startMin;
  if (age > rt.lastAge && (ev.active || age === 0)) {
    for (let a = rt.lastAge + 1; a <= age; a++) advance(rt, ctx, a);
    rt.lastAge = age;
  }
  mark(rt, ctx);
}

function advance(rt: DisasterRuntime, ctx: DisasterCtx, age: number): void {
  switch (rt.ev.kind) {
    case 'earthquake': return advanceQuake(rt, ctx, age);
    case 'flood': return advanceFlood(rt, ctx, age);
    case 'cyclone': return advanceCyclone(rt, ctx, age);
    case 'fire': return advanceFire(rt, ctx, age);
    case 'grid_fault': return advanceFault(rt, ctx, age);
  }
}

function mark(rt: DisasterRuntime, ctx: DisasterCtx): void {
  const L = ctx.layers;
  if (rt.ev.kind === 'flood' && rt.ev.active) for (let i = 0; i < rt.flood.length; i++) if (rt.flood[i]) L.flooded[i] = 1;
  if (rt.ev.kind === 'fire') for (const c of rt.burn.keys()) L.burning[c] = 1;
}

// ───────────────────────────── earthquake ─────────────────────────────

function shake(rt: DisasterRuntime, ctx: DisasterCtx, col: number, row: number, intensity: number, radius: number): number {
  let n = 0;
  const r = Math.ceil(radius);
  for (let y = row - r; y <= row + r; y++) {
    for (let x = col - r; x <= col + r; x++) {
      if (x < 0 || y < 0 || x >= GRID_COLS || y >= GRID_ROWS) continue;
      const d = Math.hypot(x - col, y - row);
      if (d > radius) continue;
      const id = cellId(x, y);
      const cell = ctx.cells[id];
      if (cell.terrain === 'river') continue;
      const p = intensity * Math.pow(Math.max(0, 1 - d / radius), 0.7);
      if (ctx.rng.next() < p && !ctx.layers.destroyed[id]) {
        ctx.layers.destroyed[id] = 1;
        rt.ev.affected.push(id);
        n++;
      }
    }
  }
  return n;
}

function advanceQuake(rt: DisasterRuntime, ctx: DisasterCtx, age: number): void {
  const p = rt.ev.params;
  if (age === 0) {
    const n = shake(rt, ctx, p.col!, p.row!, p.intensity!, p.radius!);
    ctx.log('crit', `Earthquake at (${p.col},${p.row}) — ${n} grid blocks destroyed`);
    // protective shutdown of the plant closest to the epicentre (seismic relays), restart after the aftershock window
    const gid = ctx.nearestGenerator(p.col!, p.row!);
    if (gid) {
      ctx.tripGenerator(gid, rt.ev.startMin + rt.ev.durationMin);
      ctx.log('crit', `Seismic protection tripped ${gid} for ${rt.ev.durationMin} min`, gid);
    }
  }
  while (rt.aftershocks.length && rt.aftershocks[0].at <= age) {
    const a = rt.aftershocks.shift()!;
    const n = shake(rt, ctx, a.col, a.row, p.intensity! * 0.4, p.radius! * 0.8);
    ctx.log('warn', `Aftershock near (${a.col},${a.row}) — ${n} more blocks destroyed`);
  }
  if (age >= rt.ev.durationMin && rt.aftershocks.length === 0) rt.ev.active = false;
}

// ───────────────────────────── flood ─────────────────────────────

function advanceFlood(rt: DisasterRuntime, ctx: DisasterCtx, age: number): void {
  const ev = rt.ev;
  const D = ev.durationMin;
  const lmax = 0.15 + 0.45 * ev.params.intensity!;
  const rise = 0.4 * D;
  const recede = 0.7 * D;
  let level = 0;
  if (age < rise) level = lmax * (age / rise);
  else if (age < recede) level = lmax;
  else level = lmax * Math.max(0, 1 - (age - recede) / (D - recede));
  if (age === 0) ctx.log('crit', `Flood warning — river rising (peak level ${lmax.toFixed(2)})`);
  if (age >= D) {
    ev.active = false;
    rt.flood.fill(0);
    ev.affected = [];
    rt.level = 0;
    return;
  }
  rt.level = level;
  // flood fill from the river through 4-connected cells below the water level
  const flood = rt.flood;
  flood.fill(0);
  const q: number[] = [];
  const seen = new Uint8Array(flood.length);
  for (const c of ctx.cells) if (c.terrain === 'river') { seen[c.id] = 1; q.push(c.id); }
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    const c = cur % GRID_COLS, r = Math.floor(cur / GRID_COLS);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dx, nr = r + dy;
      if (nc < 0 || nr < 0 || nc >= GRID_COLS || nr >= GRID_ROWS) continue;
      const nid = cellId(nc, nr);
      if (seen[nid]) continue;
      if (ctx.cells[nid].elevation >= level) continue;
      seen[nid] = 1;
      q.push(nid);
      flood[nid] = 1;
    }
  }
  ev.affected = [];
  for (let i = 0; i < flood.length; i++) if (flood[i]) ev.affected.push(i);
}

// ───────────────────────────── cyclone ─────────────────────────────

function advanceCyclone(rt: DisasterRuntime, ctx: DisasterCtx, age: number): void {
  const ev = rt.ev;
  const p = ev.params;
  if (age === 0) ctx.log('crit', `Cyclone landfall near (${p.col},${p.row}) — solar output collapsing, high winds`);
  if (age >= ev.durationMin) {
    if (ev.active) ctx.log('info', 'Cyclone has passed');
    ev.active = false;
    ev.affected = [];
    return;
  }
  const stepCells = (p.speed! / 60);
  rt.eye.x = p.col! + Math.cos(p.heading!) * stepCells * age;
  rt.eye.y = p.row! + Math.sin(p.heading!) * stepCells * age;
  const zr = p.radius! * 0.6;
  ev.affected = [];
  const R = Math.ceil(zr);
  for (let y = Math.floor(rt.eye.y) - R; y <= Math.floor(rt.eye.y) + R; y++) {
    for (let x = Math.floor(rt.eye.x) - R; x <= Math.floor(rt.eye.x) + R; x++) {
      if (x < 0 || y < 0 || x >= GRID_COLS || y >= GRID_ROWS) continue;
      const d = Math.hypot(x - rt.eye.x, y - rt.eye.y);
      if (d > zr) continue;
      const id = cellId(x, y);
      const cell = ctx.cells[id];
      if (cell.terrain === 'river') continue;
      ev.affected.push(id);
      if (ctx.layers.destroyed[id]) continue;
      // 0.08·intensity per minute at the eye wall, falling off towards the outer edge (see report)
      let pr = 0.08 * p.intensity! * (1 - 0.5 * (d / zr));
      if (cell.terrain === 'road' || cell.terrain === 'bridge') pr *= 0.5;
      if (ctx.rng.next() < pr) ctx.layers.destroyed[id] = 1;
    }
  }
}

// ───────────────────────────── fire ─────────────────────────────

function advanceFire(rt: DisasterRuntime, ctx: DisasterCtx, age: number): void {
  const ev = rt.ev;
  const p = ev.params;
  const burnable = (id: number) => {
    const t = ctx.cells[id].terrain;
    return (t === 'land' || t === 'park') && !ctx.layers.destroyed[id] && !rt.burn.has(id);
  };
  if (age === 0) {
    // find the nearest burnable cell to the ignition point
    let best = -1, bd = Infinity;
    for (const c of ctx.cells) {
      if (!burnable(c.id)) continue;
      const d = Math.hypot(c.col - p.col!, c.row - p.row!);
      if (d < bd) { bd = d; best = c.id; }
    }
    if (best >= 0) {
      rt.burn.set(best, ctx.rng.int(60, 120));
      ctx.log('crit', `Fire reported near (${ctx.cells[best].col},${ctx.cells[best].row})`);
    } else ev.active = false;
    return;
  }
  const ignite: number[] = [];
  for (const [id] of rt.burn) {
    const c = id % GRID_COLS, r = Math.floor(id / GRID_COLS);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dx, nr = r + dy;
      if (nc < 0 || nr < 0 || nc >= GRID_COLS || nr >= GRID_ROWS) continue;
      const nid = cellId(nc, nr);
      if (!burnable(nid)) continue;
      const mult = ctx.cells[nid].terrain === 'park' ? 2 : 1;
      if (ctx.rng.next() < 0.03 * p.intensity! * mult) ignite.push(nid);
    }
  }
  for (const id of ignite) if (!rt.burn.has(id)) rt.burn.set(id, ctx.rng.int(60, 120));
  for (const [id, left] of [...rt.burn]) {
    if (left <= 1) {
      rt.burn.delete(id);
      ctx.layers.destroyed[id] = 1;
    } else rt.burn.set(id, left - 1);
  }
  ev.affected = [...rt.burn.keys()];
  if (rt.burn.size === 0) {
    ev.active = false;
    ev.durationMin = Math.max(1, age);
    ctx.log('info', 'Fire burned out');
  }
}

// ───────────────────────────── grid fault ─────────────────────────────

function advanceFault(rt: DisasterRuntime, ctx: DisasterCtx, age: number): void {
  const ev = rt.ev;
  const id = ev.params.targetId ?? 'generator-0';
  if (age === 0) {
    ctx.tripGenerator(id, ev.startMin + ev.durationMin);
    ctx.log('crit', `Grid fault — ${id} tripped for ${ev.durationMin} min`, id);
  }
  if (age >= ev.durationMin && ev.active) {
    ev.active = false;
    ctx.log('info', `Grid fault cleared — ${id} may restart`, id);
  }
}
