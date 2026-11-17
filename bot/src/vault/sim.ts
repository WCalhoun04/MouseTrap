import type { VaultParams } from "../config.ts";
import { fmtUsd, type Micros } from "../money.ts";
import { checkDraw } from "./gate.ts";
import type { GateResult, Recall, TxResult, VaultClient, VaultCrank, VaultState } from "./types.ts";

export type Withdrawal = {
  id: string;
  /** Micro-shares. */
  shares: number;
  costBasis: Micros;
  requestedAt: number;
  settlement: "instant" | "queued";
  /** USDC value when requested; what the queue reserves. */
  quoted: Micros;
  /** On-chain tickets: a fixed USDC value, a status line, and whether it can be claimed now. */
  usdc?: Micros;
  note?: string;
  claimable?: boolean;
};

export type Activity = { id: string; kind: "deposit" | "request" | "claim"; usdc: Micros; at: number };

export type Account = {
  cash: Micros;
  shares: number;
  costBasis: Micros;
  lifetimeDeposited: Micros;
  realizedYield: Micros;
  depositedAt: number | null;
  acceptedRisk: boolean;
  withdrawals: Withdrawal[];
  activity: Activity[];
};

export type Booking = { t: number; epoch: number; rebates: Micros; rewards: Micros; spread: Micros };
export type VaultEvent = { at: number; kind: string; text: string };

