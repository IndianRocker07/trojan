/**
 * Mock replays / events / feed for the UI test page (docs/STORY.md). Dev only. Mimics the shapes the negotiation policy
 * will produce: every ReplayStageKind, 8-12 participants including household clusters, Jev + heuristic perceptions.
 */
import type {
  AgentDossier,
  ConsumerKind,
  FeedMessage,
  NegotiationEvent,
  NegotiationReplay,
  NegotiationSnapshot,
  ReplayStage,
  RoundBid,
  SimSnapshot,
  Stance,
} from '../core/types';

const kw = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} MW` : `${Math.round(n)} kW`);
const r1 = (n: number) => Math.round(n * 10) / 10;

interface P {
  id: string;
  name: string;
  kind: ConsumerKind;
  buildingIds: string[];
  orig: number;
  floor: number;
  crit: number;
  urgency: number;
  damage: number;
  risk: number;
  canConcede: number;
  conf: number;
  source: 'jev' | 'heuristic';
  stance: Stance;
  conceded: number;
  score: number;
  tele: Record<string, number>;
}

/** Floors first (by score when there is not enough), then the rest by score x need, capped at the request. */
function clear(ps: { id: string; req: number; floor: number; score: number }[], supply: number) {
  const p1: Record<string, number> = {};
  const sumFloor = ps.reduce((n, p) => n + Math.min(p.floor, p.req), 0);
  let left = supply;
  if (supply >= sumFloor) {
    for (const p of ps) p1[p.id] = Math.min(p.floor, p.req);
    left = supply - sumFloor;
  } else {
    for (const p of [...ps].sort((a, b) => b.score - a.score)) {
      const g = Math.min(Math.min(p.floor, p.req), left);
      p1[p.id] = g;
      left -= g;
    }
    left = 0;
  }
  const g: Record<string, number> = { ...p1 };
  for (let pass = 0; pass < 4 && left > 0.5; pass++) {
    const open = ps.filter((p) => g[p.id] < p.req - 0.5);
    const wsum = open.reduce((n, p) => n + (p.req - g[p.id]) * (0.3 + p.score), 0);
    if (!wsum) break;
    let used = 0;
    for (const p of open) {
      const add = Math.min(p.req - g[p.id], (left * (p.req - g[p.id]) * (0.3 + p.score)) / wsum);
      g[p.id] += add;
      used += add;
    }
    left -= used;
  }
  for (const k of Object.keys(g)) g[k] = r1(g[k]);
  for (const k of Object.keys(p1)) p1[k] = r1(p1[k]);
  return { grants: g, phase1: p1 };
}

function lines(p: P, req: number): string {
  const t = p.tele;
  switch (p.kind) {
    case 'hospital':
      return `I need ${kw(req)}. ICU ${Math.round(t.icuPatients ?? 12)}/${Math.round(t.icuBeds ?? 24)} beds are full, ${Math.round(t.ventilatorsInUse ?? 9)} ventilators running, diesel ${Math.round(t.backupFuelHours ?? 8)} h left.`;
    case 'emergency':
      return `Dispatch needs ${kw(req)}: ${Math.round(t.activeIncidents ?? 2)} incidents open, ${Math.round(t.callsPerHour ?? 12)} calls an hour.`;
    case 'water':
      return `Pumps need ${kw(req)} to hold pressure. Reservoir at ${Math.round((t.reservoirPct ?? 0.8) * 100)}% and the hospital downstream depends on it.`;
    case 'telecom':
      return `Emergency calls route through me. I ask ${kw(req)}; battery is at ${Math.round((t.batteryPct ?? 1) * 100)}%.`;
    case 'school':
      return `${Math.round(t.sheltered ?? 40)} people are sheltering here, ${Math.round(t.medicalCases ?? 1)} with medical needs. I ask ${kw(req)}.`;
    default:
      return `${p.buildingIds.length} homes together ask ${kw(req)}. We can shed about ${Math.round(p.canConcede * 100)}% of flexible load.`;
  }
}

export interface MockStory {
  replay: NegotiationReplay;
  events: NegotiationEvent[];
  feed: FeedMessage[];
}

/** variant 0 = shortage (about 70% supply), 1 = triage (below the sum of floors), 2 = mild shortage. */
export function buildStory(s: SimSnapshot, neg: Pick<NegotiationSnapshot, 'agents'>, t: number, islandId: number, variant: number, firstForIsland: boolean): MockStory {
  const id = `${t}:${islandId}`;
  const dossiers = Object.values(neg.agents) as AgentDossier[];
  const cand = dossiers.filter((d) => d.kind !== 'house' && d.islandId === islandId).sort((a, b) => (s.agents[b.agentId]?.criticality ?? 0) - (s.agents[a.agentId]?.criticality ?? 0));
  const clusters = dossiers.filter((d) => d.kind === 'house' && d.memberIds).slice(0, 2);
  const chosen = [...cand.slice(0, 8), ...clusters].slice(0, 11);
  const stances: Stance[] = ['CRITICAL_HOLD', 'PARTIAL_CONCESSION', 'FULL_FLEX_SHED'];
  const ps: P[] = chosen.map((d, i) => {
    const members = d.memberIds ?? [];
    const ag = members.length ? members.map((m) => s.agents[m]) : [s.agents[d.agentId]];
    const orig = ag.reduce((n, a) => n + (a?.demandKW ?? 0), 0) || 100;
    const floor = ag.reduce((n, a) => n + (a?.minSafeKW ?? 0), 0) || orig * 0.4;
    const crit = Math.max(...ag.map((a) => a?.criticality ?? 0.25));
    const urgency = Math.min(1, 0.25 + crit * 0.5 + ((i * 7) % 5) * 0.06);
    const stance: Stance = crit >= 0.85 ? 'CRITICAL_HOLD' : d.kind === 'house' || crit < 0.6 ? 'FULL_FLEX_SHED' : stances[1];
    const conceded = stance === 'CRITICAL_HOLD' ? 0 : (orig - floor) * (stance === 'FULL_FLEX_SHED' ? 0.6 : 0.3);
    return {
      id: d.agentId,
      name: members.length ? `Household cluster (${members.length} homes)` : (s.buildings[d.agentId]?.name ?? d.agentId),
      kind: d.kind,
      buildingIds: members.length ? members : [d.agentId],
      orig: r1(orig),
      floor: r1(floor),
      crit,
      urgency: r1(urgency * 100) / 100,
      damage: r1(Math.min(1, urgency * 0.9) * 100) / 100,
      risk: r1(Math.min(1, urgency * 0.8 + 0.05) * 100) / 100,
      canConcede: r1((conceded / orig) * 100) / 100,
      conf: 0.55 + ((i * 13) % 4) * 0.1,
      source: members.length ? 'heuristic' : i % 3 === 2 ? 'heuristic' : 'jev',
      stance,
      conceded: r1(conceded),
      score: r1((0.35 * crit + 0.25 * urgency + 0.25 * urgency * 0.9) * 100) / 100,
      tele: s.agents[d.agentId]?.telemetry ?? {},
    };
  });
  const totalReq = ps.reduce((n, p) => n + p.orig, 0);
  const totalFloor = ps.reduce((n, p) => n + p.floor, 0);
  const supply = r1(variant === 1 ? totalFloor * 0.82 : totalReq * (variant === 0 ? 0.7 : 0.86));
  const regime: NegotiationReplay['regime'] = supply < totalFloor ? 'triage' : 'shortage';
  const deficit = r1(totalReq - supply);

  const bid = (p: P, round: number, req: number): RoundBid => ({
    agentId: p.id,
    name: p.name,
    kind: p.kind,
    mode: p.crit >= 0.85 || p.urgency > 0.5 ? 'active' : 'cooperating',
    requestKW: r1(req),
    originalRequestKW: p.orig,
    minSafeKW: p.floor,
    concededKW: round > 1 ? p.conceded : 0,
    tokensOffered: round > 1 && p.conceded > 0 ? 2 : 0,
    score: p.score,
    stance: p.stance,
    perception: p.kind === 'house' && p.buildingIds.length > 1 ? undefined : { source: p.source, urgency: p.urgency, damage: p.damage, imminentFailureRisk: p.risk, canConcede: p.canConcede, concessionStrategy: 'shed_25_flex', confidence: p.conf, ageMin: 2 },
    argument: lines(p, req),
    offer: p.conceded > 0 ? `Will shed ${Math.round(p.conceded)} kW of flexible load for a better share later.` : 'No concession: holding the protected floor.',
  });
  const bids1 = ps.map((p) => bid(p, 1, p.orig));
  const bids2 = ps.map((p) => bid(p, 2, Math.max(p.floor, p.orig - p.conceded)));
  const c1 = clear(ps.map((p) => ({ id: p.id, req: p.orig, floor: p.floor, score: p.score })), supply);
  const c2 = clear(ps.map((p) => ({ id: p.id, req: Math.max(p.floor, p.orig - p.conceded), floor: p.floor, score: p.score })), supply);
  const name = (pid: string) => ps.find((p) => p.id === pid)?.name ?? pid;
  const giver = ps.find((p) => p.conceded > 0 && p.kind !== 'house') ?? ps[ps.length - 1];
  const receiver = ps.find((p) => p.crit >= 0.95) ?? ps[0];
  const nowKW = Math.max(10, Math.round(giver.conceded * 0.4));
  const laterKW = Math.round(nowKW * 1.2);
  const finalGrants: Record<string, number> = { ...c2.grants };
  finalGrants[giver.id] = r1(Math.max(0, finalGrants[giver.id] - nowKW));
  finalGrants[receiver.id] = r1(finalGrants[receiver.id] + nowKW);
  const water = ps.find((p) => p.kind === 'water');
  const trim = variant === 1 || !water ? 0 : r1(Math.min(24, finalGrants[water.id] * 0.04));
  const safeGrants: Record<string, number> = { ...finalGrants };
  const corrections: NonNullable<ReplayStage['corrections']> = [];
  if (water && trim > 0) {
    safeGrants[water.id] = r1(finalGrants[water.id] - trim);
    safeGrants[receiver.id] = r1(safeGrants[receiver.id] + trim);
    corrections.push({ agentId: water.id, proposedKW: finalGrants[water.id], finalKW: safeGrants[water.id], rule: 'edge-capacity', reason: `${water.name}'s feeder cannot carry that much, so ${Math.round(trim)} kW moved to ${receiver.name}` });
  }
  const short = ps.filter((p) => c1.grants[p.id] < p.orig - 0.5);

  const stages: ReplayStage[] = [
    { kind: 'perceive', round: 1, title: 'Agents read their situation', caption: 'Each agent looks at its own live data and asks the AI model (Jev) how bad things are. If the model is busy, a simple built-in rule scores it instead.', bids: bids1 },
    { kind: 'bid', round: 1, title: 'Round 1: bids', caption: 'Every agent tells the clearing hub how much power it wants and why. Nobody has given anything up yet.', bids: bids1 },
    {
      kind: 'clear',
      round: 1,
      title: 'Round 1: provisional clearing',
      caption: regime === 'triage' ? 'There is not even enough power to cover everyone’s safe minimum, so the hub protects the most critical agents first.' : 'The hub first covers every agent’s safe minimum, then shares what is left by priority.',
      bids: bids1,
      grants: c1.grants,
      phase1: c1.phase1,
    },
    { kind: 'notice', round: 1, title: 'Shortfall notice', caption: `The island is ${kw(deficit)} short. The hub tells each agent how much it can expect and invites it to give something up.`, notices: short.map((p) => ({ agentId: p.id, projectedKW: c1.grants[p.id], requestKW: p.orig })) },
    {
      kind: 'counter',
      round: 2,
      title: 'Round 2: counter-offers',
      caption: 'Agents that can safely wait offer to use less and earn tokens. Critical ones hold firm.',
      bids: bids2,
      concessions: ps.map((p) => ({ agentId: p.id, kw: p.conceded, stance: p.stance, text: p.conceded > 0 ? `offers to give up ${kw(p.conceded)} of flexible load` : 'holds firm: something critical depends on this power' })),
    },
    { kind: 'contract', round: 2, title: 'Forward contract', caption: 'Two agents shake on a deal: one gives up power now, the other pays it back later with interest.', contracts: [{ id: `c-${id}`, giverId: giver.id, receiverId: receiver.id, nowKW, laterKW }] },
    { kind: 'final', round: 2, title: 'Final clearing', caption: 'The hub clears again with everyone’s updated offers and the contract applied.', bids: bids2, grants: finalGrants },
    {
      kind: 'safety',
      round: 2,
      title: 'Safety check',
      caption: corrections.length ? 'The safety layer checks the plan against the real network and fixes anything unsafe.' : 'The safety layer checks the plan against the real network. Nothing needed fixing.',
      grants: safeGrants,
      corrections,
    },
    { kind: 'commit', round: 2, title: 'Commit', caption: 'The checked plan becomes real: power is delivered and tokens are paid out for giving way.', grants: safeGrants, tokens: ps.filter((p) => p.conceded > 0).map((p) => ({ agentId: p.id, delta: r1(1 + p.conceded / 100), reason: 'reward for conceding' })) },
  ];

  const replay: NegotiationReplay = {
    id,
    tMin: t,
    islandId,
    supplyKW: supply,
    totalRequestKW: r1(totalReq),
    totalMinSafeKW: r1(totalFloor),
    deficitKW: deficit,
    regime,
    microgrid: islandId === 1,
    prosumerKW: islandId === 1 ? 38 : 0,
    participants: ps.map((p) => ({ agentId: p.id, name: p.name, kind: p.kind, buildingIds: p.buildingIds })),
    stages,
    headline: `Island ${islandId} is ${kw(deficit)} short: ${ps.length} agents negotiate`,
  };

  // events
  const events: NegotiationEvent[] = [];
  const ev = (k: number, kind: NegotiationEvent['kind'], importance: 1 | 2 | 3, text: string, agentIds: string[]) => events.push({ id: `${id}:ev${k}`, tMin: t, islandId, kind, importance, text, agentIds, replayId: id });
  if (regime === 'triage') ev(0, 'triage_start', 3, `Island ${islandId} cannot cover everyone's safe minimum. Triage begins.`, ps.map((p) => p.id).slice(0, 4));
  else if (firstForIsland || variant === 0) ev(0, 'shortage_start', 3, `Island ${islandId} is ${kw(deficit)} short. ${ps.length} agents start negotiating.`, ps.map((p) => p.id).slice(0, 4));
  ev(1, 'big_concession', 2, `${giver.name} offers ${kw(giver.conceded)} so ${receiver.name} can keep running.`, [giver.id, receiver.id]);
  ev(2, 'contract', 2, `${giver.name} and ${receiver.name} sign a contract: ${kw(nowKW)} now, ${kw(laterKW)} back later.`, [giver.id, receiver.id]);
  if (corrections.length) ev(3, 'safety_veto', 2, corrections[0].reason, [corrections[0].agentId]);

  // feed
  const feed: FeedMessage[] = [];
  let n = 0;
  const m = (from: string, fromName: string, fromKind: FeedMessage['fromKind'], kind: FeedMessage['kind'], text: string, data?: FeedMessage['data']) => feed.push({ id: `${id}:m${n++}`, tMin: t, islandId, from, fromName, fromKind, kind, text, data, replayId: id });
  m('clearing', 'Clearing hub', 'clearing', 'info', `${replay.headline}. Supply ${kw(supply)}, asked ${kw(totalReq)}, safe minimums ${kw(totalFloor)}.`, { deficitKW: deficit });
  for (const p of ps.slice(0, 7)) {
    m(p.id, p.name, p.kind, 'bid', lines(p, p.orig), p.kind === 'house' && p.buildingIds.length > 1 ? { requestKW: p.orig, minSafeKW: p.floor, stance: p.stance } : { source: p.source, urgency: p.urgency, damage: p.damage, risk: p.risk, canConcede: p.canConcede, confidence: p.conf, requestKW: p.orig, minSafeKW: p.floor, stance: p.stance });
  }
  m('clearing', 'Clearing hub', 'clearing', 'notice', `Provisional result: ${short.length} of ${ps.length} agents would get less than they asked. Asking who can give something up.`, { deficitKW: deficit });
  for (const p of ps.filter((x) => x.conceded > 0).slice(0, 3)) m(p.id, p.name, p.kind, 'concession', `I can give up ${kw(p.conceded)} of flexible load. Please remember it when power gets tight again.`, { concededKW: p.conceded, stance: p.stance });
  m(giver.id, giver.name, giver.kind, 'contract', `Deal: I yield ${kw(nowKW)} to ${receiver.name} now, and get ${kw(laterKW)} back later.`, { concededKW: nowKW });
  if (corrections.length) m('safety', 'Safety layer', 'safety', 'safety', `Corrected ${name(corrections[0].agentId)} from ${kw(corrections[0].proposedKW)} to ${kw(corrections[0].finalKW)}: ${corrections[0].reason}.`, { requestKW: corrections[0].proposedKW, grantKW: corrections[0].finalKW });
  else m('safety', 'Safety layer', 'safety', 'safety', 'Checked the plan against feeder limits and safe minimums. Nothing needed fixing.');
  for (const p of ps.filter((x) => safeGrants[x.id] < x.orig - 0.5).slice(0, 3)) m('clearing', 'Clearing hub', 'clearing', 'grant', `${p.name} gets ${kw(safeGrants[p.id])} of the ${kw(p.orig)} it asked for.`, { requestKW: p.orig, grantKW: safeGrants[p.id], minSafeKW: p.floor });

  return { replay, events, feed };
}
