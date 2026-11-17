import type { Exchange, Fill, NewOrder, Side } from "../exchange/types.ts";
import type { Cents } from "../money.ts";
import type { Quote, Quotes } from "../strategy/quoter.ts";

type Live = { orderId: string; price: Cents; qty: number; placedAt: number };

export type OrderEvent = {
  id: number;
  at: number;
  kind: "place" | "cancel" | "fill" | "reject";
  symbol: string;
  side: Side;
  price: Cents;
  qty: number;
  /** Why an order was rejected, or who filled it. */
  detail?: string;
};

const TAPE_SIZE = 200;
type Pair = { bid?: Live; ask?: Live };

const BATCH = 20;

/**
 * Keeps resting orders in line with the quotes the strategy wants. It leaves an order
 * alone while its price is still right, so the bot holds its place in the queue and
 * stays well under rate limits.
 */
export class OrderManager {
  private readonly live = new Map<string, Pair>();
  private readonly rejects = new Map<string, string>();
  private readonly tape: OrderEvent[] = [];
  private readonly lastRejectAt = new Map<string, number>();
  private seq = 0;
  private eventSeq = 0;

  constructor(
    private readonly exchange: Exchange,
    private readonly minRequoteMs: number,
    private readonly now: () => number = Date.now,
  ) {
    exchange.onFill((fill) => this.onFill(fill));
  }

  resting(symbol: string): Pair {
    return this.live.get(symbol) ?? {};
  }

  lastReject(symbol: string): string | undefined {
    return this.rejects.get(symbol);
  }

  openCount(): number {
    let count = 0;
    for (const pair of this.live.values()) count += (pair.bid ? 1 : 0) + (pair.ask ? 1 : 0);
    return count;
  }

  /** Newest first: every order placed, cancelled, filled or rejected. */
  events(count: number): OrderEvent[] {
    return this.tape.slice(0, count);
  }

  private record(event: Omit<OrderEvent, "id" | "at">): void {
    this.tape.unshift({ id: ++this.eventSeq, at: this.now(), ...event });
    if (this.tape.length > TAPE_SIZE) this.tape.pop();
  }

  private onFill(fill: Fill): void {
    this.record({
      kind: "fill",
      symbol: fill.symbol,
      side: fill.side,
      price: fill.price,
      qty: fill.qty,
      detail:
        fill.cause === "sweep"
          ? "price moved through quote"
          : !fill.simulated
            ? "market trade"
            : fill.adverse
              ? "simulated taker, informed"
              : "simulated taker",
    });
    const pair = this.live.get(fill.symbol);
    const order = pair?.[fill.side];
    if (!pair || !order || order.orderId !== fill.orderId) return;
    if (fill.remaining <= 0) delete pair[fill.side];
    else order.qty = fill.remaining;
  }

  /** Cancel what is no longer wanted and place what is missing. */
  async sync(desired: Map<string, Quotes>): Promise<void> {
    const now = this.now();
    const cancels: string[] = [];
    const places: NewOrder[] = [];

    const symbols = new Set([...this.live.keys(), ...desired.keys()]);
    for (const symbol of symbols) {
      const pair = this.live.get(symbol) ?? {};
      this.live.set(symbol, pair);
      const want = desired.get(symbol);
      for (const side of ["bid", "ask"] as Side[]) {
        const have = pair[side];
        const target: Quote | undefined = want?.[side];
        if (have && this.keep(have, target, now)) continue;
        if (have) {
          cancels.push(have.orderId);
          this.record({ kind: "cancel", symbol, side, price: have.price, qty: have.qty });
          delete pair[side];
        }
        if (target) {
          places.push({ clientId: `mm-${++this.seq}`, symbol, side, price: target.price, qty: target.qty });
        }
      }
      if (!pair.bid && !pair.ask && !want) this.live.delete(symbol);
    }

    for (let i = 0; i < cancels.length; i += BATCH) await this.exchange.cancel(cancels.slice(i, i + BATCH));

    for (let i = 0; i < places.length; i += BATCH) {
      const batch = places.slice(i, i + BATCH);
      const results = await this.exchange.place(batch);
      results.forEach((result, index) => {
        const order = batch[index];
        if (!order) return;
        if (!result.ok) {
          this.rejects.set(order.symbol, result.reason);
          // The same rejection can repeat every tick; show it at most once every few seconds.
          const key = `${order.symbol}:${order.side}:${result.reason}`;
          if (now - (this.lastRejectAt.get(key) ?? 0) > 5_000) {
            this.lastRejectAt.set(key, now);
            this.record({ kind: "reject", symbol: order.symbol, side: order.side, price: order.price, qty: order.qty, detail: result.reason });
          }
          return;
        }
        this.rejects.delete(order.symbol);
        this.record({ kind: "place", symbol: order.symbol, side: order.side, price: order.price, qty: order.qty });
        const pair = this.live.get(order.symbol) ?? {};
        pair[order.side] = { orderId: result.orderId, price: order.price, qty: order.qty, placedAt: now };
        this.live.set(order.symbol, pair);
      });
    }
  }

  private keep(have: Live, target: Quote | undefined, now: number): boolean {
    if (!target) return false;
    const samePrice = have.price === target.price;
    // A partly filled order keeps its queue place until it runs low.
    const sizeOk = have.qty <= target.qty && have.qty >= Math.min(target.qty, Math.ceil(target.qty / 2));
    if (samePrice && sizeOk) return true;
    // Throttle re-quotes, except when the size must come down for a risk cap.
    const tooSoon = now - have.placedAt < this.minRequoteMs;
    return tooSoon && have.qty <= target.qty;
  }

  async cancelAll(): Promise<void> {
    await this.exchange.cancelAll();
    for (const [symbol, pair] of this.live) {
      for (const side of ["bid", "ask"] as Side[]) {
        const have = pair[side];
        if (have) this.record({ kind: "cancel", symbol, side, price: have.price, qty: have.qty, detail: "cancel all" });
      }
    }
    this.live.clear();
  }
}
