// Prices are integer cents (1..99). Quantities are whole contracts.
// Money is integer micro-USD (USDC has 6 decimals), held in a number.

export type Micros = number;
export type Cents = number;

export const USD = 1_000_000;
export const CENT = 10_000;

export function usd(dollars: number): Micros {
  return Math.round(dollars * USD);
}

export function toUsd(micros: Micros): number {
  return micros / USD;
}

/** Cost in micros of `qty` contracts at `price` cents. */
export function notional(price: Cents, qty: number): Micros {
  return price * qty * CENT;
}

export function floorToCent(micros: Micros): Micros {
  return Math.floor(micros / CENT) * CENT;
}

export function ceilToCent(micros: Micros): Micros {
  return Math.ceil(micros / CENT) * CENT;
}

/** "0.5300" -> 53. Returns null when the text is not a price between 0 and 1. */
export function parseCents(text: string | undefined | null): Cents | null {
  if (text == null || text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (cents < 0 || cents > 100) return null;
  return cents;
}

export function fmtUsd(micros: Micros): string {
  return `$${toUsd(micros).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
