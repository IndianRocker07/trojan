/**
 * Dev-only stand-in for SimEngine: real city + real power network from src/sim, with fake flows and a very
 * rough disaster model, so the view can be developed and screenshotted without the engine.
 */
import { Rng } from '../core/rng';
import { CELL, GRID_COLS, GRID_ROWS, cellCenter } from '../core/constants';
import type { DisasterEvent, DisasterKind, DisasterParams, SimSnapshot } from '../core/types';
import { generateCity } from '../sim/cityGen';
import { buildNetwork } from '../sim/powerNetwork';

const wmods = import.meta.glob('../sim/waterNetwork.ts', { eager: true }) as Record<string, any>;

export class FixtureEngine {
  snapshot: SimSnapshot;
  private rng: Rng;
  private acc = 0;
  speed = 10;
  running = true;

  constructor(seed = 7) {
    this.rng = new Rng(seed + 1);
    const { cells, buildings } = generateCity(seed);
    const network = buildNetwork(cells, buildings, new Rng(seed));
    const r = new Rng(seed + 5);
    for (const b of Object.values(buildings)) {
      b.status = 'online';
      if (b.kind === 'house' && r.chance(0.08)) b.status = 'offline';
      if (b.kind === 'house' && r.chance(0.04)) b.status = 'backup';
      if (b.kind === 'house' && r.chance(0.05)) b.status = 'brownout';
    }
    for (const e of Object.values(network.edges)) {
      e.flowKW = e.capacityKW * (e.tier === 'transmission' ? 0.3 + r.next() * 0.5 : 0.04 + r.next() * 0.5);
    }
    this.snapshot = {
      tMin: 0,
      running: true,
      speed: 10,
      cells,
      buildings,
      agents: {},
      generators: {},
      network,
      water: (Object.values(wmods)[0]?.buildWaterNetwork?.(cells, buildings, new Rng(seed)) ?? { nodes: {}, pipes: {}, services: {} }) as SimSnapshot['water'],
      disasters: [],
      metrics: { supplyKW: 0, demandKW: 0, allocatedKW: 0, servedPct: 1, criticalUnservedKW: 0, cumulativeDamage: 0, buildingsOffline: 0, cellsDestroyed: 0 },
      history: [],
      log: [],
    };
  }

  update(realDt: number): void {
    this.acc += realDt * this.speed;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.step();
    }
  }

  step(): void {
    const s = this.snapshot;
    s.tMin++;
    // fire spread
    for (const c of s.cells) {
      if (c.status !== 'burning') continue;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const col = c.col + dc;
        const row = c.row + dr;
        if (col < 0 || row < 0 || col >= GRID_COLS || row >= GRID_ROWS) continue;
        const n = s.cells[row * GRID_COLS + col];
        if (n.status === 'ok' && n.terrain !== 'river' && n.terrain !== 'road' && this.rng.chance(0.03)) n.status = 'burning';
      }
    }
    s.disasters.forEach((d) => {
      if (s.tMin - d.startMin > d.durationMin) d.active = false;
    });
    this.refresh();
  }

  /** Re-derive node / edge / building state from cell statuses. */
  private refresh(): void {
    const s = this.snapshot;
    for (const n of Object.values(s.network.nodes)) n.alive = s.cells[n.cell].status === 'ok' || s.cells[n.cell].status === 'flooded';
    for (const e of Object.values(s.network.edges)) e.status = e.cells.some((id) => s.cells[id].status === 'destroyed' || s.cells[id].status === 'burning') ? 'broken' : 'ok';
    for (const b of Object.values(s.buildings)) if (b.cells.some((id) => s.cells[id].status === 'destroyed')) b.status = 'destroyed';
    s.metrics.cellsDestroyed = s.cells.filter((c) => c.status === 'destroyed').length;
  }

  trigger(kind: DisasterKind, params: DisasterParams): DisasterEvent {
    const s = this.snapshot;
    const ev: DisasterEvent = {
      id: `${kind}-${s.disasters.length + 1}`,
      kind,
      startMin: s.tMin,
      durationMin: kind === 'earthquake' ? 1 : kind === 'flood' ? 360 : 240,
      params,
      affected: [],
      active: true,
    };
    const col = params.col ?? 24;
    const row = params.row ?? 24;
    const I = params.intensity ?? 0.8;
    if (kind === 'earthquake') {
      const R = params.radius ?? 8;
      for (const c of s.cells) {
        const d = Math.hypot(c.col - col, c.row - row);
        if (d < R && this.rng.chance(I * Math.pow(1 - d / R, 0.7))) c.status = 'destroyed';
      }
      ev.active = false;
    } else if (kind === 'fire') {
      const c = s.cells[row * GRID_COLS + col];
      if (c.terrain !== 'river') c.status = 'burning';
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1]]) {
        const n = s.cells[(row + dr) * GRID_COLS + col + dc];
        if (n && n.terrain !== 'river') n.status = 'burning';
      }
    } else if (kind === 'flood') {
      for (const c of s.cells) if (c.terrain !== 'river' && c.elevation < 0.2 + 0.45 * I) c.status = 'flooded';
    } else if (kind === 'cyclone') {
      ev.params = { heading: Math.PI * 0.75, speed: 6, radius: 5, ...params };
    }
    s.disasters.push(ev);
    this.refresh();
    return ev;
  }

  randomSpot(): { col: number; row: number } {
    return { col: this.rng.int(8, 40), row: this.rng.int(8, 40) };
  }
}

export { CELL, cellCenter };
