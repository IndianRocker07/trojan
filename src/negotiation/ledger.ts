/**
 * Virtual token ledger (docs/NEGOTIATION.md §4, PRD FR-2.4). Tokens never buy priority — they are a
 * bounded secondary signal and a reward for verified concessions.
 *
 * Invariant: Σ balances + Σ escrow = Σ minted − Σ burned, and no balance or escrow is ever negative.
 */
import type { LedgerEntry, LedgerReason } from '../core/types';
import { NEGOTIATION_CONFIG, type NegotiationConfig } from './config';

const EPS = 1e-9;

export class TokenLedger {
  private readonly cfg: NegotiationConfig;
  private bal = new Map<string, number>();
  private esc = new Map<string, number>();
  private minted = 0;
  private burned = 0;
  private entries: LedgerEntry[] = [];
  private tMin = 0;
  private lastHour: number | null = null;

  constructor(cfg: NegotiationConfig = NEGOTIATION_CONFIG) {
    this.cfg = cfg;
  }

  reset(): void {
    this.bal.clear();
    this.esc.clear();
    this.minted = 0;
    this.burned = 0;
    this.entries = [];
    this.tMin = 0;
    this.lastHour = null;
  }

  /** Timestamp used for new entries. */
  setTime(tMin: number): void {
    this.tMin = tMin;
  }

  /** Endow an agent on first sight. Returns its balance. */
  ensure(id: string): number {
    let b = this.bal.get(id);
    if (b === undefined) {
      b = this.cfg.endowment;
      this.bal.set(id, b);
      this.minted += b;
      this.log(id, b, b, 'endowment');
    }
    return b;
  }

  balance(id: string): number {
    return this.bal.get(id) ?? 0;
  }

  escrowed(id: string): number {
    return this.esc.get(id) ?? 0;
  }

  /** Σ balances (free tokens, not counting escrow). */
  total(): number {
    let t = 0;
    for (const v of this.bal.values()) t += v;
    return t;
  }

  totalEscrow(): number {
    let t = 0;
    for (const v of this.esc.values()) t += v;
    return t;
  }

  /** Move up to `n` tokens from the balance into escrow. Returns the amount escrowed. Logs only if `reason` is given. */
  escrow(id: string, n: number, reason?: LedgerReason, ref?: string): number {
    const have = this.ensure(id);
    const amt = Math.max(0, Math.min(Number.isFinite(n) ? n : 0, have));
    if (amt <= EPS) return 0;
    this.bal.set(id, have - amt);
    this.esc.set(id, (this.esc.get(id) ?? 0) + amt);
    if (reason) this.log(id, -amt, have - amt, reason, ref);
    return amt;
  }

  /** Refund up to `n` tokens from escrow to the balance. Returns the amount released. Logs only if `reason` is given. */
  release(id: string, n: number, reason?: LedgerReason, ref?: string): number {
    const held = this.esc.get(id) ?? 0;
    const amt = Math.max(0, Math.min(Number.isFinite(n) ? n : 0, held));
    if (amt <= EPS) return 0;
    this.esc.set(id, held - amt);
    const nb = (this.bal.get(id) ?? 0) + amt;
    this.bal.set(id, nb);
    if (reason) this.log(id, amt, nb, reason, ref);
    return amt;
  }

  /** Burn up to `n` tokens out of escrow (the spend). Returns the amount charged. Logged as 'spend' by default. */
  charge(id: string, n: number, reason: LedgerReason = 'spend', ref?: string): number {
    const held = this.esc.get(id) ?? 0;
    const amt = Math.max(0, Math.min(Number.isFinite(n) ? n : 0, held));
    if (amt <= EPS) return 0;
    this.esc.set(id, held - amt);
    this.burned += amt;
    this.log(id, -amt, this.bal.get(id) ?? 0, reason, ref);
    return amt;
  }

