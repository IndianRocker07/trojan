/**
 * City generation — SPEC §3. Pure TypeScript, deterministic per seed.
 *
 * Conventions (the render agent relies on these):
 *  - Building.col/row = min corner of the cells the building ACTUALLY occupies.
 *  - Building.w/d = FOOTPRINT (model space, before rotation). For odd rotations (1,3) the occupied
 *    rectangle is d cells wide (X) and w cells deep (Z). Building.cells is authoritative.
 *  - rotation r means the front (+Z in model space) faces: 0 = +Z (south), 1 = +X (east),
 *    2 = -Z (north), 3 = -X (west)  i.e. Three.js rotation.y = r * PI/2.
 */
import { BLOCK, FOOTPRINT, GRID_COLS, GRID_ROWS, cellId } from '../core/constants';
import { Rng } from '../core/rng';
import type { Building, BuildingKind, GridCell, Rotation } from '../core/types';

const N = GRID_COLS * GRID_ROWS;
const BLOCKS = GRID_COLS / BLOCK; // 8

interface Cand {
  col: number;
  row: number;
  ew: number; // occupied width (cells, X)
  ed: number; // occupied depth (cells, Z)
  rot: Rotation;
  cx: number; // centre in cell units
  cy: number;
  bc: number;
  br: number;
}

export interface CityGenInfo {
  /** river west-most column per row */
  riverMin: number[];
}

const lastInfo = new WeakMap<GridCell[], CityGenInfo>();
/** Helper for other modules (names / districts) — returns info about a generated city, if known. */
export function cityInfo(cells: GridCell[]): CityGenInfo | undefined {
  return lastInfo.get(cells);
}

export function districtOf(riverMin: number[], col: number, row: number): string {
  const rc = riverMin[row] + 1; // boundary between the two river columns
  const x = col + 0.5;
  if (Math.abs(x - rc) <= 4.5) return 'Riverside';
  const side = x < rc ? 'Westbank' : 'Eastbank';
  return `${side} ${row < GRID_ROWS / 2 ? 'N' : 'S'}`;
}

