import { CENT, ceilToCent, floorToCent, notional, type Cents, type Micros } from "../money.ts";

// Terms as of 2026-11-16 (AGENTS.md section 2). Re-check before relying on them.
export type RebateTerms = {
  rebateRate: number;
  takerRate: number;
  /** Normal maker fee rate, waived through Dec 31, 2026. Fitted to Gemini's worked examples. */
  makerFeeRate: number;
  bandLow: Cents;
  bandHigh: Cents;
  /** Cap as a share of fill notional. */
  cap: number;
};

export const DEFAULT_TERMS: RebateTerms = {
  rebateRate: 0.3,
  takerRate: 0.07,
  makerFeeRate: 0.0175,
  bandLow: 20,
  bandHigh: 80,
  cap: 0.05,
};

export function inBand(price: Cents, terms: RebateTerms = DEFAULT_TERMS): boolean {
  return price >= terms.bandLow && price <= terms.bandHigh;
}

/** C x P x (1 - P) in micros, with P in cents. */
function feeBase(price: Cents, qty: number): number {
  return qty * price * (100 - price) * (CENT / 100);
}

/** Unrounded rebate in micros for one maker fill. Rounding happens at payout. */
export function rebateAccrual(price: Cents, qty: number, terms: RebateTerms = DEFAULT_TERMS): number {
  if (!inBand(price, terms) || qty <= 0) return 0;
  const raw = terms.rebateRate * terms.takerRate * feeBase(price, qty);
  return Math.min(raw, terms.cap * notional(price, qty));
}

/** What Gemini pays out: the accrued total, rounded down to the cent. */
export function rebatePayout(accrued: number): Micros {
  return floorToCent(Math.floor(accrued + 1e-6));
}

/** Maker fee that applies once the fee waiver ends, rounded up to the cent. */
export function makerFee(price: Cents, qty: number, terms: RebateTerms = DEFAULT_TERMS): Micros {
  if (qty <= 0) return 0;
  return ceilToCent(Math.round(terms.makerFeeRate * feeBase(price, qty)));
}

/** Unrounded maker fee, for totals across many small fills. */
export function makerFeeAccrual(price: Cents, qty: number, terms: RebateTerms = DEFAULT_TERMS): number {
  return qty <= 0 ? 0 : terms.makerFeeRate * feeBase(price, qty);
}

/** Net rebate for one fill with and without the maker fee waiver. */
export function netRebate(price: Cents, qty: number, terms: RebateTerms = DEFAULT_TERMS) {
  const rebate = rebatePayout(rebateAccrual(price, qty, terms));
  return { rebate, duringWaiver: rebate, afterWaiver: rebate - makerFee(price, qty, terms) };
}
