/**
 * Forward contracts (docs/NEGOTIATION.md §4, PRD FR-2.6).
 *
 * A giver yields `nowKW` to a receiver for `contractNowMin` minutes; the receiver repays `laterKW` in a later
 * window. Both parties escrow `contractStake` tokens through the ledger. Houses/clusters never sign contracts
 * (the policy only offers contracts between negotiator agents).
 */
import type { ForwardContract } from '../core/types';
import { NEGOTIATION_CONFIG, type NegotiationConfig } from './config';
import type { ContractClaim } from './clearing';
import type { TokenLedger } from './ledger';

/** How long closed contracts stay in the snapshot (sim minutes). */
const KEEP_CLOSED_MIN = 60;
const MAX_CLOSED = 100;

export class ContractBook {
  private readonly cfg: NegotiationConfig;
  private readonly ledger: TokenLedger;
  private open = new Map<string, ForwardContract>();
  private closed: { c: ForwardContract; atMin: number }[] = [];
  private seq = 0;

  constructor(ledger: TokenLedger, cfg: NegotiationConfig = NEGOTIATION_CONFIG) {
    this.ledger = ledger;
    this.cfg = cfg;
  }

  reset(): void {
    this.open.clear();
    this.closed = [];
    this.seq = 0;
  }

  /** Open contracts (open or repaying) involving this agent. */
  openCount(agentId: string): number {
    let n = 0;
    for (const c of this.open.values()) if (c.giverId === agentId || c.receiverId === agentId) n++;
    return n;
  }

  idsFor(agentId: string): string[] {
    const out: string[] = [];
    for (const c of this.open.values()) if (c.giverId === agentId || c.receiverId === agentId) out.push(c.id);
    return out;
  }

  hasPair(giverId: string, receiverId: string): boolean {
    for (const c of this.open.values()) if (c.giverId === giverId && c.receiverId === receiverId) return true;
    return false;
  }

  get(id: string): ForwardContract | undefined {
    return this.open.get(id);
  }

  openContracts(): ForwardContract[] {
    return [...this.open.values()];
  }

  canSign(agentId: string): boolean {
    return this.openCount(agentId) < this.cfg.maxOpenContracts;
  }

  /**
   * Create a contract at `tMin`. Both stakes are escrowed; if either party cannot cover its stake, or has too many
   * open contracts, nothing happens and null is returned.
   */
  create(giverId: string, receiverId: string, nowKW: number, laterKW: number, tMin: number): ForwardContract | null {
    if (giverId === receiverId || !(nowKW > 0) || !Number.isFinite(nowKW) || !Number.isFinite(laterKW)) return null;
    if (!this.canSign(giverId) || !this.canSign(receiverId)) return null;
    const stake = this.cfg.contractStake;
    this.ledger.ensure(giverId);
    this.ledger.ensure(receiverId);
    const id = `ctr-${++this.seq}`;
    this.ledger.setTime(tMin);
    const gs = this.ledger.escrow(giverId, stake, 'contract_stake', id);
    const rs = this.ledger.escrow(receiverId, stake, 'contract_stake', id);
    if (gs < stake - 1e-9 || rs < stake - 1e-9) {
      // roll back
      this.ledger.release(giverId, gs, 'contract_refund', id);
      this.ledger.release(receiverId, rs, 'contract_refund', id);
      this.seq--;
      return null;
    }
    const nowUntil = tMin + this.cfg.contractNowMin;
    const laterFrom = tMin + this.cfg.contractDelayMin;
    const c: ForwardContract = {
      id,
      giverId,
      receiverId,
      nowKW,
      laterKW: Math.max(0, laterKW),
      createdMin: tMin,
      nowUntilMin: nowUntil,
      laterFromMin: laterFrom,
      laterToMin: laterFrom + this.cfg.contractRepayMin,
      tokenStake: stake,
      status: 'open',
    };
    this.open.set(id, c);
    return c;
  }

  /** Claims for this minute. Both parties must be in `present` (same island, connected). */
  claims(tMin: number, present: ReadonlySet<string>): ContractClaim[] {
    const out: ContractClaim[] = [];
    for (const c of this.open.values()) {
      if (!present.has(c.giverId) || !present.has(c.receiverId)) continue;
      if (tMin >= c.createdMin && tMin < c.nowUntilMin) out.push({ agentId: c.receiverId, kw: c.nowKW, contractId: c.id });
      else if (tMin >= c.laterFromMin && tMin < c.laterToMin) out.push({ agentId: c.giverId, kw: c.laterKW, contractId: c.id });
    }
    return out;
  }