export function generateCity(seed: number): { cells: GridCell[]; buildings: Record<string, Building> } {
  const rng = new Rng(seed);
  const cells: GridCell[] = new Array(N);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const road = c % BLOCK === 0 || r % BLOCK === 0;
      cells[cellId(c, r)] = {
        id: cellId(c, r),
        col: c,
        row: r,
        terrain: road ? 'road' : 'land',
        elevation: 1,
        status: 'ok',
      };
    }
  }

  // ── River: meandering 2-wide band, north–south ──
  const p1 = rng.range(0, 6.28);
  const p2 = rng.range(0, 6.28);
  const riverMin: number[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    const c = 30 + 3 * Math.sin(r / 7 + p1) + 1.1 * Math.sin(r / 2.9 + p2);
    const c0 = Math.max(24, Math.min(34, Math.floor(c)));
    riverMin.push(c0);
    for (const cc of [c0, c0 + 1]) {
      const cell = cells[cellId(cc, r)];
      cell.terrain = r % BLOCK === 0 ? 'bridge' : 'river';
    }
  }

  // ── Elevation ──
  const riverCells = cells.filter((c) => c.terrain === 'river' || c.terrain === 'bridge');
  for (const cell of cells) {
    if (cell.terrain === 'river') {
      cell.elevation = 0;
      continue;
    }
    let best = Infinity;
    for (const rv of riverCells) {
      const d = Math.hypot(rv.col - cell.col, rv.row - cell.row);
      if (d < best) best = d;
    }
    const e = Math.min(1, best / 18) + rng.range(-0.025, 0.025);
    cell.elevation = Math.max(cell.terrain === 'bridge' ? 0.03 : 0.02, Math.min(1, e));
  }
  const riverDist = new Float32Array(N);
  for (const cell of cells) {
    let best = Infinity;
    for (const rv of riverCells) {
      const d = Math.hypot(rv.col - cell.col, rv.row - cell.row);
      if (d < best) best = d;
    }
    riverDist[cell.id] = best;
  }

  // ── Parks: 3–5 whole blocks without river ──
  const blockHasRiver = (bc: number, br: number) => {
    for (const cc of blockCells(bc, br)) if (cells[cc].terrain === 'river' || cells[cc].terrain === 'bridge') return true;
    return false;
  };
  const parkBlocks: Array<[number, number]> = [];
  const nParks = rng.int(3, 5);
  for (let tries = 0; tries < 200 && parkBlocks.length < nParks; tries++) {
    const bc = rng.int(0, BLOCKS - 1);
    const br = rng.int(1, BLOCKS - 2);
    if (blockHasRiver(bc, br)) continue;
    // keep blocks near the map edge for generators free, and parks apart from each other
    if (bc === 0 || bc === BLOCKS - 1) continue;
    if (parkBlocks.some(([a, b]) => Math.abs(a - bc) <= 1 && Math.abs(b - br) <= 1)) continue;
    parkBlocks.push([bc, br]);
  }
  for (const [bc, br] of parkBlocks) for (const cc of blockCells(bc, br)) if (cells[cc].terrain === 'land') cells[cc].terrain = 'park';

  // ── Buildings ──
  const buildings: Record<string, Building> = {};
  const counters: Record<string, number> = {};

  function blockCells(bc: number, br: number): number[] {
    const out: number[] = [];
    for (let r = br * BLOCK + 1; r <= Math.min(GRID_ROWS - 1, br * BLOCK + 5); r++)
      for (let c = bc * BLOCK + 1; c <= Math.min(GRID_COLS - 1, bc * BLOCK + 5); c++) out.push(cellId(c, r));
    return out;
  }

  const isFree = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= GRID_COLS || r >= GRID_ROWS) return false;
    const cell = cells[cellId(c, r)];
    return cell.terrain === 'land' && cell.buildingId === undefined;
  };

  /** Rotation that makes a rectangle's front face its nearest existing road side. */
  function sideDists(bc: number, br: number, col: number, row: number, ew: number, ed: number) {
    const r0 = br * BLOCK + 1;
    const c0 = bc * BLOCK + 1;
    const south = br + 1 <= 7 ? br * BLOCK + 5 - (row + ed - 1) : Infinity; // road at (br+1)*6 exists if <=42
    const east = bc + 1 <= 7 ? bc * BLOCK + 5 - (col + ew - 1) : Infinity;
    return [south, east, row - r0, col - c0]; // indexed by rotation 0..3
  }

  function candidates(kind: BuildingKind, blockOk?: (bc: number, br: number) => boolean): Cand[] {
    const fp = FOOTPRINT[kind];
    const out: Cand[] = [];
    for (let br = 0; br < BLOCKS; br++) {
      for (let bc = 0; bc < BLOCKS; bc++) {
        if (blockOk && !blockOk(bc, br)) continue;
        const c1 = Math.min(GRID_COLS - 1, bc * BLOCK + 5);
        const r1 = Math.min(GRID_ROWS - 1, br * BLOCK + 5);
        for (let rot = 0 as Rotation; rot < 4; rot = (rot + 1) as Rotation) {
          const odd = rot % 2 === 1;
          const ew = odd ? fp.d : fp.w;
          const ed = odd ? fp.w : fp.d;
          for (let row = br * BLOCK + 1; row + ed - 1 <= r1; row++) {
            for (let col = bc * BLOCK + 1; col + ew - 1 <= c1; col++) {
              let ok = true;
              for (let y = 0; y < ed && ok; y++) for (let x = 0; x < ew; x++) if (!isFree(col + x, row + y)) { ok = false; break; }
              if (!ok) continue;
              const d = sideDists(bc, br, col, row, ew, ed);
              const m = Math.min(...d);
              if (d[rot] !== m) continue;
              out.push({ col, row, ew, ed, rot, cx: col + ew / 2, cy: row + ed / 2, bc, br });
            }
          }
        }
      }
    }
    return out;
  }

  const placed: Building[] = [];
  function place(kind: BuildingKind, cand: Cand, variant: number): Building {
    const n = (counters[kind] = (counters[kind] ?? -1) + 1);
    const id = `${kind}-${n}`;
    const fp = FOOTPRINT[kind];
    const ids: number[] = [];
    for (let y = 0; y < cand.ed; y++) for (let x = 0; x < cand.ew; x++) ids.push(cellId(cand.col + x, cand.row + y));
    const b: Building = {
      id,
      kind,
      name: id,
      col: cand.col,
      row: cand.row,
      w: fp.w,
      d: fp.d,
      rotation: cand.rot,
      variant,
      cells: ids,
      nodeId: '',
      status: 'online',
    };
    for (const cid of ids) cells[cid].buildingId = id;
    buildings[id] = b;
    placed.push(b);
    return b;
  }

  /** Choose the best candidate by score (+ tiny jitter for determinism-safe variety). */
  function pick(kind: BuildingKind, score: (c: Cand) => number, blockOk?: (bc: number, br: number) => boolean): Cand {
    const list = candidates(kind, blockOk);
    if (list.length === 0) throw new Error(`cityGen: no room for ${kind}`);
    let best = list[0];
    let bs = -Infinity;
    for (const c of list) {
      const s = score(c) + rng.range(0, 0.05);
      if (s > bs) {
        bs = s;
        best = c;
      }
    }
    return best;
  }
  const dTo = (c: Cand, x: number, y: number) => Math.hypot(c.cx - x, c.cy - y);
  const rd = (c: Cand) => riverDist[cellId(Math.floor(c.cx), Math.floor(c.cy))];

  // generators: west thermal, east solar+battery
  place('generator', pick('generator', (c) => -(Math.abs(c.cx - 3) + Math.abs(c.cy - 22) * 0.35)), 0);
  place('generator', pick('generator', (c) => -(Math.abs(c.cx - 45.5) + Math.abs(c.cy - 27) * 0.35)), 1);

  // substations: 4 west of the river, 2 east
  const subTargets: Array<[number, number]> = [[8, 10], [8, 36], [21, 14], [21, 38], [40, 12], [40, 36]];
  subTargets.forEach(([tx, ty], i) => place('substation', pick('substation', (c) => -dTo(c, tx, ty)), i % 2));

  // hospitals: riverside, west-north, east-south
  place('hospital', pick('hospital', (c) => -rd(c) - Math.abs(c.cy - 24) * 0.25), 0);
  place('hospital', pick('hospital', (c) => -dTo(c, 12, 16)), 1);
  place('hospital', pick('hospital', (c) => -dTo(c, 40, 32)), 0);

  // emergency stations: spread, never adjacent to hospitals
  const hospitals = placed.filter((b) => b.kind === 'hospital');
  const nearHospital = (c: Cand) =>
    hospitals.some((h) => {
      const hw = h.cells.length === 9 ? 3 : 3;
      const hc = h.col;
      const hr = h.row;
      return c.col < hc + hw + 2 && c.col + c.ew > hc - 2 && c.row < hr + hw + 2 && c.row + c.ed > hr - 2;
    });
  const emTargets: Array<[number, number]> = [[16, 19], [39, 21], [14, 41]];
  emTargets.forEach(([tx, ty], i) =>
    place('emergency', pick('emergency', (c) => (nearHospital(c) ? -1e6 : -dTo(c, tx, ty))), i % 2),
  );

  // schools in residential districts
  const schoolTargets: Array<[number, number]> = [[5, 26], [24, 5], [41, 22], [22, 31]];
  schoolTargets.forEach(([tx, ty], i) => place('school', pick('school', (c) => -dTo(c, tx, ty)), i % 2));

  // water: intake by the river, two on high ground
  place('water', pick('water', (c) => -rd(c) - Math.abs(c.cy - 14) * 0.2), 0);
  place('water', pick('water', (c) => rd(c) * 0.8 - dTo(c, 6, 34) * 0.5), 1);
  place('water', pick('water', (c) => rd(c) * 0.8 - dTo(c, 40, 30) * 0.5), 1);

  // telecom: farthest-point sampling over free land cells, mild centre bias
  const towers: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) {
    const t = pick('telecom', (c) => {
      const centreBias = -0.25 * dTo(c, 24, 24);
      if (towers.length === 0) return -dTo(c, 10, 10);
      let m = Infinity;
      for (const [x, y] of towers) m = Math.min(m, Math.hypot(c.cx - x, c.cy - y));
      return m + centreBias;
    });
    towers.push([t.cx, t.cy]);
    place('telecom', t, i % 2);
  }

  // houses: ~65% of remaining land cells
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isFree(c, r)) continue;
      if (!rng.chance(0.65)) continue;
      const bc = Math.min(BLOCKS - 1, Math.floor(c / BLOCK));
      const br = Math.min(BLOCKS - 1, Math.floor(r / BLOCK));
      const d = sideDists(bc, br, c, r, 1, 1);
      const m = Math.min(...d);
      const opts: Rotation[] = [];
      for (let k = 0 as Rotation; k < 4; k = (k + 1) as Rotation) if (d[k] === m) opts.push(k);
      const rot = rng.pick(opts);
      place('house', { col: c, row: r, ew: 1, ed: 1, rot, cx: c + 0.5, cy: r + 0.5, bc, br }, rng.int(0, 3));
    }
  }

  // ── Names ──
  const used = new Set<string>();
  const uniq = (s: string) => {
    let n = s;
    let i = 2;
    while (used.has(n)) n = `${s} ${i++}`;
    used.add(n);
    return n;
  };
  const dist = (b: Building) => districtOf(riverMin, b.col + Math.floor(Math.sqrt(b.cells.length) / 2), b.row);
  const hospNames: Record<string, string[]> = {
    Riverside: ['Riverside General Hospital', 'Riverbend Medical Center'],
    Westbank: ['Westbank Medical Center', "St. Mary General Hospital", 'Westgate Clinic Hospital'],
    Eastbank: ['Eastbank Memorial Hospital', 'Eastview Regional Hospital', 'Hillside Hospital'],
  };
  const schoolNames = ['Oakridge', 'Maple Grove', 'Hillcrest', 'Lakeview', 'Cedar Park', 'Willow Creek'];
  let si = 0;
  let wi = 0;
  let ei = 0;
  let subi = 0;
  let ti = 0;
  let hi = 0;
  for (const b of placed) {
    const dn = dist(b);
    const bank = dn.split(' ')[0];
    switch (b.kind) {
      case 'generator':
        b.name = b.variant === 0 ? 'Westbank Thermal Plant' : 'Eastbank Solar Farm';
        break;
      case 'substation':
        b.name = `Substation S${++subi}`;
        break;
      case 'hospital':
        b.name = uniq(hospNames[bank]?.[0] ?? 'City General Hospital');
        hospNames[bank]?.shift();
        break;
      case 'emergency':
        b.name = `Station ${++ei} — Fire & Rescue`;
        break;
      case 'school':
        b.name = `${schoolNames[si++ % schoolNames.length]} School (Shelter)`;
        break;
      case 'water': {
        const first = wi++ === 0;
        b.name = first ? 'Riverside Water Intake' : `${bank === 'Westbank' ? 'Hilltop' : 'Eastbank'} ${dn.endsWith('N') ? 'Northside' : 'Southside'} Pump Station`;
        b.name = uniq(b.name);
        break;
      }
      case 'telecom':
        b.name = `Tower T-${String(++ti).padStart(2, '0')}`;
        break;
      case 'house':
        b.name = `House ${++hi}`;
        break;
    }
  }

  lastInfo.set(cells, { riverMin });
  return { cells, buildings };
}