type Options = {
  now?: () => number;
  faucet: Micros;
  seedDeposits: Micros;
  seedBond: Micros;
};

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * In-memory stand-in for the escrow program in AGENTS.md section 4. It implements the
 * same instructions and enforces the same draw gate, with fake USDC.
 *
 * Two shortcuts against the design, both to keep a live demo readable:
 * deposits mint shares at the current price (not the next epoch's), and instant
 * withdrawals can be claimed without waiting for the epoch to settle.
 */
export class SimVault implements VaultClient {
  private readonly params: VaultParams;
  private readonly now: () => number;
  private readonly faucet: Micros;

  private idle: Micros = 0;
  private geminiEquity: Micros = 0;
  private drawn: Micros = 0;
  private bond: Micros = 0;
  private totalShares = 0;
  private paused = false;
  private recall: (Recall & { missed?: boolean }) | null = null;
  private navAt: number;
  private epoch = 1;
  private seq = 0;

  private readonly accounts = new Map<string, Account>();
  readonly history: { t: number; price: number }[] = [];
  readonly bookings: Booking[] = [];
  readonly events: VaultEvent[] = [];

  constructor(params: VaultParams, options: Options) {
    this.params = params;
    this.now = options.now ?? Date.now;
    this.faucet = options.faucet;
    this.navAt = this.now();
    // Other stakers' deposits and the operator's bond, so draws can pass from the start.
    this.idle = options.seedDeposits;
    this.totalShares = options.seedDeposits;
    this.bond = options.seedBond;
    this.history.push({ t: this.navAt, price: this.sharePrice() });
  }

  // --- views ---

  snapshot(): VaultState {
    return {
      idle: this.idle,
      geminiEquity: this.geminiEquity,
      drawnPrincipal: this.drawn,
      bond: this.bond,
      totalShares: this.totalShares,
      paused: this.paused,
      recall: this.recall ? { ...this.recall } : null,
      queuedWithdrawals: this.queued(),
      navAt: this.navAt,
      epoch: this.epoch,
      absoluteCap: this.params.absoluteCap,
    };
  }

  async state(): Promise<VaultState> {
    return this.snapshot();
  }

  /** USDC per share. Shares and USDC both use 6 decimals, so this is a plain ratio. */
  sharePrice(): number {
    return this.totalShares > 0 ? this.netAssets() / this.totalShares : 1;
  }

  account(wallet: string): Account {
    let account = this.accounts.get(wallet);
    if (!account) {
      account = {
        cash: this.faucet,
        shares: 0,
        costBasis: 0,
        lifetimeDeposited: 0,
        realizedYield: 0,
        depositedAt: null,
        acceptedRisk: false,
        withdrawals: [],
        activity: [],
      };
      this.accounts.set(wallet, account);
    }
    return account;
  }

  gate(amount: Micros = 0): GateResult {
    return checkDraw(this.snapshot(), this.params, amount, this.now());
  }

  // --- staker instructions ---

  deposit(wallet: string, amount: Micros, acceptRisk: boolean): Result {
    const account = this.account(wallet);
    if (this.paused) return { ok: false, error: "Deposits are paused." };
    if (!account.acceptedRisk && !acceptRisk) {
      return { ok: false, error: "Accept the risk disclosure before depositing." };
    }
    if (!(amount > 0)) return { ok: false, error: "Enter a USDC amount." };
    if (amount > account.cash) return { ok: false, error: "That is more test USDC than you have." };

    const minted = amount / this.sharePrice();
    const at = this.now();
    account.acceptedRisk = true;
    account.cash -= amount;
    account.shares += minted;
    account.costBasis += amount;
    account.lifetimeDeposited += amount;
    account.depositedAt ??= at;
    this.pushActivity(account, "deposit", amount, at);
    this.idle += amount;
    this.totalShares += minted;
    this.log("deposit", `Deposit of ${fmtUsd(amount)}`);
    return { ok: true };
  }

  requestWithdraw(wallet: string, amount: Micros): Result<{ settlement: "instant" | "queued" }> {
    const account = this.account(wallet);
    if (this.paused) return { ok: false, error: "Withdrawals are paused." };
    const price = this.sharePrice();
    const full = account.shares * price;
    if (!(amount > 0)) return { ok: false, error: "Enter a USDC amount." };
    if (amount > full + 1_000) return { ok: false, error: "That is more than the shares you can withdraw." };

    const shares = amount >= full - 10_000 ? account.shares : amount / price;
    if (shares <= 0) return { ok: false, error: "Enter a USDC amount." };
    const payout = Math.round(shares * price);
    const settlement = payout <= this.instantRoom() ? "instant" : "queued";
    const costOut = account.costBasis * (shares / account.shares);
    const at = this.now();

    account.shares = Math.max(0, account.shares - shares);
    account.costBasis = Math.max(0, account.costBasis - costOut);
    account.withdrawals.unshift({
      id: `W${++this.seq}`,
      shares,
      costBasis: costOut,
      requestedAt: at,
      settlement,
      quoted: payout,
    });
    this.pushActivity(account, "request", payout, at);

    if (settlement === "queued") this.raiseWithdrawalRecall();
    this.log("withdraw", `Withdrawal request of ${fmtUsd(payout)} (${settlement})`);
    return { ok: true, settlement };
  }

  claimWithdraw(wallet: string, id: string): Result {
    const account = this.account(wallet);
    const withdrawal = account.withdrawals.find((w) => w.id === id);
    if (!withdrawal) return { ok: false, error: "That withdrawal is no longer open." };
    const payout = Math.round(withdrawal.shares * this.sharePrice());
    if (payout > this.idle) {
      return {
        ok: false,
        error: this.recall
          ? "Idle USDC cannot cover this claim yet. The operator is repaying a recall."
          : "Idle USDC cannot cover this claim yet.",
      };
    }
    const at = this.now();
    this.idle -= payout;
    this.totalShares = Math.max(0, this.totalShares - withdrawal.shares);
    account.cash += payout;
    account.realizedYield += payout - withdrawal.costBasis;
    account.withdrawals = account.withdrawals.filter((w) => w.id !== id);
    this.pushActivity(account, "claim", payout, at);
    this.log("withdraw", `Claim of ${fmtUsd(payout)}`);
    return { ok: true };
  }

  // --- operator instructions ---

  postBond(amount: Micros): Result {
    if (!(amount > 0)) return { ok: false, error: "Bond must be positive." };
    this.bond += amount;
    return { ok: true };
  }

  /** Only the part above what outstanding draws require can leave. */
  releaseBond(amount: Micros): Result {
    const required = this.params.bondMin * this.drawn;
    if (this.bond - amount < required) return { ok: false, error: "Bond is locked behind outstanding draws." };
    this.bond -= amount;
    return { ok: true };
  }

  async previewDraw(amount: Micros): Promise<GateResult> {
    return this.gate(amount);
  }

  async requestDraw(amount: Micros, categories: string[]): Promise<TxResult> {
    if (!(amount > 0)) return { ok: false, error: "Draw must be positive." };
    const result = this.gate(amount);
    if (!result.ok) {
      const failed = result.checks.filter((c) => !c.pass).map((c) => c.label);
      return { ok: false, error: `Draw gate failed: ${failed.join(", ")}` };
    }
    this.idle -= amount;
    this.drawn += amount;
    // The USDC is in transit to Gemini; count it until the next NAV report confirms it.
    this.geminiEquity += amount;
    this.log("draw", `Draw of ${fmtUsd(amount)} for ${categories.join(", ") || "all categories"}`);
    return { ok: true };
  }

  async repay(amount: Micros): Promise<TxResult> {
    if (!(amount > 0)) return { ok: false, error: "Repayment must be positive." };
    this.idle += amount;
    this.geminiEquity = Math.max(0, this.geminiEquity - amount);
    this.drawn = Math.max(0, this.drawn - amount);
    if (this.recall) {
      this.recall.repaid += amount;
      if (this.recall.repaid >= this.recall.amount || this.drawn === 0) {
        const seconds = Math.round((this.now() - this.recall.openedAt) / 1000);
        this.log("recall", `Recall repaid in ${seconds}s`);
        this.recall = null;
      }
    }
    this.log("repay", `Repayment of ${fmtUsd(amount)}`);
    return { ok: true };
  }

  async sweepProfit(amount: Micros): Promise<TxResult> {
    if (!(amount > 0)) return { ok: false, error: "Sweep must be positive." };
    this.idle += amount;
    this.geminiEquity = Math.max(0, this.geminiEquity - amount);
    this.log("sweep", `Profit sweep of ${fmtUsd(amount)}`);
    return { ok: true };
  }

  // --- attestors and crank ---

  /** Record a quorum-signed NAV report and run the circuit breakers. */
  submitNav(equity: Micros): void {
    this.geminiEquity = Math.max(0, equity);
    this.navAt = this.now();
    this.history.push({ t: this.navAt, price: this.sharePrice() });
    if (this.history.length > 2_000) this.history.shift();

    if (this.drawn <= 0) return;
    const health = this.geminiEquity / this.drawn;
    if (health < this.params.recallHealth) {
      // Below 90%: full recall, and the bond covers the gap first.
      const gap = Math.min(this.bond, this.drawn - this.geminiEquity);
      if (gap > 0) {
        this.bond -= gap;
        this.idle += gap;
        this.log("slash", `Bond slashed ${fmtUsd(gap)} to cover an equity shortfall`);
      }
      this.openRecall(this.drawn, "breaker");
    }
  }

  settleEpoch(booking: Omit<Booking, "t" | "epoch">): void {
    this.bookings.push({ t: this.now(), epoch: this.epoch, ...booking });
    if (this.bookings.length > 200) this.bookings.shift();
    this.epoch += 1;
  }

  /** Deadline checks that on-chain would run inside whichever instruction lands next. */
  tick(): void {
    const now = this.now();
    if (this.recall && !this.recall.missed && now > this.recall.deadline && this.drawn > 0) {
      this.recall.missed = true;
      this.paused = true;
      this.slashBond();
    }
    if (!this.recall && this.drawn > 0 && now - this.navAt > this.params.navSilenceMs) {
      this.openRecall(this.drawn, "nav-silence");
    }
  }

  /** Callable by anyone once a recall deadline has been missed. */
  slashBond(): Result {
    if (!this.recall?.missed) return { ok: false, error: "No missed recall deadline." };
    if (this.bond <= 0) return { ok: false, error: "No bond left to slash." };
    this.log("slash", `Recall deadline missed: bond of ${fmtUsd(this.bond)} slashed in full`);
    this.idle += this.bond;
    this.bond = 0;
    return { ok: true };
  }

  // --- sentinel ---

  pause(): void {
    this.paused = true;
    this.log("sentinel", "Sentinel paused draws");
  }

  resume(): void {
    this.paused = false;
    if (this.recall && this.recall.reason === "sentinel") this.recall = null;
    this.log("sentinel", "Sentinel resumed draws");
  }

  forceRecall(): Result {
    if (this.drawn <= 0) return { ok: false, error: "Nothing is drawn." };
    this.openRecall(this.drawn, "sentinel");
    return { ok: true };
  }

  // --- internals ---

  private netAssets(): Micros {
    return this.idle + this.geminiEquity;
  }

  private queued(): Micros {
    let total = 0;
    for (const account of this.accounts.values()) {
      for (const w of account.withdrawals) if (w.settlement === "queued") total += w.quoted;
    }
    return total;
  }

  private pendingInstant(): Micros {
    let total = 0;
    for (const account of this.accounts.values()) {
      for (const w of account.withdrawals) if (w.settlement === "instant") total += w.quoted;
    }
    return total;
  }

  /** Idle USDC above the buffer and above instant withdrawals already promised. */
  instantRoom(): Micros {
    return Math.max(0, this.idle - this.params.bufferRatio * this.netAssets() - this.pendingInstant());
  }

  private raiseWithdrawalRecall(): void {
    const needed = this.queued() + this.pendingInstant() + this.params.bufferRatio * this.netAssets() - this.idle;
    const shortfall = Math.min(this.drawn, Math.max(0, Math.round(needed)));
    if (shortfall > 0) this.openRecall(shortfall, "withdrawals");
  }

  private openRecall(amount: Micros, reason: Recall["reason"]): void {
    if (amount <= 0) return;
    const now = this.now();
    if (this.recall) {
      // An open recall only ever grows; the deadline stays where it was.
      this.recall.amount = Math.max(this.recall.amount, this.recall.repaid + amount);
      return;
    }
    this.recall = { amount, repaid: 0, openedAt: now, deadline: now + this.params.recallDeadlineMs, reason };
    this.log("recall", `Recall of ${fmtUsd(amount)} opened (${reason})`);
  }

  private pushActivity(account: Account, kind: Activity["kind"], usdc: Micros, at: number): void {
    account.activity.unshift({ id: `A${++this.seq}`, kind, usdc, at });
    account.activity = account.activity.slice(0, 12);
  }

  private log(kind: string, text: string): void {
    this.events.unshift({ at: this.now(), kind, text });
    if (this.events.length > 60) this.events.pop();
  }
}

export function simCrank(vault: SimVault): VaultCrank {
  return {
    submitNav: async (equity) => vault.submitNav(equity),
    settleEpoch: async (booking) => vault.settleEpoch(booking),
    tick: async () => vault.tick(),
  };
}
