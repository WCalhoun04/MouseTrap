import { beforeEach, describe, expect, it } from "vitest";
import { usd } from "../src/money.ts";
import { checkDraw } from "../src/vault/gate.ts";
import { SimVault } from "../src/vault/sim.ts";
import type { VaultState } from "../src/vault/types.ts";
import { T0, testConfig } from "./helpers.ts";

const params = { ...testConfig().vault, absoluteCap: usd(60_000), navMaxAgeMs: 60_000, recallDeadlineMs: 120_000 };

const healthy: VaultState = {
  idle: usd(60_000),
  geminiEquity: usd(40_000),
  drawnPrincipal: usd(40_000),
  bond: usd(10_000),
  totalShares: usd(100_000),
  paused: false,
  recall: null,
  queuedWithdrawals: 0,
  navAt: T0 - 1_000,
  epoch: 1,
  absoluteCap: usd(60_000),
};

const failing = (state: Partial<VaultState>, amount = usd(5_000), p = params) =>
  checkDraw({ ...healthy, ...state }, p, amount, T0)
    .checks.filter((c) => !c.pass)
    .map((c) => c.id);

describe("draw gate", () => {
  it("passes a healthy draw", () => {
    expect(checkDraw(healthy, params, usd(5_000), T0).ok).toBe(true);
  });

  it("1: fails when the bond is under 15% of outstanding plus requested", () => {
    expect(failing({ bond: usd(6_000) })).toEqual([1]);
  });

  it("2: fails over the absolute cap", () => {
    expect(failing({ absoluteCap: usd(42_000) })).toEqual([2]);
  });

  it("3: fails when outstanding would pass 60% of NAV", () => {
    expect(
      failing({ drawnPrincipal: usd(58_000), geminiEquity: usd(58_000), idle: usd(42_000), absoluteCap: usd(200_000) }),
    ).toEqual([3]);
  });

  it("4: fails when the idle buffer would drop under 20% of NAV or queued withdrawals", () => {
    expect(failing({}, usd(15_000), { ...params, bufferRatio: 0.5 })).toEqual([4]);
    expect(failing({ queuedWithdrawals: usd(58_000) })).toEqual([4]);
  });

  it("5: fails on a stale NAV report", () => {
    expect(failing({ navAt: T0 - 61_000 })).toEqual([5]);
  });

  it("6: fails when Gemini equity is under 97% of drawn principal", () => {
    expect(failing({ geminiEquity: usd(38_700) })).toEqual([6]);
  });

  it("7: the destination is fixed, so it always passes", () => {
    expect(checkDraw(healthy, params, usd(5_000), T0).checks.find((c) => c.id === 7)?.pass).toBe(true);
  });

  it("8: fails when paused, in recall, or over the per-draw limit", () => {
    expect(failing({ paused: true })).toEqual([8]);
    expect(
      failing({ recall: { amount: 1, repaid: 0, openedAt: T0, deadline: T0 + 1, reason: "sentinel" } }),
    ).toEqual([8]);
    expect(failing({}, usd(15_001))).toContain(8);
  });
});

