import type { Cents, Micros } from "../money.ts";

export type Category = "crypto" | "commodities" | "sports" | "politics" | "economics" | "other";

export type Contract = {
  symbol: string;
  eventTicker: string;
  title: string;
  category: Category;
  expiry: number;
  /** Scheduled start of the underlying event (game start, release time), if any. */
  startTime: number | null;
  /** Estimated USD traded in this contract over the last 24 hours. */
  volume24h: number;
  bestBid: Cents | null;
  bestAsk: Cents | null;
};

/** Top of book in YES space. */
export type BookTop = {
  symbol: string;
  bid: Cents | null;
  bidSize: number;
  ask: Cents | null;
  askSize: number;
  at: number;
};

/** A quote side in YES space: a bid buys YES, an ask sells YES (or buys NO at 100 - price). */
export type Side = "bid" | "ask";

export type NewOrder = {
  clientId: string;
  symbol: string;
  side: Side;
  price: Cents;
  qty: number;
};

export type PlaceResult =
  | { ok: true; clientId: string; orderId: string }
  | { ok: false; clientId: string; reason: string };

export type Fill = {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  price: Cents;
  qty: number;
  at: number;
  /** True when the taker was generated locally, not a real Gemini trade. */
  simulated: boolean;
  /** Quantity still resting on the order after this fill. */
  remaining: number;
  /** Modelled loss to an informed taker, in cents per contract. */
  adverse?: number;
  /** "sweep": the market price moved through the resting quote. */
  cause?: "sweep";
};

export type Position = {
  symbol: string;
  /** Net YES contracts. Negative means short YES (long NO). */
  qty: number;
};

export type Settlement = {
  symbol: string;
  qty: number;
  /** Payout per YES contract in cents: 100, 0, or the last mid when the result is unknown. */
  value: Cents;
  resolved: boolean;
  at: number;
};

export type Trade = {
  symbol: string;
  price: Cents;
  qty: number;
  at: number;
  simulated: boolean;
  adverse?: number;
  cause?: "sweep";
};

export type Source = "gemini" | "synthetic" | "sandbox" | "production";

export interface Exchange {
  readonly source: Source;
  start(): Promise<void>;
  stop(): Promise<void>;
  listContracts(): Promise<Contract[]>;
  /** Replace the set of symbols with live book subscriptions. */
  watch(contracts: Contract[]): void;
  book(symbol: string): BookTop | undefined;
  onFill(cb: (fill: Fill) => void): void;
  onSettlement(cb: (settlement: Settlement) => void): void;
  /** Every order is maker-or-cancel. */
  place(orders: NewOrder[]): Promise<PlaceResult[]>;
  cancel(orderIds: string[]): Promise<void>;
  cancelAll(): Promise<void>;
  positions(): Promise<Position[]>;
  /** All cash on the exchange, including cash locked behind short positions. */
  cash(): Promise<Micros>;
  /** Cash not locked behind short positions. Resting orders are not deducted. */
  freeCash(): Promise<Micros>;
  /** Cash plus positions marked to mid. This is what attestors sign. */
  equity(): Promise<Micros>;
  connected(): boolean;
}

/** Public market data. The paper exchange runs on top of one of these. */
export interface MarketFeed {
  readonly source: Source;
  start(): Promise<void>;
  stop(): Promise<void>;
  listContracts(): Promise<Contract[]>;
  watch(contracts: Contract[]): void;
  onBook(cb: (book: BookTop) => void): void;
  onTrade(cb: (trade: Trade) => void): void;
  /** Result for an expired contract, or null if not known yet. */
  resolution(contract: Contract): Promise<"yes" | "no" | null>;
  connected(): boolean;
}
