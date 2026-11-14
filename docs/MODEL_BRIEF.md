# Model brief — rules for every 3D component

You are building ONE procedural Three.js model for **Trojan**, a 3D crisis-grid city simulator. The look
is a high-contrast, flat-coloured "toy diorama": cream ground, saturated flat colours, chunky readable
shapes, ink-black details. It must read as a **real, recognisable object** at city zoom and still reward a
close-up.

## Read first (5 minutes, no more)
1. `src/models/kit.ts` — your primitives: `box`, `cyl`, `rod`, `sphere`, `gableRoof`, `hipRoof`,
   `windowGrid`, `railing`, `ladder`, `insulator`, `spin`, `setPowerPorts`, `setOutPorts`, `seeded`.
2. `src/render/palette.ts` — the ONLY materials you may use (`MAT.<name>`, pass the name string to kit helpers).
   If you need a mesh the kit can't make (e.g. `THREE.LatheGeometry`, `THREE.TorusGeometry`), create
   `new THREE.Mesh(geometry, MAT.someName)` yourself — but never create a new material.
3. `src/core/constants.ts` — `CELL = 12` m, `FOOTPRINT` per kind.
4. The anatomy craft philosophy (`C:\Users\cbec\.claude\skills\anatomy\SKILL.md`, sections
   "The one idea that matters" and "Craft rules"). Ignore the SVG/isometric/WebGL mechanics; apply the
   *philosophy* to 3D:
   - **The object is the explanation**: build the real thing the way it is really built.
   - **Highly detailed, purposeful parts**: every door has a step, every roof a parapet/gutter/vent,
     every tank a ladder and railing, every pipe ends on a flange or a wall. No bare faces, no empty corners.
   - **Every part sits on another part.** Nothing floats. Nothing passes through anything visibly wrong.
   - **Tone hierarchy**: base/paving/ground parts in quiet colours (`paving`, `concrete`, `wallSand`),
     structure in its main colour, the ONE subject part (e.g. the red cross, the water tank) in the boldest colour.
   - Before finishing: look at a 2× zoom screenshot and add the real parts missing wherever a region is plain.

## Contract (MUST)
- File exports `export const VARIANTS: number` and `export const build: ModelBuilder` (from `./kit`).
  (Pylon/props files export the specific functions named in your task instead.)
- Return a `THREE.Group`. Origin = centre of the footprint at ground level. **Y up. Front faces +Z.**
- Fit inside the footprint `(w*12) × (d*12)` metres, keeping ≥ 0.8 m margin from the edge.
  A thin lot/paving slab (≤ 0.15 m tall) covering the footprint (minus margin) is encouraged.
- Real-world scale (1 unit = 1 m): a storey ≈ 3.2 m, a door ≈ 2.1 m, a car ≈ 4.2 × 1.8 m.
- Materials ONLY from `MAT`. Windows/lamps/signs that light when powered use `'glow'` (via `windowGrid`
  or `box(..., 'glow')`). Every building needs visible glow parts on at least two sides — that's how the
  user sees power state. Red blinking aviation/warning lights use `'beacon'`.
- Rotating parts (fans, turbines, radar): put them in their own `THREE.Group` and call `spin(group, axis, speed)`.
- Call `setPowerPorts(group, [...])` with the point(s) where the incoming power line attaches: put a
  visible `insulator()` there (on a roof mast, wall bracket or gantry). Height 5–9 m for consumers
  (distribution poles are 9 m tall). Place it near the +Z (front/street) edge.
- Determinism: any randomness via `seeded(opts.seed)`, never `Math.random()`.
- Performance: keep cylinder segments ≤ 16 (≤ 8 for thin rods). Mesh budget given in your task.
  (The renderer merges meshes by material, so many small meshes are fine within budget.)
- Only create/edit YOUR file(s). Do not touch kit.ts, palette.ts or any other file.

## Verify (MUST, iterate at least twice)
1. Type-check: `npx tsc --noEmit` from `D:\orca-projects\trojan`. Fix every error in YOUR file
   (ignore errors in other files — other agents are working in parallel).
2. A Vite dev server should already be on `http://localhost:5173`. Check with
   `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/models.html`. If it is not 200, start
   your own on another port in the background: `npx vite --port 51xx --strictPort` and use that port.
3. Screenshot (takes ~20 s):
   `node scripts/shot.mjs "http://localhost:5173/models.html?kind=<kind>" shots/<kind>-a.png 1400 900`
   Also `&az=215` (back view), `&zoom=2.2` (close-up) and `&el=60` (top-down-ish, how the city camera sees it).
   Then **open each PNG with the Read tool and look at it critically**. Blue balls = your power ports.
4. Fix: floating parts, parts sunk through walls, empty faces, unreadable silhouette, ports in wrong place.
5. Final message: list of variants, approx mesh count per variant, port positions, anything you could not do.
