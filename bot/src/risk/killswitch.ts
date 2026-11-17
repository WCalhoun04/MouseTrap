import type { QuoteMode } from "../strategy/quoter.ts";

export type KillInputs = {
  feedConnected: boolean;
  vaultPaused: boolean;
  recallOpen: boolean;
  /** Exchange equity over outstanding principal; 1 when nothing is drawn. */
  health: number;
  maxDrawdown: number;
  manualStop: boolean;
};

export type KillState = { mode: QuoteMode; reason: string | null };

/**
 * Decide whether the bot may quote. "off" cancels everything; "reduce-only" cancels
 * everything and then only works out of inventory, which is how a recall gets repaid.
 */
export function evaluate(input: KillInputs): KillState {
  if (input.manualStop) return { mode: "off", reason: "Stopped by operator" };
  if (!input.feedConnected) return { mode: "off", reason: "Market data feed is down" };
  // A recall outranks a pause and a drawdown stop: the only way to repay principal that
  // is tied up in positions is to keep working out of them.
  if (input.recallOpen) return { mode: "reduce-only", reason: "Recall open: reducing inventory to repay" };
  if (input.vaultPaused) return { mode: "off", reason: "Vault is paused" };
  if (input.health < 1 - input.maxDrawdown) return { mode: "off", reason: "Drawdown limit breached" };
  return { mode: "normal", reason: null };
}
