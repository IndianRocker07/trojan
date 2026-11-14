# DESIGN.md — Trojan UI & scene look

## 1. Direction
Base style **Friendly Illustrated** (design-selector library), app-UI adaptation, tweaked by the user to
**high-contrast colours** and **8 px corner radius**, full motion. It's a warm, optimistic,
toy-diorama control room. Cream canvas, white cards with **2 px near-black ink borders**, saturated flat
colour blocks, chunky tight type. A crisis tool that stays calm and human, with no dark-mode
"war room" clichés. Text contrast targets WCAG **AAA (7:1)** for body text and AA minimum everywhere.

## 2. Principles
- **The city is the hero.** UI floats on the 3D view as crisp white cards. Panels never cover more than
  ~35% of the viewport on desktop.
- **Colour = meaning, in flat blocks.** Green = powered/good, yellow = backup/attention, orange =
  brownout/overload, coral/red = offline/destroyed, blue = water/flood/transmission, lilac = telecom.
  The same mapping is used in 3D (glow, lines, overlays) and in the UI.
- **Ink everywhere.** 2 px ink borders on cards, buttons, chips and inputs; ink outlines on 3D
  buildings. No soft grey hairlines, no gradients, no blurred drop shadows. Only the hard offset
  shadow `0 4px 0 0 ink` on raised elements.
- **Big numbers.** KPI numerals are large and tight (40–56 px), labels small and sentence-case.
- **Pop motion.** Buttons lift and tilt slightly on hover with an overshoot ease; status changes pop.

## 3. Tokens (resolved, wired as CSS custom properties in `src/ui/styles.css`)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#fbf6e6` | canvas / page |
| `--surface` | `#ffffff` | cards, panels |
| `--surface-2` | `#f3ead0` | inset wells, table stripes |
| `--ink` | `#121310` | text, borders, outlines (17.9:1 on bg) |
| `--muted` | `#3d3f38` | secondary text (9.8:1 on white) |
| `--border` | `#121310` | 2 px borders |
| `--accent` | `#5fc52e` | primary button, selected pill, progress, "online" |
| `--accent-ink` | `#121310` | text on accent |
| `--green-deep` | `#2f8f1c` | positive text on white |
| `--yellow` | `#ffd60a` | backup / attention chips |
| `--orange` | `#ff8a00` | brownout / overload |
| `--coral` | `#ff4a2e` | offline / destroyed blocks (with ink text) |
| `--red` | `#e5141f` | critical alerts (white text 4.9:1, use bold) |
| `--blue` | `#0a7cff` | water, flood, transmission |
| `--lilac` | `#a77bff` | telecom |
| `--pink` | `#ff7aa8` | shelters/schools |
| `--radius` | `8px` | cards, buttons, inputs (pills keep `999px`) |
| `--border-w` | `2px` | |
| `--shadow` | `0 4px 0 0 var(--ink)` | raised cards/buttons |
| `--font-display` | `'Inter Tight', Inter, system-ui` 600, tracking −0.04em, lh .95 | numerals, titles |
| `--font-body` | `Inter` 500, 15–17 px (app density), tracking −0.01em, lh 1.45 | |
| `--font-mono` | `'JetBrains Mono'` 500 | telemetry numbers, clock |
| `--ease` | `cubic-bezier(.5,0,0,1)` | panels |
| `--pop` | `cubic-bezier(.17,.67,.3,1.33)` | buttons, chips, status changes |
| `--dur` | `260ms` | (× `--motion`, 0 for reduced motion) |

Status → colour (UI and 3D): `online` green · `brownout` orange · `backup` yellow · `offline` coral ·
`destroyed` ink fill with coral text.

Fonts: Google Fonts `Inter Tight 500;600`, `Inter 400;500;600;700`, `JetBrains Mono 500`.

## 4. Typography, layout, components
- **Type scale (app)**: 12 (micro labels, mono), 14, 16 (body), 20 (panel titles), 28, 44 (KPI numerals),
  56 (hero numeral). Sentence case everywhere; no letter-spaced caps.
- **Layout**: floating top bar (centred pill, 56 px, 14 px from top); left rail 300 px; right inspector
  360 px; bottom strip 168 px. 12 px gaps, 16 px panel padding. Everything sits on the 3D canvas with
  12 px margins. Collapsible panels (chevron) so the city can go full-screen.
- **Cards**: white, 2 px ink border, 8 px radius, hard offset shadow. Title row: 20 px display + chip.
- **Buttons**: 40 px tall (app), 8 px radius, 2 px ink border. Primary = green fill + ink text;
  secondary = white; danger = coral. Hover: `translateY(-2px) rotate(-1deg)` with `--pop`; active
  `scale(.96)` and shadow collapses to 0.
- **Chips / status pills**: pill radius, 2 px ink border, flat fill by status, 13 px 600 text.
- **Segmented control** (speed): ink outline, selected = ink fill with cream text.
- **Sliders**: thick 6 px ink track, green fill, 18 px white thumb with ink border.
- **Tables (telemetry)**: rows inside the card, 10 px row padding, alternating `--surface-2`, mono
  right-aligned numbers, sparkline (ink line, green last point) in the last column.
- **Power bar**: 18 px tall, ink border; fill = allocated (status colour), hatched part = backup,
  vertical ink tick at minSafe, demand = full width.
- **Charts**: canvas, ink axes, supply line ink 2 px, demand dashed blue, allocated green area.
- **Map labels** (`.map-label`): white pill, 2 px ink border, 12 px 600 text, status dot left.
- **Empty state** (no selection): one small flat cartoon character (a utility worker with a hard hat,
  noodle arms) with "Click any building to inspect its agent". Only place a character appears.

## 5. Imagery & 3D
The 3D city is the illustration: flat toon shading (3-step ramp), saturated palette (`src/render/
palette.ts`), ink outlines, cream ground. No photo textures, no PBR. Night = deep blue ambient so lit
(glow) windows pop. Disaster overlays use the status colours (coral hatch, translucent blue water,
orange fire).

## 6. Motion
Panels slide/fade 260 ms `--ease`; buttons/chips pop. KPI numbers tween. Status changes on chips pop
(scale 1 → 1.12 → 1). `prefers-reduced-motion`: no camera shake, no tweening, no pops, FX static.

## 7. Do / Don't
**Do**: 2 px ink borders, flat fills, big tight numerals, status colours used identically in 3D and UI,
mono for telemetry numbers, keyboard shortcuts shown as ink-bordered key chips.
**Don't**: gradients, blurred shadows, grey hairlines, thin outline icons, ALL-CAPS labels, text on
coral smaller than 14 px bold, more than one cartoon character on screen, panels covering the city.

## 8. Stack
Plain TS + DOM, CSS custom properties in `src/ui/styles.css`, no UI framework. Charts and sparklines:
hand-written `<canvas>`. Icons: inline SVG with 2 px ink strokes and flat fills (no thin outline icons).
