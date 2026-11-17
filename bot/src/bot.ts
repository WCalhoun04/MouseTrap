import type { Config } from "./config.ts";
import { DayFlow } from "./exchange/dayFlow.ts";
import type { PaperExchange } from "./exchange/paper.ts";
import type { Contract, Exchange, Fill, Settlement } from "./exchange/types.ts";
import { OrderManager } from "./execution/orderManager.ts";
import { NoopHedger, type Hedger } from "./hedge/types.ts";
import { toUsd, USD, type Micros } from "./money.ts";
import { Attribution } from "./pnl/attribution.ts";
import { FillLog } from "./pnl/fills.ts";
import { Markouts } from "./pnl/markouts.ts";
import type { Relayer } from "./relayer/relayer.ts";
import type { Treasury } from "./relayer/treasury.ts";
import { evaluate, type KillState } from "./risk/killswitch.ts";
import { buildInventory, collateral, type Inventory } from "./risk/limits.ts";
import { desiredQuotes, type Quotes } from "./strategy/quoter.ts";
import { rebateAccrual } from "./strategy/rebate.ts";
import { selectContracts } from "./strategy/selector.ts";
import type { VaultClient, VaultCrank } from "./vault/types.ts";

type Parts = {
  cfg: Config;
  exchange: Exchange;
  vault: VaultClient;
  relayer: Relayer;
  treasury: Treasury;
  /** Present in test mode: lets the bot run the rebate payout. */
  paper?: PaperExchange;
  /** Lets the bot stand in for the attestor and the epoch crank. */
  crank?: VaultCrank;
  hedger?: Hedger;
  now?: () => number;
  log?: (text: string) => void;
};

type FillRow = Fill & { title: string; rebate: number };

const FLOW_STEP_MS = 1_000;

/** Minimum fills before the trailing-edge check may pause draws. */
const EDGE_MIN_FILLS = 30;

export class Bot {
  private readonly cfg: Config;
  private readonly exchange: Exchange;
  private readonly vault: VaultClient;
  private readonly relayer: Relayer;
  private readonly treasury: Treasury;
  private readonly paper?: PaperExchange;
  private readonly crank?: VaultCrank;
  private readonly hedger: Hedger;
  private readonly now: () => number;
  private readonly log: (text: string) => void;

  private readonly orders: OrderManager;
  private readonly markouts = new Markouts();
  private readonly attribution: Attribution;
  private readonly fillLog: FillLog;

  private selected: Contract[] = [];
  private readonly known = new Map<string, Contract>();
  private quotes = new Map<string, Quotes>();
  private inventory: Inventory = buildInventory([], new Map());
  private kill: KillState = { mode: "off", reason: "Starting" };
  private manualStop = false;
  private readonly recentFills: FillRow[] = [];
  private readonly settlements: Settlement[] = [];
  private readonly opLog: { at: number; text: string }[] = [];
  private cached = { cash: 0, freeCash: 0, equity: 0, principal: 0 };
  private readonly dayFlow: DayFlow | null;
  /** One entry per settled epoch, which in test mode stands for one day. */
  private readonly days: { rebate: Micros; total: Micros; fees: Micros; nav: Micros | null }[] = [];
  private feesBooked: Micros = 0;
  private timers: NodeJS.Timeout[] = [];
  private ticking = false;
  private selecting = false;

  constructor(parts: Parts) {
    this.cfg = parts.cfg;
    this.exchange = parts.exchange;
    this.vault = parts.vault;
    this.relayer = parts.relayer;
    this.treasury = parts.treasury;
    this.paper = parts.paper;
    this.crank = parts.crank;
    this.hedger = parts.hedger ?? new NoopHedger();
    this.now = parts.now ?? Date.now;
    this.log = parts.log ?? (() => {});

    this.orders = new OrderManager(this.exchange, this.cfg.minRequoteMs, this.now);
    this.attribution = new Attribution(this.cfg.terms, this.markouts);
    this.fillLog = new FillLog(this.cfg.dataDir);
    this.dayFlow =
      this.cfg.dayFlow && this.paper
        ? new DayFlow(this.paper, {
            epochMs: this.cfg.epochMs,
            captureShare: this.cfg.captureShare,
            informedShare: this.cfg.informedShare,
            informedMoveCents: this.cfg.informedMoveCents,
          })
        : null;
    this.exchange.onFill((fill) => this.onFill(fill));
    this.exchange.onSettlement((settlement) => this.onSettlement(settlement));
  }

