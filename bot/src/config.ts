import { z } from "zod";
import type { Category } from "./exchange/types.ts";
import { usd, type Micros } from "./money.ts";
import { DEFAULT_TERMS, type RebateTerms } from "./strategy/rebate.ts";

export type Mode = "test" | "demo" | "live";

export type CategoryRule = {
  enabled: boolean;
  /** Contracts per side. */
  size: number;
  /** Extra ticks added to each side inside the news window. */
  newsWiden: number;
  /** Pull quotes once the underlying event has started (live play). */
  pullWhenLive: boolean;
};

export type RiskLimits = {
  maxPerContract: number;
  maxPerEvent: number;
  maxPerCategory: number;
  /** Cap on the sum of absolute net positions across all contracts. */
  maxNetInventory: number;
  /** Share of drawn principal the bot may lose before the kill switch trips. */
  maxDrawdown: number;
};

export type VaultParams = {
  bondMin: number;
  absoluteCap: Micros;
  drawnNavMax: number;
  bufferRatio: number;
  navMaxAgeMs: number;
  healthMin: number;
  drawBlockHealth: number;
  recallHealth: number;
  perDrawShare: number;
  recallDeadlineMs: number;
  navSilenceMs: number;
};

export type Config = {
  mode: Mode;
  offline: boolean;
  /** Use the escrow program on a Solana validator instead of the simulated vault. */
  chain: boolean;
  rpcUrl: string;
  /** Replay one day of each contract's real volume per epoch (test mode). */
  dayFlow: boolean;
  /** Share of taker flow that reaches the bot rather than another maker. */
  captureShare: number;
  /** Share of simulated takers who are informed, and what each costs in cents per contract. */
  informedShare: number;
  informedMoveCents: number;
  port: number;
  /** Read-only market maker dashboard, test mode only. */
  dashboardPort: number;
  webOrigin: string;
  epochMs: number;
  navIntervalMs: number;
  tickMs: number;
  selectorRefreshMs: number;
  maxContracts: number;
  /** Do not quote a contract this close to resolution. */
  minTimeToExpiryMs: number;
  newsWindowMs: number;
  staleBookMs: number;
  /** Improve the best price by one tick when the spread is at least this many ticks. */
  improveWhenSpread: number;
  maxSkewTicks: number;
  minRequoteMs: number;
  workingFloat: Micros;
  minDrawIntervalMs: number;
  categories: Record<Category, CategoryRule>;
  limits: RiskLimits;
  vault: VaultParams;
  terms: RebateTerms;
  seedDeposits: Micros;
  seedBond: Micros;
  faucet: Micros;
  apiKey?: string;
  apiSecret?: string;
  /** Must match the "time-based nonce" setting chosen when the API key was created. */
  nonceMode: "time-based" | "monotonic";
  dataDir: string;
};

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(8788),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  EPOCH_SECONDS: z.coerce.number().positive().optional(),
  MAX_CONTRACTS: z.coerce.number().int().positive().default(8),
  DAY_FLOW: z.enum(["on", "off"]).default("on"),
  CAPTURE_SHARE: z.coerce.number().min(0).max(1).default(0.5),
  INFORMED_SHARE: z.coerce.number().min(0).max(1).default(0.3),
  INFORMED_MOVE_CENTS: z.coerce.number().min(0).max(50).default(2),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_API_SECRET: z.string().optional(),
  GEMINI_NONCE: z.enum(["time-based", "monotonic"]).default("time-based"),
  MODE: z.string().optional(),
  SOLANA_RPC_URL: z.string().default("http://127.0.0.1:8899"),
  I_UNDERSTAND_LIVE_TRADING: z.string().optional(),
});

const DAY_MS = 86_400_000;

