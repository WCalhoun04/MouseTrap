import type { CategoryRule, Config } from "../config.ts";
import type { BookTop, Contract, Side } from "../exchange/types.ts";
import type { Cents } from "../money.ts";
import { allowedSize, type Inventory } from "../risk/limits.ts";
import { inBand } from "./rebate.ts";

export type Quote = { price: Cents; qty: number };

export type Quotes = {
  bid?: Quote;
  ask?: Quote;
  /** Why a side (or both) is missing, for the operator view. */
  note?: string;
  /** Two-sided, within $0.10 and at least 100 contracts a side: scores for liquidity rewards. */
  rewardEligible: boolean;
};

export type QuoteMode = "normal" | "reduce-only" | "off";

type QuoteConfig = Pick<
  Config,
  "improveWhenSpread" | "maxSkewTicks" | "minTimeToExpiryMs" | "newsWindowMs" | "limits" | "terms"
>;

const NONE: Quotes = { rewardEligible: false };

export function desiredQuotes(
  contract: Contract,
  book: BookTop | undefined,
  inv: Inventory,
  rule: CategoryRule,
  cfg: QuoteConfig,
  mode: QuoteMode,
  now: number,
): Quotes {
  if (mode === "off") return { ...NONE, note: "quoting off" };
  if (!rule.enabled) return { ...NONE, note: "category disabled" };
  if (!book || book.bid == null || book.ask == null) return { ...NONE, note: "no two-sided book" };
  if (contract.expiry - now < cfg.minTimeToExpiryMs) return { ...NONE, note: "near resolution" };

  const started = contract.startTime != null && now >= contract.startTime;
  if (rule.pullWhenLive && started) return { ...NONE, note: "live play" };

  const { bid: bestBid, ask: bestAsk } = book;
  const spread = bestAsk - bestBid;
  if (spread < 1) return { ...NONE, note: "crossed book" };

  // Join the best price, or step one tick inside when the spread leaves room.
  const improve = spread >= cfg.improveWhenSpread ? 1 : 0;
  let bid = bestBid + improve;
  let ask = bestAsk - improve;

  // Wider near scheduled news on contracts that cannot be hedged.
  const nearNews =
    contract.startTime != null && Math.abs(contract.startTime - now) <= cfg.newsWindowMs;
  if (nearNews && rule.newsWiden > 0) {
    bid -= rule.newsWiden;
    ask += rule.newsWiden;
  }

  // Skew against inventory: long shifts both quotes down, short shifts them up.
  const pos = inv.bySymbol.get(contract.symbol) ?? 0;
  const skew = Math.round((pos / cfg.limits.maxPerContract) * cfg.maxSkewTicks);
  bid -= skew;
  ask -= skew;

  // Never take liquidity, never quote through ourselves.
  bid = Math.min(bid, bestAsk - 1);
  ask = Math.max(ask, bestBid + 1);
  if (bid >= ask) ask = bid + 1;

  const sideQuote = (side: Side, price: Cents): Quote | undefined => {
    if (!inBand(price, cfg.terms)) return undefined;
    const reduces = side === "bid" ? pos < 0 : pos > 0;
    if (mode === "reduce-only" && !reduces) return undefined;
    const want = mode === "reduce-only" ? Math.min(rule.size, Math.abs(pos)) : rule.size;
    const qty = allowedSize(contract, side, want, inv, cfg.limits);
    return qty > 0 ? { price, qty } : undefined;
  };

  const bidQuote = sideQuote("bid", bid);
  const askQuote = sideQuote("ask", ask);

  let note: string | undefined;
  if (!bidQuote && !askQuote) note = mode === "reduce-only" ? "flat" : "outside rebate band or at cap";
  else if (!bidQuote || !askQuote) note = mode === "reduce-only" ? "reducing inventory" : "one side capped";

  const rewardEligible =
    bidQuote != null &&
    askQuote != null &&
    askQuote.price - bidQuote.price <= 10 &&
    bidQuote.qty >= 100 &&
    askQuote.qty >= 100;

  return { bid: bidQuote, ask: askQuote, note, rewardEligible };
}
