import type { Fill } from "../exchange/types.ts";
import { CENT, notional, type Micros } from "../money.ts";
import { makerFee, makerFeeAccrual, rebateAccrual, type RebateTerms } from "../strategy/rebate.ts";
import type { Markouts } from "./markouts.ts";

export type PnlSplit = { rebate: Micros; rewards: Micros; spread: Micros; hedge: Micros; total: Micros };

export type EdgeReport = {
  fills: number;
  contracts: number;
  filledNotional: Micros;
  /** Rebate accrued per dollar filled. */
  rebatePerDollar: number;
  /** Net edge per dollar filled over the trailing window, on today's fees (maker fee waived). */
  trailingEdge: number | null;
  /** The same on post-waiver fees. The Phase 0 gate is defined on this number. */
  trailingEdgePostWaiver: number | null;
};

/**
 * Splits PnL into the income lines in AGENTS.md section 2.
 *
 * Total PnL is exchange equity minus the net capital sent there, so it cannot drift
 * from the account. Rebates are what the exchange has paid out; spread is the rest:
 * bid-ask earned minus losses to informed takers, marked to mid.
 */
export class Attribution {
  private fills = 0;
  private contracts = 0;
  private filled: Micros = 0;
  private rebateAccrued = 0;
  private rebatesPaid: Micros = 0;
  private waivedFees = 0;
  private lastSplit: PnlSplit = { rebate: 0, rewards: 0, spread: 0, hedge: 0, total: 0 };

  constructor(
    private readonly terms: RebateTerms,
    private readonly markouts: Markouts,
    private readonly window = 200,
  ) {}

  onFill(fill: Fill): void {
    this.fills += 1;
    this.contracts += fill.qty;
    this.filled += notional(fill.price, fill.qty);
    this.rebateAccrued += rebateAccrual(fill.price, fill.qty, this.terms);
    // Unrounded: rounding each small fill up to a cent would overstate the fee.
    this.waivedFees += makerFeeAccrual(fill.price, fill.qty, this.terms);
  }

  /** Maker fees on every fill so far that the waiver is currently sparing the bot. */
  feesAfterWaiver(): Micros {
    return Math.round(this.waivedFees);
  }

  onRebatePaid(amount: Micros): void {
    this.rebatesPaid += amount;
  }

  split(equity: Micros, netFunded: Micros, hedge: Micros = 0): PnlSplit {
    const total = equity - netFunded + hedge;
    const rebate = this.rebatesPaid;
    return { rebate, rewards: 0, hedge, spread: total - rebate - hedge, total };
  }

  /** Change in each line since the last call. Used to book an epoch. */
  takeEpoch(equity: Micros, netFunded: Micros, hedge: Micros = 0): PnlSplit {
    const now = this.split(equity, netFunded, hedge);
    const prev = this.lastSplit;
    this.lastSplit = now;
    return {
      rebate: now.rebate - prev.rebate,
      rewards: 0,
      spread: now.spread - prev.spread,
      hedge: now.hedge - prev.hedge,
      total: now.total - prev.total,
    };
  }

  edge(): EdgeReport {
    const recent = this.markouts.recent(this.window);
    let notionalSum = 0;
    let waived = 0;
    let postWaiver = 0;
    for (const t of recent) {
      const { price, qty } = t.fill;
      const rebate = rebateAccrual(price, qty, this.terms);
      const markout = this.markouts.bestEdge(t) * qty * CENT;
      notionalSum += notional(price, qty);
      waived += rebate + markout;
      postWaiver += rebate + markout - makerFee(price, qty, this.terms);
    }
    return {
      fills: this.fills,
      contracts: this.contracts,
      filledNotional: this.filled,
      rebatePerDollar: this.filled > 0 ? this.rebateAccrued / this.filled : 0,
      trailingEdge: notionalSum > 0 ? waived / notionalSum : null,
      trailingEdgePostWaiver: notionalSum > 0 ? postWaiver / notionalSum : null,
    };
  }
}
