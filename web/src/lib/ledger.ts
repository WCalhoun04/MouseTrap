export const PREVIEW_WALLET_ID = "preview";
export const STARTING_CASH = 25_000;
export const BUFFER_RATIO = 0.2;
export const BOND_MIN = 0.15;
export const DRAWN_NAV_MAX = 0.6;
export const HEALTH_MIN = 0.97;
export const DRAW_BLOCK_HEALTH = 0.95;
export const RECALL_HEALTH = 0.9;
export const ABSOLUTE_CAP = 750_000;
export const SERIES_START = Date.UTC(2026, 7, 18);
export const DAY_MS = 86_400_000;
export const REBATE_SHARE = 0.78;
export const REWARD_SHARE = 0.27;
export const SPREAD_SHARE = -0.05;
const STORAGE_KEY = "mousetrap.ledger.v1";
const NAV_AGE_MS = 18 * 60 * 1000;

export type Settlement = "instant" | "queued";

export type Withdrawal = {
  id: string;
  shares: number;
  costBasis: number;
  requestedAt: string;
  settlement: Settlement;
};

export type ActivityKind = "deposit" | "request" | "claim";

export type Activity = {
  id: string;
  kind: ActivityKind;
  usdc: number;
  at: string;
};

export type UserAccount = {
  cash: number;
  shares: number;
  costBasis: number;
  lifetimeDeposited: number;
  realizedYield: number;
  depositedAt: string | null;
  acceptedRisk: boolean;
  withdrawals: Withdrawal[];
  activity: Activity[];
};

export type VaultState = {
  idleUsdc: number;
  geminiEquity: number;
  drawnPrincipal: number;
  bond: number;
  totalShares: number;
  paused: boolean;
  absoluteCap: number;
};

export type Ledger = {
  vault: VaultState;
  users: Record<string, UserAccount>;
};

export type LedgerResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; error: string };

export type WithdrawPlan =
  | {
      ok: true;
      shares: number;
      payout: number;
      settlement: Settlement;
      instantRoom: number;
    }
  | { ok: false; error: string };

export function freshUser(): UserAccount {
  return {
    cash: STARTING_CASH,
    shares: 0,
    costBasis: 0,
    lifetimeDeposited: 0,
    realizedYield: 0,
    depositedAt: null,
    acceptedRisk: false,
    withdrawals: [],
    activity: [],
  };
}

export function sharePriceOn(timeMs: number): number {
  const day = Math.max(0, (timeMs - SERIES_START) / DAY_MS);
  const trend = 1 + 0.00035 * day;
  const wave = 1 + 0.0035 * Math.sin(day / 4.2);
  return trend * wave;
}

export function epochOf(now: number): number {
  return Math.max(1, Math.floor((now - SERIES_START) / DAY_MS) + 1);
}

export function nav(vault: VaultState): number {
  return vault.idleUsdc + vault.geminiEquity;
}

export function sharePrice(vault: VaultState): number {
  if (vault.totalShares <= 0) return 1;
  return nav(vault) / vault.totalShares;
}

export function seedLedger(now: number): Ledger {
  const price = sharePriceOn(now);
  const totalShares = 1_250_000;
  const netAssets = price * totalShares;
  const drawnPrincipal = netAssets * 0.38;
  // A few thousand dollars of idle room, so a modest withdrawal claims at once
  // and a larger one shows the recall queue.
  const idleUsdc = netAssets * BUFFER_RATIO + 3_000;
  return {
    vault: {
      idleUsdc,
      geminiEquity: netAssets - idleUsdc,
      drawnPrincipal,
      bond: drawnPrincipal * 0.16,
      totalShares,
      paused: false,
      absoluteCap: ABSOLUTE_CAP,
    },
    users: {},
  };
}

