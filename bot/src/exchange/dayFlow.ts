import type { PaperExchange } from "./paper.ts";
import type { Contract } from "./types.ts";

export type DayFlowParams = {
  /** Length of one simulated day. */
  epochMs: number;
  /** Share of taker flow that reaches the bot; the rest trades with other makers. */
  captureShare: number;
  /** Share of takers who know where the price is going. */
  informedShare: number;
  /** Cents per contract the bot loses to an informed taker. */
  informedMoveCents: number;
};

/**
 * Replays one day of each contract's real trading volume inside every epoch.
 *
 * Gemini's books are too thin to watch a rebate strategy in real time, so test mode
 * compresses a day into an epoch. For each contract the generator spreads its real
 * 24-hour USD volume across the epoch as taker orders against the live top of book.
 * What the bot earns per epoch then approximates what it would earn per real day.
 *
 * The parts that are assumptions, not data, are the three parameters above and the
 * even split of an event's volume across its contracts (Gemini publishes volume per
 * event only).
 */
export class DayFlow {
  constructor(
    private readonly paper: PaperExchange,
    private readonly params: DayFlowParams,
    private readonly random: () => number = Math.random,
  ) {}

  /** Advance by `dtMs`, sending whatever takers fall due for each contract. */
  step(contracts: Contract[], dtMs: number): void {
    const { epochMs, captureShare, informedShare, informedMoveCents } = this.params;
    for (const contract of contracts) {
      const book = this.paper.book(contract.symbol);
      if (!book || book.bid == null || book.ask == null) continue;
      const mid = (book.bid + book.ask) / 2;
      if (mid <= 0 || contract.volume24h <= 0) continue;

      // USD volume to contracts at the current price.
      const dailyContracts = contract.volume24h / (mid / 100);
      const due = dailyContracts * (dtMs / epochMs);
      const avgSize = Math.min(60, Math.max(1, dailyContracts / 15));
      const expectedTrades = due / avgSize;
      let trades = Math.floor(expectedTrades);
      if (this.random() < expectedTrades - trades) trades += 1;

      for (let i = 0; i < trades; i += 1) {
        const qty = Math.max(1, Math.round(avgSize * (0.5 + this.random())));
        const side = this.random() < 0.5 ? "buy" : "sell";
        // Other makers are quoting too; only part of the flow finds the bot.
        if (this.random() >= captureShare) continue;
        const informed = this.random() < informedShare;
        this.paper.simulateTaker(contract.symbol, side, qty, informed ? informedMoveCents : 0);
      }
    }
  }
}