  /**
   * Request reductions owed by an agent this minute: the giver yields `nowKW` (from the minute after creation;
   * its creation-minute concession is already in its bid) and the receiver repays `laterKW`.
   */
  obligations(agentId: string, tMin: number): { contractId: string; kw: number; role: 'giver' | 'receiver' }[] {
    const out: { contractId: string; kw: number; role: 'giver' | 'receiver' }[] = [];
    for (const c of this.open.values()) {
      if (c.giverId === agentId && tMin > c.createdMin && tMin < c.nowUntilMin) out.push({ contractId: c.id, kw: c.nowKW, role: 'giver' });
      else if (c.receiverId === agentId && tMin >= c.laterFromMin && tMin < c.laterToMin) out.push({ contractId: c.id, kw: c.laterKW, role: 'receiver' });
    }
    return out;
  }

  /** Advance status by time: open → repaying, and finished repayment ⇒ honoured (stakes refunded). */
  advance(tMin: number): void {
    for (const c of [...this.open.values()]) {
      if (tMin >= c.laterToMin) this.close(c, 'honoured', tMin);
      else if (tMin >= c.laterFromMin && c.status === 'open') c.status = 'repaying';
    }
    this.trimClosed(tMin);
  }

  /** Receiver could not repay without dropping below minSafe: its stake goes to the giver, the giver's is refunded. */
  default(contractId: string, tMin: number, note?: string): void {
    const c = this.open.get(contractId);
    if (!c) return;
    this.ledger.setTime(tMin);
    this.ledger.release(c.giverId, c.tokenStake, 'contract_refund', c.id);
    this.ledger.transfer(c.receiverId, c.giverId, c.tokenStake, 'contract_forfeit', c.id, true);
    this.finish(c, 'defaulted', tMin, note ?? 'Receiver could not repay without dropping below its minimum-safe floor');
  }

  /** Cancel (disconnect / different island / destroyed): stakes refunded to both. */
  cancel(contractId: string, tMin: number, note?: string): void {
    const c = this.open.get(contractId);
    if (!c) return;
    this.close(c, 'cancelled', tMin, note);
  }

  /** Cancel every open contract whose parties are no longer on the same island. `islandOf` returns undefined when absent. */
  housekeeping(tMin: number, islandOf: (agentId: string) => number | undefined): void {
    for (const c of [...this.open.values()]) {
      const gi = islandOf(c.giverId);
      const ri = islandOf(c.receiverId);
      if (gi === undefined || ri === undefined) this.cancel(c.id, tMin, 'A party is disconnected or destroyed');
      else if (gi !== ri) this.cancel(c.id, tMin, 'Parties are on different islands');
    }
    this.advance(tMin);
  }

  /** Open contracts plus recently closed ones, for the snapshot. */
  list(tMin: number): ForwardContract[] {
    const out: ForwardContract[] = [];
    for (const k of this.closed) if (tMin - k.atMin <= KEEP_CLOSED_MIN) out.push(k.c);
    for (const c of this.open.values()) out.push(c);
    return out.map((c) => ({ ...c }));
  }

  private close(c: ForwardContract, status: 'honoured' | 'cancelled', tMin: number, note?: string): void {
    this.ledger.setTime(tMin);
    this.ledger.release(c.giverId, c.tokenStake, 'contract_refund', c.id);
    this.ledger.release(c.receiverId, c.tokenStake, 'contract_refund', c.id);
    this.finish(c, status, tMin, note);
  }

  private finish(c: ForwardContract, status: ForwardContract['status'], tMin: number, note?: string): void {
    c.status = status;
    if (note) c.note = note;
    this.open.delete(c.id);
    this.closed.push({ c, atMin: tMin });
    this.trimClosed(tMin);
  }

  private trimClosed(tMin: number): void {
    let i = 0;
    while (i < this.closed.length && (tMin - this.closed[i].atMin > KEEP_CLOSED_MIN || this.closed.length - i > MAX_CLOSED)) i++;
    if (i > 0) this.closed.splice(0, i);
  }
}
