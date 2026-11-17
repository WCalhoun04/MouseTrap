import { describe, expect, it } from "vitest";
import { usd } from "../src/money.ts";
import { evaluate } from "../src/risk/killswitch.ts";
import { allowedSize, buildInventory, collateral } from "../src/risk/limits.ts";
import { contract } from "./helpers.ts";

const limits = { maxPerContract: 400, maxPerEvent: 600, maxPerCategory: 1_500, maxNetInventory: 3_000, maxDrawdown: 0.1 };
const a = contract({ symbol: "A", eventTicker: "EV1" });
const b = contract({ symbol: "B", eventTicker: "EV1" });
const d = contract({ symbol: "D", eventTicker: "EV2" });
const known = new Map([a, b, d].map((c) => [c.symbol, c]));
const inv = (positions: Record<string, number>) =>
  buildInventory(Object.entries(positions).map(([symbol, qty]) => ({ symbol, qty })), known);

describe("exposure caps", () => {
  it("blocks the order that would breach the per-contract cap", () => {
    expect(allowedSize(a, "bid", 100, inv({ A: 350 }), limits)).toBe(50);
    expect(allowedSize(a, "bid", 100, inv({ A: 400 }), limits)).toBe(0);
    expect(allowedSize(a, "ask", 100, inv({ A: -400 }), limits)).toBe(0);
  });

  it("blocks on the per-event cap across contracts of one event", () => {
    expect(allowedSize(a, "bid", 100, inv({ A: 300, B: 250 }), limits)).toBe(50);
  });

  it("blocks on the per-category and net inventory caps", () => {
    expect(allowedSize(d, "bid", 100, inv({ D: 0 }), { ...limits, maxPerCategory: 40 })).toBe(40);
    expect(allowedSize(d, "bid", 100, inv({ A: 300 }), { ...limits, maxNetInventory: 320 })).toBe(20);
  });

  it("always allows an order that reduces the position", () => {
    expect(allowedSize(a, "ask", 100, inv({ A: 400 }), limits)).toBe(100);
    // Closing 60 is free; opening 40 more the other way needs room.
    expect(allowedSize(a, "ask", 100, inv({ A: 60 }), { ...limits, maxPerContract: 30 })).toBe(90);
  });
});

describe("collateral", () => {
  it("locks P to buy YES and 1 - P to sell it", () => {
    expect(collateral("bid", 30, 100, 0)).toBe(usd(30));
    expect(collateral("ask", 30, 100, 0)).toBe(usd(70));
  });

  it("locks nothing for the part that closes inventory", () => {
    expect(collateral("ask", 30, 100, 100)).toBe(0);
    expect(collateral("ask", 30, 100, 40)).toBe(usd(42));
    expect(collateral("bid", 30, 100, -100)).toBe(0);
  });
});

describe("kill switch", () => {
  const ok = { feedConnected: true, vaultPaused: false, recallOpen: false, health: 1, maxDrawdown: 0.1, manualStop: false };

  it("quotes normally when nothing is wrong", () => {
    expect(evaluate(ok).mode).toBe("normal");
  });

  it("turns quoting off on feed loss, pause, drawdown or operator stop", () => {
    expect(evaluate({ ...ok, feedConnected: false }).mode).toBe("off");
    expect(evaluate({ ...ok, vaultPaused: true }).mode).toBe("off");
    expect(evaluate({ ...ok, health: 0.89 }).mode).toBe("off");
    expect(evaluate({ ...ok, manualStop: true }).mode).toBe("off");
  });

  it("goes reduce-only on a recall, even when paused or in drawdown", () => {
    expect(evaluate({ ...ok, recallOpen: true }).mode).toBe("reduce-only");
    expect(evaluate({ ...ok, recallOpen: true, vaultPaused: true }).mode).toBe("reduce-only");
    expect(evaluate({ ...ok, recallOpen: true, health: 0.5 }).mode).toBe("reduce-only");
    expect(evaluate({ ...ok, recallOpen: true, feedConnected: false }).mode).toBe("off");
  });
});