export function loadConfig(
  mode: Mode,
  flags: { offline?: boolean; chain?: boolean } = {},
  env: Record<string, string | undefined> = process.env,
): Config {
  const e = Env.parse(env);

  if (mode === "live" && (e.MODE !== "live" || e.I_UNDERSTAND_LIVE_TRADING !== "yes")) {
    throw new Error(
      "Live trading refused. Set MODE=live and I_UNDERSTAND_LIVE_TRADING=yes to trade real money.",
    );
  }
  if (mode !== "test" && (!e.GEMINI_API_KEY || !e.GEMINI_API_SECRET)) {
    throw new Error(`${mode} mode needs GEMINI_API_KEY and GEMINI_API_SECRET in bot/.env.`);
  }

  // Test mode squeezes the daily cycle into a short epoch so it can be shown on stage.
  const test = mode === "test";
  const epochMs = e.EPOCH_SECONDS ? e.EPOCH_SECONDS * 1000 : test ? 60_000 : DAY_MS;
  const navIntervalMs = test ? Math.min(5_000, epochMs / 4) : 3_600_000;

  return {
    mode,
    offline: Boolean(flags.offline),
    chain: Boolean(flags.chain),
    rpcUrl: e.SOLANA_RPC_URL,
    dayFlow: test && e.DAY_FLOW === "on",
    captureShare: e.CAPTURE_SHARE,
    informedShare: e.INFORMED_SHARE,
    informedMoveCents: e.INFORMED_MOVE_CENTS,
    port: e.PORT,
    dashboardPort: e.DASHBOARD_PORT,
    webOrigin: e.WEB_ORIGIN,
    epochMs,
    navIntervalMs,
    tickMs: 500,
    selectorRefreshMs: 30_000,
    maxContracts: e.MAX_CONTRACTS,
    minTimeToExpiryMs: test ? 5 * 60_000 : 30 * 60_000,
    newsWindowMs: 15 * 60_000,
    staleBookMs: test ? 120_000 : 15_000,
    improveWhenSpread: 3,
    maxSkewTicks: 3,
    minRequoteMs: 1_000,
    workingFloat: usd(500),
    minDrawIntervalMs: test ? 10_000 : 3_600_000,
    categories: {
      crypto: { enabled: true, size: 100, newsWiden: 0, pullWhenLive: false },
      commodities: { enabled: true, size: 100, newsWiden: 0, pullWhenLive: false },
      // Unhedgeable flow: wider near scheduled news, no quotes in live play.
      sports: { enabled: true, size: 100, newsWiden: 2, pullWhenLive: true },
      politics: { enabled: true, size: 100, newsWiden: 2, pullWhenLive: true },
      economics: { enabled: true, size: 100, newsWiden: 2, pullWhenLive: true },
      other: { enabled: true, size: 100, newsWiden: 1, pullWhenLive: false },
    },
    limits: {
      maxPerContract: 400,
      maxPerEvent: 600,
      maxPerCategory: 1_500,
      maxNetInventory: 3_000,
      maxDrawdown: 0.1,
    },
    // Starting values from AGENTS.md section 5. Test mode scales the time limits.
    vault: {
      bondMin: 0.15,
      // Small in test mode so that rebates on thin books still move the share price.
      absoluteCap: usd(test ? 15_000 : 25_000),
      drawnNavMax: 0.6,
      bufferRatio: 0.2,
      navMaxAgeMs: test ? navIntervalMs * 4 : 3_600_000,
      healthMin: 0.97,
      drawBlockHealth: 0.95,
      recallHealth: 0.9,
      perDrawShare: 0.25,
      // Maker-only quotes need time to work out of inventory, so test mode allows ten epochs.
      recallDeadlineMs: test ? epochMs * 10 : 48 * 3_600_000,
      navSilenceMs: test ? epochMs : DAY_MS,
    },
    terms: DEFAULT_TERMS,
    seedDeposits: usd(20_000),
    seedBond: usd(4_000),
    faucet: usd(25_000),
    apiKey: e.GEMINI_API_KEY,
    apiSecret: e.GEMINI_API_SECRET,
    nonceMode: e.GEMINI_NONCE,
    dataDir: "data",
  };
}