export function markToMarket(ledger: Ledger, now: number): Ledger {
  const price = sharePriceOn(now);
  const targetNav = price * ledger.vault.totalShares;
  const geminiEquity = targetNav - ledger.vault.idleUsdc;
  if (geminiEquity <= 0) return ledger;
  return {
    ...ledger,
    vault: { ...ledger.vault, geminiEquity },
  };
}

export function priceSeries(now: number, days = 90): { t: number; price: number }[] {
  const date = new Date(now);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const points: { t: number; price: number }[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const t = end - i * DAY_MS;
    points.push({ t, price: sharePriceOn(t + DAY_MS / 2) });
  }
  return points;
}

export function trailingReturn(now: number, price: number, days = 30): number {
  const then = sharePriceOn(now - days * DAY_MS);
  if (then <= 0) return 0;
  return price / then - 1;
}

export type DayBook = {
  t: number;
  net: number;
  rebates: number;
  rewards: number;
  spread: number;
};

export function dailyBook(now: number, days = 7): DayBook[] {
  const series = priceSeries(now, days + 1);
  const rows: DayBook[] = [];
  for (let i = 1; i < series.length; i += 1) {
    const net = (series[i].price - series[i - 1].price) * 1000;
    rows.push({
      t: series[i].t,
      net,
      rebates: net > 0 ? net * REBATE_SHARE : 0,
      rewards: net > 0 ? net * REWARD_SHARE : 0,
      spread: net > 0 ? net * SPREAD_SHARE : net,
    });
  }
  return rows.reverse();
}

export type YieldBreakdown = {
  total: number;
  pct: number;
  rebates: number;
  rewards: number;
  spread: number;
};

export function accountYield(user: UserAccount, price: number): YieldBreakdown {
  const pending = user.withdrawals.reduce(
    (sum, withdrawal) => sum + (withdrawal.shares * price - withdrawal.costBasis),
    0,
  );
  const open = user.shares * price - user.costBasis;
  const total = open + pending + user.realizedYield;
  const pct = user.lifetimeDeposited > 0 ? total / user.lifetimeDeposited : 0;
  if (total > 0) {
    return {
      total,
      pct,
      rebates: total * REBATE_SHARE,
      rewards: total * REWARD_SHARE,
      spread: total * SPREAD_SHARE,
    };
  }
  return { total, pct, rebates: 0, rewards: 0, spread: total };
}

export function readings(vault: VaultState, now: number) {
  const netAssets = nav(vault);
  const price = sharePrice(vault);
  const drawn = vault.drawnPrincipal;
  return {
    nav: netAssets,
    price,
    epoch: epochOf(now),
    navAt: now - NAV_AGE_MS,
    drawnRatio: netAssets > 0 ? drawn / netAssets : 0,
    idleRatio: netAssets > 0 ? vault.idleUsdc / netAssets : 0,
    bondRatio: drawn > 0 ? vault.bond / drawn : 1,
    health: drawn > 0 ? vault.geminiEquity / drawn : 1,
    instantRoom: Math.max(0, vault.idleUsdc - BUFFER_RATIO * netAssets),
  };
}

export type DrawState = "open" | "blocked" | "recall";

export function drawStatus(vault: VaultState): DrawState {
  if (vault.paused) return "blocked";
  const health = vault.drawnPrincipal > 0 ? vault.geminiEquity / vault.drawnPrincipal : 1;
  if (health < RECALL_HEALTH) return "recall";
  if (health < DRAW_BLOCK_HEALTH) return "blocked";
  return "open";
}