describe("simulated vault", () => {
  let now: number;
  let vault: SimVault;

  beforeEach(() => {
    now = T0;
    vault = new SimVault(params, {
      now: () => now,
      faucet: usd(25_000),
      seedDeposits: usd(100_000),
      seedBond: usd(10_000),
    });
  });

  it("mints shares at the share price and gives each wallet fake USDC", () => {
    expect(vault.account("alice").cash).toBe(usd(25_000));
    expect(vault.deposit("alice", usd(1_000), false)).toMatchObject({ ok: false });
    expect(vault.deposit("alice", usd(1_000), true).ok).toBe(true);
    expect(vault.account("alice").shares).toBeCloseTo(usd(1_000), 0);
    expect(vault.snapshot().idle).toBe(usd(101_000));
  });

  it("releases a draw only through the gate and tracks principal", async () => {
    expect((await vault.requestDraw(usd(70_000), [])).ok).toBe(false);
    expect((await vault.requestDraw(usd(10_000), ["crypto"])).ok).toBe(true);
    const s = vault.snapshot();
    expect(s.drawnPrincipal).toBe(usd(10_000));
    expect(s.idle).toBe(usd(90_000));
    // In transit counts as equity, so the share price does not dip on a draw.
    expect(vault.sharePrice()).toBe(1);
  });

  it("moves the share price only through NAV reports", async () => {
    await vault.requestDraw(usd(10_000), []);
    vault.submitNav(usd(10_100));
    expect(vault.sharePrice()).toBeCloseTo(1.001, 6);
  });

  it("keeps principal unchanged on a profit sweep and reduces it on repay", async () => {
    await vault.requestDraw(usd(10_000), []);
    vault.submitNav(usd(10_100));
    await vault.sweepProfit(usd(100));
    expect(vault.snapshot().drawnPrincipal).toBe(usd(10_000));
    await vault.repay(usd(4_000));
    expect(vault.snapshot().drawnPrincipal).toBe(usd(6_000));
    expect(vault.sharePrice()).toBeCloseTo(1.001, 6);
  });

  it("pays small withdrawals from idle and queues large ones behind a recall", async () => {
    vault = new SimVault(
      { ...params, bufferRatio: 0.4 },
      { now: () => now, faucet: usd(25_000), seedDeposits: usd(100_000), seedBond: usd(10_000) },
    );
    vault.deposit("alice", usd(20_000), true);
    for (let i = 0; i < 4; i += 1) expect((await vault.requestDraw(usd(15_000), [])).ok).toBe(true);
    // NAV 120k, idle 60k, buffer 48k: 12k of instant room.
    expect(vault.requestWithdraw("alice", usd(5_000))).toMatchObject({ ok: true, settlement: "instant" });
    expect(vault.snapshot().recall).toBeNull();

    // 7k of room left, so 15k has to wait for the operator.
    expect(vault.requestWithdraw("alice", usd(15_000))).toMatchObject({ settlement: "queued" });
    const recall = vault.snapshot().recall;
    expect(recall?.reason).toBe("withdrawals");
    // Queued 15k + promised 5k + buffer 48k - idle 60k.
    expect(recall!.amount).toBe(usd(8_000));
    // An open recall blocks new draws.
    expect((await vault.previewDraw(usd(1_000))).checks.find((c) => c.id === 8)?.pass).toBe(false);

    await vault.repay(recall!.amount);
    expect(vault.snapshot().recall).toBeNull();
    for (const w of [...vault.account("alice").withdrawals]) {
      expect(vault.claimWithdraw("alice", w.id).ok).toBe(true);
    }
    expect(vault.account("alice").cash).toBeCloseTo(usd(25_000), -2);
    expect(vault.account("alice").shares).toBe(0);
  });

  it("recalls everything and slashes the bond when equity falls under 90% of drawn", async () => {
    await vault.requestDraw(usd(10_000), []);
    vault.submitNav(usd(8_500));
    const s = vault.snapshot();
    expect(s.recall?.reason).toBe("breaker");
    expect(s.recall?.amount).toBe(usd(10_000));
    expect(s.bond).toBe(usd(8_500));
    expect(s.idle).toBe(usd(91_500));
  });

  it("slashes the whole bond and pauses when a recall deadline is missed", async () => {
    await vault.requestDraw(usd(10_000), []);
    expect(vault.forceRecall().ok).toBe(true);
    expect(vault.slashBond().ok).toBe(false);
    now += 121_000;
    vault.tick();
    const s = vault.snapshot();
    expect(s.paused).toBe(true);
    expect(s.bond).toBe(0);
    expect(s.idle).toBe(usd(100_000));
  });

  it("opens a recall when attestors go silent", async () => {
    await vault.requestDraw(usd(10_000), []);
    now += params.navSilenceMs + 1;
    vault.tick();
    expect(vault.snapshot().recall?.reason).toBe("nav-silence");
  });

  it("locks the bond behind outstanding draws", async () => {
    await vault.requestDraw(usd(10_000), []);
    expect(vault.releaseBond(usd(9_000)).ok).toBe(false);
    expect(vault.releaseBond(usd(8_000)).ok).toBe(true);
  });
});