  /** Mint tokens for a verified concession of `kwMin` kW·minutes (capped at tokenCap). Returns the amount minted. */
  earn(id: string, kwMin: number, ref?: string): number {
    const have = this.ensure(id);
    const want = Math.max(0, Number.isFinite(kwMin) ? kwMin : 0) * this.cfg.earnPerKWMin;
    const amt = Math.max(0, Math.min(want, this.cfg.tokenCap - have - (this.esc.get(id) ?? 0)));
    if (amt <= EPS) return 0;
    this.bal.set(id, have + amt);
    this.minted += amt;
    this.log(id, amt, have + amt, 'concession', ref);
    return amt;
  }

  /**
   * Move `n` tokens between agents (e.g. a forfeited contract stake). Taken from `from`'s escrow when
   * `fromEscrow`, else from its balance; credited to `to`'s balance. Returns the amount moved.
   */
  transfer(from: string, to: string, n: number, reason: LedgerReason, ref?: string, fromEscrow = false): number {
    this.ensure(to);
    let amt: number;
    if (fromEscrow) {
      const held = this.esc.get(from) ?? 0;
      amt = Math.max(0, Math.min(Number.isFinite(n) ? n : 0, held));
      if (amt <= EPS) return 0;
      this.esc.set(from, held - amt);
    } else {
      const have = this.ensure(from);
      amt = Math.max(0, Math.min(Number.isFinite(n) ? n : 0, have));
      if (amt <= EPS) return 0;
      this.bal.set(from, have - amt);
      this.log(from, -amt, have - amt, reason, ref);
    }
    const nb = (this.bal.get(to) ?? 0) + amt;
    this.bal.set(to, nb);
    this.log(to, amt, nb, reason, ref);
    return amt;
  }

  /** Hourly decay above the endowment and replenishment below `replenishBelow`. Call once per step. */
  tick(tMin: number): void {
    this.tMin = tMin;
    const hour = Math.floor(tMin / 60);
    if (this.lastHour === null || hour < this.lastHour) {
      this.lastHour = hour;
      return;
    }
    const hours = hour - this.lastHour;
    if (hours <= 0) return;
    this.lastHour = hour;
    const ids = [...this.bal.keys()].sort();
    for (let h = 0; h < hours; h++) {
      for (const id of ids) {
        const b = this.bal.get(id) ?? 0;
        if (b > this.cfg.endowment) {
          const d = (b - this.cfg.endowment) * this.cfg.decayPerHour;
          if (d > EPS) {
            this.bal.set(id, b - d);
            this.burned += d;
            this.log(id, -d, b - d, 'decay');
          }
        } else if (b < this.cfg.replenishBelow) {
          const add = Math.min(this.cfg.replenishPerHour, this.cfg.replenishBelow - b);
          if (add > EPS) {
            this.bal.set(id, b + add);
            this.minted += add;
            this.log(id, add, b + add, 'replenish');
          }
        }
      }
    }
  }

  /** Σ balances + Σ escrow = Σ minted − Σ burned; nothing negative or non-finite. */
  checkInvariant(): boolean {
    let sum = 0;
    for (const v of this.bal.values()) {
      if (!Number.isFinite(v) || v < -1e-9) return false;
      sum += v;
    }
    for (const v of this.esc.values()) {
      if (!Number.isFinite(v) || v < -1e-9) return false;
      sum += v;
    }
    const diff = Math.abs(sum - (this.minted - this.burned));
    return diff <= 1e-6 * (1 + this.minted);
  }

  /** Recent entries, newest last (at most `n`, default all kept). */
  tail(n?: number): LedgerEntry[] {
    return n === undefined || n >= this.entries.length ? this.entries.slice() : this.entries.slice(this.entries.length - n);
  }

  /** Recent entries of one agent, newest last. */
  entriesOf(id: string, n = 20): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < n; i--) if (this.entries[i].agentId === id) out.push(this.entries[i]);
    return out.reverse();
  }

  private log(agentId: string, delta: number, balance: number, reason: LedgerReason, ref?: string): void {
    const e: LedgerEntry = { tMin: this.tMin, agentId, delta, balance, reason };
    if (ref !== undefined) e.ref = ref;
    this.entries.push(e);
    const over = this.entries.length - this.cfg.ledgerKeep;
    if (over > 0) this.entries.splice(0, over);
  }
}