  async start(): Promise<void> {
    await this.exchange.start();
    await this.refreshSelection();
    const every = (ms: number, fn: () => Promise<void> | void) =>
      this.timers.push(setInterval(() => void Promise.resolve(fn()).catch((err) => this.note(`Error: ${message(err)}`)), ms));

    every(this.cfg.tickMs, () => this.tick());
    every(this.cfg.selectorRefreshMs, () => this.refreshSelection());
    every(2_000, () => this.relayer.tick());
    every(this.cfg.navIntervalMs, () => this.attest());
    every(this.cfg.epochMs, () => this.runEpoch());
    if (this.dayFlow) every(FLOW_STEP_MS, () => this.replayVolume());
    await this.attest();
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    await this.orders.cancelAll().catch(() => {});
    await this.exchange.stop();
  }

  /** Operator kill switch. */
  async setManualStop(stop: boolean): Promise<void> {
    this.manualStop = stop;
    this.note(stop ? "Operator stopped quoting" : "Operator resumed quoting");
  }

  async refreshSelection(): Promise<void> {
    if (this.selecting) return;
    this.selecting = true;
    try {
      const all = await this.exchange.listContracts();
      const held = new Set((await this.exchange.positions()).map((p) => p.symbol));
      this.selected = selectContracts(all, held, this.cfg, this.now());
      for (const contract of this.selected) this.known.set(contract.symbol, contract);
      this.exchange.watch(this.selected);
    } finally {
      this.selecting = false;
    }
  }

  /** One pass of the quoting loop. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const [positions, state, cash, freeCash, equity] = await Promise.all([
        this.exchange.positions(),
        this.vault.state(),
        this.exchange.cash(),
        this.exchange.freeCash(),
        this.exchange.equity(),
      ]);
      this.cached = { cash, freeCash, equity, principal: state.drawnPrincipal };
      this.inventory = buildInventory(positions, this.known);

      const funded = this.treasury.netFunded();
      const next = evaluate({
        feedConnected: this.exchange.connected(),
        vaultPaused: state.paused,
        recallOpen: state.recall != null,
        health: funded > 0 ? equity / funded : 1,
        maxDrawdown: this.cfg.limits.maxDrawdown,
        manualStop: this.manualStop,
      });
      if (next.mode !== this.kill.mode) {
        // Any step down cancels everything first; quotes are rebuilt from scratch.
        if (next.mode !== "normal") await this.orders.cancelAll();
        this.note(next.reason ?? "Quoting resumed");
      }
      this.kill = next;

      const desired = new Map<string, Quotes>();
      let budget = freeCash;
      let wanted = 0;
      for (const contract of this.selected) {
        const book = this.exchange.book(contract.symbol);
        const rule = this.cfg.categories[contract.category];
        const quotes = desiredQuotes(contract, book, this.inventory, rule, this.cfg, this.kill.mode, now);
        const pos = this.inventory.bySymbol.get(contract.symbol) ?? 0;

        // Fully collateralised: a quote only goes out if the cash behind it exists.
        for (const side of ["bid", "ask"] as const) {
          const quote = quotes[side];
          if (!quote) continue;
          const cost = collateral(side, quote.price, quote.qty, pos);
          wanted += cost;
          if (cost > budget) {
            delete quotes[side];
            quotes.note = "waiting for capital";
            quotes.rewardEligible = false;
          } else {
            budget -= cost;
          }
        }
        desired.set(contract.symbol, quotes);
      }
      this.quotes = desired;

      // Ask the relayer for what full two-sided quoting needs, with headroom, on top of
      // the cash already locked behind short positions.
      const locked = Math.max(0, cash - freeCash);
      this.relayer.capitalWanted = this.kill.mode === "normal" ? Math.round(wanted * 1.25 + locked) : 0;

      const edge = this.attribution.edge();
      const negative = edge.fills >= EDGE_MIN_FILLS && edge.trailingEdge != null && edge.trailingEdge < 0;
      this.relayer.drawsAllowed = !negative;
      this.relayer.drawBlockReason = negative ? "Trailing net edge is negative" : null;

      await this.orders.sync(desired);
      this.markouts.tick(now, (symbol) => this.midOf(symbol));
    } finally {
      this.ticking = false;
    }
  }

  /** Stand-in for the attestor: read exchange equity and post it as NAV. */
  async attest(): Promise<void> {
    if (!this.crank) return;
    await this.crank.submitNav(await this.exchange.equity());
    await this.crank.tick();
  }

