import { describe, expect, it } from "vitest";
import { buildInventory } from "../src/risk/limits.ts";
import { desiredQuotes } from "../src/strategy/quoter.ts";
import { selectContracts } from "../src/strategy/selector.ts";
import { book, contract, T0, testConfig } from "./helpers.ts";

const cfg = testConfig();
const rule = cfg.categories.crypto;
const c = contract();
const inv = (qty: number) => buildInventory([{ symbol: c.symbol, qty }], new Map([[c.symbol, c]]));

describe("quoter", () => {
  it("steps one tick inside a wide spread", () => {
    const q = desiredQuotes(c, book(45, 55), inv(0), rule, cfg, "normal", T0);
    expect(q.bid).toEqual({ price: 46, qty: 100 });
    expect(q.ask).toEqual({ price: 54, qty: 100 });
    expect(q.rewardEligible).toBe(true);
  });

  it("joins the best price on a tight spread", () => {
    const q = desiredQuotes(c, book(49, 51), inv(0), rule, cfg, "normal", T0);
    expect(q.bid?.price).toBe(49);
    expect(q.ask?.price).toBe(51);
  });

  it("never crosses the book or quotes outside the rebate band", () => {
    for (let bid = 1; bid < 99; bid += 1) {
      for (const width of [1, 2, 3, 6, 12]) {
        const ask = bid + width;
        if (ask > 99) continue;
        for (const position of [-400, -150, 0, 150, 400]) {
          const q = desiredQuotes(c, book(bid, ask), inv(position), rule, cfg, "normal", T0);
          if (q.bid) {
            expect(q.bid.price).toBeLessThan(ask);
            expect(q.bid.price).toBeGreaterThanOrEqual(20);
            expect(q.bid.price).toBeLessThanOrEqual(80);
          }
          if (q.ask) {
            expect(q.ask.price).toBeGreaterThan(bid);
            expect(q.ask.price).toBeGreaterThanOrEqual(20);
            expect(q.ask.price).toBeLessThanOrEqual(80);
          }
          if (q.bid && q.ask) expect(q.bid.price).toBeLessThan(q.ask.price);
        }
      }
    }
  });

  it("skews both quotes down when long and up when short", () => {
    const flat = desiredQuotes(c, book(40, 60), inv(0), rule, cfg, "normal", T0);
    const long = desiredQuotes(c, book(40, 60), inv(300), rule, cfg, "normal", T0);
    const short = desiredQuotes(c, book(40, 60), inv(-300), rule, cfg, "normal", T0);
    expect(long.bid!.price).toBeLessThan(flat.bid!.price);
    expect(long.ask!.price).toBeLessThan(flat.ask!.price);
    expect(short.bid!.price).toBeGreaterThan(flat.bid!.price);
    expect(short.ask!.price).toBeGreaterThan(flat.ask!.price);
  });

  it("stops bidding at the per-contract cap but keeps the reducing side", () => {
    const q = desiredQuotes(c, book(45, 55), inv(cfg.limits.maxPerContract), rule, cfg, "normal", T0);
    expect(q.bid).toBeUndefined();
    expect(q.ask?.qty).toBe(100);
  });

  it("only works out of inventory in reduce-only mode", () => {
    const long = desiredQuotes(c, book(45, 55), inv(60), rule, cfg, "reduce-only", T0);
    expect(long.bid).toBeUndefined();
    expect(long.ask?.qty).toBe(60);
    const flat = desiredQuotes(c, book(45, 55), inv(0), rule, cfg, "reduce-only", T0);
    expect(flat.bid).toBeUndefined();
    expect(flat.ask).toBeUndefined();
  });

  it("pulls quotes near resolution, in live play, and when off", () => {
    const soon = contract({ expiry: T0 + 60_000 });
    expect(desiredQuotes(soon, book(45, 55), inv(0), rule, cfg, "normal", T0).note).toBe("near resolution");

    const game = contract({ category: "sports", startTime: T0 - 1_000 });
    expect(desiredQuotes(game, book(45, 55), inv(0), cfg.categories.sports, cfg, "normal", T0).note).toBe("live play");

    expect(desiredQuotes(c, book(45, 55), inv(0), rule, cfg, "off", T0).bid).toBeUndefined();
  });

  it("widens unhedgeable contracts near scheduled news", () => {
    const calm = contract({ category: "sports", startTime: T0 + 3 * 3_600_000 });
    const tense = contract({ category: "sports", startTime: T0 + 5 * 60_000 });
    const a = desiredQuotes(calm, book(40, 60), inv(0), cfg.categories.sports, cfg, "normal", T0);
    const b = desiredQuotes(tense, book(40, 60), inv(0), cfg.categories.sports, cfg, "normal", T0);
    expect(b.bid!.price).toBeLessThan(a.bid!.price);
    expect(b.ask!.price).toBeGreaterThan(a.ask!.price);
  });
});

describe("selector", () => {
  it("keeps in-band two-sided contracts, ranked by volume, and anything held", () => {
    const all = [
      contract({ symbol: "A", volume24h: 10 }),
      contract({ symbol: "B", volume24h: 500 }),
      contract({ symbol: "OUT", bestBid: 90, bestAsk: 93, volume24h: 9_999 }),
      contract({ symbol: "ONE-SIDED", bestAsk: null, volume24h: 9_999 }),
      contract({ symbol: "EXPIRING", expiry: T0 + 60_000, volume24h: 9_999 }),
      contract({ symbol: "HELD", bestBid: 90, bestAsk: 93 }),
    ];
    const picked = selectContracts(all, new Set(["HELD"]), { ...cfg, maxContracts: 3 }, T0);
    expect(picked.map((p) => p.symbol)).toEqual(["HELD", "B", "A"]);
  });
});
