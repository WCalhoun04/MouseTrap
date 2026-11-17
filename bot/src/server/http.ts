import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Bot } from "../bot.ts";
import type { Config } from "../config.ts";
import { toUsd, usd, USD, type Micros } from "../money.ts";
import type { Account, Booking, Result, VaultEvent } from "../vault/sim.ts";
import type { GateResult, VaultState } from "../vault/types.ts";

/** What the API needs from a vault: `SimVault` in test mode, `ChainVault` on a validator. */
export interface ServedVault {
  snapshot(): VaultState;
  sharePrice(): number;
  instantRoom(): Micros;
  gate(amount?: Micros): GateResult;
  readonly history: { t: number; price: number }[];
  readonly bookings: Booking[];
  readonly events: VaultEvent[];
  account(wallet: string): Account;
  deposit(wallet: string, amount: Micros, acceptRisk: boolean): Result | Promise<Result>;
  requestWithdraw(wallet: string, amount: Micros): Result<{ settlement: "instant" | "queued" }> | Promise<Result<{ settlement: "instant" | "queued" }>>;
  claimWithdraw(wallet: string, id: string): Result | Promise<Result>;
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
  forceRecall(): Result | Promise<Result>;
}

type Deps = { cfg: Config; vault: ServedVault; bot: Bot; reset: () => Promise<void> };

const iso = (ms: number) => new Date(ms).toISOString();

/** A wallet's account in the shape of the web app's `UserAccount`. */
function userView(account: Account) {
  return {
    cash: toUsd(account.cash),
    shares: account.shares / USD,
    costBasis: toUsd(account.costBasis),
    lifetimeDeposited: toUsd(account.lifetimeDeposited),
    realizedYield: toUsd(account.realizedYield),
    depositedAt: account.depositedAt == null ? null : iso(account.depositedAt),
    acceptedRisk: account.acceptedRisk,
    withdrawals: account.withdrawals.map((w) => ({
      id: w.id,
      shares: w.shares / USD,
      costBasis: toUsd(w.costBasis),
      requestedAt: iso(w.requestedAt),
      settlement: w.settlement,
    })),
    activity: account.activity.map((a) => ({ id: a.id, kind: a.kind, usdc: toUsd(a.usdc), at: iso(a.at) })),
  };
}

