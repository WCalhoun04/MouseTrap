import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { Bot } from "./bot.ts";
import { loadConfig, type Config, type Mode } from "./config.ts";
import { GeminiExchange } from "./exchange/gemini.ts";
import { GeminiFeed } from "./exchange/geminiFeed.ts";
import { PaperExchange } from "./exchange/paper.ts";
import { SyntheticFeed } from "./exchange/synthetic.ts";
import type { Exchange, MarketFeed } from "./exchange/types.ts";
import { Relayer } from "./relayer/relayer.ts";
import { NotionalTreasury, PaperTreasury, type Treasury } from "./relayer/treasury.ts";
import { loadKey, readInfo } from "./chain/localnet.ts";
import { startDashboard, startServer, type ServedVault } from "./server/http.ts";
import { ChainVault } from "./vault/chain.ts";
import { SimVault, simCrank } from "./vault/sim.ts";
import type { VaultClient, VaultCrank } from "./vault/types.ts";

const log = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${text}`);

/** With day flow on, takers come from the volume replay, not the feed's own generator. */
function syntheticFeed(cfg: Config): SyntheticFeed {
  return new SyntheticFeed(cfg.dayFlow ? { tradeMs: Infinity } : {});
}

/** Real Gemini books if they can be reached, the generated market if not. */
async function pickFeed(cfg: Config): Promise<MarketFeed> {
  if (cfg.offline) return syntheticFeed(cfg);
  const feed = new GeminiFeed("production");
  try {
    await feed.start();
    const contracts = await feed.listContracts();
    if (contracts.length === 0) throw new Error("no active contracts");
    return feed;
  } catch (err) {
    await feed.stop().catch(() => {});
    log(`Gemini feed unavailable (${err instanceof Error ? err.message : err}). Using the synthetic market.`);
    return syntheticFeed(cfg);
  }
}

/** The escrow: the program on a validator with `--chain`, the in-memory stand-in otherwise. */
async function buildVault(cfg: Config): Promise<{ vault: VaultClient & ServedVault; crank: VaultCrank }> {
  if (!cfg.chain) {
    const sim = new SimVault(cfg.vault, {
      faucet: cfg.faucet,
      seedDeposits: cfg.seedDeposits,
      seedBond: cfg.seedBond,
    });
    return { vault: sim, crank: simCrank(sim) };
  }
  const info = readInfo();
  const chain = await ChainVault.connect({
    faucetAmount: cfg.faucet,
    connection: new Connection(cfg.rpcUrl, "confirmed"),
    operator: loadKey("operator"),
    attestor: loadKey("attestor"),
    sentinel: loadKey("sentinel"),
    gemini: loadKey("gemini"),
    // Only a local validator lets the bot mint USDC to stand in for paper profit.
    mintAuthority: cfg.mode === "test" ? loadKey("owner") : undefined,
  });
  log(`Escrow program ${info.programId} on ${cfg.rpcUrl}.`);
  return { vault: chain, crank: chain };
}

async function build(cfg: Config) {
  const { vault, crank } = await buildVault(cfg);

  let exchange: Exchange;
  let treasury: Treasury;
  let paper: PaperExchange | undefined;
  if (cfg.mode === "test") {
    paper = new PaperExchange(await pickFeed(cfg), { terms: cfg.terms });
    exchange = paper;
    treasury = new PaperTreasury(paper);
  } else {
    exchange = new GeminiExchange(cfg.mode === "live" ? "production" : "sandbox", cfg.apiKey!, cfg.apiSecret!, cfg.nonceMode);
    treasury = new NotionalTreasury(exchange);
  }

  // Relayer messages go to the bot's operator log, which also prints them.
  let sink = log;
  const relayer = new Relayer(vault, treasury, exchange, cfg, Date.now, (text) => sink(text));
  const bot = new Bot({ cfg, exchange, vault, relayer, treasury, paper, crank, log });
  sink = (text) => bot.noteExternal(text);
  await bot.start();
  return { vault, bot };
}

async function main() {
  const [modeArg, ...rest] = process.argv.slice(2);
  if (modeArg !== "test" && modeArg !== "demo" && modeArg !== "live") {
    console.error("Usage: tsx src/cli.ts <test|demo|live> [--offline]");
    process.exit(1);
  }
  const mode: Mode = modeArg;
  const cfg = loadConfig(mode, { offline: rest.includes("--offline"), chain: rest.includes("--chain") });

  let runtime = await build(cfg);
  log(`MouseTrap bot running in ${mode} mode on ${runtime.bot.status().source} market data.`);
  if (mode === "test") log("Test mode: all funds are fake. No orders reach Gemini.");
  if (!cfg.chain && mode !== "test") log("The escrow is simulated: draws and repayments are bookkeeping only.");
  if (cfg.chain) log("Draws, repayments, NAV reports and settlements are transactions on the escrow program.");

  if (mode === "test") {
    const deps = {
      cfg,
      get vault() {
        return runtime.vault;
      },
      get bot() {
        return runtime.bot;
      },
      reset: async () => {
        await runtime.bot.stop();
        runtime = await build(cfg);
        log("Test state reset.");
      },
    };
    startServer(deps);
    startDashboard(deps);
    log(`Local API on http://localhost:${cfg.port} for the web app at ${cfg.webOrigin}.`);
    log(`Market maker dashboard on http://localhost:${cfg.dashboardPort}`);
  }

  const shutdown = async () => {
    log("Cancelling orders and stopping.");
    await runtime.bot.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
