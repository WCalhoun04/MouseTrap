import { createClient, HmacAuth } from "@gemini-markets/sdk/server";
import { CENT, usd, type Cents, type Micros } from "../money.ts";
import { GeminiFeed } from "./geminiFeed.ts";
import type {
  BookTop,
  Contract,
  Exchange,
  Fill,
  NewOrder,
  PlaceResult,
  Position,
  Settlement,
  Side,
  Source,
} from "./types.ts";

type Client = Awaited<ReturnType<typeof createClient>>;
type Tracked = { symbol: string; side: Side; price: Cents; qty: number; filled: number };

const price = (cents: Cents) => (cents / 100).toFixed(2);

/**
 * Real orders on Gemini Predictions (sandbox or production) through the official SDK.
 *
 * NOT YET RUN AGAINST A REAL ACCOUNT: it was written from the SDK's types without API
 * keys to test with. Run it in the sandbox and check fills, positions and balances
 * against Gemini's site before trusting it with money.
 *
 * Quotes are kept in YES space. An ask is sent as "sell YES" when the account holds
 * enough YES, otherwise as "buy NO" at 1 - price, which is the same exposure.
 */
export class GeminiExchange implements Exchange {
  readonly source: Source;
  private readonly env: "production" | "sandbox";
  private readonly feed: GeminiFeed;
  private client: Client | null = null;
  private readonly books = new Map<string, BookTop>();
  private readonly orders = new Map<string, Tracked>();
  private readonly fillCbs: ((fill: Fill) => void)[] = [];
  private readonly settleCbs: ((settlement: Settlement) => void)[] = [];
  private readonly yes = new Map<string, number>();
  private seq = 0;

  constructor(
    env: "production" | "sandbox",
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly nonceMode: "time-based" | "monotonic" = "time-based",
  ) {
    this.env = env;
    this.source = env;
    this.feed = new GeminiFeed(env, env);
    this.feed.onBook((book) => this.books.set(book.symbol, book));
  }

  async start(): Promise<void> {
    await this.feed.start();
    this.client = await createClient({
      env: this.env,
      auth: new HmacAuth({ apiKey: this.apiKey, apiSecret: this.apiSecret, nonceMode: this.nonceMode }),
    });

    // Gemini requires the Predictions terms to be accepted before the first order.
    const terms = (await this.client.predictions.getPredictionMarketsTermsStatus()) as { hasAcceptedLatest?: boolean };
    if (!terms.hasAcceptedLatest) await this.client.predictions.acceptPredictionMarketsTerms();

    const updates = this.client.websocket.private.orders({ scope: "account" });
    updates.on("message", (m) => this.onOrderUpdate(m as unknown as Record<string, unknown>));
    updates.on("error", () => {});
  }

  async stop(): Promise<void> {
    await this.cancelAll().catch(() => {});
    this.client?.close();
    this.client = null;
    await this.feed.stop();
  }

  listContracts(): Promise<Contract[]> {
    return this.feed.listContracts();
  }

  watch(contracts: Contract[]): void {
    this.feed.watch(contracts);
  }

  book(symbol: string): BookTop | undefined {
    return this.books.get(symbol);
  }

  onFill(cb: (fill: Fill) => void): void {
    this.fillCbs.push(cb);
  }

  /** Real settlements arrive as cash; positions simply disappear from the account. */
  onSettlement(cb: (settlement: Settlement) => void): void {
    this.settleCbs.push(cb);
  }

  connected(): boolean {
    return this.client != null && this.feed.connected();
  }

