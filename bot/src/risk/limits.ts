import type { RiskLimits } from "../config.ts";
import type { Category, Contract, Side } from "../exchange/types.ts";
import { CENT, type Cents, type Micros } from "../money.ts";

export type Inventory = {
  /** Net YES contracts by symbol. */
  bySymbol: Map<string, number>;
  byEvent: Map<string, number>;
  byCategory: Map<Category, number>;
  /** Sum of absolute net positions. */
  gross: number;
};

export function buildInventory(
  positions: Iterable<{ symbol: string; qty: number }>,
  contracts: Map<string, Contract>,
): Inventory {
  const inv: Inventory = { bySymbol: new Map(), byEvent: new Map(), byCategory: new Map(), gross: 0 };
  for (const { symbol, qty } of positions) {
    if (qty === 0) continue;
    inv.bySymbol.set(symbol, qty);
    inv.gross += Math.abs(qty);
    const contract = contracts.get(symbol);
    if (!contract) continue;
    inv.byEvent.set(contract.eventTicker, (inv.byEvent.get(contract.eventTicker) ?? 0) + Math.abs(qty));
    inv.byCategory.set(contract.category, (inv.byCategory.get(contract.category) ?? 0) + Math.abs(qty));
  }
  return inv;
}

/**
 * Largest size (up to `want`) that a new order on `side` may have without breaching a cap.
 * An order that reduces the position is always allowed up to the size that flattens it.
 */
export function allowedSize(
  contract: Contract,
  side: Side,
  want: number,
  inv: Inventory,
  limits: RiskLimits,
): number {
  const pos = inv.bySymbol.get(contract.symbol) ?? 0;
  const dir = side === "bid" ? 1 : -1;
  // The part of the order that only closes existing inventory adds no exposure.
  const reducing = pos * dir < 0 ? Math.min(want, Math.abs(pos)) : 0;
  const adding = want - reducing;
  if (adding <= 0) return want;

  const exposureAfterClose = Math.abs(pos + dir * reducing);
  const eventUsed = (inv.byEvent.get(contract.eventTicker) ?? 0) - reducing;
  const categoryUsed = (inv.byCategory.get(contract.category) ?? 0) - reducing;
  const grossUsed = inv.gross - reducing;

  const room = Math.min(
    limits.maxPerContract - exposureAfterClose,
    limits.maxPerEvent - eventUsed,
    limits.maxPerCategory - categoryUsed,
    limits.maxNetInventory - grossUsed,
  );
  return reducing + Math.max(0, Math.min(adding, Math.floor(room)));
}

/**
 * Cash a resting order ties up. Contracts are fully collateralised: buying YES at P
 * locks P, selling it locks 1 - P. Selling YES the bot already holds locks nothing.
 */
export function collateral(side: Side, price: Cents, qty: number, position: number): Micros {
  if (side === "bid") {
    // Buying back a short releases collateral, so only the part beyond flat costs cash.
    const opening = Math.max(0, qty - Math.max(0, -position));
    return opening * price * CENT;
  }
  const opening = Math.max(0, qty - Math.max(0, position));
  return opening * (100 - price) * CENT;
}
