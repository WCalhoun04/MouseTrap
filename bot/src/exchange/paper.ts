import { CENT, notional, USD, type Cents, type Micros } from "../money.ts";
import { collateral } from "../risk/limits.ts";
import { rebateAccrual, rebatePayout, type RebateTerms } from "../strategy/rebate.ts";
import type {
  BookTop,
  Contract,
  Exchange,
  Fill,
  MarketFeed,
  NewOrder,
  PlaceResult,
  Position,
  Settlement,
  Side,
  Source,
  Trade,
} from "./types.ts";

type Order = {
  id: string;
  symbol: string;
  side: Side;
  price: Cents;
  remaining: number;
  /** Size resting ahead of this order at its price. Infinity when it joined behind the best. */
  queueAhead: number;
};

type Options = {
  terms: RebateTerms;
  now?: () => number;
  /** How long to wait for a result after expiry before marking at the last mid. */
  settleGraceMs?: number;
};

/**
 * Paper trading account on top of a public market feed. Orders, positions and cash
 * live only in memory. The feed's real prices decide when a resting quote fills:
 *
 * - a trade strictly through the quote's price fills it, up to the trade's size
 * - a trade at the quote's price fills it only after the size that was resting ahead
 *   of it has traded, so fills are not flattered by assuming front of queue
 */
export class PaperExchange implements Exchange {
  readonly source: Source;
  private readonly feed: MarketFeed;
  private readonly terms: RebateTerms;
  private readonly now: () => number;
  private readonly settleGraceMs: number;

  private cashMicros: Micros = 0;
  private readonly pos = new Map<string, number>();
  private readonly orders = new Map<string, Order>();
  private readonly books = new Map<string, BookTop>();
  private readonly lastMid = new Map<string, number>();
  private readonly contracts = new Map<string, Contract>();
  private readonly fillCbs: ((fill: Fill) => void)[] = [];
  private readonly settleCbs: ((settlement: Settlement) => void)[] = [];
  private accrued = 0;
  private adverse: Micros = 0;
  private seq = 0;
  private timers: NodeJS.Timeout[] = [];
  private settling = false;

  constructor(feed: MarketFeed, options: Options) {
    this.feed = feed;
    this.source = feed.source;
    this.terms = options.terms;
    this.now = options.now ?? Date.now;
    this.settleGraceMs = options.settleGraceMs ?? 120_000;
    feed.onBook((book) => this.handleBook(book));
    feed.onTrade((trade) => this.handleTrade(trade));
  }

  async start(): Promise<void> {
    await this.feed.start();
    this.timers.push(setInterval(() => void this.settleExpired(), 5_000));
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    await this.feed.stop();
  }

  listContracts(): Promise<Contract[]> {
    return this.feed.listContracts();
  }

  watch(contracts: Contract[]): void {
    for (const contract of contracts) this.contracts.set(contract.symbol, contract);
    // Keep feeds for anything still held, so positions stay marked and can settle.
    const held = [...this.pos.entries()]
      .filter(([symbol, qty]) => qty !== 0 && !contracts.some((c) => c.symbol === symbol))
      .map(([symbol]) => this.contracts.get(symbol))
      .filter((c): c is Contract => c != null);
    this.feed.watch([...contracts, ...held]);
  }

  book(symbol: string): BookTop | undefined {
    return this.books.get(symbol);
  }

  onFill(cb: (fill: Fill) => void): void {
    this.fillCbs.push(cb);
  }

  onSettlement(cb: (settlement: Settlement) => void): void {
    this.settleCbs.push(cb);
  }

  connected(): boolean {
    return this.feed.connected();
  }

  async place(orders: NewOrder[]): Promise<PlaceResult[]> {
    return orders.map((order) => this.placeOne(order));
  }

