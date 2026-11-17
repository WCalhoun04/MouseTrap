import type { Micros } from "../money.ts";

export type Recall = {
  /** Principal the operator must return. */
  amount: Micros;
  repaid: Micros;
  openedAt: number;
  deadline: number;
  reason: "sentinel" | "withdrawals" | "breaker" | "nav-silence";
};

export type VaultState = {
  idle: Micros;
  /** Attested Gemini equity, adjusted for draws and repayments since the last report. */
  geminiEquity: Micros;
  drawnPrincipal: Micros;
  bond: Micros;
  /** Shares in micro-units, like the mvUSDC mint. */
  totalShares: number;
  paused: boolean;
  recall: Recall | null;
  /** Withdrawals queued beyond the idle buffer. */
  queuedWithdrawals: Micros;
  navAt: number;
  epoch: number;
  absoluteCap: Micros;
};

export type GateCheck = {
  id: number;
  label: string;
  pass: boolean;
  value: string;
  requirement: string;
};

export type GateResult = { ok: boolean; checks: GateCheck[] };

export type TxResult = { ok: true } | { ok: false; error: string };

/**
 * What the bot and relayer need from the escrow. The simulated vault implements it
 * now; an Anchor client for the on-chain program implements it later.
 */
export interface VaultClient {
  state(): Promise<VaultState>;
  /** Run every draw-gate condition without moving funds. */
  previewDraw(amount: Micros): Promise<GateResult>;
  /** `request_draw`: on success USDC leaves for the stored Gemini deposit address. */
  requestDraw(amount: Micros, categories: string[]): Promise<TxResult>;
  /** `repay`: USDC back into the idle account, reducing outstanding principal. */
  repay(amount: Micros): Promise<TxResult>;
  /** Daily sweep of profit: USDC into the idle account without touching principal. */
  sweepProfit(amount: Micros): Promise<TxResult>;
}

export type EpochBooking = { rebates: Micros; rewards: Micros; spread: Micros };

/**
 * The attestor and crank roles the bot stands in for until independent attestors
 * exist: post NAV, settle the epoch, and run deadline checks.
 */
export interface VaultCrank {
  submitNav(equity: Micros): Promise<void>;
  settleEpoch(booking: EpochBooking): Promise<void>;
  tick(): Promise<void>;
}
