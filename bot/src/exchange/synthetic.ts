import type { BookTop, Category, Contract, MarketFeed, Source, Trade } from "./types.ts";

type Market = {
  contract: Contract;
  /** Fair value in cents, not rounded. */
  fair: number;
  halfSpread: number;
  outcome: "yes" | "no" | null;
};

type Options = {
  now?: () => number;
  random?: () => number;
  /** Mean milliseconds between book updates per market. */
  bookMs?: number;
  /** Mean milliseconds between taker trades per market. */
  tradeMs?: number;
  /** Share of takers who know where fair value is heading. */
  informedShare?: number;
  lifetimeMs?: number;
};

const TEMPLATES: { ticker: string; title: string; category: Category; start: number }[] = [
  { ticker: "SIM-BTC-HI", title: "Sim: BTC above strike at close", category: "crypto", start: 52 },
  { ticker: "SIM-ETH-HI", title: "Sim: ETH above strike at close", category: "crypto", start: 44 },
  { ticker: "SIM-SOL-HI", title: "Sim: SOL above strike at close", category: "crypto", start: 61 },
  { ticker: "SIM-GOLD-HI", title: "Sim: Gold above strike at close", category: "commodities", start: 38 },
  { ticker: "SIM-OIL-HI", title: "Sim: Oil above strike at close", category: "commodities", start: 57 },
  { ticker: "SIM-CPI", title: "Sim: CPI prints above consensus", category: "economics", start: 47 },
  { ticker: "SIM-GAME-A", title: "Sim: Home team wins", category: "sports", start: 55 },
  { ticker: "SIM-VOTE", title: "Sim: Measure passes", category: "politics", start: 33 },
];

/**
 * Generated markets for offline runs and tests. Fair value follows a random walk,
 * the book sits around it, and takers arrive at random. Some takers are informed:
 * they trade in the direction fair value is about to move, which is what makes
 * tight quotes lose money in real markets.
 */
export class SyntheticFeed implements MarketFeed {
  readonly source: Source = "synthetic";
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly bookMs: number;
  private readonly tradeMs: number;
  private readonly informedShare: number;
  private readonly lifetimeMs: number;
  private readonly markets = new Map<string, Market>();
  private watched = new Set<string>();
  private readonly bookCbs: ((book: BookTop) => void)[] = [];
  private readonly tradeCbs: ((trade: Trade) => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.bookMs = options.bookMs ?? 1_500;
    this.tradeMs = options.tradeMs ?? 8_000;
    this.informedShare = options.informedShare ?? 0.25;
    this.lifetimeMs = options.lifetimeMs ?? 30 * 60_000;
    this.spawn();
  }

  private spawn(): void {
    this.generation += 1;
    const expiry = this.now() + this.lifetimeMs;
    for (const t of TEMPLATES) {
      const symbol = `${t.ticker}-${this.generation}`;
      this.markets.set(symbol, {
        contract: {
          symbol,
          eventTicker: `${t.ticker}-EV-${this.generation}`,
          title: t.title,
          category: t.category,
          expiry,
          startTime: null,
          volume24h: 50 + Math.floor(this.random() * 1_500),
          bestBid: null,
          bestAsk: null,
        },
        fair: t.start + (this.random() - 0.5) * 6,
        halfSpread: 1 + Math.floor(this.random() * 3),
        outcome: null,
      });
    }
  }

  async start(): Promise<void> {
    const stepMs = 250;
    this.timer = setInterval(() => this.step(stepMs), stepMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  connected(): boolean {
    return true;
  }

  async listContracts(): Promise<Contract[]> {
    const now = this.now();
    // Roll a fresh set of markets once the current one is close to expiring.
    const live = [...this.markets.values()].filter((m) => m.contract.expiry - now > this.lifetimeMs / 3);
    if (live.length === 0) this.spawn();
    return [...this.markets.values()]
      .filter((m) => m.contract.expiry > now)
      .map((m) => {
        const book = this.top(m);
        return { ...m.contract, bestBid: book.bid, bestAsk: book.ask };
      });
  }

  watch(contracts: Contract[]): void {
    this.watched = new Set(contracts.map((c) => c.symbol));
    for (const symbol of this.watched) {
      const market = this.markets.get(symbol);
      if (market) this.emitBook(market);
    }
  }

  onBook(cb: (book: BookTop) => void): void {
    this.bookCbs.push(cb);
  }

  onTrade(cb: (trade: Trade) => void): void {
    this.tradeCbs.push(cb);
  }

  async resolution(contract: Contract): Promise<"yes" | "no" | null> {
    const market = this.markets.get(contract.symbol);
    if (!market) return null;
    market.outcome ??= this.random() * 100 < market.fair ? "yes" : "no";
    return market.outcome;
  }

  /** Advance every watched market by `dtMs`. Public so tests can drive time by hand. */
  step(dtMs: number): void {
    const now = this.now();
    for (const symbol of this.watched) {
      const market = this.markets.get(symbol);
      if (!market || market.contract.expiry <= now) continue;

      if (this.random() < dtMs / this.tradeMs) this.trade(market);

      if (this.random() < dtMs / this.bookMs) {
        market.fair = clamp(market.fair + (this.random() - 0.5) * 2.4, 6, 94);
        this.emitBook(market);
      }
    }
  }

  private top(market: Market): BookTop {
    const bid = clamp(Math.floor(market.fair - market.halfSpread + 0.5), 1, 98);
    const ask = clamp(Math.max(bid + 1, Math.ceil(market.fair + market.halfSpread - 0.5)), 2, 99);
    return {
      symbol: market.contract.symbol,
      bid,
      bidSize: 50 + Math.floor(this.random() * 400),
      ask,
      askSize: 50 + Math.floor(this.random() * 400),
      at: this.now(),
    };
  }

  private emitBook(market: Market): void {
    const book = this.top(market);
    this.bookCbs.forEach((cb) => cb(book));
  }

  private trade(market: Market): void {
    const book = this.top(market);
    if (book.bid == null || book.ask == null) return;
    const informed = this.random() < this.informedShare;
    const buy = this.random() < 0.5;
    if (informed) {
      // The informed taker moves first, then fair value follows them.
      market.fair = clamp(market.fair + (buy ? 1 : -1) * (1 + this.random() * 2), 6, 94);
    }
    const trade: Trade = {
      symbol: market.contract.symbol,
      price: buy ? book.ask : book.bid,
      qty: 5 + Math.floor(this.random() * (informed ? 120 : 60)),
      at: this.now(),
      simulated: true,
    };
    this.tradeCbs.forEach((cb) => cb(trade));
    if (informed) this.emitBook(market);
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