  private placeOne(order: NewOrder): PlaceResult {
    const fail = (reason: string): PlaceResult => ({ ok: false, clientId: order.clientId, reason });
    const book = this.books.get(order.symbol);
    if (!book) return fail("NoBook");
    if (!Number.isInteger(order.qty) || order.qty <= 0) return fail("InvalidQuantity");
    if (!Number.isInteger(order.price) || order.price < 1 || order.price > 99) return fail("InvalidPrice");
    // Maker-or-cancel: reject anything that would take liquidity.
    if (order.side === "bid" && book.ask != null && order.price >= book.ask) return fail("MakerOrCancelWouldTake");
    if (order.side === "ask" && book.bid != null && order.price <= book.bid) return fail("MakerOrCancelWouldTake");

    const position = this.pos.get(order.symbol) ?? 0;
    const needed = collateral(order.side, order.price, order.qty, position);
    if (needed > this.freeNow() - this.reserved()) return fail("InsufficientFunds");

    const id = `P${++this.seq}`;
    this.orders.set(id, {
      id,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      remaining: order.qty,
      queueAhead: this.queueAt(order.side, order.price, book),
    });
    return { ok: true, clientId: order.clientId, orderId: id };
  }

  private queueAt(side: Side, price: Cents, book: BookTop): number {
    const best = side === "bid" ? book.bid : book.ask;
    const size = side === "bid" ? book.bidSize : book.askSize;
    if (best == null) return 0;
    const improves = side === "bid" ? price > best : price < best;
    if (improves) return 0;
    return price === best ? size : Infinity;
  }

  async cancel(orderIds: string[]): Promise<void> {
    for (const id of orderIds) this.orders.delete(id);
  }

  async cancelAll(): Promise<void> {
    this.orders.clear();
  }

  async positions(): Promise<Position[]> {
    return [...this.pos.entries()].filter(([, qty]) => qty !== 0).map(([symbol, qty]) => ({ symbol, qty }));
  }

  async cash(): Promise<Micros> {
    return this.cashMicros;
  }

  async freeCash(): Promise<Micros> {
    return this.freeNow();
  }

  async equity(): Promise<Micros> {
    let total = this.cashMicros;
    for (const [symbol, qty] of this.pos) total += qty * this.mid(symbol) * CENT;
    return Math.round(total);
  }

  // --- test-mode controls, used by the simulated treasury and the epoch cycle ---

  /** Fake USDC arriving from the vault. */
  credit(amount: Micros): void {
    this.cashMicros += amount;
  }

  /** Fake USDC leaving for the vault. Throws if it is locked. */
  debit(amount: Micros): void {
    if (amount > this.freeNow() - this.reserved() + 1) throw new Error("Insufficient free cash on the exchange.");
    this.cashMicros -= amount;
  }

  /** Cash that can leave right now: not behind shorts and not behind resting orders. */
  withdrawable(): Micros {
    return Math.max(0, this.freeNow() - this.reserved());
  }

  /** Stand-in for Gemini's 5pm ET rebate payout. Returns what was paid. */
  payRebates(): Micros {
    const paid = rebatePayout(this.accrued);
    this.accrued -= paid;
    this.cashMicros += paid;
    return paid;
  }

  accruedRebates(): number {
    return this.accrued;
  }

  /**
   * A locally generated taker hitting the real top of book. Labelled simulated.
   * `adverseCents` models an informed taker: the bot is charged that many cents per
   * contract filled, standing in for the price move that follows such a trade.
   */
  simulateTaker(symbol: string, takerSide: "buy" | "sell", qty: number, adverseCents = 0): void {
    const book = this.books.get(symbol);
    if (!book) return;
    const price = takerSide === "sell" ? book.bid : book.ask;
    if (price == null) return;
    this.handleTrade({ symbol, price, qty, at: this.now(), simulated: true, adverse: adverseCents || undefined });
  }

  /** Total charged so far for modelled informed flow. */
  adverseCost(): Micros {
    return this.adverse;
  }

  // --- internals ---

  private mid(symbol: string): number {
    const book = this.books.get(symbol);
    if (book) {
      if (book.bid != null && book.ask != null) return (book.bid + book.ask) / 2;
      const one = book.bid ?? book.ask;
      if (one != null) return one;
    }
    return this.lastMid.get(symbol) ?? 50;
  }

  /** Cash not locked as collateral behind short positions ($1 per contract short). */
  private freeNow(): Micros {
    let locked = 0;
    for (const qty of this.pos.values()) if (qty < 0) locked += -qty * USD;
    return this.cashMicros - locked;
  }

  private reserved(): Micros {
    let total = 0;
    for (const order of this.orders.values()) {
      total += collateral(order.side, order.price, order.remaining, this.pos.get(order.symbol) ?? 0);
    }
    return total;
  }

