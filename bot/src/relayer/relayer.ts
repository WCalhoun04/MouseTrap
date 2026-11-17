import type { Config } from "../config.ts";
import type { Exchange } from "../exchange/types.ts";
import { fmtUsd, usd, type Micros } from "../money.ts";
import type { GateResult, VaultClient } from "../vault/types.ts";
import type { Treasury } from "./treasury.ts";

type RelayerConfig = Pick<Config, "workingFloat" | "minDrawIntervalMs" | "vault">;

export type RelayerStatus = {
  capitalWanted: Micros;
  drawsAllowed: boolean;
  drawBlockReason: string | null;
  lastGate: GateResult | null;
  lastAction: string | null;
  lastActionAt: number | null;
};

const STEP = usd(100);
const MIN_MOVE = usd(1);

/**
 * Submits draw, repay and sweep transactions. It is trusted for nothing: the vault's
 * gate checks every draw, so the worst a broken relayer can do is fail to draw.
 */
export class Relayer {
  /** Collateral the bot wants on the exchange. Set by the quoting loop. */
  capitalWanted: Micros = 0;
  /** Cleared when trailing net edge turns negative. */
  drawsAllowed = true;
  drawBlockReason: string | null = null;

  private lastDrawAt = 0;
  private busy = false;
  private lastGate: GateResult | null = null;
  private lastAction: string | null = null;
  private lastActionAt: number | null = null;

  constructor(
    private readonly vault: VaultClient,
    private readonly treasury: Treasury,
    private readonly exchange: Exchange,
    private readonly cfg: RelayerConfig,
    private readonly now: () => number = Date.now,
    private readonly log: (text: string) => void = () => {},
  ) {}

  status(): RelayerStatus {
    return {
      capitalWanted: this.capitalWanted,
      drawsAllowed: this.drawsAllowed,
      drawBlockReason: this.drawBlockReason,
      lastGate: this.lastGate,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
    };
  }

  /** Runs every few seconds: answer recalls first, then top up capital if needed. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const state = await this.vault.state();
      if (state.recall) {
        await this.repayRecall(state.recall.amount - state.recall.repaid, state.drawnPrincipal);
        return;
      }
      if (state.paused) return;
      await this.maybeDraw();
    } finally {
      this.busy = false;
    }
  }

  /** Runs after each epoch's rebate payout and NAV report. */
  async afterEpoch(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.sweepProfit();
      await this.returnExcess();
    } finally {
      this.busy = false;
    }
  }

  private async repayRecall(owed: Micros, principal: Micros): Promise<void> {
    const pay = Math.min(owed, principal, await this.treasury.withdrawable());
    if (pay < MIN_MOVE) return;
    await this.treasury.toVault(pay);
    const result = await this.vault.repay(pay);
    this.note(result.ok ? `Repaid ${fmtUsd(pay)} against the recall` : `Repay failed: ${result.error}`);
  }

  private async maybeDraw(): Promise<void> {
    const cash = await this.exchange.cash();
    const shortBy = this.capitalWanted + this.cfg.workingFloat - cash;
    if (shortBy < STEP) return;
    if (!this.drawsAllowed) return;
    const now = this.now();
    if (now - this.lastDrawAt < this.cfg.minDrawIntervalMs) return;

    const state = await this.vault.state();
    const perDraw = this.cfg.vault.perDrawShare * state.absoluteCap;
    const amount = Math.min(Math.ceil(shortBy / STEP) * STEP, Math.floor(perDraw / STEP) * STEP);
    if (amount < STEP) return;

    // Preview first, so a failing draw never costs a transaction.
    const preview = await this.vault.previewDraw(amount);
    this.lastGate = preview;
    this.lastDrawAt = now;
    if (!preview.ok) {
      const failed = preview.checks.filter((c) => !c.pass).map((c) => c.label);
      this.note(`Draw of ${fmtUsd(amount)} held back: ${failed.join(", ")}`);
      return;
    }

    const result = await this.vault.requestDraw(amount, []);
    if (!result.ok) {
      this.note(`Draw rejected: ${result.error}`);
      return;
    }
    await this.treasury.toExchange(amount);
    this.note(`Drew ${fmtUsd(amount)}`);
  }

  /** Profit is equity above outstanding principal. Send it home, keeping the float. */
  private async sweepProfit(): Promise<void> {
    const state = await this.vault.state();
    if (state.drawnPrincipal <= 0) return;
    const profit = (await this.exchange.equity()) - state.drawnPrincipal;
    const spare = (await this.treasury.withdrawable()) - this.cfg.workingFloat;
    const amount = Math.floor(Math.min(profit, spare));
    if (amount < MIN_MOVE) return;
    await this.treasury.toVault(amount);
    const result = await this.vault.sweepProfit(amount);
    this.note(result.ok ? `Swept ${fmtUsd(amount)} of profit to the vault` : `Sweep failed: ${result.error}`);
  }

  /** Principal the bot is not using goes back, so stakers are not exposed for nothing. */
  private async returnExcess(): Promise<void> {
    const state = await this.vault.state();
    if (state.drawnPrincipal <= 0) return;
    const target = this.capitalWanted + this.cfg.workingFloat;
    const excess = (await this.treasury.withdrawable()) - target * 1.5;
    const amount = Math.floor(Math.min(excess, state.drawnPrincipal) / STEP) * STEP;
    if (amount < STEP) return;
    await this.treasury.toVault(amount);
    const result = await this.vault.repay(amount);
    this.note(result.ok ? `Returned ${fmtUsd(amount)} of unused principal` : `Repay failed: ${result.error}`);
  }

  private note(text: string): void {
    this.lastAction = text;
    this.lastActionAt = this.now();
    this.log(text);
  }
}
