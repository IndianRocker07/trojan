# Trojan — AI agents negotiating power in a city disaster

When a disaster hits a city, there is not enough electricity for everyone. In Trojan, every hospital, water
pump, fire station, phone tower and shelter has its own **AI agent** that explains what it needs and bids for
power. A clearing engine shares the power by **need, not wealth**, and an independent **safety layer** checks
every decision before it is switched on.

## Run it (2 minutes)

You need [Node.js 22+](https://nodejs.org).

```bash
npm install
npm run dev
```

Open the link it prints (usually http://localhost:5173) and click **Start guided demo**. That's it.

### Optional: use the real AI model (TypeSafe Jev)

Without a key the agents use a built-in rule of thumb, so everything still works. To let the agents think with
the Jev model:

1. Copy `.env.example` to `.env.local`
2. Put your key after `TYPESAFE_API_KEY=`
3. Restart `npm run dev`

The key stays on your machine's dev server (`/api/jev`); it is never sent to the browser. Feed messages and
replays show a **Jev** badge when the model answered and **Heuristic** when the fallback was used.

## What you can do in the app

| Do this | To see |
|---|---|
| **Start guided demo** (welcome screen, or the **?** button) | A compound crisis plays with story mode on and hints that point at each feature |
| **Theater** button (key **T**) | The negotiation as a glowing globe: bids fly to the island's clearing hub, power flows back |
| **Live negotiation** tab (left) | A chat of every agent's bid in plain words, with the model's raw scores |
| **▶ replay** on any message | Step through one negotiation: bids → clearing → shortfall → counter-offers → final → safety check |
| **Story** switch | The simulation pauses by itself at important moments and plays the replay |
| Click any building | Its dossier: how it is affected, its bid, its history, and *why it got this much power* |
| **Disasters** tab | Place an earthquake, flood, cyclone, fire or grid fault yourself |
| **Engine** menu | Compare the negotiation against a simple baseline, with and without the safety layer |

Handy links: `/?scenario=compound&t=300&theater=1&replay=latest` jumps straight into a replay on the globe.
`?jev=0` forces the built-in heuristic; `?welcome=1` shows the welcome screen again.

## For developers

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript checks (browser + Node parts) |
| `npm test` | Simulation smoke test, negotiation tests, safety tests incl. adversarial fuzzing (~6 min) |
| `npm run bench` | Compares baseline, negotiation and a damage-optimal oracle across scenarios and seeds (~16 min) |
| `npx tsx scripts/jev-probe.ts` | Checks that your Jev key works |

Docs: `PROJECT.md` (what & why), `PRD.md` (requirements), `SPEC.md` (technical), `docs/NEGOTIATION.md`
(agents, auction, safety), `docs/MICROGRID.md` (prosumers & islands), `docs/STORY.md` (visualisation),
`agent_prompt.md` (need-based rules).
