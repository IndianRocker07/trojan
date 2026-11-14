/** Grid & world dimensions. See SPEC.md §3. */
export const GRID_COLS = 48;
export const GRID_ROWS = 48;
/** Metres per cell side. */
export const CELL = 12;
export const WORLD_W = GRID_COLS * CELL;
export const WORLD_D = GRID_ROWS * CELL;
export const HALF_W = WORLD_W / 2;
export const HALF_D = WORLD_D / 2;
/** Every BLOCK-th column/row (index % BLOCK === 0) is a road. City blocks are (BLOCK-1)² cells. */
export const BLOCK = 6;

/** Scenario length and clock. */
export const SCENARIO_MINUTES = 12 * 60;
export const SIM_STEP_MIN = 1; // engine integrates in 1-minute steps
export const DEFAULT_SPEED = 10; // sim minutes per real second
export const HISTORY_LEN = 720;
export const LOG_LEN = 200;

/** Footprints in cells (w along X, d along Z) per building kind. */
export const FOOTPRINT = {
  house: { w: 1, d: 1 },
  telecom: { w: 1, d: 1 },
  substation: { w: 2, d: 2 },
  emergency: { w: 2, d: 2 },
  water: { w: 2, d: 2 },
  school: { w: 3, d: 2 },
  hospital: { w: 3, d: 3 },
  generator: { w: 3, d: 3 },
} as const;

/** Support heights (m) and spacing for rendered lines. */
export const PYLON_HEIGHT = 26;
export const POLE_HEIGHT = 9;
export const PYLON_SPACING_CELLS = 4;
export const POLE_SPACING_CELLS = 2;

export const cellId = (col: number, row: number) => row * GRID_COLS + col;
export const cellCol = (id: number) => id % GRID_COLS;
export const cellRow = (id: number) => Math.floor(id / GRID_COLS);
/** World X/Z of a cell's centre. */
export const cellCenter = (col: number, row: number) => ({
  x: (col + 0.5) * CELL - HALF_W,
  z: (row + 0.5) * CELL - HALF_D,
});
/** Cell containing a world point (clamped). */
export const worldToCell = (x: number, z: number) => ({
  col: Math.min(GRID_COLS - 1, Math.max(0, Math.floor((x + HALF_W) / CELL))),
  row: Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((z + HALF_D) / CELL))),
});

/** Scenario clock starts at 16:00 local time. */
export const START_HOUR = 16;

/** Water mains are buried this deep (m, negative = below ground). */
export const WATER_PIPE_DEPTH = -2.5;