/** Vault state for the web app. `ledger` matches the app's existing `Ledger` type. */
export function stateView({ cfg, vault, bot }: Deps, wallet: string | null) {
  const s = vault.snapshot();
  const shares = s.totalShares / USD;
  const perThousand = (micros: number) => (shares > 0 ? (toUsd(micros) / shares) * 1000 : 0);
  return {
    source: bot.status().source,
    dayFlow: bot.status().dayFlow,
    now: Date.now(),
    epoch: s.epoch,
    epochSeconds: cfg.epochMs / 1000,
    navAt: s.navAt,
    navMaxAgeSeconds: cfg.vault.navMaxAgeMs / 1000,
    sharePrice: vault.sharePrice(),
    instantRoom: toUsd(vault.instantRoom()),
    queuedWithdrawals: toUsd(s.queuedWithdrawals),
    recall: s.recall
      ? {
          amount: toUsd(s.recall.amount),
          repaid: toUsd(s.recall.repaid),
          deadline: s.recall.deadline,
          openedAt: s.recall.openedAt,
          reason: s.recall.reason,
        }
      : null,
    gate: vault.gate(0),
    history: vault.history,
    bookings: vault.bookings
      .slice(-12)
      .reverse()
      .map((b) => ({
        t: b.t,
        epoch: b.epoch,
        rebates: perThousand(b.rebates),
        rewards: perThousand(b.rewards),
        spread: perThousand(b.spread),
        net: perThousand(b.rebates + b.rewards + b.spread),
      })),
    events: vault.events.slice(0, 30),
    ledger: {
      vault: {
        idleUsdc: toUsd(s.idle),
        geminiEquity: toUsd(s.geminiEquity),
        drawnPrincipal: toUsd(s.drawnPrincipal),
        bond: toUsd(s.bond),
        totalShares: shares,
        paused: s.paused,
        absoluteCap: toUsd(s.absoluteCap),
      },
      users: wallet ? { [wallet]: userView(vault.account(wallet)) } : {},
    },
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("Request body too large.");
  }
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function wallet(body: Record<string, unknown>): string {
  const value = body.wallet;
  if (typeof value !== "string" || value.length < 1 || value.length > 64) throw new Error("Missing wallet.");
  return value;
}

function amount(body: Record<string, unknown>): number {
  const value = body.amount;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("Enter a USDC amount.");
  return usd(value);
}

/**
 * Local JSON API for the web app. Test mode only: it moves fake funds and exposes the
 * sentinel controls with no authentication, so it binds to localhost.
 */
export function startServer(deps: Deps): Server {
  const { cfg } = deps;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Read per request: a reset swaps in a fresh vault and bot.
    const { vault, bot } = deps;
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    res.setHeader("access-control-allow-origin", cfg.webOrigin);
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Browsers send no Origin on plain GETs; on writes, only the web app may call.
    if (req.method === "POST" && req.headers.origin && req.headers.origin !== cfg.webOrigin) {
      send(403, { ok: false, error: "Origin not allowed." });
      return;
    }

    try {
      switch (route) {
        case "GET /state":
          return send(200, stateView(deps, url.searchParams.get("wallet")));
        case "GET /bot":
          return send(200, bot.status());
        case "POST /deposit": {
          const body = await readJson(req);
          return send(200, await vault.deposit(wallet(body), amount(body), body.acceptRisk === true));
        }
        case "POST /withdraw/request": {
          const body = await readJson(req);
          return send(200, await vault.requestWithdraw(wallet(body), amount(body)));
        }
        case "POST /withdraw/claim": {
          const body = await readJson(req);
          if (typeof body.id !== "string") throw new Error("Missing withdrawal id.");
          return send(200, await vault.claimWithdraw(wallet(body), body.id));
        }
        case "POST /sentinel/pause":
          await vault.pause();
          return send(200, { ok: true });
        case "POST /sentinel/resume":
          await vault.resume();
          return send(200, { ok: true });
        case "POST /sentinel/recall":
          return send(200, await vault.forceRecall());
        case "POST /operator/stop":
          await bot.setManualStop(true);
          return send(200, { ok: true });
        case "POST /operator/start":
          await bot.setManualStop(false);
          return send(200, { ok: true });
        case "POST /reset":
          await deps.reset();
          return send(200, { ok: true });
        default:
          return send(404, { ok: false, error: "Not found." });
      }
    } catch (err) {
      send(400, { ok: false, error: err instanceof Error ? err.message : "Bad request." });
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  server.on("error", (err: NodeJS.ErrnoException) => {
    const why = err.code === "EADDRINUSE" ? `Port ${cfg.port} is already in use. Is another bot running?` : err.message;
    console.error(`Local API failed to start: ${why}`);
    process.exit(1);
  });
  server.listen(cfg.port, "127.0.0.1");
  return server;
}

function onListenError(what: string, port: number) {
  return (err: NodeJS.ErrnoException) => {
    const why = err.code === "EADDRINUSE" ? `Port ${port} is already in use. Is another bot running?` : err.message;
    console.error(`${what} failed to start: ${why}`);
    process.exit(1);
  };
}

/**
 * The market maker dashboard for demos: one self-contained page plus the two
 * read-only JSON feeds it polls. It has no write routes, so nothing on this port can
 * move funds or touch the sentinel controls.
 */
export function startDashboard(deps: Deps): Server {
  const { cfg } = deps;
  const page = readFileSync(new URL("./dashboard.html", import.meta.url));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Read-only." }));
      return;
    }
    switch (url.pathname) {
      case "/":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page);
        return;
      case "/bot":
        return json(deps.bot.status());
      case "/state":
        return json(stateView(deps, null));
      default:
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Not found." }));
    }
  });
  server.on("error", onListenError("Dashboard", cfg.dashboardPort));
  server.listen(cfg.dashboardPort, "127.0.0.1");
  return server;
}
