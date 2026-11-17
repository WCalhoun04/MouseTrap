import { describe, expect, it } from "vitest";
import { usd } from "../src/money.ts";
import { makerFee, netRebate, rebateAccrual, rebatePayout } from "../src/strategy/rebate.ts";

describe("rebate maths", () => {
  // The table in AGENTS.md section 2, per 100 contracts.
  it.each([
    [20, 0.33, 0.28, 0.05],
    [40, 0.5, 0.42, 0.08],
    [50, 0.52, 0.44, 0.08],
    [80, 0.33, 0.28, 0.05],
  ])("matches Gemini's worked example at %i cents", (price, rebate, fee, after) => {
    const net = netRebate(price, 100);
    expect(net.rebate).toBe(usd(rebate));
    expect(net.duringWaiver).toBe(usd(rebate));
    expect(makerFee(price, 100)).toBe(usd(fee));
    expect(net.afterWaiver).toBe(usd(after));
  });

  it("pays nothing outside the $0.20 to $0.80 band", () => {
    expect(rebateAccrual(19, 100)).toBe(0);
    expect(rebateAccrual(81, 100)).toBe(0);
    expect(rebateAccrual(20, 100)).toBeGreaterThan(0);
    expect(rebateAccrual(80, 100)).toBeGreaterThan(0);
  });

  it("caps the rebate at 5% of fill notional", () => {
    const generous = { rebateRate: 1, takerRate: 1, makerFeeRate: 0, bandLow: 20, bandHigh: 80, cap: 0.05 };
    // 100 contracts at 50 cents is $50 of notional, so the cap is $2.50.
    expect(rebateAccrual(50, 100, generous)).toBe(usd(2.5));
  });

  it("rounds the payout down to the cent across many small fills", () => {
    let accrued = 0;
    for (let i = 0; i < 3; i += 1) accrued += rebateAccrual(50, 1);
    // Three fills of 0.525 cents accrue 1.575 cents and pay one cent.
    expect(rebatePayout(accrued)).toBe(usd(0.01));
  });
});