  private handleBook(book: BookTop): void {
    this.books.set(book.symbol, book);
    if (book.bid != null && book.ask != null) this.lastMid.set(book.symbol, (book.bid + book.ask) / 2);
    // Size ahead can only shrink: cancels at our level move us up the queue.
    for (const order of this.orders.values()) {
      if (order.symbol !== book.symbol) continue;
      const best = order.side === "bid" ? book.bid : book.ask;
      const size = order.side === "bid" ? book.bidSize : book.askSize;
      if (best === order.price) order.queueAhead = Math.min(order.queueAhead, size);
    }
    // The market moved through a resting quote: someone traded against it on the way.
    // This is where adverse selection shows up, because the fill is at the old price.
    for (const order of [...this.orders.values()]) {
      if (order.symbol !== book.symbol) continue;
      const swept =
        order.side === "bid"
          ? book.ask != null && book.ask <= order.price
          : book.bid != null && book.bid >= order.price;
      if (!swept) continue;
      const qty = Math.min(order.remaining, this.affordable(order));
      if (qty > 0) {
        this.fill(order, qty, { symbol: order.symbol, price: order.price, qty, at: this.now(), simulated: false, cause: "sweep" });
      } else {
        this.orders.delete(order.id);
      }
    }
  }

  private handleTrade(trade: Trade): void {
    for (const order of [...this.orders.values()]) {
      if (order.symbol !== trade.symbol) continue;
      const through = order.side === "bid" ? trade.price < order.price : trade.price > order.price;
      let available = 0;
      if (through) {
        available = trade.qty;
      } else if (trade.price === order.price) {
        const consumed = Math.min(order.queueAhead, trade.qty);
        order.queueAhead -= consumed;
        available = trade.qty - consumed;
      }
      const qty = Math.min(order.remaining, Math.floor(available), this.affordable(order));
      if (qty > 0) this.fill(order, qty, trade);
    }
  }

  /** Largest fill the account can fund right now. */
  private affordable(order: Order): number {
    const position = this.pos.get(order.symbol) ?? 0;
    const closing = order.side === "bid" ? Math.max(0, -position) : Math.max(0, position);
    const unit = (order.side === "bid" ? order.price : 100 - order.price) * CENT;
    const free = this.freeNow();
    // Closing inventory releases cash, so it is always affordable.
    const opening = free <= 0 ? 0 : Math.floor(free / unit);
    return closing + opening;
  }

  private fill(order: Order, qty: number, trade: Trade): void {
    const dir = order.side === "bid" ? 1 : -1;
    this.cashMicros -= dir * notional(order.price, qty);
    this.pos.set(order.symbol, (this.pos.get(order.symbol) ?? 0) + dir * qty);
    this.accrued += rebateAccrual(order.price, qty, this.terms);
    if (trade.adverse) {
      const cost = qty * trade.adverse * CENT;
      this.cashMicros -= cost;
      this.adverse += cost;
    }
    order.remaining -= qty;
    if (order.remaining <= 0) this.orders.delete(order.id);
    const fill: Fill = {
      id: `F${++this.seq}`,
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      qty,
      at: trade.at,
      simulated: trade.simulated,
      remaining: Math.max(0, order.remaining),
      adverse: trade.adverse,
      cause: trade.cause,
    };
    this.fillCbs.forEach((cb) => cb(fill));
  }

  /** Close out positions in contracts that have expired. */
  async settleExpired(): Promise<void> {
    if (this.settling) return;
    this.settling = true;
    try {
      const now = this.now();
      for (const [symbol, contract] of this.contracts) {
        if (contract.expiry > now) continue;
        for (const order of [...this.orders.values()]) if (order.symbol === symbol) this.orders.delete(order.id);
        const qty = this.pos.get(symbol) ?? 0;
        if (qty === 0) {
          this.contracts.delete(symbol);
          continue;
        }
        const result = await this.feed.resolution(contract).catch(() => null);
        if (result == null && now - contract.expiry < this.settleGraceMs) continue;
        // With no published result, mark at the last mid and say so.
        const value = result === "yes" ? 100 : result === "no" ? 0 : Math.round(this.mid(symbol));
        this.cashMicros += qty * value * CENT;
        this.pos.delete(symbol);
        this.contracts.delete(symbol);
        const settlement: Settlement = { symbol, qty, value, resolved: result != null, at: now };
        this.settleCbs.forEach((cb) => cb(settlement));
      }
    } finally {
      this.settling = false;
    }
  }
}
