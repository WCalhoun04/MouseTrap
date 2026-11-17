import { beforeEach, describe, expect, it } from "vitest";
import { Bot } from "../src/bot.ts";
import { PaperExchange } from "../src/exchange/paper.ts";
import { usd } from "../src/money.ts";
import { Relayer } from "../src/relayer/relayer.ts";
import { PaperTreasury } from "../src/relayer/treasury.ts";
import { SimVault } from "../src/vault/sim.ts";
import { book, contract, ManualFeed, T0, testConfig } from "./helpers.ts";

const cfg = { ...testConfig(), minDrawIntervalMs: 0, workingFloat: usd(500) };
let now: number;
let feed: ManualFeed;
let paper: PaperExchange;
let vault: SimVault;
let treasury: PaperTreasury;
let relayer: Relayer;

beforeEach(() => {
  now = T0;
  feed = new ManualFeed();
  paper = new PaperExchange(feed, { terms: cfg.terms, now: () => now });
  vault = new SimVault(cfg.vault, { now: () => now, faucet: cfg.faucet, seedDeposits: usd(20_000), seedBond: usd(4_000) });
  treasury = new PaperTreasury(paper);
  relayer = new Relayer(vault, treasury, paper, cfg, () => now);
  feed.contracts = [contract()];
  paper.watch(feed.contracts);
  feed.pushBook(book(45, 55));
});

describe("relayer", () => {
  it("draws what the bot needs when the gate passes", async () => {
    relayer.capitalWanted = usd(1_000);
    await relayer.tick();
    expect(await paper.cash()).toBe(usd(1_500));
    expect(vault.snapshot().drawnPrincipal).toBe(usd(1_500));
  });

  it("does not draw when the preview fails, and says which condition failed", async () => {
    vault.pause();
    relayer.capitalWanted = usd(1_000);
    await relayer.tick();
    expect(await paper.cash()).toBe(0);

    vault.resume();
    now += 10 * 60_000; // NAV report is now stale
    await relayer.tick();
    expect(await paper.cash()).toBe(0);
    expect(relayer.status().lastAction).toContain("NAV freshness");
  });

  it("stops drawing when trailing edge is negative", async () => {
    relayer.capitalWanted = usd(1_000);
    relayer.drawsAllowed = false;
    await relayer.tick();
    expect(vault.snapshot().drawnPrincipal).toBe(0);
  });

  it("sweeps profit after the epoch without touching principal", async () => {
    relayer.capitalWanted = usd(1_000);
    await relayer.tick();
    paper.credit(usd(12.34)); // stands in for rebates and spread earned
    await relayer.afterEpoch();
    expect(vault.snapshot().drawnPrincipal).toBe(usd(1_500));
    expect(vault.snapshot().idle).toBe(usd(20_000 - 1_500 + 12.34));
    expect(await paper.cash()).toBe(usd(1_500));
  });

  it("returns principal the bot no longer needs", async () => {
    relayer.capitalWanted = usd(3_000);
    await relayer.tick();
    relayer.capitalWanted = usd(500);
    await relayer.afterEpoch();
    // Target is 1,000 (500 wanted + 500 float); anything over 1.5x that goes back.
    expect(vault.snapshot().drawnPrincipal).toBe(usd(1_500));
  });

  it("repays a forced recall from free cash", async () => {
    relayer.capitalWanted = usd(1_000);
    await relayer.tick();
    vault.forceRecall();
    await relayer.tick();
    expect(vault.snapshot().drawnPrincipal).toBe(0);
    expect(vault.snapshot().recall).toBeNull();
    expect(await paper.cash()).toBe(0);
  });
});

describe("bot and relayer together", () => {
  it("quotes after a draw, cancels on recall, and repays as inventory is worked off", async () => {
    const bot = new Bot({ cfg, exchange: paper, vault, relayer, treasury, paper, simVault: vault, now: () => now });
    await bot.refreshSelection();
    await bot.attest();

    await bot.tick(); // no cash yet: asks the relayer for capital
    expect(bot.status().contracts[0]!.note).toBe("waiting for capital");
    await relayer.tick();
    expect(vault.snapshot().drawnPrincipal).toBeGreaterThan(0);

    await bot.tick();
    expect(bot.status().contracts[0]).toMatchObject({ ourBid: { price: 46, qty: 100 }, ourAsk: { price: 54, qty: 100 } });

    feed.pushTrade(45, 40); // a seller trades through our bid
    await bot.tick();
    expect(bot.status().contracts[0]!.position).toBe(40);
    expect(bot.status().fills).toHaveLength(1);

    vault.forceRecall();
    await bot.tick();
    const during = bot.status();
    expect(during.quoteMode).toBe("reduce-only");
    expect(during.contracts[0]!.ourBid).toBeNull();
    expect(during.contracts[0]!.ourAsk).toMatchObject({ qty: 40 });

    await relayer.tick(); // free cash goes back first
    const owed = vault.snapshot().drawnPrincipal;
    expect(owed).toBeGreaterThan(0);
    expect(owed).toBeLessThan(usd(25));

    feed.pushTrade(55, 40); // a buyer lifts our reducing ask
    await bot.tick();
    await relayer.tick();
    expect(vault.snapshot().drawnPrincipal).toBe(0);
    expect(vault.snapshot().recall).toBeNull();
  });
});
