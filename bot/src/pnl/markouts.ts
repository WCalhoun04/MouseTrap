import type { Fill, Settlement } from "../exchange/types.ts";

export const HORIZONS = { m1: 60_000, m5: 300_000 } as const;
type Horizon = keyof typeof HORIZONS;

type Tracked = {
  fill: Fill;
  /** Mid when the fill happened, in cents. */
  mid0: number;
  m1?: number;
  m5?: number;
  settle?: number;
};

export type MarkoutStats = {
  /** Average edge in cents per contract; positive means the fill was a good one. */
  atFill: number | null;
  m1: number | null;
  m5: number | null;
  settlement: number | null;
  samples: { m1: number; m5: number; settlement: number };
};

/**
 * Markouts measure adverse selection: after the bot is filled, does the price move
 * for it or against it? Edge is signed so that positive is good for the bot.
 */
export class Markouts {
  private readonly tracked: Tracked[] = [];

  onFill(fill: Fill, mid: number): void {
    this.tracked.push({ fill, mid0: mid });
    if (this.tracked.length > 5_000) this.tracked.shift();
  }

  /** Fill in any horizon that has come due. `midOf` returns the current mid in cents. */
  tick(now: number, midOf: (symbol: string) => number | undefined): void {
    for (const t of this.tracked) {
      for (const key of Object.keys(HORIZONS) as Horizon[]) {
        if (t[key] != null || now - t.fill.at < HORIZONS[key]) continue;
        const mid = midOf(t.fill.symbol);
        if (mid != null) t[key] = edge(t.fill, mid);
      }
    }
  }

  onSettlement(settlement: Settlement): void {
    for (const t of this.tracked) {
      if (t.fill.symbol === settlement.symbol && t.settle == null) t.settle = edge(t.fill, settlement.value);
    }
  }

  /** Best available per-contract edge for a fill: the longest horizon measured so far. */
  bestEdge(t: Tracked): number {
    return t.settle ?? t.m5 ?? t.m1 ?? edge(t.fill, t.mid0);
  }

  recent(count: number): Tracked[] {
    return this.tracked.slice(-count);
  }

  stats(): MarkoutStats {
    const avg = (pick: (t: Tracked) => number | undefined) => {
      let sum = 0;
      let qty = 0;
      for (const t of this.tracked) {
        const value = pick(t);
        if (value == null) continue;
        sum += value * t.fill.qty;
        qty += t.fill.qty;
      }
      return { value: qty > 0 ? sum / qty : null, count: this.tracked.filter((t) => pick(t) != null).length };
    };
    const m1 = avg((t) => t.m1);
    const m5 = avg((t) => t.m5);
    const settlement = avg((t) => t.settle);
    return {
      atFill: avg((t) => edge(t.fill, t.mid0)).value,
      m1: m1.value,
      m5: m5.value,
      settlement: settlement.value,
      samples: { m1: m1.count, m5: m5.count, settlement: settlement.count },
    };
  }
}

/** Cents per contract the fill is ahead by, against a later reference price. */
export function edge(fill: Pick<Fill, "side" | "price" | "adverse">, reference: number): number {
  const raw = fill.side === "bid" ? reference - fill.price : fill.price - reference;
  // A modelled informed taker costs the bot this much on top of what the mid shows.
  return raw - (fill.adverse ?? 0);
}
