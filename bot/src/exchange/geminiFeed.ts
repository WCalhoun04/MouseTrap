import { createClient } from "@gemini-markets/sdk/server";
import { parseCents } from "../money.ts";
import type { BookTop, Category, Contract, MarketFeed, Source, Trade } from "./types.ts";

type Client = Awaited<ReturnType<typeof createClient>>;
type Stream = { close(): Promise<void> };

// Loose views of the API payloads: only the fields this feed reads.
type ApiContract = {
  instrumentSymbol?: string;
  label?: string;
  status?: string;
  marketState?: string | null;
  expiryDate?: string | null;
  resolutionSide?: string | null;
  isCombo?: boolean;
  prices?: { bestBid?: string | null; bestAsk?: string | null } | null;
};
type ApiEvent = {
  ticker?: string;
  title?: string;
  category?: string;
  status?: string;
  expiryDate?: string | null;
  startTime?: string | null;
  volume24h?: string | null;
  contracts?: ApiContract[];
  events?: ApiEvent[];
};

const CATEGORIES: Record<string, Category> = {
  crypto: "crypto",
  commodities: "commodities",
  sports: "sports",
  politics: "politics",
  economics: "economics",
};

export function toContracts(event: ApiEvent, out: Contract[] = []): Contract[] {
  const category = CATEGORIES[(event.category ?? "").toLowerCase()] ?? "other";
  const startTime = event.startTime ? Date.parse(event.startTime) : null;
  const tradeable = (c: ApiContract) =>
    Boolean(c.instrumentSymbol) && !c.isCombo && c.status === "active" && (c.marketState == null || c.marketState === "open");
  // Gemini reports volume per event, in USD. Split it evenly across the event's contracts.
  const siblings = Math.max(1, (event.contracts ?? []).filter(tradeable).length);
  const perContract = (Number(event.volume24h ?? 0) || 0) / siblings;
  for (const c of event.contracts ?? []) {
    if (!tradeable(c) || !c.instrumentSymbol) continue;
    const expiry = Date.parse(c.expiryDate ?? event.expiryDate ?? "");
    if (!Number.isFinite(expiry)) continue;
    out.push({
      symbol: c.instrumentSymbol,
      eventTicker: event.ticker ?? c.instrumentSymbol,
      title: c.label && c.label !== event.title ? `${event.title}: ${c.label}` : (event.title ?? c.instrumentSymbol),
      category,
      expiry,
      startTime: Number.isFinite(startTime) ? startTime : null,
      volume24h: perContract,
      bestBid: parseCents(c.prices?.bestBid),
      bestAsk: parseCents(c.prices?.bestAsk),
    });
  }
  for (const child of event.events ?? []) toContracts(child, out);
  return out;
}

/**
 * Public Gemini Predictions market data: the event list over REST, top of book and
 * trades over the public WebSocket. Needs no API key.
 */
export class GeminiFeed implements MarketFeed {
  readonly source: Source;
  private readonly env: "production" | "sandbox";
  private client: Client | null = null;
  private readonly streams = new Map<string, Stream[]>();
  /** The WebSocket reports symbols in lower case; map them back. */
  private readonly canonical = new Map<string, string>();
  private readonly bookCbs: ((book: BookTop) => void)[] = [];
  private readonly tradeCbs: ((trade: Trade) => void)[] = [];
  private lastMessageAt = 0;
  private listing: { at: number; contracts: Contract[] } | null = null;
  private failed = false;

  constructor(env: "production" | "sandbox" = "production", source: Source = "gemini") {
    this.env = env;
    this.source = source;
  }

  async start(): Promise<void> {
    if (this.client) return;
    this.client = await createClient({ env: this.env, maxResponseSizeBytes: 64 * 1024 * 1024 });
  }

  async stop(): Promise<void> {
    this.client?.close();
    this.client = null;
    this.streams.clear();
  }

  connected(): boolean {
    if (!this.client || this.failed) return false;
    // Quiet books are normal on thin markets, so only a hard stream failure counts.
    return true;
  }

  lastMessage(): number {
    return this.lastMessageAt;
  }

