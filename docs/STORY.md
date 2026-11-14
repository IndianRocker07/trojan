# Trojan — making the negotiation visible (build spec)

Goal: a person who has never seen Trojan can open the app, click one button, and *watch* utility agents
negotiate: see each model bid, the intermediate steps, and why every agent got its power — in plain language.

Contracts: `src/core/types.ts` → "Presentation" section (`RoundBid`, `ReplayStage`, `NegotiationReplay`,
`NegotiationEvent`, `FeedMessage`, `ReplayRenderer`) and `NegotiationSnapshot.replays/events/feed`.

User decisions (2026-11-14): Theater view **and** a city overlay; step-through via **replay button + stepper**,
**story-mode auto-pause**, and a **live chat feed** (including the model's raw Jev scores).

## 1. Visual direction (reference image)

Deep navy space background (#050b1f → #0b1440 vignette, no hard gradient bands), a softly glowing blue rim
light, the land rendered as a **dot matrix** (small round dots, lavender/periwinkle #7c83ff→#b9a6ff, brighter
toward the lit side), thin **pink-magenta glowing arcs** (#ff6ad5 core, #ff9be6 glow) flying high between
points, short **cyan/blue vertical light spikes** (#3aa0ff → white tips) rising from points, tiny white sparkle
particles at spike tips, strong bloom on arcs/spikes only, dark terminator shading on one side.

## 2. Negotiation Theater (`src/theater/*`, full-screen view)

- Separate Three.js canvas layered above the city canvas and below the HUD; own render loop only while
  visible; `UnrealBloomPass` for arcs/spikes; reduced-motion: no camera drift, arcs drawn statically.
- **The city as a globe cap**: map the 48×48 grid onto a spherical cap (radius ~R, cap ~70°) so it reads like
  the reference globe. Land/park cells = dots (2–3 dots per cell), roads = gaps, river = darker dotted band,
  destroyed cells = dim coral dots, flooded = faint cyan dots. Slow auto-rotation (paused during a replay
  stage that needs focus); drag to orbit.
- **Agents** = bright points at their building centres; clusters = one point at the members' centroid.
  **Spikes** (vertical light bars) per agent: height ∝ requestKW (log scale), inner brighter segment ∝ granted.
- **Clearing hub** per island = a glowing ring hovering above the island's centroid with the label
  "Island k · 1.8 MW short".
- **Arcs** (pink): bids fly agent → hub (`bid`), shortfall broadcast as expanding ring + thin arcs hub → agents
  (`notice`), concessions agent → hub in a softer violet, contracts giver → receiver (dashed gold), final grants
  hub → agent with thickness ∝ kW (`final`/`commit`), safety corrections = a shield pulse on the hub plus a
  brief red tint on corrected agents (`safety`). Arc progress follows the stepper `progress`.
- **Live mode** (no replay selected): ambient — every few seconds animate the latest replay's bid → grant
  arcs quickly; spikes follow the live snapshot.
- Hover a point → tooltip (name, request, floor, grant, stance). Click → `select` event (UI opens the dossier).
- API (implements `ReplayRenderer`):
  ```ts
  export class TheaterView extends Emitter<{ select: string | null }> implements ReplayRenderer {
    constructor(container: HTMLElement);
    build(s: SimSnapshot): void;   // on start / engine reset
    sync(s: SimSnapshot): void;    // per tick (cheap)
    setVisible(on: boolean): void; isVisible(): boolean;
    showReplay(r: NegotiationReplay | null, stageIndex: number, progress: number): void;
    dispose(): void;
  }
  ```

## 3. City overlay (`src/render/*`, on the existing toon 3D city)

- New layer `'negotiation'` (default ON): pink arcs and blue spikes drawn above the toon city using the same
  palette as the theater (additive, slightly glowing, thin); hub ring above each island in shortage.
- `WorldView.showReplay(r, stage, progress)` (implements `ReplayRenderer`) — same stage semantics as §2.
- Live mode: when no replay is selected, show the latest replay's final grant arcs fading over ~2 s each time a
  new replay arrives. Never more than ~120 arcs; pooled geometry; ≤ 4 extra draw calls.

## 4. App shell & non-expert UX (`src/ui/*`)

1. **Welcome guide** (first visit, remembered in localStorage with try/catch; "?" reopens it): three short
   cards — "A city in a disaster", "Every utility has an AI agent that bids for power", "A safety layer checks
   every decision" — and two buttons: **Start guided demo** / **Explore on my own**.
2. **Guided demo**: loads `compound`, speed 5×, story mode ON, opens the chat feed, then coach marks
   (3–5 small anchored callouts) pointing at the feed, the Theater button, a replay link, a building.
3. **Top bar**: a prominent **Negotiation Theater** toggle (key T) and a **Story mode** switch.
4. **Live chat feed** panel: chat bubbles grouped by minute; avatar = kind icon + colour + name; agent
   messages first-person ("I need 810 kW — ICU 14/16 beds, diesel 3 h left"); chips with the raw model output
   ("Jev urgency 0.82 · damage 0.71 · can concede 12% · conf 0.78" or "Heuristic"); clearing-engine and safety
   messages styled distinctly; each message with a replay link → opens the stepper. Filter: All / My island /
   Concessions / Safety. Auto-scroll unless the user scrolled up.
5. **Replay stepper** (floating, bottom-centre, above the KPI strip): headline; stage pills
   (Perceive · Bids · Clearing · Shortfall · Counter-offers · Contracts · Final · Safety · Commit — only the stages
   present); ◀ Back / ▶ Play-Pause / Next ▶ / speed (0.5×–2×) / close; the stage caption; a compact table of
   the participants at this stage (name, stance chip, request bar vs grant bar, floor tick, score) that updates
   as you step; clicking a row selects the agent. It is the **master clock**: every animation frame it calls
   `renderer.showReplay(replay, stage, progress)` on all registered `ReplayRenderer`s (theater + world).
   Default ~1.2 s per stage. Keyboard: ←/→ step, Space play/pause in the stepper when focused, Esc closes.
6. **Story mode**: when a new `NegotiationEvent` with importance 3 arrives (and story mode is on and no replay
   is open), pause the engine, open its replay and autoplay; when it finishes, resume if the engine was
   running. At most one auto-pause per 45 sim-minutes; a toast lets the user "Skip" or "Turn off story mode".
7. Plain-language everywhere new: no "phase 2" without explanation; tooltips on chips.

`HudOptions` additions (owned by UI, wired in `src/main.ts` by the orchestrator):
```ts
replayRenderers?: ReplayRenderer[];               // theater + world
theater?: { setVisible(on: boolean): void; isVisible(): boolean };
```

## 5. Data production (`src/negotiation/*`)

- Record a `NegotiationReplay` for an island-minute when its regime is not `surplus`, it has ≥ 2 bidders incl.
  ≥ 1 utility negotiator, and either no replay for that island in the last 5 sim-min or a story event fires.
  Stages per §ReplayStageKind using the real round data (round-1 bids, provisional grants, notices, round-2
  counter-offers, contracts, final grants); the `safety` + `commit` stages are filled in `commit()` from the
  audit entries and committed allocation. Keep the last 40.
- Events (keep 100): `shortage_start` (surplus → shortage/triage on an island, importance 3, ≥ 60 sim-min
  since the last one for that island), `triage_start` (3), `big_concession` (≥ 200 kW, or a hospital moving
  onto diesel; 2), `contract` (2), `microgrid` (new generator-less island with bidders; 2), `safety_veto`
  (correction ≥ 50 kW; 2), `recovered` (back to surplus; 1).
- Feed (keep 300), only for recorded replays: one clearing headline; one first-person message per utility
  negotiator whose stance/request changed (≥ 10%) since its last message or ≥ 30 sim-min ago, with perception
  chips; concession and contract messages; safety corrections; a short grant summary for agents below
  request. Text must cite real numbers. Cost: only build text for recorded replays.
- Budget: recording must add < 1 ms per step on average.
