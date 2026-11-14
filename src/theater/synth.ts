/**
 * Fallback: reconstruct a NegotiationReplay for one island from the live NegotiationSnapshot
 * (IslandTrace rounds + agent dossiers + contracts + safety audit). Used by the theater's ambient mode and the
 * dev page until the policy records real replays (snapshot.negotiation.replays).
 */
import type { NegotiationReplay, ReplayStage, RoundBid, SimSnapshot } from '../core/types';

const fmt = (kw: number) => (Math.abs(kw) >= 1000 ? `${(kw / 1000).toFixed(1)} MW` : `${Math.round(kw)} kW`);

export function synthReplay(s: SimSnapshot, islandId?: number): NegotiationReplay | null {
  const n = s.negotiation;
  if (!n || !n.islands.length) return null;
  const tr =
    (islandId !== undefined ? n.islands.find((t) => t.islandId === islandId) : undefined) ??
    n.islands.find((t) => t.regime !== 'surplus') ??
    n.islands[0];
  const ds = Object.values(n.agents).filter((d) => d.islandId === tr.islandId && d.current && d.current.tMin >= tr.tMin - 1);
  if (ds.length < 2) return null;
  const nameOf = (id: string, members?: string[]) => {
    const b = s.buildings[id];
    if (b) return b.name;
    const m = members?.[0] ? s.buildings[members[0]] : undefined;
    return `${members?.length ?? 0} homes${m ? ` near ${m.name}` : ''}`;
  };
  const toBid = (d: (typeof ds)[number], round1: boolean): RoundBid => {
    const c = d.current!;
    const p = d.perception;
    return {
      agentId: d.agentId,
      name: nameOf(d.agentId, d.memberIds),
      kind: d.kind,
      mode: c.bid.mode,
      requestKW: round1 ? c.bid.originalRequestKW : c.bid.requestKW,
      originalRequestKW: c.bid.originalRequestKW,
      minSafeKW: c.bid.minSafeKW,
      concededKW: round1 ? 0 : c.bid.concededKW,
      tokensOffered: c.bid.tokensOffered,
      score: c.explanation.priority.score,
      stance: round1 ? 'CRITICAL_HOLD' : c.brief.stance,
      perception: p && !d.memberIds
        ? {
            source: p.source,
            urgency: p.urgency,
            damage: p.damage,
            imminentFailureRisk: p.imminentFailureRisk,
            canConcede: p.canConcede,
            concessionStrategy: p.concessionStrategy,
            confidence: p.confidence,
            ageMin: d.perceptionAgeMin ?? 0,
          }
        : undefined,
      argument: c.brief.primaryArgument,
      offer: c.brief.concessionOffer,
    };
  };
  const r1 = ds.map((d) => toBid(d, true));
  const r2 = ds.map((d) => toBid(d, false));
  const ex = new Map(ds.map((d) => [d.agentId, d.current!.explanation]));
  const prov = tr.rounds[0]?.provisional ?? {};
  const proposed: Record<string, number> = {};
  const final: Record<string, number> = {};
  const phase1: Record<string, number> = {};
  for (const [id, e] of ex) {
    proposed[id] = e.proposedKW;
    final[id] = e.finalKW;
    phase1[id] = e.phase1KW;
  }
  const totalReq = r1.reduce((a, b) => a + b.requestKW, 0);
  const totalMin = r1.reduce((a, b) => a + b.minSafeKW, 0);
  const deficit = Math.max(0, totalReq - tr.supplyKW);
  const stages: ReplayStage[] = [
    { kind: 'perceive', round: 1, title: 'Agents read their sensors', caption: 'Each utility agent reads its own telemetry and asks its model how urgent things are.', bids: r1 },
    { kind: 'bid', round: 1, title: 'Round 1 — bids', caption: `${r1.length} agents ask the clearing hub for ${fmt(totalReq)} in total.`, bids: r1 },
    { kind: 'clear', round: 1, title: 'Provisional clearing', caption: `Only ${fmt(tr.supplyKW)} is available. Floors are protected first, the rest is shared by need.`, grants: prov, phase1 },
    {
      kind: 'notice',
      round: 1,
      title: 'Shortfall notice',
      caption: `The hub tells every agent the island is ${fmt(deficit)} short and what it would get.`,
      notices: r1.map((b) => ({ agentId: b.agentId, projectedKW: prov[b.agentId] ?? 0, requestKW: b.requestKW })),
    },
  ];
  const conc = (tr.rounds[1]?.concessions ?? tr.rounds[0]?.concessions ?? []).filter((c) => c.kw > 0.5);
  const concList = conc.length ? conc : r2.filter((b) => b.concededKW > 0.5).map((b) => ({ agentId: b.agentId, kw: b.concededKW, stance: b.stance }));
  if (concList.length)
    stages.push({
      kind: 'counter',
      round: 2,
      title: 'Round 2 — counter-offers',
      caption: `${concList.length} agents offer to use less (${fmt(concList.reduce((a, c) => a + c.kw, 0))} in total).`,
      bids: r2,
      concessions: concList.map((c) => ({ agentId: c.agentId, kw: c.kw, stance: c.stance, text: `Gives up ${fmt(c.kw)}` })),
    });
  const ids = new Set(ds.map((d) => d.agentId));
  const ks = n.contracts.filter((k) => ids.has(k.giverId) && ids.has(k.receiverId) && k.createdMin >= tr.tMin - 30).slice(-8);
  if (ks.length)
    stages.push({ kind: 'contract', round: 2, title: 'Forward contracts', caption: `${ks.length} agents agree to lend power now and get it back later.`, contracts: ks.map((k) => ({ id: k.id, giverId: k.giverId, receiverId: k.receiverId, nowKW: k.nowKW, laterKW: k.laterKW })) });
  stages.push({ kind: 'final', round: tr.rounds.length, title: 'Final clearing', caption: 'The hub settles the final grants.', grants: proposed });
  const corrections = [...ex.values()].filter((e) => Math.abs(e.finalKW - e.proposedKW) > 1).map((e) => ({ agentId: e.agentId, proposedKW: e.proposedKW, finalKW: e.finalKW, rule: 'safety', reason: e.validatorNotes[0] ?? 'Adjusted by the safety layer' }));
  stages.push({ kind: 'safety', round: tr.rounds.length, title: 'Safety check', caption: corrections.length ? `The safety layer corrects ${corrections.length} grants.` : 'The safety layer approves every grant.', corrections });
  stages.push({ kind: 'commit', round: tr.rounds.length, title: 'Power flows', caption: 'Grants are committed and the power is switched.', grants: final });
  return {
    id: `${tr.tMin}:${tr.islandId}:synth`,
    tMin: tr.tMin,
    islandId: tr.islandId,
    supplyKW: tr.supplyKW,
    totalRequestKW: totalReq,
    totalMinSafeKW: totalMin,
    deficitKW: deficit,
    regime: tr.regime,
    microgrid: !!s.islands?.find((i) => i.id === tr.islandId)?.microgrid,
    prosumerKW: s.islands?.find((i) => i.id === tr.islandId)?.prosumerKW ?? 0,
    participants: ds.map((d) => ({ agentId: d.agentId, name: nameOf(d.agentId, d.memberIds), kind: d.kind, buildingIds: d.memberIds ?? [d.agentId] })),
    stages,
    headline: `Island ${tr.islandId} is ${fmt(deficit)} short — ${ds.length} agents negotiate`,
  };
}