  /**
   * Every active contract. The full list is about a thousand events with long rule
   * texts, so it is fetched in modest pages and cached for two minutes.
   */
  async listContracts(): Promise<Contract[]> {
    const now = Date.now();
    if (this.listing && now - this.listing.at < 120_000) return this.listing.contracts;
    const client = this.need();
    const out: Contract[] = [];
    const limit = 250;
    for (let offset = 0; offset < 3_000; offset += limit) {
      let page: { data?: ApiEvent[]; pagination?: { total?: number } };
      try {
        page = (await client.predictions.listEvents({ status: ["active"], limit, offset })) as typeof page;
      } catch (err) {
        // A partial list is still enough to pick contracts from.
        if (out.length > 0) break;
        throw err;
      }
      for (const event of page.data ?? []) toContracts(event, out);
      const total = page.pagination?.total ?? 0;
      if (!page.data?.length || offset + limit >= total) break;
    }
    this.listing = { at: now, contracts: out };
    return out;
  }

  watch(contracts: Contract[]): void {
    const client = this.need();
    const want = new Set(contracts.map((c) => c.symbol));

    for (const [symbol, streams] of this.streams) {
      if (want.has(symbol)) continue;
      streams.forEach((s) => void s.close().catch(() => {}));
      this.streams.delete(symbol);
      this.canonical.delete(symbol.toLowerCase());
    }

    for (const symbol of want) {
      if (this.streams.has(symbol)) continue;
      this.canonical.set(symbol.toLowerCase(), symbol);

      const ticker = client.websocket.public.bookTicker(symbol);
      ticker.on("message", (m) => {
        const msg = m as { s?: string; b?: string; B?: string; a?: string; A?: string };
        const name = this.canonical.get((msg.s ?? "").toLowerCase());
        if (!name) return;
        this.lastMessageAt = Date.now();
        const book: BookTop = {
          symbol: name,
          bid: positive(parseCents(msg.b)),
          bidSize: Number(msg.B ?? 0) || 0,
          ask: positive(parseCents(msg.a)),
          askSize: Number(msg.A ?? 0) || 0,
          at: Date.now(),
        };
        this.bookCbs.forEach((cb) => cb(book));
      });
      ticker.on("error", () => {});
      ticker.on("subscriptionError", () => {
        this.failed = true;
      });
      ticker.on("resubscribed", () => {
        this.failed = false;
      });

      const trades = client.websocket.public.trades(symbol);
      trades.on("message", (m) => {
        const msg = m as { s?: string; p?: string; q?: string };
        const name = this.canonical.get((msg.s ?? "").toLowerCase());
        const price = parseCents(msg.p);
        const qty = Number(msg.q ?? 0);
        if (!name || price == null || !(qty > 0)) return;
        this.lastMessageAt = Date.now();
        const trade: Trade = { symbol: name, price, qty, at: Date.now(), simulated: false };
        this.tradeCbs.forEach((cb) => cb(trade));
      });
      trades.on("error", () => {});

      this.streams.set(symbol, [ticker, trades]);
    }
  }

  onBook(cb: (book: BookTop) => void): void {
    this.bookCbs.push(cb);
  }

  onTrade(cb: (trade: Trade) => void): void {
    this.tradeCbs.push(cb);
  }

  async resolution(contract: Contract): Promise<"yes" | "no" | null> {
    const event = (await this.need().predictions.getEvent({ eventTicker: contract.eventTicker })) as ApiEvent;
    const find = (e: ApiEvent): ApiContract | undefined =>
      e.contracts?.find((c) => c.instrumentSymbol === contract.symbol) ??
      e.events?.map(find).find((c) => c != null);
    const side = find(event)?.resolutionSide?.toLowerCase();
    return side === "yes" || side === "no" ? side : null;
  }

  private need(): Client {
    if (!this.client) throw new Error("Gemini feed not started.");
    return this.client;
  }
}

/** An empty side of the book arrives as a zero price. */
function positive(value: number | null): number | null {
  return value != null && value > 0 && value < 100 ? value : null;
}