  async place(orders: NewOrder[]): Promise<PlaceResult[]> {
    const client = this.need();
    const body = orders.map((order) => {
      const held = this.yes.get(order.symbol) ?? 0;
      const base = { symbol: order.symbol, orderType: "limit" as const, quantity: String(order.qty), makerOrCancel: true };
      if (order.side === "bid") return { ...base, side: "buy" as const, outcome: "yes" as const, price: price(order.price) };
      if (held >= order.qty) return { ...base, side: "sell" as const, outcome: "yes" as const, price: price(order.price) };
      return { ...base, side: "buy" as const, outcome: "no" as const, price: price(100 - order.price) };
    });

    // One request per order: the batch endpoints answer 503 in the sandbox.
    return Promise.all(
      orders.map(async (order, index): Promise<PlaceResult> => {
        try {
          const result = (await client.predictions.placeOrder(body[index]!)) as { orderId?: bigint | string; status?: string };
          if (result.orderId == null || result.status === "cancelled") {
            return { ok: false, clientId: order.clientId, reason: "MakerOrCancelWouldTake" };
          }
          const orderId = String(result.orderId);
          this.orders.set(orderId, { symbol: order.symbol, side: order.side, price: order.price, qty: order.qty, filled: 0 });
          return { ok: true, clientId: order.clientId, orderId };
        } catch (err) {
          return { ok: false, clientId: order.clientId, reason: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  async cancel(orderIds: string[]): Promise<void> {
    const client = this.need();
    await Promise.all(
      orderIds.map(async (id) => {
        await client.predictions.cancelOrder({ orderId: BigInt(id) });
        this.orders.delete(id);
      }),
    );
  }

  /** Cancels every open order on the account, including ones this process did not place. */
  async cancelAll(): Promise<void> {
    if (!this.client) return;
    const ids: string[] = [];
    for await (const order of this.client.predictions.iterateActiveOrders()) {
      const id = (order as { orderId?: bigint | string }).orderId;
      if (id != null) ids.push(String(id));
    }
    await this.cancel(ids);
    this.orders.clear();
  }

  async positions(): Promise<Position[]> {
    const net = new Map<string, number>();
    this.yes.clear();
    for await (const p of this.need().predictions.iteratePositions()) {
      const row = p as { symbol?: string; totalQuantity?: string; outcome?: string };
      if (!row.symbol) continue;
      const qty = Number(row.totalQuantity ?? 0) || 0;
      const isYes = (row.outcome ?? "").toLowerCase() === "yes";
      if (isYes) this.yes.set(row.symbol, qty);
      net.set(row.symbol, (net.get(row.symbol) ?? 0) + (isYes ? qty : -qty));
    }
    return [...net.entries()].filter(([, qty]) => qty !== 0).map(([symbol, qty]) => ({ symbol, qty }));
  }

  async cash(): Promise<Micros> {
    const balances = (await this.need().account.getAvailableBalances({ account: "primary" } as never)) as unknown as {
      currency?: string;
      amount?: string;
      available?: string;
    }[];
    const row = balances.find((b) => b.currency === "USD");
    return usd(Number(row?.available ?? row?.amount ?? 0) || 0);
  }

  freeCash(): Promise<Micros> {
    return this.cash();
  }

  async equity(): Promise<Micros> {
    let total = await this.cash();
    for (const { symbol, qty } of await this.positions()) {
      const book = this.books.get(symbol);
      const mid = book?.bid != null && book.ask != null ? (book.bid + book.ask) / 2 : 50;
      // Long YES is worth the mid; long NO (negative qty) is worth 1 - mid.
      total += qty >= 0 ? qty * mid * CENT : -qty * (100 - mid) * CENT;
    }
    return Math.round(total);
  }

  private onOrderUpdate(update: Record<string, unknown>): void {
    const id = String(update.i ?? "");
    const order = this.orders.get(id);
    if (!order) return;
    const status = String(update.X ?? "");
    const cumulative = Number(update.z ?? 0) || 0;
    const qty = cumulative - order.filled;
    if (qty > 0) {
      order.filled = cumulative;
      const fill: Fill = {
        id: `G${++this.seq}`,
        orderId: id,
        symbol: order.symbol,
        side: order.side,
        price: order.price,
        qty,
        at: Date.now(),
        simulated: false,
        remaining: Math.max(0, order.qty - cumulative),
      };
      this.fillCbs.forEach((cb) => cb(fill));
    }
    if (status === "FILLED" || status === "CANCELED" || status === "REJECTED") this.orders.delete(id);
  }

  private need(): Client {
    if (!this.client) throw new Error("Gemini client not started.");
    return this.client;
  }
}