export function getUser(ledger: Ledger, walletId: string): UserAccount {
  const user = ledger.users[walletId];
  if (!user || !Array.isArray(user.withdrawals) || !Array.isArray(user.activity)) {
    return freshUser();
  }
  return user;
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function createId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function withUser(
  ledger: Ledger,
  walletId: string,
  user: UserAccount,
  vault: VaultState = ledger.vault,
): Ledger {
  return { vault, users: { ...ledger.users, [walletId]: user } };
}

function pushActivity(user: UserAccount, activity: Activity): Activity[] {
  return [activity, ...user.activity].slice(0, 12);
}

function pendingInstantUsdc(ledger: Ledger, price: number): number {
  let reserved = 0;
  for (const user of Object.values(ledger.users)) {
    for (const withdrawal of user.withdrawals) {
      if (withdrawal.settlement === "instant") reserved += withdrawal.shares * price;
    }
  }
  return reserved;
}

export function planWithdraw(ledger: Ledger, walletId: string, amount: number): WithdrawPlan {
  const user = getUser(ledger, walletId);
  const price = sharePrice(ledger.vault);
  const full = user.shares * price;
  if (!(amount > 0)) return { ok: false, error: "Enter a USDC amount." };
  if (amount > full + 0.001) {
    return { ok: false, error: "That is more than the shares you can withdraw." };
  }
  const shares = amount >= full - 0.01 ? user.shares : amount / price;
  if (shares <= 0) return { ok: false, error: "Enter a USDC amount." };
  const payout = shares * price;
  const instantRoom = Math.max(
    0,
    ledger.vault.idleUsdc - BUFFER_RATIO * nav(ledger.vault) - pendingInstantUsdc(ledger, price),
  );
  const settlement: Settlement = payout <= instantRoom + 0.001 ? "instant" : "queued";
  return { ok: true, shares, payout, settlement, instantRoom };
}

export function deposit(
  ledger: Ledger,
  walletId: string,
  amount: number,
  now: number,
  acceptRisk: boolean,
): LedgerResult {
  const user = getUser(ledger, walletId);
  if (ledger.vault.paused) return { ok: false, error: "Deposits are paused." };
  if (!user.acceptedRisk && !acceptRisk) {
    return { ok: false, error: "Accept the risk disclosure before depositing." };
  }
  const usdc = cents(amount);
  if (!(usdc > 0)) return { ok: false, error: "Enter a USDC amount." };
  if (usdc > user.cash + 0.001) {
    return { ok: false, error: "That is more preview USDC than you have." };
  }
  const price = sharePrice(ledger.vault);
  const minted = usdc / price;
  const next: UserAccount = {
    ...user,
    acceptedRisk: true,
    cash: cents(user.cash - usdc),
    shares: user.shares + minted,
    costBasis: user.costBasis + usdc,
    lifetimeDeposited: user.lifetimeDeposited + usdc,
    depositedAt: user.depositedAt ?? new Date(now).toISOString(),
    activity: pushActivity(user, {
      id: createId(now),
      kind: "deposit",
      usdc,
      at: new Date(now).toISOString(),
    }),
  };
  const vault: VaultState = {
    ...ledger.vault,
    idleUsdc: ledger.vault.idleUsdc + usdc,
    totalShares: ledger.vault.totalShares + minted,
  };
  return { ok: true, ledger: withUser(ledger, walletId, next, vault) };
}

export function requestWithdraw(
  ledger: Ledger,
  walletId: string,
  amount: number,
  now: number,
): LedgerResult {
  if (ledger.vault.paused) return { ok: false, error: "Withdrawals are paused." };
  const plan = planWithdraw(ledger, walletId, amount);
  if (!plan.ok) return plan;
  const user = getUser(ledger, walletId);
  const costOut = user.shares === 0 ? 0 : user.costBasis * (plan.shares / user.shares);
  const next: UserAccount = {
    ...user,
    shares: Math.max(0, user.shares - plan.shares),
    costBasis: Math.max(0, user.costBasis - costOut),
    withdrawals: [
      {
        id: createId(now),
        shares: plan.shares,
        costBasis: costOut,
        requestedAt: new Date(now).toISOString(),
        settlement: plan.settlement,
      },
      ...user.withdrawals,
    ],
    activity: pushActivity(user, {
      id: createId(now + 1),
      kind: "request",
      usdc: plan.payout,
      at: new Date(now).toISOString(),
    }),
  };
  return { ok: true, ledger: withUser(ledger, walletId, next) };
}

export function claim(
  ledger: Ledger,
  walletId: string,
  withdrawalId: string,
  now: number,
): LedgerResult {
  const user = getUser(ledger, walletId);
  const withdrawal = user.withdrawals.find((item) => item.id === withdrawalId);
  if (!withdrawal) return { ok: false, error: "That withdrawal is no longer open." };
  const price = sharePrice(ledger.vault);
  const usdc = cents(withdrawal.shares * price);
  const vault: VaultState = {
    ...ledger.vault,
    totalShares: Math.max(0, ledger.vault.totalShares - withdrawal.shares),
  };
  if (withdrawal.settlement === "queued") {
    if (usdc > vault.geminiEquity + 0.001) {
      return { ok: false, error: "Gemini equity cannot cover this recall yet." };
    }
    vault.geminiEquity -= usdc;
    vault.drawnPrincipal = Math.max(0, vault.drawnPrincipal - usdc);
  } else if (usdc > vault.idleUsdc + 0.001) {
    return { ok: false, error: "Idle USDC cannot cover this claim yet." };
  } else {
    vault.idleUsdc -= usdc;
  }
  const next: UserAccount = {
    ...user,
    cash: cents(user.cash + usdc),
    realizedYield: user.realizedYield + (usdc - withdrawal.costBasis),
    withdrawals: user.withdrawals.filter((item) => item.id !== withdrawalId),
    activity: pushActivity(user, {
      id: createId(now),
      kind: "claim",
      usdc,
      at: new Date(now).toISOString(),
    }),
  };
  return { ok: true, ledger: withUser(ledger, walletId, next, vault) };
}

export function loadSample(ledger: Ledger, walletId: string, now: number): LedgerResult {
  const user = getUser(ledger, walletId);
  if (user.lifetimeDeposited > 0 || user.shares > 0 || user.withdrawals.length > 0) {
    return { ok: false, error: "A sample position only loads onto an empty account." };
  }
  const entryTime = now - 30 * DAY_MS;
  const entry = sharePriceOn(entryTime);
  const amount = 5_000;
  const minted = amount / entry;
  const price = sharePrice(ledger.vault);
  const next: UserAccount = {
    ...user,
    shares: minted,
    costBasis: amount,
    lifetimeDeposited: amount,
    depositedAt: new Date(entryTime).toISOString(),
    activity: [
      {
        id: createId(entryTime),
        kind: "deposit",
        usdc: amount,
        at: new Date(entryTime).toISOString(),
      },
    ],
  };
  const vault: VaultState = {
    ...ledger.vault,
    geminiEquity: ledger.vault.geminiEquity + minted * price,
    totalShares: ledger.vault.totalShares + minted,
  };
  return { ok: true, ledger: withUser(ledger, walletId, next, vault) };
}

function validLedger(value: unknown): value is Ledger {
  if (!value || typeof value !== "object") return false;
  const ledger = value as Ledger;
  const vault = ledger.vault;
  if (!vault || typeof ledger.users !== "object" || ledger.users === null) return false;
  const numbers = [
    vault.idleUsdc,
    vault.geminiEquity,
    vault.drawnPrincipal,
    vault.bond,
    vault.totalShares,
    vault.absoluteCap,
  ];
  return (
    numbers.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0) &&
    vault.totalShares > 0 &&
    typeof vault.paused === "boolean"
  );
}

export function readLedger(now: number): Ledger {
  if (typeof window === "undefined") return seedLedger(now);
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedLedger(now);
    const stored = JSON.parse(raw) as { version?: number; ledger?: unknown };
    if (stored.version !== 1 || !validLedger(stored.ledger)) return seedLedger(now);
    return markToMarket(stored.ledger, now);
  } catch {
    return seedLedger(now);
  }
}

export function writeLedger(ledger: Ledger): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ledger }));
}
