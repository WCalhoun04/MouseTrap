import type { Contract, Fill } from "../exchange/types.ts";
import type { Micros } from "../money.ts";

/**
 * Delta hedge for contracts on a tradeable underlying (crypto, commodities), placed
 * on Gemini spot or perpetuals. Hedging a binary payoff needs a pricing model for its
 * delta, which should be fitted to Phase 0 fill data, so only the no-op exists today.
 */
export interface Hedger {
  readonly name: string;
  canHedge(contract: Contract): boolean;
  onFill(fill: Fill, contract: Contract): Promise<void>;
  /** Realised plus unrealised hedge PnL. */
  pnl(): Micros;
}

export class NoopHedger implements Hedger {
  readonly name = "none";
  canHedge(): boolean {
    return false;
  }
  async onFill(): Promise<void> {}
  pnl(): Micros {
    return 0;
  }
}
