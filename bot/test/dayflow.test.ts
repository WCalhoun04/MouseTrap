import { beforeEach, describe, expect, it } from "vitest";
import { DayFlow } from "../src/exchange/dayFlow.ts";
import { PaperExchange } from "../src/exchange/paper.ts";
import type { Fill } from "../src/exchange/types.ts";
import { usd } from "../src/money.ts";
import { DEFAULT_TERMS } from "../src/strategy/rebate.ts";
import { toContracts } from "../src/exchange/geminiFeed.ts";
import { book, contract, ManualFeed, T0 } from "./helpers.ts";

const SYM = "GEMI-TEST-YES";
let feed: ManualFeed;
let paper: PaperExchange;
let fills: Fill[];

/** Deterministic stand-in for Math.random. */
function seeded(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

beforeEach(() => {
  feed = new ManualFeed();
  paper = new PaperExchange(feed, { terms: DEFAULT_TERMS, now: () => T0 });
  fills = [];
  paper.onFill((f) => fills.push(f));
  paper.credit(usd(1_000_000));
  paper.watch([contract()]);
  feed.pushBook(book(48, 52));
});

const quoteBothSides = () =>
  paper.place([
    { clientId: "b", symbol: SYM, side: "bid", price: 49, qty: 1_000_000 },
    { clientId: "a", symbol: SYM, side: "ask", price: 51, qty: 1_000_000 },
  ]);

describe("compressed-day volume replay", () => {
  it("sends about one day of the contract's real volume per epoch", async () => {
    await quoteBothSides();
    // $500 a day at a 50 cent mid is 1,000 contracts.
    const c = contract({ volume24h: 500 });
    const flow = new DayFlow(
      paper,
      { epochMs: 60_000, captureShare: 1, informedShare: 0, informedMoveCents: 0 },
      seeded(),
    );
    const days = 40;
    for (let t = 0; t < days * 60_000; t += 1_000) flow.step([c], 1_000);
    const perDay = fills.reduce((sum, f) => sum + f.qty, 0) / days;
    expect(perDay).toBeGreaterThan(900);
    expect(perDay).toBeLessThan(1_100);
    expect(fills.every((f) => f.simulated)).toBe(true);
  });

  it("gives the bot only its share of the flow", async () => {
    await quoteBothSides();
    const c = contract({ volume24h: 500 });
    const flow = new DayFlow(
      paper,
      { epochMs: 60_000, captureShare: 0.25, informedShare: 0, informedMoveCents: 0 },
      seeded(),
    );
    const days = 40;
    for (let t = 0; t < days * 60_000; t += 1_000) flow.step([c], 1_000);
    const perDay = fills.reduce((sum, f) => sum + f.qty, 0) / days;
    expect(perDay).toBeGreaterThan(200);
    expect(perDay).toBeLessThan(300);
  });

  it("sends nothing for a contract with no volume", async () => {
    await quoteBothSides();
    const flow = new DayFlow(
      paper,
      { epochMs: 60_000, captureShare: 1, informedShare: 0, informedMoveCents: 0 },
      seeded(),
    );
    for (let t = 0; t < 600_000; t += 1_000) flow.step([contract({ volume24h: 0 })], 1_000);
    expect(fills).toHaveLength(0);
  });

  it("charges the modelled adverse move on informed fills", async () => {
    await quoteBothSides();
    const cashBefore = await paper.cash();
    paper.simulateTaker(SYM, "sell", 100, 2);
    expect(fills[0]).toMatchObject({ side: "bid", price: 49, qty: 100, adverse: 2 });
    // Paid 49 cents a contract, plus 2 cents each lost to the informed taker.
    expect(await paper.cash()).toBe(cashBefore - usd(49) - usd(2));
    expect(paper.adverseCost()).toBe(usd(2));
  });
});

describe("price moving through a quote", () => {
  it("fills the resting quote at its own price", async () => {
    await paper.place([{ clientId: "b", symbol: SYM, side: "bid", price: 49, qty: 100 }]);
    // The market drops: the best ask is now below where the bot was bidding.
    feed.pushBook(book(44, 47));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ side: "bid", price: 49, qty: 100, cause: "sweep", simulated: false });
    // Bought at 49 with the mid now 45.5: the loss shows up in equity straight away.
    expect(await paper.equity()).toBe(usd(1_000_000 - 49 + 45.5));
  });

  it("leaves quotes alone while the market stays outside them", async () => {
    await quoteBothSides();
    feed.pushBook(book(49, 51));
    feed.pushBook(book(47, 53));
    expect(fills).toHaveLength(0);
  });
});

describe("contract volume from Gemini events", () => {
  it("splits an event's USD volume evenly across its tradeable contracts", () => {
    const open = { status: "active", marketState: "open", expiryDate: "2026-11-18T00:00:00.000Z" };
    const contracts = toContracts({
      ticker: "EV",
      title: "Event",
      category: "Crypto",
      volume24h: "900",
      contracts: [
        { ...open, instrumentSymbol: "A", prices: { bestBid: "0.40", bestAsk: "0.44" } },
        { ...open, instrumentSymbol: "B" },
        { ...open, instrumentSymbol: "C" },
        { ...open, instrumentSymbol: "CLOSED", marketState: "closed" },
      ],
    });
    expect(contracts.map((c) => c.symbol)).toEqual(["A", "B", "C"]);
    expect(contracts.every((c) => c.volume24h === 300)).toBe(true);
    expect(contracts[0]).toMatchObject({ bestBid: 40, bestAsk: 44, category: "crypto" });
  });
});
