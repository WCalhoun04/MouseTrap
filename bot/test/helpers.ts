import { loadConfig, type Config } from "../src/config.ts";
import type { BookTop, Contract, MarketFeed, Source, Trade } from "../src/exchange/types.ts";

export const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);

export function testConfig(): Config {
  return { ...loadConfig("test", { offline: true }, {}), dataDir: "" };
}

export function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    symbol: "GEMI-TEST-YES",
    eventTicker: "TEST",
    title: "Test contract",
    category: "crypto",
    expiry: T0 + 24 * 3_600_000,
    startTime: null,
    volume24h: 1_000,
    bestBid: 48,
    bestAsk: 52,
    ...overrides,
  };
}

export function book(bid: number | null, ask: number | null, sizes: { bid?: number; ask?: number } = {}): BookTop {
  return { symbol: "GEMI-TEST-YES", bid, bidSize: sizes.bid ?? 200, ask, askSize: sizes.ask ?? 200, at: T0 };
}

/** A feed driven by hand from the test. */
export class ManualFeed implements MarketFeed {
  readonly source: Source = "synthetic";
  contracts: Contract[] = [];
  result: "yes" | "no" | null = null;
  up = true;
  private bookCbs: ((book: BookTop) => void)[] = [];
  private tradeCbs: ((trade: Trade) => void)[] = [];

  async start() {}
  async stop() {}
  async listContracts() {
    return this.contracts;
  }
  watch() {}
  onBook(cb: (book: BookTop) => void) {
    this.bookCbs.push(cb);
  }
  onTrade(cb: (trade: Trade) => void) {
    this.tradeCbs.push(cb);
  }
  async resolution() {
    return this.result;
  }
  connected() {
    return this.up;
  }

  pushBook(b: BookTop) {
    this.bookCbs.forEach((cb) => cb(b));
  }
  pushTrade(price: number, qty: number, symbol = "GEMI-TEST-YES") {
    this.tradeCbs.forEach((cb) => cb({ symbol, price, qty, at: T0, simulated: false }));
  }
}
