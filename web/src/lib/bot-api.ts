import type { ChainInfo } from "@/lib/chain";
import type { Ledger, LedgerResult } from "@/lib/ledger";

// Client for the market maker bot's local test-mode API (bot/src/server/http.ts).

export const BOT_URL = process.env.NEXT_PUBLIC_BOT_URL ?? "http://localhost:8787";

export type GateCheck = {
  id: number;
  label: string;
  pass: boolean;
  value: string;
  requirement: string;
};

export type Booking = {
  t: number;
  epoch: number;
  rebates: number;
  rewards: number;
  spread: number;
  net: number;
};

export type BotState = {
  source: "gemini" | "synthetic" | "sandbox" | "production";
  dayFlow: boolean;
  now: number;
  epoch: number;
  epochSeconds: number;
  navAt: number;
  navMaxAgeSeconds: number;
  sharePrice: number;
  instantRoom: number;
  queuedWithdrawals: number;
  recall: {
    amount: number;
    repaid: number;
    deadline: number;
    openedAt: number;
    reason: string;
  } | null;
  gate: { ok: boolean; checks: GateCheck[] };
  history: { t: number; price: number }[];
  /** Per 1,000 mvUSDC, newest first. */
  bookings: Booking[];
  events: { at: number; kind: string; text: string }[];
  /** Set when the bot runs on the escrow program: staker actions are wallet transactions. */
  chain: ChainInfo | null;
  ledger: Ledger;
};

export type Quote = { price: number; qty: number };

export type BotContract = {
  symbol: string;
  title: string;
  category: string;
  expiry: number;
  marketBid: number | null;
  marketAsk: number | null;
  ourBid: Quote | null;
  ourAsk: Quote | null;
  position: number;
  note: string | null;
  rewardEligible: boolean;
};

export type BotFill = {
  id: string;
  symbol: string;
  title: string;
  side: "bid" | "ask";
  price: number;
  qty: number;
  at: number;
  simulated: boolean;
  rebate: number;
};

export type Usage = { used: number; max: number };

export type BotStatus = {
  mode: string;
  source: BotState["source"];
  dayFlow: boolean;
  connected: boolean;
  quoteMode: "normal" | "reduce-only" | "off";
  killReason: string | null;
  manualStop: boolean;
  hedger: string;
  now: number;
  contracts: BotContract[];
  fills: BotFill[];
  pnl: {
    rebate: number;
    rewards: number;
    spread: number;
    hedge: number;
    total: number;
    accruedRebates: number | null;
  };
  edge: {
    fills: number;
    contracts: number;
    filledNotional: number;
    rebatePerDollar: number;
    trailingEdge: number | null;
    trailingEdgePostWaiver: number | null;
  };
  markouts: {
    atFill: number | null;
    m1: number | null;
    m5: number | null;
    settlement: number | null;
    samples: { m1: number; m5: number; settlement: number };
  };
  exchange: { cash: number; freeCash: number; equity: number; funded: number };
  limits: { net: Usage; perContract: Usage; perEvent: Usage; perCategory: Usage };
  relayer: {
    capitalWanted: number;
    drawsAllowed: boolean;
    drawBlockReason: string | null;
    lastAction: string | null;
    lastActionAt: number | null;
  };
  log: { at: number; text: string }[];
};

async function get<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${BOT_URL}${path}`, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export type ActionResult = { ok: true } | { ok: false; error: string };

async function post(path: string, body: Record<string, unknown> = {}): Promise<ActionResult> {
  try {
    const response = await fetch(`${BOT_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { ok?: boolean; error?: string };
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error ?? "The bot rejected that request." };
  } catch {
    return { ok: false, error: "The bot is not reachable." };
  }
}

export function fetchState(walletId: string | null): Promise<BotState | null> {
  return get<BotState>(walletId ? `/state?wallet=${encodeURIComponent(walletId)}` : "/state");
}

export function fetchBot(): Promise<BotStatus | null> {
  return get<BotStatus>("/bot");
}

export const botActions = {
  deposit: (wallet: string, amount: number, acceptRisk: boolean) =>
    post("/deposit", { wallet, amount, acceptRisk }),
  requestWithdraw: (wallet: string, amount: number) =>
    post("/withdraw/request", { wallet, amount }),
  claim: (wallet: string, id: string) => post("/withdraw/claim", { wallet, id }),
  pause: () => post("/sentinel/pause"),
  resume: () => post("/sentinel/resume"),
  recall: () => post("/sentinel/recall"),
  stopQuoting: () => post("/operator/stop"),
  startQuoting: () => post("/operator/start"),
  reset: () => post("/reset"),
  faucet: (wallet: string) => post("/faucet", { wallet }),
};

/** Turn an action result into the ledger result the forms already handle. */
export function asLedgerResult(result: ActionResult, ledger: Ledger): LedgerResult {
  return result.ok ? { ok: true, ledger } : result;
}

/**
 * Split a wallet's yield across the income lines in the same proportions the vault
 * booked them. With nothing booked yet, or when the lines net out against the yield's
 * sign, the whole amount is shown as spread.
 */
export function splitByBookings(total: number, bookings: Booking[]) {
  const sum = bookings.reduce(
    (acc, row) => ({
      rebates: acc.rebates + row.rebates,
      rewards: acc.rewards + row.rewards,
      spread: acc.spread + row.spread,
    }),
    { rebates: 0, rewards: 0, spread: 0 },
  );
  const net = sum.rebates + sum.rewards + sum.spread;
  if (Math.abs(net) < 1e-9 || Math.sign(net) !== Math.sign(total)) {
    return { rebates: 0, rewards: 0, spread: total };
  }
  const scale = total / net;
  return {
    rebates: sum.rebates * scale,
    rewards: sum.rewards * scale,
    spread: sum.spread * scale,
  };
}

export function sourceLabel(state: Pick<BotState, "source" | "dayFlow">): string {
  const market = state.source === "gemini" ? "Live Gemini prices" : "Synthetic market";
  return state.dayFlow
    ? `${market}, each epoch replays one day of volume, simulated funds`
    : `${market}, simulated funds`;
}
