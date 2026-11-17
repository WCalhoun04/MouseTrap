import type { Exchange } from "../exchange/types.ts";
import type { PaperExchange } from "../exchange/paper.ts";
import type { Micros } from "../money.ts";

/**
 * The money path between the vault and the operator's Gemini account. Kept apart
 * from the trading loop because the trading API key cannot withdraw: this leg uses a
 * separate key whose only allowed withdrawal address is the vault.
 */
export interface Treasury {
  /** USDC from an approved draw arriving at Gemini. */
  toExchange(amount: Micros): Promise<void>;
  /** USDC leaving Gemini for the vault's address. */
  toVault(amount: Micros): Promise<void>;
  /** Cash that could leave Gemini right now. */
  withdrawable(): Promise<Micros>;
  /** Net USDC sent to the exchange so far (draws minus repayments and sweeps). */
  netFunded(): Micros;
}

/** Fake USDC moving in and out of the paper account. */
export class PaperTreasury implements Treasury {
  private funded: Micros = 0;
  constructor(private readonly paper: PaperExchange) {}

  async toExchange(amount: Micros): Promise<void> {
    this.paper.credit(amount);
    this.funded += amount;
  }

  async toVault(amount: Micros): Promise<void> {
    this.paper.debit(amount);
    this.funded -= amount;
  }

  async withdrawable(): Promise<Micros> {
    return this.paper.withdrawable();
  }

  netFunded(): Micros {
    return this.funded;
  }
}

/**
 * Bookkeeping only, for sandbox and live runs while the escrow program does not
 * exist: draws and repayments are recorded against the simulated vault but no USDC
 * moves. The account trades whatever the operator funded it with by hand.
 */
export class NotionalTreasury implements Treasury {
  private funded: Micros = 0;
  constructor(private readonly exchange: Exchange) {}

  async toExchange(amount: Micros): Promise<void> {
    this.funded += amount;
  }

  async toVault(amount: Micros): Promise<void> {
    this.funded -= amount;
  }

  async withdrawable(): Promise<Micros> {
    return Math.max(0, Math.min(this.funded, await this.exchange.freeCash()));
  }

  netFunded(): Micros {
    return this.funded;
  }
}