  /** The daily cycle from AGENTS.md section 6, run once per epoch. */
  async runEpoch(): Promise<void> {
    // 1. Rebate payout lands on the exchange.
    if (this.paper) {
      const paid = this.paper.payRebates();
      this.attribution.onRebatePaid(paid);
      if (paid > 0) this.note(`Rebate payout of $${toUsd(paid).toFixed(2)}`);
    }
    // 2. Attestors post NAV. 3. The epoch settles.
    await this.attest();
    const equity = await this.exchange.equity();
    const booked = this.attribution.takeEpoch(equity, this.treasury.netFunded(), this.hedger.pnl());
    if (this.crank) {
      try {
        await this.crank.settleEpoch({ rebates: booked.rebate, rewards: booked.rewards, spread: booked.spread + booked.hedge });
      } catch (err) {
        this.note(`Epoch settlement failed: ${message(err)}`);
      }
    }
    const fees = this.attribution.feesAfterWaiver();
    const vault = this.crank ? await this.vault.state() : null;
    this.days.push({
      rebate: booked.rebate,
      total: booked.total,
      fees: fees - this.feesBooked,
      nav: vault ? vault.idle + vault.geminiEquity : null,
    });
    this.feesBooked = fees;
    if (this.days.length > 400) this.days.shift();
    // 4. Sweep surplus home.
    await this.relayer.afterEpoch();
    await this.attest();
  }

  /** Send this second's slice of each contract's real daily volume at the book. */
  private replayVolume(): void {
    this.dayFlow?.step(this.selected, FLOW_STEP_MS);
  }

  private onFill(fill: Fill): void {
    const book = this.exchange.book(fill.symbol);
    const mid = this.midOf(fill.symbol) ?? fill.price;
    this.markouts.onFill(fill, mid);
    this.attribution.onFill(fill);
    this.fillLog.record(fill, book, this.cfg.mode);
    const contract = this.known.get(fill.symbol);
    if (contract) void this.hedger.onFill(fill, contract).catch(() => {});
    this.recentFills.unshift({
      ...fill,
      title: contract?.title ?? fill.symbol,
      rebate: rebateAccrual(fill.price, fill.qty, this.cfg.terms) / USD,
    });
    if (this.recentFills.length > 40) this.recentFills.pop();
  }

  private onSettlement(settlement: Settlement): void {
    this.markouts.onSettlement(settlement);
    this.settlements.unshift(settlement);
    if (this.settlements.length > 20) this.settlements.pop();
    const how = settlement.resolved ? `at $${(settlement.value / 100).toFixed(2)}` : "marked at last mid (no result published)";
    this.note(`${settlement.symbol} settled ${how}`);
  }

  private midOf(symbol: string): number | undefined {
    const book = this.exchange.book(symbol);
    if (!book) return undefined;
    if (book.bid != null && book.ask != null) return (book.bid + book.ask) / 2;
    return book.bid ?? book.ask ?? undefined;
  }

  private note(text: string): void {
    this.opLog.unshift({ at: this.now(), text });
    if (this.opLog.length > 60) this.opLog.pop();
    this.log(text);
  }

  /** Relayer and vault messages share the operator log. */
  noteExternal(text: string): void {
    this.note(text);
  }

  /**
   * Per-day averages over the epochs settled so far, and the staker return they imply.
   * Return is measured on vault NAV, not on the drawn principal: stakers own the whole
   * vault, and most of it sits idle because volume, not capital, is the limit.
   */
  private dailyView() {
    const n = this.days.length;
    const empty = { days: 0, avgRebate: null, avgPnl: null, avgPnlPostWaiver: null, apy: null, apyPostWaiver: null };
    if (n === 0) return empty;
    const avg = (pick: (d: (typeof this.days)[number]) => number) => this.days.reduce((acc, d) => acc + pick(d), 0) / n;
    const avgPnl = avg((d) => d.total);
    const avgPostWaiver = avgPnl - avg((d) => d.fees);
    const navs = this.days.map((d) => d.nav).filter((v): v is number => v != null && v > 0);
    const avgNav = navs.length ? navs.reduce((acc, v) => acc + v, 0) / navs.length : 0;
    // Simple, not compounded: average daily PnL over average NAV, times 365.
    const yearly = (daily: number) => (avgNav > 0 ? (daily / avgNav) * 365 : null);
    return {
      days: n,
      avgRebate: toUsd(avg((d) => d.rebate)),
      avgPnl: toUsd(avgPnl),
      avgPnlPostWaiver: toUsd(avgPostWaiver),
      apy: yearly(avgPnl),
      apyPostWaiver: yearly(avgPostWaiver),
    };
  }

