import { beforeEach, describe, expect, it } from "vitest";
import { PaperExchange } from "../src/exchange/paper.ts";
import type { Fill } from "../src/exchange/types.ts";
import { usd } from "../src/money.ts";
import { DEFAULT_TERMS } from "../src/strategy/rebate.ts";
import { book, contract, ManualFeed, T0 } from "./helpers.ts";

const SYM = "GEMI-TEST-YES";
let feed: ManualFeed;
let paper: PaperExchange;
let fills: Fill[];
let now: number;

beforeEach(() => {
  now = T0;
  feed = new ManualFeed();
  paper = new PaperExchange(feed, { terms: DEFAULT_TERMS, now: () => now, settleGraceMs: 1_000 });
  fills = [];
  paper.onFill((f) => fills.push(f));
  paper.credit(usd(1_000));
  paper.watch([contract()]);
  feed.pushBook(book(48, 52, { bid: 200, ask: 200 }));
});

const place = async (side: "bid" | "ask", price: number, qty = 100) => {
  const [result] = await paper.place([{ clientId: "c", symbol: SYM, side, price, qty }]);
  return result!;
};

describe("paper exchange", () => {
  it("rejects orders that would take liquidity", async () => {
    expect(await place("bid", 52)).toMatchObject({ ok: false, reason: "MakerOrCancelWouldTake" });
    expect(await place("ask", 48)).toMatchObject({ ok: false, reason: "MakerOrCancelWouldTake" });
    expect((await place("bid", 51)).ok).toBe(true);
  });

  it("rejects orders the account cannot collateralise", async () => {
    expect(await place("bid", 50, 5_000)).toMatchObject({ ok: false, reason: "InsufficientFunds" });
  });

  it("fills a quote inside the spread when the market trades through it", async () => {
    await place("bid", 49);
    feed.pushTrade(48, 30);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ side: "bid", price: 49, qty: 30, remaining: 70 });
    expect(await paper.positions()).toEqual([{ symbol: SYM, qty: 30 }]);
    expect(await paper.cash()).toBe(usd(1_000 - 0.49 * 30));
  });

  it("fills a joined quote only after the queue ahead has traded", async () => {
    await place("bid", 48); // joins behind 200 resting contracts
    feed.pushTrade(48, 150);
    expect(fills).toHaveLength(0);
    feed.pushTrade(48, 80); // 50 clears the queue, 30 reaches us
    expect(fills).toHaveLength(1);
    expect(fills[0]!.qty).toBe(30);
  });

  it("moves up the queue when size ahead is cancelled", async () => {
    await place("bid", 48);
    feed.pushBook(book(48, 52, { bid: 20 }));
    feed.pushTrade(48, 50);
    expect(fills[0]!.qty).toBe(30);
  });

  it("does not fill on trades that never reach the quote", async () => {
    await place("bid", 49);
    await place("ask", 51);
    feed.pushTrade(50, 500);
    expect(fills).toHaveLength(0);
  });

  it("tracks short positions with full collateral", async () => {
    await place("ask", 51);
    feed.pushTrade(52, 100);
    expect(await paper.positions()).toEqual([{ symbol: SYM, qty: -100 }]);
    expect(await paper.cash()).toBe(usd(1_051));
    // $1 per short contract is locked.
    expect(await paper.freeCash()).toBe(usd(951));
    // Marked at the 50 cent mid: sold at 51, so one cent ahead per contract.
    expect(await paper.equity()).toBe(usd(1_001));
  });

  it("accrues rebates on fills and pays them down to the cent", async () => {
    await place("bid", 50);
    feed.pushBook(book(48, 52));
    feed.pushTrade(49, 100);
    expect(paper.accruedRebates()).toBeCloseTo(usd(0.525), 0);
    const cashBefore = await paper.cash();
    expect(paper.payRebates()).toBe(usd(0.52));
    expect(await paper.cash()).toBe(cashBefore + usd(0.52));
  });

  it("settles expired positions at the published result", async () => {
    await place("bid", 49);
    feed.pushTrade(48, 100);
    feed.result = "yes";
    now = T0 + 25 * 3_600_000;
    await paper.settleExpired();
    expect(await paper.positions()).toEqual([]);
    expect(await paper.cash()).toBe(usd(1_000 - 49 + 100));
  });

  it("cancels on request", async () => {
    const result = await place("bid", 49);
    if (!result.ok) throw new Error("expected order");
    await paper.cancel([result.orderId]);
    feed.pushTrade(40, 500);
    expect(fills).toHaveLength(0);
  });
});
