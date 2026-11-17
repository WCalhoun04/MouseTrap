import type { Config } from "../config.ts";
import type { Contract } from "../exchange/types.ts";
import { inBand } from "./rebate.ts";

type SelectorConfig = Pick<Config, "categories" | "maxContracts" | "minTimeToExpiryMs" | "terms">;

/**
 * Pick the contracts worth quoting: tradeable category, far enough from resolution,
 * a two-sided book whose prices sit in the rebate band, ranked by recent volume.
 * Contracts the bot holds inventory in are always kept so it can work out of them.
 */
export function selectContracts(
  all: Contract[],
  held: Set<string>,
  cfg: SelectorConfig,
  now: number,
): Contract[] {
  const keep = all.filter((c) => held.has(c.symbol) && c.expiry > now);
  const keepSet = new Set(keep.map((c) => c.symbol));

  const candidates = all.filter((c) => {
    if (keepSet.has(c.symbol)) return false;
    const rule = cfg.categories[c.category];
    if (!rule.enabled) return false;
    if (c.expiry - now < cfg.minTimeToExpiryMs * 2) return false;
    if (rule.pullWhenLive && c.startTime != null && now >= c.startTime) return false;
    if (c.bestBid == null || c.bestAsk == null || c.bestAsk <= c.bestBid) return false;
    // Both quotes need to land in the band for two-sided rebate harvesting.
    return inBand(c.bestBid, cfg.terms) && inBand(c.bestAsk, cfg.terms);
  });

  candidates.sort((a, b) => {
    if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
    // Tie-break on distance from 50 cents: rebate per contract peaks there.
    const mid = (c: Contract) => Math.abs(((c.bestBid ?? 50) + (c.bestAsk ?? 50)) / 2 - 50);
    return mid(a) - mid(b);
  });

  const room = Math.max(0, cfg.maxContracts - keep.length);
  return [...keep, ...candidates.slice(0, room)];
}