  /** Everything the operator view shows, in dollars. */
  status() {
    const usdOf = (m: Micros) => toUsd(m);
    const inv = this.inventory;
    const split = this.attribution.split(this.cached.equity, this.treasury.netFunded(), this.hedger.pnl());
    const edge = this.attribution.edge();
    const relayer = this.relayer.status();
    const { limits } = this.cfg;
    return {
      mode: this.cfg.mode,
      source: this.exchange.source,
      dayFlow: this.dayFlow != null,
      flow: {
        epochSeconds: this.cfg.epochMs / 1000,
        captureShare: this.cfg.captureShare,
        informedShare: this.cfg.informedShare,
        informedMoveCents: this.cfg.informedMoveCents,
      },
      daily: this.dailyView(),
      connected: this.exchange.connected(),
      quoteMode: this.kill.mode,
      killReason: this.kill.reason,
      manualStop: this.manualStop,
      hedger: this.hedger.name,
      now: this.now(),
      contracts: this.selected.map((c) => {
        const book = this.exchange.book(c.symbol);
        const quotes = this.quotes.get(c.symbol);
        const resting = this.orders.resting(c.symbol);
        return {
          symbol: c.symbol,
          title: c.title,
          category: c.category,
          expiry: c.expiry,
          marketBid: book?.bid ?? null,
          marketAsk: book?.ask ?? null,
          ourBid: resting.bid ? { price: resting.bid.price, qty: resting.bid.qty } : null,
          ourAsk: resting.ask ? { price: resting.ask.price, qty: resting.ask.qty } : null,
          position: inv.bySymbol.get(c.symbol) ?? 0,
          note: quotes?.note ?? this.orders.lastReject(c.symbol) ?? null,
          rewardEligible: quotes?.rewardEligible ?? false,
        };
      }),
      fills: this.recentFills,
      orderEvents: this.orders.events(80).map((event) => ({
        ...event,
        title: this.known.get(event.symbol)?.title ?? event.symbol,
      })),
      openOrders: this.orders.openCount(),
      settlements: this.settlements,
      pnl: {
        rebate: usdOf(split.rebate),
        rewards: usdOf(split.rewards),
        spread: usdOf(split.spread),
        hedge: usdOf(split.hedge),
        total: usdOf(split.total),
        accruedRebates: this.paper ? this.paper.accruedRebates() / USD : null,
        /** Part of spread: what modelled informed takers have cost so far. */
        adverse: this.paper ? usdOf(this.paper.adverseCost()) : 0,
      },
      edge: {
        fills: edge.fills,
        contracts: edge.contracts,
        filledNotional: usdOf(edge.filledNotional),
        rebatePerDollar: edge.rebatePerDollar,
        trailingEdge: edge.trailingEdge,
        trailingEdgePostWaiver: edge.trailingEdgePostWaiver,
      },
      markouts: this.markouts.stats(),
      exchange: {
        cash: usdOf(this.cached.cash),
        freeCash: usdOf(this.cached.freeCash),
        equity: usdOf(this.cached.equity),
        funded: usdOf(this.treasury.netFunded()),
      },
      limits: {
        net: { used: inv.gross, max: limits.maxNetInventory },
        perContract: {
          used: Math.max(0, ...[...inv.bySymbol.values()].map(Math.abs)),
          max: limits.maxPerContract,
        },
        perEvent: { used: Math.max(0, ...inv.byEvent.values()), max: limits.maxPerEvent },
        perCategory: { used: Math.max(0, ...inv.byCategory.values()), max: limits.maxPerCategory },
      },
      relayer: {
        capitalWanted: usdOf(relayer.capitalWanted),
        drawsAllowed: relayer.drawsAllowed,
        drawBlockReason: relayer.drawBlockReason,
        lastAction: relayer.lastAction,
        lastActionAt: relayer.lastActionAt,
      },
      log: this.opLog.slice(0, 30),
    };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
